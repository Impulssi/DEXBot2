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
 *   - deriveTargetBoundary(fills, currentBoundaryIdx, allSlots, config, gapSlots, crossChunkBudget) - Derive boundary from fills (returns { boundaryIdx, remainingBudget })
 *   - getSideBudget(side, funds, config, totalTarget) - Calculate side budget after fees
 *   - calculateBudgetedSizes(slots, side, budget, weightDist, incrementPercent, assets) - Calculate budgeted sizes
 *
 * ===============================================================================
 */


import { ORDER_TYPES, ORDER_STATES, TIMING, FEE_PARAMETERS, GRID_LIMITS } from '../../constants';
import * as Format from '../format';
import * as MathUtils from './math';
import Logger from '../../logger';
import { sleep } from './system';
import { getErrorMessage } from '../../utils/errors';
const { isValidNumber, toFiniteNumber } = Format;
const { blockchainToFloat, floatToBlockchainInt, quantizeFloat, calculatePriceTolerance } = MathUtils;
const orderLogger = new Logger('Order');

const ORDER_GONE_ERROR_FRAGMENT = 'not found';

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
 * Skips dust refills (prevents unnecessary sync when size decreases).
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

    if (gridOrder.isDustRefill && newSize < oldSize) {
        const oldInt = floatToBlockchainInt(oldSize, precision);
        const newInt = floatToBlockchainInt(newSize, precision);
        const deltaInt = Math.max(0, oldInt - newInt);

        // Ignore only negligible one-unit quantization noise on dust refill orders.
        // Real decreases must still be synchronized to avoid stuck PARTIAL states.
        if (deltaInt <= 1) return null;
    }

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
function assignGridRoles(allSlots: any, boundaryIdx: any, gapSlots: any, ORDER_TYPES: any, ORDER_STATES: any, options: { assignOnChain?: boolean; getCurrentSlot?: (id: any) => any } = {}) {
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
        if (!assignOnChain) {
            const isEmptySlot = slot.type !== null
                && !isOrderOnChain(liveSlot)
                && liveSlot.state === ORDER_STATES.VIRTUAL
                && !liveSlot.orderId
                && Number(liveSlot.size || 0) === 0;
            if (isEmptySlot) {
                if (slot.type === ORDER_TYPES.SPREAD) return slot;
                return { ...slot, type: ORDER_TYPES.SPREAD };
            }
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
    const quantum = Math.pow(10, -p);
    return quantum > 0 ? quantum : Number.EPSILON;
}

function observedQuantum(a: any, b: any) {
    const maxDecimals = Math.max(getDecimalPlaces(a), getDecimalPlaces(b));
    if (maxDecimals <= 0) return Number.EPSILON;
    const quantum = Math.pow(10, -maxDecimals);
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
           a.orderId === b.orderId &&
           a.gridIndex === b.gridIndex;
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
 * Determine new boundary based on fills and current state.
 *
 * @param {Array} fills - Recent fill events
 * @param {number|null} currentBoundaryIdx - Current boundary index
 * @param {Array} allSlots - All grid slots sorted by price
 * @param {Object} config - Bot configuration
 * @param {number} gapSlots - Number of spread gap slots
 * @returns {number} New boundary index
 */
function deriveTargetBoundary(fills: any, currentBoundaryIdx: any, allSlots: any, config: any, gapSlots: any, crossChunkBudget?: number | null): { boundaryIdx: number; remainingBudget: number } {
    let newBoundaryIdx = currentBoundaryIdx;

    // Initial recovery if boundary is undefined
    if (newBoundaryIdx === undefined || newBoundaryIdx === null) {
         const referencePrice = config.startPrice;
         newBoundaryIdx = calculateIdealBoundary(allSlots, referencePrice, gapSlots);
    }

    // Apply shift from fills with rate-limiting
    let netShift = 0;
    for (const fill of fills) {
        const isShiftEligible =
            fill?.isPartial !== true ||
            fill?.isDelayedRotationTrigger === true;

        if (!isShiftEligible) continue;
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

    // Clamp boundary
    return {
        boundaryIdx: Math.max(0, Math.min(allSlots.length - 1, newBoundaryIdx)),
        remainingBudget,
    };
}

/**
 * Shared BTS fee adjustment math used by both getSideBudget and Grid._getSizingContext.
 *
 * Deducts BTS creation fees from allocated budget when the holding side has BTS,
 * or proportionally shares BTS fee deficits across both sides for non-BTS pairs.
 *
 * @param {number} allocated - Raw allocated budget for this side
 * @param {boolean} isBtsSide - Whether this side holds BTS
 * @param {number} formulaBudget - Pre-calculated BTS fee estimate
 * @param {number} minBtsValue - Configured minimum BTS reserve (or 0)
 * @param {number} btsFree - Available free BTS balance
 * @param {number} sideFree - Free balance of this side's asset
 * @param {number} totalFree - Total free balance across both sides
 * @returns {number} Budget adjusted for BTS fee reservation
 */
function adjustBudgetForBtsFees(allocated: any, isBtsSide: any, formulaBudget: any, minBtsValue: any, btsFree: any, sideFree: any, totalFree: any) {
    return MathUtils.adjustBudgetForBtsFees(allocated, isBtsSide, formulaBudget, minBtsValue, btsFree, sideFree, totalFree);
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
        return adjustBudgetForBtsFees(allocated, true, formulaBudget, 0, 0, 0, 0);
    }

    return adjustBudgetForBtsFees(
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

export { parseChainOrder, findMatchingGridOrderByOpenOrder, applyChainSizeToGridOrder, buildFillKey, correctOrderPriceOnChain, correctAllPriceMismatches, buildCreateOrderArgs, getOrderTypeFromUpdatedFlags, resolveConfiguredPriceBound, virtualizeOrder, convertToSpreadPlaceholder, resolveSpreadOrderSide, chainOrderMatchesSlot, parseSlotIndex, filterOrdersByType, buildOutsideInPairGroups, extractBatchOperationResults, formatUnmatchedChainOrder, isOrderOnChain, isOrderVirtual, hasOnChainId, isOrderPlaced, isPhantomOrder, isSlotAvailable, isOrderHealthy, checkSizeThreshold, checkSizesBeforeMinimum, calculateIdealBoundary, calculateFundDrivenBoundary, assignGridRoles, resolveOnChainRetypeType, shouldFlagOutOfSpread, buildIndexes, validateIndexes, ordersEqual, buildDelta, getOrderSize, deriveTargetBoundary, adjustBudgetForBtsFees, getActiveOrdersTotal, getSideBudget, calculateBudgetedSizes, buildCreateOpFingerprint }

