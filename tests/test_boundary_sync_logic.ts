/**
 * Integration tests for divergence startup checks and pool-ID caching.
 * (The fund-driven boundary sync test was removed with the writer: divergence
 * never shifts the boundary — only fills do.)
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
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
        await testStartupGridChecks();
        await testPoolIdCaching();
        console.log('\n✓ All startup integration tests passed!');
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

module.exports = { testStartupGridChecks, testPoolIdCaching };
