/**
 * tests/test_validate_create_target_slots.ts
 *
 * Tests the four-layer CREATE validation in validateCreateTargetSlots:
 *   1. Slot occupancy — target slot already has a placed order
 *   2. Master grid price collision — a placed order at the same price in another slot
 *   3. Chain orphan collision — an unmatched on-chain order at the same price
 *   4. Same-batch duplicate — two CREATEs at identical price
 */

const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');
const { validateCreateTargetSlots } = require('../modules/order/utils/validate');

// Helpers
function makeOrder(id, type, price, size, state, orderId) {
    return { id, type, price, size, state, orderId: orderId || `${id}-oid` };
}

function makeCreateAction(targetId, price, type, size = 100) {
    return {
        type: COW_ACTIONS.CREATE,
        id: targetId,
        order: { id: targetId, price, type, size }
    };
}

function makeCancelAction(targetId) {
    return { type: COW_ACTIONS.CANCEL, id: targetId };
}

function makeRotationAction(sourceId, targetId) {
    return { type: COW_ACTIONS.UPDATE, id: sourceId, newGridId: targetId };
}

function mapToOrders(arr) {
    return new Map(arr.map(o => [o.id, o]));
}

const dummyAssets = {
    assetA: { id: '1.3.0', symbol: 'TEST', precision: 8 },
    assetB: { id: '1.3.1', symbol: 'BTS', precision: 5 }
};

async function runTests() {
    console.log('Running validateCreateTargetSlots tests...');

    // ── 1. Slot occupancy ──────────────────────────────────────────────
    console.log(' - 1. Slot occupancy detection...');
    {
        const orders = mapToOrders([
            makeOrder('slot-1', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.ACTIVE, '1.7.1')
        ]);
        const actions = [makeCreateAction('slot-1', 100, ORDER_TYPES.BUY)];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, false, 'create into occupied slot should be invalid');
        assert.strictEqual(result.violations.length, 1, 'exactly one violation');
        assert.strictEqual(result.violations[0].reason, 'slot_occupied', 'reason should be slot_occupied');
    }

    // ── 2. Master grid price collision — REMOVED (genesis-frozen determinism)
    // Same-price different-slot is now VALID (price not authority, slot id is).
    console.log(' - 2. Master grid price collision (now valid)...');
    {
        const orders = mapToOrders([
            makeOrder('slot-a', ORDER_TYPES.SELL, 123.45, 30, ORDER_STATES.ACTIVE, '1.7.10'),
            makeOrder('slot-b', ORDER_TYPES.SELL, 123.45, 30, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [makeCreateAction('slot-b', 123.45, ORDER_TYPES.SELL)];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'same-price different-slot should now be valid (price collision layer removed)');
        assert.strictEqual(result.violations.length, 0, 'zero violations');
    }

    // ── 3. Same price on different side is now VALID ───────────
    console.log(' - 2b. Same price different side is now valid...');
    {
        const orders = mapToOrders([
            makeOrder('slot-buy', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.ACTIVE, '1.7.20'),
            makeOrder('slot-sell', ORDER_TYPES.SELL, 100, 50, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [makeCreateAction('slot-sell', 100, ORDER_TYPES.SELL)];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'same price different side is now valid');
        assert.strictEqual(result.violations.length, 0, 'zero violations');
    }

    // ── 4. Chain orphan collision ─────────────────────────────────────
    console.log(' - 3. Chain orphan collision...');
    {
        const orders = mapToOrders([
            makeOrder('slot-new', ORDER_TYPES.BUY, 200, 40, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [makeCreateAction('slot-new', 200, ORDER_TYPES.BUY)];
        const chainOrderCandidates = [
            { chainOrderId: '1.7.99', chainSlotId: 'slot-new', candidateSlotId: 'slot-new', price: 200, size: 10, type: ORDER_TYPES.BUY }
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets, chainOrderCandidates);
        assert.strictEqual(result.isValid, false, 'chain orphan collision should be invalid');
        assert.strictEqual(result.violations.length, 1, 'exactly one violation');
        assert.strictEqual(result.violations[0].reason, 'chain_orphan_collision', 'reason should be chain_orphan_collision');
    }

    // ── 5. Same-batch duplicate (duplicate slotId) ──────────────────────
    console.log(' - 4. Same-batch duplicate...');
    {
        const orders = mapToOrders([
            makeOrder('slot-x', ORDER_TYPES.BUY, 50, 20, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [
            makeCreateAction('slot-x', 50, ORDER_TYPES.BUY),
            makeCreateAction('slot-x', 50, ORDER_TYPES.BUY)
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, false, 'same-batch duplicate should be invalid');
        assert.strictEqual(result.violations.length, 1, 'exactly one violation');
        assert.strictEqual(result.violations[0].reason, 'same_batch_price_collision', 'reason should be same_batch_price_collision');
    }

    // ── 6. Clean batch passes ─────────────────────────────────────────
    console.log(' - 5. Clean batch passes...');
    {
        const orders = mapToOrders([
            makeOrder('s1', ORDER_TYPES.BUY, 90, 20, ORDER_STATES.VIRTUAL, null),
            makeOrder('s2', ORDER_TYPES.SELL, 110, 20, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [
            makeCreateAction('s1', 90, ORDER_TYPES.BUY),
            makeCreateAction('s2', 110, ORDER_TYPES.SELL)
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'clean batch should be valid');
        assert.strictEqual(result.violations.length, 0, 'zero violations');
    }

    // ── 7. Released slots (cancel frees the slot) ─────────────────────
    console.log(' - 6. Cancel releases slot...');
    {
        const orders = mapToOrders([
            makeOrder('slot-occ', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.ACTIVE, '1.7.1'),
            makeOrder('slot-vac', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.VIRTUAL, null)
        ]);
        // Cancel releases slot-occ, then create into it (same id, same price)
        const actions = [
            makeCancelAction('slot-occ'),
            makeCreateAction('slot-occ', 100, ORDER_TYPES.BUY)
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'cancel releases slot for create');
    }

    // ── 8. Chain orphan with malformed entries ────────────────────────
    console.log(' - 7. Malformed chain orphan entries are skipped...');
    {
        const orders = mapToOrders([
            makeOrder('slot-m', ORDER_TYPES.SELL, 150, 30, ORDER_STATES.VIRTUAL, null)
        ]);
        const actions = [makeCreateAction('slot-m', 150, ORDER_TYPES.SELL)];
        // One entry missing chainOrderId, one missing price — both should be filtered
        const chainOrderCandidates = [
            { price: 150, size: 10, type: ORDER_TYPES.SELL },
            { chainOrderId: '1.7.200', size: 10, type: ORDER_TYPES.SELL }
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets, chainOrderCandidates);
        assert.strictEqual(result.isValid, true, 'malformed entries should be filtered without crashing');
    }

    // ── 9. Assets required for collision checks ────────────────────────
    console.log(' - 8. No assets → no price collision checks (slot occupancy still works)...');
    {
        const orders = mapToOrders([
            makeOrder('slot-a', ORDER_TYPES.BUY, 100, 50, ORDER_STATES.ACTIVE, '1.7.1')
        ]);
        const actions = [makeCreateAction('slot-a', 100, ORDER_TYPES.BUY)];
        const result = validateCreateTargetSlots(actions, orders, null);
        assert.strictEqual(result.isValid, false, 'slot occupancy works without assets');
        assert.strictEqual(result.violations[0].reason, 'slot_occupied');
    }

    // ── 10. Release via rotation (UPDATE with newGridId) ──────────────
    console.log(' - 9. Rotation releases source slot...');
    {
        const orders = mapToOrders([
            makeOrder('src', ORDER_TYPES.SELL, 100, 50, ORDER_STATES.ACTIVE, '1.7.1'),
            makeOrder('released-slot', ORDER_TYPES.SELL, 100, 50, ORDER_STATES.VIRTUAL, null)
        ]);
        // Rotation UPDATE releases src; create into src slot at same price
        const actions = [
            makeRotationAction('src', 'released-slot'),
            makeCreateAction('src', 100, ORDER_TYPES.SELL)
        ];
        const result = validateCreateTargetSlots(actions, orders, dummyAssets);
        assert.strictEqual(result.isValid, true, 'rotation releases source slot for create');
    }

    // ── 11. Bit-exact same-batch price duplicate (on-chain int key) ────
    console.log(' - 10. Layer-5 bit-exact price duplicate keying...');
    {
        // SELL side precision = assetA (8) — the repo-wide side-precision
        // convention. Distinct floats that quantize to the SAME on-chain int
        // (100.000000001 and 100.000000004 both -> 10000000000 at prec 8)
        // must collide — they are one price on the DEX.
        const colliding = [
            makeCreateAction('slot-a', 100.000000001, ORDER_TYPES.SELL),
            makeCreateAction('slot-b', 100.000000004, ORDER_TYPES.SELL)
        ];
        const resColliding = validateCreateTargetSlots(colliding, new Map(), dummyAssets);
        assert.strictEqual(resColliding.isValid, false, 'same on-chain int = same price = duplicate');
        const dup = resColliding.violations.find(v => v.reason === 'same_batch_price_duplicate');
        assert.ok(dup, 'violation reason is same_batch_price_duplicate');
        assert.strictEqual(dup.targetId, 'slot-b', 'first target wins, later duplicate flagged');

        // Distinct on-chain ints (100.0000001 -> 100000001 vs
        // 100.0000002 -> 100000002) must NOT false-positive, even though
        // they are adjacent floats.
        const distinct = [
            makeCreateAction('slot-a', 100.0000001, ORDER_TYPES.SELL),
            makeCreateAction('slot-b', 100.0000002, ORDER_TYPES.SELL)
        ];
        const resDistinct = validateCreateTargetSlots(distinct, new Map(), dummyAssets);
        const dupDistinct = resDistinct.violations.find(v => v.reason === 'same_batch_price_duplicate');
        assert.ok(!dupDistinct, 'distinct on-chain ints are distinct prices, no false positive');

        // Without assets context the float fallback applies: the colliding
        // pair above has distinct floats and passes (documented fallback).
        const resFallback = validateCreateTargetSlots(colliding, new Map(), null);
        const dupFallback = resFallback.violations.find(v => v.reason === 'same_batch_price_duplicate');
        assert.ok(!dupFallback, 'float fallback for asset-less callers (old behavior)');

        // Identical prices still collide under the int key (regression).
        const identical = [
            makeCreateAction('slot-a', 100, ORDER_TYPES.SELL),
            makeCreateAction('slot-b', 100, ORDER_TYPES.SELL)
        ];
        const resIdentical = validateCreateTargetSlots(identical, new Map(), dummyAssets);
        assert.ok(resIdentical.violations.some(v => v.reason === 'same_batch_price_duplicate'), 'exact duplicates still flagged with assets');
    }

    console.log('\n✓ validateCreateTargetSlots tests PASSED!');
}

runTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
