const assert = require('assert');
const DEXBot = require('../modules/dexbot_class');

class MockAsyncLock {
    acquireCalled = false;
    async acquire(fn) {
        this.acquireCalled = true;
        return await fn();
    }
    isLocked() { return false; }
    getQueueLength() { return 0; }
}

async function test() {
    console.log('Running Dust Health Check Timer Lock Acquisition Test...');

    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    let capturedCallback = null;

    global.setInterval = ((fn: any): any => {
        capturedCallback = fn;
        return { timer: 'mock-dust-health' };
    }) as any;
    global.clearInterval = () => {};

    const lock = new MockAsyncLock();

    const bot = new DEXBot({
        botKey: 'test_dust_health_lock',
        dryRun: false,
        startPrice: 1,
        assetA: 'TESTA',
        assetB: 'TESTB',
        incrementPercent: 0.5,
        weightDistribution: { sell: 0.5, buy: 0.5 },
    });

    let cancelCalled = false;
    bot.updateOrdersOnChainPlan = async () => {};
    bot.manager = {
        _fillProcessingLock: lock,
        checkGridHealth: async () => ({
            buyDustOrders: [],
            sellDustOrders: [{ orderId: '1.7.1', id: 'dust-sell-1', size: 0.001, price: 1.0 }],
        }),
        logger: { log: () => {} },
    };
    bot._cancelDustOrders = async ({ buy, sell, fillLockAlreadyHeld }) => {
        assert.strictEqual(fillLockAlreadyHeld, true, 'Should pass fillLockAlreadyHeld=true inside the lock');
        assert.strictEqual(sell.length, 1, 'Should pass detected dust orders');
        cancelCalled = true;
        return { cancelledCount: 1, batchResult: { aborted: false } };
    };

    bot._setupDustHealthCheckInterval();

    assert.strictEqual(typeof capturedCallback, 'function', 'Interval callback should be registered');

    await capturedCallback();

    assert.strictEqual(lock.acquireCalled, true, '_fillProcessingLock.acquire should be called when dust is detected');
    assert.strictEqual(cancelCalled, true, '_cancelDustOrders should be called when dust is detected');

    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    console.log('✓ Dust health check timer acquires _fillProcessingLock when dust is present');
}

test()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('✗ Dust health check timer test failed');
        console.error(err);
        process.exit(1);
    });
