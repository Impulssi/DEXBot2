/**
 * tests/test_resync_invariants.ts
 * 
 * Verifies that the isBootstrapping flag correctly suppresses fund invariant warnings
 * during transient states like grid resync.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const chainOrders = require('../modules/chain_orders');

const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 30000);
const testTimeoutHandle = setTimeout(() => {
    console.error(`✗ Resync invariant tests timed out after ${TEST_TIMEOUT_MS}ms`);
    process.exit(1);
}, TEST_TIMEOUT_MS);
if (typeof testTimeoutHandle.unref === 'function') testTimeoutHandle.unref();

async function runTests() {
    console.log('Running Resync Invariant Tests...');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS',
            activeOrders: { buy: 5, sell: 5 }
        });
        await mgr.setAccountTotals({
            buy: 10000,
            sell: 100,
            buyFree: 10000,
            sellFree: 100
        });
        return mgr;
    };

    // Test 1: Invariant check runs when NOT bootstrapping
    console.log(' - Case 1: Invariant check runs when NOT bootstrapping...');
    {
        const manager = await createManager();
        manager.finishBootstrap(); // Set isBootstrapping = false

        let invariantChecked = false;
        manager.accountant._verifyFundInvariants = async () => {
            invariantChecked = true;
        };

        // Trigger a change that calls recalculateFunds
        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            orderId: 'c1'
        });

        assert.strictEqual(invariantChecked, true, 'Invariant check should have run');
    }

    // Test 2: Invariant check is suppressed when bootstrapping
    console.log(' - Case 2: Invariant check is suppressed when bootstrapping...');
    {
        const manager = await createManager();
        manager.startBootstrap(); // Set isBootstrapping = true

        let invariantChecked = false;
        manager.accountant._verifyFundInvariants = async () => {
            invariantChecked = true;
        };

        // Trigger a change that calls recalculateFunds
        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            orderId: 'c1'
        });

        assert.strictEqual(invariantChecked, false, 'Invariant check should be suppressed during bootstrap');
    }

    // Test 3: Resync simulation
    console.log(' - Case 3: Resync simulation (start -> clear -> finish)...');
    {
        const manager = await createManager();
        let invariantCallsDuringBootstrap = 0;
        let invariantCallsAfterBootstrap = 0;

        // Mock _verifyFundInvariants to count calls based on bootstrap state
        manager.accountant._verifyFundInvariants = async () => {
            if (manager.isBootstrapping()) {
                invariantCallsDuringBootstrap++;
            } else {
                invariantCallsAfterBootstrap++;
            }
        };

        // 1. Normal state - bootstrap already started in constructor; finish it
        manager.finishBootstrap();
        // _verifyFundInvariants should not be called during recalculateFunds while not bootstrapping
        // but the mock counting is what we care about during/after

        // 2. Start resync (bootstrap again)
        manager.startBootstrap();

        // 3. Recalculate during resync - invariant check should be suppressed
        await manager.recalculateFunds();
        assert.strictEqual(invariantCallsDuringBootstrap, 0, 'Invariant check should be suppressed during resync bootstrap');

        // 4. Finish resync (invariant check should resume)
        manager.finishBootstrap();
        await manager.recalculateFunds();

        assert(invariantCallsAfterBootstrap > 0, 'Invariant check should run now that bootstrap is finished');
    }

    // Test 4: Recovery validation must not be masked by bootstrap suppression
    console.log(' - Case 4: Recovery validation detects drift while bootstrapping...');
    {
        const manager = await createManager();
        manager.startBootstrap();
        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'TEST', precision: 5 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
        };
        await manager.setAccountTotals({
            buy: 10000,
            sell: 100,
            buyFree: 5000,
            sellFree: 100
        });
        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            orderId: '1.7.1'
        });

        manager.accountId = '1.2.test';
        manager.fetchAccountTotals = async () => {};
        manager.syncFromOpenOrders = async () => ({ filledOrders: [], updatedOrders: [] });
        // A NON-EMPTY, NON-TRUNCATED read is authoritative, so the recovery
        // sync runs and the drift check fires. (An empty/truncated read now
        // defers the sync — it is ambiguous, and syncFromOpenOrders on it
        // would let pass-1 phantom cleanup virtualize live ACTIVE slots.)
        const originalReadOpenOrders = chainOrders.readOpenOrders;
        const originalReadOpenOrdersMeta = chainOrders.readOpenOrdersWithMeta;
        const stubOrders = [{ id: '1.7.1', sell_price: { base: { amount: 100, asset_id: '1.3.0' }, quote: { amount: 100, asset_id: '1.3.1' } }, for_sale: 100, expiration: '2099-01-01T00:00:00' }];
        chainOrders.readOpenOrders = async () => stubOrders;
        chainOrders.readOpenOrdersWithMeta = async () => ({ orders: stubOrders, truncated: false });

        let validation;
        try {
            validation = await manager.accountant._performStateRecovery(manager);
        } finally {
            chainOrders.readOpenOrders = originalReadOpenOrders;
            chainOrders.readOpenOrdersWithMeta = originalReadOpenOrdersMeta;
        }

        assert.strictEqual(validation.isValid, false, 'Recovery validation should detect drift even during bootstrap');
        assert.match(validation.reason, /BUY drift/, 'Recovery validation should report buy drift');
    }

    // Test 5: Authoritative open-order sync must not double-deduct fetched free balances
    console.log(' - Case 5: Authoritative sync preserves fetched free balances...');
    {
        const manager = new OrderManager({
            market: 'TEST/BTS',
            assetA: 'TEST',
            assetB: 'BTS',
            activeOrders: { buy: 1, sell: 0 }
        });
        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'TEST', precision: 5 },
            assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
        };
        await manager.setAccountTotals({
            buy: 1000,
            sell: 0,
            buyFree: 900,
            sellFree: 0
        });

        await manager._updateOrder({
            id: 'buy-slot',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.BUY,
            price: 10,
            size: 100,
            orderId: ''
        }, 'seed', { skipAccounting: true });

        await manager.synchronizeWithChain([{
            id: '1.7.buy',
            for_sale: 10000000,
            sell_price: {
                base: { amount: 10000000, asset_id: '1.3.0' },
                quote: { amount: 1000000, asset_id: '1.3.1' }
            }
        }], 'periodicBlockchainFetch');

        assert.strictEqual(manager.accountTotals.buyFree, 900, 'authoritative sync should not deduct already-locked funds from fetched buyFree');
        const drift = manager.checkFundDriftAfterFills();
        assert.strictEqual(drift.isValid, true, `authoritative sync should remain drift-free: ${drift.reason}`);
    }

    console.log('✓ Resync invariant tests passed!');
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
}).finally(() => {
    clearTimeout(testTimeoutHandle);
});
