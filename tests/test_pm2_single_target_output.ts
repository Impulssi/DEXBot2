const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { installPm2PathShim } = require('./helpers/pm2_path_shim');

console.log('Running PM2 single-target output tests');

// pm2.ts imports { spawn }, bot_settings, bots_file_lock and chain_keys
// statically, so neither childProcess.spawn replacement nor require.cache
// entries can intercept them on compiled ESM (the ESM loader never consults
// require.cache). The test is therefore hermetic — it runs without any
// proprietary profiles/bots.json state:
//   - bots.json validation runs against a temp DEXBOT_PROFILE_ROOT fixture
//   - the `pm2` binary is replaced by a recording PATH shim
//   - chain_keys.isDaemonResponsive is mocked through the loader-hook
//     harness so single-bot restart reuses the daemon without unlock I/O

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

const targetBot = 'AAA-BBB';

function makeTempProfileRoot() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-pm2-single-'));
    process.env.DEXBOT_PROFILE_ROOT = tempRoot;
    return tempRoot;
}

function writeBotsFixture(tempRoot) {
    fs.writeFileSync(path.join(tempRoot, 'bots.json'), JSON.stringify({
        bots: [
            { name: targetBot, active: true },
        ],
    }));
}

function pm2NoiseLines(actionVerb) {
    return [
        `[PM2] Applying action ${actionVerb} on app [${targetBot}](ids: [ 63 ])`,
        `[PM2] [${targetBot}](63) ✓`,
        '[PM2] Done.',
        '┌────┬────────────────┬──────────┐',
        '│ id │ name           │ status   │',
        '└────┴────────────────┴──────────┘',
    ];
}

async function runSingleTargetStage() {
    const tempRoot = makeTempProfileRoot();
    const shim = installPm2PathShim({
        rules: [
            { action: 'stop', targetIncludes: targetBot, stdout: pm2NoiseLines('stopProcessId') },
            { action: 'delete', targetIncludes: targetBot, stdout: pm2NoiseLines('deleteProcessId') },
            { action: 'restart', targetIncludes: targetBot, stdout: pm2NoiseLines('restartProcessId') },
        ],
    });

    const logs: any[] = [];
    const warnings: any[] = [];
    const errors: any[] = [];

    try {
        writeBotsFixture(tempRoot);

        // Single-bot restart takes the daemon-reuse path only when the
        // credential daemon answers; mock the probe so the stage stays
        // offline and never reaches the interactive unlock.
        defineEsmMockAbs(require.resolve('../modules/chain_keys'), [
            'authenticate',
            'checkKeysFileSecurity',
            'isDaemonResponsive',
            'unlockWithPassword',
            'waitForDaemon',
        ], {
            authenticate: async () => { throw new Error('authenticate must not run in single-target tests'); },
            checkKeysFileSecurity: () => {},
            isDaemonResponsive: async () => true,
            unlockWithPassword: () => { throw new Error('unlockWithPassword must not run in single-target tests'); },
            waitForDaemon: async () => {},
        });

        // modules/paths first (one-time relocation notices go to the real
        // console), then capture for the assertions.
        require('../modules/paths');
        console.log = (...args) => { logs.push(args.map((part) => String(part)).join(' ')); };
        console.warn = (...args) => { warnings.push(args.map((part) => String(part)).join(' ')); };
        console.error = (...args) => { errors.push(args.map((part) => String(part)).join(' ')); };

        const { deletePM2Processes, restartPM2Processes, stopPM2Processes } = require('../pm2');

        await stopPM2Processes(targetBot);
        assert.deepStrictEqual(
            logs,
            [
                `Stopping PM2 processes: ${targetBot}`,
                `[PM2] [${targetBot}](63) ✓`,
                `PM2 process '${targetBot}' stopped.`,
            ],
            'single-target stop should emit compact PM2 output without table noise'
        );
        assert.deepStrictEqual(errors, [], 'single-target stop should not write stderr on success');

        logs.length = 0;
        await deletePM2Processes(targetBot);
        assert.deepStrictEqual(
            logs,
            [
                `Deleting PM2 processes: ${targetBot}`,
                `[PM2] [${targetBot}](63) ✓`,
                `PM2 process '${targetBot}' deleted.`,
            ],
            'single-target delete should emit compact PM2 output without the config advisory'
        );
        assert.deepStrictEqual(errors, [], 'single-target delete should not write stderr on success');

        logs.length = 0;
        await restartPM2Processes(targetBot);
        assert.deepStrictEqual(
            logs,
            [
                `Restarting PM2 processes: ${targetBot}`,
                `[PM2] [${targetBot}](63) ✓`,
                `PM2 process '${targetBot}' restarted.`,
            ],
            'single-target restart should emit compact PM2 output without helper noise when dexbot-cred is already ready'
        );
        assert.deepStrictEqual(errors, [], 'single-target restart should not write stderr on success');

        assert.deepStrictEqual(
            shim.readCalls().filter((call) => call.args).map((call) => [call.args[0], call.args[1]]),
            [
                ['stop', targetBot],
                ['delete', targetBot],
                ['restart', targetBot],
            ],
            'each single-target action should invoke pm2 exactly once for the bot'
        );
        assert.deepStrictEqual(warnings, [], 'single-target actions should not warn on the happy path');

        console.log = originalConsoleLog;
        originalConsoleLog('PM2 single-target output tests passed');
    } finally {
        console.log = originalConsoleLog;
        console.warn = originalConsoleWarn;
        console.error = originalConsoleError;
        shim.restore();
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

runEsmMockStages(['single_target'], async (stage: string) => {
    try {
        if (stage === 'single_target') {
            await runSingleTargetStage();
        } else {
            throw new Error(`Unknown stage: ${stage}`);
        }
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
});
