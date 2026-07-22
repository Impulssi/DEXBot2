process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';
const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running bot startup output tests');

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

const logs: any[] = [];
const warns: any[] = [];
const errors: any[] = [];
let startCalled = false;

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
            startCalled = true;
            assert.strictEqual(privateKey, 'private-key', 'bot should receive the decrypted private key');
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
        authenticate: async () => 'test-password',
        resolvePrivateKey: () => 'private-key',
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
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
    const { Config } = require('../modules/config');
    Config.ARGS = ['XRP-BTS'];
    Config.BOT_NAME = 'XRP-BTS';

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
        await new Promise((resolve) => {
            const check = () => {
                if (startCalled) resolve(undefined);
                else setImmediate(check);
            };
            check();
        });

        await new Promise((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(logs, [], 'bot startup should not emit info logs');
        assert.deepStrictEqual(warns, [], 'bot startup should not emit warnings');
        assert.deepStrictEqual(errors, [], 'bot startup should not emit errors');

        restoreStubs();
        originalConsoleLog('bot startup output tests passed');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
