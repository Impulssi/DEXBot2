/**
 * modules/order/utils/order.ts - Order Domain Utilities
 *
 * Business rules for orders, state predicates, filtering, and reconciliation.
 * Includes grid indexing, order comparison, delta building, and strategy calculations.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (35 exported functions)
 * ===============================================================================
 *
 * SECTION 1: CHAIN ORDER MATCHING & RECONCILIATION (5 functions)
 *   - parseChainOrder(chainOrder, assets) - Parse blockchain order to grid format
 *   - findMatchingGridOrderByOpenOrder(parsedChainOrder, opts) - Find matching grid order
 *   - applyChainSizeToGridOrder(manager, gridOrder, chainSize) - Apply chain size to grid
 *   - correctOrderPriceOnChain(manager, correctionInfo, ...) - Correct order price on chain
 *   - correctAllPriceMismatches(manager, accountName, ...) - Correct all price mismatches
 *
 * SECTION 2: ORDER CONSTRUCTION (3 functions)
 *   - buildCreateOrderArgs(order, assetA, assetB) - Build create order arguments
 *   - getOrderTypeFromUpdatedFlags(buyUpdated, sellUpdated) - Get type from update flags
 *   - resolveConfiguredPriceBound(value, fallback, startPrice, mode) - Resolve price bounds
 *   - buildFillKey(fillOrParts) - Build a stable fill dedupe key
 *   - buildCreateOpFingerprint(params) - Build fingerprint for create operations
 *
 * SECTION 3: STATE TRANSITIONS (2 functions)
 *   - virtualizeOrder(order) - Convert order to VIRTUAL state
 *   - convertToSpreadPlaceholder(order) - Convert order to SPREAD placeholder
 *
 * SECTION 4: FILTERING & COUNTING (5 functions)
 *   - filterOrdersByType(orders, orderType) - Filter orders by type

 *   - buildOutsideInPairGroups(items, accessors) - Outside->center pair grouping
 *   - extractBatchOperationResults(result) - Extract operation_results from chain batch result
 *   - formatUnmatchedChainOrder(order) - Format structural drift diagnostics
 *
 * SECTION 5: STATE PREDICATES (7 functions)
 *   - isOrderOnChain(order) - Check if order is ACTIVE or PARTIAL
 *   - isOrderVirtual(order) - Check if order is VIRTUAL
 *   - hasOnChainId(order) - Check if order has blockchain orderId
 *   - isOrderPlaced(order) - Check if order is placed on chain
 *   - isPhantomOrder(order) - Check if order is phantom (ACTIVE without orderId)
 *   - isSlotAvailable(order) - Check if slot is available for placement
 *   - isOrderHealthy(order, context) - Comprehensive order health check
 *
 * SECTION 6: SIZE VALIDATION (2 functions)
 *   - checkSizeThreshold(size, threshold) - Check if size exceeds threshold
 *   - checkSizesBeforeMinimum(sizes, minSize) - Check sizes against minimum
 *
 * SECTION 7: GRID BOUNDARY & ROLES (3 functions)
 *   - calculateIdealBoundary(allSlots, startPrice, gapSlots) - Calculate ideal boundary
 *   - assignGridRoles(allSlots, boundaryIdx, gapSlots, ...) - Assign BUY/SELL roles
 *   - shouldFlagOutOfSpread(order, startPrice, configSpread) - Check if order is out of spread
 *
 * SECTION 8: GRID INDEXING (2 functions)
 *   - buildIndexes(grid) - Build complete index set from grid
 *   - validateIndexes(grid, indexes) - Validate index consistency
 *
 * SECTION 9: ORDER COMPARISON & DELTA (3 functions)
 *   - ordersEqual(a, b) - Compare two orders for equality
 *   - buildDelta(masterGrid, workingGrid) - Build delta actions between grids
 *   - getOrderSize(order) - Extract order size with fallback
 *
 * SECTION 10: STRATEGY CALCULATIONS (6 functions)
 *   - resolveReserveCount(config, side) - Clamped per-side reserve count (>=0 int, 0 disables)
 *   - resolveReserveOrders(config) - Total reserves buy+sell (fee/count totals)
 *   - resolveReserveFloorIds(allSlots, reserve) - Bottom-N BUY slot ids by price
 *   - resolveReserveCeilIds(allSlots, reserve) - Top-N SELL slot ids by price
 *
 * ===============================================================================
 */


import { ORDER_TYPES, ORDER_STATES, TIMING, FEE_PARAMETERS, GRID_LIMITS, NATIVE_CLIENT, COW_PERFORMANCE, COW_ACTIONS } from '../../constants.js';
import * as Format from '../format.js';
import * as MathUtils from './math.js';
import Logger from '../../order/logger.js';
import { sleep } from './system.js';
import { getErrorMessage } from '../../utils/errors.js';
import { parseSlotIndex as parseSlotIndexShared } from './slot.js';
const { isValidNumber, toFiniteNumber } = Format;
const { blockchainToFloat, floatToBlockchainInt, quantizeFloat, priceSlotEqual } = MathUtils;
const orderLogger = new Logger('Order');

const ORDER_GONE_ERROR_FRAGMENT = 'not found';

/**
 * Detect a "chain order does not exist" error from a broadcast/read failure.
 * Single canonical implementation used by the correction, reconcile-cancel,
 * dust-cancel, and residual-cancel paths.
 *
 * The explicit "order ... does not exist" phrasings always match. The legacy
 * generic 'not found' fragment and the object-missing phrasings match as-is
 * when no orderId is given (legacy order.ts behavior for the correction path);
 * when an orderId IS given (dust/residual cancel paths) they additionally
 * require the orderId to appear in the message, so an unrelated missing-object
 * error is never mistaken for a gone order.
 * @param {string} message - Error message to inspect.
 * @param {string} [orderId] - Order ID required to be present in the message
 *   for generic object-missing phrasings (precision mode).
 * @returns {boolean} True if the message indicates the order is gone.
 */
function isOrderGoneErrorMessage(message: any, orderId?: any) {
    if (typeof message !== 'string' || message.length === 0) return false;
    if (/\border\b.*\bdoes not exist\b/i.test(message)) return true;
    if (/\bdoes not exist\b.*\border\b/i.test(message)) return true;
    if (orderId && !message.toLowerCase().includes(String(orderId).toLowerCase())) return false;
    if (message.includes(ORDER_GONE_ERROR_FRAGMENT)) return true;
    if (/\bdoes not exist\b/i.test(message)) return true;
    if (/\bcould not find object\b/i.test(message)) return true;
    if (/\bunable to find object\b/i.test(message)) return true;
    if (/\bobject\b.*\bnot found\b/i.test(message)) return true;
    return false;
}

// ---------------------------------------------------------------------------
// Persistent duplicate-orphan detection escalation. A duplicate-price-level
// orphan is expected self-healing (fully filled order leaves a sub-dust
// residual that collides with the rotated replacement). First sightings log at
// info; if the SAME orderId keeps being re-detected — its cancel keeps failing
// or it keeps getting re-created — the detection sites escalate to warn so the
// silent loop is surfaced instead of degrading quietly. Reuses the existing
// warn-rate-limit and recent-orderId-map tuning from constants.ts rather than
// defining new knobs: repeats are rate-limited by TIMING.STALE_TOTALS_WARN_
// RATE_LIMIT_MS and the counter map is capped by ORDER_EVENTS.
// RECENT_OWN_CANCEL_MAX_ENTRIES (same lazy-GC pattern as chain_orders.ts).
// ---------------------------------------------------------------------------
const _duplicateOrphanDetections = new Map<string, { count: number; lastWarnAt: number | null }>();

/**
 * Record a duplicate-orphan detection for an orderId.
 * First sighting stays quiet (count 1). A repeated sighting of the same
 * orderId escalates, but no more often than TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS.
 * @param {string} orderId - Duplicate orphan chain order ID.
 * @returns {{ count: number; shouldEscalate: boolean }} Detection stats.
 */
function recordDuplicateOrphanDetection(orderId: any) {
    if (!orderId) return { count: 0, shouldEscalate: false };
    const warnRateLimitMs = Number.isFinite(TIMING?.STALE_TOTALS_WARN_RATE_LIMIT_MS)
        ? TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS
        : 60000;
    const maxEntries = Number.isFinite(NATIVE_CLIENT?.ORDER_EVENTS?.RECENT_OWN_CANCEL_MAX_ENTRIES)
        ? NATIVE_CLIENT.ORDER_EVENTS.RECENT_OWN_CANCEL_MAX_ENTRIES
        : 256;

    const now = Date.now();
    const existing = _duplicateOrphanDetections.get(String(orderId));
    const count = existing ? existing.count + 1 : 1;
    let shouldEscalate = false;
    let lastWarnAt = existing ? existing.lastWarnAt : null;
    if (count >= 2 && (lastWarnAt == null || now - lastWarnAt >= warnRateLimitMs)) {
        shouldEscalate = true;
        lastWarnAt = now;
    }
    _duplicateOrphanDetections.set(String(orderId), { count, lastWarnAt });

    // Lazy GC: drop the oldest entries when the map exceeds the shared budget.
    if (_duplicateOrphanDetections.size > maxEntries) {
        let toDelete = _duplicateOrphanDetections.size - maxEntries;
        for (const [id] of _duplicateOrphanDetections) {
            if (toDelete <= 0) break;
            _duplicateOrphanDetections.delete(id);
            toDelete--;
        }
    }
    return { count, shouldEscalate };
}

/**
 * Clear the detection counter for an orderId (e.g. after a confirmed cancel),
 * so a resolved orphan never lingers and false-escalates later.
 * @param {string} orderId - Chain order ID to forget.
 */
function clearDuplicateOrphanDetection(orderId: any) {
    if (orderId) _duplicateOrphanDetections.delete(String(orderId));
}

/**
 * Record a duplicate-orphan detection and return the log level + re-detection
 * suffix for the caller's diagnostic line. First sightings log at info; a
 * repeat escalates to warn (rate-limited).
 * @param {string} orderId - Duplicate orphan chain order ID.
 * @returns {{ level: 'info'|'warn'; suffix: string }} Log level and suffix text.
 */
function duplicateOrphanLogInfo(orderId: any) {
    const { count, shouldEscalate } = recordDuplicateOrphanDetection(orderId);
    return {
        level: shouldEscalate ? 'warn' : 'info',
        suffix: count > 1 ? ` [re-detected ${count}×; cancel may be failing or the order keeps getting re-created]` : '',
    };
}

function _filterUnmatchedChainOrders(manager: any, chainOrderId: string): void {
    if (Array.isArray(manager._lastUnmatchedChainOrders)) {
        manager._lastUnmatchedChainOrders = manager._lastUnmatchedChainOrders.filter(
            (u: any) => (u?.id || u?.orderId || u?.chainOrderId) !== chainOrderId
        );
    }
}

// ================================================================================
// SECTION 1: CHAIN ORDER MATCHING & RECONCILIATION
// ================================================================================

/**
 * Parse blockchain order into standard grid order format.
 * Extracts price, type (BUY/SELL), and size from blockchain order structure.
 * Handles precision scaling between assets.
 * 
 * @param {Object} chainOrder - Order from blockchain with sell_price and for_sale
 * @param {Object} assets - Asset metadata with assetA, assetB, and precisions
 * @returns {Object|null} Parsed order {orderId, price, type, size} or null if invalid
 */
function parseChainOrder(chainOrder: any, assets: any) {
    if (!chainOrder || !chainOrder.sell_price || !assets) return null;
    const { base, quote } = chainOrder.sell_price;
    if (!base || !quote || !base.asset_id || !quote.asset_id || base.amount === 0) return null;
    
    let price; let type;
    const precisionDelta = assets.assetA.precision - assets.assetB.precision;
    const scaleFactor = precisionDelta >= 0
        ? Math.pow(10, precisionDelta)
        : Math.pow(10, Math.abs(precisionDelta));

    if (base.asset_id === assets.assetA.id && quote.asset_id === assets.assetB.id) {
        price = precisionDelta >= 0
            ? (quote.amount / base.amount) * scaleFactor
            : (quote.amount / base.amount) / scaleFactor;
        type = ORDER_TYPES.SELL;
    } else if (base.asset_id === assets.assetB.id && quote.asset_id === assets.assetA.id) {
        price = precisionDelta >= 0
            ? (base.amount / quote.amount) * scaleFactor
            : (base.amount / quote.amount) / scaleFactor;
        type = ORDER_TYPES.BUY;
    } else return null;

    let size;
    try {
        if (chainOrder.for_sale !== undefined && chainOrder.for_sale !== null) {
            const prec = (type === ORDER_TYPES.SELL) ? assets.assetA.precision : assets.assetB.precision;
            size = blockchainToFloat(toFiniteNumber(chainOrder.for_sale), prec);
        }
    } catch (e: any) {
        orderLogger.warn(`parseChainOrder failed for ${chainOrder?.id}: ${getErrorMessage(e)}`);
        return null;
    }

    return { orderId: chainOrder.id, price, type, size };
}

/**
 * Find grid order matching a blockchain order.
 * First tries exact orderId match, then falls back to price/size matching within tolerance.
 * Used during synchronization to link blockchain orders to grid slots.
 * 
 * @param {Object} parsedChainOrder - Parsed blockchain order {orderId, price, type, size}
 * @param {Object} [opts={}] - Options object
 * @param {Map} [opts.orders] - Grid orders map to search
 * @param {Object} [opts.assets] - Asset metadata for precision
 * @param {Function} [opts.calcToleranceFn] - Function to calculate price tolerance
 * @param {Object} [opts.logger] - Optional logger
 * @param {boolean} [opts.skipSizeMatch=false] - Skip size matching check
 * @param {boolean} [opts.allowSmallerChainSize=false] - Allow chain order to be smaller
 * @param {boolean} [opts.requireAvailableSlot=false] - Skip slots already bound to a different chain order
 * @param {Set<string>} [opts.excludeGridOrderIds] - Skip grid slot ids already assigned in this sync pass
 * @returns {Object|null} Matching grid order or null if no match found
 */
function findMatchingGridOrderByOpenOrder(parsedChainOrder: any, opts: any) {
    const { orders, assets, calcToleranceFn } = opts || {};
    if (!parsedChainOrder || !orders) return null;

    if (parsedChainOrder.orderId) {
        for (const gridOrder of orders.values()) {
            if (gridOrder?.orderId === parsedChainOrder.orderId) return gridOrder;
        }
    }

    const chainSize = toFiniteNumber(parsedChainOrder.size);
    const chainPrice = toFiniteNumber(parsedChainOrder.price);
    const isSell = parsedChainOrder.type === ORDER_TYPES.SELL;
    const precision = isSell ? assets?.assetA?.precision : assets?.assetB?.precision;

    if (typeof precision !== 'number') return null;

    const chainInt = floatToBlockchainInt(chainSize, precision);
    let bestMatch = null;
    let bestPriceDiff = Infinity;

    for (const gridOrder of orders.values()) {
        const typeMatch = gridOrder?.type === parsedChainOrder.type ||
            (opts?.allowSpreadType && gridOrder?.type === ORDER_TYPES.SPREAD);
        if (!gridOrder || !typeMatch) continue;
        if (opts?.excludeGridOrderIds?.has?.(gridOrder.id)) continue;
        if (![ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL, ORDER_STATES.VIRTUAL].includes(gridOrder.state)) continue;
        if (opts?.requireAvailableSlot && gridOrder.orderId && gridOrder.orderId !== parsedChainOrder.orderId) continue;

        const priceDiff = Math.abs(gridOrder.price - chainPrice);
        // Virtual/spread slots have size=0 — fall back to chain order's size so the
        // precision-based tolerance is meaningful instead of collapsing to 0.
        const effectiveSize = gridOrder.size > 0 ? gridOrder.size : chainSize;
        // When calcToleranceFn returns null (e.g. zero-size virtual slot), fall back to
        // exact matching (tolerance=0). This is intentional — virtual/spread slots should
        // only match chain orders at exactly their grid price.
        const priceTolerance = calcToleranceFn?.(gridOrder.price, effectiveSize, parsedChainOrder.type) || 0;
        if (priceDiff > priceTolerance) continue;

        const gridInt = floatToBlockchainInt(gridOrder.size, precision);
        const sizeMismatch = opts?.allowSmallerChainSize ? (chainInt > gridInt + 1) : (Math.abs(gridInt - chainInt) > 1);

        if (!opts?.skipSizeMatch && sizeMismatch) continue;

        if (priceDiff < bestPriceDiff) {
            bestPriceDiff = priceDiff;
            bestMatch = gridOrder;
        }
    }

    return bestMatch;
}

/**
 * Update grid order size based on blockchain state.
 * Detects partial fills and updates accounting if size changed.
 * 
 * Returns the updated order object or null if no update needed.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} gridOrder - Grid order to update
 * @param {number} chainSize - Size from blockchain
 * @returns {Promise<Object|null>} Updated order object or null
 * @throws {Error} If chainSize suspicious (possible data corruption)
 */
async function applyChainSizeToGridOrder(manager: any, gridOrder: any, chainSize: any) {
    if (!manager || !gridOrder) return null;
    if (gridOrder.state !== ORDER_STATES.ACTIVE && gridOrder.state !== ORDER_STATES.PARTIAL) return null;

    const precision = (gridOrder.type === ORDER_TYPES.SELL) ? manager.assets?.assetA?.precision : manager.assets?.assetB?.precision;

    if (isValidNumber(precision) && isValidNumber(chainSize)) {
        const SUSPICIOUS_SATOSHI_LIMIT = 1e15;
        const suspiciousThreshold = SUSPICIOUS_SATOSHI_LIMIT / Math.pow(10, precision);
        if (Math.abs(toFiniteNumber(chainSize)) > suspiciousThreshold) {
            const msg = `CRITICAL: suspicious chainSize=${chainSize} exceeds limit ${suspiciousThreshold}. Possible blockchain sync error or data corruption.`;
            manager.logger?.log?.(msg, 'error');
            throw new Error(msg);
        }
    }

    const oldSize = toFiniteNumber(gridOrder.size);
    const newSize = isValidNumber(chainSize) ? toFiniteNumber(chainSize) : oldSize;

    if (floatToBlockchainInt(oldSize, precision) === floatToBlockchainInt(newSize, precision)) { 
        return null; 
    }

    const updatedOrder = { ...gridOrder, size: newSize };

    const delta = newSize - oldSize;
    if (delta < 0 && manager.logger) {
        if (typeof manager.logger.logFundsStatus === 'function') manager.logger.logFundsStatus(manager);
    }
    return updatedOrder;
}

/**
 * Build a stable fill dedupe key.
 * Accepts either a fill-history entry or explicit parts.
 * Returns null if required fields are missing — callers should
 * skip dedup rather than operate on a degraded key.
 *
 * @param {Object} fillOrParts - Fill entry ({ op, block_num, id }) or { orderId, blockNum, historyId }
 * @returns {string|null} Stable key in order:block:history form, or null if fields are missing
 */
function buildFillKey(fillOrParts: any) {
    const fillOp = fillOrParts?.op?.[1];
    const orderId = fillOp?.order_id ?? fillOrParts?.orderId;
    const blockNum = fillOrParts?.block_num ?? fillOrParts?.blockNum;
    const historyId = fillOrParts?.id ?? fillOrParts?.historyId;
    if (!orderId || blockNum == null || !historyId) return null;
    return `${orderId}:${blockNum}:${historyId}`;
}

/**
 * Correct a single order's price on blockchain.
 * Cancels surplus orders; updates price for others.
 * Removes from correction queue after processing.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} correctionInfo - Correction details {gridOrder, chainOrderId, expectedPrice, size, type, isSurplus}
 * @param {string} accountName - Account name for blockchain transaction
 * @param {string} privateKey - Private key for signing
 * @param {Object} accountOrders - AccountOrders accessor for blockchain ops
 * @returns {Promise<Object>} Result {success, cancelled, skipped, error, orderGone}
 */
async function correctOrderPriceOnChain(manager: any, correctionInfo: any, accountName: any, privateKey: any, accountOrders: any) {
    const { gridOrder, chainOrderId, expectedPrice, size, type, isSurplus, cancelOnly } = correctionInfo;
    const stillNeeded = manager.ordersNeedingPriceCorrection?.some((c: any) => c.chainOrderId === chainOrderId);
    if (!stillNeeded) return { success: true, skipped: true };

    // Cancel-only entries (e.g., duplicate price level orphans) — cancel without
    // updating any grid slot. The orphan has no matching grid slot to convert.
    if (cancelOnly) {
        let shouldRemove = false;
        try {
            const sideLabel = type === ORDER_TYPES.SELL ? 'SELL' : 'BUY';
            manager.logger?.log?.(`[CORRECTION] Cancelling duplicate orphan ${sideLabel} order ${chainOrderId}`, 'info');
            await accountOrders.cancelOrder(accountName, privateKey, chainOrderId);
            clearDuplicateOrphanDetection(chainOrderId);
            _filterUnmatchedChainOrders(manager, chainOrderId);
            shouldRemove = true;
            return { success: true, cancelled: true };
        } catch (error: any) {
            const orderGone = isOrderGoneErrorMessage(getErrorMessage(error));
            if (orderGone) {
                clearDuplicateOrphanDetection(chainOrderId);
                shouldRemove = true;
                _filterUnmatchedChainOrders(manager, chainOrderId);
            }
            return { success: false, error: getErrorMessage(error), orderGone };
        } finally {
            if (shouldRemove) {
                manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter((c: any) => c.chainOrderId !== chainOrderId);
            }
        }
    }

    // Surplus/type-mismatch entries need cancellation, not a price update
    if (isSurplus) {
        let shouldRemove = false;
        try {
            const sideLabel = type === ORDER_TYPES.SELL ? 'SELL' : 'BUY';
            manager.logger?.log?.(`[CORRECTION] Cancelling surplus/mismatched ${sideLabel} order ${chainOrderId} for slot ${gridOrder?.id || 'unknown'}`, 'info');
            await accountOrders.cancelOrder(accountName, privateKey, chainOrderId);
            if (gridOrder && manager._applyOrderUpdate) {
                const spreadOrder = convertToSpreadPlaceholder(gridOrder);
                await manager._applyOrderUpdate(spreadOrder, 'surplus-type-mismatch-cancel', {
                    skipAccounting: false,
                    fee: 0
                });
            }
            _filterUnmatchedChainOrders(manager, chainOrderId);
            shouldRemove = true;
            return { success: true, cancelled: true };
        } catch (error: any) {
            const orderGone = getErrorMessage(error)?.includes(ORDER_GONE_ERROR_FRAGMENT);
            if (orderGone) {
                shouldRemove = true;
                _filterUnmatchedChainOrders(manager, chainOrderId);
            }
            return { success: false, error: getErrorMessage(error), orderGone };
        } finally {
            if (shouldRemove) {
                manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter((c: any) => c.chainOrderId !== chainOrderId);
            }
        }
    }

    let amountToSell, minToReceive;
    if (type === ORDER_TYPES.SELL) {
        amountToSell = size;
        minToReceive = size * expectedPrice;
    } else {
        amountToSell = size;
        minToReceive = size / expectedPrice;
    }

    let shouldRemove = false;

    // CROSSING-PLACEMENT GUARD: re-pricing the chain order to its slot's
    // committed price must not cross an opposite-side live order (only
    // reachable when the grid geometry itself is broken). Candidates are the
    // shared master + pending-broadcast + orphan set so a re-price cannot
    // cross a pending CREATE from an earlier uncertain batch. Drop the entry —
    // the next sync's price-mismatch detection re-queues the correction
    // once the crossed order is resolved (same lifecycle as a 'skipped'
    // update below).
    const crossed = MathUtils.findCrossedOrder(
        buildCrossingCheckCandidates(manager),
        expectedPrice,
        type,
        manager.assets,
        (o: any) => isCrossingCheckCandidate(o, chainOrderId)
    );
    if (crossed) {
        manager.logger?.log?.(
            `[CROSS-GUARD] Skipping price correction for ${chainOrderId} -> ${type} @${expectedPrice}: ` +
            `crosses live ${crossed.type} ${crossed.id} (${crossed.orderId}) @${crossed.price}; ` +
            `retried after the crossed order resolves.`,
            'warn'
        );
        // The guard returns before the try/finally below, so drop the entry
        // from the correction queue here — otherwise it would linger forever
        // and re-attempt on every sync cycle.
        manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter(
            (c: any) => c.chainOrderId !== chainOrderId
        );
        return { success: false, skipped: true, error: 'crossed-placement-guard' };
    }

    try {
        const updateResult = await accountOrders.updateOrder(accountName, privateKey, chainOrderId, { amountToSell, minToReceive });
        if (updateResult === null) {
            shouldRemove = true;
            return { success: false, error: 'skipped' };
        }
        shouldRemove = true;
        return { success: true };
    } catch (error: any) {
        const orderGone = getErrorMessage(error)?.includes(ORDER_GONE_ERROR_FRAGMENT);
        if (orderGone) {
            shouldRemove = true;
            _filterUnmatchedChainOrders(manager, chainOrderId);
        } else if (error?.code === 'BROADCAST_UNCERTAIN' || error?.name === 'BroadcastUncertainError') {
            // Uncertain update: the delta may have landed. Re-applying the same
            // delta on a later (possibly lagging) read would double-shrink the
            // order. Drop the entry instead of re-queueing blindly — the next
            // sync's price-mismatch detection re-queues the correction if the
            // order is still off-target, and treats it as done if the update
            // actually landed.
            shouldRemove = true;
            manager.logger?.log?.(
                `[CORRECTION] Uncertain price update for ${chainOrderId}; deferring verification to next sync re-detection`,
                'warn'
            );
        }
        return { success: false, error: getErrorMessage(error), orderGone };
    } finally {
        if (shouldRemove) {
            manager.ordersNeedingPriceCorrection = manager.ordersNeedingPriceCorrection.filter((c: any) => c.chainOrderId !== chainOrderId);
        }
    }
}

/**
 * Finalize bookkeeping for a correction whose chain order is confirmed gone
 * (batch-cancelled or discovered absent). Mirrors the per-entry cleanup in
 * correctOrderPriceOnChain: duplicate-orphan detection reset, unmatched-list
 * filter, queue removal, and (for surplus entries) grid-slot virtualization.
 */
async function _resolveCancelledCorrection(manager: any, entry: any): Promise<void> {
    const chainOrderId = entry.chainOrderId;
    if (entry.cancelOnly) {
        clearDuplicateOrphanDetection(chainOrderId);
    }
    if (!entry.cancelOnly && entry.isSurplus && entry.gridOrder && manager._applyOrderUpdate) {
        const spreadOrder = convertToSpreadPlaceholder(entry.gridOrder);
        await manager._applyOrderUpdate(spreadOrder, 'surplus-type-mismatch-cancel', {
            skipAccounting: false,
            fee: 0
        });
    }
    _filterUnmatchedChainOrders(manager, chainOrderId);
    manager.ordersNeedingPriceCorrection = (manager.ordersNeedingPriceCorrection || [])
        .filter((c: any) => c.chainOrderId !== chainOrderId);
}

/**
 * Broadcast all cancel-type corrections (cancelOnly duplicate orphans +
 * surplus cancellations) together in chunked multi-op transactions.
 *
 * Rationale: the serial path issued one cancelOrder tx per orphan with a sleep
 * between each, draining at ~1 order per block (~3s). A large duplicate-orphan
 * backlog blocked CREATES for minutes while the queue drained
 * one-by-one. Cancels are zero-fee and reference no balance state, so they are
 * safe to pack densely (MAX_CANCELS_PER_BROADCAST).
 *
 * Safety:
 *  - Pre-broadcast existence read: a cancel op for an already-dead order makes
 *    the chain reject the ENTIRE transaction, so gone ids are resolved first
 *    and excluded from the batch.
 *  - Chunks are independent (cancels never interact), so a failed chunk does
 *    not abort the others. Failed-chunk ids are re-read post-broadcast: ids
 *    confirmed gone (uncertain broadcast that landed) are resolved; ids still
 *    live are returned UNRESOLVED so the caller retries them through the
 *    single-entry path (which keeps its own verified-after-failure logic).
 *
 * @returns {Promise<{corrected: number, failed: number, unresolved: Array}>}
 */
async function _batchCancelCorrections(manager: any, entries: any[], accountName: any, privateKey: any, accountOrders: any) {
    const logger = manager?.logger;
    const unresolved: any[] = [];
    let corrected = 0;
    let failed = 0;

    const byId = new Map<string, any>();
    for (const e of entries) {
        if (e?.chainOrderId && !byId.has(e.chainOrderId)) byId.set(e.chainOrderId, e);
    }
    const ids = [...byId.keys()];

    let presentIds = ids;
    const preRead = typeof accountOrders?.batchReadOrders === 'function';
    if (preRead) {
        try {
            const orderMap = await accountOrders.batchReadOrders(ids);
            const goneIds: string[] = [];
            presentIds = [];
            for (const id of ids) {
                if (orderMap.get(id)) presentIds.push(id); else goneIds.push(id);
            }
            for (const id of goneIds) {
                await _resolveCancelledCorrection(manager, byId.get(id));
                corrected++;
            }
        } catch (err: any) {
            logger?.log?.(
                `[CORRECTION] Batch pre-read of ${ids.length} cancel candidate(s) failed; proceeding with broadcast: ${getErrorMessage(err)}`,
                'warn'
            );
            presentIds = ids;
        }
    }
    if (presentIds.length === 0) return { corrected, failed, unresolved };

    let ops: { id: string; op: any; }[] = [];
    try {
        for (const id of presentIds) {
            const op = await accountOrders.buildCancelOrderOp(accountName, id);
            ops.push({ id, op });
        }
    } catch (err: any) {
        // Op construction failed (e.g. account resolution): fall back entirely.
        logger?.log?.(
            `[CORRECTION] Batch cancel build failed (${presentIds.length} order(s)): ${getErrorMessage(err)}; falling back to serial cancels`,
            'warn'
        );
        return { corrected, failed, unresolved: entries.filter((e: any) => presentIds.includes(e.chainOrderId)) };
    }

    const configuredMax = Number(COW_PERFORMANCE?.MAX_CANCELS_PER_BROADCAST);
    const maxCancels = Number.isFinite(configuredMax) && configuredMax >= 1 ? Math.floor(configuredMax) : 1;
    const chunks: typeof ops[] = [];
    for (let i = 0; i < ops.length; i += maxCancels) {
        chunks.push(ops.slice(i, i + maxCancels));
    }
    logger?.log?.(
        `[CORRECTION] Batch-cancelling ${ops.length} duplicate/surplus order(s) in ${chunks.length} transaction(s) (max ${maxCancels} cancels/broadcast)`,
        'info'
    );

    const failedChunks: typeof ops[] = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
            await accountOrders.executeBatch(accountName, privateKey, chunk.map((o: any) => o.op));
            for (const { id } of chunk) {
                await _resolveCancelledCorrection(manager, byId.get(id));
                corrected++;
            }
            logger?.log?.(`[CORRECTION] Batch chunk ${i + 1}/${chunks.length} cancelled ${chunk.length} order(s)`, 'info');
        } catch (err: any) {
            logger?.log?.(
                `[CORRECTION] Batch chunk ${i + 1}/${chunks.length} failed (${chunk.length} order(s)): ${getErrorMessage(err)}; verifying per order`,
                'warn'
            );
            failedChunks.push(chunk);
        }
    }

    for (const chunk of failedChunks) {
        let verifyMap: Map<string, any> | null = null;
        if (preRead) {
            try {
                verifyMap = await accountOrders.batchReadOrders(chunk.map((o: any) => o.id));
            } catch (_: any) {
                verifyMap = null;
            }
        }
        for (const { id } of chunk) {
            const stillLive = verifyMap ? verifyMap.get(id) : true;
            if (!stillLive && verifyMap) {
                // Uncertain broadcast that actually landed — order is gone.
                await _resolveCancelledCorrection(manager, byId.get(id));
                corrected++;
            } else {
                unresolved.push(byId.get(id));
            }
        }
    }

    return { corrected, failed, unresolved };
}

/**
 * Correct all pending price mismatches atomically.
 * Cancel-type corrections (duplicate orphans, surplus) are batched into
 * chunked multi-op transactions; price updates run sequentially.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {string} accountName - Account name for blockchain transactions
 * @param {string} privateKey - Private key for signing
 * @param {Object} accountOrders - AccountOrders accessor for blockchain ops
 * @returns {Promise<Object>} Summary {corrected, failed, results}
 */
async function correctAllPriceMismatches(manager: any, accountName: any, privateKey: any, accountOrders: any) {
    if (!manager || !manager._gridLock) return { corrected: 0, failed: 0, results: [] };

    return await manager._gridLock.acquire(async () => {
        const results: any[] = [];
        let corrected = 0; let failed = 0;
        const seen = new Set();
        const ordersToCorrect = (manager.ordersNeedingPriceCorrection || []).filter((c: any) => {
            if (!c.chainOrderId || seen.has(c.chainOrderId)) return false;
            seen.add(c.chainOrderId);
            return true;
        });

        const canBatch = ordersToCorrect.length > 1
            && typeof accountOrders?.buildCancelOrderOp === 'function'
            && typeof accountOrders?.executeBatch === 'function';
        let serialEntries = ordersToCorrect;
        if (canBatch) {
            const cancelEntries = ordersToCorrect.filter((c: any) => c.cancelOnly === true || c.isSurplus === true);
            const updateEntries = ordersToCorrect.filter((c: any) => !(c.cancelOnly === true || c.isSurplus === true));
            if (cancelEntries.length > 1) {
                const batchOutcome = await _batchCancelCorrections(
                    manager, cancelEntries, accountName, privateKey, accountOrders
                );
                corrected += batchOutcome.corrected;
                failed += batchOutcome.failed;
                serialEntries = [...batchOutcome.unresolved, ...updateEntries];
            }
        }

        for (const correctionInfo of serialEntries) {
            const result = await correctOrderPriceOnChain(manager, correctionInfo, accountName, privateKey, accountOrders);
            results.push({ ...correctionInfo, result });
            if (result && result.success) corrected++; else failed++;
            await sleep(TIMING.SYNC_DELAY_MS);
        }
        // Persist master grid mutations from surplus-type-mismatch cancellations.
        // Without this, corrections that cancel an order and convert its grid slot
        // to a spread placeholder are in-memory only until the next fill-driven or
        // maintenance-driven persist cycle.
        if (corrected > 0 && typeof manager.persistGrid === 'function') {
            await manager.persistGrid();
        }
        return { corrected, failed, results };
    });
}

// ================================================================================
// SECTION 2-3: ORDER CONSTRUCTION & STATE TRANSITIONS
// ================================================================================

/**
 * Build blockchain order arguments from grid order.
 * Converts grid order data to blockchain-compatible amounts and asset IDs.
 * Handles both BUY and SELL order types.
 * 
 * @param {Object} order - Grid order with type, size, price
 * @param {Object} assetA - Asset metadata with id and precision
 * @param {Object} assetB - Asset metadata with id and precision
 * @returns {Object} Blockchain args {amountToSell, sellAssetId, minToReceive, receiveAssetId}
 * @throws {Error} If asset precision missing
 */
function buildCreateOrderArgs(order: any, assetA: any, assetB: any) {
    let precision = (order.type === 'sell') ? assetA?.precision : assetB?.precision;
    if (typeof precision !== 'number') throw new Error("Asset precision missing");

    // IMPORTANT: create args must always come from target grid size.
    // Never reuse rawOnChain.for_sale here because stale metadata from a prior
    // slot role can inflate create amounts (e.g., SPREAD->BUY activation).
    const quantizedSize = quantizeFloat(order.size, precision);

    if (order.type === 'sell') {
        return { amountToSell: quantizedSize, sellAssetId: assetA.id, minToReceive: quantizedSize * order.price, receiveAssetId: assetB.id };
    } else {
        return { amountToSell: quantizedSize, sellAssetId: assetB.id, minToReceive: quantizedSize / order.price, receiveAssetId: assetA.id };
    }
}

/**
 * Build a deterministic fingerprint for a planned CREATE order.
 *
 * The fingerprint is used by the COW recovery path to match an
 * order the bot just tried to broadcast to an on-chain order that may or may
 * not have been accepted. Determinism is the key property: if the bot replays
 * the same CREATE op after a credential daemon timeout, the new fingerprint
 * must equal the old one so the chain side can be correlated.
 *
 * The fingerprint uses the (side, assetA, assetB, sellInt, receiveInt, slotId)
 * tuple. sellInt and receiveInt are the raw blockchain integer amounts from
 * buildCreateOrderOp's finalInts (see modules/chain_orders.ts). Using the
 * raw integer pair is more robust than re-deriving a price float because
 * it is invariant to human-side rounding.
 *
 * The slot id is included so two CREATEs with identical price+size on the
 * same side (theoretically possible across non-adjacent grid slots) are
 * still distinguishable.
 *
 * Returns null on any malformed input so callers can skip non-CREATE / non-
 * integer contexts without raising.
 *
 * @param {Object} params
 * @param {string} params.side - 'sell' or 'buy'
 * @param {string} params.assetA - Base asset id (e.g. '1.3.0')
 * @param {string} params.assetB - Quote asset id (e.g. '1.3.121')
 * @param {number|string} params.sellInt - Integer (blockchain-precision) amount-to-sell
 * @param {number|string} params.receiveInt - Integer (blockchain-precision) min-to-receive
 * @param {string} params.slotId - Grid slot id (e.g. 'sell-3', 'buy-7')
 * @returns {string|null} Fingerprint or null on bad input
 */
function buildCreateOpFingerprint(params: any) {
    if (!params || typeof params !== 'object') return null;
    const { side, assetA, assetB, sellInt, receiveInt, slotId } = params;
    if (side !== 'sell' && side !== 'buy') return null;
    if (!assetA || !assetB) return null;
    if (!Number.isFinite(Number(sellInt)) || !Number.isFinite(Number(receiveInt))) return null;
    if (!slotId) return null;
    return `${side}:${assetA}:${assetB}:${Number(sellInt)}:${Number(receiveInt)}:${String(slotId)}`;
}

/**
 * Determine which order sides were updated based on update flags.
 * 
 * @param {boolean} buyUpdated - Whether buy side was updated
 * @param {boolean} sellUpdated - Whether sell side was updated
 * @returns {string} "buy", "sell", or "both"
 */
function getOrderTypeFromUpdatedFlags(buyUpdated: any, sellUpdated: any) {
    return (buyUpdated && sellUpdated) ? 'both' : (buyUpdated ? 'buy' : 'sell');
}

/**
 * Resolve configured price bound (minPrice/maxPrice) to numeric value.
 * Supports relative expressions like "2x" and fallback defaults.
 * 
 * @param {*} value - Configured value (number, percentage, relative, or empty)
 * @param {number} fallback - Fallback value if configured value is empty
 * @param {number} startPrice - Reference price for relative calculations
 * @param {string} mode - "min" or "max" for relative calculation mode
 * @returns {number} Resolved numeric price
 * @throws {Error} If value is invalid and cannot be interpreted
 */
function resolveConfiguredPriceBound(value: any, fallback: any, startPrice: any, mode: any) {
    const configuredValue = (value === null || value === undefined || value === '') ? fallback : value;

    // Bound x-multipliers must be > 1. With min semantics "Nx" => center/N and
    // max semantics "Nx" => center*N, any multiplier < 1 resolves to a bound on
    // the WRONG side of the grid (e.g. "0.7x" => 1.43x center), placing the
    // whole rail across the order book. Reject sub-1x up front so a misconfig
    // fails clearly instead of producing a broken grid (issue #15).
    const m = MathUtils.parseRelativeMultiplier(configuredValue);
    if (m !== null && m < 1) {
        const boundName = mode === 'min' ? 'minPrice' : mode === 'max' ? 'maxPrice' : 'price bound';
        const hint = mode === 'min'
            ? `'Nx' means center/N for minPrice, so use a value > 1 (e.g. '1.43x' to place the bound at 70% of center)`
            : `'Nx' means center*N for maxPrice, so use a value > 1`;
        throw new Error(`Invalid ${boundName} '${configuredValue.trim()}': a bound multiplier must be > 1. ${hint}.`);
    }

    const relative = MathUtils.resolveRelativePrice(configuredValue, startPrice, mode);
    if (Number.isFinite(relative)) {
        return relative;
    }

    const numeric = Number(configuredValue);
    if (!Number.isFinite(numeric)) {
        const boundName = mode === 'min' ? 'minPrice' : mode === 'max' ? 'maxPrice' : 'price bound';
        throw new Error(`Invalid ${boundName}: ${String(configuredValue)}. Expected a numeric value or multiplier like 3x.`);
    }

    return numeric;
}

/**
 * Convert order to virtual state.
 * Clears on-chain ID and raw blockchain data, marks as VIRTUAL.
 * 
 * @param {Object} order - Order to virtualize
 * @returns {Object} Virtualized order (VIRTUAL state, no orderId)
 */
function virtualizeOrder(order: any) {
    if (!order) return order;
    // Drop btsFeeState and the createUncertain orphan marker: an explicit
    // virtualize is a known-clean hole transition, so durable "possibly
    // landed CREATE" evidence no longer applies to the resulting object.
    const { btsFeeState, createUncertain, ...rest } = order;
    return { ...rest, state: ORDER_STATES.VIRTUAL, orderId: null, rawOnChain: null };
}

/**
 * Convert order to spread placeholder (virtual, zero-sized spread order).
 * Used when clearing order slots during rotations or rebalancing.
 * 
 * @param {Object} order - Order to convert
 * @returns {Object} Spread placeholder order (VIRTUAL, SPREAD type, zero size)
 */
function convertToSpreadPlaceholder(order: any) {
    return { ...virtualizeOrder(order), type: ORDER_TYPES.SPREAD, size: 0 };
}

/**
 * Convert an order to a rail-typed hole placeholder: VIRTUAL with the rail
 * (BUY/SELL) type and the booked size preserved.
 *
 * Phase 2 counterpart to convertToSpreadPlaceholder. A consumed/in-rail
 * source slot (e.g. a filled sell at slot-147, or a rotation source) must
 * stay on its rail so candidate-selection and evacuation geometry keep
 * working — only true gap-band slots become side-neutral SPREAD holes.
 * validateOrder accepts sized BUY/SELL VIRTUAL slots (phantom/ILLEGAL checks
 * only fire for on-chain states), so the size survives validation.
 *
 * @param {Object} order - Order to convert
 * @param {string} railType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} [sizeOverride] - Explicit size (defaults to booked size, 0 when non-finite)
 * @returns {Object} Rail hole placeholder (VIRTUAL, rail type, preserved size)
 */
function toRailHolePlaceholder(order: any, railType: any, sizeOverride: any = null) {
    const rail = (railType === ORDER_TYPES.BUY || railType === ORDER_TYPES.SELL) ? railType : order?.type;
    const size = sizeOverride !== null && sizeOverride !== undefined
        ? Math.max(0, toFiniteNumber(sizeOverride))
        : Math.max(0, toFiniteNumber(order?.size));
    return { ...virtualizeOrder(order), type: rail, size };
}

/**
 * Geometry type for a slot index: BUY at/below the boundary, SELL at/above
 * sellStart, SPREAD inside the gap band. Null-safe — returns null when the
 * index, boundary, or gap width is unusable so callers fail closed.
 */
function geometryTypeForSlotIndex(idx: any, boundaryIdx: any, gapSlots: any) {
    // Explicit null/undefined/'' guard: Number(null) === 0 would silently
    // treat "no index" as slot 0 (BUY rail). Fail closed instead.
    if (idx === null || idx === undefined || idx === '') return null;
    if (boundaryIdx === null || boundaryIdx === undefined || boundaryIdx === '') return null;
    const n = Number(idx);
    const b = Number(boundaryIdx);
    const g = Number(gapSlots);
    if (!Number.isFinite(n) || !Number.isFinite(b) || !Number.isFinite(g) || g < 0) return null;
    if (n <= b) return ORDER_TYPES.BUY;
    if (n >= MathUtils.getSellStartIdx(b, g)) return ORDER_TYPES.SELL;
    return ORDER_TYPES.SPREAD;
}

/**
 * Detect gap-evacuation candidates by GEOMETRY ONLY: live on-chain orders
 * whose parsed slot index sits strictly inside the gap band
 * (boundary < idx < sellStartIdx). Never consults the stored slot type —
 * Phase 2 retypes in-band actives to rail types, so type-based detection
 * would go blind exactly when evacuation matters.
 *
 * @param {Map} masterGrid - Master grid (slotId -> order)
 * @param {number} boundaryIdx - Last BUY slot index (frozen at plan-build)
 * @param {number} gapSlots - Spread gap slot count (frozen at plan-build)
 * @returns {Array} Candidates [{id, idx, type, price, size, orderId}]
 */
function detectGapEvacuationCandidates(masterGrid: any, boundaryIdx: any, gapSlots: any) {
    const out: any[] = [];
    if (!masterGrid || typeof masterGrid.values !== 'function') return out;
    const b = Number(boundaryIdx);
    const g = Number(gapSlots);
    if (!Number.isFinite(b) || !Number.isFinite(g) || g < 0) return out;
    const sellStartIdx = MathUtils.getSellStartIdx(b, g);
    if (!Number.isFinite(sellStartIdx)) return out;
    for (const slot of masterGrid.values()) {
        if (!slot || !isOrderOnChain(slot) || !slot.orderId) continue;
        const idx = parseSlotIndex(slot.id);
        if (idx === null || idx === undefined) continue;
        if (Number(idx) > b && Number(idx) < sellStartIdx) {
            out.push({ id: slot.id, idx: Number(idx), type: slot.type, price: slot.price, size: slot.size, orderId: slot.orderId });
        }
    }
    return out;
}

/**
 * Tick the per-slot gap-evacuation streak counter. In-memory on the manager
 * (resets on restart — acceptable; a restart re-plans evacuation anyway).
 * Slots still in-band increment; resolved slots are dropped. Returns the ids
 * whose streak reached the threshold (stuck candidates).
 *
 * @param {Map} streakMap - Mutable Map slotId -> consecutive-cycle count
 * @param {Array} candidates - detectGapEvacuationCandidates output
 * @param {number} [threshold] - GRID_LIMITS.GAP_EVACUATION_STREAK_THRESHOLD default
 * @returns {{streaks: Object, ready: Array}}
 */
function updateGapEvacuationStreaks(streakMap: any, candidates: any, threshold: any = null) {
    const thrRaw = threshold !== null && threshold !== undefined ? Number(threshold) : Number(GRID_LIMITS?.GAP_EVACUATION_STREAK_THRESHOLD);
    const thr = Number.isFinite(thrRaw) && thrRaw > 0 ? Math.floor(thrRaw) : 2;
    const seen = new Set<string>();
    const list = Array.isArray(candidates) ? candidates : [];
    for (const c of list) {
        if (!c?.id || seen.has(c.id)) continue;
        seen.add(c.id);
        if (streakMap instanceof Map) {
            streakMap.set(c.id, Number(streakMap.get(c.id) || 0) + 1);
        }
    }
    if (streakMap instanceof Map) {
        for (const id of Array.from(streakMap.keys())) {
            if (!seen.has(id)) streakMap.delete(id);
        }
    }
    const streaks: Record<string, number> = {};
    const ready: any[] = [];
    if (streakMap instanceof Map) {
        for (const [id, count] of streakMap.entries()) {
            streaks[id] = Number(count);
            if (Number(count) >= thr) {
                const cand = list.find((c: any) => c?.id === id) || { id };
                ready.push(cand);
            }
        }
    }
    return { streaks, ready };
}

/**
 * Resolve the real BUY/SELL side of a SPREAD-typed grid slot from its price
 * relative to the configured start price. SPREAD slots never carry an
 * on-chain state (validateOrder rejects SPREAD+ACTIVE/PARTIAL as fatal), so
 * every transition to an on-chain state (fill processing, sync, adoption)
 * must resolve the side first. Convention is strict: price below startPrice
 * is BUY, at or above is SELL.
 * @param {number} price - The slot's grid price.
 * @param {number} startPrice - The configured grid center price.
 * @returns {string} ORDER_TYPES.BUY or ORDER_TYPES.SELL
 */
function resolveSpreadOrderSide(price: any, startPrice: any): string {
    return Number(price) < Number(startPrice) ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
}

/**
 * Parse a grid slot id ("slot-123") to its rail index. Delegates to
 * shared slot.ts single source (GRID_PRICE_SLOT_DETERMINISM_PLAN §2.1).
 * @param {any} id - grid slot id string
 * @returns {number|null}
 */
function parseSlotIndex(id: any): number | null {
    return parseSlotIndexShared(id);
}
/**
 * Whether a parsed chain order matches a grid slot exactly:
 * type-compatible (slot may be SPREAD), price strictly equal via integer
 * round-trip (single epsilon), size within 1% quantum tolerance (floor 2
 * units). STRICT genesis-slot-mapping matcher — use only where the slot is
 * derived from the price (nearest-slot authority). Uncertain-landed
 * adoption (a broadcast whose on-chain price may have drifted by dust)
 * must use chainOrderMatchesSlotWithTolerance instead, or the drifted
 * order is never adopted and gets re-broadcast as a duplicate.
 * @param {Object} parsed - parseChainOrder output ({type, price, size, ...})
 * @param {Object} slot - Grid slot order object
 * @param {Object} assets - Manager assets ({assetA, assetB} with precision)
 * @returns {boolean}
 */
function chainOrderMatchesSlot(parsed: any, slot: any, assets: any): boolean {
    if (!parsed || !slot || !assets) return false;
    if (parsed.type !== slot.type && slot.type !== ORDER_TYPES.SPREAD) return false;
    // Genesis-frozen: price equality via integer round-trip (single epsilon); slot id is handled by caller via slotIndexForPrice
    {
        const precision = parsed.type === ORDER_TYPES.SELL ? assets.assetA.precision : assets.assetB.precision;
        if (!priceSlotEqual(parsed.price, slot.price, precision)) return false;
    }
    const precision = parsed.type === ORDER_TYPES.SELL ? assets.assetA.precision : assets.assetB.precision;
    const sizeTolerance = Math.max(2, Math.floor(floatToBlockchainInt(slot.size, precision) * 0.01));
    if (Math.abs(floatToBlockchainInt(parsed.size, precision) - floatToBlockchainInt(slot.size, precision)) > sizeTolerance) return false;
    return true;
}
/**
 * Whether a parsed chain order matches a grid slot within price tolerance:
 * type-compatible (slot may be SPREAD), price within calculatePriceTolerance
 * (clamped to ~2 price quanta so dust-inflated tolerances cannot adopt a
 * wrong order), size within the same 1% quantum tolerance as the strict
 * matcher. For the UNCERTAIN-ADOPT paths only (a just-broadcast create whose
 * on-chain price may have drifted by rounding dust): the strict
 * chainOrderMatchesSlot would miss the drifted order, the slot would stay
 * VIRTUAL, and the next cycle would re-broadcast it as a duplicate.
 * Genesis slot mapping keeps the strict matcher (nearest-slot authority).
 * @param {Object} parsed - parseChainOrder output ({type, price, size, ...})
 * @param {Object} slot - Grid slot order object
 * @param {Object} assets - Manager assets ({assetA, assetB} with precision)
 * @returns {boolean}
 */
function chainOrderMatchesSlotWithTolerance(parsed: any, slot: any, assets: any): boolean {
    if (!parsed || !slot || !assets) return false;
    if (parsed.type !== slot.type && slot.type !== ORDER_TYPES.SPREAD) return false;
    const precision = parsed.type === ORDER_TYPES.SELL ? assets.assetA.precision : assets.assetB.precision;
    let tolerance: number | null = null;
    try {
        tolerance = MathUtils.calculatePriceTolerance(
            Math.min(parsed.price, slot.price),
            Math.max(parsed.size, slot.size),
            parsed.type,
            assets
        );
    } catch {
        tolerance = null;
    }
    // Clamp to ~2 price quanta (relative): dust-sized orders inflate the
    // tolerance past the grid increment, which would adopt a wrong order.
    // A null tolerance (invalid inputs) falls back to the clamp itself.
    const quantumCap = 2 * MathUtils.quantumForPrecision(precision) * Math.max(1, Math.max(parsed.price, slot.price));
    if (tolerance == null || !Number.isFinite(tolerance)) tolerance = quantumCap;
    else tolerance = Math.min(tolerance, quantumCap);
    if (Math.abs(parsed.price - slot.price) > tolerance) return false;
    const sizeTolerance = Math.max(2, Math.floor(floatToBlockchainInt(slot.size, precision) * 0.01));
    if (Math.abs(floatToBlockchainInt(parsed.size, precision) - floatToBlockchainInt(slot.size, precision)) > sizeTolerance) return false;
    return true;
}
/**
 * Identity of a crossing-check candidate. Master orders carry orderId,
 * unmatched chain orders carry chainOrderId, pending-broadcast wrappers
 * carry slotId + order (their inner order has no chain id yet — it may not
 * even be on chain). All three classes must be visible to crossing guards:
 * an UPDATE-only rotation batch can otherwise re-price across a pending
 * CREATE from an earlier uncertain batch and self-trade (BitShares has no
 * self-trade prevention).
 * @param {Object} o - Candidate order or pending-broadcast wrapper entry
 * @returns {string|null} Chain/slot identity, or null when not placeable
 */
function crossingCandidateChainId(o: any): string | null {
    if (!o) return null;
    if (o.orderId) return o.orderId;
    if (o.chainOrderId) return o.chainOrderId;
    if (o.slotId && o.order) return o.slotId;
    return null;
}
/**
 * Shared predicate for every crossing-placement guard (COW create/rotation/
 * fallback, startup reconcile placement, price-correction re-queue). Accepts
 * master orders (orderId), unmatched chain orders (chainOrderId), AND
 * pending-broadcast wrappers (slotId + order) — pending entries can never be
 * in cancelOpIndexByOrderId (keyed by chain ids; wrapper orderIds are slot
 * ids in a disjoint namespace), so the exclusion check is harmless for them.
 * VIRTUAL slots (no orderId) are rejected: they have no chain presence and
 * must never block placements.
 * @param {Object} o - Candidate order or pending-broadcast wrapper entry
 * @param {string|null} [excludeChainOrderId=null] - Chain id to exempt (the order being relocated itself)
 * @param {Map|null} [cancelOpIndexByOrderId=null] - orderId -> op index of its already-queued cancel
 * @returns {boolean} True when the candidate participates in crossing checks
 */
function isCrossingCheckCandidate(o: any, excludeChainOrderId: any = null, cancelOpIndexByOrderId: any = null): boolean {
    if (!o) return false;
    const oid = crossingCandidateChainId(o);
    if (!oid) return false;
    if (excludeChainOrderId && oid === excludeChainOrderId) return false;
    if (cancelOpIndexByOrderId instanceof Map && cancelOpIndexByOrderId.has(oid)) return false;
    const price = o.price ?? o.order?.price;
    if (price == null || !Number.isFinite(Number(price))) return false;
    return true;
}
/**
 * Shared candidate set for crossing-placement checks: master orders plus
 * chain-side orders that may exist on chain but are not (yet) adopted into
 * the master grid — pending-broadcast wrappers from earlier uncertain
 * batches (pushed as wrappers so the predicate can see their slotId; their
 * inner order carries type/price via findCrossedOrder's item.order fallback)
 * and unmatched chain orders (orphans). Without these, an UPDATE-only
 * rotation batch can re-price across an un-adopted chain order that
 * master-grid-only checks cannot see (the pending/unmatched batch guards
 * fire only for CREATE batches).
 * @param {Object} manager - OrderManager instance (orders Map, _pendingBroadcasts, _lastUnmatchedChainOrders)
 * @returns {any[]} Candidate orders/wrappers for findCrossedOrder
 */
function buildCrossingCheckCandidates(manager: any): any[] {
    if (!manager) return [];
    const candidates: any[] = manager.orders instanceof Map ? [...manager.orders.values()] : [];
    if (manager._pendingBroadcasts instanceof Map) {
        for (const entry of manager._pendingBroadcasts.values()) {
            if (entry && entry.slotId && entry.order) candidates.push(entry);
        }
    }
    if (Array.isArray(manager._lastUnmatchedChainOrders)) {
        for (const o of manager._lastUnmatchedChainOrders) {
            if (o && o.type != null && o.price != null) candidates.push(o);
        }
    }
    return candidates;
}

// ================================================================================
// SECTION 4-6: FILTERING, PREDICATES & SIZE VALIDATION
// ================================================================================

/**
 * Filter orders array by type.
 * 
 * @param {Array<Object>} orders - Orders to filter
 * @param {string} orderType - Order type to match (BUY, SELL, SPREAD)
 * @returns {Array<Object>} Filtered orders of specified type
 */
function filterOrdersByType(orders: any, orderType: any) {
    return Array.isArray(orders) ? orders.filter((o: any) => o && o.type === orderType) : [];
}

/**
 * Build outside->center paired groups from mixed BUY/SELL items.
 * SELL items are ordered highest->lowest price, BUY items lowest->highest,
 * then zipped into groups: [sell0,buy0], [sell1,buy1], ...
 *
 * @param {Array<*>} items - Source items containing order-like data.
 * @param {Object} accessors - Accessor functions for item shape.
 * @param {(item: any) => boolean} [accessors.isValid=Boolean] - Validity predicate.
 * @param {(item: any) => string} accessors.getType - Returns ORDER_TYPES value.
 * @param {(item: any) => number|string} accessors.getPrice - Returns item price.
 * @returns {Array<Array<*>>} Grouped items in outside->center pair order.
 */
function buildOutsideInPairGroups(items: any, { isValid = Boolean, getType, getPrice }: any) {
    const safeItems = Array.isArray(items) ? items.filter((item: any) => isValid(item)) : [];
    if (safeItems.length === 0) return [];

    const sellItems = safeItems
        .filter((item: any) => getType(item) === ORDER_TYPES.SELL)
        .sort((a: any, b: any) => Number(getPrice(b) || 0) - Number(getPrice(a) || 0));

    const buyItems = safeItems
        .filter((item: any) => getType(item) === ORDER_TYPES.BUY)
        .sort((a: any, b: any) => Number(getPrice(a) || 0) - Number(getPrice(b) || 0));

    const groups: any[] = [];
    const maxLen = Math.max(sellItems.length, buyItems.length);
    for (let i = 0; i < maxLen; i++) {
        const group: any[] = [];
        if (i < sellItems.length) group.push(sellItems[i]);
        if (i < buyItems.length) group.push(buyItems[i]);
        if (group.length > 0) groups.push(group);
    }

    return groups;
}

/**
 * Extract operation_results from a chain batch execution result.
 * Handles the multiple result shapes returned by different chain library versions
 * and wrapped/unwrapped transaction formats.
 *
 * @param {Object|Array} result - Raw chain batch execution result.
 * @returns {Array} Array of operation result tuples, or empty array if unrecognized.
 */
function extractBatchOperationResults(result: any) {
    const ops = (
        (result && Array.isArray(result.operation_results) && result.operation_results) ||
        (result && result.raw && Array.isArray(result.raw.operation_results) && result.raw.operation_results) ||
        (result && result.raw && result.raw.trx && Array.isArray(result.raw.trx.operation_results) && result.raw.trx.operation_results) ||
        (result && Array.isArray(result) && result[0] && result[0].trx && Array.isArray(result[0].trx.operation_results) && result[0].trx.operation_results) ||
        null
    );
    return (ops && ops.length > 0) ? ops : null;
}

/**
 * Format an unmatched chain order/blocker for operator logs.
 *
 * @param {Object} order - Unmatched chain order or structural blocker.
 * @returns {string} Compact human-readable diagnostic.
 */
function formatUnmatchedChainOrder(order: any) {
    if (!order) return 'unknown unmatched order';
    const parts = [
        `${order.chainOrderId || 'unknown'}:${order.type || 'unknown'}@${Format.formatPrice6(order.price)}`,
    ];
    if (order.size !== undefined) parts.push(`size=${Format.formatAmount(order.size)}`);
    if (order.slotId) parts.push(`slot=${order.slotId}`);
    if (order.reason) parts.push(`reason=${order.reason}`);
    if (order.fingerprint) parts.push(`fingerprint=${order.fingerprint}`);
    if (order.candidateDiagnostics) parts.push(`candidates=${order.candidateDiagnostics}`);
    return parts.join(' ');
}

/**
 * Check if order is on blockchain (ACTIVE or PARTIAL state).
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order has on-chain state
 */
function isOrderOnChain(order: any) {
    return (order?.state === ORDER_STATES.ACTIVE || order?.state === ORDER_STATES.PARTIAL) && !!order?.orderId;
}

/**
 * Resolve the type to keep when a slot holding a live on-chain order would
 * otherwise be reassigned to SPREAD. SPREAD+ACTIVE/PARTIAL is an illegal state
 * (validateOrder rejects it as fatal ILLEGAL_SPREAD_STATE), so the slot keeps
 * its stored BUY/SELL rail type; a stale SPREAD type is resolved by the slot
 * index vs the boundary (the same convention the grid type correction uses).
 * A genuinely misplaced order is later cancelled by sync pass-1 type-mismatch
 * handling. Shared by assignGridRoles (runtime boundary shifts) and the
 * load-time GRID-TYPE-CORRECT guard so the invariant lives in one place.
 * Filled orders are unaffected: a full fill first converts the slot via
 * convertToSpreadPlaceholder/virtualizeOrder, clearing orderId and state, so
 * isOrderOnChain is false and the placeholder remains freely retypable.
 *
 * @param {Object} slot - The slot being retyped
 * @param {number} idx - Slot index
 * @param {number} buyEndIdx - Boundary index (last BUY slot)
 * @param {Object} ORDER_TYPES - ORDER_TYPES constants
 * @returns {string} Type to keep for the on-chain slot
 */
function resolveOnChainRetypeType(slot: any, idx: number, buyEndIdx: number, ORDER_TYPES: any) {
    return (slot.type === ORDER_TYPES.BUY || slot.type === ORDER_TYPES.SELL)
        ? slot.type
        : (idx <= buyEndIdx ? ORDER_TYPES.BUY : ORDER_TYPES.SELL);
}

/**
 * Check if order is virtual (not on blockchain yet).
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order in VIRTUAL state
 */
function isOrderVirtual(order: any) { return order?.state === ORDER_STATES.VIRTUAL; }

/**
 * Whether a slot is an empty reusable placeholder: VIRTUAL, no chain order,
 * and zero size.  Empty slots are normalized to SPREAD (side-neutral) so their
 * stored type never pre-biases which rail reuses them.
 *
 * Shared by loadGrid (grid.ts) and assignGridRoles.  Callers differ in whether
 * a `type: null` slot counts as empty:
 * - loadGrid (defensive backstop for legacy persisted grids): any empty slot is
 *   forced to SPREAD, including null-typed ones (allowNullType: true).
 * - assignGridRoles (non-assignOnChain path): grid creation types fresh slots
 *   null and must let geometry assign BUY/SELL, so a null type is NOT empty.
 *
 * The resolved `liveSlot` (when provided) supplies the state/orderId/size
 * checks; the `slot` object supplies the type check.  `isOrderOnChain` is
 * intentionally not checked: VIRTUAL + !orderId already implies off-chain.
 *
 * @param {Object} slot - The slot whose type is inspected.
 * @param {Object|null} liveSlot - Runtime slot for state checks (defaults to slot).
 * @param {Object} [opts] - Options.
 * @param {boolean} [opts.allowNullType=false] - Treat `type: null` slots as empty.
 * @returns {boolean} True when the slot is a size-0 VIRTUAL placeholder.
 */
function isEmptyGridSlot(slot: any, liveSlot: any = null, opts: { allowNullType?: boolean } = {}): boolean {
    if (!slot) return false;
    const target = liveSlot || slot;
    if (target.state !== ORDER_STATES.VIRTUAL) return false;
    if (target.orderId) return false;
    if (Number(target.size || 0) !== 0) return false;
    if (opts.allowNullType !== true && slot.type === null) return false;
    return true;
}

/**
 * Check if order has on-chain ID.
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order has orderId
 */
function hasOnChainId(order: any) { return !!order?.orderId; }

/**
 * Check if order is placed and confirmed on blockchain.
 * Must be on-chain (ACTIVE/PARTIAL) with orderId.
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order is confirmed placed
 */
function isOrderPlaced(order: any) { return isOrderOnChain(order) && hasOnChainId(order); }

/**
 * Check if order is phantom (on-chain but missing orderId).
 * Indicates a sync error or ghost order state.
 * 
 * @param {Object} order - Order to check
 * @returns {boolean} True if order appears on-chain but has no ID
 */
function isPhantomOrder(order: any) {
    const inOnChainState = order?.state === ORDER_STATES.ACTIVE || order?.state === ORDER_STATES.PARTIAL;
    return inOnChainState && !hasOnChainId(order);
}

/**
 * Check if slot is available for new order placement.
 * Slot must be VIRTUAL (not on-chain) and have no orderId.
 * 
 * @param {Object} order - Order/slot to check
 * @returns {boolean} True if slot available
 */
function isSlotAvailable(order: any) { return isOrderVirtual(order) && !hasOnChainId(order); }

/**
 * Check if order size meets health thresholds.
 * Must be above absolute minimum and double-dust threshold.
 * 
 * @param {number} size - Order size to check
 * @param {string} type - Order type (BUY/SELL)
 * @param {Object} assets - Asset metadata with precisions
 * @param {number} idealSize - Ideal grid size for dust calculation
 * @returns {boolean} True if order is healthy
 */
function isOrderHealthy(size: any, type: any, assets: any, idealSize: any) {
    const numericSize = Number(size);
    const numericIdeal = Number(idealSize);
    if (!Number.isFinite(numericSize) || numericSize <= 0) return false;
    if (!Number.isFinite(numericIdeal) || numericIdeal <= 0) return false;

    return MathUtils.validateOrderSize(
        numericSize,
        type,
        assets,
        GRID_LIMITS.MIN_ORDER_SIZE_FACTOR,
        numericIdeal,
        GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE
    ).isValid;
}

/**
 * Check if any size in array falls below threshold.
 * Used for validation before order placement.
 * 
 * @param {Array<number>} sizes - Sizes to check
 * @param {number} threshold - Minimum threshold value
 * @param {number} precision - Asset precision for quantization check
 * @param {boolean} [includeNonFinite=false] - Treat non-finite values as below threshold
 * @returns {boolean} True if any size is below threshold
 */
function checkSizeThreshold(sizes: any, threshold: any, precision: any, includeNonFinite: any = false) {
    if (threshold <= 0 || !Array.isArray(sizes) || sizes.length === 0) return false;
    const precisionSlack = isValidNumber(precision)
        ? MathUtils.getPrecisionSlack(precision, 1)
        : Number.EPSILON;
    return sizes.some((sz: any) => {
        if (!Number.isFinite(sz)) return includeNonFinite;
        if (sz <= 0) return false;
        if (isValidNumber(precision)) return floatToBlockchainInt(sz, precision) < floatToBlockchainInt(threshold, precision);
        return sz < (threshold - precisionSlack);
    });
}

/**
 * Check if any sizes are below minimum (including non-finite values).
 * Wrapper for checkSizeThreshold with includeNonFinite=true.
 * 
 * @param {Array<number>} sizes - Sizes to check
 * @param {number} minSize - Minimum size threshold
 * @param {number} precision - Asset precision
 * @returns {boolean} True if any size is below minimum
 */
function checkSizesBeforeMinimum(sizes: any, minSize: any, precision: any) {
    return checkSizeThreshold(sizes, minSize, precision, true);
}

/**
 * Calculate ideal grid boundary based on reference price.
 * Places boundary near reference price with gap spacing in mind.
 * 
 * @param {Array<Object>} allSlots - All grid slots sorted by price
 * @param {number} referencePrice - Reference/anchor price
 * @param {number} gapSlots - Number of gap slots between buy and sell
 * @returns {number} Ideal boundary index or -1 if slots empty
 */
function calculateIdealBoundary(allSlots: any, referencePrice: any, gapSlots: any) {
    if (!allSlots || allSlots.length === 0) return -1;
    let splitIdx = allSlots.findIndex((s: any) => s.price >= referencePrice);
    if (splitIdx === -1) splitIdx = allSlots.length;
    const buySpread = Math.floor(gapSlots / 2);
    return Math.max(0, Math.min(allSlots.length - 1, splitIdx - buySpread - 1));
}

/**
 * Assign BUY/SELL/SPREAD roles to grid slots based on boundary.
 * Slots below boundary are BUY, above boundary are SELL, between are SPREAD.
 * Can optionally override even on-chain orders.
 * 
 * @param {Array<Object>} allSlots - All grid slots to assign
 * @param {number} boundaryIdx - Boundary index
 * @param {number} gapSlots - Number of gap slots between buy and sell
 * @param {Object} ORDER_TYPES - ORDER_TYPES constants
 * @param {Object} ORDER_STATES - ORDER_STATES constants
 * @param {Object} [options={}] - Options
 * @param {boolean} [options.assignOnChain=false] - Override on-chain orders if true
 * @returns {Array<Object>} Slots with updated type assignments
 */
function assignGridRoles(allSlots: any, boundaryIdx: any, gapSlots: any, ORDER_TYPES: any, _ORDER_STATES: any, options: { assignOnChain?: boolean; getCurrentSlot?: (id: any) => any } = {}) {
    const assignOnChain = options.assignOnChain === true;
    const getCurrentSlot = (typeof options.getCurrentSlot === 'function') ? options.getCurrentSlot : null;
    const buyEndIdx = boundaryIdx;
    const sellStartIdx = MathUtils.getSellStartIdx(boundaryIdx, gapSlots);

    return allSlots.map((slot: any, i: any) => {
        const liveSlot = getCurrentSlot ? (getCurrentSlot(slot.id) || slot) : slot;

        // Empty VIRTUAL slots (size 0, no orderId) keep their RAIL type by
        // geometry (Phase 2): an in-rail hole stays BUY/SELL VIRTUAL so
        // candidate-selection and evacuation geometry keep working; only
        // true gap-band slots are side-neutral SPREAD. The stored type never
        // pre-biases reuse because every consumer filters by boundary
        // geometry (getSlotCorrectType / isSlotInRail), and spread-correction
        // accepts both rail and SPREAD stored types on the orphaned path.
        //
        // Only apply during non-assignOnChain paths (loadGrid, recalculateGrid
        // without boundary shift).  When assignOnChain is true, geometry must
        // win: strategy (calculateTargetGrid) and boundary-shift code re-type
        // empty slots by position so they appear in the correct rail's budget
        // and can be activated on the correct side.
        if (!assignOnChain && isEmptyGridSlot(slot, liveSlot)) {
            const parsed = parseSlotIndex(slot?.id);
            const geoType = geometryTypeForSlotIndex(parsed !== null && parsed !== undefined ? parsed : i, boundaryIdx, gapSlots);
            const wantType = geoType || ORDER_TYPES.SPREAD;
            if (slot.type === wantType) return slot;
            return { ...slot, type: wantType };
        }

        const newType = (i <= buyEndIdx) ? ORDER_TYPES.BUY : (i >= sellStartIdx) ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD;
        if (slot.type === newType) return slot;

        // SPREAD GUARD: a slot holding a live on-chain order (state ACTIVE/PARTIAL
        // with an orderId, including ghost PARTIAL size-0 orders) must never be
        // reassigned to SPREAD, even when assignOnChain:true moves it into the gap
        // band. SPREAD+ACTIVE/PARTIAL is an illegal state (validateOrder rejects it
        // as fatal ILLEGAL_SPREAD_STATE), and retyping would orphan the live chain
        // order. Preserve the BUY/SELL rail type; any genuinely misplaced order is
        // cancelled by sync pass-1 type-mismatch handling. Mirrors the load-time
        // GRID-TYPE-CORRECT guard (grid.ts).
        if (newType === ORDER_TYPES.SPREAD && isOrderOnChain(liveSlot)) {
            return { ...slot, type: resolveOnChainRetypeType(slot, i, buyEndIdx, ORDER_TYPES) };
        }

        const canAssign = assignOnChain || !isOrderOnChain(liveSlot);
        if (canAssign) {
            return { ...slot, type: newType };
        }
        return slot;
    });
}

/**
 * Determine if grid is out of spread and by how many steps.
 * Compares current spread against nominal with tolerance.
 * Returns number of excess steps (0 = in-spread).
 *
 * @param {number} currentSpread - Current bid-ask spread percentage
 * @param {number} nominalSpread - Nominal spread percentage
 * @param {number} toleranceSteps - Tolerance in increment steps
 * @param {number} buyCount - Number of active buy orders
 * @param {number} sellCount - Number of active sell orders
 * @param {number} [incrementPercent=0.5] - Grid increment percentage
 * @returns {number} Excess steps (0 if in-spread, >0 if out-of-spread)
 */
function shouldFlagOutOfSpread(currentSpread: any, nominalSpread: any, toleranceSteps: any, buyCount: any, sellCount: any, incrementPercent: any = 0.5) {
    if (buyCount === 0 || sellCount === 0) {
        const step = 1 + (incrementPercent / 100);
        const gap = Math.ceil(Math.log(1 + (nominalSpread / 100)) / Math.log(step));
        return Math.max(1, gap);
    }
    const step = 1 + (incrementPercent / 100);
    const currentSteps = Math.log(1 + (currentSpread / 100)) / Math.log(step);
    const limitSteps = (Math.log(1 + (nominalSpread / 100)) / Math.log(step)) + toleranceSteps;
    if (currentSteps <= limitSteps) return 0;
    return Math.max(1, Math.ceil(currentSteps - limitSteps));
}

// ================================================================================
// SECTION 8: GRID INDEXING
// ================================================================================

/**
 * Build complete index set from grid
 * @param {Map} grid - Order grid
 * @returns {Object} - Index object with state and type indexes
 */
function buildIndexes(grid: any) {
    const indexes = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set(),
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    for (const order of grid.values()) {
        const stateKey = order.state as string;
        const typeKey = order.type as string;
        if ((indexes as any)[stateKey]) (indexes as any)[stateKey].add(order.id);
        if ((indexes as any)[typeKey]) (indexes as any)[typeKey].add(order.id);
    }

    return indexes;
}

/**
 * Validate index consistency (for testing/debugging)
 * @param {Map} grid - Order grid
 * @param {Object} indexes - Index object
 * @returns {Object} - Validation result
 */
function validateIndexes(grid: any, indexes: any) {
    const errors: string[] = [];

    for (const [id, order] of grid.entries()) {
        const stateIndex = (indexes as any)[order.state];
        const typeIndex = (indexes as any)[order.type];

        if (!stateIndex || !stateIndex.has(id)) {
            errors.push(`Order ${id} missing from state index ${order.state}`);
        }
        if (!typeIndex || !typeIndex.has(id)) {
            errors.push(`Order ${id} missing from type index ${order.type}`);
        }
    }

    for (const [key, indexSet] of Object.entries(indexes)) {
        for (const id of (indexSet as any as Set<string>)) {
            if (!grid.has(id)) {
                errors.push(`Orphaned index entry: ${key} has ${id} but not in grid`);
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

// ================================================================================
// SECTION 9: ORDER COMPARISON & DELTA
// ================================================================================

function _getRelativeTolerance(configOverride?: Record<string, any>): number {
    const raw = configOverride?.gridLimits?.RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT
        ?? GRID_LIMITS.RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT;
    return Number(raw) / 100;
}
const ORDER_RELATIVE_TOLERANCE = _getRelativeTolerance();

function getDecimalPlaces(value: any) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;

    const text = numeric.toString().toLowerCase();
    if (!text.includes('e')) {
        const parts = text.split('.');
        return parts[1] ? parts[1].length : 0;
    }

    const [mantissa, exponentRaw] = text.split('e');
    const exponent = Number(exponentRaw);
    const dotIndex = mantissa.indexOf('.');
    const mantissaDecimals = dotIndex >= 0 ? (mantissa.length - dotIndex - 1) : 0;
    return Math.max(0, mantissaDecimals - exponent);
}

function parseOptionalPrecision(value: any) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    return numeric;
}

function precisionToQuantum(precision: any) {
    const p = parseOptionalPrecision(precision);
    if (p === null) return null;
    const quantum = MathUtils.quantumForPrecision(p);
    return quantum > 0 ? quantum : Number.EPSILON;
}

function observedQuantum(a: any, b: any) {
    const maxDecimals = Math.max(getDecimalPlaces(a), getDecimalPlaces(b));
    if (maxDecimals <= 0) return Number.EPSILON;
    const quantum = MathUtils.quantumForPrecision(maxDecimals);
    return quantum > 0 ? quantum : Number.EPSILON;
}

function resolveOrderSizePrecision(orderType: any, precisions: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number } = {}) {
    if (!precisions || typeof precisions !== 'object') return null;

    if (orderType === ORDER_TYPES.BUY) return parseOptionalPrecision(precisions.buyPrecision);
    if (orderType === ORDER_TYPES.SELL) return parseOptionalPrecision(precisions.sellPrecision);

    return parseOptionalPrecision(precisions.defaultPrecision);
}

function resolvePriceTolerance(precisions: { priceRelativeTolerance?: number } = {}, order: any, referenceOrder: any) {
    const leftPrice = Number(order?.price);
    const rightPrice = Number(referenceOrder?.price);
    const relativeToleranceRatio = Number(precisions.priceRelativeTolerance);
    if (!Number.isFinite(relativeToleranceRatio) || relativeToleranceRatio < 0) return 0;

    const scale = Math.max(Math.abs(leftPrice || 0), Math.abs(rightPrice || 0));
    return scale * relativeToleranceRatio;
}

function nearlyEqualAbsolute(a: any, b: any, tolerance: any) {
    const left = Number(a);
    const right = Number(b);

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return left === right;
    }

    if (left === right) return true;

    const tol = Number.isFinite(Number(tolerance)) && Number(tolerance) > 0
        ? Number(tolerance)
        : Number.EPSILON;

    return Math.abs(left - right) <= tol;
}

function nearlyEqualRelative(a: any, b: any, options: { precision?: number } = {}) {
    const left = Number(a);
    const right = Number(b);

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return left === right;
    }

    if (left === right) return true;

    const diff = Math.abs(left - right);
    const scale = Math.max(Math.abs(left), Math.abs(right));
    const configuredPrecisionQuantum = precisionToQuantum(options.precision);
    const minimumTolerance = configuredPrecisionQuantum || observedQuantum(left, right);
    const tolerance = Math.max(scale * ORDER_RELATIVE_TOLERANCE, minimumTolerance);
    return diff <= tolerance;
}

/**
 * Extract order size with fallback
 * @param {Object} order - Order object
 * @returns {number|null} - Size or null if not found
 */
function getOrderSize(order: any): number | null {
    const raw = order?.size;
    if (raw != null && !(typeof raw === 'number' && !Number.isFinite(raw))) {
        return toFiniteNumber(raw);
    }
    return toFiniteNumber(order?.amount);
}

/**
 * Compare two orders for equality
 * @param {Object} a - First order
 * @param {Object} b - Second order
 * @param {Object} [options={}] - Comparison options
 * @param {Object} [options.precisions] - Optional precision hints {buyPrecision, sellPrecision, defaultPrecision, priceRelativeTolerance}
 * @returns {boolean} - True if orders are equivalent
 */
function ordersEqual(a: any, b: any, options: { precisions?: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number; priceRelativeTolerance?: number }; comparePrecisions?: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number; priceRelativeTolerance?: number } } = {}) {
    if (!a || !b) return false;
    if (a === b) return true;

    const precisionHints: { buyPrecision?: number; sellPrecision?: number; defaultPrecision?: number; priceRelativeTolerance?: number } = options.precisions || options.comparePrecisions || {};
    const sizePrecision = resolveOrderSizePrecision(a.type, precisionHints);
    const priceTolerance = resolvePriceTolerance(precisionHints, a, b);

    return a.id === b.id &&
           a.type === b.type &&
           a.state === b.state &&
           nearlyEqualAbsolute(a.price, b.price, priceTolerance) &&
           nearlyEqualRelative(getOrderSize(a), getOrderSize(b), { precision: sizePrecision ?? undefined }) &&
           a.orderId === b.orderId;
}

/**
 * Build delta actions between master and working grid
 * @param {Map} masterGrid - Source of truth grid
 * @param {Map} workingGrid - Modified working copy
 * @param {Object} [options={}] - Delta options forwarded to ordersEqual
 * @returns {Array} - Array of action objects
 */
function buildDelta(masterGrid: any, workingGrid: any, options: any = {}) {
    const actions: any[] = [];

    for (const [id, workingOrder] of workingGrid.entries()) {
        const masterOrder = masterGrid.get(id);

        if (!masterOrder) {
            actions.push({
                type: 'create',
                id,
                order: workingOrder
            });
        } else if (!ordersEqual(workingOrder, masterOrder, options)) {
            actions.push({
                type: 'update',
                id,
                order: workingOrder,
                prevOrder: masterOrder,
                orderId: masterOrder.orderId
            });
        }
    }

    for (const [id, masterOrder] of masterGrid.entries()) {
        if (!workingGrid.has(id)) {
            actions.push({
                type: 'cancel',
                id,
                orderId: masterOrder.orderId
            });
        }
    }

    return actions;
}

// ================================================================================
// SECTION 10: STRATEGY CALCULATIONS
// ================================================================================

/**
 * Check whether a fill is eligible to drive boundary shift / rotation.
 * Partials only count when they are delayed-rotation triggers.
 *
 * @param {Object} fill - Fill event
 * @returns {boolean} True when the fill may shift the boundary
 */
function isShiftEligibleFill(fill: any): boolean {
    return fill?.isPartial !== true || fill?.isDelayedRotationTrigger === true;
}

function deriveTargetBoundary(fills: any, currentBoundaryIdx: any, allSlots: any, config: any, gapSlots: any, crossChunkBudget?: number | null): { boundaryIdx: number; remainingBudget: number } {
    let newBoundaryIdx = currentBoundaryIdx;

    // Initial recovery if boundary is undefined
    if (newBoundaryIdx === undefined || newBoundaryIdx === null) {
         const referencePrice = config.startPrice;
         newBoundaryIdx = calculateIdealBoundary(allSlots, referencePrice, gapSlots);
    }

    // Apply shift from fills with rate-limiting (reserve fills excluded: static insurance).
    let netShift = 0;
    // Reserve ladder: fills from edge-pinned reserve slots never crawl the
    // boundary — they are static fat-finger insurance, not market movement.
    const reserveBuyIds = reserveEdgeIdSet(allSlots, config, ORDER_TYPES.BUY);
    const reserveSellIds = reserveEdgeIdSet(allSlots, config, ORDER_TYPES.SELL);
    for (const fill of fills) {
        if (!isShiftEligibleFill(fill)) continue;
        if (fill && fill.type === ORDER_TYPES.BUY && reserveBuyIds && reserveBuyIds.has(fill.id)) continue;
        if (fill && fill.type === ORDER_TYPES.SELL && reserveSellIds && reserveSellIds.has(fill.id)) continue;
        if (fill.type === ORDER_TYPES.SELL) netShift++;
        else if (fill.type === ORDER_TYPES.BUY) netShift--;
    }

    // Cap cumulative shift to prevent overreaction from burst fills.
    // Uses a cross-chunk budget managed by the caller — each chunk
    // consumes from the same pool so the total across all chunks
    // never exceeds half the active window.
    // Falls back to a per-call cap when no budget is set.
    const fallbackCap = Math.max(
        Math.floor((config.activeOrders?.sell ?? 1) / 2),
        Math.floor((config.activeOrders?.buy ?? 1) / 2),
        1
    );
    const effectiveBudget = crossChunkBudget ?? fallbackCap;
    const cap = Math.min(Math.abs(effectiveBudget), fallbackCap);
    if (Math.abs(netShift) > cap) {
        netShift = Math.sign(netShift) * cap;
    }
    const remainingBudget = effectiveBudget - Math.abs(netShift);

    newBoundaryIdx += netShift;
    // Clamp boundary — cap at one slot before the gap band's SELL rail.
    // Degenerate geometries (fewer slots than the gap needs) fall back to the
    // legacy length-1 ceiling instead of collapsing the boundary below its
    // current position.
    const gapAwareCeiling = allSlots.length - gapSlots - 1;
    const legacyCeiling = allSlots.length - 1;
    const ceiling = gapAwareCeiling >= 0
        ? gapAwareCeiling
        : Math.max(legacyCeiling, Number(currentBoundaryIdx ?? 0));
    return {
        boundaryIdx: Math.max(0, Math.min(ceiling, newBoundaryIdx)),
        remainingBudget,
    };
}

/**
 * Per-side reserve count (edge-pinned fat-finger insurance orders).
 * Buy reserves pin at the grid floor, sell reserves at the grid ceiling.
 * Non-finite/non-integer/negative values disable (0).
 *
 * @param {Object} config - Bot configuration
 * @param {string} side - 'buy' or 'sell'
 * @returns {number} Reserve count for the side (>= 0 integer)
 */
function resolveReserveCount(config: any, side: any) {
    const key = side === 'sell' ? 'sell' : 'buy';
    const raw = Number(config?.reserveOrders?.[key] ?? 0);
    if (!Number.isInteger(raw) || raw < 0) return 0;
    return raw;
}

/**
 * Total reserve count across both sides (fee/count totals).
 *
 * @param {Object} config - Bot configuration
 * @returns {number} Total reserves (buy + sell)
 */
function resolveReserveOrders(config: any) {
    return resolveReserveCount(config, 'buy') + resolveReserveCount(config, 'sell');
}

/**
 * Edge-pinned reserve id set for one side, or null when disabled.
 * Boundary-independent: floor/ceiling by price rank regardless of crawl.
 *
 * @param {Array<Object>} allSlots - All grid slots (need id/price/type)
 * @param {Object} config - Bot configuration
 * @param {string} orderType - ORDER_TYPES.BUY (floor) or SELL (ceiling)
 * @returns {Set<string>|null} Edge slot ids, or null when side disabled
 */
function reserveEdgeIdSet(allSlots: any, config: any, orderType: any): Set<string> | null {
    const side = orderType === ORDER_TYPES.SELL ? 'sell' : 'buy';
    const n = resolveReserveCount(config, side);
    if (n <= 0) return null;
    return orderType === ORDER_TYPES.SELL
        ? resolveReserveCeilIds(allSlots, n)
        : resolveReserveFloorIds(allSlots, n);
}

/**
 * Bottom-N BUY slot ids by price (floor-anchored reserve set).
 * Boundary-independent: the lowest prices are the floor regardless of crawl.
 *
 * @param {Array<Object>} allSlots - All grid slots (need id/price/type)
 * @param {number} reserve - Reserve count
 * @returns {Set<string>} Floor slot ids (empty when reserve <= 0)
 */
function resolveReserveFloorIds(allSlots: any, reserve: any): Set<string> {
    const ids = new Set<string>();
    const n = Math.max(0, Math.floor(Number(reserve) || 0));
    if (n <= 0 || !Array.isArray(allSlots)) return ids;
    const floor = allSlots
        .filter((s: any) => s && s.id != null && s.price != null && s.type === ORDER_TYPES.BUY)
        .sort((a: any, b: any) => Number(a.price) - Number(b.price))
        .slice(0, n);
    for (const s of floor) ids.add(s.id);
    return ids;
}

/**
 * Top-N SELL slot ids by price (ceiling-anchored reserve set).
 * Boundary-independent: the highest prices are the ceiling regardless of crawl.
 *
 * @param {Array<Object>} allSlots - All grid slots (need id/price/type)
 * @param {number} reserve - Reserve count
 * @returns {Set<string>} Ceiling slot ids (empty when reserve <= 0)
 */
function resolveReserveCeilIds(allSlots: any, reserve: any): Set<string> {
    const ids = new Set<string>();
    const n = Math.max(0, Math.floor(Number(reserve) || 0));
    if (n <= 0 || !Array.isArray(allSlots)) return ids;
    const ceil = allSlots
        .filter((s: any) => s && s.id != null && s.price != null && s.type === ORDER_TYPES.SELL)
        .sort((a: any, b: any) => Number(b.price) - Number(a.price))
        .slice(0, n);
    for (const s of ceil) ids.add(s.id);
    return ids;
}

/**
 * Central edge selector: take reserve slots from a price-ascending list,
 * skipping already-windowed ids. floor → first N (buy dip insurance),
 * ceiling → last N (sell spike insurance). Callers pre-filter rail/type and
 * apply their own size gates; this only picks positions.
 *
 * @param {Array<Object>} sortedAsc - Slots sorted by price ascending
 * @param {number} count - Reserve count
 * @param {Set<string>|null} excludeIds - Windowed ids to skip
 * @param {string} edge - 'floor' or 'ceiling'
 * @returns {Array<Object>} Reserve slots (ascending for floor, descending for ceiling)
 */
function selectReserveEdgeSlots(sortedAsc: any, count: any, excludeIds: any, edge: any): any[] {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n <= 0 || !Array.isArray(sortedAsc)) return [];
    const avail = sortedAsc.filter((s: any) => s && s.id != null && (!excludeIds || !excludeIds.has(s.id)));
    if (edge === 'ceiling') return avail.slice(-n).reverse();
    return avail.slice(0, n);
}

/**
 * Total target order count across both sides (used for BTS fee calculation).
 * Single source of truth so every budget derivation sizes identically.
 * Includes per-side reserves: they rest live on-chain and pay creation fees.
 *
 * @param {Object} config - Bot configuration
 * @returns {number} Total target order count
 */
function getActiveOrdersTotal(config: any) {
    return Math.max(0, config?.activeOrders?.buy ?? 1) +
        Math.max(0, config?.activeOrders?.sell ?? 1) +
        resolveReserveOrders(config);
}
/**
 * Calculate side budget after BTS fee deduction.
 *
 * @param {string} side - 'buy' or 'sell'
 * @param {Object} funds - Snapshot of allocated funds
 * @param {Object} config - Bot configuration
 * @param {number} totalTarget - Total target order count (used for BTS fee calculation on both sides)
 * @returns {number} Available budget for the side
 */
function getSideBudget(side: any, funds: any, config: any, totalTarget: any) {
    const isBuy = side === 'buy';
    const allocated = isBuy ? (funds.allocatedBuy || 0) : (funds.allocatedSell || 0);
    if (allocated <= 0) return 0;

    const btsOrderType = MathUtils.getBtsSide(config?.assetA, config?.assetB);
    const isBtsSide = isBuy ? (btsOrderType === ORDER_TYPES.BUY) : (btsOrderType === ORDER_TYPES.SELL);

    // Non-BTS side without btsBalance data: no fee adjustment to make.
    if (!isBtsSide && !funds.btsBalance) return allocated;

    const btsReservationMultiplier = config?.feeParams?.BTS_RESERVATION_MULTIPLIER ?? FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER;
    const formulaBudget = MathUtils.calculateOrderCreationFees(
        config.assetA, config.assetB, totalTarget,
        btsReservationMultiplier
    );

    if (isBtsSide) {
        return MathUtils.adjustBudgetForBtsFees(allocated, true, formulaBudget, 0, 0, 0, 0);
    }

    return MathUtils.adjustBudgetForBtsFees(
        allocated,
        false,
        formulaBudget,
        config.min_BTS_value || 0,
        funds.btsBalance?.free || 0,
        isBuy ? (funds.allocatedBuy || funds.chainFreeBuy || 0) : (funds.allocatedSell || funds.chainFreeSell || 0),
        (funds.allocatedBuy || funds.chainFreeBuy || 0) + (funds.allocatedSell || funds.chainFreeSell || 0),
    );
}

/**
 * Calculate sizes for all slots on a side using weighted distribution.
 *
 * @param {Array} slots - Array of slots for the side
 * @param {string} side - 'buy' or 'sell'
 * @param {number} budget - Total budget for the side
 * @param {number} weightDist - Weight distribution factor
 * @param {number} incrementPercent - Grid increment percentage
 * @param {Object} assets - Asset metadata for precision
 * @returns {Array} Array of calculated sizes
 */
function calculateBudgetedSizes(slots: any, side: any, budget: any, weightDist: any, incrementPercent: any, assets: any) {
    const isBuy = side === 'buy';

    let precision;
    if (assets?.assetA && assets?.assetB) {
        try {
            const { A: precA, B: precB } = MathUtils.getPrecisionsForManager(assets);
            precision = isBuy ? precB : precA;
        } catch (e: any) {
            // Precision not available — floatToBlockchainInt will throw
        }
    }

    const incrementFactor = incrementPercent / 100;

    return MathUtils.allocateFundsByWeights(
        budget,
        slots.length,
        weightDist,
        incrementFactor,
        isBuy, // Reverse for BUY (Market-Close is last in array)
        0,
        precision
    );
}

// ================================================================================
// SECTION: COW batch-shared pure helpers (moved from dexbot_cow_runtime.ts —
// no bot dependency; shared by the COW runtime and any future consumer).
// ================================================================================

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
 * PRE-BROADCAST CROSSED-BOOK ASSERT (defense-in-depth, any-writer detection).
 *
 * Simulates the post-batch book: currently placed master orders plus this
 * batch's action overlay (CREATEs add, CANCELs remove, UPDATEs reprice/move).
 * Returns a detail string when a planned BUY would price at-or-above a planned
 * SELL — a state no honest planner produces — so the caller can refuse the
 * broadcast instead of paying for adverse fills.  Placed order prices are
 * independent of grid geometry, so this catches boundary overruns regardless
 * of which writer produced them.
 *
 * Detector only: any internal failure returns null (never blocks a broadcast).
 */
function detectCrossedBookPlan(manager: any, actions: any[]): string | null {
    try {
        const startPrice = Number(manager?.config?.startPrice);
        const book = new Map<string, { type: string; price: number }>();
        for (const o of Array.from(manager?.orders?.values?.() ?? []) as any[]) {
            if (!o || !o.orderId || o.price == null) continue;
            const price = Number(o.price);
            if (!Number.isFinite(price)) continue;
            let type = o.type;
            if (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL) {
                // Legacy SPREAD-typed placed order: derive side from the same
                // price-vs-startPrice convention used across the codebase.
                if (!Number.isFinite(startPrice)) continue;
                type = price < startPrice ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
            }
            book.set(String(o.id), { type, price });
        }
        for (const a of actions ?? []) {
            const id = String(a.id ?? a.orderId ?? '');
            if (a.type === COW_ACTIONS.CANCEL) {
                if (id) book.delete(id);
            } else if (a.type === COW_ACTIONS.UPDATE) {
                const newPrice = Number(a.newPrice ?? a.order?.price);
                const newType = a.order?.type;
                if (id && Number.isFinite(newPrice)) {
                    const entry = book.get(id);
                    const type = (newType === ORDER_TYPES.BUY || newType === ORDER_TYPES.SELL)
                        ? newType
                        : entry?.type;
                    if (entry) book.delete(id);
                    const key = String(a.newGridId ?? id);
                    if (type === ORDER_TYPES.BUY || type === ORDER_TYPES.SELL) {
                        book.set(key, { type, price: newPrice });
                    }
                }
            } else if (a.type === COW_ACTIONS.CREATE) {
                const price = Number(a.order?.price);
                const type = a.order?.type;
                if (!Number.isFinite(price) || (type !== ORDER_TYPES.BUY && type !== ORDER_TYPES.SELL)) continue;
                if (id) book.set(id, { type, price });
            }
        }
        let maxBuy = -Infinity;
        let minSell = Infinity;
        for (const { type, price } of book.values()) {
            if (type === ORDER_TYPES.BUY && price > maxBuy) maxBuy = price;
            else if (type === ORDER_TYPES.SELL && price < minSell) minSell = price;
        }
        if (Number.isFinite(maxBuy) && Number.isFinite(minSell) && minSell <= maxBuy) {
            return `bestPlacedBuy=${maxBuy} >= bestPlacedSell=${minSell}`;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Collect every on-chain order id master currently needs to converge against,
 * so adoption can re-read them by id (immune to the get_full_accounts window
 * truncation) instead of relying on a partial window read.
 *
 * Sources:
 *  - master's own tracked order ids (existing on-chain orders);
 *  - the batch's fresh CREATE ids extracted from the broadcast result
 *    (operation_results[i][1] aligns positionally with placedContexts[i]).
 *
 * @param {any} mgr - bot.manager
 * @param {any} placedResults - broadcast result (has operation_results); null when unavailable
 * @param {any[]} placedContexts - opContexts (aligned with operation_results); null when unavailable
 * @param {string[]|null} [extraCreateIds=null] - fresh CREATE chain ids from another
 *   authoritative source (e.g. the uncertain-broadcast poll confirmation) when
 *   no broadcast result exists; merged into createIds so the lagging-create
 *   retry guards them
 * @returns {string[]} Unique, well-formed 1.7.x order ids
 */
function collectKnownOnChainOrderIds(mgr: any, placedResults: any, placedContexts: any, extraCreateIds: any = null): { masterIds: string[]; createIds: string[]; all: string[] } {
    const masterIds = new Set<string>();
    const grid = mgr && mgr.grid;
    if (Array.isArray(grid)) {
        for (const slot of grid) {
            if (slot && slot.orderId && /^1\.7\.\d+$/.test(String(slot.orderId))) {
                masterIds.add(String(slot.orderId));
            }
        }
    }
    // Master tracked ids live in the orders Map (mgr.grid is legacy and
    // unset on OrderManager — without this the by-id set omits every
    // pre-existing ACTIVE order and pass-1 phantom cleanup would virtualize
    // them as fills on a partial snapshot).
    if (mgr && mgr.orders instanceof Map) {
        for (const slot of mgr.orders.values()) {
            if (slot && (slot as any).orderId && /^1\.7\.\d+$/.test(String((slot as any).orderId))) {
                masterIds.add(String((slot as any).orderId));
            }
        }
    }
    const createIds = new Set<string>();
    if (placedResults && Array.isArray(placedContexts)) {
        const opResults = extractBatchOperationResults(placedResults);
        if (Array.isArray(opResults)) {
            for (let i = 0; i < placedContexts.length; i++) {
                const ctx = placedContexts[i];
                if (!ctx || ctx.kind !== 'create') continue;
                const opResult = opResults[i] && opResults[i][1];
                if (opResult && /^1\.7\.\d+$/.test(String(opResult))) {
                    createIds.add(String(opResult));
                }
            }
        }
    }
    if (Array.isArray(extraCreateIds)) {
        for (const id of extraCreateIds) {
            if (id && /^1\.7\.\d+$/.test(String(id))) createIds.add(String(id));
        }
    }
    // Existing chain ids referenced by non-create op contexts (cancel /
    // rotation / size-update) are already live: they belong to the master set
    // (cancels/fills in this batch), so they join the by-id set but never
    // the lagging-create guard.
    if (Array.isArray(placedContexts)) {
        for (const ctx of placedContexts) {
            if (!ctx || ctx.kind === 'create') continue;
            const refs: any[] = [];
            if (ctx.kind === 'cancel' && ctx.order) refs.push(ctx.order.orderId);
            else if (ctx.kind === 'rotation' && ctx.rotation?.oldOrder) refs.push(ctx.rotation.oldOrder.orderId);
            else if (ctx.kind === 'size-update' && ctx.updateInfo?.partialOrder) refs.push(ctx.updateInfo.partialOrder.orderId);
            for (const id of refs) {
                if (id && /^1\.7\.\d+$/.test(String(id))) masterIds.add(String(id));
            }
        }
    }
    const all = new Set<string>([...masterIds, ...createIds]);
    return { masterIds: [...masterIds], createIds: [...createIds], all: [...all] };
}

export { parseChainOrder, findMatchingGridOrderByOpenOrder, applyChainSizeToGridOrder, buildFillKey, correctOrderPriceOnChain, correctAllPriceMismatches, buildCreateOrderArgs, getOrderTypeFromUpdatedFlags, resolveConfiguredPriceBound, virtualizeOrder, convertToSpreadPlaceholder, toRailHolePlaceholder, geometryTypeForSlotIndex, detectGapEvacuationCandidates, updateGapEvacuationStreaks, resolveSpreadOrderSide, chainOrderMatchesSlot, chainOrderMatchesSlotWithTolerance, crossingCandidateChainId, isCrossingCheckCandidate, buildCrossingCheckCandidates, parseSlotIndex, filterOrdersByType, buildOutsideInPairGroups, extractBatchOperationResults, formatUnmatchedChainOrder, isOrderOnChain, isOrderVirtual, hasOnChainId, isOrderPlaced, isPhantomOrder, isSlotAvailable, isEmptyGridSlot, isOrderHealthy, checkSizeThreshold, checkSizesBeforeMinimum, calculateIdealBoundary, assignGridRoles, resolveOnChainRetypeType, shouldFlagOutOfSpread, buildIndexes, validateIndexes, ordersEqual, buildDelta, getOrderSize, deriveTargetBoundary, isShiftEligibleFill, resolveReserveCount, resolveReserveOrders, resolveReserveFloorIds, resolveReserveCeilIds, selectReserveEdgeSlots, getActiveOrdersTotal, getSideBudget, calculateBudgetedSizes, buildCreateOpFingerprint, isOrderGoneErrorMessage, recordDuplicateOrphanDetection, clearDuplicateOrphanDetection, duplicateOrphanLogInfo, chainOrderUnchangedFromCache, detectCrossedBookPlan, collectKnownOnChainOrderIds }

