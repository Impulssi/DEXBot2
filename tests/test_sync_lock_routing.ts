const assert = require('assert');

const { OrderManager } = require('../modules/order/manager');

function createManagerFixture() {
    const manager = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });

    manager.logger = {
        log: () => {},
        marketName: 'TEST/USD',
        logFundsStatus: () => {}
    };

    manager.accountant = {
        updateOptimisticFreeBalance: async () => {},
        recalculateFunds: async () => {},
        tryDeductFromChainFree: async () => ({ ok: true }),
        addToChainFree: async () => true
    };

    manager.assets = {
        assetA: { symbol: 'BTS', id: '1.3.0', precision: 5 },
        assetB: { symbol: 'USD', id: '1.3.121', precision: 4 }
    };

    return manager;
}

async function testReadOpenOrdersNoDeadlock() {
    console.log('\n[SYNC-LOCK-001] readOpenOrders sync does not deadlock...');
    const manager = createManagerFixture();

    const timeoutMs = 1500;
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    const result = await Promise.race([
        manager.synchronizeWithChain([], 'readOpenOrders'),
        timeoutPromise
    ]);

    assert.ok(result && typeof result === 'object', 'sync should resolve with result object');
    console.log('  PASS');
}

async function testSourceBasedLockRouting() {
    console.log('\n[SYNC-LOCK-002] manager.synchronizeWithChain delegates lock acquisition to sync_engine...');
    const manager = createManagerFixture();

    let lockAcquireCalls = 0;
    manager._gridLock = {
        acquire: async (callback) => {
            lockAcquireCalls += 1;
            return await callback();
        }
    };

    manager.sync.synchronizeWithChain = async (_data, src) => ({ src });

    // The manager wrapper no longer acquires _gridLock; the sync_engine does it for
    // createOrder/cancelOrder inline, and syncFromOpenOrders does it for
    // readOpenOrders/periodicBlockchainFetch. The wrapper is a plain delegator.
    await manager.synchronizeWithChain({ any: 1 }, 'createOrder');
    assert.strictEqual(lockAcquireCalls, 0, 'manager wrapper should not acquire _gridLock for createOrder');

    lockAcquireCalls = 0;
    await manager.synchronizeWithChain([], 'readOpenOrders');
    assert.strictEqual(lockAcquireCalls, 0, 'manager wrapper should not acquire _gridLock for readOpenOrders');

    lockAcquireCalls = 0;
    await manager.synchronizeWithChain([], 'periodicBlockchainFetch');
    assert.strictEqual(lockAcquireCalls, 0, 'manager wrapper should not acquire _gridLock for periodicBlockchainFetch');

    lockAcquireCalls = 0;
    await manager.synchronizeWithChain({ any: 1 }, 'customSource');
    assert.strictEqual(lockAcquireCalls, 0, 'manager wrapper should not acquire _gridLock for unknown sources');

    console.log('  PASS');
}

async function testSyncEngineCreateOrderAcquiresGridLock() {
    console.log('\n[SYNC-LOCK-004] sync_engine.synchronizeWithChain(createOrder) acquires _gridLock...');
    const manager = createManagerFixture();

    let lockAcquireCalls = 0;
    const realSyncFromOpenOrders = manager.sync.syncFromOpenOrders;
    manager._gridLock = {
        acquire: async (callback) => {
            lockAcquireCalls += 1;
            return await callback();
        }
    };

    // Provide a real gridOrder with a pre-existing orderId for the rotation path to skip.
    manager.orders.set('grid-1', {
        id: 'grid-1', type: 'BUY', state: 'VIRTUAL', price: 1, size: 10, orderId: '',
    });

    await manager.sync.synchronizeWithChain({
        gridOrderId: 'grid-1',
        chainOrderId: '1.7.99',
        isPartialPlacement: false,
        expectedType: 'BUY',
        fee: 0,
    }, 'createOrder');

    assert.strictEqual(lockAcquireCalls, 1, 'createOrder case should acquire _gridLock inside sync_engine');

    console.log('  PASS');
}

async function testSyncEngineCancelOrderAcquiresGridLock() {
    console.log('\n[SYNC-LOCK-005] sync_engine.synchronizeWithChain(cancelOrder) acquires _gridLock...');
    const manager = createManagerFixture();

    let lockAcquireCalls = 0;
    manager._gridLock = {
        acquire: async (callback) => {
            lockAcquireCalls += 1;
            return await callback();
        }
    };
    manager.accountant = {
        ...manager.accountant,
        adjustTotalBalance: async () => {},
    };

    // No matching grid order -> fall through to the unmatched-cancel-fee path,
    // which is inside the critical section we want to lock.
    await manager.sync.synchronizeWithChain({ orderId: '1.7.99' }, 'cancelOrder');

    assert.strictEqual(lockAcquireCalls, 1, 'cancelOrder case should acquire _gridLock inside sync_engine');

    console.log('  PASS');
}

async function testOpenOrdersSyncUsesFillLockContract() {
    console.log('\n[SYNC-LOCK-003] syncFromOpenOrders acquires fill lock (re-entrant safe)...');
    const manager = createManagerFixture();

    let fillLockAcquireCalls = 0;
    let insideLock = false;
    const realFillLock = manager._fillProcessingLock;
    manager._fillProcessingLock = {
        acquire: async (callback) => {
            if (insideLock) return callback();
            insideLock = true;
            fillLockAcquireCalls += 1;
            try {
                return await callback();
            } finally {
                insideLock = false;
            }
        },
        isLocked: () => realFillLock.isLocked(),
        isReentrant: () => insideLock,
        getQueueLength: () => realFillLock.getQueueLength(),
    };

    await manager.syncFromOpenOrders([]);
    assert.strictEqual(fillLockAcquireCalls, 1, 'direct open-orders sync should acquire _fillProcessingLock');

    // Second call (lock no longer held) acquires again — expected.
    await manager.syncFromOpenOrders([]);
    assert.strictEqual(fillLockAcquireCalls, 2, 'second call acquires again (lock was released)');

    // Third call: re-entrant path — call syncFromOpenOrders from inside the lock.
    // The mock sets insideLock before running the callback, so the nested
    // syncFromOpenOrders sees isReentrant() === true and skips re-acquisition.
    fillLockAcquireCalls = 0;
    insideLock = false;
    await manager._fillProcessingLock.acquire(async () => {
        await manager.syncFromOpenOrders([]);
    });
    assert.strictEqual(fillLockAcquireCalls, 1, 'nested syncFromOpenOrders must use re-entrant path (no re-acquire)');

    console.log('  PASS');
}

async function run() {
    console.log('Running sync lock routing regression tests...');
    await testReadOpenOrdersNoDeadlock();
    await testSourceBasedLockRouting();
    await testOpenOrdersSyncUsesFillLockContract();
    await testSyncEngineCreateOrderAcquiresGridLock();
    await testSyncEngineCancelOrderAcquiresGridLock();
    console.log('\nAll sync lock routing regression tests passed');
}

run().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
