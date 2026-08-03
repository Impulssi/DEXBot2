const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setCachedModule } = require('./helpers/module_cache_stub');
// Stub bitshares_client so requiring chain_orders/dexbot_class does not open
// real WebSocket connections to the chain (the sockets kept the process alive
// ~1-2s of flaky connect/backoff time). All chain interaction here is mocked.
setCachedModule(
    path.resolve(__dirname, '../modules/bitshares_client.ts'),
    {
        BitShares: {},
        waitForConnected: async () => {},
        setSuppressConnectionLog() {},
    }
);
const chainOrders = require('../modules/chain_orders');
const maintenanceRuntime = require('../modules/dexbot_maintenance_runtime');
const DEXBot = require('../modules/dexbot_class');
const { withDynamicWeightFiles } = require('./helpers/dynamic_weight_files');

class MockAsyncLock {
    [key: string]: any;
    constructor() {
        this.locked = false;
    }

    async acquire(fn) {
        this.locked = true;
        try {
            return await fn();
        } finally {
            this.locked = false;
        }
    }

    isLocked() {
        return this.locked;
    }

    getQueueLength() {
        return 0;
    }
}

async function runTests() {
    console.log('Running Periodic Sync Fill Rebalance Test...');

    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalReadOpenOrders = chainOrders.readOpenOrders;
    const originalReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    const originalSyncMarketAdapterOnPeriodicConfigCheck = maintenanceRuntime.syncMarketAdapterOnPeriodicConfigCheck;
    const originalExistsSync = fs.existsSync;
    const originalReadFileSync = fs.readFileSync;

    let capturedCallback = null;

    global.setInterval = ((fn: any): any => {
        capturedCallback = fn;
        return { timer: 'mock-periodic' };
    }) as any;
    global.clearInterval = () => { };
    fs.existsSync = (filePath) => {
        if (String(filePath).endsWith('/profiles/bots.json')) {
            return true;
        }
        return originalExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        if (String(filePath).endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'test_periodic_sync_fill_rebalance',
                        active: true,
                        gridPrice: 'book',
                        assetA: 'XRP',
                        assetB: 'BTS',
                    },
                ],
            });
        }
        return originalReadFileSync(filePath, encoding);
    };
    maintenanceRuntime.syncMarketAdapterOnPeriodicConfigCheck = async () => ({
        changed: false,
        required: false,
        running: false,
        started: false,
        stopped: false,
        mode: 'test',
    });
    const weightFiles = withDynamicWeightFiles('test_periodic_sync_fill_rebalance');

    try {
        let fetchCalls = 0;
        let syncCalls = 0;
        let processCalls = 0;
        let batchCalls = 0;
        let persistCalls = 0;
        let maintenanceCalls = 0;
        weightFiles.writeSnapshot({
            isReady: true,
            effectiveWeights: { sell: 0.41, buy: 0.21 },
        });

        const bot = new DEXBot({
            botKey: 'test_periodic_sync_fill_rebalance',
            dryRun: false,
            startPrice: 1,
            assetA: 'XRP',
            assetB: 'BTS',
            incrementPercent: 0.5,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        });

        bot.accountId = '1.2.999';

        const syntheticFilledOrder = {
            id: 'slot-174',
            orderId: '1.7.777777',
            type: 'sell',
            state: 'partial',
            size: 0.0001,
            price: 1357.58,
            isPartial: false
        };

        bot.manager = {
            _fillProcessingLock: new MockAsyncLock(),
            _recoveryAttempted: true,
            logger: { log: () => {} },
            pauseFundRecalc() {},
            resumeFundRecalc() {},
            fetchAccountTotals: async () => {
                fetchCalls++;
            },
            synchronizeWithChain: async () => {
                syncCalls++;
                return { filledOrders: [syntheticFilledOrder], unmatchedChainOrders: [] };
            },
            processFilledOrders: async (filledOrders) => {
                processCalls++;
                assert.strictEqual(filledOrders.length, 1, 'Expected one periodic sync-detected fill');
                assert.strictEqual(filledOrders[0].orderId, '1.7.777777', 'Expected periodic detected order to flow into strategy');
                assert.deepStrictEqual(
                    bot.config.weightDistribution,
                    { sell: 0.41, buy: 0.21 },
                    'periodic sync should refresh bot config to live dynamic weights before rebalance'
                );
                assert.deepStrictEqual(
                    bot.manager.config.weightDistribution,
                    { sell: 0.41, buy: 0.21 },
                    'periodic sync should refresh manager config to live dynamic weights before rebalance'
                );
                return {
                    actions: [{ type: 'create', id: 'slot-174', order: { id: 'slot-174', type: 'buy', size: 1, price: 100 } }],
                    ordersToPlace: [],
                    ordersToRotate: [],
                    ordersToUpdate: [],
                    ordersToCancel: [],
                    stateUpdates: [],
                    hadRotation: false
                };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        };

        bot.updateOrdersOnChainBatch = async () => {
            batchCalls++;
            return { executed: false, hadRotation: false };
        };

        bot._runGridMaintenance = async () => {
            maintenanceCalls++;
        };

        chainOrders.readOpenOrders = async () => [];
        chainOrders.readOpenOrdersWithMeta = async () => ({ orders: [], truncated: false });

        bot._setupBlockchainFetchInterval();
        assert.strictEqual(typeof capturedCallback, 'function', 'Periodic interval callback should be registered');

        await capturedCallback();

        assert.strictEqual(fetchCalls, 1, 'Periodic callback should fetch account totals once');
        assert.strictEqual(syncCalls, 1, 'Periodic callback should sync open orders once');
        assert.strictEqual(processCalls, 1, 'Periodic callback should process sync-detected fills');
        assert.strictEqual(batchCalls, 1, 'Periodic callback should execute rebalance batch for sync-detected fills');
        assert.strictEqual(persistCalls, 1, 'Periodic callback should persist grid after batch execution');
        assert.strictEqual(maintenanceCalls, 1, 'Periodic callback should continue into maintenance checks');
        assert.strictEqual(bot.manager._recoveryAttempted, false, 'Periodic callback should reset recovery flag each cycle');

        console.log('✓ Periodic sync processes detected fills through rebalance and batch pipeline');
    } finally {
        weightFiles.cleanup();
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
        chainOrders.readOpenOrders = originalReadOpenOrders;
        chainOrders.readOpenOrdersWithMeta = originalReadOpenOrdersWithMeta;
        maintenanceRuntime.syncMarketAdapterOnPeriodicConfigCheck = originalSyncMarketAdapterOnPeriodicConfigCheck;
    }
}

runTests()
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('✗ Periodic sync fill rebalance test failed');
        console.error(err);
        process.exit(1);
    });
