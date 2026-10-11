/**
 * Tests for the COW operator-hold guard.
 *
 * Production incident 2026-10-11: the operator cancelled 7 sells, sync
 * recorded holds on slots 9-15 — and one minute later a rotation batch
 * repriced fresh orders straight down onto those held slots ("update
 * slot-42 -> slot-15" etc.). Materialize then cleared the holds as
 * "refilled" and the operator watched the levels come back on exchange.
 * Placement pickers check holds, but rotation UPDATEs (target slot =
 * newGridId) bypassed them.
 *
 * The guard drops CREATE/UPDATE actions targeting held slots at the same
 * chokepoint as the stale-placement and buy-floor guards, for both the
 * direct slot id and the rotation target id.
 */
const assert = require('assert');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const { COWRebalanceEngine, heldSlotDropReason } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

const PRICES = [0.90, 0.905, 0.91, 0.915, 0.92, 0.925, 0.93, 0.935, 0.94, 0.945];

function holdsOf(...ids) {
    return new Map(ids.map((id) => [id, { price: 0.93, ts: 1 }]));
}

// --- unit: drop-reason contract -------------------------------------------
assert.strictEqual(
    heldSlotDropReason({ type: COW_ACTIONS.CREATE, id: 'slot-6' }, holdsOf('slot-6')) !== null,
    true,
    'CREATE onto a held slot must drop'
);
assert.strictEqual(
    heldSlotDropReason({ type: COW_ACTIONS.UPDATE, id: 'slot-8', newGridId: 'slot-6' }, holdsOf('slot-6')) !== null,
    true,
    'UPDATE rotating onto a held slot (newGridId) must drop'
);
assert.strictEqual(
    heldSlotDropReason({ type: COW_ACTIONS.UPDATE, id: 'slot-6', newGridId: 'slot-2' }, holdsOf('slot-6')),
    null,
    'UPDATE rotating AWAY from a held slot must proceed (removes the order)'
);
assert.strictEqual(
    heldSlotDropReason({ type: COW_ACTIONS.CREATE, id: 'slot-6' }, holdsOf('slot-7')),
    null,
    'CREATE onto an unheld slot must proceed'
);
assert.strictEqual(
    heldSlotDropReason({ type: COW_ACTIONS.CREATE, id: 'slot-6' }, new Map()),
    null,
    'empty holds must not block (fail-open)'
);
assert.strictEqual(
    heldSlotDropReason({ type: COW_ACTIONS.CREATE, id: 'slot-6' }, null),
    null,
    'missing holds must not block (fail-open)'
);
assert.strictEqual(
    heldSlotDropReason({ type: 'cancel', id: 'slot-6' }, holdsOf('slot-6')),
    null,
    'non-placement actions are never dropped'
);
assert.ok(
    String(heldSlotDropReason({ type: COW_ACTIONS.CREATE, id: 'slot-6' }, holdsOf('slot-6'))).includes('slot-6'),
    'drop reason must name the held slot for the log'
);
console.log('✓ heldSlotDropReason contract (8 assertions)');

// --- engine: held rotation target dropped end-to-end -----------------------
function createMasterGrid() {
    const orders = new Map();
    PRICES.forEach((price, i) => {
        orders.set(`slot-${i}`, {
            id: `slot-${i}`,
            type: null,
            state: ORDER_STATES.VIRTUAL,
            price,
            size: 0
        });
    });
    return orders;
}

function createTargetMap(entries) {
    const target = new Map();
    for (const [idx, type] of entries) {
        const id = `slot-${idx}`;
        target.set(id, {
            id,
            price: PRICES[idx],
            type,
            size: 100,
            idealSize: 100,
            state: ORDER_STATES.ACTIVE,
            committedSide: type
        });
    }
    return target;
}

async function runPlan(targetGrid, fills, manualHolds, boundaryIdx = 5) {
    const logs = [];
    const engine = new COWRebalanceEngine({
        strategy: {
            calculateTargetGrid: () => ({ targetGrid, boundaryIdx })
        },
        logger: { log: (msg) => { logs.push(String(msg)); } },
        assets: { assetA: { precision: 8 }, assetB: { precision: 5 } },
        config: { gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 0.05 } }
    });
    const result = await engine.execute({
        masterGrid: createMasterGrid(),
        gridVersion: 1,
        boundaryIdx,
        funds: { allocatedBuy: 1e9, allocatedSell: 1e9 },
        fills,
        manualHolds
    });
    return { result, logs };
}

function placementTargets(result) {
    return result.actions
        .filter((a) => a.type === COW_ACTIONS.CREATE || a.type === COW_ACTIONS.UPDATE)
        .map((a) => (a.type === COW_ACTIONS.UPDATE && a.newGridId ? a.newGridId : a.id));
}

(async () => {
    console.log('\n[COW-HOLD-GUARD-001] CREATE onto a held slot is dropped...');
    {
        const target = createTargetMap([[5, ORDER_TYPES.SELL], [6, ORDER_TYPES.SELL], [7, ORDER_TYPES.SELL]]);
        const { result, logs } = await runPlan(
            target,
            [{ id: 'slot-7', type: ORDER_TYPES.SELL, price: PRICES[7], size: 50 }],
            holdsOf('slot-6')
        );
        assert.strictEqual(result.aborted, false, 'plan must not abort');
        const placed = placementTargets(result);
        assert.ok(!placed.includes('slot-6'), `held slot-6 must not be placed; got ${JSON.stringify(placed)}`);
        assert.ok(
            logs.some((m) => m.includes('Hold guard removed 1 placement')),
            `drop must be logged as hold-guard removal; got:\n${logs.join('\n')}`
        );
        console.log(`  ✓ held slot skipped (${JSON.stringify(placed)})`);
    }

    console.log('\n[COW-HOLD-GUARD-002] no holds: identical plan places normally...');
    {
        const target = createTargetMap([[5, ORDER_TYPES.SELL], [6, ORDER_TYPES.SELL], [7, ORDER_TYPES.SELL]]);
        const { result } = await runPlan(
            target,
            [{ id: 'slot-7', type: ORDER_TYPES.SELL, price: PRICES[7], size: 50 }],
            new Map()
        );
        assert.strictEqual(result.aborted, false, 'plan must not abort');
        const placed = placementTargets(result);
        assert.ok(placed.includes('slot-6'), `without holds slot-6 must place; got ${JSON.stringify(placed)}`);
        console.log(`  ✓ control places normally (${JSON.stringify(placed)})`);
    }

    console.log('PASS test_cow_hold_guard');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
