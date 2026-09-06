const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');
const { installPm2PathShim } = require('./helpers/pm2_path_shim');

console.log('Running PM2 startup order tests');

// pm2.ts imports `spawn` and chain_keys/credential_bootstrap statically, so
// neither childProcess.spawn replacement nor require.cache entries can
// intercept them on compiled ESM. The chain_keys and bootstrap modules are
// mocked through the loader-hook harness, and the `pm2` binary is replaced by
// a recording PATH shim so spawned commands stay hermetic while still being
// assertable (args + scrubbed child env).

process.env.TEST_PM2_SECRET = 'should-not-leak';
const TEMP_PROFILE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-pm2-order-'));
process.env.DEXBOT_PROFILE_ROOT = TEMP_PROFILE_ROOT;

function writeBotsFixture() {
    fs.writeFileSync(path.join(TEMP_PROFILE_ROOT, 'bots.json'), JSON.stringify({
        bots: [{ name: 'AAA-BBB', active: true }],
    }));
}

function installModuleMocks({ shim }) {
    defineEsmMockAbs(require.resolve('../modules/chain_keys'), [
        'checkKeysFileSecurity',
        'isDaemonReady',
        'isDaemonResponsive',
        'authenticate',
        'unlockWithPassword',
        'waitForDaemon',
    ], {
        checkKeysFileSecurity: () => {},
        isDaemonReady: () => false,
        isDaemonResponsive: async () => false,
        authenticate: async () => 'test-password',
        unlockWithPassword: () => 'test-password',
        waitForDaemon: () => shim.appendMarker('wait-ready-done'),
    });
}

function installPathShim() {
    return installPm2PathShim({
        rules: [
            // `pm2 delete dexbot-cred` before a fresh start reports "not found".
            { action: 'delete', stderr: ['Process or Namespace dexbot-cred not found'], code: 1 },
        ],
    });
}

async function runStartupOrderStage() {
    writeBotsFixture();

    // startManagedRuntimePM2 writes the bootstrap path file next to the
    // credential socket; the real flow creates that runtime dir earlier in
    // ensureCredentialDaemonPM2, which this direct call bypasses.
    const { getCredentialSocketPath } = require('../modules/credential_runtime');
    fs.mkdirSync(path.dirname(getCredentialSocketPath()), { recursive: true });

    const shim = installPathShim();
    try {
        installModuleMocks({ shim });

        const consoleErrors: any[] = [];
        const originalConsoleError = console.error;
        console.error = (...args) => {
            consoleErrors.push(args.join(' '));
        };

        const { startManagedRuntimePM2 } = require('../pm2');

        await startManagedRuntimePM2({
            apps: [{ name: 'AAA-BBB' }],
            bootstrap: {
                socketPath: '/tmp/test-bootstrap.sock',
                waitForTransfer: () => shim.appendMarker('wait-transfer-done'),
            },
        });

        console.error = originalConsoleError;

        const calls = shim.readCalls();
        // Entries are either spawn records ({args,...}) or timeline markers;
        // every index below is taken against the same full timeline array.
        const spawned = calls.filter((call) => call.args);
        const indexInCalls = (predicate) => calls.findIndex(predicate);
        const deleteIndex = indexInCalls((call) => call.args && call.args[0] === 'delete');
        const credSpawn = spawned.find((call) => call.args[0] === 'start' && String(call.args[1]).includes('credential-daemon.js'));
        const appSpawn = spawned.find((call) => call.args[0] === 'start' && String(call.args[1]).includes('ecosystem.config.cjs'));
        const credIndex = indexInCalls((call) => call === credSpawn);
        const transferDoneIndex = indexInCalls((call) => call.marker === 'wait-transfer-done');
        const readyDoneIndex = indexInCalls((call) => call.marker === 'wait-ready-done');
        const appStartIndex = indexInCalls((call) => call === appSpawn);

        assert.ok(credSpawn, 'managed runtime should start the credential daemon via pm2');
        assert.ok(appSpawn, 'managed apps should be started via pm2');
        assert.ok(deleteIndex !== -1 && deleteIndex < credIndex, 'stale dexbot-cred entries should be deleted before the fresh start');
        assert.ok(transferDoneIndex !== -1, 'password transfer should complete');
        assert.ok(readyDoneIndex !== -1, 'daemon readiness wait should complete');
        assert.ok(appStartIndex > transferDoneIndex, 'apps should start after password transfer completes');
        assert.ok(appStartIndex > readyDoneIndex, 'apps should start after daemon readiness completes');
        assert.strictEqual(credSpawn.env.TEST_PM2_SECRET, 'unset', 'credential daemon PM2 launch should not inherit arbitrary parent secrets');
        assert.strictEqual(credSpawn.env.DEXBOT_CRED_BOOTSTRAP_SOCKET, 'unset', 'credential daemon PM2 launch should not receive bootstrap socket env');
        assert.strictEqual(appSpawn.env.TEST_PM2_SECRET, 'unset', 'ecosystem PM2 launch should not inherit arbitrary parent secrets');
        assert.strictEqual(appSpawn.env.DEXBOT_CRED_BOOTSTRAP_SOCKET, 'unset', 'ecosystem PM2 launch should not receive bootstrap env');
        assert.ok(
            !consoleErrors.some((line) => line.includes('Process or Namespace dexbot-cred not found')),
            'missing dexbot-cred should be ignored without logging a PM2 error'
        );

        originalConsoleError('PM2 startup order tests passed');
    } finally {
        shim.restore();
        fs.rmSync(TEMP_PROFILE_ROOT, { recursive: true, force: true });
    }
}

runEsmMockStages(['startup_order'], async () => {
    try {
        await runStartupOrderStage();
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
});
