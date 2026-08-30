const assert = require('assert');

const {
    reconcileGridOrders,
} = require('../modules/order/grid_reconcile');
const { validateBoundaryAgainstChainEvidence } = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

// ── shared fixtures ─────────────────────────────────────────────────────

const SLOT_PRICES = [1.00, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.10, 1.11];

function slotGrid(boundaryForTypes, slotCount = 12, gapSlots = 2) {
    const slots = [];
    for (let i = 0; i < slotCount; i++) {
        const sellStart = boundaryForTypes + gapSlots + 1;
        const type = i <= boundaryForTypes
            ? ORDER_TYPES.BUY
            : (i >= sellStart ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
        slots.push({
            id: `slot-${i}`,
            price: SLOT_PRICES[i],
            type,
            state: ORDER_STATES.VIRTUAL,
            size: type === ORDER_TYPES.SPREAD ? 0 : 10,
            orderId: '',
        });
    }
    return slots;
}

// assetA = XRP (sell-side), assetB = BTS (buy-side); both precision 5.
function sellChainOrder(id, price) {
    return {
        id,
        sell_price: {
            base: { amount: 1000000, asset_id: '1.3.1' },
            quote: { amount: Math.round(price * 1000000), asset_id: '1.3.0' },
        },
        for_sale: 1000000,
    };
}

function buyChainOrder(id, price) {
    return {
        id,
        sell_price: {
            base: { amount: Math.round(price * 1000000), asset_id: '1.3.0' },
            quote: { amount: 1000000, asset_id: '1.3.1' },
        },
        for_sale: Math.round(price * 1000000),
    };
}

function createManager(overrides = {}) {
    const orders = new Map();
    const manager = {
        orders,
        logs: [],
        logger: null,
        assets: {
            assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        },
        accountTotals: { sellFree: 100, buyFree: 100 },
        strategy: {
            hasAnyDust: () => false,
            rebalance: async () => null,
        },
        accountant: {
            addToChainFree: async () => {},
        },
        getOrdersByTypeAndState: (type, state) => {
            return Array.from(orders.values()).filter(o => o && o.type === type && o.state === state);
        },
        _gridLock: { acquire: async (fn) => await fn() },
        _fundLock: { acquire: async (fn) => await fn() },
        synchronizeWithChain: async () => {},
        _applySync: async () => {},
        _updateOrder: (order) => { orders.set(order.id, order); },
        _applyOrderUpdate: async (order) => { orders.set(order.id, order); return true; },
        _orderIdAssignedAt: new Map(),
        boundaryIdx: null,
        _gapSlots: null,
        _restoreBoundary: (newIdx: number) => { manager.boundaryIdx = newIdx; },
        ...overrides,
    };
    manager.logger = {
        log: (msg, level) => { manager.logs.push({ msg, level }); }
    };
    return manager;
}

function chainFacade(captures) {
    return {
        updateOrder: async () => {},
        buildUpdateOrderOp: async (account, chainOrderId, updateParams) => {
            captures.updateOps.push({
                chainOrderId,
                newPrice: updateParams.newPrice,
                orderType: updateParams.orderType,
            });
            return { op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } };
        },
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => { captures.cancels++; },
        createOrder: async () => { captures.creates++; return []; },
        readOpenOrders: async () => [],
    };
}

// ── unit: validator semantics ───────────────────────────────────────────

async function testValidatorConsistentBook() {
    console.log('Running test: validator accepts a boundary consistent with the live book');
    const evidence = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 5,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [
            { price: 1.02, type: ORDER_TYPES.BUY },
            { price: 1.05, type: ORDER_TYPES.BUY },
            { price: 1.08, type: ORDER_TYPES.SELL },
            { price: 1.11, type: ORDER_TYPES.SELL },
        ],
    });
    assert.strictEqual(evidence.ok, true, 'consistent book passes');
    assert.strictEqual(evidence.suggestedBoundary, 5, 'no correction suggested');
    assert.deepStrictEqual(evidence.reasons, [], 'no reasons');
    assert.strictEqual(evidence.liveBuyMaxIdx, 5, 'buy evidence mapped by price');
    assert.strictEqual(evidence.liveSellMinIdx, 8, 'sell evidence mapped by price');
    console.log('  PASS: consistent book validates without correction');
}

async function testValidatorEdgeAlignmentIsConsistent() {
    console.log('Running test: boundary exactly at the live rails is consistent');
    const evidence = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 5,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [
            { price: 1.05, type: ORDER_TYPES.BUY },
            { price: 1.08, type: ORDER_TYPES.SELL },
        ],
    });
    assert.strictEqual(evidence.ok, true, 'rails exactly at boundary/sellStart are consistent');
    console.log('  PASS: edge-aligned book does not trigger a correction');
}

async function testValidatorStaleLowBoundary() {
    console.log('Running test: stale-low boundary is corrected to the chain-implied window');
    const evidence = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 3,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [
            { price: 1.04, type: ORDER_TYPES.BUY },
            { price: 1.05, type: ORDER_TYPES.BUY },
            { price: 1.09, type: ORDER_TYPES.SELL },
            { price: 1.10, type: ORDER_TYPES.SELL },
        ],
    });
    assert.strictEqual(evidence.ok, false, 'stale-low boundary rejected');
    assert.ok(evidence.reasons.includes('LIVE_BUY_ABOVE_BOUNDARY'), 'live BUY above boundary detected');
    assert.strictEqual(evidence.feasibleLower, 5, 'lower bound from live BUY evidence');
    assert.strictEqual(evidence.feasibleUpper, 6, 'upper bound from live SELL evidence');
    assert.strictEqual(evidence.suggestedBoundary, 5, 'restored boundary clamped into feasible window');
    console.log('  PASS: stale-low boundary re-derived to 5');
}

async function testValidatorStaleHighBoundary() {
    console.log('Running test: stale-high boundary is corrected downward');
    const evidence = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 7,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [
            { price: 1.00, type: ORDER_TYPES.BUY },
            { price: 1.02, type: ORDER_TYPES.BUY },
            { price: 1.08, type: ORDER_TYPES.SELL },
            { price: 1.09, type: ORDER_TYPES.SELL },
        ],
    });
    assert.strictEqual(evidence.ok, false, 'stale-high boundary rejected');
    assert.ok(evidence.reasons.includes('LIVE_SELL_BELOW_SELL_START'), 'live SELL below sellStart detected');
    assert.strictEqual(evidence.suggestedBoundary, 5, 'restored boundary clamped down to feasible window');
    console.log('  PASS: stale-high boundary re-derived to 5');
}

async function testValidatorCrossedBook() {
    console.log('Running test: crossed live book yields no safe derivation');
    const evidence = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 5,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [
            { orderId: '1.7.301', price: 1.10, type: ORDER_TYPES.BUY },
            { orderId: '1.7.401', price: 1.02, type: ORDER_TYPES.SELL },
        ],
    });
    assert.strictEqual(evidence.ok, false, 'crossed book rejected');
    assert.ok(evidence.reasons.includes('NO_FEASIBLE_BOUNDARY'), 'infeasible window reported');
    assert.strictEqual(evidence.suggestedBoundary, null, 'no boundary suggested for a crossed book');
    assert.deepStrictEqual(evidence.conflictingBuyIds, ['1.7.301'], 'straddling BUY enumerated for cancel ladder');
    assert.deepStrictEqual(evidence.conflictingSellIds, ['1.7.401'], 'straddling SELL enumerated for cancel ladder');
    console.log('  PASS: crossed book defers to adoption-only');
}

async function testValidatorAnchorPreferredWhenFeasible() {
    console.log('Running test: fresh anchor projection is the preferred correction');
    const evidence = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 3,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [
            { price: 1.05, type: ORDER_TYPES.BUY },
            { price: 1.10, type: ORDER_TYPES.SELL },
        ],
        anchorProjected: 6,
    });
    assert.strictEqual(evidence.ok, false, 'chain violation still detected');
    assert.strictEqual(evidence.suggestedBoundary, 6, 'anchor projection wins over plain clamp');
    console.log('  PASS: anchor projection used as the corrected boundary');
}

async function testValidatorAnchorContradictionDoesNotVeto() {
    console.log('Running test: contradictory anchor can NEVER veto the chain-derived boundary');
    // Production scenario: bookkept boundary 3, chain says buys/sells imply a
    // feasible window [5..7]; a stale anchor projects 11 (far off). The anchor
    // must only nudge WITHIN the feasible window — it can never null the
    // correction and force an adoption-only reconcile that cancels orders.
    const evidence = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 3,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [
            { price: 1.05, type: ORDER_TYPES.BUY },
            { price: 1.10, type: ORDER_TYPES.SELL },
        ],
        anchorProjected: 11,
    });
    assert.strictEqual(evidence.ok, false, 'chain violation still detected');
    assert.ok(!evidence.reasons.includes('ANCHOR_CONTRADICTS_CORRECTION'),
        'contradictory anchor must NOT veto the correction');
    assert.strictEqual(evidence.suggestedBoundary, 7,
        'chain-evidenced boundary wins: clamped into feasible window [5..7]');
    console.log('  PASS: contradictory anchor ignored; chain boundary authoritative');
}

async function testValidatorAnchorNeverGatesAlone() {
    console.log('Running test: divergent anchor against a consistent book does not gate');
    const evidence = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 5,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [
            { price: 1.02, type: ORDER_TYPES.BUY },
            { price: 1.11, type: ORDER_TYPES.SELL },
        ],
        anchorProjected: 11,
    });
    assert.strictEqual(evidence.ok, true, 'anchor drift alone is telemetry, not a violation');
    assert.strictEqual(evidence.suggestedBoundary, 5, 'bookkept boundary kept');
    console.log('  PASS: anchor divergence alone never triggers a correction');
}

async function testValidatorDegenerateInputs() {
    console.log('Running test: degenerate inputs pass through without gating');
    const noBoundary = validateBoundaryAgainstChainEvidence({
        boundaryIdx: null,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [{ price: 1.05, type: ORDER_TYPES.BUY }],
    });
    assert.strictEqual(noBoundary.ok, true, 'null boundary has nothing to validate');
    assert.strictEqual(noBoundary.suggestedBoundary, null, 'null boundary suggests nothing');

    const noChain = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 5,
        gapSlots: 2,
        allSlots: slotGrid(5),
        chainOrders: [],
    });
    assert.strictEqual(noChain.ok, true, 'empty live book cannot contradict');
    assert.strictEqual(noChain.suggestedBoundary, 5, 'bookkept boundary kept');

    // Writer-ceiling clamp: 8 slots, gap 2 -> ceiling 5; boundary 7 with live
    // sells at slot-5 must clamp to the feasible window, not the restored value.
    const ceiling = validateBoundaryAgainstChainEvidence({
        boundaryIdx: 7,
        gapSlots: 2,
        allSlots: slotGrid(5, 8),
        chainOrders: [
            { price: 1.00, type: ORDER_TYPES.BUY },
            { price: 1.05, type: ORDER_TYPES.SELL },
        ],
    });
    assert.strictEqual(ceiling.ok, false, 'beyond-ceiling boundary with live sells rejected');
    assert.strictEqual(ceiling.suggestedBoundary, 2, 'clamped into [liveBuyMax..liveSellMin-gap-1]');
    console.log('  PASS: degenerate inputs and ceiling clamps handled');
}

// ── integration: reconcile gate wiring ──────────────────────────────────

async function testReconcileReDerivesBoundaryBeforePlacements() {
    console.log('Running test: reconcile re-derives the boundary BEFORE placing orders');

    // Restored state: boundary 3 (stale), slot types assigned per that restore.
    const manager = createManager({ boundaryIdx: 3, _gapSlots: 2 });
    for (const slot of slotGrid(3)) {
        manager.orders.set(slot.id, slot);
    }

    // Live book contradicts boundary 3: buys were swept up to slots 4-5 prices.
    const chainOpenOrders = [
        buyChainOrder('1.7.101', 1.04),
        buyChainOrder('1.7.102', 1.05),
        sellChainOrder('1.7.201', 1.09),
        sellChainOrder('1.7.202', 1.10),
    ];

    const captures = { updateOps: [], creates: 0, cancels: 0 };
    await reconcileGridOrders({
        manager,
        config: { activeOrders: { buy: 2, sell: 2 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders: chainFacade(captures),
        chainOpenOrders,
    });

    assert.strictEqual(manager.boundaryIdx, 5, 'boundary re-derived before placements');
    assert.ok(manager.logs.some(l => l.msg.includes('[BOUNDARY-EVIDENCE] Boundary 3 contradicts chain evidence')
        && l.level === 'error'), 'violation logged at error level');
    assert.ok(manager.logs.some(l => l.msg.includes('Boundary re-derived from chain evidence: 3 -> 5')),
        'correction logged');

    // The sell updates must land on the CORRECTED sell rail (slots 8-9), never
    // on slots 6-7 — those sit inside the honest gap band and are exactly how
    // the incident orphan was created (stale-boundary placement).
    const sellTargets = captures.updateOps.filter(u => u.orderType === ORDER_TYPES.SELL).map(u => u.newPrice);
    assert.deepStrictEqual(sellTargets.sort(), [1.08, 1.09], 'sells placed on the corrected sell rail');
    assert.ok(!sellTargets.includes(1.06) && !sellTargets.includes(1.07),
        'no order may be price-updated into the honest gap band');

    const buyTargets = captures.updateOps.filter(u => u.orderType === ORDER_TYPES.BUY).map(u => u.newPrice);
    assert.deepStrictEqual(buyTargets.sort(), [1.02, 1.03], 'buys placed on the corrected buy rail');

    assert.strictEqual(captures.creates, 0, 'no creates needed (targets 2/2, chain 2/2)');
    assert.strictEqual(captures.cancels, 0, 'no cancels needed');
    console.log('  PASS: placements proceeded on corrected geometry, band untouched');
}

async function testReconcileCancelsStraddlersWhenNoSafeBoundary() {
    console.log('Running test: reconcile cancels straddling orders when no safe boundary is derivable');

    const manager = createManager({ boundaryIdx: 3, _gapSlots: 2 });
    for (const slot of slotGrid(3)) {
        manager.orders.set(slot.id, slot);
    }

    // Crossed live book: BUY priced above a SELL -> no feasible boundary while
    // both straddle. The cancel ladder repairs the geometry instead of freezing
    // placements: single-side removals are infeasible here (each order sits
    // inside the opposite rail), so both straddlers are cancelled and the
    // reconcile proceeds on the corrected geometry (surplus semantics).
    const chainOpenOrders = [
        buyChainOrder('1.7.301', 1.11),
        sellChainOrder('1.7.401', 1.02),
    ];

    const captures = { updateOps: [], creates: 0, cancels: 0 };
    await reconcileGridOrders({
        manager,
        config: { activeOrders: { buy: 2, sell: 2 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders: chainFacade(captures),
        chainOpenOrders,
    });

    assert.strictEqual(manager.boundaryIdx, 3, 'boundary re-derived from the surviving evidence');
    assert.ok(manager.logs.some(l => l.msg.includes('[BOUNDARY-EVIDENCE] Boundary 3 contradicts chain evidence')
        && l.msg.includes('NO_FEASIBLE_BOUNDARY')), 'infeasibility logged');
    assert.ok(manager.logs.some(l => l.msg.includes('NO_FEASIBLE recovery: cancelling 2 straddling')),
        'straddle cancel repair logged');
    assert.ok(manager.logs.some(l => l.msg.includes('Boundary re-derived after straddle cancel')),
        'post-cancel boundary re-derivation logged');
    assert.ok(!manager.logs.some(l => l.msg.includes('No safe boundary derivable from chain evidence')),
        'no adoption-only freeze once the ladder repairs the geometry');
    assert.strictEqual(captures.cancels, 2, 'both straddlers cancelled');
    assert.strictEqual(captures.updateOps.length, 0, 'no price-updates needed for the cancelled straddlers');
    assert.ok(captures.creates > 0, 'placements proceed after the repair');
    console.log('  PASS: crossed book repaired via straddle cancels, placements proceed');
}

async function testReconcileCancelsSingleStraddlingSide() {
    console.log('Running test: reconcile cancels the smaller straddling side (H-BTS reset case)');

    const manager = createManager({ boundaryIdx: 3, _gapSlots: 2 });
    for (const slot of slotGrid(3)) {
        manager.orders.set(slot.id, slot);
    }

    // A dust BUY parked in the spread zone while the SELL rail is intact:
    // cancelling the BUY alone reopens a feasible boundary — the SELL rail
    // survives and the reconcile proceeds without touching it.
    const chainOpenOrders = [
        buyChainOrder('1.7.501', 1.05),
        sellChainOrder('1.7.502', 1.07),
        sellChainOrder('1.7.503', 1.08),
    ];

    const captures = { updateOps: [], creates: 0, cancels: 0 };
    await reconcileGridOrders({
        manager,
        config: { activeOrders: { buy: 2, sell: 2 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders: chainFacade(captures),
        chainOpenOrders,
    });

    assert.strictEqual(manager.boundaryIdx, 3, 'boundary consistent with the surviving SELL rail');
    assert.ok(manager.logs.some(l => l.msg.includes('NO_FEASIBLE recovery: cancelling 1 straddling')
        && l.msg.includes('1.7.501')), 'single straddling BUY cancelled');
    assert.ok(!manager.logs.some(l => l.msg.includes('No safe boundary derivable from chain evidence')),
        'no adoption-only freeze');
    assert.strictEqual(captures.cancels, 1, 'only the straddling BUY cancelled');
    assert.ok(captures.creates > 0, 'placements proceed after the repair');
    console.log('  PASS: smaller straddling side cancelled, SELL rail preserved');
}

// ── runner ──────────────────────────────────────────────────────────────

async function runAll() {
    await testValidatorConsistentBook();
    await testValidatorEdgeAlignmentIsConsistent();
    await testValidatorStaleLowBoundary();
    await testValidatorStaleHighBoundary();
    await testValidatorCrossedBook();
    await testValidatorAnchorPreferredWhenFeasible();
    await testValidatorAnchorContradictionDoesNotVeto();
    await testValidatorAnchorNeverGatesAlone();
    await testValidatorDegenerateInputs();
    await testReconcileReDerivesBoundaryBeforePlacements();
    await testReconcileCancelsStraddlersWhenNoSafeBoundary();
    await testReconcileCancelsSingleStraddlingSide();
    console.log('All boundary chain-evidence gate tests passed');
}

runAll().catch(error => {
    console.error('Test FAILED:', error);
    process.exit(1);
});
