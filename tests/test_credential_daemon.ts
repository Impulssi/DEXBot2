const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

console.log('Running credential daemon tests');

const {
    createCredentialDaemonController,
} = require('../modules/launcher/credential_daemon');
const {
    BOOTSTRAP_SOCKET_PREFIX,
    createPasswordBootstrapServer,
    fetchBootstrapPassword,
} = require('../modules/launcher/credential_bootstrap');

async function listenFakeDaemon(socketPath) {
    // Minimal stand-in for the credential daemon: a unix socket server that
    // answers any request line, so the real isDaemonResponsive probe (used by
    // waitForManagedDaemon through the controller's ready check) sees a live
    // daemon without any stubbing of compiled ESM modules.
    const server = net.createServer((socket) => {
        socket.on('data', () => {
            try { socket.write('{"ok":true}\n'); } catch (_) {}
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve(undefined));
    });
    return server;
}

async function testWaitsForExistingDaemon() {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-cred-daemon-test-'));
    const socketPath = path.join(runtimeDir, 'dexbot-cred.sock');
    const readyFilePath = path.join(runtimeDir, 'dexbot-cred.ready');

    fs.writeFileSync(readyFilePath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    const server = await listenFakeDaemon(socketPath);

    try {
        const controller = createCredentialDaemonController({
            socketPath,
            readyFilePath,
            pollIntervalMs: 10,
        });
        const startedAt = Date.now();

        setTimeout(() => {
            // Simulate the daemon shutting down: drop the socket and the
            // ready marker so the controller's readiness loop terminates.
            server.close();
            try { fs.rmSync(socketPath, { force: true }); } catch (_) {}
            try { fs.rmSync(readyFilePath, { force: true }); } catch (_) {}
        }, 40);

        const exitCode = await controller.waitForManagedDaemon();
        const elapsed = Date.now() - startedAt;

        assert.strictEqual(exitCode, 0, 'waitForManagedDaemon should resolve cleanly for an existing daemon');
        assert.ok(elapsed >= 20, `waitForManagedDaemon should wait for daemon shutdown, elapsed=${elapsed}ms`);
        assert.ok(elapsed < 5000, `waitForManagedDaemon should not stall after shutdown, elapsed=${elapsed}ms`);
    } finally {
        server.close();
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
}

function testNormalizeBootstrapCredentialKeepsDerivedSecret() {
    // credential_secret statically imports chain_keys, so a require.cache
    // entry cannot intercept its ESM import on compiled modules. The real
    // isVaultSecret already recognizes derived vault secrets, so exercise the
    // real module directly: a pre-derived secret must pass through by
    // reference, and normalizeBootstrapCredential contains no unlock path at
    // all (non-derived payloads are rejected outright).
    const { normalizeBootstrapCredential } = require('../modules/launcher/credential_secret');
    const secret = { kind: 'dexbot-vault-secret', vaultKeyHex: 'abc123' };

    const normalized = normalizeBootstrapCredential(secret);
    assert.strictEqual(normalized, secret, 'pre-derived bootstrap secrets should pass through unchanged');
    assert.throws(
        () => normalizeBootstrapCredential({ password: 'plaintext' }),
        /Invalid bootstrap credential payload/,
        'non-derived bootstrap payloads should be rejected instead of re-derived'
    );
}

async function testBootstrapPasswordTransfer() {
    let bootstrap;
    try {
        bootstrap = await createPasswordBootstrapServer({ password: 'test-secret', timeoutMs: 1000 });
    } catch (error) {
        if (error && (error as any).code === 'EPERM') {
            console.log('Skipping bootstrap socket integration test under sandbox restrictions');
            return;
        }
        throw error;
    }

    try {
        assert.ok(fs.existsSync(bootstrap.socketPath), 'bootstrap socket should exist before transfer');

        const password = await fetchBootstrapPassword({
            socketPath: bootstrap.socketPath,
            timeoutMs: 1000,
        });

        assert.strictEqual(password, 'test-secret', 'bootstrap client should receive the original password');
        await bootstrap.waitForTransfer();
        assert.ok(!fs.existsSync(bootstrap.socketPath), 'bootstrap socket should be removed after transfer');
    } finally {
        if (bootstrap) bootstrap.close();
    }
}

async function testBootstrapSecretTransfer() {
    let bootstrap;
    const secret = {
        kind: 'dexbot-vault-secret',
        version: 2,
        vaultKeyHex: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    };

    try {
        bootstrap = await createPasswordBootstrapServer({ secret, timeoutMs: 1000 });
    } catch (error) {
        if (error && (error as any).code === 'EPERM') {
            console.log('Skipping secret bootstrap socket integration test under sandbox restrictions');
            return;
        }
        throw error;
    }

    try {
        const response = await fetchBootstrapPassword({
            socketPath: bootstrap.socketPath,
            timeoutMs: 1000,
        });

        assert.strictEqual(response.kind, secret.kind, 'bootstrap client should receive the secret kind');
        assert.strictEqual(response.vaultKeyHex, secret.vaultKeyHex, 'bootstrap client should receive the derived vault key');
        await bootstrap.waitForTransfer();
    } finally {
        if (bootstrap) bootstrap.close();
    }
}

async function testStaleBootstrapDirsAreCleanedBeforeNewServer() {
    const tmpDir = os.tmpdir();
    const staleDir = fs.mkdtempSync(path.join(tmpDir, BOOTSTRAP_SOCKET_PREFIX));
    const freshDir = fs.mkdtempSync(path.join(tmpDir, BOOTSTRAP_SOCKET_PREFIX));
    const unrelatedDir = fs.mkdtempSync(path.join(tmpDir, 'dexbot-other-bootstrap-'));
    const staleTime = new Date(Date.now() - (31 * 60 * 1000));
    let bootstrap = null;

    try {
        fs.writeFileSync(path.join(staleDir, 'bootstrap.sock'), 'stale');
        fs.writeFileSync(path.join(freshDir, 'bootstrap.sock'), 'fresh');
        fs.writeFileSync(path.join(unrelatedDir, 'bootstrap.sock'), 'unrelated');
        fs.utimesSync(staleDir, staleTime, staleTime);

        try {
            bootstrap = await createPasswordBootstrapServer({ password: 'test-secret', timeoutMs: 1000 });
        } catch (error) {
            if (!error || (error as any).code !== 'EPERM') throw error;
        }

        assert.strictEqual(fs.existsSync(staleDir), false, 'stale bootstrap dir should be removed before creating a new server');
        assert.strictEqual(fs.existsSync(freshDir), true, 'fresh bootstrap dir should not be removed');
        assert.strictEqual(fs.existsSync(unrelatedDir), true, 'non-bootstrap temp dirs should not be removed');
    } finally {
        if (bootstrap) bootstrap.close();
        for (const dir of [staleDir, freshDir, unrelatedDir]) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
}

(async () => {
    await testWaitsForExistingDaemon();
    await testBootstrapPasswordTransfer();
    await testBootstrapSecretTransfer();
    await testStaleBootstrapDirsAreCleanedBeforeNewServer();
    testNormalizeBootstrapCredentialKeepsDerivedSecret();
    console.log('credential daemon tests passed');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
