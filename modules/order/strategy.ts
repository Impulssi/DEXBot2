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
import { deriveTargetBoundary, isShiftEligibleFill, resolveFillPrice, deriveAnchorBounds, getSideBudget, calculateBudgetedSizes, getActiveOrdersTotal, projectAnchorToGrid, isMarketAnchorAvailable, isMarketAnchorFresh, computeAnchorDivergence } from './utils/order.js';
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

        // Anchor shadow telemetry (price-first alignment, Phase 1). The fills-
        // derived price anchor is used ONLY for observability ([ANCHOR-DIVERGENCE]
        // / [ANCHOR-STALE]); it must never override the boundary — the boundary
        // is derived from chain evidence and the burst-fill price correction in
        // deriveTargetBoundary. The Phase-2 projection override has been removed.
        const anchor = (this.manager as any)._marketAnchor || null;
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
        // Outlier guard: fill prices resolved from stale slot state must not
        // drag the burst correction to a far rail. Bound candidate prices to
        // the anchor's established range (same guard the anchor update uses).
        const outlierBounds = deriveAnchorBounds(anchor, ANCHOR.PRICE_OUTLIER_FACTOR);
        const { boundaryIdx: legacyBoundaryIdx, remainingBudget } = deriveTargetBoundary(fills, currentBoundaryIdx, allSlots, config, gapSlots, crossChunkBudget, burstTarget, outlierBounds);
        if (crossChunkBudget != null) {
            (this.manager as any)._boundaryShiftBudget = remainingBudget;
        }

        // Boundary remains the legacy count-crawl result, price-corrected by the
        // burst-fill anchor inside deriveTargetBoundary. The fills-derived price
        // anchor is intentionally NOT used to override the boundary here: it is
        // not chain-authoritative and previously placed opposite-side orders on
        // the wrong side of the market (new sell below the highest sell, etc.).
        const newBoundaryIdx = legacyBoundaryIdx;

        // 1c. Swept-band exclusion (replaces the removed placement guard).
        // When the boundary is budget-frozen, the price-anchored boundary
        // correction cannot clear a band the book just traded through, and
        // stale live orders survive INSIDE the swept range. Rather than
        // re-typing slots in place — which kept the stale slot price and
        // instantly self-crossed the opposite rail during chunked
        // broadcasts (production incident: multiple self-fills, large COW
        // plans flip-flopping every ~30s on batch-local extremes, fatal
        // fund assertion) — slots priced inside the filled band are
        // excluded from the active-window rails: they fall out of the
        // window (target VIRTUAL), reconcile cancels the stranded live
        // orders, and the window re-forms OUTSIDE the band. A cancel-only
        // transition cannot self-trade, and the COW-layer crossing guard
        // (findCrossedOrder) covers the re-placement side.
        // Burst-global: the swept band must span the WHOLE burst's sweep
        // [minBuy,maxSell], not a per-chunk local max. 15 sells 894->902
        // previously chunked gave chunk1 max 870 -> window still contained
        // 894, chunk4 with budget 0 -> Actions=0. The manager caches the
        // burst-global band at batch start; fall back to this chunk's fills
        // when it is absent.
        let maxFilledSellPrice: number | null = (this.manager as any)._burstSweptMaxSell ?? null;
        let minFilledBuyPrice: number | null = (this.manager as any)._burstSweptMinBuy ?? null;
        const hasBurstBand = maxFilledSellPrice != null || minFilledBuyPrice != null;
        if (!hasBurstBand) {
            const slotById = new Map(allSlots.map((s: any) => [s.id, s]));
            for (const fill of fills) {
                if (!isShiftEligibleFill(fill)) continue;
                const price = resolveFillPrice(fill, slotById, outlierBounds);
                if (price == null) continue;
                if (fill.type === ORDER_TYPES.SELL) {
                    if (maxFilledSellPrice == null || price > maxFilledSellPrice) maxFilledSellPrice = price;
                } else if (fill.type === ORDER_TYPES.BUY) {
                    if (minFilledBuyPrice == null || price < minFilledBuyPrice) minFilledBuyPrice = price;
                }
            }
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
        // Exclusion predicates: a slot priced inside the filled band is not
        // window-eligible even when geometry still places it on the rail
        // (budget-frozen boundary). Applied AFTER the SPREAD GUARD keeps
        // live orders typed, so exclusion only removes them from the
        // window — reconcile cancels them as surplus, types stay intact.
        // Asymmetry (inherited from the removed guard): a SELL at or below
        // the highest filled sell price is stranded (the market traded
        // through it and paid more), while a BUY strictly above the lowest
        // filled buy price is stranded but a BUY AT the filled price is the
        // standard anchor-refill rotation and must stay window-eligible.
        const burstSellCount = (this.manager as any)._burstSweptSellCount ??
            fills.filter((f: any) => isShiftEligibleFill(f) && f.type === ORDER_TYPES.SELL).length;
        const multiFillSellSweep = burstSellCount >= 2;
        const sweptSell = (o: any) => maxFilledSellPrice != null && Number(o.price) <= maxFilledSellPrice;
        const sweptBuy = (o: any) =>
            (minFilledBuyPrice != null && Number(o.price) > minFilledBuyPrice) ||
            (multiFillSellSweep && maxFilledSellPrice != null && Number(o.price) > maxFilledSellPrice);
        const bandExcludedSells = allSellSlots.filter((o: any) => isSlotInRail(newBoundaryIdx, gapSlots, ORDER_TYPES.SELL, o) && sweptSell(o)).length;
        const bandExcludedBuys = allBuySlots.filter((o: any) => isSlotInRail(newBoundaryIdx, gapSlots, ORDER_TYPES.BUY, o) && sweptBuy(o)).length;
        if (bandExcludedSells > 0 || bandExcludedBuys > 0) {
            this.manager.logger.log(
                `[BAND-EXCLUSION] Excluded ${bandExcludedSells} sell slot(s) at/below the highest filled sell price ` +
                `${maxFilledSellPrice != null ? maxFilledSellPrice.toPrecision(6) : 'n/a'} and ` +
                `${bandExcludedBuys} buy slot(s) above the swept band edge ` +
                `${maxFilledSellPrice != null && multiFillSellSweep ? maxFilledSellPrice.toPrecision(6) : (minFilledBuyPrice != null ? minFilledBuyPrice.toPrecision(6) : 'n/a')} ` +
                `from the active window; stranded live orders will be cancelled and the rail re-forms outside the swept band.`,
                'info'
            );
        }
        const inBuyRail = (o: any) => isSlotInRail(newBoundaryIdx, gapSlots, ORDER_TYPES.BUY, o) && !sweptBuy(o);
        const inSellRail = (o: any) => isSlotInRail(newBoundaryIdx, gapSlots, ORDER_TYPES.SELL, o) && !sweptSell(o);

        // Sort Closest-First for windowing, then collapse duplicate price levels
        // before slicing so the active window keeps as many unique-priced
        // slots as the target count allows.
        const buyCandidates = allBuySlots
            .filter(inBuyRail)
            .sort((a: any, b: any) => b.price - a.price);
        const sellCandidates = allSellSlots
            .filter(inSellRail)
            .sort((a: any, b: any) => a.price - b.price);

        // Robustness by construction: enforce strict monotonicity and unique
        // price levels on the WINDOWED rails. Grid geometry is monotonic by
        // construction, but rotation (anchor-refill re-typing) can place two
        // slots at the same price level (production incident: 902.08089 x2,
        // 894.01113 x3 after a 15-sell burst).
        //
        // UPDATE-NOT-CANCEL: the straggler is RE-PRICED to a unique adjacent
        // ladder level and stays ACTIVE instead of being virtualized. A
        // virtualized straggler would be cancelled by reconcile as surplus; a
        // re-priced straggler propagates to the chain as an in-place
        // price-correction UPDATE (sync detects the grid-vs-chain price
        // mismatch and corrects without touching the order's size). Re-pricing
        // always moves AWAY from the market (buys down, sells up), so a
        // re-priced order can never self-fill. When a price level is
        // contested, the slot already carrying an on-chain order keeps its
        // price and the other slot moves.
        //
        // Guarantees / edge cases:
        // - The COW commit-time price tolerance is incrementPercent/1000
        //   (manager._getCowComparePrecisions), so a full ladder step
        //   (incrementPercent/100) always exceeds it 10x — the re-priced
        //   delta is never suppressed by the ordersEqual check.
        // - The re-priced level is clamped to [config.minPrice,
        //   config.maxPrice] when those bounds are set. If clamping leaves no
        //   unique in-bounds level (duplicate pinned at a grid bound), the
        //   straggler falls back to surplus (cancelled) instead of being
        //   placed out of bounds.
        // - Retention is conditional on the window: in an oversubscribed
        //   window the re-priced (farthest-from-market) straggler can be
        //   sliced off and surplus-cancelled — the log below therefore does
        //   not promise unconditional retention.
        // - Re-pricing is a one-time drift: the repaired price is written
        //   back to the target and the next cycle starts from it, so there is
        //   no repeated compounding.
        const tolerance = 1e-8;
        const stepPct = Number(config.incrementPercent);
        const safeStepPct = Number.isFinite(stepPct) && stepPct > 0 ? stepPct : 1;
        // COW delta price tolerance (manager._getCowComparePrecisions) with a
        // 2x safety margin; max with the ladder step keeps the structural 10x
        // headroom explicit (normally a no-op). Note the configurable
        // RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT governs only the SIZE
        // comparison (nearlyEqualRelative) — and re-priced slots preserve
        // their on-chain size — so it cannot suppress the price update.
        const cowPriceTolRatio = safeStepPct / 1000;
        const stepRatio = Math.max(safeStepPct / 100, cowPriceTolRatio * 2);
        const ladderStep = (price: any, dir: number) =>
            dir > 0
                ? Number(price) * (1 + stepRatio)
                : Number(price) * (1 - stepRatio);
        const minBound = Number(config.minPrice);
        const maxBound = Number(config.maxPrice);
        const clampToBounds = (p: number) => {
            if (Number.isFinite(minBound)) p = Math.max(minBound, p);
            if (Number.isFinite(maxBound)) p = Math.min(maxBound, p);
            return p;
        };
        const snapRail = (slots: any[], side: string, dir: number) => {
            const kept: any[] = [];
            const stragglers: any[] = [];
            for (const s of slots) {
                const price = Number(s.price);
                const dup = kept.find((k: any) => Math.abs(Number(k.price) - price) < tolerance);
                if (dup == null) {
                    kept.push(s);
                    continue;
                }
                // Duplicate price level. Prefer keeping the slot that already
                // carries an on-chain order at this price; the other slot is
                // re-priced away.
                if (!isOrderPlaced(dup) && isOrderPlaced(s)) {
                    kept[kept.indexOf(dup)] = s;
                    stragglers.push(dup);
                } else {
                    stragglers.push(s);
                }
            }
            for (const st of stragglers) {
                let candidate = clampToBounds(ladderStep(st.price, dir));
                let guard = 0;
                while (
                    kept.some((k: any) => Math.abs(Number(k.price) - candidate) < tolerance) &&
                    guard++ < 100
                ) {
                    candidate = clampToBounds(ladderStep(candidate, dir));
                }
                if (kept.some((k: any) => Math.abs(Number(k.price) - candidate) < tolerance)) {
                    // No unique in-bounds level (duplicate pinned at a grid
                    // bound): leave the slot out of the window; reconcile
                    // cancels it as surplus.
                    this.manager.logger.log(
                        `[GRID-DEDUPE] ${side} slot ${st.id}@${st.price} has no unique in-bounds ` +
                        `level; surplus-cancelled instead of re-priced.`,
                        'warn'
                    );
                    continue;
                }
                this.manager.logger.log(
                    `[GRID-DEDUPE] Re-priced ${side} slot ${st.id}@${st.price} -> ${candidate} ` +
                    `(duplicate price level, unique ladder re-price).`,
                    'warn'
                );
                kept.push({ ...st, price: candidate });
            }
            kept.sort((a: any, b: any) =>
                dir > 0 ? Number(a.price) - Number(b.price) : Number(b.price) - Number(a.price)
            );
            return kept;
        };

        const buySlots = snapRail(buyCandidates, 'buy', -1).slice(0, targetCountBuy);
        const sellSlots = snapRail(sellCandidates, 'sell', +1).slice(0, targetCountSell);
        
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
