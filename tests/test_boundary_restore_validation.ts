const assert = require('assert');
const {
    validateBoundaryCommit,
    validatePersistedBoundary
} = require('../modules/order/utils/math');
const { loadGrid } = require('../modules/order/grid');
const { recoverFromPersistedGrid } = require('../modules/dexbot_state_recovery');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Build a 10-slot price-sorted grid:
 *   slots 0..5  BUY rail   (placed)
 *   slots 6..7  gap band   (empty/virtual)
 *   slots 8..9  SELL rail  (placed)
 * Honest boundary = 5, gapSlots = 2.
 */
function buildGrid() {
    const grid = [];
    for (let i = 0; i < 6; i++) {
        grid.push({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            orderId: `1.7.${100 + i}`
        });
    }
    for (let i = 6; i < 8; i++) {
        grid.push({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: ORDER_TYPES.SPREAD,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: ''
        });
    }
    for (let i = 8; i < 10; i++) {
        grid.push({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            orderId: `1.7.${200 + i}`
        });
    }
    return grid;
}

function buildFakeManager(config) {
    const manager = {
        config,
        logs: [],
        logger: null,
        funds: { btsFeesOwed: 0 },
        orders: new Map(),
        _gridVersion: 0,
        boundaryIdx: null,
        _gapSlots: null,
        assets: { assetA: {}, assetB: {} },
        initialSpreadCount: 0,
        currentSpreadCount: 0,
        _gridLock: { acquire: async (fn) => await fn() },
        _fundLock: { acquire: async (fn) => await fn() },
        _initializeAssets: async () => {},
        resetFunds: async () => {},
        pauseRecalcLogging: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        resumeRecalcLogging: () => {},
        _applyOrderUpdate: async (order) => {
            manager.orders.set(order.id, Object.freeze({ ...order }));
        },
        _restoreBoundary: (newIdx) => { manager.boundaryIdx = newIdx; }
    };
    manager.logger = {
        log: (msg, level) => { manager.logs.push({ msg, level }); }
    };
    return manager;
}

// ── unit: validator semantics ───────────────────────────────────────────

async function testValidatorSemantics() {
    console.log('Running test: boundary validator semantics');

    const grid = buildGrid();

    // Honest geometry: boundary 5, gap 6-7, sells 8-9.
    assert.strictEqual(validateBoundaryCommit(5, grid, 2).ok, true, 'commit gate accepts honest boundary');
    assert.strictEqual(validatePersistedBoundary(5, grid, 2).ok, true, 'restore gate accepts honest boundary');
    assert.strictEqual(validateBoundaryCommit(null, grid, 2).ok, true, 'null boundary is always acceptable');

    // Numeric sanity.
    assert.strictEqual(validateBoundaryCommit(4.5, grid, 2).ok, false, 'non-integer rejected');
    assert.strictEqual(validateBoundaryCommit(-1, grid, 2).ok, false, 'negative rejected');
    assert.strictEqual(validateBoundaryCommit(99, grid, 2).reason, 'boundary_out_of_range', 'out-of-range rejected');

    // Sell-rail ceiling (writer alignment): both boundary writers clamp to
    // [0, N−gapSlots−1]; the gate rejects beyond-ceiling proposals so an
    // overrun from a legacy snapshot or buggy writer cannot self-legalize
    // zero-SELL geometry via resolveGapBand. N=10, g=2 -> maxAllowed 7.
    const ceilResult = validateBoundaryCommit(8, grid, 2);
    assert.strictEqual(ceilResult.ok, false, 'beyond-ceiling boundary rejected at commit gate');
    assert.strictEqual(ceilResult.reason, 'sell_rail_ceiling_exceeded', 'stable reason for ceiling overrun');
    assert.ok(/maxAllowed=7/.test(ceilResult.detail), 'detail carries the ceiling');
    assert.strictEqual(validateBoundaryCommit(7, grid, 2).ok, true, 'ceiling value itself accepted (writer parity)');
    assert.strictEqual(validatePersistedBoundary(9, grid, 2).ok, false,
        'restore gate rejects past-ceiling persisted boundary');

    // Crossed-placed-book check limitation (pinned deliberately): entries
    // are price-sorted before position classification, so any BUY-side index
    // always prices <= any SELL-side index. Equal prices sort ADJACENTLY and
    // can never straddle a band with gapSlots >= 1, so the
    // crossed_book_geometry branch is unreachable there. The real
    // restore-time poison signal is stranding, covered below.
    const collision = [
        { id: 'a', price: 1.02, orderId: '1.7.1' },
        { id: 'b', price: 1.00 },
        { id: 'c', price: 1.00 },
        { id: 'd', price: 1.00 },                    // boundary idx 3
        { id: 'e', price: 1.02, orderId: '1.7.2' },  // sorts adjacent to 'a'
        { id: 'f', price: 1.03 },
        { id: 'g', price: 1.04 }
    ];
    assert.strictEqual(
        validateBoundaryCommit(3, collision, 1).ok, true,
        'known limitation: equal prices sort adjacently, cannot straddle band'
    );

    // Stranding: placed order strictly inside the implied band.
    // Default commit gate tolerates it (upstream caps prevent it; post-commit
    // detector owns it) — restore gate rejects it (safe fallback = rebuild).
    const stranded = buildGrid();
    stranded[6] = { ...stranded[6], orderId: '1.7.999', state: ORDER_STATES.ACTIVE, size: 10 };
    assert.strictEqual(
        validateBoundaryCommit(5, stranded, 2).ok, true,
        'commit gate does NOT own in-band placements'
    );
    const strandResult = validatePersistedBoundary(5, stranded, 2);
    assert.strictEqual(strandResult.ok, false, 'restore gate rejects stranded placement');
    assert.strictEqual(strandResult.reason, 'placed_order_in_band');

    // Downward overrun poison (the pre-5eb3ca7 failure shape): boundary slid
    // onto the buy rail so placed BUYs sit inside the implied band. No price
    // crossing — only geometry detects it.
    const downResult = validatePersistedBoundary(3, grid, 2);
    assert.strictEqual(downResult.ok, false, 'downward-overrun boundary rejected at restore');
    assert.strictEqual(downResult.reason, 'placed_order_in_band');

    console.log('  PASS: validator semantics match commit vs restore strictness');
}

// ── loadGrid: honest restore passes through unchanged ───────────────────

async function testLoadGridValidBoundaryPassthrough() {
    console.log('Running test: loadGrid accepts an honest persisted boundary');

    const grid = buildGrid();
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 1.07 });

    await loadGrid(manager, grid, 5);

    assert.strictEqual(manager.boundaryIdx, 5, 'honest boundary restored verbatim');
    assert.strictEqual(manager._gapSlots, 2, 'gapSlots set from config math');
    assert.strictEqual(manager.orders.size, 10, 'all slots loaded');
    assert.ok(!manager.logs.some(l => l.msg.includes('[GRID-LOAD] Persisted boundary rejected')),
        'no rejection logged for honest state');

    console.log('  PASS: honest persisted boundary loads without repair');
}

// ── loadGrid: poisoned boundary is repaired by re-derivation ────────────

async function testLoadGridRepairsPoisonedBoundary() {
    console.log('Running test: loadGrid repairs a poisoned persisted boundary');

    // Overrun poison: downward slide left placed BUYs (idx 4,5) strictly
    // inside the implied band under restored boundary 3.
    const grid = buildGrid();
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 1.07 });

    await loadGrid(manager, grid, 3);

    // calculateIdealBoundary with startPrice=1.07: splitIdx=7 -> 7-1-1=5,
    // which is exactly the honest boundary and passes re-validation.
    assert.strictEqual(manager.boundaryIdx, 5, 'poisoned boundary repaired to re-derived value');
    assert.strictEqual(manager._gapSlots, 2, 'gapSlots set after repair');

    // Slot types must match the REPAIRED geometry.
    for (let i = 0; i <= 5; i++) {
        assert.strictEqual(manager.orders.get(`slot-${i}`).type, ORDER_TYPES.BUY, `slot-${i} BUY`);
    }
    for (let i = 6; i <= 7; i++) {
        assert.strictEqual(manager.orders.get(`slot-${i}`).type, ORDER_TYPES.SPREAD, `slot-${i} SPREAD`);
    }
    for (let i = 8; i <= 9; i++) {
        assert.strictEqual(manager.orders.get(`slot-${i}`).type, ORDER_TYPES.SELL, `slot-${i} SELL`);
    }

    assert.ok(manager.logs.some(l => l.msg.includes('Persisted boundary rejected') && l.level === 'error'),
        'rejection logged at error level');
    assert.ok(manager.logs.some(l => l.msg.includes('boundary repaired: 3 -> 5')), 'repair logged');

    console.log('  PASS: poisoned persisted boundary repaired via re-derivation');
}

// ── loadGrid: unrepairable poison falls back to no boundary ─────────────

async function testLoadGridFallsBackToNullBoundary() {
    console.log('Running test: loadGrid falls back to null when re-derivation is impossible');

    const grid = buildGrid();
    // startPrice not numeric ("pool"/"book" modes) -> cannot re-derive.
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 'pool' });
    manager.boundaryIdx = 42;      // sentinel: must NOT be overwritten by poison
    manager._gapSlots = 'unset';   // sentinel: null path must not touch it

    await loadGrid(manager, grid, 3);

    assert.strictEqual(manager.boundaryIdx, 42, 'poison discarded, previous value kept');
    assert.strictEqual(manager._gapSlots, 'unset', 'null-boundary path leaves _gapSlots untouched');
    assert.strictEqual(manager.orders.size, 10, 'grid still loads without a boundary');
    assert.ok(manager.logs.some(l => l.msg.includes('Could not re-derive a safe boundary') && l.level === 'error'),
        'fallback logged at error level');

    console.log('  PASS: unrepairable poison degrades to boundary-less load');
}

// ── loadGrid: repair maps back to the STORED array ordering ─────────────

async function testLoadGridRepairMapsToStoredOrder() {
    console.log('Running test: loadGrid repair maps the derived boundary to stored positions');

    // Reversed snapshot: boundaryIdx indexes the stored array, so the
    // re-derived price-sorted index (5) must land on the anchor slot's
    // ORIGINAL position (slot-5 -> position 4), not be reused verbatim.
    const grid = buildGrid().slice().reverse();
    const manager = buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1, startPrice: 1.07 });

    await loadGrid(manager, grid, 3);

    assert.strictEqual(manager.boundaryIdx, 4,
        'repair must map sorted idx 5 to the anchor slot\'s stored position');
    assert.ok(manager.logs.some(l => l.msg.includes('boundary repaired: 3 -> 4')), 'repair logged with mapped index');

    // Types follow loadGrid's standard reassignment over STORED positions
    // (rail-typed holes: empty in-rail slots keep BUY/SELL by geometry, only
    // true band slots are SPREAD; placed slots resolve per its retype
    // rules — e.g. an on-chain slot keeps its persisted rail type rather than
    // becoming SPREAD). What this test pins is the MAPPING: the derived
    // price-sorted index must land on the anchor slot's stored position.
    // Repaired boundary 4, gap 2 → sellStart 7: slot-7 sits on the SELL rail,
    // slot-6 sits in the band.
    assert.strictEqual(manager.orders.get('slot-7').type, ORDER_TYPES.SELL, 'empty in-rail hole keeps rail type');
    assert.strictEqual(manager.orders.get('slot-6').type, ORDER_TYPES.SPREAD, 'empty band slot normalized');
    assert.strictEqual(manager.orders.get('slot-5').type, ORDER_TYPES.BUY);
    assert.strictEqual(manager.orders.get('slot-4').type, ORDER_TYPES.BUY,
        'on-chain slot keeps persisted rail type instead of SPREAD');

    console.log('  PASS: unsorted snapshots repair against stored ordering');
}

// ── recovery: poisoned snapshot refused so resync rebuilds clean ────────

async function testRecoveryRejectsPoisonedSnapshot() {
    console.log('Running test: recoverFromPersistedGrid refuses a snapshot with invalid boundary');

    const grid = buildGrid();
    const bot = {
        accountId: '1.2.3',
        accountOrders: {
            loadGrid: () => grid,
            loadBoundaryIdx: () => 3
        },
        // Gate reads config-derived gapSlots (calculateGapSlots(1,1) = 2),
        // matching loadGrid's restore gate exactly.
        manager: buildFakeManager({ incrementPercent: 1, targetSpreadPercent: 1 })
    };
    // If the gate failed to fire, the next step (grid.loadGrid) would run and
    // blow up on the missing _gridLock surface of this stub manager — any
    // non-gate failure yields a different reason string, so asserting on the
    // reason proves the early return happened BEFORE loading.
    bot.manager._gridLock = undefined;

    const result = await recoverFromPersistedGrid(bot);

    assert.strictEqual(result.success, false, 'recovery refuses poisoned snapshot');
    assert.ok(/persisted boundary rejected/.test(result.reason || ''),
        `reason must cite the boundary gate (got: ${result.reason})`);
    assert.ok(bot.manager.logs.some(l => l.msg.includes('[RECOVERY] Persisted boundary failed validation')),
        'rejection logged');

    console.log('  PASS: structural resync falls through to clean rebuild on poisoned snapshot');
}

// ── runner ──────────────────────────────────────────────────────────────

async function runAll() {
    await testValidatorSemantics();
    await testLoadGridValidBoundaryPassthrough();
    await testLoadGridRepairsPoisonedBoundary();
    await testLoadGridFallsBackToNullBoundary();
    await testLoadGridRepairMapsToStoredOrder();
    await testRecoveryRejectsPoisonedSnapshot();
    console.log('All boundary restore validation tests passed');
}

runAll().catch(error => {
    console.error('Test FAILED:', error);
    process.exit(1);
});
