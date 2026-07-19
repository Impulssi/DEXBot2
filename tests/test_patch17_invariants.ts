const assert = require('assert');
const DEXBot = require('../modules/dexbot_class');
const { _getSizingContext, _recalculateGridOrderSizesFromBlockchain } = require('../modules/order/grid');;
const chainOrders = require('../modules/chain_orders');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');
const bsModule = require('../modules/bitshares_client');

if (typeof bsModule.setSuppressConnectionLog === 'function') {
    bsModule.setSuppressConnectionLog(true);
}

const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 30000);
let testsComplete = false;
const testTimeoutHandle = setTimeout(() => {
    console.error(`✗ Patch17 invariant tests timed out after ${TEST_TIMEOUT_MS}ms`);
    process.exit(1);
}, TEST_TIMEOUT_MS);
if (typeof testTimeoutHandle.unref === 'function') testTimeoutHandle.unref();

process.on('unhandledRejection', (reason) => {
    const isPostTestWsErrorEvent = testsComplete &&
        reason &&
        (reason as any).type === 'error' &&
        (reason as any).error &&
        typeof (reason as any).error === 'object';

    if (isPostTestWsErrorEvent) {
        return;
    }
    console.error('✗ Patch17 invariant tests failed');
    console.error(reason);
    process.exit(1);
});

async function createManager() {
    const mgr = new OrderManager({
        market: 'TEST/BTS',
        assetA: 'TEST',
        assetB: 'BTS',
        startPrice: 100,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        activeOrders: { buy: 4, sell: 4 },
        weightDistribution: { sell: 0.5, buy: 0.5 }
    });
    mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
    await mgr.setAccountTotals({ buy: 10000, sell: 1000, buyFree: 10000, sellFree: 1000 });
    mgr.resetFunds();
    return mgr;
}

function createBatchManagerStub(overrides = {}) {
    return {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' }
        },
        _gridVersion: 0,
        boundaryIdx: null,
        lockOrders: () => {},
        unlockOrders: () => {},
        _setRebalanceState: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        _clearWorkingGridRef: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _commitWorkingGrid: async () => {},
        consumeIllegalStateSignal: () => null,
        consumeAccountingFailureSignal: () => null,
        getChainFundsSnapshot: () => ({
            chainFreeBuy: 100000,
            chainFreeSell: 100000,
            available: { buy: 100000, sell: 100000 }
        }),
        orders: new Map(),
        _updateOrder: async () => {},
        _throwOnIllegalState: false,
        logger: {
            log: () => {},
            logFundsStatus: () => {}
        },
        ...overrides
    };
}

async function testExtremePlacementOrdering() {
    const mgr = await createManager();

    const allSlots = [
        { id: 'b0', price: 99, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'b1', price: 98, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'b2', price: 97, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'b3', price: 96, type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's0', price: 101, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's1', price: 102, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's2', price: 103, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's3', price: 104, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 0 }
    ];

    mgr.pauseFundRecalc();
    for (const slot of allSlots) {
        await mgr._updateOrder(slot, 'seed', { skipAccounting: true, fee: 0 });
    }
    await mgr.resumeFundRecalc();

    const targetGrid = new Map(
        allSlots.map((slot) => [
            slot.id,
            {
                ...slot,
                state: ORDER_STATES.ACTIVE,
                size: slot.type === ORDER_TYPES.BUY ? 100 : 10
            }
        ])
    );

    const reconcile = mgr.reconcileGrid(targetGrid, 3);
    const buyCreateIds = reconcile.actions
        .filter((a) => a.type === COW_ACTIONS.CREATE && a.order?.type === ORDER_TYPES.BUY)
        .map((a) => a.id);
    const sellCreateIds = reconcile.actions
        .filter((a) => a.type === COW_ACTIONS.CREATE && a.order?.type === ORDER_TYPES.SELL)
        .map((a) => a.id);

    assert.deepStrictEqual(
        buyCreateIds,
        ['b0', 'b1', 'b2', 'b3'],
        'BUY placements must use nearest available free slots first'
    );
    assert.deepStrictEqual(
        sellCreateIds,
        ['s0', 's1', 's2', 's3'],
        'SELL placements must use nearest available free slots first'
    );
}

async function testPipelineInFlightDefersMaintenance() {
    const bot = new DEXBot({
        botKey: 'test_patch17_invariants_pipeline',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let spreadChecks = 0;
    let healthChecks = 0;
    let capturedSignals = null;

    bot._incomingFillQueue.push({ id: 'fill-1' });
    bot._batchInFlight = true;
    bot._recoverySyncInFlight = true;

    bot.manager = {
        recalculateFunds: () => {},
        clearStalePipelineOperations: () => {},
        isPipelineEmpty: (signals) => {
            capturedSignals = signals;
            return { isEmpty: false, reasons: ['in-flight test'] };
        },
        checkSpreadCondition: async () => {
            spreadChecks++;
            return { ordersPlaced: 0 };
        },
        checkGridHealth: async () => {
            healthChecks++;
            return { buyDust: false, sellDust: false };
        },
        _state: { isBroadcastingActive: () => true },
        shadowOrderIds: new Set(['lock-1']),
        logger: { log: () => {} }
    };

    await bot._executeMaintenanceLogic('invariant-pipeline');

    assert(capturedSignals, 'Pipeline signals should be passed to isPipelineEmpty');
    assert.strictEqual(capturedSignals.batchInFlight, true, 'batchInFlight signal should be true');
    assert.strictEqual(capturedSignals.recoveryInFlight, true, 'recoveryInFlight signal should be true');
    assert.strictEqual(capturedSignals.broadcasting, true, 'broadcasting signal should be true');
    assert.strictEqual(spreadChecks, 0, 'Spread maintenance must be deferred when pipeline is in-flight');
    assert.strictEqual(healthChecks, 1, 'Dust/health check runs before pipeline gate (intentional — dust cancel is safe during pipeline activity)');
}

async function testIllegalStateAbortResyncAndCooldown() {
    const bot = new DEXBot({
        botKey: 'test_patch17_invariants_abort',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let spreadChecks = 0;
    let healthChecks = 0;
    let persistCalls = 0;
    let recoverySyncCalls = 0;
    let consumeCount = 0;

    bot._triggerStateRecoverySync = async () => {
        recoverySyncCalls++;
    };
    bot._persistAndRecoverIfNeeded = async () => {
        persistCalls++;
    };

    bot.manager = {
        recalculateFunds: () => {},
        clearStalePipelineOperations: () => {},
        isPipelineEmpty: () => ({ isEmpty: true, reasons: [] }),
        checkSpreadCondition: async () => {
            spreadChecks++;
            return { ordersPlaced: 1 };
        },
        checkGridHealth: async () => {
            healthChecks++;
            return { buyDust: false, sellDust: false };
        },
        consumeIllegalStateSignal: () => {
            consumeCount++;
            if (consumeCount === 1) {
                return { id: 'slot-x', context: 'fill-place', message: 'simulated illegal spread on-chain' };
            }
            return null;
        },
        logger: { log: () => {} }
    };

    await bot._executeMaintenanceLogic('invariant-abort-1');

    assert.strictEqual(recoverySyncCalls, 1, 'Illegal state should trigger immediate recovery sync');
    assert.strictEqual(persistCalls, 0, 'Illegal state abort should skip persistence in same cycle');
    assert.strictEqual(healthChecks, 1, 'Health check runs first; abort should stop the remaining maintenance steps');
    assert.strictEqual(spreadChecks, 0, 'Illegal state abort should prevent spread checks in same cycle');
    assert.strictEqual(bot._maintenanceCooldownCycles, 1, 'Hard-abort should arm one maintenance cooldown cycle');

    await bot._executeMaintenanceLogic('invariant-abort-2');
    assert.strictEqual(healthChecks, 1, 'Cooldown cycle should skip all maintenance checks once after hard-abort');
    assert.strictEqual(spreadChecks, 0, 'Cooldown cycle should skip spread checks once after hard-abort');
}

async function testFillCallbackAppliesQueueBackPressure() {
    const bot = new DEXBot({
        botKey: 'test_patch17_invariants_queue_backpressure',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let warnings = 0;
    let consumeCalls = 0;
    bot._warn = () => { warnings++; };
    bot._consumeFillQueue = async () => { consumeCalls++; };
    bot.manager = { logger: { log: () => {} } };

    bot._incomingFillQueue = Array.from({ length: 999 }, (_, index) => ({ id: `queued-${index}` }));
    const callback = bot._createFillCallback({});

    await assert.rejects(
        callback([{ id: 'overflow-1' }, { id: 'overflow-2' }]),
        /Incoming fill queue back-pressure/,
        'fill callback should reject before accepting fills beyond the queue cap'
    );

    assert.strictEqual(bot._incomingFillQueue.length, 999, 'back-pressure must leave the queue unchanged for retry');
    assert.strictEqual(consumeCalls, 0, 'back-pressure must not start a consumer for rejected fills');
    assert.strictEqual(warnings, 1, 'back-pressure should emit one warning');

    await callback([{ id: 'accepted-1' }]);
    assert.strictEqual(bot._incomingFillQueue.length, 1000, 'queue should still accept fills up to the configured cap');
    assert.strictEqual(consumeCalls, 1, 'accepted fills should start the consumer');
}

async function testRoleAssignmentBlocksOnChainSpreadConversion() {
    const mgr = await createManager();
    mgr.logger.level = 'error';

    const slots = [
        { id: 'buy-0', type: ORDER_TYPES.BUY, price: 98, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.1' },
        { id: 'buy-1', type: ORDER_TYPES.BUY, price: 99, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.2' },
        { id: 'mid-active', type: ORDER_TYPES.BUY, price: 100, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.3' },
        { id: 'sell-0', type: ORDER_TYPES.SELL, price: 101, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.4' },
        { id: 'sell-1', type: ORDER_TYPES.SELL, price: 102, size: 10, state: ORDER_STATES.ACTIVE, orderId: '1.7.5' }
    ];

    for (const slot of slots) {
        await mgr._updateOrder(slot, 'seed', { skipAccounting: true, fee: 0 });
    }
    mgr.config.startPrice = 99;
    mgr.boundaryIdx = 1;

    const rebalanceResult = await mgr.performSafeRebalance([], new Set());

    const midOrder = mgr.orders.get('mid-active');
    assert(midOrder, 'Mid slot should still exist');
    assert.strictEqual(midOrder.type, ORDER_TYPES.BUY, 'On-chain mid slot should keep BUY type before commit');

    const hasSpreadCreate = (rebalanceResult.actions || []).some(
        (action) => action.type === COW_ACTIONS.CREATE && action.order?.type === ORDER_TYPES.SPREAD
    );
    assert(
        hasSpreadCreate === false,
        'Rebalance should not emit CREATE actions that convert on-chain slots into SPREAD orders'
    );
}

async function testGridResizeRespectsBudgetAfterCap() {
    const mgr = await createManager();
    await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1, sellFree: 1000 });
    mgr.resetFunds();

    const slots = [
        { id: 'b0', type: ORDER_TYPES.BUY, price: 99, state: ORDER_STATES.ACTIVE, orderId: '1.7.1', size: 0.5 },
        { id: 'b1', type: ORDER_TYPES.BUY, price: 98, state: ORDER_STATES.ACTIVE, orderId: '1.7.2', size: 0.5 },
        { id: 'b2', type: ORDER_TYPES.BUY, price: 97, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 'b3', type: ORDER_TYPES.BUY, price: 96, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's0', type: ORDER_TYPES.SELL, price: 101, state: ORDER_STATES.VIRTUAL, size: 0 },
        { id: 's1', type: ORDER_TYPES.SELL, price: 102, state: ORDER_STATES.VIRTUAL, size: 0 }
    ];

    mgr.pauseFundRecalc();
    for (const slot of slots) {
        await mgr._updateOrder(slot, 'seed', { skipAccounting: true, fee: 0 });
    }
    await mgr.resumeFundRecalc();

    await _recalculateGridOrderSizesFromBlockchain(mgr, ORDER_TYPES.BUY);

    const buyOrders = Array.from(mgr.orders.values()).filter(o => (o as any).type === ORDER_TYPES.BUY);
    const allocatedBuy = buyOrders.reduce((sum, o) => (sum as any) + Number((o as any).size || 0), 0);
    const buyCtx = await _getSizingContext(mgr, 'buy');
    const buyBudget = Number(buyCtx?.budget || 0);

    assert(
        (allocatedBuy as any) <= buyBudget + 1e-5,
        `BUY allocation must not exceed budget after capping (allocated ${allocatedBuy}, budget ${buyBudget})`
    );
}

async function testIllegalBatchAbortArmsMaintenanceCooldown() {
    const bot = new DEXBot({
        botKey: 'test_patch17_batch_abort_cooldown',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let recoverySyncCalls = 0;
    bot._triggerStateRecoverySync = async () => {
        recoverySyncCalls++;
    };

    bot.manager = createBatchManagerStub({
        consumeIllegalStateSignal: () => ({ message: 'simulated illegal state from test' })
    });

    bot._validateOperationFunds = () => ({ isValid: true, summary: 'ok' });

    const originalExecuteBatch = chainOrders.executeBatch;
    const originalBuildCreateOrderOp = chainOrders.buildCreateOrderOp;
    try {
        chainOrders.buildCreateOrderOp = async () => ({
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { asset_id: '1.3.1', amount: 1 },
                    min_to_receive: { asset_id: '1.3.0', amount: 1 }
                }
            },
            finalInts: {
                sell: 1,
                receive: 1,
                sellAssetId: '1.3.1',
                receiveAssetId: '1.3.0'
            }
        });

        chainOrders.executeBatch = async () => {
            const err = new Error('simulated illegal state');
            (err as any).code = 'ILLEGAL_ORDER_STATE';
            throw err;
        };

        const result = await bot.updateOrdersOnChainPlan({
            ordersToPlace: [{ id: 'slot-new', type: ORDER_TYPES.BUY, size: 1, price: 99 }],
            ordersToRotate: [],
            ordersToUpdate: [],
            ordersToCancel: []
        });

        assert.strictEqual(result?.abortedForIllegalState, true, 'Batch should abort with ILLEGAL_ORDER_STATE signal');
        assert.strictEqual(recoverySyncCalls, 1, 'Illegal-state abort should trigger one immediate recovery sync');
        assert.strictEqual(bot._maintenanceCooldownCycles, 1, 'Illegal-state batch abort must arm maintenance cooldown');
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
        chainOrders.buildCreateOrderOp = originalBuildCreateOrderOp;
    }
}

async function testSingleStaleCancelBatchUsesStaleOnlyFastPath() {
    const bot = new DEXBot({
        botKey: 'test_patch17_single_stale_cancel',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let recoverySyncCalls = 0;
    bot._triggerStateRecoverySync = async () => {
        recoverySyncCalls++;
    };

    bot.manager = await createManager();
    bot.manager.pauseFundRecalc();
    await bot.manager._updateOrder({
        id: 'slot-stale',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        size: 1,
        price: 99,
        orderId: '1.7.999',
        rawOnChain: { id: '1.7.999', for_sale: '100000' }
    }, 'seed-stale', { skipAccounting: true, fee: 0 });
    await bot.manager.resumeFundRecalc();

    bot._validateOperationFunds = () => ({ isValid: true, summary: 'ok' });

    const originalExecuteBatch = chainOrders.executeBatch;
    const originalBuildCancelOrderOp = chainOrders.buildCancelOrderOp;
    try {
        chainOrders.buildCancelOrderOp = async () => ({
            op_name: 'limit_order_cancel',
            op_data: { order: '1.7.999' }
        });

        chainOrders.executeBatch = async () => {
            throw new Error('Limit order 1.7.999 does not exist');
        };

        const result = await bot.updateOrdersOnChainPlan({
            ordersToPlace: [],
            ordersToRotate: [],
            ordersToUpdate: [],
            ordersToCancel: [{ id: 'slot-stale', orderId: '1.7.999' }]
        });

        const cleanedSlot = bot.manager.orders.get('slot-stale');
        assert.strictEqual(result?.stale, true, 'Explicit stale order should return recoverable stale result');
        assert(cleanedSlot, 'Stale slot should still exist in grid');
        assert.strictEqual(cleanedSlot.state, ORDER_STATES.VIRTUAL, 'Stale slot should be virtualized through manager update path');
        assert.strictEqual(cleanedSlot.orderId, null, 'Stale slot should clear orderId');
        assert.strictEqual(cleanedSlot.size, 0, 'Stale slot should be zero-sized after cleanup');
        assert.strictEqual(cleanedSlot.rawOnChain, null, 'Stale slot should clear rawOnChain metadata');
        assert.strictEqual(recoverySyncCalls, 0, 'Stale-only cancel race should not trigger recovery sync');
        assert.strictEqual(bot._staleCleanedOrderIds.has('1.7.999'), true, 'Stale order id should be tracked to avoid double-credit');
        assert.strictEqual(bot.manager.validateIndices(), true, 'Stale cleanup should preserve manager indices');
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
        chainOrders.buildCancelOrderOp = originalBuildCancelOrderOp;
    }
}

async function testCannotDeductTriggersRecoverySyncInsteadOfVirtualizing() {
    const bot = new DEXBot({
        botKey: 'test_patch17_cannot_deduct_recovery',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    let recoverySyncCalls = 0;
    bot._triggerStateRecoverySync = async () => {
        recoverySyncCalls++;
    };

    bot.manager = await createManager();
    bot.manager.pauseFundRecalc();
    await bot.manager._updateOrder({
        id: 'slot-partial',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 5,
        price: 101,
        orderId: '1.7.555',
        rawOnChain: { id: '1.7.555', for_sale: '500000000' }
    }, 'seed-partial', { skipAccounting: true, fee: 0 });
    await bot.manager.resumeFundRecalc();

    bot._validateOperationFunds = () => ({ isValid: true, summary: 'ok' });

    const originalExecuteBatch = chainOrders.executeBatch;
    const originalBuildUpdateOrderOp = chainOrders.buildUpdateOrderOp;
    try {
        chainOrders.buildUpdateOrderOp = async () => ({
            op: {
                op_name: 'limit_order_update',
                op_data: {
                    order: '1.7.555',
                    new_price: {
                        base: { asset_id: '1.3.0', amount: 500000000 },
                        quote: { asset_id: '1.3.1', amount: 49505 }
                    },
                    delta_amount_to_sell: { asset_id: '1.3.0', amount: -1000 }
                }
            },
            finalInts: {
                sell: 500000000,
                receive: 49505,
                sellAssetId: '1.3.0',
                receiveAssetId: '1.3.1'
            }
        });

        chainOrders.executeBatch = async () => {
            throw new Error('Cannot deduct all or more from order than order contains');
        };

        const result = await bot.updateOrdersOnChainPlan({
            ordersToPlace: [],
            ordersToRotate: [],
            ordersToUpdate: [{
                id: 'slot-partial',
                orderId: '1.7.555',
                type: ORDER_TYPES.SELL,
                newSize: 4.99999
            }],
            ordersToCancel: []
        });

        const liveSlot = bot.manager.orders.get('slot-partial');
        assert.strictEqual(result?.recoveredBySync, true, '"Cannot deduct" should recover via sync path');
        assert.strictEqual(result?.reason, 'ORDER_SIZE_DRIFT', '"Cannot deduct" should be classified as size drift');
        assert.strictEqual(recoverySyncCalls, 1, '"Cannot deduct" should trigger one recovery sync');
        assert(liveSlot, 'Updated slot should remain present after recoverable size drift');
        assert.notStrictEqual(liveSlot.state, ORDER_STATES.VIRTUAL, '"Cannot deduct" must not virtualize the slot');
        assert.strictEqual(liveSlot.orderId, '1.7.555', '"Cannot deduct" must preserve orderId until sync reconciles it');
        assert.strictEqual(bot._staleCleanedOrderIds.has('1.7.555'), false, '"Cannot deduct" must not mark order as stale-cleaned');
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
        chainOrders.buildUpdateOrderOp = originalBuildUpdateOrderOp;
    }
}

async function testStaleCleanedOrphanFillTtlDedup() {
    console.log('\n--- Stale-cleaned orphan fill TTL dedup ---');

    const bot = new DEXBot({
        botKey: 'test_patch17_stale_orphan_ttl',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    bot.manager = await createManager();
    bot.manager.finishBootstrap();

    const originalGetMode = chainOrders.getFillProcessingMode;
    const originalWasCancelled = chainOrders.wasRecentlyOwnCancelled;
    chainOrders.getFillProcessingMode = () => 'history';
    chainOrders.wasRecentlyOwnCancelled = () => false;

    try {
        const sellBefore = bot.manager.accountTotals.sell;
        const orderId = '1.7.777';

        // Seed stale-cleaned entry within TTL
        bot._staleCleanedOrderIds.set(orderId, Date.now());

        bot._incomingFillQueue.push({
            block_num: 1000,
            id: '1.11.888',
            op: [4, {
                order_id: orderId,
                pays: { asset_id: '1.3.1', amount: 100000 },
                receives: { asset_id: '1.3.0', amount: 250000 },
                is_maker: true
            }]
        });

        await bot._consumeFillQueue(chainOrders);

        assert.strictEqual(
            bot.manager.accountTotals.sell,
            sellBefore,
            'Orphan fill for stale-cleaned order must be skipped within TTL window'
        );
        assert.strictEqual(
            bot._staleCleanedOrderIds.has(orderId),
            true,
            'Stale-cleaned entry must survive while still within TTL'
        );
        console.log('  ✓ Within TTL: fill blocked, entry preserved');

        // Simulate TTL expiry
        bot._staleCleanedOrderIds.set(orderId, Date.now() - 600000);

        bot._incomingFillQueue.push({
            block_num: 1001,
            id: '1.11.889',
            op: [4, {
                order_id: orderId,
                pays: { asset_id: '1.3.1', amount: 100000 },
                receives: { asset_id: '1.3.0', amount: 250000 },
                is_maker: true
            }]
        });

        await bot._consumeFillQueue(chainOrders);

        const rawProceeds = 250000 / Math.pow(10, bot.manager.assets.assetA.precision);
        assert.strictEqual(
            bot.manager.accountTotals.sell,
            sellBefore + rawProceeds,
            'Orphan fill for stale-cleaned order must credit proceeds after TTL expiry'
        );
        assert.strictEqual(
            bot._staleCleanedOrderIds.has(orderId),
            false,
            'Stale-cleaned entry must be removed after TTL expiry and processing'
        );
        console.log('  ✓ After TTL: fill credited, entry removed');
    } finally {
        chainOrders.getFillProcessingMode = originalGetMode;
        chainOrders.wasRecentlyOwnCancelled = originalWasCancelled;
    }
}

async function runTests() {
    console.log('Running Patch17 Invariant Tests...');
    await testExtremePlacementOrdering();
    await testPipelineInFlightDefersMaintenance();
    await testIllegalStateAbortResyncAndCooldown();
    await testFillCallbackAppliesQueueBackPressure();
    await testRoleAssignmentBlocksOnChainSpreadConversion();
    await testGridResizeRespectsBudgetAfterCap();
    await testIllegalBatchAbortArmsMaintenanceCooldown();
    await testSingleStaleCancelBatchUsesStaleOnlyFastPath();
    await testCannotDeductTriggersRecoverySyncInsteadOfVirtualizing();
    await testStaleCleanedOrphanFillTtlDedup();
    testsComplete = true;
    console.log('✓ Patch17 invariant tests passed!');
}

runTests().catch(err => {
    console.error('✗ Patch17 invariant tests failed');
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    clearTimeout(testTimeoutHandle);
    const BitShares = bsModule.BitShares;
    if (BitShares?.ws?.isConnected && typeof BitShares.disconnect === 'function') {
        try { BitShares.disconnect(); } catch (_) { }
    }
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});
