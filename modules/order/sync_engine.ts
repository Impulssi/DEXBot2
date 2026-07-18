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
 * FILL PROCESSING (1 method)
 *   5. syncFromFillHistory(fill) - Process fill event synchronously
 *      Updates grid order state based on fill data
 *      Updates fund state and accounting
 *      Handles both maker and taker fills
 *
 * FULL SYNCHRONIZATION (1 method - async)
 *   6. synchronizeWithChain(chainData, source) - Full sync (fetch + sync) (async)
 *      Fetches fresh account balances
 *      Calls syncFromOpenOrders() with chain data
 *      Source: event type that triggered sync (fill, poll, broadcast, etc.)
 *
 * ACCOUNT STATE (2 methods - async)
 *   7. fetchAccountBalancesAndSetTotals(accountId) - Fetch account totals (async)
 *      Retrieves BUY/SELL totals and free balances from blockchain
 *      Sets manager.accountTotals
 *      Triggers fund recalculation
 *
 *   8. initializeAssets() - Initialize asset metadata (async)
 *      Fetches asset precision and other metadata
 *      Sets manager.assets
 *      Called once at bot startup
 *
 * ===============================================================================
 *
 * LOCK HIERARCHY:
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

const { ORDER_TYPES, ORDER_STATES, TIMING, BTS_PRECISION } = require('../constants');
const Format = require('./format');
const { toFiniteNumber } = Format;
const {
    blockchainToFloat,
    floatToBlockchainInt,
    hasValidAccountTotals,
    calculatePriceTolerance,
    getAssetFees
} = require('./utils/math');
const {
    parseChainOrder,
    findMatchingGridOrderByOpenOrder,
    applyChainSizeToGridOrder,
    convertToSpreadPlaceholder,
    virtualizeOrder,
    buildFillKey,
    isOrderPlaced,
    isOrderOnChain,
    hasOnChainId,
    isOrderVirtual,
    isPhantomOrder
} = require('./utils/order');
const {
    resolveProcessedFillPersistenceMode
} = require('./processed_fill_store');
const { lookupAsset } = require('./utils/system');

/**
 * Compare two raw chain order objects for on-chain equivalence.
 * @param {Object|null} a - First chain order
 * @param {Object|null} b - Second chain order
 * @returns {boolean} True if orders are equivalent
 */
function hasEquivalentRawOnChainOrder(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;

    const aBase = a.sell_price?.base || {};
    const bBase = b.sell_price?.base || {};
    const aQuote = a.sell_price?.quote || {};
    const bQuote = b.sell_price?.quote || {};

    return String(a.id ?? '') === String(b.id ?? '') &&
        String(a.for_sale ?? '') === String(b.for_sale ?? '') &&
        String(aBase.amount ?? '') === String(bBase.amount ?? '') &&
        String(aBase.asset_id ?? '') === String(bBase.asset_id ?? '') &&
        String(aQuote.amount ?? '') === String(bQuote.amount ?? '') &&
        String(aQuote.asset_id ?? '') === String(bQuote.asset_id ?? '');
}

function describeNearestAdoptionCandidates(mgr, chainOrder, precision, calcTolerance, matchedGridOrderIds = null) {
    if (!mgr?.orders || !chainOrder || typeof precision !== 'number') return 'candidate diagnostics unavailable';

    const chainPrice = toFiniteNumber(chainOrder.price);
    const chainSize = toFiniteNumber(chainOrder.size);
    const chainInt = floatToBlockchainInt(chainSize, precision);
    const candidates = [];

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
        const reasons = [];
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

function _getDriftToleranceMultiplier(mgr): number {
    return mgr?.config?.gridLimits?.PRICE_DRIFT_TOLERANCE_MULTIPLIER;
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
function computeOutOfToleranceDriftTag(mgr, chainOrder, calcToleranceFn) {
    if (!mgr?.orders || !chainOrder) return null;
    const chainPrice = toFiniteNumber(chainOrder.price);
    if (!Number.isFinite(chainPrice)) return null;
    const chainSize = toFiniteNumber(chainOrder.size);
    const orderType = chainOrder.type;
    if (orderType !== ORDER_TYPES.BUY && orderType !== ORDER_TYPES.SELL) return null;

    let bestDrift = null;
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
        const driftBudget = tolerance * _getDriftToleranceMultiplier(mgr);
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

        if (!options?.fillLockAlreadyHeld && mgr._fillProcessingLock) {
            return mgr._fillProcessingLock.acquire(async () => {
                return this.syncFromOpenOrders(chainOrders, {
                    ...options,
                    fillLockAlreadyHeld: true
                });
            });
        }

        mgr.logger?.log?.(`[SYNC] Starting synchronization from ${chainOrders?.length || 0} blockchain orders...`, 'info');

        const timeoutMs = TIMING.SYNC_LOCK_TIMEOUT_MS;
        let timedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const syncStartedAt = Date.now();
        try {
            const result = await Promise.race([
                mgr._syncLock.acquire(async () => {
                    const innerResult = await this._doSyncFromOpenOrders(chainOrders, options);
                    if (timedOut) {
                        mgr.logger?.log?.(
                            `[SYNC] Sync completed after timeout (${Date.now() - syncStartedAt}ms) — ` +
                            `timeout won the race; next sync will reconcile chain state`,
                            'warn'
                        );
                        return innerResult;
                    }
                    const unmatchedCount = Array.isArray(innerResult.unmatchedChainOrders)
                        ? innerResult.unmatchedChainOrders.length
                        : 0;
                    mgr._lastUnmatchedChainOrders = unmatchedCount > 0
                        ? innerResult.unmatchedChainOrders.map(order => ({ ...order }))
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
            return result;
        } catch (err: any) {
            clearTimeout(timeoutHandle);
            if (err.message?.includes('timed out')) {
                mgr.logger?.log?.(
                    '[SYNC] Lock may be held by orphan after timeout; will release when inner work completes',
                    'warn'
                );
            }
            mgr.logger?.log?.(`Sync lock error: ${err.message}`, 'error');
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
     *   - validateOnly {boolean}: If true, only validate without applying changes
     *   - skipFundRecalc {boolean}: If true, skip fund recalculation after sync
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
                mgr.logger?.log?.(`Warning: Error parsing chain order ${order.id}: ${e.message}`, 'warn');
                continue;
            }
        }

        // Collect all order IDs that might be modified during reconciliation
        // Lock them to prevent concurrent modifications from createOrder/cancelOrder
        const orderIdsToLock = new Set();
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

        const chainOrderIdsOnGrid = new Set<string>();
        const matchedGridOrderIds = new Set<string>();
        const filledOrders = [];
        const updatedOrders = [];
        const ordersNeedingCorrection = [];
        const unmatchedChainOrders = [];

        // Lock orders before reconciliation
        mgr.lockOrders([...orderIdsToLock]);

        // Keep lock leases alive during long reconciliation runs.
        const refreshEveryMs = Math.max(TIMING.LOCK_REFRESH_MIN_MS, Math.floor(TIMING.LOCK_TIMEOUT_MS / 3));
        const refreshLockLeases = () => {
            const expiresAt = Date.now() + TIMING.LOCK_TIMEOUT_MS;
            for (const id of orderIdsToLock) {
                mgr.shadowOrderIds.set(id, expiresAt);
            }
            mgr.logger?.log?.(`Refreshed lock leases for ${orderIdsToLock.size} orders`, 'debug');
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

            if (options?.gridLockAlreadyHeld) {
                await runReconciliation();
            } else {
                await mgr._gridLock.acquire(runReconciliation);
            }
        } finally {
            clearInterval(lockRefreshTimer);
            // Unlock after reconciliation completes
            mgr.unlockOrders([...orderIdsToLock]);
        }

        return { filledOrders, updatedOrders, ordersNeedingCorrection, unmatchedChainOrders };
    }

    /**
     * Internal two-pass reconciliation with locks already held.
     * @param {Object} mgr - OrderManager instance
     * @param {number} assetAPrecision - Asset A precision
     * @param {number} assetBPrecision - Asset B precision
     * @param {Map<string, import('./types').ParsedChainOrder>} parsedChainOrders - Parsed chain orders by ID
     * @param {Map<string, Object>} rawChainOrders - Raw blockchain order objects by ID
     * @param {Set<string>} chainOrderIdsOnGrid - Output set: chain order IDs matched to grid
     * @param {Set<string>} matchedGridOrderIds - Output set: grid order IDs matched to chain
     * @param {Array<Object>} filledOrders - Output array: orders detected as filled
     * @param {Array<Object>} updatedOrders - Output array: orders updated during sync
     * @param {Array<Object>} ordersNeedingCorrection - Output array: orders flagged for price correction
     * @param {Array<Object>} unmatchedChainOrders - Output array: open chain orders with no adoptable grid slot
     * @param {Object} options - Sync options (skipAccounting, etc.)
     * @returns {Promise<{filledOrders: Array, updatedOrders: Array, ordersNeedingCorrection: Array, unmatchedChainOrders: Array}>}
     */
    async _performSyncFromOpenOrders(mgr: any, assetAPrecision: number, assetBPrecision: number, parsedChainOrders: Map<string, any>, rawChainOrders: Map<string, any>,
        chainOrderIdsOnGrid: Set<string>, matchedGridOrderIds: Set<string>, filledOrders: any[], updatedOrders: any[], ordersNeedingCorrection: any[], unmatchedChainOrders: any[], options: Record<string, any>) {
        const skipAccounting = Boolean(options?.skipAccounting);

        const queueCorrection = (entry) => {
            ordersNeedingCorrection.push(entry);
            if (!Array.isArray(mgr.ordersNeedingPriceCorrection)) return;

            const existingIndex = mgr.ordersNeedingPriceCorrection.findIndex((queued) =>
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
                    const newSize = blockchainToFloat(chainSizeInt, precision, true);
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
                        await mgr._applyOrderUpdate(updatedOrder, 'sync-pass1-partial', { skipAccounting, fee: 0 });
                    } else {
                        const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                        await mgr._applyOrderUpdate(spreadOrder, 'sync-pass1-filled', { skipAccounting, fee: 0 });
                        filledOrders.push(spreadOrder);
                        updatedOrders.push(spreadOrder);
                    }
                }
            } else if (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL) {
                const currentGridOrder = mgr.orders.get(gridOrder.id) || gridOrder;
                const hadOrderId = Boolean(currentGridOrder?.orderId);
                const spreadOrder = convertToSpreadPlaceholder(currentGridOrder);
                await mgr._applyOrderUpdate(spreadOrder, 'sync-cleanup-phantom', { skipAccounting, fee: 0 });

                // Only genuine disappearances (had orderId) count as fills.
                if (hadOrderId) {
                    filledOrders.push({ ...currentGridOrder });
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
            // match (line 684), because a VIRTUAL slot at a nearby price can
            // otherwise silently adopt the orphan before the duplicate guard runs.
            const duplicatePriceOrder: any = Array.from(mgr.orders.values()).find((o: any) =>
                o.type === chainOrder.type &&
                isOrderPlaced(o) &&
                Math.abs(o.price - chainOrder.price) <= calculatePriceTolerance(
                    Math.min(o.price, chainOrder.price),
                    Math.max(o.size, chainOrder.size),
                    o.type, mgr.assets
                )
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
                mgr.logger?.log?.(
                    `[SYNC] Orphaned chain order ${chainOrderId} (${chainOrder.type}, price=${chainOrder.price}, ` +
                    `size=${chainOrder.size}) — NOT adopted: duplicates price level of active ` +
                    `${duplicatePriceOrder.id} (${duplicatePriceOrder.orderId} at ${duplicatePriceOrder.price})`,
                    'warn'
                );
                continue;
            }

            const match = findMatchingGridOrderByOpenOrder(
                { orderId: chainOrderId, type: chainOrder.type, price: chainOrder.price, size: chainOrder.size },
                {
                    orders: mgr.orders,
                    assets: mgr.assets,
                    calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets),
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
                        await mgr._applyOrderUpdate(spreadOrder, 'sync-pass2-filled', { skipAccounting, fee: 0 });
                        updatedOrders.push(spreadOrder);
                        chainOrderIdsOnGrid.add(chainOrderId);
                        continue;
                    }
                } else if (wasPartial) {
                    bestMatch.state = ORDER_STATES.PARTIAL;
                }
                await mgr._applyOrderUpdate(bestMatch, 'sync-pass2-orphan', { skipAccounting, fee: 0 });
                updatedOrders.push(bestMatch);
                chainOrderIdsOnGrid.add(chainOrderId);
            } else if (match) {
                mgr.logger?.log?.(
                    `Warning: Orphan chain order ${chainOrderId} matched grid order ${match.id}, ` +
                    `but grid order was already matched to another chain order. Skipping to prevent double-assignment.`,
                    'warn'
                );
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
                        calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets),
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
                    await mgr._applyOrderUpdate(adoptedOrder, 'sync-pass2-adopt-orphan', { skipAccounting, fee: 0 });
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
                        (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets),
                        matchedGridOrderIds
                    );
                    const driftTag = computeOutOfToleranceDriftTag(
                        mgr,
                        chainOrder,
                        (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets)
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

    /**
     * Process one incremental fill-history event.
     * Returns `{ filledOrders, updatedOrders, partialFill, requiresOpenOrdersSync, ghostOrderId? }`.
     * @param {Object} fill - Fill history event object
     * @param {Object} [options] - Persistence mode options
     * @returns {Promise<Object>} { filledOrders, updatedOrders, partialFill, requiresOpenOrdersSync, ghostOrderId? }
     */
    async syncFromFillHistory(fill: any, options: Record<string, any> = {}) {
        const mgr = this.manager;
        const persistenceMode = resolveProcessedFillPersistenceMode(options);
        if (!fill || !fill.op || !fill.op[1]) return { filledOrders: [], updatedOrders: [], partialFill: false };

        const fillOp = fill.op[1];
        const blockNum = fill.block_num;
        const historyId = fill.id;
        const isMaker = fillOp.is_maker !== false;  // Default missing flag to maker for consistency with accounting
        const orderId = fillOp.order_id;
        const fillKey = buildFillKey({ orderId, blockNum, historyId });

        const paysAmountRaw = toFiniteNumber(fillOp.pays?.amount);
        const paysAssetId = fillOp.pays ? fillOp.pays.asset_id : null;
        const receivesAmountRaw = toFiniteNumber(fillOp.receives?.amount);
        const receivesAssetId = fillOp.receives ? fillOp.receives.asset_id : null;

        mgr.logger.log(`[SYNC] Processing fill ${historyId} at block ${blockNum} for order ${orderId} (maker=${isMaker}). Pays=${paysAmountRaw}@${paysAssetId}, Receives=${receivesAmountRaw}@${receivesAssetId}`, 'debug');

         if (!fillKey) {
             mgr.logger.log(
                 `[SYNC] Missing replay-safe fill key for order ${orderId} block ${blockNum}; deferring to open-orders sync`,
                 'warn'
             );
             return { filledOrders: [], updatedOrders: [], partialFill: false, requiresOpenOrdersSync: true };
         }

         // Optimistically update account totals to reflect the fill
         // This prevents fund invariant violations during the window between fill detection and next blockchain fetch
         const appliedAccounting = await mgr.accountant.processFillAccounting(fillOp, fillKey, { persistenceMode });
         if (!appliedAccounting) {
             mgr.logger.log(`[SYNC] Replay detected for fill ${fillKey}; skipping duplicate order mutation`, 'debug');
             return { filledOrders: [], updatedOrders: [], partialFill: false };
         }

         // Lock the order to prevent concurrent modifications from createOrder/cancelOrder/sync
         // This is critical to prevent TOCTOU races where fill processing updates a stale order
         const orderIdsToLock = new Set([orderId]);
         mgr.lockOrders([...orderIdsToLock]);

        try {
            mgr.pauseFundRecalc();
            try {
                const paysAmount = paysAmountRaw;

                const assetAPrecision = mgr.assets?.assetA?.precision;
                const assetBPrecision = mgr.assets?.assetB?.precision;

                if (assetAPrecision === undefined || assetBPrecision === undefined) {
                    mgr.logger?.log?.('Error: manager.assets precision missing in syncFromFillHistory', 'error');
                    return { filledOrders: [], updatedOrders: [], partialFill: false };
                }

                let matchedGridOrder = null;
                for (const gridOrder of mgr.orders.values()) {
                    if (gridOrder.orderId === orderId && (gridOrder.state === ORDER_STATES.ACTIVE || gridOrder.state === ORDER_STATES.PARTIAL)) {
                        matchedGridOrder = gridOrder;
                        break;
                    }
                }

                if (!matchedGridOrder) {
                    mgr.logger.log(`[SYNC] Fill for order ${orderId} ignored: order not found in active grid.`, 'debug');
                    return { filledOrders: [], updatedOrders: [], partialFill: false };
                }

                const orderType = matchedGridOrder.type;
                const currentSize = toFiniteNumber(matchedGridOrder.size);
                
                // CRITICAL: Sells are sized in AssetA, Buys are sized in AssetB
                const precision = (orderType === ORDER_TYPES.SELL) ? assetAPrecision : assetBPrecision;
                
                let filledAmount = 0;
                if (orderType === ORDER_TYPES.SELL) {
                    if (paysAssetId === mgr.assets.assetA.id) filledAmount = blockchainToFloat(paysAmount, precision, true);
                } else {
                    if (paysAssetId === mgr.assets.assetB.id) filledAmount = blockchainToFloat(paysAmount, precision, true);
                }

                mgr.logger.log(`[SYNC] Order ${orderId} (${orderType}) currentSize=${currentSize}, filledAmount=${filledAmount}`, 'debug');

                const currentSizeIntFromGrid = floatToBlockchainInt(currentSize, precision);
                const rawForSaleInt = toFiniteNumber(matchedGridOrder?.rawOnChain?.for_sale, null);
                let effectiveRawForSale = rawForSaleInt;
                let chainConfirmsEmpty = false;
                let chainRefetched = false;

                // -----------------------------------------------------------------
                // Drift-only refetch: the cache is self-correcting across sequential
                // websocket fills, but if a fill was ever missed (reconnect, restart,
                // reorg, external activity), the cache and the grid can disagree.
                // The only signal we can detect from the in-memory state is a
                // consistent drift: cached for_sale < grid size. Chain `for_sale`
                // can only decrease, so a smaller cached value is an obvious
                // inconsistency that warrants a targeted refetch.
                //
                // We do NOT refetch on a time-based TTL. A stale-but-consistent
                // cache is still correct; a fresh-but-wrong cache is the actual
                // bug we're guarding against, and the drift signal catches that.
                // The refetch is best-effort: a network error falls back to the
                // cache with a warning, and the open-orders sync is the ultimate
                // recovery channel.
                // -----------------------------------------------------------------
                const driftSignal = Number.isFinite(rawForSaleInt)
                    && Math.round(rawForSaleInt) < currentSizeIntFromGrid;

                if (driftSignal) {
                    try {
                        const { readSingleOrder } = require('../chain_orders');
                        const fresh = await readSingleOrder(orderId, 3000);
                        if (fresh) {
                            const freshForSale = toFiniteNumber(fresh.for_sale, null);
                            if (Number.isFinite(freshForSale)) {
                                effectiveRawForSale = freshForSale;
                                chainRefetched = true;
                                mgr.logger.log(
                                    `[SYNC] Drift detected for ${orderId} (cached=${rawForSaleInt} < grid=${currentSizeIntFromGrid}); ` +
                                    `refetched for_sale=${freshForSale}`,
                                    'warn'
                                );
                            }
                        } else {
                            // Chain returned null — the order is genuinely absent.
                            // This is the authoritative "chain confirms empty"
                            // signal (vs. an RPC failure which would have thrown).
                            chainConfirmsEmpty = true;
                            mgr.logger.log(
                                `[SYNC] Drift refetch for ${orderId} returned null; chain confirms empty`,
                                'info'
                            );
                        }
                    } catch (refetchErr: any) {
                        mgr.logger.log(
                            `[SYNC] Drift refetch for ${orderId} failed; falling back to cache: ` +
                            `${refetchErr?.message || refetchErr}`,
                            'warn'
                        );
                    }
                }

                // Chain-confirmed-empty gate: only true when the drift refetch
                // returned null (i.e., the chain is definitively saying the order
                // is gone). We deliberately do not trust a cached 0 from a
                // never-refetched source — that would misclassify a 0.003 XRP
                // residual as a full fill.
                if (chainRefetched
                    && Number.isFinite(effectiveRawForSale)
                    && Math.round(effectiveRawForSale) <= 0) {
                    chainConfirmsEmpty = true;
                }

                const currentSizeInt = Number.isFinite(effectiveRawForSale)
                    ? Math.max(0, Math.round(effectiveRawForSale))
                    : currentSizeIntFromGrid;
                const filledAmountInt = floatToBlockchainInt(filledAmount, precision);
                const newSizeInt = Math.max(0, currentSizeInt - filledAmountInt);
                const newSize = blockchainToFloat(newSizeInt, precision, true); // needed for partial fills

                if (Number.isFinite(effectiveRawForSale) && currentSizeInt !== currentSizeIntFromGrid) {
                    mgr.logger.log(
                        `[SYNC] Using rawOnChain.for_sale baseline for ${orderId}: raw=${currentSizeInt}, grid=${currentSizeIntFromGrid}` +
                        (chainRefetched ? ' (refetched)' : ''),
                        'debug'
                    );
                }

                // CRITICAL (v0.5.1 Robustness + chain-confirmed-empty gate):
                // An order is "effectively" full if EITHER:
                //   1. The chain has confirmed the order is gone (the drift
                //      refetch above returned null), OR
                //   2. The grid itself is at 0 (no drift between grid and chain), OR
                //   3. The OTHER side rounds to 0 (the chain will close the order
                //      regardless of the residual on the size side — see
                //      test_ghost_order_fix.ts for the intended behaviour).
                //
                // We deliberately do NOT use `newSizeInt <= 0` as a fast-path
                // full-fill signal: with a stale cached rawOnChain, that arithmetic
                // can be wrong and misclassify a partial fill as full. The
                // 30-satoshi residual that triggered the bot-stale incident is the
                // motivating case.
                const gridAlsoEmpty = currentSizeIntFromGrid <= 0;
                let isEffectivelyFull = chainConfirmsEmpty || gridAlsoEmpty;

                let ghostOrderId: string | undefined;

                if (!isEffectivelyFull) {
                    // Check the "other" side's precision. If the remaining amount to receive/pay
                    // rounds to 0 on the blockchain, the order will be closed regardless of newSizeInt.
                    const otherPrecision = (orderType === ORDER_TYPES.SELL) ? assetBPrecision : assetAPrecision;
                    const price = matchedGridOrder.price;
                    const otherSize = (orderType === ORDER_TYPES.SELL) ? newSize * price : newSize / price;

                    if (floatToBlockchainInt(otherSize, otherPrecision) <= 0) {
                        mgr.logger.log(`[SYNC] Order ${orderId} (slot ${matchedGridOrder.id}) other-side (${otherSize}) rounds to 0. Treating as full fill to trigger rotation.`, 'info');
                        isEffectivelyFull = true;
                        ghostOrderId = matchedGridOrder.orderId;
                    }
                }

                const filledOrders = [];
                const updatedOrders = [];
                if (isEffectivelyFull) {
                    mgr.logger.log(`[SYNC] Full fill for order ${orderId} (slot ${matchedGridOrder.id}).`, 'info');
                    const filledOrder = {
                        ...matchedGridOrder,
                        blockNum: blockNum,
                        historyId: historyId,
                        isMaker: isMaker  // Preserve maker/taker flag for accurate fee calculation
                    };

                    const spreadOrder = convertToSpreadPlaceholder(matchedGridOrder);
                    const fullOk = await mgr._updateOrder(spreadOrder, 'handle-fill-full', { skipAccounting: false, fee: 0 });
                    if (fullOk === false) {
                        mgr.logger.log(`[SYNC] Failed to convert filled order ${orderId} to spread placeholder`, 'warn');
                    }
                    filledOrders.push(filledOrder);
                    return { filledOrders, updatedOrders, partialFill: false, ...(ghostOrderId ? { ghostOrderId } : {}) };
                } else {
                    mgr.logger.log(`[SYNC] Partial fill for order ${orderId} (slot ${matchedGridOrder.id}): newSize=${newSize}`, 'info');
                    const filledPortion = {
                        ...matchedGridOrder,
                        size: filledAmount,
                        isPartial: true,
                        blockNum: blockNum,
                        historyId: historyId,
                        isMaker: isMaker  // Preserve maker/taker flag for accurate fee calculation
                    };
                    const { btsFeeState, ...matchedWithoutDeferredFee } = matchedGridOrder;
                    let updatedOrder = { ...matchedWithoutDeferredFee, state: ORDER_STATES.PARTIAL };

                    // Update cached raw order integer instead of deleting it.
                    // If the drift refetch above pulled a fresh chain value, use
                    // it as the new baseline (subtracting this fill) and stamp
                    // fetchedAt so the cache is consistent for the next fill.
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

                    const partialOk = await mgr._updateOrder(updatedOrder, 'handle-fill-partial', { skipAccounting: false, fee: 0 });
                    if (partialOk === false) {
                        mgr.logger.log(`[SYNC] Failed to update partially filled order ${orderId}`, 'warn');
                    }
                    updatedOrders.push(updatedOrder);
                    filledOrders.push(filledPortion);
                    return { filledOrders, updatedOrders, partialFill: true };
                 }
             } finally {
                 await mgr.resumeFundRecalc();
             }
        } finally {
            mgr.unlockOrders([...orderIdsToLock]);
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
     * @param {Object} [options] - Sync options forwarded to open-order reconciliation
     * @returns {Promise<Object>} { newOrders, ordersNeedingCorrection }
     */
    async synchronizeWithChain(chainData: any, source: string, options: Record<string, any> = {}) {
        const mgr = this.manager;
        if (!mgr.assets) return { newOrders: [], ordersNeedingCorrection: [] };

        switch (source) {
            // ... [existing cases: createOrder, cancelOrder] ...
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
                                    const oldVirtualOrder = { ...virtualizeOrder(existingOrder), size: 0 };
                                    await mgr._applyOrderUpdate(oldVirtualOrder, 'rotation-cleanup', {
                                        skipAccounting: chainData.skipAccounting || false,
                                        fee: 0
                                    });
                                } else if (hasOnChainId(existingOrder)) {
                                    // Already VIRTUAL but still has orderId (from rebalance)
                                    // Just clear the orderId to reflect blockchain state
                                    const clearedOrder = { ...virtualizeOrder(existingOrder), size: 0 };
                                    await mgr._applyOrderUpdate(clearedOrder, 'fill-cleanup', {
                                        skipAccounting: chainData.skipAccounting || false,
                                        fee: 0
                                    });
                                }
                            }

                            const newState = isPartialPlacement ? ORDER_STATES.PARTIAL : ORDER_STATES.ACTIVE;
                            const normalizedExpectedType = (expectedType === ORDER_TYPES.BUY || expectedType === ORDER_TYPES.SELL)
                                ? expectedType
                                : null;
                            const updatedOrder = {
                                ...gridOrder,
                                type: normalizedExpectedType || gridOrder.type,
                                state: newState,
                                orderId: chainOrderId
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
                // CRITICAL: serialize with concurrent _applyOrderUpdate on the global
                // _ordersByState / _ordersByType Sets and the frozen manager.orders Map.
                // Internal callers that already hold _gridLock (e.g. reconcileGridOrders)
                // opt out via { gridLockAlreadyHeld: true } to avoid deadlock with the
                // non-reentrant AsyncLock.
                if (options?.gridLockAlreadyHeld) {
                    await runCreate();
                } else if (mgr._gridLock && typeof mgr._gridLock.acquire === 'function') {
                    await mgr._gridLock.acquire(runCreate);
                } else {
                    throw new Error('synchronizeWithChain(createOrder): _gridLock is missing — cannot proceed without lock');
                }
                break;
            }
            case 'cancelOrder': {
                const orderId = typeof chainData === 'object' && chainData !== null
                    ? chainData.orderId
                    : chainData;
                const clearSize = !!(typeof chainData === 'object' && chainData !== null && chainData.clearSize);
                let btsFeeData;
                try {
                    btsFeeData = getAssetFees('BTS');
                } catch (err: any) {
                    mgr.logger?.log?.(
                        `[FILL-FEE] Failed to load BTS cancel fee cache: ${err.message}. Using zero-fee fallback.`,
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
                    const gridOrder = findMatchingGridOrderByOpenOrder({ orderId }, { orders: mgr.orders, assets: mgr.assets, calcToleranceFn: (p, s, t) => calculatePriceTolerance(p, s, t, mgr.assets), logger: mgr.logger });
                    if (gridOrder) {
                        // Lock both chain orderId and grid order ID to prevent concurrent modifications
                        const orderIds = [orderId, gridOrder.id].filter(Boolean);
                        mgr.lockOrders(orderIds);
                        try {
                            // Re-fetch to ensure we have latest state after acquiring lock
                            const currentGridOrder = mgr.orders.get(gridOrder.id);
                            if (currentGridOrder && currentGridOrder.orderId === orderId) {
                                const nextOrder = clearSize
                                    ? { ...virtualizeOrder(currentGridOrder), size: 0 }
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
                        const btsSide = (mgr.config.assetA === 'BTS') ? ORDER_TYPES.SELL : (mgr.config.assetB === 'BTS') ? ORDER_TYPES.BUY : null;
                        if (btsSide && btsFeeData?.cancelFee > 0) {
                            await mgr.accountant.adjustTotalBalance(btsSide, -btsFeeData.cancelFee, 'cancel-order-unmatched-fee');
                        }
                    }
                };
                // CRITICAL: same _gridLock rationale as the createOrder case above.
                if (options?.gridLockAlreadyHeld) {
                    await runCancel();
                } else if (mgr._gridLock && typeof mgr._gridLock.acquire === 'function') {
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
                    skipAccounting: false,
                    fillLockAlreadyHeld: options?.fillLockAlreadyHeld
                });

            case 'periodicBlockchainFetch': {
                // This source is used after fetchAccountTotals() has refreshed
                // authoritative chain free/locked totals. Applying optimistic
                // commitment deltas here double-deducts newly adopted or resized
                // open orders from already-fetched free balances.
                return this.syncFromOpenOrders(chainData, {
                    skipAccounting: true,
                    fillLockAlreadyHeld: options?.fillLockAlreadyHeld
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
            const { BitShares } = require('../bitshares_client');
            if (!BitShares || !BitShares.db) return;
            const accountIdOrName = mgr.accountId || mgr.account || null;
            if (!accountIdOrName) return;

            try { await this.initializeAssets(); } catch (err: any) { mgr.logger.log(`[SYNC] initializeAssets failed: ${err.message}`, 'warn'); }
            const assetAId = mgr.assets?.assetA?.id;
            const assetBId = mgr.assets?.assetB?.id;
            if (!assetAId || !assetBId) return;

            const { getOnChainAssetBalances } = require('../chain_orders');
            const { NATIVE_CLIENT } = require('../constants');
            const assetList = [assetAId, assetBId];

            // For non-BTS pairs, also fetch core asset (BTS) balance for fee management
            if (mgr.config.assetA !== 'BTS' && mgr.config.assetB !== 'BTS') {
                assetList.push(NATIVE_CLIENT.CHAIN.CORE_ASSET_ID);
            }

            const lookup = await getOnChainAssetBalances(accountIdOrName, assetList);
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
            mgr.logger.log(`Failed to fetch on-chain balances: ${err.message}`, 'warn');
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

        const { BitShares } = require('../bitshares_client');
        const fetchAssetWithFallback = async (symbol, side) => {
            try {
                return await lookupAsset(BitShares, symbol);
            } catch (err: any) {
                // If blockchain lookup fails, check for persisted fallback
                if (mgr.accountOrders) {
                    const persistedAssets = mgr.accountOrders.loadPersistedAssets();
                    const assetData = (side === 'A') ? persistedAssets?.assetA : persistedAssets?.assetB;

                    if (assetData && assetData.symbol === symbol && typeof assetData.precision === 'number') {
                        mgr.logger.log(`Blockchain lookup failed for ${symbol}: ${err.message}. Persisted data: id=${assetData.id}, precision=${assetData.precision} — refusing stale fallback`, 'error');
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
            mgr.logger.log(`Asset metadata lookup failed: ${err.message}`, 'error');
            throw err;
        }
    }
}

export = SyncEngine;
