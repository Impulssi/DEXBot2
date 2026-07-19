/**
 * modules/order/grid_reconcile_internal.ts - Internal helpers for grid reconciliation
 *
 * Extracted from grid_reconcile.ts for file-size management.
 * All helpers are prefixed with _ and are NOT part of the public API.
 */

const { ORDER_TYPES, ORDER_STATES, TIMING, BTS_PRECISION } = require('../constants');
const { getMinAbsoluteOrderSize, getAssetFees, blockchainToFloat, calculatePriceTolerance } = require('./utils/math');
const { isOrderPlaced, parseChainOrder, buildCreateOrderArgs, isOrderOnChain, buildOutsideInPairGroups, extractBatchOperationResults } = require('./utils/order');
const { resolveAccountRef } = require('./utils/system');
const Format = require('./format');

const SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER = 5;

/**
 * Count active orders on the grid for a given type.
 * @param {Object} manager - OrderManager instance.
 * @param {string} type - ORDER_TYPES value.
 * @returns {number} Count of active and partial orders with orderId.
 * @private
 */
function _countActiveOnGrid(manager: any, type: any): number {
    const active = manager.getOrdersByTypeAndState(type, ORDER_STATES.ACTIVE).filter((o: any) => o && o.orderId);
    const partial = manager.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL).filter((o: any) => o && o.orderId);
    return active.length + partial.length;
}

/**
 * Pick virtual slots to activate based on type and count.
 * @param {Object} manager - OrderManager instance.
 * @param {string} type - ORDER_TYPES value.
 * @param {number} count - Number of slots to pick.
 * @returns {Array<Object>} Array of picked virtual slots.
 * @private
 */
function _pickVirtualSlotsToActivate(manager: any, type: any, count: any): any[] {
    if (count <= 0) return [];

    // CRITICAL FIX: Filter by type BEFORE sorting
    // Only get slots of the requested type (SELL or BUY), not a mix
    const slotsOfType = (Array.from(manager.orders.values()) as any[])
        .filter((slot: any) => slot && slot.type === type)
        .sort((a: any, b: any) => type === ORDER_TYPES.BUY ? b.price - a.price : a.price - b.price);

    let effectiveMin = 0;
    try {
        effectiveMin = getMinAbsoluteOrderSize(type, manager.assets);
    } catch (e: any) { effectiveMin = 0; }

    const valid: any[] = [];
    for (const slot of slotsOfType) {
        if (valid.length >= count) break;
        if (!slot.orderId && slot.state === ORDER_STATES.VIRTUAL) {
            // Role invariant: Only pick slots that make sense for this type based on current market pivot
            // (Strategy will enforce this strictly, but we filter here for cleaner activation)
            if (slot.id && (Number(slot.size) || 0) >= effectiveMin) {
                valid.push(slot);
            }
        }
    }

    return valid;
}

function _getStartupSideComparators(orderType: any, assets: any): { sortUpdateComparator: (a: any, b: any) => number; sortExcessCancelComparator: (a: any, b: any) => number; sortMatchedCancelComparator: (a: any, b: any) => number } {
    const isSell = orderType === ORDER_TYPES.SELL;

    const sortUpdateComparator = isSell
        ? (a, b) => (parseChainOrder(a, assets)?.price || 0) - (parseChainOrder(b, assets)?.price || 0)
        : (a, b) => (parseChainOrder(b, assets)?.price || 0) - (parseChainOrder(a, assets)?.price || 0);

    const sortExcessCancelComparator = isSell
        ? (a, b) => (b.parsed.price || 0) - (a.parsed.price || 0)
        : (a, b) => (a.parsed.price || 0) - (b.parsed.price || 0);

    const sortMatchedCancelComparator = isSell
        ? (a, b) => (b.price || 0) - (a.price || 0)
        : (a, b) => (a.price || 0) - (b.price || 0);

    return {
        sortUpdateComparator,
        sortExcessCancelComparator,
        sortMatchedCancelComparator,
    };
}

/**
 * Detect if grid edge is fully occupied with active orders.
 * When all outermost (furthest from market) orders are ACTIVE with orderId,
 * we're at grid edge and all balance is committed to those orders.
 *
 * @param {Object} manager - OrderManager instance
 * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {number} updateCount - Number of orders being updated
 * @returns {boolean} true if edge orders are all active
 * @private
 */
function _isGridEdgeFullyActive(manager: any, orderType: any, updateCount: any): boolean {
    if (!manager || updateCount <= 0) return false;

    // Get all orders of this type
    const allOrders: any[] = (Array.from(manager.orders.values()) as any[]).filter((o: any) => o.type === orderType);
    if (allOrders.length === 0) return false;

    // Sort: for BUY (highest to lowest price), for SELL (lowest to highest)
    // This puts market edge first, grid edge (furthest) last
    const sorted = orderType === ORDER_TYPES.BUY
        ? allOrders.sort((a: any, b: any) => (b.price || 0) - (a.price || 0))  // Buy: high to low price
        : allOrders.sort((a: any, b: any) => (a.price || 0) - (b.price || 0));  // Sell: low to high price

    // Get the outermost orders (last N in sorted = furthest from market)
    const outerEdgeCount = Math.min(updateCount, sorted.length);
    const edgeOrders = sorted.slice(-outerEdgeCount);

    // Check if ALL edge orders are ACTIVE (placed on blockchain)
    // Empty array check prevents vacuous truth: every([]) returns true
    if (edgeOrders.length === 0) return false;
    const allEdgeActive = edgeOrders.every((o: any) => isOrderPlaced(o));

    return allEdgeActive;
}

/**
 * Find the largest order among those being updated.
 * Returns both the order and its index in unmatchedOrders for pairing with gridOrders.
 * @param {Array<Object>} unmatchedOrders - Array of unmatched on-chain orders
 * @param {number} updateCount - Number of orders being updated (first N)
 * @returns {{order: Object, index: number}|null} Largest order and its index, or null if none found
 * @private
 */
function _findLargestOrder(unmatchedOrders: any, updateCount: any): { order: any; index: number } | null {
    if (!Array.isArray(unmatchedOrders) || unmatchedOrders.length === 0) return null;

    const ordersToCheck = unmatchedOrders.slice(0, updateCount);
    let largestOrder = null;
    let largestIndex = -1;
    let largestSize = 0;

    for (let i = 0; i < ordersToCheck.length; i++) {
        const order = ordersToCheck[i];
        const size = Number(order.for_sale) || 0;
        if (size > largestSize) {
            largestSize = size;
            largestOrder = order;
            largestIndex = i;
        }
    }

    return largestIndex >= 0 ? { order: largestOrder, index: largestIndex } : null;
}

/**
 * Cancel the largest unmatched order to free up maximum funds.
 * This is more efficient than reducing to size 1 and then updating twice.
 * Returns the grid slot index and grid order that needs to be filled.
 * @param {Object} params - Destructured parameters
 * @param {Function} params.chainOrders - Chain order query function
 * @param {string} params.account - Account ID or name
 * @param {string} params.privateKey - Active/owner private key
 * @param {Object} params.manager - OrderManager instance
 * @param {Array<Object>} params.unmatchedOrders - Unmatched on-chain orders
 * @param {number} params.updateCount - Number of orders being updated
 * @param {string} params.orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
 * @param {boolean} params.dryRun - If true, skip actual cancellation
 * @returns {Promise<{gridIndex: number, gridOrder: Object}|null>} Grid slot info or null
 * @private
 */
async function _cancelLargestOrder({ chainOrders, account, privateKey, manager, unmatchedOrders, updateCount, orderType, dryRun }: { chainOrders: any; account: any; privateKey: any; manager: any; unmatchedOrders: any; updateCount: any; orderType: any; dryRun: any; }): Promise<{ index: number; orderType: any } | null> {
    if (dryRun) return null;
    if (!Array.isArray(unmatchedOrders) || unmatchedOrders.length === 0) return null;

    const logger = manager && manager.logger;

    // Find the largest order among those being updated
    const largestInfo = _findLargestOrder(unmatchedOrders, updateCount);
    if (!largestInfo) return null;

    const { order: largestOrder, index: largestIndex } = largestInfo;
    const originalSize = Number(largestOrder.for_sale) || 0;
    const orderId = largestOrder.id;

    logger?.log?.(
        `Grid edge detected: cancelling largest order ${orderId} (size ${originalSize}) to free up funds`,
        'info'
    );

    try {
        // Cancel the largest order on blockchain and release untracked funds.
        await _cancelChainOrder({
            chainOrders,
            account,
            privateKey,
            manager,
            chainOrderId: orderId,
            chainOrderObj: largestOrder,
            releaseUntrackedFunds: true,
            dryRun,
        });
        logger?.log?.(`Cancelled largest order ${orderId}`, 'info');

        // Mark for removal from unmatched list (handled by caller)
        // Return info needed to create this order fresh later
        return { index: largestIndex, orderType };
    } catch (err: any) {
        logger?.log?.(`Warning: Could not cancel largest order ${orderId}: ${err.message}`, 'warn');
        return null;
    }
}

/**
 * Create a new chain order from a grid slot.
 * @param {Object} params - Creation parameters.
 * @param {Object} params.chainOrders - Chain orders module.
 * @param {string} params.account - Account name.
 * @param {string} params.privateKey - Private key.
 * @param {Object} params.manager - OrderManager instance.
 * @param {Object} params.gridOrder - Grid order object.
 * @param {boolean} params.dryRun - Whether to simulate.
 * @returns {Promise<void>}
 * @private
 */
async function _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun }: { chainOrders: any; account: any; privateKey: any; manager: any; gridOrder: any; dryRun: any; }): Promise<void> {
    if (dryRun) return;

    // ATOMIC RE-VERIFICATION: Ensure slot is still virtual and hasn't been filled by recovery sync
    const currentSlot = manager.orders.get(gridOrder.id);
    if (currentSlot && currentSlot.orderId) {
        manager.logger?.log?.(`[_createOrderFromGrid] SKIP: Slot ${gridOrder.id} already has orderId ${currentSlot.orderId}`, 'warn');
        return;
    }

    const { amountToSell, sellAssetId, minToReceive, receiveAssetId } = buildCreateOrderArgs(
        gridOrder,
        manager.assets.assetA,
        manager.assets.assetB
    );

    const result = await chainOrders.createOrder(
        account,
        privateKey,
        amountToSell,
        sellAssetId,
        minToReceive,
        receiveAssetId,
        null,
        false
    );

    if (result && result.skipped) {
        const logger = manager && manager.logger;
        logger?.log?.(`[_createOrderFromGrid] Skipped slot ${gridOrder.id}: order amounts too small to place on-chain`, 'warn');
        return;
    }

    const operationResults = extractBatchOperationResults(result) || [];
    const chainOrderId = operationResults[0] && operationResults[0][1];

    if (chainOrderId) {
        const btsFeeData = getAssetFees('BTS');

        // Centralized Fund Tracking: Use manager's sync core to handle state transition and fund deduction
        // CRITICAL: Use _applySync (lock-free) since caller holds _gridLock
        await manager._applySync({
            gridOrderId: gridOrder.id,
            chainOrderId,
            isPartialPlacement: false,
            fee: btsFeeData.createFee
        }, 'createOrder', { gridLockAlreadyHeld: true });
    } else {
        // CRITICAL FIX: Recovery sync if order extraction fails
        const logger = manager && manager.logger;
        logger?.log?.(`[_createOrderFromGrid] CRITICAL: createOrder succeeded but chainOrderId extraction failed`, 'error');
        try {
            const freshChainOrders = await chainOrders.readOpenOrders(
                resolveAccountRef(manager, account),
                TIMING.CONNECTION_TIMEOUT_MS
            );
            // CRITICAL FIX: Use skipAccounting: false - order discovery must update accounting
            // Orphan order requires fund deduction to prevent phantom capital
            await manager.syncFromOpenOrders(freshChainOrders, {
                skipAccounting: false,
                source: 'chainOrderIdExtractionFailure',
                gridLockAlreadyHeld: true,
            });
        } catch (syncErr: any) {
            logger?.log?.(`[_createOrderFromGrid] Recovery sync failed: ${syncErr.message}`, 'error');
        }
    }
}

/**
 * Cancel a chain order and sync with manager.
 * @param {Object} params - Cancellation parameters.
 * @param {Object} params.chainOrders - Chain orders module.
 * @param {string} params.account - Account name.
 * @param {string} params.privateKey - Private key.
 * @param {Object} params.manager - OrderManager instance.
 * @param {string} params.chainOrderId - ID of the chain order to cancel.
 * @param {boolean} params.dryRun - Whether to simulate.
 * @param {Object} [params.chainOrderObj] - Raw chain order object (needed for fund release).
 * @param {boolean} [params.releaseUntrackedFunds=false] - If true, release the cancelled order's
 *   committed funds via addToChainFree. Use only for unmatched chain orders that have no
 *   corresponding ACTIVE/PARTIAL grid slot (where synchronizeWithChain cannot release them).
 * @returns {Promise<void>}
 * @private
 */
async function _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId, dryRun, chainOrderObj, releaseUntrackedFunds = false }: { chainOrders: any; account: any; privateKey: any; manager: any; chainOrderId: any; dryRun: any; chainOrderObj: any; releaseUntrackedFunds?: boolean; }): Promise<void> {
    if (dryRun) return;

    const cancelResult = await chainOrders.cancelOrder(account, privateKey, chainOrderId);
    if (cancelResult?.verifiedAfterFailure) {
        const freshChainOrders = await chainOrders.readOpenOrders(
            resolveAccountRef(manager, account),
            TIMING.CONNECTION_TIMEOUT_MS
        );
        await manager.syncFromOpenOrders(freshChainOrders, {
            skipAccounting: false,
            source: 'cancelOrder',
            gridLockAlreadyHeld: true,
        });
    } else {
        // CRITICAL: Use _applySync (lock-free) since caller holds _gridLock
        await manager._applySync({ orderId: chainOrderId }, 'cancelOrder', { gridLockAlreadyHeld: true });
    }

    // Unmatched chain orders are not represented as ACTIVE/PARTIAL grid slots, so
    // synchronizeWithChain('cancelOrder') cannot release their commitment.
    if (releaseUntrackedFunds && manager.accountant && chainOrderObj) {
        const parsed = parseChainOrder(chainOrderObj, manager.assets);
        if (parsed && parsed.size > 0) {
            await manager.accountant.addToChainFree(parsed.type, parsed.size, 'startup-cancel-unmatched');
        }
    }
}

async function _recoverStartupSyncFailure({ chainOrders, manager, account, logger, triggerMessage, source }: { chainOrders: any; manager: any; account: any; logger: any; triggerMessage: any; source: any; }): Promise<any> {
    try {
        logger?.log?.(triggerMessage, 'warn');
        const freshChainOrders = await chainOrders.readOpenOrders(
            resolveAccountRef(manager, account),
            TIMING.CONNECTION_TIMEOUT_MS
        );
        await manager.syncFromOpenOrders(freshChainOrders, {
            skipAccounting: false,
            source,
            gridLockAlreadyHeld: true,
        });
        return freshChainOrders;
    } catch (syncErr: any) {
        logger?.log?.(`Startup: Recovery sync failed: ${syncErr.message}`, 'error');
        return null;
    }
}

function _refreshStartupUpdatePlans(updatePlans: any, chainOpenOrders: any): any[] {
    if (!Array.isArray(updatePlans) || updatePlans.length === 0) return [];
    const chainById = new Map(
        (Array.isArray(chainOpenOrders) ? chainOpenOrders : [])
            .filter(o => o && o.id)
            .map(o => [o.id, o])
    );

    const refreshed = [];
    for (const plan of updatePlans) {
        if (!plan?.chainOrderId || !plan?.gridOrder?.id) continue;
        const freshChainOrder = chainById.get(plan.chainOrderId);
        if (!freshChainOrder) continue;
        refreshed.push({
            ...plan,
            chainOrderObj: freshChainOrder,
        });
    }
    return refreshed;
}

function _prepareStartupUpdatePlan(plan: any, manager: any, logger: any): any {
    const chainOrderId = plan?.chainOrderId;
    const gridOrder = plan?.gridOrder;
    if (!chainOrderId || !gridOrder?.id) return null;

    const currentSlot = manager.orders.get(gridOrder.id);
    if (!currentSlot || (currentSlot.orderId && currentSlot.orderId !== chainOrderId)) {
        logger?.log?.(`Startup: Skip update ${chainOrderId} -> ${gridOrder.id}; slot already mapped (${currentSlot?.orderId || 'none'})`, 'warn');
        return null;
    }
    if (currentSlot.orderId === chainOrderId) {
        logger?.log?.(`Startup: Skip update ${chainOrderId} -> ${gridOrder.id}; slot already matched`, 'debug');
        return null;
    }

    const { amountToSell, minToReceive } = buildCreateOrderArgs(
        gridOrder,
        manager.assets.assetA,
        manager.assets.assetB
    );

    return {
        plan,
        chainOrderId,
        gridOrder,
        parsedChain: parseChainOrder(plan.chainOrderObj, manager.assets),
        updateParams: {
            newPrice: gridOrder.price,
            amountToSell,
            minToReceive,
            orderType: gridOrder.type,
        }
    };
}

async function _finalizeStartupUpdate({ manager, preparedUpdate }: { manager: any; preparedUpdate: any }): Promise<void> {
    const { plan, parsedChain } = preparedUpdate;
    if (parsedChain && parsedChain.size > 0 && manager.accountant) {
        await manager.accountant.addToChainFree(plan.gridOrder.type, parsedChain.size, 'startup-align');
    }

    // Extract deferred_fee from the raw chain order object so the fee
    // lifecycle (cancel refunds, fill maker discounts) reconstructs
    // the correct btsFeeState after a grid reset.
    // deferred_fee from chain is in raw satoshis (BTS precision 5).
    // The fee lifecycle operates in float BTS units, so convert here.
    const rawDeferredFee = Format.toFiniteNumber(plan.chainOrderObj?.deferred_fee, null);
    const deferredFeeFloat = rawDeferredFee !== null ? blockchainToFloat(rawDeferredFee, BTS_PRECISION) : null;

    const btsFeeData = getAssetFees('BTS');
    await manager._applySync({
        gridOrderId: plan.gridOrder.id,
        chainOrderId: plan.chainOrderId,
        isPartialPlacement: false,
        fee: btsFeeData.updateFee,
        skipAccounting: false,
        deferredFee: deferredFeeFloat,
    }, 'createOrder', { gridLockAlreadyHeld: true });
}

async function _executeStartupUpdateBatch({
    updatePlans,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}: {
    updatePlans: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
}): Promise<{ executed: boolean; prepared: number; skipped: boolean }> {
    if (!Array.isArray(updatePlans) || updatePlans.length === 0 || dryRun) {
        return { executed: false, prepared: 0, skipped: true };
    }

    if (typeof chainOrders?.buildUpdateOrderOp !== 'function' || typeof chainOrders?.executeBatch !== 'function') {
        throw new Error('chainOrders does not support batch update operations');
    }

    const logger = manager?.logger;
    const prepared = [];

    for (const plan of updatePlans) {
        const preparedPlan = _prepareStartupUpdatePlan(plan, manager, logger);
        if (!preparedPlan) continue;

        const buildResult = await chainOrders.buildUpdateOrderOp(
            account,
            preparedPlan.chainOrderId,
            preparedPlan.updateParams,
            plan.chainOrderObj || null
        );

        if (!buildResult) {
            logger?.log?.(`Startup: Skip update ${preparedPlan.chainOrderId} -> ${preparedPlan.gridOrder.id}; no blockchain delta`, 'debug');
            continue;
        }

        prepared.push({
            ...preparedPlan,
            op: buildResult.op,
        });
    }

    if (prepared.length === 0) {
        return { executed: false, prepared: 0, skipped: true };
    }

    logger?.log?.(`Startup: Broadcasting update batch (${prepared.length} op${prepared.length > 1 ? 's' : ''})`, 'info');
    await chainOrders.executeBatch(account, privateKey, prepared.map(p => p.op));

    for (const entry of prepared) {
        await _finalizeStartupUpdate({ manager, preparedUpdate: entry });
    }

    return { executed: true, prepared: prepared.length, skipped: false };
}

async function _executeStartupSingleUpdate({
    plan,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}: {
    plan: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
}): Promise<{ executed: boolean; skipped: boolean }> {
    if (dryRun) return { executed: false, skipped: true };
    if (typeof chainOrders?.updateOrder !== 'function') {
        throw new Error('chainOrders.updateOrder is required for sequential update fallback');
    }

    const logger = manager?.logger;
    const prepared = _prepareStartupUpdatePlan(plan, manager, logger);
    if (!prepared) return { executed: false, skipped: true };

    const result = await chainOrders.updateOrder(
        account,
        privateKey,
        prepared.chainOrderId,
        prepared.updateParams
    );

    if (!result) {
        logger?.log?.(`Startup: Skip update ${prepared.chainOrderId} -> ${prepared.gridOrder.id}; no blockchain delta`, 'debug');
        return { executed: false, skipped: true };
    }

    await _finalizeStartupUpdate({ manager, preparedUpdate: prepared });
    return { executed: true, skipped: false };
}

async function _executeStartupSequentialUpdateFallback({
    updatePlans,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}: {
    updatePlans: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
}): Promise<{ executed: number; skipped: number; failed: number }> {
    if (!Array.isArray(updatePlans) || updatePlans.length === 0 || dryRun) {
        return { executed: 0, skipped: 0, failed: 0 };
    }

    const logger = manager?.logger;
    let queue = updatePlans.slice(0);
    let executed = 0;
    let skipped = 0;
    let failed = 0;

    logger?.log?.(`Startup: Falling back to sequential updates for ${queue.length} pending order(s)`, 'warn');

    while (queue.length > 0) {
        const plan = queue.shift();
        if (!plan) continue;

        try {
            const result = await _executeStartupSingleUpdate({
                plan,
                chainOrders,
                account,
                privateKey,
                manager,
                dryRun,
            });

            if (result.executed) executed++;
            else skipped++;
        } catch (err: any) {
            failed++;
            logger?.log?.(`Startup: Sequential update failed for ${plan.chainOrderId} -> ${plan.gridOrderId || plan.gridOrder?.id}: ${err.message}`, 'error');

            const refreshedChainOrders = await _recoverStartupSyncFailure({
                chainOrders,
                manager,
                account,
                logger,
                triggerMessage: `Startup: Triggering recovery sync after sequential update failure for ${plan.chainOrderId}`,
                source: 'startupReconcileSequentialUpdateFailure',
                });

            queue = _refreshStartupUpdatePlans(queue, refreshedChainOrders);
        }
    }

    return { executed, skipped, failed };
}

async function _createStartupOrderWithHandling({
    chainOrders,
    account,
    privateKey,
    manager,
    gridOrder,
    orderLabel,
    dryRun,
    recovery,
}: {
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    gridOrder: any;
    orderLabel: any;
    dryRun: any;
    recovery: any;
}): Promise<void> {
    try {
        await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun });
    } catch (err: any) {
        manager?.logger?.log?.(`Startup: Failed to create ${orderLabel}: ${err.message}`, 'error');

        if (recovery && recovery.triggerMessage && recovery.source) {
            await _recoverStartupSyncFailure({
                chainOrders,
                manager,
                account,
                logger: manager?.logger,
                triggerMessage: recovery.triggerMessage,
                source: recovery.source,
                });
        }
    }
}

// _extractBatchOperationResults — thin wrapper over shared utility,
// returns empty array (not null) for callers that iterate directly.
function _extractBatchOperationResults(result: any): any[] {
    return extractBatchOperationResults(result) || [];
}

function _resolveGroupRecovery(group: any, fallbackMessage: any, fallbackSource: any): { triggerMessage: any; source: any } {
    for (const plan of group || []) {
        if (plan?.recovery?.triggerMessage && plan?.recovery?.source) {
            return { triggerMessage: plan.recovery.triggerMessage, source: plan.recovery.source };
        }
    }
    return { triggerMessage: fallbackMessage, source: fallbackSource };
}

async function _executeStartupCreateGroupBatch({
    group,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
    groupIndex,
    totalGroups,
}: {
    group: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
    groupIndex: any;
    totalGroups: any;
}): Promise<void> {
    if (!Array.isArray(group) || group.length === 0 || dryRun) return;
    if (typeof chainOrders?.buildCreateOrderOp !== 'function' || typeof chainOrders?.executeBatch !== 'function') {
        throw new Error('chainOrders does not support batch create operations');
    }

    const logger = manager?.logger;
    const prepared = [];

    for (const plan of group) {
        const gridOrder = plan?.gridOrder;
        if (!gridOrder || !gridOrder.id) continue;

        const currentSlot = manager.orders.get(gridOrder.id);
        if (currentSlot?.orderId) {
            logger?.log?.(`Startup: Skip create ${plan.orderLabel} - slot ${gridOrder.id} already has orderId ${currentSlot.orderId}`, 'warn');
            continue;
        }

        const { amountToSell, sellAssetId, minToReceive, receiveAssetId } = buildCreateOrderArgs(
            gridOrder,
            manager.assets.assetA,
            manager.assets.assetB
        );

        const buildResult = await chainOrders.buildCreateOrderOp(
            account,
            amountToSell,
            sellAssetId,
            minToReceive,
            receiveAssetId,
            null
        );

        if (!buildResult) {
            logger?.log?.(`Startup: Skip create ${plan.orderLabel} - order amounts too small to place on-chain`, 'warn');
            continue;
        }

        prepared.push({ plan, op: buildResult.op });
    }

    if (prepared.length === 0) return;

    const recovery = _resolveGroupRecovery(
        group,
        `Startup: Triggering recovery sync after create group ${groupIndex + 1}/${totalGroups} failure`,
        'startupCreateGroupFailure'
    );

    try {
        logger?.log?.(
            `Startup: Broadcasting create group ${groupIndex + 1}/${totalGroups} in single batch (${prepared.length} op${prepared.length > 1 ? 's' : ''})`,
            'info'
        );

        const batchResult = await chainOrders.executeBatch(account, privateKey, prepared.map(p => p.op));
        const opResults = _extractBatchOperationResults(batchResult);
        const btsFeeData = getAssetFees('BTS');

        let missingChainOrderId = false;
        for (let i = 0; i < prepared.length; i++) {
            const chainOrderId = opResults[i] && opResults[i][1];
            const plan = prepared[i].plan;
            if (!chainOrderId) {
                logger?.log?.(`Startup: create result missing chainOrderId for ${plan.orderLabel}`, 'error');
                missingChainOrderId = true;
                continue;
            }

            await manager._applySync({
                gridOrderId: plan.gridOrder.id,
                chainOrderId,
                isPartialPlacement: false,
                fee: btsFeeData.createFee
            }, 'createOrder', { gridLockAlreadyHeld: true });
        }

        if (missingChainOrderId) {
            await _recoverStartupSyncFailure({
                chainOrders,
                manager,
                account,
                logger,
                triggerMessage: recovery.triggerMessage,
                source: recovery.source,
                });
        }
    } catch (err: any) {
        logger?.log?.(`Startup: Failed to create group ${groupIndex + 1}/${totalGroups}: ${err.message}`, 'error');
        await _recoverStartupSyncFailure({
            chainOrders,
            manager,
            account,
            logger,
            triggerMessage: recovery.triggerMessage,
            source: recovery.source,
        });
    }
}

function _buildOutsideInCreateGroups(createPlans: any): any[] {
    return buildOutsideInPairGroups(createPlans, {
        isValid: p => Boolean(p?.gridOrder),
        getType: p => p.orderType,
        getPrice: p => p.gridOrder?.price,
    });
}

async function _executePlannedStartupCreates({
    createPlans,
    chainOrders,
    account,
    privateKey,
    manager,
    dryRun,
}: {
    createPlans: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
}): Promise<void> {
    const logger = manager?.logger;
    const groups = _buildOutsideInCreateGroups(createPlans);
    if (groups.length === 0) return;

    logger?.log?.(`Startup: Executing ${createPlans.length} planned create(s) in ${groups.length} outside->center group(s)`, 'info');

    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const labels = group.map(p => `${p.orderType.toUpperCase()}:${p.gridOrder?.id}`).join(', ');
        logger?.log?.(`Startup: Create group ${i + 1}/${groups.length} (${labels})`, 'info');

        const canBatchCreate = typeof chainOrders?.buildCreateOrderOp === 'function' && typeof chainOrders?.executeBatch === 'function';
        if (group.length > 1 && canBatchCreate) {
            await _executeStartupCreateGroupBatch({
                group,
                chainOrders,
                account,
                privateKey,
                manager,
                dryRun,
                groupIndex: i,
                totalGroups: groups.length,
                });
            continue;
        }

        if (group.length > 1 && !canBatchCreate) {
            logger?.log?.('Startup: Batch create helpers unavailable; falling back to sequential creates for this group', 'warn');
        }

        for (const plan of group) {
            await _createStartupOrderWithHandling({
                chainOrders,
                account,
                privateKey,
                manager,
                gridOrder: plan.gridOrder,
                orderLabel: plan.orderLabel,
                dryRun,
                recovery: plan.recovery,
                });
        }
    }
}

async function _reconcileStartupSide({
    orderType,
    targetCount,
    chainSideOrders,
    unmatchedSideOrders,
    manager,
    chainOrders,
    account,
    privateKey,
    dryRun,
    plannedCreates,
    plannedUpdates,
}: {
    orderType: any;
    targetCount: any;
    chainSideOrders: any;
    unmatchedSideOrders: any;
    manager: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    dryRun: any;
    plannedCreates: any;
    plannedUpdates: any;
}): Promise<{ chainCount: any }> {
    const logger = manager?.logger;
    const sideUpper = orderType === ORDER_TYPES.SELL ? 'SELL' : 'BUY';
    const balanceKey = orderType === ORDER_TYPES.SELL ? 'sellFree' : 'buyFree';
    const balanceSymbol = orderType === ORDER_TYPES.SELL ? manager.assets.assetA.symbol : manager.assets.assetB.symbol;
    const {
        sortUpdateComparator,
        sortExcessCancelComparator,
        sortMatchedCancelComparator,
    } = _getStartupSideComparators(orderType, manager.assets);

    const matchedOnGrid = _countActiveOnGrid(manager, orderType);
    const neededSlots = Math.max(0, targetCount - matchedOnGrid);
    const desiredSlots = _pickVirtualSlotsToActivate(manager, orderType, neededSlots);

    const sortedUnmatched = unmatchedSideOrders.slice(0).sort(sortUpdateComparator);
    const updateCount = Math.min(sortedUnmatched.length, desiredSlots.length);
    let cancelledIndex = null;
    let projectedSideBalance = Number(manager.accountTotals?.[balanceKey] || 0);

    logger?.log?.(
        `Startup ${sideUpper}: matchedOnGrid=${matchedOnGrid}, needSlots=${neededSlots}, unmatched=${sortedUnmatched.length}, updates=${updateCount}`,
        'info'
    );

    if (updateCount > 0 && _isGridEdgeFullyActive(manager, orderType, updateCount)) {
        logger?.log?.(`Startup: ${sideUpper} grid edge is fully active, cancelling largest order to free funds`, 'info');
        const cancelInfo = await _cancelLargestOrder({
            chainOrders,
            account,
            privateKey,
            manager,
            unmatchedOrders: sortedUnmatched,
            updateCount,
            orderType,
            dryRun,
        });
        if (cancelInfo) cancelledIndex = cancelInfo.index;
    }

    for (let i = 0; i < updateCount; i++) {
        if (cancelledIndex !== null && i === cancelledIndex) continue;

        const chainOrder = sortedUnmatched[i];
        const gridOrder = desiredSlots[i];
        const gridSize = Number(gridOrder.size) || 0;
        const parsedChain = parseChainOrder(chainOrder, manager.assets);
        const currentSize = parsedChain ? parsedChain.size : 0;
        const sizeIncrease = Math.max(0, gridSize - currentSize);
        const currentAssetBalance = projectedSideBalance;

        if (sizeIncrease > currentAssetBalance) {
            logger?.log?.(
                `Startup: Skipping ${sideUpper} update ${chainOrder.id} - insufficient balance for increase (need +${Format.formatSizeByOrderType(sizeIncrease, orderType, manager.assets)} ${balanceSymbol}, have ${Format.formatSizeByOrderType(currentAssetBalance, orderType, manager.assets)} ${balanceSymbol})`,
                'warn'
            );
            continue;
        }

        logger?.log?.(
            `Startup: Updating chain ${sideUpper} ${chainOrder.id} -> grid ${gridOrder.id} (price=${Format.formatPrice6(gridOrder.price)}, size=${Format.formatSizeByOrderType(gridOrder.size, orderType, manager.assets)})`,
            'info'
        );

        plannedUpdates.push({
            orderType,
            chainOrderId: chainOrder.id,
            chainOrderObj: chainOrder,
            gridOrderId: gridOrder.id,
            gridOrder: { ...gridOrder },
        });

        projectedSideBalance += (currentSize - gridSize);
    }

    if (cancelledIndex !== null && !dryRun) {
        const targetGridOrder = desiredSlots[cancelledIndex];
        if (targetGridOrder) {
            logger?.log?.(
                `Startup: Creating new ${sideUpper} for cancelled slot at grid ${targetGridOrder.id} (price=${Format.formatPrice6(targetGridOrder.price)}, size=${Format.formatSizeByOrderType(targetGridOrder.size, orderType, manager.assets)})`,
                'info'
            );
            plannedCreates.push({
                orderType,
                gridOrder: targetGridOrder,
                orderLabel: `${sideUpper} for cancelled slot`,
                recovery: {
                    triggerMessage: `Startup: Triggering recovery sync after ${sideUpper} creation failure`,
                    source: 'phase3CreationFailure',
                },
            });
        }
    }

    const processedUnmatched = sortedUnmatched.slice(updateCount);
    const chainCount = chainSideOrders.length;
    const createCount = Math.max(0, targetCount - chainCount);
    const remainingSlots = desiredSlots.slice(updateCount);

    for (let i = 0; i < Math.min(createCount, remainingSlots.length); i++) {
        const gridOrder = remainingSlots[i];
        logger?.log?.(
            `Startup: Creating ${sideUpper} for grid ${gridOrder.id} (price=${Format.formatPrice6(gridOrder.price)}, size=${Format.formatSizeByOrderType(gridOrder.size, orderType, manager.assets)})`,
            'info'
        );
        plannedCreates.push({
            orderType,
            gridOrder,
            orderLabel: sideUpper,
            // Intentionally no recovery metadata here.
            // This preserves legacy behavior: regular virtual-slot creates only log failures,
            // while cancelled-slot replacement creates trigger a startup recovery sync.
        });
    }

    let cancelCount = Math.max(0, chainCount - targetCount);
    if (cancelCount > 0) {
        const parsedUnmatched = processedUnmatched
            .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed)
            .sort(sortExcessCancelComparator);

        for (const x of parsedUnmatched) {
            if (cancelCount <= 0) break;
            logger?.log?.(`Startup: Cancelling excess ${sideUpper} chain order ${x.chain.id}`, 'info');
            try {
                await _cancelChainOrder({
                    chainOrders,
                    account,
                    privateKey,
                    manager,
                    chainOrderId: x.chain.id,
                    chainOrderObj: x.chain,
                    releaseUntrackedFunds: true,
                    dryRun,
                });
                logger?.log?.(`Startup: Successfully cancelled excess ${sideUpper} order ${x.chain.id}`, 'info');
                cancelCount--;
            } catch (err: any) {
                logger?.log?.(`Startup: Failed to cancel ${sideUpper} ${x.chain.id}: ${err.message}`, 'error');
            }
        }

        if (cancelCount > 0) {
            const activeOrders = manager.getOrdersByTypeAndState(orderType, ORDER_STATES.ACTIVE)
                .filter(o => o && o.orderId)
                .sort(sortMatchedCancelComparator);

            for (const o of activeOrders) {
                if (cancelCount <= 0) break;
                logger?.log?.(`Startup: Cancelling excess matched ${sideUpper} ${o.orderId} (grid ${o.id})`, 'warn');
                try {
                    await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun, chainOrderObj: o });
                    logger?.log?.(`Startup: Successfully cancelled excess matched ${sideUpper} order ${o.orderId} (grid ${o.id})`, 'info');
                    cancelCount--;
                } catch (err: any) {
                    logger?.log?.(`Startup: Failed to cancel matched ${sideUpper} ${o.orderId}: ${err.message}`, 'error');
                }
            }
        }
    }

    return {
        chainCount,
    };
}

module.exports = {
    _countActiveOnGrid, _pickVirtualSlotsToActivate, _getStartupSideComparators,
    _isGridEdgeFullyActive, _findLargestOrder, _cancelLargestOrder,
    _createOrderFromGrid, _cancelChainOrder, _recoverStartupSyncFailure,
    _refreshStartupUpdatePlans, _prepareStartupUpdatePlan, _finalizeStartupUpdate,
    _executeStartupUpdateBatch, _executeStartupSingleUpdate,
    _executeStartupSequentialUpdateFallback, _createStartupOrderWithHandling,
    _extractBatchOperationResults, _resolveGroupRecovery,
    _executeStartupCreateGroupBatch, _buildOutsideInCreateGroups,
    _executePlannedStartupCreates, _reconcileStartupSide,
};
