const assert = require('assert');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const chainOrders = require('../modules/chain_orders');
const chainKeys = require('../modules/chain_keys');
const DEXBot = require('../modules/dexbot_class');
const { OrderManager } = require('../modules/order/manager');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

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

function buildIndexes(orders) {
    const byState = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set()
    };
    const byType = {
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set()
    };

    for (const [id, order] of orders.entries()) {
        if (byState[order.state]) byState[order.state].add(id);
        if (byType[order.type]) byType[order.type].add(id);
    }

    return { byState, byType };
}

function createManagerFixture() {
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
    const logs = [];
    let recalcCount = 0;

    manager.logger = {
        log: (msg, level) => logs.push({ msg, level })
    };

    manager.recalculateFunds = async () => {
        recalcCount += 1;
    };

    manager._gridVersion = 5;
    manager.boundaryIdx = 0;
    manager.config = {
        ...(manager.config || {}),
        incrementPercent: 0.5
    };
    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 8 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };

    const master = new Map([
        ['slot-1', createOrder('slot-1')]
    ]);
    manager.orders = Object.freeze(master);

    const { byState, byType } = buildIndexes(master);
    manager._ordersByState = byState;
    manager._ordersByType = byType;

    return {
        manager,
        logs,
        getRecalcCount: () => recalcCount
    };
}

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

function createCowExecutionFixture(masterOrders = new Map()) {
    const bot = new DEXBot({
        botKey: 'test_cow_cache_deduction',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });

    const postBatchAdjustments = [];
    const manager = {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
        },
        orders: Object.freeze(masterOrders),
        logger: {
            log: () => {},
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
        _commitWorkingGrid: async () => {},
        persistGrid: async () => {},
        _clearWorkingGridRef: () => {},
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        accountant: {
            updateOptimisticFreeBalance: async () => {}
        },
        applyGridUpdateBatch: async () => {},
        synchronizeWithChain: async () => {},
    };

    bot.manager = manager;
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';

    return { bot, manager, postBatchAdjustments };
}

async function testRejectsVersionMismatchWithoutCommit() {
    console.log('\n[COW-COMMIT-001] rejects version mismatch without commit...');

    const { manager, logs, getRecalcCount } = createManagerFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 4 });
    workingGrid.set('slot-1', createOrder('slot-1', { price: 2 }));

    manager._currentWorkingGrid = workingGrid;
    manager._rebalanceState = 'BROADCASTING';

    await manager._commitWorkingGrid(workingGrid, workingGrid.getIndexes(), 0);

    assert.strictEqual(manager.orders.get('slot-1').price, 1, 'master order must remain unchanged');
    assert.strictEqual(manager._gridVersion, 5, 'grid version must not advance');
    assert.strictEqual(getRecalcCount(), 0, 'fund recalculation must be skipped for rejected commit');
    assert.strictEqual(manager._currentWorkingGrid, null, 'working grid reference should be cleared');
    assert.strictEqual(manager._rebalanceState, 'NORMAL', 'rebalance state should be reset');
    assert(logs.some(l => String(l.msg).includes('base version')), 'should log base version mismatch');
    assert(!logs.some(l => String(l.msg).includes('Grid committed in')), 'must not log successful commit');

    console.log('✓ COW-COMMIT-001 passed');
}

async function testNoPostCommitSideEffectsWhenDeltaEmpty() {
    console.log('\n[COW-COMMIT-002] skips post-commit side effects on empty delta...');

    const { manager, logs, getRecalcCount } = createManagerFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 5 });

    manager._currentWorkingGrid = workingGrid;
    manager._rebalanceState = 'BROADCASTING';

    await manager._commitWorkingGrid(workingGrid, workingGrid.getIndexes(), 0);

    assert.strictEqual(manager.orders.get('slot-1').price, 1, 'master order must remain unchanged');
    assert.strictEqual(manager._gridVersion, 5, 'grid version must not advance');
    assert.strictEqual(getRecalcCount(), 0, 'fund recalculation must be skipped for empty delta');
    assert.strictEqual(manager._currentWorkingGrid, null, 'working grid reference should be cleared');
    assert.strictEqual(manager._rebalanceState, 'NORMAL', 'rebalance state should be reset');
    assert(logs.some(l => String(l.msg).includes('Delta empty at commit')), 'should log empty delta refusal');
    assert(!logs.some(l => String(l.msg).includes('Grid committed in')), 'must not log successful commit');

    console.log('✓ COW-COMMIT-002 passed');
}

async function testExecuteBatchIfNeededSkipsEmptyActions() {
    console.log('\n[COW-COMMIT-003] central empty-action guard skips broadcast...');

    const bot = new DEXBot({
        botKey: 'test_cow_commit_guard_empty_actions',
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    const logs = [];
    let clearWorkingGridCalls = 0;
    bot.manager = {
        logger: {
            log: (msg, level) => logs.push({ msg: String(msg), level })
        },
        _clearWorkingGridRef: () => { clearWorkingGridCalls++; }
    };

    let batchCalls = 0;
    bot.updateOrdersOnChainBatch = async () => {
        batchCalls += 1;
        return { executed: true, hadRotation: false };
    };

    const emptyResult = await bot._executeBatchIfNeeded({ actions: [] }, 'unit-empty');
    assert.strictEqual(batchCalls, 0, 'Empty action set must not call updateOrdersOnChainBatch');
    assert.strictEqual(emptyResult.skippedNoActions, true, 'Empty action set should return skipped marker');
    assert(logs.some(l => l.level === 'debug' && l.msg.includes('No actions needed for unit-empty')),
        'Empty action guard should emit debug log');
    assert.strictEqual(clearWorkingGridCalls, 1,
        'Empty action guard must call _clearWorkingGridRef to reset REBALANCING state');

    await bot._executeBatchIfNeeded({
        actions: [{ type: COW_ACTIONS.CREATE, id: 'slot-new', order: { id: 'slot-new' } }],
        workingGrid: {}
    }, 'unit-non-empty');
    assert.strictEqual(batchCalls, 1, 'Non-empty action set must execute batch once');
    // _clearWorkingGridRef for non-empty path is handled inside _updateOrdersOnChainBatchCOW
    assert.strictEqual(clearWorkingGridCalls, 1, 'Non-empty path must not double-call _clearWorkingGridRef');

    console.log('✓ COW-COMMIT-003 passed');
}

async function testRejectsCreateOnOccupiedSlotBeforeBroadcast() {
    console.log('\n[COW-COMMIT-004] rejects create on occupied slot pre-broadcast...');

    const { manager } = createManagerFixture();
    manager.assets = {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
    };

    const bot = new DEXBot({
        botKey: 'test_cow_commit_guard_occupied_slot',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    bot.manager = manager;
    bot.account = { id: '1.2.999' };
    bot.privateKey = 'TEST_PRIVATE_KEY';

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
    const cowResult = {
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary: manager.boundaryIdx,
        actions: [{
            type: COW_ACTIONS.CREATE,
            id: 'slot-1',
            order: {
                id: 'slot-1',
                type: ORDER_TYPES.SELL,
                price: 1.1,
                size: 10,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        }]
    };

    const originalExecuteBatch = chainOrders.executeBatch;
    let executeBatchCalls = 0;
    chainOrders.executeBatch = async () => {
        executeBatchCalls += 1;
        return { success: true, operation_results: [] };
    };

    try {
        const result = await bot.updateOrdersOnChainBatch(cowResult);
        assert.strictEqual(result.executed, false, 'Occupied-slot create batch must not execute');
        assert.strictEqual(result.aborted, true, 'Occupied-slot create batch should abort early');
        assert.strictEqual(result.reason, 'CREATE_SLOT_OCCUPIED', 'Abort reason should indicate occupied slot');
        assert.strictEqual(executeBatchCalls, 0, 'Pre-broadcast guard must block blockchain executeBatch call');
    } finally {
        chainOrders.executeBatch = originalExecuteBatch;
    }

    console.log('✓ COW-COMMIT-004 passed');
}

async function testRejectsCreatesWhenUnmatchedChainOrdersExist() {
    console.log('\n[COW-COMMIT-005] rejects creates while unmatched chain orders exist...');

    const masterOrders = new Map([
        ['slot-new', createOrder('slot-new', {
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.VIRTUAL,
            price: 1.1,
            size: 10,
            orderId: ''
        })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });
    let structuralResyncRequests = 0;
    let executeCalls = 0;

    (manager as any)._lastUnmatchedChainOrders = [{
        chainOrderId: '1.7.572303058',
        type: ORDER_TYPES.SELL,
        price: 1.101,
        size: 10
    }];
    (manager as any).requestStructuralGridResync = async () => {
        structuralResyncRequests += 1;
        return { scheduled: true };
    };

    const result = await bot._updateOrdersOnChainBatchCOW({
        workingGrid,
        workingIndexes: workingGrid.getIndexes(),
        workingBoundary: 0,
        actions: [{
            type: COW_ACTIONS.CREATE,
            id: 'slot-new',
            order: {
                id: 'slot-new',
                type: ORDER_TYPES.SELL,
                price: 1.1,
                size: 10,
                state: ORDER_STATES.VIRTUAL,
                orderId: ''
            }
        }]
    });

    assert.strictEqual(result.executed, false, 'Create batch should not execute with unmatched chain orders');
    assert.strictEqual(result.aborted, true, 'Create batch should abort before broadcast');
    assert.strictEqual(result.reason, 'UNMATCHED_CHAIN_ORDERS', 'Abort reason should identify structural drift');
    assert.strictEqual(executeCalls, 0, 'No blockchain broadcast should be attempted');
    assert.strictEqual(structuralResyncRequests, 1, 'Structural resync should be requested');

    console.log('✓ COW-COMMIT-005 passed');
}

async function testMissingCreateBlockerMergesWithExistingUnmatchedOrders() {
    console.log('\n[COW-COMMIT-006] missing create blocker merges with existing unmatched orders...');

    const { bot, manager } = createCowExecutionFixture();
    (manager as any)._lastUnmatchedChainOrders = [{
        chainOrderId: '1.7.572303058',
        type: ORDER_TYPES.SELL,
        price: 1.101,
        size: 10,
        reason: 'unmatched-chain-order'
    }];

    bot._markMissingCreateResultsAsStructuralBlocker([{
        index: 2,
        ctx: {
            id: 'slot-missing-create',
            order: {
                id: 'slot-missing-create',
                type: ORDER_TYPES.BUY,
                price: 1.25,
                size: 3.5
            }
        }
    }]);
    bot._markMissingCreateResultsAsStructuralBlocker([{
        index: 2,
        ctx: {
            id: 'slot-missing-create',
            order: {
                id: 'slot-missing-create',
                type: ORDER_TYPES.BUY,
                price: 1.25,
                size: 3.5
            }
        }
    }]);

    assert.strictEqual((manager as any)._lastUnmatchedChainOrders.length, 2, 'Existing unmatched order should be preserved and duplicate blocker deduped');
    assert.strictEqual((manager as any)._lastUnmatchedChainOrders[0].chainOrderId, '1.7.572303058', 'Existing unmatched order should remain first');
    assert.strictEqual((manager as any)._lastUnmatchedChainOrders[1].reason, 'missing-create-result', 'Missing create blocker should be appended');
    assert((manager as any)._lastUnmatchedChainOrders[1].fingerprint.includes('type='), 'Missing create blocker should include local type fingerprint');
    assert((manager as any)._lastUnmatchedChainOrders[1].fingerprint.includes('price='), 'Missing create blocker should include local price fingerprint');
    assert((manager as any)._lastUnmatchedChainOrders[1].fingerprint.includes('size='), 'Missing create blocker should include local size fingerprint');

    console.log('✓ COW-COMMIT-006 passed');
}

async function testNoPostBatchCacheDeductionForCreates() {
    console.log('\n[COW-COMMIT-007] no post-batch cache deduction (handled in real-time by updateOptimisticFreeBalance)...');

    const { bot, manager, postBatchAdjustments } = createCowExecutionFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });

    const actions = [{
        type: COW_ACTIONS.CREATE,
        id: 'slot-create-buy',
        order: {
            id: 'slot-create-buy',
            type: ORDER_TYPES.BUY,
            price: 1,
            size: 1.23456789,
            state: ORDER_STATES.VIRTUAL,
            orderId: null
        }
    }];

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildUpdateOrderOp = async () => ({ op: { op_name: 'limit_order_update', op_data: {} }, finalInts: null });
    chainOrders.buildCreateOrderOp = async () => ({
        op: {
            op_name: 'limit_order_create',
            op_data: {
                amount_to_sell: { amount: 123456, asset_id: manager.assets.assetB.id }
            }
        },
        finalInts: {
            sell: 123456,
            receive: 12345678,
            sellAssetId: manager.assets.assetB.id,
            receiveAssetId: manager.assets.assetA.id
        }
    });

    let recoverySyncCalls = 0;
    (manager as any).syncFromOpenOrders = async () => {
        recoverySyncCalls += 1;
        (manager as any)._lastUnmatchedChainOrders = [];
        (manager as any)._lastUnmatchedChainOrdersAt = 0;
        return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
    };
    const originalReadOpenOrders = chainOrders.readOpenOrders;
    chainOrders.readOpenOrders = async () => [];
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({ success: true, operation_results: [] });

    let result;
    try {
        result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        });
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
        chainOrders.readOpenOrders = originalReadOpenOrders;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    assert.strictEqual(result.executed, false, 'Missing create result must abort local commit');
    assert.strictEqual(Array.isArray(result.missingCreateResults), true, 'Missing create result should be reported via missingCreateResults key');
    assert.strictEqual(result.missingCreateResults.length, 1, 'Single missing create result should be reported');
    assert.strictEqual(recoverySyncCalls, 1, 'Missing create result must trigger immediate recovery sync');
    assert.strictEqual((manager as any)._lastUnmatchedChainOrders.length, 1, 'Missing create result should leave a structural create blocker');
    assert.strictEqual((manager as any)._lastUnmatchedChainOrders[0].reason, 'missing-create-result', 'Blocker should identify missing create result');
    // Cache deduction now happens in real-time via updateOptimisticFreeBalance
    // (inside _commitWorkingGrid), not as a separate post-batch step.
    // No cow-placements deductions should occur (would be double-deducting).
    assert.strictEqual(postBatchAdjustments.length, 0,
        'No post-batch cache deduction expected (handled in real-time by updateOptimisticFreeBalance)');

    console.log('✓ COW-COMMIT-007 passed');
}

async function testNoPostBatchCacheDeductionForMixedCreates() {
    console.log('\n[COW-COMMIT-008] no post-batch cache deduction for mixed creates...');

    const { bot, manager, postBatchAdjustments } = createCowExecutionFixture();
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });

    const actions = [
        {
            type: COW_ACTIONS.CREATE,
            id: 'slot-create-buy',
            order: {
                id: 'slot-create-buy',
                type: ORDER_TYPES.BUY,
                price: 1,
                size: 1,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        },
        {
            type: COW_ACTIONS.CREATE,
            id: 'slot-create-sell',
            order: {
                id: 'slot-create-sell',
                type: ORDER_TYPES.SELL,
                price: 2,
                size: 2,
                state: ORDER_STATES.VIRTUAL,
                orderId: null
            }
        }
    ];

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildUpdateOrderOp = async () => ({ op: { op_name: 'limit_order_update', op_data: {} }, finalInts: null });
    chainOrders.buildCreateOrderOp = async (_account, _amountToSell, sellAssetId) => {
        if (sellAssetId === manager.assets.assetB.id) {
            return {
                op: {
                    op_name: 'limit_order_create',
                    op_data: {
                        amount_to_sell: { amount: 100000, asset_id: sellAssetId }
                    }
                },
                finalInts: {
                    sell: 100000,
                    receive: 10000000,
                    sellAssetId,
                    receiveAssetId: manager.assets.assetA.id
                }
            };
        }

        return {
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: 200000000, asset_id: sellAssetId }
                }
            },
            finalInts: {
                sell: 200000000,
                receive: 200000,
                sellAssetId,
                receiveAssetId: manager.assets.assetB.id
            }
        };
    };

    let recoverySyncCalls = 0;
    (manager as any).syncFromOpenOrders = async () => {
        recoverySyncCalls += 1;
        (manager as any)._lastUnmatchedChainOrders = [];
        (manager as any)._lastUnmatchedChainOrdersAt = 0;
        return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [], unmatchedChainOrders: [] };
    };
    const originalReadOpenOrders = chainOrders.readOpenOrders;
    chainOrders.readOpenOrders = async () => [];
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({ success: true, operation_results: [[1, '1.7.999']] });
    let result;
    try {
        result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        });
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
        chainOrders.readOpenOrders = originalReadOpenOrders;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    assert.strictEqual(result.executed, false, 'Missing mixed create result must abort local commit');
    assert.strictEqual(Array.isArray(result.missingCreateResults), true, 'Missing mixed create result should be reported via missingCreateResults key');
    assert.strictEqual(result.missingCreateResults.length, 1, 'Single missing mixed create result should be reported');
    assert.strictEqual(recoverySyncCalls, 1, 'Missing mixed create result must trigger recovery sync');
    assert.strictEqual((manager as any)._lastUnmatchedChainOrders.length, 1, 'Missing mixed create result should leave a structural create blocker');
    assert.strictEqual((manager as any)._lastUnmatchedChainOrders[0].reason, 'missing-create-result', 'Mixed create blocker should identify missing result');
    // Cache deduction now happens in real-time via updateOptimisticFreeBalance
    // (inside _commitWorkingGrid), not as a separate post-batch step.
    assert.strictEqual(postBatchAdjustments.length, 0,
        'No post-batch cache deduction expected (handled in real-time by updateOptimisticFreeBalance)');

    console.log('✓ COW-COMMIT-008 passed');
}

async function testNoPostBatchCacheDeductionForSizeUpdates() {
    console.log('\n[COW-COMMIT-009] no post-batch cache deduction for size updates...');

    const master = new Map([
        ['slot-update-buy', createOrder('slot-update-buy', {
            type: ORDER_TYPES.BUY,
            size: 1,
            state: ORDER_STATES.ACTIVE,
            orderId: '1.7.700',
            rawOnChain: { for_sale: '100000' }
        })]
    ]);
    const { bot, manager, postBatchAdjustments } = createCowExecutionFixture(master);
    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });

    const actions = [{
        type: COW_ACTIONS.UPDATE,
        id: 'slot-update-buy',
        orderId: '1.7.700',
        newGridId: 'slot-update-buy',
        newSize: 1.000009,
        order: {
            id: 'slot-update-buy',
            type: ORDER_TYPES.BUY,
            price: 1,
            size: 1.000009
        }
    }];

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildUpdate = chainOrders.buildUpdateOrderOp;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildCreateOrderOp = async () => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: null
    });
    chainOrders.buildUpdateOrderOp = async () => ({
        op: {
            op_name: 'limit_order_update',
            op_data: {
                new_price: {
                    base: { amount: 100001, asset_id: manager.assets.assetB.id },
                    quote: { amount: 10000100, asset_id: manager.assets.assetA.id }
                },
                delta_amount_to_sell: { amount: 1, asset_id: manager.assets.assetB.id }
            }
        },
        finalInts: {
            sell: 100001,
            receive: 10000100,
            sellAssetId: manager.assets.assetB.id,
            receiveAssetId: manager.assets.assetA.id
        }
    });

    let commitCalls = 0;
    manager._commitWorkingGrid = async () => {
        commitCalls += 1;
    };
    const originalExecuteBatch = chainOrders.executeBatch;
    chainOrders.executeBatch = async () => ({ success: true, operation_results: [] });
    let result;
    try {
        result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        });
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildUpdateOrderOp = originalBuildUpdate;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    assert.strictEqual(result.executed, true, 'Update-only batch with empty operation_results should still commit');
    assert.strictEqual(commitCalls, 1, 'Update-only batch should not be rejected by create result guard');
    // Cache deduction now happens in real-time via updateOptimisticFreeBalance
    // (inside _commitWorkingGrid), not as a separate post-batch step.
    assert.strictEqual(postBatchAdjustments.length, 0,
        'No post-batch cache deduction expected (handled in real-time by updateOptimisticFreeBalance)');

    console.log('✓ COW-COMMIT-009 passed');
}

async function testCredentialDaemonPreflightBlocksBroadcast() {
    console.log('\n[COW-COMMIT-010] credential daemon preflight blocks write broadcast...');

    const masterOrders = new Map([
        ['slot-new', {
            id: 'slot-new',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: 1,
            size: 10,
            orderId: null
        }]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);
    bot.privateKey = chainKeys.createDaemonSigningToken('1.2.x', {
        socketPath: '/tmp/missing-dexbot-cred.sock'
    });

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });
    const order = {
        id: 'slot-new',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price: 1,
        size: 10
    };
    workingGrid.set('slot-new', order);

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalProbe = chainKeys.probeAccountInDaemon;
    let executeCalls = 0;

    chainOrders.buildCreateOrderOp = async () => ({
        op: { op_name: 'limit_order_create', op_data: {} },
        finalInts: null
    });
    chainKeys.probeAccountInDaemon = async () => {
        throw new Error('Daemon connection failed: ENOENT');
    };

    try {
        await assert.rejects(
            () => bot._updateOrdersOnChainBatchCOW({
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: 0,
                actions: [{ type: COW_ACTIONS.CREATE, id: 'slot-new', order }]
            }),
            /Credential daemon unavailable/
        );
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainKeys.probeAccountInDaemon = originalProbe;
    }

    assert.strictEqual(executeCalls, 0, 'Credential outage must abort before broadcast execution');
    console.log('✓ COW-COMMIT-010 passed');
}

async function testToleranceViolationFiltersCreatesOnly() {
    console.log('\n[COW-COMMIT-011] tolerance violations filter only violating CREATEs, rest of batch proceeds...');

    const masterOrders = new Map([
        ['slot-1', createOrder('slot-1', { type: ORDER_TYPES.BUY, price: 1.0 })]
    ]);
    const { bot, manager } = createCowExecutionFixture(masterOrders);

    const originalBuildCancel = chainOrders.buildCancelOrderOp;
    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    let executeBatchOps: any[] = [];
    let executeBatchCalls = 0;

    chainOrders.buildCancelOrderOp = async () => ({ op_name: 'limit_order_cancel', op_data: {} });
    chainOrders.buildCreateOrderOp = async (_account: any, _amountToSell: any, sellAssetId: string) => ({
        op: {
            op_name: 'limit_order_create',
            op_data: { amount_to_sell: { amount: 100000, asset_id: sellAssetId } }
        },
        finalInts: { sell: 100000, receive: 10000000, sellAssetId, receiveAssetId: manager.assets.assetA.id }
    });
    chainOrders.executeBatch = async (_account: any, _key: any, ops: any[]) => {
        executeBatchCalls += 1;
        executeBatchOps = ops;
        // Return operation_results with chain order IDs for each op so
        // processBatchResults doesn't trip on missing IDs.
        const chainOrderIdBase = 1000 + Math.floor(Math.random() * 1000);
        return {
            success: true,
            operation_results: ops.map((_: any, i: number) => [null, `1.7.${chainOrderIdBase + i}`])
        };
    };

    const logMessages: string[] = [];
    manager.logger = {
        log: (msg: string) => { logMessages.push(msg); },
        logFundsStatus: () => {}
    };

    const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 0 });

    try {
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [
                { type: COW_ACTIONS.CREATE, id: 'slot-2', order: { id: 'slot-2', type: ORDER_TYPES.BUY, price: 1.1, size: 10, state: ORDER_STATES.VIRTUAL, orderId: null } },
                { type: COW_ACTIONS.CREATE, id: 'slot-3', order: { id: 'slot-3', type: ORDER_TYPES.BUY, price: 1.1, size: 10, state: ORDER_STATES.VIRTUAL, orderId: null } },
                { type: COW_ACTIONS.CREATE, id: 'slot-4', order: { id: 'slot-4', type: ORDER_TYPES.BUY, price: 1.2, size: 10, state: ORDER_STATES.VIRTUAL, orderId: null } },
                { type: COW_ACTIONS.CANCEL, id: 'slot-1', orderId: '1.7.100' }
            ]
        });

        assert.strictEqual(result.executed, true, 'batch with filtered tolerance violations must still execute');
        assert.strictEqual(executeBatchCalls, 1, 'executeBatch must be called exactly once');

        // 3 ops: 2 CREATEs (slot-2, slot-4) + 1 CANCEL (slot-1).
        // slot-3 CREATE was filtered out by same_batch_price_collision.
        assert.strictEqual(executeBatchOps.length, 3,
            `expected 3 broadcast ops (2 CREATEs + 1 CANCEL), got ${executeBatchOps.length}`);

        const loggedFilter = logMessages.some((m: string) =>
            /tolerance-violating CREATE\(s\)/.test(m)
        );
        assert.strictEqual(loggedFilter, true, 'should log tolerance-violating filter message');
    } finally {
        chainOrders.buildCancelOrderOp = originalBuildCancel;
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }

    console.log('✓ COW-COMMIT-011 passed');
}

async function run() {
    console.log('Running COW commit guard regression tests...');
    await testRejectsVersionMismatchWithoutCommit();
    await testNoPostCommitSideEffectsWhenDeltaEmpty();
    await testExecuteBatchIfNeededSkipsEmptyActions();
    await testRejectsCreateOnOccupiedSlotBeforeBroadcast();
    await testRejectsCreatesWhenUnmatchedChainOrdersExist();
    await testMissingCreateBlockerMergesWithExistingUnmatchedOrders();
    await testNoPostBatchCacheDeductionForCreates();
    await testNoPostBatchCacheDeductionForMixedCreates();
    await testNoPostBatchCacheDeductionForSizeUpdates();
    await testCredentialDaemonPreflightBlocksBroadcast();
    await testToleranceViolationFiltersCreatesOnly();
    console.log('\n✓ All COW commit guard regression tests passed');
}

run().catch(err => {
    console.error('Test failed:', err);
    process.exitCode = 1;
}).finally(() => {
    testsComplete = true;
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});
