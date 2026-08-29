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


import { ORDER_TYPES, ORDER_STATES, ANCHOR } from '../constants.js';
import { calculateGapSlots } from './grid.js';
import { isSlotInRail } from './utils/math.js';
import { deriveTargetBoundary, isShiftEligibleFill, resolveFillPrice, getSideBudget, calculateBudgetedSizes, getActiveOrdersTotal, projectAnchorToGrid, isMarketAnchorAvailable, isMarketAnchorFresh, computeAnchorDivergence, calculateFundDrivenBoundary } from './utils/order.js';
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

        // 1. Determine new boundary based on fills (Boundary Crawl + price-first projection)
        // Use the stored gapSlots from grid creation (always consistent with
        // the grid geometry) instead of recomputing from live config which may
        // have drifted if targetSpreadPercent or gridLimits changed.
        const gapSlots = this.manager._gapSlots ?? calculateGapSlots(config.incrementPercent, config.targetSpreadPercent, config.gridLimits);

        // Phase 1 shadow telemetry + Phase 2 projection (price-first alignment)
        // Shadow telemetry always runs (flag off = divergence histogram), projection gated by flag.
        const anchor = (this.manager as any)._marketAnchor || null;
        const projectionEnabled = (() => {
            const cfgA = (this.manager as any).config?.anchor?.projectionEnabled;
            if (typeof cfgA === 'boolean') return cfgA;
            const cfgB = (this.manager as any).config?.projectionEnabled;
            if (typeof cfgB === 'boolean') return cfgB;
            return ANCHOR?.PROJECTION_ENABLED === true;
        })();
        let projectedBoundary: number | null = null;
        let anchorDivergence: number | null = null;
        try {
            if (anchor && isMarketAnchorAvailable(anchor)) {
                projectedBoundary = projectAnchorToGrid(anchor, allSlots, gapSlots);
                if (Number.isFinite(projectedBoundary as any) && Number.isFinite(currentBoundaryIdx as any)) {
                    anchorDivergence = computeAnchorDivergence(projectedBoundary, currentBoundaryIdx);
                    if (anchorDivergence != null && Math.abs(anchorDivergence) > ANCHOR.DIVERGENCE_INFO) {
                        // Rate-limit divergence telemetry: a persistent drift would
                        // otherwise log every calculateTargetGrid call. A 60s sample
                        // still yields the Phase-1 divergence histogram.
                        const mgr: any = this.manager;
                        const now = Date.now();
                        const rateLimitMs = mgr?.config?.timing?.STALE_TOTALS_WARN_RATE_LIMIT_MS ?? 60000;
                        if (now - (mgr._lastAnchorDivergenceLogAt ?? 0) >= rateLimitMs) {
                            mgr._lastAnchorDivergenceLogAt = now;
                            const level = Math.abs(anchorDivergence) > ANCHOR.DIVERGENCE_WARN ? 'warn' : 'info';
                            this.manager.logger.log(`[ANCHOR-DIVERGENCE] projected=${projectedBoundary} bookkept=${currentBoundaryIdx} drift=${anchorDivergence}`, level);
                        }
                    }
                }
                // Stale-anchor still projects (does not fall back to count crawl per plan).
                // Rate-limit stale telemetry to avoid spamming every calculateTargetGrid call.
                try {
                    let curPrice: number | null = null;
                    // Prefer live AMA center when gridPrice:ama — startPrice is often "pool"/"book"
                    // (non-finite) or static; the AMA center moves, so isMarketAnchorFresh must track it.
                    try {
                        const usesAma = (() => {
                            try { return require('../grid_price_source.js').usesAmaGridPrice(config); } catch { return false; }
                        })();
                        if (usesAma) {
                            try {
                                const sys = require('./utils/system.js');
                                const live = sys.loadAmaCenterPrice?.(this.manager?.config?.botKey)
                                    ?? sys.loadAmaCenterSnapshot?.(this.manager?.config?.botKey)?.gridCenterPrice;
                                if (Number.isFinite(Number(live)) && Number(live) > 0) curPrice = Number(live);
                            } catch {}
                        }
                    } catch {}
                    if (curPrice == null) {
                        curPrice = Number.isFinite(Number(config.startPrice)) ? Number(config.startPrice) : (Number.isFinite(anchor.lastFillPrice as any) ? Number(anchor.lastFillPrice) : null);
                    }
                    const incPct = Number(config.incrementPercent);
                    if (!isMarketAnchorFresh(anchor, curPrice, incPct)) {
                        const mgr: any = this.manager;
                        const now = Date.now();
                        const lastWarn = mgr._lastAnchorStaleWarnAt ?? 0;
                        const rateLimitMs = mgr?.config?.timing?.STALE_TOTALS_WARN_RATE_LIMIT_MS ?? 60000;
                        if (now - lastWarn >= rateLimitMs) {
                            mgr._lastAnchorStaleWarnAt = now;
                            this.manager.logger.log(`[ANCHOR-STALE] anchor stale age=${anchor.updatedAt ? Date.now() - anchor.updatedAt : 'unknown'}ms lastPrice=${anchor.lastFillPrice} range=[${anchor.minFilledBuyPrice},${anchor.maxFilledSellPrice}] — continuing projection from last known range`, 'info');
                        }
                    }
                } catch (_: any) {}
            }
        } catch (_: any) {}

        const crossChunkBudget = (this.manager as any)._boundaryShiftBudget;
        const burstTarget = (this.manager as any)._boundaryTarget;
        const { boundaryIdx: legacyBoundaryIdx, remainingBudget } = deriveTargetBoundary(fills, currentBoundaryIdx, allSlots, config, gapSlots, crossChunkBudget, burstTarget);
        if (crossChunkBudget != null) {
            (this.manager as any)._boundaryShiftBudget = remainingBudget;
        }

        // Phase 2: choose boundary — price-first projection when available, otherwise legacy
        let newBoundaryIdx = legacyBoundaryIdx;
        if (projectionEnabled && projectedBoundary != null) {
            // D1 fund floor: price truth is primary; funds may pull the projected
            // boundary toward the affordable rail by at most half an active window,
            // never past the fund rail itself. Uses accounting-available funds
            // (manager.funds.available) — the same "free" notion syncBoundaryToFunds
            // balances against — falling back to chain-free snapshot values.
            // When no funds data exists yet (both sides 0/unknown), the pull is
            // skipped entirely: calculateFundDrivenBoundary would fabricate a
            // mid-grid rail, and D1 routes severe shortfalls into sizing, not
            // boundary location.
            try {
                const snap = typeof this.manager.getChainFundsSnapshot === 'function' ? this.manager.getChainFundsSnapshot() : null;
                const pick = (...candidates: any[]) => {
                    for (const c of candidates) {
                        const n = Number(c);
                        if (Number.isFinite(n)) return n;
                    }
                    return null;
                };
                const availA = pick((this.manager as any).funds?.available?.sell, funds?.available?.sell, snap?.chainFreeSell);
                const availB = pick((this.manager as any).funds?.available?.buy, funds?.available?.buy, snap?.chainFreeBuy);
                const price = this.manager.config?.startPrice;
                let fundIdx: number | null = null;
                if (availA != null && availB != null && (availA > 0 || availB > 0)
                    && Number.isFinite(price as any) && allSlots.length > 0) {
                    fundIdx = calculateFundDrivenBoundary(allSlots, availA, availB, price, gapSlots);
                }
                if (Number.isFinite(fundIdx as any)) {
                    const wSell = Math.max(1, Math.floor(config.activeOrders?.sell ?? 1));
                    const wBuy = Math.max(1, Math.floor(config.activeOrders?.buy ?? 1));
                    const halfWindow = Math.max(Math.floor(wSell / 2), Math.floor(wBuy / 2), 1);
                    const diff = (fundIdx as number) - (projectedBoundary as number);
                    if (diff !== 0) {
                        const pull = Math.sign(diff) * Math.min(Math.abs(diff), halfWindow);
                        const constrained = (projectedBoundary as number) + pull;
                        if (diff > 0) newBoundaryIdx = Math.min(constrained, fundIdx as number);
                        else newBoundaryIdx = Math.max(constrained, fundIdx as number);
                    } else {
                        newBoundaryIdx = projectedBoundary as number;
                    }
                } else {
                    newBoundaryIdx = projectedBoundary as number;
                }
            } catch (_: any) {
                newBoundaryIdx = projectedBoundary as number;
            }
            // I4 ceiling clamp (gap-aware) — degenerate geometry falls back to legacy ceiling
            {
                const floorGap = Math.floor(Number(gapSlots) || 0);
                const gapAwareCeiling = allSlots.length - floorGap - 1;
                const legacyCeiling = allSlots.length - 1;
                const ceiling = gapAwareCeiling >= 0 ? gapAwareCeiling : Math.max(legacyCeiling, Number(currentBoundaryIdx ?? 0));
                newBoundaryIdx = Math.max(0, Math.min(ceiling, newBoundaryIdx));
            }
            // Stale-anchor continues projection (does not fall back to count crawl);
            // count crawl remains only for truly price-less fills (I5 via legacy path when anchor cold).
        }

        // 1b. Placement guard (defense-in-depth): no re-created order may sit
        // on the wrong side of a just-filled price. A SELL slot at or below
        // the highest filled SELL price is immediately marketable (the book
        // traded through it) and economically inverted; the same holds for a
        // BUY slot strictly above the lowest filled BUY price. Rotate such
        // slots to the opposite rail BEFORE windowing and sizing so
        // reconcile cancels the toxic order and replaces it across the
        // spread. Asymmetry is intentional: re-creating a BUY at exactly the
        // filled price is the standard anchor-refill rotation, while a SELL
        // at/below the filled price would dump into a market that just paid
        // more. This holds the invariant even when the boundary is stale
        // (stale-plan re-plans, recovery paths, price-less fills).
        const guardSlotById = new Map(allSlots.map((s: any) => [s.id, s]));
        let maxFilledSellPrice: number | null = null;
        let minFilledBuyPrice: number | null = null;
        for (const fill of fills) {
            if (!isShiftEligibleFill(fill)) continue;
            const price = resolveFillPrice(fill, guardSlotById);
            if (price == null) continue;
            if (fill.type === ORDER_TYPES.SELL) {
                if (maxFilledSellPrice == null || price > maxFilledSellPrice) maxFilledSellPrice = price;
            } else if (fill.type === ORDER_TYPES.BUY) {
                if (minFilledBuyPrice == null || price < minFilledBuyPrice) minFilledBuyPrice = price;
            }
        }

        // 2. Assign Roles (Buy/Sell/Spread)
        const updatedSlots = assignGridRoles(allSlots, newBoundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES, { assignOnChain: true });

        let rotatedToBuy = 0;
        let rotatedToSell = 0;
        if (maxFilledSellPrice != null) {
            for (const slot of updatedSlots) {
                if (slot.type === ORDER_TYPES.SELL && Number(slot.price) <= maxFilledSellPrice) {
                    slot.type = ORDER_TYPES.BUY;
                    rotatedToBuy++;
                }
            }
        }
        if (minFilledBuyPrice != null) {
            for (const slot of updatedSlots) {
                if (slot.type === ORDER_TYPES.BUY && Number(slot.price) > minFilledBuyPrice) {
                    slot.type = ORDER_TYPES.SELL;
                    rotatedToSell++;
                }
            }
        }
        if (rotatedToBuy > 0 || rotatedToSell > 0) {
            this.manager.logger.log(
                `[PLACEMENT-GUARD] Rotated ${rotatedToBuy} sell slot(s) at/below max filled sell price ` +
                `${maxFilledSellPrice != null ? maxFilledSellPrice.toPrecision(6) : 'n/a'} to BUY, ` +
                `${rotatedToSell} buy slot(s) at/above min filled buy price ` +
                `${minFilledBuyPrice != null ? minFilledBuyPrice.toPrecision(6) : 'n/a'} to SELL.`,
                'warn'
            );
        }

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

        // Sort Closest-First for windowing
        const buySlots = allBuySlots
            .filter(inBuyRail)
            .sort((a: any, b: any) => b.price - a.price)
            .slice(0, targetCountBuy);
        
        const sellSlots = allSellSlots
            .filter(inSellRail)
            .sort((a: any, b: any) => a.price - b.price)
            .slice(0, targetCountSell);
        
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

        const buySizes = buySlots.map((slot: any) => buySizeById.get(slot.id) || 0);
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

        applySizes(buySlots, buySizes);
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
