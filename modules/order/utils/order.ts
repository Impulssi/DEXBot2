/**
 * modules/order/utils/order.ts - Order Domain Utilities
 *
 * Business rules for orders, state predicates, filtering, and reconciliation.
 * Includes grid indexing, order comparison, delta building, and strategy calculations.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (36 exported functions)
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
 * SECTION 7: GRID BOUNDARY & ROLES (4 functions)
 *   - calculateIdealBoundary(allSlots, startPrice, gapSlots) - Calculate ideal boundary
 *   - calculateFundDrivenBoundary(allSlots, availA, availB, startPrice, gapSlots) - Fund-driven boundary
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
 * SECTION 10: STRATEGY CALCULATIONS (3 functions)
 *   - deriveTargetBoundary(fills, currentBoundaryIdx, allSlots, config, gapSlots, crossChunkBudget, burstTarget) - Derive boundary from fills (returns { boundaryIdx, remainingBudget })
 *   - computePriceAnchoredBoundaryTarget(fills, allSlots, gapSlots) - Price-anchored burst boundary target (or null when no fill price resolvable)
 *   - getSideBudget(side, funds, config, totalTarget) - Calculate side budget after fees
 *   - calculateBudgetedSizes(slots, side, budget, weightDist, incrementPercent, assets) - Calculate budgeted sizes
 *
 * ===============================================================================
 */


import { ORDER_TYPES, ORDER_STATES, TIMING, FEE_PARAMETERS, GRID_LIMITS, NATIVE_CLIENT, ANCHOR } from '../../constants.js';
import * as Format from '../format.js';
import * as MathUtils from './math.js';
import Logger from '../../order/logger.js';
import { sleep } from './system.js';
import { getErrorMessage } from '../../utils/errors.js';
const { isValidNumber, toFiniteNumber } = Format;
const { blockchainToFloat, floatToBlockchainInt, quantizeFloat, calculatePriceTolerance } = MathUtils;
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
 * Correct all pending price mismatches atomically.
 * Processes corrections sequentially with sync delays between operations.
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

        for (const correctionInfo of ordersToCorrect) {
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
    const { btsFeeState, ...rest } = order;
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
 * Parse a grid slot id ("slot-123") to its rail index. Slot ids are assigned
 * in ascending price order at grid generation (grid.ts), so the index is
 * strictly price-monotonic and can be compared exactly where float prices
 * would risk rounding ambiguity (adjacent levels can round to the same
 * price). Returns null when the id is not a grid slot id (e.g. orphan fills
 * with chain-derived ids) so callers can fall back to price comparison.
 * @param {any} id - grid slot id string
 * @returns {number|null}
 */
function parseSlotIndex(id: any): number | null {
    if (typeof id !== 'string') return null;
    const match = /^slot-(\d+)$/.exec(id);
    if (!match) return null;
    const idx = parseInt(match[1], 10);
    return Number.isFinite(idx) ? idx : null;
}
/**
 * Whether a parsed chain order matches a grid slot within tolerance:
 * type-compatible (slot may be SPREAD), price within tolerance, size within
 * 1% quantum tolerance (floor 2 units). Shared by the startup adoption paths
 * that match an uncertain-landed chain order to the slot it was created for.
 * @param {Object} parsed - parseChainOrder output ({type, price, size, ...})
 * @param {Object} slot - Grid slot order object
 * @param {Object} assets - Manager assets ({assetA, assetB} with precision)
 * @returns {boolean}
 */
function chainOrderMatchesSlot(parsed: any, slot: any, assets: any): boolean {
    if (!parsed || !slot || !assets) return false;
    if (parsed.type !== slot.type && slot.type !== ORDER_TYPES.SPREAD) return false;
    const priceTolerance = calculatePriceTolerance(slot.price, slot.size, parsed.type, assets) || 0;
    if (Math.abs(parsed.price - slot.price) > priceTolerance) return false;
    const precision = parsed.type === ORDER_TYPES.SELL ? assets.assetA.precision : assets.assetB.precision;
    const sizeTolerance = Math.max(2, Math.floor(floatToBlockchainInt(slot.size, precision) * 0.01));
    if (Math.abs(floatToBlockchainInt(parsed.size, precision) - floatToBlockchainInt(slot.size, precision)) > sizeTolerance) return false;
    return true;
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
 * Calculate grid boundary based on available funds ratio.
 * Distributes buy/sell slots proportional to fund values.
 * 
 * @param {Array<Object>} allSlots - All grid slots sorted by price
 * @param {number} availA - Available assetA (sell-side capital)
 * @param {number} availB - Available assetB (buy-side capital)
 * @param {number} price - Current reference price for valuation
 * @param {number} gapSlots - Number of gap slots between buy and sell
 * @returns {number} Fund-driven boundary index
 */
function calculateFundDrivenBoundary(allSlots: any, availA: any, availB: any, price: any, gapSlots: any) {
    const valA = toFiniteNumber(availA) * toFiniteNumber(price);
    const valB = toFiniteNumber(availB);
    const totalVal = valA + valB;
    if (totalVal <= 0) return Math.floor((allSlots.length - gapSlots) / 2);
    const targetBuySlots = Math.round((allSlots.length - gapSlots) * (valB / totalVal));
    return Math.max(0, Math.min(allSlots.length - gapSlots - 1, targetBuySlots - 1));
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

        // Empty VIRTUAL slots (size 0, no orderId) are side-neutral SPREAD
        // during grid load — a stale BUY/SELL type on an empty slot misleads
        // candidate-selection code that picks by stored type.  Force SPREAD
        // so the stored type never pre-biases which side reuses the slot.
        //
        // Only apply during non-assignOnChain paths (loadGrid, recalculateGrid
        // without boundary shift).  When assignOnChain is true, geometry must
        // win: strategy (calculateTargetGrid) and boundary-shift code re-type
        // empty slots by position so they appear in the correct rail's budget
        // and can be activated on the correct side.
        if (!assignOnChain && isEmptyGridSlot(slot, liveSlot)) {
            if (slot.type === ORDER_TYPES.SPREAD) return slot;
            return { ...slot, type: ORDER_TYPES.SPREAD };
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
    if (fill?.skipBoundaryShift === true) return false;
    return fill?.isPartial !== true || fill?.isDelayedRotationTrigger === true;
}

/**
 * Resolve the grid price of a fill. Prefers the fill's own price, falls back
 * to the slot price looked up by id in the provided slot map.
 *
 * @param {Object} fill - Fill event
 * @param {Map|null} slotById - Slot id -> slot map (may be null)
 * @returns {number|null} Fill price or null when unavailable
 */
function resolveFillPrice(fill: any, slotById: Map<any, any> | null): number | null {
    const direct = toFiniteNumber(fill?.price);
    if (direct != null && direct > 0) return direct;
    const slot = slotById ? slotById.get(fill?.id) : null;
    const slotPrice = toFiniteNumber(slot?.price);
    return slotPrice != null && slotPrice > 0 ? slotPrice : null;
}

/**
 * Compute a price-anchored boundary CORRECTION bound from a burst of fills.
 *
 * The count-based crawl shifts one slot per fill; its two failure modes are
 * (a) interleaved BUY+SELL fills cancelling out while price swept several
 * slots, and (b) the shift cap starving later burst chunks. The correction
 * bound repairs both without disturbing the single-fill crawl semantics:
 *
 * - Trailing SELL (price swept UP, latest fill approximates the market):
 *   every filled sell slot must end up BELOW the sell rail, i.e. the sell
 *   rail start (boundary + gapSlots + 1) must exceed the highest filled
 *   sell slot index -> boundary >= maxSellFillIdx - gapSlots.
 * - Trailing BUY (price swept DOWN): slots above the lowest filled buy slot
 *   must be sell-side, i.e. sell rail start <= lowestFilledBuyIdx + 1
 *   -> boundary <= minBuyFillIdx - gapSlots.
 *
 * The direction is chosen by the LAST eligible fill (fills arrive in
 * history order); the other side's bound is ignored so a mixed burst
 * corrects toward its dominant trailing direction instead of oscillating.
 *
 * @param {Array} fills - Fill events (whole burst, not per-chunk), in
 *   history order
 * @param {Array} allSlots - All grid slots sorted by price
 * @param {number} gapSlots - Number of spread gap slots
 * @returns {{direction: string, boundIdx: number}|null} Correction bound,
 *   or null when no fill price is resolvable (caller keeps the pure
 *   count-based shift)
 */
function computePriceAnchoredBoundaryTarget(fills: any, allSlots: any, gapSlots: any): { direction: string; boundIdx: number } | null {
    if (!Array.isArray(fills) || fills.length === 0) return null;
    if (!Array.isArray(allSlots) || allSlots.length === 0) return null;

    const slotById = new Map(allSlots.map((s: any) => [s?.id, s]));
    let maxPrice: number | null = null;
    let minPrice: number | null = null;
    let trailingType: string | null = null;
    for (const fill of fills) {
        if (!isShiftEligibleFill(fill)) continue;
        const price = resolveFillPrice(fill, slotById);
        if (price == null) continue;
        if (maxPrice == null || price > maxPrice) maxPrice = price;
        if (minPrice == null || price < minPrice) minPrice = price;
        if (fill.type === ORDER_TYPES.SELL || fill.type === ORDER_TYPES.BUY) {
            trailingType = fill.type;
        }
    }
    if (maxPrice == null || minPrice == null || trailingType == null) return null;

    if (trailingType === ORDER_TYPES.SELL) {
        // splitIdx = first slot at/above the highest fill price = that
        // slot's own index on an exact price match.
        const splitIdx = allSlots.findIndex((s: any) => s.price >= maxPrice);
        if (splitIdx < 0) return null;
        return { direction: 'up', boundIdx: splitIdx - Math.floor(gapSlots) };
    }
    const splitIdxLow = allSlots.findIndex((s: any) => s.price >= minPrice);
    if (splitIdxLow < 0) return null;
    return { direction: 'down', boundIdx: splitIdxLow - Math.floor(gapSlots) };
}

/**
 * Determine new boundary based on fills and current state.
 *
 * Base shift is the count-based crawl (one slot per eligible fill,
 * rate-limited by the cross-chunk budget). When fill prices are resolvable,
 * a price-anchored correction then pulls the boundary to the traded range
 * (see computePriceAnchoredBoundaryTarget) so burst fills that the count
 * crawl cancelled out or capped away still move the boundary with price.
 * Without resolvable prices the conservative half-window cap retains
 * burst-storm protection.
 *
 * @param {Array} fills - Recent fill events
 * @param {number|null} currentBoundaryIdx - Current boundary index
 * @param {Array} allSlots - All grid slots sorted by price
 * @param {Object} config - Bot configuration
 * @param {number} gapSlots - Number of spread gap slots
 * @param {number|null} crossChunkBudget - Remaining cross-chunk shift budget
 *   managed by the caller (consumed by |applied shift|)
 * @param {Object|null} burstAnchor - Pre-computed price-anchored correction
 *   bound for the WHOLE burst (computed before chunking); takes precedence
 *   over per-call price derivation
 * @returns {{boundaryIdx: number, remainingBudget: number}} New boundary index and remaining budget
 */
function deriveTargetBoundary(fills: any, currentBoundaryIdx: any, allSlots: any, config: any, gapSlots: any, crossChunkBudget?: number | null, burstAnchor?: { direction: string; boundIdx: number } | null): { boundaryIdx: number; remainingBudget: number } {
    let newBoundaryIdx = currentBoundaryIdx;

    // Initial recovery if boundary is undefined
    if (newBoundaryIdx === undefined || newBoundaryIdx === null) {
         const referencePrice = config.startPrice;
         newBoundaryIdx = calculateIdealBoundary(allSlots, referencePrice, gapSlots);
    }

    // Full per-side window bounds the price-anchored correction; the
    // half-window cap governs the count-based base shift.
    const windowCap = Math.max(
        Math.floor(config.activeOrders?.sell ?? 1),
        Math.floor(config.activeOrders?.buy ?? 1),
        1
    );
    const fallbackCap = Math.max(
        Math.floor((config.activeOrders?.sell ?? 1) / 2),
        Math.floor((config.activeOrders?.buy ?? 1) / 2),
        1
    );

    const anchor = burstAnchor !== undefined
        ? burstAnchor
        : computePriceAnchoredBoundaryTarget(fills, allSlots, gapSlots);
    const effectiveBudget = crossChunkBudget ?? (anchor != null ? windowCap : fallbackCap);

    // 1. Base shift: count-based crawl, rate-limited by the budget and the
    //    half-window cap.
    let netShift = 0;
    for (const fill of fills) {
        if (!isShiftEligibleFill(fill)) continue;
        if (fill.type === ORDER_TYPES.SELL) netShift++;
        else if (fill.type === ORDER_TYPES.BUY) netShift--;
    }
    const baseCap = Math.min(Math.abs(effectiveBudget), fallbackCap);
    if (Math.abs(netShift) > baseCap) {
        netShift = Math.sign(netShift) * baseCap;
    }
    newBoundaryIdx += netShift;

    // 2. Price-anchored correction toward the traded range, bounded by the
    //    remaining budget (total applied shift never exceeds the budget).
    let applied = Math.abs(netShift);
    if (anchor != null && Number.isFinite(Number(anchor.boundIdx))) {
        const bound = Number(anchor.boundIdx);
        const room = Math.max(0, Math.abs(effectiveBudget) - applied);
        if (anchor.direction === 'up' && newBoundaryIdx < bound) {
            const step = Math.min(bound - newBoundaryIdx, room);
            newBoundaryIdx += step;
            applied += step;
        } else if (anchor.direction === 'down' && newBoundaryIdx > bound) {
            const step = Math.min(newBoundaryIdx - bound, room);
            newBoundaryIdx -= step;
            applied += step;
        }
    }

    const remainingBudget = effectiveBudget - applied;

    // Clamp boundary — cap at one slot before the gap band's SELL rail,
    // matching calculateFundDrivenBoundary's geometry. Degenerate geometries
    // (fewer slots than the gap needs) fall back to the legacy length-1
    // ceiling instead of collapsing the boundary below its current position.
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
 * Total target order count across both sides (used for BTS fee calculation).
 * Single source of truth so every budget derivation sizes identically.
 *
 * @param {Object} config - Bot configuration
 * @returns {number} Total target order count
 */
function getActiveOrdersTotal(config: any) {
    return Math.max(0, config?.activeOrders?.buy ?? 1) +
        Math.max(0, config?.activeOrders?.sell ?? 1);
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
// SECTION 11: MARKET ANCHOR (Price-First Alignment)
// ================================================================================

/**
 * Create an empty MarketAnchor.
 * @returns {Object} Empty anchor with null fields
 */
function createEmptyMarketAnchor() {
    return {
        lastFillPrice: null,
        maxFilledSellPrice: null,
        minFilledBuyPrice: null,
        lastFillSide: null,
        updatedAt: null,
        lastBlockNum: null,
        fillCount: 0,
        // dedupe set for idempotent re-delivery (buildFillKey strings)
        _seenKeys: new Set(),
    };
}

/**
 * Whether the anchor has any price data.
 * @param {Object|null} anchor
 * @returns {boolean}
 */
function isMarketAnchorAvailable(anchor: any): boolean {
    if (!anchor) return false;
    return anchor.lastFillPrice != null || anchor.maxFilledSellPrice != null || anchor.minFilledBuyPrice != null;
}

/**
 * Check if the anchor is fresh per the ANCHOR_FRESHNESS rule.
 * Fresh for FRESHNESS_MS OR until price drifts > PRICE_MOVE_INCREMENTS beyond
 * the anchor's range.
 * @param {Object|null} anchor
 * @param {number|null} currentPrice - Current market price (e.g. startPrice or AMA center)
 * @param {number|null} incrementPercent - Grid increment percent
 * @returns {boolean}
 */
function isMarketAnchorFresh(anchor: any, currentPrice: any = null, incrementPercent: any = null): boolean {
    if (!anchor || anchor.updatedAt == null) return false;
    const age = Date.now() - anchor.updatedAt;
    if (age > ANCHOR.FRESHNESS_MS) return false;
    // Price-driven early expiration: if currentPrice moved >N increments beyond anchor range, stale even within time window
    if (currentPrice != null && incrementPercent != null && Number.isFinite(currentPrice) && Number.isFinite(incrementPercent) && incrementPercent > 0) {
        const factor = Math.pow(1 + incrementPercent / 100, ANCHOR.PRICE_MOVE_INCREMENTS);
        const low = anchor.minFilledBuyPrice;
        const high = anchor.maxFilledSellPrice;
        if (low != null && high != null) {
            const lowerBound = low / factor;
            const upperBound = high * factor;
            if (currentPrice < lowerBound || currentPrice > upperBound) return false;
        } else if (high != null) {
            const upperBound = high * factor;
            if (currentPrice > upperBound) return false;
        } else if (low != null) {
            const lowerBound = low / factor;
            if (currentPrice < lowerBound) return false;
        }
    }
    return true;
}

/**
 * Seed anchor from live on-chain book orders.
 * Derives initial range from highest live buy and lowest live sell.
 * @param {Array} chainOrders - Array of parsed/live orders ({price, type})
 * @returns {Object|null} Seeded anchor or null if book empty
 */
function seedMarketAnchorFromBook(chainOrders: any): any | null {
    if (!Array.isArray(chainOrders) || chainOrders.length === 0) return null;
    let highestBuy: number | null = null;
    let lowestSell: number | null = null;
    for (const o of chainOrders) {
        if (!o || o.price == null || !Number.isFinite(Number(o.price))) continue;
        const price = Number(o.price);
        if (o.type === ORDER_TYPES.BUY) {
            if (highestBuy == null || price > highestBuy) highestBuy = price;
        } else if (o.type === ORDER_TYPES.SELL) {
            if (lowestSell == null || price < lowestSell) lowestSell = price;
        }
    }
    if (highestBuy == null && lowestSell == null) return null;
    return {
        lastFillPrice: null,
        maxFilledSellPrice: lowestSell,
        minFilledBuyPrice: highestBuy,
        lastFillSide: null,
        updatedAt: Date.now(),
        lastBlockNum: null,
        fillCount: 0,
        _seenKeys: new Set(),
    };
}

/**
 * Update anchor with a batch of fills.
 * - Filters to shift-eligible fills only (isShiftEligibleFill)
 * - Resolves price via resolveFillPrice (fill.price or slotId lookup)
 * - Applies in block_num order (D4) when available
 * - Idempotent under re-delivery via buildFillKey + _seenKeys
 * - For replay windows (isReplay=true), only the latest fill (max block_num) contributes to the range (prevents 200-fill backfill slamming).
 * @param {Object|null} anchor - Current anchor (mutated in place, or created)
 * @param {Array} fills - Fill events
 * @param {Map|null} slotById - Slot id -> slot map for price lookup
 * @param {Object} opts
 * @param {boolean} [opts.isReplay=false] - Whether this is a history replay window
 * @param {Set<string>} [opts.seenKeys] - Optional external dedupe set (falls back to anchor._seenKeys)
 * @returns {Object} Updated anchor
 */
function updateMarketAnchorFromFills(anchor: any, fills: any, slotById: Map<any, any> | null, opts: { isReplay?: boolean } = {}): any {
    if (!Array.isArray(fills) || fills.length === 0) return anchor;
    const target = anchor || createEmptyMarketAnchor();
    if (!target._seenKeys) target._seenKeys = new Set();
    const isReplay = opts.isReplay === true;

    // Block ordering (D4): sort by block_num when available; ties and fills
    // without a block_num keep the input (history) order. Never fall back to
    // id-string comparison — that scrambles chronological order for fills
    // without a block_num.
    // Infinity sentinel: missing block_num sorts last (after all known blocks)
    // instead of front-loading at 0. This mirrors the fill runtime, which
    // processes no-block fills after all block-sorted fills, and keeps the
    // comparator transitive — a null sentinel compared by input order against
    // present blocks is not (cycles scramble TimSort output for mixed batches).
    const orderIdx = new Map(fills.map((f: any, i: number) => [f, i]));
    const sorted = [...fills].sort((a: any, b: any) => {
        const aBlock = a?.block_num ?? a?.blockNum ?? Infinity;
        const bBlock = b?.block_num ?? b?.blockNum ?? Infinity;
        if (aBlock !== bBlock) return aBlock - bBlock;
        return (orderIdx.get(a) ?? 0) - (orderIdx.get(b) ?? 0);
    });

    // Replay cap: a history-backfill window never contributes more than
    // ANCHOR.REPLAY_MAX_FILLS (default 1) fills to the anchor range — the
    // latest eligible fills only. Prevents a 200-fill backfill slamming the
    // range wide.
    let replayFills = sorted;
    if (isReplay) {
        const cap = Math.max(1, Math.floor(Number(ANCHOR.REPLAY_MAX_FILLS) || 1));
        const picked: any[] = [];
        for (let i = sorted.length - 1; i >= 0 && picked.length < cap; i--) {
            if (!isShiftEligibleFill(sorted[i])) continue;
            if (resolveFillPrice(sorted[i], slotById) == null) continue;
            picked.push(sorted[i]);
        }
        replayFills = picked.reverse();
    }

    for (const fill of replayFills) {
        if (!isShiftEligibleFill(fill)) continue;
        const fillKey = buildFillKey(fill);
        if (fillKey && target._seenKeys.has(fillKey)) continue;
        const price = resolveFillPrice(fill, slotById);
        if (price == null) continue;
        if (fillKey) target._seenKeys.add(fillKey);
        target.lastFillPrice = price;
        target.lastFillSide = fill.type === ORDER_TYPES.SELL || fill.type === ORDER_TYPES.BUY ? fill.type : target.lastFillSide;
        target.updatedAt = Date.now();
        const blockNum = fill?.block_num ?? fill?.blockNum ?? null;
        if (blockNum != null) target.lastBlockNum = blockNum;
        target.fillCount = (target.fillCount || 0) + 1;
        if (fill.type === ORDER_TYPES.SELL) {
            if (target.maxFilledSellPrice == null || price > target.maxFilledSellPrice) target.maxFilledSellPrice = price;
        } else if (fill.type === ORDER_TYPES.BUY) {
            if (target.minFilledBuyPrice == null || price < target.minFilledBuyPrice) target.minFilledBuyPrice = price;
        }
    }
    // Prune _seenKeys growth (keep last 1000)
    if (target._seenKeys.size > 1000) {
        const arr = Array.from(target._seenKeys);
        target._seenKeys = new Set(arr.slice(-1000));
    }
    return target;
}

/**
 * Project the MarketAnchor to a boundary index.
 * Pure function, no side effects, reuses existing geometry helpers only.
 * Generalized from computePriceAnchoredBoundaryTarget: gap band centered on
 * the traded range, both directions, plus the I4 ceiling clamp.
 * @param {Object|null} anchor - MarketAnchor
 * @param {Array} allSlots - All grid slots sorted by price
 * @param {number} gapSlots - Gap slot count
 * @returns {number|null} Projected boundary index or null if anchor insufficient
 */
function projectAnchorToGrid(anchor: any, allSlots: any, gapSlots: any): number | null {
    if (!anchor || !Array.isArray(allSlots) || allSlots.length === 0) return null;
    const maxSell = anchor.maxFilledSellPrice;
    const minBuy = anchor.minFilledBuyPrice;
    const lastPrice = anchor.lastFillPrice;
    const lastSide = anchor.lastFillSide;

    // Need at least one price to project
    if (maxSell == null && minBuy == null && lastPrice == null) return null;

    const floorGap = Math.floor(Number(gapSlots) || 0);
    const gapAwareCeiling = allSlots.length - floorGap - 1;
    const legacyCeiling = allSlots.length - 1;
    const ceiling = gapAwareCeiling >= 0 ? gapAwareCeiling : legacyCeiling;

    const findSplitIdx = (price: number): number => {
        const idx = allSlots.findIndex((s: any) => s.price >= price);
        return idx < 0 ? allSlots.length : idx;
    };

    let candidate: number | null = null;

    if (maxSell != null && minBuy != null) {
        const upBound = findSplitIdx(maxSell) - floorGap;
        const downBound = findSplitIdx(minBuy) - floorGap;
        // Feasible interval [upBound, downBound] where gap covers both extremes.
        // Reuses the same floorGap convention as computePriceAnchoredBoundaryTarget (D2).
        if (upBound <= downBound) {
            // Gap can cover both extremes — center it in the feasible interval.
            // Uses only the existing up/down bounds (which themselves use getSellStartIdx geometry
            // implicitly: sellStart = boundary+gap+1 > maxSellIdx). No new gap math.
            candidate = Math.round((upBound + downBound) / 2);
        } else {
            // Wide range beyond gap capacity — prioritize trailing side
            if (lastSide === ORDER_TYPES.SELL) candidate = upBound;
            else if (lastSide === ORDER_TYPES.BUY) candidate = downBound;
            else candidate = Math.round((upBound + downBound) / 2);
        }
    } else if (maxSell != null) {
        candidate = findSplitIdx(maxSell) - floorGap;
    } else if (minBuy != null) {
        candidate = findSplitIdx(minBuy) - floorGap;
    } else if (lastPrice != null) {
        // Fallback to single last price via ideal boundary convention
        candidate = calculateIdealBoundary(allSlots, lastPrice, floorGap);
    }

    if (candidate == null || !Number.isFinite(candidate)) return null;
    return Math.max(0, Math.min(ceiling, candidate));
}

/**
 * Compute divergence between projected and bookkept boundary for telemetry.
 * @param {number|null} projected
 * @param {number|null} bookkept
 * @returns {number|null} Drift (projected - bookkept) or null if insufficient
 */
function computeAnchorDivergence(projected: any, bookkept: any): number | null {
    if (!Number.isFinite(projected) || !Number.isFinite(bookkept)) return null;
    return Number(projected) - Number(bookkept);
}

/**
 * Validate a restored/bookkept boundary against CHAIN EVIDENCE before the
 * startup reconcile is allowed to place orders against it (P3 of
 * docs/GAP_BAND_ORPHAN_PREVENTION_PLAN.md).
 *
 * A persisted boundary is disk state that may predate the last fill sweep:
 * `validatePersistedBoundary` only proves the boundary was consistent with
 * the SNAPSHOT at write time, not with the live book the reconcile is about
 * to mutate. Placements derived from a stale boundary create orders in
 * positions that a later boundary correction strands inside the gap band
 * (the orphan-creation origin).
 *
 * Evidence used:
 *   1. Placed-order distribution — every live BUY must imply a slot at or
 *      below the boundary; every live SELL at or above sellStartIdx
 *      (boundary + gapSlots + 1, the getSellStartIdx convention). Slot
 *      implication maps a price to the first slot priced at or above it —
 *      the same findIndex convention as projectAnchorToGrid.
 *   2. Market anchor (optional) — when the caller passes a FRESH anchor
 *      projection, it is used as the preferred correction candidate and as
 *      a contradiction veto. It never gates on its own: the anchor is a
 *      trailing traded-range signal with known large-drift false positives,
 *      so a divergent anchor against an otherwise-consistent book is
 *      telemetry (the ANCHOR-DIVERGENCE warning), not a correction trigger.
 *
 * Correction semantics: the live book implies a feasible boundary window
 * [liveBuyMaxIdx, liveSellMinIdx - gapSlots - 1], clamped to the shared
 * writer ceiling [0, N-gapSlots-1] (mirrors validateBoundaryCommit). The
 * suggested boundary is the anchor projection (preferred) or the restored
 * value, clamped into that window. When the window is empty (crossed live
 * book) or the fresh anchor contradicts the clamped correction beyond
 * maxAnchorDrift slots, no safe boundary can be derived and the caller must
 * run the reconcile adoption-only (no creates, no price-updates).
 *
 * @param {Object} params
 * @param {number|null} params.boundaryIdx - Restored/bookkept boundary (null = nothing to validate)
 * @param {number} params.gapSlots - Gap slot count between the rails
 * @param {Array<Object>} params.allSlots - Grid slots (any order; sorted internally by price)
 * @param {Array<Object>} params.chainOrders - Parsed live chain orders ({price, type})
 * @param {number|null} [params.anchorProjected] - Fresh projectAnchorToGrid output, if available
 * @param {number} [params.maxAnchorDrift=3] - Slot drift tolerated between anchor and correction
 * @returns {{ok: boolean, reasons: string[], detail: string, suggestedBoundary: number|null,
 *            liveBuyMaxIdx: number|null, liveSellMinIdx: number|null,
 *            feasibleLower: number|null, feasibleUpper: number|null}}
 */
function validateBoundaryAgainstChainEvidence(params: {
    boundaryIdx: any;
    gapSlots: any;
    allSlots: any;
    chainOrders: any;
    anchorProjected?: number | null;
    maxAnchorDrift?: number;
}): {
    ok: boolean;
    reasons: string[];
    detail: string;
    suggestedBoundary: number | null;
    liveBuyMaxIdx: number | null;
    liveSellMinIdx: number | null;
    feasibleLower: number | null;
    feasibleUpper: number | null;
} {
    const {
        boundaryIdx,
        gapSlots,
        allSlots,
        chainOrders,
        anchorProjected = null,
        maxAnchorDrift = 3,
    } = params || {};

    const result = {
        ok: true,
        reasons: [] as string[],
        detail: '',
        suggestedBoundary: null as number | null,
        liveBuyMaxIdx: null as number | null,
        liveSellMinIdx: null as number | null,
        feasibleLower: null as number | null,
        feasibleUpper: null as number | null,
    };

    if (boundaryIdx == null || !Number.isFinite(Number(boundaryIdx))) {
        result.detail = 'boundary unknown — nothing to validate';
        return result;
    }
    const boundary = Math.floor(Number(boundaryIdx));
    const gap = Math.max(0, Math.floor(Number(gapSlots) || 0));

    const sorted = (Array.isArray(allSlots) ? allSlots : [])
        .filter((s: any) => s && Number.isFinite(Number(s.price)))
        .sort((a: any, b: any) => Number(a.price) - Number(b.price));
    const n = sorted.length;

    const impliedIdx = (price: number): number => {
        const idx = sorted.findIndex((s: any) => Number(s.price) >= price);
        return idx < 0 ? n : idx;
    };

    for (const co of (Array.isArray(chainOrders) ? chainOrders : [])) {
        const price = Number(co?.price);
        if (!Number.isFinite(price)) continue;
        const idx = impliedIdx(price);
        if (co.type === ORDER_TYPES.BUY) {
            if (result.liveBuyMaxIdx === null || idx > result.liveBuyMaxIdx) result.liveBuyMaxIdx = idx;
        } else if (co.type === ORDER_TYPES.SELL) {
            if (result.liveSellMinIdx === null || idx < result.liveSellMinIdx) result.liveSellMinIdx = idx;
        }
    }

    const sellStartIdx = MathUtils.getSellStartIdx(boundary, gap);

    if (result.liveBuyMaxIdx !== null && result.liveBuyMaxIdx > boundary) {
        result.ok = false;
        result.reasons.push('LIVE_BUY_ABOVE_BOUNDARY');
    }
    if (result.liveSellMinIdx !== null && result.liveSellMinIdx < sellStartIdx) {
        result.ok = false;
        result.reasons.push('LIVE_SELL_BELOW_SELL_START');
    }

    const ceiling = n - gap - 1 >= 0 ? n - gap - 1 : Math.max(0, n - 1);
    const lower = Math.max(0, result.liveBuyMaxIdx !== null ? result.liveBuyMaxIdx : 0);
    const upper = Math.min(
        ceiling,
        result.liveSellMinIdx !== null ? result.liveSellMinIdx - gap - 1 : ceiling
    );
    result.feasibleLower = lower;
    result.feasibleUpper = upper;

    if (result.ok) {
        result.suggestedBoundary = boundary;
        result.detail =
            `boundary=${boundary} sellStartIdx=${sellStartIdx} liveBuyMaxIdx=${result.liveBuyMaxIdx} ` +
            `liveSellMinIdx=${result.liveSellMinIdx}`;
        return result;
    }

    result.detail =
        `boundary=${boundary} sellStartIdx=${sellStartIdx} liveBuyMaxIdx=${result.liveBuyMaxIdx} ` +
        `liveSellMinIdx=${result.liveSellMinIdx} feasible=[${lower}..${upper}]`;

    const hasFeasible = n > 0 && lower <= upper;
    if (!hasFeasible) {
        result.reasons.push('NO_FEASIBLE_BOUNDARY');
        result.suggestedBoundary = null;
        return result;
    }

    let candidate: number | null = null;
    const anchorValid = anchorProjected != null
        && Number.isFinite(Number(anchorProjected))
        && Number.isInteger(Number(anchorProjected));
    if (anchorValid) {
        const ap = Math.floor(Number(anchorProjected));
        candidate = Math.max(lower, Math.min(ap, upper));
    } else {
        candidate = Math.max(lower, Math.min(boundary, upper));
    }

    if (anchorValid && Number.isFinite(Number(maxAnchorDrift)) && Number(maxAnchorDrift) >= 0) {
        const drift = Math.abs(Math.floor(Number(anchorProjected)) - candidate!);
        if (drift > Number(maxAnchorDrift)) {
            result.reasons.push('ANCHOR_CONTRADICTS_CORRECTION');
            result.suggestedBoundary = null;
            return result;
        }
    }

    result.suggestedBoundary = candidate;
    return result;
}

export { parseChainOrder, findMatchingGridOrderByOpenOrder, applyChainSizeToGridOrder, buildFillKey, correctOrderPriceOnChain, correctAllPriceMismatches, buildCreateOrderArgs, getOrderTypeFromUpdatedFlags, resolveConfiguredPriceBound, virtualizeOrder, convertToSpreadPlaceholder, resolveSpreadOrderSide, chainOrderMatchesSlot, parseSlotIndex, filterOrdersByType, buildOutsideInPairGroups, extractBatchOperationResults, formatUnmatchedChainOrder, isOrderOnChain, isOrderVirtual, hasOnChainId, isOrderPlaced, isPhantomOrder, isSlotAvailable, isEmptyGridSlot, isOrderHealthy, checkSizeThreshold, checkSizesBeforeMinimum, calculateIdealBoundary, calculateFundDrivenBoundary, assignGridRoles, resolveOnChainRetypeType, shouldFlagOutOfSpread, buildIndexes, validateIndexes, ordersEqual, buildDelta, getOrderSize, deriveTargetBoundary, computePriceAnchoredBoundaryTarget, isShiftEligibleFill, resolveFillPrice, getActiveOrdersTotal, getSideBudget, calculateBudgetedSizes, buildCreateOpFingerprint, isOrderGoneErrorMessage, recordDuplicateOrphanDetection, clearDuplicateOrphanDetection, duplicateOrphanLogInfo, createEmptyMarketAnchor, isMarketAnchorAvailable, isMarketAnchorFresh, seedMarketAnchorFromBook, updateMarketAnchorFromFills, projectAnchorToGrid, computeAnchorDivergence, validateBoundaryAgainstChainEvidence }

