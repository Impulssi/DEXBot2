const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const { findPriceCollision } = require('../modules/order/utils/math');
const { isOrderPlaced } = require('../modules/order/utils/order');

const {
    _createOrderFromGrid,
    _executeStartupCreateGroupBatch,
} = require('../modules/order/grid_reconcile_internal');

let nextId = 100;

function makeAssets(overrides = {}) {
    return {
        assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
        assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        ...overrides,
    };
}

function makePlacedOrder(id, price, size, type = ORDER_TYPES.BUY) {
    return {
        id,
        price,
        size,
        type,
        orderId: `1.7.${++nextId}`,
        state: ORDER_STATES.ACTIVE,
    };
}

function makeVirtualOrder(id, price, size, type = ORDER_TYPES.BUY) {
    return {
        id,
        price,
        size,
        type,
        orderId: null,
        state: ORDER_STATES.VIRTUAL,
    };
}

function makeManager(orders = []) {
    const logs: any[] = [];
    const orderMap = new Map(orders.map(o => [o.id, o]));
    return {
        orders: orderMap,
        assets: makeAssets(),
        logger: {
            log: (msg, level) => { logs.push({ msg, level }); },
        },
        logs,
        _applySync: async () => {},
        getOrdersByTypeAndState: (type, state) => {
            return Array.from(orderMap.values()).filter(o => o && o.type === type && o.state === state);
        },
        _gridLock: { acquire: async (fn) => await fn() },
        synchronizeWithChain: async () => {},
    };
}

function makeChainOrders(createFn = async () => []) {
    return {
        createOrder: createFn,
        buildCreateOrderOp: async () => ({
            op: {
                op_name: 'limit_order_create',
                op_data: { fee: { amount: 0, asset_id: '1.3.0' } },
            },
        }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => {},
        updateOrder: async () => {},
        readOpenOrders: async () => [],
    };
}

// ============================================================
// TESTS: findPriceCollision (shared utility)
// ============================================================

async function testFindPriceCollisionDetectsMatch() {
    const assets = makeAssets();
    const existing = makePlacedOrder('slot1', 100, 50, ORDER_TYPES.BUY);
    const orders = [existing];

    const result = findPriceCollision(
        orders, 'slot2', 100, 50, ORDER_TYPES.BUY, assets, isOrderPlaced
    );

    assert.strictEqual(result, existing, 'Should detect collision at same price');
    console.log('✅ findPriceCollision detects same-price match');
}

async function testFindPriceCollisionNoMatch() {
    const assets = makeAssets();
    const existing = makePlacedOrder('slot1', 200, 50, ORDER_TYPES.BUY);
    const orders = [existing];

    const result = findPriceCollision(
        orders, 'slot2', 100, 50, ORDER_TYPES.BUY, assets, isOrderPlaced
    );

    assert.strictEqual(result, null, 'Should return null for non-overlapping prices');
    console.log('✅ findPriceCollision returns null for distant prices');
}

async function testFindPriceCollisionExcludeSelf() {
    const assets = makeAssets();
    const order = makePlacedOrder('slot1', 100, 50, ORDER_TYPES.BUY);
    const orders = [order];

    const result = findPriceCollision(
        orders, 'slot1', 100, 50, ORDER_TYPES.BUY, assets, isOrderPlaced
    );

    assert.strictEqual(result, null, 'Should skip excludeId');
    console.log('✅ findPriceCollision excludes own slot');
}

async function testFindPriceCollisionNullPrice() {
    const assets = makeAssets();
    const existing = { id: 'slot1', price: null, size: 50, type: ORDER_TYPES.BUY, orderId: '1.7.1' };
    const orders = [existing];

    const result = findPriceCollision(
        orders, 'slot2', 100, 50, ORDER_TYPES.BUY, assets, isOrderPlaced
    );

    assert.strictEqual(result, null, 'Should skip items with null price');
    console.log('✅ findPriceCollision handles null candidate price');
}

// ============================================================
// TESTS: _createOrderFromGrid price collision guard
// ============================================================

async function testCreateOrderFromGridSkipsOnCollision() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    const existing = makePlacedOrder('existing-slot', 100, 50, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, false, 'Should NOT call createOrder when price collision exists');
    assert.ok(manager.logs.length > 0 && manager.logs[manager.logs.length - 1].msg.includes('SKIP'),
        'Should log skip message');
    console.log('✅ _createOrderFromGrid skips create on price collision');
}

async function testCreateOrderFromGridProceedsWithoutCollision() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    const existing = makePlacedOrder('existing-slot', 200, 50, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, true, 'Should call createOrder when no price collision');
    console.log('✅ _createOrderFromGrid proceeds to create without collision');
}

async function testCreateOrderFromGridSkipsOnOwnOrderId() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    const target = makePlacedOrder('target-slot', 100, 50, ORDER_TYPES.BUY);
    const manager = makeManager([target]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, false, 'Should skip when slot already has orderId');
    console.log('✅ _createOrderFromGrid skips when slot already has orderId');
}

async function testCreateOrderFromGridOrderIdCheckFiresBeforePriceCheck() {
    let createCalled = false;
    const chainOrders = makeChainOrders(async () => { createCalled = true; return []; });

    // Target has orderId AND there's another order at the same price.
    // The orderId check must fire first, before the price collision check runs.
    const existing = makePlacedOrder('other-slot', 100, 50, ORDER_TYPES.BUY);
    const target = makePlacedOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    await _createOrderFromGrid({
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        gridOrder: target,
        dryRun: false,
    });

    assert.strictEqual(createCalled, false, 'Should skip before reaching chain');
    // The log should mention orderId (from the first guard), not collision (from the second).
    const lastLog = manager.logs[manager.logs.length - 1];
    assert.ok(lastLog && lastLog.msg.includes('already has orderId'),
        'Log should mention orderId (first guard), not price collision');
    console.log('✅ _createOrderFromGrid orderId check fires before price collision check');
}

// ============================================================
// TESTS: _executeStartupCreateGroupBatch price collision guard
// ============================================================

async function testStartupBatchSkipsOnCollision() {
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [] }; };

    const existing = makePlacedOrder('existing-slot', 100, 50, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    const group = [{
        gridOrder: target,
        orderLabel: 'BUY:target-slot',
    }];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, false, 'Should NOT call executeBatch when price collision exists');
    console.log('✅ _executeStartupCreateGroupBatch skips batch on price collision');
}

async function testStartupBatchProceedsWithoutCollision() {
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [['1.7.100', '1.7.100']] }; };

    const existing = makePlacedOrder('existing-slot', 200, 50, ORDER_TYPES.BUY);
    const target = makeVirtualOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    const group = [{
        gridOrder: target,
        orderLabel: 'BUY:target-slot',
    }];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, true, 'Should call executeBatch when no price collision');
    console.log('✅ _executeStartupCreateGroupBatch proceeds to batch without collision');
}

async function testStartupBatchSkipsOnOwnOrderId() {
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [] }; };

    const target = makePlacedOrder('target-slot', 100, 50, ORDER_TYPES.BUY);
    const manager = makeManager([target]);

    const group = [{
        gridOrder: target,
        orderLabel: 'BUY:target-slot',
    }];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, false, 'Should skip when slot already has orderId');
    console.log('✅ _executeStartupCreateGroupBatch skips when slot already has orderId');
}

async function testStartupBatchFiltersOnlyCollidingItems() {
    let batchOpCount = 0;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => {
        batchOpCount++;
        return { success: true, operation_results: [] };
    };

    const existing1 = makePlacedOrder('existing-buy', 100, 50, ORDER_TYPES.BUY);
    const target1 = makeVirtualOrder('target-buy', 100, 50, ORDER_TYPES.BUY);
    const target2 = makeVirtualOrder('target-sell', 150, 50, ORDER_TYPES.SELL);

    const manager = makeManager([existing1, target1, target2]);

    const group = [
        { gridOrder: target1, orderLabel: 'BUY:target-buy' },
        { gridOrder: target2, orderLabel: 'SELL:target-sell' },
    ];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchOpCount, 1, 'Should execute batch once with filtered ops');
    console.log('✅ _executeStartupCreateGroupBatch filters only colliding items in multi-order batch');
}

async function testStartupBatchOrderIdCheckFiresBeforePriceCheck() {
    let batchCalled = false;
    const chainOrders = makeChainOrders();
    chainOrders.executeBatch = async () => { batchCalled = true; return { success: true, operation_results: [] }; };

    // Target has orderId AND another order at same price. The orderId check must fire first.
    const existing = makePlacedOrder('other-slot', 100, 50, ORDER_TYPES.BUY);
    const target = makePlacedOrder('target-slot', 100, 50, ORDER_TYPES.BUY);

    const manager = makeManager([existing, target]);

    const group = [{
        gridOrder: target,
        orderLabel: 'BUY:target-slot',
    }];

    await _executeStartupCreateGroupBatch({
        group,
        chainOrders,
        account: 'test-account',
        privateKey: 'test-key',
        manager,
        dryRun: false,
        groupIndex: 0,
        totalGroups: 1,
    });

    assert.strictEqual(batchCalled, false, 'Should skip before reaching chain');
    console.log('✅ _executeStartupCreateGroupBatch orderId check fires before price collision check');
}

// ============================================================
// RUN ALL TESTS
// ============================================================

(async () => {
    console.log('\n========== PRICE COLLISION GUARD TESTS ==========\n');

    // findPriceCollision utility
    await testFindPriceCollisionDetectsMatch();
    await testFindPriceCollisionNoMatch();
    await testFindPriceCollisionExcludeSelf();
    await testFindPriceCollisionNullPrice();

    // _createOrderFromGrid
    await testCreateOrderFromGridSkipsOnCollision();
    await testCreateOrderFromGridProceedsWithoutCollision();
    await testCreateOrderFromGridSkipsOnOwnOrderId();
    await testCreateOrderFromGridOrderIdCheckFiresBeforePriceCheck();

    // _executeStartupCreateGroupBatch
    await testStartupBatchSkipsOnCollision();
    await testStartupBatchProceedsWithoutCollision();
    await testStartupBatchSkipsOnOwnOrderId();
    await testStartupBatchFiltersOnlyCollidingItems();
    await testStartupBatchOrderIdCheckFiresBeforePriceCheck();

    console.log('\n✅ All price collision guard tests passed!\n');
})().catch((err) => {
    console.error('\n❌ PRICE COLLISION GUARD TEST FAILED:');
    console.error(err);
    process.exit(1);
});
