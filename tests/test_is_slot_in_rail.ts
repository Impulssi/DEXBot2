/**
 * Unit tests for MathUtils.isSlotInRail — the shared geometric rail-membership
 * guard used by the strategy window (strategy.ts), virtual-slot activation
 * (_pickVirtualSlotsToActivate), budgeted-size derivation
 * (_deriveBudgetedSideSizes), and the COW divergence correction (system.ts).
 *
 * Covers the classification rules and the defensive fallbacks that make the
 * helper safe as a shared default: unknown boundary never excludes (fail-open for
 * boundary-unknown), while unparseable id always excludes (fail-closed per
 * plan §2.1). Degenerate gapSlots must not silently drop the whole SELL rail.
 */

const assert = require('assert');
const { isSlotInRail } = require('../modules/order/utils/math');
const { ORDER_TYPES } = require('../modules/constants');

function testIsSlotInRail() {
    console.log('\nRunning isSlotInRail unit tests...\n');

    // BUY rail: slots at or below the boundary are in-rail.
    console.log('  BUY rail classification (boundary 10)');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.BUY, { id: 'slot-10' }), true,
        'slot-10 (== boundary) is the top BUY slot');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.BUY, { id: 'slot-5' }), true,
        'slot-5 (inside buy rail) is in-rail');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.BUY, { id: 'slot-0' }), true,
        'slot-0 (bottom buy rail) is in-rail');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.BUY, { id: 'slot-11' }), false,
        'slot-11 (above boundary) is outside the buy rail');

    // SELL rail: slots at or above sellStartIdx (boundary + gapSlots + 1) are in-rail.
    console.log('  SELL rail classification (boundary 10, gap 3 → sellStart 14)');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.SELL, { id: 'slot-14' }), true,
        'slot-14 (== sellStart) is the bottom SELL slot');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.SELL, { id: 'slot-20' }), true,
        'slot-20 (inside sell rail) is in-rail');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.SELL, { id: 'slot-13' }), false,
        'slot-13 (gap band) is outside the sell rail');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.SELL, { id: 'slot-10' }), false,
        'slot-10 (boundary slot) is outside the sell rail');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.SELL, { id: 'slot-11' }), false,
        'slot-11 (gap band) is outside the sell rail');

    // gapSlots 0 collapses the gap to a single slot below sellStart.
    console.log('  gapSlots 0 (boundary 10 → sellStart 11)');
    assert.strictEqual(isSlotInRail(10, 0, ORDER_TYPES.SELL, { id: 'slot-11' }), true,
        'slot-11 is the bottom SELL slot when gap is 0');
    assert.strictEqual(isSlotInRail(10, 0, ORDER_TYPES.SELL, { id: 'slot-10' }), false,
        'slot-10 (boundary) stays on the buy side when gap is 0');

    // Unknown boundary: never exclude (mirrors grid_reconcile boundaryKnown).
    console.log('  Unknown boundary → not excluded');
    assert.strictEqual(isSlotInRail(null, 3, ORDER_TYPES.SELL, { id: 'slot-13' }), true,
        'null boundary must not exclude');
    assert.strictEqual(isSlotInRail(undefined, 3, ORDER_TYPES.BUY, { id: 'slot-11' }), true,
        'undefined boundary must not exclude');
    assert.strictEqual(isSlotInRail(NaN, 3, ORDER_TYPES.BUY, { id: 'slot-0' }), true,
        'NaN boundary must not exclude');

    // Unparseable / missing ids: excluded (fail-closed per plan §2.1)
    console.log('  Unparseable ids → excluded (fail-closed)');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.SELL, { id: 'slot-x' }), false,
        'non-numeric slot id must be excluded');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.SELL, {}), false,
        'missing id must be excluded');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.BUY, { id: 'anything' }), false,
        'non slot-N id must be excluded');

    // Non BUY/SELL type (e.g. SPREAD): no rail constraint.
    console.log('  Non BUY/SELL type → no constraint');
    assert.strictEqual(isSlotInRail(10, 3, ORDER_TYPES.SPREAD, { id: 'slot-13' }), true,
        'SPREAD slots are not constrained to either rail');

    // Degenerate gapSlots must NOT silently exclude the whole SELL rail.
    console.log('  Degenerate gapSlots → SELL rail not silently excluded');
    assert.strictEqual(isSlotInRail(10, NaN, ORDER_TYPES.SELL, { id: 'slot-14' }), true,
        'NaN gapSlots must not exclude in-rail sells');
    assert.strictEqual(isSlotInRail(10, 'abc', ORDER_TYPES.SELL, { id: 'slot-14' }), true,
        'non-numeric gapSlots must not exclude in-rail sells');
    assert.strictEqual(isSlotInRail(10, null, ORDER_TYPES.SELL, { id: 'slot-14' }), true,
        'null gapSlots (treated as 0) keeps sellStart at boundary+1');
    assert.strictEqual(isSlotInRail(10, undefined, ORDER_TYPES.SELL, { id: 'slot-14' }), true,
        'undefined gapSlots (treated as 0) keeps sellStart at boundary+1');

    console.log('✓ isSlotInRail unit tests passed!\n');
}

if (require.main === module) {
    try {
        testIsSlotInRail();
    } catch (err) {
        console.error('Test FAILED:', err);
        process.exit(1);
    }
}

module.exports = { testIsSlotInRail };