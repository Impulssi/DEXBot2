/**
 * Tests for the COW stale-placement guard (slot-id based).
 *
 * Verifies that CREATE/UPDATE placements targeting a slot below the last
 * same-side shift-eligible SELL fill slot (or above the last BUY fill slot)
 * are dropped from the plan before broadcast, using exact slot-index
 * comparison with price-based fallback when slot ids are unavailable.
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

async function runPlan(targetGrid: any, fills: any[], masterOverrides: any = {}) {
    const logs: string[] = [];
    const engine = new COWRebalanceEngine({
        strategy: {
            calculateTargetGrid: () => ({ targetGrid, boundaryIdx: 5 })
        },
        logger: { log: (msg: string) => { logs.push(String(msg)); } },
        assets: { assetA: { precision: 8 }, assetB: { precision: 5 } },
        config: { gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 0.05 } }
    });
    const result = await engine.execute({
        masterGrid: createMasterGrid(masterOverrides),
        gridVersion: 1,
        boundaryIdx: 5,
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

async function testSellSlotGuard() {
    console.log('\n[COW-SLOT-GUARD-001] SELL placements below the last SELL fill slot are dropped; equality and above kept...');

    const target = createTargetMap([[2, ORDER_TYPES.SELL], [3, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL], [5, ORDER_TYPES.SELL], [6, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'slot-5', type: ORDER_TYPES.SELL, price: PRICES[5], size: 50 }]);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-5', 'slot-6'], 'slots 2-4 (below fill slot 5) must be dropped');

    console.log('✓ COW-SLOT-GUARD-001 passed');
}

async function testBuySlotGuard() {
    console.log('\n[COW-SLOT-GUARD-002] BUY placements above the last BUY fill slot are dropped; equality and below kept...');

    const target = createTargetMap([[2, ORDER_TYPES.BUY], [3, ORDER_TYPES.BUY], [4, ORDER_TYPES.BUY], [5, ORDER_TYPES.BUY], [6, ORDER_TYPES.BUY]]);
    const { result } = await runPlan(target, [{ id: 'slot-4', type: ORDER_TYPES.BUY, price: PRICES[4], size: 50 }]);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-2', 'slot-3', 'slot-4'], 'slots 5-6 (above fill slot 4) must be dropped');

    console.log('✓ COW-SLOT-GUARD-002 passed');
}

async function testOppositeSideFillDoesNotVeto() {
    console.log('\n[COW-SLOT-GUARD-003] opposite-side fills do not veto placements...');

    const target = createTargetMap([[2, ORDER_TYPES.BUY], [3, ORDER_TYPES.BUY], [4, ORDER_TYPES.BUY], [7, ORDER_TYPES.SELL], [8, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'slot-5', type: ORDER_TYPES.SELL, price: PRICES[5], size: 50 }]);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-2', 'slot-3', 'slot-4', 'slot-7', 'slot-8'], 'SELL fill must not veto buys or sells above it');

    console.log('✓ COW-SLOT-GUARD-003 passed');
}

async function testPriceFallbackForNonSlotFillIds() {
    console.log('\n[COW-SLOT-GUARD-004] fills without grid slot ids fall back to price comparison...');

    const target = createTargetMap([[2, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL], [5, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'orphan-fill-1', type: ORDER_TYPES.SELL, price: PRICES[4], size: 50 }]);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-4', 'slot-5'], 'slot-2 (below fill price) must be dropped via price fallback');

    console.log('✓ COW-SLOT-GUARD-004 passed');
}

async function testPartialNonTriggerFillIsNotReference() {
    console.log('\n[COW-SLOT-GUARD-005] partial fills without delayed-rotation trigger are not used as reference...');

    const target = createTargetMap([[2, ORDER_TYPES.SELL], [3, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'slot-4', type: ORDER_TYPES.SELL, price: PRICES[4], size: 10, isPartial: true }]);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-2', 'slot-3', 'slot-4'], 'no reference → nothing dropped');

    console.log('✓ COW-SLOT-GUARD-005 passed');
}

async function testPartialDelayedRotationTriggerIsReference() {
    console.log('\n[COW-SLOT-GUARD-006] partial fills with delayed-rotation trigger ARE used as reference...');

    const target = createTargetMap([[2, ORDER_TYPES.SELL], [3, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, [{ id: 'slot-4', type: ORDER_TYPES.SELL, price: PRICES[4], size: 10, isPartial: true, isDelayedRotationTrigger: true }]);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-4'], 'slots 2-3 must be dropped against the trigger fill');

    console.log('✓ COW-SLOT-GUARD-006 passed');
}

async function testRotationUpdateAndOrphanCancel() {
    console.log('\n[COW-SLOT-GUARD-007] rotation UPDATE targeting a dropped slot is dropped; orphan CANCEL passes through...');

    const target = createTargetMap([[3, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL], [5, ORDER_TYPES.SELL]]);
    target.set('slot-8', { id: 'slot-8', price: PRICES[8], type: ORDER_TYPES.SELL, size: 0, idealSize: 0, state: ORDER_STATES.VIRTUAL, committedSide: ORDER_TYPES.SELL });
    const masterOverrides = {
        'slot-8': { id: 'slot-8', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: PRICES[8], size: 100, orderId: '1.7.8' },
        'slot-9': { id: 'slot-9', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, price: PRICES[9], size: 100, orderId: '1.7.9' }
    };
    const { result } = await runPlan(target, [{ id: 'slot-5', type: ORDER_TYPES.SELL, price: PRICES[5], size: 50 }], masterOverrides);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    const ids = result.actions.map((a: any) => `${a.type}:${a.type === COW_ACTIONS.UPDATE ? a.newGridId : a.id}`);
    assert.deepStrictEqual(ids, ['cancel:slot-9', 'create:slot-5'], 'rotation update to slot-3 must be dropped, orphan cancel must pass');

    console.log('✓ COW-SLOT-GUARD-007 passed');
}

async function testOptimizedUpdateTargetSlot() {
    console.log('\n[COW-SLOT-GUARD-008] create/cancel-optimized UPDATE is guarded by its newGridId slot...');

    const target = createTargetMap([[3, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL], [5, ORDER_TYPES.SELL]]);
    target.set('slot-7', { id: 'slot-7', price: PRICES[7], type: ORDER_TYPES.SELL, size: 0, idealSize: 0, state: ORDER_STATES.ACTIVE, committedSide: ORDER_TYPES.SELL });
    const masterOverrides = {
        'slot-7': { id: 'slot-7', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: PRICES[7], size: 100, orderId: '1.7.7' }
    };
    const { result } = await runPlan(target, [{ id: 'slot-5', type: ORDER_TYPES.SELL, price: PRICES[5], size: 50 }], masterOverrides);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    // reconcile: CANCEL slot-7 (target-size-zero) + CREATEs at 3,4,5 →
    // optimizeRebalanceActions converts the CANCEL+closest CREATE (slot-5)
    // into UPDATE slot-7→slot-5; CREATEs at 3,4 remain and are dropped.
    assert.deepStrictEqual(placementIds(result), ['slot-5'], 'stale CREATEs at slots 3-4 must be dropped; optimized UPDATE to slot-5 kept');

    console.log('✓ COW-SLOT-GUARD-008 passed');
}

async function testNoFillsNoGuard() {
    console.log('\n[COW-SLOT-GUARD-009] no shift-eligible fills → guard is a no-op...');

    const target = createTargetMap([[2, ORDER_TYPES.SELL], [3, ORDER_TYPES.SELL], [4, ORDER_TYPES.SELL], [5, ORDER_TYPES.SELL]]);
    const { result } = await runPlan(target, []);

    assert.strictEqual(result.aborted, false, 'plan must not abort');
    assert.deepStrictEqual(placementIds(result), ['slot-2', 'slot-3', 'slot-4', 'slot-5'], 'nothing dropped without fills');

    console.log('✓ COW-SLOT-GUARD-009 passed');
}

async function run() {
    await testSellSlotGuard();
    await testBuySlotGuard();
    await testOppositeSideFillDoesNotVeto();
    await testPriceFallbackForNonSlotFillIds();
    await testPartialNonTriggerFillIsNotReference();
    await testPartialDelayedRotationTriggerIsReference();
    await testRotationUpdateAndOrphanCancel();
    await testOptimizedUpdateTargetSlot();
    await testNoFillsNoGuard();
    testsComplete = true;
    console.log('\nAll stale-slot guard tests passed.');
}

run().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
});
