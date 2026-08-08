/**
 * tests/test_accounting_logic.ts
 *
 * Comprehensive unit tests for accounting.ts - Fund tracking and calculations
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { installChainOrdersStub } = require('./helpers/chain_orders_stub');
const { chainOrders } = installChainOrdersStub();
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES, TIMING } = require('../modules/constants');
const { createSilentLogger } = require('./helpers/silent_logger');
const { getErrorMessage } = require('../modules/utils/errors');

// Mock getAssetFees to prevent crashes during recalculateFunds
const OrderUtils = require('../modules/order/utils/math');
const originalGetAssetFees = OrderUtils.getAssetFees;

OrderUtils.getAssetFees = (asset) => {
    if (asset === 'BTS') {
        return {
            total: 0.011,
            createFee: 0.1,
            updateFee: 0.001,
            makerNetFee: 0.01,
            takerNetFee: 0.1,
            netFee: 0.01,
            isMaker: true
        };
    }
    return 1.0;
};

async function runTests() {
     console.log('Running Accountant Logic Tests...');

     const createManager = async () => {
         const mgr = new OrderManager({
             market: 'TEST/BTS',
             assetA: 'TEST',
             assetB: 'BTS',
             weightDistribution: { sell: 0.5, buy: 0.5 },
             activeOrders: { buy: 5, sell: 5 }
         });
         mgr.logger = createSilentLogger();
         await mgr.setAccountTotals({
             buy: 10000,
             sell: 100,
             buyFree: 10000,
             sellFree: 100
         });
         return mgr;
     };

     // Test: resetFunds()
     console.log(' - Testing resetFunds()...');
     {
         const manager = await createManager();
         await manager.resetFunds();
         assert(manager.funds !== undefined, 'funds should be defined');
         assert.strictEqual(manager.funds.available.buy, 0);
         assert.strictEqual(manager.funds.available.sell, 0);
         assert.strictEqual(manager.funds.committed.chain.buy, 0);
         assert.strictEqual(manager.funds.virtual.buy, 0);
     }

     // Test: recalculateFunds()
     console.log(' - Testing recalculateFunds()...');
     {
         const manager = await createManager();
        await manager._updateOrder({
            id: 'virtual-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.BUY,
            size: 500,
            price: 100
        });
        assert.strictEqual(manager.funds.virtual.buy, 500);

        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            size: 25,
            price: 100,
            orderId: 'chain-001'
        });
        assert.strictEqual(manager.funds.committed.chain.sell, 25);
    }

    // Test: Multiple orders summing
     console.log(' - Testing multiple orders summing...');
     {
         const manager = await createManager();
         manager.pauseFundRecalc();
          await manager._updateOrder({ id: 'b1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
          await manager._updateOrder({ id: 'b2', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 200 });
          await manager._updateOrder({ id: 'b3', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 150, orderId: 'c1' });
          await manager.resumeFundRecalc();

         assert.strictEqual(manager.funds.virtual.buy, 300);
         assert.strictEqual(manager.funds.committed.grid.buy, 150);
         assert.strictEqual(manager.funds.total.grid.buy, 450);
     }

    // Test: Invariant chainTotal = chainFree + chainCommitted
    console.log(' - Testing chainTotal invariant...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'o1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 1000,
            orderId: 'c1'
        });

        const { buy: chainTotal } = manager.funds.total.chain;
        const { buy: chainFree } = manager.accountTotals;
        const { buy: chainCommitted } = manager.funds.committed.chain;

        assert(Math.abs(chainTotal - (chainFree + chainCommitted)) < 0.01, 'Invariant failed: chainTotal != chainFree + chainCommitted');
    }

    // Test: Precision
    console.log(' - Testing precision...');
    {
        const manager = await createManager();
        manager.pauseFundRecalc();
        await manager._updateOrder({ id: 'p1', type: ORDER_TYPES.BUY, size: 123.456789, price: 100, state: ORDER_STATES.VIRTUAL });
        await manager._updateOrder({ id: 'p2', type: ORDER_TYPES.BUY, size: 987.654321, price: 99, state: ORDER_STATES.VIRTUAL });
        await manager.resumeFundRecalc();

        const expected = 123.456789 + 987.654321;
        assert(Math.abs(manager.funds.virtual.buy - expected) < 0.00000001);
    }

    // Test: PARTIAL -> ACTIVE Transition Bug Fix
    console.log(' - Testing PARTIAL -> ACTIVE transition bug fix...');
    {
        const manager = await createManager();
        const oldOrder = {
            id: 'p-fix',
            state: ORDER_STATES.PARTIAL,
            type: ORDER_TYPES.BUY,
            size: 100,
            price: 100
        };
        const newOrder = {
            id: 'p-fix',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 100,
            price: 100,
            orderId: 'c-new'
        };

        const buyFreeBefore = manager.accountTotals.buyFree;
        await manager.accountant.updateOptimisticFreeBalance(oldOrder, newOrder, 'test');
        const buyFreeAfter = manager.accountTotals.buyFree;

        assert.strictEqual(buyFreeBefore - buyFreeAfter, 0, 'Should not deduct again if already PARTIAL');
    }

    // Test: Manual Fund Override Protection (pauseFundRecalcDepth flag)
    console.log(' - Testing manual fund override protection via pauseFundRecalc...');
    {
        const manager = await createManager();
        await manager.resetFunds();

        // Manually override fund values
        const manualAvailable = 5000;
        manager.funds.available.buy = manualAvailable;

        // While paused, add orders that would normally trigger recalculateFunds
        manager.pauseFundRecalc();
        await manager._updateOrder({ id: 'override-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 100 });
        await manager._updateOrder({ id: 'override-2', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY, size: 200 });
        await manager._updateOrder({ id: 'override-3', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY, size: 150, orderId: 'c-override' });

        // Verify manual value is NOT overwritten while paused
        assert.strictEqual(
            manager.funds.available.buy,
            manualAvailable,
            `Manual fund override should be preserved while paused (expected ${manualAvailable}, got ${manager.funds.available.buy})`
        );

        // Resume and verify recalculateFunds NOW applies
        await manager.resumeFundRecalc();
        const expectedVirtual = 300; // 100 + 200
        assert.strictEqual(
            manager.funds.virtual.buy,
            expectedVirtual,
            `After resume, virtual funds should be recalculated (expected ${expectedVirtual}, got ${manager.funds.virtual.buy})`
        );
    }

    // Test: Missing fee cache must not crash fill accounting (fallback to raw proceeds)
    console.log(' - Testing fill accounting fee-cache fallback...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const sellTotalBefore = manager.accountTotals.sell;
        const rawReceives = 2.5;

        try {
            await manager.accountant.processFillAccounting({
                pays: { asset_id: '1.3.1', amount: 100000 },
                receives: { asset_id: '1.3.0', amount: 250000 }
            });
        } catch (err) {
            assert.fail('processFillAccounting should tolerate missing fee cache and continue: ' + getErrorMessage(err));
        }

        assert.strictEqual(manager.accountTotals.sell, sellTotalBefore + rawReceives, 'Sell total should credit raw proceeds when fee lookup fails');
    }

    console.log(' - Testing manager owns processed fill tracker before bot wiring...');
    {
        const manager = await createManager();
        assert.strictEqual(manager.processedFillTracker instanceof Map, true, 'OrderManager should own a shared processed fill tracker by default');
        assert.strictEqual(manager.accountant.manager.processedFillTracker, manager.processedFillTracker, 'Accountant should use the manager-owned processed fill tracker');
    }

    console.log(' - Testing keyed fill accounting deduplicates duplicate credits...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const sellTotalBefore = manager.accountTotals.sell;
        const fillOp = {
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
        };
        const fillKey = '1.7.123:999:1.11.555';

        await manager.accountant.processFillAccounting(fillOp, fillKey);
        await manager.accountant.processFillAccounting(fillOp, fillKey);

        assert.strictEqual(
            manager.accountTotals.sell,
            sellTotalBefore + 2.5,
            'Duplicate keyed fill should only credit proceeds once'
        );
    }

    console.log(' - Testing keyed fill replay stays blocked beyond burst dedupe window...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const sellTotalBefore = manager.accountTotals.sell;
        const fillOp = {
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
        };
        const fillKey = '1.7.123:999:1.11.556';

        await manager.accountant.processFillAccounting(fillOp, fillKey);
        manager.accountant.manager.processedFillTracker.set(fillKey, Date.now() - (TIMING.FILL_DEDUPE_WINDOW_MS + 1000));
        await manager.accountant.processFillAccounting(fillOp, fillKey);

        assert.strictEqual(
            manager.accountTotals.sell,
            sellTotalBefore + 2.5,
            'Replay should stay blocked after the short burst dedupe window expires'
        );
    }

    console.log(' - Testing invalid keyed fill does not block later valid retry...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const sellTotalBefore = manager.accountTotals.sell;
        const retryFillKey = '1.7.124:1000:1.11.556';

        await manager.accountant.processFillAccounting({
            pays: { asset_id: '1.3.1', amount: 100000 }
        }, retryFillKey);

        await manager.accountant.processFillAccounting({
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
        }, retryFillKey);

        assert.strictEqual(
            manager.accountTotals.sell,
            sellTotalBefore + 2.5,
            'A no-op keyed fill attempt must not poison a later valid retry'
        );
    }

    console.log(' - Testing keyed fill retry survives post-validation failure before tracker write...');
    {
        const manager = await createManager();
        manager.assets = {
            assetA: { id: '1.3.0', precision: 5 },
            assetB: { id: '1.3.1', precision: 5 }
        };

        const originalAdjustTotalBalance = manager.accountant.adjustTotalBalance.bind(manager.accountant);
        const sellTotalBefore = manager.accountTotals.sell;
        const retryFillKey = '1.7.125:1001:1.11.557';
        const fillOp = {
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 }
        };

        manager.accountant.adjustTotalBalance = () => {
            throw new Error('forced post-validation failure');
        };

        await assert.rejects(
            manager.accountant.processFillAccounting(fillOp, retryFillKey),
            /forced post-validation failure/,
            'Expected injected failure after fill validation'
        );
        assert.strictEqual(
            manager.accountant.manager.processedFillTracker.has(retryFillKey),
            false,
            'Failed accounting attempt must not poison the fill key'
        );

        manager.accountant.adjustTotalBalance = originalAdjustTotalBalance;
        await manager.accountant.processFillAccounting(fillOp, retryFillKey);

        assert.strictEqual(
            manager.accountTotals.sell,
            sellTotalBefore + 2.5,
            'Retry after post-validation failure should still credit the fill once'
        );
    }

    // Test: Recovery retry cooldown and reset behavior
    console.log(' - Testing recovery retry cooldown and reset...');
    {
        const manager = await createManager();
        const originalRecovery = manager.accountant._performStateRecovery;
        let attempts = 0;

        manager.accountant._performStateRecovery = async () => {
            attempts += 1;
            return { isValid: false, reason: 'forced failure' };
        };

        const first = await manager.accountant._attemptFundRecovery(manager, 'unit-test');
        assert.strictEqual(first, false, 'First forced recovery should fail');
        assert.strictEqual(manager._recoveryState.attemptCount, 1, 'Attempt count should increment after first try');

        const second = await manager.accountant._attemptFundRecovery(manager, 'unit-test');
        assert.strictEqual(second, false, 'Second immediate attempt should be blocked by cooldown');
        assert.strictEqual(manager._recoveryState.attemptCount, 1, 'Cooldown-blocked attempt must not increment attempt count');

        manager._recoveryState = { ...manager._recoveryState, lastAttemptAt: Date.now() - 61000 };
        await manager.accountant._attemptFundRecovery(manager, 'unit-test');
        assert.strictEqual(manager._recoveryState.attemptCount, 2, 'Attempt count should increment after cooldown expires');
        assert.strictEqual(attempts >= 2, true, 'Recovery should have executed at least twice after cooldown expiry');

        manager.accountant._performStateRecovery = async () => ({ isValid: true, reason: null });
        manager._recoveryState = { ...manager._recoveryState, lastAttemptAt: Date.now() - 61000 };
        const success = await manager.accountant._attemptFundRecovery(manager, 'unit-test');
        assert.strictEqual(success, true, 'Successful recovery should return true');
        // NOTE: Successful recovery does NOT reset attempt count immediately.
        // This prevents infinite "attempt 1/5" loops when fund invariants are violated
        // but sync "succeeds" (no errors) without actually fixing the invariant.
        // The counter is reset by:
        // 1. resetRecoveryState() called at start of each periodic fetch cycle
        // 2. Decay logic if enough time passes without violations
        assert.strictEqual(manager._recoveryState.attemptCount, 3, 'Successful recovery should NOT reset attempt count (counter is 3 from previous attempts)');

        manager.accountant._performStateRecovery = originalRecovery;
    }

    // Test: Recovery sync must not re-apply optimistic accounting deltas
    console.log(' - Testing recovery sync uses skipAccounting=true...');
    {
        const manager = await createManager();
        manager.accountId = '1.2.345';

        const originalFetchTotals = manager.fetchAccountTotals;
        const originalSyncFromOpenOrders = manager.syncFromOpenOrders;
        const chainOrders = require('../modules/chain_orders');
        const originalRead = chainOrders.readOpenOrders;
        const originalReadMeta = chainOrders.readOpenOrdersWithMeta;
        const stubOrders = [{ id: '1.7.1', sell_price: { base: { amount: 100, asset_id: '1.3.0' }, quote: { amount: 100, asset_id: '1.3.121' } }, for_sale: 100, expiration: '2099-01-01T00:00:00' }];
        chainOrders.readOpenOrders = async () => stubOrders;
        chainOrders.readOpenOrdersWithMeta = async () => ({ orders: stubOrders, truncated: false });

        let capturedSyncOptions = null;
        manager.fetchAccountTotals = async () => { };
        manager.syncFromOpenOrders = async (_orders, options) => {
            capturedSyncOptions = options;
            return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
        };

        try {
            const result = await manager.accountant._performStateRecovery(manager);
            assert.strictEqual(typeof result.isValid, 'boolean', 'Recovery should return validation result');
            assert.strictEqual(capturedSyncOptions?.skipAccounting, true,
                'Recovery sync must use skipAccounting=true to avoid double-counting');
        } finally {
            manager.fetchAccountTotals = originalFetchTotals;
            manager.syncFromOpenOrders = originalSyncFromOpenOrders;
            chainOrders.readOpenOrders = originalRead;
            chainOrders.readOpenOrdersWithMeta = originalReadMeta;
        }
    }

    console.log(' - Testing recovery skips sync on empty/truncated read...');
    {
        const manager = await createManager();
        manager.accountId = '1.2.345';

        const originalFetchTotals = manager.fetchAccountTotals;
        const originalSyncFromOpenOrders = manager.syncFromOpenOrders;
        const chainOrders = require('../modules/chain_orders');
        const originalRead = chainOrders.readOpenOrders;
        const originalReadMeta = chainOrders.readOpenOrdersWithMeta;
        chainOrders.readOpenOrders = async () => [];
        chainOrders.readOpenOrdersWithMeta = async () => ({ orders: [], truncated: false });

        let syncCalled = false;
        manager.fetchAccountTotals = async () => { };
        manager.syncFromOpenOrders = async () => { syncCalled = true; };

        try {
            const result = await manager.accountant._performStateRecovery(manager);
            assert.strictEqual(syncCalled, false,
                'Empty read is ambiguous — recovery sync must be skipped (node may be lagging; pass-1 phantom cleanup would virtualize live slots)');
            assert.strictEqual(result.isValid, false, 'Skipped recovery must report an invalid/deferred validation result');
        } finally {
            manager.fetchAccountTotals = originalFetchTotals;
            manager.syncFromOpenOrders = originalSyncFromOpenOrders;
            chainOrders.readOpenOrders = originalRead;
            chainOrders.readOpenOrdersWithMeta = originalReadMeta;
        }
    }


    // Restore original
    OrderUtils.getAssetFees = originalGetAssetFees;

    console.log('✓ Accountant logic tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
