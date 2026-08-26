/**
 * modules/order/sync_engine.ts - SyncEngine
 *
 * Blockchain synchronization and reconciliation engine.
 * Exports a single SyncEngine class handling all blockchain state matching.
 *
 * Responsibilities:
 * - Match blockchain open orders to grid orders
 * - Detect and handle partial fills
 * - Process fill history events
 * - Update fund state based on blockchain
 * - Fetch and cache account balances
 * - Initialize asset metadata
 *
 * Uses AsyncLock to prevent concurrent sync operations (defense-in-depth locking).
 *
 * ===============================================================================
 * TABLE OF CONTENTS - SyncEngine Class (8 methods) + 1 module-level helper
 * ===============================================================================
 *
 * MODULE-LEVEL HELPER (internal, not exported):
 *   hasEquivalentRawOnChainOrder(a, b) - Compare two chain orders for equivalence
 *      Used internally during sync to detect redundant/duplicate chain entries
 *
 * INITIALIZATION (1 method)
 *   1. constructor(manager) - Create new SyncEngine with manager reference
 *
 * BLOCKCHAIN SYNCHRONIZATION (3 methods - async)
 *   2. syncFromOpenOrders(chainOrders, options) - Main sync entry point (async)
 *      Reconciles grid against fresh blockchain snapshot
 *      Uses AsyncLock to ensure only one sync at a time (defense-in-depth)
 *      Performs two-pass reconciliation (grid→chain, then chain→grid)
 *
 *   3. _doSyncFromOpenOrders(chainOrders, options) - Execute sync with locking (async, internal)
 *      Acquires _syncLock, validates chain orders, calls _performSyncFromOpenOrders
 *
 *   4. _performSyncFromOpenOrders(mgr, precA, precB, parsedChain, rawChain, options) - Core sync logic (internal)
 *      Performs actual two-pass reconciliation without locking
 *      Pass 1: Match grid orders to chain (known grid → chain, includes orphan cleanup)
 *      Pass 2: Add missing chain orders (unknown chain → grid)
 *
 * FILL PROCESSING (2 methods)
 *   5. syncFromFillHistory(fill) - Process single fill event synchronously
 *      Updates grid order state based on fill data
 *      Updates fund state and accounting
 *      Handles both maker and taker fills
 *
 *   6. syncFromFillHistoryBatch(fills) - Process multiple fill events in batch
 *      Acquires _gridLock once for all fills in block group
 *      Batches drift refetch into one get_objects RPC call
 *      Applies all grid mutations in a single applyGridUpdateBatch
 *
 * FULL SYNCHRONIZATION (1 method - async)
 *   7. synchronizeWithChain(chainData, source) - Full sync (fetch + sync) (async)
 *      Fetches fresh account balances
 *      Calls syncFromOpenOrders() with chain data
 *      Source: event type that triggered sync (fill, poll, broadcast, etc.)
 *
 * ACCOUNT STATE (2 methods - async)
 *   8. fetchAccountBalancesAndSetTotals(accountId) - Fetch account totals (async)
 *      Retrieves BUY/SELL totals and free balances from blockchain
 *      Sets manager.accountTotals
 *      Triggers fund recalculation
 *
 *   9. initializeAssets() - Initialize asset metadata (async)
 *      Fetches asset precision and other metadata
 *      Sets manager.assets
 *      Called once at bot startup
 *
 * ===============================================================================
 *
 * GLOBAL LOCK HIERARCHY (see manager.ts for canonical 5-level definition):
 *   Level 0: _fillProcessingLock  →  Level 1: _divergenceLock  →  Level 2: _syncLock
 *   →  Level 3: _gridLock  →  Level 4: _fundLock
 * Acquire in ascending order only.
 *
 * SYNC-LOCAL HIERARCHY (nested inside _syncLock):
 * 1. _syncLock (AsyncLock): Ensures only one full-sync at a time
 * 2. Per-order locks (shadowOrderIds): Protect specific orders during sync
 * 3. Lock refresh mechanism: Prevents timeout during long reconciliation
 *
 * TWO-PASS RECONCILIATION:
 * PASS 1: Grid → Chain
 * - For each grid order with orderId, find matching chain order
 * - Detect partial fills (chain size < grid size)
 * - Update sizes and mark as filled if needed
 * - Downgrade to VIRTUAL if not found on-chain
 *
 * PASS 2: Chain → Grid
 * - For each chain order not matched to grid order
 * - Create new grid order for unexpected chain order
 * - Mark as ACTIVE with blockchain orderId
 *
 * ===============================================================================
 */


import { ORDER_TYPES, ORDER_STATES, TIMING, BTS_PRECISION } from '../constants.js';
import * as Format from './format.js';
import { lookupAsset } from './utils/system.js';
import * as chainOrders from '../chain_orders.js';
import * as client from '../bitshares_client.js';
const { BitShares } = client;
import { NATIVE_CLIENT } from '../constants.js';
const { toFiniteNumber } = Format;
import {
    blockchainToFloat,
    floatToBlockchainInt,
    calculatePriceTolerance,
    getAssetFees,
    getBtsSide
} from './utils/math.js';
import {
    parseChainOrder,
    findMatchingGridOrderByOpenOrder,
    applyChainSizeToGridOrder,
    convertToSpreadPlaceholder,
    virtualizeOrder,
    buildFillKey,
    isOrderPlaced,
    hasOnChainId,
    isOrderVirtual,
    resolveSpreadOrderSide,
    duplicateOrphanLogInfo
} from './utils/order.js';
import {
    resolveProcessedFillPersistenceMode
} from './processed_fill_store.js';
import { getErrorMessage } from '../utils/errors.js';

function describeNearestAdoptionCandidates(mgr: any, chainOrder: any, precision: any, calcTolerance: any, matchedGridOrderIds: Set<string> | null = null) {
    if (!mgr?.orders || !chainOrder || typeof precision !== 'number') return 'candidate diagnostics unavailable';

    const chainPrice = toFiniteNumber(chainOrder.price);
    const chainSize = toFiniteNumber(chainOrder.size);
    const chainInt = floatToBlockchainInt(chainSize, precision);
    const candidates: any[] = [];

    for (const slot of mgr.orders.values()) {
        if (!slot || ![ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL, ORDER_STATES.VIRTUAL].includes(slot.state)) continue;
        const typeMatch = slot.type === chainOrder.type;
        const spreadMatch = slot.type === ORDER_TYPES.SPREAD;
        if (!typeMatch && !spreadMatch) continue;

        const price = toFiniteNumber(slot.price);
        const priceDiff = Math.abs(price - chainPrice);
        const effectiveSize = slot.size > 0 ? toFiniteNumber(slot.size) : chainSize;
        const tolerance = calcTolerance(price, effectiveSize, chainOrder.type) || 0;
        const gridInt = floatToBlockchainInt(toFiniteNumber(slot.size), precision);
        const sizeDiffInt = chainInt - gridInt;
        const hasOrderId = Boolean(slot.orderId);
        const alreadyMatched = Boolean(matchedGridOrderIds?.has?.(slot.id));
        const sizeOk = Math.abs(sizeDiffInt) <= 1;
        const primaryEligible = typeMatch && priceDiff <= tolerance && sizeOk;
        const fallbackEligible = (typeMatch || spreadMatch) && priceDiff <= tolerance && sizeOk && !hasOrderId && !alreadyMatched;

        candidates.push({
            slot,
            typeMatch,
            spreadMatch,
            priceDiff,
            tolerance,
            sizeDiffInt,
            hasOrderId,
            alreadyMatched,
            primaryEligible,
            fallbackEligible,
        });
    }

    candidates.sort((a, b) => a.priceDiff - b.priceDiff);
    if (candidates.length === 0) return 'no same-side or spread candidate slots exist';

    return candidates.slice(0, 5).map((candidate) => {
        const slot = candidate.slot;
        const reasons: string[] = [];
        if (!candidate.typeMatch && !candidate.spreadMatch) reasons.push('type');
        if (candidate.priceDiff > candidate.tolerance) reasons.push('price');
        if (Math.abs(candidate.sizeDiffInt) > 1) reasons.push('size');
        if (candidate.hasOrderId) reasons.push(`occupied:${slot.orderId}`);
        if (candidate.alreadyMatched) reasons.push('alreadyMatched');
        if (candidate.primaryEligible) reasons.push('primary-matchable');
        if (candidate.fallbackEligible) reasons.push('fallback-adoptable');
        return `${slot.id || 'unknown'} ${slot.type}/${slot.state}` +
            ` orderId=${slot.orderId || 'none'}` +
            ` price=${Format.formatPrice6(slot.price)}` +
            ` diff=${Format.formatPrice6(candidate.priceDiff)}` +
            ` tol=${Format.formatPrice6(candidate.tolerance)}` +
            ` size=${Format.formatSizeByOrderType(slot.size || 0, chainOrder.type, mgr.assets)}` +
            ` sizeDiffInt=${candidate.sizeDiffInt}` +
            ` reason=${reasons.join('|') || 'unknown'}`;
    }).join('; ');
}

/**
 * Find the closest same-side (or spread) candidate slot for a chain order and
 * return a "price-drift-orphan" tag if the slot's price diff is larger than the
 * strict tolerance but small enough to be considered a meaningful drift.
 *
 * Rationale: when the chain order has drifted from the planned slot price by
 * more than the matcher's strict tolerance (so the matcher correctly rejects
 * the adoption), the next planning cycle's pre-broadcast guard will refuse
 * new CREATEs and the structural resync will cancel+recreate. Tagging the
 * entry as a price-drift-orphan lets the auto-cancel path prioritize it and
 * the diagnostics surface the exact slot the orphan drifted from.
 *
 * "Meaningful drift" = price diff > strict tolerance AND price diff
 * <= strict tolerance * PRICE_DRIFT_TOLERANCE_MULTIPLIER. Larger diffs are
 * considered wildly-out-of-tolerance orphans (e.g. legacy orders from a
 * previous config) and are NOT tagged — the resync will discard them
 * structurally instead.
 *
 * @param {Object} mgr - OrderManager instance
 * @param {Object} chainOrder - Parsed chain order { price, size, type }
 * @param {Function} calcToleranceFn - calculatePriceTolerance function
 * @returns {{candidateSlotId: string, candidateSlotPrice: number, priceDiff: number, tolerance: number}|null}
 */
function computeOutOfToleranceDriftTag(mgr: any, chainOrder: any, calcToleranceFn: any) {
    if (!mgr?.orders || !chainOrder) return null;
    const chainPrice = toFiniteNumber(chainOrder.price);
    if (!Number.isFinite(chainPrice)) return null;
    const chainSize = toFiniteNumber(chainOrder.size);
    const orderType = chainOrder.type;
    if (orderType !== ORDER_TYPES.BUY && orderType !== ORDER_TYPES.SELL) return null;

    let bestDrift: any = null;
    for (const slot of mgr.orders.values()) {
        if (!slot) continue;
        if (slot.type !== orderType && slot.type !== ORDER_TYPES.SPREAD) continue;
        if (slot.orderId) continue;
        if (![ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL, ORDER_STATES.VIRTUAL].includes(slot.state)) continue;
        const slotPrice = toFiniteNumber(slot.price);
        if (!Number.isFinite(slotPrice)) continue;
        const priceDiff = Math.abs(slotPrice - chainPrice);
        const effectiveSize = slot.size > 0 ? toFiniteNumber(slot.size) : chainSize;
        const tolerance = (calcToleranceFn ? (calcToleranceFn(slotPrice, effectiveSize, orderType) || 0) : 0);
        if (priceDiff <= tolerance) continue;
        const driftMultiplier = mgr?.config?.gridLimits?.PRICE_DRIFT_TOLERANCE_MULTIPLIER;
        const driftBudget = tolerance * driftMultiplier;
        if (driftBudget > 0 && priceDiff > driftBudget) continue;
        if (!bestDrift || priceDiff < bestDrift.priceDiff) {
            bestDrift = {
                candidateSlotId: slot.id,
                candidateSlotPrice: slotPrice,
                priceDiff,
                tolerance
            };
        }
    }
    return bestDrift;
}

class SyncEngine {
    private manager: any;
    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager: any) {
        this.manager = manager;
    }

    /**
     * Reconcile grid orders against fresh blockchain open orders snapshot.
     * This is the MAIN SYNCHRONIZATION MECHANISM that corrects the grid state when
     * the blockchain state diverges from our local expectations.
     *
     * CRITICAL: This method uses AsyncLock (defense-in-depth) to ensure only one
     * full-sync operation runs at a time. WITHIN that lock, per-order locks prevent
     * concurrent createOrder/cancelOrder races.
     *
     * LOCK HIERARCHY:
     * 1. _syncLock (AsyncLock): Ensures only one full-sync at a time
     * 2. Per-order locks (shadowOrderIds): Protect specific orders during sync
     * 3. Lock refresh mechanism: Prevents timeout during long reconciliation
     *
     * RECONCILIATION FLOW:
     * ========================================================================
     * This method performs a two-pass reconciliation:
     *
     * PASS 1: Match grid orders to chain orders (known grid → chain lookup)
     * - For each grid order with an orderId, find the matching chain order
     * - Detect partial fills: if chain size < grid size, downgrade to PARTIAL state
     * - Detect full fills: if order no longer exists on chain, convert to SPREAD
     * - Detect price slippage: flag orders for price correction if needed
     * - Update grid order sizes to match chain reality
     *
     * PASS 2: Orphan chain orders (chain → grid lookup)
     * - For chain orders not matched in Pass 1, find best grid slot match
     * - This handles cases where an order was placed but grid lost track (race condition)
     * - Uses price tolerance and geometric proximity to find the best match
     * - Once matched, retroactively assign orderId and synchronize state
     *
     * CRITICAL RULES:
     * 1. ACTIVE orders can only stay ACTIVE if size matches chain exactly
     *    If chain size < grid size → must transition to PARTIAL
     * 2. If an ACTIVE order is not found on chain → it filled → convert to SPREAD
     * 3. Precision matters: Use blockchain integer arithmetic to compare sizes
     *    Floating point comparisons can give false positives for partial fills
     * 4. Size updates are applied via applyChainSizeToGridOrder() which handles
     *    precision conversion and may adjust sizes slightly for blockchain granularity
     *
      * PRICE TOLERANCE CALCULATION:
      * calculatePriceTolerance() can return null in these cases:
      *   1. assets parameter is null/missing
      *   2. gridPrice is 0 or null (invalid price)
      *   3. orderSize is 0 or null (invalid size - orders should not sync with 0 size)
      *   4. assetA or assetB precision is undefined (asset metadata not loaded)
      * When tolerance is null, we treat it as 0 (strict: any price difference flagged).
      * This is safe because null signals a configuration/data issue, not a real order.
      *
      * RETURNS: { filledOrders, updatedOrders, ordersNeedingCorrection }
      * - filledOrders: Orders that completed (now SPREAD placeholders)
      * - updatedOrders: All orders modified during sync (state changes, size updates)
      * - ordersNeedingCorrection: Orders with price slippage requiring correction
     *
     * EDGE CASES HANDLED:
     * - Orphan chain orders (placed but grid lost track due to race condition)
     * - Partial fills (size reduced on chain)
     * - Full fills (order removed from chain completely)
     * - Price tolerance (small slippage acceptable, large slippage flagged)
     * - Precision mismatches (blockchain integer precision vs float grid)
     * - Double spending prevention (each chain order matched to at most one grid order)
     */
    /**
     * Synchronize grid orders with blockchain open orders snapshot.
     * @param {Array|null} chainOrders - Array of blockchain order objects
     * @param {Object} [options={}] - Sync options (e.g., { skipAccounting: true })
     * @returns {Promise<Object>} Result with filledOrders, updatedOrders, ordersNeedingCorrection
     */
    async syncFromOpenOrders(chainOrders: any[] | null, options: Record<string, any> = {}) {
        const mgr = this.manager;

        if (!mgr) {
            throw new Error('manager required for syncFromOpenOrders');
        }
        if (!mgr._syncLock) {
            mgr.logger?.log?.('Error: syncLock not initialized', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }

        // CRITICAL: The gate below is the recursion breaker. syncFromOpenOrders
        // re-invokes itself as the acquire() callback, so without this check the
        // acquire() re-entrant short-circuit alone would recurse forever (each
        // nested call is re-entrant and runs the body again). Only run through
        // the lock when the caller does NOT already hold it.
        if (mgr._fillProcessingLock && !mgr._fillProcessingLock.isReentrant()) {
            return mgr._fillProcessingLock.acquire(async () => {
                return this.syncFromOpenOrders(chainOrders, options);
            });
        }

        const timeoutMs = TIMING.SYNC_LOCK_TIMEOUT_MS;
        const forceReleaseMs = TIMING.SYNC_LOCK_FORCE_RELEASE_AGE_MS;
        let timedOut = false;
        let timeoutHandle: any;
        let forceReleaseHandle: any;
        const syncStartedAt = Date.now();
        // Capture sync generation so the orphan callback can detect that it
        // was force-released and abort early instead of running to completion.
        const captureGeneration = (mgr as any)._syncGeneration ?? 0;
        try {
            const result = await Promise.race([
                mgr._syncLock.acquire(async () => {
                    // Early-abort check: if forceRelease incremented _syncGeneration
                    // while we were waiting in the lock queue, this callback is
                    // orphaned and should return immediately.
                    if (((mgr as any)._syncGeneration ?? 0) !== captureGeneration) {
                        mgr.logger?.log?.('[SYNC] Sync abandoned: force-released before lock acquired', 'warn');
                        return { filledOrders: [] as any[], updatedOrders: [] as any[], ordersNeedingCorrection: [] as any[], unmatchedChainOrders: [] as any[] };
                    }

                    // Snapshot the correction queue length so we can roll back
                    // side-effect pushes if forceRelease fires during the sync.
                    const preSyncCorrectionLen = Array.isArray(mgr.ordersNeedingPriceCorrection)
                        ? mgr.ordersNeedingPriceCorrection.length
                        : 0;

                    // If fill accounting applied balances but the order update
                    // failed, flag forces a fresh chain-balance fetch to correct
                    // the negative free balance before the next sync cycle.
                    if (mgr.accountTotalsStale) {
                        mgr.accountTotalsStale = false;
                        try {
                            await mgr.fetchAccountTotals(mgr.accountId || mgr.config?.accountId);
                        } catch (fetchErr: any) {
                            mgr.logger?.log?.(`[SYNC] Stale-totals refresh failed: ${getErrorMessage(fetchErr)}`, 'warn');
                        }
                    }

                    const innerResult: any = await this._doSyncFromOpenOrders(chainOrders, options);

                    // Re-check generation after sync completes: if forceRelease fired
                    // during the sync, this result is orphaned — discard it.
                    if (((mgr as any)._syncGeneration ?? 0) !== captureGeneration) {
                        mgr.logger?.log?.(
                            `[SYNC] Sync abandoned: force-released during sync (${Date.now() - syncStartedAt}ms); discarding result`,
                            'warn'
                        );
                        // Roll back any corrections that _performSyncFromOpenOrders may
                        // have pushed to the manager-level queue — the caller discarding
                        // the result will never process them, leaving orphaned entries.
                        if (Array.isArray(mgr.ordersNeedingPriceCorrection) && mgr.ordersNeedingPriceCorrection.length > preSyncCorrectionLen) {
                            mgr.ordersNeedingPriceCorrection.length = preSyncCorrectionLen;
                        }
                        return { filledOrders: [] as any[], updatedOrders: [] as any[], ordersNeedingCorrection: [] as any[], unmatchedChainOrders: [] as any[] };
                    }

                    if (timedOut) {
                        mgr.logger?.log?.(
                            `[SYNC] Sync completed after timeout (${Date.now() - syncStartedAt}ms) — ` +
                            `timeout won the race; next sync will reconcile chain state`,
                            'warn'
                        );
                        return innerResult;
                    }
                    clearTimeout(forceReleaseHandle);
                    const unmatchedCount = Array.isArray(innerResult.unmatchedChainOrders)
                        ? innerResult.unmatchedChainOrders.length
                        : 0;
                    mgr._lastUnmatchedChainOrders = unmatchedCount > 0
                        ? innerResult.unmatchedChainOrders.map((order: any) => ({ ...order }))
                        : [];
                    mgr._lastUnmatchedChainOrdersAt = unmatchedCount > 0 ? Date.now() : 0;
                    mgr.logger?.log?.(
                        `[SYNC] Synchronization complete: ${innerResult.filledOrders.length} filled, ` +
                        `${innerResult.updatedOrders.length} updated, ` +
                        `${innerResult.ordersNeedingCorrection.length} needing correction.`, 'info');
                    return innerResult;
                }),
                new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        timedOut = true;
                        reject(new Error(`Sync timed out after ${timeoutMs}ms`));
                    }, timeoutMs);
                })
            ]);
            clearTimeout(timeoutHandle);
            clearTimeout(forceReleaseHandle);
            return result;
        } catch (err: any) {
            clearTimeout(timeoutHandle);
            clearTimeout(forceReleaseHandle);
            if (getErrorMessage(err)?.includes('timed out')) {
                // Gap 3: Schedule a force-release of the sync lock if the inner
                // operation doesn't complete within the grace window. This prevents
                // a single stuck sync from permanently blocking all subsequent syncs.
                if (forceReleaseMs > 0 && mgr._syncLock && typeof mgr._syncLock.forceRelease === 'function') {
                    forceReleaseHandle = setTimeout(() => {
                        if (mgr._syncLock.isLocked()) {
                            // Increment the sync generation so the orphan callback
                            // can detect it was force-released and abort early.
                            (mgr as any)._syncGeneration = ((mgr as any)._syncGeneration || 0) + 1;
                            const released = mgr._syncLock.forceRelease();
                            mgr.logger?.log?.(
                                `[SYNC] Force-released sync lock (generation=${(mgr as any)._syncGeneration}, ${released} queued ops cleared) after ${forceReleaseMs}ms grace period`,
                                'warn'
                            );
                        }
                    }, Math.max(1000, forceReleaseMs - (Date.now() - syncStartedAt)));
                }
                mgr.logger?.log?.(
                    '[SYNC] Lock may be held by orphan after timeout; will release when inner work completes',
                    'warn'
                );
            }
            mgr.logger?.log?.(`Sync lock error: ${getErrorMessage(err)}`, 'error');
            throw err;
        }
    }

    /**
     * Internal method that performs the actual sync logic within lock context.
     *
     * This is the core synchronization implementation that runs inside _syncLock
     * to ensure exclusive access. It validates inputs, parses chain orders, and
     * delegates to _performSyncFromOpenOrders for the actual reconciliation.
     *
     * VALIDATION CHECKS:
     * - Manager must be initialized
     * - Chain orders must be a valid array
     * - Manager.orders must be initialized as Map
     * - Asset precisions must be available
     *
     * PARSING:
     * Converts raw blockchain order objects to normalized format using parseChainOrder()
     * with appropriate asset precision.
     *
     * @param {Array<Object>|null} chainOrders - Array of raw blockchain order objects
     *   Each object contains sell_price, for_sale, id, etc. from blockchain
     * @param {Object} options - Sync options
     * @returns {Promise<Object>} Sync result:
     *   - filledOrders {Array}: Orders that were detected as filled
     *   - updatedOrders {Array}: Orders that were updated during sync
     *   - ordersNeedingCorrection {Array}: Orders flagged for price correction
     * @async
     * @private
     */
    async _doSyncFromOpenOrders(chainOrders: any[] | null, options: Record<string, any>) {
        const mgr = this.manager;

        // Validate inputs
        if (!mgr) {
            throw new Error('manager required');
        }

        if (!chainOrders || !Array.isArray(chainOrders)) {
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }
        if (!mgr.orders || !(mgr.orders instanceof Map)) {
            mgr.logger?.log?.('Error: manager.orders is not initialized as a Map', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }
        if (mgr.assets?.assetA?.precision === undefined || mgr.assets?.assetB?.precision === undefined) {
            mgr.logger?.log?.('Error: manager.assets precision missing', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }

        const assetAPrecision = mgr.assets.assetA.precision;
        const assetBPrecision = mgr.assets.assetB.precision;
        const assetAId = mgr.assets.assetA.id;
        const assetBId = mgr.assets.assetB.id;

        if (!assetAId || !assetBId) {
            mgr.logger?.log?.('Error: manager.assets asset IDs missing', 'error');
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
        }

        // Use separate maps: parsed (floats) and raw (blockchain integers)
        // This eliminates type confusion - each map has a single, clear purpose
        const parsedChainOrders = new Map();
        const rawChainOrders = new Map();

        for (const order of chainOrders) {
            try {
                const parsed = parseChainOrder(order, mgr.assets);
                if (!parsed) continue;

                // Store parsed (converted) data in parsedChainOrders
                parsedChainOrders.set(order.id, parsed);
                // Store raw blockchain data in separate map - clean separation of concerns
                rawChainOrders.set(order.id, order);
            } catch (e: any) {
                mgr.logger?.log?.(`Warning: Error parsing chain order ${order.id}: ${getErrorMessage(e)}`, 'warn');
                continue;
            }
        }

        mgr.logger?.log?.(`[SYNC] Starting synchronization from ${parsedChainOrders.size} blockchain orders...`, 'info');

        // Collect all order IDs that might be modified during reconciliation
        // Lock them to prevent concurrent modifications from createOrder/cancelOrder
        const orderIdsToLock = new Set<string>();
        for (const gridOrder of mgr.orders.values()) {
            // Lock any order with a chain orderId (already on-chain)
            if (gridOrder.orderId) {
                orderIdsToLock.add(gridOrder.id);
                orderIdsToLock.add(gridOrder.orderId);
            }
            // Also lock ACTIVE/PARTIAL orders that might transition to/from SPREAD
            if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                orderIdsToLock.add(gridOrder.id);
            }
        }

        // Re-verify that all collected order IDs still exist in mgr.orders before
        // locking. A concurrent createOrder/cancelOrder could have removed or
        // modified an order between collection above and the lock call below.
        // The _gridLock serializes the main reconciliation against _applyOrderUpdate,
        // but this re-verification catches the window before _gridLock acquisition.
        const validOrderIds = new Set<string>();
        for (const id of orderIdsToLock) {
            if (mgr.orders.has(id)) {
                validOrderIds.add(id);
            } else {
                mgr.logger?.log?.(
                    `[SYNC] Order ${id} disappeared between collection and locking; skipping`,
                    'debug'
                );
            }
        }
        const orderIdsToLockFinal = [...validOrderIds];

        const chainOrderIdsOnGrid = new Set<string>();
        const matchedGridOrderIds = new Set<string>();
        const filledOrders: any[] = [];
        const updatedOrders: any[] = [];
        const ordersNeedingCorrection: any[] = [];
        const unmatchedChainOrders: any[] = [];

        // Lock orders before reconciliation
        mgr.lockOrders(orderIdsToLockFinal);

        // Keep lock leases alive during long reconciliation runs.
        const refreshEveryMs = Math.max(TIMING.LOCK_REFRESH_MIN_MS, Math.floor(TIMING.LOCK_TIMEOUT_MS / 3));
        const refreshLockLeases = () => {
            const expiresAt = Date.now() + TIMING.LOCK_TIMEOUT_MS;
            for (const id of orderIdsToLockFinal) {
                mgr.shadowOrderIds.set(id, expiresAt);
            }
            mgr.logger?.log?.(`Refreshed lock leases for ${orderIdsToLockFinal.length} orders`, 'debug');
        };

        refreshLockLeases();
        const lockRefreshTimer = setInterval(refreshLockLeases, refreshEveryMs);

        try {
            const runReconciliation = async () => {
                mgr.pauseFundRecalc();
                try {
                    await this._performSyncFromOpenOrders(
                        mgr,
                        assetAPrecision,
                        assetBPrecision,
                        parsedChainOrders,
                        rawChainOrders,
                        chainOrderIdsOnGrid,
                        matchedGridOrderIds,
                        filledOrders,
                        updatedOrders,
                        ordersNeedingCorrection,
                        unmatchedChainOrders,
                        options
                    );
                } finally {
                    await mgr.resumeFundRecalc();
                }
            };

            await mgr._gridLock.acquire(runReconciliation);
        } finally {
            clearInterval(lockRefreshTimer);
            // Unlock after reconciliation completes
            mgr.unlockOrders(orderIdsToLockFinal);
        }

        return { filledOrders, updatedOrders, ordersNeedingCorrection, unmatchedChainOrders };
    }

    /**
     * Internal two-pass reconciliation with locks already held.
     * @param {Object} mgr - OrderManager instance
     * @param {number} assetAPrecision - Asset A precision
     * @param {number} assetBPrecision - Asset B precision
     * @param {Map<string, any>} parsedChainOrders - Parsed chain orders by ID
     * @param {Map<string, Object>} rawChainOrders - Raw blockchain order objects by ID
     * @param {Set<string>} chainOrderIdsOnGrid - Output set: chain order IDs matched to grid
     * @param {Set<string>} matchedGridOrderIds - Output set: grid order IDs matched to chain
     * @param {Array<Object>} filledOrders - Output array: orders detected as filled
     * @param {Array<Object>} updatedOrders - Output array: orders updated during sync
     * @param {Array<Object>} ordersNeedingCorrection - Output array: orders flagged for price correction
     * @param {Array<Object>} unmatchedChainOrders - Output array: open chain orders with no adoptable grid slot
     * @param {Object} options - Sync options (skipAccounting, etc.)
     * @returns {Promise<any>}
     */
    async _performSyncFromOpenOrders(mgr: any, assetAPrecision: number, assetBPrecision: number, parsedChainOrders: Map<string, any>, rawChainOrders: Map<string, any>,
        chainOrderIdsOnGrid: Set<string>, matchedGridOrderIds: Set<string>, filledOrders: any[], updatedOrders: any[], ordersNeedingCorrection: any[], unmatchedChainOrders: any[], options: Record<string, any>) {
        const skipAccounting = options?.skipAccounting ?? true;

        const queueCorrection = (entry: any) => {
            ordersNeedingCorrection.push(entry);
            if (!Array.isArray(mgr.ordersNeedingPriceCorrection)) return;

            const existingIndex = mgr.ordersNeedingPriceCorrection.findIndex((queued: any) =>
                queued?.chainOrderId === entry.chainOrderId && Boolean(queued?.isSurplus) === Boolean(entry.isSurplus)
            );

            if (existingIndex >= 0) {
                mgr.ordersNeedingPriceCorrection[existingIndex] = {
                    ...mgr.ordersNeedingPriceCorrection[existingIndex],
                    ...entry
                };
            } else {
                mgr.ordersNeedingPriceCorrection.push({ ...entry });
            }
        };

        // ====================================================================
        // PASS 1: GRID → CHAIN - Match grid orders to blockchain
        // ====================================================================
        for (const gridOrder of mgr.orders.values()) {

            if (gridOrder.orderId && parsedChainOrders.has(gridOrder.orderId)) {
                const chainOrder = parsedChainOrders.get(gridOrder.orderId);
                let updatedOrder = { ...gridOrder };
                chainOrderIdsOnGrid.add(gridOrder.orderId);
                // Store raw blockchain data in grid slot for later update calculation.
                // Tag the snapshot with `fetchedAt` so the drift check in
                // syncFromFillHistory can distinguish a fresh chain read from a
                // never-synced entry (the latter has no fetchedAt and is treated
                // as if grid-equals-chain, since the cache is just a thin mirror
                // of the grid baseline at this point).
                const rawSnapshot = rawChainOrders.get(gridOrder.orderId);
                updatedOrder.rawOnChain = rawSnapshot
                    ? { ...rawSnapshot, fetchedAt: Date.now() }
                    : rawSnapshot;

                // Side mismatch: keep slot untouched and queue cancellation for stale chain order.
                if (gridOrder.type !== chainOrder.type) {
                    mgr.logger?.log?.(
                        `[SYNC] Type mismatch for ${gridOrder.id}: grid=${gridOrder.type}, chain=${chainOrder.type}. ` +
                        `Queuing stale chain order ${gridOrder.orderId} for cancellation to prevent fund tracking corruption.`,
                        'warn'
                    );
                    queueCorrection({
                        gridOrder: { ...gridOrder },
                        chainOrderId: gridOrder.orderId,
                        expectedPrice: gridOrder.price,
                        actualPrice: chainOrder.price,
                        size: chainOrder.size,
                        type: chainOrder.type,
                        typeMismatch: true,
                        isSurplus: true,
                        sideUpdated: chainOrder.type
                    });
                    continue;
                } else {
                    const priceTolerance = calculatePriceTolerance(gridOrder.price, gridOrder.size, gridOrder.type, mgr.assets);
                    const normalizedTolerance = (priceTolerance === null) ? 0 : priceTolerance;

                    // Null tolerance is strict mode (0).
                    if (Math.abs(chainOrder.price - gridOrder.price) > normalizedTolerance) {
                        queueCorrection({
                            gridOrder: { ...gridOrder },
                            chainOrderId: gridOrder.orderId,
                            expectedPrice: gridOrder.price,
                            actualPrice: chainOrder.price,
                            size: chainOrder.size,
                            type: gridOrder.type
                        });
                    }
                }

                // Chain side determines which precision applies to for_sale.
                const precision = (chainOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const currentSizeInt = floatToBlockchainInt(gridOrder.size, precision);
                const chainSizeInt = floatToBlockchainInt(chainOrder.size, precision);

                if (currentSizeInt !== chainSizeInt) {
                    const newSize = blockchainToFloat(chainSizeInt, precision);
                    const newInt = floatToBlockchainInt(newSize, precision);

                    if (newInt > 0) {
                        const nextOrder = await applyChainSizeToGridOrder(mgr, updatedOrder, newSize);
                        if (nextOrder) {
                            // Merge updated state if size actually changed
                            updatedOrder = { ...updatedOrder, ...nextOrder };
                        }
                        // Transition to PARTIAL when chain size < grid size (partial fill).
                        // Real-time fill events set this via syncFromFillHistory, but
                        // downtime fills detected during open-orders sync must also update
                        // state so that checkWindowDust can identify dust orders.
                        updatedOrder.state = (chainSizeInt < currentSizeInt)
                            ? ORDER_STATES.PARTIAL
                            : gridOrder.state;
                        await mgr._applyOrderUpdate(updatedOrder, 'sync-pass1-partial', { skipAccounting: skipAccounting, fee: 0 });
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                        await mgr._applyOrderUpdate(spreadOrder, 'sync-pass1-filled', { skipAccounting: skipAccounting, fee: 0 });
                        // Push the filled order with its REAL side (chain order
                        // type), not the SPREAD placeholder: downstream fill
                        // processing (deriveTargetBoundary) derives boundary
                        // movement from fill.type, and a SPREAD type would
                        // silently drop the shift for this completed order.
                        filledOrders.push({ ...gridOrder, type: chainOrder.type });
                        updatedOrders.push(spreadOrder);
                    }
                }
            } else if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                // Don't virtualize orders placed by a successful COW commit.
                // The chain snapshot may lag behind confirmed transactions,
                // causing correctly-placed orders to appear missing. _committedOrderIds
                // is atomically rebuilt from every successful COW commit
                // (manager.ts:_commitWorkingGrid) and is always active for all sync
                // paths.
                // filled/virtualized orders are absent from the next commit's
                // finalMap, so their IDs drop out on the next atomic rebuild.
                //
                // SAFETY: _committedOrderIds is replaced atomically (reference swap)
                // by _commitWorkingGrid. The sync reads has(gridOrder.orderId) against the
                // current reference. If a concurrent COW commit replaces the set mid-sync,
                // the new set is a superset (only adds entries for newly committed orders).
                // An order in the superset was just committed, so it is genuinely on-chain
                // and should not be virtualized. An order removed from the old set was
                // filled/virtualized, which the sync will detect independently via the
                // chain snapshot. Superset behavior is safe for this guard.
                //
                // ESCAPE HATCH 1 — Ghost orders (PARTIAL + size=0): These preserve the
                // original orderId only to block duplicate CREATEs after a full fill
                // that the chain hasn't closed yet. The orderId is in _committedOrderIds
                // because the original order was COW-placed, but the slot is already a
                // known fill. Allow phantom detection to proceed so the ghost is cleaned
                // up on the next sync cycle after the chain cancel succeeds.
                //
                // ESCAPE HATCH 2 — Time-based: If the most recent COW commit is older
                // than SYNC_LOCK_TIMEOUT_MS, the committed-but-missing order is
                // presumed genuinely filled. The chain should have confirmed or
                // rejected the transaction within the sync timeout window (~7 blocks
                // at 3s each). Prevents permanent stall when a fill event was missed
                // (reconnect gap, lossy subscription) and the only detection path is
                // this open-orders sync.
                if (mgr._committedOrderIds?.has(gridOrder.orderId)) {
                    const commitAge = Date.now() - (mgr._committedOrderIdsBuiltAt || 0);
                    const isGhost = gridOrder.size <= 0 && gridOrder.state === ORDER_STATES.PARTIAL;
                    if (!isGhost && commitAge < TIMING.SYNC_LOCK_TIMEOUT_MS) {
                        continue;
                    }
                }
                const currentGridOrder = mgr.orders.get(gridOrder.id) || gridOrder;
                const hadOrderId = Boolean(currentGridOrder?.orderId);
                const spreadOrder = convertToSpreadPlaceholder(currentGridOrder);
                await mgr._applyOrderUpdate(spreadOrder, 'sync-cleanup-phantom', { skipAccounting: skipAccounting, fee: 0 });

                // Only genuine disappearances (had orderId) count as fills.
                if (hadOrderId) {
                    // A SPREAD slot can carry an on-chain order (spread-correction
                    // activation). Resolve the real side before pushing: the fill
                    // drives deriveTargetBoundary, which only shifts on BUY/SELL —
                    // a SPREAD-typed fill would silently drop the boundary crawl
                    // for this completed order. Same price-vs-startPrice convention
                    // as the funds check (manager.ts) since no chain order remains
                    // to resolve the side from.
                    let resolvedType = currentGridOrder.type;
                    if (resolvedType === ORDER_TYPES.SPREAD) {
                        resolvedType = resolveSpreadOrderSide(currentGridOrder.price, mgr.config.startPrice);
                    }
                    filledOrders.push({ ...currentGridOrder, type: resolvedType });
                }
            }
        }

        // ====================================================================
        // PASS 2: CHAIN → GRID - Match unmatched chain orders to grid
        // ====================================================================
        for (const [chainOrderId, chainOrder] of parsedChainOrders) {
            if (chainOrderIdsOnGrid.has(chainOrderId)) continue;

            // The grid allows at most one order per price level. If a placed
            // grid order already exists at the orphan's price (within tolerance),
            // this orphan is a stale duplicate — skip adoption so the reconcile
            // layer cancels it. Size is irrelevant; any duplicate violates the
            // invariant. Check BEFORE any adoption attempt, including the first
            // match (line 684), because a VIRTUAL slot at a nearby price can
            // otherwise silently adopt the orphan before the duplicate guard runs.
            const duplicatePriceOrder: any = Array.from(mgr.orders.values()).find((o: any) => {
                const co: any = chainOrder;
                return o.type === co.type &&
                    isOrderPlaced(o) &&
                    co != null &&
                    Math.abs(o.price - co.price) <= (calculatePriceTolerance as any)(
                        Math.min(o.price, co.price),
                        Math.max(o.size, co.size),
                        o.type, mgr.assets
                    );
            }
            );
            if (duplicatePriceOrder) {
                unmatchedChainOrders.push({
                    chainOrderId,
                    type: chainOrder.type,
                    price: chainOrder.price,
                    size: chainOrder.size,
                    raw: rawChainOrders.get(chainOrderId),
                    reason: 'duplicate-price-level',
                    candidateSlotId: duplicatePriceOrder.id,
                });
                const { level, suffix } = duplicateOrphanLogInfo(chainOrderId);
                mgr.logger?.log?.(
                    `[SYNC] Orphaned chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}, ` +
                    `size=${chainOrder.size}) — NOT adopted: duplicates price level of active ` +
                    `${duplicatePriceOrder.id} (${duplicatePriceOrder.orderId} at ${duplicatePriceOrder.price})${suffix}`,
                    level
                );
                // Gap 2: Queue duplicate chain order for cancellation via the correction
                // mechanism (called from _performSyncFromOpenOrders). Duplicate price levels
                // block new placements. Cancelling proactively unblocks CREATEs.
                queueCorrection({
                    gridOrder: duplicatePriceOrder,
                    chainOrderId,
                    expectedPrice: chainOrder.price,
                    size: chainOrder.size,
                    type: chainOrder.type,
                    isSurplus: true,
                    cancelOnly: true,
                });
                continue;
            }

            const match = findMatchingGridOrderByOpenOrder(
                { orderId: chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size },
                {
                    orders: mgr.orders,
                    assets: mgr.assets,
                    calcToleranceFn: (p: number, s: number, t: any) => calculatePriceTolerance(p, s, t, mgr.assets),
                    logger: mgr.logger,
                    allowSmallerChainSize: true,
                    requireAvailableSlot: true,
                    excludeGridOrderIds: matchedGridOrderIds
                }
            );

            if (match && !matchedGridOrderIds.has(match.id)) {
                let bestMatch = { ...match };
                const wasVirtual = match.state === ORDER_STATES.VIRTUAL;
                const wasPartial = match.state === ORDER_STATES.PARTIAL;
                bestMatch.orderId = chainOrderId;
                bestMatch.state = wasVirtual ? ORDER_STATES.ACTIVE : match.state;
                const bestMatchRaw = rawChainOrders.get(chainOrderId);
                bestMatch.rawOnChain = bestMatchRaw
                    ? { ...bestMatchRaw, fetchedAt: Date.now() }
                    : bestMatchRaw;
                matchedGridOrderIds.add(bestMatch.id);

                // Reconstruct btsFeeState from raw chain order's deferred_fee.
                // After a grid reset, in-memory orders lose btsFeeState. The chain's
                // limit_order_object stores the original deferred_fee (or 0 after a
                // partial fill). Restoring it ensures correct fee lifecycle accounting
                // (cancel refunds, fill maker discounts) on the reconciled order.
                // Only set btsFeeState when deferred_fee > 0 — _resolveBtsFeeLifecycle
                // deletes btsFeeState when nextDeferred is 0, so setting it to 0 here
                // would be an unnecessary set-then-delete cycle.
                if (bestMatch.rawOnChain) {
                    const rawDeferredFee = toFiniteNumber(bestMatch.rawOnChain.deferred_fee, null);
                    if (rawDeferredFee !== null && rawDeferredFee > 0) {
                        bestMatch.btsFeeState = { deferredFee: blockchainToFloat(rawDeferredFee, BTS_PRECISION) };
                    } else if (wasVirtual && rawDeferredFee !== null && rawDeferredFee <= 0 && bestMatch.rawOnChain.for_sale > 0) {
                        // Core zeros deferred_fee on every fill (fill_limit_order db_market.cpp:1895).
                        // If deferred_fee is 0 while for_sale > 0, the order was partially filled.
                        bestMatch.state = ORDER_STATES.PARTIAL;
                    }
                }

                const precision = (bestMatch.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                const targetInt = floatToBlockchainInt(match.size, precision);
                const chainInt = floatToBlockchainInt(chainOrder.size, precision);
                if (targetInt !== chainInt) {
                    const updated = await applyChainSizeToGridOrder(mgr, bestMatch, chainOrder.size);
                    if (updated) bestMatch = { ...bestMatch, ...updated };

                    if (chainInt > 0) {
                        if (wasVirtual) {
                            // Only override to ACTIVE if partial-fill check above didn't already
                            // set PARTIAL via deferred_fee === 0. Skip override to preserve signal.
                            if (bestMatch.state !== ORDER_STATES.PARTIAL) {
                                bestMatch.state = ORDER_STATES.ACTIVE;
                            }
                        } else if (chainInt < targetInt) {
                            bestMatch.state = ORDER_STATES.PARTIAL;
                        } else if (wasPartial) {
                            bestMatch.state = ORDER_STATES.PARTIAL;
                        } else {
                            bestMatch.state = ORDER_STATES.ACTIVE;
                        }
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(bestMatch);
                        filledOrders.push({ ...bestMatch });
                        await mgr._applyOrderUpdate(spreadOrder, 'sync-pass2-filled', { skipAccounting: skipAccounting, fee: 0 });
                        updatedOrders.push(spreadOrder);
                        chainOrderIdsOnGrid.add(chainOrderId);
                        continue;
                    }
                } else if (wasPartial) {
                    bestMatch.state = ORDER_STATES.PARTIAL;
                }
                await mgr._applyOrderUpdate(bestMatch, 'sync-pass2-orphan', { skipAccounting: skipAccounting, fee: 0 });
                updatedOrders.push(bestMatch);
                chainOrderIdsOnGrid.add(chainOrderId);
            } else if (match) {
                mgr.logger?.log?.(
                    `Warning: Orphan chain order ${chainOrderId} matched grid order ${match.id}, ` +
                    `but grid order was already matched to another chain order. Queuing orphan for cancellation.`,
                    'warn'
                );
                queueCorrection({
                    gridOrder: match,
                    chainOrderId,
                    expectedPrice: chainOrder.price,
                    size: chainOrder.size,
                    type: chainOrder.type,
                    isSurplus: true,
                    cancelOnly: true,
                });
                // Also push to unmatchedChainOrders so the existing auto-cancel
                // path at dexbot_class.ts:4262 can pick it up if the correction
                // mechanism does not fire first.
                unmatchedChainOrders.push({
                    chainOrderId,
                    type: chainOrder.type,
                    price: chainOrder.price,
                    size: chainOrder.size,
                    raw: rawChainOrders.get(chainOrderId),
                    reason: 'already-matched-slot',
                    candidateSlotId: match.id,
                });
            } else {
                // No grid slot matched by type+price+size in the first pass.
                // Fallback: adopt into the nearest VIRTUAL/spread slot so the
                // orphan becomes visible to checkWindowDust for dust auto-cancel.
                // The duplicate-price-level guard already ran above so it is not
                // repeated here.

                const adoptedSlot = findMatchingGridOrderByOpenOrder(
                    { orderId: chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size },
                    {
                        orders: mgr.orders,
                        assets: mgr.assets,
                        calcToleranceFn: (p: number, s: number, t: any) => calculatePriceTolerance(p, s, t, mgr.assets),
                        allowSpreadType: true,
                        skipSizeMatch: true,
                        requireAvailableSlot: true,
                        excludeGridOrderIds: matchedGridOrderIds
                    }
                );

                if (adoptedSlot && !matchedGridOrderIds.has(adoptedSlot.id) && !adoptedSlot.orderId) {
                    const precision = (chainOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                    const chainInt = floatToBlockchainInt(chainOrder.size, precision);
                    const adoptedRaw = rawChainOrders.get(chainOrderId);
                    const adoptedState = chainInt > 0 ? ORDER_STATES.PARTIAL : ORDER_STATES.VIRTUAL;
                    const adoptedBtsFeeState = (adoptedRaw) ? (() => {
                        const rawFee = toFiniteNumber(adoptedRaw.deferred_fee, null);
                        return rawFee !== null && rawFee > 0 ? { deferredFee: blockchainToFloat(rawFee, BTS_PRECISION) } : undefined;
                    })() : undefined;
                    const adoptedOrder = {
                        ...adoptedSlot,
                        orderId: chainOrderId,
                        type: chainOrder.type,
                        state: adoptedState,
                        size: chainOrder.size,
                        price: chainOrder.price,
                        rawOnChain: adoptedRaw
                            ? { ...adoptedRaw, fetchedAt: Date.now() }
                            : adoptedRaw,
                        ...(adoptedBtsFeeState ? { btsFeeState: adoptedBtsFeeState } : {}),
                    };
                    matchedGridOrderIds.add(adoptedSlot.id);
                    chainOrderIdsOnGrid.add(chainOrderId);
                    await mgr._applyOrderUpdate(adoptedOrder, 'sync-pass2-adopt-orphan', { skipAccounting: skipAccounting, fee: 0 });
                    updatedOrders.push(adoptedOrder);
                    mgr.logger?.log?.(
                        `[SYNC] Orphaned chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}, ` +
                        `size=${chainOrder.size}) adopted into slot ${adoptedSlot.id} (was ${adoptedSlot.type})`,
                        'warn'
                    );
                } else {
                    const precision = (chainOrder.type === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                    const candidateDiagnostics = describeNearestAdoptionCandidates(
                        mgr,
                        chainOrder,
                        precision,
                        (p: number, s: number, t: any) => calculatePriceTolerance(p, s, t, mgr.assets),
                        matchedGridOrderIds
                    );
                    const driftTag = computeOutOfToleranceDriftTag(
                        mgr,
                        chainOrder,
                        (p: number, s: number, t: any) => calculatePriceTolerance(p, s, t, mgr.assets)
                    );
                    const unmatchedEntry: Record<string, any> = {
                        chainOrderId,
                        type: chainOrder.type,
                        price: chainOrder.price,
                        size: chainOrder.size,
                        raw: rawChainOrders.get(chainOrderId),
                        candidateDiagnostics
                    };
                    if (driftTag) {
                        unmatchedEntry.reason = 'price-drift-orphan';
                        unmatchedEntry.candidateSlotId = driftTag.candidateSlotId;
                        unmatchedEntry.candidateSlotPrice = driftTag.candidateSlotPrice;
                        unmatchedEntry.priceDiff = driftTag.priceDiff;
                        unmatchedEntry.tolerance = driftTag.tolerance;
                    }
                    unmatchedChainOrders.push(unmatchedEntry);
                    mgr.logger?.log?.(
                        `[SYNC] Unmatched chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}, ` +
                        `size=${chainOrder.size}): no adoptable slot found` +
                        (driftTag ? ` (price-drift-orphan slot=${driftTag.candidateSlotId}@${driftTag.candidateSlotPrice} diff=${driftTag.priceDiff} tol=${driftTag.tolerance})` : '') +
                        `. Nearest candidates: ${candidateDiagnostics}`,
                        'warn'
                    );
                }
            }
        }

        return { filledOrders, updatedOrders, ordersNeedingCorrection, unmatchedChainOrders };
    }

    // ------------------------------------------------------------------
    // Shared fill-processing helpers (used by syncFromFillHistory and
    // syncFromFillHistoryBatch)
    // ------------------------------------------------------------------

    _findMatchingGridOrder(mgr: any, orderId: any) {
        for (const gridOrder of mgr.orders.values()) {
            if (gridOrder.orderId === orderId && (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL)) {
                return gridOrder;
            }
        }
        return null;
    }

    _computeFillContext(mgr: any, matchedGridOrder: any, paysAssetId: any, paysAmountRaw: any) {
        // A SPREAD slot can carry an on-chain order (e.g. spread-correction
        // activation). Resolve the real side from the fill's pays asset so the
        // transition result is BUY/SELL — never SPREAD with an on-chain state,
        // which validateOrder rejects as fatal ILLEGAL_SPREAD_STATE. When the
        // pays asset matches neither side (malformed fill event), fall back to
        // the price-vs-startPrice convention so the type can never leak SPREAD
        // into a fill result (which would drop the boundary shift downstream).
        let orderType = matchedGridOrder.type;
        if (orderType === ORDER_TYPES.SPREAD) {
            if (paysAssetId === mgr.assets.assetB.id) orderType = ORDER_TYPES.BUY;
            else if (paysAssetId === mgr.assets.assetA.id) orderType = ORDER_TYPES.SELL;
            else orderType = resolveSpreadOrderSide(matchedGridOrder.price, mgr.config.startPrice);
        }
        const currentSize = toFiniteNumber(matchedGridOrder.size);
        const precision = (orderType === ORDER_TYPES.SELL) ? mgr.assets.assetA.precision : mgr.assets.assetB.precision;

        let filledAmount = 0;
        if (orderType === ORDER_TYPES.SELL) {
            if (paysAssetId === mgr.assets.assetA.id) filledAmount = blockchainToFloat(paysAmountRaw, precision);
        } else {
            if (paysAssetId === mgr.assets.assetB.id) filledAmount = blockchainToFloat(paysAmountRaw, precision);
        }

        const currentSizeIntFromGrid = floatToBlockchainInt(currentSize, precision);
        const rawForSale = matchedGridOrder?.rawOnChain?.for_sale;
        const rawForSaleInt = rawForSale !== undefined && rawForSale !== null ? toFiniteNumber(rawForSale) : NaN;
        const driftSignal = Number.isFinite(rawForSaleInt) && Math.round(rawForSaleInt) < currentSizeIntFromGrid;

        return { orderType, currentSize, precision, filledAmount, currentSizeIntFromGrid, rawForSaleInt, driftSignal };
    }

    async _computeFillTransitionResult(mgr: any, params: any) {
        const { matchedGridOrder, orderType, precision, filledAmount, filledAmountInt, currentSizeIntFromGrid, chainRefetched, chainConfirmsEmpty, effectiveRawForSale, blockNum, historyId, isMaker } = params;

        let resolvedChainConfirmsEmpty = chainConfirmsEmpty;
        if (chainRefetched && Number.isFinite(effectiveRawForSale) && Math.round(effectiveRawForSale) <= 0) {
            resolvedChainConfirmsEmpty = true;
        }

        const currentSizeInt = Number.isFinite(effectiveRawForSale)
            ? Math.max(0, Math.round(effectiveRawForSale))
            : currentSizeIntFromGrid;
        const newSizeInt = Math.max(0, currentSizeInt - filledAmountInt);
        const newSize = blockchainToFloat(newSizeInt, precision);

        if (Number.isFinite(effectiveRawForSale) && currentSizeInt !== currentSizeIntFromGrid) {
            mgr.logger.log(
                `[SYNC] Using rawOnChain.for_sale baseline for ${matchedGridOrder.orderId}: raw=${currentSizeInt}, grid=${currentSizeIntFromGrid}` +
                (chainRefetched ? ' (refetched)' : ''),
                'debug'
            );
        }

        const gridAlsoEmpty = currentSizeIntFromGrid <= 0;
        let isEffectivelyFull = resolvedChainConfirmsEmpty || gridAlsoEmpty;

        // If the chain retains a real residual order after this fill, the bot
        // must cancel it explicitly. The chain only auto-culls ("culls small")
        // an order when its residual value in the QUOTE asset truncates to 0
        // (amount_to_receive() == 0, i.e. for_sale × price == 0 in quote units,
        // see maybe_cull_small_order in bitshares-core). A residual of >= 1 base
        // unit whose quote value is non-zero is NOT culled — it would be
        // orphaned on-chain once the slot is converted to a SPREAD placeholder.
        // Verified fills stay authoritative (rotation proceeds), but the leftover
        // dust is handled by an explicit cancel rather than trusting the chain to
        // sweep it.
        let residualCancel: { orderId: string; id: string } | null = null;

        if (!isEffectivelyFull) {
            const otherPrecision = (orderType === ORDER_TYPES.SELL) ? mgr.assets.assetB.precision : mgr.assets.assetA.precision;
            const otherSidePrice = matchedGridOrder.price;
            const otherSize = (orderType === ORDER_TYPES.SELL) ? newSize * otherSidePrice : newSize / otherSidePrice;

            if (floatToBlockchainInt(otherSize, otherPrecision) <= 0) {
                // A fill event is authoritative: the order WAS on-chain and this
                // fill consumed the tradeable remainder. A fill is a fill — we do
                // not need to preserve the orderId as a "ghost" PARTIAL to block
                // a duplicate CREATE. Treating every sub-dust other-side fill as
                // a real full fill lets rotation immediately plan the opposite-side
                // replacement, preserving the grid invariant (each filled side
                // produces a new order on the other side). This replaces the legacy
                // ghost mechanism whose preserved orderIds caused instantly-filled
                // replacement orders to deadlock the COW create pipeline.
                //
                // However, the chain does NOT reliably cull the leftover residual:
                // maybe_cull_small_order only removes an order whose QUOTE-side
                // value rounds to zero. Verify the order against the chain; if it
                // still exists with for_sale > 0, schedule an explicit cancel so
                // the dust is not stranded on the book (previously it could remain
                // forever because the slot was virtualized and nothing referenced
                // the orderId anymore).
                isEffectivelyFull = true;
                // Reuse a drift-refetch result when present: it is a live
                // post-fill read, so for_sale > 0 already proves a real residual
                // remains. Avoids a second RPC for the same order in the exact
                // scenario that triggered this branch.
                let residualForSale: number | null = null;
                if (chainRefetched && Number.isFinite(effectiveRawForSale)) {
                    residualForSale = Math.round(effectiveRawForSale);
                } else {
                    try {
                        const residualOrder = await chainOrders.readSingleOrder(matchedGridOrder.orderId, 3000);
                        residualForSale = residualOrder ? toFiniteNumber(residualOrder.for_sale, null) : null;
                    } catch (residualErr: any) {
                        // The read is best-effort: if it fails, fall back to the old
                        // behavior (rely on reconciliation) rather than blocking the
                        // authoritative fill transition.
                        mgr.logger.log(
                            `[SYNC] Order ${matchedGridOrder.orderId} (slot ${matchedGridOrder.id}) other-side (${otherSize}) rounds to 0. ` +
                            `Fill is authoritative: treating as full fill for rotation. Residual verification read failed (${getErrorMessage(residualErr)}); ` +
                            `relying on reconciliation for any residual.`,
                            'warn'
                        );
                    }
                }
                if (Number.isFinite(residualForSale) && Math.round(residualForSale as number) > 0) {
                    residualCancel = { orderId: matchedGridOrder.orderId, id: matchedGridOrder.id };
                    mgr.logger.log(
                        `[SYNC] Order ${matchedGridOrder.orderId} (slot ${matchedGridOrder.id}) other-side (${otherSize}) rounds to 0. ` +
                        `Fill is authoritative: treating as full fill for rotation, but chain still holds residual for_sale=${residualForSale} ` +
                        `(not culled); scheduling explicit cancel.`,
                        'warn'
                    );
                } else {
                    mgr.logger.log(
                        `[SYNC] Order ${matchedGridOrder.orderId} (slot ${matchedGridOrder.id}) other-side (${otherSize}) rounds to 0. ` +
                        `Fill is authoritative: treating as full fill for rotation; chain confirms residual gone (for_sale=0), no cancel needed.`,
                        'info'
                    );
                }
            }
        }

        let fullUpdate;
        let partialUpdate;
        let filledOrderResult;

        if (isEffectivelyFull) {
            fullUpdate = convertToSpreadPlaceholder(matchedGridOrder);
            filledOrderResult = {
                ...matchedGridOrder,
                type: orderType,
                blockNum,
                historyId,
                isMaker
            };
        } else {
            filledOrderResult = {
                ...matchedGridOrder,
                type: orderType,
                size: filledAmount,
                isPartial: true,
                blockNum,
                historyId,
                isMaker
            };
            const { btsFeeState, ...matchedWithoutDeferredFee } = matchedGridOrder;
            let updatedOrder = { ...matchedWithoutDeferredFee, type: orderType, state: ORDER_STATES.PARTIAL };

            if (updatedOrder.rawOnChain && updatedOrder.rawOnChain.for_sale !== undefined) {
                const baselineForSale = (chainRefetched && Number.isFinite(effectiveRawForSale))
                    ? effectiveRawForSale
                    : toFiniteNumber(updatedOrder.rawOnChain.for_sale);
                const nextForSaleInt = Math.max(0, Math.round(baselineForSale) - filledAmountInt);
                updatedOrder.rawOnChain = {
                    ...updatedOrder.rawOnChain,
                    for_sale: String(nextForSaleInt),
                    fetchedAt: Date.now()
                };
            }

            const nextOrder = await applyChainSizeToGridOrder(mgr, updatedOrder, newSize);
            if (nextOrder) {
                updatedOrder = { ...updatedOrder, ...nextOrder };
            }
            partialUpdate = updatedOrder;
        }

        return {
            isFull: isEffectivelyFull,
            filledOrder: filledOrderResult,
            fullUpdate,
            partialUpdate,
            newSize,
            residualCancel
        };
    }

    /**
     * Process one incremental fill-history event.
     * @param {Object} fill - Fill history event object
     * @param {Object} [options] - Persistence mode options
     * @returns {Promise<any>}
     */
    async syncFromFillHistory(fill: any, options: Record<string, any> = {}) {
        const mgr = this.manager;
        const persistenceMode = resolveProcessedFillPersistenceMode(options);
        if (!fill || !fill.op || !fill.op[1]) return { filledOrders: [], updatedOrders: [], partialFill: false };

        const fillOp = fill.op[1];
        const blockNum = fill.block_num;
        const historyId = fill.id;
        const orderId = fillOp.order_id;
        if (fillOp.is_maker === undefined) {
            mgr.logger.log(`[SYNC] is_maker flag missing from fill data for order ${orderId}; defaulting to maker`, 'warn');
        }
        const isMaker = fillOp.is_maker !== false;
        const fillKey = buildFillKey({ orderId, blockNum, historyId });

        const paysAmountRaw = toFiniteNumber(fillOp.pays?.amount);
        const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;
        const receivesAmountRaw = toFiniteNumber(fillOp.receives?.amount);
        const receivesAssetId = fillOp.receives ? fillOp.receives.asset_id : null;

        mgr.logger.log(`[SYNC] Processing fill ${historyId} at block ${blockNum} for order ${orderId} (maker=${isMaker}). Pays=${paysAmountRaw}@${paysAssetId}, Receives=${receivesAmountRaw}@${receivesAssetId}`, 'debug');

        if (!fillKey) {
            mgr.logger.log(`[SYNC] Missing replay-safe fill key for order ${orderId} block ${blockNum}; deferring to open-orders sync`, 'warn');
            return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: true };
        }

        // Raise the fill-batch in-flight guard BEFORE the accountTotals refresh
        // (mirrors syncFromFillHistoryBatch): the refresh returns post-fill
        // balances while the grid still holds the filled order as committed, so
        // a fund-invariant check in this window would fire a spurious CRITICAL.
        // The guard is lowered before the final consolidated recalc so the
        // settled (re-anchored) state is still verified.
        mgr._fillBatchInFlight = (mgr._fillBatchInFlight ?? 0) + 1;
        let fillGuardLowered = false;

        try {
            const totalsGate = await mgr.refreshAccountTotalsIfStale();
            if (!totalsGate.ok) {
                mgr.logger.log(
                    `[SYNC] Deferring fill ${historyId}: accountTotals refresh failed (stale snapshot). Will be re-processed on the next cycle.`,
                    'warn'
                );
                return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: false, deferred: true };
            }

            const orderIdsToLock = new Set([orderId]);
            mgr.lockOrders([...orderIdsToLock]);

            try {
                mgr.pauseFundRecalc();
                try {
                    const appliedAccounting = await mgr.accountant.processFillAccounting(fillOp, fillKey, { persistenceMode });
                    if (!appliedAccounting) {
                        mgr.logger.log(`[SYNC] Replay detected for fill ${fillKey}; skipping duplicate order mutation`, 'debug');
                        return { filledOrders: [], updatedOrders: [], partialFill: false };
                    }

                    const assetAPrecision = mgr.assets?.assetA?.precision;
                    const assetBPrecision = mgr.assets?.assetB?.precision;
                    if (assetAPrecision === undefined || assetBPrecision === undefined) {
                        mgr.logger?.log?.('Error: manager.assets precision missing in syncFromFillHistory', 'error');
                        return { filledOrders: [], updatedOrders: [], partialFill: false };
                    }

                    const matchedGridOrder = this._findMatchingGridOrder(mgr, orderId);
                    if (!matchedGridOrder) {
                        mgr.logger.log(`[SYNC] Fill for order ${orderId} ignored: order not found in active grid.`, 'debug');
                        return { filledOrders: [], updatedOrders: [], partialFill: false };
                    }

                    const ctx = this._computeFillContext(mgr, matchedGridOrder, paysAssetId, paysAmountRaw);
                    mgr.logger.log(`[SYNC] Order ${orderId} (${ctx.orderType}) currentSize=${ctx.currentSize}, filledAmount=${ctx.filledAmount}`, 'debug');

                    let effectiveRawForSale = ctx.rawForSaleInt;
                    let chainConfirmsEmpty = false;
                    let chainRefetched = false;

                    if (ctx.driftSignal) {
                        try {
                            const fresh = await chainOrders.readSingleOrder(orderId, 3000);
                            if (fresh) {
                                const freshForSale = toFiniteNumber(fresh.for_sale, null);
                                if (freshForSale !== null && Number.isFinite(freshForSale)) {
                                    effectiveRawForSale = freshForSale;
                                    chainRefetched = true;
                                    mgr.logger.log(
                                        `[SYNC] Drift detected for ${orderId} (cached=${ctx.rawForSaleInt} < grid=${ctx.currentSizeIntFromGrid}); ` +
                                        `refetched for_sale=${freshForSale}`,
                                        'warn'
                                    );
                                }
                            } else {
                                chainConfirmsEmpty = true;
                                mgr.logger.log(`[SYNC] Drift refetch for ${orderId} returned null; chain confirms empty`, 'info');
                            }
                        } catch (refetchErr: any) {
                            mgr.logger.log(`[SYNC] Drift refetch for ${orderId} failed; falling back to cache: ${refetchErr?.message || refetchErr}`, 'warn');
                        }
                    }

                    const result = await this._computeFillTransitionResult(mgr, {
                        matchedGridOrder,
                        orderType: ctx.orderType,
                        precision: ctx.precision,
                        filledAmount: ctx.filledAmount,
                        filledAmountInt: floatToBlockchainInt(ctx.filledAmount, ctx.precision),
                        currentSizeIntFromGrid: ctx.currentSizeIntFromGrid,
                        rawForSaleInt: ctx.rawForSaleInt,
                        chainRefetched,
                        chainConfirmsEmpty,
                        effectiveRawForSale,
                        blockNum,
                        historyId,
                        isMaker
                    });

                    const filledOrders: any[] = [];
                    const updatedOrders: any[] = [];

                if (result.isFull) {
                    mgr.logger.log(`[SYNC] Full fill for order ${orderId} (slot ${matchedGridOrder.id}).`, 'info');
                    const fullOk = await mgr._updateOrder(result.fullUpdate, 'handle-fill-full', { skipAccounting: false, fee: 0 });
                    if (fullOk === false) {
                        mgr.logger.log(`[SYNC] Failed to convert filled order ${orderId} to spread placeholder; marking totals stale for next sync cycle`, 'warn');
                        mgr.accountTotalsStale = true;
                    }
                    filledOrders.push(result.filledOrder);
                } else {
                    mgr.logger.log(`[SYNC] Partial fill for order ${orderId} (slot ${matchedGridOrder.id}): newSize=${result.newSize}`, 'info');
                    const partialOk = await mgr._updateOrder(result.partialUpdate, 'handle-fill-partial', { skipAccounting: false, fee: 0 });
                    if (partialOk === false) {
                        mgr.logger.log(`[SYNC] Failed to update partially filled order ${orderId}; marking totals stale for next sync cycle`, 'warn');
                        mgr.accountTotalsStale = true;
                    }
                    updatedOrders.push(result.partialUpdate);
                    filledOrders.push(result.filledOrder);
                }

                // Re-anchor accountTotals to authoritative post-fill chain truth
                // after the fill's optimistic accounting + grid update (see
                // syncFromFillHistoryBatch for rationale).
                await mgr.reanchorAccountTotals('fill-sync');

                return {
                    filledOrders,
                    updatedOrders,
                    partialFill: result.isFull ? false : true,
                    residualCancels: result.residualCancel ? [result.residualCancel] : []
                };
                } finally {
                    // Lower the guard before the final consolidated recalc so the
                    // settled (re-anchored) state is still verified.
                    fillGuardLowered = true;
                    mgr._fillBatchInFlight = Math.max(0, (mgr._fillBatchInFlight ?? 0) - 1);
                    await mgr.resumeFundRecalc();
                }
            } finally {
                mgr.unlockOrders([...orderIdsToLock]);
            }
        } finally {
            // Safety net: ensure the guard never leaks across cycles on early
            // returns (deferral) or exceptions in the refresh/lock region.
            // Skipped when the inner finally already lowered it for this
            // invocation so concurrent batches cannot zero each other's count.
            if (!fillGuardLowered && (mgr._fillBatchInFlight ?? 0) > 0) mgr._fillBatchInFlight--;
        }
    }

    /**
     * Process multiple fill-history events in a batch, acquiring _gridLock once.
     *
     * Locking: all order IDs locked once up-front; fund recalc paused once.
     *
     * @param {Array} fills - Array of fill history event objects (same block group)
     * @param {Object} [options] - Persistence mode options
     * @returns {Promise<any>}
     */
    async syncFromFillHistoryBatch(fills: any[], options: Record<string, any> = {}) {
        const mgr = this.manager;
        const persistenceMode = resolveProcessedFillPersistenceMode(options);
        if (!Array.isArray(fills) || fills.length === 0) {
            return { filledOrders: [], updatedOrders: [], partialFill: false };
        }

        // Phase 1: Extract & validate fill data
        const fillEntries: any[] = [];
        let anyRequiresSync = false;

        for (const fill of fills) {
            if (!fill || !fill.op || !fill.op[1]) continue;
            const fillOp = fill.op[1];
            const blockNum = fill.block_num;
            const historyId = fill.id;
            const orderId = fillOp.order_id;
            if (fillOp.is_maker === undefined) {
                mgr.logger.log(`[SYNC] is_maker flag missing from fill data for order ${orderId}; defaulting to maker`, 'warn');
            }
            const isMaker = fillOp.is_maker !== false;
            const fillKey = buildFillKey({ orderId, blockNum, historyId });

            if (!fillKey) {
                mgr.logger.log(`[SYNC] Missing replay-safe fill key for order ${orderId} block ${blockNum}; deferring to open-orders sync`, 'warn');
                anyRequiresSync = true;
                continue;
            }

            const paysAmountRaw = toFiniteNumber(fillOp.pays?.amount);
            const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;
            const receivesAmountRaw = toFiniteNumber(fillOp.receives?.amount);
            const receivesAssetId = fillOp.receives ? fillOp.receives.asset_id : null;

            mgr.logger.log(`[SYNC] Processing fill ${historyId} at block ${blockNum} for order ${orderId} (maker=${isMaker}). Pays=${paysAmountRaw}@${paysAssetId}, Receives=${receivesAmountRaw}@${receivesAssetId}`, 'debug');

            fillEntries.push({
                fill, fillOp, blockNum, historyId, orderId, fillKey,
                isMaker, paysAmountRaw, paysAssetId, receivesAmountRaw, receivesAssetId
            });
        }

        if (fillEntries.length === 0) {
            return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: anyRequiresSync };
        }

        // Phase 2: Lock all unique order IDs once
        const allOrderIds = [...new Set(fillEntries.map(e => e.orderId))];

        // Raise the fill-batch in-flight guard BEFORE the accountTotals refresh.
        // The refresh fetches post-fill balances, but the grid still holds the
        // filled orders as committed until the batch's grid mutation (Phase 7),
        // so any fund-invariant check in this window would fire a spurious
        // CRITICAL with diff == the fills' size. The guard is lowered right
        // before the final consolidated recalc so the settled state is still
        // verified.
        mgr._fillBatchInFlight = (mgr._fillBatchInFlight ?? 0) + 1;
        let fillGuardLowered = false;

        try {
            const totalsGate = await mgr.refreshAccountTotalsIfStale();
            if (!totalsGate.ok) {
                mgr.logger.log(
                    '[SYNC] Deferring fill batch: accountTotals refresh failed (stale snapshot). Fills will be re-processed on the next cycle.',
                    'warn'
                );
                return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: false, deferred: true };
            }

            mgr.lockOrders(allOrderIds);

            try {
                mgr.pauseFundRecalc();
                try {
                    // Phase 3: Process accounting for each fill
                    const validEntries: any[] = [];
                    for (const entry of fillEntries) {
                        try {
                            const appliedAccounting = await mgr.accountant.processFillAccounting(
                                entry.fillOp, entry.fillKey, { persistenceMode }
                            );
                            if (!appliedAccounting) {
                                mgr.logger.log(`[SYNC] Replay detected for fill ${entry.fillKey}; skipping duplicate order mutation`, 'debug');
                                continue;
                            }
                            validEntries.push(entry);
                        } catch (acctErr: any) {
                            mgr.logger.log(`[SYNC] Accounting error for fill ${entry.fillKey}: ${getErrorMessage(acctErr)}`, 'error');
                            continue;
                        }
                    }

                    if (validEntries.length === 0) {
                        return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: anyRequiresSync };
                    }

                    // Phase 4: Build per-fill context + identify drift candidates
                    const entryContexts: any[] = [];
                    const driftOrderIds = new Set<string>();

                    const assetAPrecision = mgr.assets?.assetA?.precision;
                    const assetBPrecision = mgr.assets?.assetB?.precision;
                    if (assetAPrecision === undefined || assetBPrecision === undefined) {
                        mgr.logger?.log?.('Error: manager.assets precision missing in syncFromFillHistoryBatch', 'error');
                        return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: anyRequiresSync };
                    }

                    for (const entry of validEntries) {
                        const { orderId, paysAmountRaw, paysAssetId } = entry;

                        const matchedGridOrder = this._findMatchingGridOrder(mgr, orderId);
                        if (!matchedGridOrder) {
                            mgr.logger.log(`[SYNC] Fill for order ${orderId} ignored: order not found in active grid.`, 'debug');
                            anyRequiresSync = true;
                            continue;
                        }

                        const ctx = this._computeFillContext(mgr, matchedGridOrder, paysAssetId, paysAmountRaw);
                        mgr.logger.log(`[SYNC] Order ${orderId} (${ctx.orderType}) currentSize=${ctx.currentSize}, filledAmount=${ctx.filledAmount}`, 'debug');

                        if (ctx.driftSignal) {
                            driftOrderIds.add(orderId);
                        }

                        entryContexts.push({
                            entry, matchedGridOrder,
                            orderType: ctx.orderType,
                            precision: ctx.precision,
                            filledAmount: ctx.filledAmount,
                            filledAmountInt: floatToBlockchainInt(ctx.filledAmount, ctx.precision),
                            currentSizeIntFromGrid: ctx.currentSizeIntFromGrid,
                            rawForSaleInt: ctx.rawForSaleInt
                        });
                    }

                    // Phase 5: Batch drift refetch — one get_objects call for all order IDs
                    const refetchMap = new Map<string, { chainConfirmsEmpty: boolean; chainRefetched: boolean; effectiveRawForSale: number | null }>();

                    if (driftOrderIds.size > 0) {
                        try {
                            const batchResults = await chainOrders.batchReadOrders([...driftOrderIds], 3000);
                            for (const [orderId, freshOrder] of batchResults) {
                                if (freshOrder) {
                                    const freshForSale = toFiniteNumber(freshOrder.for_sale, null);
                                    if (freshForSale !== null && Number.isFinite(freshForSale)) {
                                        refetchMap.set(orderId, {
                                            chainConfirmsEmpty: Math.round(freshForSale) <= 0,
                                            chainRefetched: true,
                                            effectiveRawForSale: freshForSale
                                        });
                                    } else {
                                        refetchMap.set(orderId, {
                                            chainConfirmsEmpty: false,
                                            chainRefetched: true,
                                            effectiveRawForSale: null
                                        });
                                    }
                                } else {
                                    refetchMap.set(orderId, {
                                        chainConfirmsEmpty: true,
                                        chainRefetched: true,
                                        effectiveRawForSale: null
                                    });
                                }
                            }

                            for (const [orderId, { chainRefetched, chainConfirmsEmpty, effectiveRawForSale }] of refetchMap) {
                                if (chainRefetched && effectiveRawForSale != null) {
                                    mgr.logger.log(`[SYNC] Drift detected for ${orderId}; batch-refetched for_sale=${effectiveRawForSale}`, 'warn');
                                } else if (chainConfirmsEmpty) {
                                    mgr.logger.log(`[SYNC] Drift refetch for ${orderId} returned null; chain confirms empty`, 'info');
                                }
                            }
                        } catch (refetchErr: any) {
                            mgr.logger.log(`[SYNC] Batch drift refetch failed for ${driftOrderIds.size} orders; falling back to cache: ${refetchErr?.message || refetchErr}`, 'warn');
                        }
                    }

                    // Phase 6: Compute state transitions and collect grid updates.
                    // Multiple fills for the SAME order inside one batch are
                    // aggregated into a single cumulative transition. Each fill is
                    // still accounted individually (Phase 3), but the grid mutation
                    // must reflect the COMBINED consumption. Without aggregation every
                    // fill recomputes newSize from the same stale pre-batch baseline
                    // and the last update wins (`applyGridUpdateBatch` is last-wins
                    // per slot), leaving a phantom residual equal to the earlier
                    // fills' sum — exactly the fund-invariant CRITICAL seen in the
                    // XRP-BTS log whenever a batch contained 2+ fills of one order.
                    const gridUpdates: any[] = [];
                    const filledOrders: any[] = [];
                    const updatedOrders: any[] = [];
                    const residualCancels: any[] = [];
                    let anyPartialFill = false;

                    const fillContextsBySlot = new Map<string, any[]>();
                    for (const ctx of entryContexts) {
                        const slotId = ctx.matchedGridOrder.id;
                        const group = fillContextsBySlot.get(slotId);
                        if (group) group.push(ctx);
                        else fillContextsBySlot.set(slotId, [ctx]);
                    }

                    for (const group of fillContextsBySlot.values()) {
                        const lastCtx = group[group.length - 1];
                        const { matchedGridOrder, orderType, precision, currentSizeIntFromGrid, rawForSaleInt } = lastCtx;
                        const { orderId } = lastCtx.entry;

                        // Sum the integer filled amounts across this order's fills so
                        // the single transition reflects the total consumption.
                        let totalFilledAmountInt = 0;
                        for (const ctx of group) {
                            totalFilledAmountInt += ctx.filledAmountInt;
                        }
                        const totalFilledAmount = blockchainToFloat(totalFilledAmountInt, precision);

                        if (group.length > 1) {
                            mgr.logger.log(
                                `[SYNC] Aggregated ${group.length} fill(s) for order ${orderId} (slot ${matchedGridOrder.id}): total filled=${totalFilledAmount}`,
                                'debug'
                            );
                        }

                        const refetchInfo = refetchMap.get(orderId);
                        const chainRefetched = refetchInfo?.chainRefetched || false;
                        const chainConfirmsEmpty = refetchInfo?.chainConfirmsEmpty || false;
                        const effectiveRawForSale = refetchInfo?.effectiveRawForSale != null ? refetchInfo.effectiveRawForSale : rawForSaleInt;

                        const result = await this._computeFillTransitionResult(mgr, {
                            matchedGridOrder,
                            orderType,
                            precision,
                            filledAmount: totalFilledAmount,
                            filledAmountInt: totalFilledAmountInt,
                            currentSizeIntFromGrid,
                            rawForSaleInt,
                            chainRefetched,
                            chainConfirmsEmpty,
                            effectiveRawForSale,
                            blockNum: lastCtx.entry.blockNum,
                            historyId: lastCtx.entry.historyId,
                            isMaker: lastCtx.entry.isMaker
                        });

                        if (result.isFull) {
                            mgr.logger.log(`[SYNC] Full fill for order ${orderId} (slot ${matchedGridOrder.id}).`, 'info');
                            gridUpdates.push({ id: matchedGridOrder.id, ...result.fullUpdate, context: 'handle-fill-full' });
                            filledOrders.push(result.filledOrder);
                            if (result.residualCancel) residualCancels.push(result.residualCancel);
                        } else {
                            mgr.logger.log(`[SYNC] Partial fill for order ${orderId} (slot ${matchedGridOrder.id}): newSize=${result.newSize}`, 'info');
                            gridUpdates.push({ id: matchedGridOrder.id, ...result.partialUpdate, context: 'handle-fill-partial' });
                            updatedOrders.push(result.partialUpdate);
                            filledOrders.push(result.filledOrder);
                            anyPartialFill = true;
                        }
                    }

                    // Phase 7: Single grid batch update — acquires _gridLock once
                    if (gridUpdates.length > 0) {
                        const updateObjects = gridUpdates.map(u => {
                            const { context, ...orderData } = u;
                            return orderData;
                        });
                        const batchOk = await mgr.applyGridUpdateBatch(updateObjects, 'handle-fill-batch', { skipAccounting: false, fee: 0 });
                        if (batchOk === false) {
                            mgr.logger.log('[SYNC] Batch grid update failed for some fills; marking totals stale for next sync cycle', 'warn');
                            mgr.accountTotalsStale = true;
                        }
                    }

                    // Re-anchor accountTotals to authoritative post-fill chain truth
                    // after the batch's accounting + grid mutation. The up-front
                    // stale-totals refresh returns post-fill balances, so the batch's
                    // processFillAccounting pays/receives adjustments would otherwise
                    // double-count; the forced fetch overwrites them with the
                    // authoritative values and hands re-commitments
                    // (tryDeductFromChainFree) a fresh snapshot.
                    await mgr.reanchorAccountTotals('fill-batch');

                    return { filledOrders, updatedOrders, partialFill: anyPartialFill, requiresOpenOrdersSync: anyRequiresSync, residualCancels };
                } finally {
                    // Lower the guard before the final consolidated recalc so the
                    // settled (re-anchored) state is still verified.
                    fillGuardLowered = true;
                    mgr._fillBatchInFlight = Math.max(0, (mgr._fillBatchInFlight ?? 0) - 1);
                    await mgr.resumeFundRecalc();
                }
            } finally {
                mgr.unlockOrders(allOrderIds);
            }
        } finally {
            // Safety net: ensure the guard never leaks across cycles on early
            // returns (deferral) or exceptions in the refresh/lock region.
            // Skipped when the inner finally already lowered it for this
            // invocation so concurrent batches cannot zero each other's count.
            if (!fillGuardLowered && (mgr._fillBatchInFlight ?? 0) > 0) mgr._fillBatchInFlight--;
        }
    }

    /**
     * High-level dispatcher for different blockchain synchronization sources.
     * Routes to the appropriate sync strategy based on the data source.
     *
     * SOURCES AND STRATEGIES:
     * ========================================================================
     * source: 'createOrder'
     *   Purpose: Grid order was successfully placed on-chain
     *   Data: { gridOrderId, chainOrderId, isPartialPlacement, fee }
     *   Action:
     *     1. Look up grid order by gridOrderId
     *     2. Assign the returned chainOrderId (so we can find it later)
     *     3. Transition state based on isPartialPlacement:
     *        - false → ACTIVE (full order placed)
     *        - true → PARTIAL (placed as partial, likely due to insufficient funds)
     *     4. Update optimistic chainFree balance (deduct fees if BTS pair)
     *   Fund Impact: Funds transition from free → locked/committed
     *
     * source: 'cancelOrder'
     *   Purpose: Grid order was successfully cancelled on-chain
     *   Data: The chainOrderId to cancel
     *   Action:
     *     1. Find grid order by orderId (reverse lookup)
     *     2. Transition to VIRTUAL (order no longer on-chain)
     *     3. Clear orderId so it can be re-used
     *     4. Update optimistic chainFree balance (add funds back as free)
     *   Fund Impact: Funds transition from locked → free
     *   Note: This is used for direct cancellations (not rotation/consolidation)
     *
     * source: 'readOpenOrders' or 'periodicBlockchainFetch'
     *   Purpose: Full snapshot sync of all open orders from blockchain
     *   Data: Array of chain orders from blockchain API
     *   Action: Delegates to syncFromOpenOrders() for full reconciliation
     *   Use Case: Periodic health check or startup initialization
     *
     * FUND TRACKING:
     * Both 'createOrder' and 'cancelOrder' call updateOptimisticFreeBalance() to
     * keep the optimistic chainFree balance in sync with actual on-chain state.
     * This prevents fund leaks where placed orders weren't deducted or cancelled
     * orders weren't released.
     *
     * RETURNS: { newOrders, ordersNeedingCorrection }
     * Most callers use ordersNeedingCorrection to flag price corrections needed.
     * Only syncFromOpenOrders() populates ordersNeedingCorrection.
     *
     * @param {Object} chainData - Chain event data
     * @param {string} source - Source identifier ('createOrder', 'cancelOrder', 'readOpenOrders', etc.)
     * @returns {Promise<Object>} { newOrders, ordersNeedingCorrection }
     */
    async synchronizeWithChain(chainData: any, source: string) {
        const mgr = this.manager;
        if (!mgr.assets) return { newOrders: [], ordersNeedingCorrection: [] };

        switch (source) {
            case 'createOrder': {
                const { gridOrderId, chainOrderId, isPartialPlacement, expectedType, fee } = chainData;
                const runCreate = async () => {
                    // Lock order to prevent concurrent modifications during state transition
                    mgr.lockOrders([gridOrderId]);
                    try {
                        const gridOrder = mgr.orders.get(gridOrderId);
                        if (gridOrder) {
                            // Check if this chain order already exists on grid (rotation case)
                            // If so, fee was already paid when original order was placed - don't deduct again
                            // CRITICAL: Look for ANY order with this orderId, even if it's been transitioned to VIRTUAL
                            const existingOrder: any = Array.from(mgr.orders.values() as any[]).find(
                                (o: any) => o.orderId === chainOrderId && o.id !== gridOrderId
                            );
                            const isRotation = !!existingOrder;

                            // For rotation: transition the old order to VIRTUAL, freeing its capital
                            if (isRotation && existingOrder) {
                                if (!isOrderVirtual(existingOrder)) {
                                    const oldVirtualOrder = convertToSpreadPlaceholder(existingOrder);
                                    await mgr._applyOrderUpdate(oldVirtualOrder, 'rotation-cleanup', {
                                        skipAccounting: chainData.skipAccounting || false,
                                        fee: 0
                                    });
                                } else if (hasOnChainId(existingOrder)) {
                                    // Already VIRTUAL but still has orderId (from rebalance)
                                    // Just clear the orderId to reflect blockchain state
                                    const clearedOrder = convertToSpreadPlaceholder(existingOrder);
                                    await mgr._applyOrderUpdate(clearedOrder, 'fill-cleanup', {
                                        skipAccounting: chainData.skipAccounting || false,
                                        fee: 0
                                    });
                                }
                            }

                            const newState = isPartialPlacement ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE;
                            let normalizedExpectedType = (expectedType === ORDER_TYPES.BUY || expectedType === ORDER_TYPES.SELL)
                                ? expectedType
                                : null;
                            // Defensive: a SPREAD slot must never transition to an on-chain
                            // state (validateOrder rejects SPREAD+ACTIVE/PARTIAL as fatal).
                            // Derive the side from the slot price vs start price — same
                            // convention as the funds check (manager.ts).
                            if (!normalizedExpectedType && gridOrder.type === ORDER_TYPES.SPREAD) {
                                normalizedExpectedType = resolveSpreadOrderSide(gridOrder.price, mgr.config.startPrice);
                            }
                            const updatedOrder = {
                                ...gridOrder,
                                type: normalizedExpectedType || gridOrder.type,
                                state: newState,
                                orderId: chainOrderId,
                            };
                            // Restore btsFeeState from raw chain order data if provided.
                            // After a grid reset, in-memory orders have no fee state but the
                            // chain's limit_order_object stores deferred_fee. Passing it through
                            // chainData.deferredFee allows reconstructing btsFeeState so the fee
                            // lifecycle (cancel refunds, fill maker discounts) uses correct values.
                            if (chainData.deferredFee !== undefined && chainData.deferredFee !== null) {
                                updatedOrder.btsFeeState = { deferredFee: Math.max(0, chainData.deferredFee) };
                            }
                            // Deduced fee (createFee or updateFee) must always be applied to reflect blockchain cost
                            const actualFee = fee;
                            await mgr._applyOrderUpdate(updatedOrder, 'fill-place', {
                                skipAccounting: chainData.skipAccounting || false,
                                fee: actualFee
                            });
                        }
                    } finally {
                        mgr.unlockOrders([gridOrderId]);
                    }
                };
                if (mgr._gridLock && typeof mgr._gridLock.acquire === 'function') {
                    await mgr._gridLock.acquire(runCreate);
                } else {
                    throw new Error('synchronizeWithChain(createOrder): _gridLock is missing — cannot proceed without lock');
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = chainData.orderId;
                const clearSize = !!chainData.clearSize;
                let btsFeeData;
                try {
                    btsFeeData = getAssetFees('BTS');
                } catch (err: any) {
                    mgr.logger?.log?.(
                        `[FILL-FEE] Failed to load BTS cancel fee cache: ${getErrorMessage(err)}. Using zero-fee fallback.`,
                        'warn'
                    );
                    btsFeeData = {
                        total: 0,
                        createFee: 0,
                        updateFee: 0,
                        cancelFee: 0,
                        makerNetFee: 0,
                        takerNetFee: 0,
                        netFee: 0,
                        isMaker: true,
                    };
                }
                const runCancel = async () => {
                    const gridOrder = findMatchingGridOrderByOpenOrder({ orderId }, { orders: mgr.orders, assets: mgr.assets, calcToleranceFn: (p: number, s: number, t: any) => calculatePriceTolerance(p, s, t, mgr.assets), logger: mgr.logger });
                    if (gridOrder) {
                        // Lock both chain orderId and grid order ID to prevent concurrent modifications
                        const orderIds = [orderId, gridOrder.id].filter(Boolean);
                        mgr.lockOrders(orderIds);
                        try {
                            // Re-fetch to ensure we have latest state after acquiring lock
                            const currentGridOrder = mgr.orders.get(gridOrder.id);
                            if (currentGridOrder && currentGridOrder.orderId === orderId) {
                                const nextOrder = clearSize
                                    ? convertToSpreadPlaceholder(currentGridOrder)
                                    : virtualizeOrder(currentGridOrder);
                                await mgr._applyOrderUpdate(nextOrder, 'cancel-order', {
                                    skipAccounting: false,
                                    fee: btsFeeData?.cancelFee || 0
                                });
                            }
                        } finally {
                            mgr.unlockOrders(orderIds);
                        }
                    } else {
                        // CRITICAL: Even if order not in grid, the cancellation fee was still paid on blockchain
                        // Deduct it from account totals to prevent drift.
                        const btsSide = getBtsSide(mgr.config?.assetA, mgr.config?.assetB);
                        if (btsSide && btsFeeData?.cancelFee > 0) {
                            await mgr.accountant.adjustTotalBalance(btsSide, -btsFeeData.cancelFee, 'cancel-order-unmatched-fee');
                        }
                    }
                };
                if (mgr._gridLock && typeof mgr._gridLock.acquire === 'function') {
                    await mgr._gridLock.acquire(runCancel);
                } else {
                    throw new Error('synchronizeWithChain(cancelOrder): _gridLock is missing — cannot proceed without lock');
                }
                break;
            }
            case 'readOpenOrders':
                // Plain open-order syncs do not imply a fresh account balance fetch,
                // so they still use optimistic accounting deltas.
                return this.syncFromOpenOrders(chainData, {
                    skipAccounting: false
                });

            case 'periodicBlockchainFetch': {
                // This source is used after fetchAccountTotals() has refreshed
                // authoritative chain free/locked totals. Applying optimistic
                // commitment deltas here double-deducts newly adopted or resized
                // open orders from already-fetched free balances.
                return this.syncFromOpenOrders(chainData, {
                    skipAccounting: true
                });
            }
        }
        return { newOrders: [], ordersNeedingCorrection: [] };
    }

    /**
     * Fetch account balances from blockchain and update optimistic fund totals.
     * This is a critical method for financial accuracy and must be called periodically.
     *
     * BALANCE FETCHING:
     * ========================================================================
     * This method queries the blockchain for the actual account balances in both
     * assetA and assetB. It retrieves:
     *   - total: Total balance (including locked amounts)
     *   - free: Available balance (not locked in orders)
     *
     * These are stored in mgr.accountTotals as:
     *   - sell: assetA total (what we can sell)
     *   - sellFree: assetA available
     *   - buy: assetB total (what we can buy with)
     *   - buyFree: assetB available
     *
     * IMPORTANCE FOR FUND TRACKING:
     * The grid maintains an "optimistic" free balance that tracks fund deductions
     * as orders transition states. However, the blockchain is the source of truth.
     * Periodically fetching actual balances allows us to:
     *
     * 1. RECONCILE: Detect if optimistic state diverged from reality
     *    Example: If we think buyFree=1000 but blockchain says 950,
     *    something was deducted (fee, slippage, etc.) that we didn't track.
     *
     * 2. RECOVER: Identify "orphaned" funds that got stuck somewhere
     *    If actual > optimistic, we can reabsorb the extra into available pool.
     *
     * 3. PREVENT OVERSPEND: Use actual totals as the hard ceiling
     *    Even if optimistic calc says we have X funds, we never exceed actual total.
     *
     * FUND FORMULA:
     * At any time, this should hold:
     *   chainTotal = chainFree + chainCommitted
     * Where:
     *   chainTotal = actual on-chain total from blockchain
     *   chainFree = free balance (unallocated)
     *   chainCommitted = sum of all ACTIVE/PARTIAL order sizes on-chain
     *
     * ASSET INITIALIZATION:
     * First calls initializeAssets() to ensure assetA and assetB metadata is loaded.
     * Without this, we can't convert between blockchain precision and float values.
     *
     * ERROR HANDLING:
     * Gracefully handles lookup failures. If blockchain fetch fails, we don't crash
     * but instead log a warning. The system continues with last-known balances.
     *
     * @returns {Promise<void>}
     */
    async fetchAccountBalancesAndSetTotals() {
        const mgr = this.manager;
        try {
            if (!BitShares || !BitShares.db) return;
            const accountIdOrName = mgr.accountId || mgr.account || null;
            if (!accountIdOrName) return;

            try { await this.initializeAssets(); } catch (err: any) { mgr.logger.log(`[SYNC] initializeAssets failed: ${getErrorMessage(err)}`, 'warn'); }
            const assetAId = mgr.assets?.assetA?.id;
            const assetBId = mgr.assets?.assetB?.id;
            if (!assetAId || !assetBId) return;

            const assetList = [assetAId, assetBId];

            // For non-BTS pairs, also fetch core asset (BTS) balance for fee management
            if (mgr.config.assetA !== 'BTS' && mgr.config.assetB !== 'BTS') {
                assetList.push(NATIVE_CLIENT.CHAIN.CORE_ASSET_ID);
            }

            const lookup: Record<string, any> = await chainOrders.getOnChainAssetBalances(accountIdOrName, assetList);
            const aInfo = lookup?.[assetAId] || lookup?.[mgr.config.assetA];
            const bInfo = lookup?.[assetBId] || lookup?.[mgr.config.assetB];

             if (aInfo && bInfo) {
                 await mgr.setAccountTotals({ sell: aInfo.total, sellFree: aInfo.free, buy: bInfo.total, buyFree: bInfo.free });
             }

             // Store BTS balance for non-BTS pairs
             if (mgr.config.assetA !== 'BTS' && mgr.config.assetB !== 'BTS') {
                 const btsInfo = lookup?.[NATIVE_CLIENT.CHAIN.CORE_ASSET_ID];
                 if (btsInfo) {
                     mgr.btsBalance = { free: btsInfo.free, total: btsInfo.total, locked: 0 };
                 }
             }
        } catch (err: any) {
            mgr.logger.log(`Failed to fetch on-chain balances: ${getErrorMessage(err)}`, 'warn');
        }
    }

    /**
     * Initialize asset metadata for assetA and assetB.
     * This must be called before any blockchain operations, as asset metadata
     * (ID, precision) is required for all conversions and lookups.
     *
     * WHY ASSET METADATA MATTERS:
     * ========================================================================
     * The blockchain and grid use different representations for amounts:
     *
     * Blockchain: Uses integers (atomic units based on asset precision)
     *   - BTS: precision 5 → 1 BTS = 100000 satoshis
     *   - USDT: precision 6 → 1 USDT = 1000000 satoshis
     *   Storage on-chain is always integer to prevent floating-point errors
     *
     * Grid: Uses floats for all calculations
     *   - Easier to work with for price/size calculations
     *   - Must round-trip correctly through blockchain precision
     *
     * Asset Metadata Needed:
     * 1. asset_id: Required to match orders on-chain
     *    When we see an order selling assetA for assetB, we identify it by comparing
     *    the asset_ids in the sell_price object.
     *
     * 2. precision: Required for float ↔ integer conversions
     *    floatToBlockchainInt(1.5, precision=5) = 150000
     *    blockchainToFloat(150000, precision=5) = 1.5
     *
     * Without precision, we can't:
     * - Compare order sizes (float vs blockchain int)
     * - Calculate fills (precision matters at extreme sizes)
     * - Match chain orders to grid orders (need correct ID)
     * - Convert fill amounts to grid sizes
     *
     * INITIALIZATION STRATEGY:
     * Assets are looked up asynchronously via the BitShares API.
     * The lookup is idempotent: if assets are already initialized, returns immediately.
     * This allows safe calls from multiple places without redundant lookups.
     *
     * ERROR HANDLING:
     * If asset lookup fails (asset doesn't exist, API error, etc.), the error
     * is propagated (not caught). This is intentional - a missing asset is a
     * configuration error that must be fixed before the bot can operate.
     *
     * @returns {Promise<void>}
     */
    async initializeAssets() {
        const mgr = this.manager;
        if (mgr.assets) return;

        const fetchAssetWithFallback = async (symbol: any, side: any) => {
            try {
                return await lookupAsset(BitShares, symbol);
            } catch (err: any) {
                // If blockchain lookup fails, check for persisted fallback
                if (mgr.accountOrders) {
                    const persistedAssets = mgr.accountOrders.loadPersistedAssets();
                    const assetData = (side === 'A') ? persistedAssets?.assetA : persistedAssets?.assetB;

                    if (assetData && assetData.symbol === symbol && typeof assetData.precision === 'number') {
                        mgr.logger.log(`Blockchain lookup failed for ${symbol}: ${getErrorMessage(err)}. Persisted data: id=${assetData.id}, precision=${assetData.precision} — refusing stale fallback`, 'error');
                    }
                }
                throw err;
            }
        };

        try {
            mgr.assets = {
                assetA: await fetchAssetWithFallback(mgr.config.assetA, 'A'),
                assetB: await fetchAssetWithFallback(mgr.config.assetB, 'B')
            };
        } catch (err: any) {
            mgr.logger.log(`Asset metadata lookup failed: ${getErrorMessage(err)}`, 'error');
            throw err;
        }
    }
}

export default SyncEngine
