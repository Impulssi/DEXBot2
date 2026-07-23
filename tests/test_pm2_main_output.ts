const assert = require('assert');
const Module = require('module');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running PM2 main output tests');

const pm2Path = require.resolve('../pm2');
const bitsharesClientPath = require.resolve('../modules/bitshares_client');
const chainKeysPath = require.resolve('../modules/chain_keys');
const bootstrapPath = require.resolve('../modules/launcher/credential_bootstrap');
const botSettingsPath = require.resolve('../modules/bot_settings');

const originalResolveFilename = Module._resolveFilename;
const originalPm2Module = require.cache[pm2Path];
const originalBitsharesClient = require.cache[bitsharesClientPath];
const originalChainKeys = require.cache[chainKeysPath];
const originalBootstrap = require.cache[bootstrapPath];
const originalBotSettings = require.cache[botSettingsPath];
const originalSpawn = childProcess.spawn;
const originalProcessExit = process.exit;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalStdoutIsTTY = process.stdout.isTTY;
const originalNoColor = process.env.NO_COLOR;

const logs: any[] = [];
const errors: any[] = [];
const spawnCalls: any[] = [];

function setStdoutTTY(value) {
    Object.defineProperty(process.stdout, 'isTTY', {
        value,
        configurable: true,
        writable: true,
    });
}

function resetState() {
    logs.length = 0;
    errors.length = 0;
    spawnCalls.length = 0;
}

function stripAnsi(text) {
    return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function logsIncludePlain(expected) {
    return logs.some((line) => stripAnsi(line) === expected);
}

function installStubs() {
    delete require.cache[pm2Path];

    Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
        if (request === 'pm2') {
            return '/virtual/pm2.js';
        }
        return originalResolveFilename.call(this, request, parent, isMain, options);
    };

    setCachedModule(bitsharesClientPath, {
        waitForConnected: async () => {},
    });

    setCachedModule(chainKeysPath, {
        authenticate: async () => 'test-password',
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
        waitForDaemon: async () => {},
    });

    setCachedModule(bootstrapPath, {
        createPasswordBootstrapServer: async () => ({
            socketPath: '/tmp/bootstrap.sock',
            close() {},
            waitForTransfer: async () => {},
        }),
    });

    setCachedModule(botSettingsPath, {
        loadSettingsFile: () => ({
            config: {
                bots: [
                    { name: 'XRP-BTS', active: true },
                    { name: 'H-BTS', active: true },
                    { name: 'T-BTS', active: true },
                ],
            },
        }),
        selectActiveBotEntries: (config) => (config && Array.isArray(config.bots) ? config.bots.filter((bot) => bot.active !== false) : []),
    });

    childProcess.spawn = (command, args, options) => {
        spawnCalls.push({ command, args, options });

        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};

        const emitStdout = (lines) => {
            process.nextTick(() => {
                for (const line of lines) {
                    child.stdout.emit('data', `${line}\n`);
                }
                child.emit('close', 0);
            });
        };

        process.nextTick(() => {
            if (args[0] === 'delete') {
                child.stderr.emit('data', 'Process or Namespace dexbot-cred not found');
                child.emit('close', 1);
                return;
            }

            if (args[0] === 'start' && String(args[1]).includes('credential-daemon.js')) {
                emitStdout([
                    '[PM2] Starting /root/DEXBot2/credential-daemon.js in fork_mode (1 instance)',
                    '[PM2] Done.',
                    '┌────┬────────────────────┬──────────┬──────┬───────────┬──────────┬──────────┐',
                    '│ id │ name               │ mode     │ ↺    │ status    │ cpu      │ memory   │',
                    '├────┼────────────────────┼──────────┼──────┼───────────┼──────────┼──────────┤',
                    '│ 57 │ dexbot-cred        │ fork     │ 0    │ online    │ 0%       │ 60.7mb   │',
                    '└────┴────────────────────┴──────────┴──────┴───────────┴──────────┴──────────┘',
                ]);
                return;
            }

            if (args[0] === 'start' && String(args[1]).includes('ecosystem.config.js')) {
                emitStdout([
                    '[PM2] cron restart at 0 0 * * *',
                    '[PM2][WARN] Applications XRP-BTS, H-BTS, T-BTS, dexbot-update not running, starting...',
                    '[PM2] App [XRP-BTS] launched (1 instances)',
                    '[PM2] App [H-BTS] launched (1 instances)',
                    '[PM2] App [T-BTS] launched (1 instances)',
                    '[PM2] App [dexbot-update] launched (1 instances)',
                    '┌────┬────────────────────┬──────────┬──────┬───────────┬──────────┬──────────┐',
                    '│ id │ name               │ mode     │ ↺    │ status    │ cpu      │ memory   │',
                    '├────┼────────────────────┼──────────┼──────┼───────────┼──────────┼──────────┤',
                    '│ 58 │ XRP-BTS            │ fork     │ 0    │ online    │ 0%       │ 44.1mb   │',
                    '│ 59 │ H-BTS              │ fork     │ 0    │ online    │ 0%       │ 42.6mb   │',
                    '│ 60 │ T-BTS              │ fork     │ 0    │ online    │ 0%       │ 21.9mb   │',
                    '│ 61 │ dexbot-update      │ fork     │ 0    │ online    │ 0%       │ 26.6mb   │',
                    '└────┴────────────────────┴──────────┴──────┴───────────┴──────────┴──────────┘',
                ]);
                return;
            }

            emitStdout([]);
        });

        return child;
    };

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ');
        if (line.trim()) logs.push(line.trim());
    };

    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ');
        if (line.trim()) errors.push(line.trim());
    };

    process.exit = (code = 0) => {
        const err = new Error(`process.exit(${code})`);
        (err as any).code = 'TEST_PROCESS_EXIT';
        (err as any).exitCode = code;
        throw err;
    };
}

function restoreStubs() {
    Module._resolveFilename = originalResolveFilename;
    childProcess.spawn = originalSpawn;
    process.exit = originalProcessExit;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    setStdoutTTY(originalStdoutIsTTY);
    if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
    } else {
        process.env.NO_COLOR = originalNoColor;
    }

    restoreCachedModule(bitsharesClientPath, originalBitsharesClient);
    restoreCachedModule(chainKeysPath, originalChainKeys);
    restoreCachedModule(bootstrapPath, originalBootstrap);
    restoreCachedModule(botSettingsPath, originalBotSettings);

    if (originalPm2Module) require.cache[pm2Path] = originalPm2Module;
    else delete require.cache[pm2Path];
}

installStubs();

const { main } = require('../pm2');

(async () => {
    try {
        setStdoutTTY(true);
        delete process.env.NO_COLOR;
        await main();

        assert.ok(logsIncludePlain('Connected to BitShares'), 'launcher should still report BitShares connectivity');
        assert.ok(logsIncludePlain('✓ Authentication successful'), 'launcher should still report successful authentication');
        assert.ok(logs.includes('Number active bots: 3'), 'launcher should still report the active bot count');
        assert.ok(logs.includes('Starting PM2 with all services...'), 'launcher should still report PM2 startup');
        assert.ok(logsIncludePlain('DEXBot2 started successfully!'), 'launcher should still print the final success banner');
        assert.ok(logs.includes('If dexbot-cred stops, rerun `dexbot pm2` to unlock it again.'), 'launcher should still print the final advisory');
        assert.ok(!logs.some((line) => line.includes('Connecting to BitShares...')), 'launcher should not print a separate connection banner');
        assert.ok(!logs.some((line) => line.includes('Authenticating master password...')), 'launcher should not print an auth banner');
        assert.ok(!logs.some((line) => line.includes('Ecosystem configuration generated')), 'launcher should not announce ecosystem config generation');
        assert.ok(!logs.some((line) => line.includes('[PM2] Starting /root/DEXBot2/credential-daemon.js')), 'launcher should strip the credential daemon start banner');
        assert.ok(!logs.some((line) => line.includes('[PM2] Done.')), 'launcher should strip the PM2 done banner');
        assert.ok(!logs.some((line) => line.includes('[PM2] cron restart at')), 'launcher should strip cron restart output');
        assert.ok(!logs.some((line) => line.includes('[PM2][WARN] Applications')), 'launcher should strip PM2 not-running warnings');
        assert.ok(!logs.some((line) => line.includes('(1 instances)')), 'launcher should strip PM2 instance counts');
        assert.ok(!logs.some((line) => line.includes('(1 instance)')), 'launcher should strip PM2 instance counts');
        assert.ok(logs.includes('[PM2] App [dexbot-cred] launched'), 'launcher should list the credential daemon launch with other compact PM2 output');
        assert.ok(logs.includes('[PM2] App [XRP-BTS] launched'), 'launcher should keep the app launch line without the instance count');
        assert.ok(logs.includes('[PM2] App [H-BTS] launched'), 'launcher should keep the app launch line without the instance count');
        assert.ok(logs.includes('[PM2] App [T-BTS] launched'), 'launcher should keep the app launch line without the instance count');
        assert.ok(logs.includes('[PM2] App [dexbot-update] launched'), 'launcher should keep the app launch line without the instance count');
        assert.ok(!logs.some((line) => line.startsWith('┌') || line.startsWith('│') || line.startsWith('├') || line.startsWith('└')), 'launcher should strip PM2 table output');
        assert.deepStrictEqual(errors, [], 'launcher should not emit console errors during a normal start');
        assert.ok(spawnCalls.some((call) => call.args[0] === 'start' && String(call.args[1]).includes('ecosystem.config.js')), 'launcher should still start the PM2 ecosystem');

        assert.ok(
            logs.some((line) => line.includes('\x1b[1;92m') && line.includes('Connected to BitShares')),
            'PM2 launcher should color connection success green'
        );
        assert.ok(
            logs.some((line) => line.includes('\x1b[1;92m') && line.includes('✓ Authentication successful')),
            'PM2 launcher should color authentication success green'
        );
        assert.ok(
            logs.some((line) => line.includes('\x1b[1;92m') && line.includes('DEXBot2 started successfully!')),
            'PM2 launcher should color the final success banner green'
        );

        restoreStubs();
        process.stdout.write('PM2 main output tests passed\n');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
