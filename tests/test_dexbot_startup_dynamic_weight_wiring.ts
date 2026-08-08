'use strict';

const assert = require('assert');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');
const { withDynamicWeightFiles } = require('./helpers/dynamic_weight_files');

console.log('Running dexbot startup dynamic weight wiring tests');

const bitsharesClientPath = path.resolve(__dirname, '../modules/bitshares_client.ts');
const startupReconcilePath = path.resolve(__dirname, '../modules/order/grid_reconcile.ts');
const dexbotClassPath = path.resolve(__dirname, '../modules/dexbot_class.ts');

const originalBitsharesClient = require.cache[bitsharesClientPath];
const originalStartupReconcile = require.cache[startupReconcilePath];
const originalDexbotClass = require.cache[dexbotClassPath];

setCachedModule(bitsharesClientPath, {
    BitShares: { db: { call: async () => [] }, subscribe() {} },
    waitForConnected: async () => {},
    createAccountClient: () => ({}),
    setSuppressConnectionLog() {},
    getNodeManager: () => null,
    getNodeStats: () => null,
    getNodeSummary: () => null,
    _internal: { connected: true },
    onReconnect: () => () => {},
});

setCachedModule(startupReconcilePath, {
    attemptResumePersistedGridByPriceMatch: async () => ({ resumed: false }),
    decideStartupGridAction: async () => ({ shouldRegenerate: false }),
    reconcileGridOrders: async () => ({ actions: [] }),
});

const gridModulePath = require.resolve('../modules/order/grid');
const { installChainOrdersStub } = require('./helpers/chain_orders_stub');
const { chainOrders } = installChainOrdersStub();
const realGrid = require('../modules/order/grid');
const gridStub = Object.assign({}, realGrid);
setCachedModule(gridModulePath, gridStub);
delete require.cache[dexbotClassPath];
const DEXBot = require('../modules/dexbot_class').default;

async function testPlaceInitialOrdersRefreshesAndFallsBack() {
    const botKey = 'test_startup_dynamic_weight_initial';
    const weightFiles = withDynamicWeightFiles(botKey);
    const originalInitializeGrid = gridStub.initializeGrid;

    try {
        const observedWeights = [];
        weightFiles.writeSnapshot({
            isReady: true,
            effectiveWeights: { sell: 0.45, buy: 0.25 },
        });

        gridStub.initializeGrid = async (manager) => {
            observedWeights.push({ ...manager.config.weightDistribution });
        };

        const bot = new DEXBot({
            botKey,
            dryRun: true,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5,
            weightDistribution: { sell: 0.6, buy: 0.4 },
            botFunds: { buy: 1, sell: 1 },
        });

        let persistCalls = 0;
        bot.manager = {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            logger: { log: () => {} },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            startBootstrap: () => {},
            finishBootstrap: () => {},
        };

        // Simulate the startup refresh that normally precedes initial order placement
        bot._refreshDynamicWeightDistribution('startup');

        await bot.placeInitialOrders();
        assert.deepStrictEqual(
            observedWeights[0],
            { sell: 0.45, buy: 0.25 },
            'initial order placement should use live dynamic weights when snapshot is ready'
        );
        assert.deepStrictEqual(
            bot.config.weightDistribution,
            { sell: 0.45, buy: 0.25 },
            'bot config should be updated to live dynamic weights during initial placement'
        );

        weightFiles.writeSnapshot({
            isReady: false,
            effectiveWeights: { sell: 0.45, buy: 0.25 },
        });

        bot._refreshDynamicWeightDistribution('startup');

        await bot.placeInitialOrders();
        assert.deepStrictEqual(
            observedWeights[1],
            { sell: 0.6, buy: 0.4 },
            'initial order placement should fall back to static base weights when snapshot is stale'
        );
        assert.deepStrictEqual(
            bot.config.weightDistribution,
            { sell: 0.6, buy: 0.4 },
            'bot config should revert to static base weights when live snapshot is not ready'
        );
        assert.strictEqual(persistCalls, 2, 'dry-run placement should persist grid each time');
    } finally {
        gridStub.initializeGrid = originalInitializeGrid;
        weightFiles.cleanup();
    }
}

async function testFinishStartupSequenceUsesLiveWeightsForStartupFillRebalance() {
    const botKey = 'test_startup_dynamic_weight_loaded';
    const weightFiles = withDynamicWeightFiles(botKey);
    const originalListenForFills = chainOrders.listenForFills;
    const originalReadOpenOrders = chainOrders.readOpenOrders;
    const originalReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;
    const originalLoadGrid = gridStub.loadGrid;

    try {
        weightFiles.writeSnapshot({
            isReady: true,
            effectiveWeights: { sell: 0.47, buy: 0.27 },
        });

        let processCalls = 0;
        let loadGridCalls = 0;
        let finishBootstrapCalls = 0;

        chainOrders.listenForFills = async () => async () => {};
        chainOrders.readOpenOrders = async () => [];
        chainOrders.readOpenOrdersWithMeta = async () => ({ orders: [], truncated: false });
        gridStub.loadGrid = async () => {
            loadGridCalls++;
        };

        const bot = new DEXBot({
            botKey,
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5,
            preferredAccount: 'alice',
            weightDistribution: { sell: 0.6, buy: 0.4 },
        });

        bot.account = { id: '1.2.345' };
        bot.accountId = '1.2.345';
        bot.privateKey = 'test-key';
        bot._log = () => {};
        bot._warn = () => {};
        bot._handlePendingTriggerReset = async () => false;
        bot._setupTriggerFileDetection = async () => {};
        bot._setupCreditRuntime = async () => {};
        bot._setupBlockchainFetchInterval = () => {};
        bot._isOpenOrdersSyncLoopEnabled = () => false;
        bot._runGridMaintenance = async () => {};
        bot._persistAndRecoverIfNeeded = async () => {};
        bot._executeBatchIfNeeded = async () => ({ skippedNoActions: true, hadRotation: false });
        bot._processFillsWithBatching = async (filledOrders, excludeSet, context, options) => {
            processCalls++;
            assert.strictEqual(filledOrders.length, 1, 'startup fill rebalance should receive one detected fill');
            assert.deepStrictEqual(
                bot.config.weightDistribution,
                { sell: 0.47, buy: 0.27 },
                'startup fill rebalance should refresh bot config to live dynamic weights'
            );
            assert.deepStrictEqual(
                bot.manager.config.weightDistribution,
                { sell: 0.47, buy: 0.27 },
                'startup fill rebalance should refresh manager config to live dynamic weights'
            );
            assert.strictEqual(context, 'startup sync fill rebalance', 'startup fill rebalance should use the startup sync batching context');
            assert.strictEqual(
                options && options.skipAccountTotalsUpdate,
                true,
                'startup fill rebalance should preserve existing skipAccountTotalsUpdate behavior'
            );
            assert(excludeSet instanceof Set, 'startup fill rebalance should still pass an exclude set');
            return { aborted: false };
        };
        bot.shutdown = async () => {};

        bot.manager = {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 0 },
            resetFunds: () => {},
            finishBootstrap: () => {
                finishBootstrapCalls++;
            },
            _initializeAssets: async () => {},
            _fillProcessingLock: {
                acquire: async (fn) => await fn(),
                isLocked: () => false,
                getQueueLength: () => 0,
            },
            _fundLock: { acquire: async (fn) => await fn() },
            syncFromOpenOrders: async () => ({
                filledOrders: [{
                    id: 'slot-174',
                    orderId: '1.7.777777',
                    type: 'sell',
                    isPartial: false,
                }],
            }),
            synchronizeWithChain: async () => ({ filledOrders: [] }),
            fetchAccountTotals: async () => {},
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
        };

        await bot._finishStartupSequence({
            persistedGrid: [{ id: 'slot-174', state: 'active' }],
            persistedBtsFeesOwed: 0,
            persistedBoundaryIdx: 0,
        });

        assert.strictEqual(loadGridCalls, 1, 'startup should load the persisted grid once');
        assert.strictEqual(processCalls, 1, 'startup should process the detected fill once');
        assert(finishBootstrapCalls >= 1, 'startup should still finalize bootstrap');
    } finally {
        chainOrders.listenForFills = originalListenForFills;
        chainOrders.readOpenOrders = originalReadOpenOrders;
        chainOrders.readOpenOrdersWithMeta = originalReadOpenOrdersWithMeta;
        gridStub.loadGrid = originalLoadGrid;
        weightFiles.cleanup();
    }
}

async function main() {
    const unhandledRejectionHandler = (reason) => {
        const isWsErrorEvent = reason &&
            (
                reason.constructor?.name === 'ErrorEvent' ||
                (reason.type === 'error' && reason.error && typeof reason.error === 'object')
            );

        if (isWsErrorEvent) {
            return;
        }

        throw reason;
    };

    process.on('unhandledRejection', unhandledRejectionHandler);
    try {
        await testPlaceInitialOrdersRefreshesAndFallsBack();
        await testFinishStartupSequenceUsesLiveWeightsForStartupFillRebalance();
        console.log('dexbot startup dynamic weight wiring tests passed');
    } finally {
        process.off('unhandledRejection', unhandledRejectionHandler);
        restoreCachedModule(bitsharesClientPath, originalBitsharesClient);
        restoreCachedModule(startupReconcilePath, originalStartupReconcile);
        restoreCachedModule(dexbotClassPath, originalDexbotClass);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
