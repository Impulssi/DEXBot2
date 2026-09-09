// Regression tests for https://github.com/froooze/DEXBot2/issues/23
// synchronizeWithChain(createOrder) silently dropped the chain linkage when the
// grid id was unknown to master, causing duplicate CREATEs on the next cycle.
// Also covers the sibling path: restoreDiscardedCreates with a missing slot.
const assert = require('assert');

const { OrderManager } = require('../modules/order/manager');

const { restoreDiscardedCreates } = require('../modules/dexbot_cow_runtime');

function createManagerFixture(logs) {
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });

    manager.logger = {
        log: (message, level) => logs.push({ message, level }),
        marketName: 'TEST/USD',
        logFundsStatus: () => {}
    };

    manager.accountant = {
        updateOptimisticFreeBalance: async () => {},
        recalculateFunds: async () => {},
        tryDeductFromChainFree: async () => ({ ok: true }),
        addToChainFree: async () => true
    };

    manager.assets = {
        assetA: { symbol: 'BTS', id: '1.3.0', precision: 5 },
        assetB: { symbol: 'USD', id: '1.3.121', precision: 4 }
    };

    manager._gridLock = {
        acquire: async (callback) => await callback()
    };
    manager.config = manager.config || {};
    manager.config.startPrice = 1;

    return manager;
}

async function testUnknownIdWithDescriptorMaterializes() {
    console.log('\n[CREATE-UNKNOWN-001] unknown grid id + descriptor materializes the slot...');
    const logs = [];
    const manager = createManagerFixture(logs);

    await manager.sync.synchronizeWithChain({
        gridOrderId: 'deep-1',
        chainOrderId: '1.7.111',
        isPartialPlacement: false,
        expectedType: 'buy',
        fee: 0,
        order: { id: 'deep-1', type: 'buy', price: 0.9, size: 10 },
    }, 'createOrder');

    const order = manager.orders.get('deep-1');
    assert.ok(order, 'slot must be materialized in master');
    assert.strictEqual(order.orderId, '1.7.111', 'chain linkage must be recorded');
    assert.strictEqual(order.state, 'active', 'full placement transitions to ACTIVE');
    assert.ok(!logs.some((e) => e.level === 'error'), 'no error must be logged on recovery');

    // Second linkage for the same broadcast is idempotent, not a duplicate.
    logs.length = 0;
    await manager.sync.synchronizeWithChain({
        gridOrderId: 'deep-1',
        chainOrderId: '1.7.111',
        isPartialPlacement: false,
        expectedType: 'buy',
        fee: 0,
        order: { id: 'deep-1', type: 'buy', price: 0.9, size: 10 },
    }, 'createOrder');
    assert.strictEqual(manager.orders.get('deep-1').orderId, '1.7.111');

    console.log('  PASS');
}

async function testUnknownIdWithoutDescriptorLogsError() {
    console.log('\n[CREATE-UNKNOWN-002] unknown grid id without descriptor logs an error...');
    const logs = [];
    const manager = createManagerFixture(logs);

    await manager.sync.synchronizeWithChain({
        gridOrderId: 'slot-9',
        chainOrderId: '1.7.222',
        isPartialPlacement: false,
        expectedType: 'buy',
        fee: 0,
    }, 'createOrder');

    assert.strictEqual(manager.orders.get('slot-9'), undefined, 'nothing may be fabricated without a descriptor');
    assert.ok(
        logs.some((e) => e.level === 'error' && /createOrder linkage LOST/.test(e.message)),
        'linkage loss must be logged as an error, never dropped silently'
    );

    console.log('  PASS');
}

async function testUnknownIdAlreadyTrackedIsIdempotent() {
    console.log('\n[CREATE-UNKNOWN-003] unknown grid id with already-tracked chain id is a no-op...');
    const logs = [];
    const manager = createManagerFixture(logs);
    manager.orders.set('slot-3', { id: 'slot-3', type: 'buy', state: 'active', price: 0.9, size: 10, orderId: '1.7.333' });

    await manager.sync.synchronizeWithChain({
        gridOrderId: 'slot-99',
        chainOrderId: '1.7.333',
        isPartialPlacement: false,
        expectedType: 'buy',
        fee: 0,
        order: { id: 'slot-99', type: 'buy', price: 0.9, size: 10 },
    }, 'createOrder');

    assert.strictEqual(manager.orders.get('slot-99'), undefined, 'must not duplicate the tracked chain order');
    assert.ok(logs.some((e) => /already tracked/.test(e.message)), 'idempotent skip must be logged');

    console.log('  PASS');
}

function createUncertainBot(logs) {
    const manager = createManagerFixture(logs);
    manager._pendingBroadcasts = new Map();
    return { manager };
}

async function testDiscardedCreateMissingSlotMaterializes() {
    console.log('\n[CREATE-UNKNOWN-004] discarded CREATE with slot missing from master materializes creation-uncertain...');
    const logs = [];
    const bot = createUncertainBot(logs);
    const entry = {
        ctxIndex: 0,
        slotId: 'deep-2',
        order: { id: 'deep-2', type: 'buy', price: 0.85, size: 5 },
        fingerprint: 'fp-deep-2',
    };
    bot.manager._pendingBroadcasts.set(entry.fingerprint, entry);

    // Empty opContexts: the PENDING_BROADCASTS reject path.
    const restored = await restoreDiscardedCreates(bot, [entry], []);

    assert.strictEqual(restored, 1, 'discarded entry must be counted');
    const slot = bot.manager.orders.get('deep-2');
    assert.ok(slot, 'creation-uncertain slot must be materialized in master');
    assert.strictEqual(slot.state, 'virtual', 'restored slot stays VIRTUAL (not on-chain yet)');
    assert.strictEqual(slot.size, 5, 'planned size must be preserved for orphan adoption');
    assert.strictEqual(slot.createUncertain, true, 'slot must be flagged as creation-uncertain');
    assert.strictEqual(slot.orderId, null, 'slot must look like a clean adoption target');
    assert.ok(!bot.manager._pendingBroadcasts.has(entry.fingerprint), 'pending entry must be cleared');
    assert.ok(logs.some((e) => e.level === 'warn' && /materializing creation-uncertain/.test(e.message)), 'recovery must be logged');

    console.log('  PASS');
}

async function testDiscardedCreateMalformedDescriptorLogsError() {
    console.log('\n[CREATE-UNKNOWN-005] discarded CREATE without placement descriptor logs an error...');
    const logs = [];
    const bot = createUncertainBot(logs);
    // Recognizable CREATE (has id+type) but no size: descriptor unusable.
    const sizeless = { ctxIndex: 0, slotId: 'deep-3', order: { id: 'deep-3', type: 'buy', price: 0.8 }, fingerprint: 'fp-deep-3' };
    // Not even recognizable as a CREATE: no id/type at all.
    const typeless = { ctxIndex: 0, slotId: 'deep-4', order: { id: null }, fingerprint: 'fp-deep-4' };
    bot.manager._pendingBroadcasts.set(sizeless.fingerprint, sizeless);
    bot.manager._pendingBroadcasts.set(typeless.fingerprint, typeless);

    await restoreDiscardedCreates(bot, [sizeless, typeless], []);

    assert.strictEqual(bot.manager.orders.get('deep-3'), undefined, 'nothing may be fabricated without a descriptor');
    assert.ok(logs.some((e) => e.level === 'error' && /no usable placement descriptor/.test(e.message)), 'descriptor skip must be logged as an error');
    assert.ok(logs.some((e) => e.level === 'error' && /not a recognizable CREATE/.test(e.message)), 'unrecognized skip must be logged as an error');

    console.log('  PASS');
}

async function run() {
    console.log('Running createOrder unknown-id regression tests (issue #23)...');
    await testUnknownIdWithDescriptorMaterializes();
    await testUnknownIdWithoutDescriptorLogsError();
    await testUnknownIdAlreadyTrackedIsIdempotent();
    await testDiscardedCreateMissingSlotMaterializes();
    await testDiscardedCreateMalformedDescriptorLogsError();
    console.log('\nAll createOrder unknown-id regression tests passed');
}

run().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
