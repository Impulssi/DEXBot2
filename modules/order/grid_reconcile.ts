import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import {
    _countActiveOnGrid, _cancelChainOrder, _recoverStartupSyncFailure,
    _refreshStartupUpdatePlans,
    _executeStartupUpdateBatch,
    _executeStartupSequentialUpdateFallback,
    _executePlannedStartupCreates, _reconcileStartupSide,
} from './grid_reconcile_internal.js';
import { ORDER_TYPES, ORDER_STATES, TIMING } from '../constants.js';
import { readOpenOrdersGuarded } from '../chain_orders.js';
import { calculatePriceTolerance, getAssetFeesSafe, resolveGapBand } from './utils/math.js';
import {
    isOrderPlaced, parseChainOrder, isOrderOnChain, chainOrderMatchesSlot,
    duplicateOrphanLogInfo,
    validateBoundaryAgainstChainEvidence,
} from './utils/order.js';
import * as Format from './format.js';
import { getErrorMessage } from '../utils/errors.js';
const SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER = 5;


/**
 * Returns { resumed: boolean, matchedCount: number }.
 * @param {Object} params - Destructured parameters
 * @param {Object} params.manager - OrderManager instance
 * @param {Array<Object>} params.persistedGrid - Persisted grid orders
 * @param {Array<Object>} params.chainOpenOrders - On-chain open orders
 * @param {Object} params.logger - Logger instance
 * @param {Function} params.storeGrid - Grid persistence callback
 * @returns {Promise<{resumed: boolean, matchedCount: number}>}
 */
export async function attemptResumePersistedGridByPriceMatch({
    manager,
    persistedGrid,
    chainOpenOrders,
    logger,
    storeGrid,
    boundaryIdx = null,
}: {
    manager: any;
    persistedGrid: any[];
    chainOpenOrders: any[];
    logger: any;
    storeGrid: any;
    boundaryIdx?: number | null;
}) {
    if (!Array.isArray(persistedGrid) || persistedGrid.length === 0) return { resumed: false, matchedCount: 0 };
    if (!Array.isArray(chainOpenOrders) || chainOpenOrders.length === 0) return { resumed: false, matchedCount: 0 };
    if (!manager || typeof manager.synchronizeWithChain !== 'function') return { resumed: false, matchedCount: 0 };

    try {
        logger && logger.log && logger.log('No matching active order IDs found. Attempting to match by price...', 'info');
        const { loadGrid } = require('./grid');
        await loadGrid(manager, persistedGrid, boundaryIdx);
        await manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

        const matchedOrderIds = new Set(
            (Array.from(manager.orders.values()) as any[])
                .filter((o: any) => o && isOrderOnChain(o))
                .map((o: any) => o.orderId)
                .filter(Boolean)
        );

        if (matchedOrderIds.size === 0) {
            logger && logger.log && logger.log('Price-based matching found no matches. Generating new grid.', 'info');
            return { resumed: false, matchedCount: 0 };
        }

        logger && logger.log && logger.log(`Successfully matched ${matchedOrderIds.size} orders by price. Resuming with existing grid.`, 'info');
        if (typeof storeGrid === 'function') {
            await storeGrid(Array.from(manager.orders.values()) as any[]);
        }
        return { resumed: true, matchedCount: matchedOrderIds.size };
    } catch (err: any) {
        logger && logger.log && logger.log(`Price-based resume attempt failed: ${err && getErrorMessage(err) ? getErrorMessage(err) : err}`, 'warn');
        return { resumed: false, matchedCount: 0 };
    }
}

/**
 * Decide whether a startup should regenerate the grid or resume a persisted grid.
 *
 * Resulting behavior matches the existing startup policy:
 * - If no persisted grid -> regenerate
 * - If any persisted ACTIVE orderId exists on-chain -> resume
 * - Else if there are on-chain orders -> attempt price-based matching; resume if it matches any
 * - Else -> regenerate
 * @param {Object} params - Destructured parameters
 * @param {Array<Object>} params.persistedGrid - Persisted grid orders
 * @param {Array<Object>} params.chainOpenOrders - On-chain open orders
 * @param {Object} params.manager - OrderManager instance
 * @param {Object} params.logger - Logger instance
 * @param {Function} params.storeGrid - Grid persistence callback
 * @param {Function} [params.attemptResumeFn=attemptResumePersistedGridByPriceMatch] - Resume function
 * @returns {Promise<Object>} { shouldRegenerate, hasActiveMatch, resumedByPrice, matchedCount }
 */
export async function decideStartupGridAction({
    persistedGrid,
    chainOpenOrders,
    manager,
    logger,
    storeGrid,
    boundaryIdx = null,
    attemptResumeFn = attemptResumePersistedGridByPriceMatch,
}: {
    persistedGrid: any[];
    chainOpenOrders: any[];
    manager: any;
    logger: any;
    storeGrid: any;
    boundaryIdx?: number | null;
    attemptResumeFn?: any;
}) {
    const persisted = Array.isArray(persistedGrid) ? persistedGrid : [];
    const chain = Array.isArray(chainOpenOrders) ? chainOpenOrders : [];

    if (persisted.length === 0) {
        return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
    }

    const chainOrderIds = new Set(chain.map(o => o && o.id).filter(Boolean));
    const hasActiveMatch = persisted.some(order => order && order.state === ORDER_STATES.ACTIVE && order.orderId && chainOrderIds.has(order.orderId));
    if (hasActiveMatch) {
        return { shouldRegenerate: false, hasActiveMatch: true, resumedByPrice: false, matchedCount: 0 };
    }

    if (chain.length > 0) {
        const resume = await attemptResumeFn({ manager, persistedGrid: persisted, chainOpenOrders: chain, logger, storeGrid, boundaryIdx });
        return { shouldRegenerate: !resume.resumed, hasActiveMatch: false, resumedByPrice: !!resume.resumed, matchedCount: resume.matchedCount || 0 };
    }

    return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
}

/**
 * Reconcile existing on-chain orders to a newly generated grid.
 *
 * Policy (per side):
 * - Prefer updating existing unmatched chain orders to match the target grid slots.
 * - Then create missing orders if chain has fewer than target.
 * - Then cancel excess orders if chain has more than target.
 *
 * Targets are derived from config.activeOrders.{buy,sell} and chain counts are computed
 * from current on-chain open orders.
 * @param {Object} params - Destructured parameters
 * @param {Object} params.manager - OrderManager instance
 * @param {Object} params.config - Bot configuration
 * @param {string} params.account - Account ID or name
 * @param {string} params.privateKey - Active/owner private key
 * @param {Function} params.chainOrders - Chain order query function
 * @param {Array<Object>} params.chainOpenOrders - On-chain open orders
 * @returns {Promise<Object|null>} Reconciliation result, or null when reconciliation completes without a summary object
 */
export async function reconcileGridOrders({
    manager,
    config,
    account,
    privateKey,
    chainOrders,
    chainOpenOrders,
}: {
    manager: any;
    config: any;
    account: any;
    privateKey: any;
    chainOrders: any;
    chainOpenOrders: any[];
}) {
    // Parameter validation
    if (!manager || typeof manager.synchronizeWithChain !== 'function') {
        throw new Error('reconcileGridOrders: manager must be provided with synchronizeWithChain method');
    }
    if (typeof manager.getOrdersByTypeAndState !== 'function') {
        throw new Error('reconcileGridOrders: manager.getOrdersByTypeAndState method not found');
    }
    if (!account || !privateKey) {
        throw new Error('reconcileGridOrders: account and privateKey are required');
    }
    if (!chainOrders || typeof chainOrders.cancelOrder !== 'function' || typeof chainOrders.createOrder !== 'function') {
        throw new Error('reconcileGridOrders: chainOrders must provide cancelOrder and createOrder methods');
    }
    if (typeof chainOrders.readOpenOrders !== 'function') {
        throw new Error('reconcileGridOrders: chainOrders.readOpenOrders is required for recovery sync');
    }
    const supportsBatchUpdate = typeof chainOrders.buildUpdateOrderOp === 'function' && typeof chainOrders.executeBatch === 'function';
    const supportsSequentialUpdate = typeof chainOrders.updateOrder === 'function';
    if (!supportsBatchUpdate && !supportsSequentialUpdate) {
        throw new Error('reconcileGridOrders: chainOrders must provide updateOrder or (buildUpdateOrderOp + executeBatch) for startup updates');
    }

    const logger = manager && manager.logger;
    const dryRun = !!(config && config.dryRun);

    const parsedChain = (chainOpenOrders || [])
        .map((co: any) => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
        .filter((x: any) => x.parsed);

    const activeCfg = (config && config.activeOrders) ? config.activeOrders : {};
    let targetBuy = Math.max(0, Number.isFinite(Number(activeCfg.buy)) ? Number(activeCfg.buy) : 1);
    let targetSell = Math.max(0, Number.isFinite(Number(activeCfg.sell)) ? Number(activeCfg.sell) : 1);

    const chainBuys = parsedChain.filter((x: any) => x.parsed.type === ORDER_TYPES.BUY).map((x: any) => x.chain);
    const chainSells = parsedChain.filter((x: any) => x.parsed.type === ORDER_TYPES.SELL).map((x: any) => x.chain);

    // PHASE 1: In-memory reconciliation under lock — pure planning, no blockchain I/O.
    // All cancellations are collected into plannedCancels and executed in Phase 2.
    // This keeps the lock hierarchy clean (no _gridLock held across sync calls).
    const phase1Result = await manager._gridLock.acquire(async () => {
        if (typeof manager._applyOrderUpdate !== 'function') {
            throw new Error('manager._applyOrderUpdate is required for startup reconciliation');
        }
        const applyUpdate = manager._applyOrderUpdate.bind(manager);

        const chainIds = new Set((Array.isArray(chainOpenOrders) ? chainOpenOrders : []).map(o => o && o.id).filter(Boolean));
        for (const order of manager.orders.values()) {
            if (isOrderPlaced(order)) {
                if (!chainIds.has(order.orderId)) {
                    // Absence-decision guard: only virtualize as a phantom when
                    // the absence is trustworthy. An orderId assigned within the
                    // sync-lock window may be an in-flight create/adopt whose
                    // broadcast has not landed or is not yet visible to a
                    // lagging/truncated read. Virtualizing it here and
                    // re-creating would duplicate a real live order (the
                    // reconcile-timeout death-spiral root cause). Mirror the
                    // sync_engine committed-order guard; ghost orders (PARTIAL +
                    // size=0) still pass through so known fills get cleaned up.
                    const assignedAt = manager._orderIdAssignedAt?.get(order.orderId) || 0;
                    const isGhost = order.size <= 0 && order.state === ORDER_STATES.PARTIAL;
                    if (!isGhost && assignedAt > 0 && Date.now() - assignedAt < TIMING.SYNC_LOCK_TIMEOUT_MS) {
                        logger?.log?.(
                            `Startup: Order ${order.id} (ID ${order.orderId}) absent from snapshot but freshly assigned ` +
                            `(${Date.now() - assignedAt}ms ago); deferring phantom cleanup (duplicate-order protection).`,
                            'warn'
                        );
                        continue;
                    }
                    logger?.log?.(`Startup: Found phantom order ${order.id} (ID ${order.orderId}) not on chain. Resetting to VIRTUAL.`, 'warn');

                    await applyUpdate({
                        ...order,
                        state: ORDER_STATES.VIRTUAL,
                        orderId: "",
                        rawOnChain: null
                    }, 'startup-phantom', { skipAccounting: true });
                }
            }
        }

        const matchedChainOrderIds = new Set();
        for (const gridOrder of manager.orders.values()) {
            if (gridOrder && gridOrder.orderId) {
                matchedChainOrderIds.add(gridOrder.orderId);
            }
        }

        const unmatchedChain = (Array.isArray(chainOpenOrders) ? chainOpenOrders : []).filter((co: any) => co && !matchedChainOrderIds.has(co.id));
        let unmatchedParsed = unmatchedChain
            .map((co: any) => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
            .filter((x: any) => x.parsed);

        const plannedCancels: any[] = [];
        const cancelledDuplicateIds = new Set<string>();
        const activeGridOrders = (Array.from(manager.orders.values()) as any[]).filter((o: any) => o && o.orderId && isOrderPlaced(o));
        // Update-first policy: unmatched chain orders are NEVER cancelled here.
        // They flow into _reconcileStartupSide below, which price-updates them onto
        // rail slots in a single batch (plannedUpdates), creates missing orders, and
        // cancels only true surplus (chainCount > targetCount). Pre-emptive
        // cancellation would turn one batched update into per-order cancel+create
        // churn and strip the bot's own live orders during a reset.
        for (const u of unmatchedParsed) {
            const p = u.parsed!;
            const desc = `Unmatched chain order: ${p.orderId} (${p.type === ORDER_TYPES.BUY ? 'BUY' : 'SELL'}), price=${Format.formatPrice6(p.price)}, size=${Format.formatSizeByOrderType(p.size ?? 0, p.type, manager.assets)}`;
            let nearest: any = null;
            for (const gridOrder of activeGridOrders) {
                if (gridOrder.type !== p.type) continue;
                const priceDiff = Math.abs(p.price - gridOrder.price);
                const tolerance = calculatePriceTolerance(gridOrder.price, gridOrder.size, gridOrder.type, manager.assets) || 0;
                const candidate = {
                    gridOrder,
                    priceDiff,
                    tolerance,
                    looseTolerance: tolerance * SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER,
                };
                if (!nearest || priceDiff < nearest.priceDiff) nearest = candidate;
            }
            if (nearest && nearest.priceDiff <= nearest.looseTolerance) {
                // The sync layer already owns this duplicate: PASS 2 queues a
                // cancel-only correction, and startup runs it (correctAllPriceMismatches)
                // before reconcile — leaving a stale snapshot where the order is already
                // cancelled. Defer to the correction so a single orphan is cancelled once,
                // but restore the untracked-fund accounting its cancel-only path does not
                // perform (reconcile's Phase-2 cancel used to do it via releaseUntrackedFunds).
                const alreadyQueued = Array.isArray(manager.ordersNeedingPriceCorrection) &&
                    manager.ordersNeedingPriceCorrection.some((q: any) => q?.chainOrderId === p.orderId && q?.cancelOnly === true);
                const alreadyCancelled = typeof chainOrders.wasRecentlyOwnCancelled === 'function' &&
                    chainOrders.wasRecentlyOwnCancelled(p.orderId);
                if (alreadyQueued || alreadyCancelled) {
                    if (manager.accountant && manager._fundLock && p.size != null && p.size > 0) {
                        await manager._fundLock.acquire(async () => {
                            await manager.accountant.addToChainFree(p.type, p.size, 'startup-skip-duplicate');
                        });
                    }
                    cancelledDuplicateIds.add(p.orderId);
                    continue;
                }
                const { level, suffix } = duplicateOrphanLogInfo(p.orderId);
                logger?.log?.(
                    `SUSPECTED DUPLICATE: ${desc} - nearest active grid ${nearest.gridOrder.id} ` +
                    `(orderId=${nearest.gridOrder.orderId}, price=${Format.formatPrice6(nearest.gridOrder.price)}, ` +
                    `diff=${Format.formatPrice6(nearest.priceDiff)}, tolerance=${Format.formatPrice6(nearest.tolerance)}, ` +
                    `looseTolerance=${Format.formatPrice6(nearest.looseTolerance)})${suffix}`,
                    level
                );
                // Queue duplicate for Phase 2 cancellation instead of executing under lock
                cancelledDuplicateIds.add(p.orderId);
                plannedCancels.push({
                    chainOrderId: p.orderId,
                    chainOrderObj: u.chain,
                    releaseUntrackedFunds: true,
                });
            } else if (nearest) {
                logger?.log?.(
                    `${desc}; nearest active same-side grid ${nearest.gridOrder.id} ` +
                    `(orderId=${nearest.gridOrder.orderId}, price=${Format.formatPrice6(nearest.gridOrder.price)}, ` +
                    `diff=${Format.formatPrice6(nearest.priceDiff)}, tolerance=${Format.formatPrice6(nearest.tolerance)}, ` +
                    `looseTolerance=${Format.formatPrice6(nearest.looseTolerance)})`,
                    'warn'
                );
            } else {
                logger?.log?.(`${desc}; no active same-side grid order exists`, 'warn');
            }
        }

        if (cancelledDuplicateIds.size > 0) {
            unmatchedParsed = unmatchedParsed.filter((u: any) => !cancelledDuplicateIds.has(u.parsed!.orderId));
        }

        let unmatchedBuys = unmatchedParsed.filter((x: any) => x.parsed.type === ORDER_TYPES.BUY).map((x: any) => x.chain);
        let unmatchedSells = unmatchedParsed.filter((x: any) => x.parsed.type === ORDER_TYPES.SELL).map((x: any) => x.chain);
        const plannedCreates: any[] = [];
        const plannedUpdates: any[] = [];

        logger && logger.log && logger.log(
            `Startup reconcile starting: unmatched(sell=${unmatchedSells.length}, buy=${unmatchedBuys.length}), target(sell=${targetSell}, buy=${targetBuy})`,
            'info'
        );

        // P3 boundary-evidence gate (docs/CONSOLIDATED_ORPHAN_FIX_SUMMARY.md §1):
        // the restored boundary is disk state that may predate the last fill
        // sweep. The reconcile below price-updates and creates orders into rail
        // positions derived from it — validate it against the live book (and a
        // fresh anchor projection when available) BEFORE any placement. On
        // contradiction, re-derive from chain evidence; when no safe boundary
        // is derivable, run this reconcile adoption-only (no creates, no
        // price-updates, no placement-funding cancels).
        const resolvedBand = resolveGapBand(manager);
        let placementsAllowed = true;
        if (resolvedBand.boundaryIdx !== null) {
            const evidenceSlots = (Array.from(manager.orders.values()) as any[]).sort((a: any, b: any) => Number(a.price) - Number(b.price));
            // Chain evidence is the ground truth for the boundary. The fills-derived
            // price anchor is intentionally NOT passed here: it must never veto a
            // valid chain-evidenced boundary (that veto previously forced an
            // adoption-only reconcile that cancelled legitimate boundary orders).
            const evidence = validateBoundaryAgainstChainEvidence({
                boundaryIdx: resolvedBand.boundaryIdx,
                gapSlots: resolvedBand.gapSlots,
                allSlots: evidenceSlots,
                chainOrders: parsedChain.map((x: any) => x.parsed),
            });
            if (!evidence.ok) {
                placementsAllowed = false;
                logger?.log?.(
                    `[BOUNDARY-EVIDENCE] Boundary ${resolvedBand.boundaryIdx} contradicts chain evidence ` +
                    `(${evidence.reasons.join(', ')}): ${evidence.detail}`,
                    'error'
                );
                if (evidence.suggestedBoundary !== null) {
                    manager._restoreBoundary(evidence.suggestedBoundary);
                    placementsAllowed = true;
                    logger?.log?.(
                        `[BOUNDARY-EVIDENCE] Boundary re-derived from chain evidence: ` +
                        `${resolvedBand.boundaryIdx} -> ${evidence.suggestedBoundary}; ` +
                        `placements proceed on corrected geometry.`,
                        'warn'
                    );
                    // Fix #5 (Mode D): a valid boundary was established — clear any armed
                    // re-validation so the periodic sync does not loop on a healthy grid.
                    try { (manager as any)._boundaryRevalidationPending = null; } catch { /* ignore */ }
                } else {
                    // NO_FEASIBLE means live BUY(s) and SELL(s) overlap inside the
                    // gap band: no boundary exists while both straddle, so a pure
                    // adoption-only freeze can never repair the geometry. Escalate
                    // a cancel ladder — smaller single side, other single side,
                    // both sides — stopping at the first set whose removal makes
                    // the remaining chain evidence feasible (chain-evidenced,
                    // boundary-independent). Surplus semantics: orders that cannot
                    // fit the geometry are cancelled and re-placed, not frozen.
                    const buyOffenders = evidence.conflictingBuyIds;
                    const sellOffenders = evidence.conflictingSellIds;
                    const smallerFirst = buyOffenders.length <= sellOffenders.length;
                    const ladder: string[][] = [
                        smallerFirst ? buyOffenders : sellOffenders,
                        smallerFirst ? sellOffenders : buyOffenders,
                        [...buyOffenders, ...sellOffenders],
                    ];
                    let repaired = false;
                    for (const candidateIds of ladder) {
                        const cancelIds = new Set<string>(candidateIds);
                        if (cancelIds.size === 0) continue;
                        // Simulate the cancels against the remaining evidence; the
                        // queued orders leave the book in Phase 2.
                        const remainingParsed = parsedChain
                            .filter((x: any) => !cancelIds.has(String(x.parsed?.orderId)))
                            .map((x: any) => x.parsed);
                        const recheck = validateBoundaryAgainstChainEvidence({
                            boundaryIdx: resolvedBand.boundaryIdx,
                            gapSlots: resolvedBand.gapSlots,
                            allSlots: evidenceSlots,
                            chainOrders: remainingParsed,
                        });
                        if (recheck.suggestedBoundary === null) continue;
                        logger?.log?.(
                            `[BOUNDARY-EVIDENCE] NO_FEASIBLE recovery: cancelling ${cancelIds.size} straddling ` +
                            `order(s) [${[...cancelIds].join(', ')}] whose price occupies the gap band; ` +
                            `re-deriving boundary afterwards.`,
                            'warn'
                        );
                        for (const u of parsedChain) {
                            if (!u?.parsed || !cancelIds.has(String(u.parsed.orderId))) continue;
                            plannedCancels.push({
                                chainOrderId: u.parsed.orderId,
                                chainOrderObj: u.chain,
                                releaseUntrackedFunds: true,
                            });
                        }
                        unmatchedParsed = unmatchedParsed.filter((u: any) => !cancelIds.has(String(u.parsed?.orderId)));
                        unmatchedBuys = unmatchedParsed.filter((x: any) => x.parsed.type === ORDER_TYPES.BUY).map((x: any) => x.chain);
                        unmatchedSells = unmatchedParsed.filter((x: any) => x.parsed.type === ORDER_TYPES.SELL).map((x: any) => x.chain);
                        manager._restoreBoundary(recheck.suggestedBoundary);
                        placementsAllowed = true;
                        logger?.log?.(
                            `[BOUNDARY-EVIDENCE] Boundary re-derived after straddle cancel: ` +
                            `${resolvedBand.boundaryIdx} -> ${recheck.suggestedBoundary}; ` +
                            `placements proceed on corrected geometry.`,
                            'warn'
                        );
                        repaired = true;
                        break;
                    }
                    if (!repaired) {
                        // Fix #5 (Mode D): previously this froze placements with only an error
                        // log and no retry, so the bot could stay adoption-only for hours.
                        // Log at WARN and arm a bounded re-validation: the
                        // periodic sync re-runs boundary validation on the next tick instead of
                        // waiting for a fill-driven rotation path to unstick it.
                        logger?.log?.(
                            '[BOUNDARY-EVIDENCE] No safe boundary derivable from chain evidence — ' +
                            'startup placements deferred (adoption-only reconcile). ' +
                            'Arming next-tick boundary re-validation (NO_FEASIBLE recovery).',
                            'warn'
                        );
                        try {
                            (manager as any)._boundaryRevalidationPending = {
                                since: Date.now(),
                                attempts: ((manager as any)._boundaryRevalidationPending?.attempts || 0) + 1,
                            };
                        } catch { /* ignore */ }
                    }
                }
            } else {
                // Boundary already consistent with chain evidence — clear any armed
                // re-validation (it would have been set by a prior NO_FEASIBLE cycle).
                try { (manager as any)._boundaryRevalidationPending = null; } catch { /* ignore */ }
            }
        }

        // NOTE: the previous "P2 gap-band orphan sweep" that cancelled any
        // unmatched chain order priced inside the gap band has been REMOVED.
        // Cancelling is the most destructive action and was firing during exactly
        // the unvalidated/stale-boundary restarts where the band itself was
        // wrong — it destroyed legitimate boundary orders instead of rotating
        // them. The boundary is now derived from chain evidence (above); a chain
        // order that looks "in-gap" under a wrong boundary is simply adopted by
        // the normal reconcile path once the boundary is corrected.

        const sellResult = await _reconcileStartupSide({
            orderType: ORDER_TYPES.SELL,
            targetCount: targetSell,
            chainSideOrders: chainSells,
            unmatchedSideOrders: unmatchedSells,
            manager,
            chainOrders,
            account,
            privateKey,
            dryRun,
            plannedCreates,
            plannedUpdates,
            plannedCancels,
            planOnly: true,
            placementsAllowed,
        });

        const buyResult = await _reconcileStartupSide({
            orderType: ORDER_TYPES.BUY,
            targetCount: targetBuy,
            chainSideOrders: chainBuys,
            unmatchedSideOrders: unmatchedBuys,
            manager,
            chainOrders,
            account,
            privateKey,
            dryRun,
            plannedCreates,
            plannedUpdates,
            plannedCancels,
            planOnly: true,
            placementsAllowed,
        });

        return { plannedCreates, plannedUpdates, plannedCancels, chainSellCount: sellResult.chainCount, chainBuyCount: buyResult.chainCount };
    });

    // PHASE 2: Blockchain operations outside lock (batch updates, creates, cancels, read)
    // These are the heavy operations that would block all other grid operations
    // if held under _gridLock. All lock acquisitions here follow the canonical
    // hierarchy (fillProcessingLock → syncLock → gridLock → fundLock).
    // P0 placement mutex: the whole of Phase 2 is broadcast I/O plus master-grid
    // mutations, and it is NOT under _gridLock. Without the broadcasting gate a
    // fill-driven COW rebalance can plan and broadcast the SAME slots in parallel
    // with this loop: the commit is then refused ("master mutation during
    // broadcasting"), both order generations land on chain, and the loser becomes
    // a duplicate-price orphan backlog that blocks placements until drained.
    // startBroadcasting() defers that rebalance —
    // manager.performSafeRebalance waits on the flag and the fill consumer gates
    // on it. The flag is refcounted and has a 120s stale-clear watchdog.
    if (typeof manager.startBroadcasting === 'function') manager.startBroadcasting();
    try {
        const { plannedCreates, plannedUpdates, plannedCancels, chainSellCount, chainBuyCount } = phase1Result;

        // Execute planned cancellations (duplicates, edge, excess) outside lock.
        // Each _cancelChainOrder call acquires _gridLock internally via synchronizeWithChain.
        if (!dryRun && plannedCancels.length > 0) {
            logger?.log?.(`Startup: Executing ${plannedCancels.length} queued cancellations (Phase 2)`, 'info');
            for (const cancelPlan of plannedCancels) {
                try {
                    await _cancelChainOrder({
                        chainOrders,
                        account,
                        privateKey,
                        manager,
                        chainOrderId: cancelPlan.chainOrderId,
                        dryRun,
                        chainOrderObj: cancelPlan.chainOrderObj,
                        releaseUntrackedFunds: cancelPlan.releaseUntrackedFunds,
                    });
                    logger?.log?.(
                        `Startup: Cancelled queued order ${cancelPlan.chainOrderId} (Phase 2)`,
                        'info'
                    );
                } catch (cancelErr: any) {
                    logger?.log?.(
                        `Startup: Failed to cancel queued order ${cancelPlan.chainOrderId}: ${getErrorMessage(cancelErr)}`,
                        'error'
                    );
                }
            }
        }

        if (!dryRun && plannedUpdates.length > 0) {
            let updatePlans = plannedUpdates;
            const maxBatchAttempts = 3;
            let batchCompleted = false;

            if (supportsBatchUpdate) {
                for (let attempt = 1; attempt <= maxBatchAttempts; attempt++) {
                    try {
                        const batchResult = await _executeStartupUpdateBatch({
                            updatePlans,
                            chainOrders,
                            account,
                            privateKey,
                            manager,
                            dryRun,
                        });

                        if (batchResult.executed) {
                            logger?.log?.(`Startup: Update batch complete (${batchResult.prepared} updated)`, 'info');
                        }
                        batchCompleted = true;
                        break;
                    } catch (err: any) {
                        logger?.log?.(`Startup: Update batch attempt ${attempt}/${maxBatchAttempts} failed: ${getErrorMessage(err)}`, 'error');

                        const refreshedChainOrders = await _recoverStartupSyncFailure({
                            chainOrders,
                            manager,
                            account,
                            logger,
                            triggerMessage: `Startup: Triggering recovery sync after update batch failure (attempt ${attempt}/${maxBatchAttempts})`,
                            source: 'startupReconcileUpdateBatchFailure',
                        });

                        updatePlans = _refreshStartupUpdatePlans(updatePlans, refreshedChainOrders);
                        if (updatePlans.length === 0) {
                            logger?.log?.('Startup: No update plans remain after recovery sync; skipping further update attempts', 'warn');
                            batchCompleted = true;
                            break;
                        }

                        if (attempt >= maxBatchAttempts) {
                            logger?.log?.('Startup: Update batch retries exhausted; switching to sequential fallback', 'warn');
                            break;
                        }
                    }
                }
            } else {
                logger?.log?.('Startup: Batch update helpers unavailable; using sequential fallback updates', 'warn');
            }

            if (!batchCompleted && updatePlans.length > 0) {
                try {
                    const fallbackResult = await _executeStartupSequentialUpdateFallback({
                        updatePlans,
                        chainOrders,
                        account,
                        privateKey,
                        manager,
                        dryRun,
                    });

                    if (fallbackResult.executed > 0 || fallbackResult.skipped > 0 || fallbackResult.failed > 0) {
                        logger?.log?.(
                            `Startup: Sequential fallback complete (updated=${fallbackResult.executed}, skipped=${fallbackResult.skipped}, failed=${fallbackResult.failed})`,
                            fallbackResult.failed > 0 ? 'warn' : 'info'
                        );
                    }
                } catch (err: any) {
                    logger?.log?.(`Startup: Sequential fallback failed unexpectedly: ${getErrorMessage(err)}`, 'error');
                }
            }
        }

        const phase2CreatedOrderIds = new Set<string>();
        if (!dryRun && plannedCreates.length > 0) {
            const createdIds = await _executePlannedStartupCreates({
                createPlans: plannedCreates,
                chainOrders,
                account,
                privateKey,
                manager,
                dryRun,
            });
            for (const id of createdIds) {
                phase2CreatedOrderIds.add(id);
            }
        }

        let finalChainSellCount = chainSellCount;
        let finalChainBuyCount = chainBuyCount;
        if (!dryRun) {
            try {
                // Truncated-read guard: get_full_accounts caps the limit_orders
                // window and fresh orders (exactly the Phase-2 creates) sort last
                // and are the first entries omitted. The adoption loop and the
                // surplus-cancel counts would silently operate on a partial
                // snapshot — defer to the sync loop's targeted drift detection and
                // keep the pre-Phase-2 counts for the summary log.
                const freshOpenOrders = await readOpenOrdersGuarded(chainOrders, account, {
                    log: (message: string, level: any) => logger?.log?.(message, level),
                    label: 'STARTUP',
                    detail: 'Post-Phase-2 chain read',
                });
                if (freshOpenOrders !== null) {
                    const freshParsed = (Array.isArray(freshOpenOrders) ? freshOpenOrders : [])
                        .map((co: any) => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
                        .filter((x: any) => x.parsed);

                    const gridOrderIds = new Set<string>();
                    for (const order of manager.orders.values()) {
                        if (order && order.orderId) gridOrderIds.add(order.orderId);
                    }
                    // Merge any chain order IDs Phase 2 successfully created on-chain
                    // (even if _applySync failed to register them in manager.orders).
                    // This prevents Phase 3 from cancelling legitimately created orders.
                    for (const id of phase2CreatedOrderIds) {
                        gridOrderIds.add(id);
                    }

                    // Adopt any Phase-2 uncertain-landed chain orders that never made
                    // it into grid slots (the group adoption sync only runs when the
                    // post-uncertain read returned orders). Targeted slot adoption
                    // only: match VIRTUAL/SPREAD slots without an orderId by
                    // type+price+size (within tolerance). Full syncFromOpenOrders is
                    // deliberately NOT used here — its pass-1 virtualizes ACTIVE slots
                    // missing from the snapshot, and a lagging read right after the
                    // Phase-2 broadcast would destroy the confirmed grid.
                    const btsFeeData = getAssetFeesSafe('BTS');
                    for (const entry of freshParsed) {
                        const co: any = entry.chain;
                        const parsed: any = entry.parsed;
                        if (!co?.id || !parsed) continue;
                        if (gridOrderIds.has(co.id)) continue;
                        const candidate: any = Array.from(manager.orders.values()).find((o: any) => {
                            if (!o || o.orderId || o.state !== ORDER_STATES.VIRTUAL) return false;
                            return chainOrderMatchesSlot(parsed, o, manager.assets);
                        });
                        if (!candidate) continue;
                        try {
                            await manager._applySync({
                                gridOrderId: candidate.id,
                                chainOrderId: co.id,
                                isPartialPlacement: false,
                                expectedType: parsed.type,
                                fee: btsFeeData?.createFee || 0,
                            }, 'createOrder');
                            gridOrderIds.add(co.id);
                            phase2CreatedOrderIds.add(co.id);
                            logger?.log?.(
                                `Startup: Adopted uncertain-landed chain order ${co.id} into slot ${candidate.id} (${parsed.type}, price=${parsed.price})`,
                                'warn'
                            );
                        } catch (adoptErr: any) {
                            logger?.log?.(
                                `Startup: Failed to adopt landed order ${co.id} into slot ${candidate?.id}: ${getErrorMessage(adoptErr)}`,
                                'warn'
                            );
                            // The order IS on chain (Phase-2 uncertain-landed). Even
                            // though the slot registration failed, the ID must still
                            // be protected from the same pass's surplus-cancel —
                            // mirror the capturedId protection of _createOrderFromGrid.
                            // The next sync loop's orphan adoption registers it.
                            gridOrderIds.add(co.id);
                        }
                    }
                    const staleSurplusCancels: Array<{ chainOrderObj: any; sideLabel: string }> = [];
                    for (const side of [ORDER_TYPES.SELL, ORDER_TYPES.BUY]) {
                        const targetCount = side === ORDER_TYPES.SELL ? targetSell : targetBuy;
                        let sideOrders = freshParsed.filter((x: any) => x.parsed.type === side);
                        const sideLabel = side === ORDER_TYPES.SELL ? 'SELL' : 'BUY';

                        if (sideOrders.length > targetCount) {
                            // Sort by chain ID for deterministic cancellation order.
                            sideOrders = sideOrders.sort((a: any, b: any) =>
                                (a.chain.id || '').localeCompare(b.chain.id || '')
                            );
                            let cancelLimit = sideOrders.length - targetCount;
                            for (const so of sideOrders) {
                                if (cancelLimit <= 0) break;
                                if (!gridOrderIds.has(so.chain.id)) {
                                    staleSurplusCancels.push({ chainOrderObj: so.chain, sideLabel });
                                    cancelLimit--;
                                }
                            }
                        }
                    }

                    let cancelledSellCount = 0;
                    let cancelledBuyCount = 0;
                    if (staleSurplusCancels.length > 0) {
                        for (const sc of staleSurplusCancels) {
                            try {
                                await _cancelChainOrder({
                                    chainOrders,
                                    account,
                                    privateKey,
                                    manager,
                                    chainOrderId: sc.chainOrderObj.id,
                                    dryRun,
                                    chainOrderObj: sc.chainOrderObj,
                                    releaseUntrackedFunds: true,
                                });
                                if (sc.sideLabel === 'SELL') cancelledSellCount++;
                                else cancelledBuyCount++;
                                logger?.log?.(`Startup: Cancelled stale surplus ${sc.sideLabel} order ${sc.chainOrderObj.id}`, 'info');
                            } catch (e: any) {
                                logger?.log?.(`Startup: Failed to cancel surplus ${sc.sideLabel} ${sc.chainOrderObj.id}: ${getErrorMessage(e)}`, 'warn');
                            }
                        }
                    }

                    finalChainSellCount = freshParsed.filter((x: any) => x.parsed.type === ORDER_TYPES.SELL).length - cancelledSellCount;
                    finalChainBuyCount = freshParsed.filter((x: any) => x.parsed.type === ORDER_TYPES.BUY).length - cancelledBuyCount;
                }
            } catch (err: any) {
                logger?.log?.(`Startup: Failed to refresh final chain counts: ${getErrorMessage(err)}`, 'warn');
            }
        }

        logger && logger.log && logger.log(
            `Startup reconcile complete: target(sell=${targetSell}, buy=${targetBuy}), chain(sell=${finalChainSellCount}, buy=${finalChainBuyCount}), ` +
            `gridActive(sell=${_countActiveOnGrid(manager, ORDER_TYPES.SELL)}, buy=${_countActiveOnGrid(manager, ORDER_TYPES.BUY)})`,
            'info'
        );
    } finally {
        if (typeof manager.stopBroadcasting === 'function') manager.stopBroadcasting();
    }

    return null;
}


