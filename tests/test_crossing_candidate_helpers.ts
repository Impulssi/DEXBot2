/**
 * tests/test_crossing_candidate_helpers.ts
 *
 * Batch 1 (P1 — H1/H2/M1): the shared crossing-candidate builder and
 * predicate. Regression: crossing guards were blind to pending CREATEs
 * because pending entries carry only a slot id (no chain orderId), so
 * orderId-only predicates filtered them out and an UPDATE-only rotation
 * could re-price across a pending broadcast and self-trade.
 */

const assert = require('assert');
const { ORDER_TYPES } = require('../modules/constants');
const {
    buildCrossingCheckCandidates,
    isCrossingCheckCandidate,
    crossingCandidateChainId,
} = require('../modules/order/utils/order');
const { findCrossedOrder } = require('../modules/order/utils/math');

const assets = {
    assetA: { id: '1.3.0', symbol: 'TEST', precision: 8 },
    assetB: { id: '1.3.1', symbol: 'BTS', precision: 5 },
};

function makeMaster(id, type, price, orderId) {
    return { id, type, price, size: 10, state: 'active', orderId };
}

// Pending-broadcast wrapper shape (dexbot_cow_runtime recordPendingBroadcast):
// orderId is the SLOT id; the inner order carries type/price/size.
function makePendingWrapper(slotId, type, price) {
    return {
        fingerprint: `fp-${slotId}`,
        opIndex: 0,
        ctxIndex: 0,
        slotId,
        orderId: slotId,
        orderType: type,
        order: { id: slotId, type, price, size: 10 },
        finalInts: { sell: 1, receive: 1 },
        batchId: 'batch-1',
        recordedAt: Date.now(),
    };
}

function makeManager() {
    return {
        orders: new Map([
            ['slot-1', makeMaster('slot-1', ORDER_TYPES.SELL, 110, '1.7.100')],
        ]),
        _pendingBroadcasts: new Map([
            ['fp-slot-5', makePendingWrapper('slot-5', ORDER_TYPES.BUY, 101)],
        ]),
        _lastUnmatchedChainOrders: [
            { chainOrderId: '1.7.200', type: ORDER_TYPES.SELL, price: 120, size: 5 },
        ],
    };
}

async function runTests() {
    console.log('Running crossing-candidate helper tests...');

    console.log(' - builder includes master + pending wrappers + orphans...');
    {
        const candidates = buildCrossingCheckCandidates(makeManager());
        assert.strictEqual(candidates.length, 3, 'master + 1 pending + 1 orphan');
        assert.ok(candidates.some((c) => c.orderId === '1.7.100'), 'master order present');
        assert.ok(candidates.some((c) => c.slotId === 'slot-5' && c.order), 'pending wrapper present');
        assert.ok(candidates.some((c) => c.chainOrderId === '1.7.200'), 'orphan present');
    }

    console.log(' - builder tolerates missing manager parts...');
    {
        assert.deepStrictEqual(buildCrossingCheckCandidates(null), [], 'null manager');
        assert.deepStrictEqual(buildCrossingCheckCandidates({}), [], 'empty manager');
        const noPending = buildCrossingCheckCandidates({ orders: new Map([['a', makeMaster('a', ORDER_TYPES.BUY, 90, '1.7.1')]]) });
        assert.strictEqual(noPending.length, 1, 'master only');
    }

    console.log(' - predicate accepts all three candidate classes...');
    {
        const mgr = makeManager();
        const [master, pending, orphan] = buildCrossingCheckCandidates(mgr);
        void master;
        assert.strictEqual(isCrossingCheckCandidate(mgr.orders.get('slot-1')), true, 'master accepted');
        assert.strictEqual(isCrossingCheckCandidate(pending), true, 'pending wrapper accepted (slot-id-only identity)');
        assert.strictEqual(isCrossingCheckCandidate(orphan), true, 'orphan accepted');
    }

    console.log(' - predicate rejects VIRTUAL slots and junk...');
    {
        assert.strictEqual(isCrossingCheckCandidate({ id: 'slot-9', type: ORDER_TYPES.BUY, price: 90, size: 10, state: 'virtual' }), false, 'VIRTUAL slot (no orderId) rejected');
        assert.strictEqual(isCrossingCheckCandidate(null), false, 'null rejected');
        assert.strictEqual(isCrossingCheckCandidate({ orderId: '1.7.5', price: null }), false, 'priceless rejected');
        // Unwrapped pending order (inner order alone, slot id only, no chain
        // id): not a valid candidate — callers must push the wrapper entry.
        assert.strictEqual(isCrossingCheckCandidate({ id: 'slot-5', type: ORDER_TYPES.BUY, price: 101, size: 10 }), false, 'bare slot-id order rejected (push the wrapper)');
    }

    console.log(' - predicate honors exclusions; cancel map is harmless for pending...');
    {
        const mgr = makeManager();
        const pending = buildCrossingCheckCandidates(mgr).find((c) => c.slotId === 'slot-5');
        const cancelMap = new Map([['1.7.100', 0]]);
        assert.strictEqual(isCrossingCheckCandidate(mgr.orders.get('slot-1'), null, cancelMap), false, 'cancelled master excluded');
        assert.strictEqual(isCrossingCheckCandidate(mgr.orders.get('slot-1'), '1.7.100', null), false, 'relocated order excluded');
        assert.strictEqual(isCrossingCheckCandidate(pending, null, cancelMap), true, 'pending survives unrelated cancel map');
        assert.strictEqual(isCrossingCheckCandidate(pending, '1.7.999', cancelMap), true, 'pending survives unrelated exclusion');
    }

    console.log(' - chain-id helper resolves each class...');
    {
        assert.strictEqual(crossingCandidateChainId({ orderId: '1.7.1' }), '1.7.1', 'master');
        assert.strictEqual(crossingCandidateChainId({ chainOrderId: '1.7.2' }), '1.7.2', 'orphan');
        assert.strictEqual(crossingCandidateChainId(makePendingWrapper('slot-5', ORDER_TYPES.BUY, 101)), 'slot-5', 'pending wrapper');
        assert.strictEqual(crossingCandidateChainId({ id: 'slot-5' }), null, 'bare slot id');
    }

    console.log(' - end-to-end: SELL create across a pending BUY is detected (H1)...');
    {
        const mgr = makeManager();
        const candidates = buildCrossingCheckCandidates(mgr);
        // SELL @100 crosses the pending BUY @101 (buy priced above the sell).
        const crossed = findCrossedOrder(
            candidates,
            100,
            ORDER_TYPES.SELL,
            assets,
            (o) => isCrossingCheckCandidate(o)
        );
        assert.ok(crossed, 'crossing detected');
        assert.strictEqual(crossed.slotId, 'slot-5', 'the crossed order is the pending wrapper');
        // Without the pending broadcast the same placement is clean (the
        // master sell @110 and orphan sell @120 are same-side, not crossed).
        const mgrNoPending = makeManager();
        mgrNoPending._pendingBroadcasts = new Map();
        const clean = findCrossedOrder(
            buildCrossingCheckCandidates(mgrNoPending),
            100,
            ORDER_TYPES.SELL,
            assets,
            (o) => isCrossingCheckCandidate(o)
        );
        assert.strictEqual(clean, null, 'no crossing without the pending broadcast');
    }

    console.log(' - end-to-end: old orderId-only predicate misses the pending wrapper...');
    {
        const mgr = makeManager();
        const candidates = buildCrossingCheckCandidates(mgr);
        const legacyPredicate = (o) => {
            const oid = o?.orderId || o?.chainOrderId;
            return o && oid;
        };
        // NOTE: wrappers carry orderId=slotId so even the legacy predicate
        // sees them — the historical blindness was pushing entry.order
        // (unwrapped, no orderId) instead of the wrapper. Guard the fix from
        // both sides: wrappers visible, unwrapped pending invisible.
        const seen = findCrossedOrder(candidates, 100, ORDER_TYPES.SELL, assets, legacyPredicate);
        assert.ok(seen, 'wrapper visible even to legacy predicate');
        const unwrappedOnly = [mgr._pendingBroadcasts.get('fp-slot-5').order];
        const missed = findCrossedOrder(unwrappedOnly, 100, ORDER_TYPES.SELL, assets, legacyPredicate);
        assert.strictEqual(missed, null, 'unwrapped pending order invisible to orderId-only predicate (the H1 hole)');
        const caught = findCrossedOrder(
            [mgr._pendingBroadcasts.get('fp-slot-5')],
            100,
            ORDER_TYPES.SELL,
            assets,
            (o) => isCrossingCheckCandidate(o)
        );
        assert.ok(caught, 'shared predicate catches the wrapper');
    }

    console.log('\n✓ crossing-candidate helper tests PASSED!');
}

runTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
