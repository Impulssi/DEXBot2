const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { unlink: safeUnlink } = require('../modules/storage').getStorage();

console.log('Running foreign credential daemon detection tests');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-foreign-test-'));
const credPidFile = path.join(tmpRoot, 'monolithic-cred.pid');
const socketFile = path.join(tmpRoot, 'dexbot-cred-daemon.sock');
const readyFile = path.join(tmpRoot, 'dexbot-cred-daemon.ready');

const modulePath = require.resolve('../modules/launcher/foreign_cred_daemon');
const fcd = require(modulePath);

function writeSocketAndReady() {
    fs.writeFileSync(socketFile, '');
    fs.writeFileSync(readyFile, '');
}

function cleanup() {
    for (const p of [socketFile, readyFile, credPidFile]) {
        safeUnlink(p)
    }
}

const baseOpts = {
    socketPath: socketFile,
    readyFilePath: readyFile,
    pidFile: credPidFile,
    isLikelyProcess: () => true,
    verbose: false,
};

async function runNoRuntimeFilesTest() {
    cleanup();
    const cleaned = await fcd.ensureNoForeignCredentialDaemon(baseOpts);
    assert.strictEqual(cleaned, false, 'no socket should be treated as no-op');
}

async function runStaleFilesNoLiveDaemonTest() {
    writeSocketAndReady();
    safeUnlink(credPidFile)

    const cleaned = await fcd.ensureNoForeignCredentialDaemon(baseOpts);
    assert.strictEqual(cleaned, false, 'stale files without a live owner should be cleaned but not flagged as foreign');
    assert.strictEqual(fs.existsSync(socketFile), false, 'stale socket should be removed');
    assert.strictEqual(fs.existsSync(readyFile), false, 'stale ready file should be removed');
}

async function runStalePidTest() {
    writeSocketAndReady();
    fs.writeFileSync(credPidFile, '0', { mode: 0o600 });

    const cleaned = await fcd.ensureNoForeignCredentialDaemon(baseOpts);
    assert.strictEqual(cleaned, false, 'pid=0 in ownership file should not be flagged as foreign');
    assert.strictEqual(fs.existsSync(credPidFile), false, 'invalid pid=0 should be removed from ownership file');
    assert.strictEqual(fs.existsSync(socketFile), false, 'stale socket should be cleaned up');
    assert.strictEqual(fs.existsSync(readyFile), false, 'stale ready file should be cleaned up');
}

async function runWrongPidTest() {
    // The recorded PID is alive (this very test process) but isLikelyProcess
    // returns false to simulate a PID that does not match the
    // credential-daemon script. The helper should detect the mismatch and
    // clean up orphan runtime files without touching the process.
    writeSocketAndReady();
    fs.writeFileSync(credPidFile, String(process.pid), { mode: 0o600 });

    const opts = { ...baseOpts, isLikelyProcess: () => false };
    const cleaned = await fcd.ensureNoForeignCredentialDaemon(opts);
    assert.strictEqual(cleaned, false, 'non-credential-daemon pid should not be flagged as foreign');
    assert.strictEqual(fs.existsSync(socketFile), false, 'stale socket should be cleaned up');
    assert.strictEqual(fs.existsSync(readyFile), false, 'stale ready file should be cleaned up');
    assert.strictEqual(fs.existsSync(credPidFile), false, 'invalid ownership file should be removed');
    assert.ok(isProcessAlive(process.pid), 'helper must not have killed the test process');
}

async function runFindOwnerPidNoSocketTest() {
    cleanup();
    const pid = fcd.findCredentialSocketOwnerPid(socketFile, () => true);
    assert.strictEqual(pid, 0, 'missing socket should yield owner pid 0');
}

async function runFindOwnerPidStaleFileTest() {
    writeSocketAndReady();
    const pid = fcd.findCredentialSocketOwnerPid(socketFile, () => true);
    assert.strictEqual(pid, 0, 'socket path with no live listener should yield owner pid 0');
}

async function runSocketWithoutReadyFileTest() {
    // Socket exists but the ready file does not. A foreign daemon may be
    // holding the socket after the ready file was removed by a previous
    // unlock. With the relaxed `isLikelyProcess: () => true` the helper
    // should NOT short-circuit on the missing ready file; it should still
    // attempt to look up the owner and find nothing (because no real
    // listener exists in this temp dir), then clean up the socket.
    safeUnlink(readyFile)
    fs.writeFileSync(socketFile, '');
    safeUnlink(credPidFile)

    const cleaned = await fcd.ensureNoForeignCredentialDaemon(baseOpts);
    assert.strictEqual(cleaned, false, 'socket without ready file with no live owner is a no-op foreign-wise');
    assert.strictEqual(fs.existsSync(socketFile), false, 'stale socket should be removed even without ready file');
}

async function runOrphanReadyFileTest() {
    // Ready file exists but socket does not. This is a stale marker that
    // would block the controller's readiness probe. The helper should
    // remove it.
    safeUnlink(socketFile)
    fs.writeFileSync(readyFile, '');

    const cleaned = await fcd.ensureNoForeignCredentialDaemon(baseOpts);
    assert.strictEqual(cleaned, false, 'orphan ready file is a no-op foreign-wise');
    assert.strictEqual(fs.existsSync(readyFile), false, 'orphan ready file should be removed');
}

async function runInodeExactPathMatchTest() {
    // A socket with a path that happens to be a SUPERSET of the target
    // path should NOT match. /proc/net/unix lists all sockets; the helper
    // must compare the Path column exactly, not via line.includes.
    //
    // We create a real listener on a path that embeds our target socket
    // path as a substring, then call readCredentialSocketInode with the
    // shorter target. It must return 0.
    //
    // This test only runs when /proc/net/unix is reachable (Linux).
    if (process.platform === 'win32') return;
    const net = require('net');
    const shortTarget = path.join(tmpRoot, 's');
    const longPath = shortTarget + '.longer';
    safeUnlink(longPath)
    const server = net.createServer(() => {});
    const listenError = await new Promise((resolve) => {
        server.once('error', resolve);
        server.listen(longPath, () => resolve(null));
    });
    if (listenError) {
        if (['EPERM', 'EACCES', 'EADDRNOTAVAIL'].includes((listenError as any).code)) {
            console.log(`Skipping inode exact path match test: Unix socket listen unavailable (${(listenError as any).code})`);
            return;
        }
        throw listenError;
    }
    try {
        const inode = fcd.readCredentialSocketInode(shortTarget);
        assert.strictEqual(inode, 0, 'substring match must not match a longer path');
    } finally {
        server.close();
        safeUnlink(shortTarget)
        safeUnlink(longPath)
    }
}

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

(async () => {
    try {
        await runNoRuntimeFilesTest();
        await runStaleFilesNoLiveDaemonTest();
        await runStalePidTest();
        await runWrongPidTest();
        await runFindOwnerPidNoSocketTest();
        await runFindOwnerPidStaleFileTest();
        await runSocketWithoutReadyFileTest();
        await runOrphanReadyFileTest();
        await runInodeExactPathMatchTest();

        process.stdout.write('foreign credential daemon tests passed\n');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    } finally {
        cleanup();
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
})();
