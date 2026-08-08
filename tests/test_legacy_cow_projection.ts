const assert = require('assert');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const DEXBot = require('../modules/dexbot_class').default;
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

    console.error('✗ Legacy COW projection tests failed');
    console.error(reason);
    process.exit(1);
});

async function testLegacyProjectionIntoWorkingGrid() {
    const bot = new DEXBot({
        botKey: 'test_legacy_cow_projection',
        dryRun: true,
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        startPrice: 1300,
        incrementPercent: 0.4
    });

    bot.manager = {
        _gridVersion: 9,
        boundaryIdx: 100,
        orders: new Map([
            ['slot-101', { id: 'slot-101', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 1310.85, size: 0, orderId: null }],
            ['slot-200', { id: 'slot-200', type: ORDER_TYPES.BUY, state: ORDER_STATES.PARTIAL, price: 1290, size: 1.2, orderId: '1.7.200' }],
            ['slot-300', { id: 'slot-300', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 1326, size: 0.06, orderId: '1.7.300' }]
        ])
    };

    let captured = null;
    bot._updateOrdersOnChainBatchCOW = async (cowResult) => {
        captured = cowResult;
        return { executed: true, hadRotation: true };
    };

    await bot.updateOrdersOnChainPlan({
        ordersToPlace: [
            { id: 'slot-101', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 1310.85, size: 0.0607 }
        ],
        ordersToUpdate: [
            {
                partialOrder: {
                    id: 'slot-200',
                    orderId: '1.7.200',
                    type: ORDER_TYPES.BUY,
                    state: ORDER_STATES.PARTIAL,
                    price: 1290,
                    size: 1.2
                },
                newSize: 1.5
            }
        ],
        ordersToCancel: [
            { id: 'slot-300', orderId: '1.7.300' }
        ]
    });

    assert(captured, 'legacy path should forward normalized COW result');
    assert.strictEqual(captured.workingGrid.baseVersion, 9, 'working grid should preserve manager grid version');

    const projectedCreate = captured.workingGrid.get('slot-101');
    assert.strictEqual(projectedCreate.type, ORDER_TYPES.SELL, 'create projection should assign target side');
    assert.strictEqual(projectedCreate.size, 0.0607, 'create projection should preserve target size');
    assert.strictEqual(projectedCreate.state, ORDER_STATES.VIRTUAL, 'create projection should remain virtual before sync');
    assert.strictEqual(projectedCreate.orderId, null, 'create projection should clear orderId before placement');

    const projectedUpdate = captured.workingGrid.get('slot-200');
    assert.strictEqual(projectedUpdate.size, 1.5, 'update projection should apply new size');
    assert.strictEqual(projectedUpdate.orderId, '1.7.200', 'update projection should preserve orderId');

    const projectedCancel = captured.workingGrid.get('slot-300');
    assert.strictEqual(projectedCancel.type, ORDER_TYPES.SPREAD, 'cancel projection should virtualize to spread slot');
    assert.strictEqual(projectedCancel.state, ORDER_STATES.VIRTUAL, 'cancel projection should set virtual state');

    const updateAction = captured.actions.find(a => a.type === COW_ACTIONS.UPDATE);
    assert(updateAction, 'legacy update should normalize into COW update action');
    assert.strictEqual(updateAction.id, 'slot-200', 'normalized update action should use partialOrder.id');
    assert.strictEqual(updateAction.orderId, '1.7.200', 'normalized update action should use partialOrder.orderId');
}

async function testOutsideInPairGrouping() {
    const bot = new DEXBot({
        botKey: 'test_outside_in_pair_grouping',
        dryRun: true,
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        startPrice: 100,
        incrementPercent: 1
    });

    const groups = bot._buildOutsideInPairGroupsForOrders([
        { id: 's-near', type: ORDER_TYPES.SELL, price: 101, size: 1 },
        { id: 's-mid', type: ORDER_TYPES.SELL, price: 102, size: 1 },
        { id: 's-out', type: ORDER_TYPES.SELL, price: 103, size: 1 },
        { id: 'b-near', type: ORDER_TYPES.BUY, price: 99, size: 1 },
        { id: 'b-out', type: ORDER_TYPES.BUY, price: 97, size: 1 }
    ]);

    assert.strictEqual(groups.length, 3, 'should build outside-in groups with singleton tail when one side is longer');

    assert.deepStrictEqual(
        groups[0].map(o => o.id),
        ['s-out', 'b-out'],
        'first group should pair outermost sell+buy'
    );

    assert.deepStrictEqual(
        groups[1].map(o => o.id),
        ['s-mid', 'b-near'],
        'second group should move inward on both sides'
    );

    assert.deepStrictEqual(
        groups[2].map(o => o.id),
        ['s-near'],
        'final group should contain remaining near-center side'
    );
}

async function testOutsideInPairGroupingForCreateEntries() {
    const bot = new DEXBot({
        botKey: 'test_outside_in_create_entries',
        dryRun: true,
        assetA: 'IOB.XRP',
        assetB: 'BTS',
        startPrice: 100,
        incrementPercent: 1
    });

    const groups = bot._buildOutsideInPairGroupsForCreateEntries([
        { operation: { op_name: 'limit_order_create' }, context: { kind: 'create', order: { id: 's-near', type: ORDER_TYPES.SELL, price: 101, size: 1 } } },
        { operation: { op_name: 'limit_order_create' }, context: { kind: 'create', order: { id: 's-out', type: ORDER_TYPES.SELL, price: 104, size: 1 } } },
        { operation: { op_name: 'limit_order_create' }, context: { kind: 'create', order: { id: 'b-near', type: ORDER_TYPES.BUY, price: 99, size: 1 } } },
        { operation: { op_name: 'limit_order_create' }, context: { kind: 'create', order: { id: 'b-out', type: ORDER_TYPES.BUY, price: 96, size: 1 } } }
    ]);

    assert.strictEqual(groups.length, 2, 'should build two paired groups when both sides have equal depth');
    assert.deepStrictEqual(groups[0].map(e => e.context.order.id), ['s-out', 'b-out'], 'first create group should be outermost pair');
    assert.deepStrictEqual(groups[1].map(e => e.context.order.id), ['s-near', 'b-near'], 'second create group should move toward center');
}

async function run() {
    console.log('Running legacy COW projection tests...');
    await testLegacyProjectionIntoWorkingGrid();
    await testOutsideInPairGrouping();
    await testOutsideInPairGroupingForCreateEntries();
    console.log('✓ Legacy COW projection tests passed');
}

run().catch((err) => {
    console.error('✗ Legacy COW projection tests failed');
    console.error(err);
    process.exitCode = 1;
}).finally(() => {
    testsComplete = true;
    setTimeout(() => process.exit(process.exitCode || 0), 20);
});
