/**
 * tests/test_manual_hold.ts
 *
 * Manual-cancel hold: operator-cancelled slots stay empty until the market
 * moves significantly past them, instead of refilling on the next cycle.
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const {
    MANUAL_HOLD_MOVE_MULT,
    resolveManualHoldMovePct,
    isManualHoldExpired,
    recordManualHold,
    clearManualHold,
    pruneManualHolds,
    isSlotHeld,
    getManualHoldMap,
    classifyDisappearance,
    classifyDisappearanceAsync,
    clearMarkerPath,
    consumeClearMarker,
    serializeManualHolds,
    restoreManualHolds,
} = require('../modules/order/manual_hold');
const chainOrders = require('../modules/chain_orders');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

let passed = 0;
function check(name, actual, expected) {
    assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`);
    passed++;
}

function fakeManager(config): any {
    return {
        config: config || {},
        orders: new Map(),
        logger: { log() {} },
    };
}

// --- move threshold scales with grid density ---
check('mult constant is 5', MANUAL_HOLD_MOVE_MULT, 5);
check('1.5% incr -> 7.5% move', resolveManualHoldMovePct({ incrementPercent: 1.5 }), 0.075);
check('missing incr falls back', resolveManualHoldMovePct({}), 0.075);
check('zero incr falls back', resolveManualHoldMovePct({ incrementPercent: 0 }), 0.075);

// --- expiry math ---
check('exact threshold stays held', isManualHoldExpired({ price: 100, ts: 1 }, 107.5, 0.075), false);
check('past threshold releases', isManualHoldExpired({ price: 100, ts: 1 }, 107.51, 0.075), true);
check('down move releases symmetrically', isManualHoldExpired({ price: 100, ts: 1 }, 92, 0.075), true);
check('small move holds', isManualHoldExpired({ price: 100, ts: 1 }, 103, 0.075), false);
check('no market price never expires', isManualHoldExpired({ price: 100, ts: 1 }, null, 0.075), false);
check('garbage hold expires', isManualHoldExpired({ price: 0, ts: 1 }, 100, 0.075), true);
check('null hold expires', isManualHoldExpired(null, 100, 0.075), true);

// --- record / clear / presence ---
{
    const mgr = fakeManager({});
    check('absent by default', isSlotHeld(mgr, 'slot-1'), false);
    check('record ok', recordManualHold(mgr, 'slot-1', 100), true);
    check('present after record', isSlotHeld(mgr, 'slot-1'), true);
    check('rejects bad price', recordManualHold(mgr, 'slot-2', 0), false);
    check('bad price absent', isSlotHeld(mgr, 'slot-2'), false);
    check('clear ok', clearManualHold(mgr, 'slot-1'), true);
    check('absent after clear', isSlotHeld(mgr, 'slot-1'), false);
    check('clear missing is false', clearManualHold(mgr, 'slot-1'), false);
}

// --- prune keeps active, drops moved-past ---
{
    const mgr = fakeManager({ incrementPercent: 1.5 });
    recordManualHold(mgr, 'near', 115);
    recordManualHold(mgr, 'far', 100);
    mgr.manualHolds.get('far').ts -= 1000;
    const dropped = pruneManualHolds(mgr, 120, 0.075);
    check('moved-past dropped', JSON.stringify(dropped), JSON.stringify(['far']));
    check('near kept', isSlotHeld(mgr, 'near'), true);
    check('far gone', isSlotHeld(mgr, 'far'), false);
}

// --- baseline semantics: a far-away cancel holds while the market sits ---
{
    // Slot far above a flat market: legacy slot-comparison would release
    // instantly; baseline comparison must hold.
    check(
        'far slot held on flat market',
        isManualHoldExpired({ price: 0.001569, ts: 1, base: 0.001384 }, 0.001384, 0.075),
        false
    );
    check(
        'releases when market rallies from baseline',
        isManualHoldExpired({ price: 0.001569, ts: 1, base: 0.001384 }, 0.00151, 0.075),
        true
    );
    check(
        'legacy entry without base uses slot comparison',
        isManualHoldExpired({ price: 100, ts: 1 }, 120, 0.075),
        true
    );
}

// --- serialize / restore roundtrip (crash survival; graceful stop clears instead) ---
{
    const mgr = fakeManager({});
    mgr.orders.set('slot-1', { id: 'slot-1', price: 100 });
    recordManualHold(mgr, 'slot-1', 100);
    recordManualHold(mgr, 'slot-gone', 50);
    const snap = serializeManualHolds(mgr);
    check('serializes both', snap.length, 2);
    const mgr2 = fakeManager({});
    mgr2.orders.set('slot-1', { id: 'slot-1', price: 100 });
    const restored = restoreManualHolds(mgr2, snap);
    check('restores only surviving slot', restored, 1);
    check('survivor held', isSlotHeld(mgr2, 'slot-1'), true);
    check('dead id dropped', isSlotHeld(mgr2, 'slot-gone'), false);
    check('garbage input restores zero', restoreManualHolds(fakeManager({}), null), 0);
}

// --- classifyDisappearance: fill / own / manual ---
{
    const mgr = fakeManager({});
    mgr.processedFillTracker = new Map([['1.7.100:10:abc', Date.now()]]);
    mgr._fillBatchInFlight = 0;
    check('known fill -> fill', classifyDisappearance(mgr, { id: 's', orderId: '1.7.100' }), 'fill');
    check('unknown, no context -> manual', classifyDisappearance(mgr, { id: 's', orderId: '1.7.999' }), 'manual');
    check('missing orderId -> fill (fail-open)', classifyDisappearance(mgr, { id: 's' }), 'fill');
    chainOrders.recordOwnCancel('1.7.555');
    check('own cancel -> own', classifyDisappearance(mgr, { id: 's', orderId: '1.7.555' }), 'own');
    mgr._fillBatchInFlight = 1;
    check('in-flight fills -> fill (fail-open)', classifyDisappearance(mgr, { id: 's', orderId: '1.7.999' }), 'fill');
    mgr._fillBatchInFlight = 0;
}

// --- clear-marker consume (dexbot clear-holds handshake) ---
{
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holds-'));
    try {
        check('no marker -> -1', consumeClearMarker(fakeManager({}), tmp, 'bot1'), -1);
        check('bad args -> -1', consumeClearMarker(fakeManager({}), '', ''), -1);
        const mgr = fakeManager({});
        recordManualHold(mgr, 'slot-9', 100);
        fs.writeFileSync(path.join(tmp, 'manual-holds.clear.bot1'), 'clear-holds unit-test\n', 'utf8');
        check('marker clears holds', consumeClearMarker(mgr, tmp, 'bot1'), 1);
        check('holds gone', isSlotHeld(mgr, 'slot-9'), false);
        check('marker consumed', fs.existsSync(path.join(tmp, 'manual-holds.clear.bot1')), false);
        check('second consume -> -1', consumeClearMarker(mgr, tmp, 'bot1'), -1);
        check('marker path null on empty', clearMarkerPath('', ''), null);
        // Single-slot marker clears only that hold.
        recordManualHold(mgr, 'slot-a', 100);
        recordManualHold(mgr, 'slot-b', 100);
        fs.writeFileSync(path.join(tmp, 'manual-holds.clear.bot1'), 'slot:slot-a\n', 'utf8');
        check('single-slot clears 1', consumeClearMarker(mgr, tmp, 'bot1'), 1);
        check('target gone', isSlotHeld(mgr, 'slot-a'), false);
        check('other kept', isSlotHeld(mgr, 'slot-b'), true);
        fs.writeFileSync(path.join(tmp, 'manual-holds.clear.bot1'), 'slot:slot-missing\n', 'utf8');
        check('unknown slot clears 0', consumeClearMarker(mgr, tmp, 'bot1'), 0);
        check('other still kept', isSlotHeld(mgr, 'slot-b'), true);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

// --- surplus-cancel grace (fresh placements immune briefly) ---
{
    const { recordOrderPlacement, isFreshlyPlacedOrder } = require('../modules/order/utils/order');
    const mgr = fakeManager({});
    check('unknown id not fresh', isFreshlyPlacedOrder(mgr, '1.7.1'), false);
    check('null id not fresh', isFreshlyPlacedOrder(mgr, null), false);
    recordOrderPlacement(mgr, '1.7.1');
    check('just placed is fresh', isFreshlyPlacedOrder(mgr, '1.7.1'), true);
    check('custom grace honored (1ms)', isFreshlyPlacedOrder(mgr, '1.7.1', 1), true);
    mgr._placedAt.set('1.7.1', Date.now() - 20 * 60 * 1000);
    check('aged out not fresh', isFreshlyPlacedOrder(mgr, '1.7.1'), false);
    check('record ignores empty', recordOrderPlacement(mgr, ''), undefined);
    check('record on missing manager safe', recordOrderPlacement(null, '1.7.1'), undefined);
}

// --- hold records carry the vanished orderId (serialize roundtrip) ---
{
    const mgr = fakeManager({});
    mgr.orders.set('slot-1', { id: 'slot-1', price: 100 });
    recordManualHold(mgr, 'slot-1', 100, '1.7.777');
    check('hold stores orderId', mgr.manualHolds.get('slot-1').orderId, '1.7.777');
    const snap = serializeManualHolds(mgr);
    check('snapshot carries orderId', snap[0].orderId, '1.7.777');
    const mgr2 = fakeManager({});
    mgr2.orders.set('slot-1', { id: 'slot-1', price: 100 });
    restoreManualHolds(mgr2, snap);
    check('restore revives orderId', mgr2.manualHolds.get('slot-1').orderId, '1.7.777');
    check('record without orderId still ok', recordManualHold(fakeManager({}), 's', 50), true);
}

// --- history-verify: a missed fill must never hold (async; runs after the sync summary) ---
(async () => {
    let passedAsync = 0;
    const acheck = (name, actual, expected) => {
        assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`);
        passedAsync++;
    };
    // Snapshot consult (sync path): persisted recent-fill keys cover restarts
    // that wipe the in-memory tracker.
    {
        const mgr = fakeManager({});
        mgr._recentFillKeysSnapshot = { '1.7.200:99:1.11.5': Date.now() };
        mgr._fillBatchInFlight = 0;
        acheck('snapshot fill -> fill', classifyDisappearance(mgr, { id: 's', orderId: '1.7.200' }), 'fill');
        acheck('snapshot miss -> manual', classifyDisappearance(mgr, { id: 's', orderId: '1.7.201' }), 'manual');
    }
    // Fast path never pays for the RPC.
    {
        let calls = 0;
        const counting = async () => { calls++; return null; };
        const mgr = fakeManager({});
        mgr.processedFillTracker = new Map([['1.7.100:10:abc', Date.now()]]);
        acheck('fast fill skips verifier', await classifyDisappearanceAsync(mgr, { id: 's', orderId: '1.7.100' }, counting), 'fill');
        acheck('verifier not called', calls, 0);
    }
    // History verdicts: hit -> fill, clean miss -> manual, error -> fill (fail-open).
    acheck('history hit -> fill',
        await classifyDisappearanceAsync(fakeManager({}), { id: 's', orderId: '1.7.300' }, async () => ({ historyId: '1.11.9' })), 'fill');
    acheck('history miss -> manual',
        await classifyDisappearanceAsync(fakeManager({}), { id: 's', orderId: '1.7.301' }, async () => null), 'manual');
    acheck('history error -> fill (fail-open)',
        await classifyDisappearanceAsync(fakeManager({}), { id: 's', orderId: '1.7.302' }, async () => { throw new Error('node down'); }), 'fill');
    acheck('no verifier -> manual',
        await classifyDisappearanceAsync(fakeManager({}), { id: 's', orderId: '1.7.303' }, null), 'manual');
    console.log(`✓ Manual hold history-verify tests passed! (${passedAsync} assertions)`);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

// --- findFillForOrderInHistory: single-page scan (injected fetcher; runs after the sync summary) ---
(async () => {
    let passedH = 0;
    const hcheck = (name, actual, expected) => {
        assert.deepStrictEqual(actual, expected, `${name}: got ${JSON.stringify(actual)}`);
        passedH++;
    };
    const page = [
        { id: '1.11.10', op: [1, { order_id: '1.7.1' }], block_num: 100 },
        { id: '1.11.11', op: [4, { order_id: '1.7.900' }], block_num: 101 },
        { id: '1.11.12', op: ['fill_order', { orderId: '1.7.901' }], block_num: 102 },
        { id: '1.11.13', op: [4, {}], block_num: 103 },
        null,
    ];
    const fetcher = async (accountRef, stop, limit, start) => {
        assert.strictEqual(accountRef, 'acct');
        assert.strictEqual(stop, '1.11.0');
        assert.ok(limit <= 100);
        assert.strictEqual(start, '1.11.0');
        return page;
    };
    const hit = await chainOrders.findFillForOrderInHistory('acct', '1.7.900', { fetcher });
    hcheck('numeric fill op matches', hit && hit.historyId, '1.11.11');
    const hit2 = await chainOrders.findFillForOrderInHistory('acct', '1.7.901', { fetcher });
    hcheck('named fill op matches', hit2 && hit2.blockNum, 102);
    hcheck('no match -> null', await chainOrders.findFillForOrderInHistory('acct', '1.7.999', { fetcher }), null);
    hcheck('missing args -> null', await chainOrders.findFillForOrderInHistory(null, '1.7.900', { fetcher }), null);
    let threw = false;
    try {
        await chainOrders.findFillForOrderInHistory('acct', '1.7.900', { fetcher: async () => { throw new Error('rpc down'); } });
    } catch (e) {
        threw = /rpc down/.test(String((e as any)?.message || e));
    }
    hcheck('rpc error throws (caller fail-opens)', threw, true);
    let threw2 = false;
    try {
        await chainOrders.findFillForOrderInHistory('acct', '1.7.900', { fetcher: async () => ({}) });
    } catch (e) {
        threw2 = true;
    }
    hcheck('malformed page throws', threw2, true);
    console.log(`✓ Fill history verify tests passed! (${passedH} assertions)`);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

// --- execution gate: held slots never broadcast (plan/execute race; runs after the sync summary) ---
(async () => {
    let passedX = 0;
    const xcheck = (name, actual, expected) => {
        assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`);
        passedX++;
    };
    const { OrderManager } = require('../modules/order/index').default;
    const { _createOrderFromGrid } = require('../modules/order/grid_reconcile_internal');
    const mgr = new OrderManager({
        market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
        startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
        activeOrders: { buy: 2, sell: 2 },
    });
    mgr.logger.level = 'silent';
    mgr.assets = { assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' }, assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' } };
    await mgr.setAccountTotals({ buy: 100000, sell: 100, buyFree: 100000, sellFree: 100 });
    await mgr.resetFunds();
    mgr.pauseFundRecalc();
    await mgr._updateOrder({ id: 'slot-5', type: ORDER_TYPES.BUY, price: 90, size: 100, state: ORDER_STATES.VIRTUAL });
    let broadcasts = 0;
    const fakeChain = {
        createOrder: async () => { broadcasts++; return { operation_results: [[0, '1.7.900']] }; },
    };
    const params = { chainOrders: fakeChain, account: 'a', privateKey: 'p', manager: mgr, dryRun: false };
    // Race: hold lands after planning, before execution -> no broadcast.
    recordManualHold(mgr, 'slot-5', 90);
    const heldResult = await _createOrderFromGrid({ ...params, gridOrder: { id: 'slot-5', type: ORDER_TYPES.BUY, price: 90, size: 100 } });
    xcheck('held create returns null', heldResult, null);
    xcheck('held create never broadcasts', broadcasts, 0);
    xcheck('slot stays empty', mgr.orders.get('slot-5').orderId || null, null);
    // Control: same slot without the hold broadcasts (fixture reaches broadcast).
    clearManualHold(mgr, 'slot-5');
    const okResult = await _createOrderFromGrid({ ...params, gridOrder: { id: 'slot-5', type: ORDER_TYPES.BUY, price: 90, size: 100 } });
    xcheck('unheld create broadcasts', broadcasts, 1);
    xcheck('unheld create links', okResult, '1.7.900');
    await mgr.resumeFundRecalc();
    console.log(`✓ Manual hold execution-gate tests passed! (${passedX} assertions)`);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});

console.log(`✓ Manual hold tests passed! (${passed} assertions)`);
