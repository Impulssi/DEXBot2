const assert = require('assert');

const MaintenanceRuntime = require('../modules/dexbot_maintenance_runtime');
const chainOrders = require('../modules/chain_orders');
const grid = require('../modules/order/grid');
const { ORDER_STATES, ORDER_TYPES } = require('../modules/constants');

async function runTests() {
    console.log('Running Targeted Drift Reconcile Tests...');

    const originalReadOpenOrders = chainOrders.readOpenOrders;
    const originalMonitorDivergence = grid.monitorDivergence;

    try {
        console.log(' - Testing active-order shortfall triggers open-order sync...');

        let readOpenOrdersCalls = 0;
        let synchronized = false;
        const orders = new Map();

        chainOrders.readOpenOrders = async (accountId) => {
            readOpenOrdersCalls++;
            assert.strictEqual(accountId, '1.2.345', 'targeted sync should read orders for the bot account');
            return [{ id: '1.7.9001' }];
        };
        grid.monitorDivergence = async () => ({
            needsUpdate: false,
            buy: { ratio: false, rms: false, metric: 0 },
            sell: { ratio: false, rms: false, metric: 0 },
        });

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
                loadGrid: () => [],
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
                const syncResult = await this.manager.synchronizeWithChain(openOrders, 'readOpenOrders');
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
    } finally {
        chainOrders.readOpenOrders = originalReadOpenOrders;
        grid.monitorDivergence = originalMonitorDivergence;
    }
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
