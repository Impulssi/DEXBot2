process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';
const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running dexbot master password failure output tests');

// NOTE: `dexbot start` aliases the persistent unlock launcher (spawns the
// unlock runtime) since commit 42724793. The one-shot in-process runner that
// prints the PM-style master-password failure output and exits 1 is
// `dexbot test` (formerly reached via the `start` alias), so this test
// exercises that command. Launching the real unlock.js here would block the
// suite on live password prompts.

const dexbotPath = require.resolve('../dexbot.js');
const botSettingsPath = require.resolve('../modules/bot_settings');
const dexbotClassPath = require.resolve('../modules/dexbot_class');
const chainKeysPath = require.resolve('../modules/chain_keys');
const gracefulShutdownPath = require.resolve('../modules/graceful_shutdown');
const systemPath = require.resolve('../modules/order/utils/system');
const accountBotsPath = require.resolve('../modules/account_bots');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');

// Import real MasterPasswordError before the chain_keys stub replaces it
const { MasterPasswordError } = require('../modules/chain_keys');

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
const originalConsoleError = console.error;
const originalProcessExit = process.exit;

const logs: any[] = [];
const errors: any[] = [];
const errorCalls: any[] = [];
const suppressCalls: any[] = [];
let exitCode: any = null;

function stripAnsi(text) {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

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

    const masterPasswordError = new Error('Incorrect master password after 3 attempts.');
    masterPasswordError.name = 'MasterPasswordError';
    (masterPasswordError as any).code = MasterPasswordError.code;

    class StubSharedDEXBot {
    [key: string]: any;
        constructor(config) {
            this.config = config;
        }

        async start() {
            throw masterPasswordError;
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

    setCachedModule(dexbotClassPath, StubSharedDEXBot);
    setCachedModule(chainKeysPath, {
        authenticate: async () => 'test-password',
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
        isMasterPasswordFailure: (err) => !!(err && (err.code === MasterPasswordError.code || err.name === 'MasterPasswordError')),
    });
    setCachedModule(gracefulShutdownPath, {
        setupGracefulShutdown: () => {},
        registerCleanup: () => {},
        unregisterCleanup: () => {},
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
    (process as any).exit = ((code: any) => {
        exitCode = code;
    });

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) logs.push(line);
    };
    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        errorCalls.push(line);
        if (line) errors.push(line);
    };
}

function restoreStubs() {
    fs.existsSync = originalExistsSync;
    process.argv = originalArgv;
    process.exit = originalProcessExit;
    console.log = originalConsoleLog;
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

        assert.strictEqual(exitCode, 1, 'dexbot test should exit with code 1 on master password failure');
        assert.ok(suppressCalls.includes(true), 'dexbot startup should suppress BitShares connection logs');
        assert.ok(suppressCalls.includes(false), 'dexbot startup should restore BitShares connection logs after startup');
        assert.ok(errors.some((line) => stripAnsi(line).includes('Incorrect master password after 3 attempts.')), 'dexbot test should match the PM2-style failure output');
        assert.ok(!errors.some((line) => line.includes('Failed to start bot:')), 'dexbot test should not print the generic failure prefix');
        assert.ok(!errors.some((line) => line.includes('Aborting because the master password failed 3 times.')), 'dexbot test should not print the extra abort line');
        assert.ok(logs.includes('Connected to BitShares'), 'dexbot test should still print the connection banner before failure');

        restoreStubs();
        originalConsoleLog('dexbot master password failure output tests passed');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
