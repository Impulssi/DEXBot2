/**
 * Pending fill crawls — consumed-fill rotation survival across refused
 * broadcasts, aborted plans, and restarts.
 *
 * Production incident (live bot 2026-09-10 02:52 restart): 4 buy fills
 * (slots 93-96) were processed under a null boundary, both fill batches
 * were refused at broadcast, and the restart restored the stale boundary
 * 96 with the fills deduped. Startup reconcile saw 4 in-window buy holes
 * and re-created BUYs at the exact filled prices — instead of the
 * rotation the grid logic demands (crawl down, refill lower, let the sell
 * rail take profit). Root cause: a processed fill whose derivation never
 * commits loses its crawl permanently; nothing records what is owed.
 *
 * Fix: strategy records every shift-eligible fill as a pending crawl
 * ({slotId, side, ts}); derivations incorporate owed entries (deduped
 * against the current batch, reserves excluded); any accepted non-null
 * commit clears the record; startup applies owed crawls onto the restored
 * boundary (validated placed-order-aware) before reconcile. An absolute
 * fill anchor (Tier 1) subsumes all history, so it ignores owed entries
 * rather than double-counting them.
 */

const assert = require('assert');
const fs = require('fs');
const { AccountOrders, createBotKey } = require('../modules/account_orders');
const StrategyEngine = require('../modules/order/strategy').default;
const {
    deriveTargetBoundary,
    consumePendingFillCrawls,
    reserveEdgeIdSet,
    resolveLiveReserveEdgeAnchorPrice,
} = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const GAP = 4;
const N_SLOTS = 216;
const CFG = { startPrice: 'pool', activeOrders: { buy: 20, sell: 20 } };

function buildSlots(count) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        slots.push({ id: `slot-${i}`, price: 0.001 + i * 0.000004, type: ORDER_TYPES.BUY });
    }
    return slots;
}

function buyFill(i, partial = false) {
    return {
        id: `slot-${i}`,
        type: ORDER_TYPES.BUY,
        price: 0.001 + i * 0.000004,
        isPartial: partial,
    };
}

// Full 216-slot master shaped around boundary 96: live buys <=92, holes at
// 93-96, gap 97-100, live sells 101+. Extra placed sells can be injected
// into the band to prove the startup validator refuses unsafe applies.
function buildMaster(extraPlaced = []) {
    const orders = new Map();
    for (let i = 0; i < N_SLOTS; i++) {
        let type = ORDER_TYPES.BUY;
        let state = ORDER_STATES.ACTIVE;
        let orderId = `1.7.${1000 + i}`;
        if (i >= 93 && i <= 96) {
            state = ORDER_STATES.VIRTUAL;
            orderId = '';
        } else if (i >= 97 && i <= 100) {
            type = ORDER_TYPES.SPREAD;
            state = ORDER_STATES.VIRTUAL;
            orderId = '';
        } else if (i >= 101) {
            type = ORDER_TYPES.SELL;
        }
        orders.set(`slot-${i}`, {
            id: `slot-${i}`,
            price: 0.001 + i * 0.000004,
            type,
            state,
            orderId,
            size: state === ORDER_STATES.VIRTUAL ? 0 : 100,
        });
    }
    for (const [id, type, orderId] of extraPlaced) {
        const slot = orders.get(id);
        slot.type = type;
        slot.state = ORDER_STATES.ACTIVE;
        slot.orderId = orderId;
        slot.size = 100;
    }
    return orders;
}

function mockManager(boundary, orders, pending, config: any = CFG): any {
    return {
        boundaryIdx: boundary,
        orders,
        config,
        _gapSlots: GAP,
        _pendingFillCrawls: pending,
        _restoreBoundary(v) { this.boundaryIdx = v; },
        _markGridDirty() { this.dirtied = true; },
    };
}

async function testPending_IncorporatedIncrementally() {
    console.log('\n[PEND-001] owed entries shift alongside current fills...');
    const { boundaryIdx } = deriveTargetBoundary(
        [buyFill(95)],
        96,
        buildSlots(N_SLOTS),
        CFG,
        GAP,
        null,
        [{ slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 }, { slotId: 'slot-94', side: ORDER_TYPES.BUY, ts: 2 }]
    );
    assert.strictEqual(boundaryIdx, 93, `1 current + 2 owed buys must crawl 96 -> 93 (got ${boundaryIdx})`);
    console.log('✓ PEND-001 passed');
}

async function testPending_CurrentBatchDeduped() {
    console.log('\n[PEND-002] current-batch slots are not double-counted...');
    const { boundaryIdx } = deriveTargetBoundary(
        [buyFill(95)],
        96,
        buildSlots(N_SLOTS),
        CFG,
        GAP,
        null,
        [{ slotId: 'slot-95', side: ORDER_TYPES.BUY, ts: 1 }]
    );
    assert.strictEqual(boundaryIdx, 95, `same slot in batch and pending must crawl once (got ${boundaryIdx})`);
    console.log('✓ PEND-002 passed');
}

async function testPending_AbsoluteAnchorSubsumes() {
    console.log('\n[PEND-003] Tier-1 anchor ignores owed entries (no double count)...');
    const { boundaryIdx } = deriveTargetBoundary(
        [96, 95, 94, 93].map((i) => buyFill(i)),
        null,
        buildSlots(N_SLOTS),
        CFG,
        GAP,
        null,
        [92, 91, 90].map((i) => ({ slotId: `slot-${i}`, side: ORDER_TYPES.BUY, ts: 1 }))
    );
    assert.strictEqual(boundaryIdx, 93, `absolute anchor must land at the fill edge, not 93-3 (got ${boundaryIdx})`);
    console.log('✓ PEND-003 passed');
}

async function testPending_GenesisAnchorKeepsOwed() {
    console.log('\n[PEND-004] non-fill anchor (genesis) still shifts owed entries...');
    const slots = buildSlots(N_SLOTS);
    const genesisStart = 0.0015;
    const split = slots.findIndex((s) => s.price >= genesisStart);
    const { boundaryIdx } = deriveTargetBoundary(
        [{ id: 'slot-100', type: ORDER_TYPES.SELL, isPartial: true, isDelayedRotationTrigger: true }],
        null,
        slots,
        { ...CFG, genesisStartPrice: genesisStart },
        GAP,
        null,
        [{ slotId: 'slot-101', side: ORDER_TYPES.SELL, ts: 1 }]
    );
    // Genesis anchor (split-3) + current dust crawl (+1) + owed sell (+1).
    const want = split - Math.floor(GAP / 2) - 1 + 2;
    assert.strictEqual(boundaryIdx, want, `genesis anchor plus two owed crawls (got ${boundaryIdx}, want ${want})`);
    console.log('✓ PEND-004 passed');
}

async function testPending_ReserveEntriesSkipped() {
    console.log('\n[PEND-005] reserve-slot entries never crawl...');
    const cfg = { ...CFG, reserveOrders: { buy: 2, sell: 0 } };
    const { boundaryIdx } = deriveTargetBoundary(
        [buyFill(95)],
        96,
        buildSlots(N_SLOTS),
        cfg,
        GAP,
        null,
        [{ slotId: 'slot-0', side: ORDER_TYPES.BUY, ts: 1 }]
    );
    assert.strictEqual(boundaryIdx, 95, `floor-reserve entry must not shift (got ${boundaryIdx})`);
    console.log('✓ PEND-005 passed');
}

async function testConsume_AppliesOntoRestored() {
    console.log('\n[PEND-006] startup applies owed crawls onto the restored boundary...');
    const mgr = mockManager(96, buildMaster(), [
        { slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 },
        { slotId: 'slot-94', side: ORDER_TYPES.BUY, ts: 2 },
        { slotId: 'slot-95', side: ORDER_TYPES.BUY, ts: 3 },
        { slotId: 'slot-96', side: ORDER_TYPES.BUY, ts: 4 },
    ]);
    const result = consumePendingFillCrawls(mgr);
    assert.strictEqual(result.applied, true, `must apply (${result.reason ?? 'no reason'})`);
    assert.strictEqual(result.from, 96, 'must start from the restored boundary');
    assert.strictEqual(result.to, 92, `4 owed buys must crawl 96 -> 92 (got ${result.to})`);
    assert.strictEqual(result.count, 4, 'all four entries owed');
    assert.deepStrictEqual(mgr._pendingFillCrawls, [], 'consumed entries must clear');
    assert.strictEqual(mgr.dirtied, true, 'grid must be marked dirty for persist');
    console.log('✓ PEND-006 passed');
}

async function testConsume_DropsOnNull() {
    console.log('\n[PEND-007] null restored boundary drops entries (Tier 1 owns)...');
    const mgr = mockManager(null, buildMaster(), [{ slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 }]);
    const result = consumePendingFillCrawls(mgr);
    assert.strictEqual(result.applied, false, 'must not apply without an anchor');
    assert.strictEqual(result.reason, 'null-boundary', `reason must name the cause (got ${result.reason})`);
    assert.deepStrictEqual(mgr._pendingFillCrawls, [], 'stale entries must clear');
    console.log('✓ PEND-007 passed');
}

async function testConsume_DropsUnsafe() {
    console.log('\n[PEND-008] apply refuses to strand a placed order...');
    // A live SELL sits at slot-95: crawling 96 -> 92 would strand it in-band.
    const mgr = mockManager(96, buildMaster([['slot-95', ORDER_TYPES.SELL, '1.7.999']]), [
        { slotId: 'slot-93', side: ORDER_TYPES.BUY, ts: 1 },
        { slotId: 'slot-94', side: ORDER_TYPES.BUY, ts: 2 },
        { slotId: 'slot-95', side: ORDER_TYPES.BUY, ts: 3 },
        { slotId: 'slot-96', side: ORDER_TYPES.BUY, ts: 4 },
    ]);
    const result = consumePendingFillCrawls(mgr);
    assert.strictEqual(result.applied, false, 'must not strand the placed sell');
    assert.ok(String(result.reason).startsWith('unsafe'), `reason must flag safety (got ${result.reason})`);
    assert.strictEqual(mgr.boundaryIdx, 96, 'boundary must stay put');
    console.log('✓ PEND-008 passed');
}

async function testConsume_LiveAnchorClassifies() {
    console.log('\n[PEND-011] startup classifies reserves with the live anchor, not the config fallback...');
    // Stale leftover: a BUY-typed VIRTUAL slot left above the buy rail by an
    // older bound, priced below the live floor. The live run (finite live
    // anchor) ranks it out of the reserve set, so its crawl is owed; the
    // config-bound fallback is null for mode-string bounds, and plain rank
    // would make it a reserve and drop the crawl.
    const orders = buildMaster();
    Object.assign(orders.get('slot-210'), {
        type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', price: 0.0005, size: 0,
    });
    const mgr = mockManager(96, orders, [{ slotId: 'slot-210', side: ORDER_TYPES.BUY, ts: 1 }],
        { ...CFG, reserveOrders: { buy: 2, sell: 0 } });
    const allSlots = Array.from(orders.values());
    const liveAnchor = resolveLiveReserveEdgeAnchorPrice(mgr, 'buy');
    const liveReserveIds = reserveEdgeIdSet(allSlots, mgr.config, ORDER_TYPES.BUY, liveAnchor);
    const configAnchorIds = reserveEdgeIdSet(allSlots, mgr.config, ORDER_TYPES.BUY);
    assert.ok(!liveReserveIds.has('slot-210'), 'live anchor must not rank the stale leftover as a reserve');
    assert.ok(configAnchorIds.has('slot-210'), 'config fallback would (the drift this pins down)');
    const result = consumePendingFillCrawls(mgr);
    assert.strictEqual(result.applied, true, `live-anchored classification must apply the crawl (${result.reason ?? 'no reason'})`);
    assert.strictEqual(result.to, 95, `one owed buy must crawl 96 -> 95 (got ${result.to})`);
    console.log('✓ PEND-011 passed');
}

async function testPersist_RoundTripAndClear() {
    console.log('\n[PEND-009] storeMasterGrid sanitizes, round-trips, and clears pending crawls...');
    const botKey = createBotKey({ name: 'pending-crawl-test' }, 0);
    const accountOrders = new AccountOrders({ botKey });
    try {
        await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, [
            { slotId: 'slot-93', side: 'buy', ts: 1 },
            { slotId: '', side: 'buy', ts: 2 },
            { slotId: 'slot-94', side: 'sideways', ts: 3 },
            { slotId: 'slot-95', side: 'sell', ts: NaN },
            { slotId: 'slot-96', side: 'sell', ts: 4 },
        ]);
        assert.deepStrictEqual(accountOrders.loadPendingFillCrawls(), [
            { slotId: 'slot-93', side: 'buy', ts: 1 },
            { slotId: 'slot-96', side: 'sell', ts: 4 },
        ], 'only well-formed entries survive');
        await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined, []);
        assert.deepStrictEqual(accountOrders.loadPendingFillCrawls(), [],
            'empty array must clear, not resurrect consumed entries');
        await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, undefined,
            [{ slotId: 'slot-97', side: 'buy', ts: 5 }]);
        await accountOrders.storeMasterGrid([], 0, null, null, null, null, null);
        assert.deepStrictEqual(accountOrders.loadPendingFillCrawls(), [{ slotId: 'slot-97', side: 'buy', ts: 5 }],
            'undefined param is a no-op (backward compatible callers)');
    } finally {
        try { fs.unlinkSync(`profiles/orders/${botKey}.json`); } catch { /* absent */ }
    }
    console.log('✓ PEND-009 passed');
}

async function testRecord_PushDedupesSlot() {
    console.log('\n[PEND-010] reprocessed fills replace, never stack, ineligible fills skip...');
    const mgr = {
        orders: new Map([
            ['slot-93', { id: 'slot-93', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', size: 0, price: 0.001372 }],
            ['slot-94', { id: 'slot-94', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', size: 0, price: 0.001376 }],
        ]),
        logger: { log() {} },
        config: {},
        _pendingFillCrawls: [],
        _markGridDirty() {},
        recalculateFunds() {},
    };
    const strategy = new StrategyEngine(mgr);
    const fill = { id: 'slot-93', type: ORDER_TYPES.BUY, price: 0.001372, size: 1.8, isPartial: false };
    await strategy.processFillsOnly([fill]);
    await strategy.processFillsOnly([fill]);
    assert.strictEqual(mgr._pendingFillCrawls.length, 1, 'same slot must not stack');
    assert.strictEqual(mgr._pendingFillCrawls[0].slotId, 'slot-93', 'newest entry wins');
    await strategy.processFillsOnly([{ id: 'slot-94', type: ORDER_TYPES.BUY, price: 0.001376, size: 0.5, isPartial: true }]);
    assert.strictEqual(mgr._pendingFillCrawls.length, 1, 'ineligible partial must not record');
    console.log('✓ PEND-010 passed');
}

async function main() {
    await testPending_IncorporatedIncrementally();
    await testPending_CurrentBatchDeduped();
    await testPending_AbsoluteAnchorSubsumes();
    await testPending_GenesisAnchorKeepsOwed();
    await testPending_ReserveEntriesSkipped();
    await testConsume_AppliesOntoRestored();
    await testConsume_DropsOnNull();
    await testConsume_DropsUnsafe();
    await testConsume_LiveAnchorClassifies();
    await testPersist_RoundTripAndClear();
    await testRecord_PushDedupesSlot();
    console.log('\nAll pending-crawl tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
