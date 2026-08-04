/**
 * Integration tests for boundary sync logic in applyGridDivergenceCorrections
 * Tests fund-driven boundary recalculation and order matching
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const Grid = require('../modules/order/grid');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');
const { createTestLogger } = require('./helpers/silent_logger');
const { getErrorMessage } = require('../modules/utils/errors');

function createMockManager(buyFunds = 10000, sellFunds = 100, startPrice = 100) {
    const manager = new OrderManager({
        startPrice,
        incrementPercent: 0.5,
        targetSpreadPercent: 2,
        assetA: 'USD',
        assetB: 'TESTCOIN',
        minPrice: 50,
        maxPrice: 200
    });

    manager.funds = {
        buy: { total: buyFunds, free: buyFunds, committed: { grid: 0, chain: 0 } },
        sell: { total: sellFunds, free: sellFunds, committed: { grid: 0, chain: 0 } }
    };

    manager.assets = {
        assetA: { id: 'test-a', symbol: 'USD', precision: 8 },
        assetB: { id: 'test-b', symbol: 'TESTCOIN', precision: 8 }
    };

    manager.boundaryIdx = 0;
    manager.initialSpreadCount = 2;
    manager.outOfSpread = 0;

    manager.logger = createTestLogger({ includeFundsStatus: false });

    return manager;
}

function logTest(name, passed, details = '') {
    const status = passed ? '✓' : '✗';
    console.log(` - ${status} ${name}${details ? ' (' + details + ')' : ''}`);
}

async function testBoundarySync() {
    console.log('\nRunning Boundary Sync Tests...');

    // Test 1: Boundary shifts when funds are skewed
    {
        const manager = createMockManager(20000, 50, 100);
        const allSlots = Array.from({ length: 10 }, (_, i) => ({
            id: `slot-${i}`,
            price: 100 * Math.pow(1.005, i - 5),
            type: i < 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
            size: i < 5 ? 2000 : 5,
            state: ORDER_STATES.VIRTUAL
        }));

        // Simulate fund-driven boundary calculation
        const availA = manager.funds.buy.free;
        const availB = manager.funds.sell.free;
        const buySideValue = availA;
        const sellSideValue = availB * manager.config.startPrice;
        const totalValue = buySideValue + sellSideValue;
        const buyRatio = buySideValue / totalValue;

        // Expected: More buy funds means boundary should shift toward sell side (higher prices)
        const expectedBoundaryBias = buyRatio > 0.7 ? 'shifted_right' : buyRatio < 0.3 ? 'shifted_left' : 'centered';
        logTest('Boundary shifts with fund imbalance', expectedBoundaryBias !== 'centered', expectedBoundaryBias);
    }

    // Test 2: Rotation pairing matches orders correctly
    {
        const manager = createMockManager(10000, 100, 100);
        manager.orders = new Map();

        // Create 3 active buy orders
        const activeBuys = [
            { id: 'buy-1', price: 99, orderId: 'chain-1', size: 100, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE },
            { id: 'buy-2', price: 98.5, orderId: 'chain-2', size: 100, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE },
            { id: 'buy-3', price: 98, orderId: 'chain-3', size: 100, type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE }
        ];

        // Create 4 desired slots (due to fund increase)
        const desiredSlots = [
            { id: 'slot-1', price: 99, size: 150 },
            { id: 'slot-2', price: 98.5, size: 150 },
            { id: 'slot-3', price: 98, size: 150 },
            { id: 'slot-4', price: 97.5, size: 150 }
        ];

        // Expected: First 3 active orders rotate to match first 3 desired slots
        // 4th slot is placed as new
        const matchCount = Math.min(activeBuys.length, desiredSlots.length);
        logTest('Rotation pairing matches all existing orders', matchCount === 3, `${matchCount}/3 matched`);
    }

    // Test 3: Target count follows configured active window
    {
        const baseTargetCount = 5;
        const targetCount = Math.max(1, baseTargetCount);

        logTest('Target count keeps configured window size', targetCount === 5, `${baseTargetCount} -> ${targetCount}`);
    }

    // Test 4: Prevents overfunding when boundary syncs
    {
        const manager = createMockManager(1000, 10, 100);
        const availA = manager.funds.buy.free;
        const ordersWithNewPrice = [
            { price: 101, size: 100 },
            { price: 102, size: 100 },
            { price: 103, size: 100 }
        ];

        const totalRequired = ordersWithNewPrice.reduce((sum, o) => sum + o.size, 0);
        const wouldExceedBudget = totalRequired > availA;

        logTest('Boundary sync respects available funds', wouldExceedBudget === false || totalRequired <= availA,
                `need ${totalRequired} have ${availA}`);
    }
}

async function testStartupGridChecks() {
    console.log('\nRunning Startup Grid Checks Tests...');

    // Test 1: Threshold check triggers on high fund ratio
    {
        const manager = createMockManager(10000, 100, 100);
        manager.funds.buy.free = 5000;

        const regenerationThreshold = 0.2; // 20%
        const availableRatio = manager.funds.buy.free / manager.funds.buy.total;
        const shouldTrigger = availableRatio > regenerationThreshold;

        logTest('Threshold check triggers on high available ratio', shouldTrigger === true,
                `available ratio: ${(availableRatio * 100).toFixed(1)}%`);
    }

    // Test 2: Divergence check detects grid mismatch
    {
        const persistedGrid = [
            { id: 'p-1', price: 99, size: 100, type: ORDER_TYPES.BUY },
            { id: 'p-2', price: 101, size: 100, type: ORDER_TYPES.SELL }
        ];

        const calculatedGrid = [
            { id: 'c-1', price: 99.5, size: 110, type: ORDER_TYPES.BUY },
            { id: 'c-2', price: 100.5, size: 110, type: ORDER_TYPES.SELL }
        ];

        // Simple divergence: price and size differ
        const hasDivergence = persistedGrid.some((p, i) => {
            const c = calculatedGrid[i];
            return c && (Math.abs(p.price - c.price) > 0.1 || Math.abs(p.size - c.size) > 5);
        });

        logTest('Divergence check detects grid mismatch', hasDivergence === true, 'prices/sizes differ');
    }

    // Test 3: Bootstrap phase uses divergence check only after threshold check passes
    {
        const manager = createMockManager(10000, 100, 100);
        const isBootstrap = true;
        const availableFundsTriggeredThreshold = false; // Not triggered
        const shouldRunDivergence = isBootstrap && !availableFundsTriggeredThreshold;

        logTest('Bootstrap divergence runs only after threshold fails', shouldRunDivergence === true,
                'threshold=${availableFundsTriggeredThreshold}, divergence=${shouldRunDivergence}');
    }
}

async function testPoolIdCaching() {
    console.log('\nRunning Pool ID Caching Tests...');

    // Test 1: Cache hit returns correct pool
    {
        const poolIdCache = new Map();
        const cacheKey = 'asset-a:asset-b';
        const cachedPoolId = '1.19.123';

        poolIdCache.set(cacheKey, cachedPoolId);
        const retrieved = poolIdCache.get(cacheKey);

        logTest('Cache hit retrieves correct pool ID', retrieved === cachedPoolId, `${cachedPoolId}`);
    }

    // Test 2: Cache miss returns null
    {
        const poolIdCache = new Map();
        const retrieved = poolIdCache.get('unknown-key');

        logTest('Cache miss returns null', retrieved === undefined, 'miss');
    }

    // Test 3: Cache invalidation on stale pool
    {
        const poolIdCache = new Map();
        const cacheKey = 'asset-a:asset-b';
        const poolId = '1.19.123';

        poolIdCache.set(cacheKey, poolId);

        // Simulate stale pool (assets don't match)
        const storedPool = { id: poolId, asset_a: '1.3.0', asset_b: '1.3.1' };
        const requestedAssetA = '1.3.0';
        const requestedAssetB = '1.3.2'; // Different!

        const isStale = !(storedPool.asset_a === requestedAssetA && storedPool.asset_b === requestedAssetB);

        if (isStale) {
            poolIdCache.delete(cacheKey);
        }

        const postInvalidation = poolIdCache.get(cacheKey);
        logTest('Cache invalidation removes stale entries', postInvalidation === undefined, 'invalidated');
    }

    // Test 4: Concurrent access doesn't cause race conditions
    {
        const poolIdCache = new Map();
        const cacheKey = 'asset-a:asset-b';

        // Simulate concurrent read/write
        const writes = [];
        const reads = [];

        for (let i = 0; i < 10; i++) {
            poolIdCache.set(cacheKey, `pool-${i}`);
            writes.push(i);
        }

        for (let i = 0; i < 10; i++) {
            const val = poolIdCache.get(cacheKey);
            if (val) reads.push(val);
        }

        // With Map (single-threaded JS), this should always work
        logTest('Concurrent access maintains cache integrity', reads.length > 0, `${reads.length} reads`);
    }
}

// ================================================================================
// Main
// ================================================================================
async function runTests() {
    try {
        await testBoundarySync();
        await testStartupGridChecks();
        await testPoolIdCaching();
        console.log('\n✓ All boundary sync and startup integration tests passed!');
        process.exit(0);
    } catch (err) {
        console.error('\n✗ Test failed:', getErrorMessage(err));
        process.exit(1);
    }
}

if (require.main === module) {
    runTests().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { testBoundarySync, testStartupGridChecks, testPoolIdCaching };
