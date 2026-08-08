const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running PM2 stop/delete all tests');

const pm2Path = require.resolve('../pm2');
const botSettingsPath = require.resolve('../modules/bot_settings');
const ecosystemConfigPath = path.join(__dirname, '..', 'profiles', 'ecosystem.config.cjs');

const originalPm2Module = require.cache[pm2Path];
const originalBotSettings = require.cache[botSettingsPath];
const originalSpawn = childProcess.spawn;
const originalExistsSync = fs.existsSync;
const originalLog = console.log;
const originalWarn = console.warn;

const calls: any[] = [];
const logs: any[] = [];
const warnings: any[] = [];

let scenario = 'output';

function makePm2Child() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    return child;
}

function emitLines(child, lines) {
    process.nextTick(() => {
        for (const line of lines) {
            child.stdout.emit('data', `${line}\n`);
        }
        child.emit('close', 0);
    });
}

function resetCaptured() {
    calls.length = 0;
    logs.length = 0;
    warnings.length = 0;
}

function installStubs() {
    delete require.cache[pm2Path];

    setCachedModule(botSettingsPath, {
        loadSettingsFile: () => {
            if (scenario === 'warn') {
                throw new Error('malformed bots.json');
            }
            return {
                config: {
                    bots: [
                        { name: 'XRP-BTS', active: true },
                        { name: 'H-BTS', active: true },
                        { name: 'T-BTS', active: true },
                    ],
                },
            };
        },
        selectActiveBotEntries: (config) => (config && Array.isArray(config.bots) ? config.bots.filter((bot) => bot.active !== false) : []),
    });

    childProcess.spawn = (_command, args) => {
        calls.push(args);
        const child = makePm2Child();
        const action = args[0];
        const target = String(args[1] || '');

        if (scenario === 'output' && target === ecosystemConfigPath && (action === 'stop' || action === 'delete')) {
            const actionVerb = action === 'stop' ? 'stopProcessId' : 'deleteProcessId';
            emitLines(child, [
                `[PM2] Applying action ${actionVerb} on app [XRP-BTS, H-BTS, T-BTS, dexbot-update](ids: [ 63, 64, 65, 66 ])`,
                '[PM2] [H-BTS](64) ✓',
                '[PM2] [XRP-BTS](63) ✓',
                '[PM2] [dexbot-update](66) ✓',
                '[PM2] [T-BTS](65) ✓',
                '┌────┬────────────────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐',
                '│ id │ name           │ namespace   │ version │ mode    │ pid      │ uptime │ ↺    │ status    │ cpu      │ mem      │ user     │ watching │',
                '└────┴────────────────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘',
            ]);
            return child;
        }

        process.nextTick(() => child.emit('close', 0));
        return child;
    };

    fs.existsSync = (targetPath) => {
        if (String(targetPath).endsWith('profiles/ecosystem.config.cjs')) return scenario === 'output';
        if (String(targetPath).endsWith('profiles/bots.json')) return true;
        if (String(targetPath).endsWith('profiles/logs')) return true;
        return originalExistsSync(targetPath);
    };

    console.log = (...args) => {
        logs.push(args.map((part) => String(part)).join(' '));
    };

    console.warn = (...args) => {
        warnings.push(args.map((part) => String(part)).join(' '));
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    fs.existsSync = originalExistsSync;
    console.log = originalLog;
    console.warn = originalWarn;

    restoreCachedModule(botSettingsPath, originalBotSettings);

    if (originalPm2Module) require.cache[pm2Path] = originalPm2Module;
    else delete require.cache[pm2Path];
}

installStubs();

const { deletePM2Processes, stopPM2Processes } = require('../pm2');

(async () => {
    try {
        scenario = 'output';

        resetCaptured();
        await stopPM2Processes('all');
        assert.deepStrictEqual(
            logs,
            [
                'Stopping PM2 processes: all',
                '',
                '[PM2] [H-BTS](64) ✓',
                '[PM2] [XRP-BTS](63) ✓',
                '[PM2] [dexbot-update](66) ✓',
                '[PM2] [T-BTS](65) ✓',
                '',
                'All dexbot PM2 processes stopped.',
            ],
            'stop all should emit the compact ordered PM2 output'
        );
        assert.deepStrictEqual(
            calls.map((args) => [args[0], args[1]]),
            [
                ['stop', 'dexbot-cred'],
                ['stop', ecosystemConfigPath],
            ],
            'stop all should act on dexbot-cred first (safety-stop) and then the managed ecosystem'
        );
        assert.deepStrictEqual(warnings, [], 'stop all should not warn in the normal path');

        resetCaptured();
        await deletePM2Processes('all');
        assert.deepStrictEqual(
            logs,
            [
                'Deleting PM2 processes: all',
                '',
                '[PM2] [H-BTS](64) ✓',
                '[PM2] [XRP-BTS](63) ✓',
                '[PM2] [dexbot-update](66) ✓',
                '[PM2] [T-BTS](65) ✓',
                '',
                'All dexbot PM2 processes deleted.',
            ],
            'delete all should emit the compact ordered PM2 output'
        );
        assert.deepStrictEqual(
            calls.map((args) => [args[0], args[1]]),
            [
                ['delete', 'dexbot-cred'],
                ['delete', ecosystemConfigPath],
            ],
            'delete all should act on dexbot-cred first (safety-stop) and then the managed ecosystem'
        );
        assert.deepStrictEqual(warnings, [], 'delete all should not warn in the normal path');

        scenario = 'warn';

        resetCaptured();
        await stopPM2Processes('all');
        await deletePM2Processes('all');

        assert.deepStrictEqual(
            calls.map((args) => [args[0], args[1]]),
            [
                ['stop', 'dexbot-cred'],
                ['delete', 'dexbot-cred'],
            ],
            'all-target stop/delete should still act on dexbot-cred when bots.json is malformed'
        );
        assert.ok(
            warnings.some((message) => message.includes('Skipping managed bot stop')),
            'stop all should warn when managed bot config regeneration fails'
        );
        assert.ok(
            warnings.some((message) => message.includes('Skipping managed bot delete')),
            'delete all should warn when managed bot config regeneration fails'
        );

        restoreStubs();
        console.log('PM2 stop/delete all tests passed');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
