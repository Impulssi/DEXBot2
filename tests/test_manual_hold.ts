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
    serializeManualHolds,
    restoreManualHolds,
    classifyDisappearance,
} = require('../modules/order/manual_hold');
const chainOrders = require('../modules/chain_orders');

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

// --- serialize / restore roundtrip (restart resilience) ---
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

console.log(`✓ Manual hold tests passed! (${passed} assertions)`);
