/**
 * tests/test_hold_and_center_guards.ts
 *
 * Guards for the boundary-recovery center and the deferred-hold ledger:
 *
 *  - isNonBlockingUnmatchedOrder classifies every `*-deferred` reason as a
 *    deliberate hold, so a new defer reason cannot silently re-freeze the
 *    CREATE pipeline (finding 5b).
 *  - deriveTargetBoundary refuses a Tier-2/Tier-3 center that falls outside
 *    the live rail instead of pinning the boundary to an edge slot (finding 3).
 *  - StrategyEngine's pending-crawl ledger is capped at exactly 500 and does
 *    not record under dryRun (finding 4).
 *  - initializeGrid folds owed fill crawls into a static rebuild center
 *    instead of dropping their direction (finding 2).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PATHS } = require('../modules/paths');
const { setDerivePriceTestHook } = require('../modules/order/utils/system');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const {
    deriveTargetBoundary,
    isNonBlockingUnmatchedOrder,
} = require('../modules/order/utils/order');
const StrategyEngine = require('../modules/order/strategy').default;

const N = 51;
const GAP = 4;
const STEP = 1.01;
const CENTER_IDX = Math.max(0, Math.floor((N - 1 - GAP) / 2));

function buildSlots(count = N) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        slots.push({ id: `slot-${i}`, price: 100 * Math.pow(STEP, i) });
    }
    return slots;
}

function testHoldClassification() {
    console.log('\n[HOLD-001] every *-deferred reason is non-blocking; others still block...');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'out-of-grid-deferred' }), true,
        'out-of-grid holds must not block');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'boundary-unknown-deferred' }), true,
        'boundary-unknown holds must not block');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'future-reason-deferred' }), true,
        'a new -deferred reason must default to non-blocking');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'no-available-nearest-slot' }), false,
        'adoptable/cancellable orphans still block');
    assert.strictEqual(isNonBlockingUnmatchedOrder({ reason: 'duplicate-price-level' }), false,
        'duplicate orphans still block');
    assert.strictEqual(isNonBlockingUnmatchedOrder({}), false, 'missing reason blocks');
    assert.strictEqual(isNonBlockingUnmatchedOrder(null), false, 'null blocks');
    console.log('✓ HOLD-001 passed');
}

function testOutOfRailCenterFallsBackToRailCenter() {
    console.log('\n[CENTER-001] stale numeric startPrice outside the rail falls back to rail center...');
    const slots = buildSlots();
    const railCenterBoundary = CENTER_IDX - Math.floor(GAP / 2) - 1;
    const edgeBoundary = N - Math.floor(GAP / 2) - 1;
    assert.notStrictEqual(railCenterBoundary, edgeBoundary, 'fixture must distinguish center from edge');

    const stale = deriveTargetBoundary([], null, slots, {
        startPrice: 1e9,
        activeOrders: { buy: 3, sell: 3 },
    }, GAP);
    assert.strictEqual(stale.boundaryIdx, railCenterBoundary,
        'an out-of-rail numeric center must not pin the boundary to the top edge');
    assert.notStrictEqual(stale.boundaryIdx, edgeBoundary, 'must not be the rail-edge fabrication');

    // Control: an in-rail numeric center keeps the honest boundary math.
    const honest = deriveTargetBoundary([], null, slots, {
        startPrice: slots[10].price,
        activeOrders: { buy: 3, sell: 3 },
    }, GAP);
    assert.strictEqual(honest.boundaryIdx, 10 - Math.floor(GAP / 2) - 1,
        'an in-rail center still resolves the honest boundary');
    console.log('✓ CENTER-001 passed');
}

function testOutOfRailGenesisFallsBackToRailCenter() {
    console.log('\n[CENTER-002] out-of-rail genesis center falls back to rail center...');
    const slots = buildSlots();
    const railCenterBoundary = CENTER_IDX - Math.floor(GAP / 2) - 1;
    const res = deriveTargetBoundary([], null, slots, {
        startPrice: 'pool',
        genesisStartPrice: 1e9,
        activeOrders: { buy: 3, sell: 3 },
    }, GAP);
    assert.strictEqual(res.boundaryIdx, railCenterBoundary,
        'an out-of-rail genesis center must not pin the boundary to an edge');
    console.log('✓ CENTER-002 passed');
}

function testOutOfRailFillAnchorStillWins() {
    console.log('\n[CENTER-003] Tier-1 fill anchor is exempt (live market wins)...');
    const slots = buildSlots();
    // A fill above the rail is still real market position — the guard must not
    // override Tier-1 the way it drops a stale config center.
    const res = deriveTargetBoundary([
        { id: 'slot-x', type: ORDER_TYPES.SELL, price: 1e9, isPartial: false },
    ], null, slots, {
        startPrice: 'pool',
        activeOrders: { buy: 3, sell: 3 },
    }, GAP);
    assert.ok(res.boundaryIdx > CENTER_IDX,
        `out-of-rail fill anchor must still drive the boundary high (got ${res.boundaryIdx})`);
    console.log('✓ CENTER-003 passed');
}

async function testPendingCrawlLedgerCapAndDryRun() {
    console.log('\n[PEND-CAP-001] ledger capped at exactly 500; dryRun records nothing...');
    const mgr = {
        orders: new Map(),
        logger: { log() {} },
        config: {},
        _pendingFillCrawls: [],
        _markGridDirty() {},
        recalculateFunds() {},
    };
    for (let i = 0; i < 500; i++) {
        mgr._pendingFillCrawls.push({ slotId: `pre-${i}`, side: ORDER_TYPES.BUY, ts: 1 });
    }
    const strategy = new StrategyEngine(mgr);
    await strategy.processFillsOnly([
        { id: 'slot-fresh', type: ORDER_TYPES.BUY, price: 1, size: 1, isPartial: false },
    ]);
    assert.strictEqual(mgr._pendingFillCrawls.length, 500,
        'in-memory length must match the persisted slice(-500) cap exactly');
    assert.strictEqual(mgr._pendingFillCrawls[mgr._pendingFillCrawls.length - 1].slotId, 'slot-fresh',
        'newest entry survives the cap');

    const dryMgr = {
        orders: new Map(),
        logger: { log() {} },
        config: { dryRun: true },
        _pendingFillCrawls: [],
        _markGridDirty() {},
        recalculateFunds() {},
    };
    const dryStrategy = new StrategyEngine(dryMgr);
    await dryStrategy.processFillsOnly([
        { id: 'slot-dry', type: ORDER_TYPES.BUY, price: 1, size: 1, isPartial: false },
    ]);
    assert.strictEqual(dryMgr._pendingFillCrawls.length, 0,
        'dryRun never commits a boundary, so it must not record crawls');
    console.log('✓ PEND-CAP-001 passed');
}

async function testRebuildFoldsOwedCrawlsIntoStaticCenter() {
    console.log('\n[REBUILD-FOLD-001] owed crawls shift a static rebuild center...');
    const { OrderManager, grid: Grid } = require('../modules/order').default;
    const baseCfg = {
        name: 'fold-test',
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 150,
        minPrice: 100,
        maxPrice: 200,
        incrementPercent: 1,
        targetSpreadPercent: 4,
        activeOrders: { buy: 3, sell: 3 },
        logging: { level: 'error' },
    };

    const buildManager = async (overrides = {}) => {
        const manager = new OrderManager({ ...baseCfg, ...overrides });
        manager.assets = {
            assetA: { id: '1.3.100', symbol: 'BTS', precision: 3 },
            assetB: { id: '1.3.101', symbol: 'USD', precision: 3 },
        };
        await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });
        return manager;
    };
    const owedSell = [{ slotId: 'slot-x', side: ORDER_TYPES.SELL, ts: 1 }];
    const foldedCenter = 150 * STEP;

    // Control: no owed crawls -> the static center is unchanged.
    const control = await buildManager();
    await Grid.initializeGrid(control);
    assert.strictEqual(Number(control.config.startPrice), 150,
        'a rebuild with no owed crawls keeps the static center');

    // One net sell crawl -> the static center shifts up by one ladder step.
    const manager = await buildManager();
    manager._pendingFillCrawls = [...owedSell];
    await Grid.initializeGrid(manager);
    assert.ok(Math.abs(Number(manager.config.startPrice) - foldedCenter) < 1e-9,
        `static center must fold the net crawl (expected ~${foldedCenter}, got ${manager.config.startPrice})`);
    assert.ok(Math.abs(Number(manager._genesis?.startPrice) - foldedCenter) < 1e-9,
        'the generated genesis center must match the folded center');
    assert.deepStrictEqual(manager._pendingFillCrawls, [],
        'a rebuild consumes the owed ledger once folded');
    console.log('✓ REBUILD-FOLD-001 passed');

    // Mixed mode: numeric startPrice + live gridPrice. The CENTER is still the
    // static config value (gridPrice only feeds the bounds reference), so the
    // owed crawl must still fold. The test hook also resolves the pool gp
    // offline (the gp source must not mask the static center).
    setDerivePriceTestHook(async () => 150);
    try {
        {
            const mixed = await buildManager({ gridPrice: 'pool' });
            mixed._pendingFillCrawls = [...owedSell];
            await Grid.initializeGrid(mixed);
            assert.ok(Math.abs(Number(mixed.config.startPrice) - foldedCenter) < 1e-9,
                `numeric center + pool gridPrice must still fold (got ${mixed.config.startPrice})`);
            console.log('✓ REBUILD-FOLD-002 passed');
        }

        // Mixed mode: derived startPrice + numeric gridPrice. The center was
        // resolved from live market data, so it already contains the movement —
        // the owed crawl must be dropped, not double-counted.
        {
            const derived = await buildManager({ startPrice: 'book', gridPrice: 150 });
            derived._pendingFillCrawls = [...owedSell];
            await Grid.initializeGrid(derived);
            assert.ok(Math.abs(Number(derived.config.startPrice) - 150) < 1e-9,
                `derived live center must not fold (got ${derived.config.startPrice})`);
            assert.deepStrictEqual(derived._pendingFillCrawls, [],
                'a live-center rebuild drops the owed ledger');
            console.log('✓ REBUILD-FOLD-003 passed');
        }
    } finally {
        setDerivePriceTestHook(null);
    }

    // Mixed mode: numeric startPrice + AMA gridPrice. Per the stated intent the
    // AMA snapshot offsets the center live, so the crawl is dropped.
    {
        const amaBotKey = 'fold-ama-test';
        const amaFile = path.join(PATHS.ORDERS_DIR, `${amaBotKey}.dynamicgrid.json`);
        fs.writeFileSync(amaFile, JSON.stringify({ gridCenterPrice: 150, source: 'test', updatedAt: new Date().toISOString() }));
        try {
            const ama = await buildManager({ botKey: amaBotKey, gridPrice: 'ama' });
            ama._pendingFillCrawls = [...owedSell];
            await Grid.initializeGrid(ama);
            assert.ok(Math.abs(Number(ama.config.startPrice) - 150) < 1e-9,
                `numeric center + ama gridPrice must not fold (got ${ama.config.startPrice})`);
            assert.deepStrictEqual(ama._pendingFillCrawls, [],
                'an ama-center rebuild drops the owed ledger');
        } finally {
            try { fs.unlinkSync(amaFile); } catch { /* absent */ }
        }
        console.log('✓ REBUILD-FOLD-004 passed');
    }
}

async function testInitialActivationRailGate() {
    console.log('\n[RAIL-GATE-001] getInitialOrdersToActivate drops a slot whose stored rail is stale...');
    const { OrderManager } = require('../modules/order').default;
    const manager = new OrderManager({
        name: 'rail-gate-test',
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 100,
        minPrice: 50,
        maxPrice: 200,
        incrementPercent: 1,
        activeOrders: { buy: 2, sell: 2 },
        logging: { level: 'error' },
    });
    manager.assets = {
        assetA: { id: '1.3.100', symbol: 'BTS', precision: 3 },
        assetB: { id: '1.3.101', symbol: 'USD', precision: 3 },
    };
    manager.boundaryIdx = 5;
    manager._gapSlots = 4; // SELL rail starts at slot-10

    const orders = new Map();
    for (let i = 0; i <= 15; i++) {
        orders.set(`slot-${i}`, {
            id: `slot-${i}`, price: 50 + i, type: ORDER_TYPES.BUY,
            state: ORDER_STATES.VIRTUAL, size: 1, orderId: '',
        });
    }
    // Stale rail: stored SELL but geometrically below the boundary. It sorts
    // closest-to-market and would be picked without the geometry gate.
    orders.set('slot-3', {
        id: 'slot-3', price: 53, type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL, size: 1, orderId: '',
    });
    // Genuine in-rail sell (>= sellStart 10) that must still activate.
    orders.set('slot-12', {
        id: 'slot-12', price: 62, type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL, size: 1, orderId: '',
    });
    manager.orders = orders;

    const picked = manager.getInitialOrdersToActivate();
    const sellIds = picked.filter((o: any) => o.type === ORDER_TYPES.SELL).map((o: any) => o.id);
    assert.ok(!sellIds.includes('slot-3'),
        'a SELL stored below the boundary must be gated out of the sell rail');
    assert.ok(sellIds.includes('slot-12'),
        'an in-rail sell must still activate');
    console.log('✓ RAIL-GATE-001 passed');
}

async function runTests() {
    console.log('Running hold + boundary-center guard tests...');
    testHoldClassification();
    testOutOfRailCenterFallsBackToRailCenter();
    testOutOfRailGenesisFallsBackToRailCenter();
    testOutOfRailFillAnchorStillWins();
    await testPendingCrawlLedgerCapAndDryRun();
    await testRebuildFoldsOwedCrawlsIntoStaticCenter();
    await testInitialActivationRailGate();
    console.log('\n✓ All hold + boundary-center guard tests passed.');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('\n✗ Hold + boundary-center guard tests failed');
    console.error(err);
    process.exit(1);
});
