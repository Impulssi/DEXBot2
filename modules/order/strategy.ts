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
 *      Fill deduplication (replay safety, fee-event) is handled upstream by
 *      the manager's processedFillTracker — this class is stateless w.r.t. dedup.
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


import { ORDER_TYPES, ORDER_STATES } from '../constants.js';

import { calculateGapSlots } from './grid.js';
import { isSlotInRail, resolveBuyFloorUsdt, resolveBuyDelayMs, resolveBuyWindowMode } from './utils/math.js';
import { deriveTargetBoundary, getSideBudget, calculateBudgetedSizes, getActiveOrdersTotal } from './utils/order.js';
import { assignGridRoles } from './utils/order.js';
import {
    convertToSpreadPlaceholder,
    hasOnChainId,
    isOrderPlaced
} from "./utils/order.js";

class StrategyEngine {
    manager: any;

    /**
     * @param {Object} manager - OrderManager instance
     */
    constructor(manager: any) {
        this.manager = manager;
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
    async processFillsOnly(filledOrders: any, excludeOrderIds: any = new Set()) {
        const mgr = this.manager;
        if (!Array.isArray(filledOrders) || filledOrders.length === 0) return true;

        mgr.logger.log(`[STRATEGY] Processing batch of ${filledOrders.length} filled orders...`, 'info');

        for (const filledOrder of filledOrders) {
            if (excludeOrderIds?.has?.(filledOrder.id)) {
                mgr.logger.log(`[STRATEGY] Skipping excluded fill for order ${filledOrder.id}`, 'debug');
                continue;
            }

            const isPartial = filledOrder.isPartial === true;
            mgr.logger.log(`[STRATEGY] Processing fill: id=${filledOrder.id}, type=${filledOrder.type}, price=${filledOrder.price}, size=${filledOrder.size}, partial=${isPartial}`, 'debug');

            // Buy-delay bookkeeping: any BUY fill (full or delayed-rotation
            // partial) arms the buy-side delay (config buyDelayMinutes,
            // default 15) used by calculateTargetGrid.
            // DEADLINE semantics: re-arm only when the previous window has fully
            // expired. A sliding re-arm lets live sub-floor dust orders (which
            // keep filling on every oscillation) postpone new buys forever.
            if (filledOrder.type === ORDER_TYPES.BUY) {
                const mgrAny = mgr as any;
                const delayMs = resolveBuyDelayMs(mgr?.config);
                if (delayMs > 0) {
                    const prev = mgrAny._lastBuyFillTime || 0;
                    if (prev === 0 || (Date.now() - prev) >= delayMs) {
                        mgrAny._lastBuyFillTime = Date.now();
                        mgr.logger.log(`[STRATEGY] Buy fill detected — buy-side updates paused ${delayMs / 1000 |0}s`, 'info');
                    }
                }
            }

            if (!isPartial || filledOrder.isDelayedRotationTrigger) {
                const currentSlot = mgr.orders.get(filledOrder.id);
                const slotReused = currentSlot && hasOnChainId(currentSlot) && filledOrder.orderId && currentSlot.orderId !== filledOrder.orderId;

                if (currentSlot && !slotReused && isOrderPlaced(currentSlot) && currentSlot.size > 0) {
                    mgr.logger.log(`[STRATEGY] Virtualizing filled slot ${filledOrder.id}`, 'debug');
                    const ok = await mgr._updateOrder(
                        convertToSpreadPlaceholder(currentSlot),
                        'fill',
                        { skipAccounting: false, fee: 0 }
                    );
                    if (ok === false) {
                        mgr.logger.log(`[STRATEGY] Failed to virtualize filled slot ${filledOrder.id}; marking totals stale for next sync cycle`, 'warn');
                        mgr.accountTotalsStale = true;
                    }
                }
            }
        }

        // BTS operation fees are settled at operation time (create/update/cancel).
        // Fill proceeds already include maker refund projection via accounting, so
        // do not accrue/deduct additional fill-time BTS fees here.

        await mgr.recalculateFunds();
        return true;
    }

    /**
     * UNIFIED TARGET CALCULATION
     * Calculates the "Ideal State" grid based on current fills and market conditions.
     * 
     * This is NOT a pure function. Besides computing what the grid SHOULD look
     * like after rebalancing, it reads and mutates manager boundary budget
     * state: it consumes manager._gapSlots / manager._boundaryShiftBudget and
     * writes the remaining cross-chunk shift budget back to
     * manager._boundaryShiftBudget (boundary-crawl bookkeeping).
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


        // Clone grid for local simulation (Target Grid)
        // We work with "slots" which are the potential order locations
        const allSlots = Array.from(frozenMasterGrid.values())
            .filter((o: any) => o.price != null)
            .sort((a: any, b: any) => a.price - b.price)
            .map((o: any) => ({ ...o })); // Shallow clone for simulation

        if (allSlots.length === 0) return { targetGrid: new Map(), boundaryIdx: currentBoundaryIdx };

        // 1. Determine new boundary based on fills (Boundary Crawl)
        // Use the stored gapSlots from grid creation (always consistent with
        // the grid geometry) instead of recomputing from live config which may
        // have drifted if targetSpreadPercent or gridLimits changed.
        const gapSlots = (this.manager as any)._genesis?.gapSlots ?? this.manager._gapSlots ?? calculateGapSlots(config.incrementPercent, config.targetSpreadPercent, config.gridLimits);
        const crossChunkBudget = (this.manager as any)._boundaryShiftBudget;
        const { boundaryIdx: newBoundaryIdx, remainingBudget } = deriveTargetBoundary(fills, currentBoundaryIdx, allSlots, config, gapSlots, crossChunkBudget);
        if (crossChunkBudget != null) {
            (this.manager as any)._boundaryShiftBudget = remainingBudget;
        }

        // 2. Assign Roles (Buy/Sell/Spread)
        const updatedSlots = assignGridRoles(allSlots, newBoundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES, { assignOnChain: true });

        this.manager.logger.log(`[DEBUG] calculateTargetGrid: boundary=${newBoundaryIdx}, gap=${gapSlots}, allSlots=${updatedSlots.length}`, 'debug');
        updatedSlots.forEach((s: any) => this.manager.logger.log(`  Slot ${s.id}: price=${s.price}, size=${s.size ?? 'n/a'}, type=${s.type}`, 'debug'));

        // 3. Calculate Ideal Sizes (Budgeting)
        const totalTarget = getActiveOrdersTotal(config);
        const budgetBuy = getSideBudget('buy', funds, config, totalTarget);
        const budgetSell = getSideBudget('sell', funds, config, totalTarget);
        
        // Filter slots into BUY/SELL
        const allBuySlots = updatedSlots.filter((o: any) => o.type === ORDER_TYPES.BUY);
        const allSellSlots = updatedSlots.filter((o: any) => o.type === ORDER_TYPES.SELL);

        // Apply Window Discipline (activeOrders count)
        const targetCountBuy = Math.max(1, (config.activeOrders?.buy ?? 1));
        const targetCountSell = Math.max(1, (config.activeOrders?.sell ?? 1));

        // The SPREAD GUARD (assignGridRoles) keeps a live on-chain order typed
        // BUY/SELL even when a boundary crawl moves its slot into the spread
        // band (to avoid the illegal SPREAD+ACTIVE state). Such a stray slot
        // must NOT be counted in the active window: otherwise the window keeps
        // the rail parked in its old position and an on-chain sell gets left
        // inside the gap (spread removed). Exclude stray slots by geometry
        // (shared MathUtils.isSlotInRail helper) so reconcile treats them as
        // surplus and relocates them back onto the rail.
        const inBuyRail = (o: any) => isSlotInRail(newBoundaryIdx, gapSlots, ORDER_TYPES.BUY, o);
        const inSellRail = (o: any) => isSlotInRail(newBoundaryIdx, gapSlots, ORDER_TYPES.SELL, o);

        // Buy window placement (config buyWindowMode, default 'low'):
        // - 'low': farthest (lowest) buys in the rail — static low ladder that
        //   never crawls to the ceiling with the boundary.
        // - 'closest': upstream behavior — closest to the boundary.
        // Buy-side delay (config buyDelayMinutes, default 15, 0 = off) arms in
        // processFillsOnly on any BUY fill and holds new buys virtual here;
        // sell side is immediate.
        const buyDelayMs = resolveBuyDelayMs(config);
        const lastBuyTime = (this.manager as any)._lastBuyFillTime || 0;
        const buyDelayActive = buyDelayMs > 0 && lastBuyTime !== 0 && (Date.now() - lastBuyTime) < buyDelayMs;
        if (buyDelayActive) {
            this.manager.logger.log(`[STRATEGY] Buy delay active: ${((buyDelayMs - (Date.now() - lastBuyTime))/1000 |0)}s remaining, keeping buys virtual`, 'info');
        }
        // Sort Farthest-First for BUY windowing, then collapse duplicate price
        // levels before slicing so the active window keeps as many
        // unique-priced slots as the target count allows. Same robustness
        // guard as upstream's snapRail (duplicate levels after rotation
        // re-typing), but anchored at the RAIL BOTTOM so the ladder never
        // crawls to the boundary. SELL keeps upstream closest-first.
        const windowLow = resolveBuyWindowMode(config) !== 'closest';
        const buyCandidates = allBuySlots
            .filter(inBuyRail)
            .sort((a: any, b: any) => windowLow ? a.price - b.price : b.price - a.price);
        const sellCandidates = allSellSlots
            .filter(inSellRail)
            .sort((a: any, b: any) => a.price - b.price);

        const snapRail = (slots: any[], dir: number) => {
            const kept: any[] = [];
            for (const s of slots) {
                if (!kept.some((k: any) => k.id === s.id)) kept.push(s);
                else if (!isOrderPlaced(kept.find((k: any) => k.id === s.id)) && isOrderPlaced(s)) {
                    const idx = kept.findIndex((k: any) => k.id === s.id);
                    kept[idx] = s;
                }
            }
            kept.sort((a: any, b: any) => dir > 0 ? Number(a.price) - Number(b.price) : Number(b.price) - Number(a.price));
            return kept;
        };

        // dir +1 for BUY in 'low' mode = farthest-first (rail bottom);
        // 'closest' mode sorts descending via buyCandidates above. buySlotsRaw
        // is the window; the deadline delay empties it while armed (sell side
        // unaffected).
        const buySlotsRaw = snapRail(buyCandidates, windowLow ? +1 : -1).slice(0, targetCountBuy);
        const buySlots = buyDelayActive ? [] : buySlotsRaw;
        const sellSlots = snapRail(sellCandidates, +1).slice(0, targetCountSell);
        
        // IMPORTANT:
        // Size distribution must be computed on the FULL side topology, not only
        // the active window. Otherwise budgets get concentrated into targetCount
        // slots (e.g., 3), producing absurd per-order sizes.
        const allBuySortedForSizing = [...allBuySlots].sort((a: any, b: any) => a.price - b.price);
        const allSellSortedForSizing = [...allSellSlots].sort((a: any, b: any) => a.price - b.price);

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

        const buySizeById = new Map(allBuySortedForSizing.map((slot: any, i: any) => [slot.id, fullBuySizes[i] || 0]));
        const sellSizeById = new Map(allSellSortedForSizing.map((slot: any, i: any) => [slot.id, fullSellSizes[i] || 0]));

        // Minimum BUY size (config buyFloorUSDT, default 1.0, 0 = off): skip
        // buys below the floor. Keeps remaining funds as free
        // (virtualReservation not locked) instead of shrinking all orders
        // to 0.45, 0.30, ... as fills eat the budget.
        // NOTE: BUY slot sizes are already denominated in the quote asset
        // (USDT) — the size IS the notional, do NOT multiply by price.
        const buyFloorUsdt = resolveBuyFloorUsdt(config);
        const filteredBuySlots: any[] = [];
        buySlots.forEach((slot: any) => {
            const sz = buySizeById.get(slot.id) || 0;
            if (!(buyFloorUsdt > 0) || sz >= buyFloorUsdt) {
                filteredBuySlots.push(slot);
            } else if (sz > 0) {
                this.manager.logger.log(`[STRATEGY] Skipping buy ${slot.id} @${Number(slot.price).toPrecision(4)} size ${sz.toFixed(3)} USDT < ${buyFloorUsdt} USDT minimum`, 'info');
            }
        });
        const buySlotsToUse = filteredBuySlots;
        const buySizes = buySlotsToUse.map((slot: any) => buySizeById.get(slot.id) || 0);
        const sellSizes = sellSlots.map((slot: any) => sellSizeById.get(slot.id) || 0);

        // Apply sizes to target grid map
        const targetGrid = new Map();
        
        const applySizes = (slots: any, sizes: any) => {
            slots.forEach((slot: any, i: any) => {
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

        applySizes(buySlotsToUse, buySizes);
        applySizes(sellSlots, sellSizes);
        
        // Handle slots outside the window: preserve their calculated sizes
        // Window Discipline only controls WHICH orders are placed on-chain,
        // not the grid's fund allocation. Virtual orders must retain their
        // sizes so that funds.virtual reflects the full grid commitment.
        const windowIds = new Set([...buySlots, ...sellSlots].map((s: any) => s.id));
        updatedSlots.forEach((slot: any) => {
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

}

export default StrategyEngine
