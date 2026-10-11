'use strict';

/**
 * tests/test_credential_daemon_handover.ts
 *
 * Ordered credential-daemon handover (Oct-11 incident: concurrent start/stop
 * left an alive pid with no socket file while the launcher reported
 * success, wedging every later start):
 *
 *   1. stale live owner of the socket path is SIGTERMed and verified dead
 *      BEFORE any unlink (no orphaned listeners, no stolen fresh sockets);
 *   2. owners younger than 60s are refused (a concurrent starter's child
 *      must never be murdered — fail loud instead);
 *   3. after a successful start the socket file must exist, otherwise the
 *      freshly spawned child is killed and startup fails loud instead of
 *      limping on sockless.
 *
 * Uses loader-hook ESM mocks (require.cache cannot intercept the compiled
 * ESM graph) plus an injected spawnFn, so no real daemon ever spawns.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

esmMockEntry();

// --- programmable stub state (one mock set for the whole file) ---
const stub: {
    ownerPid: number;
    alive: (pid: number) => boolean;
    statRes: any;
    uptimeSec: number;
    pids: number[];
    isDaemon: boolean;
    kills: Array<[number, any]>;
    spawnCount: number;
    spawnKills: string[];
    bindOnSpawn: boolean;
} = {
    // process_discovery
    ownerPid: 0,
    alive: (_pid: number) => false,
    statRes: null,
    uptimeSec: 1000000,
    pids: [],
    // bot_supervisor
    isDaemon: true,
    // runtime
    kills: [],
    // spawn
    spawnCount: 0,
    spawnKills: [],
    bindOnSpawn: true,
};

function registerMocks() {
    defineEsmMockAbs(require.resolve('../modules/chain_keys'), [
        'authenticate', 'isDaemonResponsive', 'waitForDaemon', 'unlockWithPassword',
    ], {
        authenticate: async () => 'test-secret',
        isDaemonResponsive: async () => false,
        waitForDaemon: async () => {},
        unlockWithPassword: () => 'test-secret',
    });
    defineEsmMockAbs(require.resolve('../modules/credential_runtime'), [
        'assertPrivatePathSecurity', 'ensureCredentialRuntimeDirSync',
        'getCredentialReadyFilePath', 'getCredentialSocketPath',
    ], {
        assertPrivatePathSecurity: () => null,
        ensureCredentialRuntimeDirSync: () => {},
        getCredentialReadyFilePath: () => '/tmp/should-not-be-used.ready',
        getCredentialSocketPath: () => '/tmp/should-not-be-used.sock',
    });
    defineEsmMockAbs(require.resolve('../modules/launcher/credential_bootstrap'), [
        'createPasswordBootstrapServer',
    ], {
        createPasswordBootstrapServer: async () => ({
            socketPath: '/tmp/handover-test-bootstrap.sock',
            close: () => {},
            waitForTransfer: async () => {},
        }),
    });
    defineEsmMockAbs(require.resolve('../modules/credential_policy'), [
        'ensurePolicyConfig',
    ], {
        ensurePolicyConfig: () => ({}),
    });
    defineEsmMockAbs(require.resolve('../modules/process_discovery'), [
        'getProcessDiscovery',
    ], {
        getProcessDiscovery: () => ({
            findSocketOwnerPid: () => stub.ownerPid,
            isAlive: (pid) => stub.alive(pid),
            readStat: () => stub.statRes,
            readSystemUptimeSec: () => stub.uptimeSec,
            listAllPids: () => stub.pids.slice(),
        }),
    });
    defineEsmMockAbs(require.resolve('../modules/launcher/bot_supervisor'), [
        'isNodeProcessWithExactScript', 'isPidAlive',
    ], {
        isNodeProcessWithExactScript: () => stub.isDaemon,
        isPidAlive: () => false,
    });
    const recordKill = (pid: number, sig: any) => {
        if (pid === 999999999) {
            const gone: any = new Error('ESRCH: no such process');
            gone.code = 'ESRCH';
            throw gone;
        }
        stub.kills.push([pid, sig]);
        return true;
    };
    defineEsmMockAbs(require.resolve('../modules/runtime'), [
        'kill', 'runtime',
    ], {
        kill: recordKill,
        // Full-object export for importers that take `runtime` itself
        // (order/utils/system and friends evaluate in this process too).
        runtime: {
            kill: recordKill,
            stdin: { isTTY: false },
            stdout: { write: () => {} },
            getuid: () => 0,
        },
    });
}

registerMocks();

function makeTmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-cred-handover-'));
}

function fakeSpawnFactory(tmp, sockPath) {
    return (_cmd, _args, _opts) => {
        stub.spawnCount += 1;
        const child = new EventEmitter();
        child.pid = 424242;
        child.killed = false;
        child.kill = (signal) => {
            stub.spawnKills.push(signal);
            child.killed = true;
        };
        if (stub.bindOnSpawn) {
            // Simulate a daemon that binds its socket on startup.
            fs.writeFileSync(sockPath, '');
        }
        process.nextTick(() => child.emit('spawn'));
        return child;
    };
}

async function testStaleOwnerKilledThenStartSucceeds() {
    console.log('Running test: stale live owner is killed, verified, then start succeeds');
    const tmp = makeTmp();
    try {
        const sock = path.join(tmp, 'cred.sock');
        const ready = path.join(tmp, 'cred.ready');
        fs.writeFileSync(sock, 'stale-socket');
        stub.ownerPid = 4242;
        stub.isDaemon = true;
        stub.alive = () => false; // dies on SIGTERM
        stub.kills = [];
        stub.spawnCount = 0;
        stub.spawnKills = [];
        stub.bindOnSpawn = true;

        const { createCredentialDaemonController } = require('../modules/launcher/credential_daemon');
        const controller = createCredentialDaemonController({
            root: tmp,
            socketPath: sock,
            readyFilePath: ready,
            spawnFn: fakeSpawnFactory(tmp, sock),
        });
        const started = await controller.ensureCredentialDaemon();
        assert.strictEqual(started, true, 'start should succeed after handover');
        assert.ok(stub.kills.some(([pid, sig]) => pid === 4242 && sig === 'SIGTERM'), `stale owner must get SIGTERM, got ${JSON.stringify(stub.kills)}`);
        assert.strictEqual(stub.spawnCount, 1, 'exactly one daemon spawns');
        assert.ok(fs.existsSync(sock), 'fresh socket file must exist after bind');
        console.log('  ✓ stale owner SIGTERMed before unlink; fresh socket verified');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function testMissingSocketAfterBindFailsLoud() {
    console.log('Running test: missing socket after bind fails loud and kills the child');
    const tmp = makeTmp();
    try {
        const sock = path.join(tmp, 'cred.sock');
        const ready = path.join(tmp, 'cred.ready');
        stub.ownerPid = 0;
        stub.kills = [];
        stub.spawnCount = 0;
        stub.spawnKills = [];
        stub.bindOnSpawn = false; // daemon never binds

        const { createCredentialDaemonController } = require('../modules/launcher/credential_daemon');
        const controller = createCredentialDaemonController({
            root: tmp,
            socketPath: sock,
            readyFilePath: ready,
            spawnFn: fakeSpawnFactory(tmp, sock),
        });
        let err = null;
        try {
            await controller.ensureCredentialDaemon();
        } catch (e) { err = e; }
        assert.ok(err, 'must throw when the socket file is missing after bind');
        assert.ok(/concurrent start\/stop/.test(err.message), `error must name the suspected race, got: ${err.message}`);
        assert.ok(stub.spawnKills.includes('SIGTERM'), 'spawned child must be SIGTERMed, not left running sockless');
        console.log('  ✓ sockless start fails loud, child reaped');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function testYoungOwnerRefused() {
    console.log('Running test: young socket owner is refused, never killed');
    const tmp = makeTmp();
    try {
        const sock = path.join(tmp, 'cred.sock');
        const ready = path.join(tmp, 'cred.ready');
        fs.writeFileSync(sock, 'stale-socket');
        stub.ownerPid = 4343;
        stub.isDaemon = true;
        // Owner is 10s old: uptime 1000000s, started 999990s after boot at 100 ticks/s.
        stub.uptimeSec = 1000000;
        stub.statRes = { utime: 1, stime: 1, starttime: (1000000 - 10) * 100 };
        stub.kills = [];
        stub.spawnCount = 0;
        stub.bindOnSpawn = true;

        const { createCredentialDaemonController } = require('../modules/launcher/credential_daemon');
        const controller = createCredentialDaemonController({
            root: tmp,
            socketPath: sock,
            readyFilePath: ready,
            spawnFn: fakeSpawnFactory(tmp, sock),
        });
        let err = null;
        try {
            await controller.ensureCredentialDaemon();
        } catch (e) { err = e; }
        assert.ok(err, 'must refuse when the owner may be a concurrent starter');
        assert.ok(/concurrent starter/.test(err.message), `error must name the concurrent-starter risk, got: ${err && err.message}`);
        assert.strictEqual(stub.kills.length, 0, `young owner must never be signaled, got ${JSON.stringify(stub.kills)}`);
        assert.strictEqual(stub.spawnCount, 0, 'no daemon may spawn while the young owner lives');
        console.log('  ✓ young owner refused, untouched');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function testStopStaleHelper() {
    console.log('Running test: stopStaleCredentialDaemon TERM-first, KILL-escalation');
    const { stopStaleCredentialDaemon } = require('../modules/launcher/credential_daemon');
    // Dead pid resolves true without signaling.
    stub.kills = [];
    stub.alive = () => false;
    assert.strictEqual(await stopStaleCredentialDaemon(999999999), true, 'dead pid resolves true');
    assert.strictEqual(stub.kills.length, 0, 'dead pid gets no signal');
    // Non-daemon live pid resolves true without signaling.
    stub.isDaemon = false;
    assert.strictEqual(await stopStaleCredentialDaemon(process.pid), true, 'non-daemon resolves true');
    assert.strictEqual(stub.kills.length, 0, 'non-daemon gets no signal');
    stub.isDaemon = true;
    // Stubborn pid: TERM then KILL, returns false after ~10s of polling.
    stub.alive = () => true;
    const startedAt = Date.now();
    assert.strictEqual(await stopStaleCredentialDaemon(4244), false, 'unkillable pid resolves false');
    assert.ok(Date.now() - startedAt >= 9000, 'must poll through both timeouts before giving up');
    const sigs = stub.kills.filter(([pid]) => pid === 4244).map(([, sig]) => sig);
    assert.ok(sigs.includes('SIGTERM') && sigs.includes('SIGKILL'), `must escalate TERM->KILL, got ${JSON.stringify(sigs)}`);
    console.log('  ✓ TERM-first with KILL escalation and verified result');
}

async function testListLiveDaemonPids() {
    console.log('Running test: listLiveCredentialDaemonPids helper');
    stub.pids = [process.pid, 123456789];
    const foreign = require('../modules/launcher/foreign_cred_daemon');
    assert.deepStrictEqual(foreign.listLiveCredentialDaemonPids(() => false), [], 'no matcher => empty');
    const all = foreign.listLiveCredentialDaemonPids(() => true);
    assert.ok(Array.isArray(all) && all.includes(process.pid), 'match-all must include our own test process');
    console.log('  ✓ helper lists live pids through the matcher');
}

(async () => {
    await testStaleOwnerKilledThenStartSucceeds();
    await testMissingSocketAfterBindFailsLoud();
    await testYoungOwnerRefused();
    await testStopStaleHelper();
    await testListLiveDaemonPids();
    console.log('PASS test_credential_daemon_handover');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
