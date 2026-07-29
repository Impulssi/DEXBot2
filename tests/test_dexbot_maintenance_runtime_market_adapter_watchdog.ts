const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');
const { Config } = require('../modules/config');

console.log('Running dexbot maintenance runtime market adapter watchdog tests');

const runtimePath = require.resolve('../modules/dexbot_maintenance_runtime');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');
const chainOrdersPath = require.resolve('../modules/chain_orders');
const gridPath = require.resolve('../modules/order/grid');
const constantsPath = require.resolve('../modules/constants');
const systemPath = require.resolve('../modules/order/utils/system');
const formatPath = require.resolve('../modules/order/format');
const orderUtilsPath = require.resolve('../modules/order/utils/order');
const accountBotsPath = require.resolve('../modules/account_bots');
const marketAdapterRuntimePath = require.resolve('../modules/launcher/market_adapter_runtime');
const loggerPath = require.resolve('../modules/order/logger');

const originals = new Map([
    [runtimePath, require.cache[runtimePath]],
    [bitsharesClientPath, require.cache[bitsharesClientPath]],
    [chainOrdersPath, require.cache[chainOrdersPath]],
    [gridPath, require.cache[gridPath]],
    [constantsPath, require.cache[constantsPath]],
    [systemPath, require.cache[systemPath]],
    [formatPath, require.cache[formatPath]],
    [orderUtilsPath, require.cache[orderUtilsPath]],
    [accountBotsPath, require.cache[accountBotsPath]],
    [marketAdapterRuntimePath, require.cache[marketAdapterRuntimePath]],
    [loggerPath, require.cache[loggerPath]],
]);

const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;

function loadRuntimeWithStubs({ marketAdapterRuntimeStub }: any = {}) {
    delete require.cache[runtimePath];
    delete require.cache[loggerPath];

    setCachedModule(bitsharesClientPath, { BitShares: {} });
    setCachedModule(chainOrdersPath, {
        readOpenOrders: async () => [],
    });
    setCachedModule(gridPath, {
        recalculateGrid: async () => {},
    });
    setCachedModule(constantsPath, {
        ORDER_STATES: {},
        TIMING: {},
        MAINTENANCE: {},
        GRID_LIMITS: {},
        LOGGING_CONFIG: {},
    });
    setCachedModule(systemPath, {
        retryPersistenceIfNeeded: async () => {},
        applyGridDivergenceCorrections: async (_1: any, _2: any, _3: any, _4: any, _5: any) => {},
        loadAmaCenterSnapshot: () => null,
        parseJsonWithComments: (text) => JSON.parse(text),
    });
    setCachedModule(formatPath, {});
    setCachedModule(orderUtilsPath, {
        virtualizeOrder: (order) => order,
    });
    setCachedModule(accountBotsPath, {});
    setCachedModule(marketAdapterRuntimePath, marketAdapterRuntimeStub || {
        getSharedMarketAdapterRuntime: () => ({
            syncBot: async () => ({ running: false, started: false, stopped: false }),
            releaseBot: async () => ({ running: false, stopped: false }),
        }),
    });

    return require(runtimePath);
}

async function testSnapshotReaderDetectsAMAConfig() {
    const botsFile = require('path').join(__dirname, '..', 'profiles', 'bots.json');

    fs.existsSync = (filePath) => String(filePath) === botsFile;
    fs.readFileSync = (filePath, encoding) => {
        if (String(filePath) === botsFile) {
            return JSON.stringify({
                bots: [
                    { name: 'AMA Bot', active: true, gridPrice: 'ama3' },
                    { name: 'Book Bot', active: true, gridPrice: 'book' },
                ],
            });
        }
        return originalReadFileSync(filePath, encoding);
    };

    const { loadBotsConfigSnapshot } = loadRuntimeWithStubs();
    const snapshot = loadBotsConfigSnapshot();

    assert.strictEqual(snapshot.exists, true, 'bots.json should be detected');
    assert.strictEqual(snapshot.activeBots.length, 2, 'all active bots should be returned');
    assert.strictEqual(snapshot.needsMarketAdapter, true, 'AMA grid pricing should require the market adapter');
    assert.ok(snapshot.fingerprint, 'fingerprint should be populated');
}

async function testWatchdogStartsAdapterWhenMissing() {
    Config.pm_exec_path = '/usr/bin/pm2';
    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
    let started = false;
    let queried = false;
    const logs = [];

    const self = {
        _marketAdapterWatchdogFingerprint: null,
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-1',
            activeBots: [{ name: 'AMA Bot', active: true, gridPrice: 'ama' }],
            needsMarketAdapter: true,
        }),
        _getPm2ProcessNames: async () => {
            queried = true;
            return ['AMA Bot'];
        },
        _startMarketAdapterPm2: async () => {
            started = true;
        },
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.strictEqual(queried, true, 'watchdog should query PM2 when AMA pricing is active');
    assert.strictEqual(started, true, 'watchdog should start the adapter when it is missing');
    assert.strictEqual(result.changed, true, 'first snapshot should be treated as a change');
    assert.strictEqual(result.required, true, 'AMA pricing should require the adapter');
    assert.strictEqual(result.started, true, 'watchdog should report a successful start');
    assert.ok(
        logs.some((msg) => String(msg).includes('Started dexbot-adapter')),
        'watchdog should log the adapter start'
    );
}

async function testWatchdogSkipsLaunchWhenAdapterNotNeeded() {
    Config.pm_exec_path = '/usr/bin/pm2';
    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
    let queried = false;
    let started = false;
    let stopped = false;

    const self = {
        _marketAdapterWatchdogFingerprint: 'old-fingerprint',
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'new-fingerprint',
            activeBots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
            needsMarketAdapter: false,
        }),
        _getPm2ProcessNames: async () => {
            queried = true;
            return ['dexbot-adapter'];
        },
        _startMarketAdapterPm2: async () => {
            started = true;
        },
        _stopMarketAdapterPm2: async () => {
            stopped = true;
        },
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.strictEqual(result.changed, true, 'config fingerprint changes should still be detected');
    assert.strictEqual(result.required, false, 'non-AMA config should not require the adapter');
    assert.strictEqual(queried, true, 'PM2 should be queried so stale adapter processes can be stopped');
    assert.strictEqual(started, false, 'adapter start should be skipped when not needed');
    assert.strictEqual(stopped, true, 'running adapter should be stopped when it is no longer needed');
    assert.strictEqual(result.stopped, true, 'watchdog should report the adapter stop');
}

async function testWatchdogLeavesAdapterStoppedWhenAlreadyAbsent() {
    Config.pm_exec_path = '/usr/bin/pm2';
    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs();
    let stopped = false;

    const self = {
        _marketAdapterWatchdogFingerprint: 'old-fingerprint',
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'new-fingerprint',
            activeBots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
            needsMarketAdapter: false,
        }),
        _getPm2ProcessNames: async () => [],
        _stopMarketAdapterPm2: async () => {
            stopped = true;
        },
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.strictEqual(result.required, false, 'non-AMA config should not require the adapter');
    assert.strictEqual(result.stopped, false, 'watchdog should not stop an adapter that is already absent');
    assert.strictEqual(stopped, false, 'stop should not be attempted when the adapter is already absent');
}

async function testWatchdogUsesDirectRuntimeWithoutPm2() {
    Config.pm_exec_path = undefined;

    const syncCalls = [];
    const releaseCalls = [];
    const fakeRuntime = {
        syncBot: async (botId, shouldRun) => {
            syncCalls.push({ botId, shouldRun });
            return shouldRun
                ? { running: true, owned: true, started: true }
                : { running: false, owned: false, stopped: true };
        },
        releaseBot: async (botId) => {
            releaseCalls.push(botId);
            return { running: false, stopped: true };
        },
    };

    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
        marketAdapterRuntimeStub: {
            getSharedMarketAdapterRuntime: () => fakeRuntime,
        },
    });

    const logs = [];
    const self = {
        _marketAdapterWatchdogFingerprint: null,
        config: {
            botKey: 'xrp-bts-0',
            name: 'XRP-BTS',
            gridPrice: 'ama',
        },
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-2',
            activeBots: [{ name: 'AMA Bot', active: true, gridPrice: 'ama' }],
            needsMarketAdapter: true,
        }),
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.deepStrictEqual(syncCalls, [
        { botId: 'xrp-bts-0', shouldRun: true },
    ], 'direct runtime should be used when PM2 is not active');
    assert.strictEqual(result.mode, 'direct', 'watchdog should report direct mode');
    assert.strictEqual(result.started, true, 'direct runtime should start the adapter when needed');
    assert.strictEqual(releaseCalls.length, 0, 'direct runtime should not release during AMA startup');
    assert.ok(
        logs.some((msg) => String(msg).includes('Started dexbot-adapter')),
        'direct runtime should log the adapter start'
    );
}

async function testWatchdogDoesNotRegisterNonAmaBotInDirectRuntime() {
    Config.pm_exec_path = undefined;

    const syncCalls = [];
    const fakeRuntime = {
        syncBot: async (botId, shouldRun) => {
            syncCalls.push({ botId, shouldRun });
            return { running: true, owned: true, started: false, stopped: false };
        },
        releaseBot: async () => ({ running: true, stopped: false }),
    };

    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
        marketAdapterRuntimeStub: {
            getSharedMarketAdapterRuntime: () => fakeRuntime,
        },
    });

    const self = {
        _marketAdapterWatchdogFingerprint: null,
        config: {
            botKey: 'book-bot-0',
            name: 'Book Bot',
            gridPrice: 'book',
        },
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-ama-elsewhere',
            activeBots: [
                { name: 'AMA Bot', active: true, gridPrice: 'ama' },
                { name: 'Book Bot', active: true, gridPrice: 'book' },
            ],
            needsMarketAdapter: true,
        }),
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.deepStrictEqual(syncCalls, [
        { botId: 'book-bot-0', shouldRun: false },
    ], 'non-AMA direct bot should not be registered as requiring the adapter');
    assert.strictEqual(result.mode, 'direct', 'watchdog should report direct mode');
    assert.strictEqual(result.required, true, 'global snapshot can still require the adapter for another AMA bot');
    assert.strictEqual(result.started, false, 'non-AMA bot should not start the adapter');
}

async function testWatchdogUsesSnapshotEntryWhenRuntimeConfigIsStale() {
    Config.pm_exec_path = undefined;

    const syncCalls = [];
    const fakeRuntime = {
        syncBot: async (botId, shouldRun) => {
            syncCalls.push({ botId, shouldRun });
            return { running: false, owned: false, started: false, stopped: true };
        },
        releaseBot: async () => ({ running: false, stopped: false }),
    };

    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
        marketAdapterRuntimeStub: {
            getSharedMarketAdapterRuntime: () => fakeRuntime,
        },
    });

    const self = {
        _marketAdapterWatchdogFingerprint: null,
        config: {
            botKey: 'xrp-bts-0',
            name: 'XRP-BTS',
            gridPrice: 'ama',
        },
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-runtime-stale',
            activeBots: [{ botKey: 'xrp-bts-0', name: 'XRP-BTS', active: true, gridPrice: 'book' }],
            needsMarketAdapter: false,
        }),
        _log: () => {},
        _warn: () => {},
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.deepStrictEqual(syncCalls, [
        { botId: 'xrp-bts-0', shouldRun: false },
    ], 'live snapshot entry should override stale runtime AMA config');
    assert.strictEqual(result.required, false, 'adapter should no longer be required after current bot leaves AMA pricing');
    assert.strictEqual(result.stopped, true, 'direct runtime should stop after current bot leaves AMA pricing');
}

async function testWatchdogReleasesDirectRuntimeWithoutPm2() {
    Config.pm_exec_path = undefined;

    const syncCalls = [];
    const releaseCalls = [];
    const fakeRuntime = {
        syncBot: async (botId, shouldRun) => {
            syncCalls.push({ botId, shouldRun });
            return { running: false, owned: false, stopped: !shouldRun };
        },
        releaseBot: async (botId) => {
            releaseCalls.push(botId);
            return { running: false, stopped: true };
        },
    };

    const { syncMarketAdapterOnPeriodicConfigCheck } = loadRuntimeWithStubs({
        marketAdapterRuntimeStub: {
            getSharedMarketAdapterRuntime: () => fakeRuntime,
        },
    });

    const logs = [];
    const self = {
        _marketAdapterWatchdogFingerprint: 'old-fingerprint',
        config: {
            botKey: 'xrp-bts-0',
            name: 'XRP-BTS',
        },
        _loadBotsConfigSnapshot: async () => ({
            exists: true,
            fingerprint: 'fingerprint-3',
            activeBots: [{ name: 'Book Bot', active: true, gridPrice: 'book' }],
            needsMarketAdapter: false,
        }),
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    const result = await syncMarketAdapterOnPeriodicConfigCheck(self, 'unit-test');

    assert.deepStrictEqual(syncCalls, [
        { botId: 'xrp-bts-0', shouldRun: false },
    ], 'direct runtime should receive the no-AMA stop request');
    assert.strictEqual(result.mode, 'direct', 'watchdog should report direct mode');
    assert.strictEqual(result.stopped, true, 'direct runtime should stop the adapter when AMA is disabled');
    assert.ok(
        logs.some((msg) => String(msg).includes('Stopped dexbot-adapter')),
        'direct runtime should log the adapter stop'
    );
    assert.strictEqual(releaseCalls.length, 0, 'syncBot should handle the direct stop path');
}

async function testSetupBlockchainFetchIntervalRunsWatchdogBeforeDisabledReturn() {
    Config.pm_exec_path = undefined;
    const { setupBlockchainFetchInterval } = loadRuntimeWithStubs();
    let snapshotChecks = 0;
    const logs = [];

    const self = {
        config: { blockchainFetchIntervalMinutes: 0 },
        manager: null,
        accountId: null,
        _blockchainFetchInterval: null,
        _loadBotsConfigSnapshot: async () => {
            snapshotChecks += 1;
            return {
                exists: true,
                fingerprint: 'startup-fingerprint',
                activeBots: [{ name: 'AMA Bot', active: true, gridPrice: 'ama' }],
                needsMarketAdapter: true,
            };
        },
        _getPm2ProcessNames: async () => ['dexbot-adapter'],
        _startMarketAdapterPm2: async () => {
            throw new Error('should not start when already running');
        },
        _stopBlockchainFetchInterval: () => {},
        _log: (msg) => logs.push(msg),
        _warn: (msg) => logs.push(`WARN:${msg}`),
    };

    setupBlockchainFetchInterval(self);
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(snapshotChecks, 1, 'startup path should run the market adapter watchdog immediately');
    assert.ok(
        logs.some((msg) => String(msg).includes('Blockchain fetch interval disabled')),
        'disabled interval should still log the disabled state after the startup watchdog check'
    );
}

async function main() {
    try {
        await testSnapshotReaderDetectsAMAConfig();
        await testWatchdogStartsAdapterWhenMissing();
        await testWatchdogSkipsLaunchWhenAdapterNotNeeded();
        await testWatchdogLeavesAdapterStoppedWhenAlreadyAbsent();
        await testWatchdogUsesDirectRuntimeWithoutPm2();
        await testWatchdogDoesNotRegisterNonAmaBotInDirectRuntime();
        await testWatchdogUsesSnapshotEntryWhenRuntimeConfigIsStale();
        await testWatchdogReleasesDirectRuntimeWithoutPm2();
        await testSetupBlockchainFetchIntervalRunsWatchdogBeforeDisabledReturn();
        console.log('dexbot maintenance runtime market adapter watchdog tests passed');
    } finally {
        Config.pm_exec_path = undefined;
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
        for (const [modulePath, original] of originals.entries()) {
            restoreCachedModule(modulePath, original);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
