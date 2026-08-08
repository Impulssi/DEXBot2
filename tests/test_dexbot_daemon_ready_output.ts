process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';
const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running dexbot daemon-ready output tests');

// NOTE: `dexbot start` aliases the persistent unlock launcher (spawns the
// unlock runtime) since commit 42724793. The one-shot in-process runner that
// skips master-password auth when the then-credential daemon is ready is
// `dexbot test` (formerly reached via the `start` alias), so this test
// exercises that command. Launching the real unlock.js here would block the
// suite on live password prompts (3 failed attempts before abort).

const dexbotPath = require.resolve('../dexbot.js');
const botSettingsPath = require.resolve('../modules/bot_settings');
const dexbotClassPath = require.resolve('../modules/dexbot_class');
const chainKeysPath = require.resolve('../modules/chain_keys');
const gracefulShutdownPath = require.resolve('../modules/graceful_shutdown');
const systemPath = require.resolve('../modules/order/utils/system');
const accountBotsPath = require.resolve('../modules/account_bots');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');

const originalDexbotModule = require.cache[dexbotPath];
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

const logs: any[] = [];
const warns: any[] = [];
const errors: any[] = [];
const suppressCalls: any[] = [];
const state = {
    startArgs: [],
    authCalls: 0,
    daemonProbeCalls: 0,
};

function installStubs() {
    delete require.cache[dexbotPath];

    fs.existsSync = (filePath) => {
        if (String(filePath).endsWith('/profiles/bots.json')) {
            return true;
        }
        return originalExistsSync(filePath);
    };

    setCachedModule(botSettingsPath, {
        collectValidationIssues: () => ({ errors: [], warnings: [] }),
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
        normalizeBotEntries: (entries) => entries.map((entry, index) => ({
            ...entry,
            active: entry.active !== false,
            botIndex: index,
            botKey: `bot-${index}`,
        })),
        resolveRawBotEntries: (config) => config?.bots || [],
        saveSettingsFile: () => {},
    });

    class StubSharedDEXBot {
    [key: string]: any;
        constructor(config) {
            this.config = config;
        }

        async start(masterPassword) {
            state.startArgs.push(masterPassword);
            assert.strictEqual(masterPassword, null, 'dexbot should skip master-password auth when the daemon is ready');
        }

        async shutdown() {}
    }
    (StubSharedDEXBot as any).authenticateWithChainKeys = async () => {};
    (StubSharedDEXBot as any).normalizeBotEntry = (bot, index) => ({
        ...bot,
        active: bot.active !== false,
        botIndex: index,
        botKey: `bot-${index}`,
    });

    setCachedModule(dexbotClassPath, { default: StubSharedDEXBot });
    setCachedModule(chainKeysPath, {
        authenticate: async () => {
            state.authCalls += 1;
            throw new Error('authenticate should not be called when the daemon is ready');
        },
        probeAccountInDaemon: async () => {
            state.daemonProbeCalls += 1;
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
        setSuppressConnectionLog: (value) => {
            suppressCalls.push(value);
        },
        waitForConnected: async () => {},
    });

    process.argv = ['node', dexbotPath, 'test'];

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

    if (originalDexbotModule) require.cache[dexbotPath] = originalDexbotModule;
    else delete require.cache[dexbotPath];
}

installStubs();
require('../dexbot');

(async () => {
    try {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(state.startArgs, [null], 'dexbot test should pass null master password in daemon-ready mode');
        assert.strictEqual(state.authCalls, 0, 'dexbot test should not prompt for the master password when the daemon is ready');
        assert.ok(suppressCalls.includes(true), 'dexbot test should suppress BitShares connection logs');
        assert.ok(suppressCalls.includes(false), 'dexbot test should restore BitShares connection logs after startup');
        assert.ok(!logs.includes('✓ Authentication successful'), 'dexbot test should not print the auth banner when the daemon is ready');
        assert.deepStrictEqual(warns, [], 'dexbot daemon-ready startup should not emit warnings');
        assert.deepStrictEqual(errors, [], 'dexbot daemon-ready startup should not emit errors');

        restoreStubs();
        originalConsoleLog('dexbot daemon-ready output tests passed');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
