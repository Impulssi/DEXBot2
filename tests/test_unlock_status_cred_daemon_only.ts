// Config.ts snapshots process.env at module-load, so the profile-root override
// MUST be set on the very first line before any require(). We point it at a
// temp dir whose monolithic-cred.pid declares a live stub daemon PID, so the
// credential-daemon-only status path runs without touching the real profiles.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credstat-'));
const STUB_PID = 123456;
fs.mkdirSync(path.join(tmpRoot, 'run'), { recursive: true });
process.env.DEXBOT_PROFILE_ROOT = tmpRoot;
process.env.DEXBOT_CRED_RUNTIME_DIR = path.join(tmpRoot, 'run');

// Declare the daemon pid (monolithic.pid absent => monolithic wrapper stopped).
fs.writeFileSync(path.join(tmpRoot, 'monolithic-cred.pid'), String(STUB_PID), { mode: 0o600 });

const assert = require('assert');
const { setCachedModule, restoreCachedModule } = require('./helpers/module_cache_stub');
const { stripAnsi } = require('./helpers/unlock_test_helpers');

console.log('Running unlock status (credential-daemon-only, monolithic stopped) tests');

const botSupervisorPath = require.resolve('../modules/launcher/bot_supervisor');
const monolithicRuntimePath = require.resolve('../modules/launcher/monolithic_runtime');
const statusReportingPath = require.resolve('../modules/launcher/status_reporting');

const realBotSupervisor = require(botSupervisorPath);
const realMonolithicRuntime = require(monolithicRuntimePath);
const realStatusReporting = require(statusReportingPath);

const originalBotSupervisor = setCachedModule(botSupervisorPath, {
    ...realBotSupervisor,
    isPidAlive: (pid) => pid === STUB_PID,
    readMarketAdapterLockPid: () => 0,
    usesAmaGridPrice: () => false,
});

const originalMonolithicRuntime = setCachedModule(monolithicRuntimePath, {
    ...realMonolithicRuntime,
    isLikelyCredentialDaemonProcess: (pid) => pid === STUB_PID,
    findCredentialSocketOwnerPid: () => 0,
    readLiveMonolithicPid: () => ({ pid: 0, stale: false }),
    listConfiguredBots: () => [],
    readCredentialDaemonStatus: async () => ({ alive: true, ready: true, socket: true }),
});

const originalStatusReporting = setCachedModule(statusReportingPath, {
    ...realStatusReporting,
    readProcUptime: () => '1d 2h',
    readProcMemMB: () => '40MB',
    readProcCpuPercent: async () => '0.0%',
    readProcCpuTime: () => '0.0s',
});

const unlock = require('../unlock');

const logs: any[] = [];
const errors: any[] = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
    const line = args.map((part) => String(part)).join(' ').trim();
    if (line) logs.push(line);
};
console.error = (...args) => {
    const line = args.map((part) => String(part)).join(' ').trim();
    if (line) errors.push(line);
};

function has(needle) {
    return logs.some((line) => stripAnsi(line).includes(needle));
}

function cleanup() {
    restoreCachedModule(botSupervisorPath, originalBotSupervisor);
    restoreCachedModule(monolithicRuntimePath, originalMonolithicRuntime);
    restoreCachedModule(statusReportingPath, originalStatusReporting);
    delete process.env.DEXBOT_PROFILE_ROOT;
    delete process.env.DEXBOT_CRED_RUNTIME_DIR;
    console.log = originalLog;
    console.error = originalError;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
}

(async () => {
    try {
        await unlock.main({ argv: ['node', 'unlock', 'status'], startupGraceMs: 0 });

        // The live-daemon branch should render the daemon status block alongside
        // a note that the monolithic runtime (bots + adapter) is stopped.
        assert.ok(has('Monolithic bot'), 'should render the Monolithic bot section header');
        assert.ok(has('(offline)'), 'should note the monolithic runtime is offline');
        assert.ok(has('Credential daemon:'), 'should render the Credential daemon section');
        assert.ok(has('Alive: yes'), 'should report the daemon alive');
        assert.ok(has('Ready: yes'), 'should report the daemon ready');
        assert.ok(has('Market adapter:'), 'should render the Market adapter section');
        assert.strictEqual(errors.length, 0, 'should not emit errors for the credential-only status');

        cleanup();
        process.stdout.write('unlock status (credential-only) tests passed\n');
        process.exit(0);
    } catch (err) {
        cleanup();
        console.error(err);
        console.error('Captured logs:', logs);
        process.exit(1);
    }
})();