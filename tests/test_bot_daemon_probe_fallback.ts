process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';
// Set BOT_NAME before any module loads so Config.BOT_NAME is populated when
// config.ts is first loaded (via module_cache_stub -> constants.ts ->
// general_settings.ts -> paths.ts -> config.ts). Without this, Config.ARGS is
// empty and bot.ts falls through to runtime.exit(1) before the test can run.
process.env.BOT_NAME = 'AAA-BBB';
const assert = require('assert');
const fs = require('fs');
const { setCachedModule } = require('./helpers/module_cache_stub');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running bot daemon probe fallback tests');

// The signing-key resolution now lives in DaemonKeyStore.resolveSigningKey
// (modules/key_store), which statically imports chain_keys — a compiled ESM
// namespace that cannot be patched via require.cache. The chain_keys mock is
// therefore installed through the loader-hook harness; every other consumer
// here is reached through lazy requires, so plain cache stubs still work.

const botSettingsPath = require.resolve('../modules/bot_settings');
const dexbotClassPath = require.resolve('../modules/dexbot_class');
const gracefulShutdownPath = require.resolve('../modules/graceful_shutdown');
const systemPath = require.resolve('../modules/order/utils/system');
const accountBotsPath = require.resolve('../modules/account_bots');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');

const originalExistsSync = fs.existsSync;
const originalArgv = process.argv.slice();
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

const logs: any[] = [];
const warns: any[] = [];
const errors: any[] = [];

const state = {
    daemonProbeCalls: 0,
    startArgs: null,
    authCalls: 0,
    getKeyCalls: 0,
};

function installStubs() {
    fs.existsSync = (filePath) => {
        if (String(filePath).endsWith('/profiles/bots.json')) {
            return true;
        }
        return originalExistsSync(filePath);
    };

    setCachedModule(botSettingsPath, {
        loadSettingsFile: () => ({
            config: {
                bots: [
                    {
                        name: 'AAA-BBB',
                        active: true,
                        assetA: 'XRP',
                        assetB: 'BTS',
                        preferredAccount: 'xrp-account',
                    },
                ],
            },
        }),
        resolveRawBotEntries: (config) => config?.bots || [],
        selectBotEntry: (config, name) => (config?.bots || []).find((bot) => bot.name === name) || null,
    });

    class StubDEXBot {
    [key: string]: any;
        constructor(config) {
            this.config = config;
        }

        async startWithPrivateKey(privateKey) {
            state.startArgs = privateKey;
            assert.strictEqual(privateKey, 'fallback-private-key', 'bot should fall back to interactive auth when daemon probing fails');
        }

        async shutdown() {}
    }
    (StubDEXBot as any).normalizeBotEntry = (bot, index) => ({
        ...bot,
        botIndex: index,
        botKey: `bot-${index}`,
    });

    setCachedModule(dexbotClassPath, { default: StubDEXBot });
    setCachedModule(gracefulShutdownPath, {
        setupGracefulShutdown: () => {},
        registerCleanup: () => {},
    });
    setCachedModule(systemPath, {
        ensureProfilesDirectory: () => false,
        initializeFeeCache: async () => {},
    });
    setCachedModule(accountBotsPath, {
        main: async () => {},
    });
    setCachedModule(bitsharesClientPath, {
        BitShares: {
            disconnect: () => {},
        },
        setSuppressConnectionLog: () => {},
        waitForConnected: async () => {},
    });

    process.argv = ['node', require.resolve('../bot.js'), 'AAA-BBB'];
    const { Config } = require('../modules/config');
    Config.ARGS = ['AAA-BBB'];
    Config.BOT_NAME = 'AAA-BBB';

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) logs.push(line);
    };
    console.warn = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) warns.push(line);
    };
    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) errors.push(line);
    };
}

function installChainKeysMock() {
    // Mock names must cover every statically imported member used by
    // key_store (resolveSigningKey path) and bot.js (lazy require).
    defineEsmMockAbs(require.resolve('../modules/chain_keys'), [
        'checkKeysFileSecurity',
        'isDaemonReady',
        'isDaemonResponsive',
        'probeAccountInDaemon',
        'createDaemonSigningToken',
        'isDaemonSigningToken',
        'authenticate',
        'resolvePrivateKey',
        'isMasterPasswordFailure',
        'waitForDaemon',
    ], {
        checkKeysFileSecurity: () => {},
        isDaemonReady: () => true,
        isDaemonResponsive: async () => true,
        probeAccountInDaemon: async () => {
            state.daemonProbeCalls += 1;
            throw new Error('daemon unavailable');
        },
        createDaemonSigningToken: () => {
            throw new Error('bot should not create a daemon signing token after a failed probe');
        },
        authenticate: async () => {
            state.authCalls += 1;
            return 'fallback-password';
        },
        resolvePrivateKey: (accountName, masterPassword) => {
            state.getKeyCalls += 1;
            assert.strictEqual(accountName, 'xrp-account', 'bot should request the configured preferred account');
            assert.strictEqual(masterPassword, 'fallback-password', 'bot should use the interactive master password after daemon probing fails');
            return 'fallback-private-key';
        },
        isMasterPasswordFailure: () => false,
        waitForDaemon: async () => {},
    });
}

async function runProbeFallbackStage() {
    // The chain_keys mock MUST be registered before anything else runs: any
    // earlier require of a module that transitively loads the real
    // modules/chain_keys poisons the ESM cache and the loader hook would
    // never be consulted for it. Force-load key_store afterwards so both are
    // cached in their mocked form.
    installChainKeysMock();
    require('../modules/key_store');
    require('../modules/chain_keys');

    installStubs();

    process.on('unhandledRejection', (reason) => {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        console.error('Unhandled rejection in test_bot_daemon_probe_fallback:', reason);
        process.exit(1);
    });

    require('../bot');

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(state.daemonProbeCalls, 1, 'bot should probe the daemon once before falling back');
    assert.strictEqual(state.authCalls, 1, 'bot should fall back to interactive authentication');
    assert.strictEqual(state.getKeyCalls, 1, 'bot should derive the private key after interactive authentication');
    assert.deepStrictEqual(state.startArgs, 'fallback-private-key', 'bot should continue using the raw private key after fallback');
    assert.deepStrictEqual(logs, [], 'bot daemon fallback should not emit info logs');
    assert.deepStrictEqual(warns, [], 'bot daemon fallback should not emit warnings');
    assert.deepStrictEqual(errors, [], 'bot daemon fallback should not emit errors');

    fs.existsSync = originalExistsSync;
    process.argv = originalArgv;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;

    originalConsoleLog('bot daemon probe fallback tests passed');
}

runEsmMockStages(['probe_fallback'], async () => {
    try {
        await runProbeFallbackStage();
    } catch (err) {
        console.log = originalConsoleLog;
        console.error(err);
        process.stderr.write((err && ((err as any).stack || getErrorMessage(err) || String(err))) + '\n');
        process.exit(1);
    }
});
