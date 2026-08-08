const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    restoreCachedModule,
    setCachedModule,
} = require('./helpers/module_cache_stub');

console.log('Running credential daemon tests');

const { installChainKeysStub } = require('./helpers/chain_keys_stub');
const { chainKeys } = installChainKeysStub();
const {
    createCredentialDaemonController,
} = require('../modules/launcher/credential_daemon');
const {
    BOOTSTRAP_SOCKET_PREFIX,
    createPasswordBootstrapServer,
    fetchBootstrapPassword,
} = require('../modules/launcher/credential_bootstrap');

function loadCredentialSecretWithStubbedChainKeys(stubbedChainKeys) {
    const credentialSecretPath = require.resolve('../modules/launcher/credential_secret');
    const chainKeysPath = require.resolve('../modules/chain_keys');
    const originalCredentialSecret = require.cache[credentialSecretPath];
    const originalChainKeys = setCachedModule(chainKeysPath, stubbedChainKeys);

    delete require.cache[credentialSecretPath];

    try {
        const credentialSecret = require('../modules/launcher/credential_secret');
        return {
            credentialSecret,
            restore() {
                restoreCachedModule(credentialSecretPath, originalCredentialSecret);
                restoreCachedModule(chainKeysPath, originalChainKeys);
            },
        };
    } catch (error) {
        restoreCachedModule(credentialSecretPath, originalCredentialSecret);
        restoreCachedModule(chainKeysPath, originalChainKeys);
        throw error;
    }
}

async function testWaitsForExistingDaemon() {
    const originalIsDaemonResponsive = chainKeys.isDaemonResponsive;
    let ready = true;
    chainKeys.isDaemonResponsive = async () => ready;

    try {
        const controller = createCredentialDaemonController({ pollIntervalMs: 10 });
        const startedAt = Date.now();

        setTimeout(() => {
            ready = false;
        }, 30);

        const exitCode = await controller.waitForManagedDaemon();
        const elapsed = Date.now() - startedAt;

        assert.strictEqual(exitCode, 0, 'waitForManagedDaemon should resolve cleanly for an existing daemon');
        assert.ok(elapsed >= 20, `waitForManagedDaemon should wait for daemon shutdown, elapsed=${elapsed}ms`);
    } finally {
        chainKeys.isDaemonResponsive = originalIsDaemonResponsive;
    }
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

function testNormalizeBootstrapCredentialKeepsDerivedSecret() {
    const secret = { kind: 'dexbot-vault-secret', vaultKeyHex: 'abc123' };
    let unlockCalled = false;
    const { credentialSecret, restore } = loadCredentialSecretWithStubbedChainKeys({
        isVaultSecret: (value) => value === secret,
        unlockWithPassword: () => {
            unlockCalled = true;
            return null;
        },
    });

    try {
        const normalized = credentialSecret.normalizeBootstrapCredential(secret);
        assert.strictEqual(normalized, secret, 'pre-derived bootstrap secrets should pass through unchanged');
        assert.strictEqual(unlockCalled, false, 'pre-derived bootstrap secrets should not be re-derived');
    } finally {
        restore();
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
