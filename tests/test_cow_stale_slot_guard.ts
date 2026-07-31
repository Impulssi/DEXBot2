/**
 * Tests for the COW stale-placement guard (boundary-based).
 *
 * The guard's veto line is the PLAN'S OWN targetBoundary, not the last
 * same-side fill slot: deriveTargetBoundary caps the net boundary shift, so
 * after a burst the last fill can sit ABOVE the plan's legitimate re-place
 * levels — a fill-slot veto would drop those valid placements (one-cycle
 * deferral). Comparing against the boundary only vetoes genuinely
 * cross-spread placements (a CREATE/UPDATE/ROTATE targeting a slot the plan
 * assigns to the opposite side). Slot ids are compared within the plan's own
 * grid generation, so a recenter between the fill capture and the plan cannot
 * skew the comparison.
 */
const assert = require('assert');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const { COWRebalanceEngine } = require('../modules/order/manager');
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

const PRICES = [0.90, 0.905, 0.91, 0.915, 0.92, 0.925, 0.93, 0.935, 0.94, 0.945];

function createMasterGrid(overrides: Record<string, any> = {}) {
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
    for (const [id, order] of Object.entries(overrides)) {
        orders.set(id, order);
    }
    return orders;
}

function createTargetMap(entries: Array<[number, string]>) {
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

async function runPlan(targetGrid: any, fills: any[], masterOverrides: any = {}, boundaryIdx: any = 5) {
    const logs: string[] = [];
    const engine = new COWRebalanceEngine({
        strategy: {
            calculateTargetGrid: () => ({ targetGrid, boundaryIdx })
        },
        logger: { log: (msg: string) => { logs.push(String(msg)); } },
        assets: { assetA: { precision: 8 }, assetB: { precision: 5 } },
        config: { gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 0.05 } }
    });
    const result = await engine.execute({
        masterGrid: createMasterGrid(masterOverrides),
        gridVersion: 1,
        boundaryIdx,
        funds: { allocatedBuy: 1e9, allocatedSell: 1e9 },
        fills
    });
    return { result, logs };
}

function placementIds(result: any) {
    return result.actions
        .filter((a: any) => a.type === COW_ACTIONS.CREATE || a.type === COW_ACTIONS.UPDATE)
        .map((a: any) => (a.type === COW_ACTIONS.UPDATE ? a.newGridId : a.id));
}

async function testSellBelowBoundaryDropped() {
    console.log('\n[COW-SLOT-GUARD-001] SELL placements below the plan boundary are dropped; at/above kept...');

    // Boundary 5: BUY zone = slots < 5, spread = slot 5, SELL zone = slots > 5.
    // A SELL CREATE/UPDATE targeting slot 4 (a BUY-zone slot) crosses the
    // spread and would fill immediately — must be dropped.
    const target = createTargetMap([[4, ORDER_TYPES.SELL], [5, ORDER_TYPES.SELL], [6, ORDER_TYPES.SELL], [7, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'slot-7', type: ORDER_TYPES.SELL, price: PRICES[7], size: 50 }]);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-5', 'slot-6', 'slot-7'], 'slot 4 (below boundary 5) must be dropped');

    console.log('✓ COW-SLOT-GUARD-001 passed');
}

async function testBuyAboveBoundaryDropped() {
    console.log('\n[COW-SLOT-GUARD-002] BUY placements above the plan boundary are dropped; at/below kept...');

    const target = createTargetMap([[2, ORDER_TYPES.BUY], [3, ORDER_TYPES.BUY], [4, ORDER_TYPES.BUY], [5, ORDER_TYPES.BUY], [6, ORDER_TYPES.BUY]]);
    const { result } = await runPlan(target, [{ id: 'slot-3', type: ORDER_TYPES.BUY, price: PRICES[3], size: 50 }]);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-2', 'slot-3', 'slot-4', 'slot-5'], 'slot 6 (above boundary 5) must be dropped');

    console.log('✓ COW-SLOT-GUARD-002 passed');
}

async function testCappedBurstKeepsLegitReplaces() {
    console.log('\n[COW-SLOT-GUARD-003] capped-burst: fills above the boundary must NOT veto legitimate re-place levels...');

    // The review regression: SELL burst at slots 5,6,7 with a boundary-shift
    // cap moves the boundary only to 6. SELL re-place levels 6-9 are
    // legitimate even though the last fill slot (7) sits above the boundary —
    // the plan is NOT stale, the boundary move is just capped. The old
    // fill-slot veto would have dropped slot 6 (6 < 7); the boundary-based
    // guard keeps every SELL slot >= boundary.
    const target = createTargetMap([[6, ORDER_TYPES.SELL], [7, ORDER_TYPES.SELL], [8, ORDER_TYPES.SELL], [9, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(
        target,
        [
            { id: 'slot-5', type: ORDER_TYPES.SELL, price: PRICES[5], size: 50 },
            { id: 'slot-6', type: ORDER_TYPES.SELL, price: PRICES[6], size: 50 },
            { id: 'slot-7', type: ORDER_TYPES.SELL, price: PRICES[7], size: 50 }
        ],
        {},
        6
    );

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-6', 'slot-7', 'slot-8', 'slot-9'], 'legit re-place levels at/above boundary 6 must be kept (fill-slot veto would have dropped slot 6)');

    console.log('✓ COW-SLOT-GUARD-003 passed');
}

async function testOppositeSideFillDoesNotVeto() {
    console.log('\n[COW-SLOT-GUARD-004] opposite-side fills do not veto placements...');

    const target = createTargetMap([[2, ORDER_TYPES.BUY], [3, ORDER_TYPES.BUY], [4, ORDER_TYPES.BUY], [7, ORDER_TYPES.SELL], [8, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'slot-8', type: ORDER_TYPES.SELL, price: PRICES[8], size: 50 }]);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-2', 'slot-3', 'slot-4', 'slot-7', 'slot-8'], 'SELL fill must not veto buys below the boundary or sells above it');

    console.log('✓ COW-SLOT-GUARD-004 passed');
}

async function testFillSlotFallbackWithoutBoundary() {
    console.log('\n[COW-SLOT-GUARD-005] without a plan boundary, the last same-side fill slot is the veto line (fallback)...');

    // boundaryIdx null forces the fill-slot fallback: last SELL fill at slot 5,
    // so SELL placements below 5 are dropped, at/above kept.
    const target = createTargetMap([[2, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL], [5, ORDER_TYPES.SELL], [6, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'slot-5', type: ORDER_TYPES.SELL, price: PRICES[5], size: 50 }], {}, null);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-5', 'slot-6'], 'slots 2,4 (below fill slot 5) must be dropped via fill-slot fallback');

    console.log('✓ COW-SLOT-GUARD-005 passed');
}

async function testPriceFallbackForNonSlotFillIds() {
    console.log('\n[COW-SLOT-GUARD-006] without a boundary and without fill slot ids, price comparison is the fallback...');

    const target = createTargetMap([[2, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL], [5, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'orphan-fill-1', type: ORDER_TYPES.SELL, price: PRICES[4], size: 50 }], {}, null);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-4', 'slot-5'], 'slot-2 (below fill price) must be dropped via price fallback');

    console.log('✓ COW-SLOT-GUARD-006 passed');
}

async function testPartialNonTriggerFillIsNotReference() {
    console.log('\n[COW-SLOT-GUARD-007] partial fills without delayed-rotation trigger are not a fill-slot reference (fallback path)...');

    const target = createTargetMap([[2, ORDER_TYPES.SELL], [3, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'slot-4', type: ORDER_TYPES.SELL, price: PRICES[4], size: 10, isPartial: true }], {}, null);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-2', 'slot-3', 'slot-4'], 'no reference → nothing dropped');

    console.log('✓ COW-SLOT-GUARD-007 passed');
}

async function testCrossSideCreatesDroppedAndOrphanCancel() {
    console.log('\n[COW-SLOT-GUARD-008] creates in below-boundary slots are dropped; orphan CANCEL passes through...');

    const target = createTargetMap([[3, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL], [5, ORDER_TYPES.SELL], [6, ORDER_TYPES.SELL]]);
    const masterOverrides = {
        'slot-9': { id: 'slot-9', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: PRICES[9], size: 100, orderId: '1.7.9' }
    };
    const { result } = await runPlan(target, [{ id: 'slot-6', type: ORDER_TYPES.SELL, price: PRICES[6], size: 50 }], masterOverrides);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    const ids = result.actions.map((a: any) => `${a.type}:${a.type === COW_ACTIONS.UPDATE ? a.newGridId : a.id}`);
    assert.deepStrictEqual(ids, ['cancel:slot-9', 'create:slot-5', 'create:slot-6'], 'cross-spread creates at slots 3-4 (below boundary 5) must be dropped; orphan cancel must pass');

    console.log('✓ COW-SLOT-GUARD-008 passed');
}

async function testOptimizedUpdateTargetSlot() {
    console.log('\n[COW-SLOT-GUARD-009] create/cancel-optimized UPDATE is guarded by its newGridId slot...');

    const target = createTargetMap([[6, ORDER_TYPES.SELL], [7, ORDER_TYPES.SELL], [8, ORDER_TYPES.SELL]]);
    target.set('slot-9', { id: 'slot-9', price: PRICES[9], type: ORDER_TYPES.SELL, size: 0, idealSize: 0, state: ORDER_STATES.ACTIVE, committedSide: ORDER_TYPES.SELL });
    const masterOverrides = {
        'slot-9': { id: 'slot-9', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: PRICES[9], size: 100, orderId: '1.7.9' }
    };
    const { result } = await runPlan(target, [{ id: 'slot-7', type: ORDER_TYPES.SELL, price: PRICES[7], size: 50 }], masterOverrides);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    // reconcile: CANCEL slot-9 (target-size-zero) + CREATEs at 6,7,8 →
    // optimizeRebalanceActions converts the CANCEL+closest CREATE into an
    // UPDATE to slot-8; all placements are at/above the boundary so nothing
    // is dropped.
    assert.deepStrictEqual(placementIds(result), ['slot-8', 'slot-6', 'slot-7'], 'SELL placements at/above boundary 5 must be kept');

    console.log('✓ COW-SLOT-GUARD-009 passed');
}

async function testNoFillsNoDrop() {
    console.log('\n[COW-SLOT-GUARD-010] no fills → nothing dropped for boundary-consistent placements...');

    const target = createTargetMap([[6, ORDER_TYPES.SELL], [7, ORDER_TYPES.SELL], [8, ORDER_TYPES.SELL], [9, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, []);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-6', 'slot-7', 'slot-8', 'slot-9'], 'nothing dropped without fills');

    console.log('✓ COW-SLOT-GUARD-010 passed');
}

async function run() {
    await testSellBelowBoundaryDropped();
    await testBuyAboveBoundaryDropped();
    await testCappedBurstKeepsLegitReplaces();
    await testOppositeSideFillDoesNotVeto();
    await testFillSlotFallbackWithoutBoundary();
    await testPriceFallbackForNonSlotFillIds();
    await testPartialNonTriggerFillIsNotReference();
    await testCrossSideCreatesDroppedAndOrphanCancel();
    await testOptimizedUpdateTargetSlot();
    await testNoFillsNoDrop();
    testsComplete = true;
    console.log('\nAll stale-slot guard tests passed.');
}

run().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
});
