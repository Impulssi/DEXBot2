process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';
const assert = require('assert');
const fs = require('fs');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running dexbot startup output tests');

// NOTE: `dexbot start` aliases the persistent unlock launcher (spawns the
// unlock runtime) since commit 42724793. The one-shot in-process runner with
// the launcher banner ("DEXBot2 Start Launcher", connection/auth colors) is
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
const originalStdoutIsTTY = process.stdout.isTTY;
const originalNoColor = process.env.NO_COLOR;
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

const logs: any[] = [];
const warns: any[] = [];
const errors: any[] = [];
const suppressCalls: any[] = [];
let startCalled = false;

function setStdoutTTY(value) {
    Object.defineProperty(process.stdout, 'isTTY', {
        value,
        configurable: true,
        writable: true,
    });
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

    class StubSharedDEXBot {
    [key: string]: any;
        constructor(config) {
            this.config = config;
        }

        async start(masterPassword) {
            startCalled = true;
            assert.strictEqual(masterPassword, 'test-password', 'dexbot should pass the authenticated master password to bot instances');
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
        authenticate: async () => 'test-password',
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

    setStdoutTTY(originalStdoutIsTTY);
    if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
    } else {
        process.env.NO_COLOR = originalNoColor;
    }
}

async function runStartupColorTest() {
    resetLogs();
    setStdoutTTY(true);
    delete process.env.NO_COLOR;

    installStubs();
    require('../dexbot');

    await new Promise((resolve) => {
        const check = () => {
            if (startCalled) resolve(undefined);
            else setImmediate(check);
        };
        check();
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(logs.includes('Active bots:'), 'dexbot test should print the active-bot summary header');
    assert.ok(
        logs.some((line) => line.includes('\x1b[1;92m') && line.includes('XRP-BTS')),
        'dexbot test should color active bot names green'
    );
    assert.ok(
        logs.some((line) => line.includes('\x1b[1;92m') && line.includes('Connected to BitShares')),
        'dexbot test should color connection success green'
    );
    assert.ok(
        logs.some((line) => line.includes('\x1b[1;92m') && line.includes('✓ Authentication successful')),
        'dexbot test should color authentication success green'
    );
    assert.ok(
        logs.some((line) => line.includes('\x1b[1;92m') && line.includes('DEXBot2 started successfully!')),
        'dexbot test should color the final success footer green'
    );
}

function resetLogs() {
    logs.length = 0;
    warns.length = 0;
    errors.length = 0;
    suppressCalls.length = 0;
    startCalled = false;
}

installStubs();
require('../dexbot');

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

        assert.ok(suppressCalls.includes(true), 'dexbot test should suppress BitShares connection logs');
        assert.ok(suppressCalls.includes(false), 'dexbot test should restore BitShares connection logs after startup');
        assert.ok(logs.includes('DEXBot2 Start Launcher'), 'dexbot test should print a launcher title');
        assert.ok(logs.includes('Starting all bots'), 'dexbot test should print the selected launch mode');
        assert.ok(logs.includes('Connected to BitShares'), 'dexbot test should print BitShares connection status');
        assert.ok(logs.includes('✓ Authentication successful'), 'dexbot test should confirm successful authentication');
        assert.ok(logs.includes('Number active bots: 1'), 'dexbot test should print the active bot count');
        assert.ok(logs.includes('Starting bot runtime...'), 'dexbot test should print the runtime transition');
        assert.ok(logs.includes('DEXBot2 started successfully!'), 'dexbot test should print a success footer');
        assert.ok(logs.includes('If the bots stop, rerun `dexbot unlock`.'), 'dexbot test should print the restart hint');
        assert.deepStrictEqual(logs.filter((line) => line.startsWith('┌') || line.startsWith('│') || line.startsWith('├') || line.startsWith('└')), [], 'dexbot test should not emit PM2-style tables');
        assert.ok(!logs.some((line) => line.includes('Connecting to BitShares...')), 'dexbot test should not print a separate connection banner');
        assert.ok(!logs.some((line) => line.includes('Authenticating master password...')), 'dexbot test should not print an auth banner');
        assert.deepStrictEqual(warns, [], 'dexbot test should not emit warnings');
        assert.deepStrictEqual(errors, [], 'dexbot test should not emit errors');

        await runStartupColorTest();
        restoreStubs();
        originalConsoleLog('dexbot startup output tests passed');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
