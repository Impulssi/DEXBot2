/**
 * tests/test_buy_window_config.ts
 *
 * Unit tests for buy-window behavior resolvers (bots.json: buyFloorUSDT,
 * buyDelayMinutes, buyWindowMode, buyDeepCount) and the deep-shelf
 * dip-insurance ladder. Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { resolveBuyFloorUsdt, resolveBuyDelayMs, resolveBuyWindowMode, resolveBuyDeepCount, resolveBuyDeepSizes, isDeepShelfId, deepShelfPrices, BUY_WINDOW_DEFAULTS } = require('../modules/order/utils/math');
const { ensureDeepShelfEntries, isDeepShelfFillOrder, resolveDeepShelfFloor, applyDeepManualSizes } = require('../modules/order/utils/order');
const { validateWorkingGridFunds } = require('../modules/order/utils/validate');
const SyncEngine = require('../modules/order/sync_engine').default;

let passed = 0;
function check(name, actual, expected) {
    assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`);
    passed++;
}

// --- resolveBuyFloorUsdt ---
check('floor default (missing)', resolveBuyFloorUsdt({}), BUY_WINDOW_DEFAULTS.floorUsdt);
check('floor default value is 1.0', BUY_WINDOW_DEFAULTS.floorUsdt, 1.0);
check('floor explicit 2.5', resolveBuyFloorUsdt({ buyFloorUSDT: 2.5 }), 2.5);
check('floor explicit string "0.75"', resolveBuyFloorUsdt({ buyFloorUSDT: '0.75' }), 0.75);
check('floor 0 disables', resolveBuyFloorUsdt({ buyFloorUSDT: 0 }), 0);
check('floor negative falls back', resolveBuyFloorUsdt({ buyFloorUSDT: -1 }), 1.0);
check('floor NaN falls back', resolveBuyFloorUsdt({ buyFloorUSDT: 'abc' }), 1.0);
check('floor null falls back', resolveBuyFloorUsdt({ buyFloorUSDT: null }), 1.0);
check('floor null config falls back', resolveBuyFloorUsdt(null), 1.0);

// --- resolveBuyDelayMs ---
check('delay default (missing)', resolveBuyDelayMs({}), 15 * 60 * 1000);
check('delay explicit 15', resolveBuyDelayMs({ buyDelayMinutes: 15 }), 15 * 60 * 1000);
check('delay explicit 5', resolveBuyDelayMs({ buyDelayMinutes: 5 }), 5 * 60 * 1000);
check('delay 0 disables', resolveBuyDelayMs({ buyDelayMinutes: 0 }), 0);
check('delay negative falls back', resolveBuyDelayMs({ buyDelayMinutes: -5 }), 15 * 60 * 1000);
check('delay NaN falls back', resolveBuyDelayMs({ buyDelayMinutes: 'soon' }), 15 * 60 * 1000);
check('delay null config falls back', resolveBuyDelayMs(undefined), 15 * 60 * 1000);

// --- resolveBuyWindowMode ---
check('window default (missing)', resolveBuyWindowMode({}), 'low');
check('window explicit low', resolveBuyWindowMode({ buyWindowMode: 'low' }), 'low');
check('window explicit closest', resolveBuyWindowMode({ buyWindowMode: 'closest' }), 'closest');
check('window case-insensitive', resolveBuyWindowMode({ buyWindowMode: 'Closest' }), 'closest');
check('window invalid falls back', resolveBuyWindowMode({ buyWindowMode: 'moon' }), 'low');
check('window null falls back', resolveBuyWindowMode({ buyWindowMode: null }), 'low');

// --- resolveBuyDeepCount ---
check('deep default (missing)', resolveBuyDeepCount({}), 0);
check('deep default value is 0', BUY_WINDOW_DEFAULTS.deepCount, 0);
check('deep explicit 3', resolveBuyDeepCount({ buyDeepCount: 3 }), 3);
check('deep explicit string "3"', resolveBuyDeepCount({ buyDeepCount: '3' }), 3);
check('deep 0 disables', resolveBuyDeepCount({ buyDeepCount: 0 }), 0);
check('deep negative disables', resolveBuyDeepCount({ buyDeepCount: -2 }), 0);
check('deep fractional floors', resolveBuyDeepCount({ buyDeepCount: 2.9 }), 2);
check('deep NaN disables', resolveBuyDeepCount({ buyDeepCount: 'lots' }), 0);
check('deep null disables', resolveBuyDeepCount({ buyDeepCount: null }), 0);
check('deep caps at 12', resolveBuyDeepCount({ buyDeepCount: 99 }), 12);

// --- isDeepShelfId ---
check('deep id deep-0', isDeepShelfId('deep-0'), true);
check('deep id deep-12', isDeepShelfId('deep-12'), true);
check('slot id is not deep', isDeepShelfId('slot-0'), false);
check('bare prefix is not deep', isDeepShelfId('deep-'), false);
check('non-numeric suffix is not deep', isDeepShelfId('deep-x'), false);
check('null is not deep', isDeepShelfId(null), false);
check('number is not deep', isDeepShelfId(3), false);

// --- deepShelfPrices (floor-anchored, normal grid steps upward) ---
{
    const floor = 0.001154, step = 1.0158;
    const prices = deepShelfPrices(floor, step, 3);
    check('ladder length', prices.length, 3);
    check('deepest sits exactly on the floor', prices[2], floor);
    check('top-first order', prices[0] > prices[1] && prices[1] > prices[2], true);
    check('normal step up (1)', Math.abs(prices[1] / prices[2] - step) < 1e-12, true);
    check('normal step up (2)', Math.abs(prices[0] / prices[1] - step) < 1e-12, true);
    check('never below floor', Math.min(...prices) >= floor, true);
}
check('ladder count 0 is empty', deepShelfPrices(0.001154, 1.0158, 0).length, 0);
check('ladder bad floor is empty', deepShelfPrices(0, 1.0158, 3).length, 0);
check('ladder unit step is empty', deepShelfPrices(0.001154, 1.0, 3).length, 0);

// --- resolveDeepShelfFloor ---
{
    // Numeric startPrice reference: floor resolves like the grid bound.
    const m1 = { config: { minPrice: '1.15x', startPrice: 0.0017725, gridPrice: 'fixed' } };
    const f1 = resolveDeepShelfFloor(m1);
    check('numeric floor resolves (0.0017725/1.15)', Math.abs(f1 - 0.0017725 / 1.15) < 1e-12, true);
    // Pool mode has no synchronous reference: fail static (null).
    const m2 = { config: { minPrice: '1.15x', gridPrice: 'pool' } };
    check('pool mode floor is null', resolveDeepShelfFloor(m2), null);
    // Unknown AMA bot: no snapshot, no floor.
    const m3 = { config: { minPrice: '1.15x', gridPrice: 'ama4', botKey: 'no-such-bot-xyz' } };
    check('unknown bot floor is null', resolveDeepShelfFloor(m3), null);
}

// --- ensureDeepShelfEntries ---
{
    const mkMgr = (deep, extra = {}) => ({
        config: { buyDeepCount: deep, incrementPercent: 1.5, minPrice: 0.001154, startPrice: 0.0015, gridPrice: 'fixed', ...extra },
    });
    const base = new Map([
        ['slot-0', { id: 'slot-0', type: 'buy', state: 'virtual', price: 0.0013408, size: 2.26, orderId: null }],
    ]);
    const shelf = ensureDeepShelfEntries(base, mkMgr(3));
    check('shelf length', shelf.length, 3);
    check('shelf ids top-first', shelf.map((s) => s.id).join(','), 'deep-0,deep-1,deep-2');
    check('shelf type is BUY', shelf.every((s) => s.type === 'buy'), true);
    check('shelf virtual when unplaced', shelf.every((s) => s.state === 'virtual' && s.orderId === null), true);
    check('shelf deepest on floor', shelf[2].price, 0.001154);
    check('shelf steps match grid', Math.abs(shelf[0].price / shelf[1].price - 1.015) < 1e-9, true);
    // Live shelf orders are pinned (price + orderId kept).
    const live = new Map([
        ['deep-1', { id: 'deep-1', type: 'buy', state: 'active', price: 0.00117, size: 2.1, orderId: '1.7.999' }],
    ]);
    const shelf2 = ensureDeepShelfEntries(live, mkMgr(3));
    const pinned = shelf2.find((s) => s.id === 'deep-1');
    check('live shelf keeps price', pinned.price, 0.00117);
    check('live shelf keeps orderId', pinned.orderId, '1.7.999');
    // Disabled shelf: no descriptors.
    check('disabled shelf is empty', ensureDeepShelfEntries(base, mkMgr(0)).length, 0);
    // Unresolvable floor: existing virtuals kept as-is (no invention).
    const stale = new Map([
        ['deep-0', { id: 'deep-0', type: 'buy', state: 'virtual', price: 0.00119, size: 0, orderId: null }],
    ]);
    const poolMgr = { config: { buyDeepCount: 3, incrementPercent: 1.5, minPrice: '1.15x', gridPrice: 'pool' } };
    const shelf3 = ensureDeepShelfEntries(stale, poolMgr);
    check('static fallback keeps price', shelf3[0].price, 0.00119);
}

// --- isDeepShelfFillOrder ---
{
    const mgr = { _deepShelfOrderIds: new Set(['1.7.111']) };
    check('tracked order is deep fill', isDeepShelfFillOrder(mgr, { op: [null, { order_id: '1.7.111' }] }), true);
    check('plain orderId form works', isDeepShelfFillOrder(mgr, { orderId: '1.7.111' }), true);
    check('other order is not', isDeepShelfFillOrder(mgr, { op: [null, { order_id: '1.7.222' }] }), false);
    check('missing set is not', isDeepShelfFillOrder({}, { op: [null, { order_id: '1.7.111' }] }), false);
}

// --- resolveBuyDeepSizes (manual dip-insurance notionals, top-first) ---
check('manual default is empty', resolveBuyDeepSizes({}).length, 0);
check('manual array passthrough', resolveBuyDeepSizes({ buyDeepSizes: [2.5, 2, 1.5] }).join(','), '2.5,2,1.5');
check('manual comma string parses', resolveBuyDeepSizes({ buyDeepSizes: '2.5, 2,1.5' }).join(','), '2.5,2,1.5');
check('manual negatives become curve fallback', resolveBuyDeepSizes({ buyDeepSizes: [2.5, -1, 'x'] }).join(','), '2.5,0,0');
check('manual garbage is empty', resolveBuyDeepSizes({ buyDeepSizes: 42 }).length, 0);
check('manual empty string is empty', resolveBuyDeepSizes({ buyDeepSizes: '   ' }).length, 0);
check('manual caps at 12', resolveBuyDeepSizes({ buyDeepSizes: new Array(15).fill(1) }).length, 12);

// --- applyDeepManualSizes ---
{
    const shelf = [
        { id: 'deep-0', price: 0.00119 },
        { id: 'deep-1', price: 0.001172 },
        { id: 'deep-2', price: 0.001154 },
    ];
    const curve = new Map([['deep-0', 2.1], ['deep-1', 2.05], ['deep-2', 2.0]]);
    const r1 = applyDeepManualSizes({ buyDeepSizes: [5, 0, 3] }, shelf, curve);
    check('manual wins level 0', r1.sizes.get('deep-0'), 5);
    check('zero falls back to curve', r1.sizes.get('deep-1'), 2.05);
    check('manual wins level 2', r1.sizes.get('deep-2'), 3);
    check('manual ids tracked', [...r1.manualIds].sort().join(','), 'deep-0,deep-2');
    const r2 = applyDeepManualSizes({}, shelf, curve);
    check('no manual keeps curve', r2.sizes.get('deep-0'), 2.1);
    check('no manual ids', r2.manualIds.size, 0);
    const r3 = applyDeepManualSizes({ buyDeepSizes: [7] }, shelf, curve);
    check('short array covers head only', r3.sizes.get('deep-0'), 7);
    check('short array tail uses curve', r3.sizes.get('deep-2'), 2.0);
}

// --- validateWorkingGridFunds: deep excess over allocation is allowed ---
{
    const mkGrid = (orders) => ({ values: () => orders.values(), [Symbol.iterator]: function* () { yield* orders.values(); } });
    const asMap = (arr) => new Map(arr.map((o) => [o.id, o]));
    const funds = { allocatedBuy: 35, chainTotalBuy: 50 };
    const prec = { buyPrecision: 6, sellPrecision: 5 };
    const assets = { assetB: { symbol: 'XBTSX.USDT' }, assetA: { symbol: 'BTS' } };
    const rail = (size) => ({ id: 'slot-0', type: 'buy', state: 'active', price: 0.00134, size, orderId: '1.7.1' });
    const deep = (size) => ({ id: 'deep-2', type: 'buy', state: 'active', price: 0.001154, size, orderId: '1.7.2' });
    // Rail 30 + deep 10 = 40 > allocation 35 but < wallet 50 → VALID (new).
    const v1 = validateWorkingGridFunds(mkGrid(asMap([rail(30), deep(10)])), funds, prec, assets);
    check('deep over-allocation allowed under wallet total', v1.isValid, true);
    // Rail alone over allocation → still blocked (protection kept).
    const v2 = validateWorkingGridFunds(mkGrid(asMap([rail(40)])), funds, prec, assets);
    check('rail over-allocation still blocked', v2.isValid, false);
    // Deep pushing the total over the wallet → blocked (physical cap).
    const v3 = validateWorkingGridFunds(mkGrid(asMap([rail(30), deep(25)])), funds, prec, assets);
    check('over-wallet total still blocked', v3.isValid, false);
    // No shelf: old behavior identical (rail fits → valid).
    const v4 = validateWorkingGridFunds(mkGrid(asMap([rail(30)])), funds, prec, assets);
    check('plain rail still valid', v4.isValid, true);
}

// --- deep-adopt: first placement links even when master lacks the id ---
async function deepAdoptChecks() {
    const applied = [];
    const fakeMgr = {
        assets: { assetA: { precision: 5 }, assetB: { precision: 6 } },
        orders: new Map(),
        lockOrders: () => {},
        unlockOrders: () => {},
        _gridLock: { acquire: async (fn) => await fn() },
        _applyOrderUpdate: async (o) => { applied.push(o); fakeMgr.orders.set(o.id, o); },
        logger: { log: () => {} },
    };
    const sync = new SyncEngine(fakeMgr);
    await sync.synchronizeWithChain({
        gridOrderId: 'deep-1', chainOrderId: '1.7.999', expectedType: 'buy', fee: 0,
        order: { id: 'deep-1', price: 0.00117, size: 5, type: 'buy' },
    }, 'createOrder');
    const adopted = fakeMgr.orders.get('deep-1');
    check('adopted entry exists', !!adopted, true);
    check('adopted links chain id', adopted && adopted.orderId, '1.7.999');
    check('adopted keeps BUY type', adopted && adopted.type, 'buy');
    check('adopted keeps price', adopted && adopted.price, 0.00117);
    check('adopted is active', adopted && adopted.state, 'active');
    // Unknown non-deep id without master entry: still dropped, no crash.
    const n0 = applied.length;
    await sync.synchronizeWithChain({
        gridOrderId: 'slot-999', chainOrderId: '1.7.1000', expectedType: 'buy', fee: 0,
        order: { id: 'slot-999', price: 1, size: 1, type: 'buy' },
    }, 'createOrder');
    check('non-deep unknown id not adopted', applied.length, n0);
    // Deep id without usable price: skipped with warn, nothing applied.
    await sync.synchronizeWithChain({
        gridOrderId: 'deep-2', chainOrderId: '1.7.1001', expectedType: 'buy', fee: 0,
        order: { id: 'deep-2', price: 0, size: 5, type: 'buy' },
    }, 'createOrder');
    check('unusable deep descriptor not adopted', fakeMgr.orders.has('deep-2'), false);
}

deepAdoptChecks().then(() => {
    console.log(`✓ Buy window config tests passed! (${passed} assertions)`);
}).catch((e) => {
    console.error('Deep adopt checks failed:', e);
    process.exit(1);
});
