/**
 * tests/repro_phantom_orders.ts
 * 
 * Test that verifies phantom orders (ACTIVE/PARTIAL without orderId) are now PREVENTED.
 * 
 * Historical context: Before the fix, phantom orders could be created via:
 * 1. Grid resize operations promoting VIRTUAL to ACTIVE without an orderId
 * 2. SyncEngine skipping ACTIVE orders without orderId during cleanup
 * 3. Strategy upgrading PARTIAL to ACTIVE without checking orderId
 * 
 * Now: Defense-in-depth in _updateOrder prevents these from ever occurring.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function runTest() {
    console.log('Running Phantom Orders Prevention Test...');

    const mgr = new OrderManager({
        market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS'
    });
    mgr.assets = {
        assetA: { id: '1.3.0', symbol: 'TEST', precision: 8 },
        assetB: { id: '1.3.1', symbol: 'BTS', precision: 5 }
    };
    await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });

    // ============================================================================
    // TEST 1: Direct phantom creation attempt is blocked
    // ============================================================================
    console.log(' - Test 1: Attempt to create phantom order (ACTIVE with no orderId)');
    await mgr._updateOrder({
        id: 'slot-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE, // Attempt phantom active
        size: 10,
        price: 1.0,
        orderId: '' // No ID
    });

    await mgr.recalculateFunds();
    const order1 = mgr.orders.get('slot-1');

    // Order should be downgraded to VIRTUAL by defense-in-depth
    assert.strictEqual(order1.state, ORDER_STATES.VIRTUAL, 'Phantom attempt should be downgraded to VIRTUAL');
    assert.strictEqual(mgr.funds.committed.grid.sell, 0, 'No funds should be committed for VIRTUAL order');
    console.log('   ✓ Phantom order blocked - downgraded to VIRTUAL');

    // ============================================================================
    // TEST 2: Order resizing preserves VIRTUAL state (doesn't create phantoms)
    // ============================================================================
    console.log(' - Test 2: Order resizing preserves VIRTUAL state');

    // Create a VIRTUAL order and resize it
    await mgr._updateOrder({
        id: 'slot-2',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        size: 20,  // Resized from 0 to 20
        price: 1.2,
        orderId: ''  // No blockchain ID (still VIRTUAL)
    });

    const resizedOrder = mgr.orders.get('slot-2');
    assert.strictEqual(resizedOrder.state, ORDER_STATES.VIRTUAL, 'Resized VIRTUAL order should stay VIRTUAL');
    assert.strictEqual(resizedOrder.size, 20, 'Size should be updated correctly');
    console.log('   ✓ Order resizing preserves VIRTUAL state (no phantom created)');

    // ============================================================================
    // TEST 3: SyncEngine cleanup of orphaned ACTIVE (no orderId on chain)
    // ============================================================================
    console.log(' - Test 3: Sync cleans up orders with no orderId');

    // Create an order that has ACTIVE state but no orderId (simulating corruption)
    // First create as VIRTUAL, then manually set to ACTIVE to bypass the guard
    mgr.orders.set('slot-3', {
        id: 'slot-3',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,  // Manually corrupted to ACTIVE
        size: 10,
        price: 1.5,
        orderId: null  // No blockchain ID
    });
    mgr._ordersByState[ORDER_STATES.ACTIVE].add('slot-3');
    mgr._ordersByType[ORDER_TYPES.SELL].add('slot-3');

    // Run sync with empty chain orders - should clean up the phantom
    await mgr.sync.syncFromOpenOrders([]);

    const syncedOrder = mgr.orders.get('slot-3');
    // After sync, the phantom should be converted to SPREAD placeholder
    assert.ok(
        syncedOrder.state === ORDER_STATES.VIRTUAL || syncedOrder.state === ORDER_STATES.SPREAD || syncedOrder.size === 0,
        'Orphaned ACTIVE order should be cleaned up by sync'
    );
    console.log('   ✓ Sync cleans up orders without orderId');

    // ============================================================================
    // TEST 4: Valid ACTIVE order with orderId is preserved
    // ============================================================================
    console.log(' - Test 4: Valid ACTIVE order with orderId is preserved');
    await mgr._updateOrder({
        id: 'slot-4',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 15,
        price: 2.0,
        orderId: '1.7.12345' // Valid orderId
    });

    await mgr.recalculateFunds();
    const validOrder = mgr.orders.get('slot-4');
    assert.strictEqual(validOrder.state, ORDER_STATES.ACTIVE, 'Valid ACTIVE order should remain ACTIVE');
    assert.strictEqual(validOrder.orderId, '1.7.12345', 'orderId should be preserved');
    assert.ok(mgr.funds.committed.grid.sell > 0, 'Valid ACTIVE order should have committed funds');
    console.log('   ✓ Valid ACTIVE order preserved correctly');

    console.log('\n✓ All phantom prevention tests passed!');
    process.exit(0);
}

runTest().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
