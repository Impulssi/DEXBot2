/**
 * GRID-PRICE-INVARIANT checker test suite (GPI-001..GPI-008).
 *
 * Covers checkGridPriceInvariant — the guard that BLOCKS a broadcast whose
 * price is not the genesis level for its own slot.
 *
 * Why this exists: range guards (isChainPriceOutOfGrid) only test the
 * configured min/max bounds, so an off-grid price can sit inside the bounds
 * while being far outside the active window. That band had no check on the
 * broadcast path. See docs/GRID_PRICE_INVARIANT.md.
 *
 * Contract asserted here:
 * - a genuine genesis level is ok
 * - a price that is not the genesis level is reported (off-grid-price)
 * - unjudgeable inputs are NEVER violations (no false positives on wide grids,
 *   synthetic slot ids, missing genesis, or non-finite prices)
 * - it never throws
 *
 * Uses synthetic geometry only — no real pair names or account identifiers.
 */

const assert = require('assert');
const { checkGridPriceInvariant } = require('../modules/order/utils/order');
const { checkGridPriceInvariant: cowChecker, deriveRotationPrice } = require('../modules/dexbot_cow_runtime');

/** Build a minimal genesis with a geometric ladder. */
function makeGenesis(base: number, incPct: number, len: number) {
    const step = 1 + incPct / 100;
    const priceLevels: number[] = [];
    for (let i = 0; i < len; i++) priceLevels.push(base * Math.pow(step, i));
    return { startPrice: base, incrementPercent: incPct, gapSlots: 2, priceLevels };
}

function testGPI001_GenesisLevelPasses() {
    const g = makeGenesis(1000, 0.5, 10);
    for (let i = 0; i < 10; i++) {
        const r = checkGridPriceInvariant(`slot-${i}`, g.priceLevels[i], g);
        assert.strictEqual(r.ok, true, `slot-${i} genesis level must pass`);
        assert.strictEqual(r.reason, 'ok');
        assert.strictEqual(r.idx, i);
    }
    console.log('  \u2713 GPI-001 genesis level passes');
}

function testGPI002_OffGridPriceReported() {
    const g = makeGenesis(1000, 0.5, 10);
    // slot-3 is 1015.075...; emit something ~2.5x that.
    const offGrid = g.priceLevels[3] * 2.5;
    const r = checkGridPriceInvariant('slot-3', offGrid, g);
    assert.strictEqual(r.ok, false, 'off-grid price must be reported');
    assert.strictEqual(r.reason, 'off-grid-price');
    assert.strictEqual(r.idx, 3);
    assert.ok(Math.abs(r.expected - g.priceLevels[3]) < 1e-9, 'expected is the genesis level');
    assert.ok(r.drift > 1, 'drift is relative and large');
    console.log('  \u2713 GPI-002 off-grid price reported');
}

function testGPI003_InBoundsButOffGridStillReported() {
    // The core case: a price inside the configured min/max range but not a
    // grid level. Range guards would allow this; this check must not.
    const g = makeGenesis(1000, 0.5, 200);
    const lo = g.priceLevels[0];
    const hi = g.priceLevels[g.priceLevels.length - 1];
    const between = (g.priceLevels[7] + g.priceLevels[8]) / 2; // mid-slot gap
    assert.ok(between > lo && between < hi, 'fixture price is inside the range');
    const r = checkGridPriceInvariant('slot-7', between, g);
    assert.strictEqual(r.ok, false, 'in-range but off-grid must be reported');
    console.log('  \u2713 GPI-003 in-bounds off-grid price reported');
}

function testGPI004_MissingGenesisIsNotAViolation() {
    for (const bad of [null, undefined, {}, { priceLevels: [] }, { priceLevels: 'x' }]) {
        const r = checkGridPriceInvariant('slot-1', 123, bad);
        assert.strictEqual(r.ok, true, 'missing genesis must not report a violation');
        assert.strictEqual(r.reason, 'no-genesis');
    }
    console.log('  \u2713 GPI-004 missing genesis is not a violation');
}

function testGPI005_UncheckableIdsAreNotViolations() {
    const g = makeGenesis(1000, 0.5, 10);
    const ids = [undefined, null, 12345, '', 'chain-1.7.123', 'slot-', 'slot-abc', 'slot--1'];
    for (const id of ids) {
        const r = checkGridPriceInvariant(id, 999999, g);
        assert.strictEqual(r.ok, true, `id ${JSON.stringify(id)} must not report a violation`);
        assert.strictEqual(r.reason, 'uncheckable-slot');
    }
    console.log('  \u2713 GPI-005 uncheckable slot ids are not violations');
}

function testGPI006_OutOfRangeIndexIsNotAViolation() {
    const g = makeGenesis(1000, 0.5, 10);
    for (const id of ['slot-10', 'slot-999999']) {
        const r = checkGridPriceInvariant(id, 1000, g);
        assert.strictEqual(r.ok, true, `${id} beyond the ladder is uncheckable, not a violation`);
        assert.strictEqual(r.reason, 'uncheckable-slot');
    }
    console.log('  \u2713 GPI-006 out-of-range slot index is not a violation');
}

function testGPI007_InvalidPriceIsNotAViolation() {
    const g = makeGenesis(1000, 0.5, 10);
    for (const p of [NaN, Infinity, -Infinity, 0, -5, null, undefined, 'abc']) {
        const r = checkGridPriceInvariant('slot-3', p, g);
        assert.strictEqual(r.ok, true, `price ${String(p)} must not report a violation`);
        assert.strictEqual(r.reason, 'invalid-price');
    }
    console.log('  \u2713 GPI-007 invalid price is not a violation');
}

function testGPI008_NeverThrows() {
    const g = makeGenesis(1000, 0.5, 10);
    // Hostile genesis / slotId combinations must degrade, never throw.
    const hostileGenesis = [
        { priceLevels: [NaN, 1, 2] },
        { priceLevels: [1, null, 2] },
        { priceLevels: [1, 'x', 2] },
        { get priceLevels() { throw new Error('boom'); } },
    ];
    for (const hg of hostileGenesis) {
        const r = checkGridPriceInvariant('slot-1', 1, hg);
        assert.strictEqual(r.ok, true, 'hostile genesis must not report a violation');
    }
    // A slotId whose parse throws must also degrade.
    const r = checkGridPriceInvariant({ toString() { throw new Error('boom'); } }, 1, g);
    assert.strictEqual(r.ok, true);
    console.log('  \u2713 GPI-008 never throws, degrades to ok');
}

/**
 * The COW module exposes a thin wrapper over the shared checker. It must agree
 * with the shared implementation, otherwise the emit-time rejection and the
 * reconcile-site rejection would disagree about the same price.
 */
function testGPI009_CowWrapperAgreesWithShared() {
    const g = makeGenesis(1000, 0.5, 10);
    const cases: Array<[any, any]> = [
        ['slot-3', g.priceLevels[3]],
        ['slot-3', g.priceLevels[3] * 2.5],
        ['slot-99', 1234],
        ['chain-1.7.1', 1234],
        ['slot-2', NaN],
    ];
    for (const [id, price] of cases) {
        const shared = checkGridPriceInvariant(id, price, g);
        const wrapper = cowChecker(id, price, g);
        assert.deepStrictEqual(wrapper, shared, `wrapper disagrees for ${id} @ ${String(price)}`);
    }
    // And the shared checker must be reachable from the grid-reconcile path too.
    const orderUtils = require('../modules/order/utils/order');
    assert.strictEqual(typeof orderUtils.reportGridPriceInvariant, 'function',
        'reportGridPriceInvariant must be exported for the reconcile sites');
    console.log('  \u2713 GPI-009 COW wrapper agrees with shared checker');
}

/**
 * Planner pairing: every UPDATE action the real planner emits must pair
 * newGridId with the price of THAT SAME slot. This is what makes checking
 * (newGridId, newPrice) correct at the broadcast site. If a future planner
 * emits a rotation whose newPrice belongs to a different slot, this fails here
 * instead of surfacing as a confusing violated++ in the soak.
 */
function testGPI010_PlannerPairsDestinationIdWithPrice() {
    const { reconcileGrid } = require('../modules/order/utils/validate');
    const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

    // Genesis whose levels ARE the fixture slot prices, so the planner's
    // destination price can be checked against priceForSlot(newGridId).
    // Mirrors the surplus+hole rotation shape used by test_cow_master_plan.
    const lv = (i: number) => 1000 * Math.pow(1.005, i);
    const genesis = { startPrice: 1000, incrementPercent: 0.5, gapSlots: 2,
        priceLevels: Array.from({ length: 40 }, (_, i) => lv(i)) };

    const mk = (i: number, type: string, state: string, size: number, orderId: string | null) => ({
        id: `slot-${i}`, type, state, price: lv(i), size, amount: size, orderId
    });

    // slot-3: destination hole (target wants a live SELL there).
    // slot-9: surplus (live on chain, target wants it empty).
    const master = new Map<string, any>([
        [`slot-3`, mk(3, ORDER_TYPES.SPREAD, ORDER_STATES.VIRTUAL, 0, null)],
        [`slot-9`, mk(9, ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 5, '1.7.9001')],
    ]);
    const target = new Map<string, any>([
        [`slot-3`, mk(3, ORDER_TYPES.SELL, ORDER_STATES.ACTIVE, 5, null)],
        [`slot-9`, mk(9, ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL, 0, null)],
    ]);

    const result = reconcileGrid(master, target, null) || {};
    const updates = (result.actions || []).filter((a: any) => a && a.type === 'update' && a.newGridId != null);

    assert.ok(updates.length > 0, 'fixture must produce at least one UPDATE to be meaningful');
    for (const a of updates) {
        // The pairing under test: newPrice must be the genesis level of newGridId.
        const inv = checkGridPriceInvariant(a.newGridId, a.newPrice, genesis);
        assert.strictEqual(inv.ok, true,
            `planner UPDATE paired newGridId=${a.newGridId} with newPrice=${a.newPrice} ` +
            `but that slot's genesis level is ${inv.expected}`);
    }
    console.log(`  \u2713 GPI-010 planner pairs destination id with price (${updates.length} UPDATE(s))`);
}


/**
 * The guard must actually BLOCK, not just warn.
 *
 * This is the property that matters: a warning on a live path is a no-op, so a
 * regression that silently reverted the check to report-only would still pass
 * every "does it detect" test. These assert the return contract the emission
 * sites branch on.
 */
function testGPI011_GuardBlocksOffGridEmission() {
    const { reportGridPriceInvariant } = require('../modules/order/utils/order');
    const g = makeGenesis(1000, 0.5, 10);
    const logs: string[] = [];
    const manager: any = { _genesis: g, logger: { log: (m: string) => logs.push(String(m)) } };

    // A genesis level must be allowed through.
    const allowed = reportGridPriceInvariant(manager, 'slot-3', g.priceLevels[3], 'TEST');
    assert.strictEqual(allowed, true, 'a genesis level must be permitted');
    assert.strictEqual(logs.length, 0, 'a passing check must not log');

    // An off-grid price must be REFUSED.
    const refused = reportGridPriceInvariant(manager, 'slot-3', g.priceLevels[3] * 2.5, 'TEST');
    assert.strictEqual(refused, false, 'an off-grid price must be refused');
    assert.strictEqual(logs.length, 1, 'a refusal must log exactly once');
    assert.ok(logs[0].includes('SKIPPED'), `refusal must say the emission was skipped, got: ${logs[0]}`);

    console.log('  \u2713 GPI-011 off-grid emission is blocked, genesis level permitted');
}

/**
 * ...but it must FAIL OPEN on anything it cannot judge. A guard that blocks on
 * missing metadata would halt legitimate trading during startup (no genesis yet)
 * or on synthetic ids — far worse than the bug it prevents.
 */
function testGPI012_GuardFailsOpenOnUnjudgeable() {
    const { reportGridPriceInvariant } = require('../modules/order/utils/order');
    const g = makeGenesis(1000, 0.5, 10);
    const noGenesis: any = { _genesis: null, logger: { log: () => {} } };
    const withGenesis: any = { _genesis: g, logger: { log: () => {} } };

    const cases: Array<[string, any, any]> = [
        ['no genesis (pre-genesis startup)', noGenesis, 'slot-3', ],
        ['synthetic chain id', withGenesis, 'chain-1.7.1'],
        ['out-of-ladder slot index', withGenesis, 'slot-999'],
        ['non-finite price', withGenesis, 'slot-3'],
    ];
    for (const [label, mgr, id] of cases) {
        const price = label === 'non-finite price' ? NaN : g.priceLevels[3];
        assert.strictEqual(reportGridPriceInvariant(mgr, id, price, 'TEST'), true,
            `must fail OPEN on ${label}`);
    }

    // A throwing checker must not block either.
    const exploding: any = {
        _genesis: { get priceLevels() { throw new Error('boom'); } },
        logger: { log: () => {} },
    };
    assert.strictEqual(reportGridPriceInvariant(exploding, 'slot-3', 1000, 'TEST'), true,
        'a checker failure must fail OPEN, never block a broadcast');

    console.log('  \u2713 GPI-012 unjudgeable inputs fail open (never block)');
}

async function runAllTests() {
    console.log('\n=== GRID-PRICE-INVARIANT test suite ===');
/**
 * GPI-013 — the emitted rotation price is DERIVED from the destination's
 * genesis level, not taken from the planner's action.newPrice.
 *
 * The planner sets newPrice = hole.order.price, a mutable slot field. Checking
 * it is not enough on its own: the emission should not depend on that object
 * being sound. deriveRotationPrice makes the destination level authoritative,
 * so a planner bug cannot produce a mis-priced UPDATE even if the check were
 * bypassed.
 */
function testGPI013_RotationPriceDerivedFromGenesis() {
    const g = makeGenesis(1000, 0.5, 10);
    const bot = { manager: { _genesis: g } };
    for (let i = 0; i < 10; i++) {
        const got = deriveRotationPrice(bot, `slot-${i}`);
        assert.strictEqual(got, g.priceLevels[i],
            `slot-${i} must derive to its genesis level ${g.priceLevels[i]}, got ${got}`);
    }
    console.log('  \u2713 GPI-013 rotation price derives from the destination genesis level');
}

/**
 * GPI-014 — with no genesis ladder (migration) the derivation declines rather
 * than inventing a price, so the caller falls back to the planned price and the
 * checker fails open. Deriving a price with no ladder would be worse than the
 * bug it prevents.
 */
function testGPI014_RotationPriceUndefinedWithoutGenesis() {
    for (const bot of [
        { manager: {} },
        { manager: { _genesis: null } },
        { manager: { _genesis: { priceLevels: [] } } },
        {},
    ]) {
        const got = deriveRotationPrice(bot, 'slot-3');
        assert.ok(Number.isNaN(got), `no genesis must yield NaN, got ${got}`);
    }
    const g = makeGenesis(1000, 0.5, 10);
    for (const bad of [null, undefined, '', 'not-a-slot', 'chain-1.7.123']) {
        const got = deriveRotationPrice({ manager: { _genesis: g } }, bad);
        assert.ok(Number.isNaN(got), `unparseable id ${String(bad)} must yield NaN, got ${got}`);
    }
    console.log('  \u2713 GPI-014 derivation declines instead of inventing a price');
}

/**
 * GPI-015 — an out-of-ladder destination index declines (that slot has no
 * level), rather than reading a neighbouring level.
 */
function testGPI015_RotationPriceOutOfLadderDeclines() {
    const g = makeGenesis(1000, 0.5, 10);
    const bot = { manager: { _genesis: g } };
    for (const bad of ['slot-99', 'slot-1000']) {
        const got = deriveRotationPrice(bot, bad);
        assert.ok(Number.isNaN(got), `${bad} is out of the ladder and must yield NaN, got ${got}`);
    }
    console.log('  \u2713 GPI-015 out-of-ladder destination declines');
}

    testGPI001_GenesisLevelPasses();
    testGPI002_OffGridPriceReported();
    testGPI003_InBoundsButOffGridStillReported();
    testGPI004_MissingGenesisIsNotAViolation();
    testGPI005_UncheckableIdsAreNotViolations();
    testGPI006_OutOfRangeIndexIsNotAViolation();
    testGPI007_InvalidPriceIsNotAViolation();
    testGPI008_NeverThrows();
    testGPI009_CowWrapperAgreesWithShared();
    testGPI010_PlannerPairsDestinationIdWithPrice();
    testGPI011_GuardBlocksOffGridEmission();
    testGPI012_GuardFailsOpenOnUnjudgeable();
    testGPI013_RotationPriceDerivedFromGenesis();
    testGPI014_RotationPriceUndefinedWithoutGenesis();
    testGPI015_RotationPriceOutOfLadderDeclines();
    console.log('\n=== All grid-price-invariant tests passed! ===');
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });
