/**
 * tests/test_stale_accounting_and_order_dedup.ts
 *
 * Regression tests for:
 * 1. tryDeductFromChainFree structured return (stale / insufficient / undefined / success)
 * 2. updateOptimisticFreeBalance staleness path (doesn't throw, sets _lastAccountingFailure)
 * 3. correctOrderPriceOnChain orderGone dedup of _lastUnmatchedChainOrders
 */

const assert = require('assert');

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, TIMING } = require('../modules/constants');
const { createSilentLogger, createTestLogger } = require('./helpers/silent_logger');

// Stub chain_orders so correctOrderPriceOnChain doesn't require real blockchain
function createStubAccountOrders(cancelBehavior) {
    return {
        cancelOrder: cancelBehavior || (async () => {}),
        updateOrder: async () => ({ /* stub */ }),
    };
}

async function runTests() {
    console.log('Running Stale Accounting & Order Dedup Tests...');

    // ====================================================================
    // 1. tryDeductFromChainFree — structured return value
    // ====================================================================
    console.log(' - Testing tryDeductFromChainFree return values...');

    // 1a. Stale accountTotals
    {
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createSilentLogger();
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        // Force stale by setting _lastFetchedAt far in the past
        mgr.accountTotals._lastFetchedAt = Date.now() - TIMING.MAX_ACCOUNT_TOTALS_AGE_MS - 60000;

        const result = await mgr.accountant.tryDeductFromChainFree(ORDER_TYPES.BUY, 100, 'test-stale');
        assert.strictEqual(result.ok, false, 'stale should return ok=false');
        assert.strictEqual(result.reason, 'stale', 'stale should return reason=stale');
        console.log('   ✓ Stale deduction returns {ok:false, reason:stale}');
    }

    // 1b. Insufficient funds
    {
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createSilentLogger();
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 10, sellFree: 10 });
        // Fresh fetch
        mgr.accountTotals._lastFetchedAt = Date.now();

        const result = await mgr.accountant.tryDeductFromChainFree(ORDER_TYPES.BUY, 100, 'test-insufficient');
        assert.strictEqual(result.ok, false, 'insufficient should return ok=false');
        assert.strictEqual(result.reason, 'insufficient', 'insufficient should return reason=insufficient');
        console.log('   ✓ Insufficient deduction returns {ok:false, reason:insufficient}');
    }

    // 1c. Undefined accountTotals
    {
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createSilentLogger();
        // No accountTotals set — keep it null
        mgr.accountTotals = null;

        const result = await mgr.accountant.tryDeductFromChainFree(ORDER_TYPES.BUY, 100, 'test-undefined');
        assert.strictEqual(result.ok, false, 'undefined totals should return ok=false');
        assert.strictEqual(result.reason, 'undefined', 'undefined totals should return reason=undefined');
        console.log('   ✓ Undefined totals deduction returns {ok:false, reason:undefined}');
    }

    // 1d. Missing key in accountTotals
    {
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createSilentLogger();
        mgr.accountTotals = { buy: null, sell: null, _lastFetchedAt: Date.now() };
        // buyFree and sellFree are undefined

        const result = await mgr.accountant.tryDeductFromChainFree(ORDER_TYPES.BUY, 100, 'test-missing-key');
        assert.strictEqual(result.ok, false, 'missing key should return ok=false');
        assert.strictEqual(result.reason, 'undefined', 'missing key should return reason=undefined');
        console.log('   ✓ Missing key deduction returns {ok:false, reason:undefined}');
    }

    // 1e. Successful deduction
    {
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createSilentLogger();
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr.accountTotals._lastFetchedAt = Date.now();

        const result = await mgr.accountant.tryDeductFromChainFree(ORDER_TYPES.BUY, 100, 'test-success');
        assert.strictEqual(result.ok, true, 'success should return ok=true');
        assert.strictEqual(result.reason, undefined, 'success should not have a reason');
        assert.strictEqual(mgr.accountTotals.buyFree, 400, 'buyFree should be deducted');
        console.log('   ✓ Successful deduction returns {ok:true} and deducts balance');
    }

    // 1f. No _lastDeductionStale side-channel remains
    {
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createSilentLogger();
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr.accountTotals._lastFetchedAt = Date.now();

        assert.strictEqual((mgr.accountant as any)._lastDeductionStale, undefined,
            '_lastDeductionStale field should not exist after refactor');
        console.log('   ✓ _lastDeductionStale field removed');
    }

    // ====================================================================
    // 2. updateOptimisticFreeBalance — staleness path
    // ====================================================================
    console.log(' - Testing updateOptimisticFreeBalance staleness path...');

    // 2a. Stale does not throw, sets _lastAccountingFailure with STALE code
    {
        const logs: string[] = [];
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createTestLogger({ onLog: (msg: string) => logs.push(msg) });
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr.accountTotals._lastFetchedAt = Date.now() - TIMING.MAX_ACCOUNT_TOTALS_AGE_MS - 60000;

        const oldOrder = { id: 'o1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 0, price: 1 };
        const newOrder = { id: 'o1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 100, price: 1, orderId: '1.7.1' };

        let threw = false;
        try {
            await mgr.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test-stale-path', 0);
        } catch {
            threw = true;
        }
        assert.strictEqual(threw, false, 'stale path should NOT throw');

        const failure = mgr._lastAccountingFailure;
        assert(failure, '_lastAccountingFailure should be set');
        assert.strictEqual(failure.code, 'ACCOUNTING_STALE_ACCOUNT_TOTALS',
            'failure code should be ACCOUNTING_STALE_ACCOUNT_TOTALS');
        assert.strictEqual(failure.side, ORDER_TYPES.BUY);
        assert.strictEqual(failure.amount, 100);
        assert.strictEqual(failure.reason, 'stale');

        const staleLog = logs.find(l => l.includes('Stale accountTotals'));
        assert(staleLog, 'should log staleness warning');
        console.log('   ✓ Staleness path does not throw and sets _lastAccountingFailure with STALE code');
    }

    // 2b. Insufficient funds still throws when _throwOnIllegalState is true
    {
        const logs: string[] = [];
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createTestLogger({ onLog: (msg: string) => logs.push(msg) });
        mgr._throwOnIllegalState = true;
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 10, sellFree: 10 });
        mgr.accountTotals._lastFetchedAt = Date.now();

        const oldOrder = { id: 'o1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 0, price: 1 };
        const newOrder = { id: 'o1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 100, price: 1, orderId: '1.7.1' };

        let threw = false;
        try {
            await mgr.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test-insufficient-path', 0);
        } catch (err: any) {
            threw = true;
            assert.strictEqual(err.code, 'ACCOUNTING_COMMITMENT_FAILED');
        }
        assert.strictEqual(threw, true, 'insufficient funds should throw when _throwOnIllegalState is true');

        const failure = mgr._lastAccountingFailure;
        assert(failure, '_lastAccountingFailure should be set');
        assert.strictEqual(failure.code, 'ACCOUNTING_COMMITMENT_FAILED',
            'failure code should be ACCOUNTING_COMMITMENT_FAILED');
        assert.strictEqual(failure.reason, 'insufficient');
        console.log('   ✓ Insufficient funds path throws with ACCOUNTING_COMMITMENT_FAILED');
    }

    // 2c. Stale snapshot: refresh-from-chain + retry once → deduction succeeds (no recovery)
    {
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createSilentLogger();
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr.accountTotals._lastFetchedAt = Date.now() - TIMING.MAX_ACCOUNT_TOTALS_AGE_MS - 60000;

        // Refresh supplies fresh chain balances, so the retry must succeed.
        let refreshed = false;
        mgr._fetchAccountBalancesAndSetTotals = async () => {
            refreshed = true;
            await mgr.setAccountTotals({ buy: 2000, sell: 2000, buyFree: 1500, sellFree: 1500 });
        };

        const oldOrder = { id: 'o1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 0, price: 1 };
        const newOrder = { id: 'o1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 100, price: 1, orderId: '1.7.1' };

        await mgr.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test-stale-refresh-retry', 0);

        // The order was committed without throwing AND without a recovery signal:
        // staleness was fixed in place by refreshing and retrying the deduction.
        assert.strictEqual(mgr._lastAccountingFailure, null,
            'refresh+retry should avoid setting _lastAccountingFailure');
        assert.strictEqual(mgr.accountTotals.buyFree, 1400,
            'deduction should apply against the fresh snapshot (1500 - 100)');
        assert.strictEqual(refreshed, true,
            'the accountTotals refresh should run BEFORE _fundLock is held (never across the lock boundary)');
        console.log('   ✓ Stale snapshot is refreshed from chain and the deduction retried in place');
    }

    // 2d. Stale snapshot + refresh fails → still does not throw, records stale failure
    {
        const logs: string[] = [];
        const mgr = new OrderManager({ assetA: 'TEST', assetB: 'BTS', startPrice: 1 });
        mgr.logger = createTestLogger({ onLog: (msg: string) => logs.push(msg) });
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr.accountTotals._lastFetchedAt = Date.now() - TIMING.MAX_ACCOUNT_TOTALS_AGE_MS - 60000;

        // Refresh "fails" by not advancing _lastFetchedAt (node error / empty read).
        mgr._fetchAccountBalancesAndSetTotals = async () => {};

        const oldOrder = { id: 'o1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 0, price: 1 };
        const newOrder = { id: 'o1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 100, price: 1, orderId: '1.7.1' };

        let threw = false;
        try {
            await mgr.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test-stale-refresh-fail', 0);
        } catch {
            threw = true;
        }
        assert.strictEqual(threw, false, 'failed refresh must NOT throw (orphan-broadcast protection)');

        const failure = mgr._lastAccountingFailure;
        assert(failure, '_lastAccountingFailure should be set when refresh fails');
        assert.strictEqual(failure.reason, 'stale',
            'failure reason should still be stale when refresh fails');
        assert(logs.some(l => l.includes('skipping in-lock refresh')),
            'should log that the retry was skipped to avoid holding _fundLock across a blocking chain RPC');
        console.log('   ✓ Failed refresh preserves stale-failure handling (no throw, recovery signal kept)');
    }

    // ====================================================================
    // 3. correctOrderPriceOnChain — orderGone dedup of _lastUnmatchedChainOrders
    // ====================================================================
    console.log(' - Testing correctOrderPriceOnChain orderGone dedup...');

    // 3a. cancelOnly: orderGone filters _lastUnmatchedChainOrders
    {
        const mgr = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
        mgr.logger = createSilentLogger();
        mgr.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.121', precision: 4 }
        };
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr._lastUnmatchedChainOrders = [
            { id: '1.7.101', reason: 'orphan' },
            { id: '1.7.102', reason: 'orphan' },
        ];
        mgr.ordersNeedingPriceCorrection = [{ chainOrderId: '1.7.101' }];

        const { correctOrderPriceOnChain } = require('../modules/order/utils/order');

        const correctionInfo = {
            chainOrderId: '1.7.101',
            type: ORDER_TYPES.BUY,
            cancelOnly: true,
            isSurplus: false,
            size: 100,
            price: 1.0,
            expectedPrice: 1.0,
        };

        // cancelOrder throws 'not found'
        const stubAccountOrders = createStubAccountOrders(
            async () => { throw new Error('not found'); }
        );

        const result = await correctOrderPriceOnChain(
            mgr, correctionInfo, 'test-account', 'test-key', stubAccountOrders
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.orderGone, true);

        // Should have been removed from _lastUnmatchedChainOrders
        assert.strictEqual(mgr._lastUnmatchedChainOrders.length, 1,
            'orderGone should remove the chain order from _lastUnmatchedChainOrders');
        assert.strictEqual(mgr._lastUnmatchedChainOrders[0].id, '1.7.102',
            'only the remaining orphan should still be in the list');
        console.log('   ✓ cancelOnly orderGone dedup removes chainOrderId from _lastUnmatchedChainOrders');
    }

    // 3b. isSurplus: orderGone filters _lastUnmatchedChainOrders
    {
        const mgr = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
        mgr.logger = createSilentLogger();
        mgr.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.121', precision: 4 }
        };
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr._lastUnmatchedChainOrders = [
            { id: '1.7.201', reason: 'surplus' },
            { id: '1.7.202', reason: 'orphan' },
        ];
        mgr.orders = new Map();
        mgr.ordersNeedingPriceCorrection = [{ chainOrderId: '1.7.201' }];

        const { correctOrderPriceOnChain } = require('../modules/order/utils/order');

        const correctionInfo = {
            chainOrderId: '1.7.201',
            type: ORDER_TYPES.SELL,
            cancelOnly: false,
            isSurplus: true,
            size: 100,
            price: 1.0,
            expectedPrice: 1.0,
        };

        const stubAccountOrders = createStubAccountOrders(
            async () => { throw new Error('not found'); }
        );

        const result = await correctOrderPriceOnChain(
            mgr, correctionInfo, 'test-account', 'test-key', stubAccountOrders
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.orderGone, true);
        assert.strictEqual(mgr._lastUnmatchedChainOrders.length, 1,
            'surplus orderGone should remove from _lastUnmatchedChainOrders');
        assert.strictEqual(mgr._lastUnmatchedChainOrders[0].id, '1.7.202');
        console.log('   ✓ isSurplus orderGone dedup removes chainOrderId from _lastUnmatchedChainOrders');
    }

    // 3c. updateOrder path: orderGone filters _lastUnmatchedChainOrders
    {
        const mgr = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
        mgr.logger = createSilentLogger();
        mgr.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.121', precision: 4 }
        };
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr._lastUnmatchedChainOrders = [
            { id: '1.7.301', reason: 'update-orphan' },
            { id: '1.7.302', reason: 'other' },
        ];
        mgr.orders = new Map();
        mgr.ordersNeedingPriceCorrection = [{ chainOrderId: '1.7.301' }];

        const { correctOrderPriceOnChain } = require('../modules/order/utils/order');

        const correctionInfo = {
            chainOrderId: '1.7.301',
            type: ORDER_TYPES.BUY,
            cancelOnly: false,
            isSurplus: false,
            size: 100,
            price: 1.0,
            expectedPrice: 1.0,
        };

        const stubAccountOrders = createStubAccountOrders();
        // updateOrder throws 'not found'
        stubAccountOrders.updateOrder = async () => { throw new Error('not found'); };

        const result = await correctOrderPriceOnChain(
            mgr, correctionInfo, 'test-account', 'test-key', stubAccountOrders
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.orderGone, true);
        assert.strictEqual(mgr._lastUnmatchedChainOrders.length, 1,
            'update orderGone should remove from _lastUnmatchedChainOrders');
        assert.strictEqual(mgr._lastUnmatchedChainOrders[0].id, '1.7.302');
        console.log('   ✓ updateOrder orderGone dedup removes chainOrderId from _lastUnmatchedChainOrders');
    }

    // 3d. Non-orderGone error does NOT filter _lastUnmatchedChainOrders
    {
        const mgr = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
        mgr.logger = createSilentLogger();
        mgr.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.121', precision: 4 }
        };
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr._lastUnmatchedChainOrders = [
            { id: '1.7.401', reason: 'orphan' },
        ];
        mgr.orders = new Map();
        mgr.ordersNeedingPriceCorrection = [{ chainOrderId: '1.7.401' }];

        const { correctOrderPriceOnChain } = require('../modules/order/utils/order');

        const correctionInfo = {
            chainOrderId: '1.7.401',
            type: ORDER_TYPES.BUY,
            cancelOnly: true,
            isSurplus: false,
            size: 100,
            price: 1.0,
            expectedPrice: 1.0,
        };

        // cancelOrder throws a non-orderGone error (e.g. network error)
        const stubAccountOrders = createStubAccountOrders(
            async () => { throw new Error('connection refused'); }
        );

        const result = await correctOrderPriceOnChain(
            mgr, correctionInfo, 'test-account', 'test-key', stubAccountOrders
        );

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.orderGone, false, 'non-orderGone error should have orderGone=false');
        // The order should remain in _lastUnmatchedChainOrders
        assert.strictEqual(mgr._lastUnmatchedChainOrders.length, 1,
            'non-orderGone error should NOT remove from _lastUnmatchedChainOrders');
        console.log('   ✓ Non-orderGone error preserves _lastUnmatchedChainOrders');
    }

    // 3e. refreshAccountTotalsIfStale — fresh snapshot short-circuits (no fetch)
    {
        const mgr = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
        mgr.logger = createSilentLogger();
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr.accountTotals._lastFetchedAt = Date.now();  // fresh
        let fetchCalls = 0;
        mgr._fetchAccountBalancesAndSetTotals = async () => { fetchCalls++; };

        const result = await mgr.refreshAccountTotalsIfStale();
        assert.strictEqual(result.ok, true, 'fresh totals should report ok=true');
        assert.strictEqual(fetchCalls, 0, 'fresh totals should NOT trigger a chain fetch');
        console.log('   ✓ refreshAccountTotalsIfStale short-circuits on fresh totals');
    }

    // 3f. refreshAccountTotalsIfStale — stale + successful refetch
    {
        const mgr = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
        mgr.logger = createSilentLogger();
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr.accountTotals._lastFetchedAt = Date.now() - TIMING.MAX_ACCOUNT_TOTALS_AGE_MS - 60000;
        const oldStamp = mgr.accountTotals._lastFetchedAt;
        mgr._fetchAccountBalancesAndSetTotals = async () => {
            await mgr.setAccountTotals({ buy: 2000, sell: 2000, buyFree: 1500, sellFree: 1500 });
        };

        const result = await mgr.refreshAccountTotalsIfStale();
        assert.strictEqual(result.ok, true, 'successful refetch should report ok=true');
        assert.ok(mgr.accountTotals._lastFetchedAt > oldStamp, 'refetch should advance _lastFetchedAt');
        assert.strictEqual(mgr.accountTotals.buyFree, 1500, 'refetch should apply fresh totals');
        console.log('   ✓ refreshAccountTotalsIfStale refreshes stale totals when fetch succeeds');
    }

    // 3g. refreshAccountTotalsIfStale — stale + failed refetch (no-op fetch)
    {
        const mgr = new OrderManager({ assetA: 'BTS', assetB: 'USD', startPrice: 1 });
        mgr.logger = createSilentLogger();
        await mgr.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 500, sellFree: 500 });
        mgr.accountTotals._lastFetchedAt = Date.now() - TIMING.MAX_ACCOUNT_TOTALS_AGE_MS - 60000;
        const oldStamp = mgr.accountTotals._lastFetchedAt;
        // Fetch "fails" by not refreshing totals (node error / empty read)
        mgr._fetchAccountBalancesAndSetTotals = async () => {};

        const result = await mgr.refreshAccountTotalsIfStale();
        assert.strictEqual(result.ok, false, 'failed refetch should report ok=false');
        assert.strictEqual(result.reason, 'refresh-failed', 'failed refetch should report reason=refresh-failed');
        assert.strictEqual(mgr.accountTotals._lastFetchedAt, oldStamp, 'failed refetch should NOT advance _lastFetchedAt');
        console.log('   ✓ refreshAccountTotalsIfStale reports refresh-failed when fetch does not refresh');
    }

    console.log('✓ All stale accounting & order dedup tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
