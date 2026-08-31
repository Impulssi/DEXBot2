/**
 * tests/test_market_anchor.ts — Phase 1 MarketAnchor unit tests
 *
 * Covers the docs/CONSOLIDATED_ORPHAN_FIX_SUMMARY.md §4 Phase 1 gate: idempotent
 * re-delivery, block ordering (D4), replay cap, freshness, book-seeding
 * (including the empty-book cold start). Pure-function tests against
 * modules/order/utils/order.js — no manager required.
 */
const assert = require('assert');
const {
    createEmptyMarketAnchor,
    updateMarketAnchorFromFills,
    seedMarketAnchorFromBook,
    isMarketAnchorAvailable,
    isMarketAnchorFresh,
    computeAnchorDivergence,
} = require('../modules/order/utils/order');
const { ORDER_TYPES } = require('../modules/constants');

const FRESHNESS_MS = 15 * 60 * 1000;

function makeFill(p: any) {
    const f: any = { op: [0, { order_id: p.orderId }], block_num: p.block_num, id: p.id, type: p.type, price: p.price };
    if (p.isPartial) f.isPartial = true;
    if (p.isDelayedRotationTrigger) f.isDelayedRotationTrigger = true;
    if (p.skipBoundaryShift) f.skipBoundaryShift = true;
    return f;
}

async function run() {
    console.log('Running MarketAnchor unit tests...');

    // ── empty anchor / availability ─────────────────────────────────────
    assert.deepStrictEqual(createEmptyMarketAnchor().fillCount, 0, 'empty anchor fillCount 0');
    assert.strictEqual(isMarketAnchorAvailable(null), false, 'null anchor unavailable');
    assert.strictEqual(
        isMarketAnchorAvailable({ lastFillPrice: null, maxFilledSellPrice: null, minFilledBuyPrice: null }),
        false,
        'all-null anchor unavailable'
    );
    assert.strictEqual(isMarketAnchorAvailable({ lastFillPrice: 105 }), true, 'priced anchor available');
    assert.strictEqual(computeAnchorDivergence(10, 8), 2, 'divergence projected-bookkept');
    assert.strictEqual(computeAnchorDivergence(null, 8), null, 'divergence null on missing projected');
    assert.strictEqual(computeAnchorDivergence(10, null), null, 'divergence null on missing bookkept');

    // ── cold start: null anchor → created, updated ──────────────────────
    {
        const a = updateMarketAnchorFromFills(null, [
            makeFill({ block_num: 10, id: 'f1', type: ORDER_TYPES.SELL, price: 105, orderId: 'o1' }),
        ], null, {});
        assert.ok(a, 'cold start creates anchor');
        assert.strictEqual(a.lastFillPrice, 105, 'cold start lastFillPrice');
        assert.strictEqual(a.maxFilledSellPrice, 105, 'cold start maxFilledSellPrice');
        assert.strictEqual(a.fillCount, 1, 'cold start fillCount');
        assert.strictEqual(a.lastBlockNum, 10, 'cold start lastBlockNum');
        assert.strictEqual(a.lastFillSide, ORDER_TYPES.SELL, 'cold start lastFillSide');
    }

    // ── idempotent re-delivery (buildFillKey dedupe) ────────────────────
    {
        const f = makeFill({ block_num: 10, id: 'f1', type: ORDER_TYPES.SELL, price: 105, orderId: 'o1' });
        const a1 = updateMarketAnchorFromFills(null, [f], null, {});
        const a2 = updateMarketAnchorFromFills(a1, [f], null, {});
        assert.strictEqual(a2.fillCount, 1, 're-delivered fill counted once');
        // Same key but a (wrongly) different price must NOT re-apply
        const tampered = { ...f, price: 140 };
        const a3 = updateMarketAnchorFromFills(a2, [tampered], null, {});
        assert.strictEqual(a3.fillCount, 1, 'same-key tampered re-delivery ignored');
        assert.strictEqual(a3.maxFilledSellPrice, 105, 'range unchanged by tampered re-delivery');
    }

    // ── block ordering (D4): out-of-order fills applied in block order ──
    {
        const a = updateMarketAnchorFromFills(null, [
            makeFill({ block_num: 20, id: 'f2', type: ORDER_TYPES.SELL, price: 110, orderId: 'o2' }),
            makeFill({ block_num: 10, id: 'f1', type: ORDER_TYPES.SELL, price: 100, orderId: 'o1' }),
        ], null, {});
        assert.strictEqual(a.fillCount, 2, 'both block-ordered fills applied');
        assert.strictEqual(a.lastFillPrice, 110, 'trailing direction = latest block');
        assert.strictEqual(a.maxFilledSellPrice, 110, 'range includes both extremes');
    }

    // ── block-ordering tiebreaker: fills without block_num keep input order
    //    (previously scrambled by id-string compare) ─────────────────────
    {
        const a = updateMarketAnchorFromFills(null, [
            makeFill({ id: 'b', type: ORDER_TYPES.BUY, price: 100, orderId: 'ob' }),
            makeFill({ id: 'a', type: ORDER_TYPES.SELL, price: 110, orderId: 'oa' }),
        ], null, {});
        assert.strictEqual(a.lastFillPrice, 110, 'no-block fills keep input order (last wins)');
        assert.strictEqual(a.lastFillSide, ORDER_TYPES.SELL, 'input-order trailing side');
    }

    // ── mixed batch (some fills lack block_num): block fills sort ascending
    //    among themselves, no-block fills apply last in input order.
    //    Regression guard: a null sentinel compared by input order against
    //    present blocks is intransitive — cycles scramble TimSort output
    //    (with-block fills came out in input order, lastBlockNum wrong). ──
    {
        const a = updateMarketAnchorFromFills(null, [
            makeFill({ block_num: 20, id: 'f2', type: ORDER_TYPES.SELL, price: 120, orderId: 'o2' }),
            makeFill({ id: 'fA', type: ORDER_TYPES.SELL, price: 130, orderId: 'oA' }),
            makeFill({ block_num: 10, id: 'f1', type: ORDER_TYPES.SELL, price: 100, orderId: 'o1' }),
            makeFill({ id: 'fB', type: ORDER_TYPES.BUY, price: 95, orderId: 'oB' }),
        ], null, {});
        assert.strictEqual(a.fillCount, 4, 'mixed batch applies every eligible fill');
        // Block-ascending application: f1 (block 10) before f2 (block 20);
        // no-block fA/fB never overwrite lastBlockNum (unknown block).
        assert.strictEqual(a.lastBlockNum, 20, 'block fills applied block-ascending (not input order)');
        assert.strictEqual(a.lastFillPrice, 95, 'no-block fills apply last in input order (fB wins)');
        assert.strictEqual(a.lastFillSide, ORDER_TYPES.BUY, 'trailing fill is the last no-block fill');
        assert.strictEqual(a.maxFilledSellPrice, 130, 'range includes all sell fills regardless of order');
        assert.strictEqual(a.minFilledBuyPrice, 95, 'range includes the no-block buy fill');
    }

    // ── skipBoundaryShift: synthetic (non-market) fills never touch the
    //    anchor — dust-cancel shape (isPartial + isDelayedRotationTrigger +
    //    skipBoundaryShift) must be excluded, while the same shape WITHOUT
    //    the flag stays eligible ─────────────────────────────────────────
    {
        const base = updateMarketAnchorFromFills(null, [
            makeFill({ block_num: 10, id: 'f1', type: ORDER_TYPES.SELL, price: 105, orderId: 'o1' }),
        ], null, {});
        assert.strictEqual(base.fillCount, 1, 'baseline real fill applied');

        const dust = updateMarketAnchorFromFills(base, [
            makeFill({ id: 'd1', type: ORDER_TYPES.SELL, price: 140, orderId: 'oD', isPartial: true, isDelayedRotationTrigger: true, skipBoundaryShift: true }),
        ], null, {});
        assert.strictEqual(dust.fillCount, 1, 'skipBoundaryShift fill excluded from anchor');
        assert.strictEqual(dust.lastFillPrice, 105, 'lastFillPrice unchanged by skipBoundaryShift fill');
        assert.strictEqual(dust.maxFilledSellPrice, 105, 'range unchanged by skipBoundaryShift fill');
        assert.strictEqual(dust.lastBlockNum, 10, 'lastBlockNum unchanged by skipBoundaryShift fill');

        const eligible = updateMarketAnchorFromFills(base, [
            makeFill({ block_num: 11, id: 'd2', type: ORDER_TYPES.SELL, price: 140, orderId: 'oD2', isPartial: true, isDelayedRotationTrigger: true }),
        ], null, {});
        assert.strictEqual(eligible.fillCount, 2, 'same shape without the flag stays eligible');
        assert.strictEqual(eligible.maxFilledSellPrice, 140, 'eligible delayed-rotation fill widens range');
    }

    // ── replay cap (isReplay): only the latest fill contributes ─────────
    {
        const fills = [
            makeFill({ block_num: 5, id: 'f5', type: ORDER_TYPES.BUY, price: 98, orderId: 'o5' }),
            makeFill({ block_num: 10, id: 'f10', type: ORDER_TYPES.SELL, price: 102, orderId: 'o10' }),
            makeFill({ block_num: 15, id: 'f15', type: ORDER_TYPES.SELL, price: 108, orderId: 'o15' }),
        ];
        const a = updateMarketAnchorFromFills(null, fills, null, { isReplay: true });
        assert.strictEqual(a.fillCount, 1, 'replay window capped to latest fill');
        assert.strictEqual(a.lastFillPrice, 108, 'replay latest fill price');
        assert.strictEqual(a.maxFilledSellPrice, 108, 'replay does not widen range to whole window');
        assert.strictEqual(a.minFilledBuyPrice, null, 'replay buy fill excluded (not latest)');
    }

    // ── replay cap skips ineligible/priceless fills when picking latest ─
    {
        const fills = [
            makeFill({ block_num: 5, id: 'f5', type: ORDER_TYPES.BUY, price: 98, orderId: 'o5' }),
            makeFill({ block_num: 10, id: 'f10', type: ORDER_TYPES.SELL, price: 102, orderId: 'o10', isPartial: true }),
            makeFill({ block_num: 15, id: 'f15', type: ORDER_TYPES.SELL, price: null, orderId: 'o15' }),
        ];
        const a = updateMarketAnchorFromFills(null, fills, null, { isReplay: true });
        assert.strictEqual(a.lastFillPrice, 98, 'replay falls back to latest eligible+priced fill');
        assert.strictEqual(a.minFilledBuyPrice, 98, 'replay fallback applied buy');
        assert.strictEqual(a.fillCount, 1, 'replay cap still 1');
    }

    // ── non-replay windows keep every eligible fill ─────────────────────
    {
        const fills = [
            makeFill({ block_num: 5, id: 'f5', type: ORDER_TYPES.BUY, price: 98, orderId: 'o5' }),
            makeFill({ block_num: 10, id: 'f10', type: ORDER_TYPES.SELL, price: 102, orderId: 'o10' }),
            makeFill({ block_num: 15, id: 'f15', type: ORDER_TYPES.SELL, price: 108, orderId: 'o15' }),
        ];
        const a = updateMarketAnchorFromFills(null, fills, null, { isReplay: false });
        assert.strictEqual(a.fillCount, 3, 'live window applies every eligible fill');
        assert.strictEqual(a.minFilledBuyPrice, 98, 'live window buy range');
        assert.strictEqual(a.maxFilledSellPrice, 108, 'live window sell range');
    }

    // ── book-seeding (D5): highest live buy / lowest live sell ──────────
    {
        const seeded = seedMarketAnchorFromBook([
            { price: 100, type: ORDER_TYPES.BUY },
            { price: 105, type: ORDER_TYPES.BUY },
            { price: 110, type: ORDER_TYPES.SELL },
            { price: 115, type: ORDER_TYPES.SELL },
            { price: null, type: ORDER_TYPES.BUY },
            { type: ORDER_TYPES.BUY },
        ]);
        assert.ok(seeded, 'book seed returns anchor');
        assert.strictEqual(seeded.minFilledBuyPrice, 105, 'highest live buy bounds range low');
        assert.strictEqual(seeded.maxFilledSellPrice, 110, 'lowest live sell bounds range high');
        assert.strictEqual(seeded.fillCount, 0, 'book seed has no fills');
        assert.strictEqual(seeded.lastFillPrice, null, 'book seed has no last fill price');
        assert.ok(isMarketAnchorAvailable(seeded), 'book-seeded anchor available');
    }

    // ── book-seeding: empty book / no parseable prices → null (cold start) ──
    {
        assert.strictEqual(seedMarketAnchorFromBook([]), null, 'empty book → no anchor');
        assert.strictEqual(seedMarketAnchorFromBook(null), null, 'null book → no anchor');
        assert.strictEqual(
            seedMarketAnchorFromBook([{ price: 'x', type: ORDER_TYPES.BUY }, { type: ORDER_TYPES.SELL }]),
            null,
            'unparseable book → no anchor'
        );
    }

    // ── freshness: time expiry ──────────────────────────────────────────
    {
        const fresh = { lastFillPrice: 105, maxFilledSellPrice: 110, minFilledBuyPrice: 100, lastFillSide: ORDER_TYPES.SELL, updatedAt: Date.now() };
        assert.strictEqual(isMarketAnchorFresh(fresh), true, 'fresh anchor (no price arg → time only)');
        const old = { ...fresh, updatedAt: Date.now() - FRESHNESS_MS - 60_000 };
        assert.strictEqual(isMarketAnchorFresh(old), false, 'anchor older than FRESHNESS_MS is stale');
        assert.strictEqual(isMarketAnchorFresh(null), false, 'null anchor stale');
    }

    // ── freshness: price-move expiry (>3 increments beyond range) ───────
    {
        // factor = 1.01^3 ≈ 1.0303; upper ≈ 110*1.0303 ≈ 113.3; lower ≈ 100/1.0303 ≈ 97.1
        const anchor = { lastFillPrice: 105, maxFilledSellPrice: 110, minFilledBuyPrice: 100, lastFillSide: ORDER_TYPES.SELL, updatedAt: Date.now() };
        assert.strictEqual(isMarketAnchorFresh(anchor, 114, 1), false, 'price above upper bound → stale');
        assert.strictEqual(isMarketAnchorFresh(anchor, 95, 1), false, 'price below lower bound → stale');
        assert.strictEqual(isMarketAnchorFresh(anchor, 105, 1), true, 'price inside range → fresh');
        assert.strictEqual(isMarketAnchorFresh(anchor, 112, 1), true, 'price within 3-increment tolerance → fresh');
        assert.strictEqual(isMarketAnchorFresh(anchor, 500, null), true, 'no incrementPercent → time-only');
    }

    // ── freshness: single-sided range ───────────────────────────────────
    {
        const sellOnly = { lastFillPrice: 110, maxFilledSellPrice: 110, minFilledBuyPrice: null, lastFillSide: ORDER_TYPES.SELL, updatedAt: Date.now() };
        assert.strictEqual(isMarketAnchorFresh(sellOnly, 120, 1), false, 'single-sided upper escape → stale');
        assert.strictEqual(isMarketAnchorFresh(sellOnly, 110, 1), true, 'single-sided within range → fresh');
        const buyOnly = { lastFillPrice: 100, maxFilledSellPrice: null, minFilledBuyPrice: 100, lastFillSide: ORDER_TYPES.BUY, updatedAt: Date.now() };
        assert.strictEqual(isMarketAnchorFresh(buyOnly, 90, 1), false, 'single-sided lower escape → stale');
        assert.strictEqual(isMarketAnchorFresh(buyOnly, 100, 1), true, 'single-sided within range → fresh');
    }

    console.log('✓ All MarketAnchor unit tests passed');
}

run().catch(err => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});