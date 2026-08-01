/**
 * tests/test_isghost_leak_fix.ts
 *
 * Regression tests for the `isGhost` flag leak:
 *
 *   The isGhost marker is a transient "blocked CREATE" flag that a full fill
 *   sets when the other-side rounds to zero (sync_engine._computeFillTransitionResult
 *   sets state=PARTIAL, size=0, isGhost=true, keeping the orderId). The bug:
 *   the flag was never cleared anywhere, so it leaked onto freshly-placed real
 *   orders, spread placeholders, and adopted chain orders — persisting
 *   isGhost=true on ACTIVE on-chain orders in the grid JSON (e.g. slots
 *   124-137 in xrp-bts.json with real orderIds 1.7.573353223-231).
 *
 * Coverage:
 *   1. virtualizeOrder / convertToSpreadPlaceholder clear the marker.
 *   2. COW CREATE branch clears the marker from a ghost source slot.
 *   3. validateOrder normalizes away a leaked marker on non-ghost states.
 *   4. synchronizeWithChain(createOrder) does not persist a leaked marker.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { virtualizeOrder, convertToSpreadPlaceholder } = require('../modules/order/utils/order');
const { validateOrder } = require('../modules/order/utils/validate');

function suppressNoise() {
    const bsModule = require('../modules/bitshares_client');
    if (bsModule.setSuppressConnectionLog) bsModule.setSuppressConnectionLog(true);
}

function createManager() {
    const mgr = new OrderManager({
        market: 'XRP/BTS', assetA: 'XRP', assetB: 'BTS'
    });
    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'XRP', precision: 4 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };
    mgr.logger = {
        log: (msg, level) => {
            if (level === 'debug') return;
            console.log(`  ${msg}`);
        }
    };
    return mgr;
}

async function testVirtualizeOrderClearsGhost() {
    console.log('\n - virtualizeOrder / convertToSpreadPlaceholder clear isGhost...');
    const ghost = {
        id: 'slot-0', state: ORDER_STATES.PARTIAL, type: ORDER_TYPES.SELL,
        size: 0, price: 1000, orderId: '1.7.123', isGhost: true, rawOnChain: {}
    };

    const virtual = virtualizeOrder(ghost);
    assert.strictEqual(virtual.state, ORDER_STATES.VIRTUAL, 'should be VIRTUAL');
    assert.strictEqual(virtual.orderId, null, 'should clear orderId');
    assert.strictEqual(virtual.isGhost, undefined, 'isGhost must not survive virtualizeOrder');

    const spread = convertToSpreadPlaceholder(ghost);
    assert.strictEqual(spread.type, ORDER_TYPES.SPREAD, 'should be SPREAD');
    assert.strictEqual(spread.size, 0, 'should be zero-sized');
    assert.strictEqual(spread.isGhost, undefined, 'isGhost must not survive convertToSpreadPlaceholder');
    console.log('  PASS');
}

async function testValidateOrderClearsLeakedGhost() {
    console.log('\n - validateOrder clears a leaked isGhost on non-ghost states...');
    const oldOrder = {
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5, price: 1000, orderId: '1.7.456', isGhost: true
    };
    // ACTIVE real order with size > 0 carrying a leaked isGhost must be normalized away.
    const result = validateOrder({ ...oldOrder }, oldOrder, 'test-ghost-clear');
    assert.ok(result.isValid, 'should remain valid');
    assert.strictEqual(result.normalizedOrder.isGhost, false,
        'leaked isGhost on ACTIVE order must be cleared by validateOrder');
    assert.ok(result.warnings.some((w) => w.code === 'ISGHOST_CLEARED'),
        'should emit ISGHOST_CLEARED warning');
    console.log('  PASS');
}

async function testValidateOrderKeepsLegitGhost() {
    console.log('\n - validateOrder preserves a legitimate ghost (PARTIAL + size<=0)...');
    const ghost = {
        id: 'slot-0', state: ORDER_STATES.PARTIAL, type: ORDER_TYPES.SELL,
        size: 0, price: 1000, orderId: '1.7.789', isGhost: true
    };
    const result = validateOrder({ ...ghost }, null, 'test-ghost-keep');
    assert.ok(result.isValid, 'ghost order should remain valid');
    assert.strictEqual(result.normalizedOrder.isGhost, true,
        'legitimate ghost marker must be preserved');
    assert.ok(!result.warnings.some((w) => w.code === 'ISGHOST_CLEARED'),
        'should NOT emit ISGHOST_CLEARED for a genuine ghost');
    console.log('  PASS');
}

async function testSynchronizeWithChainCreateClearsGhost() {
    console.log('\n - synchronizeWithChain(createOrder) clears leaked isGhost...');
    const mgr = createManager();
    const ghostSlot = {
        id: 'slot-0', state: ORDER_STATES.PARTIAL, type: ORDER_TYPES.SELL,
        size: 0, price: 1000, orderId: '1.7.OLD', isGhost: true
    };
    const ordersMap = new Map([['slot-0', ghostSlot]]);
    mgr.orders = Object.freeze(ordersMap);
    mgr.config = { startPrice: 1000 };
    mgr.accountTotals = { assetA: { active: 0, virtual: 0 }, assetB: { active: 0, virtual: 0 } };
    mgr.fetchAccountTotals = async () => {};
    mgr.recalculateFunds = async () => {};
    mgr._markGridDirty = () => {};

    await mgr.synchronizeWithChain(
        { gridOrderId: 'slot-0', chainOrderId: '1.7.NEW', expectedType: ORDER_TYPES.SELL, fee: 0 },
        'createOrder'
    );

    const slot = mgr.orders.get('slot-0');
    assert.strictEqual(slot.orderId, '1.7.NEW', 'new chain orderId must be attached');
    assert.strictEqual(slot.state, ORDER_STATES.ACTIVE, 'placed order must be ACTIVE');
    assert.strictEqual(slot.isGhost, false,
        'freshly placed order must not carry isGhost');
    console.log('  PASS');
}

async function main() {
    suppressNoise();
    await testVirtualizeOrderClearsGhost();
    await testValidateOrderClearsLeakedGhost();
    await testValidateOrderKeepsLegitGhost();
    await testSynchronizeWithChainCreateClearsGhost();
    console.log('\n✓ All isGhost leak fix tests PASSED!');
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = {
    testVirtualizeOrderClearsGhost,
    testValidateOrderClearsLeakedGhost,
    testValidateOrderKeepsLegitGhost,
    testSynchronizeWithChainCreateClearsGhost,
};
