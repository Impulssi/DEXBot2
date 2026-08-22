/**
 * modules/order/grid.ts - Grid Engine
 *
 * Order grid creation, synchronization, and health management.
 * Exports plain functions for grid operations.
 *
 * Manages the complete lifecycle of the order grid:
 * - Creates geometric price grids with configurable spacing (increments)
 * - Synchronizes grid state with blockchain and fund changes
 * - Monitors grid health and handles spread corrections
 * - Calculates order sizes and allocations based on funds
 * - Detects and flags out-of-spread conditions
 *
 * ===============================================================================
 * TABLE OF CONTENTS - Grid Functions (28 exported functions)
 * ===============================================================================
 *
 * CONFIGURATION & CALCULATION (2 methods)
 *   1. calculateGapSlots(incrementPercent, targetSpreadPercent) - Calculate spread gap size
 *   2. getSizingContext(manager, side) - Get budget and sizing parameters (public wrapper)
 *
 * GRID SIZING & CONTEXT (1 method)
 *   3. _getSizingContext(manager, side) - Get budget and sizing parameters (internal)
 *      Determines budget from allocated funds, deducts BTS fees if needed
 *
 * GRID CREATION (1 method)
 *   4. createOrderGrid(config) - Create geometric price grid
 *      Returns price levels from minPrice to maxPrice with increment spacing
 *
 * ORDER CACHE MANAGEMENT (1 method - internal)
 *   5. _clearOrderCachesLogic(manager) - Clear order caches (_ordersByType, _ordersByState)
 *
 * GRID LOADING & INITIALIZATION (2 methods - async)
 *   6. loadGrid(manager, grid, boundaryIdx) - Load grid into manager orders
 *   7. initializeGrid(manager) - Full grid initialization from config
 *
 * GRID RECALCULATION (1 method - async)
 *   8. recalculateGrid(manager, opts) - Recalculate grid based on current state
 *
 * GRID STATE CHECKING (1 method)
 *   9. checkAndUpdateGridIfNeeded(manager) - Check if grid needs update
 *
 * BLOCKCHAIN SYNCHRONIZATION (2 methods - async)
 *   10. _recalculateGridOrderSizesFromBlockchain(manager, orderType) - Recalculate sizes from blockchain
 *   11. updateGridFromBlockchainSnapshot(manager, orderType, fromBlockchainTimer) - Update grid from blockchain
 *
 * GRID COMPARISON (2 methods - async)
 *   12. compareGrids(calculatedGrid, persistedGrid, manager) - Compare two grids
 *       Validates grid structure and reports divergence metrics
 *   13. monitorDivergence(manager, calculatedGrid, persistedGrid) - Unified divergence check
 *       Runs ratio-based + RMS-based checks and returns combined result
 *
 * ON-CHAIN ORDER FETCHING (1 method - async)
 *   14. _getOnChainOrders(manager) - Collect on-chain buy/sell orders from manager
 *
 * SPREAD MANAGEMENT (2 methods - async)
 *   15. calculateCurrentSpread(manager) - Calculate current bid-ask spread
 *   16. checkSpreadCondition(manager, BitShares, updateOrdersOnChainBatch) - Check and flag spread condition
 *
 * GRID HEALTH MONITORING (6 methods)
 *   17. checkGridHealth(manager, updateOrdersOnChainBatch) - Monitor grid health (async)
 *   18. checkWindowDust(manager) - Dust check scoped to the active buy/sell window (async)
 *   19. _hasAnyDust(manager, partials, type) - Check for dust orders (internal)
 *   20. hasAnyDust(manager, partials, side) - Check for dust orders (public)
 *   21. getDustOrders(manager, partials, side) - Get all dust order IDs (public)
 *   22. determineOrderSideByFunds(manager, currentMarketPrice) - Determine priority side
 *
 * SPREAD CORRECTION (1 method)
 *   23. prepareSpreadCorrectionOrders(manager, preferredSide) - Prepare correction orders
 *
 * DUST DETECTION (1 method - internal)
 *   25. _getDustOrders(manager, partials, type) - Internal dust detection helper
 *
 * ===============================================================================
 *
 * GRID STRUCTURE:
 * Grid = Array of slots with:
 * - id: Order ID (null for virtual)
 * - price: Price level
 * - size: Grid allocation
 * - grid: In-grid size (ACTIVE + PARTIAL orders)
 * - blockchain: On-blockchain size
 * - type: BUY, SELL, or SPREAD
 * - state: VIRTUAL, ACTIVE, PARTIAL
 *
 * GRID LIFECYCLE:
 * 1. createOrderGrid(config) - Generate price levels
 * 2. assignGridRoles() - Assign BUY/SELL/SPREAD roles based on boundary
 * 3. calculateOrderSizes() - Allocate funds to slots
 * 4. loadGrid() - Create grid Order objects in manager
 * 5. syncFromOpenOrders() - Load blockchain state
 * 6. recalculateGrid() - Keep in sync as market/funds change
 *
 * ===============================================================================
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { ORDER_TYPES, ORDER_STATES, COW_ACTIONS, DEFAULT_CONFIG, GRID_LIMITS, TIMING, PIPELINE_TIMING, MARKET_ADAPTER, INCREMENT_BOUNDS } from '../constants.js';
const { GRID_COMPARISON } = GRID_LIMITS;
import * as Format from './format.js';
import {
    resolveMaxAsymmetryFactor,
    applyAsymmetricBounds,
} from '../../market_adapter/core/asymmetric_bounds.js';

// FIX: Extract magic numbers to named constants for maintainability
const GRID_CONSTANTS = {
    RMS_PERCENTAGE_SCALE: 100,  // Convert RMS percentage threshold from percent to decimal
};

function _snapshotFundState(manager: any): any {
    return {
        buyFree: Number(manager.accountTotals?.buyFree || 0),
        sellFree: Number(manager.accountTotals?.sellFree || 0),
        buyLocked: Number(manager.accountTotals?.buyLocked || 0),
        sellLocked: Number(manager.accountTotals?.sellLocked || 0),
    };
}

import {
    floatToBlockchainInt,
    getPrecisionByOrderType,
    getPrecisionsForManager,
    calculateOrderCreationFees,
    calculateOrderSizes,
    calculateRotationOrderSizes,
    calculateAvailableFundsValue,
    calculateGridSideDivergenceMetric,
    getPrecisionSlack,
    getMinOrderSize,
    getSingleDustThreshold,
    getGridBestPrices,
    calculateSpreadFromOrders,
    allocateFundsByWeights,
    calculateGapSlots as _mathGapSlots,
    findPriceCollision,
    getBtsSide,
    getSellStartIdx,
    resolveGapBand,
    countGapBandSpread,
    validatePersistedBoundary,
    adjustBudgetForBtsFees,
    clamp,
} from './utils/math.js';
import {
    filterOrdersByType,
    checkSizesBeforeMinimum,
    checkSizeThreshold,
    resolveConfiguredPriceBound,
    shouldFlagOutOfSpread,
    isOrderHealthy,
    isPhantomOrder,
    isSlotAvailable,
    isOrderOnChain,
    isOrderPlaced,
    hasOnChainId,
    isEmptyGridSlot,
    parseSlotIndex,
    calculateIdealBoundary,
    assignGridRoles,
    resolveOnChainRetypeType
} from './utils/order.js';
import { loadAmaCenterPrice, loadAmaCenterSnapshot, withBlockchainRetry } from './utils/system.js';
import { derivePriceWithPoolRef } from './utils/withPoolRef.js';
import { getWhitelistFlags } from '../market_adapter_whitelist.js';

import type { Order } from '../types.js';
import { getErrorMessage } from '../utils/errors.js';

const calculateGapSlots = _mathGapSlots;
export { calculateGapSlots };

export function isGridBloated(manager: any, orders: any): any {
        const gridSize = Array.isArray(orders) ? orders.length : orders.size;
        if (!gridSize || !manager?.config) return { bloated: false };

        const config = manager.config;
        const incPct = config.incrementPercent || 0.3;
        if (incPct <= 0) return { bloated: false };

        const targetSpreadPct = config.targetSpreadPercent || incPct * 2;
        const orderList = Array.isArray(orders) ? orders : Array.from(orders.values());

        const numBuyActive = orderList.filter((o: any) =>
            o.type === ORDER_TYPES.BUY &&
            (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) &&
            o.orderId
        ).length;
        const numSellActive = orderList.filter((o: any) =>
            o.type === ORDER_TYPES.SELL &&
            (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL) &&
            o.orderId
        ).length;
        const placedCount = numBuyActive + numSellActive;
        if (!placedCount) return { bloated: false };

        const gapSlots = calculateGapSlots(incPct, targetSpreadPct);

        // Estimate expected full-rail size from actual min/max prices in the grid.
        // A normal grid has one geometric price level per increment step across
        // the full price range, plus gapSlots for the spread zone.
        // This correctly handles the full-rail grid layout (many virtual slots
        // outside the active window) and only flags true bloat where spread-
        // correction inserts or other duplication have added EXTRA slots beyond
        // what the price range would produce.
        //
        // The buffer uses MIN_SPREAD_ORDERS to cover:
        //   1. Estimation error from createOrderGrid's sqrt(step) starting
        //      offset (~1 geometric level per side)
        //   2. Headroom for legitimate spread-correction inserts
        const prices = orderList
            .map((o: any) => o.price)
            .filter((p: any) => p != null && Number.isFinite(p));
        let expectedTotal = 0;
        if (prices.length > 0) {
            const minP = Math.min(...prices);
            const maxP = Math.max(...prices);
            if (minP > 0 && maxP > minP) {
                const step = 1 + incPct / 100;
                expectedTotal = Math.floor(Math.log(maxP / minP) / Math.log(step)) + 1;
            }
        }
        const railEstimate = Math.max(expectedTotal, placedCount);
        const buffer = (config.gridLimits?.MIN_SPREAD_ORDERS ?? GRID_LIMITS.MIN_SPREAD_ORDERS);
        const maxAllowed = railEstimate + gapSlots + buffer;

        return {
            bloated: gridSize > maxAllowed,
            details: { gridSize, placedCount, numBuyActive, numSellActive, gapSlots, maxAllowed, railEstimate }
        };
    }

    /**
     * Check whether the grid-bloat grace period is still active, i.e. a
     * bloat detection happened recently enough that a structural resync
     * has not had time to resolve it.
     *
     * Used by both Grid.loadGrid (to suppress redundant resync requests)
     * and the maintenance runtime (to decide when to re-check after the
     * grace window expires) so the two policies share one definition of
     * the grace window.
     *
     * @param {Object} manager - OrderManager instance.
     * @returns {{active: boolean, elapsed: number, graceMs: number}}
     */
export function isGridBloatGraceActive(manager: any): any {
        const graceMs = Number(TIMING?.GRID_BLOAT_RESYNC_GRACE_MS) || TIMING.GRID_BLOAT_RESYNC_GRACE_MS;
        if (!manager._gridBloatDetectedAt) {
            return { active: false, elapsed: 0, graceMs };
        }
        const elapsed = Date.now() - manager._gridBloatDetectedAt;
        return { active: elapsed < graceMs, elapsed, graceMs };
    }

    /**
     * Clear the grid-bloat detection timestamp once the grid size has
     * returned to normal. Shared so both call sites use the same key.
     * @param {Object} manager - OrderManager instance.
     */
export function clearGridBloatFlag(manager: any): void {
        delete manager._gridBloatDetectedAt;
    }

    /**
     * Public wrapper for side sizing context.
     * Keeps StrategyEngine decoupled from Grid private internals.
     *
     * @param {import('./types').OrderManager} manager
     * @param {'buy'|'sell'} side
     * @returns {Promise<any|null>}
     */
export async function getSizingContext(manager: any, side: any): Promise<any> {
        return await _getSizingContext(manager, side);
    }

    /**
     * Unifies budget calculation and fee deduction for all grid sizing scenarios.
     * Ensures consistent fund context (Allocated vs Total) across the bot.
     *
     * @param {import('./types').OrderManager} manager - OrderManager instance
     * @param {string} side - 'buy' or 'sell'
     * @returns {Promise<any|null>}
     * @private
     */
export async function _getSizingContext(manager: any, side: any, { skipRecalc = false }: { skipRecalc?: boolean } = {}) {
        if (!manager || !manager.assets) return null;

        // 1. Ensure fund state is fresh before sizing
        if (!skipRecalc) {
            await manager.recalculateFunds();
        }

        const snap = manager.getChainFundsSnapshot ? manager.getChainFundsSnapshot() : {};
        const isBuy = side === 'buy';
        const type = isBuy ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;

        // 2. Determine base budget: Always use ALLOCATED funds (respects botFunds %)
        // This ensures the bot only "thinks" about the capital it is allowed to use.
        let budget = isBuy ? (snap.allocatedBuy || 0) : (snap.allocatedSell || 0);

        // 3. Standardize BTS Fee Deduction (Issue #15 consistency)
        // BTS fees are paid for ALL order operations regardless of side, so the
        // BTS-holding side reserves fees for both buy and sell target counts.
        if (budget > 0) {
            const targetBuy = Math.max(0, manager.config.activeOrders?.buy ?? 1);
            const targetSell = Math.max(0, manager.config.activeOrders?.sell ?? 1);
            const totalTarget = targetBuy + targetSell;
            const btsOrderType = getBtsSide(manager.config?.assetA, manager.config?.assetB);
            const isBtsSide = isBuy ? (btsOrderType === ORDER_TYPES.BUY) : (btsOrderType === ORDER_TYPES.SELL);
            const formulaBudget = calculateOrderCreationFees(
                manager.config.assetA,
                manager.config.assetB,
                totalTarget,
                manager.config?.feeParams?.BTS_RESERVATION_MULTIPLIER
            );

            budget = adjustBudgetForBtsFees(
                budget,
                isBtsSide,
                formulaBudget,
                manager.config.min_BTS_value || 0,
                Format.toFiniteNumber(manager.funds?.btsBalance?.free, 0),
                Format.toFiniteNumber(isBuy ? (snap.allocatedBuy || 0) : (snap.allocatedSell || 0)),
                Format.toFiniteNumber(snap.allocatedBuy || 0)
                    + Format.toFiniteNumber(snap.allocatedSell || 0),
            );
        }

        return {
            budget,
            precision: getPrecisionByOrderType(manager.assets, type),
            config: manager.config
        };
    }

    /**
     * Create the initial order grid structure based on configuration.
     *
     * ALGORITHM: Geometric Grid Creation with Fixed Spread Gap
     * =========================================================
     * This method generates a unified "Master Rail" of price levels with geometric spacing.
     * The grid is centered around startPrice with a fixed-size spread gap.
     *
     * KEY CONCEPTS:
     * - Geometric Spacing: Each price level is incrementPercent% away from neighbors
     * - Master Rail: Single unified array (not separate buy/sell rails)
     * - Spread Gap: Fixed-size buffer between best buy and best sell
     * - Role Assignment: BUY / SPREAD / SELL based on position relative to startPrice
     *
     * SPREAD GAP FORMULA:
     * ===================
     * The spread gap size is calculated to match the target spread percentage:
     *
     * 1. Step Factor (s): s = 1 + (incrementPercent / 100)
     *    Example: If incrementPercent = 0.5%, then s = 1.005
     *
     * 2. Minimum Spread: minSpread = incrementPercent × MIN_SPREAD_FACTOR
     *    This ensures spread is at least 2× the increment (prevents too-narrow spread)
     *
     * 3. Target Steps (n): Number of price levels needed to achieve target spread
     *    Formula: n = ceil(ln(1 + targetSpread/100) / ln(s))
     *
     *    Derivation: If we want price to grow by targetSpread% over n steps:
     *    - Final price = startPrice × s^n
     *    - Growth factor = (1 + targetSpread/100)
     *    - Therefore: s^n = (1 + targetSpread/100)
     *    - Taking ln: n × ln(s) = ln(1 + targetSpread/100)
     *    - Solving: n = ln(1 + targetSpread/100) / ln(s)
     *
     * 4. Gap Slots (G): G = max(MIN_SPREAD_ORDERS, n)
     *    Ensures at least MIN_SPREAD_ORDERS slots even if target spread is small
     *
     * EXAMPLE:
     * --------
     * incrementPercent = 0.5%, targetSpread = 2%
     * - s = 1.005
     * - minSpread = 0.5% × 2 = 1%
     * - targetSpread = max(2%, 1%) = 2%
     * - n = ceil(ln(1.02) / ln(1.005)) = ceil(3.98) = 4 steps
     * - G = max(2, 4) = 4 slots
     *
     * @param {any} config - Grid configuration
     * @returns {any}
     */
export function createOrderGrid(config: any): any {
        const { startPrice, minPrice, maxPrice, incrementPercent } = config;

        // FIX: Add comprehensive input validation to prevent silent grid creation failures
        if (!Number.isFinite(startPrice)) {
            throw new Error(`Invalid startPrice: ${startPrice}. Must be a finite number.`);
        }
        if (!Number.isFinite(minPrice)) {
            throw new Error(`Invalid minPrice: ${minPrice}. Must be a finite number.`);
        }
        if (minPrice <= 0) {
            throw new Error(`Invalid minPrice: ${minPrice}. Must be positive.`);
        }
        if (!Number.isFinite(maxPrice)) {
            throw new Error(`Invalid maxPrice: ${maxPrice}. Must be a finite number.`);
        }
        if (minPrice >= maxPrice) {
            throw new Error(`Invalid price bounds: minPrice (${minPrice}) must be < maxPrice (${maxPrice}).`);
        }
        if (!(minPrice <= startPrice && startPrice <= maxPrice)) {
            throw new Error(`startPrice (${startPrice}) must be within bounds [${minPrice}, ${maxPrice}].`);
        }
        if (maxPrice <= 0) {
            throw new Error(`maxPrice (${maxPrice}) must be positive.`);
        }

        if (!Number.isFinite(incrementPercent)) {
            throw new Error(`Invalid incrementPercent: ${incrementPercent}. Must be a finite number.`);
        }
        // Fall back to the canonical INCREMENT_BOUNDS when the config omits
        // incrementBounds. Without this, a non-positive incrementPercent (e.g. 0)
        // silently passes validation and the geometric loop below spins forever.
        const incrementBounds = config.incrementBounds || INCREMENT_BOUNDS;
        const minPercent = incrementBounds.MIN_PERCENT;
        const maxPercent = incrementBounds.MAX_PERCENT;
        if (incrementPercent <= 0 || incrementPercent < minPercent || incrementPercent > maxPercent) {
            throw new Error(
                `Invalid incrementPercent: ${incrementPercent}. Must be between ` +
                `${minPercent} and ${maxPercent} (inclusive).`
            );
        }

        const stepUp = 1 + (incrementPercent / 100);
        const stepDown = 1 - (incrementPercent / 100);

        // ================================================================================
        // STEP 1: GENERATE PRICE LEVELS (Geometric progression)
        // ================================================================================
        // Create a geometric series of prices from minPrice to maxPrice.
        // Each level is incrementPercent% away from its neighbors.
        //
        // We start from startPrice and expand outward in both directions to ensure
        // the grid is centered around the market price.

        const priceLevels: number[] = [];

        // Generate levels upwards from startPrice (higher prices for SELL orders)
        // Start from sqrt(stepUp) × startPrice to center the grid
        let upPrice = startPrice * Math.sqrt(stepUp);
        while (upPrice <= maxPrice) {
            priceLevels.push(upPrice);
            upPrice *= stepUp;
        }

        // Generate levels downwards from startPrice (lower prices for BUY orders)
        // Start from sqrt(stepDown) × startPrice to center the grid
        let downPrice = startPrice * Math.sqrt(stepDown);
        while (downPrice >= minPrice) {
            priceLevels.push(downPrice);
            downPrice *= stepDown;
        }

        // Sort all levels from lowest to highest (Master Rail order)
        priceLevels.sort((a: any, b: any) => a - b);

        if (priceLevels.length === 0) {
            throw new Error(
                `Grid generation produced no price levels for startPrice=${startPrice}, ` +
                `bounds=[${minPrice}, ${maxPrice}], incrementPercent=${incrementPercent}. ` +
                `Widen bounds or reduce incrementPercent.`
            );
        }

        // ================================================================================
        // STEP 2: CALCULATE SPREAD GAP SIZE
        // ================================================================================
        // Determine how many slots should be in the spread zone.
        // See formula documentation in JSDoc above.

        const gapSlots = calculateGapSlots(incrementPercent, config.targetSpreadPercent, config.gridLimits);

        // ================================================================================
        // STEP 3: FIND SPLIT INDEX & ROLE ASSIGNMENT
        // ================================================================================
        // Determine the boundary and assign roles (BUY/SPREAD/SELL) to each slot.
        //
        // STRATEGY: Center the spread gap around startPrice
        
        const boundaryIdx = calculateIdealBoundary(priceLevels.map((p: any) => ({ price: p })), startPrice, gapSlots);

        // ================================================================================
        // STEP 4: CREATE ORDER OBJECTS
        // ================================================================================
        // Convert price levels to order objects with assigned roles.

        const orders = priceLevels.map((price: any, i: any) => ({
            id: `slot-${i}`,
            price,
            type: null, // assigned below
            state: ORDER_STATES.VIRTUAL,
            size: 0
        }));

        const updatedOrders = assignGridRoles(orders, boundaryIdx, gapSlots, ORDER_TYPES, ORDER_STATES);

        const buyCount = updatedOrders.filter((o: any) => o.type === ORDER_TYPES.BUY).length;
        const sellCount = updatedOrders.filter((o: any) => o.type === ORDER_TYPES.SELL).length;
        if (buyCount === 0 || sellCount === 0) {
            throw new Error(
                `Grid generation produced an imbalanced rail (buy=${buyCount}, sell=${sellCount}) for ` +
                `startPrice=${startPrice}, bounds=[${minPrice}, ${maxPrice}], incrementPercent=${incrementPercent}, ` +
                `targetSpreadPercent=${config.targetSpreadPercent}. Widen bounds or reduce target spread.`
            );
        }

        const initialSpreadCount = {
            buy: Math.floor(gapSlots / 2),
            sell: gapSlots - Math.floor(gapSlots / 2)
        };

        return { orders: updatedOrders, boundaryIdx, initialSpreadCount, gapSlots };
    }

    /**
     * Internal utility to clear all order-related manager caches.
     * Prevents stale references during grid reinitialization.
     * RC-2: Synchronized to prevent concurrent modifications during clear
     * 
     * Note: Uses explicit assignment instead of .clear() to enforce COW semantics:
     * - Replace the master grid atomically with a fresh Map instance
     * - Avoid mutating any previously referenced Map object
     * @param {import('./types').OrderManager} manager - OrderManager instance
     * @private
     */
function _clearOrderCachesLogic(manager: any): void {
        // Bump the grid version: the master map is replaced atomically here, and
        // an in-flight COW plan whose baseVersion matches the pre-swap version
        // must be refused at commit (version check) instead of committing over
        // the regenerated grid. _applyOrderUpdate bumps per slot afterwards, but
        // a zero-slot grid would otherwise leave the version unchanged.
        if (Number.isFinite(Number(manager._gridVersion))) {
            manager._gridVersion++;
        }
        // Replace frozen master grid with fresh empty frozen Map (COW pattern)
        manager.orders = Object.freeze(new Map());
    }


    /**
     * Restore a persisted grid snapshot onto a manager instance.
     *
     * Side effects on manager:
     * - Reassigns all slot types to match current boundary + gapSlots
     *   (fixes stale persisted types that cause ILLEGAL_SPREAD_STATE)
     * - Sets `manager._gapSlots` to the computed gapSlots so strategy reads
     *   the creation-time value instead of recomputing from live config
     * - Sanitizes phantom orders (ACTIVE/PARTIAL without orderId → VIRTUAL)
     *
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @param {Array<any>} grid - The persisted grid array.
     * @param {number|null} [boundaryIdx=null] - The master boundary index.
     * @returns {Promise<void>}
     */
export async function loadGrid(manager: any, grid: any, boundaryIdx: any = null): Promise<any> {
        if (!Array.isArray(grid)) return;
        return await manager._gridLock.acquire(async () => {
            try {
                await withBlockchainRetry(
                    () => manager._initializeAssets(),
                    'initializeAssets',
                    { logger: manager.logger }
                );
            } catch (e: any) {
                manager.logger?.log?.(`Asset initialization failed during grid load: ${getErrorMessage(e)}`, 'warn');
            }

            // RC-2: Use logic helper
            _clearOrderCachesLogic(manager);

            // resetFunds under _fundLock only — no persistGrid needed (grid already
            // on disk). For the resync variant see recalculateGrid (grid.ts:~1037)
            // which snapshots fund values under lock and persists outside.
            // Read btsFeesOwed inside the lock (before resetFunds) to avoid a TOCTOU
            // with concurrent deductBtsFees (which also holds _fundLock).
            await manager._fundLock.acquire(async () => {
                const savedBtsFeesOwed = manager.funds.btsFeesOwed;
                await manager.resetFunds();
                manager.funds.btsFeesOwed = savedBtsFeesOwed;
            });

            // RESTORE-TIME BOUNDARY GATE: a persisted boundary is untrusted
            // disk state.  Any writer bug that committed AND persisted an
            // overrun boundary (e.g. the pre-5eb3ca7 promotion path) would
            // otherwise legalize itself on every restart: resolveGapBand
            // re-derives sellStartIdx from whatever value is restored, and
            // none of the runtime gates (commit gate, detectors) run before
            // this point.  Validate against the snapshot BEFORE restoring;
            // on failure attempt to repair by re-deriving the structural
            // center boundary from slot prices, falling back to "no boundary"
            // (callers sync against chain right after load either way).
            const loadGapSlots = calculateGapSlots(
                manager.config?.incrementPercent,
                manager.config?.targetSpreadPercent,
                manager.config?.gridLimits
            );
            let restoredBoundary = typeof boundaryIdx === 'number' ? boundaryIdx : null;
            if (restoredBoundary !== null) {
                const check = validatePersistedBoundary(restoredBoundary, grid, loadGapSlots);
                if (!check.ok) {
                    manager.logger?.log?.(
                        `[GRID-LOAD] Persisted boundary rejected (${check.reason}): ${check.detail}. ` +
                        `Attempting re-derivation from slot prices.`,
                        'error'
                    );
                    restoredBoundary = null;
                    const startPrice = Number(manager.config?.startPrice);
                    if (Number.isFinite(startPrice) && Array.isArray(grid) && grid.length > 0) {
                        const priceSorted = [...grid].sort((a: any, b: any) => Number(a.price) - Number(b.price));
                        const derived = calculateIdealBoundary(
                            priceSorted.map((s: any) => ({ price: s.price })),
                            startPrice,
                            loadGapSlots
                        );
                        if (Number.isInteger(derived) && derived >= 0
                            && validatePersistedBoundary(derived, priceSorted, loadGapSlots).ok) {
                            // boundaryIdx indexes the STORED array ordering, not
                            // the price-sorted copy — map the anchor slot back
                            // so the repair stays correct even if a snapshot is
                            // not price-sorted (the honest-load path assumes it;
                            // the repair path must not inherit that silently).
                            const anchorSlot = priceSorted[derived];
                            let mappedIdx = grid.indexOf(anchorSlot);
                            if (mappedIdx === -1 && anchorSlot?.id != null) {
                                mappedIdx = grid.findIndex((s: any) => s && s.id === anchorSlot.id);
                            }
                            if (mappedIdx >= 0) {
                                restoredBoundary = mappedIdx;
                                manager.logger?.log?.(
                                    `[GRID-LOAD] Persisted boundary repaired: ${boundaryIdx} -> ${mappedIdx} ` +
                                    `(re-derived from slot prices, sorted idx ${derived}).`,
                                    'warn'
                                );
                            }
                        }
                    }
                    if (restoredBoundary === null) {
                        manager.logger?.log?.(
                            `[GRID-LOAD] Could not re-derive a safe boundary; continuing without one. ` +
                            `The next sync cycle will reconcile grid geometry against the chain.`,
                            'error'
                        );
                    }
                }
            }

            // Restore boundary index for StrategyEngine
            if (restoredBoundary !== null) {
                manager._restoreBoundary(restoredBoundary);
                manager.logger?.log?.(`Restored boundary index: ${restoredBoundary}`, 'info');
            }

            // Reassign slot types based on current boundary.
            // Every slot's type must match its position in the price-sorted rail
            // relative to the boundary + gapSlots.  Stale persisted types cause
            // split spread zones and ILLEGAL_SPREAD_STATE errors.  The subsequent
            // sync will detect type mismatches with chain orders (e.g. a BUY-zone
            // slot holding a SELL chain order) and auto-cancel + recreate them.
            if (restoredBoundary !== null) {
                const gapSlots = loadGapSlots;
                manager._gapSlots = gapSlots;
                const buyEndIdx = restoredBoundary;
                const sellStartIdx = getSellStartIdx(restoredBoundary, gapSlots);
                let reassignCount = 0;
                grid = grid.map((slot: any, i: any) => {
                    const correctType = (i <= buyEndIdx)
                        ? ORDER_TYPES.BUY
                        : (i >= sellStartIdx)
                            ? ORDER_TYPES.SELL
                            : ORDER_TYPES.SPREAD;

                    // DEFENSIVE BACKSTOP: a VIRTUAL slot with no orderId and
                    // zero size is side-neutral — it is a reusable placeholder
                    // that may be activated on either rail.  Storing a stale
                    // BUY/SELL type here misleads candidate-selection code
                    // (e.g. spread-correction orphaned filters and reconcile
                    // activation), which pick by stored type instead of boundary
                    // geometry.  Force SPREAD so the stored type can never
                    // pre-bias which side reuses the slot.  The VIRTUAL +
                    // !orderId + size-0 combination already implies not on-chain
                    // (on-chain requires ACTIVE/PARTIAL and an orderId).  This is
                    // a defensive backstop for legacy persisted grids; the
                    // boundary-shift and strategy re-plan paths use
                    // assignGridRoles (order.ts) with assignOnChain, where
                    // geometry-based typing wins.
                    if (isEmptyGridSlot(slot, slot, { allowNullType: true })) {
                        if (slot.type !== ORDER_TYPES.SPREAD) reassignCount++;
                        return { ...slot, type: ORDER_TYPES.SPREAD };
                    }

                    if (slot.type !== correctType) {
                        let newType = correctType;
                        // On-chain slots must never be reassigned to SPREAD:
                        // SPREAD+ACTIVE/PARTIAL is an illegal state (validateOrder
                        // rejects it), so the slot would be dropped from the loaded
                        // grid and its chain order orphaned. Keep the stored
                        // BUY/SELL rail type (the subsequent sync's pass-1
                        // type-mismatch handling cancels/recreates a genuinely
                        // wrong side), or resolve a stale SPREAD type by the slot
                        // index vs the boundary (the same convention the whole
                        // correction block uses). The price-vs-startPrice
                        // convention is NOT usable here: startPrice may still be
                        // the string "pool"/"book" (price modes are only coerced
                        // to a number by initializeGrid), which makes every
                        // comparison false and wrongly resolves below-center
                        // slots to SELL.
                        if (newType === ORDER_TYPES.SPREAD && isOrderOnChain(slot)) {
                            newType = resolveOnChainRetypeType(slot, i, buyEndIdx, ORDER_TYPES);
                        }
                        reassignCount++;
                        return { ...slot, type: newType };
                    }
                    return slot;
                });
                if (reassignCount > 0) {
                    manager.logger?.log?.(
                        `[GRID-TYPE-CORRECT] Reassigned ${reassignCount} stale slot type(s) based on boundary ${restoredBoundary}`,
                        'warn'
                    );
                }
            }

            // Gap 6: Grid size cap — validate grid slot count against expected maximum.
            // Formula: placedOrders (active+partial with orderId) + gapSlots + 1 tolerance slot.
            const bloatResult = isGridBloated(manager, grid);
            if (bloatResult.bloated) {
                const d = bloatResult.details;
                const grace = isGridBloatGraceActive(manager);
                if (grace.active) {
                    manager.logger?.log?.(
                        `[GRID-BLOAT] Grid size ${d.gridSize} exceeds expected maximum ${d.maxAllowed} ` +
                        `(grace period active ${grace.elapsed}ms/${grace.graceMs}ms). Skipping re-request.`,
                        'debug'
                    );
                } else {
                    manager.logger?.log?.(
                        `[GRID-BLOAT] Grid size ${d.gridSize} exceeds expected maximum ${d.maxAllowed} ` +
                        `(placed=${d.placedCount} buy=${d.numBuyActive} sell=${d.numSellActive} ` +
                        `gapSlots=${d.gapSlots}). Triggering protective structural resync.`,
                        'warn'
                    );
                    manager._gridBloatDetectedAt = Date.now();
                    if (typeof manager.requestStructuralGridResync === 'function') {
                        manager.requestStructuralGridResync(
                            'grid-bloat-detected',
                            { reason: `Grid size ${d.gridSize} exceeds maximum ${d.maxAllowed}` }
                        ).catch((err: any) => {
                            manager.logger?.log?.(
                                `[GRID-BLOAT] Structural resync request failed: ${getErrorMessage(err)}`,
                                'error'
                            );
                        });
                    }
                }
            }

            manager.pauseRecalcLogging();
            manager.pauseFundRecalc();
            try {
                // RC-2: Use applyOrderUpdate (PRIVATE/UNLOCKED)
                for (const order of grid) {
                    let currentOrder = order;
                    if (isPhantomOrder(order)) {
                        manager.logger?.log?.(`Sanitizing corrupted order ${order.id}: ACTIVE/PARTIAL without orderId -> VIRTUAL`, 'warn');
                        currentOrder = { ...order, state: ORDER_STATES.VIRTUAL };
                    }
                    await manager._applyOrderUpdate(currentOrder, 'grid-load', { skipAccounting: true });
                }
                 // Gap-band occupancy for the spread metric.  Empty slots are
                 // normalized to SPREAD (side-neutral) above, so a raw
                 // `type === SPREAD` count would include every empty slot on both
                 // rails.  countGapBandSpread requires both SPREAD type and band
                 // geometry (target = gapSlots).
                 // Index resolution: prefer the parsed slot id (price-monotonic
                 // at creation) so the count is order-independent, matching the
                 // accountant (accounting.ts).  Fall back to array position only
                 // for ids that are not grid slot ids.
                 const spreadCount = countGapBandSpread(manager, grid, (o: any, i: number) => {
                     const idx = parseSlotIndex(o?.id);
                     return idx === null ? i : idx;
                 });
                 manager.initialSpreadCount = spreadCount;
                 manager.currentSpreadCount = spreadCount;

             } finally {
                 await manager.resumeFundRecalc();
                 manager.resumeRecalcLogging();
             }
             manager.logger?.log?.(`Loaded ${manager.orders.size} orders from persisted grid.`, 'info');
        });
    }

function resolveMinScaleSlots(primary: any, secondary: any): number {
    const p = Number(primary);
    if (Number.isFinite(p)) return Math.max(0, Math.floor(p));
    const s = Number(secondary);
    if (Number.isFinite(s)) return Math.max(0, Math.floor(s));
    return MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MIN_SCALE_SLOTS;
}

/**
     * Initialize and orchestrate the order grid.
     *
     * @return {Promise<void>}
     * @throws {Error} If initialization fails or account totals are missing.
     */
export async function initializeGrid(manager: any): Promise<void> {
        if (!manager) throw new Error('initializeGrid requires a manager instance');

        try {
            await withBlockchainRetry(
                () => manager._initializeAssets(),
                'initializeAssets',
                { logger: manager.logger }
            );
        } catch (e: any) {
            manager.logger?.log?.(`Asset initialization failed during grid init: ${getErrorMessage(e)}`, 'warn');
        }

        // FIX: Add explicit state validation to prevent cryptic errors later
        if (!manager.assets || !manager.assets.assetA || !manager.assets.assetB) {
            throw new Error('Asset initialization did not complete properly - assetA or assetB undefined');
        }
        if (!manager.config) {
            throw new Error('Manager config not initialized before grid initialization');
        }

        const mpRaw = manager.config.startPrice;
        manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: mpRaw type=${typeof mpRaw}, value=${mpRaw}`, 'debug');

        // Auto-derive price if not a fixed numeric value (e.g. "pool", "book", or undefined)
        if (typeof mpRaw !== 'number' || isNaN(mpRaw)) {
            try {
                const { BitShares } = require('../bitshares_client');
                const derived = await derivePriceWithPoolRef(BitShares, manager.config.assetA, manager.config.assetB, manager.config.priceMode || 'auto', manager.config.poolRef);
                if (derived) {
                    manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: Derived new startPrice=${derived.toFixed(8)} (mode=${manager.config.priceMode || 'auto'})`, 'info');
                    manager.config.startPrice = Number(derived);
                } else {
                    throw new Error(`Price derivation returned no result for ${manager.config.assetA}/${manager.config.assetB}`);
                }
            } catch (err: any) {
                manager.logger?.log?.(`Failed to derive market price: ${getErrorMessage(err)}`, 'warn');
                throw err; // Re-throw to prevent "pool" string reaching numeric math
            }
        }

        const configuredMinPrice = manager.config.minPrice;
        const configuredMaxPrice = manager.config.maxPrice;
        const mp = Number(manager.config.startPrice);

        // Derive gridPrice — separate reference for x-factor bounds (may differ from startPrice).
        // Supported modes:
        //   - numeric: fixed value
        //   - "pool" / "book": live blockchain price for the pair
        //   - "ama"/"ama1".."ama4": center from profiles/orders/<botKey>.dynamicgrid.json
        //   - null/anything else: fallback to startPrice (backward-compatible)
        let gp = mp;
        let gpSource = 'startPrice';
        let amaSnapshot: any = null;
        const whitelistFlags = getWhitelistFlags(manager.config.botKey);
        const isGridRangeScalingWhitelisted = whitelistFlags.asymmetricBounds === true;
        let gridPriceOffsetPct = 0;
        const gpRaw = manager.config.gridPrice;
        const gpMode = (typeof gpRaw === 'string') ? gpRaw.trim().toLowerCase() : null;
        if (typeof gpRaw === 'number' && Number.isFinite(gpRaw) && gpRaw > 0) {
            gp = gpRaw;
            gpSource = 'numeric';
            manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: gridPrice=numeric ${gp.toFixed(8)}`, 'info');
        } else if (gpMode === 'pool' || gpMode === 'book') {
            try {
                const { BitShares } = require('../bitshares_client');
                const derived = await derivePriceWithPoolRef(BitShares, manager.config.assetA, manager.config.assetB, gpMode, manager.config.poolRef);
                if (derived) {
                    gp = Number(derived);
                    gpSource = gpMode;
                    manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: gridPrice=${gpMode} ${gp.toFixed(8)}`, 'info');
                } else {
                    manager.logger?.log?.(`initializeGrid: ${gpMode} gridPrice unavailable, falling back to startPrice`, 'warn');
                }
            } catch (err: any) {
                manager.logger?.log?.(`initializeGrid: ${gpMode} gridPrice derivation failed: ${getErrorMessage(err)}`, 'warn');
            }
        } else if (/^ama(?:[1-4])?$/.test(gpMode || '')) {
            amaSnapshot = loadAmaCenterSnapshot(manager.config.botKey);
            const amaCenter = amaSnapshot?.gridCenterPrice ?? loadAmaCenterPrice(manager.config.botKey);
            if (Number.isFinite(amaCenter) && amaCenter > 0) {
                gp = amaCenter;
                gpSource = 'ama';
                const snapshotGridPriceOffsetPct = Number(amaSnapshot?.gridPriceOffsetPct);
                const hasGridPriceOffset = isGridRangeScalingWhitelisted
                    && Number.isFinite(snapshotGridPriceOffsetPct)
                    && snapshotGridPriceOffsetPct !== 0;
                gridPriceOffsetPct = hasGridPriceOffset ? snapshotGridPriceOffsetPct : 0;
                manager.logger?.log?.(`[DIAGNOSTIC] initializeGrid: gridPrice=AMA center ${gp.toFixed(8)}`, 'info');
            } else {
                manager.logger?.log?.(`initializeGrid: AMA center unavailable for gridPrice, falling back to startPrice`, 'warn');
            }
        }

        const minP = resolveConfiguredPriceBound(manager.config.minPrice, DEFAULT_CONFIG.minPrice, gp, 'min');
        const maxP = resolveConfiguredPriceBound(manager.config.maxPrice, DEFAULT_CONFIG.maxPrice, gp, 'max');

        // Asymmetric bound adjustment: widen the bound in the AMA trend direction
        // and tighten the opposite side, giving the grid more room when the center
        // trails price. Uses slope data from the dynamicgrid.json snapshot.
        let resolvedMinP = minP;
        let resolvedMaxP = maxP;
        let rangeScalingFactor: number | null = null;
        let appliedTrend: 'UP' | 'DOWN' | null = null;
        let minScaleSlots: number | null = null;
        if (gpSource === 'ama' && Number.isFinite(minP) && Number.isFinite(maxP)
            && isGridRangeScalingWhitelisted) {
            const dw = amaSnapshot?.dynamicWeights;
            // Fallback to root-level asymmetricBounds when dynamicWeights is
            // absent (asymmetricBounds: true without dynamicWeight: true).
            const rootBounds = !dw && amaSnapshot?.asymmetricBounds
                && typeof amaSnapshot.asymmetricBounds === 'object'
                ? amaSnapshot.asymmetricBounds
                : null;
            if (dw) {
                const maxAsymmetryFactor = resolveMaxAsymmetryFactor(
                    manager.config.asymmetricBounds?.maxAsymmetryFactor,
                    dw?.maxAsymmetryFactor,
                    MARKET_ADAPTER.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR
                );
                const adjustment = applyAsymmetricBounds({
                    centerPrice: gp,
                    minPrice: minP,
                    maxPrice: maxP,
                    trend: dw?.trend,
                    slopeOffset: dw?.slopeOffset,
                    maxSlopeOffset: dw?.maxSlopeOffset,
                    maxAsymmetryFactor,
                });
                if (Number.isFinite(adjustment.appliedAsymmetryFactor)) {
                    resolvedMinP = adjustment.resolvedMinPrice;
                    resolvedMaxP = adjustment.resolvedMaxPrice;
                    rangeScalingFactor = Number(adjustment.appliedAsymmetryFactor);
                    appliedTrend = (dw?.trend === 'UP' || dw?.trend === 'DOWN') ? dw.trend : null;
                    minScaleSlots = resolveMinScaleSlots(manager.config.asymmetricBounds?.minScaleSlots, dw?.minScaleSlots);
                    manager.logger?.log?.(
                        `[BOUND-ASYMMETRY] trend=${dw.trend} slopeOffset=${dw.slopeOffset.toFixed(4)} `
                        + `raw=${((adjustment.rawAsymmetryFactor ?? 0) * 100).toFixed(1)}% `
                        + `cap=${((maxAsymmetryFactor ?? 0) * 100).toFixed(0)}% `
                        + `asymmetry=${((adjustment.appliedAsymmetryFactor ?? 0) * 100).toFixed(1)}% `
                        + `min ${(minP ?? 0).toFixed(8)}→${(resolvedMinP ?? 0).toFixed(8)} `
                        + `max ${(maxP ?? 0).toFixed(8)}→${(resolvedMaxP ?? 0).toFixed(8)}`,
                        'info'
                    );
                }
            } else if (rootBounds && Number.isFinite(rootBounds.appliedAsymmetryFactor)
                && (rootBounds.trend === 'UP' || rootBounds.trend === 'DOWN')) {
                const asymmetry = Number(rootBounds.appliedAsymmetryFactor);
                const rootTrend = rootBounds.trend;
                if (rootTrend === 'DOWN') {
                    resolvedMinP = gp / ((gp / minP!) * (1 + asymmetry));
                    resolvedMaxP = gp * ((maxP! / gp) * (1 - asymmetry));
                } else {
                    resolvedMinP = gp / ((gp / minP!) * (1 - asymmetry));
                    resolvedMaxP = gp * ((maxP! / gp) * (1 + asymmetry));
                }
                rangeScalingFactor = asymmetry;
                appliedTrend = rootTrend;
                minScaleSlots = resolveMinScaleSlots(manager.config.asymmetricBounds?.minScaleSlots, rootBounds.minScaleSlots);
                manager.logger?.log?.(
                    `[BOUND-ASYMMETRY] trend=${rootTrend} `
                    + `asymmetry=${(asymmetry * 100).toFixed(1)}% `
                    + `(root-level) min ${(minP ?? 0).toFixed(8)}→${(resolvedMinP ?? 0).toFixed(8)} `
                    + `max ${(maxP ?? 0).toFixed(8)}→${(resolvedMaxP ?? 0).toFixed(8)}`,
                    'info'
                );
            }
        }

        let gridStartPrice = mp;
        let offsetAdjustedStartPrice = gridStartPrice;
        if (gpSource === 'ama' && gridPriceOffsetPct !== 0 && Number.isFinite(gridStartPrice) && gridStartPrice > 0) {
            const adjustedMarketPrice = gridStartPrice * (1 + (gridPriceOffsetPct / 100));
            manager.logger?.log?.(
                `[DIAGNOSTIC] initializeGrid: applying AMA market-price offset ${gridPriceOffsetPct.toFixed(3)}% `
                + `to startPrice ${gridStartPrice.toFixed(8)} -> ${adjustedMarketPrice.toFixed(8)}`,
                'info'
            );
            gridStartPrice = adjustedMarketPrice;
            offsetAdjustedStartPrice = adjustedMarketPrice;
        }
        const rMinP = resolvedMinP ?? 0;
        const rMaxP = resolvedMaxP ?? 0;
        if (!(gridStartPrice >= rMinP && gridStartPrice <= rMaxP)) {
            if (Number.isFinite(gp) && gp > 0 && gp >= rMinP && gp <= rMaxP) {
                gridStartPrice = gp;
                manager.logger?.log?.(
                    `initializeGrid: startPrice (${mp}) outside bounds [${rMinP}, ${rMaxP}]; using gridPrice center ${gp}`,
                    'warn'
                );
            } else {
                const clamped = clamp(gridStartPrice, rMinP, rMaxP);
                manager.logger?.log?.(
                    `initializeGrid: startPrice (${mp}) outside bounds [${rMinP}, ${rMaxP}]; clamping to ${clamped}`,
                    'warn'
                );
                gridStartPrice = clamped;
            }
        }

        // Narrowing-side slot guard: range scaling tightens one bound toward the
        // center. Without a floor this can collapse that side into a near-center
        // sliver holding few or zero active orders. Guarantee at least
        // minScaleSlots price levels remain between the grid center and the
        // tightened bound (in multiples of incrementPercent). The widened side
        // still extends freely.
        if (appliedTrend && Number.isFinite(gridStartPrice) && gridStartPrice > 0) {
            const inc = Number(manager.config.incrementPercent);
            const mss = Number.isFinite(minScaleSlots) ? Math.floor(Number(minScaleSlots)) : 0;
            if (Number.isFinite(inc) && inc > 0 && mss > 0) {
                const stepMult = 1 + (inc / 100);
                if (appliedTrend === 'DOWN' && resolvedMaxP != null) {
                    const keepAbove = gridStartPrice * Math.pow(stepMult, mss);
                    if (resolvedMaxP < keepAbove) {
                        manager.logger?.log?.(
                            `[BOUND-ASYMMETRY] narrowing-side guard: max ${resolvedMaxP.toFixed(8)} collapses ` +
                            `${mss} levels; holding at ${keepAbove.toFixed(8)}`,
                            'info'
                        );
                        resolvedMaxP = keepAbove;
                    }
                } else if (appliedTrend === 'UP' && resolvedMinP != null) {
                    const belowMin = gridStartPrice * Math.pow(1 - (inc / 100), mss);
                    if (resolvedMinP > belowMin) {
                        manager.logger?.log?.(
                            `[BOUND-ASYMMETRY] narrowing-side guard would pull min ${resolvedMinP.toFixed(8)} ` +
                            `short of ${mss} levels; holding at ${belowMin.toFixed(8)}`,
                            'info'
                        );
                        resolvedMinP = belowMin;
                    }
                }
            }
        }

        manager.config.minPrice = resolvedMinP;
        manager.config.maxPrice = resolvedMaxP;
        manager._lastGridPricingContext = {
            gridPrice: gp,
            gridPriceOffsetPct,
            offsetAdjustedStartPrice,
            startPrice: gridStartPrice,
            configuredMinPrice,
            configuredMaxPrice,
            rangeScalingFactor
        };

        // Ensure percentage-based funds are resolved before sizing
        try {
            if (manager.accountId && !manager.accountTotals) {
                await manager.waitForAccountTotals(TIMING.ACCOUNT_TOTALS_TIMEOUT_MS);
            }
        } catch (e: any) {
            manager.logger?.log?.(`Failed to load account totals: ${getErrorMessage(e)}`, 'warn');
            // FIX: Add error handling - cannot proceed with grid initialization without account totals
            // Continuing would create grid with 0 fund allocation, rendering it non-functional
            throw new Error(`Cannot initialize grid without account totals: ${getErrorMessage(e)}`);
        }

        const { orders, boundaryIdx, initialSpreadCount, gapSlots } = createOrderGrid({
            ...manager.config,
            startPrice: gridStartPrice,
            minPrice: resolvedMinP,
            maxPrice: resolvedMaxP,
        });
        manager._gapSlots = gapSlots;

        // RC-8: Update boundary with notification to dependent systems
        // Persist master boundary for StrategyEngine
        if (manager.boundaryIdx !== boundaryIdx) {
            manager._restoreBoundary(boundaryIdx);
            // RC-8: Notify StrategyEngine of boundary change (if method exists)
            if (typeof manager.notifyBoundaryUpdate === 'function') {
                try {
                    manager.notifyBoundaryUpdate(boundaryIdx);
                } catch (err: any) {
                    manager.logger?.log?.(`Error notifying boundary update: ${getErrorMessage(err)}`, 'warn');
                }
            }
        }

        const minSellSize = getMinOrderSize(ORDER_TYPES.SELL, manager.assets);
        const minBuySize = getMinOrderSize(ORDER_TYPES.BUY, manager.assets);

        const { A: precA, B: precB } = getPrecisionsForManager(manager.assets);

        // Use centralized sizing context for both sides.
        // Resolve funds once upfront so both contexts share the same snapshot,
        // avoiding a redundant recalculateFunds inside the second _getSizingContext call.
        await manager.recalculateFunds();
        const sellCtx = await _getSizingContext(manager, 'sell', { skipRecalc: true });
        const buyCtx = await _getSizingContext(manager, 'buy', { skipRecalc: true });

        if (!sellCtx || !buyCtx) throw new Error('Failed to retrieve sizing context for grid initialization');

        let sizedOrders = calculateOrderSizes(
            orders,
            manager.config,
            sellCtx.budget,
            buyCtx.budget,
            minSellSize,
            minBuySize,
            precA,
            precB
        );

        // Verification of sizes
        const sells = filterOrdersByType(sizedOrders, ORDER_TYPES.SELL).map((o: any) => Number(o.size || 0));
        const buys = filterOrdersByType(sizedOrders, ORDER_TYPES.BUY).map((o: any) => Number(o.size || 0));
        if (checkSizesBeforeMinimum(sells, minSellSize, precA) || checkSizesBeforeMinimum(buys, minBuySize, precB)) {
            throw new Error('Calculated orders fall below minimum allowable size.');
        }

        // Check for warning if orders are near minimal size (regression fix)
        const warningSellSize = minSellSize > 0 ? getMinOrderSize(ORDER_TYPES.SELL, manager.assets, 100) : 0;
        const warningBuySize = minBuySize > 0 ? getMinOrderSize(ORDER_TYPES.BUY, manager.assets, 100) : 0;
        if (checkSizeThreshold(sells, warningSellSize, precA, false) || checkSizeThreshold(buys, warningBuySize, precB, false)) {
            manager.logger?.log?.("WARNING: Order grid contains orders near minimum size. To ensure the bot runs properly, consider increasing the funds of your bot.", "warn");
        }

        // RC-2: Wrap atomic changes in grid lock
        await manager._gridLock.acquire(async () => {
            _clearOrderCachesLogic(manager);
            await manager._fundLock.acquire(async () => {
                await manager.resetFunds();
            });

            manager.pauseRecalcLogging();
            manager.pauseFundRecalc();
            try {
                // RC-2: Use _applyOrderUpdate (PRIVATE/UNLOCKED)
                for (const order of sizedOrders) {
                    await manager._applyOrderUpdate(order, 'grid-init', { skipAccounting: true });
                }
            } finally {
                await manager.resumeFundRecalc();
                manager.resumeRecalcLogging();
            }

            // RC-6: Spread count updates protected by grid lock.
            // initializeGrid always sets initialSpreadCount = gapSlots (theoretical
            // value for a fresh grid).  loadGrid uses the actual SPREAD-typed slot
            // count in the gap band, which may be lower after promotions absorbed
            // gap slots into a rail.  Both are correct for their context; callers
            // should not assume the two paths agree.
            manager.initialSpreadCount = initialSpreadCount.buy + initialSpreadCount.sell;
            manager.currentSpreadCount = manager.initialSpreadCount;
        });
        // FIX: Use consistent optional chaining pattern for all logger calls
        manager.logger?.log?.(`Initialized grid with ${orders.length} orders.`, 'info');
        manager.logger?.logFundsStatus?.(manager);
        manager.logger?.logOrderGrid?.(Array.from(manager.orders.values()) as Order[], gridStartPrice);
    }

    /**
     * Full grid resynchronization from blockchain state.
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @param {Object} opts - Options for resynchronization.
     * @param {Function} opts.readOpenOrdersFn - Function to read open orders.
     * @param {Object} opts.chainOrders - Chain orders module.
     * @param {string} opts.account - Account name.
     * @param {string} opts.privateKey - Private key.
     * @returns {Promise<void>}
     */
export async function recalculateGrid(manager: any, opts: any): Promise<void> {
        const { readOpenOrdersFn, chainOrders, account, privateKey } = opts;

        // Suppress invariant warnings during full resync
        manager.startBootstrap();

        // Total timeout across all steps — prevents indefinite hang even if
        // an individual withBlockchainRetry step pins the event loop.
        const totalTimeoutMs = PIPELINE_TIMING.TIMEOUT_MS * 2; // 10 min
        let _resyncAborted = false;

        const work = (async () => {
            try {
                manager.logger?.log?.('Starting full resync...', 'info');
                if (_resyncAborted) return;

                // #1: Initialize assets with timeout + retry + node failover
                try {
                    await withBlockchainRetry(
                        () => manager._initializeAssets(),
                        'initializeAssets',
                        { logger: manager.logger }
                    );
                } catch (e: any) {
                    manager.logger?.log?.(`Asset initialization failed during resync: ${getErrorMessage(e)}`, 'warn');
                }
                if (_resyncAborted) return;

                // #2: Fetch account totals with timeout + retry + node failover
                await withBlockchainRetry(
                    () => manager.fetchAccountTotals(),
                    'fetchAccountTotals',
                    { logger: manager.logger }
                );
                if (_resyncAborted) return;

                // #3: Read open orders with timeout + retry + node failover
                const chainOpenOrders = await withBlockchainRetry(
                    () => readOpenOrdersFn(),
                    'readOpenOrders',
                    { logger: manager.logger }
                );
                if (_resyncAborted) return;
                if (!Array.isArray(chainOpenOrders)) return;

                await withBlockchainRetry(
                    () => manager.syncFromOpenOrders(chainOpenOrders, { skipAccounting: true }),
                    'syncFromOpenOrders',
                    { logger: manager.logger }
                );
                if (_resyncAborted) return;

                // resetFunds under _fundLock + snapshot; persistGrid outside lock to
                // avoid blocking concurrent fund operations (tryDeductFromChainFree,
                // updateOptimisticFreeBalance, etc.) behind file I/O.  Same pattern as
                // loadGrid (grid.ts:~557) except that path skips persistGrid.
                let fundSnapshot!: { btsFeesOwed: number; accountTotals: any };
                await manager._fundLock.acquire(async () => {
                    await manager.resetFunds();
                    fundSnapshot = {
                        btsFeesOwed: manager.funds.btsFeesOwed,
                        accountTotals: manager.accountTotals
                    };
                });

                if (_resyncAborted) return;
                await manager.persistGrid(undefined, undefined, fundSnapshot);

                if (_resyncAborted) return;
                await initializeGrid(manager);

                if (_resyncAborted) return;
                const { reconcileGridOrders } = require('./grid_reconcile');

                // #5: Reconcile grid orders.
                // No per-attempt wall-clock race around the whole reconcile.
                // Phase 2 performs many sequential broadcasts (creates ~3s each)
                // plus per-op retry with on-chain verification
                // (grid_reconcile_internal._createOrderFromGrid: uncertain creates
                // are re-read, adopted if landed, and re-broadcast only on
                // authoritative absence). An outer timeout would fire mid-batch,
                // orphan in-flight broadcasts, and let the next attempt virtualize
                // and re-create them — the duplicate-accumulation death spiral.
                // Reads inside reconcile already follow the 30s/3-retry/node-
                // failover standard via withBlockchainRetry, and the 10-min
                // totalTimeoutMs safety net below bounds the whole resync.
                try {
                    await reconcileGridOrders({ manager, config: manager.config, account, privateKey, chainOrders, chainOpenOrders });
                } catch (err: any) {
                    manager.logger?.log?.(`Error during startup order reconciliation: ${getErrorMessage(err)}`, 'error');
                    throw new Error(`Grid recalculation failed during order reconciliation: ${getErrorMessage(err)}`);
                }
                if (_resyncAborted) return;

                manager.logger?.log?.('Full resync complete.', 'info');
            } finally {
                manager.finishBootstrap();
            }
        })();

        // Swallow late rejection if timeout wins the race
        Promise.resolve(work).catch(() => {});
        let timeoutId: any;
        const result = await Promise.race([
            work,
            new Promise<void>((_, reject) => {
                timeoutId = setTimeout(
                    () => {
                        _resyncAborted = true;
                        reject(new Error(`recalculateGrid timed out after ${totalTimeoutMs}ms`));
                    },
                    totalTimeoutMs
                );
            })
        ]);
        clearTimeout(timeoutId);
        return result;
    }

    /**
     * Check for grid divergence and trigger update if threshold is met.
     *
     * @param {import('./types').OrderManager} manager - Manager instance with order state
     * @returns {any}
     */
export function checkAndUpdateGridIfNeeded(manager: any): any {
        const threshold = manager.config?.gridLimits?.GRID_REGENERATION_PERCENTAGE;
        const chainSnap = manager.getChainFundsSnapshot();
        const gridBuy = Number(manager.funds?.total?.grid?.buy || 0);
        const gridSell = Number(manager.funds?.total?.grid?.sell || 0);
        const result = { buyUpdated: false, sellUpdated: false };

        const sides = [
            { name: 'buy', grid: gridBuy, orderType: ORDER_TYPES.BUY },
            { name: 'sell', grid: gridSell, orderType: ORDER_TYPES.SELL }
        ];

        for (const s of sides) {
            if (s.grid <= 0) continue;

            const availableFunds = calculateAvailableFundsValue(
                s.name,
                manager.accountTotals,
                manager.funds,
                manager.config.assetA,
                manager.config.assetB,
                manager.config.activeOrders,
                manager.config.min_BTS_value,
                manager.config.feeParams ?? null
            );

            // Denominator: side's allocated capital (or chain total fallback).
            const allocated = s.name === 'buy' ? chainSnap.allocatedBuy : chainSnap.allocatedSell;
            const denominator = (allocated > 0) ? allocated : (s.grid + availableFunds);
            const ratio = (denominator > 0) ? (availableFunds / denominator) * 100 : 0;

            manager.logger?.log?.(
                `[DIVERGENCE] ${s.name.toUpperCase()} ratio check: availableFunds=${availableFunds.toFixed(5)}, allocated=${allocated.toFixed(5)}, ratio=${ratio.toFixed(4)}% (threshold=${threshold}%) → ${ratio >= threshold ? 'TRIGGER' : 'no trigger'}`,
                'debug'
            );

            if (ratio >= threshold) {
                // RC-3: Use Set for automatic duplicate prevention
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(s.orderType);
                if (s.name === 'buy') result.buyUpdated = true; else result.sellUpdated = true;
            }
        }
        return result;
    }

    /**
     * Standardize grid sizes using blockchain total context.
     *
     * FUND CAPPING STRATEGY:
     * =====================
     * During grid regeneration (e.g., after fills increase available funds),
     * this method recalculates all order sizes using geometric weighting.
     * However, ACTIVE/PARTIAL orders must not grow larger than currently available funds.
     *
     * Rationale for capping:
     * 1. POST-FILL EXPANSION PREVENTION: After a large fill, funds become available.
     *    A naive size recalculation might expand orders, consuming all new capital.
     *    Capping prevents this "resize explosion" by limiting growth to available free balance.
     * 2. VIRTUAL ORDER PROTECTION: Virtual orders (not yet placed) are uncapped,
     *    allowing natural expansion when their slot comes up for placement.
     * 3. BLOCKCHAIN-BACKED CONSTRAINT: sideFreeAvailable tracks exactly what we can spend,
     *    decreasing as commitments grow (proportional to realized delta).
     *
     * Fund Capping Algorithm:
     * ========================
     * For each ACTIVE/PARTIAL order slot:
     *   1. Calculate new size from geometric series
     *   2. If delta > 0 (growth):
     *      - affordableDelta = min(delta, sideFreeAvailable)
     *      - Cap growth to what we actually have: newSize = currentSize + affordableDelta
     *      - Deduct from sideFreeAvailable (this spending is now committed)
     *   3. If delta < 0 (shrinkage):
     *      - Release the freed capital back to sideFreeAvailable
     *      - Allows later slots to grow into this freed capacity
     *   4. For VIRTUAL orders (not on-chain):
     *      - Apply new size directly (no capping)
     *      - They will be constrained when actually placed
     *
     * Example (2 slots, buy side, budget=1000, simplify to linear):
     * ========================================================
     * Initial: slot[0]=400 (ACTIVE), slot[1]=0 (VIRTUAL), sideFree=600
     * Recalc:  newSizes=[500, 500]
     *
     *   Process slot[0]:
     *     - Type: ACTIVE, current=400, new=500, delta=+100
     *     - affordableDelta = min(100, 600) = 100
     *     - Apply: size=500 (full growth), sideFree=500
     *
     *   Process slot[1]:
     *     - Type: VIRTUAL (not capped), current=0, new=500, delta=+500
     *     - Apply: size=500 (no cap check)
     *     - Result: slot[1] ready for placement, will consume from sideFree when placed
     *
     * @param {import('./types').OrderManager} manager - OrderManager instance
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Object} [options] - Options object
     * @param {import('./working_grid.js')} [options.workingGrid] - Working grid for COW pattern
     * @returns {Promise<{actions: Array, changed: boolean}|undefined>} - COW result or undefined
     * @private
     */
export async function _recalculateGridOrderSizesFromBlockchain(manager: any, orderType: any, options: { workingGrid?: any } = {}) {
        if (!manager.assets) return options?.workingGrid ? { actions: [], changed: false } : undefined;

        const workingGrid = options?.workingGrid || null;
        const collectActions = !!workingGrid;

        const isBuy = orderType === ORDER_TYPES.BUY;
        const sideName = isBuy ? 'buy' : 'sell';

        // Use centralized sizing context (respects botFunds % allocation)
        const ctx = await _getSizingContext(manager, sideName);
        if (!ctx) return collectActions ? { actions: [], changed: false } : undefined;

        // Get ALL slots for this side, sorted for calculateRotationOrderSizes.
        // SELL: sorted ASC (Market to Edge)
        // BUY: sorted ASC (Edge to Market)
        //
        // When a working grid is available (COW mode), read types from it
        // instead of manager.orders.  This ensures slots whose type changed
        // due to a boundary shift (e.g. SPREAD→BUY) are included in the
        // correct side's size calculation — using manager.orders here would
        // filter by stale pre-shift types and miss the crossers, producing a
        // budget allocation that doesn't match the post-shift grid structure.
        //
        // Empty (size-0 VIRTUAL) slots are stored SPREAD (side-neutral) after
        // normalization and are deliberately NOT included in the side's
        // ideal-size denominator here: a SPREAD slot cannot carry a size
        // (validateOrder forces SPREAD size back to 0), so including it would
        // only dilute the budget without giving the slot a usable size.
        // Activation sizing for empties is handled where re-typing happens:
        // spread-correction (prepareSpreadCorrectionOrders) and startup
        // reconcile (_deriveBudgetedSideSizes) both compute the full in-rail
        // geometric progression including empties, then re-type the picked slot
        // to BUY/SELL before placement.  The COW boundary-shift path re-types
        // the working grid by geometry first, so crossers stay in the correct
        // side's denominator.
        const orderSource = collectActions ? workingGrid : manager.orders;
        const allSideSlots = (Array.from(orderSource.values()) as Order[])
            .filter((o: any) => o.type === orderType)
            .sort((a: any, b: any) => a.price - b.price);

        if (allSideSlots.length === 0) return collectActions ? { actions: [], changed: false } : undefined;

        // Calculate geometric sizes for the ENTIRE rail
        const newSizes = calculateRotationOrderSizes(
            ctx.budget,
            0,
            allSideSlots.length,
            orderType,
            manager.config,
            0,
            ctx.precision
        );

        const actions: any[] = [];
        let changed = false;

        const freeKey = isBuy ? 'buyFree' : 'sellFree';
        let sideFreeAvailable = Number(manager.accountTotals?.[freeKey] || 0);

        if (!collectActions) manager.pauseRecalcLogging();
        try {
            // Apply new sizes to all slots on the side
            for (let i = 0; i < allSideSlots.length; i++) {
                const slot = allSideSlots[i];
                let newSize = newSizes[i] || 0;

                // FUND CAPPING FOR COMMITTED (ON-CHAIN) ORDERS:
                // Only ACTIVE/PARTIAL orders are constrained by available funds.
                // Virtual orders (not yet placed) will be constrained when they are actually placed.
                //
                // NOTE: BTS update fees are paid from BTS balance (separate from asset balance),
                // so they don't affect this asset-side size cap. Fee budgets are tracked in
                // funds.btsFeesOwed and reserved separately via btsFeesReservation.
                const isCommitted = isOrderOnChain(slot);
                if (isCommitted) {
                    const currentSize = Number(slot.size || 0);
                    const delta = newSize - currentSize;
                    if (delta > 0) {
                        // GROWTH: Cap to available free balance
                        // This prevents aggressive expansion after fills
                        const affordableDelta = Math.min(delta, Math.max(0, sideFreeAvailable));
                        if (affordableDelta < delta) {
                            // Cannot afford full growth; cap to what's available
                            newSize = currentSize + affordableDelta;
                        }
                        sideFreeAvailable = Math.max(0, sideFreeAvailable - affordableDelta);
                    } else if (delta < 0) {
                        // SHRINKAGE: Release freed capital back for other slots
                        sideFreeAvailable += Math.abs(delta);
                    }
                }

                // Use integer comparison to avoid redundant updates from float noise
                const currentSizeInt = floatToBlockchainInt(slot.size || 0, ctx.precision);
                const newSizeInt = floatToBlockchainInt(newSize, ctx.precision);

                if (slot.size === undefined || currentSizeInt !== newSizeInt) {
                    changed = true;

                    if (collectActions) {
                        workingGrid.set(slot.id, {
                            ...slot,
                            size: newSize
                        });

                        if (isCommitted && hasOnChainId(slot)) {
                            actions.push({
                                type: COW_ACTIONS.UPDATE,
                                id: slot.id,
                                orderId: slot.orderId,
                                newGridId: slot.id,
                                newSize,
                                newPrice: slot.price,
                                order: {
                                    id: slot.id,
                                    type: slot.type,
                                    price: slot.price,
                                    size: newSize
                                }
                            });
                        }
                    } else {
                        // CRITICAL: Set skipAccounting=false to ensure delta is consumed/released from ChainFree
                        const resizeOk = await manager._updateOrder(
                            { ...slot, size: newSize },
                            'grid-resize',
                            { skipAccounting: false, fee: 0 }
                        );
                        if (resizeOk === false) {
                            manager.logger?.log?.(`Failed to resize order ${slot.id}`, 'warn');
                        }
                    }
                }

            }

            if (!collectActions) {
                await manager.recalculateFunds();
            }
        } finally {
            if (!collectActions) manager.resumeRecalcLogging();
        }

        if (collectActions) {
            return { actions, changed };
        }

        return undefined;
    }

    /**
     * High-level entry for resizing grid from snapshot using COW pattern.
     * Creates working grid, calculates new sizes, generates UPDATE actions.
     * Master grid is only updated after successful blockchain confirmation.
     *
     * @param {import('./types').OrderManager} manager - Manager instance
     * @param {string} orderType - 'buy', 'sell', or 'both' - which sides to update
     * @param {boolean} [fromBlockchainTimer=false] - If true, skip refetch of account totals (already current)
     * @param {number|null} [overrideBoundaryIdx=null] - Optional override for boundary index
     * @returns {Promise<{actions: Array, workingGrid: import('./working_grid.js'), workingIndexes: Object, workingBoundary: number, hasWorkingChanges: boolean, aborted: boolean}|null>}
     */
export async function updateGridFromBlockchainSnapshot(manager: any, orderType: any = 'both', fromBlockchainTimer: any = false, overrideBoundaryIdx: any = null) {
        if (!fromBlockchainTimer && manager.config?.accountId) {
            await manager.fetchAccountTotals(manager.config.accountId);
        }

        const { WorkingGrid } = require('./working_grid');
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        const allActions: any[] = [];
        let hasWorkingChanges = false;

        const newBoundary = (overrideBoundaryIdx !== null) ? overrideBoundaryIdx : manager.boundaryIdx;

        // REASSIGN SLOT TYPES FIRST when the boundary is shifting.
        // _recalculateGridOrderSizesFromBlockchain needs to see the corrected
        // types so that slots which cross the boundary (e.g. SPREAD→BUY) are
        // included in the correct side's budget allocation.  Running assignGridRoles
        // after the size calc means crossers keep their pre-shift sizes, producing
        // an allocation that doesn't match the post-shift grid structure.
        //
        // NOTE: syncBoundaryToFunds is a pure computation (no eager write), so
        // manager.boundaryIdx still carries the pre-shift value here.  The
        // overrideBoundaryIdx !== manager.boundaryIdx check correctly detects
        // that a shift is needed.  The boundary is only written atomically
        // inside _commitWorkingGrid via _setBoundary.
        if (overrideBoundaryIdx !== null && overrideBoundaryIdx !== manager.boundaryIdx) {
            const gapSlots = manager._gapSlots ?? calculateGapSlots(manager.config.incrementPercent, manager.config.targetSpreadPercent, manager.config.gridLimits);
            const allSlots = (Array.from(workingGrid.values()) as Order[])
                .filter((s: any) => s.price != null)
                .sort((a: any, b: any) => a.price - b.price);
            const updatedSlots = assignGridRoles(allSlots, newBoundary, gapSlots, ORDER_TYPES, ORDER_STATES, { assignOnChain: true });
            for (const slot of updatedSlots) {
                workingGrid.set(slot.id, slot);
            }
            hasWorkingChanges = true;
        }

        // Calculate size updates for each side (via existing sizing function in COW mode).
        // _recalculateGridOrderSizesFromBlockchain reads types from the working grid when
        // one is passed, so boundary-crossing slots are now correctly classified.
        if (orderType === ORDER_TYPES.BUY || orderType === 'both') {
            const buyResult = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.BUY, { workingGrid })!;
            allActions.push(...buyResult!.actions);
            hasWorkingChanges = hasWorkingChanges || buyResult!.changed;
        }
        if (orderType === ORDER_TYPES.SELL || orderType === 'both') {
            const sellResult = await _recalculateGridOrderSizesFromBlockchain(manager, ORDER_TYPES.SELL, { workingGrid })!;
            allActions.push(...sellResult!.actions);
            hasWorkingChanges = hasWorkingChanges || sellResult!.changed;
        }

        // Return COW result only if there are changes
        if (allActions.length === 0 && !hasWorkingChanges) {
            return null;
        }

        return {
            actions: allActions,
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: newBoundary,
            hasWorkingChanges,
            aborted: false
        };
    }

    /**
     * Compare ideal grid vs persisted grid to detect divergence.
     * INDEPENDENT SIDE CHECKING: Buy and sell sides are evaluated independently.
     * Each side's RMS divergence is compared against its own threshold.
     * Only sides exceeding the threshold are marked for update.
     *
     * PURPOSE: Detect if the calculated in-memory grid has diverged significantly from the
     * persisted grid state. High divergence indicates that order fills/rotations have caused
     * size distributions to deviate, potentially requiring grid size recalculation.
     *
     * METRIC: RMS (Root Mean Square) percentage of relative size differences
     * Formula: RMS% = sqrt(mean((calculated - persisted) / persisted)²) × 100
     * This measures the typical relative error across all orders on each side.
     *
     * SIDE INDEPENDENCE:
     * - Buy side RMS is checked against GRID_COMPARISON.RMS_PERCENTAGE independently
     * - Sell side RMS is checked against GRID_COMPARISON.RMS_PERCENTAGE independently
     * - One side can diverge while the other remains stable (no update for stable side)
     *
     * RC-4: Atomic snapshot taking prevents stale data from concurrent fill operations
     *   - Grids are snapshotted atomically before comparison
     *   - Prevents mixing old and new grid state
     *   - Ensures consistent RMS metrics across both sides
     *
     * @param {Array<any>} calculatedGrid - Ideal calculated grid
     * @param {Array<any>} persistedGrid - Persisted grid state
     * @param {import('./types').OrderManager|null} [manager=null] - Manager instance (for grid lock access)
     * @returns {Promise<any>}
     */
export async function compareGrids(calculatedGrid: any, persistedGrid: any, manager: any = null): Promise<any> {
        if (!Array.isArray(calculatedGrid) || !Array.isArray(persistedGrid)) {
            return { buy: { metric: 0, updated: false }, sell: { metric: 0, updated: false } };
        }

        // RC-4: Take snapshots atomically to prevent concurrent modification races
        // If manager has grid lock, use it to get consistent snapshots
        let calculatedSnap = calculatedGrid;
        let persistedSnap = persistedGrid;

        if (manager?._gridLock?.acquire) {
            const snapshotResult = await manager._gridLock.acquire(() => {
                return {
                    calculated: Array.from(calculatedGrid),
                    persisted: Array.from(persistedGrid)
                };
            });
            calculatedSnap = snapshotResult.calculated;
            persistedSnap = snapshotResult.persisted;
        }

        // Filter to ACTIVE orders only (excludes PARTIAL/VIRTUAL/SPREAD)
        // Partial orders are excluded from divergence calculation as they are expected to deviate;
        // they are instead handled by the available-funds ratio check or follow-up correction.
        // Must be sorted ASC for calculateRotationOrderSizes to match geometric weight distribution
        const filterForRms = (orders: any, type: any): any[] => {
            const result = Array.isArray(orders) ? orders.filter((o: any) => o && o.type === type && o.state === ORDER_STATES.ACTIVE) : [];
            return result
                .sort((a: any, b: any) => (a.price ?? 0) - (b.price ?? 0));
        };

        const calculatedBuys = filterForRms(calculatedSnap, ORDER_TYPES.BUY);
        const calculatedSells = filterForRms(calculatedSnap, ORDER_TYPES.SELL);
        const persistedBuys = filterForRms(persistedSnap, ORDER_TYPES.BUY);
        const persistedSells = filterForRms(persistedSnap, ORDER_TYPES.SELL);

        // Calculate ideal sizes for each order based on current available budget.
        // The sizing context (which includes recalculateFunds) is resolved once per side up front
        // so both buy and sell metrics share a single fund snapshot. This avoids the previous
        // double-recalculateFunds between the two sides and keeps the metric consistent even if
        // a fill event arrives between per-side calculations.
        const computeSideIdeals = (activeOrders: any, type: any, ctx: any): any => {
            if (!manager || !ctx || ctx.budget <= 0 || activeOrders.length === 0) return activeOrders;

            // Identify ALL slots currently assigned to this side from the calculated
            // grid snapshot (not a fresh read from manager.orders).  Using the snapshot
            // avoids TOCTOU races and ensures the slot classification is consistent with
            // the grid state used for the RMS computation.  If a boundary shift is pending
            // (set via _gridSidesUpdated but not yet committed through the COW pipeline),
            // the types in manager.orders are stale — reading from the snapshot matches
            // what the rest of the comparison sees.
            const sideSlots = (calculatedSnap as any[])
                .filter((o: any) => o.type === type)
                .sort((a: any, b: any) => (a.price ?? 0) - (b.price ?? 0));

            if (sideSlots.length === 0) return activeOrders;

            // Calculate geometric ideals for the ENTIRE side (all slots)
            try {
                const allIdealSizes = calculateRotationOrderSizes(
                    ctx.budget,
                    0,
                    sideSlots.length,
                    type,
                    manager.config,
                    0,
                    ctx.precision
                );

                // Map Ideal sizes to IDs for quick lookup
                const idealMap = new Map();
                sideSlots.forEach((slot: any, i: any) => idealMap.set(slot.id, allIdealSizes[i]));

                // Return the activeOrders subset with their true geometric ideal sizes
                return activeOrders.map((o: any) => ({ ...o, size: idealMap.get(o.id) ?? 0 }));
            } catch (e: any) {
                return activeOrders;
            }
        };

        const needsBuy = calculatedBuys.length > 0 && manager?.assets;
        const needsSell = calculatedSells.length > 0 && manager?.assets;
        if (needsBuy || needsSell) {
            await manager.recalculateFunds();
        }
        const buyCtx = needsBuy
            ? await _getSizingContext(manager, 'buy', { skipRecalc: true })
            : null;
        const sellCtx = needsSell
            ? await _getSizingContext(manager, 'sell', { skipRecalc: true })
            : null;

        const buyIdeals = computeSideIdeals(calculatedBuys, ORDER_TYPES.BUY, buyCtx);
        const sellIdeals = computeSideIdeals(calculatedSells, ORDER_TYPES.SELL, sellCtx);

        // Calculate RMS divergence metric for each side
        const buyMetric = calculateGridSideDivergenceMetric(buyIdeals, persistedBuys, 'buy');
        const sellMetric = calculateGridSideDivergenceMetric(sellIdeals, persistedSells, 'sell');

        // Check if metrics exceed threshold and flag sides for regeneration
        // Set RMS_PERCENTAGE to 0 to disable RMS divergence checks
        let buyUpdated = false, sellUpdated = false;
        if (manager && (manager.config?.gridLimits?.GRID_COMPARISON?.RMS_PERCENTAGE ?? GRID_COMPARISON.RMS_PERCENTAGE) > 0) {
            const limit = (manager.config?.gridLimits?.GRID_COMPARISON?.RMS_PERCENTAGE ?? GRID_COMPARISON.RMS_PERCENTAGE) / GRID_CONSTANTS.RMS_PERCENTAGE_SCALE;

            if (buyMetric > limit) {
                // RC-3: Use Set for automatic duplicate prevention
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(ORDER_TYPES.BUY);
                buyUpdated = true;
            }
            if (sellMetric > limit) {
                // RC-3: Use Set for automatic duplicate prevention
                if (!(manager._gridSidesUpdated instanceof Set)) manager._gridSidesUpdated = new Set();
                manager._gridSidesUpdated.add(ORDER_TYPES.SELL);
                sellUpdated = true;
            }
        }

        return {
            buy: { metric: buyMetric, updated: buyUpdated },
            sell: { metric: sellMetric, updated: sellUpdated },
            totalMetric: (buyMetric + sellMetric) / 2
        };
    }

    /**
     * Unified divergence monitoring.
     * Performs both Ratio-based and RMS-based divergence checks.
     * 
     * @param {import('./types').OrderManager} manager - Manager instance
     * @param {Array<any>} calculatedGrid - Ideal/calculated grid
     * @param {Array<any>} persistedGrid - Current/persisted grid
     * @returns {Promise<any>}
     */
export async function monitorDivergence(manager: any, calculatedGrid: any, persistedGrid: any): Promise<any> {
        // 1. Check ratio-based divergence (available funds vs allocated)
        const ratioResult = checkAndUpdateGridIfNeeded(manager);

        if (ratioResult.buyUpdated || ratioResult.sellUpdated) {
            const { getOrderTypeFromUpdatedFlags } = require('./utils/order');
            return {
                needsUpdate: true,
                buy: { updated: ratioResult.buyUpdated, ratio: ratioResult.buyUpdated, rms: false, metric: 0 },
                sell: { updated: ratioResult.sellUpdated, ratio: ratioResult.sellUpdated, rms: false, metric: 0 },
                orderType: getOrderTypeFromUpdatedFlags(ratioResult.buyUpdated, ratioResult.sellUpdated)
            };
        }
        
        // 2. Check RMS-based divergence (structural deviation)
        const rmsResult = await compareGrids(calculatedGrid, persistedGrid, manager);
        
        const buyUpdated = ratioResult.buyUpdated || rmsResult.buy.updated;
        const sellUpdated = ratioResult.sellUpdated || rmsResult.sell.updated;
        
        const { getOrderTypeFromUpdatedFlags } = require('./utils/order');
        
        return {
            needsUpdate: buyUpdated || sellUpdated,
            buy: { updated: buyUpdated, ratio: ratioResult.buyUpdated, rms: rmsResult.buy.updated, metric: rmsResult.buy.metric },
            sell: { updated: sellUpdated, ratio: ratioResult.sellUpdated, rms: rmsResult.sell.updated, metric: rmsResult.sell.metric },
            orderType: getOrderTypeFromUpdatedFlags(buyUpdated, sellUpdated)
        };
    }

    /**
     * Collect on-chain buy and sell orders from the manager.
     * Filters to orders with valid orderId and positive size.
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @returns {{onChainBuys: Array<import('./types').Order>, onChainSells: Array<import('./types').Order>}}
     */
function _getOnChainOrders(manager: any): any {
        const onChainBuys = [
            ...manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE),
            ...manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.PARTIAL)
        ].filter((o: any) => o?.orderId && Number(o?.size || 0) > 0);

        const onChainSells = [
            ...manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE),
            ...manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.PARTIAL)
        ].filter((o: any) => o?.orderId && Number(o?.size || 0) > 0);

        return { onChainBuys, onChainSells };
    }

    /**
     * Calculate current market spread using on-chain orders.
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @returns {number} The calculated spread percentage.
     */
export function calculateCurrentSpread(manager: any): number {
        const { onChainBuys, onChainSells } = _getOnChainOrders(manager);
        return calculateSpreadFromOrders(onChainBuys, onChainSells);
    }

    /**
     * Proactive spread correction check.
     *
     * CRITICAL: Uses AsyncLock to prevent race conditions with fill processing.
     * Without the lock, a TOCTOU (Time-Of-Check-To-Use) vulnerability exists where:
     * - Fund snapshot is taken (check phase)
     * - Fill processor modifies funds in another thread
     * - Order is placed based on stale funds (use phase)
     * Result: Orders placed beyond available liquidity, fund accounting errors
     *
     * DESIGN DECISION: Lock is released before blockchain operations for performance
     * - Lock held: Fund verification and correction decision (synchronized)
     * - Lock released: Blockchain submission (async, potentially slow)
     * - RACE CONDITION WINDOW: Between lock release and blockchain submission
     * - MITIGATION: Pre-flight fund verification before submission; comprehensive error handling
     *
     * See RACE_CONDITION_ANALYSIS.md for detailed vulnerability documentation.
     *
     * @param {import('./types').OrderManager} manager - Manager instance
     * @param {Object} BitShares - BitShares API client
     * @param {Function|null} [updateOrdersOnChainBatch=null] - Optional batch update function
     * @returns {Promise<any>}
     */
export async function checkSpreadCondition(manager: any, _BitShares: any, updateOrdersOnChainBatch: any = null): Promise<any> {
        // CRITICAL: Acquire corrections lock to serialize spread correction operations
        // This prevents concurrent fill processing from modifying funds while we're making decisions
        let correction: any = null;
        let shouldApplyCorrection = false;

        if (!manager._gridLock) {
            manager.logger?.log?.('Spread check skipped: no grid lock available', 'warn');
            return { ordersPlaced: 0, partialsMoved: 0 };
        }

        // Derive current market price from the bot's own grid (no blockchain call needed).
        // Grid prices are in B/A format (e.g. BTS/XRP) so no inversion is required.
        // Mid between best bid and best ask is the most current price the bot has.
        // Falls back to config.startPrice when either side is empty (e.g. at startup).
        const { onChainBuys, onChainSells } = _getOnChainOrders(manager);
        const { bestBuy, bestSell } = getGridBestPrices(onChainBuys, onChainSells);
        const lastPrice = (bestBuy !== null && bestSell !== null)
            ? (bestBuy + bestSell) / 2
            : Number(manager.config.startPrice) || 0;

        // Lock guard is handled at function entry — if _gridLock is absent we return early.
        let fundSnapshot: any = null;

        // Detect empty-side condition: when one side has zero on-chain orders,
        // the spread is technically infinite and shouldFlagOutOfSpread's old
        // guard (return 0) prevented any correction from firing.  Now we
        // propagate the out-of-spread flag, but an empty side at a rail edge
        // (boundary clamped to 0 or allSlots.length-1) also needs a structural
        // resync to re-center the grid — spread correction alone would keep
        // activating SPREAD slots at suboptimal prices.
        const oneSideEmpty = onChainBuys.length === 0 || onChainSells.length === 0;

        const executeSpreadCheck = async () => {
            const currentSpread = calculateCurrentSpread(manager);

            // Nominal spread is the configured target spread percentage.
            // Keep this fixed: doubled-side flags are fill/replacement mechanics only.
            const nominalSpread = manager.config.targetSpreadPercent ?? DEFAULT_CONFIG.targetSpreadPercent;

            // Fixed tolerance: 0.5 steps = half increment (tighter spread check).
            const toleranceSteps = 0.5;

            const buyCount = manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.ACTIVE)
                .concat(manager.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.PARTIAL))
                .filter((o: any) => o?.orderId && Number(o?.size || 0) > 0)
                .length;
            const sellCount = manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.ACTIVE)
                .concat(manager.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.PARTIAL))
                .filter((o: any) => o?.orderId && Number(o?.size || 0) > 0)
                .length;

            manager.outOfSpread = shouldFlagOutOfSpread(currentSpread, nominalSpread, toleranceSteps, buyCount, sellCount, manager.config.incrementPercent);
            if (manager.outOfSpread === 0) return false;

            // Check whether the empty side is caused by boundary-at-rail-edge.
            // When the boundary crawl has clamped to 0 or allSlots.length-1,
            // fill pressure can wipe out one entire side.  Spread correction
            // can activate SPREAD slots, but the underlying grid structure
            // remains skewed — without a structural resync the gap will keep
            // returning as fills re-push the boundary to the rail edge.
            if (oneSideEmpty && manager.boundaryIdx !== null && typeof manager.boundaryIdx === 'number') {
                const allSlots = Array.from(manager.orders.values())
                    .filter((o: any) => o.price != null)
                    .sort((a: any, b: any) => a.price - b.price);
                const gapSlots = manager._gapSlots ?? calculateGapSlots(manager.config.incrementPercent, manager.config.targetSpreadPercent, manager.config.gridLimits);
                const railLen = allSlots.length;
                const buyEndIdx = manager.boundaryIdx;
                const sellStartIdx = getSellStartIdx(manager.boundaryIdx, gapSlots);
                const buySideCount = Math.max(0, Math.min(railLen, buyEndIdx + 1));
                const sellSideCount = Math.max(0, railLen - sellStartIdx);

                // Structural resync: both sides have room but one is empty.
                // Fire a structural resync to re-center the grid around the
                // current price, giving both sides a balanced foundation.
                // The spread correction below provides immediate relief
                // while the resync runs in the background.
                if (buySideCount < 2 || sellSideCount < 2) {
                    manager.logger?.log?.(
                        `[SPREAD] Boundary at rail edge (boundaryIdx=${manager.boundaryIdx}, ` +
                        `buySlots=${buySideCount}, sellSlots=${sellSideCount}). ` +
                        `Requesting structural grid resync to re-center.`,
                        'warn'
                    );
                    if (typeof manager.requestStructuralGridResync === 'function') {
                        manager.requestStructuralGridResync(
                            'boundary-at-rail-edge',
                            { reason: `Boundary ${manager.boundaryIdx} leaves ${buySideCount} buy / ${sellSideCount} sell slots` }
                        ).catch((err: any) => {
                            manager.logger?.log?.(
                                `[SPREAD] Structural resync request failed: ${getErrorMessage(err)}`,
                                'error'
                            );
                        });
                    }
                }
            }

            // Limit spread = nominal + half increment tolerance (0.5 steps).
            const limitSpread = nominalSpread + (manager.config.incrementPercent * toleranceSteps);
            manager.logger?.log?.(`Spread too wide (${Format.formatPercent(currentSpread)} > ${Format.formatPercent(limitSpread)}), correcting with ${manager.outOfSpread} extra slot(s)...`, 'warn');

            const decision = determineOrderSideByFunds(manager, lastPrice);
            if (!decision.side) return false;

            // Perform spread correction by placing orders on the chosen side.
            correction = await prepareSpreadCorrectionOrders(manager, decision.side, manager.outOfSpread);
            if (!correction) return false;
            let placeCount = correction.ordersToPlace?.length || 0;
            let updateCount = correction.ordersToUpdate?.length || 0;

            // STARVATION FALLBACK: If the selected side has no correctable slots (e.g.
            // all SPREAD slots already filled or misaligned), try the opposite side.
            if ((placeCount + updateCount) === 0) {
                const oppositeSide = decision.side === ORDER_TYPES.BUY ? ORDER_TYPES.SELL : ORDER_TYPES.BUY;
                manager.logger?.log?.(
                    `[SPREAD] Side ${decision.side} produced zero candidates; ` +
                    `trying opposite side ${oppositeSide}.`,
                    'debug'
                );
                const oppositeCorrection = await prepareSpreadCorrectionOrders(manager, oppositeSide, manager.outOfSpread);
                if (oppositeCorrection) {
                    correction = oppositeCorrection;
                    placeCount = correction.ordersToPlace?.length || 0;
                    updateCount = correction.ordersToUpdate?.length || 0;
                }
            }

            // Capture fund snapshot under lock for pre-flight verification before broadcast
            fundSnapshot = _snapshotFundState(manager);
            return (placeCount + updateCount) > 0;
        };

        try {
            shouldApplyCorrection = await manager._gridLock.acquire(executeSpreadCheck);
        } catch (err: any) {
            manager.logger?.log?.(`Error checking spread condition: ${getErrorMessage(err)}`, 'error');
            // Track failure in recovery state for external monitoring.
            // Do NOT throw — the startup runtime path lacks a try/catch and
            // a throw would crash startup. The error is symptom of a deeper
            // issue (lock contention, grid inconsistency) that should be
            // diagnosed separately.
            if (manager._recoveryState) {
                manager._recoveryState = { ...manager._recoveryState, lastFailureAt: Date.now() };
            }
            return { ordersPlaced: 0, partialsMoved: 0 };
        }

        // Blockchain operations are intentionally OUTSIDE the lock to reduce lock contention.
        // The lock is only needed for fund verification; order placement doesn't need it.
        // Pre-flight fund verification mitigates TOCTOU between lock release and broadcast.
        if (shouldApplyCorrection && updateOrdersOnChainBatch && correction && fundSnapshot) {
            const currentFunds = _snapshotFundState(manager);
            const fundChanged = fundSnapshot.buyFree !== currentFunds.buyFree
                || fundSnapshot.sellFree !== currentFunds.sellFree
                || fundSnapshot.buyLocked !== currentFunds.buyLocked
                || fundSnapshot.sellLocked !== currentFunds.sellLocked;
            if (fundChanged) {
                // TOCTOU: fund state changed between lock release and broadcast.
                // Lock-free re-plan — no _gridLock needed because the fund read
                // (recalculateFunds) is serialized by _fundLock internally, and
                // the remaining logic is read-only against COW-frozen state.
                // All grid-lock-needing work (fund verification, grid reads) is
                // done under the single outer acquire above; this re-plan runs
                // after that lock was released.
                // Refresh lastPrice from current grid state — the grid may
                // have changed since function entry (TOCTOU).
                const freshOnChain = _getOnChainOrders(manager);
                const freshBest = getGridBestPrices(freshOnChain.onChainBuys, freshOnChain.onChainSells);
                const freshPrice = (freshBest.bestBuy !== null && freshBest.bestSell !== null)
                    ? (freshBest.bestBuy + freshBest.bestSell) / 2
                    : Number(manager.config.startPrice) || 0;
                const rePlanDecision = determineOrderSideByFunds(manager, freshPrice);
                if (!rePlanDecision.side) {
                    manager.logger?.log?.(
                        `[SPREAD] Fund state changed; no side has sufficient funds for re-plan. Skipping cycle.`,
                        'warn'
                    );
                    return { ordersPlaced: 0, partialsMoved: 0 };
                }
                const rePlanCorrection = await prepareSpreadCorrectionOrders(manager, rePlanDecision.side, manager.outOfSpread);
                if (rePlanCorrection && ((rePlanCorrection.ordersToPlace?.length || 0) + (rePlanCorrection.ordersToUpdate?.length || 0) > 0)) {
                    correction = rePlanCorrection;
                    fundSnapshot = currentFunds;
                    manager.logger?.log?.(
                        `[SPREAD] Fund state changed between lock release and broadcast — ` +
                        `re-planned with updated funds: ${correction.ordersToPlace?.length || 0} creates, ` +
                        `${correction.ordersToUpdate?.length || 0} updates`,
                        'info'
                    );
                } else {
                    manager.logger?.log?.(
                        `[SPREAD] Fund state changed; re-plan produced no viable orders. Skipping cycle.`,
                        'warn'
                    );
                    return { ordersPlaced: 0, partialsMoved: 0 };
                }
            }
            try {
                const batchResult = await updateOrdersOnChainBatch(correction);
                if (!batchResult || batchResult.executed !== true) {
                    manager.logger?.log?.(`Spread correction batch was prepared but not executed. Keeping local state unchanged.`, 'warn');
                    return { ordersPlaced: 0, partialsMoved: 0 };
                }
            await manager.recalculateFunds();
                const placed = correction.ordersToPlace?.length || 0;
                const updated = correction.ordersToUpdate?.length || 0;
                return { ordersPlaced: placed + updated, partialsMoved: updated };
            } catch (err: any) {
                manager.logger?.log?.(`Error applying spread correction on-chain: ${getErrorMessage(err)}`, 'warn');
                return { ordersPlaced: 0, partialsMoved: 0 };
            }
        }
        return { ordersPlaced: 0, partialsMoved: 0 };
    }

    /**
     * Grid health check for structural violations.
     * Monitors for "Dust Partials" that are too small to be traded on-chain,
     * scoped to the active buy/sell window.
     *
     * NOTE: Internal gaps (virtual slots between active ones) are no longer
     * flagged as violations. The "Edge-First" placement strategy intentionally
     * creates these gaps to maximize grid coverage during fund expansion.
     *
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @param {Function|null} [updateOrdersOnChainBatch=null] - Optional batch update function.
     * @returns {Promise<any>}
     */
export async function checkGridHealth(manager: any, _updateOrdersOnChainBatch: any = null): Promise<any> {
        if (!manager) return { buyDust: false, sellDust: false, buyDustOrders: [], sellDustOrders: [] };

        // Skip health checks during bootstrap to prevent spamming warnings
        if (manager.isBootstrapping()) return { buyDust: false, sellDust: false, buyDustOrders: [], sellDustOrders: [] };

        // Health checks are scoped to the active on-chain window only.
        // This keeps detection aligned with maintenance actions that operate on
        // active window partials.
        const { buyDust, sellDust, buyDustOrders, sellDustOrders } = await checkWindowDust(manager);

        // Partial split/merge maintenance is intentionally disabled.
        // Health checks remain detection-only.

        return { buyDust, sellDust, buyDustOrders, sellDustOrders };
    }

    /**
     * Dust check covering all partial orders, with interior-only guard.
     *
     * The top-of-window partial (closest to market) is always eligible for dust
     * detection since cancelling it is just the grid edge moving inward.
     *
     * Interior partials (further from market) are eligible when they have a
     * duplicate price level — another active order at essentially the same price —
     * or when their size is already below the per-slot dust threshold. In the
     * duplicate-price case cancelling won't leave a gap because the sibling
     * active order already covers that price level; in the below-threshold case
     * the residual is economically negligible and otherwise strands forever (the
     * residual path only cancels zero-value residuals, and interior dust rarely
     * has a duplicate price level) — cancelling lets rotation re-derive the slot.
     *
     * Returns boolean flags plus the actual dust order objects so callers can act
     * on individual orders (dust is cancelled immediately on detection).
     *
     * @param {import('./types').OrderManager} manager
     * @returns {Promise<any>}
     */
export async function checkWindowDust(manager: any): Promise<any> {
        if (!manager) return { buyDust: false, sellDust: false, buyDustOrders: [], sellDustOrders: [] };

        const allOrders = Array.from(manager.orders.values()) as Order[];

        const isLiveOrder = (order: any) =>
            order &&
            order.orderId &&
            order.price != null &&
            (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL);

        // Identify top-of-window orders (closest to market per side).
        const topBuyOrder = allOrders
            .filter((o: any) => o.type === ORDER_TYPES.BUY && isLiveOrder(o))
            .sort((a: any, b: any) => b.price - a.price)[0];
        const topSellOrder = allOrders
            .filter((o: any) => o.type === ORDER_TYPES.SELL && isLiveOrder(o))
            .sort((a: any, b: any) => a.price - b.price)[0];

        // Check if an order has a duplicate price level — an active sibling at the
        // same price within tolerance. If so, cancelling won't create a grid gap.
        // Only checks ACTIVE siblings. If two PARTIALs share a price with no active
        // sibling, neither qualifies and the gap is left to the rebalancer.
        // Uses the LARGER size of the two orders for tolerance calculation to prevent
        // a tiny dust order from inflating the tolerance window.
        const hasDuplicatePriceLevel = (order: any, assets: any): boolean =>
            findPriceCollision(
                allOrders,
                order.id,
                order.price, order.size, order.type, assets,
                (o: any) => o.type === order.type && o.state === ORDER_STATES.ACTIVE && !!o.orderId && o.price != null
            ) != null;

        const assets = manager.assets;
        const allPartials = allOrders.filter((o: any) => isLiveOrder(o) && o.state === ORDER_STATES.PARTIAL);

        const isTopBuy = (o: any) => topBuyOrder && o.id === topBuyOrder.id;
        const isTopSell = (o: any) => topSellOrder && o.id === topSellOrder.id;

        // Compute per-slot dust thresholds once per side so the eligibility
        // filter below and _getDustOrders share the same sizing context
        // (avoids a duplicate recalculateFunds round per side). Each side's map
        // is only computed when that side actually has a partial candidate —
        // _computeDustThresholdMap runs a fund recalculation, so an empty side
        // must not pay for it.
        if (allPartials.length === 0) {
            return { buyDust: false, sellDust: false, buyDustOrders: [], sellDustOrders: [] };
        }
        const buyPartials = allPartials.filter((o: any) => o.type === ORDER_TYPES.BUY);
        const sellPartials = allPartials.filter((o: any) => o.type === ORDER_TYPES.SELL);
        const [buyThresholds, sellThresholds] = await Promise.all([
            buyPartials.length > 0 ? _computeDustThresholdMap(manager, ORDER_TYPES.BUY) : Promise.resolve(new Map<string, number>()),
            sellPartials.length > 0 ? _computeDustThresholdMap(manager, ORDER_TYPES.SELL) : Promise.resolve(new Map<string, number>()),
        ]);

        // A partial is below its per-slot dust threshold (economically negligible).
        const isDustSized = (o: any, thresholds: Map<string, number>): boolean => {
            const threshold = thresholds.get(o.id);
            return !!threshold && threshold > 0 && o.size < threshold;
        };

        // Safety filter: top-of-window partials always qualify; interior partials
        // qualify if they have a duplicate price level (no gap risk) OR their
        // size is already below the dust threshold. A sub-threshold interior
        // partial would otherwise strand on the book forever: the residual path
        // only cancels zero-value residuals, and an interior dust rarely has a
        // duplicate price level. Cancelling it frees the slot for rotation to
        // re-derive, so the tiny gap is closed by normal grid rebalancing.
        const eligibleBuyPartials = allPartials.filter((o: any) =>
            o.type === ORDER_TYPES.BUY && (isTopBuy(o) || hasDuplicatePriceLevel(o, assets) || isDustSized(o, buyThresholds))
        );
        const eligibleSellPartials = allPartials.filter((o: any) =>
            o.type === ORDER_TYPES.SELL && (isTopSell(o) || hasDuplicatePriceLevel(o, assets) || isDustSized(o, sellThresholds))
        );

        const buyDustOrders = await _getDustOrders(manager, eligibleBuyPartials, ORDER_TYPES.BUY, buyThresholds);
        const sellDustOrders = await _getDustOrders(manager, eligibleSellPartials, ORDER_TYPES.SELL, sellThresholds);

        return {
            buyDust: buyDustOrders.length > 0,
            sellDust: sellDustOrders.length > 0,
            buyDustOrders,
            sellDustOrders,
        };
    }

    /**
     * Compute the per-slot dust threshold for every order of a given type.
     * Returns a Map<orderId, threshold> using the same sizing context as
     * _getDustOrders so eligibility and dust classification stay consistent.
     * @private
     * @param {import('./types').OrderManager} manager
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @returns {Promise<Map<string, number>>}
     */
async function _computeDustThresholdMap(manager: any, type: any): Promise<Map<string, number>> {
        const side = type === ORDER_TYPES.BUY ? 'buy' : 'sell';
        const ctx = await _getSizingContext(manager, side);
        const dustThresholdPercent = manager.config?.gridLimits?.PARTIAL_DUST_THRESHOLD_PERCENTAGE;

        const sideSlots = (Array.from(manager.orders.values()) as Order[])
            .filter((o: any) => o.type === type)
            .sort((a: any, b: any) => a.price - b.price);

        const idealSizes = ctx && ctx.budget > 0
            ? allocateFundsByWeights(
                ctx.budget,
                sideSlots.length,
                manager.config.weightDistribution[side],
                manager.config.incrementPercent / 100,
                type === ORDER_TYPES.BUY,
                0,
                ctx.precision
            )
            : [];

        const map = new Map<string, number>();
        sideSlots.forEach((s: any, idx: number) => {
            const threshold = idealSizes.length > idx && idealSizes[idx] > 0
                ? getSingleDustThreshold(idealSizes[idx], dustThresholdPercent)
                : 0;
            map.set(s.id, threshold);
        });
        return map;
    }

    /**
     * Return the subset of partial orders that qualify as dust on a given side.
     * Shares the same sizing context as _hasAnyDust but returns the actual order
     * objects so callers can act on them (e.g. auto-cancel).
     * @private
     * @param {import('./types').OrderManager} manager
     * @param {Array<any>} partials - Candidate partial orders to test.
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Map<string, number>} [thresholdMap=null] - Optional precomputed per-slot dust thresholds.
     * @returns {Promise<Array<any>>} Orders whose size is below the dust threshold.
     */
async function _getDustOrders(manager: any, partials: any, type: any, thresholdMap: any = null): Promise<any[]> {
        if (!partials || partials.length === 0) return [];

        const thresholds = thresholdMap || await _computeDustThresholdMap(manager, type);
        if (thresholds.size === 0) return [];

        return partials.filter((p: any) => {
            const threshold = thresholds.get(p.id);
            if (!threshold || threshold <= 0) return false;
            return p.size < threshold;
        });
    }

    /**
     * Check if any partial orders on a side represent "dust" that should be cleaned.
     * @param {import('./types').OrderManager} manager - Manager instance
     * @param {Array<any>} partials - Partial orders to check
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @returns {Promise<boolean>} true if dust partials exist
     * @private
     */
async function _hasAnyDust(manager: any, partials: any, type: any): Promise<boolean> {
        return (await _getDustOrders(manager, partials, type)).length > 0;
    }

    /**
     * Public dust helper shared by StrategyEngine and Grid health checks.
     * @param {import('./types').OrderManager} manager
     * @param {Array<any>} partials
     * @param {'buy'|'sell'} side
     * @returns {Promise<boolean>}
     */
export async function hasAnyDust(manager: any, partials: any, side: any): Promise<boolean> {
        const type = side === 'buy' ? ORDER_TYPES.BUY : side === 'sell' ? ORDER_TYPES.SELL : null;
        if (!type) return false;
        return await _hasAnyDust(manager, partials, type);
    }

    /**
     * Public dust helper that returns the subset of candidate partials currently below
     * the configured dust threshold for the requested side.
     * @param {import('./types').OrderManager} manager
     * @param {Array<any>} partials
     * @param {'buy'|'sell'} side
     * @returns {Promise<Array<any>>}
     */
export async function getDustOrders(manager: any, partials: any, side: any): Promise<any[]> {
        const type = side === 'buy' ? ORDER_TYPES.BUY : side === 'sell' ? ORDER_TYPES.SELL : null;
        if (!type) return [];
        return await _getDustOrders(manager, partials, type);
    }

    /**
     * Determine which side has more available funds for spread correction.
     * @param {import('./types').OrderManager} manager - The manager instance.
     * @param {number} currentMarketPrice - Last traded price in B/A format (e.g. BTS/XRP), used to
     *   normalize sell-side funds into buy-side units for a fair cross-asset comparison.
     * @returns {{ side: import('./types').OrderType|null, reason: string }} The side to correct on, or null if insufficient funds.
     */
export function determineOrderSideByFunds(manager: any, currentMarketPrice: any): any {
        const buyAvailable = Math.min(
            Number(manager.funds?.available?.buy || 0),
            Number(manager.accountTotals?.buyFree || 0)
        );
        const sellAvailable = Math.min(
            Number(manager.funds?.available?.sell || 0),
            Number(manager.accountTotals?.sellFree || 0)
        );

        // Need at least some funds on a side to justify correction
        const buyPrecision = manager.assets?.assetB?.precision;
        const sellPrecision = manager.assets?.assetA?.precision;
        if (buyPrecision === undefined || sellPrecision === undefined) {
            throw new Error(`CRITICAL: Asset precision unavailable for grid correction check`);
        }
        const buyMinUnit = 1 / Math.pow(10, buyPrecision);
        const sellMinUnit = 1 / Math.pow(10, sellPrecision);

        const buyViable = buyAvailable > buyMinUnit;
        const sellViable = sellAvailable > sellMinUnit;

        let side: any = null;
        if (buyViable && sellViable) {
            // Normalize sell (assetA) to assetB units using market price so both sides
            // are comparable. Without this, a raw number comparison (e.g. 2192 BTS vs
            // 0.12 XRP) always picks BUY even when the sell side is larger in value.
            const marketPrice = Number(currentMarketPrice);
            const sellInBuyUnits = (Number.isFinite(marketPrice) && marketPrice > 0)
                ? sellAvailable * marketPrice
                : sellAvailable;

            side = buyAvailable >= sellInBuyUnits ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
        } else if (buyViable) {
            side = ORDER_TYPES.BUY;
        } else if (sellViable) {
            side = ORDER_TYPES.SELL;
        }

        if (!side) {
            const committedBuy = Math.max(0, Number(manager.funds?.committed?.chain?.buy || 0));
            const committedSell = Math.max(0, Number(manager.funds?.committed?.chain?.sell || 0));
            const marketPrice = Number(currentMarketPrice);
            const hasValidPrice = Number.isFinite(marketPrice) && marketPrice > 0;

            if (committedBuy > buyMinUnit || committedSell > sellMinUnit) {
                if (hasValidPrice) {
                    const buyComparable = committedBuy;
                    const sellComparable = committedSell * marketPrice;
                    side = buyComparable >= sellComparable ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
                } else if (committedBuy > buyMinUnit && committedSell <= sellMinUnit) {
                    side = ORDER_TYPES.BUY;
                } else if (committedSell > sellMinUnit && committedBuy <= buyMinUnit) {
                    side = ORDER_TYPES.SELL;
                } else {
                    // Deterministic fallback when both sides hold inventory but market valuation is unavailable.
                    side = ORDER_TYPES.BUY;
                }

                manager.logger?.log?.(
                    `Spread correction using redistribution fallback on ${side} ` +
                    `(free buy=${Format.formatAmount8(buyAvailable)}, free sell=${Format.formatAmount8(sellAvailable)}, ` +
                    `price=${hasValidPrice ? Format.formatAmount8(marketPrice) : 'unavailable'})`,
                    'info'
                );
            }
        }

        if (!side) {
            manager.logger?.log?.(
                `Spread correction skipped: insufficient free funds and no committed inventory to redistribute ` +
                `(buy=${Format.formatAmount8(buyAvailable)}, sell=${Format.formatAmount8(sellAvailable)})`,
                'warn'
            );
        }

        return { side, reason: side ? `Choosing ${side}` : 'Insufficient funds or committed inventory' };
    }

    /**
     * Resolve the MIN_SPREAD_ORDERS gap reserve used by boundary promotion.
     * Promotion may never consume the last `reserve` empty slots of the gap
     * band — this is the floor that keeps the spread from being zeroed.
     */
    function resolveMinSpreadOrdersReserve(manager: any): number {
        const raw = Number(manager?.config?.gridLimits?.MIN_SPREAD_ORDERS ?? GRID_LIMITS.MIN_SPREAD_ORDERS);
        return (Number.isFinite(raw) && raw >= 0) ? Math.floor(raw) : GRID_LIMITS.MIN_SPREAD_ORDERS;
    }

    // Collect contiguous empty gap-band slots adjacent to a rail edge for boundary
    // promotion.  BUY walks upward from the boundary into the gap, SELL walks
    // downward from the sell start; both stop at the first unavailable slot.
    // Mirrors are collapsed into one directional walk (step +/- 1).
    //
    // PROMOTION CAP (gap-band geometry): promotion may consume at most
    // bandSize − MIN_SPREAD_ORDERS slots, where bandSize = sellStartIdx −
    // buyEndIdx − 1.  The previous cap (the OPPOSITE RAIL's span) constrained
    // nothing: for BUY it was the sell rail's length and for SELL the buy
    // rail's length, so a single correction could promote every gap slot and
    // zero the spread.  Reserving MIN_SPREAD_ORDERS empty slots guarantees the
    // gap never closes within this path regardless of quota.
    //
    // DEFENSE-IN-DEPTH WALK BOUNDS: the loop itself also stops
    // MIN_SPREAD_ORDERS short of the opposite rail edge (idx <= sellStartIdx−1−
    // reserve for BUY / idx >= buyEndIdx+1+reserve for SELL), so even if the
    // cap above is ever miscomputed the walk cannot consume the reserved gap.
    // When bandSize <= reserve the bound disables promotion entirely.
    function _collectPromotableBoundarySlots(
        allSlotsByPrice: any[],
        railType: string,
        buyEndIdx: number,
        sellStartIdx: number,
        quota: number,
        spreadReserve: number,
        maxDepth: number
    ): any[] {
        const isBuy = railType === ORDER_TYPES.BUY;
        const bandSize = Math.max(0, sellStartIdx - buyEndIdx - 1);
        // Depth is bounded by three independent caps (defense-in-depth):
        //   reserve cap  — keep MIN_SPREAD_ORDERS empties in the band
        //   stranding cap— the boundary slide must never move a placed
        //                  opposite-rail order into the implied spread band;
        //                  constraining DEPTH here (not clamping the derived
        //                  boundary afterwards) keeps the promoted slots'
        //                  classification consistent with the new geometry
        //   walk bounds  — hard stop short of the opposite rail edge, even if
        //                  both caps above were ever miscomputed
        const maxPromotable = Math.max(0, bandSize - spreadReserve);
        const promotionQuota = Math.min(quota, maxPromotable, Math.max(0, maxDepth));
        const promoted: any[] = [];
        const step = isBuy ? 1 : -1;
        for (let idx = isBuy ? buyEndIdx + 1 : sellStartIdx - 1;
            promoted.length < promotionQuota
                && (isBuy
                    ? idx <= sellStartIdx - 1 - spreadReserve
                    : idx >= buyEndIdx + 1 + spreadReserve);
            idx += step) {
            const slot = allSlotsByPrice[idx];
            if (!slot || !isSlotAvailable(slot)) break;
            promoted.push(slot);
        }
        return promoted;
    }

    /**
     * Prepares one or more orders to correct a wide spread.
     * @param {import('./types').OrderManager} manager - The OrderManager instance.
     * @param {string} preferredSide - The side to place the correction on (ORDER_TYPES.BUY/SELL).
     * @returns {Promise<any>}
     * @throws {Error} If preferredSide is invalid.
     */
    export async function prepareSpreadCorrectionOrders(manager: any, preferredSide: any, outOfSpread: number = 0): Promise<any> {
        // FIX: Validate preferredSide parameter to prevent silent logic errors
        if (preferredSide !== ORDER_TYPES.BUY && preferredSide !== ORDER_TYPES.SELL) {
            throw new Error(`Invalid preferredSide: ${preferredSide}. Must be '${ORDER_TYPES.BUY}' or '${ORDER_TYPES.SELL}'.`);
        }

        const ordersToPlace: any[] = [];
        const ordersToUpdate: any[] = [];
        const railType = preferredSide;
        const sideName = railType === ORDER_TYPES.BUY ? 'buy' : 'sell';
        const configuredMissingSlots = Number(outOfSpread || 0);
        const missingSlots = configuredMissingSlots > 0
            ? Math.floor(configuredMissingSlots)
            : 1;

        // STRATEGY: Edge-Based Correction (Safe Bridging)
        // Instead of calculating a "mid-price" (which can be dangerous in wide gaps),
        // we strictly target the orders closest to the spread gap.
        // 1. Priority: Update existing PARTIAL orders at the edge (Highest Buy / Lowest Sell).
        // 2. Fallback: Activate SPREAD slots at the edge (Lowest Spread for Buy / Highest Spread for Sell).

        const allOrders = Array.from(manager.orders.values()) as Order[];

        // Boundary-correct type computation — hoisted before edge-partial and
        // candidate filters so all call sites (including the edge-partial filter
        // which now uses getSlotCorrectType) can access it.
        //
        // The natural type of a slot is derived from its position in the price-sorted
        // rail relative to boundaryIdx + gapSlots: indices in [0, boundaryIdx] are
        // BUY, indices in [boundaryIdx + gapSlots + 1, N-1] are SELL, the middle
        // band is SPREAD.
        const allSlotsByPrice = allOrders
            .filter((o: any) => o.price != null && Number.isFinite(o.price))
            .sort((a: any, b: any) => a.price - b.price);
        const slotIndexMap = new Map(allSlotsByPrice.map((o: any, i: number) => [o.id, i]));

        // Use the committed boundary for slot classification — never a speculative
        // value from syncBoundaryToFunds that hasn't been persisted through the COW
        // pipeline.  If the boundary shifts later via _commitWorkingGrid, the next
        // spread correction cycle will re-classify with the updated committed value.
        // This prevents TOCTOU-style inconsistency where slot types are chosen
        // against a boundary that was never atomically committed to manager.orders.
        const resolved = resolveGapBand(manager);
        const gapSlots = resolved.gapSlots;
        const boundaryKnown = resolved.boundaryIdx !== null && resolved.sellStartIdx !== null;
        // NOTE: `?? 0` keeps the legacy classification fallback (boundary not
        // restored yet → treat as bottom of the rail) so the correction can still
        // act on concrete BUY/SELL candidates.  Boundary PROMOTION is gated on
        // `boundaryKnown` below: deriving a new boundary from a fabricated 0 would
        // silently commit a boundary that was never real.
        const buyEndIdx = resolved.boundaryIdx ?? 0;
        const sellStartIdx = resolved.sellStartIdx ?? getSellStartIdx(buyEndIdx, gapSlots);
        const getSlotCorrectType = (slot: any): string => {
            const idx = slotIndexMap.get(slot.id);
            if (idx === undefined) return slot.type;
            if (idx <= buyEndIdx) return ORDER_TYPES.BUY;
            if (idx >= sellStartIdx) return ORDER_TYPES.SELL;
            return ORDER_TYPES.SPREAD;
        };

        let edgePartial: any = null;
        const partials = allOrders
            .filter((o: any) =>
                getSlotCorrectType(o) === railType
                && o.state === ORDER_STATES.PARTIAL
            )
            .sort((a: any, b: any) => railType === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);
        if (partials.length > 0) {
            edgePartial = partials[0];
            manager.logger?.log?.(`[SPREAD-CORRECTION] Identified partial order at ${edgePartial.price} for update`, 'debug');
        }

        // Primary candidates: SPREAD-type slots adjacent to the gap.  Filter by
        // boundary-correct type so a SPREAD slot that, after a boundary shift, now sits
        // in the BUY or SELL zone is excluded — it would otherwise be placed on the
        // correction side at a price the grid already considers the opposite side.
        const typedSpreadCandidates = allOrders
            .filter((o: any) =>
                o.type === ORDER_TYPES.SPREAD
                && isSlotAvailable(o)
                && getSlotCorrectType(o) === railType
            )
            .sort((a: any, b: any) => railType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price)
            .slice(0, missingSlots);

        // Secondary candidates: orphaned virtual slots that have lost their
        // order (e.g. stale-cleaned after a race condition during a crash).
        // These sit inside the active window and are invisible to the
        // gap-band SPREAD filter above.
        //
        // Empty slots are stored SPREAD (side-neutral) after normalization, so
        // the stored type can be railType OR SPREAD — what matters is that the
        // boundary-correct type (geometry) matches the rail being corrected.
        // Filter by boundary-correct type so that filled-then-virtualized slots
        // whose boundary position has moved into the spread or opposite zone are
        // NOT re-activated on the stale side — doing so would compound inventory
        // at prices where the bot already traded.
        const orphanedVirtualCandidates = allOrders
            .filter((o: any) =>
                (o.type === railType || o.type === ORDER_TYPES.SPREAD)
                && o.state === ORDER_STATES.VIRTUAL
                && !o.orderId
                && Number(o.size || 0) === 0
                && getSlotCorrectType(o) === railType
            )
            .sort((a: any, b: any) => railType === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price)
            .slice(0, missingSlots);

        // If the funded rail is full, the spread itself may be stale: the
        // nearest empty slots are still in the gap band. Promote contiguous
        // empty gap slots from that rail edge so correction can repair the
        // boundary and place orders in one atomic COW commit.
        //
        // Requires a KNOWN committed boundary: with a null/unknown boundary the
        // rail edges are fabricated (buyEndIdx=0), so promotion would place
        // orders at arbitrary prices and return a boundary derived from that
        // fiction.  Without promotion there is nothing to commit, so falling
        // back to the pre-existing candidate paths is safe.
        const promotedCandidates: any[] = [];
        const spreadReserve = resolveMinSpreadOrdersReserve(manager);
        // STRANDING DEPTH CAP: the post-commit geometry re-derives the band
        // from the new boundary, sliding it over opposite-rail slots.  A
        // slide may never swallow an already-PLACED order into that band, so
        // promotion depth is capped up-front — constraining depth keeps the
        // derived boundary consistent with every promoted slot's placement;
        // clamping the boundary afterwards would not.
        let maxPromotionDepth = Infinity;
        if (railType === ORDER_TYPES.BUY) {
            for (let idx = Math.max(sellStartIdx, 0); idx < allSlotsByPrice.length; idx++) {
                if (allSlotsByPrice[idx]?.orderId) {
                    // Implied sell zone must start at/below the lowest placed
                    // sell: B' + gapSlots + 1 <= idx  =>  depth <= idx − G − 1 − B.
                    maxPromotionDepth = idx - gapSlots - 1 - buyEndIdx;
                    break;
                }
            }
        } else {
            for (let idx = Math.min(buyEndIdx, allSlotsByPrice.length - 1); idx >= 0; idx--) {
                if (allSlotsByPrice[idx]?.orderId) {
                    // Boundary may not drop below the highest placed buy:
                    // B' = B − depth >= idx  =>  depth <= B − idx.
                    maxPromotionDepth = buyEndIdx - idx;
                    break;
                }
            }
        }
        if (boundaryKnown && orphanedVirtualCandidates.length + typedSpreadCandidates.length < missingSlots) {
            const rawQuota = missingSlots - orphanedVirtualCandidates.length - typedSpreadCandidates.length;
            promotedCandidates.push(..._collectPromotableBoundarySlots(
                allSlotsByPrice,
                railType,
                buyEndIdx,
                sellStartIdx,
                rawQuota,
                spreadReserve,
                maxPromotionDepth
            ));
            if (promotedCandidates.length > 0) {
                manager.logger?.log?.(
                    `[SPREAD-CORRECTION] ${promotedCandidates.length} gap slot(s) available for boundary promotion on ${sideName}`,
                    'info'
                );
            }
        }

        // Merge: prefer orphaned virtuals (they already occupy correct grid positions) then
        // fall back to SPREAD slots for any remaining quota.
        const remainingQuota = Math.max(0, missingSlots - orphanedVirtualCandidates.length);
        let spreadCandidates: any[] = [
            ...orphanedVirtualCandidates,
            ...typedSpreadCandidates.slice(0, remainingQuota),
            ...promotedCandidates
        ];

        // Dedupe by slot id: an empty in-rail slot typed SPREAD (normalized) now
        // qualifies for BOTH orphanedVirtualCandidates and typedSpreadCandidates
        // (both accept SPREAD type + rail geometry), so a single slot can be
        // planned twice.  Duplicate CREATEs would inflate the sizing denominator
        // (diluting every order), mislead the plan counts, and get dropped by the
        // COW same-batch collision filter anyway.  Keep the first occurrence
        // (orphaned-priority — those already occupy correct grid positions).
        {
            const seenSlotIds = new Set<string>();
            spreadCandidates = spreadCandidates.filter((c: any) => {
                if (!c?.id || seenSlotIds.has(c.id)) return false;
                seenSlotIds.add(c.id);
                return true;
            });
        }

        // P2: Filter out candidates whose price already has a placed order from any slot.
        // This prevents creating a duplicate order at the same price when a prior cycle's
        // order was not properly cleaned up (e.g. uncertain broadcast).
        if (spreadCandidates.length > 0) {
            const preFilter = spreadCandidates.length;
            spreadCandidates = spreadCandidates.filter((c: any) => {
                if (c.price == null) return false;
                // Resolve candidate size: if zero/missing, use minimum so tolerance
                // doesn't collapse to zero (calculatePriceTolerance returns null for size <= 0).
                const cs = (c.size && c.size > 0) ? c.size : getMinOrderSize(railType, manager.assets);
                return !findPriceCollision(
                    allOrders,
                    c.id,
                    c.price, cs, railType, manager.assets,
                    (o: any) => isOrderPlaced(o) && o.price != null
                );
            });
            const filteredCount = preFilter - spreadCandidates.length;
            if (filteredCount > 0) {
                manager.logger?.log?.(
                    `[SPREAD-CORRECTION] Filtered ${filteredCount}/${preFilter} candidate(s) with duplicate price levels`,
                    'warn'
                );
            }
        }

        if (spreadCandidates.length > 0) {
            manager.logger?.log?.(`[SPREAD-CORRECTION] Identified ${spreadCandidates.length}/${missingSlots} slot(s) for activation on ${sideName} (orphaned=${orphanedVirtualCandidates.length}, spread=${spreadCandidates.length - orphanedVirtualCandidates.length})`, 'debug');
        }

        if (!edgePartial && spreadCandidates.length === 0) {
            manager.logger?.log?.(`[SPREAD-CORRECTION] No suitable partials, orphaned virtual slots, or spread slots found. Skipping.`, 'warn');
            return { ordersToPlace: [], ordersToUpdate: [] };
        }

        const orphanedIds = new Set(orphanedVirtualCandidates.map((o: any) => o.id));
        const sideSlots = allOrders
            .filter((o: any) => o.type === railType && !orphanedIds.has(o.id))
            .sort((a: any, b: any) => a.price - b.price);
        const syntheticSideSlots = [
            ...sideSlots,
            ...spreadCandidates.map((slot: any) => ({ ...slot, type: railType }))
        ].sort((a: any, b: any) => a.price - b.price);

        const ctx = await _getSizingContext(manager, sideName);
        if (!ctx || ctx.budget <= 0 || syntheticSideSlots.length === 0) {
            return { ordersToPlace: [], ordersToUpdate: [] };
        }
        const precisionEpsilon = getPrecisionSlack(ctx.precision, 1);

        const idealSizes = allocateFundsByWeights(
            ctx.budget,
            syntheticSideSlots.length,
            manager.config.weightDistribution[sideName],
            manager.config.incrementPercent / 100,
            railType === ORDER_TYPES.BUY,
            0,
            ctx.precision
        );

        const idealById = new Map();
        syntheticSideSlots.forEach((slot: any, idx: any) => {
            idealById.set(slot.id, Number(idealSizes[idx] || 0));
        });

        const availableFund = Math.max(0, Math.min(
            Number(manager.funds?.available?.[sideName] || 0),
            Number(sideName === 'buy' ? manager.accountTotals?.buyFree : manager.accountTotals?.sellFree) || 0
        ));

        const minAbsoluteSize = getMinOrderSize(railType, manager.assets);
        const prioritizedTargets: any[] = [];

        if (edgePartial && edgePartial.id) {
            const ideal = Number(idealById.get(edgePartial.id) || 0);
            const current = Number(edgePartial.size || 0);
            if (ideal > current + precisionEpsilon) {
                prioritizedTargets.push({
                    kind: 'partial-topup',
                    order: edgePartial,
                    current,
                    ideal,
                    needed: Math.max(0, ideal - current)
                });
            }
        }

        for (const slot of spreadCandidates) {
            const ideal = Number(idealById.get(slot.id) || 0);
            if (ideal > precisionEpsilon) {
                prioritizedTargets.push({
                    kind: 'create',
                    order: slot,
                    current: 0,
                    ideal,
                    needed: ideal
                });
            }
        }

        if (prioritizedTargets.length === 0) {
            return { ordersToPlace: [], ordersToUpdate: [] };
        }

        const totalNeeded = prioritizedTargets.reduce((sum: any, t: any) => sum + Math.max(0, Number(t.needed || 0)), 0);
        let recoveredBudget = 0;
        const redistributionUpdates: any[] = [];

        if (totalNeeded > availableFund + precisionEpsilon) {
            let shortfall = totalNeeded - availableFund;

            const donors = sideSlots
                .filter((o: any) => hasOnChainId(o) && (o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL))
                .filter((o: any) => !edgePartial || o.id !== edgePartial.id)
                .sort((a: any, b: any) => railType === ORDER_TYPES.BUY ? a.price - b.price : b.price - a.price);

            for (const donor of donors) {
                if (shortfall <= precisionEpsilon) break;

                const donorCurrent = Number(donor.size || 0);
                const donorIdeal = Number(idealById.get(donor.id) || 0);
                const donorFloor = Math.max(minAbsoluteSize, donorIdeal);
                const donorReducible = Math.max(0, donorCurrent - donorFloor);
                if (donorReducible <= precisionEpsilon) continue;

                const reduction = Math.min(donorReducible, shortfall);
                const donorNext = donorCurrent - reduction;
                if (donorNext <= precisionEpsilon) continue;
                if (!isOrderHealthy(donorNext, railType, manager.assets, donorIdeal || donorNext)) continue;

                redistributionUpdates.push({ partialOrder: { ...donor }, newSize: donorNext });
                recoveredBudget += reduction;
                shortfall -= reduction;
            }

            if (recoveredBudget > precisionEpsilon) {
                manager.logger?.log?.(
                    `[SPREAD-CORRECTION] Recovered ${Format.formatSizeByOrderType(recoveredBudget, railType, manager.assets)} on ${sideName} via redistribution`,
                    'info'
                );
            }
        }

        let remainingBudget = availableFund + recoveredBudget;

        for (const target of prioritizedTargets) {
            if (remainingBudget <= precisionEpsilon) break;

            if (target.kind === 'partial-topup') {
                const topUp = Math.min(target.needed, remainingBudget);
                const newSize = target.current + topUp;
                if (newSize > target.current + precisionEpsilon && isOrderHealthy(newSize, railType, manager.assets, target.ideal)) {
                    ordersToUpdate.push({ partialOrder: { ...target.order }, newSize });
                    remainingBudget -= topUp;
                }
                continue;
            }

            const createSize = Math.min(target.ideal, remainingBudget);
            if (createSize <= precisionEpsilon) continue;
            if (!isOrderHealthy(createSize, railType, manager.assets, target.ideal)) continue;

            ordersToPlace.push({
                ...target.order,
                type: railType,
                size: createSize,
                state: ORDER_STATES.VIRTUAL
            });
            remainingBudget -= createSize;
        }

        let boundaryIdx: number | undefined;
        const placedPromotedIds = new Set(ordersToPlace
            .filter((order: any) => promotedCandidates.some((slot: any) => slot.id === order.id))
            .map((order: any) => order.id));
        if (placedPromotedIds.size > 0) {
            // Derive boundary from the placed promoted set's extremes (via
            // slotIndexMap), not the contiguous prefix.  Any promoted-but-
            // unplaced slots sit in-rail or in-band as normal empty slots.
            let maxDist = 0;
            for (const id of placedPromotedIds) {
                const idx = slotIndexMap.get(id);
                if (idx === undefined) continue;
                const dist = railType === ORDER_TYPES.BUY
                    ? idx - buyEndIdx
                    : sellStartIdx - idx;
                if (dist > maxDist) maxDist = dist;
            }
            if (maxDist > 0) {
                boundaryIdx = railType === ORDER_TYPES.BUY
                    ? buyEndIdx + maxDist
                    : buyEndIdx - maxDist;
                // PROMOTION BOUNDARY BACKSTOP (refusal-only): the boundary is
                // DERIVED from the placed promoted set (buyEndIdx ± maxDist),
                // so shifting it here would silently strand those fresh orders
                // inside the implied band.  All real constraints — the
                // MIN_SPREAD_ORDERS reserve and opposite-rail stranding — are
                // enforced UPSTREAM as walk-depth caps.  This backstop only
                // verifies array limits plus the reserve ceiling; any
                // violation signals an internal inconsistency, so promotion is
                // refused loudly instead of silently re-geometried.
                const maxIdx = allSlotsByPrice.length - 1;
                const lo = 0;
                const hi = railType === ORDER_TYPES.BUY
                    ? Math.min(maxIdx, sellStartIdx - 1 - spreadReserve)
                    : maxIdx;
                if (lo > hi || boundaryIdx < lo || boundaryIdx > hi) {
                    manager.logger?.log?.(
                        `[SPREAD-CORRECTION] Boundary promotion refused on ${sideName}: ` +
                        `derived boundary ${boundaryIdx} violates safe range [${lo}, ${hi}] ` +
                        `(band ${buyEndIdx + 1}..${sellStartIdx - 1})`,
                        'warn'
                    );
                    boundaryIdx = undefined;
                } else {
                    manager.logger?.log?.(
                        `[SPREAD-CORRECTION] Boundary promotion on ${sideName}: ` +
                        `${buyEndIdx} -> ${boundaryIdx} (${placedPromotedIds.size} placed, maxDist ${maxDist})`,
                        'info'
                    );
                }
            } else {
                boundaryIdx = undefined;
            }
        }

        const combinedUpdates = [...redistributionUpdates];
        for (const plannedUpdate of ordersToUpdate) {
            const id = plannedUpdate?.partialOrder?.id || (plannedUpdate as any)?.id;
            if (!id) continue;
            const existingIdx = combinedUpdates.findIndex((u: any) => (u?.partialOrder?.id || u?.id) === id);
            if (existingIdx >= 0) {
                combinedUpdates[existingIdx] = plannedUpdate;
            } else {
                combinedUpdates.push(plannedUpdate);
            }
        }

        if (spreadCandidates.length < missingSlots) {
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Requested ${missingSlots} extra slot(s), found ${spreadCandidates.length} available slot(s) on ${sideName}`,
                'warn'
            );
        }

        if (ordersToPlace.length < spreadCandidates.length) {
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Fund-constrained placement on ${sideName}: planned ${spreadCandidates.length}, placing ${ordersToPlace.length}`,
                'info'
            );
        }

        if (combinedUpdates.length > 0 || ordersToPlace.length > 0) {
            manager.logger?.log?.(
                `[SPREAD-CORRECTION] Prepared updates=${combinedUpdates.length}, creates=${ordersToPlace.length}, remainingBudget=${Format.formatSizeByOrderType(Math.max(0, remainingBudget), railType, manager.assets)}`,
                'debug'
            );
        }

        return { ordersToPlace, ordersToUpdate: combinedUpdates, ...(boundaryIdx === undefined ? {} : { boundaryIdx }) };
    }
