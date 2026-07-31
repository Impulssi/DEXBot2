const assert = require('assert');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const chainOrders = require('../modules/chain_orders');
const DEXBot = require('../modules/dexbot_class');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

let testsComplete = false;

process.on('unhandledRejection', (reason) => {
    const isPostTestWsErrorEvent = testsComplete &&
        reason &&
        (reason as any).type === 'error' &&
        (reason as any).error &&
        typeof (reason as any).error === 'object';

    if (isPostTestWsErrorEvent) {
        return;
    }

    console.error('Test failed:', reason);
    process.exit(1);
});

function createOrder(id, overrides = {}) {
    return {
        id,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1,
        size: 100,
        orderId: '1.7.100',
        ...overrides
    };
}

function createVirtualCreateAction(id, price) {
    const order = {
        id,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price,
        size: 10,
        orderId: null
    };
    return { type: COW_ACTIONS.CREATE, id, order };
}

/**
 * Fixture for the pre-broadcast stale-plan guard (bounded re-plan).
 *
 * Mirrors the real manager's stack contract: performSafeRebalance pushes a
 * fresh working grid onto _currentWorkingGridStack and _commitWorkingGrid
 * pops the top on success (the real method pops on every terminal path).
 * The pop/spy counters let the tests assert the stack stays balanced.
 */
function createGuardFixture(masterOrders = new Map()) {
    const bot = new DEXBot({
        botKey: 'test_cow_guard_replan',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });

    const logs: string[] = [];
    const counters = {
        commitCalls: 0,
        replanCalls: 0,
        resyncCalls: 0,
        executeBatchCalls: 0,
        clearCalls: 0
    };

    const manager: any = {
        _gridVersion: 0,
        _recoveryState: {},
        _currentWorkingGridStack: [] as any[],
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
        },
        orders: Object.freeze(masterOrders),
        logger: {
            log: (msg: string) => { logs.push(String(msg)); },
            logFundsStatus: () => {}
        },
        lockOrders: () => {},
        unlockOrders: () => {},
        _setRebalanceState: () => {},
        _resetRebalanceStateToDepth: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _commitWorkingGrid: async () => {
            counters.commitCalls += 1;
            manager._clearWorkingGridRef();
            return true;
        },
        persistGrid: async () => {},
        _clearWorkingGridRef: () => {
            counters.clearCalls += 1;
            manager._currentWorkingGridStack.pop();
        },
        requestStructuralGridResync: async () => {
            counters.resyncCalls += 1;
        },
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        accountant: {
            updateOptimisticFreeBalance: async () => {}
        },
        applyGridUpdateBatch: async () => {},
        synchronizeWithChain: async () => {}
    };

    bot.manager = manager;
    bot.account = 'test-account';

    return { bot, manager, counters, logs };
}

function installChainStubs(manager: any, counters: any) {
    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    chainOrders.buildCreateOrderOp = async (_account: any, _amountToSell: any, sellAssetId: string) => ({
        op: {
            op_name: 'limit_order_create',
            op_data: { amount_to_sell: { amount: 100000, asset_id: sellAssetId } }
        },
        finalInts: { sell: 100000, receive: 10000000, sellAssetId, receiveAssetId: manager.assets.assetA.id }
    });
    chainOrders.executeBatch = async (_account: any, _key: any, ops: any[]) => {
        counters.executeBatchCalls += 1;
        const chainOrderIdBase = 3000 + Math.floor(Math.random() * 1000);
        return {
            success: true,
            operation_results: ops.map((_: any, i: number) => [null, `1.7.${chainOrderIdBase + i}`])
        };
    };

    return () => {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    };
}

function makeStaleWorkingGrid(manager: any) {
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion - 1 });
    workingGrid.set('slot-2', createVirtualCreateAction('slot-2', 1.1).order);
    return workingGrid;
}

async function testStalePlanReplansOnceAndExecutes() {
    console.log('\n[COW-GUARD-REPLAN-001] stale plan + fill context re-plans ONCE and executes the fresh plan...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    // A fill landed during planning: master version advanced past the plan.
    manager._gridVersion = 1;

    const staleWG = makeStaleWorkingGrid(manager);
    const fills = [{ id: 'fill-1', type: ORDER_TYPES.BUY, price: 0.99, size: 5 }];
    let replanFills: any = null;
    let replanExcludeIds: any = null;

    manager.performSafeRebalance = async (fillsArg: any, excludeIdsArg: any) => {
        counters.replanCalls += 1;
        replanFills = fillsArg;
        replanExcludeIds = excludeIdsArg;
        const freshWG = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        freshWG.set('slot-2', createVirtualCreateAction('slot-2', 1.1).order);
        manager._currentWorkingGridStack.push(freshWG);
        return {
            workingGrid: freshWG,
            workingIndexes: freshWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)]
        };
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid: staleWG,
            workingIndexes: staleWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            fills,
            excludeIds: new Set(['slot-1'])
        });

        assert.strictEqual(result.executed, true, 'fresh plan must execute');
        assert.strictEqual(counters.replanCalls, 1, 'must re-plan exactly once');
        assert.strictEqual(replanFills, fills, 're-plan must receive the same fill context');
        assert(replanExcludeIds instanceof Set, 're-plan must receive excludeIds');
        assert.strictEqual(counters.commitCalls, 1, 'exactly one commit of the fresh plan');
        assert.strictEqual(counters.executeBatchCalls, 1, 'exactly one broadcast');
        assert.strictEqual(manager._currentWorkingGridStack.length, 0, 'working grid stack must be balanced');
        assert.strictEqual(counters.clearCalls, 2, 'original pop + commit pop');
        assert.strictEqual(counters.resyncCalls, 0, 'no structural resync needed when re-plan succeeds');
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-001 passed');
}

async function testReplanWithNoActionsSkipsStalePlan() {
    console.log('\n[COW-GUARD-REPLAN-002] re-plan with no executable actions skips the stale plan...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    manager._gridVersion = 1;
    const staleWG = makeStaleWorkingGrid(manager);

    manager.performSafeRebalance = async () => {
        counters.replanCalls += 1;
        const freshWG = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        manager._currentWorkingGridStack.push(freshWG);
        return {
            workingGrid: freshWG,
            workingIndexes: freshWG.getIndexes(),
            workingBoundary: 0,
            actions: []
        };
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid: staleWG,
            workingIndexes: staleWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            fills: [{ id: 'fill-1', type: ORDER_TYPES.BUY, price: 0.99, size: 5 }]
        });

        assert.strictEqual(result.executed, false, 'stale plan must not ship');
        assert.strictEqual(result.skippedStalePlan, true, 'must report skipped stale plan');
        assert.strictEqual(counters.replanCalls, 1, 're-plan attempted once');
        assert.strictEqual(counters.executeBatchCalls, 0, 'no broadcast for a skipped plan');
        assert.strictEqual(counters.commitCalls, 0, 'no commit for a skipped plan');
        assert.strictEqual(manager._currentWorkingGridStack.length, 0, 'working grid stack must be balanced');
        assert.strictEqual(counters.clearCalls, 2, 'original pop + fresh-plan pop');
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-002 passed');
}

async function testStaleAtReplanLimitProceedsWithResync() {
    console.log('\n[COW-GUARD-REPLAN-003] still stale at re-plan limit proceeds with plan and requests structural resync...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters, logs } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    manager._gridVersion = 1;
    const staleWG = makeStaleWorkingGrid(manager);

    try {
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid: staleWG,
            workingIndexes: staleWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)]
        }, { replanDepth: 1 });

        assert.strictEqual(result.executed, true, 'bounded policy proceeds with the plan');
        assert.strictEqual(counters.replanCalls, 0, 'no re-plan at the depth limit');
        assert.strictEqual(counters.resyncCalls, 1, 'structural resync requested exactly once');
        assert.strictEqual(manager._recoveryState.structuralResyncRequested, true, 'resync flag recorded on recovery state');
        assert.strictEqual(counters.commitCalls, 1, 'proceeded plan commits');
        assert.strictEqual(manager._currentWorkingGridStack.length, 0, 'working grid stack must be balanced');
        assert(logs.some((m: string) => m.includes('still stale after re-plan')), 'should log the depth-limit proceed decision');
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-003 passed');
}

async function testReplanThrowProceedsWithResync() {
    console.log('\n[COW-GUARD-REPLAN-004] re-plan throw proceeds with original plan and requests structural resync...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    const { bot, manager, counters, logs } = createGuardFixture(masterOrders);
    const restore = installChainStubs(manager, counters);

    manager._gridVersion = 1;
    const staleWG = makeStaleWorkingGrid(manager);

    manager.performSafeRebalance = async () => {
        counters.replanCalls += 1;
        throw new Error('replan exploded');
    };

    try {
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid: staleWG,
            workingIndexes: staleWG.getIndexes(),
            workingBoundary: 0,
            actions: [createVirtualCreateAction('slot-2', 1.1)],
            fills: [{ id: 'fill-1', type: ORDER_TYPES.BUY, price: 0.99, size: 5 }]
        });

        assert.strictEqual(result.executed, true, 'bounded policy proceeds with the original plan');
        assert.strictEqual(counters.replanCalls, 1, 're-plan attempted once');
        assert.strictEqual(counters.resyncCalls, 1, 'structural resync requested for the re-plan failure path');
        assert.strictEqual(manager._recoveryState.structuralResyncRequested, true, 'resync flag recorded on recovery state');
        assert.strictEqual(counters.commitCalls, 1, 'proceeded plan commits');
        assert.strictEqual(manager._currentWorkingGridStack.length, 0, 'working grid stack must be balanced');
        assert.strictEqual(counters.clearCalls, 2, 'original pop + commit pop');
        assert(logs.some((m: string) => m.includes('Re-plan failed')), 'should log the re-plan failure');
    } finally {
        restore();
    }

    console.log('✓ COW-GUARD-REPLAN-004 passed');
}

async function run() {
    console.log('Running COW guard bounded re-plan regression tests...');
    await testStalePlanReplansOnceAndExecutes();
    await testReplanWithNoActionsSkipsStalePlan();
    await testStaleAtReplanLimitProceedsWithResync();
    await testReplanThrowProceedsWithResync();
    console.log('\n✓ All COW guard re-plan regression tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exitCode = 1;
});
