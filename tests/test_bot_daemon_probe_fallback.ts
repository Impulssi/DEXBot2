process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';
// Set BOT_NAME before any module loads so Config.BOT_NAME is populated when
// config.ts is first loaded (via module_cache_stub -> constants.ts ->
// general_settings.ts -> paths.ts -> config.ts). Without this, Config.ARGS is
// empty and bot.ts falls through to runtime.exit(1) before the test can run.
process.env.BOT_NAME = 'XRP-BTS';
const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running bot daemon probe fallback tests');

const botPath = require.resolve('../bot.js');
const botSettingsPath = require.resolve('../modules/bot_settings');
const dexbotClassPath = require.resolve('../modules/dexbot_class');
const chainKeysPath = require.resolve('../modules/chain_keys');
const gracefulShutdownPath = require.resolve('../modules/graceful_shutdown');
const systemPath = require.resolve('../modules/order/utils/system');
const accountBotsPath = require.resolve('../modules/account_bots');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');

const originalBotModule = require.cache[botPath];
const originalBotSettings = require.cache[botSettingsPath];
const originalDexbotClass = require.cache[dexbotClassPath];
const originalChainKeys = require.cache[chainKeysPath];
const originalGracefulShutdown = require.cache[gracefulShutdownPath];
const originalSystem = require.cache[systemPath];
const originalAccountBots = require.cache[accountBotsPath];
const originalBitsharesClient = require.cache[bitsharesClientPath];
const originalExistsSync = fs.existsSync;
const originalArgv = process.argv.slice();
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

// Pre-emptively handle unhandled rejections from the bot.ts IIFE or any
// stubbed async path so a silent process.exit(1) does not hide the error.
process.on('unhandledRejection', (reason) => {
    // Restore stubs first so the error is visible on stderr.
    if (typeof originalConsoleError === 'function') {
        console.error = originalConsoleError;
    }
    if (typeof originalConsoleLog === 'function') {
        console.log = originalConsoleLog;
    }
    console.error('Unhandled rejection in test_bot_daemon_probe_fallback:', reason);
    process.exit(1);
});

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
    delete require.cache[botPath];

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
                        name: 'XRP-BTS',
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

    setCachedModule(dexbotClassPath, StubDEXBot);
    setCachedModule(chainKeysPath, {
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
        probeAccountInDaemon: async () => {
            state.daemonProbeCalls += 1;
            throw new Error('daemon unavailable');
        },
        createDaemonSigningToken: () => {
            throw new Error('bot should not create a daemon signing token after a failed probe');
        },
        isDaemonReady: () => true,
        isDaemonResponsive: async () => true,
        isMasterPasswordFailure: () => false,
    });
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

    process.argv = ['node', botPath, 'XRP-BTS'];

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

function restoreStubs() {
    fs.existsSync = originalExistsSync;
    process.argv = originalArgv;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;

    restoreCachedModule(botSettingsPath, originalBotSettings);
    restoreCachedModule(dexbotClassPath, originalDexbotClass);
    restoreCachedModule(chainKeysPath, originalChainKeys);
    restoreCachedModule(gracefulShutdownPath, originalGracefulShutdown);
    restoreCachedModule(systemPath, originalSystem);
    restoreCachedModule(accountBotsPath, originalAccountBots);
    restoreCachedModule(bitsharesClientPath, originalBitsharesClient);

    if (originalBotModule) require.cache[botPath] = originalBotModule;
    else delete require.cache[botPath];
}

installStubs();
require('../bot');

(async () => {
    try {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(state.daemonProbeCalls, 1, 'bot should probe the daemon once before falling back');
        assert.strictEqual(state.authCalls, 1, 'bot should fall back to interactive authentication');
        assert.strictEqual(state.getKeyCalls, 1, 'bot should derive the private key after interactive authentication');
        assert.deepStrictEqual(state.startArgs, 'fallback-private-key', 'bot should continue using the raw private key after fallback');
        assert.deepStrictEqual(logs, [], 'bot daemon fallback should not emit info logs');
        assert.deepStrictEqual(warns, [], 'bot daemon fallback should not emit warnings');
        assert.deepStrictEqual(errors, [], 'bot daemon fallback should not emit errors');

        restoreStubs();
        originalConsoleLog('bot daemon probe fallback tests passed');
        process.exit(0);
    } catch (err) {
        // Restore stubs first, then ensure the error is visible regardless
        // of stub state. The second process.stderr.write is a belt-and-suspenders
        // in case the original console.error itself was captured by something
        // before the test saved originalConsoleError.
        restoreStubs();
        console.error(err);
        process.stderr.write((err && (err.stack || err.message || String(err))) + '\n');
        process.exit(1);
    }
})();
