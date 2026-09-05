/**
 * modules/order/utils/validate.ts
 *
 * Pure functions for order validation, grid reconciliation, and immutable mutations.
 *
 * ===============================================================================
 * TABLE OF CONTENTS
 * ===============================================================================
 *
 * SECTION 1: EXTERNAL DEPENDENCIES
 *
 * SECTION 2: VALIDATION
 *   - validateOrder()
 *   - validateGridForPersistence()
 *   - calculateRequiredFunds()
 *   - validateWorkingGridFunds()
 *   - checkFundDrift()
 *
 * SECTION 3: GRID RECONCILIATION (COW Pipeline)
 *   - reconcileGrid()
 *   - optimizeRebalanceActions()
 *   - summarizeActions()
 *   - hasActionForOrder()
 *   - removeActionsForOrder()
 *   - projectTargetToWorkingGrid()
 *   - buildStateUpdates()
 *   - buildAbortedResult()
 *   - buildSuccessResult()
 *   - evaluateCommit()
 *
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: EXTERNAL DEPENDENCIES
// ===============================================================================


import * as Format from '../format.js';
import {
    ORDER_STATES,
    ORDER_TYPES,
    COW_ACTIONS,
    GRID_LIMITS
} from '../../constants.js';
import {
    floatToBlockchainInt,
    blockchainToFloat,
    getPrecisionSlack,
    getDoubleDustThreshold,
    clamp
} from './math.js';
import { parseSlotIndex } from './slot.js';
import {
    isOrderOnChain,
    isPhantomOrder,
    convertToSpreadPlaceholder
} from './order.js';
const { isValidNumber, toFiniteNumber } = Format;

// Pre-computed valid sets
const VALID_ORDER_STATES = new Set(Object.values(ORDER_STATES));
const VALID_ORDER_TYPES = new Set(Object.values(ORDER_TYPES));

// ===============================================================================
// SECTION 2: VALIDATION
// ===============================================================================

/**
 * Validate a complete order object
 * @param {Object} order - Order to validate
 * @param {Object} oldOrder - Previous order state (for context)
 * @param {string} context - Operation context for error messages
 * @returns {Object} Validation result
 */
function validateOrder(order: any, oldOrder: any = null, context: any = 'validate') {
    const errors: any[] = [];
    const warnings: any[] = [];
    let normalizedOrder = { ...(oldOrder || {}), ...order };

    if (!order || !order.id) {
        errors.push({ code: 'MISSING_ID', message: 'Refusing to update order: missing ID' });
        return { isValid: false, errors, warnings, normalizedOrder: null };
    }

    if (!normalizedOrder.type && normalizedOrder.state === ORDER_STATES.VIRTUAL) {
        const placeholderSize = toFiniteNumber(normalizedOrder.size);
        if (placeholderSize === 0) {
            normalizedOrder.type = ORDER_TYPES.SPREAD;
        }
    }

    if (!VALID_ORDER_STATES.has(normalizedOrder.state)) {
        errors.push({
            code: 'INVALID_STATE',
            message: `Refusing to update order ${order.id}: invalid state '${normalizedOrder.state}' (context: ${context})`
        });
    }

    if (!VALID_ORDER_TYPES.has(normalizedOrder.type)) {
        errors.push({
            code: 'INVALID_TYPE',
            message: `Refusing to update order ${order.id}: invalid type '${normalizedOrder.type}' (context: ${context})`
        });
    }

    if (normalizedOrder.type === ORDER_TYPES.SPREAD && toFiniteNumber(normalizedOrder.size) !== 0) {
        warnings.push({
            code: 'SPREAD_SIZE_NORMALIZED',
            message: `[INVARIANT] Normalizing SPREAD order ${order.id} size ${normalizedOrder.size} -> 0 (context: ${context})`
        });
        normalizedOrder.size = 0;
    }

    const isOnChainState = (
        normalizedOrder.state === ORDER_STATES.ACTIVE ||
        normalizedOrder.state === ORDER_STATES.PARTIAL
    );

    if (normalizedOrder.type === ORDER_TYPES.SPREAD && isOnChainState) {
        errors.push({
            code: 'ILLEGAL_SPREAD_STATE',
            message: `ILLEGAL STATE: Refusing to move SPREAD order ${order.id} to ${normalizedOrder.state}. SPREAD orders must remain VIRTUAL.`,
            isFatal: true
        });
    }

    if (isPhantomOrder(normalizedOrder)) {
        errors.push({
            code: 'PHANTOM_ORDER',
            message: `ILLEGAL STATE: Refusing to set order ${order.id} to ${normalizedOrder.state} without orderId. Context: ${context}. This would create a phantom order that doubles fund tracking.`,
            autoCorrect: {
                state: ORDER_STATES.VIRTUAL,
                orderId: null,
                rawOnChain: null,
                size: 0
            }
        });
    }

    if (normalizedOrder.type === ORDER_TYPES.BUY || normalizedOrder.type === ORDER_TYPES.SELL) {
        normalizedOrder.committedSide = normalizedOrder.type;
    } else if (!normalizedOrder.committedSide && oldOrder) {
        if (oldOrder.committedSide) {
            normalizedOrder.committedSide = oldOrder.committedSide;
        } else if (oldOrder.type === ORDER_TYPES.BUY || oldOrder.type === ORDER_TYPES.SELL) {
            normalizedOrder.committedSide = oldOrder.type;
        }
    }

    return {
        isValid: errors.length === 0 || !errors.some((e: any) => e.isFatal),
        errors,
        warnings,
        normalizedOrder
    };
}

/**
 * Validate grid state for persistence
 * @param {Map} orders - Master grid orders
 * @param {Object} accountTotals - Current account totals
 * @returns {Object} Validation result
 */
function validateGridForPersistence(orders: any, accountTotals: any) {
    for (const order of orders.values()) {
        if (isPhantomOrder(order)) {
            return {
                isValid: false,
                reason: `Phantom order detected: order ${order.id} is ${order.state} but has no orderId`
            };
        }
    }

    if (!accountTotals || !isValidNumber(accountTotals.buy) || !isValidNumber(accountTotals.sell)) {
        return {
            isValid: false,
            reason: 'Account totals not initialized'
        };
    }

    return { isValid: true, reason: null };
}

/**
 * Calculate required funds from a grid
 * @param {Map|WorkingGrid} grid - Grid to analyze
 * @param {Object} precisions - Precision config
 * @returns {Object} Required funds { buyInt, sellInt, buy, sell }
 */
function calculateRequiredFunds(grid: any, precisions: Record<string, any> = {}) {
    const buyPrecision = precisions.buyPrecision;
    const sellPrecision = precisions.sellPrecision;

    let buyRequiredInt = 0;
    let sellRequiredInt = 0;

    for (const order of grid.values()) {
        const size = toFiniteNumber(order.size ?? order.amount);

        const state = order.state;
        const isActive = state === ORDER_STATES.ACTIVE || state === ORDER_STATES.PARTIAL;

        if (isActive && isOrderOnChain(order)) {
            if (order.type === ORDER_TYPES.BUY) {
                buyRequiredInt += floatToBlockchainInt(size, buyPrecision);
            } else if (order.type === ORDER_TYPES.SELL) {
                sellRequiredInt += floatToBlockchainInt(size, sellPrecision);
            }
        }
    }

    return {
        buyInt: buyRequiredInt,
        sellInt: sellRequiredInt,
        buy: blockchainToFloat(buyRequiredInt, buyPrecision),
        sell: blockchainToFloat(sellRequiredInt, sellPrecision)
    };
}

/**
 * Validate working grid against available funds
 * @param {WorkingGrid} workingGrid - Grid to validate
 * @param {Object} projectedFunds - Available funds
 * @param {Object} precisions - Asset precisions
 * @param {Object} assets - Asset metadata
 * @returns {Object} Validation result
 */
function validateWorkingGridFunds(workingGrid: any, projectedFunds: any, precisions: Record<string, any> = {}, assets: any = null) {
    const buyPrecision = precisions.buyPrecision ?? assets?.assetB?.precision;
    const sellPrecision = precisions.sellPrecision ?? assets?.assetA?.precision;
    
    const required = calculateRequiredFunds(workingGrid, { buyPrecision, sellPrecision });
    
    const availableBuy = isValidNumber(projectedFunds?.allocatedBuy)
        ? Number(projectedFunds.allocatedBuy)
        : isValidNumber(projectedFunds?.chainTotalBuy)
            ? Number(projectedFunds.chainTotalBuy)
            : toFiniteNumber(projectedFunds?.freeBuy ?? projectedFunds?.chainFreeBuy);
    
    const availableSell = isValidNumber(projectedFunds?.allocatedSell)
        ? Number(projectedFunds.allocatedSell)
        : isValidNumber(projectedFunds?.chainTotalSell)
            ? Number(projectedFunds.chainTotalSell)
            : toFiniteNumber(projectedFunds?.freeSell ?? projectedFunds?.chainFreeSell);

    const shortfalls: any[] = [];

    const availableBuyInt = floatToBlockchainInt(availableBuy, buyPrecision);
    const availableSellInt = floatToBlockchainInt(availableSell, sellPrecision);

    if (required.buyInt > availableBuyInt) {
        const requiredBuyFloat = blockchainToFloat(required.buyInt, buyPrecision);
        const availableBuyFloat = blockchainToFloat(availableBuyInt, buyPrecision);
        shortfalls.push({
            asset: assets?.assetB?.symbol || 'buyAsset',
            required: requiredBuyFloat,
            available: availableBuyFloat,
            deficit: blockchainToFloat(required.buyInt - availableBuyInt, buyPrecision)
        });
    }

    if (required.sellInt > availableSellInt) {
        const requiredSellFloat = blockchainToFloat(required.sellInt, sellPrecision);
        const availableSellFloat = blockchainToFloat(availableSellInt, sellPrecision);
        shortfalls.push({
            asset: assets?.assetA?.symbol || 'sellAsset',
            required: requiredSellFloat,
            available: availableSellFloat,
            deficit: blockchainToFloat(required.sellInt - availableSellInt, sellPrecision)
        });
    }

    return {
        isValid: shortfalls.length === 0,
        reason: shortfalls.length > 0 ? `Fund shortfall: ${JSON.stringify(shortfalls)}` : null,
        shortfalls,
        required,
        available: { buy: availableBuy, sell: availableSell }
    };
}

/**
 * Check fund drift against blockchain totals
 * @param {Map} orders - Current orders
 * @param {Object} accountTotals - Blockchain account totals
 * @param {Object} assets - Asset metadata
 * @returns {Object} Drift check result
 */
function checkFundDrift(orders: Map<string, any>, accountTotals: any, assets: any = null, gridLimits: any = null) {
    let gridBuy = 0, gridSell = 0;
    for (const order of Array.from(orders.values())) {
        const size = toFiniteNumber(order.size);
        if (size <= 0 || !isOrderOnChain(order)) continue;

        if (order.type === ORDER_TYPES.BUY) gridBuy += size;
        else if (order.type === ORDER_TYPES.SELL) gridSell += size;
    }

    const chainFreeBuy = accountTotals?.buyFree || 0;
    const chainFreeSell = accountTotals?.sellFree || 0;
    const actualBuy = accountTotals?.buy || 0;
    const actualSell = accountTotals?.sell || 0;

    const expectedBuy = chainFreeBuy + gridBuy;
    const expectedSell = chainFreeSell + gridSell;

    const driftBuy = Math.abs(actualBuy - expectedBuy);
    const driftSell = Math.abs(actualSell - expectedSell);

    const buyPrecision = assets?.assetB?.precision;
    const sellPrecision = assets?.assetA?.precision;
    
    if (!isValidNumber(buyPrecision) || !isValidNumber(sellPrecision)) {
        return { isValid: true, reason: 'Skipped: precision not available', driftBuy, driftSell };
    }

    const precisionSlackBuy = getPrecisionSlack(buyPrecision);
    const precisionSlackSell = getPrecisionSlack(sellPrecision);
    const fundInvariantTolerance = gridLimits?.FUND_INVARIANT_PERCENT_TOLERANCE ?? GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE;
    const percentTolerance = fundInvariantTolerance / 100;

    const allowedDriftBuy = Math.max(precisionSlackBuy, actualBuy * percentTolerance);
    const allowedDriftSell = Math.max(precisionSlackSell, actualSell * percentTolerance);

    const buyOk = driftBuy <= allowedDriftBuy;
    const sellOk = driftSell <= allowedDriftSell;

    return {
        isValid: buyOk && sellOk,
        driftBuy,
        driftSell,
        allowedDriftBuy,
        allowedDriftSell,
        reason: !buyOk 
            ? `BUY drift ${Format.formatAmountByPrecision(driftBuy, buyPrecision)} > ${Format.formatAmountByPrecision(allowedDriftBuy, buyPrecision)}`
            : !sellOk 
                ? `SELL drift ${Format.formatAmountByPrecision(driftSell, sellPrecision)} > ${Format.formatAmountByPrecision(allowedDriftSell, sellPrecision)}`
                : null
    };
}

// ===============================================================================
// SECTION 3: GRID RECONCILIATION (COW Pipeline)
// ===============================================================================

/**
 * Clamp a rotation UPDATE's target size to a partially-filled surplus order's
 * booked remaining size.
 *
 * A rotation must never GROW a PARTIAL order in place: the fill is already
 * booked into slot.size, and growing it restores the pre-fill size on chain
 * while the books keep the post-fill remainder (fill accounting divergence —
 * the COW executor skips such UPDATEs, which strands the hole and leaves a
 * gap in the grid). Clamping keeps the plan's price intent and fills the hole
 * at the remainder size, so the grid stays contiguous. A deliberate full-size
 * top-up must go through a cancel+create cycle, not a silent in-place grow.
 *
 * Mirrors the clampPostFillUpdateSize policy used for plain size UPDATEs in
 * the COW executor (modules/dexbot_cow_runtime.ts).
 *
 * @param {Object} surplusMaster - Live master-grid order for the rotation source
 * @param {number} holeSize - Planned target (hole) size
 * @param {Function|null} [logger=null] - Optional (msg, level) logger
 * @param {string} [holeId=''] - Hole slot id for the log line
 * @returns {number} The (possibly clamped) rotation size
 */
function clampRotationSizeForPartial(surplusMaster: any, holeSize: number, logger: any = null, holeId: string = '') {
    const target = toFiniteNumber(holeSize);
    if (!surplusMaster || surplusMaster.state !== ORDER_STATES.PARTIAL) return target;
    const booked = toFiniteNumber(surplusMaster.size);
    if (!Number.isFinite(target) || !Number.isFinite(booked) || booked <= 0) return target;
    if (target > booked) {
        if (logger) {
            logger(
                `[RECONCILE] Clamping rotation ${surplusMaster.id} -> ${holeId || '?'}: ` +
                `surplus is PARTIAL with booked remaining ${Format.formatAmount8(booked)} ` +
                `but hole targets ${Format.formatAmount8(target)} — rotating at remainder size ` +
                `so the hole fills without growing the partial in place.`,
                'warn'
            );
        }
        return booked;
    }
    return target;
}

/**
 * Reconcile target grid against master state
 * @param {Map} masterGrid - Current master grid
 * @param {Map} targetGrid - Target state from strategy
 * @param {number} targetBoundary - Target boundary index
 * @param {Object} options - Options
 * @returns {Object} Reconciliation result with actions
 */
function reconcileGrid(masterGrid: any, targetGrid: any, targetBoundary: any, options: Record<string, any> = {}) {
    const { logger = null, dustThresholdPercent = GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE } = options;
    const actions: any[] = [];
    
    const surplusesBuy: any[] = [];
    const surplusesSell: any[] = [];
    const holesBuy: any[] = [];
    const holesSell: any[] = [];

    const isCreateHealthy = (order: any) => {
        if (!order || order.size <= 0) return false;
        const idealSize = toFiniteNumber(order.idealSize || order.size);
        if (idealSize <= 0) return true;
        const minHealthy = getDoubleDustThreshold(idealSize, dustThresholdPercent);
        if (order.size < minHealthy) {
            if (logger) {
                logger(
                    `[RECONCILE] Skipping dust target order: ${order.id} ` +
                    `size=${Format.formatAmount8(order.size)} < minHealthy=${Format.formatAmount8(minHealthy)} ` +
                    `(ideal=${Format.formatAmount8(idealSize)}, threshold=${dustThresholdPercent * 2}%)`,
                    'warn'
                );
            }
            return false;
        }
        return true;
    };

    let validatedBoundary = targetBoundary;
    if (targetBoundary !== null) {
        const maxIdx = Math.max(0, masterGrid.size - 1);
        if (targetBoundary < 0 || targetBoundary > maxIdx) {
            const clamped = clamp(targetBoundary, 0, maxIdx);
            if (logger) {
                logger(`[RECONCILE] Clamping target boundary ${targetBoundary} -> ${clamped} (max ${maxIdx}).`, 'warn');
            }
            validatedBoundary = clamped;
        }
    }

    for (const [id, targetOrder] of targetGrid) {
        const masterOrder = masterGrid.get(id);

        if (!masterOrder || masterOrder.state === ORDER_STATES.VIRTUAL) {
            // Slot is empty or virtual - check if we need to fill it
            if (targetOrder.size > 0 && targetOrder.state === ORDER_STATES.ACTIVE) {
                // This is a hole that needs filling
                if (targetOrder.type === ORDER_TYPES.BUY) {
                    holesBuy.push({ id, order: targetOrder });
                } else if (targetOrder.type === ORDER_TYPES.SELL) {
                    holesSell.push({ id, order: targetOrder });
                }
            }
            continue;
        }

        if (masterOrder.type !== targetOrder.type) {
            actions.push({ type: COW_ACTIONS.CANCEL, id, orderId: masterOrder.orderId, reason: 'type-mismatch' });
            if (targetOrder.size > 0 && targetOrder.state === ORDER_STATES.ACTIVE && isCreateHealthy(targetOrder)) {
                actions.push({ type: COW_ACTIONS.CREATE, id, order: targetOrder });
            }
            continue;
        }

        // If master is on-chain but target should be VIRTUAL (outside window),
        // this is a surplus candidate for rotation.
        if (isOrderOnChain(masterOrder) && targetOrder.state === ORDER_STATES.VIRTUAL) {
            if (masterOrder.type === ORDER_TYPES.BUY) {
                surplusesBuy.push({ id, master: masterOrder, target: targetOrder });
            } else if (masterOrder.type === ORDER_TYPES.SELL) {
                surplusesSell.push({ id, master: masterOrder, target: targetOrder });
            }
            continue;
        }

        if (masterOrder.size !== targetOrder.size) {
            if (targetOrder.size === 0) {
                actions.push({ type: COW_ACTIONS.CANCEL, id, orderId: masterOrder.orderId, reason: 'target-size-zero' });
            }
            // Intentionally no in-place size UPDATE here.
            // Fill-driven COW rebalance keeps updates rotation-only (newGridId path).
            // Non-rotation size corrections are handled by dedicated maintenance flows
            // (divergence/surplus cache-funds correction plans).
        }
    }

    const cancelSurpluses = (surpluses: any) => {
        for (const surplus of surpluses) {
            if (surplus.master.orderId) {
                actions.push({ type: COW_ACTIONS.CANCEL, id: surplus.id, orderId: surplus.master.orderId, reason: 'surplus-no-rotation-target' });
            }
        }
    };

    const pairRotations = (surpluses: any, holes: any) => {
        const healthyHoles = holes.filter((hole: any) => isCreateHealthy(hole.order));

        if (healthyHoles.length === 0) {
            // No viable rotation targets — cancel all unmatched surpluses
            cancelSurpluses(surpluses);
            return;
        }

        if (surpluses.length === 0) {
            for (const hole of healthyHoles) {
                actions.push({ type: COW_ACTIONS.CREATE, id: hole.id, order: hole.order });
            }
            return;
        }

        const isBuy = surpluses[0]?.master?.type === ORDER_TYPES.BUY;
        const slotIdx = (id: string) => { const p = parseSlotIndex(id); return p == null ? Number.MAX_SAFE_INTEGER : p; };
        healthyHoles.sort((a: any, b: any) => {
            const da = slotIdx(a.id);
            const db = slotIdx(b.id);
            if (da !== db) return da - db;
            return isBuy ? b.order.price - a.order.price : a.order.price - b.order.price;
        });
        surpluses.sort((a: any, b: any) => {
            const da = slotIdx(a.id);
            const db = slotIdx(b.id);
            if (da !== db) return da - db;
            return isBuy ? a.master.price - b.master.price : b.master.price - a.master.price;
        });

        const rotationCount = Math.min(surpluses.length, healthyHoles.length);
        for (let i = 0; i < rotationCount; i++) {
            const surplus = surpluses[i];
            const hole = healthyHoles[i];

            actions.push({
                type: COW_ACTIONS.UPDATE,
                id: surplus.id,
                orderId: surplus.master.orderId,
                newGridId: hole.id,
                newSize: clampRotationSizeForPartial(surplus.master, hole.order.size, logger, hole.id),
                newPrice: hole.order.price,
                order: hole.order,
                isRotation: true
            });
        }

        for (let i = rotationCount; i < healthyHoles.length; i++) {
            actions.push({ type: COW_ACTIONS.CREATE, id: healthyHoles[i].id, order: healthyHoles[i].order });
        }

        // Cancel any surpluses that couldn't be paired with a hole
        cancelSurpluses(surpluses.slice(rotationCount));
    };
    
    pairRotations(surplusesBuy, holesBuy);
    pairRotations(surplusesSell, holesSell);

    for (const [id, masterOrder] of masterGrid) {
        if (!targetGrid.has(id) && isOrderOnChain(masterOrder)) {
            actions.push({ type: COW_ACTIONS.CANCEL, id, orderId: masterOrder.orderId, reason: 'orphan-slot' });
        }
    }

    return { 
        actions, 
        aborted: false,
        boundaryIdx: validatedBoundary,
        summary: summarizeActions(actions)
    };
}

/**
 * Pair same-side CREATE+CANCEL actions into rotation-style UPDATE actions.
 * This reduces churn and matches boundary-crawl behavior where an on-chain
 * order is moved to a new slot instead of cancel+recreate.
 *
 * @param {Array<Object>} actions - Reconcile action list
 * @param {Map} masterGrid - Current master grid
 * @returns {Array<Object>} Optimized action list
 */
function optimizeRebalanceActions(actions: any, masterGrid: any, options: Record<string, any> = {}) {
    if (!Array.isArray(actions) || actions.length === 0) return [];
    const { logger = null } = options;

    const creates: any[] = [];
    const cancels: any[] = [];
    const passthrough: any[] = [];

    for (const action of actions) {
        if (action?.type === COW_ACTIONS.CREATE) {
            creates.push(action);
        } else if (action?.type === COW_ACTIONS.CANCEL) {
            cancels.push(action);
        } else {
            passthrough.push(action);
        }
    }

    if (creates.length === 0 || cancels.length === 0) {
        return actions;
    }

    const remainingCreates = [...creates];
    const optimized = [...passthrough];

    for (const cancelAction of cancels) {
        const masterOrder = masterGrid.get(cancelAction.id);
        const cancelType = masterOrder?.type;

        if (!masterOrder || !cancelAction.orderId || !cancelType) {
            optimized.push(cancelAction);
            continue;
        }

        let bestIdx = -1;
        let bestDistance = Infinity;

        for (let i = 0; i < remainingCreates.length; i++) {
            const createAction = remainingCreates[i];
            const createType = createAction?.order?.type;
            if (createType !== cancelType) continue;

            const fromIdx = parseSlotIndex(cancelAction.id);
            const toIdx = parseSlotIndex(createAction.id);
            const fromPrice = toFiniteNumber(masterOrder.price);
            const toPrice = toFiniteNumber(createAction?.order?.price);
            const distance = (fromIdx != null && toIdx != null) ? Math.abs(toIdx - fromIdx) : Math.abs(toPrice - fromPrice);

            if (distance < bestDistance) {
                bestDistance = distance;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) {
            optimized.push(cancelAction);
            continue;
        }

        const createAction = remainingCreates.splice(bestIdx, 1)[0];
        optimized.push({
            type: COW_ACTIONS.UPDATE,
            id: cancelAction.id,
            orderId: cancelAction.orderId,
            newGridId: createAction.id,
            newSize: clampRotationSizeForPartial(masterOrder, toFiniteNumber(createAction?.order?.size), logger, createAction.id),
            newPrice: toFiniteNumber(createAction?.order?.price),
            order: createAction.order,
            isRotation: true
        });
    }

    for (const createAction of remainingCreates) {
        optimized.push(createAction);
    }

    return optimized;
}

/**
 * Summarize actions for logging/debugging
 * @param {Array} actions - Action list
 * @returns {Object} Summary counts
 */
function summarizeActions(actions: any) {
    return {
        total: actions.length,
        creates: actions.filter((a: any) => a.type === COW_ACTIONS.CREATE).length,
        cancels: actions.filter((a: any) => a.type === COW_ACTIONS.CANCEL).length,
        updates: actions.filter((a: any) => a.type === COW_ACTIONS.UPDATE).length
    };
}

/**
 * Check if a rebalance result has executable actions.
 *
 * @param {any} rebalanceResult - Rebalance result to check
 * @returns {boolean} True if actions array is non-empty
 */
function hasExecutableActions(rebalanceResult: any) {
    const actions = rebalanceResult?.actions;
    return Array.isArray(actions) && actions.length > 0;
}

/**
 * Validate that CREATE actions target slots that are not already occupied on-chain
 * and that no CREATE price collides with an existing placed order or unmatched
 * on-chain order.  Checks four layers:
 *   1. Slot occupancy — target grid slot already has a placed order
 *   2. Master grid slot collision — same slotId already placed (priceSlotEqual)
 *   3. Chain orphan slot collision — chain order's nearest slotId equals target slotId
 *   4. Same-batch duplicate slotId — two CREATEs target same slotId
 *
 * Cancel and rotation-released slots are considered free.
 *
 * Returns violating target IDs alongside violations so the caller can skip
 * individual violating CREATEs instead of aborting the entire batch.
 *
 * @param {Array<any>} actions - List of COW actions
 * @param {Map} orders - Current order grid
 * @param {Object|null} [assets=null] - Asset metadata for tolerance calculation
 * @param {Array<Object>} [chainOrderCandidates=[]] - Unmatched on-chain orders
 *   with {chainOrderId, price, size, type} to check beyond the grid
 * @returns {{isValid: boolean, violations: Array<Object>, violatingTargetIds: Set<string>}} Validation result
 */
function validateCreateTargetSlots(actions: any, orders: any, _assets: any = null, chainOrderCandidates: any[] = []) {
    const safeActions = Array.isArray(actions) ? actions : [];
    const orderMap = orders instanceof Map ? orders : new Map();
    const releasedSlotIds = new Set();

    for (const action of safeActions) {
        if (action?.type === COW_ACTIONS.CANCEL && action.id) {
            releasedSlotIds.add(action.id);
            continue;
        }

        if (
            action?.type === COW_ACTIONS.UPDATE &&
            action.id &&
            action.newGridId &&
            action.newGridId !== action.id
        ) {
            releasedSlotIds.add(action.id);
        }
    }

    const violations: any[] = [];
    const createEntries: Array<{targetId: string, action: any, price: number, size: number, type: string}> = [];

    for (const action of safeActions) {
        if (action?.type !== COW_ACTIONS.CREATE) continue;

        const targetId = action.id || action.order?.id;
        if (!targetId || releasedSlotIds.has(targetId)) continue;

        const current = orderMap.get(targetId);

        // isOrderOnChain already checks orderId is truthy
        if (current && isOrderOnChain(current)) {
            violations.push({
                targetId,
                currentOrderId: current.orderId,
                currentType: current.type,
                currentState: current.state,
                reason: 'slot_occupied'
            });
        }

        if (action.order?.price != null && action.order?.type != null) {
            const liveSlot = orderMap.get(targetId);
            const livePrice = liveSlot && Number.isFinite(Number(liveSlot.price))
                ? Number(liveSlot.price)
                : null;
            const effectivePrice = livePrice !== null ? livePrice : Number(action.order.price);
            createEntries.push({
                targetId,
                action,
                price: effectivePrice,
                size: Number(action.order.size || 0),
                type: action.order.type,
            });
        }
    }

    if (createEntries.length > 0) {
        // Chain orphan: if chain order's nearest slot equals target slot
        const validChainCandidates = chainOrderCandidates.length > 0 ? chainOrderCandidates.filter((u: any) => u.chainOrderId) : [];
        if (validChainCandidates.length > 0) {
            const chainSlotIds = new Set(validChainCandidates.map((u: any) => u.chainSlotId || u.candidateSlotId).filter(Boolean));
            for (const entry of createEntries) {
                if (chainSlotIds.has(entry.targetId)) {
                    violations.push({ targetId: entry.targetId, currentOrderId: entry.targetId, currentType: entry.type, currentState: 'CHAIN_ORPHAN', reason: 'chain_orphan_collision' });
                }
            }
            // Price-based fallback when candidates have no slotId (legacy sync without genesis slot mapping)
            if (chainSlotIds.size === 0 && _assets) {
                try {
                    const { priceSlotEqual } = require('./math.js');
                    for (const entry of createEntries) {
                        if (violations.some(v => v.targetId === entry.targetId)) continue;
                        for (const u of validChainCandidates) {
                            if (u.price == null || entry.price == null) continue;
                            if (u.type && entry.type && u.type !== entry.type) continue;
                            const precision = entry.type === 'sell' ? _assets.assetA?.precision : _assets.assetB?.precision;
                            try { if (priceSlotEqual(u.price, entry.price, precision)) { violations.push({ targetId: entry.targetId, currentOrderId: u.chainOrderId, currentType: entry.type, currentState: 'CHAIN_ORPHAN', reason: 'chain_orphan_collision' }); break; } } catch {}
                        }
                    }
                } catch {}
            }
        }
        // Same-batch duplicate slot
        const seen = new Set<string>();
        for (const entry of createEntries) {
            if (seen.has(entry.targetId)) {
                violations.push({ targetId: entry.targetId, currentOrderId: null, currentType: entry.type, currentState: 'CREATE', reason: 'same_batch_price_collision' });
            } else seen.add(entry.targetId);
        }
    }

    const violatingTargetIds = new Set(violations.map(v => v.targetId));

    return {
        isValid: violations.length === 0,
        violations,
        violatingTargetIds
    };
}

/**
 * Check whether an action targets a given order reference.
 * Matches by orderId first (when present on both), otherwise by slot id.
 *
 * @param {Object} action - Action object
 * @param {Object} orderRef - Reference with id/orderId
 * @returns {boolean}
 */
function actionMatchesOrder(action: any, orderRef: any) {
    if (!action || !orderRef) return false;
    if (orderRef.orderId && action.orderId && String(orderRef.orderId) === String(action.orderId)) {
        return true;
    }
    return !!orderRef.id && String(orderRef.id) === String(action.id);
}

/**
 * Check if an action list already contains a matching action for an order.
 *
 * @param {Array<Object>} actions - Action list
 * @param {string|null} actionType - Optional action type filter
 * @param {Object} orderRef - Reference with id/orderId
 * @returns {boolean}
 */
function hasActionForOrder(actions: any, actionType: any, orderRef: any) {
    if (!Array.isArray(actions)) return false;
    return actions.some((action: any) => {
        if (actionType && action?.type !== actionType) return false;
        return actionMatchesOrder(action, orderRef);
    });
}

/**
 * Remove matching actions for an order from action list in-place.
 *
 * @param {Array<Object>} actions - Action list (mutated)
 * @param {string|null} actionType - Optional action type filter
 * @param {Object} orderRef - Reference with id/orderId
 * @returns {number} Number of removed actions
 */
function removeActionsForOrder(actions: any, actionType: any, orderRef: any) {
    if (!Array.isArray(actions)) return 0;
    let removed = 0;
    for (let i = actions.length - 1; i >= 0; i--) {
        const action = actions[i];
        if (actionType && action?.type !== actionType) continue;
        if (!actionMatchesOrder(action, orderRef)) continue;
        actions.splice(i, 1);
        removed++;
    }
    return removed;
}

/**
 * @param {Array} [actions]
 * @returns {{slotIds: Set<string>, orderIds: Set<string>}}
 */
function _buildUpdateSelectors(actions: any) {
    const selectors = {
        slotIds: new Set(),
        orderIds: new Set()
    };

    if (!Array.isArray(actions)) return selectors;

    for (const action of actions) {
        if (action?.type !== COW_ACTIONS.UPDATE) continue;
        if (action.id) selectors.slotIds.add(String(action.id));
        if (action.newGridId) selectors.slotIds.add(String(action.newGridId));
        if (action.orderId) selectors.orderIds.add(String(action.orderId));
    }

    return selectors;
}

/**
 * @param {{slotIds: Set<string>, orderIds: Set<string>}|null} selectors
 * @param {Object} [current]
 * @param {string} [id]
 * @returns {boolean}
 */
function _hasExplicitUpdateForOrder(selectors: any, current: any, id: any) {
    if (!selectors) return false;

    if (id && selectors.slotIds.has(String(id))) {
        return true;
    }

    const orderId = current?.orderId;
    return !!orderId && selectors.orderIds.has(String(orderId));
}

/**
 * @param {Object} current
 * @param {Object} targetOrder
 * @param {number} resultSize
 * @param {string} resultState
 * @param {string|null} resultOrderId
 * @returns {boolean}
 */
function _isProjectionUnchanged(current: any, targetOrder: any, resultSize: any, resultState: any, resultOrderId: any) {
    if (current.price === targetOrder.price &&
        current.type === targetOrder.type &&
        current.state === resultState &&
        current.size === resultSize &&
        current.orderId === resultOrderId) {
        return true;
    }
    return false;
}

/**
 * Project target grid into working grid
 * @param {any} workingGrid - Working grid to modify
 * @param {Map} targetGrid - Target state
 * @param {Object} [options] - Optional parameters
 * @param {Array} [options.actions] - Pre-existing COW actions to consider
 * @returns {void}
 */
function projectTargetToWorkingGrid(workingGrid: any, targetGrid: any, options: Record<string, any> = {}) {
    const updateSelectors = _buildUpdateSelectors(options.actions);
    const targetIds = new Set();

    for (const [id, targetOrder] of targetGrid.entries()) {
        targetIds.add(id);

        const current = workingGrid.get(id);
        const targetSize = toFiniteNumber(targetOrder?.size);

        if (!current) {
            // New orders start as VIRTUAL - transition to ACTIVE happens in synchronizeWithChain
            // after blockchain confirms placement. This ensures accounting deduction occurs.
            workingGrid.set(id, {
                ...targetOrder,
                size: Math.max(0, targetSize),
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            });
            continue;
        }

        if (targetSize > 0) {
            const keepOrderId = isOrderOnChain(current) && current.type === targetOrder.type;
            const hasExplicitUpdate = _hasExplicitUpdateForOrder(updateSelectors, current, id);
            // Orders without on-chain ID remain VIRTUAL until synchronizeWithChain
            // confirms blockchain placement and triggers accounting deduction.
            //
            // Preserve actual on-chain size for any unchanged on-chain order (ACTIVE/PARTIAL)
            // unless there is an explicit UPDATE action for this slot/order.
            // This prevents synthetic target sizes from being committed when no
            // blockchain update operation will be broadcast.
            const shouldPreserveSize = keepOrderId && !hasExplicitUpdate;
            const preservedSize = shouldPreserveSize
                ? Math.max(0, toFiniteNumber(current.size))
                : targetSize;
            const resultState = keepOrderId ? current.state : ORDER_STATES.VIRTUAL;
            const resultOrderId = keepOrderId ? current.orderId : null;
            if (!_isProjectionUnchanged(current, targetOrder, preservedSize, resultState, resultOrderId)) {
                workingGrid.set(id, {
                    ...current,
                    ...targetOrder,
                    size: preservedSize,
                    state: resultState,
                    orderId: resultOrderId
                });
            }
        } else {
            if (!_isProjectionUnchanged(current, targetOrder, 0, ORDER_STATES.VIRTUAL, null)) {
                workingGrid.set(id, {
                    ...current,
                    ...targetOrder,
                    size: 0,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: null
                });
            }
        }
    }

    for (const [id, current] of workingGrid.entries()) {
        if (targetIds.has(id)) continue;
        if (isOrderOnChain(current)) {
            workingGrid.set(id, convertToSpreadPlaceholder(current));
        }
    }
}

/**
 * Build optimistic state updates from rebalance actions
 * @param {Array<Object>} actions - Array of rebalance action objects
 * @param {Map} masterGrid - Master grid Map containing current order states
 * @returns {Array<Object>} State update objects for optimistic rendering
 */
function buildStateUpdates(actions: any, masterGrid: any) {
    const stateUpdates: any[] = [];

    for (const action of actions) {
        if (action.type === COW_ACTIONS.CREATE) {
            stateUpdates.push({ 
                ...action.order, 
                state: ORDER_STATES.VIRTUAL, 
                orderId: null 
            });
        } else if (action.type === COW_ACTIONS.CANCEL) {
            const masterOrder = masterGrid.get(action.id);
            if (masterOrder) {
                stateUpdates.push(convertToSpreadPlaceholder(masterOrder));
            }
        } else if (action.type === COW_ACTIONS.UPDATE) {
            const masterOrder = masterGrid.get(action.id);
            if (masterOrder) {
                const newSize = toFiniteNumber(action.newSize ?? action.order?.size);
                stateUpdates.push({ ...masterOrder, size: newSize });
            }
        }
    }

    return stateUpdates;
}

/**
 * Build an aborted COW result
 * @param {string} reason - Abort reason
 * @returns {Object} Aborted result object
 */
function buildAbortedResult(reason: any) {
    return {
        actions: [],
        stateUpdates: [],
        hadRotation: false,
        workingGrid: null,
        workingIndexes: null,
        workingBoundary: null,
        planningDuration: 0,
        aborted: true,
        reason
    };
}

/**
 * Build successful COW result
 * @param {Object} params - Result parameters
 * @returns {Object} Success result object
 */
function buildSuccessResult({
    actions,
    stateUpdates,
    workingGrid,
    workingBoundary,
    planningDuration
}: any) {
    return {
        actions,
        stateUpdates,
        hadRotation: actions.some((a: any) => a.type === COW_ACTIONS.CREATE || a.type === COW_ACTIONS.UPDATE),
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary,
        planningDuration,
        aborted: false
    };
}

/**
 * Evaluate if a working grid can be committed
 * @param {WorkingGrid} workingGrid - Grid to evaluate
 * @param {Object} options - Evaluation options
 * @returns {Object} Evaluation result
 */
function evaluateCommit(workingGrid: any, options: any = {}) {
    const hasLock = typeof options === 'boolean' ? options : !!options?.hasLock;
    const currentVersion = toFiniteNumber(options?.currentVersion, null);
    const masterGrid = typeof options === 'object' ? options.masterGrid : null;

    if (!workingGrid) {
        return {
            canCommit: false,
            reason: 'No working grid to commit',
            level: 'error'
        };
    }

    if (workingGrid.isStale()) {
        return {
            canCommit: false,
            reason: `Refusing stale working grid commit${hasLock ? ' (under lock)' : ''}: ${workingGrid.getStaleReason() || 'Master grid changed during planning'}`,
            level: 'warn'
        };
    }

    const baseVersion = workingGrid.baseVersion;

    if (baseVersion === null || baseVersion === undefined) {
        return {
            canCommit: false,
            reason: 'Working grid has no base version',
            level: 'error'
        };
    }

    if (currentVersion !== null && isValidNumber(baseVersion) && Number(baseVersion) !== currentVersion) {
        return {
            canCommit: false,
            reason: `Refusing working grid commit: base version ${Number(baseVersion)} != current ${currentVersion}`,
            level: 'warn'
        };
    }

    if (masterGrid && typeof workingGrid.buildDelta === 'function') {
        const delta = workingGrid.buildDelta(masterGrid, {
            precisions: options?.comparePrecisions || null
        });
        if (Array.isArray(delta) && delta.length === 0) {
            return {
                canCommit: false,
                reason: 'Delta empty at commit - nothing to commit',
                level: 'debug'
            };
        }
    }

    if (hasLock) {
        const stats = workingGrid.getMemoryStats();
        if (stats.size === 0) {
            return {
                canCommit: false,
                reason: 'Working grid is empty',
                level: 'warn'
            };
        }
    }

    return { canCommit: true };
}

// ===============================================================================
// EXPORTS
// ===============================================================================

export { validateOrder, validateGridForPersistence, validateWorkingGridFunds, checkFundDrift, reconcileGrid, optimizeRebalanceActions, hasExecutableActions, validateCreateTargetSlots, hasActionForOrder, removeActionsForOrder, projectTargetToWorkingGrid, buildStateUpdates, buildAbortedResult, buildSuccessResult, evaluateCommit }

