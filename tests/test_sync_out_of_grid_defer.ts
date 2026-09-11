/**
 * test_sync_out_of_grid_defer.ts — sub/super-grid orphans must hold, never
 * adopt into edge slots or cancel as duplicates (issue #24).
 *
 * slotIndexForPrice clamps out-of-range prices onto slot-0 / slot-(N-1).
 * The genesis Pass-2 path must treat that clamp as no-match: below-grid
 * buys are not slot-0, above-grid sells are not slot-(N-1) — defer with
 * reason 'out-of-grid-deferred' (no adopt, no cancelOnly).
 *
 * Order ids below are synthetic (1.7.91xxxx); the shapes mirror the issue
 * (slot-0 live order plus orphans 14-20% below it).
 */
const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const AsyncLock = require('../modules/order/async_lock').default;
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');
const { buildGenesisFromPriceLevels, isChainPriceOutOfGrid } = require('../modules/order/utils/math');
const { validateCreateTargetSlots } = require('../modules/order/utils/validate');

const N_LEVELS = 51; // slot-0 .. slot-50
const LEVELS = Array.from({ length: N_LEVELS }, (_, i) => 100 * Math.pow(1.01, i));
const GENESIS = () => buildGenesisFromPriceLevels(100, 1, 4, LEVELS);

function makeMgr(opts = {}) {
    const orders = new Map();
    for (const o of (opts as any).orders || []) {
        orders.set(o.id, { ...o });
    }
    const assets = (opts as any).assets || {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
    };
    const logEntries: any[] = [];
    return {
        orders,
        assets,
        config: (opts as any).config,
        boundaryIdx: (opts as any).boundaryIdx,
        _gapSlots: (opts as any).gapSlots,
        _genesis: (opts as any).genesis,
        logger: {
            log: (msg: string, level: string) => { logEntries.push({ msg, level }); }
        },
        _logEntries: logEntries,
        _gridPersistenceSuspendedReason: null,
        _persistenceWarning: undefined,
        _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false },
        _syncLock: new AsyncLock(),
        _fillProcessingLock: new AsyncLock(),
        _gridLock: new AsyncLock(),
        ordersNeedingPriceCorrection: [],
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        lockOrders: () => {},
        unlockOrders: () => {},
        shadowOrderIds: new Map(),
        _applyOrderUpdate: async (order: any, _reason: string, _opts2: any) => {
            orders.set(order.id, { ...(orders.get(order.id) || {}), ...order });
            return orders.get(order.id);
        }
    };
}

function makeChainOrder(id: string, type: string, price: number, size: number) {
    // Mirror parseChainOrder: sell → base assetA / quote assetB;
    // buy → base assetB / quote assetA (price = base/quote * 10^delta).
    const isSell = type === 'sell';
    const baseAssetId = isSell ? '1.3.0' : '1.3.121';
    const quoteAssetId = isSell ? '1.3.121' : '1.3.0';
    const baseInt = Math.round(size * Math.pow(10, isSell ? 8 : 5));
    const quoteInt = isSell
        ? Math.round(size * price * Math.pow(10, 5))
        : Math.round(size * Math.pow(10, 8) / price);
    return {
        id,
        sell_price: {
            base: { amount: String(baseInt), asset_id: baseAssetId },
            quote: { amount: String(quoteInt), asset_id: quoteAssetId }
        },
        for_sale: String(baseInt),
        type,
        price,
        size
    };
}

function correctionsFor(mgr: any, chainOrderId: string) {
    return (mgr.ordersNeedingPriceCorrection || []).filter((c: any) => c.chainOrderId === chainOrderId);
}

async function testBelowGridBuysAreDeferredNotAdoptedOrCancelled() {
    console.log(' - Below-grid buys defer (occupied slot-0): no adopt, no duplicate cancel...');
    // Issue #24 shape: slot-0 @ 100, orphans 14-20% below it.
    const mgr = makeMgr({
        orders: [{
            id: 'slot-0',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            price: LEVELS[0],
            size: 5,
            orderId: '1.7.910001',
        }],
        genesis: GENESIS(),
        boundaryIdx: 40, // buy rail idx <= 40 → slot-0 is rail (clamp passes rail check pre-fix)
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const chain = [
        makeChainOrder('1.7.910001', ORDER_TYPES.BUY, LEVELS[0], 5),
        makeChainOrder('1.7.910002', ORDER_TYPES.BUY, 85, 5),
        makeChainOrder('1.7.910003', ORDER_TYPES.BUY, 80, 5),
    ];
    const result = await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    assert.strictEqual(result.unmatchedChainOrders.length, 2, 'Both below-grid orphans must stay unmatched');
    for (const id of ['1.7.910002', '1.7.910003']) {
        const unmatched = result.unmatchedChainOrders.find((u: any) => u.chainOrderId === id);
        assert.ok(unmatched, `${id} must be unmatched`);
        assert.strictEqual(unmatched.reason, 'out-of-grid-deferred', `${id} must defer, not duplicate/cancel`);
        assert.strictEqual(unmatched.candidateSlotId, 'slot-0', `${id} candidate stays slot-0 for diagnostics`);
        assert.strictEqual(correctionsFor(mgr, id).length, 0, `${id} must NOT be queued for cancellation`);
    }
    const slot0 = mgr.orders.get('slot-0');
    assert.strictEqual(slot0.orderId, '1.7.910001', 'slot-0 must keep its live order (no mis-adoption)');
    console.log('✓ OUT-OF-GRID-001 passed');
}

async function testBelowGridBuyDoesNotAdoptIntoFreeSlot0() {
    console.log(' - Below-grid buy defers (free slot-0): no mis-adoption...');
    const mgr = makeMgr({
        orders: [{
            id: 'slot-0',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: LEVELS[0],
            size: 5,
        }],
        genesis: GENESIS(),
        boundaryIdx: 40,
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const result = await engine.syncFromOpenOrders(
        [makeChainOrder('1.7.910004', ORDER_TYPES.BUY, 82, 5)],
        { skipAccounting: true }
    );

    assert.strictEqual(result.unmatchedChainOrders.length, 1, 'Below-grid orphan must stay unmatched');
    assert.strictEqual(result.unmatchedChainOrders[0].reason, 'out-of-grid-deferred', 'Must defer, not adopt');
    const slot0 = mgr.orders.get('slot-0');
    assert.ok(!slot0.orderId, 'Free slot-0 must NOT adopt the below-grid orphan');
    console.log('✓ OUT-OF-GRID-002 passed');
}

async function testAboveGridSellIsDeferredNotCancelled() {
    console.log(' - Above-grid sell defers (occupied top slot): symmetric hold...');
    const topIdx = N_LEVELS - 1;
    const mgr = makeMgr({
        orders: [{
            id: `slot-${topIdx}`,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: LEVELS[topIdx],
            size: 10,
            orderId: '1.7.910006',
        }],
        genesis: GENESIS(),
        boundaryIdx: 40, // sellStart = 45 → top slot is rail
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const result = await engine.syncFromOpenOrders(
        [
            makeChainOrder('1.7.910006', ORDER_TYPES.SELL, LEVELS[topIdx], 10),
            makeChainOrder('1.7.910007', ORDER_TYPES.SELL, LEVELS[topIdx] * 1.2, 10),
        ],
        { skipAccounting: true }
    );

    assert.strictEqual(result.unmatchedChainOrders.length, 1, 'Above-grid orphan must stay unmatched');
    assert.strictEqual(result.unmatchedChainOrders[0].reason, 'out-of-grid-deferred', 'Must defer, not duplicate/cancel');
    assert.strictEqual(correctionsFor(mgr, '1.7.910007').length, 0, 'Above-grid orphan must NOT be queued for cancellation');
    const top = mgr.orders.get(`slot-${topIdx}`);
    assert.strictEqual(top.orderId, '1.7.910006', 'Top slot must keep its live order');
    console.log('✓ OUT-OF-GRID-003 passed');
}

async function testInRailOrphanStillAdopts() {
    console.log(' - In-rail orphan still adopts (guard does not overreach)...');
    const idx = 10;
    const mgr = makeMgr({
        orders: [{
            id: `slot-${idx}`,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL,
            price: LEVELS[idx],
            size: 10,
        }],
        genesis: GENESIS(),
        boundaryIdx: 40,
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);
    const result = await engine.syncFromOpenOrders(
        [makeChainOrder('1.7.910008', ORDER_TYPES.BUY, LEVELS[idx], 10)],
        { skipAccounting: true }
    );

    assert.strictEqual(result.unmatchedChainOrders.length, 0, 'Exact in-rail orphan must adopt');
    const slot = mgr.orders.get(`slot-${idx}`);
    assert.strictEqual(slot.orderId, '1.7.910008', 'In-rail slot must bind the chain order');
    console.log('✓ OUT-OF-GRID-004 passed');
}

async function testHelperClassifiesEdges() {
    console.log(' - isChainPriceOutOfGrid classifies rail vs outside...');
    const g = GENESIS();
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[0], g, 5), false, 'Edge price is in-grid');
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[10], g, 5), false, 'Mid-rail price is in-grid');
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[0] * 0.8, g, 5), true, 'Below-grid price is out');
    assert.strictEqual(isChainPriceOutOfGrid(LEVELS[N_LEVELS - 1] * 1.2, g, 8), true, 'Above-grid price is out');
    console.log('✓ OUT-OF-GRID-005 passed');
}

async function testHoldDoesNotBlockRailRefill() {
    console.log(' - Out-of-grid hold does not collide with rail refill CREATE...');
    const assets = {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
    };
    const orders = new Map([['slot-0', {
        id: 'slot-0', type: ORDER_TYPES.BUY, price: LEVELS[0], size: 5,
        state: ORDER_STATES.VIRTUAL, orderId: '',
    }]]);
    const actions = [{
        type: COW_ACTIONS.CREATE, id: 'slot-0',
        order: { id: 'slot-0', price: LEVELS[0], type: ORDER_TYPES.BUY, size: 5 },
    }];
    // The hold lives below the grid; its candidateSlotId is the clamp, not
    // a real match — refilling slot-0 must stay valid.
    const holds = [{
        chainOrderId: '1.7.910002', candidateSlotId: 'slot-0',
        reason: 'out-of-grid-deferred', price: 82, size: 5, type: ORDER_TYPES.BUY,
    }];
    const resHold = validateCreateTargetSlots(actions, orders, assets, holds);
    assert.ok(!resHold.violations.some((v: any) => v.reason === 'chain_orphan_collision'),
        'Hold must not collide with the rail refill');
    assert.strictEqual(resHold.isValid, true, 'Refill CREATE stays valid alongside the hold');
    // Control: a real same-slot duplicate still collides (no overreach).
    const dups = [{
        chainOrderId: '1.7.910005', candidateSlotId: 'slot-0',
        reason: 'duplicate-price-level', price: LEVELS[0], size: 5, type: ORDER_TYPES.BUY,
    }];
    const resDup = validateCreateTargetSlots(actions, orders, assets, dups);
    assert.ok(resDup.violations.some((v: any) => v.reason === 'chain_orphan_collision'),
        'True same-slot duplicate must still collide');
    console.log('✓ OUT-OF-GRID-006 passed');
}

async function testBoundaryUnknownHoldDoesNotBlockRailRefill() {
    console.log(' - Boundary-unknown hold (a different -deferred reason) also does not collide...');
    const assets = {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
    };
    const orders = new Map([['slot-0', {
        id: 'slot-0', type: ORDER_TYPES.BUY, price: LEVELS[0], size: 5,
        state: ORDER_STATES.VIRTUAL, orderId: '',
    }]]);
    const actions = [{
        type: COW_ACTIONS.CREATE, id: 'slot-0',
        order: { id: 'slot-0', price: LEVELS[0], type: ORDER_TYPES.BUY, size: 5 },
    }];
    // Classification is by the shared `-deferred` suffix, not an exact reason
    // string: a boundary-unknown hold is a deliberate defer too and must not
    // be mistaken for a same-slot duplicate.
    const holds = [{
        chainOrderId: '1.7.910007', candidateSlotId: 'slot-0',
        reason: 'boundary-unknown-deferred', price: LEVELS[0], size: 5, type: ORDER_TYPES.BUY,
    }];
    const resHold = validateCreateTargetSlots(actions, orders, assets, holds);
    assert.ok(!resHold.violations.some((v: any) => v.reason === 'chain_orphan_collision'),
        'Boundary-unknown hold must not collide with the rail refill');
    assert.strictEqual(resHold.isValid, true, 'Refill CREATE stays valid alongside the hold');
    console.log('✓ OUT-OF-GRID-007 passed');
}

async function runTests() {
    console.log('Running Sync Engine Out-Of-Grid Defer Tests (issue #24)...');
    await testBelowGridBuysAreDeferredNotAdoptedOrCancelled();
    await testBelowGridBuyDoesNotAdoptIntoFreeSlot0();
    await testAboveGridSellIsDeferredNotCancelled();
    await testInRailOrphanStillAdopts();
    await testHelperClassifiesEdges();
    await testHoldDoesNotBlockRailRefill();
    await testBoundaryUnknownHoldDoesNotBlockRailRefill();
    console.log('✓ Sync engine out-of-grid defer tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('✗ Sync engine out-of-grid defer tests failed');
    console.error(err);
    process.exit(1);
});
