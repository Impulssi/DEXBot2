/**
 * tests/test_validate_mixed_orphan_tolerance.ts
 *
 * Batch 3 (P3 — L1/M4):
 *  - L1: chain-orphan price fallback is per-candidate. A slot-unknown
 *    orphan (no slot id) at a CREATE price must collide even when OTHER
 *    candidates carry slot ids (the old chainSlotIds.size === 0 gate
 *    skipped the price check for the whole mixed set).
 *  - M4: chainOrderMatchesSlotWithTolerance adopts drifted-price
 *    uncertain-landed orders (strict matcher misses them -> duplicate
 *    re-broadcast) while still rejecting far prices; strict
 *    chainOrderMatchesSlot keeps exact semantics for genesis mapping.
 */

const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');
const { validateCreateTargetSlots } = require('../modules/order/utils/validate');
const {
    chainOrderMatchesSlot,
    chainOrderMatchesSlotWithTolerance,
} = require('../modules/order/utils/order');

const dummyAssets = {
    assetA: { id: '1.3.0', symbol: 'TEST', precision: 8 },
    assetB: { id: '1.3.1', symbol: 'BTS', precision: 5 }
};

function makeCreateAction(targetId, price, type, size = 100) {
    return {
        type: COW_ACTIONS.CREATE,
        id: targetId,
        order: { id: targetId, price, type, size }
    };
}

async function runTests() {
    console.log('Running mixed-orphan + tolerance-adopt tests...');

    console.log(' - L1: slot-unknown orphan collides despite slotted candidates...');
    {
        const actions = [makeCreateAction('slot-7', 100, ORDER_TYPES.SELL)];
        const candidates = [
            // Slotted candidate for a DIFFERENT slot: no collision by slot.
            { chainOrderId: '1.7.11', chainSlotId: 'slot-3', type: ORDER_TYPES.SELL, price: 95, size: 100 },
            // Slot-unknown orphan (sync_engine slot-unknown-* cancelOnly shape)
            // sitting exactly at the CREATE price.
            { chainOrderId: '1.7.12', type: ORDER_TYPES.SELL, price: 100, size: 100 },
        ];
        const result = validateCreateTargetSlots(actions, new Map(), dummyAssets, candidates);
        assert.strictEqual(result.isValid, false, 'mixed set must still flag the slotless collision');
        const hit = result.violations.find(v => v.reason === 'chain_orphan_collision');
        assert.ok(hit, 'chain_orphan_collision violation present');
        assert.strictEqual(hit.targetId, 'slot-7', 'violation targets the CREATE slot');
        assert.strictEqual(hit.currentOrderId, '1.7.12', 'violation names the slotless orphan');
    }

    console.log(' - L1: slotted candidates still match by slot only (no price false-positive)...');
    {
        const actions = [makeCreateAction('slot-3', 100, ORDER_TYPES.SELL)];
        const candidates = [
            { chainOrderId: '1.7.11', chainSlotId: 'slot-3', type: ORDER_TYPES.SELL, price: 95, size: 100 },
        ];
        const result = validateCreateTargetSlots(actions, new Map(), dummyAssets, candidates);
        const hit = result.violations.find(v => v.reason === 'chain_orphan_collision');
        assert.ok(hit, 'slot-id collision still detected');
        assert.strictEqual(hit.targetId, 'slot-3', 'violation targets the CREATE slot');
    }

    console.log(' - L1: slotless orphan at a different price does not collide...');
    {
        const actions = [makeCreateAction('slot-7', 100, ORDER_TYPES.SELL)];
        const candidates = [
            { chainOrderId: '1.7.11', chainSlotId: 'slot-3', type: ORDER_TYPES.SELL, price: 95, size: 100 },
            { chainOrderId: '1.7.12', type: ORDER_TYPES.SELL, price: 150, size: 100 },
        ];
        const result = validateCreateTargetSlots(actions, new Map(), dummyAssets, candidates);
        assert.ok(!result.violations.some(v => v.reason === 'chain_orphan_collision'), 'no collision at a different price');
    }

    console.log(' - M4: tolerance variant adopts exact and drifted prices...');
    {
        const slot = { id: 'slot-7', type: ORDER_TYPES.SELL, price: 100, size: 100 };
        const exact = { type: ORDER_TYPES.SELL, price: 100, size: 100 };
        assert.strictEqual(chainOrderMatchesSlotWithTolerance(exact, slot, dummyAssets), true, 'exact price adopted');
        assert.strictEqual(chainOrderMatchesSlot(exact, slot, dummyAssets), true, 'strict matcher agrees on exact');

        // 1-quantum drift on the 8-decimal leg: strict misses, tolerance adopts.
        const drifted = { type: ORDER_TYPES.SELL, price: 100 + 1e-8, size: 100 };
        assert.strictEqual(chainOrderMatchesSlot(drifted, slot, dummyAssets), false, 'strict matcher misses drifted price');
        assert.strictEqual(chainOrderMatchesSlotWithTolerance(drifted, slot, dummyAssets), true, 'tolerance variant adopts drifted price');
    }

    console.log(' - M4: tolerance variant still rejects far prices and wrong types...');
    {
        const slot = { id: 'slot-7', type: ORDER_TYPES.SELL, price: 100, size: 100 };
        assert.strictEqual(
            chainOrderMatchesSlotWithTolerance({ type: ORDER_TYPES.SELL, price: 101, size: 100 }, slot, dummyAssets),
            false, 'far price rejected'
        );
        assert.strictEqual(
            chainOrderMatchesSlotWithTolerance({ type: ORDER_TYPES.BUY, price: 100, size: 100 }, slot, dummyAssets),
            false, 'wrong type rejected'
        );
        assert.strictEqual(
            chainOrderMatchesSlotWithTolerance({ type: ORDER_TYPES.SELL, price: 100, size: 100000 }, slot, dummyAssets),
            false, 'wildly different size rejected'
        );
        assert.strictEqual(chainOrderMatchesSlotWithTolerance(null, slot, dummyAssets), false, 'null rejected');
    }

    console.log(' - M4: SPREAD slot stays type-compatible under tolerance...');
    {
        const spread = { id: 'slot-7', type: ORDER_TYPES.SPREAD, price: 100, size: 100 };
        assert.strictEqual(
            chainOrderMatchesSlotWithTolerance({ type: ORDER_TYPES.SELL, price: 100, size: 100 }, spread, dummyAssets),
            true, 'SPREAD slot adopts either side'
        );
    }

    console.log('\n✓ mixed-orphan + tolerance-adopt tests PASSED!');
}

runTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
