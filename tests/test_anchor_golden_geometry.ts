/**
 * tests/test_anchor_golden_geometry.ts — Phase 4 golden-file geometry pin
 *
 * Pins the rail conventions for boundary helpers so an future off-by-one
 * is located immediately. Canonical fixture × gap × price position × direction.
 * No helper moves; this is the executable spec per PRICE_FIRST_ALIGNMENT_PLAN.
 */
const assert = require('assert');
const { calculateIdealBoundary, projectAnchorToGrid } = require('../modules/order/utils/order');
const { getSellStartIdx } = require('../modules/order/utils/math');
const { ORDER_TYPES } = require('../modules/constants');

function buildSlots(count = 20, start = 100) {
    return Array.from({ length: count }, (_, i) => ({
        id: `slot-${i}`,
        price: start + i,
        type: i < 10 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
    }));
}

async function run() {
    console.log('Running anchor golden geometry tests...');

    const slots = buildSlots(20, 100);

    // Golden table derived from current helpers (see plan D2: reuse existing geometry helpers).
    // Each entry: gap, price, side, expectedIdeal, expectedSellStart, expectedProject(S_sell), expectedProject(B_buy)
    // Single-sided projection: SELL => split - gap ; BUY => split - gap ; ideal => split - floor(gap/2) -1
    const singles = [
        // gap 0 — single slot is the gap, SELL rail starts right after split
        { gap: 0, price: 105,   ideal: 4,  sellStartForIdeal: 5,  projSell: 5,  projBuy: 5 },
        { gap: 0, price: 105.5, ideal: 5,  sellStartForIdeal: 6,  projSell: 6,  projBuy: 6 },
        { gap: 0, price: 110,   ideal: 9,  sellStartForIdeal: 10, projSell: 10, projBuy: 10 },
        { gap: 0, price: 110.5, ideal: 10, sellStartForIdeal: 11, projSell: 11, projBuy: 11 },
        // gap 1
        { gap: 1, price: 105,   ideal: 4,  sellStartForIdeal: 6,  projSell: 4,  projBuy: 4 },
        { gap: 1, price: 105.5, ideal: 5,  sellStartForIdeal: 7,  projSell: 5,  projBuy: 5 },
        { gap: 1, price: 110,   ideal: 9,  sellStartForIdeal: 11, projSell: 9,  projBuy: 9 },
        { gap: 1, price: 110.5, ideal: 10, sellStartForIdeal: 12, projSell: 10, projBuy: 10 },
        // gap 2 — 2-slot spread, floor(gap/2)=1
        { gap: 2, price: 105,   ideal: 3,  sellStartForIdeal: 6,  projSell: 3,  projBuy: 3 },
        { gap: 2, price: 105.5, ideal: 4,  sellStartForIdeal: 7,  projSell: 4,  projBuy: 4 },
        { gap: 2, price: 110,   ideal: 8,  sellStartForIdeal: 11, projSell: 8,  projBuy: 8 },
        { gap: 2, price: 110.5, ideal: 9,  sellStartForIdeal: 12, projSell: 9,  projBuy: 9 },
        // gap 3
        { gap: 3, price: 105,   ideal: 3,  sellStartForIdeal: 7,  projSell: 2,  projBuy: 2 },
        { gap: 3, price: 105.5, ideal: 4,  sellStartForIdeal: 8,  projSell: 3,  projBuy: 3 },
        { gap: 3, price: 110,   ideal: 8,  sellStartForIdeal: 12, projSell: 7,  projBuy: 7 },
        { gap: 3, price: 110.5, ideal: 9,  sellStartForIdeal: 13, projSell: 8,  projBuy: 8 },
    ];

    for (const r of singles) {
        const ideal = calculateIdealBoundary(slots, r.price, r.gap);
        assert.strictEqual(ideal, r.ideal, `ideal gap=${r.gap} price=${r.price} expected ${r.ideal} got ${ideal}`);
        assert.strictEqual(getSellStartIdx(ideal, r.gap), r.sellStartForIdeal, `sellStart gap=${r.gap} ideal=${ideal}`);
        const projSell = projectAnchorToGrid({ maxFilledSellPrice: r.price, minFilledBuyPrice: null, lastFillPrice: r.price, lastFillSide: ORDER_TYPES.SELL }, slots, r.gap);
        const projBuy = projectAnchorToGrid({ maxFilledSellPrice: null, minFilledBuyPrice: r.price, lastFillPrice: r.price, lastFillSide: ORDER_TYPES.BUY }, slots, r.gap);
        assert.strictEqual(projSell, r.projSell, `projSell gap=${r.gap} price=${r.price}`);
        assert.strictEqual(projBuy, r.projBuy, `projBuy gap=${r.gap} price=${r.price}`);
        // I4 ceiling invariant: projected never exceeds gap-aware ceiling
        const ceiling = slots.length - Math.floor(r.gap) - 1;
        const effectiveCeiling = ceiling >= 0 ? ceiling : slots.length - 1;
        assert.ok((projSell as number) <= effectiveCeiling, `projSell ceiling gap=${r.gap}`);
        assert.ok((projBuy as number) <= effectiveCeiling, `projBuy ceiling gap=${r.gap}`);
    }

    // Both-sides anchor: gap centered on traded range
    const bothSides = [
        { gap: 0, maxSell: 112, minBuy: 108, lastSide: ORDER_TYPES.SELL, expected: 12 },
        { gap: 0, maxSell: 115, minBuy: 105, lastSide: ORDER_TYPES.SELL, expected: 15 },
        { gap: 1, maxSell: 112, minBuy: 108, lastSide: ORDER_TYPES.SELL, expected: 11 },
        { gap: 1, maxSell: 115, minBuy: 105, lastSide: ORDER_TYPES.SELL, expected: 14 },
        { gap: 2, maxSell: 112, minBuy: 108, lastSide: ORDER_TYPES.SELL, expected: 10 },
        { gap: 2, maxSell: 115, minBuy: 105, lastSide: ORDER_TYPES.SELL, expected: 13 },
        { gap: 3, maxSell: 112, minBuy: 108, lastSide: ORDER_TYPES.SELL, expected: 9 },
        { gap: 3, maxSell: 115, minBuy: 105, lastSide: ORDER_TYPES.SELL, expected: 12 },
        // Wide range beyond gap capacity — trailing side wins
        { gap: 2, maxSell: 115, minBuy: 100, lastSide: ORDER_TYPES.SELL, expected: 13 }, // upBound dominates
        { gap: 2, maxSell: 115, minBuy: 100, lastSide: ORDER_TYPES.BUY, expected: 0 },   // downBound 0 (100 at idx0 -2 => -2 clamp 0)
    ];
    for (const r of bothSides) {
        const proj = projectAnchorToGrid({ maxFilledSellPrice: r.maxSell, minFilledBuyPrice: r.minBuy, lastFillPrice: r.maxSell, lastFillSide: r.lastSide }, slots, r.gap);
        assert.strictEqual(proj, r.expected, `bothSides gap=${r.gap} range [${r.minBuy},${r.maxSell}] side=${r.lastSide} expected ${r.expected} got ${proj}`);
    }

    // Degenerate geometry: fewer slots than gap needs — ceiling fallback to length-1, never collapses below current
    {
        const tiny = buildSlots(3, 100); // prices 100,101,102
        const gap = 5;
        const proj = projectAnchorToGrid({ maxFilledSellPrice: 102, minFilledBuyPrice: null, lastFillPrice: 102, lastFillSide: ORDER_TYPES.SELL }, tiny, gap);
        // gapAwareCeiling = 3-5-1=-3 <0 => legacyCeiling=2 => clamp 0..2
        assert.ok(proj !== null && (proj as number) >= 0 && (proj as number) <= 2, `degenerate proj ${proj} in [0,2]`);
        const ideal = calculateIdealBoundary(tiny, 101, gap);
        assert.ok(ideal >= 0 && ideal <= 2, `degenerate ideal ${ideal} in [0,2]`);
    }

    // I4: getSellStartIdx never invades buy rail (sellStart = boundary + gap +1)
    for (const gap of [0, 1, 2, 3]) {
        for (let b = 0; b < slots.length; b++) {
            const ss = getSellStartIdx(b, gap);
            assert.strictEqual(ss, b + Math.floor(gap) + 1, `getSellStartIdx b=${b} gap=${gap}`);
        }
    }

    // Null anchor => null projection (cold start → legacy path)
    assert.strictEqual(projectAnchorToGrid(null, slots, 2), null, 'null anchor -> null proj');
    assert.strictEqual(projectAnchorToGrid({ maxFilledSellPrice: null, minFilledBuyPrice: null, lastFillPrice: null } as any, slots, 2), null);

    console.log('✓ All anchor golden geometry tests passed');
}

run().catch(err => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});
