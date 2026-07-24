/** State recovery runtime - grid persistence, recovery sync, size-drift repair */
const { BitShares } = require('./bitshares_client');
const chainOrders = require('./chain_orders');
function virtualizeOrder(...args) { return require('./order/utils/order').virtualizeOrder(...args); }
function parseChainOrder(...args) { return require('./order/utils/order').parseChainOrder(...args); }
function blockchainToFloat(...args) { return require('./order/utils/math').blockchainToFloat(...args); }
const { ORDER_TYPES } = require('./constants');
const Format = require('./order/format');
const grid = require('./order/grid');
const { isGridBloated } = grid;

/**
 * Persist the current grid state and trigger recovery if validation fails.
 * @param {import('./dexbot_class').DEXBot} bot
 */
async function persistAndRecoverIfNeeded(bot) {
    bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
    const validation = await bot.manager.persistGrid();
    if (!validation.isValid) {
        bot._warn(`Startup validation failed: ${validation.reason}. Triggering immediate recovery...`);
        const recoveryValidation = await bot.manager.accountant._performStateRecovery(bot.manager);
        if (recoveryValidation.isValid) {
            bot._log(`✓ Startup recovery successful. Persistent state restored.`);
            bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
            await bot.manager.persistGrid();
        } else {
            bot._warn(`Startup recovery failed: ${recoveryValidation.reason}. Bot proceeding with caution.`);
        }
    }
}

/**
 * Snapshot the recently queued fill keys as a plain object for crash-durable persistence.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Record<string, number>}
 */
function getRecentFillKeysSnapshot(bot) {
    const snapshot = {};
    const now = Date.now();
    for (const [key, timestamp] of bot._recentlyQueuedFills) {
        if (now - Number(timestamp) < bot._fillDedupeWindowMs) {
            snapshot[key] = Number(timestamp);
        }
    }
    if (bot.manager?._recentFillKeysSnapshot) {
        for (const [key, timestamp] of Object.entries(bot.manager._recentFillKeysSnapshot)) {
            if (!(key in snapshot) && now - Number(timestamp) < bot._fillDedupeWindowMs) {
                snapshot[key] = Number(timestamp);
            }
        }
    }
    return snapshot;
}

/**
 * Trigger a full state recovery sync (fetch chain + sync from open orders + persist).
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} [reason='state recovery sync']
 */
async function triggerStateRecoverySync(bot, reason = 'state recovery sync') {
    if (!bot.manager) return;

    if (bot._recoverySyncInFlight) {
        bot.manager.logger.log(`[RECOVERY] Skipping duplicate recovery request: ${reason}`, 'warn');
        return;
    }

    bot._recoverySyncInFlight = true;
    try {
        bot.manager.logger.log(`Triggering state recovery sync (${reason})...`, 'info');
        await bot.manager.fetchAccountTotals(bot.accountId);
        const openOrders = await chainOrders.readOpenOrders(bot.accountId);
        await bot.manager.syncFromOpenOrders(openOrders, { skipAccounting: true });
        if (typeof bot.manager.persistGrid === 'function') {
            await bot.manager.persistGrid();
        }
    } finally {
        bot._recoverySyncInFlight = false;
    }
}

/**
 * Abort the current flow if an illegal state signal was raised.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} flowContext
 * @returns {Promise<boolean>}
 */
async function abortFlowIfIllegalState(bot, flowContext) {
    const illegalSignal = bot.manager?.consumeIllegalStateSignal?.();
    if (!illegalSignal) {
        return false;
    }

    bot.manager.logger.log(
        `[HARD-ABORT] ${flowContext} aborted due to illegal state (${illegalSignal.context}): ${illegalSignal.message}`,
        'error'
    );
    await bot._triggerStateRecoverySync(`hard-abort ${flowContext}`);
    bot._maintenanceCooldownCycles = Math.max(bot._maintenanceCooldownCycles, 1);
    return true;
}

/**
 * Handle a hard abort from batch processing due to illegal state or accounting failure.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Error} err
 * @param {string} [phase='batch processing']
 * @param {number} [opsCount=0]
 * @returns {Promise<Object|null>}
 */
async function handleBatchHardAbort(bot, err, phase = 'batch processing', opsCount = 0) {
    const baseResult = { executed: false, hadRotation: false };
    const opsInfo = opsCount > 0 ? ` with ${opsCount} ops` : '';

    if (err?.code === 'ILLEGAL_ORDER_STATE') {
        const illegalSignal = bot.manager.consumeIllegalStateSignal?.();
        await bot._triggerStateRecoverySync(illegalSignal?.message || `illegal order state during ${phase}${opsInfo}`);
        bot._maintenanceCooldownCycles = Math.max(bot._maintenanceCooldownCycles, 1);
        return { ...baseResult, abortedForIllegalState: true };
    }

    if (err?.code === 'ACCOUNTING_COMMITMENT_FAILED') {
        const accountingSignal = bot.manager.consumeAccountingFailureSignal?.();
        const reason = accountingSignal
            ? `accounting lock failure (${accountingSignal.side} ${Format.formatAmount8(accountingSignal.amount)}) during ${accountingSignal.context}`
            : `accounting commitment lock failure during ${phase}${opsInfo}`;
        await bot._triggerStateRecoverySync(reason);
        bot._maintenanceCooldownCycles = Math.max(bot._maintenanceCooldownCycles, 1);
        return { ...baseResult, abortedForAccountingFailure: true };
    }

    return null;
}

/**
 * Apply recoverable grid updates (order virtualisation) after a batch failure.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Array<Object>} updates
 * @param {string} [context='recoverable-grid-update']
 * @returns {Promise<number>}
 */
async function applyRecoverableGridUpdates(bot, updates, context = 'recoverable-grid-update') {
    if (!bot.manager || !Array.isArray(updates) || updates.length === 0) {
        return 0;
    }

    let applied;
    if (typeof bot.manager.applyGridUpdateBatch === 'function') {
        await bot.manager.applyGridUpdateBatch(updates, context);
        applied = updates.length;
    } else {
        applied = 0;
        for (const update of updates) {
            if (typeof bot.manager._updateOrder !== 'function') break;
            await bot.manager._updateOrder(update, context);
            applied++;
        }
    }

    if (applied > 0 && typeof bot.manager.persistGrid === 'function') {
        await bot.manager.persistGrid();
    }

    return applied;
}

/**
 * Recover from explicit stale order errors by virtualizing affected grid slots.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Set<string>|string[]} staleOrderIds
 * @param {string} [reason='stale order cleanup']
 * @returns {Promise<Object>}
 */
async function recoverExplicitStaleOrders(bot, staleOrderIds, reason = 'stale order cleanup') {
    const staleIds = Array.from(staleOrderIds || []).filter(Boolean) as string[];
    if (staleIds.length === 0) {
        return { executed: false, hadRotation: false, stale: false };
    }

    bot.manager.logger.log(
        `[COW] Stale order(s) detected: ${staleIds.join(', ')}. Applying targeted cleanup.`,
        'warn'
    );

    const updates = [];

    for (const [, gridOrder] of bot.manager.orders.entries()) {
        if (!gridOrder?.orderId || !staleOrderIds.has(gridOrder.orderId)) continue;
        bot._staleCleanedOrderIds.set(gridOrder.orderId, Date.now());
        updates.push({ ...virtualizeOrder(gridOrder), size: 0 });
    }

    for (const orderId of staleIds) {
        if (!bot._staleCleanedOrderIds.has(orderId)) {
            bot._staleCleanedOrderIds.set(orderId, Date.now());
        }
    }

    if (updates.length > 0) {
        await bot._applyRecoverableGridUpdates(updates, reason);
    } else {
        bot.manager.logger.log(
            `[COW] No local grid slot matched stale order cleanup request (${staleIds.join(', ')}).`,
            'debug'
        );
    }

    return {
        executed: false,
        hadRotation: false,
        stale: true,
        recoveredByVirtualization: updates.length > 0
    };
}

/**
 * Recover from on-chain size drift detected during batch broadcast.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Error} err
 * @param {Array<Object>} [opContexts=[]]
 * @returns {Promise<Object>}
 */
async function recoverBatchSizeDrift(bot, err, opContexts = []) {
    const affectedOrderIds = extractSizeDriftOrderIds(opContexts);
    if (affectedOrderIds.length > 0) {
        bot.manager.logger.log(
            `[COW] Targeted size-drift repair for ${affectedOrderIds.length} order(s): ${affectedOrderIds.join(', ')}`,
            'debug'
        );
        const repaired = await bot._targetedOrderRepair(affectedOrderIds);
        if (repaired) {
            return {
                executed: false,
                hadRotation: false,
                recoveredBySync: true,
                reason: 'ORDER_SIZE_DRIFT_TARGETED'
            };
        }
        bot.manager.logger.log(
            '[COW] Targeted repair failed, falling back to full state recovery sync.',
            'warn'
        );
    }

    const reason = `recoverable size drift during COW batch: ${err.message}`;
    bot.manager.logger.log(
        `[COW] Recovering from on-chain size drift via recovery sync: ${err.message}`,
        'warn'
    );
    await bot._triggerStateRecoverySync(reason);
    return {
        executed: false,
        hadRotation: false,
        recoveredBySync: true,
        reason: 'ORDER_SIZE_DRIFT'
    };
}

/**
 * Extract chain order IDs from opContexts for size-drift operations.
 * @param {Array<Object>} opContexts
 * @returns {string[]}
 */
function extractSizeDriftOrderIds(opContexts) {
    if (!Array.isArray(opContexts)) return [];
    const ids = new Set();
    for (const ctx of opContexts) {
        if (ctx?.kind === 'size-update' && ctx?.updateInfo?.partialOrder?.orderId) {
            ids.add(ctx.updateInfo.partialOrder.orderId);
        } else if (ctx?.kind === 'rotation' && ctx?.rotation?.oldOrder?.orderId) {
            ids.add(ctx.rotation.oldOrder.orderId);
        }
    }
    return Array.from(ids);
}

/**
 * Reload the grid from the persisted on-disk snapshot and reconcile with chain.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
async function recoverFromPersistedGrid(bot) {
    if (!bot.accountOrders || !bot.manager) {
        return { success: false, reason: 'accountOrders or manager unavailable' };
    }

    const accountRef = bot.accountId || bot.account?.id || bot.account;
    if (!accountRef) {
        return { success: false, reason: 'no account reference' };
    }

    bot.manager.logger.log('[RECOVERY] Attempting full grid reload from persisted snapshot...', 'warn');

    try {
        const persistedGrid = bot.accountOrders.loadGrid(true);
        if (!persistedGrid || persistedGrid.length === 0) {
            return { success: false, reason: 'no persisted grid on disk' };
        }

        const boundaryIdx = bot.accountOrders.loadBoundaryIdx(true);

        await grid.loadGrid(bot.manager, persistedGrid, boundaryIdx);

        if (await bot._rejectCorruptedGridSnapshot('recovery')) {
            return { success: false, reason: 'corrupted grid snapshot rejected (fund drift)' };
        }

        const chainOpenOrders = await chainOrders.readOpenOrders(accountRef);

        if (chainOpenOrders.length > 0 && bot.manager?.syncFromOpenOrders) {
            await bot.manager.syncFromOpenOrders(chainOpenOrders, {
                skipAccounting: true,
            });
        }

        if (typeof bot.manager.persistGrid === 'function') {
            await bot.manager.persistGrid();
        }

        const assets = bot.manager?.assets;
        const matchedCount = assets
            ? chainOpenOrders.filter(o => parseChainOrder(o, assets) !== null).length
            : chainOpenOrders.length;
        bot.manager.logger.log(
            `[RECOVERY] Grid reloaded from persisted snapshot: ${bot.manager.orders.size} orders, ` +
            `${matchedCount} on-chain orders synced`,
            'info'
        );

        const remainingUnmatched = Array.isArray(bot.manager?._lastUnmatchedChainOrders)
            ? bot.manager._lastUnmatchedChainOrders
            : [];
        if (remainingUnmatched.length > 0) {
            const sample = remainingUnmatched.slice(0, 3)
                .map(o => bot._formatUnmatchedChainOrderForLog(o))
                .join(' | ');
            bot.manager.logger.log(
                `[RECOVERY] Persisted grid reloaded but ${remainingUnmatched.length} unmatched chain order(s) ` +
                `remain${sample ? ` (${sample})` : ''}. Rejecting — full grid reset required.`,
                'warn'
            );
            return { success: false, reason: `grid inconsistent after reload: ${remainingUnmatched.length} unmatched remain` };
        }

        const ordersArr = Array.from(bot.manager.orders.values());
        const bloatPostRecovery = isGridBloated(bot.manager, ordersArr);
        if (bloatPostRecovery.bloated) {
            const d = bloatPostRecovery.details;
            bot.manager.logger.log(
                `[RECOVERY] Persisted grid reloaded but still bloated ` +
                `(${d.gridSize} slots, max ${d.maxAllowed}). Rejecting — full grid reset required.`,
                'warn'
            );
            return { success: false, reason: 'grid still bloated after reload' };
        }

        return { success: true };
    } catch (err: any) {
        bot.manager.logger.log(
            `[RECOVERY] Full grid reload from persisted snapshot failed: ${err.message}`,
            'error'
        );
        return { success: false, reason: err.message };
    }
}

/**
 * Reject a corrupted grid snapshot when catastrophic fund drift is detected.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {'startup'|'recovery'} context
 * @returns {Promise<boolean>}
 */
async function rejectCorruptedGridSnapshot(bot, context) {
    if (!bot.manager?.checkFundDriftAfterFills) return false;
    const driftCheck = bot.manager.checkFundDriftAfterFills();
    if (driftCheck.isValid) return false;

    const tag = context === 'recovery' ? '[RECOVERY][SNAPSHOT-REJECT]' : '[SNAPSHOT-REJECT]';
    bot._warn(
        `${tag} Corrupted grid snapshot detected: ` +
        `drift sell=${driftCheck.driftSell.toFixed(2)} buy=${driftCheck.driftBuy.toFixed(2)}. ` +
        `Deleting corrupted snapshot.`
    );
    if (bot.accountOrders && typeof bot.accountOrders.clearGrid === 'function') {
        try {
            await bot.accountOrders.clearGrid();
            bot._warn(`${tag} Corrupted grid snapshot deleted.`);
        } catch (clearErr) {
            bot._warn(`${tag} Failed to delete corrupted snapshot: ${clearErr.message}`);
        }
    }
    return true;
}

/**
 * Attempt to repair size-drift for specific order IDs from chain state.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string[]} orderIds
 * @returns {Promise<boolean>}
 */
async function targetedOrderRepair(bot, orderIds) {
    try {
        const objects = await BitShares.db.get_objects(orderIds);
        if (!Array.isArray(objects) || objects.length !== orderIds.length) return false;

        const updates = [];
        for (let i = 0; i < orderIds.length; i++) {
            const chainOrder = objects[i];
            const gridOrder = (Array.from(bot.manager.orders.values()) as any[])
                .find((o: any) => o.orderId === orderIds[i]);
            if (!gridOrder) continue;

            if (!chainOrder || typeof chainOrder.for_sale === 'undefined') {
                updates.push({ ...virtualizeOrder(gridOrder), size: 0 });
            } else {
                const chainUnits = Number(chainOrder.for_sale);
                if (Number.isFinite(chainUnits)) {
                    const prec = gridOrder.type === ORDER_TYPES.SELL
                        ? bot.manager.assets.assetA.precision
                        : bot.manager.assets.assetB.precision;
                    const floatSize = blockchainToFloat(chainUnits, prec);
                    if (floatSize !== gridOrder.size) {
                        updates.push({
                            id: gridOrder.id,
                            size: floatSize,
                            rawOnChain: chainOrder,
                        });
                    }
                }
            }
        }

        if (updates.length > 0) {
            await bot._applyRecoverableGridUpdates(updates, 'targeted-size-drift-repair');
        }
        return true;
    } catch (err) {
        bot.manager.logger.log(
            `[COW] Targeted order repair failed: ${err.message}`,
            'debug'
        );
        return false;
    }
}

export = {
    persistAndRecoverIfNeeded,
    getRecentFillKeysSnapshot,
    triggerStateRecoverySync,
    abortFlowIfIllegalState,
    handleBatchHardAbort,
    applyRecoverableGridUpdates,
    recoverExplicitStaleOrders,
    recoverBatchSizeDrift,
    extractSizeDriftOrderIds,
    recoverFromPersistedGrid,
    rejectCorruptedGridSnapshot,
    targetedOrderRepair,
};
