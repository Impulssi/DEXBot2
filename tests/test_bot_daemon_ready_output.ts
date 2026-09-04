process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';
const assert = require('assert');
const fs = require('fs');
const { setCachedModule } = require('./helpers/module_cache_stub');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');

console.log('Running bot daemon-ready output tests');

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
    startArgs: null,
    daemonProbeCalls: 0,
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
            assert.deepStrictEqual(privateKey, {
                kind: 'dexbot-daemon-signing-token',
                accountName: 'xrp-account',
                socketPath: '/tmp/dexbot-cred-daemon.sock',
            }, 'bot should receive a daemon signing token instead of a raw key');
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
        createDaemonSigningToken: (accountName) => ({
            kind: 'dexbot-daemon-signing-token',
            accountName,
            socketPath: '/tmp/dexbot-cred-daemon.sock',
        }),
        isDaemonSigningToken: (value) => Boolean(value && value.kind === 'dexbot-daemon-signing-token'),
        probeAccountInDaemon: async () => {
            state.daemonProbeCalls += 1;
        },
        authenticate: () => {
            throw new Error('authenticate should not be called when the daemon is ready');
        },
        resolvePrivateKey: () => {
            throw new Error('getPrivateKey should not be called in daemon-ready mode');
        },
        isMasterPasswordFailure: () => false,
        waitForDaemon: async () => {},
    });
}

async function runDaemonReadyStage() {
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
        console.error('Unhandled rejection in test_bot_daemon_ready_output:', reason);
        process.exit(1);
    });

    require('../bot');

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(state.startArgs, {
        kind: 'dexbot-daemon-signing-token',
        accountName: 'xrp-account',
        socketPath: '/tmp/dexbot-cred-daemon.sock',
    }, 'bot startup should pass the daemon signing token to the bot');
    assert.strictEqual(state.daemonProbeCalls, 1, 'bot startup should probe the daemon before using the signing token');
    assert.deepStrictEqual(logs, [], 'bot daemon-ready startup should not emit info logs');
    assert.deepStrictEqual(warns, [], 'bot daemon-ready startup should not emit warnings');
    assert.deepStrictEqual(errors, [], 'bot daemon-ready startup should not emit errors');

    fs.existsSync = originalExistsSync;
    process.argv = originalArgv;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;

    originalConsoleLog('bot daemon-ready output tests passed');
}

runEsmMockStages(['daemon_ready'], async () => {
    try {
        await runDaemonReadyStage();
    } catch (err) {
        console.log = originalConsoleLog;
        console.error(err);
        process.stderr.write(`TEST FAILURE: ${err && (err as any).stack ? (err as any).stack : err}\n`);
        process.stderr.write(`LOGS: ${JSON.stringify(logs)}\n`);
        process.stderr.write(`WARNS: ${JSON.stringify(warns)}\n`);
        process.stderr.write(`ERRORS: ${JSON.stringify(errors)}\n`);
        process.exit(1);
    }
});
