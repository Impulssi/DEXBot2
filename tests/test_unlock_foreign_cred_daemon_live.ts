const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

console.log('Running foreign credential daemon live kill test');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-foreign-live-'));
const credPidFile = path.join(tmpRoot, 'monolithic-cred.pid');
const socketFile = path.join(tmpRoot, 'dexbot-cred-daemon.sock');
const readyFile = path.join(tmpRoot, 'dexbot-cred-daemon.ready');

// Place the stub at a temp path so we never overwrite any real launcher
// file.  The test then uses the candidate-aware predicate
// `unlock.pidMatchesScriptCandidates(pid, candidates)` with this temp
// path, exercising the SAME algorithm unlock.ts uses for its
// `isLikelyCredentialDaemonProcess` predicate — only with test-supplied
// candidate paths.
const stubSource = path.resolve(__dirname, 'helpers', 'foreign_cred_stub.js');
const stubInstallPath = path.join(tmpRoot, 'credential-daemon.js');
fs.copyFileSync(stubSource, stubInstallPath);
const stubCandidates = new Set([stubInstallPath]);

function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function waitForExit(pid, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            if (!isAlive(pid)) return resolve(true);
            if ((Date.now() - started) >= timeoutMs) return resolve(false);
            setTimeout(tick, 100);
        };
        tick();
    });
}

const helperPath = require.resolve('../modules/launcher/foreign_cred_daemon');
const fcd = require(helperPath);

// Pull in the real unlock.ts so the test uses the production
// candidate-aware predicate helper. We do NOT use the production
// `isLikelyCredentialDaemonProcess` because its candidates are hardcoded
// to the repo root; using the candidate-aware variant lets the test
// pass our temp path and still validate the same algorithm.
const unlock = require('../unlock');
const { unlink: safeUnlink } = require('../modules/storage').getStorage();
if (typeof unlock.pidMatchesScriptCandidates !== 'function') {
    throw new Error('unlock.pidMatchesScriptCandidates is not exported; cannot validate the predicate algorithm');
}
const pidMatchesScriptCandidates = unlock.pidMatchesScriptCandidates;

function launchStub() {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [stubInstallPath],
            {
                env: {
                    ...process.env,
                    DEXBOT_TEST_SOCKET: socketFile,
                    DEXBOT_TEST_READY: readyFile,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );
        let stderrBuf = '';
        child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            reject(new Error(`stub did not open socket in time. stderr=${stderrBuf}`));
        }, 5000);
        const check = () => {
            if (fs.existsSync(socketFile)) {
                clearTimeout(timer);
                resolve(child);
            } else {
                setTimeout(check, 50);
            }
        };
        check();
        child.on('exit', (code) => {
            if (!fs.existsSync(socketFile)) {
                clearTimeout(timer);
                reject(new Error(`stub exited before opening socket (code=${code}). stderr=${stderrBuf}`));
            }
        });
    });
}

async function assertStubIsRecognised(stubPid) {
    // Sanity check: the production candidate-aware predicate helper from
    // unlock.ts must accept the stub as matching the temp path candidate.
    // This is the algorithm the production isLikelyCredentialDaemonProcess
    // predicate uses; we just feed it test-only candidates so we don't
    // need to touch any real launcher file.
    assert.ok(
        pidMatchesScriptCandidates(stubPid, stubCandidates),
        'unlock.pidMatchesScriptCandidates must recognise the stub against the temp candidates'
    );
    // And the predicate should reject the stub when given the production
    // hardcoded candidates (which do not include our temp path).
    const prodCandidates = unlock.candidateRuntimeScriptPaths(['credential-daemon']);
    assert.ok(
        !pidMatchesScriptCandidates(stubPid, prodCandidates),
        'production candidates must not include the temp path'
    );
}

async function runLiveForeignKilledTest() {
    safeUnlink(socketFile)
    safeUnlink(readyFile)
    safeUnlink(credPidFile)

    const stub = await launchStub();
    const stubPid = (stub as any).pid;
    await assertStubIsRecognised(stubPid);
    assert.ok(isAlive(stubPid), 'foreign stub should be running');
    assert.ok(fs.existsSync(socketFile), 'socket file should exist');
    assert.ok(fs.existsSync(readyFile), 'ready file should exist');
    assert.ok(!fs.existsSync(credPidFile), 'cred pid file should not exist');

    const cleaned = await fcd.ensureNoForeignCredentialDaemon({
        socketPath: socketFile,
        readyFilePath: readyFile,
        pidFile: credPidFile,
        isLikelyProcess: (pid) => pidMatchesScriptCandidates(pid, stubCandidates),
        verbose: false,
    });

    assert.strictEqual(cleaned, true, 'foreign daemon should be reported as removed');
    assert.ok(!fs.existsSync(socketFile), 'socket should be removed after foreign kill');
    assert.ok(!fs.existsSync(readyFile), 'ready file should be removed after foreign kill');
    const exited = await waitForExit(stubPid, 5000);
    assert.ok(exited, 'foreign stub should have been killed by the detector');
    assert.ok(!isAlive(stubPid), 'foreign stub PID should no longer be alive');
}

async function runLiveForeignPidMismatchTest() {
    safeUnlink(socketFile)
    safeUnlink(readyFile)
    fs.writeFileSync(credPidFile, '0', { mode: 0o600 });

    const stub = await launchStub();
    const stubPid = (stub as any).pid;
    await assertStubIsRecognised(stubPid);
    assert.ok(isAlive(stubPid), 'foreign stub should be running');

    const cleaned = await fcd.ensureNoForeignCredentialDaemon({
        socketPath: socketFile,
        readyFilePath: readyFile,
        pidFile: credPidFile,
        isLikelyProcess: (pid) => pidMatchesScriptCandidates(pid, stubCandidates),
        verbose: false,
    });

    assert.strictEqual(cleaned, true, 'foreign daemon should be reported as removed even with stale ownership file');
    const exited = await waitForExit(stubPid, 5000);
    assert.ok(exited, 'foreign stub should have been killed');
    assert.ok(!fs.existsSync(credPidFile), 'stale ownership file should be removed');
    assert.ok(!fs.existsSync(socketFile), 'socket should be removed');
    assert.ok(!fs.existsSync(readyFile), 'ready file should be removed');
}

async function runOwnedStubLeftAloneTest() {
    safeUnlink(socketFile)
    safeUnlink(readyFile)
    safeUnlink(credPidFile)

    const stub = await launchStub();
    const stubPid = (stub as any).pid;
    await assertStubIsRecognised(stubPid);
    assert.ok(isAlive(stubPid), 'foreign stub should be running');
    fs.writeFileSync(credPidFile, String(stubPid), { mode: 0o600 });

    const cleaned = await fcd.ensureNoForeignCredentialDaemon({
        socketPath: socketFile,
        readyFilePath: readyFile,
        pidFile: credPidFile,
        isLikelyProcess: (pid) => pidMatchesScriptCandidates(pid, stubCandidates),
        verbose: false,
    });

    assert.strictEqual(cleaned, false, 'owned stub should be left alone');
    assert.ok(isAlive(stubPid), 'owned stub should still be running');
    assert.ok(fs.existsSync(socketFile), 'socket should still be present');
    assert.ok(fs.existsSync(readyFile), 'ready file should still be present');

    try { process.kill(stubPid, 'SIGTERM'); } catch (_) {}
    await waitForExit(stubPid, 2000);
}

async function runSocketWithoutReadyFileTest() {
    // Reproduces Finding 3: a live foreign daemon is still listening on
    // the socket after the ready file was removed. The detector must
    // notice and kill it, even though the ready file is missing.
    safeUnlink(socketFile)
    safeUnlink(readyFile)
    safeUnlink(credPidFile)

    const stub = await launchStub();
    const stubPid = (stub as any).pid;
    await assertStubIsRecognised(stubPid);
    // Simulate the ready file being removed by an external process
    // (e.g. a previous unlock unlinked it).
    safeUnlink(readyFile)
    assert.ok(fs.existsSync(socketFile), 'socket should still be present');
    assert.ok(!fs.existsSync(readyFile), 'ready file should be gone');

    const cleaned = await fcd.ensureNoForeignCredentialDaemon({
        socketPath: socketFile,
        readyFilePath: readyFile,
        pidFile: credPidFile,
        isLikelyProcess: (pid) => pidMatchesScriptCandidates(pid, stubCandidates),
        verbose: false,
    });

    assert.strictEqual(cleaned, true, 'foreign daemon should be killed even when ready file is missing');
    const exited = await waitForExit(stubPid, 5000);
    assert.ok(exited, 'foreign stub should have been killed by the detector');
    assert.ok(!fs.existsSync(socketFile), 'socket should be removed');
}

(async () => {
    try {
        await runLiveForeignKilledTest();
        await runLiveForeignPidMismatchTest();
        await runOwnedStubLeftAloneTest();
        await runSocketWithoutReadyFileTest();

        process.stdout.write('foreign credential daemon live kill test passed\n');
        process.exit(0);
    } catch (err) {
        if (String((err as any)?.message || err).includes('listen EPERM')) {
            console.log('Skipping foreign credential daemon live kill test: Unix socket listen unavailable (EPERM)');
            process.exit(0);
            return;
        }
        console.error(err);
        process.exit(1);
    } finally {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
})();
