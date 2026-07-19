const assert = require('assert');
const { isGridBloated } = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function makeOrder(id, type, overrides = {}) {
    return {
        id,
        type,
        state: ORDER_STATES.ACTIVE,
        orderId: '1.7.' + id,
        price: 1.0,
        size: 10,
        ...overrides,
    };
}

const manager = {
    config: {
        incrementPercent: 0.3,
        targetSpreadPercent: 0.6,
    },
};

async function runTests() {
    // Test 1: Normal grid — no bloat
    {
        const orders = [];
        for (let i = 0; i < 20; i++) orders.push(makeOrder('b' + i, ORDER_TYPES.BUY));
        for (let i = 0; i < 20; i++) orders.push(makeOrder('s' + i, ORDER_TYPES.SELL));
        const result = isGridBloated(manager, orders);
        assert.strictEqual(result.bloated, false, 'Normal grid must not be bloated');
        assert.ok(result.details.gridSize === 40, 'gridSize must be 40');
        assert.ok(result.details.placedCount === 40, 'placedCount must be 40');
        assert.ok(result.details.maxAllowed === 43, 'maxAllowed must be 40 + 2 gap + 1 = 43');
        console.log('  ✓ Normal grid (40 placed) not bloated');
    }

    // Test 2: Bloated grid — many spread slots
    {
        const orders = [];
        for (let i = 0; i < 20; i++) orders.push(makeOrder('b' + i, ORDER_TYPES.BUY));
        for (let i = 0; i < 20; i++) orders.push(makeOrder('s' + i, ORDER_TYPES.SELL));
        for (let i = 0; i < 60; i++) orders.push(makeOrder('x' + i, ORDER_TYPES.SPREAD, { state: ORDER_STATES.VIRTUAL, orderId: '', size: 0 }));
        const result = isGridBloated(manager, orders);
        assert.strictEqual(result.bloated, true, 'Grid with 60 extra spread slots must be bloated');
        console.log('  ✓ Bloated grid (100 total) detected');
    }

    // Test 3: Empty grid
    {
        const result = isGridBloated(manager, []);
        assert.strictEqual(result.bloated, false, 'Empty grid must not be bloated');
        assert.strictEqual(result.details, undefined, 'Empty grid has no details');
        console.log('  ✓ Empty grid not bloated');
    }

    // Test 4: Map input (runtime path)
    {
        const map = new Map();
        for (let i = 0; i < 10; i++) map.set('b' + i, makeOrder('b' + i, ORDER_TYPES.BUY));
        for (let i = 0; i < 10; i++) map.set('s' + i, makeOrder('s' + i, ORDER_TYPES.SELL));
        const result = isGridBloated(manager, map);
        assert.strictEqual(result.bloated, false, 'Map input must not be bloated');
        assert.ok(result.details.gridSize === 20, 'Map gridSize must be 20');
        console.log('  ✓ Map input handled correctly');
    }

    // Test 5: No config
    {
        const result = isGridBloated({ config: null }, [makeOrder('b0', ORDER_TYPES.BUY)]);
        assert.strictEqual(result.bloated, false, 'No config must not be bloated');
        console.log('  ✓ Missing config handled gracefully');
    }

    // Test 6: Zero placedCount (only VIRTUAL/SPREAD)
    {
        const orders = [
            { id: 'v0', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, orderId: '', price: 1, size: 10 },
            { id: 'x0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, orderId: '', price: 1, size: 0 },
        ];
        const result = isGridBloated(manager, orders);
        assert.strictEqual(result.bloated, false, 'Only virtual/spread must not be bloated');
        console.log('  ✓ Zero placedCount handled correctly');
    }

    // Test 7: Phantom orders (ACTIVE without orderId) must not inflate placedCount
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

    console.log('\n✓ Grid bloat tests passed');
}

runTests().catch(err => {
    console.error('Grid bloat tests failed:', err.message);
    process.exit(1);
});
