/**
 * modules/order/strategy.ts - StrategyEngine
 *
 * Grid rebalancing and order placement strategy.
 * Exports a single StrategyEngine class implementing boundary-crawl pivot strategy.
 *
 * Strategy Approach:
 * - Simple & Robust Pivot Strategy (Boundary-Crawl Version)
 * - Maintains contiguous physical rails using a master boundary anchor
 * - Boundary fixed at market start price determines BUY/SELL/SPREAD zones
 * - Dynamically rebalances orders as grid prices change
 * - Handles partial fills and order consolidation
 *
 * ===============================================================================
 * TABLE OF CONTENTS - StrategyEngine Class
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor(manager) - Create new StrategyEngine with manager reference
 *
 * REBALANCING (1 method)
 *   2. calculateTargetGrid(params) - UNIFIED PURE TARGET CALCULATION
 *      Calculates the "Ideal State" based on current fills and market conditions.
 *      Returns: { targetGrid: Map, boundaryIdx: number }
 *      No side effects.
 *
 * ORDER PROCESSING (1 method)
 *   3. processFillsOnly(filledOrders, excludeOrderIds) - Process filled orders (async)
 *      Handles order fill events, fee accounting, and grid updates
 *      Consolidates partial fills, updates fund state. Does NOT trigger rebalancing.

 * FEE EVENT MANAGEMENT (2 methods - internal)
 *   4. _pruneSettledFeeEvents() - Evict expired fee event cache entries
 *   5. _buildFeeEventId(feeOp) - Build deduplication key for fee events

 * HEALTH CHECK (1 method)
 *   6. hasAnyDust(partials, side) - Check for dust (unhealthy) partial orders
 *      Detects partial orders below minimum size threshold
 *      Returns true if dust detected on side
 *
 * ===============================================================================
 *
 * BOUNDARY-CRAWL ALGORITHM:
 * 1. Find reference price (from fills or market)
 * 2. Calculate gap slots for spread zone
 * 3. Determine split index (boundary location in sorted price array)
 * 4. Assign roles:
 *    - BUY slots: below boundary (price < reference)
 *    - SPREAD slots: within gap
 *    - SELL slots: above boundary (price >= reference)
 * 5. Calculate order sizes based on budgeting
 * 6. Handle fills and consolidate partials
 *
 * ===============================================================================
 */

const { ORDER_TYPES, ORDER_STATES, PIPELINE_TIMING } = require("../constants");
const {
    virtualizeOrder,
    hasOnChainId,
    isOrderPlaced
} = require("./utils/order");
const { floatToBlockchainInt, getPrecisionByOrderType } = require('./utils/math');
const { calculateGapSlots, hasAnyDust } = require('./grid');

class StrategyEngine {
    manager: any;
    _settledFeeEvents: Map<string, number>;
    _feeEventTtlMs: number;
    _pruneCallCount: number;

    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager: any) {
        this.manager = manager;
        this._settledFeeEvents = new Map();
        this._feeEventTtlMs = Number(PIPELINE_TIMING.FEE_EVENT_DEDUP_TTL_MS);
        this._pruneCallCount = 0;
    }

    /**
     * Remove expired fee event cache entries by TTL.
     * @param {number} now - Current timestamp in ms
     * @returns {void}
     */
    _pruneSettledFeeEvents(now) {
        // Remove expired entries by TTL
        for (const [eventId, ts] of this._settledFeeEvents) {
            if (now - ts > this._feeEventTtlMs) {
                this._settledFeeEvents.delete(eventId);
            }
        }

        // Sampling: Only check size limit every N calls to avoid O(n log n) sort on every fill batch.
        // The expensive eviction (sort) is deferred until we're truly near the limit.
        this._pruneCallCount = (this._pruneCallCount || 0) + 1;
        const PRUNE_SAMPLE_INTERVAL = 10;
        const maxEvents = Math.max(1, PIPELINE_TIMING.MAX_FEE_EVENT_CACHE_SIZE);

        // Check every Nth call OR if we're already over the limit (to drain it down)
        const shouldCheckSize = (this._pruneCallCount % PRUNE_SAMPLE_INTERVAL === 0) ||
                                (this._settledFeeEvents.size > maxEvents);

        if (shouldCheckSize && this._settledFeeEvents.size > maxEvents) {
            // Convert to array sorted by timestamp (oldest first) - O(n log n)
            const entries = Array.from(this._settledFeeEvents.entries())
                .sort((a, b) => a[1] - b[1]);
            // Evict oldest entries to get back to target retention ratio
            const retentionRatio = Number.isFinite(PIPELINE_TIMING.CACHE_EVICTION_RETENTION_RATIO) && PIPELINE_TIMING.CACHE_EVICTION_RETENTION_RATIO > 0
                ? PIPELINE_TIMING.CACHE_EVICTION_RETENTION_RATIO
                : 0.75;
            const evictCount = this._settledFeeEvents.size - Math.floor(maxEvents * retentionRatio);
            for (let i = 0; i < evictCount && i < entries.length; i++) {
                this._settledFeeEvents.delete(entries[i][0]);
            }
            this.manager?.logger?.log?.(
                `[STRATEGY] Fee event cache exceeded ${maxEvents}, evicted ${evictCount} oldest entries`,
                'warn'
            );
        }
    }

    /**
     * Build a unique fee event ID from a filled order for deduplication.
     * @param {Object} filledOrder - Filled order object
     * @returns {string} Fee event deduplication key
     */
    _buildFeeEventId(filledOrder) {
        // Use integer blockchain representation for size to avoid float imprecision.
        // Precision is derived from order side and manager assets.
        let precision;
        try {
            if (this.manager?.assets && filledOrder?.type) {
                precision = getPrecisionByOrderType(this.manager.assets, filledOrder.type);
            }
        } catch (err: any) {
            this.manager?.logger?.log?.(
                `_buildFeeEventId: precision unavailable for ${filledOrder?.type}, falling back to size string: ${err.message}`,
                'debug'
            );
        }

        if (typeof precision !== 'number') {
            return filledOrder.historyId || [
                filledOrder.orderId || filledOrder.id,
                filledOrder.blockNum || 'na',
                String(filledOrder?.size || 0),
                filledOrder.isMaker === false ? 'taker' : 'maker'
            ].join(':');
        }

        const sizeInt = floatToBlockchainInt(Number(filledOrder?.size || 0), precision);
        return filledOrder.historyId || [
            filledOrder.orderId || filledOrder.id,
            filledOrder.blockNum || 'na',
            sizeInt,
            filledOrder.isMaker === false ? 'taker' : 'maker'
        ].join(':');
    }

    /**
     * Process filled orders: handle fills and consolidate partials.
     * Does NOT trigger rebalancing (now decoupled from rebalance logic).
     * 
     * This method handles the accounting side of fills without modifying
     * the grid structure. OrderManager invokes it before running COW rebalance.
     *
     * OPERATIONS PERFORMED:
     * 1. Validates and filters filled orders
     * 2. Virtualizes fully-filled slots (converts ACTIVE/PARTIAL to VIRTUAL)
     * 3. Calculates and deducts BTS fees (if BTS pair)
     * 4. Triggers fund recalculation
     *
     * FEE CALCULATION:
     * - For BTS trading pairs, calculates fees based on maker/taker status
     * - Maker fills: Lower fee rate
     * - Taker fills: Higher fee rate
     * - Fees are accumulated and deducted from available funds
     *
     * @param {Array<Object>} filledOrders - Array of filled order objects from blockchain
     *   - id {string}: Order slot ID
     *   - orderId {string}: Blockchain order ID
     *   - type {string}: 'BUY' or 'SELL'
     *   - price {number}: Order price
     *   - size {number}: Filled size
     *   - isPartial {boolean}: Whether this is a partial fill
     *   - isMaker {boolean}: Whether fill was maker (true) or taker (false)
     *   - isDelayedRotationTrigger {boolean}: Whether this triggers delayed rotation
     * @param {Set<string>} [excludeOrderIds=new Set()] - Order IDs to skip
     * @returns {Promise<boolean>} True if processing completed successfully
     * @async
     */
    async processFillsOnly(filledOrders, excludeOrderIds = new Set()) {
        const mgr = this.manager;
        if (!Array.isArray(filledOrders) || filledOrders.length === 0) return true;

        mgr.logger.log(`[STRATEGY] Processing batch of ${filledOrders.length} filled orders...`, 'info');

        const now = Date.now();
        this._pruneSettledFeeEvents(now);

        let fillsToSettle = 0;
        let makerFillCount = 0;
        let takerFillCount = 0;

        for (const filledOrder of filledOrders) {
            if (excludeOrderIds?.has?.(filledOrder.id)) {
                mgr.logger.log(`[STRATEGY] Skipping excluded fill for order ${filledOrder.id}`, 'debug');
                continue;
            }

            const isPartial = filledOrder.isPartial === true;
            mgr.logger.log(`[STRATEGY] Processing fill: id=${filledOrder.id}, type=${filledOrder.type}, price=${filledOrder.price}, size=${filledOrder.size}, partial=${isPartial}`, 'debug');

            if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                const feeEventId = this._buildFeeEventId(filledOrder);

                if (!this._settledFeeEvents.has(feeEventId)) {
                    this._settledFeeEvents.set(feeEventId, now);
                    fillsToSettle++;
                    if (filledOrder.isMaker !== false) makerFillCount++;
                    else takerFillCount++;
                } else {
                    mgr.logger.log(`[STRATEGY] Skipping duplicate fee settlement event ${feeEventId}`, 'debug');
                }

                const currentSlot = mgr.orders.get(filledOrder.id);
                const slotReused = currentSlot && hasOnChainId(currentSlot) && filledOrder.orderId && currentSlot.orderId !== filledOrder.orderId;

                if (currentSlot && !slotReused && isOrderPlaced(currentSlot) && currentSlot.size > 0) {
                    mgr.logger.log(`[STRATEGY] Virtualizing filled slot ${filledOrder.id}`, 'debug');
                    const ok = await mgr._updateOrder(
                        { ...virtualizeOrder(currentSlot), size: 0 },
                        'fill',
                        { skipAccounting: false, fee: 0 }
                    );
                    if (ok === false) {
                        mgr.logger.log(`[STRATEGY] Failed to virtualize filled slot ${filledOrder.id}`, 'warn');
                    }
                }
            }
        }

        // BTS operation fees are settled at operation time (create/update/cancel).
        // Fill proceeds already include maker refund projection via accounting, so
        // do not accrue/deduct additional fill-time BTS fees here.

        await mgr.recalculateFunds();
        mgr.logger.log(`[STRATEGY] Batch fill processing complete. Fills settled: ${fillsToSettle}`, 'info');
        return true;
    }

    /**
     * UNIFIED PURE TARGET CALCULATION
     * Calculates the "Ideal State" grid based on current fills and market conditions.
     * 
     * This is a PURE FUNCTION with no side effects. It takes the current state and
     * calculates what the grid SHOULD look like after rebalancing, without modifying
     * any actual state.
     *
     * ALGORITHM:
     * 1. Derive new boundary index based on fills (boundary crawl)
     * 2. Assign grid roles (BUY/SELL/SPREAD) based on boundary position
     * 3. Calculate budget allocation for each side
     * 4. Apply window discipline (activeOrders count limits)
     * 5. Calculate ideal order sizes based on budgets and weights
     * 6. Build target grid map representing desired state
     *
     * BOUNDARY CRAWL:
     * - BUY fills shift boundary LEFT (market moved down)
     * - SELL fills shift boundary RIGHT (market moved up)
     * - Spread gap is maintained between buy and sell zones
     *
     * WINDOW DISCIPLINE:
     * - Only targetCountBuy buy orders kept (closest to boundary)
     * - Only targetCountSell sell orders kept (closest to boundary)
     * - Excess orders are virtualized (size = 0)
     *
     * @param {Object} params - Calculation parameters
     * @param {Map} params.frozenMasterGrid - Immutable copy of current grid orders
     * @param {Object} params.config - Bot configuration
     *   - targetSpreadPercent {number}: Width of spread zone
     *   - incrementPercent {number}: Price step between orders
     *   - activeOrders {Object}: Target active order counts
     *   - weightDistribution {Object}: Size weighting for each side
     * @param {Object} params.accountAssets - Asset metadata (precision, IDs)
     * @param {Object} params.funds - Current fund state
     *   - available {Object}: Available funds per side
     *   - committed {Object}: Committed funds per side
     * @param {Array<Object>} params.fills - Recent fills that triggered calculation
     * @param {number} params.currentBoundaryIdx - Current boundary index
     * @returns {Object} Target grid state:
     *   - targetGrid {Map}: Map of slotId -> target order state
     *     - id {string}: Slot ID
     *     - price {number}: Order price
     *     - type {string}: 'BUY', 'SELL', or 'SPREAD'
     *     - size {number}: Target size (0 for virtualized orders)
     *     - state {string}: 'ACTIVE' or 'VIRTUAL'
     *   - boundaryIdx {number}: New boundary index
     */
    calculateTargetGrid(params: {
        frozenMasterGrid: Map<string, any>;
        config: any;
        accountAssets: any;
        funds: any;
        fills: any[];
        currentBoundaryIdx: number;
    }) {
        // Core params needed for calculation
        const { 
            frozenMasterGrid, 
            config, 
            accountAssets, 
            funds, 
            fills,
            currentBoundaryIdx 
        } = params;

        const { deriveTargetBoundary, getSideBudget, calculateBudgetedSizes } = require('./utils/order');
        const { assignGridRoles } = require('./utils/order');

        // Clone grid for local simulation (Target Grid)
        // We work with "slots" which are the potential order locations
        const allSlots = Array.from(frozenMasterGrid.values())
            .filter(o => o.price != null)
            .sort((a, b) => a.price - b.price)
            .map(o => ({ ...o })); // Shallow clone for simulation

        if (allSlots.length === 0) return { targetGrid: new Map(), boundaryIdx: currentBoundaryIdx };

        // 1. Determine new boundary based on fills (Boundary Crawl)
        const gapSlots = calculateGapSlots(config.incrementPercent, config.targetSpreadPercent, config.gridLimits);
        const newBoundaryIdx = deriveTargetBoundary(fills, currentBoundaryIdx, allSlots, config, gapSlots);

        // 2. Assign Roles (Buy/Sell/Spread)
        const updatedSlots = assignGridRoles(allSlots, newBoundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES, { assignOnChain: true });

        this.manager.logger.log(`[DEBUG] calculateTargetGrid: boundary=${newBoundaryIdx}, gap=${gapSlots}, allSlots=${updatedSlots.length}`, 'debug');
        updatedSlots.forEach((s) => this.manager.logger.log(`  Slot ${s.id}: price=${s.price}, size=${s.size ?? 'n/a'}, type=${s.type}`, 'debug'));

        // 3. Calculate Ideal Sizes (Budgeting)
        const totalTarget = Math.max(0, config.activeOrders?.buy ?? 1) + Math.max(0, config.activeOrders?.sell ?? 1);
        const budgetBuy = getSideBudget('buy', funds, config, totalTarget);
        const budgetSell = getSideBudget('sell', funds, config, totalTarget);
        
        // Filter slots into BUY/SELL
        const allBuySlots = updatedSlots.filter(o => o.type === ORDER_TYPES.BUY);
        const allSellSlots = updatedSlots.filter(o => o.type === ORDER_TYPES.SELL);

        // Apply Window Discipline (activeOrders count)
        const targetCountBuy = Math.max(1, (config.activeOrders?.buy ?? 1));
        const targetCountSell = Math.max(1, (config.activeOrders?.sell ?? 1));

        // Sort Closest-First for windowing
        const buySlots = allBuySlots
            .sort((a, b) => b.price - a.price)
            .slice(0, targetCountBuy);
        
        const sellSlots = allSellSlots
            .sort((a, b) => a.price - b.price)
            .slice(0, targetCountSell);
        
        // IMPORTANT:
        // Size distribution must be computed on the FULL side topology, not only
        // the active window. Otherwise budgets get concentrated into targetCount
        // slots (e.g., 3), producing absurd per-order sizes.
        const allBuySortedForSizing = [...allBuySlots].sort((a, b) => a.price - b.price);
        const allSellSortedForSizing = [...allSellSlots].sort((a, b) => a.price - b.price);

        const fullBuySizes = calculateBudgetedSizes(
            allBuySortedForSizing,
            'buy',
            budgetBuy,
            config.weightDistribution?.buy,
            config.incrementPercent,
            accountAssets
        );
        const fullSellSizes = calculateBudgetedSizes(
            allSellSortedForSizing,
            'sell',
            budgetSell,
            config.weightDistribution?.sell,
            config.incrementPercent,
            accountAssets
        );

        const buySizeById = new Map(allBuySortedForSizing.map((slot, i) => [slot.id, fullBuySizes[i] || 0]));
        const sellSizeById = new Map(allSellSortedForSizing.map((slot, i) => [slot.id, fullSellSizes[i] || 0]));

        const buySizes = buySlots.map(slot => buySizeById.get(slot.id) || 0);
        const sellSizes = sellSlots.map(slot => sellSizeById.get(slot.id) || 0);

        // Apply sizes to target grid map
        const targetGrid = new Map();
        
        const applySizes = (slots, sizes) => {
            slots.forEach((slot, i) => {
                const size = sizes[i] || 0;
                targetGrid.set(slot.id, {
                    id: slot.id,
                    price: slot.price,
                    type: slot.type,
                    size: size,
                    idealSize: size,
                    // If size > 0, we WANT it active. If size 0, we want it VIRTUAL/SPREAD
                    state: size > 0 ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    committedSide: (slot.type === ORDER_TYPES.BUY || slot.type === ORDER_TYPES.SELL)
                        ? slot.type
                        : slot.committedSide
                });
            });
        };

        applySizes(buySlots, buySizes);
        applySizes(sellSlots, sellSizes);
        
        // Handle slots outside the window: preserve their calculated sizes
        // Window Discipline only controls WHICH orders are placed on-chain,
        // not the grid's fund allocation. Virtual orders must retain their
        // sizes so that funds.virtual reflects the full grid commitment.
        const windowIds = new Set([...buySlots, ...sellSlots].map(s => s.id));
        updatedSlots.forEach(slot => {
            if (!windowIds.has(slot.id)) {
                // Use calculated size from full-rail sizing (preserves fund allocation)
                const calculatedSize = buySizeById.get(slot.id) ?? sellSizeById.get(slot.id) ?? slot.size ?? 0;
                targetGrid.set(slot.id, {
                    id: slot.id,
                    price: slot.price,
                    type: slot.type,
                    size: calculatedSize,
                    idealSize: calculatedSize,
                    state: ORDER_STATES.VIRTUAL,
                    committedSide: (slot.type === ORDER_TYPES.BUY || slot.type === ORDER_TYPES.SELL)
                        ? slot.type
                        : slot.committedSide
                });
            }
        });

        return { 
            targetGrid: targetGrid,
            boundaryIdx: newBoundaryIdx 
        }; 
    }

    /**
     * Check for dust (unhealthy) partial orders on a side.
     *
     * A "dust" order is a partial fill that has remaining size below the minimum
     * viable order size for the asset. These orders are problematic because:
     * - They cannot be rotated (new order would be below minimum)
     * - They tie up small amounts of capital inefficiently
     * - They may indicate grid misconfiguration
     *
     * DETECTION LOGIC:
     * - Compares remaining size against asset-specific minimums
     * - Uses doubled thresholds when side has doubled orders
     * - Considers both absolute and relative minimums
     *
     * @param {Array<Object>} partials - Array of partial order objects
     *   - id {string}: Order slot ID
     *   - orderId {string}: Blockchain order ID
     *   - type {string}: 'BUY' or 'SELL'
     *   - price {number}: Order price
     *   - size {number}: Current remaining size
     *   - state {string}: Should be 'PARTIAL'
     * @param {string} side - Side to check ('buy' or 'sell')
     * @returns {boolean} True if any partial on the side is below minimum viable size
     */
    hasAnyDust(partials, side) {
        const mgr = this.manager;
        return hasAnyDust(mgr, partials, side);
    }

}

export = StrategyEngine;
