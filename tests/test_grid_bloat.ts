const assert = require('assert');
const { isGridBloated, loadGrid } = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { ORDER_SPREAD_TOLERANCE } = require('../modules/constants');
const { getErrorMessage } = require('../modules/utils/errors');

function makeOrder(id, type, overrides = {}) {
    const inc = 0.3;
    const step = 1 + inc / 100;
    const index = parseInt(id.replace(/\D/g, '')) || 0;
    return {
        id,
        type,
        state: ORDER_STATES.ACTIVE,
        orderId: '1.7.' + id,
        price: 1.0 * Math.pow(step, index),
        size: 10,
        ...overrides,
    };
}

// gapSlots for incPct=0.3, targetSpreadPct=0.6:
//   ceil(ln(1.006) / ln(1.003)) = 2
const GAP = 2;

const manager = {
    config: {
        incrementPercent: 0.3,
        targetSpreadPercent: 0.6,
    },
};

async function runTests() {
    // Test 1: Normal grid — no bloat
    // 40 active orders at geometric prices → railEstimate = 40 (all at
    // distinct levels from index), maxAllowed = 40 + GAP + 5 = 47
    {
        const orders = [];
        for (let i = 0; i < 20; i++) orders.push(makeOrder('b' + i, ORDER_TYPES.BUY));
        for (let i = 0; i < 20; i++) orders.push(makeOrder('s' + i, ORDER_TYPES.SELL));
        const result = isGridBloated(manager, orders);
        assert.strictEqual(result.bloated, false, 'Normal grid must not be bloated');
        assert.ok(result.details.gridSize === 40, 'gridSize must be 40');
        assert.ok(result.details.placedCount === 40, 'placedCount must be 40');
        assert.ok(result.details.maxAllowed === 40 + GAP + 2, 'maxAllowed must be 40 + gap + MIN_SPREAD_ORDERS(2)');
        console.log('  ✓ Normal grid (40 placed) not bloated');
    }

    // Test 2: Bloated grid — many extra slots beyond price range
    // Same price range (40 geometric levels), but 60 extra VIRTUAL slots
    // with price=1.0 (tightly clustered outside the geometric progression)
    // → actual levels from min/max price = 1 (all extras at 1.0),
    //   railEstimate = max(1, 40) = 40,
    //   maxAllowed = 40 + GAP + 5 = 47,
    //   100 > 47 → bloated
    {
        const orders = [];
        for (let i = 0; i < 20; i++) orders.push(makeOrder('b' + i, ORDER_TYPES.BUY));
        for (let i = 0; i < 20; i++) orders.push(makeOrder('s' + i, ORDER_TYPES.SELL));
        for (let i = 0; i < 60; i++) orders.push(makeOrder('x' + i, ORDER_TYPES.SPREAD, { state: ORDER_STATES.VIRTUAL, orderId: '', size: 0 }));
        const result = isGridBloated(manager, orders);
        assert.strictEqual(result.bloated, true, 'Grid with 60 extra spread slots must be bloated');
        console.log('  ✓ Bloated grid (100 total) detected');
    }

    // Test 3: Normal full-rail grid — many virtual slots, NOT bloated
    // 40 active + 250 virtual = 290 slots spanning 250 geometric levels
    // (price range 1.0 → 1.0 * 1.003^250 ≈ 2.115)
    // railEstimate = 250, maxAllowed = 250 + GAP + 5 = 257
    // 290 > 257 → bloated? That would be a false positive!
    // Actually with incPct=0.3 and 250 virtual slots at distinct geometric
    // prices, the expected total should be ~290. Let's check:
    // Prices range from 1.0 to 1.003^250 ≈ 2.115 → 250 geometric levels
    // from min to max. But the FIRST 40 are the active ones at prices
    // 1.0, 1.003, 1.006, ..., 1.003^39 ≈ 1.124. The remaining 250 are
    // at higher prices 1.003^40 to 1.003^289.
    // So min=1.0, max=1.003^289 ≈ 2.367 → 289 levels → railEstimate=289
    // maxAllowed = 289 + GAP + 5 = 296, 290 < 296 → not bloated ✓
    {
        const orders = [];
        for (let i = 0; i < 20; i++) orders.push(makeOrder('b' + i, ORDER_TYPES.BUY));
        for (let i = 0; i < 20; i++) orders.push(makeOrder('s' + i, ORDER_TYPES.SELL));
        for (let i = 40; i < 290; i++) {
            orders.push({
                id: 'v' + i,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.VIRTUAL,
                orderId: '',
                price: 1.0 * Math.pow(1.003, i),
                size: 5,
            });
        }
        const result = isGridBloated(manager, orders);
        assert.strictEqual(result.bloated, false, 'Full-rail grid with 290 slots must not be bloated');
        assert.ok(result.details.railEstimate > 200, 'railEstimate must reflect the full price range');
        console.log(`  ✓ Full-rail grid (290 slots, railEstimate=${result.details.railEstimate}) not bloated`);
    }

    // Test 4: Empty grid
    {
        const result = isGridBloated(manager, []);
        assert.strictEqual(result.bloated, false, 'Empty grid must not be bloated');
        assert.strictEqual(result.details, undefined, 'Empty grid has no details');
        console.log('  ✓ Empty grid not bloated');
    }

    // Test 5: Map input (runtime path)
    {
        const map = new Map();
        for (let i = 0; i < 10; i++) map.set('b' + i, makeOrder('b' + i, ORDER_TYPES.BUY));
        for (let i = 0; i < 10; i++) map.set('s' + i, makeOrder('s' + i, ORDER_TYPES.SELL));
        const result = isGridBloated(manager, map);
        assert.strictEqual(result.bloated, false, 'Map input must not be bloated');
        assert.ok(result.details.gridSize === 20, 'Map gridSize must be 20');
        console.log('  ✓ Map input handled correctly');
    }

    // Test 6: No config
    {
        const result = isGridBloated({ config: null }, [makeOrder('b0', ORDER_TYPES.BUY)]);
        assert.strictEqual(result.bloated, false, 'No config must not be bloated');
        console.log('  ✓ Missing config handled gracefully');
    }

    // Test 7: Zero placedCount (only VIRTUAL/SPREAD)
    {
        const orders = [
            { id: 'v0', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', price: 1, size: 10 },
            { id: 'x0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, orderId: '', price: 1, size: 0 },
        ];
        const result = isGridBloated(manager, orders);
        assert.strictEqual(result.bloated, false, 'Only virtual/spread must not be bloated');
        console.log('  ✓ Zero placedCount handled correctly');
    }

    // Test 8: Phantom orders (ACTIVE without orderId) must not inflate placedCount
    {
        const orders = [];
        for (let i = 0; i < 20; i++) orders.push(makeOrder('b' + i, ORDER_TYPES.BUY));
        for (let i = 0; i < 20; i++) orders.push(makeOrder('s' + i, ORDER_TYPES.SELL));
        orders.push({ id: 'phantom', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: '', price: 1, size: 10 });
        const result = isGridBloated(manager, orders);
        assert.strictEqual(result.bloated, false, 'Phantom order must not inflate placedCount');
        assert.ok(result.details.placedCount === 40, 'placedCount must exclude phantom');
        console.log('  ✓ Phantom order excluded from placedCount');
    }

    // Test 9: loadGrid stale virtual slot type reassignment
    // A grid with boundary=5 and gapSlots=4 (for 0.3% inc, 1.5% target) should have:
    //   slots 0-5: BUY
    //   slots 6-9: SPREAD
    //   slots 10+: SELL
    // We feed it with stale types and verify loadGrid corrects them.
    {
        const step = 1.003;
        const grid = [
            // Correctly typed BUY
            { id: 'slot-0', type: 'spread', state: 'virtual', price: 1.0, size: 0, orderId: '' },
            { id: 'slot-1', type: 'sell',   state: 'virtual', price: 1.003, size: 0, orderId: '' },
            // Correctly typed BUY (should stay BUY)
            { id: 'slot-2', type: 'buy',    state: 'virtual', price: 1.006, size: 0, orderId: '' },
            // ACTIVE on-chain — type corrected to BUY by position;
            // subsequent sync detects mismatch and cancels/recreates
            { id: 'slot-3', type: 'sell',   state: 'active',  price: 1.009, size: 10, orderId: '1.7.3' },
            // Boundary at 5, gapSlots=4 (for 0.3% inc, 1.5% target)
        // → buyEndIdx=5, sellStartIdx=10
        // slot-0..5 = BUY, slot-6..9 = SPREAD, slot-10.. = SELL
            { id: 'slot-4', type: 'spread', state: 'virtual', price: 1.012, size: 0, orderId: '' },
            { id: 'slot-5', type: 'sell',   state: 'virtual', price: 1.015, size: 0, orderId: '' },
            { id: 'slot-6', type: 'buy',    state: 'virtual', price: 1.018, size: 0, orderId: '' },
            { id: 'slot-7', type: 'sell',   state: 'virtual', price: 1.021, size: 0, orderId: '' },
            { id: 'slot-8', type: 'spread', state: 'virtual', price: 1.024, size: 0, orderId: '' },
            { id: 'slot-9', type: 'buy',    state: 'virtual', price: 1.027, size: 0, orderId: '' },
            { id: 'slot-10', type: 'spread', state: 'virtual', price: 1.030, size: 0, orderId: '' },
        ];
        const mgr: any = {
            config: { incrementPercent: 0.3, targetSpreadPercent: 1.5, gridLimits: {} },
            orders: new Map(),
            boundaryIdx: 5,
            _setBoundary: (i: number) => { mgr.boundaryIdx = i; },
            _restoreBoundary: (i: number) => { mgr.boundaryIdx = i; },
            logger: { log: () => {} },
            _gridLock: { acquire: async (fn: any) => fn() },
            _fundLock: { acquire: async (fn: any) => fn() },
            _initializeAssets: async () => {},
            resetFunds: () => {},
            pauseRecalcLogging: () => {},
            pauseFundRecalc: () => {},
            resumeRecalcLogging: () => {},
            resumeFundRecalc: async () => {},
            _applyOrderUpdate: async (order: any) => { mgr.orders.set(order.id, order); },
            funds: { btsFeesOwed: 0 },
            requestStructuralGridResync: async () => {},
            checkFundDriftAfterFills: () => ({ isValid: true }),
            _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0 },
        };

        const capturedLogs: string[] = [];
        mgr.logger.log = (msg: string) => { capturedLogs.push(msg); };

        await loadGrid(mgr as any, grid, 5);

        // Check that stale types were corrected
        const getType = (id: string) => mgr.orders.get(id)?.type;

        // Slot-0: index 0 ≤ 5 → should be BUY (was SPREAD)
        assert.strictEqual(getType('slot-0'), 'buy', 'slot-0 (index 0) should be BUY');
        // Slot-1: index 1 ≤ 5 → should be BUY (was SELL)
        assert.strictEqual(getType('slot-1'), 'buy', 'slot-1 (index 1) should be BUY');
        // Slot-2: already BUY → should remain BUY
        assert.strictEqual(getType('slot-2'), 'buy', 'slot-2 should remain BUY');
        // Slot-3: ACTIVE on-chain — type corrected to BUY because
        // index 3 is within the BUY zone (boundary=5, gapSlots=4 → buyEndIdx=5).
        // Subsequent sync detects the chain mismatch and cancels/recreates.
        assert.strictEqual(getType('slot-3'), 'buy', 'slot-3 (active on-chain) corrected to BUY');
        // Slot-4: index 4 ≤ 5 → should be BUY (was SPREAD)
        assert.strictEqual(getType('slot-4'), 'buy', 'slot-4 (index 4) should be BUY');
        // Slot-5: index 5 ≤ 5 → should be BUY (was SELL)
        assert.strictEqual(getType('slot-5'), 'buy', 'slot-5 (index 5) should be BUY');
        // Slot-6: index 6 is in gap [6,7] → should be SPREAD (was BUY)
        assert.strictEqual(getType('slot-6'), 'spread', 'slot-6 (index 6) should be SPREAD');
        // Slot-7: index 7 is in gap [6,7] → should be SPREAD (was SELL)
        assert.strictEqual(getType('slot-7'), 'spread', 'slot-7 (index 7) should be SPREAD');
        // Slot-8: index 8 < 10 → in spread zone → should be SPREAD (was SPREAD, stays SPREAD)
        assert.strictEqual(getType('slot-8'), 'spread', 'slot-8 (index 8) should stay SPREAD');
        // Slot-9: index 9 < 10 → in spread zone → should be SPREAD (was BUY)
        assert.strictEqual(getType('slot-9'), 'spread', 'slot-9 (index 9) should be SPREAD');
        // Slot-10: index 10 ≥ 10 → should be SELL (was SPREAD)
        assert.strictEqual(getType('slot-10'), 'sell', 'slot-10 (index 10) should be SELL');

        const reassignLog = capturedLogs.find((l: string) => l.includes('Reassigned'));
        assert.ok(reassignLog, 'loadGrid should log [GRID-LOAD] Reassigned N stale virtual slot type(s)');
        console.log(`  ✓ loadGrid virtual slot type reassignment: ${reassignLog}`);
    }

    console.log('\n✓ Grid bloat tests passed');
}

runTests().catch(err => {
    console.error('Grid bloat tests failed:', getErrorMessage(err));
    process.exit(1);
});
