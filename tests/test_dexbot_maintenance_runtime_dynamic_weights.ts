'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');
const { ensureDir, readJSON, writeJSON } = require('../modules/utils/fs_utils');
const { fixedTo } = require('../modules/utils/math_utils');

console.log('Running dexbot maintenance runtime dynamic weight tests');

const { isDistCodeRoot } = require('../modules/launcher/runtime_entry');
const _isDist = isDistCodeRoot(path.dirname(__dirname));
const _adapterSource = 'market_adapter/market_adapter' + (_isDist ? '.js' : '.ts');
const runtimePath = require.resolve('../modules/dexbot_maintenance_runtime');
const dexbotClassPath = require.resolve('../modules/dexbot_class');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');
const chainKeysPath = require.resolve('../modules/chain_keys');
const credentialPolicyPath = require.resolve('../modules/credential_policy');
const chainOrdersPath = require.resolve('../modules/chain_orders');
const orderModulePath = require.resolve('../modules/order');
const gridPath = require.resolve('../modules/order/grid');
const constantsPath = require.resolve('../modules/constants');
const systemPath = require.resolve('../modules/order/utils/system');
const validatePath = require.resolve('../modules/order/utils/validate');
const formatPath = require.resolve('../modules/order/format');
const orderUtilsPath = require.resolve('../modules/order/utils/order');
const mathPath = require.resolve('../modules/order/utils/math');
const processedFillStorePath = require.resolve('../modules/order/processed_fill_store');
const fillRuntimePath = require.resolve('../modules/dexbot_fill_runtime');
const creditRuntimePath = require.resolve('../modules/credit_runtime');
const startupReconcilePath = require.resolve('../modules/order/grid_reconcile');
const accountOrdersPath = require.resolve('../modules/account_orders');
const botSettingsPath = require.resolve('../modules/bot_settings');
const accountBotsPath = require.resolve('../modules/account_bots');
const marketAdapterRuntimePath = require.resolve('../modules/launcher/market_adapter_runtime');

const originals = new Map([
    [runtimePath, require.cache[runtimePath]],
    [dexbotClassPath, require.cache[dexbotClassPath]],
    [bitsharesClientPath, require.cache[bitsharesClientPath]],
    [chainKeysPath, require.cache[chainKeysPath]],
    [credentialPolicyPath, require.cache[credentialPolicyPath]],
    [chainOrdersPath, require.cache[chainOrdersPath]],
    [orderModulePath, require.cache[orderModulePath]],
    [gridPath, require.cache[gridPath]],
    [constantsPath, require.cache[constantsPath]],
    [systemPath, require.cache[systemPath]],
    [validatePath, require.cache[validatePath]],
    [formatPath, require.cache[formatPath]],
    [orderUtilsPath, require.cache[orderUtilsPath]],
    [mathPath, require.cache[mathPath]],
    [processedFillStorePath, require.cache[processedFillStorePath]],
    [fillRuntimePath, require.cache[fillRuntimePath]],
    [creditRuntimePath, require.cache[creditRuntimePath]],
    [startupReconcilePath, require.cache[startupReconcilePath]],
    [accountOrdersPath, require.cache[accountOrdersPath]],
    [botSettingsPath, require.cache[botSettingsPath]],
    [accountBotsPath, require.cache[accountBotsPath]],
    [marketAdapterRuntimePath, require.cache[marketAdapterRuntimePath]],
]);

const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalUnlinkSync = fs.unlinkSync;
let dynamicWeightSnapshotMode = 'live';

async function testPerformGridResyncAppliesVolatilityOnlyDynamicWeights() {
    const logs = [];
    let recalculateCalled = false;
    let persistCalled = false;
    let startCalled = false;
    let finishCalled = false;

    delete require.cache[runtimePath];

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) return true;
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) return true;
        if (text.endsWith('/tmp/nonexistent-dw.trigger')) return false;
        return originalExistsSync(filePath);
    };

    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'Volatility Bot',
                        weightDistribution: { sell: 0.6, buy: 0.4 },
                    },
                ],
            });
        }
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    'volatility-bot-0': { ama: true, dynamicWeight: true },
                },
            });
        }
        return originalReadFileSync(filePath, encoding);
    };

    fs.unlinkSync = () => {};

    setCachedModule(bitsharesClientPath, { BitShares: {} });
    setCachedModule(chainOrdersPath, {
        readOpenOrders: async () => [],
    });
    setCachedModule(gridPath, {
        recalculateGrid: async (manager, opts) => {
            recalculateCalled = true;
            assert.deepStrictEqual(
                manager.config.weightDistribution,
                { sell: 0.42, buy: 0.22 },
                'manager config should receive the volatility-only dynamic weights before recalculation'
            );
            assert.deepStrictEqual(
                opts.config.weightDistribution,
                { sell: 0.42, buy: 0.22 },
                'recalculateGrid should receive the updated weight distribution'
            );
        },
    });
    setCachedModule(constantsPath, {
        ORDER_STATES: { ACTIVE: 'active', PARTIAL: 'partial' },
        ORDER_TYPES: { BUY: 'buy', SELL: 'sell' },
        TIMING: {},
        MAINTENANCE: {},
        GRID_LIMITS: {},
        LOGGING_CONFIG: {},
        FEE_PARAMETERS: { BTS_RESERVATION_MULTIPLIER: 5, BTS_FALLBACK_FEE: 100 },
        BTS_PRECISION: 8,
        NATIVE_CLIENT: {},
    });
    setCachedModule(systemPath, {
        retryPersistenceIfNeeded: async () => {},
        applyGridDivergenceCorrections: async () => {},
        loadAmaCenterSnapshot: () => ({
            centerPrice: 100,
            dynamicWeights: {
                isReady: dynamicWeightSnapshotMode !== 'stale',
                trend: 'NEUTRAL',
                confidence: 0,
                effectiveWeights: { sell: 0.42, buy: 0.22 },
                baseWeights: dynamicWeightSnapshotMode === 'base-changed'
                    ? { sell: 0.8, buy: 0.2 }
                    : { sell: 0.6, buy: 0.4 },
            },
        }),
        parseJsonWithComments: (text) => JSON.parse(text),
    });
    setCachedModule(formatPath, {});
    setCachedModule(orderUtilsPath, {
        virtualizeOrder: (order) => order,
    });
    setCachedModule(accountBotsPath, {});
    setCachedModule(marketAdapterRuntimePath, {
        getSharedMarketAdapterRuntime: () => ({
            syncBot: async () => ({ running: false, started: false, stopped: false }),
            releaseBot: async () => ({ running: false, stopped: false }),
        }),
    });

    const { performGridResync } = require(runtimePath);

    const self = {
        config: {
            name: 'Volatility Bot',
            botKey: 'volatility-bot-0',
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        manager: {
            config: {
                name: 'Volatility Bot',
                botKey: 'volatility-bot-0',
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 5 },
            startBootstrap: () => { startCalled = true; },
            finishBootstrap: () => { finishCalled = true; },
            persistGrid: async () => { persistCalled = true; },
        },
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile: '/tmp/nonexistent-dw.trigger',
    };

    try {
        const ok = await performGridResync(self);

        assert.strictEqual(ok, true, 'performGridResync should succeed');
        assert.strictEqual(startCalled, true, 'bootstrap should start');
        assert.strictEqual(finishCalled, true, 'bootstrap should finish');
        assert.strictEqual(recalculateCalled, true, 'grid recalculation should run');
        assert.strictEqual(persistCalled, true, 'grid state should persist after resync');
        assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.42, buy: 0.22 });
        assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.42, buy: 0.22 });
        assert.strictEqual(self.manager.funds.btsFeesOwed, 0, 'fee accumulator should reset after resync');
        assert.ok(
            logs.some((msg) => String(msg).includes('Applied live dynamic weights (grid resync): sell=0.42 buy=0.22')),
            'resync should log that it applied the dynamic weights'
        );
    } finally {
        fs.unlinkSync = originalUnlinkSync;
    }
}

function testRefreshDynamicWeightDistributionAppliesAndFallsBack() {
    const { refreshDynamicWeightDistribution } = require(runtimePath);

    dynamicWeightSnapshotMode = 'live';
    const self = {
        config: {
            name: 'Volatility Bot',
            botKey: 'volatility-bot-0',
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        },
        _log: () => {},
    };

    const applied = refreshDynamicWeightDistribution(self, 'unit-test-live');
    assert.strictEqual(applied.applied, true, 'ready dynamic weights should be applied');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.42, buy: 0.22 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.42, buy: 0.22 });

    dynamicWeightSnapshotMode = 'stale';
    const reverted = refreshDynamicWeightDistribution(self, 'unit-test-stale');
    assert.strictEqual(reverted.applied, false, 'stale dynamic weights should not be applied');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.6, buy: 0.4 });
}

function testRefreshDynamicWeightDistributionReloadsWhitelistFlags() {
    const { refreshDynamicWeightDistribution } = require(runtimePath);

    let whitelistEnabled = true;
    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) return true;
        return originalExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    'volatility-bot-0': { ama: true, dynamicWeight: whitelistEnabled },
                },
            });
        }
        return originalReadFileSync(filePath, encoding);
    };

    dynamicWeightSnapshotMode = 'live';
    const self = {
        config: {
            name: 'Volatility Bot',
            botKey: 'volatility-bot-0',
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        },
        _log: () => {},
    };

    const applied = refreshDynamicWeightDistribution(self, 'unit-test-live-whitelist');
    assert.strictEqual(applied.applied, true, 'whitelisted bot should apply live weights');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.42, buy: 0.22 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.42, buy: 0.22 });

    whitelistEnabled = false;
    const reverted = refreshDynamicWeightDistribution(self, 'unit-test-whitelist-removed');
    assert.strictEqual(reverted.applied, false, 'refresh should pick up whitelist removal without restart');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.6, buy: 0.4 });
}

async function testManualTriggerResetRefreshesCenterPrice() {
    const { handlePendingTriggerReset } = require(runtimePath);

    const botKey = `manual-reset-${Date.now()}`;
    const triggerFile = `/tmp/${botKey}.trigger`;
    const snapshotFile = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);

    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        centerPrice: 100,
        amaCenterPrice: 123.45,
        gridPriceOffsetPct: 0.8,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });
    fs.writeFileSync(triggerFile, '', 'utf8');

    const previousExistsSync = fs.existsSync;
    const previousReadFileSync = fs.readFileSync;
    const logs = [];

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text === triggerFile) return true;
        return previousExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'Manual Reset Bot',
                        weightDistribution: { sell: 0.6, buy: 0.4 },
                    },
                ],
            });
        }
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    [botKey]: { ama: true, dynamicWeight: true },
                },
            });
        }
        return previousReadFileSync(filePath, encoding);
    };

    const self = {
        config: {
            name: 'Manual Reset Bot',
            botKey,
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                name: 'Manual Reset Bot',
                botKey,
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 2 },
            _fillProcessingLock: {
                acquire: async (fn) => fn(),
            },
            startBootstrap: () => {},
            finishBootstrap: () => {},
            persistGrid: async () => {},
        },
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile,
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
        _performGridResync: async (options) => require(runtimePath).performGridResync(self, options),
    };

    try {
        const ok = await handlePendingTriggerReset(self);
        assert.strictEqual(ok, true, 'manual trigger reset should succeed');

        const updated = readJSON(snapshotFile);
        assert.strictEqual(updated.centerPrice, 123.45, 'manual reset should refresh centerPrice from amaCenterPrice');
        assert.strictEqual(updated.gridPriceOffsetPct, 0.8, 'manual reset should preserve the AMA spread offset for the rebuild');
        assert.strictEqual(updated.lastGridResetSource, 'manual_grid_resync', 'manual reset should record manual reset provenance');
        assert.ok(
            logs.some((msg) => String(msg).includes('Refreshed AMA center snapshot for manual grid reset.')),
            'manual reset should log that the center snapshot was refreshed'
        );
    } finally {
        fs.existsSync = previousExistsSync;
        fs.readFileSync = previousReadFileSync;
        try { originalUnlinkSync(triggerFile); } catch (_) {}
        try { originalUnlinkSync(snapshotFile); } catch (_) {}
    }
}

async function testManualTriggerResetKeepsOffsetWhenCenterAlreadyCurrent() {
    const { handlePendingTriggerReset } = require(runtimePath);

    const botKey = `manual-reset-current-${Date.now()}`;
    const triggerFile = `/tmp/${botKey}.trigger`;
    const snapshotFile = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);

    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        gridCenterPrice: 123.45,
        centerPrice: 123.45,
        amaCenterPrice: 123.45,
        gridPriceOffsetPct: 0.8,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });
    fs.writeFileSync(triggerFile, '', 'utf8');

    const previousExistsSync = fs.existsSync;
    const previousReadFileSync = fs.readFileSync;

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text === triggerFile) return true;
        return previousExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'Manual Reset Current Bot',
                        weightDistribution: { sell: 0.6, buy: 0.4 },
                    },
                ],
            });
        }
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    [botKey]: { ama: true, dynamicWeight: true },
                },
            });
        }
        return previousReadFileSync(filePath, encoding);
    };

    const self = {
        config: {
            name: 'Manual Reset Current Bot',
            botKey,
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                name: 'Manual Reset Current Bot',
                botKey,
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 2 },
            _fillProcessingLock: {
                acquire: async (fn) => fn(),
            },
            startBootstrap: () => {},
            finishBootstrap: () => {},
            persistGrid: async () => {},
        },
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile,
        _log: () => {},
        _warn: () => {},
        _performGridResync: async (options) => require(runtimePath).performGridResync(self, options),
    };

    try {
        const ok = await handlePendingTriggerReset(self);
        assert.strictEqual(ok, true, 'manual trigger reset should succeed when center already equals AMA');

        const updated = readJSON(snapshotFile);
        assert.strictEqual(updated.centerPrice, 123.45, 'manual reset should leave the current AMA center intact');
        assert.strictEqual(updated.gridPriceOffsetPct, 0.8, 'manual reset should preserve the AMA spread offset when center is already current');
    } finally {
        fs.existsSync = previousExistsSync;
        fs.readFileSync = previousReadFileSync;
        try { originalUnlinkSync(triggerFile); } catch (_) {}
        try { originalUnlinkSync(snapshotFile); } catch (_) {}
    }
}

async function testMarketAdapterTriggerResetRefreshesAmaCenterPrice() {
    const { handlePendingTriggerReset } = require(runtimePath);

    const botKey = `market-adapter-reset-${Date.now()}`;
    const triggerFile = `/tmp/${botKey}.trigger`;
    const snapshotFile = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);

    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        gridCenterPrice: 100,
        centerPrice: 100,
        amaCenterPrice: 123.45,
        gridPriceOffsetPct: 0.8,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });
    writeJSON(triggerFile, {
        source: _adapterSource,
        reason: 'market_adapter_delta_threshold',
        newCenterPrice: 100,
        amaCenterPrice: 123.45,
    });

    const previousExistsSync = fs.existsSync;
    const previousReadFileSync = fs.readFileSync;
    const logs = [];

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text === triggerFile) return true;
        return previousExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'Market Adapter Reset Bot',
                        weightDistribution: { sell: 0.6, buy: 0.4 },
                    },
                ],
            });
        }
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    [botKey]: { ama: true, dynamicWeight: true },
                },
            });
        }
        return previousReadFileSync(filePath, encoding);
    };

    const self = {
        config: {
            name: 'Market Adapter Reset Bot',
            botKey,
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                name: 'Market Adapter Reset Bot',
                botKey,
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 2 },
            _fillProcessingLock: {
                acquire: async (fn) => fn(),
            },
            startBootstrap: () => {},
            finishBootstrap: () => {},
            persistGrid: async () => {},
        },
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile,
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
        _performGridResync: async (options) => require(runtimePath).performGridResync(self, options),
    };

    try {
        const ok = await handlePendingTriggerReset(self);
        assert.strictEqual(ok, true, 'market-adapter trigger reset should succeed');

        const updated = readJSON(snapshotFile);
        assert.strictEqual(updated.centerPrice, 123.45, 'market-adapter reset should refresh centerPrice from latest amaCenterPrice');
        assert.strictEqual(updated.amaCenterPrice, 123.45, 'market-adapter reset should preserve raw AMA diagnostics');
        assert.strictEqual(updated.lastGridResetSource, 'market_adapter_delta_threshold', 'market-adapter reset should preserve the trigger reason as reset provenance');
        assert.ok(
            logs.some((msg) => String(msg).includes('AMA center grid reset')),
            'market-adapter reset should log that the AMA center snapshot was refreshed'
        );
    } finally {
        fs.existsSync = previousExistsSync;
        fs.readFileSync = previousReadFileSync;
        try { originalUnlinkSync(triggerFile); } catch (_) {}
        try { originalUnlinkSync(snapshotFile); } catch (_) {}
    }
}

async function testMarketAdapterBootstrapTriggerResetRecordsBootstrapSource() {
    const { handlePendingTriggerReset } = require(runtimePath);

    const botKey = `market-adapter-bootstrap-${Date.now()}`;
    const triggerFile = `/tmp/${botKey}.trigger`;
    const snapshotFile = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);

    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        gridCenterPrice: 100,
        centerPrice: 100,
        amaCenterPrice: 123.45,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });
    writeJSON(triggerFile, {
        source: _adapterSource,
        reason: 'market_adapter_bootstrap',
        newCenterPrice: 100,
        amaCenterPrice: 123.45,
    });

    const previousExistsSync = fs.existsSync;
    const previousReadFileSync = fs.readFileSync;
    const logs = [];

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text === triggerFile) return true;
        return previousExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'Market Adapter Bootstrap Bot',
                        weightDistribution: { sell: 0.6, buy: 0.4 },
                    },
                ],
            });
        }
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    [botKey]: { ama: true, dynamicWeight: true },
                },
            });
        }
        return previousReadFileSync(filePath, encoding);
    };

    const self = {
        config: {
            name: 'Market Adapter Bootstrap Bot',
            botKey,
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                name: 'Market Adapter Bootstrap Bot',
                botKey,
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 2 },
            _fillProcessingLock: {
                acquire: async (fn) => fn(),
            },
            startBootstrap: () => {},
            finishBootstrap: () => {},
            persistGrid: async () => {},
        },
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile,
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
        _performGridResync: async (options) => require(runtimePath).performGridResync(self, options),
    };

    try {
        const ok = await handlePendingTriggerReset(self);
        assert.strictEqual(ok, true, 'market-adapter bootstrap trigger reset should succeed');

        const updated = readJSON(snapshotFile);
        assert.strictEqual(updated.centerPrice, 123.45, 'market-adapter bootstrap reset should refresh centerPrice from latest amaCenterPrice');
        assert.strictEqual(updated.amaCenterPrice, 123.45, 'market-adapter bootstrap reset should preserve raw AMA diagnostics');
        assert.strictEqual(updated.lastGridResetSource, 'market_adapter_bootstrap', 'market-adapter bootstrap reset should preserve bootstrap provenance');
        assert.ok(
            logs.some((msg) => String(msg).includes('AMA bootstrap grid reset')),
            'market-adapter bootstrap reset should log that the AMA center snapshot was refreshed'
        );
    } finally {
        fs.existsSync = previousExistsSync;
        fs.readFileSync = previousReadFileSync;
        try { originalUnlinkSync(triggerFile); } catch (_) {}
        try { originalUnlinkSync(snapshotFile); } catch (_) {}
    }
}

async function testMarketAdapterSlopeTriggerResetRecordsSlopeSource() {
    const { handlePendingTriggerReset } = require(runtimePath);

    const botKey = `market-adapter-slope-${Date.now()}`;
    const triggerFile = `/tmp/${botKey}.trigger`;
    const snapshotFile = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);

    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        gridCenterPrice: 100,
        centerPrice: 100,
        amaCenterPrice: 123.45,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });
    writeJSON(triggerFile, {
        source: _adapterSource,
        reason: 'market_adapter_ama_slope_delta_threshold',
        newCenterPrice: 100,
        amaCenterPrice: 123.45,
    });

    const previousExistsSync = fs.existsSync;
    const previousReadFileSync = fs.readFileSync;
    const logs = [];

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text === triggerFile) return true;
        return previousExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/bots.json')) {
            return JSON.stringify({
                bots: [
                    {
                        name: 'Market Adapter Slope Bot',
                        weightDistribution: { sell: 0.6, buy: 0.4 },
                    },
                ],
            });
        }
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    [botKey]: { ama: true, dynamicWeight: true },
                },
            });
        }
        return previousReadFileSync(filePath, encoding);
    };

    const self = {
        config: {
            name: 'Market Adapter Slope Bot',
            botKey,
            botIndex: 0,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                name: 'Market Adapter Slope Bot',
                botKey,
                botIndex: 0,
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            funds: { btsFeesOwed: 2 },
            _fillProcessingLock: {
                acquire: async (fn) => fn(),
            },
            startBootstrap: () => {},
            finishBootstrap: () => {},
            persistGrid: async () => {},
        },
        accountId: '1.2.345',
        account: { id: '1.2.345' },
        privateKey: 'test-key',
        triggerFile,
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
        _performGridResync: async (options) => require(runtimePath).performGridResync(self, options),
    };

    try {
        const ok = await handlePendingTriggerReset(self);
        assert.strictEqual(ok, true, 'market-adapter slope trigger reset should succeed');

        const updated = readJSON(snapshotFile);
        assert.strictEqual(updated.centerPrice, 123.45, 'market-adapter slope reset should refresh centerPrice from latest amaCenterPrice');
        assert.strictEqual(updated.amaCenterPrice, 123.45, 'market-adapter slope reset should preserve raw AMA diagnostics');
        assert.strictEqual(updated.lastGridResetSource, 'market_adapter_ama_slope_delta_threshold', 'market-adapter slope reset should preserve slope provenance');
        assert.ok(
            logs.some((msg) => String(msg).includes('AMA slope grid reset')),
            'market-adapter slope reset should log that the AMA center snapshot was refreshed'
        );
    } finally {
        fs.existsSync = previousExistsSync;
        fs.readFileSync = previousReadFileSync;
        try { originalUnlinkSync(triggerFile); } catch (_) {}
        try { originalUnlinkSync(snapshotFile); } catch (_) {}
    }
}

function testUpdateBotGridResetMetadataRecordsActualReset() {
    const { updateBotGridResetMetadata } = require(runtimePath);

    const botKey = `metadata-reset-${Date.now()}`;
    const snapshotFile = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);
    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        gridCenterPrice: 123.45,
        centerPrice: 123.45,
        amaCenterPrice: 130.25,
        gridPriceOffsetPct: 0.8,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });

    const prevReadFileSync = fs.readFileSync;
    let adapterStateReadCount = 0;
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/market_adapter/state/market_adapter_state.json')
                || text.endsWith('/market_adapter/state/market_adapter_centers.json')) {
            adapterStateReadCount += 1;
            throw new Error(`unexpected adapter state read: ${text}`);
        }
        return originalReadFileSync(filePath, encoding);
    };

    try {
        const ok = updateBotGridResetMetadata(botKey, {
            resetAt: '2026-05-15T00:01:00.327Z',
            resetSource: 'unit_test_resync',
        });
        assert.strictEqual(ok, true, 'metadata update should succeed when snapshot exists');

        const updated = readJSON(snapshotFile);
        assert.strictEqual(updated.gridCenterPrice, 123.45, 'metadata update should preserve grid center');
        assert.strictEqual(updated.centerPrice, 123.45, 'metadata update should preserve center alias');
        assert.strictEqual(updated.amaCenterPrice, 130.25, 'metadata update should preserve current AMA diagnostics');
        assert.strictEqual(updated.gridPriceOffsetPct, 0.8, 'metadata update should preserve actual offset');
        assert.strictEqual(updated.lastGridResetAt, '2026-05-15T00:01:00.327Z');
        assert.strictEqual(updated.lastGridResetSource, 'unit_test_resync');
        assert.strictEqual(updated.updatedAt, '2026-05-15T00:01:00.327Z');
        assert.strictEqual(adapterStateReadCount, 0, 'metadata update should not touch adapter-owned state snapshots');
    } finally {
        fs.readFileSync = prevReadFileSync;
        originalUnlinkSync(snapshotFile);
    }
}

function testUpdateBotGridResetMetadataRejectsInvalidSnapshot() {
    const { updateBotGridResetMetadata } = require(runtimePath);

    const botKey = `metadata-invalid-${Date.now()}`;
    const snapshotFile = path.join(__dirname, '..', 'profiles', 'orders', `${botKey}.dynamicgrid.json`);
    ensureDir(path.dirname(snapshotFile));
    writeJSON(snapshotFile, {
        gridCenterPrice: 0,
        centerPrice: 0,
        amaCenterPrice: 130.25,
        source: _adapterSource,
        updatedAt: '2026-01-01T00:00:00Z',
    });

    try {
        const ok = updateBotGridResetMetadata(botKey, {
            resetAt: '2026-05-15T00:01:00.327Z',
            resetSource: 'unit_test_resync',
        });
        assert.strictEqual(ok, false, 'metadata update should report false when no valid center can be preserved');

        const updated = readJSON(snapshotFile);
        assert.strictEqual(updated.lastGridResetAt, undefined);
        assert.strictEqual(updated.lastGridResetSource, undefined);
    } finally {
        originalUnlinkSync(snapshotFile);
    }
}

function testRefreshDynamicWeightDistributionRejectsStaleBaseWeights() {
    const { refreshDynamicWeightDistribution } = require(runtimePath);

    const prevExistsSync = fs.existsSync;
    const prevReadFileSync = fs.readFileSync;

    fs.existsSync = (filePath) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) return true;
        return originalExistsSync(filePath);
    };
    fs.readFileSync = (filePath, encoding) => {
        const text = String(filePath);
        if (text.endsWith('/profiles/market_adapter_whitelist.json')) {
            return JSON.stringify({
                whitelist: {
                    'volatility-bot-0': { ama: true, dynamicWeight: true },
                },
            });
        }
        return originalReadFileSync(filePath, encoding);
    };

    dynamicWeightSnapshotMode = 'base-changed';
    const logs = [];
    const self = {
        config: {
            name: 'Volatility Bot',
            botKey: 'volatility-bot-0',
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        manager: {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        },
        _log: (msg) => logs.push(msg),
    };

    const result = refreshDynamicWeightDistribution(self, 'unit-test-base-mismatch');
    assert.strictEqual(result.applied, false, 'stale base weights should cause fallback to static');
    assert.deepStrictEqual(self.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    assert.deepStrictEqual(self.manager.config.weightDistribution, { sell: 0.6, buy: 0.4 });
    assert.ok(
        logs.some((msg) => String(msg).includes('Skipping stale dynamic weights')),
        'should log a warning about stale dynamic weights'
    );
    assert.ok(
        logs.some((msg) => String(msg).includes('snapshot base (sell=0.8, buy=0.2) != config (sell=0.6, buy=0.4)')),
        'should log the mismatched base vs config values'
    );

    fs.existsSync = prevExistsSync;
    fs.readFileSync = prevReadFileSync;
    dynamicWeightSnapshotMode = 'live';
}

async function testRmsDivergenceRunsFullGridResync() {
    delete require.cache[runtimePath];

    let resyncOptions = null;
    let correctionCalled = false;
    let spreadChecked = false;
    const logs = [];

    setCachedModule(bitsharesClientPath, { BitShares: {} });
    setCachedModule(constantsPath, {
        ORDER_STATES: { ACTIVE: 'active', PARTIAL: 'partial' },
        ORDER_TYPES: { BUY: 'buy', SELL: 'sell' },
        TIMING: {},
        MAINTENANCE: {},
        GRID_LIMITS: {},
        LOGGING_CONFIG: {},
    });
    setCachedModule(systemPath, {
        retryPersistenceIfNeeded: async () => {},
        applyGridDivergenceCorrections: async () => {
            correctionCalled = true;
        },
        loadAmaCenterSnapshot: () => null,
        parseJsonWithComments: (text) => JSON.parse(text),
    });
    setCachedModule(gridPath, {
        monitorDivergence: async () => ({
            needsUpdate: true,
            buy: { ratio: false, rms: true, metric: 14.8 },
            sell: { ratio: false, rms: false, metric: 0 },
        }),
    });
    setCachedModule(formatPath, {
        formatPrice6: (value) => fixedTo(value, 6),
    });
    setCachedModule(orderUtilsPath, {
        virtualizeOrder: (order) => order,
    });
    setCachedModule(accountBotsPath, {
        isBotDynamicWeightWhitelisted: () => false,
        resetMarketAdapterWhitelistCache: () => {},
    });
    setCachedModule(marketAdapterRuntimePath, {
        getSharedMarketAdapterRuntime: () => ({
            syncBot: async () => ({ running: false, started: false, stopped: false }),
            releaseBot: async () => ({ running: false, stopped: false }),
        }),
    });

    const { executeMaintenanceLogic } = require(runtimePath);
    const self = {
        config: {
            botKey: 'rms-reset-bot-0',
            dryRun: true,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        },
        _baseWeightDistribution: { sell: 0.6, buy: 0.4 },
        _maintenanceCooldownCycles: 0,
        _dustSinceMap: new Map(),
        manager: {
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
            orders: new Map([
                ['buy-0', { id: 'buy-0', type: 'buy', price: 1, size: 1 }],
            ]),
            recalculateFunds: async () => {},
            _clearStaleBroadcastFlag: () => {},
            clearStalePipelineOperations: () => {},
            isPipelineEmpty: () => ({ isEmpty: true }),
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
            checkSpreadCondition: async () => {
                spreadChecked = true;
                return null;
            },
        },
        accountOrders: {
            loadGrid: () => [{ id: 'buy-0', type: 'buy', price: 1, size: 1 }],
        },
        _getPipelineSignals: () => ({}),
        _cancelDustOrders: async () => ({ cancelledCount: 0, batchResult: null }),
        _abortFlowIfIllegalState: async () => false,
        _performGridResync: async (options) => {
            resyncOptions = options;
            return true;
        },
        updateOrdersOnChainBatch: async () => {
            throw new Error('correction batch should not run for RMS resync');
        },
        updateOrdersOnChainPlan: async () => {},
        _persistAndRecoverIfNeeded: async () => {},
        _log: (msg) => logs.push(String(msg)),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    await executeMaintenanceLogic(self, 'unit-test-rms');

    assert.deepStrictEqual(resyncOptions, {
        refreshCenterPrice: true,
        centerRefreshContext: 'RMS structural grid resync',
        centerRefreshLabel: 'RMS structural grid resync',
        resetSource: 'rms_structural_grid_resync',
    }, 'RMS divergence should run full grid resync from the latest AMA center snapshot');
    assert.strictEqual(correctionCalled, false, 'RMS divergence should not use correction-only path');
    assert.strictEqual(spreadChecked, false, 'maintenance should stop after full RMS resync');
    assert.ok(
        logs.some((msg) => msg.includes('Grid update triggered by structural divergence during unit-test-rms')),
        'RMS divergence should be logged'
    );
}

async function testDexbotClassPerformGridResyncForwardsOptions() {
    delete require.cache[dexbotClassPath];

    let forwardedThis = null;
    let forwardedOptions = null;
    setCachedModule(runtimePath, {
        performGridResync(bot, options = {}) {
            forwardedThis = bot;
            forwardedOptions = options;
            return Promise.resolve('forwarded');
        },
    });
    setCachedModule(bitsharesClientPath, { BitShares: {}, waitForConnected: async () => {} });
    setCachedModule(chainKeysPath, {});
    setCachedModule(credentialPolicyPath, {});
    setCachedModule(chainOrdersPath, {});
    setCachedModule(orderModulePath, { OrderManager: class {}, grid: {} });
    setCachedModule(systemPath, {
        retryPersistenceIfNeeded: async () => {},
        initializeFeeCache: async () => {},
        applyGridDivergenceCorrections: async () => {},
        parseJsonWithComments: (text) => JSON.parse(text),
    });
    setCachedModule(validatePath, {
        hasExecutableActions: () => false,
        validateCreateTargetSlots: () => [],
    });
    setCachedModule(orderUtilsPath, {
        buildCreateOrderArgs: () => null,
        getOrderTypeFromUpdatedFlags: () => null,
        virtualizeOrder: (order) => order,
        correctAllPriceMismatches: () => [],
        convertToSpreadPlaceholder: () => null,
        buildOutsideInPairGroups: () => [],
        extractBatchOperationResults: () => [],
        buildFillKey: () => 'fill-key',
    });
    setCachedModule(mathPath, {
        validateOrderSize: () => true,
        calculateRotationOrderSizes: () => ({}),
        cloneWeightDistribution: (weights, fallback) => weights || fallback || null,
    });
    setCachedModule(processedFillStorePath, {
        ProcessedFillStore: class {},
        PROCESSED_FILL_PERSISTENCE_MODES: {},
    });
    setCachedModule(fillRuntimePath, {});
    setCachedModule(creditRuntimePath, class {});
    setCachedModule(constantsPath, {
        ORDER_STATES: { ACTIVE: 'active', PARTIAL: 'partial' },
        ORDER_TYPES: { BUY: 'buy', SELL: 'sell' },
        REBALANCE_STATES: {},
        COW_ACTIONS: {},
        TIMING: {},
        MAINTENANCE: {},
        GRID_LIMITS: {},
        FILL_PROCESSING: {},
        LOGGING_CONFIG: {},
    });
    setCachedModule(startupReconcilePath, {
        attemptResumePersistedGridByPriceMatch: async () => null,
        decideStartupGridAction: () => null,
        reconcileGridOrders: async () => null,
    });
    setCachedModule(accountOrdersPath, {
        AccountOrders: class {},
        createBotKey: () => 'bot-key',
    });
    setCachedModule(botSettingsPath, {
        normalizeBotEntry: (entry) => entry,
    });
    setCachedModule(formatPath, {});

    const DEXBot = require(dexbotClassPath);
    const fakeBot = { config: { botKey: 'forward-bot' } };
    const options = {
        refreshCenterPrice: true,
        centerRefreshContext: 'RMS structural grid resync',
        resetSource: 'rms_structural_grid_resync',
    };

    const result = await DEXBot.prototype._performGridResync.call(fakeBot, options);

    assert.strictEqual(result, 'forwarded');
    assert.strictEqual(forwardedThis, fakeBot, 'wrapper should preserve the bot instance');
    assert.strictEqual(forwardedOptions, options, 'wrapper should forward resync options unchanged');
}

async function main() {
    try {
        await testPerformGridResyncAppliesVolatilityOnlyDynamicWeights();
        testRefreshDynamicWeightDistributionAppliesAndFallsBack();
        testRefreshDynamicWeightDistributionReloadsWhitelistFlags();
        testRefreshDynamicWeightDistributionRejectsStaleBaseWeights();
        testUpdateBotGridResetMetadataRecordsActualReset();
        testUpdateBotGridResetMetadataRejectsInvalidSnapshot();
        await testManualTriggerResetRefreshesCenterPrice();
        await testManualTriggerResetKeepsOffsetWhenCenterAlreadyCurrent();
        await testMarketAdapterTriggerResetRefreshesAmaCenterPrice();
        await testMarketAdapterBootstrapTriggerResetRecordsBootstrapSource();
        await testMarketAdapterSlopeTriggerResetRecordsSlopeSource();
        await testRmsDivergenceRunsFullGridResync();
        await testDexbotClassPerformGridResyncForwardsOptions();
        console.log('dexbot maintenance runtime dynamic weight tests passed');
    } finally {
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
        fs.unlinkSync = originalUnlinkSync;
        for (const [modulePath, original] of originals.entries()) {
            restoreCachedModule(modulePath, original);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
