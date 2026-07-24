const assert = require('assert');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const chainOrders = require('../modules/chain_orders');
const DEXBot = require('../modules/dexbot_class');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

let testsComplete = false;

process.on('unhandledRejection', (reason) => {
    console.error('Test failed:', reason);
    process.exit(1);
});

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

function makeBot() {
    const bot = new DEXBot({
        botKey: 'test_cow_orchestration_fixes',
        dryRun: false,
        startPrice: 100,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    const logEntries = [];
    const orders = new Map();
    const manager = {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
        },
        orders,
        logger: {
            log: (msg, level) => { logEntries.push({ msg: String(msg), level }); },
            logFundsStatus: () => {}
        },
        _logEntries: logEntries,
        lockOrders: () => {},
        unlockOrders: () => {},
        _setRebalanceState: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _commitWorkingGrid: async () => {},
        _clearWorkingGridRef: () => {},
        _clearPendingBroadcasts: () => {},
        _persistenceWarning: undefined,
        _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false },
        _pendingBroadcasts: new Map(),
        persistGrid: async () => ({ isValid: true, skipped: false }),
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        synchronizeWithChain: async () => {},
        accountant: {
            updateOptimisticFreeBalance: async () => {}
        },
        applyGridUpdateBatch: async () => {},
    };
    bot.manager = manager;
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    return { bot, manager, logEntries };
}

async function testPreBroadcastPriceFreshnessRebuildsOp() {
    console.log(' - Pre-broadcast price freshness: drifted slot price overrides the action order price...');
    const { bot, manager, logEntries } = makeBot();
    const plannedOrder = {
        id: 'sell-7',
        type: ORDER_TYPES.SELL,
        price: 100,
        size: 10,
        state: ORDER_STATES.VIRTUAL,
        orderId: ''
    };
    manager.orders.set('sell-7', {
        id: 'sell-7',
        type: ORDER_TYPES.SELL,
        price: 103.25,
        size: 10,
        state: ORDER_STATES.VIRTUAL,
        orderId: ''
    });

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    let capturedArgs = null;
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        capturedArgs = { amountToSell, sellAssetId, minToReceive, receiveAssetId };
        return {
            op: { op_name: 'limit_order_create', op_data: { amount_to_sell: { amount: amountToSell, asset_id: sellAssetId }, min_to_receive: { amount: minToReceive, asset_id: receiveAssetId } } },
            finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
        };
    };
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[1, '1.7.572399999']]
    });

    try {
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
        workingGrid.set('sell-7', { ...plannedOrder });
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: 'sell-7', order: plannedOrder }]
        });
        assert.strictEqual(result.executed, true, 'Drifted create should still execute');
        assert.ok(capturedArgs, 'buildCreateOrderOp must have been called');
        assert.notStrictEqual(capturedArgs.amountToSell, plannedOrder.size * 1e8, 'Build should NOT have used the stale planned order verbatim');
        const driftLog = logEntries.find(l => l.msg.includes('Pre-broadcast price freshness'));
        assert.ok(driftLog, 'Drift log line must be present');
        assert.ok(driftLog.msg.includes('drifted from planned=100'), 'Drift log should show planned=100');
        assert.ok(driftLog.msg.includes('to live=103.25'), 'Drift log should show live=103.25');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('\u2713 COW-FRESH-001 passed');
}

async function testPreBroadcastNoDriftNoRebuild() {
    console.log(' - Pre-broadcast price freshness: matching price does not change the op...');
    const { bot, manager, logEntries } = makeBot();
    const plannedOrder = {
        id: 'sell-3',
        type: ORDER_TYPES.SELL,
        price: 100,
        size: 10,
        state: ORDER_STATES.VIRTUAL,
        orderId: ''
    };
    manager.orders.set('sell-3', { ...plannedOrder });

    let buildCallCount = 0;
    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        buildCallCount += 1;
        return {
            op: { op_name: 'limit_order_create', op_data: {} },
            finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
        };
    };
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[1, '1.7.572399999']]
    });

    try {
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
        workingGrid.set('sell-3', { ...plannedOrder });
        await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: 'sell-3', order: plannedOrder }]
        });
        assert.strictEqual(buildCallCount, 1, 'Build should be called exactly once');
        const driftLog = logEntries.find(l => l.msg.includes('Pre-broadcast price freshness'));
        assert.ok(!driftLog, 'No drift log expected when prices match');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('\u2713 COW-FRESH-002 passed');
}

async function testPersistenceCommitGuardRetriesOnSkipped() {
    console.log(' - Persistence commit guard retries once and clears the warning on success...');
    const { bot, manager, logEntries } = makeBot();
    let persistCalls = 0;
    manager.persistGrid = async () => {
        persistCalls += 1;
        if (persistCalls === 1) {
            return { isValid: true, skipped: true, suspended: true, reason: 'unit-test' };
        }
        return { isValid: true, skipped: false };
    };

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
    });
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[1, '1.7.572399999']]
    });

    const plannedOrder = {
        id: 'sell-1', type: ORDER_TYPES.SELL, price: 100, size: 10,
        state: ORDER_STATES.VIRTUAL, orderId: ''
    };
    manager.orders.set('sell-1', { ...plannedOrder });

    try {
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
        workingGrid.set('sell-1', { ...plannedOrder });
        manager._persistenceWarning = { isValid: true, skipped: true, reason: 'pre-existing' };
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: 'sell-1', order: plannedOrder }]
        });
        assert.strictEqual(result.executed, true, 'Batch should execute normally');
        assert.strictEqual(persistCalls, 2, 'persistGrid should be retried exactly once');
        const guardLog = logEntries.find(l => l.msg.includes('First persist attempt was skipped'));
        assert.ok(guardLog, 'Guard log line should fire on first skipped persist');
        assert.strictEqual(manager._persistenceWarning, undefined, 'Warning should be cleared on successful retry');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('\u2713 COW-PERSIST-001 passed');
}

async function testPersistenceCommitGuardRequestsResyncOnRepeatedFailure() {
    console.log(' - Persistence commit guard requests structural resync on repeated failure...');
    const { bot, manager, logEntries } = makeBot();
    manager.persistGrid = async () => ({ isValid: false, skipped: false });

    const resyncCalls = [];
    (manager as any).requestStructuralGridResync = async (reason, opts) => {
        resyncCalls.push({ reason, opts });
        return { scheduled: true };
    };

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    chainOrders.buildCreateOrderOp = async (account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
    });
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({
        success: true, operation_results: [[1, '1.7.572399999']]
    });

    const plannedOrder = {
        id: 'sell-2', type: ORDER_TYPES.SELL, price: 100, size: 10,
        state: ORDER_STATES.VIRTUAL, orderId: ''
    };
    manager.orders.set('sell-2', { ...plannedOrder });

    try {
        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
        workingGrid.set('sell-2', { ...plannedOrder });
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: 'sell-2', order: plannedOrder }]
        });
        assert.strictEqual(result.executed, true, 'Batch should still execute; persistence failure is non-fatal');
        const errLog = logEntries.find(l => l.msg.includes('Retry also skipped/invalid'));
        assert.ok(errLog, 'Error log for retry failure should fire');
        assert.strictEqual(manager._recoveryState.structuralResyncRequested, true, 'Resync flag should be set');
        assert.strictEqual(resyncCalls.length, 1, 'requestStructuralGridResync should be called once');
        assert.strictEqual(resyncCalls[0].reason, 'persistence guard triggered after COW batch', 'Resync reason should mention the persistence guard');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('\u2713 COW-PERSIST-002 passed');
}

async function run() {
    console.log('Running COW orchestration fix tests...');
    await testPreBroadcastPriceFreshnessRebuildsOp();
    await testPreBroadcastNoDriftNoRebuild();
    await testPersistenceCommitGuardRetriesOnSkipped();
    await testPersistenceCommitGuardRequestsResyncOnRepeatedFailure();
    console.log('\n\u2713 All COW orchestration fix tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exitCode = 1;
}).finally(() => {
    testsComplete = true;
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});
