/**
 * modules/dexbot_cow_runtime.ts - COW (Copy-on-Write) Batch Execution Runtime
 *
 * Handles on-chain order execution with Copy-on-Write working grid semantics,
 * broadcast uncertainty recovery, and result processing.
 *
 * Each function takes the DEXBot instance as its first parameter, following
 * the same pattern as dexbot_fill_runtime.ts.
 */

const chainOrders = require('./chain_orders');
const { readOpenOrdersWithMetaSafe, readOpenOrdersGuarded } = require('./chain_orders');
const { BroadcastUncertainError } = require('./dexbot_credential_client');
const {
    buildCreateOrderArgs,
    buildCreateOpFingerprint,
    extractBatchOperationResults,
    formatUnmatchedChainOrder,
    convertToSpreadPlaceholder,
    buildOutsideInPairGroups,
    isOrderPlaced,
} = require('./order/utils/order');
const { validateCreateTargetSlots, evaluateCommit, hasExecutableActions } = require('./order/utils/validate');
const { validateOrderSize, findPriceCollision } = require('./order/utils/math');
// Lazy accessor so test mocks on the math module export take effect at call time.
function getAssetFeesSafe(...args: any) { return require('./order/utils/math').getAssetFeesSafe(...args); }
const {
    COW_ACTIONS,
    ORDER_STATES,
    ORDER_TYPES,
    REBALANCE_STATES,
} = require('./constants');
const Format = require('./order/format');
const { WorkingGrid } = require('./order/working_grid');
const { getErrorMessage } = require('./utils/errors');

// Maximum number of times the pre-broadcast staleness guard may re-plan the
// batch from a fresh master before proceeding anyway. Bounded so a master
// grid that keeps mutating (fill bursts, sync loops) can never livelock the
// pipeline: after one re-plan the batch is shipped regardless, and the
// commit-time guard + post-refused-commit chain adoption close divergence.
const STALE_PLAN_REPLAN_LIMIT = 1;

/**
 * Group orders into outside-in pairs for atomic create execution.
 * @param {Array} orders
 * @returns {Array<Array>}
 */
function buildOutsideInPairGroupsForOrders(orders: any) {
    return buildOutsideInPairGroups(orders, {
        isValid: Boolean,
        getType: (o: any) => o.type,
        getPrice: (o: any) => o.price,
    });
}

/**
 * Build outside-in pair groups for create entry contexts.
 * @param {Array} createEntries
 * @returns {Array<Array>}
 */
function buildOutsideInPairGroupsForCreateEntries(createEntries: any) {
    return buildOutsideInPairGroups(createEntries, {
        isValid: (e: any) => Boolean(e?.context?.order),
        getType: (e: any) => e.context.order.type,
        getPrice: (e: any) => e.context.order.price,
    });
}

/**
 * Extract operation results from a batch transaction result.
 * @param {Object|Array|null} result
 * @param {string} [warnContext='']
 * @param {Function} [logFn] - Optional logger function, called with (msg, level) on unrecognized shape
 * @returns {Array}
 */
function extractOperationResults(result: any, warnContext: any = '', logFn: Function | null = null) {
    const extracted = extractBatchOperationResults(result);

    if (Array.isArray(extracted)) return extracted;

    if (result && logFn) {
        const resultType = Array.isArray(result) ? 'array' : typeof result;
        const keySummary = (resultType === 'object' && !Array.isArray(result))
            ? Object.keys(result).slice(0, 8).join(',')
            : '';
        const contextSuffix = warnContext ? ` (${warnContext})` : '';
        const keysSuffix = keySummary ? `; keys=[${keySummary}]` : '';
        logFn(
            `[COW] Unrecognized operation_results shape${contextSuffix}; defaulting to empty results. resultType=${resultType}${keysSuffix}`,
            'warn'
        );
    }

    return [];
}

/**
 * Find CREATE operation contexts whose broadcast result did not include a chain order id.
 * @param {Array} operationResults
 * @param {Array} opContexts
 * @returns {Array<{index:number, ctx:Object}>}
 */
function findMissingCreateResultContexts(operationResults: any, opContexts: any) {
    const missing: { index: number; ctx: any; }[] = [];
    if (!Array.isArray(opContexts)) return missing;

    for (let i = 0; i < opContexts.length; i++) {
        const ctx = opContexts[i];
        if (ctx?.kind !== 'create') continue;
        const chainOrderId = operationResults?.[i]?.[1];
        if (!chainOrderId || !/^1\.7\.\d+$/.test(String(chainOrderId))) {
            missing.push({ index: i, ctx });
        }
    }

    return missing;
}

/**
 * Run an immediate chain sync after a successful CREATE broadcast returned incomplete ids.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} [reason]
 * @returns {Promise<void>}
 */
async function recoverAfterMissingCreateResults(bot: any, reason: any = 'missing create operation results') {
    try {
        const accountRef = bot.accountId || bot.account?.id || bot.account;
        if (!accountRef || !bot.manager || !chainOrders?.readOpenOrders) {
            bot.manager?.logger?.log?.(`[COW] Recovery sync unavailable after ${reason}`, 'warn');
            return;
        }
        const preRecoveryMissingCreateBlockers = Array.isArray(bot.manager._lastUnmatchedChainOrders)
            ? bot.manager._lastUnmatchedChainOrders
                .filter((order: any) => order?.reason === 'missing-create-result')
                .map((order: any) => ({ ...order }))
            : [];
        // Truncated-read guard: the freshest CREATEs sort last and are exactly
        // the orders a partial get_full_accounts window omits — syncing would
        // virtualize them (phantom cleanup). Defer; blockers stay registered
        // so the COW guard retries the recovery on a clean read.
        const openOrders = await readOpenOrdersGuarded(chainOrders, accountRef, {
            log: (message: string, level: any) => bot.manager?.logger?.log?.(message, level),
            label: 'COW',
            detail: `recovery sync after ${reason}`,
        });
        if (openOrders === null) {
            bot.manager?.logger?.log?.(
                `[COW] Deferring recovery sync after ${reason}: open-order read ambiguous (truncated); blockers retained for retry.`,
                'warn'
            );
            return;
        }
        const recoveryResult = await bot.manager.syncFromOpenOrders(openOrders, {
            skipAccounting: false,
        });
        preserveMissingCreateBlockersAfterRecovery(bot, preRecoveryMissingCreateBlockers, recoveryResult);
        if (typeof bot.manager.persistGrid === 'function') {
            await bot.manager.persistGrid();
        }
    } catch (err: any) {
        bot.manager?.logger?.log?.(`[COW] CRITICAL: Recovery sync failed after ${reason}: ${getErrorMessage(err)}`, 'error');
        if (typeof bot.manager?.requestStructuralGridResync === 'function') {
            try {
                await bot.manager.requestStructuralGridResync(`recovery sync failed after ${reason}`, {
                    error: getErrorMessage(err)
                });
            } catch (scheduleErr: any) {
                bot.manager?.logger?.log?.(
                    `[COW] CRITICAL: Failed to schedule structural resync after recovery failure: ${getErrorMessage(scheduleErr)}`,
                    'error'
                );
            }
        }
    }
}

/**
 * Restore unresolved missing-create blockers after recovery if sync did not adopt them.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array} blockers
 * @param {Object} recoveryResult
 */
function preserveMissingCreateBlockersAfterRecovery(bot: any, blockers: any, recoveryResult: any) {
    if (!Array.isArray(blockers) || blockers.length === 0 || !bot.manager) return;

    const adoptedSlotIds = new Set(
        (Array.isArray(recoveryResult?.updatedOrders) ? recoveryResult.updatedOrders : [])
            .filter((order: any) => order?.id && order?.orderId)
            .map((order: any) => order.id)
    );
    const unresolvedBlockers = blockers.filter((blocker: any) => !blocker.slotId || !adoptedSlotIds.has(blocker.slotId));
    if (unresolvedBlockers.length === 0) return;

    const currentUnmatched = Array.isArray(bot.manager._lastUnmatchedChainOrders)
        ? bot.manager._lastUnmatchedChainOrders
        : [];
    const currentKeys = new Set(currentUnmatched.map((order: any) => `${order.reason || ''}:${order.slotId || ''}:${order.operationIndex ?? ''}`));
    const restored = [...currentUnmatched];

    for (const blocker of unresolvedBlockers) {
        const key = `${blocker.reason || ''}:${blocker.slotId || ''}:${blocker.operationIndex ?? ''}`;
        if (!currentKeys.has(key)) restored.push({ ...blocker });
    }

    if (restored.length !== currentUnmatched.length) {
        bot.manager._lastUnmatchedChainOrders = restored;
        bot.manager._lastUnmatchedChainOrdersAt = Date.now();
        bot.manager.logger?.log?.(
            `[COW] Preserving ${restored.length - currentUnmatched.length} missing-create blocker(s) after recovery sync; ` +
            `chain snapshot did not account for the affected slot(s).`,
            'warn'
        );
    }
}

/**
 * Merge missing CREATE result contexts into manager._lastUnmatchedChainOrders.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array<{index:number, ctx:Object}>} missingCreateResults
 */
function markMissingCreateResultsAsStructuralBlocker(bot: any, missingCreateResults: any) {
    const blockers = Array.isArray(missingCreateResults)
        ? missingCreateResults.map((item: any) => {
            const order = item.ctx?.order || {};
            const fingerprint = [
                `type=${order.type || 'unknown'}`,
                `price=${Format.formatPrice6(order.price)}`,
                `size=${Format.formatAmount(order.size)}`
            ].join(',');
            return {
                chainOrderId: 'unknown',
                type: order.type || null,
                price: order.price,
                size: order.size,
                slotId: order.id || item.ctx?.id || null,
                reason: 'missing-create-result',
                operationIndex: item.index,
                fingerprint,
            };
        })
        : [];

    if (bot.manager && blockers.length > 0) {
        const existing = Array.isArray(bot.manager._lastUnmatchedChainOrders)
            ? bot.manager._lastUnmatchedChainOrders
            : [];
        const keys = new Set(existing.map((order: any) => `${order.reason || ''}:${order.slotId || ''}:${order.operationIndex ?? ''}`));
        const merged = [...existing];
        for (const blocker of blockers) {
            const key = `${blocker.reason || ''}:${blocker.slotId || ''}:${blocker.operationIndex ?? ''}`;
            if (!keys.has(key)) {
                merged.push(blocker);
                keys.add(key);
            }
        }
        bot.manager._lastUnmatchedChainOrders = merged;
        bot.manager._lastUnmatchedChainOrdersAt = Date.now();
    }
}

/**
 * Format an unmatched chain order for COW logs.
 * @param {Object} order
 * @returns {string}
 */
function formatUnmatchedChainOrderForLog(order: any) {
    return formatUnmatchedChainOrder(order);
}

/**
 * Record a pending CREATE broadcast on the manager.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} entry
 */
function recordPendingBroadcast(bot: any, entry: any) {
    if (!bot.manager || !entry || !entry.order) return;
    if (!bot.manager._pendingBroadcasts || !(bot.manager._pendingBroadcasts instanceof Map)) {
        bot.manager._pendingBroadcasts = new Map();
    }
    const fingerprint = buildCreateOpFingerprint({
        side: entry.order.type,
        assetA: bot.manager?.assets?.assetA?.id,
        assetB: bot.manager?.assets?.assetB?.id,
        sellInt: entry.finalInts?.sell,
        receiveInt: entry.finalInts?.receive,
        slotId: entry.order.id
    });
    if (!fingerprint) {
        bot.manager.logger.log?.(
            `[COW] Skipped pending-broadcast record: could not build fingerprint for ${entry.order?.id || 'unknown'}`,
            'warn'
        );
        return;
    }
    bot.manager._pendingBroadcasts.set(fingerprint, {
        fingerprint,
        opIndex: entry.opIndex,
        ctxIndex: entry.ctxIndex,
        slotId: entry.order.id,
        orderId: entry.order.id,
        orderType: entry.order.type,
        order: entry.order,
        finalInts: entry.finalInts,
        batchId: bot._currentBatchId || null,
        recordedAt: Date.now()
    });
}

/**
 * Clear the pending-broadcast cache.
 * @param {Map} pendingBroadcasts
 */
function clearPendingBroadcasts(pendingBroadcasts: any) {
    if (pendingBroadcasts instanceof Map) {
        pendingBroadcasts.clear();
    }
}

/**
 * Drop only the pending-broadcast entries for the given CREATE slots.
 *
 * Used by the re-plan path: the original plan's ops are abandoned with its
 * working grid, so their pending entries must not trip the recursion's own
 * pending-broadcast guard. Entries recorded by an EARLIER unresolved batch
 * (different slots) are KEPT — clearing them here would let the fresh plan
 * re-create slots whose earlier uncertain broadcast may have landed
 * (duplicate orders). The batch-entry guard only fires for batches WITH
 * CREATE actions, so a create-less batch can reach the re-plan path while
 * earlier entries are still live.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array} actions - The abandoned batch's actions (COW_ACTIONS)
 */
function clearPendingBroadcastsForSlots(bot: any, actions: any) {
    if (!(bot.manager?._pendingBroadcasts instanceof Map) || !Array.isArray(actions)) return;
    const slotIds = new Set(
        actions
            .filter((a: any) => a?.type === COW_ACTIONS.CREATE)
            .map((a: any) => a?.id)
            .filter(Boolean)
    );
    if (slotIds.size === 0) return;
    for (const [fp, entry] of bot.manager._pendingBroadcasts) {
        if (entry?.slotId && slotIds.has(entry.slotId)) {
            bot.manager._pendingBroadcasts.delete(fp);
        }
    }
}

/**
 * Pop a pushed working-grid stack entry exactly once, guarded on the push
 * marker (manager-owned discipline — see OrderManager._pushWorkingGridRef /
 * _popWorkingGridRef). Results that were never pushed (aborted plans,
 * no-trigger processFilledOrders outputs, updateOrdersOnChainPlan cowResults,
 * reconcileGridOrders null results) leave the stack untouched — an unmatched
 * pop could steal a nested grid's entry.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} cowResult - Rebalance/COW result carrying _workingGridPushed
 */
function popPushedWorkingGrid(bot: any, cowResult: any) {
    bot.manager?._popWorkingGridRef?.(cowResult);
}

/**
 * Defer an uncertain-broadcast reconciliation on an ambiguous chain read
 * (empty/truncated/failed). An empty snapshot may be a node lagging behind
 * the just-broadcast transaction and a truncated get_full_accounts window
 * omits the freshest orders (exactly the batch's creates), so absence is
 * never authoritative: the pending-broadcast protection is kept and a
 * structural resync is requested so the next cycle adopts any landed orders.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} detail - The failure detail (before the common suffix)
 * @param {string} suffix - Parenthetical explanation appended to the message
 * @param {string} resyncReason - Reason string passed to the structural resync
 * @param {Object} [resyncOptions={}] - Extra resync context (batchId, truncated...)
 * @returns {Object} Ambiguous-read reconciliation result
 */
async function deferUncertainBroadcastRead(bot: any, detail: string, suffix: string, resyncReason: string, resyncOptions: any = {}) {
    bot.manager.logger.log(
        `[COW][UNCERTAIN] ${detail}; keeping pending-broadcast protection and requesting structural resync ${suffix}`,
        'warn'
    );
    if (typeof bot.manager.requestStructuralGridResync === 'function') {
        await bot.manager.requestStructuralGridResync(resyncReason, resyncOptions);
    }
    return { executed: false, hadRotation: false, uncertain: true, ambiguousRead: true };
}

/**
 * Build a fingerprint for an on-chain order so it can be matched against
 * the pending-broadcast cache.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} chainOrder
 * @param {string} slotId
 * @returns {string|null}
 */
function buildChainOrderFingerprint(bot: any, chainOrder: any, slotId: any) {
    if (!chainOrder || !slotId) return null;
    const normalized = normalizeChainOrderForPendingMatch(bot, chainOrder);
    if (!normalized) return null;
    return buildCreateOpFingerprint({
        side: normalized.side,
        assetA: normalized.assetA,
        assetB: normalized.assetB,
        sellInt: normalized.sellInt,
        receiveInt: normalized.receiveInt,
        slotId
    });
}

/**
 * Normalize raw BitShares limit_order_object data into the integer tuple
 * used by pending-broadcast recovery.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} chainOrder
 * @returns {{side: string, assetA: string, assetB: string, sellInt: number, receiveInt: number}|null}
 */
function normalizeChainOrderForPendingMatch(bot: any, chainOrder: any) {
    if (!chainOrder) return null;
    const assetA = bot.manager?.assets?.assetA?.id;
    const assetB = bot.manager?.assets?.assetB?.id;
    if (!assetA || !assetB) return null;

    const explicitSide = (chainOrder.type === 'buy' || chainOrder.type === 'sell')
        ? chainOrder.type
        : null;
    const explicitSell = chainOrder.sellInt ?? chainOrder.sell;
    const explicitReceive = chainOrder.receiveInt ?? chainOrder.receive;
    if (explicitSide && Number.isFinite(Number(explicitSell)) && Number.isFinite(Number(explicitReceive))) {
        return {
            side: explicitSide,
            assetA,
            assetB,
            sellInt: Number(explicitSell),
            receiveInt: Number(explicitReceive)
        };
    }

    const base = chainOrder.sell_price?.base;
    const quote = chainOrder.sell_price?.quote;
    if (!base || !quote || !base.asset_id || !quote.asset_id) return null;
    const baseAmount = Number(base.amount);
    const quoteAmount = Number(quote.amount);
    if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount)) return null;

    if (base.asset_id === assetA && quote.asset_id === assetB) {
        return { side: 'sell', assetA, assetB, sellInt: baseAmount, receiveInt: quoteAmount };
    }
    if (base.asset_id === assetB && quote.asset_id === assetA) {
        return { side: 'buy', assetA, assetB, sellInt: baseAmount, receiveInt: quoteAmount };
    }
    return null;
}

/**
 * Find a chain order that matches a planned slot using price+size proximity.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array} chainOrders - Open chain orders for the account
 * @param {string} slotId - Planned grid slot id
 * @param {Object} planned - { sell, receive, orderType } integers from the planned op
 * @returns {Object|null} Matching chain order, or null
 */
function findChainOrderForSlot(bot: any, chainOrders: any, slotId: any, planned: any) {
    if (!Array.isArray(chainOrders) || !slotId) return null;
    const assetA = bot.manager?.assets?.assetA?.id;
    const assetB = bot.manager?.assets?.assetB?.id;
    if (!assetA || !assetB) return null;

    // 1. Exact fingerprint match.
    for (const o of chainOrders) {
        const fp = buildChainOrderFingerprint(bot, o, slotId);
        if (fp && bot.manager._pendingBroadcasts?.has(fp)) {
            return o;
        }
    }
    if (!planned || !Number.isFinite(Number(planned.sell)) || !Number.isFinite(Number(planned.receive))) {
        return null;
    }
    // 2. Near match: same side, sell int within 1, receive int within 1% or 2 units.
    const targetSell = Number(planned.sell);
    const targetReceive = Number(planned.receive);
    const plannedSide = planned.orderType ||
        planned.side ||
        bot.manager._pendingBroadcasts?.get?.(planned.fingerprint)?.orderType ||
        bot.manager.orders.get(slotId)?.type;
    if (plannedSide !== 'buy' && plannedSide !== 'sell') {
        return null;
    }
    let best = null;
    let bestDistance = Infinity;
    for (const o of chainOrders) {
        const normalized = normalizeChainOrderForPendingMatch(bot, o);
        if (!normalized) continue;
        if (normalized.side !== plannedSide) continue;
        const sell = Number(normalized.sellInt);
        const receive = Number(normalized.receiveInt);
        if (!Number.isFinite(sell) || !Number.isFinite(receive)) continue;
        const sellDelta = Math.abs(sell - targetSell);
        const receiveDelta = Math.abs(receive - targetReceive);
        const receiveTol = Math.max(2, Math.floor(targetReceive * 0.01));
        if (sellDelta > 1 || receiveDelta > receiveTol) continue;
        const distance = sellDelta * 1000 + receiveDelta;
        if (distance < bestDistance) {
            best = o;
            bestDistance = distance;
        }
    }
    return best;
}

/**
 * Reconcile a broadcast whose chain state is unknown.
 * Thin wrapper that optionally acquires _fillProcessingLock before delegating.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {BroadcastUncertainError} err
 * @param {Array<Object>} opContexts
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function reconcileAfterUncertainBroadcast(bot: any, err: any, opContexts: any, options: Record<string, any> = {}) {
    if (
        bot.manager?._fillProcessingLock &&
        typeof bot.manager._fillProcessingLock.acquire === 'function' &&
        !bot.manager._fillProcessingLock.isReentrant()
    ) {
        return bot.manager._fillProcessingLock.acquire(() =>
            reconcileAfterUncertainBroadcast(bot, err, opContexts, options)
        );
    }
    return reconcileAfterUncertainBroadcastImpl(bot, err, opContexts, options);
}

/**
 * Reconcile a broadcast whose chain state is unknown (implementation).
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {BroadcastUncertainError} err
 * @param {Array<Object>} opContexts
 * @param {Object} options
 * @returns {Promise<Object>}
 */
async function reconcileAfterUncertainBroadcastImpl(bot: any, err: any, opContexts: any, _options: any) {
    const startedAt = Date.now();
    const pending: any[] = (bot.manager && bot.manager._pendingBroadcasts instanceof Map)
        ? Array.from(bot.manager._pendingBroadcasts.values()) as any[]
        : [];
    const createContextCount = opContexts.filter((c: any) => c && c.kind === 'create').length;
    const nonCreateContextCount = opContexts.length - createContextCount;

    bot.manager.logger.log(
        `[COW][UNCERTAIN] batchId=${err?.batchId || 'n/a'} ops=${opContexts.length} ` +
        `creates=${createContextCount} nonCreates=${nonCreateContextCount} ` +
        `staleSinceMs=${err?.timeoutMs || 'n/a'}. Entering reconcile-then-decide.`,
        'warn'
    );

    if (!chainOrders?.readOpenOrdersWithMeta) {
        bot.manager.logger.log(
            '[COW][UNCERTAIN] readOpenOrdersWithMeta unavailable; falling back to structural resync only.',
            'error'
        );
        if (typeof bot.manager.requestStructuralGridResync === 'function') {
            await bot.manager.requestStructuralGridResync(
                'broadcast uncertain — readOpenOrders unavailable',
                { batchId: err?.batchId || null }
            );
        }
        clearPendingBroadcasts(bot.manager?._pendingBroadcasts);
        return { executed: false, hadRotation: false, uncertain: true };
    }

    // 1. Read the chain
    const accountRef = bot.accountId || bot.account?.id || bot.account;
    let chainSnapshot: any[] = [];
    let chainReadTruncated = false;
    try {
        const chainRead = await chainOrders.readOpenOrdersWithMeta(accountRef);
        chainSnapshot = chainRead.orders;
        chainReadTruncated = chainRead.truncated;
    } catch (readErr) {
        bot.manager.logger.log(
            `[COW][UNCERTAIN] readOpenOrders failed: ${(readErr as any)?.message || readErr}. ` +
            `Falling back to structural resync.`,
            'error'
        );
        if (typeof bot.manager.requestStructuralGridResync === 'function') {
            await bot.manager.requestStructuralGridResync(
                'broadcast uncertain — readOpenOrders failed',
                { batchId: (err as any)?.batchId || null, error: (readErr as any)?.message || String(readErr) }
            );
        }
        clearPendingBroadcasts(bot.manager?._pendingBroadcasts);
        return { executed: false, hadRotation: false, uncertain: true };
    }

    // 1.5. Empty/truncated-read guard: an empty snapshot is ambiguous — the
    // account is either genuinely empty or the node is lagging behind the
    // just-broadcast transaction. A truncated snapshot (get_full_accounts
    // capped limit_orders; fresh creates sort last in the by_account index
    // and are the first entries omitted) is equally ambiguous: the batch's
    // creates may simply be missing from the returned window. Treating every
    // pending broadcast as discarded would clear the pending-broadcast
    // protection and let the next cycle re-CREATE slots whose orders may
    // actually be on chain (duplicate orders). Keep the protection and let
    // the structural resync adopt any landed orders.
    if (pending.length > 0 && (chainSnapshot.length === 0 || chainReadTruncated)) {
        return await deferUncertainBroadcastRead(
            bot,
            `${chainSnapshot.length === 0 ? 'Empty' : 'Truncated'} chain read for ${pending.length} pending broadcast(s)`,
            '(node may be lagging or the result set capped; no discard decisions made)',
            'uncertain broadcast — empty/truncated chain read',
            { batchId: err?.batchId || null, truncated: chainReadTruncated }
        );
    }

    const adopted: { entry: any; match: any; }[] = [];
    let discarded: any[] = [];

    // 2. For each pending broadcast, look for a chain match.
    for (const entry of pending) {
        const match = findChainOrderForSlot(
            bot,
            chainSnapshot,
            entry.slotId,
            {
                sell: entry.finalInts?.sell,
                receive: entry.finalInts?.receive,
                orderType: entry.orderType,
                fingerprint: entry.fingerprint,
            }
        );
        if (match) {
            adopted.push({ entry, match });
        } else {
            discarded.push(entry);
        }
    }

    // 2b. Second pass: search for any unmatched chain orders by fingerprint
    // across all known pending slots.
    if (adopted.length < pending.length) {
        const adoptedSlotIds = new Set(adopted.map((a: any) => a.entry.slotId));
        for (const o of chainSnapshot) {
            if (adopted.some((a: any) => a.match.id === o.id)) continue;
            for (const entry of pending) {
                if (adoptedSlotIds.has(entry.slotId)) continue;
                const fp = buildChainOrderFingerprint(bot, o, entry.slotId);
                if (fp && bot.manager._pendingBroadcasts?.has(fp)) {
                    adopted.push({ entry, match: o });
                    adoptedSlotIds.add(entry.slotId);
                    break;
                }
            }
        }
        // Rebuild discarded list to remove newly adopted entries.
        const newlyAdoptedSlotIds = new Set(adopted.map((a: any) => a.entry.slotId));
        discarded = pending.filter((e: any) => !newlyAdoptedSlotIds.has(e.slotId));
    }

    // 3a. Re-read chain for discarded CREATE entries to catch broadcasts that
    // landed between the initial read and this point (TOCTOU window).
    if (discarded.length > 0 && typeof chainOrders.readOpenOrders === 'function') {
        const createDiscarded = discarded.filter((e: any) => {
            const ctx = opContexts[e.ctxIndex];
            return ctx && ctx.kind === 'create';
        });
        if (createDiscarded.length > 0) {
            try {
                const freshRead = await readOpenOrdersWithMetaSafe(chainOrders, accountRef);
                // An empty/truncated re-read is as ambiguous as the initial
                // read: a truncated get_full_accounts window omits the freshest
                // creates (exactly the discarded ones being re-verified), and an
                // empty snapshot may be a node lagging behind the just-broadcast
                // transaction. Absence in either case is NOT authoritative —
                // discarding here would free the slot + clear the pending
                // protection and let the next cycle re-create (duplicate) an
                // order that actually landed in the TOCTOU window. Keep the
                // pending-broadcast protection and defer to a structural resync.
                if (!freshRead || freshRead.truncated || !Array.isArray(freshRead.orders) || freshRead.orders.length === 0) {
                    const ambiguous = !freshRead || !Array.isArray(freshRead.orders) || freshRead.orders.length === 0;
                    return await deferUncertainBroadcastRead(
                        bot,
                        `${ambiguous ? 'Empty' : 'Truncated'} re-read for ${createDiscarded.length} discarded CREATE(s)`,
                        '(absence is not authoritative on an ambiguous re-read)',
                        'uncertain broadcast — ambiguous re-read for discarded creates',
                        { batchId: err?.batchId || null, truncated: !ambiguous }
                    );
                }
                const freshChain = freshRead.orders;
                const remainingDiscarded: any[] = [];
                for (const entry of discarded) {
                    const ctx = opContexts[entry.ctxIndex];
                    if (ctx && ctx.kind === 'create') {
                        const match = findChainOrderForSlot(
                            bot, freshChain, entry.slotId,
                            {
                                sell: entry.finalInts?.sell,
                                receive: entry.finalInts?.receive,
                                orderType: entry.orderType,
                                fingerprint: entry.fingerprint,
                            }
                        );
                        if (match) {
                            adopted.push({ entry, match });
                            bot.manager.logger.log(
                                `[COW][UNCERTAIN] Late-adopted discarded CREATE for slot ${entry.slotId} (${match.id}) via fresh chain read`,
                                'info'
                            );
                        } else {
                            remainingDiscarded.push(entry);
                        }
                    } else {
                        remainingDiscarded.push(entry);
                    }
                }
                discarded = remainingDiscarded;
            } catch (reReadErr: any) {
                return await deferUncertainBroadcastRead(
                    bot,
                    `Fresh chain read for late adoption FAILED (${getErrorMessage(reReadErr)})`,
                    '(absence is not authoritative on a failed re-read)',
                    'uncertain broadcast — failed re-read for discarded creates',
                    { batchId: err?.batchId || null }
                );
            }
        }
    }

    // 3b. Apply decisions
    let adoptedCount = 0;
    let discardedCount = 0;

    for (const { entry, match } of adopted) {
        adoptedCount++;
        const plannedOpCtx = opContexts[entry.ctxIndex];
        if (plannedOpCtx && plannedOpCtx.kind === 'create') {
            const chainOrderId = match.id;
            const expectedType = plannedOpCtx.order?.type || entry.orderType;

            try {
                const btsFeeData = getAssetFeesSafe('BTS');
                await bot.manager.synchronizeWithChain({
                    gridOrderId: plannedOpCtx.order?.id || entry.slotId,
                    chainOrderId,
                    expectedType,
                    fee: btsFeeData?.createFee || 0,
                }, 'createOrder');
            } catch (syncErr: any) {
                bot.manager.logger.log(
                    `[COW][UNCERTAIN] Failed to adopt matched order ${chainOrderId} for slot ${entry.slotId}: ${syncErr?.message || syncErr}`,
                    'error'
                );
            }
        }

        // Remove from pending broadcasts — matched entries are resolved.
        if (entry.fingerprint && bot.manager._pendingBroadcasts?.has(entry.fingerprint)) {
            bot.manager._pendingBroadcasts.delete(entry.fingerprint);
        }
    }

    for (const entry of discarded) {
        discardedCount++;
        const plannedOpCtx = opContexts[entry.ctxIndex];
        if (plannedOpCtx && plannedOpCtx.kind === 'create') {
            try {
                // Restore target grid sizes for discarded CREATEs so the slots are
                // immediately available for the next cycle without waiting for a
                // structural resync. entry.order is the pending-broadcast target
                // order (captured at broadcast time, before the working grid was
                // committed or discarded).
                if (entry.order?.id && entry.order?.size && entry.order?.type) {
                    const slot = bot.manager.orders.get(entry.order.id);
                    if (slot) {
                        const plannedType = entry.order.type;
                        if (plannedType === ORDER_TYPES.BUY || plannedType === ORDER_TYPES.SELL) {
                            // Creation-uncertain state: the broadcast MAY have
                            // landed on chain even though no match was found yet.
                            // Keep the planned type and size on the slot (VIRTUAL)
                            // instead of restoring the SPREAD placeholder, whose
                            // size is normalized to 0 by the SPREAD invariant.
                            // A possibly-landed order must never be released as a
                            // clean hole — that frees the slot for a duplicate
                            // CREATE and later orphan adoption double-commits the
                            // funds. The next sync's orphan adoption reconciles a
                            // landed order into this slot cleanly.
                            bot.manager.logger.log(
                                `[COW][UNCERTAIN] Restored creation-uncertain state for slot ${entry.slotId} ` +
                                `(type=${plannedType}, size: ${entry.order.size}); next sync adoption will reconcile any landed order`,
                                'warn'
                            );
                            const updates = [{
                                ...slot,
                                type: plannedType,
                                size: entry.order.size,
                                price: entry.order.price,
                                state: ORDER_STATES.VIRTUAL,
                                // Clear any stale order identity: the broadcast
                                // MAY have landed, but the slot must look like a
                                // clean adoption target (no orderId/rawOnChain)
                                // so the next sync's orphan adoption can reconcile
                                // a landed order into it. A retained orderId would
                                // make pass-2 adoption skip the slot (it requires
                                // !adoptedSlot.orderId), leaving the landed order
                                // unmatched and auto-cancelled; a stale rawOnChain
                                // would feed a bogus drift signal.
                                orderId: null,
                                rawOnChain: null,
                            }];
                            if (typeof bot.manager.applyGridUpdateBatch === 'function') {
                                await bot.manager.applyGridUpdateBatch(updates, 'uncertain-broadcast-discard-restore');
                            }
                        } else {
                            bot.manager.logger.log(
                                `[COW][UNCERTAIN] Restored target size for discarded CREATE slot ${entry.slotId} (size: ${entry.order.size})`,
                                'debug'
                            );
                            const updates = [{
                                ...slot,
                                size: entry.order.size,
                                price: entry.order.price,
                            }];
                            if (typeof bot.manager.applyGridUpdateBatch === 'function') {
                                await bot.manager.applyGridUpdateBatch(updates, 'uncertain-broadcast-discard-restore');
                            }
                        }
                    }
                }
            } catch (restoreErr: any) {
                bot.manager.logger.log(
                    `[COW][UNCERTAIN] Failed to restore slot ${entry.slotId} after discard: ${restoreErr?.message || restoreErr}`,
                    'error'
                );
            }
        }
        // Remove from pending broadcasts.
        if (entry.fingerprint && bot.manager._pendingBroadcasts?.has(entry.fingerprint)) {
            bot.manager._pendingBroadcasts.delete(entry.fingerprint);
        }
    }

    // 4. If some entries remain unresolved (broadcasts that point to opContext
    // indices beyond the array — shouldn't happen, but guard defensively),
    // treat them as discarded.
    const remainingAfterDecide = bot.manager._pendingBroadcasts instanceof Map
        ? bot.manager._pendingBroadcasts.size
        : 0;
    if (remainingAfterDecide > 0) {
        const remainingEntries = Array.from(bot.manager._pendingBroadcasts.values()) as any[];
        for (const entry of remainingEntries) {
            discardedCount++;
            bot.manager.logger.log(
                `[COW][UNCERTAIN] Cleaning residual pending broadcast for slot ${entry.slotId} (opIndex=${entry.opIndex})`,
                'debug'
            );
        }
        bot.manager._pendingBroadcasts.clear();
    }

    // 5. Log structured summary
    const elapsed = Date.now() - startedAt;
    bot.manager.logger.log(
        `[COW][UNCERTAIN] Reconciled: ${adoptedCount} adopted, ${discardedCount} discarded ` +
        `(opContexts=${opContexts.length}, pending=${pending.length}, ` +
        `chainOrders=${chainSnapshot.length}) in ${elapsed}ms.`,
        'info'
    );

    // 6. Persist master grid changes from the reconciliation.
    if (adoptedCount > 0 || discardedCount > 0) {
        if (typeof bot.manager.persistGrid === 'function') {
            try {
                await bot.manager.persistGrid();
            } catch (persistErr: any) {
                bot.manager.logger.log(
                    `[COW][UNCERTAIN] Persist after reconcile failed: ${persistErr?.message || persistErr}`,
                    'error'
                );
            }
        }
    }

    // 7. Request structural resync if any chain orders remain unaccounted for
    // after the reconciliation, ensuring the next cycle re-plans from a clean
    // chain snapshot.
    const alreadyScheduled = bot._structuralGridResyncRunning || bot._structuralGridResyncTimer;
    if (!alreadyScheduled && chainSnapshot.length > 0) {
        const reconciledOrderIds = new Set(adopted.map((a: any) => a.match?.id).filter(Boolean));
        const unreconciledCount = chainSnapshot.filter((o: any) => !reconciledOrderIds.has(o.id)).length;
        if (unreconciledCount > 0) {
            bot.manager.logger.log(
                `[COW][UNCERTAIN] ${unreconciledCount} chain order(s) remain unreconciled after uncertain broadcast recovery. ` +
                `These may be legitimate pre-existing orders or leftovers from a prior cycle. Requesting structural resync.`,
                'warn'
            );
            if (typeof bot.manager.requestStructuralGridResync === 'function') {
                await bot.manager.requestStructuralGridResync(
                    'unreconciled orders after uncertain broadcast',
                    {
                        batchId: err?.batchId || null,
                        pendingCount: pending.length,
                        adoptedCount,
                        discardedCount,
                        unreconciledCount
                    }
                );
            } else {
                bot._warn?.('[COW][UNCERTAIN] requestStructuralGridResync unavailable; cannot schedule structural resync.');
            }
        }
    }

    return { executed: false, hadRotation: false, uncertain: true, adoptedCount, discardedCount };
}

/**
 * Auto-cancel one unmatched orphan (price-drift orphan) per cycle.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Promise<{cancelled: boolean, reason?: string, orderId?: string}>}
 */
async function autoCancelOneUnmatchedOrphan(bot: any) {
    const cycleId = bot._currentCycleId || 0;
    const recoveryActive = bot.manager?._recoveryState?.structuralResyncRequested === true;
    const cycleCap = recoveryActive ? 5 : 1;

    if (bot._autoCancelOrphanCycleMarker === cycleId) {
        if (bot._autoCancelOrphanSubCount >= cycleCap) {
            return { cancelled: false, reason: 'cap-reached-this-cycle', subCount: bot._autoCancelOrphanSubCount };
        }
    } else {
        bot._autoCancelOrphanCycleMarker = cycleId;
        bot._autoCancelOrphanSubCount = 0;
    }
    const pending = (bot.manager && bot.manager._pendingBroadcasts instanceof Map)
        ? bot.manager._pendingBroadcasts.size
        : 0;
    if (pending > 0) {
        return { cancelled: false, reason: 'pending-broadcasts-active' };
    }
    const unmatched = Array.isArray(bot.manager?._lastUnmatchedChainOrders)
        ? bot.manager._lastUnmatchedChainOrders
        : [];
    if (unmatched.length === 0) {
        return { cancelled: false, reason: 'no-unmatched' };
    }
    const fingerprinted = unmatched.find((u: any) => u && u.fingerprint);
    if (fingerprinted) {
        return { cancelled: false, reason: 'fingerprinted-handle-via-recovery' };
    }

    const target = unmatched.find((u: any) => u && u.reason === 'price-drift-orphan');
    if (!target) {
        return { cancelled: false, reason: 'no-price-drift-orphan', message: 'no price-drift orphan to cancel; other unmatched orders are adoptable' };
    }
    const orderId = target.id || target.orderId || target.chainOrderId;
    if (!orderId) {
        return { cancelled: false, reason: 'no-orderId' };
    }
    if (!chainOrders?.cancelOrder) {
        return { cancelled: false, reason: 'cancelOrder-unavailable' };
    }
    try {
        await chainOrders.cancelOrder(bot.account, bot.privateKey, orderId);
        if (typeof chainOrders.recordOwnCancel === 'function') {
            chainOrders.recordOwnCancel(orderId);
        }
        bot._autoCancelOrphanSubCount++;
        bot.manager.logger.log(
            `[COW] Auto-cancelled ${bot._autoCancelOrphanSubCount}/${unmatched.length} unmatched chain order ` +
            `(${formatUnmatchedChainOrderForLog(target)}) — per-cycle cap=${cycleCap}.`,
            'warn'
        );
        return { cancelled: true, orderId };
    } catch (err) {
        bot.manager.logger.log(
            `[COW] Auto-cancel of unmatched chain order ${orderId} failed: ${(err as any)?.message || err}`,
            'error'
        );
        return { cancelled: false, reason: 'cancel-failed', error: (err as any)?.message || String(err) };
    }
}

/**
 * Check whether to execute creates in outside-in pair mode.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array} opContexts
 * @returns {boolean}
 */
function shouldExecuteCreatePairMode(_bot: any, opContexts: any) {
    if (!Array.isArray(opContexts) || opContexts.length < 2) return false;
    if (!opContexts.every((ctx: any) => ctx?.kind === 'create' && ctx?.order)) return false;

    let hasBuy = false;
    let hasSell = false;
    for (const ctx of opContexts) {
        if (ctx.order.type === ORDER_TYPES.BUY) hasBuy = true;
        if (ctx.order.type === ORDER_TYPES.SELL) hasSell = true;
        if (hasBuy && hasSell) return true;
    }
    return false;
}

/**
 * Verify one op context against a fresh chain snapshot for pre-retry
 * re-broadcast safety. Verdicts per kind (see the kind-specific verifiers):
 *  - 'absent'  → provably never transmitted → retry safe
 *  - 'landed'  → provably applied on chain → must defer
 *  - 'unknown' → chain state unverifiable → must defer
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array} freshChain - Non-empty, non-truncated chain snapshot
 * @param {Object} ctx - Operation context (kind: create/cancel/size-update/rotation)
 * @returns {'absent' | 'landed' | 'unknown'}
 */
function verifyOpAgainstChain(bot: any, freshChain: any[], ctx: any): 'absent' | 'landed' | 'unknown' {
    if (ctx.kind === 'create') return verifyCreateAbsent(bot, freshChain, ctx);
    if (ctx.kind === 'cancel') return verifyCancelLanded(freshChain, ctx);
    if (ctx.kind === 'size-update' || ctx.kind === 'rotation') return verifyUpdateUnapplied(freshChain, ctx);
    return 'unknown';
}

/**
 * CREATE verify: 'absent' only when the batch's creates are found NOWHERE in
 * the snapshot (fingerprint/near-match) — never transmitted → retry safe.
 * Any match means the broadcast landed ('landed'). A create without
 * fingerprint data cannot match anything, so it is treated as absent
 * (original semantics).
 */
function verifyCreateAbsent(bot: any, freshChain: any[], ctx: any): 'absent' | 'landed' | 'unknown' {
    if (!ctx.finalInts || !ctx.order) return 'absent';
    const match = findChainOrderForSlot(bot, freshChain, ctx.order.id, {
        sell: ctx.finalInts.sell,
        receive: ctx.finalInts.receive,
        orderType: ctx.order.type,
        fingerprint: buildCreateOpFingerprint({
            side: ctx.order.type,
            assetA: bot.manager?.assets?.assetA?.id,
            assetB: bot.manager?.assets?.assetB?.id,
            sellInt: ctx.finalInts.sell,
            receiveInt: ctx.finalInts.receive,
            slotId: ctx.order.id
        })
    });
    return match ? 'landed' : 'absent';
}

/**
 * CANCEL verify: the order still present → the cancel never landed ('absent',
 * retry safe). Absent from a live snapshot → the cancel landed ('landed').
 * No orderId → unverifiable ('unknown').
 */
function verifyCancelLanded(freshChain: any[], ctx: any): 'absent' | 'landed' | 'unknown' {
    const chainOrderId = ctx.order?.orderId;
    if (!chainOrderId) return 'unknown';
    if (!freshChain.some((o: any) => String(o?.id ?? '') === String(chainOrderId))) {
        return 'landed';
    }
    return 'absent';
}

/**
 * UPDATE verify (size-update/rotation): limit_order_update ops are DELTAS, so
 * a landed broadcast double-applies the size change on re-broadcast. Retry
 * ('absent') only when the chain order is provably UNCHANGED from the
 * pre-update cache (the update never applied). Target applied, partially
 * filled after a landed update, or the order missing (filled/cancelled
 * concurrently) → 'unknown' (defer).
 */
function verifyUpdateUnapplied(freshChain: any[], ctx: any): 'absent' | 'landed' | 'unknown' {
    const chainOrderId = ctx.kind === 'size-update'
        ? ctx.updateInfo?.partialOrder?.orderId
        : ctx.rotation?.oldOrder?.orderId;
    const cachedRaw = ctx.kind === 'size-update'
        ? ctx.updateInfo?.partialOrder?.rawOnChain
        : ctx.rotation?.oldOrder?.rawOnChain;
    if (!chainOrderId) return 'unknown';
    const chainOrder = freshChain.find(
        (o: any) => String(o?.id ?? '') === String(chainOrderId)
    );
    if (!chainOrder) return 'unknown';
    if (!chainOrderUnchangedFromCache(chainOrder, cachedRaw)) return 'unknown';
    return 'absent';
}

/**
 * Execute operations with retry on BroadcastUncertainError.
 *
 * Never re-broadcasts blindly: an uncertain broadcast may have landed, and
 * re-sending the same ops would duplicate on-chain orders. A retry is only
 * allowed on AUTHORITATIVE ABSENCE — a successful non-empty, non-truncated
 * chain read where every op verifies 'absent' (see verifyOpAgainstChain). An
 * empty read (node may be lagging), a truncated read (get_full_accounts
 * capped the result set; fresh creates sort last and are the first entries
 * omitted), or any 'landed'/'unknown' verdict defers to the post-broadcast
 * reconciliation machinery (pollChainForConfirmation +
 * reconcileAfterUncertainBroadcast), which verifies inclusion and adopts
 * landed orders before the next cycle.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array} operations
 * @param {Array} opContexts
 * @returns {Promise<{result: Object, opContexts: Array}>}
 */
async function executeWithRetryOnUncertain(bot: any, operations: any, opContexts: any) {
    const MAX_RETRIES = 1;
    for (let attempt = 1; ; attempt++) {
        try {
            return await executeOperationsWithStrategy(bot, operations, opContexts);
        } catch (err: any) {
            const isRetriable = err instanceof BroadcastUncertainError
                && !err.partialOnChainState
                && attempt <= MAX_RETRIES;
            if (isRetriable) {
                // Verify per operation kind against a live snapshot before
                // re-broadcasting (see verifyOpAgainstChain): only a provably
                // unapplied batch may be retried; a truncated or empty read is
                // never authoritative (nodes lag / get_full_accounts caps the
                // window) → defer.
                let absence: 'absent' | 'landed' | 'unknown' = 'unknown';
                try {
                    const accountRef = bot.accountId || bot.account?.id || bot.account;
                    const freshRead = await chainOrders.readOpenOrdersWithMeta(accountRef);
                    const freshChain = freshRead.orders;
                    if (Array.isArray(freshChain) && freshChain.length > 0) {
                        absence = 'absent';
                        for (const ctx of opContexts) {
                            if (!ctx) continue;
                            const verdict = verifyOpAgainstChain(bot, freshChain, ctx);
                            if (verdict !== 'absent') {
                                absence = verdict;
                                break;
                            }
                        }
                    }
                    // A truncated read (get_full_accounts caps limit_orders, and
                    // fresh creates sort last in the by_account index) omits the
                    // very orders this batch may have landed — 'absent' is not
                    // authoritative here, degrade to 'unknown' and defer.
                    if (freshRead.truncated && absence === 'absent') {
                        absence = 'unknown';
                    }
                } catch (verifyErr: any) {
                    bot.manager.logger.log(
                        `[COW] Pre-retry chain verification failed (non-fatal): ${verifyErr?.message || verifyErr}`,
                        'warn'
                    );
                }

                if (absence === 'absent') {
                    bot.manager.logger.log(
                        `[COW] Broadcast uncertain (attempt ${attempt}/${MAX_RETRIES + 1}); verified unapplied on chain, retrying...`,
                        'warn'
                    );
                    await bot._ensureCredentialDaemonWritable('COW batch retry');
                    continue;
                }

                bot.manager.logger.log(
                    `[COW] Broadcast uncertain (attempt ${attempt}/${MAX_RETRIES + 1}); ` +
                    `${absence === 'landed' ? 'operation(s) confirmed applied on chain' : 'chain state unverifiable (empty/truncated/lagging read)'} — ` +
                    `deferring to post-broadcast reconciliation (no blind re-broadcast)`,
                    'warn'
                );
                throw err;
            }
            throw err;
        }
    }
}

/**
 * Whether a chain order still matches the cached pre-update state the
 * limit_order_update delta was built from. Only a provably-unchanged order
 * makes a re-broadcast of the identical delta safe (it applies to the same
 * base). Any other state (target applied, filled, resized) must defer.
 * @param {Object} chainOrder - Raw chain order object (get_full_accounts)
 * @param {Object|null} cachedRaw - The rawOnChain cache captured at build time
 * @returns {boolean}
 */
function chainOrderUnchangedFromCache(chainOrder: any, cachedRaw: any) {
    if (!chainOrder || !cachedRaw) return false;
    const base = chainOrder.sell_price?.base;
    const quote = chainOrder.sell_price?.quote;
    const cachedBase = cachedRaw.sell_price?.base?.amount;
    const cachedQuote = cachedRaw.sell_price?.quote?.amount;
    const cachedForSale = cachedRaw.for_sale;
    if (base === undefined || quote === undefined) return false;
    if (cachedForSale === undefined || cachedBase === undefined || cachedQuote === undefined) return false;
    return String(base.amount ?? '') === String(cachedBase)
        && String(quote.amount ?? '') === String(cachedQuote)
        && String(chainOrder.for_sale ?? '') === String(cachedForSale);
}

/**
 * Execute blockchain operations with appropriate strategy (single batch or pair mode).
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array} operations
 * @param {Array} opContexts
 * @returns {Promise<{result: Object, opContexts: Array}>}
 */
async function executeOperationsWithStrategy(bot: any, operations: any, opContexts: any) {
    if (!shouldExecuteCreatePairMode(bot, opContexts)) {
        const result = await chainOrders.executeBatch(bot.account, bot.privateKey, operations);
        return { result, opContexts };
    }

    const createEntries: any[] = [];
    for (let i = 0; i < operations.length; i++) {
        createEntries.push({
            operation: operations[i],
            context: opContexts[i],
        });
    }

    const groups = buildOutsideInPairGroupsForCreateEntries(createEntries);
    const mergedOperationResults: any[] = [];
    const mergedRawResults: any[] = [];
    const mergedContexts: any[] = [];

    for (let idx = 0; idx < groups.length; idx++) {
        const group = groups[idx];
        const groupOps = group.map((e: any) => e.operation);
        const groupContexts = group.map((e: any) => e.context);
        bot.manager.logger.log(
            `[COW] Broadcasting create pair group ${idx + 1}/${groups.length} (${groupOps.length} op${groupOps.length > 1 ? 's' : ''}, outside->center)`,
            'info'
        );
        let groupResult;
        try {
            groupResult = await chainOrders.executeBatch(bot.account, bot.privateKey, groupOps);
        } catch (err: any) {
            const groupsBroadcast = idx;
            const groupsTotal = groups.length;
            const broadcastedOperationCount = mergedContexts.length;
            bot.manager.logger.log(
                `[COW] Grouped create execution failed at group ${idx + 1}/${groupsTotal}; ${groupsBroadcast} group(s) already broadcast (${broadcastedOperationCount} op context(s)). Partial on-chain state is possible.`,
                'error'
            );
            err.partialOnChainState = groupsBroadcast > 0;
            err.groupsBroadcast = groupsBroadcast;
            err.groupsTotal = groupsTotal;
            err.broadcastedOperationCount = broadcastedOperationCount;
            throw err;
        }
        const groupOpResults = extractOperationResults(groupResult, '', bot.manager?.logger?.log?.bind(bot.manager?.logger));

        mergedOperationResults.push(...groupOpResults);
        mergedRawResults.push(groupResult?.raw || null);
        mergedContexts.push(...groupContexts);
    }

    return {
        result: {
            success: true,
            raw: {
                grouped: true,
                groupsExecuted: groups.length,
                groupResults: mergedRawResults,
            },
            operation_results: mergedOperationResults,
            grouped: true,
            groupsExecuted: groups.length
        },
        opContexts: mergedContexts
    };
}

/**
 * Validate that operations can be executed with available funds before broadcasting.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array} operations
 * @param {Object} assetA
 * @param {Object} assetB
 * @returns {Object} { isValid: boolean, summary: string }
 */
function validateOperationFunds(bot: any, operations: any, assetA: any, assetB: any) {
    if (!operations || operations.length === 0) {
        return { isValid: true, summary: 'No operations to validate' };
    }

    const { blockchainToFloat, floatToBlockchainInt, quantizeFloat } = require('./order/utils/math');
    let snap = bot.manager?.getChainFundsSnapshot?.();
    if (!snap) {
        snap = { chainFreeSell: 0, chainFreeBuy: 0 };
        bot.manager?.logger?.log?.(
            '[COW][VALIDATION] getChainFundsSnapshot unavailable — fund validation skipped (assuming no balance)',
            'warn'
        );
    }
    const netRequiredFunds = { [assetA.id]: 0, [assetB.id]: 0 };
    const runningRequiredFunds = { [assetA.id]: 0, [assetB.id]: 0 };
    const peakRequiredFunds = { [assetA.id]: 0, [assetB.id]: 0 };

    for (const op of operations) {
        if (!op?.op_data) continue;

        let sellAssetId = null;
        let sellAmountInt = 0;

        if (op.op_name === 'limit_order_create') {
            sellAssetId = op.op_data.amount_to_sell?.asset_id;
            sellAmountInt = op.op_data.amount_to_sell?.amount;
        } else if (op.op_name === 'limit_order_update') {
            sellAssetId = op.op_data.new_price?.base?.asset_id;
            sellAmountInt = op.op_data.new_price?.base?.amount;
        }

        if (sellAssetId && (sellAmountInt !== undefined && sellAmountInt !== null)) {
            const precision = (sellAssetId === assetA.id) ? assetA.precision : assetB.precision;
            const assetSymbol = (sellAssetId === assetA.id) ? assetA.symbol : assetB.symbol;

            if (Number(sellAmountInt) <= 0) {
                return {
                    isValid: false,
                    summary: `[VALIDATION] CRITICAL: Zero amount order detected for ${assetSymbol} (assetId=${sellAssetId})`,
                    violations: [{ asset: assetSymbol, sizeInt: sellAmountInt, reason: 'Zero amount' }]
                };
            }

            let signedDelta = 0;
            if (op.op_name === 'limit_order_update') {
                const deltaAssetId = op.op_data.delta_amount_to_sell?.asset_id;
                const deltaSellInt = op.op_data.delta_amount_to_sell?.amount;
                if (deltaAssetId === sellAssetId && Number.isFinite(Number(deltaSellInt))) {
                    signedDelta = blockchainToFloat(deltaSellInt, precision);
                }
            } else {
                signedDelta = blockchainToFloat(sellAmountInt, precision);
            }

            netRequiredFunds[sellAssetId] = quantizeFloat(
                (netRequiredFunds[sellAssetId] || 0) + signedDelta,
                precision
            );

            runningRequiredFunds[sellAssetId] = quantizeFloat(
                (runningRequiredFunds[sellAssetId] || 0) + signedDelta,
                precision
            );

            const nextPeak = Math.max(
                Number(peakRequiredFunds[sellAssetId] || 0),
                Number(runningRequiredFunds[sellAssetId] || 0)
            );
            peakRequiredFunds[sellAssetId] = quantizeFloat(nextPeak, precision);
        }
    }

    const availableFunds = {
        [assetA.id]: quantizeFloat(snap.chainFreeSell || 0, assetA.precision),
        [assetB.id]: quantizeFloat(snap.chainFreeBuy || 0, assetB.precision)
    };

    const fundViolations: any[] = [];
    for (const assetId in peakRequiredFunds) {
        const required = peakRequiredFunds[assetId];
        const netRequired = netRequiredFunds[assetId] || 0;
        const available = availableFunds[assetId] || 0;

        const prec = (assetId === assetA.id) ? assetA.precision : assetB.precision;
        if (floatToBlockchainInt(required, prec) > floatToBlockchainInt(available, prec)) {
            fundViolations.push({
                asset: assetId === assetA.id ? assetA.symbol : assetB.symbol,
                required,
                netRequired,
                available,
                deficit: quantizeFloat(required - available, prec)
            });
        }
    }

    if (fundViolations.length > 0) {
        let summary = `[VALIDATION] Fund validation FAILED:\n`;
        for (const v of fundViolations) {
            summary += `  ${v.asset}: peakRequired=${Format.formatAmount8(v.required)}, netRequired=${Format.formatAmount8(v.netRequired)}, available=${Format.formatAmount8(v.available)}, deficit=${Format.formatAmount8(v.deficit)}\n`;
        }
        return { isValid: false, summary: summary.trim(), violations: fundViolations };
    }

    const summary = `[VALIDATION] PASSED: ${operations.length} operations`;
    return { isValid: true, summary };
}

/**
 * Resolve the ideal size from an order-like object with fallback.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object|null} orderLike
 * @param {number|null} [fallbackSize=null]
 * @returns {number|null}
 */
function resolveIdealSizeForValidation(_bot: any, orderLike: any, fallbackSize: any = null) {
    const candidates = [
        orderLike?.idealSize,
        orderLike?.order?.idealSize,
        orderLike?.size,
        orderLike?.order?.size,
        fallbackSize
    ];

    for (const candidate of candidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric;
        }
    }

    return null;
}

/**
 * Validate that an order size is safe to execute.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {number} size
 * @param {string} type
 * @param {Object|null} [orderLike=null]
 * @param {number|null} [fallbackSize=null]
 * @returns {import('./types').OrderValidationResult}
 */
function validateOrderSizeForExecution(bot: any, size: any, type: any, orderLike: any = null, fallbackSize: any = null) {
    return validateOrderSize(
        size,
        type,
        bot.manager.assets,
        bot.config.gridLimits?.MIN_ORDER_SIZE_FACTOR,
        resolveIdealSizeForValidation(bot, orderLike, fallbackSize),
        bot.config.gridLimits?.PARTIAL_DUST_THRESHOLD_PERCENTAGE
    );
}

/**
 * Build COW actions array from a simple plan object.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object|Array} plan
 * @returns {Array}
 */
function buildActionsFromPlan(_bot: any, plan: any) {
    const normalizedPlan = Array.isArray(plan)
        ? { ordersToPlace: plan }
        : (plan || {});

    const {
        ordersToPlace = [],
        ordersToRotate = [],
        ordersToUpdate = [],
        ordersToCancel = []
    } = normalizedPlan;

    const actions: any[] = [];

    for (const o of ordersToCancel) {
        if (o?.orderId) {
            actions.push({ type: COW_ACTIONS.CANCEL, id: o.id, orderId: o.orderId });
        }
    }

    for (const r of ordersToRotate) {
        const oldOrder = r?.oldOrder || r;
        const id = oldOrder?.id || r?.id;
        const orderId = oldOrder?.orderId || r?.orderId;
        const newGridId = r?.newGridId || id;
        const newSize = Number.isFinite(Number(r?.newSize))
            ? Number(r.newSize)
            : Number(r?.size || oldOrder?.size || 0);
        const newPrice = Number.isFinite(Number(r?.newPrice))
            ? Number(r.newPrice)
            : Number(r?.price || oldOrder?.price);
        const orderType = r?.type || oldOrder?.type;

        if (!id || !orderId || !newGridId || !orderType || !Number.isFinite(newPrice) || !(newSize > 0)) continue;

        actions.push({
            type: COW_ACTIONS.UPDATE,
            id,
            orderId,
            newGridId,
            newSize,
            newPrice,
            order: {
                id: newGridId,
                type: orderType,
                price: newPrice,
                size: newSize
            }
        });
    }

    for (const o of ordersToUpdate) {
        const partialOrder = o?.partialOrder || o;
        const id = o?.id || partialOrder?.id;
        const orderId = o?.orderId || partialOrder?.orderId;
        const orderType = o?.type || partialOrder?.type;
        const newSize = Number.isFinite(Number(o?.newSize))
            ? Number(o.newSize)
            : Number(partialOrder?.size || 0);

        if (!id || !orderId) continue;

        actions.push({
            type: COW_ACTIONS.UPDATE,
            id,
            orderId,
            newSize,
            order: {
                ...(partialOrder || {}),
                id,
                orderId,
                type: orderType,
                size: newSize
            }
        });
    }

    for (const o of ordersToPlace) {
        if (!o?.id) continue;
        actions.push({ type: COW_ACTIONS.CREATE, id: o.id, order: o });
    }

    return actions;
}

/**
 * Build a COW result object (workingGrid + actions) from a simple plan.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object|Array} plan
 * @returns {{workingGrid: import('./types').WorkingGrid, workingIndexes: Object, workingBoundary: number, actions: Array}}
 */
function buildCowResultFromPlan(bot: any, plan: any) {
    const workingGrid = new WorkingGrid(bot.manager.orders, {
        baseVersion: Number.isFinite(Number(bot.manager._gridVersion)) ? bot.manager._gridVersion : 0
    });
    const workingBoundary = bot.manager.boundaryIdx;
    const actions = buildActionsFromPlan(bot, plan);

    for (const action of actions) {
        if (action.type === COW_ACTIONS.CANCEL) {
            const current = workingGrid.get(action.id);
            if (!current) continue;
            workingGrid.set(action.id, convertToSpreadPlaceholder(current));
        } else if (action.type === COW_ACTIONS.CREATE) {
            if (!action.id || !action.order) continue;
            const current = workingGrid.get(action.id) || { id: action.id };
            workingGrid.set(action.id, {
                ...current,
                ...action.order,
                id: action.id,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            });
        } else if (action.type === COW_ACTIONS.UPDATE) {
            if (action.newGridId && action.newGridId !== action.id) {
                const current = workingGrid.get(action.id);
                if (current) {
                    workingGrid.set(action.id, convertToSpreadPlaceholder(current));
                }

                const targetId = action.newGridId;
                const targetCurrent = workingGrid.get(targetId) || { id: targetId };
                const rotatedSize = Number.isFinite(Number(action.newSize))
                    ? Number(action.newSize)
                    : Number(targetCurrent.size || 0);
                const rotatedPrice = Number.isFinite(Number(action.newPrice))
                    ? Number(action.newPrice)
                    : Number(action.order?.price ?? targetCurrent.price);

                workingGrid.set(targetId, {
                    ...targetCurrent,
                    ...(action.order || {}),
                    id: targetId,
                    size: rotatedSize,
                    price: rotatedPrice,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: null
                });
                continue;
            }

            const current = workingGrid.get(action.id);
            if (!current) continue;
            const newSize = Number.isFinite(Number(action.newSize))
                ? Number(action.newSize)
                : Number(current.size || 0);
            workingGrid.set(action.id, {
                ...current,
                ...(action.order || {}),
                id: action.id,
                orderId: action.orderId || current.orderId,
                size: newSize
            });
        }
    }

    return {
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary,
        actions
    };
}

/**
 * Restore skipped update slots in the working grid to master state.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {import('./types').WorkingGrid} workingGrid
 * @param {Set<string>} skippedSlotIds
 * @param {number} [skippedCount=0]
 */
/**
 * Pre-apply rotation state transitions to the working grid before commit.
 * This makes the COW commit truly atomic for structural changes — source slots
 * are cleared to VIRTUAL and destination slots are activated with the inherited
 * orderId before the working grid is committed to master, eliminating the need
 * for post-commit structural patching in processBatchResults.
 *
 * Only slot-to-slot rotations (newGridId exists) need pre-application;
 * in-place rotations already have their size/price changes in the working grid.
 */
function applyRotationTransitionsToWorkingGrid(bot: any, workingGrid: any, executedContexts: any) {
    if (!workingGrid || !executedContexts) return;

    for (const ctx of executedContexts) {
        if (ctx.kind !== 'rotation' || !ctx.rotation?.newGridId) continue;

        const { rotation } = ctx;
        const { oldOrder, newGridId, newPrice, newSize, type } = rotation;

        // Source slot → VIRTUAL (if it's a different slot)
        if (oldOrder?.id && oldOrder.id !== newGridId) {
            const sourceSlot = workingGrid.get(oldOrder.id);
            if (sourceSlot && sourceSlot.orderId) {
                workingGrid.set(oldOrder.id, {
                    ...sourceSlot,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: null,
                    rawOnChain: null
                });
                bot.manager.logger.log(
                    `[COW] Pre-applied rotation: source ${oldOrder.id} → VIRTUAL (order ${sourceSlot.orderId} moved to ${newGridId})`,
                    'debug'
                );
            }
        }

        // Destination slot → ACTIVE with inherited orderId from source
        const destSlot = workingGrid.get(newGridId);
        if (destSlot) {
            workingGrid.set(newGridId, {
                ...destSlot,
                id: newGridId,
                type,
                size: newSize,
                price: newPrice,
                state: ORDER_STATES.ACTIVE,
                // oldOrder?.orderId is the authoritative source: the rotation
                // moved this orderId from the source slot.  destSlot.orderId
                // is only a fallback for edge cases where the destination
                // already held a prior committed ID (e.g. a partial commit
                // left a stale reference).  The source-of-truth is always the
                // original order being rotated.
                orderId: oldOrder?.orderId || destSlot.orderId || null
            });
            bot.manager.logger.log(
                `[COW] Pre-applied rotation: dest ${newGridId} → ACTIVE (orderId=${oldOrder?.orderId || destSlot.orderId || 'none'})`,
                'debug'
            );
        }
    }
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll the chain after an uncertain broadcast to check if CREATE operations
 * were actually accepted. Uses fingerprint matching against readOpenOrders.
 * Falls back to reconciliation if polling cannot confirm within retries.
 *
 * We specifically confirm CREATE operations because they leave a detectable
 * footprint on the chain (new order with matching fingerprint). UPDATEs and
 * CANCELs modify existing orders and cannot be reliably distinguished from
 * "not yet visible" state by simple polling.
 *
 * @returns {{ allConfirmed: boolean, confirmed: Array, unconfirmed: Array }}
 */
async function pollChainForConfirmation(bot: any, opContexts: any, options: any = {}): Promise<{
    allConfirmed: boolean;
    confirmed: any[];
    unconfirmed: any[];
}> {
    const maxPollRetries = options.maxPollRetries || 4;
    const pollIntervalMs = options.pollIntervalMs || 1500;

    // Only CREATE operations can be confirmed by polling (they appear as new orders on chain)
    const createContexts = opContexts.filter((ctx: any) => ctx && ctx.kind === 'create' && ctx.finalInts && ctx.order);
    if (createContexts.length === 0) {
        return { allConfirmed: false, confirmed: [], unconfirmed: [...opContexts] };
    }

    const accountRef = bot.accountId || bot.account?.id || bot.account;
    let remaining: any[] = [...createContexts];

    for (let attempt = 1; attempt <= maxPollRetries; attempt++) {
        try {
            const chainRead = await readOpenOrdersWithMetaSafe(chainOrders, accountRef);
            const chainSnapshot = chainRead.orders;
            // A truncated read omits the freshest orders — the exact CREATEs
            // this poll is trying to confirm — so absence cannot be
            // distinguished from window truncation. Fall back to the
            // reconciliation machinery immediately instead of burning the
            // remaining polls.
            if (chainRead.truncated) {
                bot.manager.logger.log(
                    `[COW][POLL] Chain read TRUNCATED (account exceeds the get_full_accounts window); ` +
                    `fresh creates cannot be confirmed — deferring to reconciliation`,
                    'warn'
                );
                break;
            }
            if (!Array.isArray(chainSnapshot) || chainSnapshot.length === 0) {
                if (attempt < maxPollRetries) {
                    await sleep(pollIntervalMs);
                }
                continue;
            }

            const stillUnconfirmed: any[] = [];
            for (const ctx of remaining) {
                const match = findChainOrderForSlot(bot, chainSnapshot, ctx.order.id, {
                    sell: ctx.finalInts.sell,
                    receive: ctx.finalInts.receive,
                    orderType: ctx.order.type,
                    fingerprint: createContexts.length > 0
                        ? buildCreateOpFingerprint({
                            side: ctx.order.type,
                            assetA: bot.manager?.assets?.assetA?.id,
                            assetB: bot.manager?.assets?.assetB?.id,
                            sellInt: ctx.finalInts.sell,
                            receiveInt: ctx.finalInts.receive,
                            slotId: ctx.order.id
                        })
                        : undefined
                });

                if (match) {
                    bot.manager.logger.log(
                        `[COW][POLL] Confirmed CREATE for slot ${ctx.order.id} on chain as ${match.id}`,
                        'debug'
                    );
                } else {
                    stillUnconfirmed.push(ctx);
                }
            }

            if (stillUnconfirmed.length === 0) {
                const confirmed = createContexts;
                bot.manager.logger.log(
                    `[COW][POLL] All ${confirmed.length} CREATE(s) confirmed on chain after ${attempt} poll(s)`,
                    'info'
                );
                return { allConfirmed: true, confirmed, unconfirmed: [] };
            }

            remaining = stillUnconfirmed;
            if (attempt < maxPollRetries) {
                await sleep(pollIntervalMs);
            }
        } catch (pollErr: any) {
            bot.manager.logger.log(
                `[COW][POLL] Chain read attempt ${attempt}/${maxPollRetries} failed: ${getErrorMessage(pollErr)}`,
                'warn'
            );
            if (attempt < maxPollRetries) {
                await sleep(pollIntervalMs);
            }
        }
    }

    const confirmed = createContexts.filter((ctx: any) => !remaining.includes(ctx));
    bot.manager.logger.log(
        `[COW][POLL] ${confirmed.length}/${createContexts.length} CREATE(s) confirmed after ${maxPollRetries} polls; ` +
        `${remaining.length} unconfirmed. Falling back to reconciliation.`,
        'warn'
    );
    return { allConfirmed: false, confirmed, unconfirmed: remaining };
}

function restoreSkippedUpdateSlotsInWorkingGrid(bot: any, workingGrid: any, skippedSlotIds: any, skippedCount: any = 0) {
    if (!workingGrid || !skippedSlotIds || skippedSlotIds.size === 0) {
        return;
    }

    const masterVersion = Number.isFinite(Number(bot.manager?._gridVersion))
        ? Number(bot.manager._gridVersion)
        : undefined;

    for (const slotId of skippedSlotIds) {
        workingGrid.syncFromMaster(bot.manager.orders, slotId, masterVersion);
    }

    bot.manager.logger.log(
        `[COW] Restored ${skippedSlotIds.size} slot(s) after ${skippedCount} skipped update action(s).`,
        'debug'
    );
}

/**
 * Bounded re-plan for a stale pre-broadcast plan (regression-safe policy).
 *
 * Policy (bounded re-plan + proceed):
 *   * First staleness hit → re-plan ONCE from fresh master using the same
 *     fills; the recursion re-runs this guard against the fresh plan. A
 *     re-plan with no executable actions means the grid is already consistent
 *     post-fills — the stale plan must NOT ship.
 *   * Still stale (master kept mutating), or no fill context to re-plan with
 *     → PROCEED with the plan anyway and request a structural resync. Never
 *     hard-abort on staleness: an abort would silently drop the fill set that
 *     triggered this rebalance (_processFillsWithBatching only hard-aborts on
 *     illegal-state or accounting failures), and the post-broadcast commit
 *     guard + chain adoption below close any residual divergence.
 *
 * Stack discipline: the original plan's grid is popped before the fresh
 * re-plan pushes (LIFO order); when the re-plan fails/aborts, the original
 * grid is pushed back (marker restored) so the later commit/catch pop sites
 * release exactly the entry they were pushed with, instead of underflowing
 * or stealing a nested grid's entry.
 *
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} cowResult - The stale plan result
 * @param {number} replanDepth - Recursion depth (0 = first attempt)
 * @param {Object} preBroadcastGuard - The failed evaluateCommit result
 * @returns {Promise<{handled: boolean, result?: Object}>} handled=true when the
 *   batch was resolved by the re-plan (fresh plan executed, or stale plan
 *   skipped as already-consistent); handled=false when the caller must proceed
 *   with the original plan.
 */
async function replanStaleBatch(bot: any, cowResult: any, replanDepth: number, preBroadcastGuard: any): Promise<{ handled: boolean; result?: any }> {
    const canReplan = replanDepth < STALE_PLAN_REPLAN_LIMIT
        && Array.isArray(cowResult.fills) && cowResult.fills.length > 0;
    if (!canReplan) {
        bot.manager.logger.log(
            `[COW] Plan stale pre-broadcast (${preBroadcastGuard.reason}); ` +
            (replanDepth >= STALE_PLAN_REPLAN_LIMIT
                ? 'still stale after re-plan — proceeding with plan (commit guard + chain adoption close divergence)'
                : 'no fill context for re-plan — proceeding with plan (commit guard + chain adoption close divergence)'),
            'warn'
        );
        await requestStructuralResync(
            bot,
            'plan stale pre-broadcast (proceeding with plan)',
            { reason: preBroadcastGuard.reason }
        );
        return { handled: false };
    }

    bot.manager.logger.log(
        `[COW] Plan stale pre-broadcast (${preBroadcastGuard.reason}); re-planning once from fresh master`,
        'warn'
    );

    // Abandon the original plan's working grid: it can no longer commit. Pop
    // it so the rebalance stack stays balanced — the fresh plan's grid (pushed
    // by performSafeRebalance below) is popped by the recursion's own
    // commit/cleanup path. Guarded on the push marker (plan-path calls never
    // pushed a grid); the marker is cleared so a later throw in this frame
    // (e.g. the recursion) cannot pop the entry a second time.
    const hadPushedGrid = cowResult?._workingGridPushed === true;
    popPushedWorkingGrid(bot, cowResult);

    let replanned: any = null;
    try {
        // Restore the boundary-shift budget consumed by the abandoned plan:
        // it was built from the same fills and never shipped, so the re-plan
        // must derive from the FULL batch budget — not the leftover. Without
        // the restore, each stale-plan re-plan spends the budget twice and
        // drifts conservative (boundary under-shift).
        if ((bot.manager as any)?._boundaryShiftBudgetBase != null) {
            (bot.manager as any)._boundaryShiftBudget = (bot.manager as any)._boundaryShiftBudgetBase;
        }
        if (typeof bot.manager.performSafeRebalance === 'function') {
            replanned = await bot.manager.performSafeRebalance(
                cowResult.fills,
                cowResult.excludeIds || new Set()
            );
        }
    } catch (replanErr: any) {
        bot.manager.logger.log(
            `[COW] Re-plan failed: ${getErrorMessage(replanErr)}; proceeding with original plan`,
            'warn'
        );
    }

    if (replanned && !replanned.aborted) {
        if (hasExecutableActions(replanned)) {
            // The original plan's ops are abandoned with its working grid;
            // drop THEIR pending-broadcast entries only, or the recursion's
            // own pending-broadcast guard would reject the fresh plan's
            // CREATEs. Entries from an earlier unresolved batch are
            // deliberately KEPT: the entry guard only covers CREATE batches,
            // so a create-less batch can reach this path while earlier
            // entries are still live — clearing them here would let the fresh
            // plan re-create slots whose earlier broadcast may have landed
            // (duplicate orders). The recursion's guard will then abort +
            // reconcile instead.
            clearPendingBroadcastsForSlots(bot, cowResult.actions);
            return {
                handled: true,
                result: await updateOrdersOnChainBatchCOW(bot, replanned, {
                    replanDepth: replanDepth + 1
                }),
            };
        }
        // Re-plan confirms the grid is already consistent post-fills; the
        // stale original plan must NOT ship. Pop the fresh plan's grid too
        // (it was never committed).
        popPushedWorkingGrid(bot, replanned);
        clearPendingBroadcastsForSlots(bot, cowResult.actions);
        bot.manager.logger.log(
            '[COW] Re-plan produced no executable actions; grid is already consistent post-fills, skipping stale plan',
            'info'
        );
        return { handled: true, result: { executed: false, hadRotation: false, skippedStalePlan: true } };
    }

    // Re-plan failed or aborted — the original plan proceeds after all. Its
    // grid was popped above to keep the stack LIFO-balanced for the fresh
    // plan; push it back (marker restored) so the broadcast commit / catch
    // pop sites release exactly the entry they were pushed with, instead of
    // underflowing or stealing a nested grid's entry.
    if (hadPushedGrid && cowResult.workingGrid) {
        if (typeof bot.manager._pushWorkingGridRef === 'function') {
            bot.manager._pushWorkingGridRef(cowResult.workingGrid, cowResult);
        } else {
            bot.manager._currentWorkingGridStack?.push?.(cowResult.workingGrid);
            bot.manager._resetRebalanceStateToDepth?.();
            cowResult._workingGridPushed = true;
        }
    }
    bot.manager.logger.log(
        '[COW] Re-plan unavailable; proceeding with original plan (commit guard + chain adoption close divergence)',
        'warn'
    );
    await requestStructuralResync(
        bot,
        're-plan unavailable (proceeding with original plan)',
        { reason: preBroadcastGuard.reason }
    );
    return { handled: false };
}

/**
 * COW broadcast: Execute blockchain operations and commit working grid on success.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} cowResult
 * @param {Object} [options={}] - Internal execution options (replanDepth)
 * @returns {Promise<Object>}
 */
async function updateOrdersOnChainBatchCOW(bot: any, cowResult: any, options: any = {}) {
    const replanDepth = Number.isFinite(Number(options?.replanDepth)) ? Number(options.replanDepth) : 0;
    bot._currentCycleId = (Number.isFinite(Number(bot._currentCycleId)) ? Number(bot._currentCycleId) : 0) + 1;
    const { workingGrid, workingIndexes, workingBoundary, actions } = cowResult;

    if (bot.config.dryRun) {
        const cancelCount = actions.filter((a: any) => a.type === COW_ACTIONS.CANCEL).length;
        const createCount = actions.filter((a: any) => a.type === COW_ACTIONS.CREATE).length;
        const updateCount = actions.filter((a: any) => a.type === COW_ACTIONS.UPDATE).length;
        if (cancelCount > 0) bot.manager.logger.log(`Dry run: would cancel ${cancelCount} orders`, 'info');
        if (createCount > 0) bot.manager.logger.log(`Dry run: would place ${createCount} new orders`, 'info');
        if (updateCount > 0) bot.manager.logger.log(`Dry run: would update ${updateCount} orders`, 'info');
        popPushedWorkingGrid(bot, cowResult);
        return { executed: true, hadRotation: false };
    }

    const chainOrderCandidates = Array.isArray(bot.manager?._lastUnmatchedChainOrders)
        ? bot.manager._lastUnmatchedChainOrders
        : [];
    const createSlotValidation = validateCreateTargetSlots(actions, bot.manager?.orders, bot.manager?.assets, chainOrderCandidates);
    if (!createSlotValidation.isValid) {
        for (const violation of createSlotValidation.violations) {
            let reason: string;
            switch (violation.reason) {
                case 'price_collision':
                    reason = `existing placed order ${violation.currentOrderId} at same price`;
                    break;
                case 'same_batch_price_collision':
                    reason = `another CREATE in the same batch at same price`;
                    break;
                case 'chain_orphan_collision':
                    reason = `unmatched on-chain order ${violation.currentOrderId} at same price`;
                    break;
                default:
                    reason = `existing orderId=${violation.currentOrderId}`;
            }
            bot.manager.logger.log(
                `[COW] Rejecting CREATE for slot ${violation.targetId}: ${reason} ` +
                `(type=${violation.currentType}, state=${violation.currentState})`,
                'error'
            );
        }

        // Differentiate violation types:
        //   * slot_occupied — hard constraint, not a false positive (the
        //     target slot literally has a placed order).  Abort the batch.
        //   * price_collision / chain_orphan_collision / same_batch_price_collision
        //     — tolerance-based; can false-positive on low-precision assets
        //     where calculatePriceTolerance exceeds the grid increment.
        //     Skip only the violating CREATEs so the rest of the batch
        //     (valid CREATEs, CANCELs, UPDATEs) still proceeds.
        const hasHardOccupiedViolation = createSlotValidation.violations.some(
            (v: any) => v.reason === 'slot_occupied'
        );

        if (hasHardOccupiedViolation) {
            popPushedWorkingGrid(bot, cowResult);
            return {
                executed: false,
                aborted: true,
                reason: 'CREATE_SLOT_OCCUPIED',
                violations: createSlotValidation.violations,
                hadRotation: false
            };
        }

        const violatingIds = createSlotValidation.violatingTargetIds;
        const filteredActions = actions.filter((action: any) => {
            if (action.type !== COW_ACTIONS.CREATE) return true;
            const targetId = action.id || action.order?.id;
            return !violatingIds.has(targetId);
        });

        actions.length = 0;
        actions.push(...filteredActions);

        // All violations at this point are tolerance-based; slot_occupied
        // would have aborted above.
        bot.manager.logger.log(
            `[COW] Filtered ${createSlotValidation.violations.length} tolerance-violating CREATE(s); ` +
            `${actions.length} action(s) remaining in batch`,
            'warn'
        );

        if (!actions.some((action: any) => action.type === COW_ACTIONS.CREATE)) {
            if (actions.length === 0) {
                // Same exactly-once marker discipline as the other early
                // returns: a pushed working grid must be popped here or the
                // caller would leak the stack entry.
                popPushedWorkingGrid(bot, cowResult);
                return { executed: false, hadRotation: false };
            }
        }
    }

    const hasCreateActions = actions.some((action: any) => action.type === COW_ACTIONS.CREATE);

    if (hasCreateActions && bot.manager?._recoveryExhaustedAt) {
        const exhaustedAge = Date.now() - bot.manager._recoveryExhaustedAt;
        bot.manager.logger.log?.(
            `[RECOVERY-EXHAUSTED] Blocking ${actions.filter((a: any) => a.type === COW_ACTIONS.CREATE).length} CREATE(s) ` +
            `(exhausted ${(exhaustedAge / 1000).toFixed(0)}s ago). ` +
            `Waiting for next fill or sync cycle to reset recovery state.`,
            'warn'
        );
        popPushedWorkingGrid(bot, cowResult);
        return {
            executed: false,
            aborted: true,
            reason: 'RECOVERY_EXHAUSTED',
            hadRotation: false
        };
    }

    const unmatchedChainOrders = Array.isArray(bot.manager?._lastUnmatchedChainOrders)
        ? bot.manager._lastUnmatchedChainOrders
        : [];
    const pendingBroadcasts: any[] = (bot.manager && bot.manager._pendingBroadcasts instanceof Map)
        ? Array.from(bot.manager._pendingBroadcasts.values()) as any[]
        : [];
    if (hasCreateActions && (unmatchedChainOrders.length > 0 || pendingBroadcasts.length > 0)) {
        if (pendingBroadcasts.length > 0) {
            bot.manager.logger.log(
                `[COW] Rejecting CREATE batch: ${pendingBroadcasts.length} pending broadcast(s) from a prior uncertain ` +
                `broadcast. Running recovery before placing replacement orders.`,
                'error'
            );
            if (typeof bot.manager.requestStructuralGridResync === 'function') {
                if (bot.manager._recoveryState) bot.manager._recoveryState = { ...bot.manager._recoveryState, structuralResyncRequested: true };
                await bot.manager.requestStructuralGridResync(
                    'pending broadcasts before COW create',
                    { pendingBroadcasts: pendingBroadcasts.map((p: any) => p.slotId) }
                );
            }
            try {
                await reconcileAfterUncertainBroadcast(
                    bot,
                    new BroadcastUncertainError(
                        'rejected CREATE batch had pending broadcasts',
                        {
                            operations: pendingBroadcasts.map((p: any) => p.order),
                            accountName: bot.account,
                            batchId: bot._currentBatchId || null,
                            payload: null,
                            timeoutMs: null
                        }
                    ),
                    []
                );
            } catch (recoverErr: any) {
                bot.manager.logger.log(
                    `[COW] Recovery from pending broadcasts failed: ${recoverErr?.message || recoverErr}`,
                    'error'
                );
            }
            popPushedWorkingGrid(bot, cowResult);
            return {
                executed: false,
                aborted: true,
                reason: 'PENDING_BROADCASTS',
                hadRotation: false
            };
        }

        const unmatchedSample = unmatchedChainOrders
            .slice(0, 3)
            .map((o: any) => formatUnmatchedChainOrderForLog(o))
            .join(' | ');
        bot.manager.logger.log(
            `[COW] ${unmatchedChainOrders.length} unmatched chain order(s) blocking CREATES ` +
            (unmatchedSample ? `(${unmatchedSample})` : '') +
            ` — adopting via sync instead of cancelling`,
            'info'
        );
        try {
            const accountRef = bot.account;
            const freshRead = await chainOrders.readOpenOrdersWithMeta(accountRef);
            // Truncated-read guard: a partial get_full_accounts window omits the
            // freshest orders; syncing on it would virtualize live slots and
            // re-create duplicates. Defer the adoption to a clean read — the
            // unmatched orders keep blocking CREATEs until then.
            if (freshRead.truncated) {
                bot.manager.logger.log(
                    '[COW] Post-guard chain snapshot TRUNCATED; skipping adoption sync (partial snapshot would virtualize live slots) — unmatched chain orders keep blocking CREATEs',
                    'warn'
                );
            } else if (freshRead.orders && freshRead.orders.length > 0) {
                const freshSnapshot = freshRead.orders;
                const syncResult = await bot.manager.syncFromOpenOrders(freshSnapshot, {
                    // Accounting enabled: the adopted chain orders were never
                    // registered in master (they are unmatched/orphan), so the
                    // adoption must lock their capital. skipAccounting:true would
                    // leave the optimistic balances drifted until the next fetch
                    // — inconsistent with the open-orders loop convention
                    // ('readOpenOrders' → skipAccounting:false).
                    skipAccounting: false,
                });
                if (syncResult && Array.isArray(syncResult.unmatchedChainOrders)) {
                    const processed = (syncResult.filledOrders?.length || 0) +
                                      (syncResult.updatedOrders?.length || 0) +
                                      (syncResult.ordersNeedingCorrection?.length || 0);
                    if (processed > 0) {
                        bot.manager._lastUnmatchedChainOrders = syncResult.unmatchedChainOrders;
                        bot.manager.logger.log(
                            `[COW] Adopted chain order(s) via sync: ${processed} processed, ` +
                            `${syncResult.unmatchedChainOrders.length} still unmatched`,
                            'info'
                        );
                    } else {
                        const syncUnmatchedCount = syncResult.unmatchedChainOrders.length;
                        bot.manager.logger.log(
                            `[COW] Sync returned without processing (processed=0, ` +
                            `unmatched=${syncUnmatchedCount} in result, ` +
                            `_lastUnmatchedChainOrders=${unmatchedChainOrders.length}). ` +
                            `Structural resync will handle adoption.`,
                            syncUnmatchedCount > 0 ? 'warn' : 'debug'
                        );
                        if (syncUnmatchedCount > 0 && syncUnmatchedCount !== unmatchedChainOrders.length) {
                            bot.manager._lastUnmatchedChainOrders = syncResult.unmatchedChainOrders.map((o: any) => ({ ...o }));
                            bot.manager.logger.log(
                                `[COW] Updated _lastUnmatchedChainOrders from sync result: ` +
                                `${unmatchedChainOrders.length} → ${syncUnmatchedCount}`,
                                'debug'
                            );
                        }
                    }
                }
            }
        } catch (syncErr: any) {
            bot.manager.logger.log(
                `[COW] Failed to sync/unmatched orders: ${syncErr?.message || syncErr}`,
                'warn'
            );
        }
        if (typeof bot.manager.requestStructuralGridResync === 'function') {
            if (bot.manager._recoveryState) bot.manager._recoveryState = { ...bot.manager._recoveryState, structuralResyncRequested: true };
            await bot.manager.requestStructuralGridResync(
                'unmatched chain orders before COW create',
                { unmatchedChainOrders: unmatchedChainOrders }
            );
        }
        bot.manager.logger.log(
            `[COW] Rejecting CREATE batch after sync: working grid invalidated by master mutation`,
            'info'
        );
        popPushedWorkingGrid(bot, cowResult);
        return {
            executed: false,
            aborted: true,
            reason: 'UNMATCHED_CHAIN_ORDERS',
            hadRotation: false
        };
    }

    const { assetA, assetB } = bot.manager.assets;
    const operations: any[] = [];
    const opContexts: any[] = [];
    const skippedUpdateSlotIds = new Set();
    let skippedUpdateCount = 0;

    const idsToLock = new Set();
    for (const action of actions) {
        if (action.type === COW_ACTIONS.CANCEL && action.orderId) {
            idsToLock.add(action.orderId);
            if (action.id) idsToLock.add(action.id);
        } else if (action.type === COW_ACTIONS.CREATE && action.id) {
            idsToLock.add(action.id);
        } else if (action.type === COW_ACTIONS.UPDATE && action.orderId) {
            idsToLock.add(action.orderId);
            if (action.id) idsToLock.add(action.id);
        }
    }

    bot.manager.lockOrders(idsToLock);

    try {
        bot._batchInFlight++;
        bot._markGridActivity('batch start');
        bot.manager._setRebalanceState(REBALANCE_STATES.BROADCASTING);
        bot.manager.startBroadcasting();

        for (const action of actions) {
            if (action.type === COW_ACTIONS.CANCEL) {
                try {
                    const op = await chainOrders.buildCancelOrderOp(bot.account, action.orderId);
                    operations.push(op);
                    const order = bot.manager.orders.get(action.id) || { id: action.id, orderId: action.orderId };
                    opContexts.push({ kind: 'cancel', order });
                } catch (err: any) {
                    const orderNotFound = /\bnot found\b/i.test(getErrorMessage(err)) || /\bdoes not exist\b/i.test(getErrorMessage(err));
                    if (orderNotFound) {
                        bot.manager.logger.log(
                            `[COW] Cancel skipped for ${action.id} (${action.orderId}): order already removed from chain`,
                            'debug'
                        );
                    } else {
                        bot.manager.logger.log(`Failed to prepare cancel op for ${action.id}: ${getErrorMessage(err)}`, 'error');
                    }
                }
            } else if (action.type === COW_ACTIONS.CREATE) {
                try {
                    const order = action.order;
                    const sizeValidation = validateOrderSizeForExecution(
                        bot,
                        order.size,
                        order.type,
                        order,
                        order.size
                    );
                    if (!sizeValidation.isValid) {
                        bot.manager.logger.log(
                            `Skipping create op for ${action.id}: ${sizeValidation.reason}`,
                            'warn'
                        );
                        continue;
                    }
                    const liveSlot = bot.manager.orders.get(order.id);
                    const plannedPrice = Number(order.price);
                    const livePrice = liveSlot ? Number(liveSlot.price) : NaN;
                    const priceDrift = Number.isFinite(plannedPrice) && Number.isFinite(livePrice)
                        ? Math.abs(livePrice - plannedPrice)
                        : 0;
                    const effectiveOrder = (priceDrift > 0)
                        ? { ...order, price: livePrice, size: order.size, type: order.type }
                        : order;
                    if (priceDrift > 0) {
                        bot.manager.logger.log(
                            `[COW] Pre-broadcast price freshness: slot ${order.id} ` +
                            `drifted from planned=${plannedPrice} to live=${livePrice} ` +
                            `(diff=${priceDrift}); rebuilding CREATE op with live price.`,
                            'debug'
                        );
                    }

                    const createPrice = effectiveOrder.price;
                    const createSize = effectiveOrder.size;

                    const batchCollision = findPriceCollision(
                        opContexts,
                        order.id,
                        createPrice, createSize, order.type, bot.manager.assets,
                        (ctx: any) => ctx.kind === 'create'
                    );
                    if (batchCollision) {
                        bot.manager.logger.log(
                            `[COW] Skipping CREATE for ${order.id} at ${Format.formatPrice6(createPrice)}: ` +
                            `same-batch CREATE ${batchCollision.id} already at ` +
                            `price ${Format.formatPrice6(batchCollision.order.price)}. ` +
                            `The next reconcile cycle will resolve the mismatch.`,
                            'warn'
                        );
                        continue;
                    }

                    const args = buildCreateOrderArgs(effectiveOrder, assetA, assetB);
                    const buildResult = await chainOrders.buildCreateOrderOp(
                        bot.account,
                        args.amountToSell,
                        args.sellAssetId,
                        args.minToReceive,
                        args.receiveAssetId,
                        null
                    );
                    if (!buildResult) {
                        bot.manager.logger.log(
                            `Skipping create op for ${action.id}: amounts would round to 0 on blockchain`,
                            'warn'
                        );
                        continue;
                    }
                    operations.push(buildResult.op);
                    opContexts.push({ kind: 'create', id: order.id, order: effectiveOrder, args, finalInts: buildResult.finalInts });
                    recordPendingBroadcast(bot, {
                        opIndex: operations.length - 1,
                        ctxIndex: opContexts.length - 1,
                        order: effectiveOrder,
                        finalInts: buildResult.finalInts
                    });
                } catch (err: any) {
                    bot.manager.logger.log(`Failed to prepare create op for ${action.id}: ${getErrorMessage(err)}`, 'error');
                }
            } else if (action.type === COW_ACTIONS.UPDATE) {
                try {
                    if (action.newGridId && action.newGridId !== action.id) {
                        const masterOrder = bot.manager.orders.get(action.id);
                        const orderType = action.order?.type || masterOrder?.type;
                        const newPrice = Number.isFinite(Number(action.newPrice))
                            ? Number(action.newPrice)
                            : Number(action.order?.price);
                        const newSize = Number.isFinite(Number(action.newSize))
                            ? Number(action.newSize)
                            : Number(action.order?.size || 0);

                        if (!masterOrder || !action.orderId || !orderType || !Number.isFinite(newPrice) || newSize <= 0) {
                            continue;
                        }

                        const rotationSizeValidation = validateOrderSizeForExecution(
                            bot,
                            newSize,
                            orderType,
                            action.order,
                            newSize
                        );
                        if (!rotationSizeValidation.isValid) {
                            bot.manager.logger.log(
                                `Skipping rotation update ${action.id} -> ${action.newGridId}: ${rotationSizeValidation.reason}`,
                                'warn'
                            );
                            continue;
                        }

                        const { amountToSell, minToReceive } = buildCreateOrderArgs(
                            { type: orderType, size: newSize, price: newPrice },
                            assetA,
                            assetB
                        );

                        const buildResult = await chainOrders.buildUpdateOrderOp(
                            bot.account,
                            action.orderId,
                            { amountToSell, minToReceive, newPrice, orderType },
                            masterOrder.rawOnChain || null
                        );
                        if (!buildResult) {
                            skippedUpdateCount++;
                            if (action.id) skippedUpdateSlotIds.add(action.id);
                            if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                            bot.manager.logger.log(
                                `[COW] Skipping rotation update ${action.id} -> ${action.newGridId}: no blockchain delta`,
                                'debug'
                            );
                            continue;
                        }

                        operations.push(buildResult.op);
                        opContexts.push({
                            kind: 'rotation',
                            rotation: {
                                oldOrder: { ...masterOrder },
                                newGridId: action.newGridId,
                                newPrice,
                                newSize,
                                type: orderType
                            },
                            finalInts: buildResult.finalInts
                        });
                        continue;
                    }

                    const newSize = Number.isFinite(Number(action.newSize))
                        ? Number(action.newSize)
                        : Number(action.order?.size || 0);

                    const masterOrder = bot.manager.orders.get(action.id);
                    const orderType = action.order?.type || masterOrder?.type;
                    const cachedRawOnChain = masterOrder?.rawOnChain || action.order?.rawOnChain || null;

                    const op = await chainOrders.buildUpdateOrderOp(
                        bot.account,
                        action.orderId,
                        { amountToSell: newSize, orderType },
                        cachedRawOnChain
                    );
                    if (!op) {
                        skippedUpdateCount++;
                        if (action.id) skippedUpdateSlotIds.add(action.id);
                        if (action.newGridId) skippedUpdateSlotIds.add(action.newGridId);
                        bot.manager.logger.log(
                            `[COW] Skipping size update ${action.id} (${action.orderId}): no blockchain delta`,
                            'debug'
                        );
                        continue;
                    }
                    operations.push(op.op);
                    const partialOrder = masterOrder || {
                        id: action.id,
                        orderId: action.orderId,
                        type: orderType
                    };
                    opContexts.push({ kind: 'size-update', updateInfo: { partialOrder, newSize }, finalInts: op.finalInts });
                } catch (err: any) {
                    const orderNotFound = /\bnot found\b/i.test(getErrorMessage(err)) || /\bdoes not exist\b/i.test(getErrorMessage(err));
                    if (orderNotFound) {
                        try {
                            const fbOrder = action.order || bot.manager.orders.get(action.id);
                            const fbType = fbOrder?.type;
                            const fbSize = action.newSize || fbOrder?.size || 0;
                            const targetSlotId = action.newGridId || action.id;
                            const plannedPrice = action.newPrice || action.order?.price || 0;
                            const liveSlotForPrice = bot.manager.orders.get(targetSlotId);
                            const livePrice = liveSlotForPrice ? Number(liveSlotForPrice.price) : NaN;
                            const priceDrift = Number.isFinite(plannedPrice) && Number.isFinite(livePrice)
                                ? Math.abs(livePrice - plannedPrice)
                                : 0;
                            const fbPrice = (priceDrift > 0) ? livePrice : plannedPrice;
                            if (priceDrift > 0) {
                                bot.manager.logger.log(
                                    `[COW] CREATE fallback price drift for ${action.id} -> ${targetSlotId}: ` +
                                    `planned=${plannedPrice} live=${livePrice} (diff=${priceDrift})`,
                                    'debug'
                                );
                            }
                            const sizeCheck = validateOrderSizeForExecution(bot, fbSize, fbType, fbOrder, fbSize);
                            if (!sizeCheck.isValid) {
                                bot.manager.logger.log(
                                    `[COW] CREATE fallback for ${action.id} rejected by size validation: ${sizeCheck.reason}`,
                                    'warn'
                                );
                            } else if (fbType && fbSize > 0 && fbPrice > 0) {
                                const fbCollision = findPriceCollision(
                                    bot.manager.orders.values(),
                                    targetSlotId,
                                    fbPrice, fbSize, fbType, bot.manager.assets,
                                    isOrderPlaced
                                );
                                if (fbCollision) {
                                    bot.manager.logger.log(
                                        `[COW] Skipping CREATE fallback for ${targetSlotId} at ${Format.formatPrice6(fbPrice)}: ` +
                                        `existing placed order ${fbCollision.id} (${fbCollision.orderId}) ` +
                                        `already at price ${Format.formatPrice6(fbCollision.price)}.`,
                                        'warn'
                                    );
                                    continue;
                                }
                                const fbBatchCollision = findPriceCollision(
                                    opContexts,
                                    targetSlotId,
                                    fbPrice, fbSize, fbType, bot.manager.assets,
                                    (ctx: any) => ctx.kind === 'create'
                                );
                                if (fbBatchCollision) {
                                    bot.manager.logger.log(
                                        `[COW] Skipping CREATE fallback for ${targetSlotId} at ${Format.formatPrice6(fbPrice)}: ` +
                                        `same-batch CREATE ${fbBatchCollision.id} already at ` +
                                        `price ${Format.formatPrice6(fbBatchCollision.order.price)}.`,
                                        'warn'
                                    );
                                    continue;
                                }
                                const fbArgs = buildCreateOrderArgs(
                                    { type: fbType, size: fbSize, price: fbPrice },
                                    assetA, assetB
                                );
                                const fbResult = await chainOrders.buildCreateOrderOp(
                                    bot.account,
                                    fbArgs.amountToSell,
                                    fbArgs.sellAssetId,
                                    fbArgs.minToReceive,
                                    fbArgs.receiveAssetId,
                                    null
                                );
                                if (fbResult) {
                                    operations.push(fbResult.op);
                                    opContexts.push({
                                        kind: 'create',
                                        id: targetSlotId,
                                        order: { id: targetSlotId, type: fbType, price: fbPrice, size: fbSize },
                                        args: { amountToSell: fbArgs.amountToSell, minToReceive: fbArgs.minToReceive },
                                        finalInts: fbResult.finalInts
                                    });
                                    recordPendingBroadcast(bot, {
                                        opIndex: operations.length - 1,
                                        ctxIndex: opContexts.length - 1,
                                        order: { id: targetSlotId, type: fbType, price: fbPrice, size: fbSize },
                                        finalInts: fbResult.finalInts
                                    });
                                    bot.manager.logger.log(
                                        `[COW] Recovered "not found" for ${action.id}: converted UPDATE to CREATE for slot ${targetSlotId}`,
                                        'warn'
                                    );
                                    continue;
                                }
                            }
                        } catch (fbErr: any) {
                            bot.manager.logger.log(
                                `[COW] CREATE fallback also failed for ${action.id}: ${getErrorMessage(fbErr)}`,
                                'warn'
                            );
                        }
                    }
                    bot.manager.logger.log(`Failed to prepare update op for ${action.id}: ${getErrorMessage(err)}`, 'error');
                }
            }
        }

        if (skippedUpdateCount > 0) {
            restoreSkippedUpdateSlotsInWorkingGrid(bot, workingGrid, skippedUpdateSlotIds, skippedUpdateCount);
        }

        if (operations.length === 0) {
            // Pop the working grid: in the re-plan recursion the fresh plan's
            // grid was pushed by performSafeRebalance, and nothing downstream
            // will commit it — leaving it on the stack would stick the manager
            // in REBALANCING permanently (the outer frame already popped its
            // own grid before recursing). Guarded on the push marker so plan
            // path calls (never pushed) cannot pop an unrelated entry.
            popPushedWorkingGrid(bot, cowResult);
            return { executed: false, hadRotation: false };
        }

        const validation = validateOperationFunds(bot, operations, assetA, assetB);
        bot.manager.logger.log(validation.summary, validation.isValid ? 'info' : 'warn');

        if (!validation.isValid) {
            bot.manager.logger.log(`Skipping batch broadcast: ${validation.violations!.length} fund violation(s) detected`, 'warn');
            popPushedWorkingGrid(bot, cowResult);
            return { executed: false, hadRotation: false };
        }

        // Refuse stale plans BEFORE broadcasting: a master-grid change during
        // planning (fills, syncs) makes the working grid invalid. Broadcasting
        // anyway would place orders the commit will refuse to register, leaving
        // on-chain state ahead of the grid.
        // NOTE: the commit-time evaluateCommit also rejects empty deltas; here
        // (pre-broadcast) that case is already covered by the operations.length
        // guard above, so only staleness and version-mismatch are checked.
        const preBroadcastGuard = evaluateCommit(workingGrid, {
            hasLock: false,
            currentVersion: bot.manager._gridVersion
        });
        if (!preBroadcastGuard.canCommit) {
            // Bounded re-plan + proceed — policy documented on replanStaleBatch.
            const replan = await replanStaleBatch(bot, cowResult, replanDepth, preBroadcastGuard);
            if (replan.handled) {
                return replan.result;
            }
            // Fall through: proceed with the current plan (bounded policy).
        }

        await bot._ensureCredentialDaemonWritable('COW batch broadcast');

        bot.manager.logger.log(`[COW] Broadcasting batch with ${operations.length} operations...`, 'info');
        bot._lastBroadcastHeartbeatAt = Date.now();
        const execution = await executeWithRetryOnUncertain(bot, operations, opContexts);
        const result = execution.result;
        const executedContexts = execution.opContexts;

        bot.manager.pauseFundRecalc();
        try {
            bot.manager._throwOnIllegalState = true;
            
            if (result.success) {
                const preCommitResults = extractOperationResults(result, 'pre-commit-integrity', bot.manager?.logger?.log?.bind(bot.manager?.logger));
                const missingCreateResults = findMissingCreateResultContexts(preCommitResults, executedContexts);
                if (missingCreateResults.length > 0) {
                    const missingSlots = missingCreateResults
                        .map((item: any) => item.ctx?.order?.id || item.ctx?.id || `op-${item.index}`)
                        .join(', ');
                    bot.manager.logger.log(
                        `[COW] Refusing to commit working grid: ${missingCreateResults.length} CREATE op(s) ` +
                        `returned no chainOrderId (${missingSlots}). Discarding working grid and syncing from chain.`,
                        'error'
                    );
                    popPushedWorkingGrid(bot, cowResult);
                    markMissingCreateResultsAsStructuralBlocker(bot, missingCreateResults);
                    await recoverAfterMissingCreateResults(bot, 'missing create operation results');
                    return {
                        executed: false,
                        hadRotation: false,
                        missingCreateResults: missingCreateResults.map((item: any) => ({
                            index: item.index,
                            slotId: item.ctx?.order?.id || item.ctx?.id || null
                        }))
                    };
                }

                // Pre-apply rotation state transitions to the working grid so the
                // COW commit is truly atomic for structural changes (source → VIRTUAL,
                // dest → ACTIVE with orderId). Remaining post-commit patches in
                // processBatchResults are limited to rawOnChain metadata enrichment
                // that depends on broadcast result data.
                applyRotationTransitionsToWorkingGrid(bot, workingGrid, executedContexts);

                bot.manager.logger.log('[COW] Blockchain success - committing working grid to master', 'info');
                // _commitWorkingGrid releases the stack entry on every settle
                // path (return or throw) and clears the push marker via
                // options.result, so a later throw in this frame (e.g.
                // processBatchResults after a successful commit) cannot pop a
                // second time for the same grid in the batch catch below.
                const commitOk: boolean = await bot.manager._commitWorkingGrid(
                    workingGrid,
                    workingIndexes,
                    workingBoundary,
                    { skipRecalc: true, result: cowResult }
                );
                if (!commitOk) {
                    // Master changed during broadcast (e.g. a fill landed and was
                    // processed concurrently) so the commit was refused. The batch
                    // is on chain; adopt the placed orders from the chain so master
                    // converges instead of remaining divergent until a later sync.
                    bot.manager.logger.log(
                        '[COW] Commit refused after broadcast; adopting placed orders from chain to keep master in sync',
                        'warn'
                    );
                    const adopted = await adoptPlacedBatchFromChain(bot, chainOrders, '[COW]');
                    if (!adopted) {
                        // Chain state unknown (empty/lagging read or sync failure):
                        // keep the pending-broadcast protection so a later plan
                        // cannot duplicate the placed orders, and let the structural
                        // resync adopt them from the chain.
                        bot.manager.logger.log(
                            '[COW] Commit refused and chain adoption unavailable; keeping pending-broadcast protection pending structural resync',
                            'error'
                        );
                        await requestStructuralResync(
                            bot,
                            'commit refused after broadcast (chain adoption unavailable)',
                            { reason: 'chain-adoption-unavailable' }
                        );
                        return { executed: false, hadRotation: false, commitRefused: true, chainAdoptionPending: true };
                    }
                    // Deduct create fees for the placed orders (mirrors
                    // processBatchResults, which the refused path bypasses).
                    await applyAdoptionFeeAccounting(bot, executedContexts);
                    await persistGridAndClearPendingBroadcasts(bot, '[COW]');
                    return { executed: false, hadRotation: false, commitRefused: true };
                }
                
                const batchResult = await processBatchResults(bot, result, executedContexts);

                const persistResult = await bot.manager.persistGrid();
                if (persistResult && (persistResult.skipped || persistResult.isValid === false)) {
                    bot.manager.logger.log(
                        `[COW][PERSIST-GUARD] First persist attempt was ` +
                        `${persistResult.skipped ? 'skipped' : 'invalid'} ` +
                        `(${persistResult.reason || 'no reason'}); retrying once before ` +
                        `clearing working grid reference.`,
                        'warn'
                    );
                    bot.manager._persistenceWarning = persistResult;
                    const retryResult = await bot.manager.persistGrid();
                    if (retryResult && (retryResult.skipped || retryResult.isValid === false)) {
                        bot.manager.logger.log(
                            `[COW][PERSIST-GUARD] Retry also skipped/invalid ` +
                            `(${retryResult.reason || 'no reason'}). Master grid in memory ` +
                            `is ahead of disk snapshot; structural resync requested.`,
                            'error'
                        );
                        if (typeof bot.manager.requestStructuralGridResync === 'function') {
                            bot.manager._recoveryState = { ...bot.manager._recoveryState, structuralResyncRequested: true };
                            await bot.manager.requestStructuralGridResync(
                                'persistence guard triggered after COW batch',
                                { persistReason: retryResult.reason || 'unknown' }
                            );
                        }
                    } else {
                        delete bot.manager._persistenceWarning;
                    }
                } else if (bot.manager._persistenceWarning) {
                    delete bot.manager._persistenceWarning;
                }

                bot._metrics.batchesExecuted++;
                clearPendingBroadcasts(bot.manager?._pendingBroadcasts);

                return { ...batchResult, executed: true, hadRotation: true };
            } else {
                bot.manager.logger.log('[COW] Blockchain failed - working grid discarded, master unchanged', 'warn');
                popPushedWorkingGrid(bot, cowResult);
                clearPendingBroadcasts(bot.manager?._pendingBroadcasts);
                return { ...result, executed: false, hadRotation: false };
            }
        } finally {
            bot.manager._throwOnIllegalState = false;
            await bot.manager.resumeFundRecalc();
            bot.manager.stopBroadcasting();
            const createCount = actions.filter((a: any) => a.type === COW_ACTIONS.CREATE).length;
            const cancelCount = actions.filter((a: any) => a.type === COW_ACTIONS.CANCEL).length;
            bot.manager.logger.logFundsStatus(bot.manager, `AFTER COW batch (created=${createCount}, cancelled=${cancelCount})`);
        }

    } catch (err: any) {
        bot.manager.logger.log(`[COW] Batch transaction failed: ${getErrorMessage(err)}`, 'error');
        if (err?.partialOnChainState) {
            bot.manager.logger.log(
                `[COW] Non-atomic grouped execution detected (${err.groupsBroadcast}/${err.groupsTotal} groups broadcast). Local rollback cannot undo confirmed on-chain operations; next sync/reconcile will converge state.`,
                'warn'
            );
        }
        bot.manager.stopBroadcasting();

        // Chain polling: for uncertain broadcasts (not partial), try to confirm
        // CREATE operations on chain before clearing the working grid. If all
        // planned CREATEs are confirmed, the entire batch was accepted atomically
        // and we can commit the working grid directly, bypassing the expensive
        // reconciliation state machine. This handles the ~90% case where the
        // chain accepted the transaction but the response was lost.
        if (err instanceof BroadcastUncertainError && err.partialOnChainState !== true) {
            try {
                const confirmation = await pollChainForConfirmation(bot, opContexts);
                if (confirmation.allConfirmed) {
                    // pollChainForConfirmation only verifies CREATE ops (see its doc).
                    // If the batch had non-CREATE ops (UPDATEs/CANCELs), they are NOT
                    // confirmed here — we assume atomic batch acceptance.  Log the
                    // composition so a misbehaving partial-broadcast (partialOnChainState
                    // incorrectly false) leaves a forensic trace.
                    const createCount = confirmation.confirmed.length;
                    const totalOps = opContexts.length;
                    if (createCount < totalOps) {
                        bot.manager.logger.log(
                            `[COW][UNCERTAIN] Chain polling confirmed ${createCount}/${totalOps} CREATEs on chain ` +
                            `(${totalOps - createCount} non-CREATE ops assumed confirmed via atomic batch). ` +
                            `Committing working grid.`,
                            'info'
                        );
                    } else {
                        bot.manager.logger.log(
                            `[COW][UNCERTAIN] Chain polling confirmed all ${createCount} CREATE(s) on chain. Committing working grid directly.`,
                            'info'
                        );
                    }
                    applyRotationTransitionsToWorkingGrid(bot, workingGrid, opContexts);
                    // Same exactly-once discipline as the success path:
                    // _commitWorkingGrid pops on every settle path and clears
                    // the push marker via options.result, so a later throw here
                    // must not pop again in the batch catch below.
                    const pollCommitOk: boolean = await bot.manager._commitWorkingGrid(
                        workingGrid,
                        workingIndexes,
                        workingBoundary,
                        { skipRecalc: true, result: cowResult }
                    );
                    if (!pollCommitOk) {
                        // Master moved while polling — same recovery as the
                        // refused-commit path: adopt from chain, keep pending
                        // protection if adoption is unavailable.
                        bot.manager.logger.log(
                            `[COW][UNCERTAIN] Poll-confirmed commit refused; adopting placed orders from chain`,
                            'warn'
                        );
                        const pollAdopted = await adoptPlacedBatchFromChain(bot, chainOrders, '[COW][UNCERTAIN]');
                        if (!pollAdopted) {
                            bot.manager.logger.log(
                                '[COW][UNCERTAIN] Poll-refused commit with unavailable chain adoption; keeping pending protection pending structural resync',
                                'error'
                            );
                            await requestStructuralResync(
                                bot,
                                'poll-confirmed commit refused (chain adoption unavailable)',
                                { reason: 'chain-adoption-unavailable' }
                            );
                            return { executed: false, hadRotation: false, commitRefused: true, chainAdoptionPending: true };
                        }
                        await applyAdoptionFeeAccounting(bot, opContexts);
                        await persistGridAndClearPendingBroadcasts(bot, '[COW][UNCERTAIN]');
                        return { executed: false, hadRotation: false, commitRefused: true, uncertainResolved: true };
                    }
                    // Enrich master grid with chain-assigned order IDs and amounts;
                    // accounting enabled so the adopted orders' capital is locked
                    // and any cancelled orders release theirs. The adoption result
                    // is authoritative: a truncated read right after the confirming
                    // poll can omit the batch's own fresh creates (they sort last
                    // in the by_account index), so clearing the pending protection
                    // on a failed adoption would let the next cycle re-create the
                    // VIRTUAL slots as duplicate on-chain orders. Keep the
                    // protection and defer to a structural resync instead.
                    const pollAdoptedOk = await adoptPlacedBatchFromChain(bot, chainOrders, '[COW][UNCERTAIN]');
                    if (!pollAdoptedOk) {
                        bot.manager.logger.log(
                            '[COW][UNCERTAIN] Poll-confirmed commit with unavailable chain adoption; keeping pending protection pending structural resync',
                            'error'
                        );
                        await requestStructuralResync(
                            bot,
                            'poll-confirmed commit (chain adoption unavailable)',
                            { reason: 'chain-adoption-unavailable' }
                        );
                        return { executed: false, hadRotation: false, commitRefused: false, chainAdoptionPending: true };
                    }
                    // The commit happened without processBatchResults (no success
                    // result to extract); deduct create fees so the optimistic
                    // balance reflects the on-chain cost.
                    await applyAdoptionFeeAccounting(bot, opContexts);
                    await persistGridAndClearPendingBroadcasts(bot, '[COW][UNCERTAIN]');
                    return { executed: true, hadRotation: false, uncertainResolved: true };
                }
            } catch (pollErr: any) {
                bot.manager.logger.log(
                    `[COW][UNCERTAIN] Chain polling threw unexpectedly: ${getErrorMessage(pollErr)}. Falling back to reconciliation.`,
                    'error'
                );
            }
        }

        popPushedWorkingGrid(bot, cowResult);

        if (err instanceof BroadcastUncertainError) {
            return await reconcileAfterUncertainBroadcast(bot, err, opContexts);
        }

        const hardAbortResult = await bot._handleBatchHardAbort(err, 'COW batch processing', operations.length);
        if (hardAbortResult) return hardAbortResult;

        const staleOrderIds = new Set();
        const patterns = [
            /Limit order (1\.7\.\d+) does not exist/g,
            /Unable to find Object (1\.7\.\d+)/g,
            /object (1\.7\.\d+) (?:does not exist|not found)/gi
        ];
        for (const pattern of patterns) {
            let m;
            while ((m = pattern.exec(getErrorMessage(err))) !== null) {
                staleOrderIds.add(m[1]);
            }
        }

        if (/Cannot deduct all or more from order than order contains/.test(getErrorMessage(err))) {
            return await bot._recoverBatchSizeDrift(err, opContexts);
        }

        if (staleOrderIds.size > 0) {
            return await bot._recoverExplicitStaleOrders(staleOrderIds, 'cow-stale-order-cleanup');
        }

        throw err;
    } finally {
        bot._batchInFlight--;
        bot._markGridActivity('batch end');
        bot.manager.unlockOrders(idsToLock);

        if (!bot._shuttingDown && bot._incomingFillQueue.length > 0) {
            bot._scheduleFillConsumerRestart(chainOrders);
        }
    }
}

/**
 * Request a structural grid resync with the recovery-state flag raised, so a
 * later plan cannot duplicate orders placed by a batch whose chain adoption is
 * pending. No-op when the manager has no structural-resync handler.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} reason - Human-readable resync reason
 * @param {Object} [details={}] - Details passed to the resync handler
 */
async function requestStructuralResync(bot: any, reason: string, details: any = {}) {
    if (typeof bot.manager?.requestStructuralGridResync !== 'function') return;
    if (bot.manager._recoveryState) {
        bot.manager._recoveryState = { ...bot.manager._recoveryState, structuralResyncRequested: true };
    }
    await bot.manager.requestStructuralGridResync(reason, details);
}

/**
 * Adopt a batch's placed orders from the chain after the commit was refused
 * or after a poll-confirmed uncertain commit. The batch ops are already on
 * chain but never reached master, so a full chain sync with accounting
 * enabled locks the placed orders' capital and releases any cancelled ones.
 * Returns true when the adoption sync ran; false when the chain state could
 * not be read (empty/lagging read, truncated read, or sync failure) — the
 * caller then keeps the pending-broadcast protection and defers adoption to
 * a structural resync.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module
 * @param {string} logPrefix - Log prefix for sync failure messages
 * @returns {Promise<boolean>}
 */
async function adoptPlacedBatchFromChain(bot: any, chainOrders: any, logPrefix: string): Promise<boolean> {
    try {
        const accountRef = bot.accountId || bot.account?.id || bot.account;
        const freshRead = await readOpenOrdersWithMetaSafe(chainOrders, accountRef);
        // A truncated read (get_full_accounts caps the limit_orders window and
        // fresh creates sort last) omits the very orders this batch just
        // broadcast — the adoption sync could not register them, and clearing
        // the pending-broadcast protection would let the next cycle re-create
        // them as duplicates on chain. Treat truncated like an unreadable
        // chain state: keep the protection and defer to a structural resync.
        if (freshRead.truncated) {
            bot.manager.logger.log(
                `${logPrefix} Chain read TRUNCATED after batch broadcast; adoption deferred (pending-broadcast protection kept)`,
                'warn'
            );
            return false;
        }
        const freshChain = freshRead.orders;
        if (freshChain.length > 0 && typeof bot.manager.syncFromOpenOrders === 'function') {
            await bot.manager.syncFromOpenOrders(freshChain, { skipAccounting: false });
            return true;
        }
    } catch (syncErr: any) {
        bot.manager.logger.log(
            `${logPrefix} Chain sync after batch broadcast failed: ${getErrorMessage(syncErr)}`,
            'error'
        );
    }
    return false;
}

/**
 * Persist the master grid after a chain adoption and clear the pending
 * broadcast protection. Persist failures are logged, not thrown — the
 * in-memory master is authoritative and the next sync/persist converges disk.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} logPrefix - Log prefix for persist failure messages
 */
async function persistGridAndClearPendingBroadcasts(bot: any, logPrefix: string) {
    try {
        await bot.manager.persistGrid();
    } catch (persistErr: any) {
        bot.manager.logger.log(
            `${logPrefix} Persist after chain adoption failed: ${getErrorMessage(persistErr)}`,
            'error'
        );
    }
    clearPendingBroadcasts(bot.manager?._pendingBroadcasts);
}

/**
 * Apply BTS create-fee accounting for a batch that bypassed the normal
 * processBatchResults pipeline (commit refused after broadcast, or
 * poll-confirmed uncertain commit). Mirrors the create branch of
 * processBatchResults using master-grid state after chain adoption, so the
 * optimistic balance reflects the on-chain create cost.
 *
 * Safe on adopted/committed slots only: the slot must already carry its
 * orderId, so the transition old(ACTIVE)→new(ACTIVE) is delta-zero and only
 * the fee is applied — no double capital commitment. Cancel/rotation fee
 * accounting is intentionally skipped: the chain sync already performed the
 * capital release for cancelled orders (diff-based, applying it again would
 * double-release), and rotations without a committed destination cannot be
 * accounted locally.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array<Object>} contexts - Executed op contexts (create/rotation/cancel)
 */
async function applyAdoptionFeeAccounting(bot: any, contexts: any) {
    if (!bot.manager?.accountant || !Array.isArray(contexts) || contexts.length === 0) return;
    const btsFeeData = getAssetFeesSafe('BTS');
    const btsSide = (typeof bot.manager.accountant._getBtsOrderType === 'function')
        ? bot.manager.accountant._getBtsOrderType()
        : null;

    for (const ctx of contexts) {
        if (ctx?.kind === 'create') {
            const slot = ctx.order?.id ? bot.manager.orders.get(ctx.order.id) : null;
            if (!slot?.orderId) continue;
            try {
                await bot.manager.synchronizeWithChain({
                    gridOrderId: ctx.order.id,
                    chainOrderId: slot.orderId,
                    isPartialPlacement: false,
                    expectedType: ctx.order.type,
                    fee: btsFeeData?.createFee || 0,
                }, 'createOrder');
            } catch (feeErr: any) {
                bot.manager.logger.log(
                    `[COW] Adoption fee accounting failed for create slot ${ctx.order.id}: ${getErrorMessage(feeErr)}`,
                    'warn'
                );
            }
        } else if (ctx?.kind === 'cancel') {
            // The cancel landed but the commit was refused / the adoption path
            // bypassed processBatchResults. Master still holds the slot; the
            // next sync's phantom cleanup releases its commitment with fee 0 —
            // charge the cancel fee here so the optimistic BTS balance reflects
            // the on-chain cost exactly once (mirrors the sync's
            // 'cancel-order-unmatched-fee' pattern; the deferred-fee refund is
            // reconciled by the next sync's fill/cancel processing).
            if (btsSide && btsFeeData?.cancelFee > 0) {
                try {
                    await bot.manager.accountant.adjustTotalBalance(btsSide, -btsFeeData.cancelFee, 'cancel-adopt-fee');
                } catch (feeErr: any) {
                    bot.manager.logger.log(
                        `[COW] Adoption fee accounting failed for cancel ${ctx.order?.orderId}: ${getErrorMessage(feeErr)}`,
                        'warn'
                    );
                }
            }
        } else if (ctx?.kind === 'size-update' || ctx?.kind === 'rotation') {
            // Same reasoning as cancels: the update landed but its fee was never
            // charged on this path; the next sync's size reconciliation applies
            // the chain state without an update fee (fee 0), so charge it once
            // here to prevent optimistic BTS drift.
            if (btsSide && btsFeeData?.updateFee > 0) {
                try {
                    await bot.manager.accountant.adjustTotalBalance(btsSide, -btsFeeData.updateFee, 'update-adopt-fee');
                } catch (feeErr: any) {
                    bot.manager.logger.log(
                        `[COW] Adoption fee accounting failed for update ${ctx.kind === 'size-update' ? ctx.updateInfo?.partialOrder?.orderId : ctx.rotation?.oldOrder?.orderId}: ${getErrorMessage(feeErr)}`,
                        'warn'
                    );
                }
            }
        }
    }
}

/**
 * Process results from batch transaction execution.
 * Updates order state, synchronizes with chain, and deducts BTS fees.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} result
 * @param {Array} opContexts
 * @returns {Object} Result with { executed: boolean, hadRotation: boolean }
 */
async function processBatchResults(bot: any, result: any, opContexts: any) {
    const results = extractOperationResults(result, 'processBatchResults', bot.manager?.logger?.log?.bind(bot.manager?.logger));
    // Safe variant: this runs AFTER the working grid committed, so a throw
    // here (fee cache unset) would hard-fail the whole batch post-commit and
    // land in the executor catch, where the stack-entry marker is already
    // cleared — leaving the grid committed but its post-commit processing
    // (fee deduction, metadata) silently skipped. Zero-fee fallback keeps the
    // accounting close; the next sync converges the residual.
    const btsFeeData = getAssetFeesSafe('BTS');
    let hadRotation = false;
    let updateOperationCount = 0;

    const updatesToApply: any[] = [];

    for (let i = 0; i < opContexts.length; i++) {
        const ctx = opContexts[i];
        const res = results[i];

        if (ctx.kind === 'cancel') {
            bot.manager.logger.log(`Cancelled surplus order ${ctx.order.id} (${ctx.order.orderId})`, 'info');
            const oldOrder = ctx.order;
            const committedOrder = oldOrder?.id ? bot.manager.orders.get(oldOrder.id) : null;

            if (oldOrder && committedOrder && bot.manager.accountant) {
                await bot.manager.accountant.updateOptimisticFreeBalance(
                    oldOrder,
                    committedOrder,
                    'fill-cancel',
                    btsFeeData?.cancelFee || 0,
                    false
                );
            }
        }
        else if (ctx.kind === 'size-update') {
            const oldOrder = ctx.updateInfo.partialOrder;
            const ord = bot.manager.orders.get(oldOrder.id);

            if (oldOrder && ord && bot.manager.accountant) {
                await bot.manager.accountant.updateOptimisticFreeBalance(
                    oldOrder,
                    ord,
                    'order-update',
                    btsFeeData?.updateFee || 0,
                    false
                );
            }

            if (ord) {
                const updatedSlot = { ...ord, size: ctx.updateInfo.newSize };
                if (ctx.finalInts) {
                    updatedSlot.rawOnChain = {
                        id: ord.orderId,
                        for_sale: String(ctx.finalInts.sell),
                        sell_price: {
                            base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                            quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                        }
                    };
                }
                updatesToApply.push({ order: updatedSlot, context: 'post-update-metadata' });
            }
            bot.manager.logger.log(`Size update complete: ${ctx.updateInfo.partialOrder.orderId}`, 'info');
            updateOperationCount++;
        }
        else if (ctx.kind === 'create') {
            const chainOrderId = res && res[1];
            if (chainOrderId) {
                await bot.manager.synchronizeWithChain({
                    gridOrderId: ctx.order.id, chainOrderId, expectedType: ctx.order.type, fee: btsFeeData?.createFee || 0
                }, 'createOrder');

                if (ctx.finalInts) {
                    const syncedOrder = bot.manager.orders.get(ctx.order.id);
                    if (syncedOrder) {
                        updatesToApply.push({
                            order: {
                                ...syncedOrder,
                                rawOnChain: {
                                    id: chainOrderId,
                                    for_sale: String(ctx.finalInts.sell),
                                    sell_price: {
                                        base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                                        quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                                    }
                                }
                            },
                            context: 'post-placement-metadata'
                        });
                    }
                }
                bot.manager.logger.log(`Placed ${ctx.order.type} order ${ctx.order.id} -> ${chainOrderId}`, 'info');
            } else {
                const fingerprint = [
                    `type=${ctx.order.type || 'unknown'}`,
                    `price=${Format.formatPrice6(ctx.order.price)}`,
                    `size=${Format.formatAmount(ctx.order.size)}`
                ].join(',');
                bot.manager.logger.log(
                    `[COW] CRITICAL: Create op for slot ${ctx.order.id} (type=${ctx.order.type}) ` +
                    `returned no chainOrderId. Identify any orphaned on-chain order by local fingerprint ` +
                    `${fingerprint} before cancelling.`,
                    'error'
                );
            }
        }
        else if (ctx.kind === 'rotation') {
            hadRotation = true;
            const { rotation } = ctx;
            const { oldOrder, newPrice, newGridId, newSize, type } = rotation;

            if (!newGridId) {
                const ord = bot.manager.orders.get(oldOrder.id || rotation.id);

                if (oldOrder && ord && bot.manager.accountant) {
                    await bot.manager.accountant.updateOptimisticFreeBalance(
                        oldOrder,
                        ord,
                        'order-update',
                        btsFeeData?.updateFee || 0,
                        false
                    );
                }

                if (ord) {
                    const updatedSlot = { ...ord, size: newSize };
                    if (ctx.finalInts) {
                        updatedSlot.rawOnChain = {
                            id: ord.orderId,
                            for_sale: String(ctx.finalInts.sell),
                            sell_price: {
                                base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                                quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                            }
                        };
                    }
                    updatesToApply.push({ order: updatedSlot, context: 'post-update-metadata' });
                }
                updateOperationCount++;
                continue;
            }

            const slot = bot.manager.orders.get(newGridId);
            if (!slot) {
                bot.manager.logger.log(
                    `[ROTATION] Destination slot ${newGridId} missing from master grid after COW commit - skipping activation, sync will reconcile`,
                    'error'
                );
                if (oldOrder?.id && oldOrder.id !== newGridId) {
                    const staleSource = bot.manager.orders.get(oldOrder.id);
                    if (staleSource?.orderId) {
                        updatesToApply.push({
                            order: { ...staleSource, state: ORDER_STATES.VIRTUAL, orderId: null, rawOnChain: null },
                            context: 'post-rotation-source-clear'
                        });
                    }
                }
                continue;
            }
            const updatedSlot = {
                ...slot,
                id: newGridId,
                type,
                size: newSize,
                price: newPrice,
                state: ORDER_STATES.ACTIVE,
                orderId: oldOrder?.orderId || slot.orderId || null
            };

            if (ctx.finalInts) {
                updatedSlot.rawOnChain = {
                    id: updatedSlot.orderId,
                    for_sale: String(ctx.finalInts.sell),
                    sell_price: {
                        base: { amount: String(ctx.finalInts.sell), asset_id: ctx.finalInts.sellAssetId },
                        quote: { amount: String(ctx.finalInts.receive), asset_id: ctx.finalInts.receiveAssetId }
                    }
                };
            }

            if (oldOrder && updatedSlot && bot.manager.accountant) {
                await bot.manager.accountant.updateOptimisticFreeBalance(
                    oldOrder,
                    updatedSlot,
                    'order-update',
                    btsFeeData?.updateFee || 0,
                    false
                );
            }

            if (oldOrder?.id && oldOrder.id !== newGridId) {
                const currentSource = bot.manager.orders.get(oldOrder.id);
                if (currentSource && currentSource.orderId) {
                    updatesToApply.push({
                        order: {
                            ...currentSource,
                            state: ORDER_STATES.VIRTUAL,
                            orderId: null,
                            rawOnChain: null
                        },
                        context: 'post-rotation-source-clear'
                    });
                }
            }

            updatesToApply.push({ order: updatedSlot, context: 'post-rotation-metadata' });
        }
    }

    if (updatesToApply.length > 0) {
        await bot.manager.applyGridUpdateBatch(
            updatesToApply.map((u: any) => u.order), 
            'batch-results-process',
            { skipAccounting: true }
        );
    }

    return {
        executed: true,
        hadRotation,
        updateOperationCount
    };
}

export = {
    buildOutsideInPairGroupsForOrders,
    buildOutsideInPairGroupsForCreateEntries,
    extractOperationResults,
    findMissingCreateResultContexts,
    recoverAfterMissingCreateResults,
    preserveMissingCreateBlockersAfterRecovery,
    markMissingCreateResultsAsStructuralBlocker,
    formatUnmatchedChainOrderForLog,
    recordPendingBroadcast,
    clearPendingBroadcasts,
    clearPendingBroadcastsForSlots,
    popPushedWorkingGrid,
    buildChainOrderFingerprint,
    normalizeChainOrderForPendingMatch,
    findChainOrderForSlot,
    reconcileAfterUncertainBroadcast,
    reconcileAfterUncertainBroadcastImpl,
    autoCancelOneUnmatchedOrphan,
    shouldExecuteCreatePairMode,
    executeWithRetryOnUncertain,
    executeOperationsWithStrategy,
    validateOperationFunds,
    resolveIdealSizeForValidation,
    validateOrderSizeForExecution,
    buildActionsFromPlan,
    buildCowResultFromPlan,
    restoreSkippedUpdateSlotsInWorkingGrid,
    applyRotationTransitionsToWorkingGrid,
    pollChainForConfirmation,
    updateOrdersOnChainBatchCOW,
    processBatchResults,
};
