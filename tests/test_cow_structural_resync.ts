const assert = require('assert');

const DEXBot = require('../modules/dexbot_class');
const { OrderManager } = require('../modules/order/manager');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

function createOrder(id, overrides = {}) {
    return {
        id,
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        price: 1.1,
        size: 10,
        orderId: '1.7.999',
        ...overrides
    };
}

function waitForResync(maxMs = 200) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            if (Date.now() - start >= maxMs) return resolve(undefined);
            setImmediate(tick);
        };
        setImmediate(tick);
    });
}

async function runTests() {
    console.log('Running COW Structural Resync Wiring Tests...');

    console.log(' - COW guard aborts CREATE batch and triggers actual requestGridReset via structural resync wiring...');
    {
        const bot = new DEXBot({
            botKey: 'test_cow_structural_resync',
            dryRun: false,
            startPrice: 1,
            assetA: 'BTS',
            assetB: 'USD',
            incrementPercent: 0.5
        });

        const masterOrders = new Map([
            ['slot-new', createOrder('slot-new', {
                state: ORDER_STATES.VIRTUAL,
                orderId: ''
            })]
        ]);

        const manager = {
            assets: {
                assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
            },
            orders: masterOrders,
            logger: { log: () => {}, logFundsStatus: () => {} },
            lockOrders: () => {},
            unlockOrders: () => {},
            _setRebalanceState: () => {},
            startBroadcasting: () => {},
            stopBroadcasting: () => {},
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            _commitWorkingGrid: async () => {},
            persistGrid: async () => {},
            _clearWorkingGridRef: () => {},
            _recoveryState: {
                attemptCount: 3,
                lastAttemptAt: 12345,
                lastFailureAt: 67890,
                structuralResyncRequested: false
            }
        };

        bot.manager = manager;
        bot.account = 'test-account';
        bot.privateKey = 'test-private-key';
        bot._validateOperationFunds = () => ({ isValid: true, summary: 'ok', violations: [] });
        bot._processBatchResults = async () => ({ executed: true, hadRotation: false, updateOperationCount: 0 });

        const requestGridResetCalls = [];
        bot.requestGridReset = async (reason, options) => {
            requestGridResetCalls.push({ reason, options });
            return { success: true };
        };

        let executeCalls = 0;
        bot._executeOperationsWithStrategy = async () => {
            executeCalls += 1;
            return {
                result: { success: true, operation_results: [[1, '1.7.12345']] },
                opContexts: []
            };
        };

        bot._wireStructuralGridResyncRequest();

        // Monkeypatch chainOrders.cancelOrder to avoid real blockchain calls.
        // The auto-cancel path in _updateOrdersOnChainBatchCOW attempts to cancel
        // unmatched chain orders before blocking the CREATE batch. The test
        // verifies the guard path, so we make cancelOrder throw to simulate a
        // failed cancellation attempt.
        const chainOrdersModule = require('../modules/chain_orders');
        const originalCancelOrder = chainOrdersModule.cancelOrder;
        chainOrdersModule.cancelOrder = async () => {
            throw new Error('Simulated cancel failure for test');
        };

        try {
            (manager as any)._lastUnmatchedChainOrders = [{
            chainOrderId: '1.7.572303058',
            type: ORDER_TYPES.SELL,
            price: 1.101,
            size: 10
        }];

        const workingGrid = new WorkingGrid(manager.orders, { baseVersion: 1 });
        const result = await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{
                type: COW_ACTIONS.CREATE,
                id: 'slot-new',
                order: {
                    id: 'slot-new',
                    type: ORDER_TYPES.SELL,
                    price: 1.1,
                    size: 10,
                    state: ORDER_STATES.VIRTUAL,
                    orderId: ''
                }
            }]
        });

        assert.strictEqual(result.executed, false, 'Batch must be aborted');
        assert.strictEqual(result.aborted, true, 'Batch must be marked aborted');
        assert.strictEqual(result.reason, 'UNMATCHED_CHAIN_ORDERS', 'Abort reason must be UNMATCHED_CHAIN_ORDERS');
        assert.strictEqual(executeCalls, 0, 'No broadcast may have been attempted');

        assert.strictEqual(
            manager._recoveryState.structuralResyncRequested,
            true,
            'COW guard must set the structural resync latch so other paths see a resync is in progress'
        );

        await waitForResync(300);

        assert.strictEqual(
            requestGridResetCalls.length,
            1,
            'Structural resync callback must call requestGridReset exactly once'
        );
        assert.strictEqual(
            requestGridResetCalls[0].reason,
            'rms_structural_grid_resync',
            'Reset must be triggered with the structural resync reason code'
        );
        assert.strictEqual(
            requestGridResetCalls[0].options && requestGridResetCalls[0].options.refreshCenterPrice,
            true,
            'Reset must include refreshCenterPrice:true to re-anchor against current market'
        );

        assert.strictEqual(manager._recoveryState.attemptCount, 0, 'Recovery attempt count must be reset after structural resync');
        assert.strictEqual(manager._recoveryState.lastAttemptAt, 0, 'Recovery lastAttemptAt must be reset after structural resync');
        assert.strictEqual(manager._recoveryState.lastFailureAt, 0, 'Recovery lastFailureAt must be reset after structural resync');
        assert.strictEqual(
            manager._recoveryState.structuralResyncRequested,
            false,
            'Structural resync latch must be cleared in finally block'
        );

        console.log('\u2713 COW-STRUCTURAL-RESYNC-001 passed');
        } finally {
            chainOrdersModule.cancelOrder = originalCancelOrder;
        }
    }

    console.log(' - Duplicate structural resync schedule is deduped (timer + in-flight)...');
    {
        const bot = new DEXBot({
            botKey: 'test_cow_structural_resync_dedup',
            dryRun: false,
            startPrice: 1,
            assetA: 'BTS',
            assetB: 'USD',
            incrementPercent: 0.5
        });

        const manager = {
            assets: {
                assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
            },
            orders: new Map(),
            logger: { log: () => {}, logFundsStatus: () => {} },
            lockOrders: () => {},
            unlockOrders: () => {},
            _setRebalanceState: () => {},
            startBroadcasting: () => {},
            stopBroadcasting: () => {},
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            _commitWorkingGrid: async () => {},
            persistGrid: async () => {},
            _clearWorkingGridRef: () => {},
            _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false }
        };

        bot.manager = manager;
        bot.account = 'test-account';
        bot.privateKey = 'test-private-key';
        bot._validateOperationFunds = () => ({ isValid: true, summary: 'ok', violations: [] });
        bot._processBatchResults = async () => ({ executed: true, hadRotation: false, updateOperationCount: 0 });

        const requestGridResetCalls = [];
        bot.requestGridReset = async (reason) => {
            requestGridResetCalls.push(reason);
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { success: true };
        };

        bot._executeOperationsWithStrategy = async () => ({
            result: { success: true, operation_results: [] },
            opContexts: []
        });

        bot._wireStructuralGridResyncRequest();

        const unmatched = [{ chainOrderId: '1.7.572303058', type: ORDER_TYPES.SELL, price: 1.1, size: 10 }];
        const first = await (manager as any).requestStructuralGridResync('first trigger', { unmatchedChainOrders: unmatched });
        const second = await (manager as any).requestStructuralGridResync('second trigger', { unmatchedChainOrders: unmatched });

        assert.strictEqual(first.scheduled, true, 'First call should report scheduled');
        assert.strictEqual(second.skipped, true, 'Second call should be deduped (skipped)');
        assert.strictEqual(second.reason, 'structural grid resync already scheduled', 'Dedup reason should reference existing schedule');

        await waitForResync(300);

        assert.strictEqual(
            requestGridResetCalls.length,
            1,
            'Deduped calls must not produce additional requestGridReset invocations'
        );

        const third = await (manager as any).requestStructuralGridResync('after completion', { unmatchedChainOrders: unmatched });
        assert.strictEqual(third.scheduled, true, 'After completion a fresh schedule should be accepted');

        await waitForResync(300);

        assert.strictEqual(
            requestGridResetCalls.length,
            2,
            'A new schedule after completion must trigger another requestGridReset'
        );

        console.log('\u2713 COW-STRUCTURAL-RESYNC-002 passed');
    }

    console.log(' - Shutdown clears pending structural resync timer without invoking requestGridReset...');
    {
        const bot = new DEXBot({
            botKey: 'test_cow_structural_resync_shutdown',
            dryRun: false,
            startPrice: 1,
            assetA: 'BTS',
            assetB: 'USD',
            incrementPercent: 0.5
        });

        const manager = {
            assets: {
                assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
            },
            orders: new Map(),
            logger: { log: () => {}, logFundsStatus: () => {} },
            lockOrders: () => {},
            unlockOrders: () => {},
            _setRebalanceState: () => {},
            startBroadcasting: () => {},
            stopBroadcasting: () => {},
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            _commitWorkingGrid: async () => {},
            persistGrid: async () => {},
            _clearWorkingGridRef: () => {},
            _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false }
        };

        bot.manager = manager;
        bot.account = 'test-account';
        bot.privateKey = 'test-private-key';
        bot._shutdownImpl = async function () {
            this._shuttingDown = true;
            if (this._structuralGridResyncTimer) {
                clearTimeout(this._structuralGridResyncTimer);
                this._structuralGridResyncTimer = null;
            }
        };

        const requestGridResetCalls = [];
        bot.requestGridReset = async () => {
            requestGridResetCalls.push(true);
            return { success: true };
        };

        bot._wireStructuralGridResyncRequest();

        const scheduleResult = await (manager as any).requestStructuralGridResync('shutdown test trigger', {});
        assert.strictEqual(scheduleResult.scheduled, true, 'Schedule should be accepted before shutdown');

        await bot.shutdown();

        await waitForResync(200);

        assert.strictEqual(
            requestGridResetCalls.length,
            0,
            'Shutdown must clear pending structural resync timer and prevent requestGridReset'
        );

        const afterShutdown = await (manager as any).requestStructuralGridResync('after shutdown', {});
        assert.strictEqual(afterShutdown.skipped, true, 'Schedule after shutdown must be skipped');
        assert.strictEqual(afterShutdown.reason, 'shutting down', 'Skip reason must mention shutdown');

        console.log('\u2713 COW-STRUCTURAL-RESYNC-003 passed');
    }

    console.log('\u2713 COW structural resync wiring tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('\u2717 COW structural resync wiring tests failed');
    console.error(err);
    process.exit(1);
});
