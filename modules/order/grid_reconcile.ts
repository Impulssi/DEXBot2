/**
 * modules/order/grid_reconcile.ts - Grid Reconciliation Module
 *
 * Reconciles the local grid against the on-chain state. Used both at startup
 * (resume-from-persisted-grid) and from the maintenance runtime's targeted
 * drift reconciliation path.
 *
 * Renamed from startup_reconcile.ts — the function is a general grid/chain
 * reconciler, not a startup-only concern; maintenance depends on the same
 * logic. See modules/dexbot_maintenance_runtime.ts for the runtime caller.
 *
 * Purpose:
 * - Resume previously persisted grids from storage
 * - Match persisted grids with current blockchain state
 * - Reconcile VIRTUAL orders with actual open orders
 * - Activate appropriate orders based on blockchain state
 * - Detect and handle partial order dust
 * - Trigger rebalancing when needed
 *
 * ===============================================================================
 * EXPORTS (3 functions)
 * ===============================================================================
 *
 * PUBLIC FUNCTIONS:
 *   1. reconcileGridOrders(manager, logger) - Main reconciliation function (async)
 *      Reconciles blockchain orders with persisted grid, activates as needed
 *      Handles partial orders and triggers rebalancing if dust detected
 *      Returns null or rebalance result
 *
 *   2. attemptResumePersistedGridByPriceMatch(manager, persistedGrid) - Resume from storage (async)
 *      Matches persisted grid to current market state using price proximity
 *      Validates grid structure, locks/activates orders as appropriate
 *      Returns { success, reason, activatedIds } or { success: false, reason }
 *
 *   3. decideStartupGridAction(manager, chainOrders, persistedGrid) - Determine startup action
 *      Decides whether to resume persisted grid, create new grid, or abort
 *      Returns { action, reason } where action is 'resume', 'create_new', or 'abort'
 *
 * INTERNAL HELPERS:
 *   4. _countActiveOnGrid(manager, type) - Count active/partial orders by type
 *   5. _pickVirtualSlotsToActivate(manager, type, count) - Pick virtual slots for activation
 *   6. _isGridEdgeFullyActive(manager, orderType, updateCount) - Check if grid edge is fully active on one side
 *   7. _findLargestOrder(unmatchedOrders, updateCount) - Find the largest unmatched chain order
 *   8. _cancelLargestOrder({...}) - Cancel the largest unmatched chain order (async)
 *   9. _createOrderFromGrid({...}) - Create a new on-chain order from a grid slot (async)
 *   10. _cancelChainOrder({...}) - Cancel a specific on-chain order (async)
 *   11. _recoverStartupSyncFailure({...}) - Handle sync failure recovery at startup (async)
 *   12. _executeStartupUpdateBatch({...}) - Execute startup updates in one batch (async)
 *   13. _executeStartupSingleUpdate({...}) - Execute one startup update (async)
 *   14. _executeStartupSequentialUpdateFallback({...}) - Sequential backup after batch retries (async)
 *   15. _reconcileStartupSide({...}) - Reconcile one side (buy/sell) against chain at startup (async)
 *
 * ===============================================================================
 *
 * STARTUP FLOW:
 * 1. Load persisted grid from storage (if exists)
 * 2. Call decideStartupGridAction() to determine action
 * 3. If resume: attemptResumePersistedGridByPriceMatch()
 * 4. Call reconcileGridOrders() to sync with blockchain
 * 5. Activate appropriate orders
 * 6. Check for dust partials and trigger rebalancing if needed
 *
 * ===============================================================================
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
async function _cancelLargestOrder({ chainOrders, account, privateKey, manager, unmatchedOrders, updateCount, orderType, dryRun, fillLockAlreadyHeld = false }: { chainOrders: any; account: any; privateKey: any; manager: any; unmatchedOrders: any; updateCount: any; orderType: any; dryRun: any; fillLockAlreadyHeld?: boolean }): Promise<{ index: number; orderType: any } | null> {
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
            fillLockAlreadyHeld,
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
async function _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun, fillLockAlreadyHeld = false }: { chainOrders: any; account: any; privateKey: any; manager: any; gridOrder: any; dryRun: any; fillLockAlreadyHeld?: boolean }): Promise<void> {
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
                fillLockAlreadyHeld,
                protectCommittedOrders: true
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
async function _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId, dryRun, chainOrderObj, releaseUntrackedFunds = false, fillLockAlreadyHeld = false }: { chainOrders: any; account: any; privateKey: any; manager: any; chainOrderId: any; dryRun: any; chainOrderObj: any; releaseUntrackedFunds?: boolean; fillLockAlreadyHeld?: boolean }): Promise<void> {
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
            fillLockAlreadyHeld,
            protectCommittedOrders: true
        });
    } else {
        // CRITICAL: Use _applySync (lock-free) since caller holds _gridLock
        await manager._applySync(chainOrderId, 'cancelOrder', { gridLockAlreadyHeld: true });
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

async function _recoverStartupSyncFailure({ chainOrders, manager, account, logger, triggerMessage, source, fillLockAlreadyHeld = false }: { chainOrders: any; manager: any; account: any; logger: any; triggerMessage: any; source: any; fillLockAlreadyHeld?: boolean }): Promise<any> {
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
            fillLockAlreadyHeld,
            protectCommittedOrders: true
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
    fillLockAlreadyHeld = false,
}: {
    updatePlans: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
    fillLockAlreadyHeld?: boolean;
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
                fillLockAlreadyHeld,
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
    fillLockAlreadyHeld = false
}: {
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    gridOrder: any;
    orderLabel: any;
    dryRun: any;
    recovery: any;
    fillLockAlreadyHeld?: boolean;
}): Promise<void> {
    try {
        await _createOrderFromGrid({ chainOrders, account, privateKey, manager, gridOrder, dryRun, fillLockAlreadyHeld });
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
                fillLockAlreadyHeld,
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
    fillLockAlreadyHeld = false,
}: {
    group: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
    groupIndex: any;
    totalGroups: any;
    fillLockAlreadyHeld?: boolean;
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
                fillLockAlreadyHeld,
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
            fillLockAlreadyHeld,
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
    fillLockAlreadyHeld = false,
}: {
    createPlans: any;
    chainOrders: any;
    account: any;
    privateKey: any;
    manager: any;
    dryRun: any;
    fillLockAlreadyHeld?: boolean;
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
                fillLockAlreadyHeld,
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
                fillLockAlreadyHeld,
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
    fillLockAlreadyHeld = false,
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
    fillLockAlreadyHeld?: boolean;
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
            fillLockAlreadyHeld,
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
                    fillLockAlreadyHeld,
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
                    await _cancelChainOrder({ chainOrders, account, privateKey, manager, chainOrderId: o.orderId, dryRun, chainOrderObj: o, fillLockAlreadyHeld });
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

/**
 * Attempt to resume a persisted grid when orderIds don't match (e.g. orders.json out of sync),
 * by matching existing on-chain open orders to grid orders using price+size matching.
 *
 * Returns { resumed: boolean, matchedCount: number }.
 * @param {Object} params - Destructured parameters
 * @param {Object} params.manager - OrderManager instance
 * @param {Array<Object>} params.persistedGrid - Persisted grid orders
 * @param {Array<Object>} params.chainOpenOrders - On-chain open orders
 * @param {Object} params.logger - Logger instance
 * @param {Function} params.storeGrid - Grid persistence callback
 * @returns {Promise<{resumed: boolean, matchedCount: number}>}
 */
async function attemptResumePersistedGridByPriceMatch({
    manager,
    persistedGrid,
    chainOpenOrders,
    logger,
    storeGrid,
    fillLockAlreadyHeld = false,
}) {
    if (!Array.isArray(persistedGrid) || persistedGrid.length === 0) return { resumed: false, matchedCount: 0 };
    if (!Array.isArray(chainOpenOrders) || chainOpenOrders.length === 0) return { resumed: false, matchedCount: 0 };
    if (!manager || typeof manager.synchronizeWithChain !== 'function') return { resumed: false, matchedCount: 0 };

    try {
        logger && logger.log && logger.log('No matching active order IDs found. Attempting to match by price...', 'info');
        const Grid = require('./grid');
        await Grid.loadGrid(manager, persistedGrid);
        await manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders', { fillLockAlreadyHeld });

        const matchedOrderIds = new Set(
            (Array.from(manager.orders.values()) as any[])
                .filter((o: any) => o && isOrderOnChain(o))
                .map((o: any) => o.orderId)
                .filter(Boolean)
        );

        if (matchedOrderIds.size === 0) {
            logger && logger.log && logger.log('Price-based matching found no matches. Generating new grid.', 'info');
            return { resumed: false, matchedCount: 0 };
        }

        logger && logger.log && logger.log(`Successfully matched ${matchedOrderIds.size} orders by price. Resuming with existing grid.`, 'info');
        if (typeof storeGrid === 'function') {
            await storeGrid(Array.from(manager.orders.values()) as any[]);
        }
        return { resumed: true, matchedCount: matchedOrderIds.size };
    } catch (err: any) {
        logger && logger.log && logger.log(`Price-based resume attempt failed: ${err && err.message ? err.message : err}`, 'warn');
        return { resumed: false, matchedCount: 0 };
    }
}

/**
 * Decide whether a startup should regenerate the grid or resume a persisted grid.
 *
 * Resulting behavior matches the existing startup policy:
 * - If no persisted grid -> regenerate
 * - If any persisted ACTIVE orderId exists on-chain -> resume
 * - Else if there are on-chain orders -> attempt price-based matching; resume if it matches any
 * - Else -> regenerate
 * @param {Object} params - Destructured parameters
 * @param {Array<Object>} params.persistedGrid - Persisted grid orders
 * @param {Array<Object>} params.chainOpenOrders - On-chain open orders
 * @param {Object} params.manager - OrderManager instance
 * @param {Object} params.logger - Logger instance
 * @param {Function} params.storeGrid - Grid persistence callback
 * @param {Function} [params.attemptResumeFn=attemptResumePersistedGridByPriceMatch] - Resume function
 * @returns {Promise<Object>} { shouldRegenerate, hasActiveMatch, resumedByPrice, matchedCount }
 */
async function decideStartupGridAction({
    persistedGrid,
    chainOpenOrders,
    manager,
    logger,
    storeGrid,
    attemptResumeFn = attemptResumePersistedGridByPriceMatch,
    fillLockAlreadyHeld = false,
}) {
    const persisted = Array.isArray(persistedGrid) ? persistedGrid : [];
    const chain = Array.isArray(chainOpenOrders) ? chainOpenOrders : [];

    if (persisted.length === 0) {
        return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
    }

    const chainOrderIds = new Set(chain.map(o => o && o.id).filter(Boolean));
    const hasActiveMatch = persisted.some(order => order && order.state === ORDER_STATES.ACTIVE && order.orderId && chainOrderIds.has(order.orderId));
    if (hasActiveMatch) {
        return { shouldRegenerate: false, hasActiveMatch: true, resumedByPrice: false, matchedCount: 0 };
    }

    if (chain.length > 0) {
        const resume = await attemptResumeFn({ manager, persistedGrid: persisted, chainOpenOrders: chain, logger, storeGrid, fillLockAlreadyHeld });
        return { shouldRegenerate: !resume.resumed, hasActiveMatch: false, resumedByPrice: !!resume.resumed, matchedCount: resume.matchedCount || 0 };
    }

    return { shouldRegenerate: true, hasActiveMatch: false, resumedByPrice: false, matchedCount: 0 };
}

/**
 * Reconcile existing on-chain orders to a newly generated grid.
 *
 * Policy (per side):
 * - Prefer updating existing unmatched chain orders to match the target grid slots.
 * - Then create missing orders if chain has fewer than target.
 * - Then cancel excess orders if chain has more than target.
 *
 * Targets are derived from config.activeOrders.{buy,sell} and chain counts are computed
 * from current on-chain open orders.
 * @param {Object} params - Destructured parameters
 * @param {Object} params.manager - OrderManager instance
 * @param {Object} params.config - Bot configuration
 * @param {string} params.account - Account ID or name
 * @param {string} params.privateKey - Active/owner private key
 * @param {Function} params.chainOrders - Chain order query function
 * @param {Array<Object>} params.chainOpenOrders - On-chain open orders
 * @returns {Promise<Object>} Reconciliation result
 */
async function reconcileGridOrders({
    manager,
    config,
    account,
    privateKey,
    chainOrders,
    chainOpenOrders,
    fillLockAlreadyHeld = false,
}) {
    // Parameter validation
    if (!manager || typeof manager.synchronizeWithChain !== 'function') {
        throw new Error('reconcileGridOrders: manager must be provided with synchronizeWithChain method');
    }
    if (typeof manager.getOrdersByTypeAndState !== 'function') {
        throw new Error('reconcileGridOrders: manager.getOrdersByTypeAndState method not found');
    }
    if (!account || !privateKey) {
        throw new Error('reconcileGridOrders: account and privateKey are required');
    }
    if (!chainOrders || typeof chainOrders.cancelOrder !== 'function' || typeof chainOrders.createOrder !== 'function') {
        throw new Error('reconcileGridOrders: chainOrders must provide cancelOrder and createOrder methods');
    }
    if (typeof chainOrders.readOpenOrders !== 'function') {
        throw new Error('reconcileGridOrders: chainOrders.readOpenOrders is required for recovery sync');
    }
    const supportsBatchUpdate = typeof chainOrders.buildUpdateOrderOp === 'function' && typeof chainOrders.executeBatch === 'function';
    const supportsSequentialUpdate = typeof chainOrders.updateOrder === 'function';
    if (!supportsBatchUpdate && !supportsSequentialUpdate) {
        throw new Error('reconcileGridOrders: chainOrders must provide updateOrder or (buildUpdateOrderOp + executeBatch) for startup updates');
    }

    const logger = manager && manager.logger;
    const dryRun = !!(config && config.dryRun);

    const parsedChain = (chainOpenOrders || [])
        .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
        .filter(x => x.parsed);

    const activeCfg = (config && config.activeOrders) ? config.activeOrders : {};
    let targetBuy = Math.max(0, Number.isFinite(Number(activeCfg.buy)) ? Number(activeCfg.buy) : 1);
    let targetSell = Math.max(0, Number.isFinite(Number(activeCfg.sell)) ? Number(activeCfg.sell) : 1);

    const chainBuys = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
    const chainSells = parsedChain.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);

    // PHASE 1: In-memory reconciliation under lock (compute + individual quick cancels)
    // Blockchain-heavy batch operations (updates, creates, readOpenOrders) are deferred
    // to Phase 2 to minimize lock contention.
    const phase1Result = await manager._gridLock.acquire(async () => {
        if (typeof manager._applyOrderUpdate !== 'function') {
            throw new Error('manager._applyOrderUpdate is required for startup reconciliation');
        }
        const applyUpdate = manager._applyOrderUpdate.bind(manager);

        const chainIds = new Set((Array.isArray(chainOpenOrders) ? chainOpenOrders : []).map(o => o && o.id).filter(Boolean));
        for (const order of manager.orders.values()) {
            if (isOrderPlaced(order)) {
                if (!chainIds.has(order.orderId)) {
                    logger?.log?.(`Startup: Found phantom order ${order.id} (ID ${order.orderId}) not on chain. Resetting to VIRTUAL.`, 'warn');

                    await applyUpdate({
                        ...order,
                        state: ORDER_STATES.VIRTUAL,
                        orderId: "",
                        rawOnChain: null
                    }, 'startup-phantom', false, 0);
                }
            }
        }

        const matchedChainOrderIds = new Set();
        for (const gridOrder of manager.orders.values()) {
            if (gridOrder && gridOrder.orderId) {
                matchedChainOrderIds.add(gridOrder.orderId);
            }
        }

        const unmatchedChain = (Array.isArray(chainOpenOrders) ? chainOpenOrders : []).filter(co => co && !matchedChainOrderIds.has(co.id));
        let unmatchedParsed = unmatchedChain
            .map(co => ({ chain: co, parsed: parseChainOrder(co, manager.assets) }))
            .filter(x => x.parsed);

        const cancelledDuplicateIds = new Set<string>();
        const activeGridOrders = (Array.from(manager.orders.values()) as any[]).filter((o: any) => o && o.orderId && isOrderPlaced(o));
        for (const u of unmatchedParsed) {
            const p = u.parsed;
            const desc = `Unmatched chain order: ${p.orderId} (${p.type === ORDER_TYPES.BUY ? 'BUY' : 'SELL'}), price=${Format.formatPrice6(p.price)}, size=${Format.formatSizeByOrderType(p.size, p.type, manager.assets)}`;
            let nearest = null;
            for (const gridOrder of activeGridOrders) {
                if (gridOrder.type !== p.type) continue;
                const priceDiff = Math.abs(p.price - gridOrder.price);
                const tolerance = calculatePriceTolerance(gridOrder.price, gridOrder.size, gridOrder.type, manager.assets);
                const candidate = {
                    gridOrder,
                    priceDiff,
                    tolerance,
                    looseTolerance: tolerance * SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER,
                };
                if (!nearest || priceDiff < nearest.priceDiff) nearest = candidate;
            }
            if (nearest && nearest.priceDiff <= nearest.looseTolerance) {
                logger?.log?.(
                    `SUSPECTED DUPLICATE: ${desc} - nearest active grid ${nearest.gridOrder.id} ` +
                    `(orderId=${nearest.gridOrder.orderId}, price=${Format.formatPrice6(nearest.gridOrder.price)}, ` +
                    `diff=${Format.formatPrice6(nearest.priceDiff)}, tolerance=${Format.formatPrice6(nearest.tolerance)}, ` +
                    `looseTolerance=${Format.formatPrice6(nearest.looseTolerance)})`,
                    'error'
                );
                if (!dryRun) {
                    try {
                        await _cancelChainOrder({
                            chainOrders,
                            account,
                            privateKey,
                            manager,
                            chainOrderId: p.orderId,
                            dryRun,
                            chainOrderObj: u.chain,
                            releaseUntrackedFunds: true,
                            fillLockAlreadyHeld,
                        });
                        cancelledDuplicateIds.add(p.orderId);
                        logger?.log?.(
                            `Cancelled unmatched duplicate chain order ${p.orderId} at price ${Format.formatPrice6(p.price)} — ` +
                            `stale dust remnant duplicate of grid ${nearest.gridOrder.id} (${nearest.gridOrder.orderId})`,
                            'warn'
                        );
                    } catch (cancelErr: any) {
                        logger?.log?.(
                            `Failed to cancel duplicate chain order ${p.orderId}: ${cancelErr.message}`,
                            'error'
                        );
                    }
                }
            } else if (nearest) {
                logger?.log?.(
                    `${desc}; nearest active same-side grid ${nearest.gridOrder.id} ` +
                    `(orderId=${nearest.gridOrder.orderId}, price=${Format.formatPrice6(nearest.gridOrder.price)}, ` +
                    `diff=${Format.formatPrice6(nearest.priceDiff)}, tolerance=${Format.formatPrice6(nearest.tolerance)}, ` +
                    `looseTolerance=${Format.formatPrice6(nearest.looseTolerance)})`,
                    'warn'
                );
            } else {
                logger?.log?.(`${desc}; no active same-side grid order exists`, 'warn');
            }
        }

        if (cancelledDuplicateIds.size > 0) {
            unmatchedParsed = unmatchedParsed.filter(u => !cancelledDuplicateIds.has(u.parsed.orderId));
        }

        let unmatchedBuys = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.BUY).map(x => x.chain);
        let unmatchedSells = unmatchedParsed.filter(x => x.parsed.type === ORDER_TYPES.SELL).map(x => x.chain);
        const plannedCreates: any[] = [];
        const plannedUpdates: any[] = [];

        logger && logger.log && logger.log(
            `Startup reconcile starting: unmatched(sell=${unmatchedSells.length}, buy=${unmatchedBuys.length}), target(sell=${targetSell}, buy=${targetBuy})`,
            'info'
        );

        const sellResult = await _reconcileStartupSide({
            orderType: ORDER_TYPES.SELL,
            targetCount: targetSell,
            chainSideOrders: chainSells,
            unmatchedSideOrders: unmatchedSells,
            manager,
            chainOrders,
            account,
            privateKey,
            dryRun,
            plannedCreates,
            plannedUpdates,
            fillLockAlreadyHeld,
        });

        const buyResult = await _reconcileStartupSide({
            orderType: ORDER_TYPES.BUY,
            targetCount: targetBuy,
            chainSideOrders: chainBuys,
            unmatchedSideOrders: unmatchedBuys,
            manager,
            chainOrders,
            account,
            privateKey,
            dryRun,
            plannedCreates,
            plannedUpdates,
            fillLockAlreadyHeld,
        });

        return { plannedCreates, plannedUpdates, chainSellCount: sellResult.chainCount, chainBuyCount: buyResult.chainCount };
    });

    // PHASE 2: Blockchain operations outside lock (batch updates, creates, read)
    // These are the heavy operations that would block all other grid operations
    // if held under _gridLock.
    const { plannedCreates, plannedUpdates, chainSellCount, chainBuyCount } = phase1Result;

    if (!dryRun && plannedUpdates.length > 0) {
        let updatePlans = plannedUpdates;
        const maxBatchAttempts = 3;
        let batchCompleted = false;

        if (supportsBatchUpdate) {
            for (let attempt = 1; attempt <= maxBatchAttempts; attempt++) {
                try {
                    const batchResult = await _executeStartupUpdateBatch({
                        updatePlans,
                        chainOrders,
                        account,
                        privateKey,
                        manager,
                        dryRun,
                    });

                    if (batchResult.executed) {
                        logger?.log?.(`Startup: Update batch complete (${batchResult.prepared} updated)`, 'info');
                    }
                    batchCompleted = true;
                    break;
                } catch (err: any) {
                    logger?.log?.(`Startup: Update batch attempt ${attempt}/${maxBatchAttempts} failed: ${err.message}`, 'error');

                    const refreshedChainOrders = await _recoverStartupSyncFailure({
                        chainOrders,
                        manager,
                        account,
                        logger,
                        triggerMessage: `Startup: Triggering recovery sync after update batch failure (attempt ${attempt}/${maxBatchAttempts})`,
                        source: 'startupReconcileUpdateBatchFailure',
                        fillLockAlreadyHeld,
                    });

                    updatePlans = _refreshStartupUpdatePlans(updatePlans, refreshedChainOrders);
                    if (updatePlans.length === 0) {
                        logger?.log?.('Startup: No update plans remain after recovery sync; skipping further update attempts', 'warn');
                        batchCompleted = true;
                        break;
                    }

                    if (attempt >= maxBatchAttempts) {
                        logger?.log?.('Startup: Update batch retries exhausted; switching to sequential fallback', 'warn');
                        break;
                    }
                }
            }
        } else {
            logger?.log?.('Startup: Batch update helpers unavailable; using sequential fallback updates', 'warn');
        }

        if (!batchCompleted && updatePlans.length > 0) {
            try {
                const fallbackResult = await _executeStartupSequentialUpdateFallback({
                    updatePlans,
                    chainOrders,
                    account,
                    privateKey,
                    manager,
                    dryRun,
                    fillLockAlreadyHeld,
                });

                if (fallbackResult.executed > 0 || fallbackResult.skipped > 0 || fallbackResult.failed > 0) {
                    logger?.log?.(
                        `Startup: Sequential fallback complete (updated=${fallbackResult.executed}, skipped=${fallbackResult.skipped}, failed=${fallbackResult.failed})`,
                        fallbackResult.failed > 0 ? 'warn' : 'info'
                    );
                }
            } catch (err: any) {
                logger?.log?.(`Startup: Sequential fallback failed unexpectedly: ${err.message}`, 'error');
            }
        }
    }

    if (!dryRun && plannedCreates.length > 0) {
        await _executePlannedStartupCreates({
            createPlans: plannedCreates,
            chainOrders,
            account,
            privateKey,
            manager,
            dryRun,
            fillLockAlreadyHeld,
        });
    }

    let finalChainSellCount = chainSellCount;
    let finalChainBuyCount = chainBuyCount;
    if (!dryRun) {
        try {
            const freshOpenOrders = await chainOrders.readOpenOrders(account);
            const freshParsed = (Array.isArray(freshOpenOrders) ? freshOpenOrders : [])
                .map(co => ({ parsed: parseChainOrder(co, manager.assets) }))
                .filter(x => x.parsed);
            finalChainSellCount = freshParsed.filter(x => x.parsed.type === ORDER_TYPES.SELL).length;
            finalChainBuyCount = freshParsed.filter(x => x.parsed.type === ORDER_TYPES.BUY).length;
        } catch (err: any) {
            logger?.log?.(`Startup: Failed to refresh final chain counts: ${err.message}`, 'warn');
        }
    }

    logger && logger.log && logger.log(
        `Startup reconcile complete: target(sell=${targetSell}, buy=${targetBuy}), chain(sell=${finalChainSellCount}, buy=${finalChainBuyCount}), ` +
        `gridActive(sell=${_countActiveOnGrid(manager, ORDER_TYPES.SELL)}, buy=${_countActiveOnGrid(manager, ORDER_TYPES.BUY)})`,
        'info'
    );

    return null;
}

export = {
    reconcileGridOrders,
    attemptResumePersistedGridByPriceMatch,
    decideStartupGridAction,
};
