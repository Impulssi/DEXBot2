const assert = require('assert');

const MaintenanceRuntime = require('../modules/dexbot_maintenance_runtime');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');

async function runTests() {
    console.log('Running Targeted Drift Reconcile Tests...');

    // Compiled ESM namespaces are frozen and require.cache injection cannot
    // intercept static ESM imports, so chainOrders/grid overrides are gone.
    // The readOpenOrders mock lives on a local plain object — the production
    // flow reaches it via ctx._syncOpenOrdersAndProcessFills (test-owned), and
    // monitorDivergence runs REAL against a persisted grid seeded to match the
    // live grid (loadGrid returns the same slots) so it computes no divergence.
    const chainOrders = {
        readOpenOrders: async (accountId) => {
            readOpenOrdersCalls++;
            assert.strictEqual(accountId, '1.2.345', 'targeted sync should read orders for the bot account');
            return [{ id: '1.7.9001' }];
        },
    };

    console.log(' - Testing active-order shortfall triggers open-order sync...');

    let readOpenOrdersCalls = 0;
    let synchronized = false;
    const orders = new Map();

        const ctx = {
            accountId: '1.2.345',
            account: { id: '1.2.345' },
            privateKey: 'test-key',
            config: {
                botKey: 'targeted-drift-test',
                dryRun: false,
                activeOrders: { buy: 1, sell: 0 },
                assetA: 'TEST',
                assetB: 'BTS',
            },
            manager: {
                orders,
                fetchAccountTotals: async () => {},
                recalculateFunds: async () => {},
                _clearStaleBroadcastFlag: () => {},
                clearStalePipelineOperations: () => {},
                isPipelineEmpty: () => ({ isEmpty: true, reasons: [] }),
                checkFundDriftAfterFills: () => ({ isValid: true, reason: 'ok' }),
                getOrdersByTypeAndState: (type, state) => {
                    return Array.from(orders.values()).filter(o => o && o.type === type && o.state === state);
                },
                synchronizeWithChain: async () => {
                    synchronized = true;
                    orders.set('slot-1', {
                        id: 'slot-1',
                        type: ORDER_TYPES.BUY,
                        state: ORDER_STATES.ACTIVE,
                        orderId: '1.7.9001',
                        price: 1,
                        size: 10,
                    });
                    return { filledOrders: [], unmatchedChainOrders: [] };
                },
                persistGrid: async () => ({ isValid: true }),
                checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
                checkSpreadCondition: async () => ({ ordersPlaced: 0 }),
            },
            accountOrders: {
                // Persisted grid mirrors the live grid so the REAL
                // monitorDivergence/compareGrids computes zero divergence.
                loadGrid: () => Array.from(orders.values()),
            },
            _targetedDriftSyncCooldownMs: 60_000,
            _lastTargetedDriftSyncAt: 0,
            _incomingFillQueue: [],
            _batchInFlight: 1,
            _lightweightSyncCheckAt: Date.now(),
            _recoverySyncInFlight: 0,
            _dustSinceMap: new Map(),
            _getPipelineSignals: () => ({
                incomingFillQueueLength: 0,
                shadowLocks: 0,
                batchInFlight: false,
                recoveryInFlight: false,
                broadcasting: false,
            }),
            _processFillsWithBatching: async () => ({ aborted: false }),
            _syncOpenOrdersAndProcessFills: async function (_tag) {
                const openOrders = await chainOrders.readOpenOrders(this.accountId);
                const syncResult = await (this.manager.synchronizeWithChain as any)(openOrders, 'readOpenOrders');
                return { syncResult, aborted: false, hasUnmatched: 0 };
            },
            _executeBatchIfNeeded: async () => ({ executed: false }),
            updateOrdersOnChainPlan: async () => ({ executed: false }),
            updateOrdersOnChainBatch: async () => ({ executed: false }),
            _cancelDustOrders: async () => ({ cancelledCount: 0, batchResult: null }),
            _abortFlowIfIllegalState: async () => false,
            _persistAndRecoverIfNeeded: async () => {},
            _log: () => {},
            _warn: () => {},
        };

        await MaintenanceRuntime.executeMaintenanceLogic(ctx, 'targeted-test');

        assert.strictEqual(readOpenOrdersCalls, 1, 'shortfall should trigger one open-order fetch');
        assert.strictEqual(synchronized, true, 'shortfall should synchronize from chain truth');
        assert.strictEqual(orders.get('slot-1').orderId, '1.7.9001', 'sync should restore the live order into the grid');

    console.log('✓ Targeted drift reconcile tests passed!');
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
