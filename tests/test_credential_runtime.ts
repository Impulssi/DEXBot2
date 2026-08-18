const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// Point the resolver at a throwaway profile root BEFORE any module load, so
// PATHS.PROFILES_DIR / PATHS.CREDENTIAL_RUN_DIR resolve under tmp and the
// fallback assertions never touch the repo's real profiles dir.
//
// MUST be unconditional: if a developer/CI exported DEXBOT_PROFILE_ROOT, we
// must NOT adopt it here (the finally block would rmSync it). Save the
// original, always use a pid-scoped tmp root, and only ever delete that tmp.
const ORIGINAL_DEXBOT_PROFILE_ROOT = process.env.DEXBOT_PROFILE_ROOT;
const TEST_PROFILE_ROOT = path.join(os.tmpdir(), `dexbot-cred-runtime-tests-${process.pid}`);
process.env.DEXBOT_PROFILE_ROOT = TEST_PROFILE_ROOT;

console.log('Running credential runtime path tests');

const runtime = require('../modules/credential_runtime');
const { Config } = require('../modules/config');
const { ensureDir } = require('../modules/storage').getStorage();
const { PATHS } = require('../modules/paths');

function withConfigSnapshot(fn) {
    const snapshot = {
        XDG_RUNTIME_DIR: Config.XDG_RUNTIME_DIR,
        DEXBOT_CRED_RUNTIME_DIR: Config.DEXBOT_CRED_RUNTIME_DIR,
        DEXBOT_CRED_DAEMON_SOCKET: Config.DEXBOT_CRED_DAEMON_SOCKET,
        DEXBOT_CRED_DAEMON_READY_FILE: Config.DEXBOT_CRED_DAEMON_READY_FILE,
    };
    const restore = () => {
        Config.XDG_RUNTIME_DIR = snapshot.XDG_RUNTIME_DIR;
        Config.DEXBOT_CRED_RUNTIME_DIR = snapshot.DEXBOT_CRED_RUNTIME_DIR;
        Config.DEXBOT_CRED_DAEMON_SOCKET = snapshot.DEXBOT_CRED_DAEMON_SOCKET;
        Config.DEXBOT_CRED_DAEMON_READY_FILE = snapshot.DEXBOT_CRED_DAEMON_READY_FILE;
    };
    try {
        return fn(restore);
    } finally {
        restore();
    }
}

function testDefaultPathsUseProfilesRun() {
    withConfigSnapshot((restore) => {
        Config.XDG_RUNTIME_DIR = undefined;
        Config.DEXBOT_CRED_RUNTIME_DIR = undefined;
        Config.DEXBOT_CRED_DAEMON_SOCKET = undefined;
        Config.DEXBOT_CRED_DAEMON_READY_FILE = undefined;

        const expectedRuntimeDir = PATHS.CREDENTIAL_RUN_DIR;
        assert.strictEqual(runtime.getCredentialRuntimeDir(), expectedRuntimeDir);
        assert.strictEqual(
            runtime.getCredentialSocketPath(),
            path.join(expectedRuntimeDir, 'dexbot-cred-daemon.sock')
        );
        assert.strictEqual(
            runtime.getCredentialReadyFilePath(),
            path.join(expectedRuntimeDir, 'dexbot-cred-daemon.ready')
        );
    });
}

function testXdgRuntimeOverride() {
    withConfigSnapshot((restore) => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-runtime-xdg-'));
        const xdgRuntimeDir = path.join(baseDir, 'xdg-runtime');

        ensureDir(xdgRuntimeDir);
        Config.XDG_RUNTIME_DIR = xdgRuntimeDir;
        Config.DEXBOT_CRED_RUNTIME_DIR = undefined;
        Config.DEXBOT_CRED_DAEMON_SOCKET = undefined;
        Config.DEXBOT_CRED_DAEMON_READY_FILE = undefined;

        try {
            assert.strictEqual(runtime.getCredentialRuntimeDir(), path.join(xdgRuntimeDir, 'dexbot2'));
            assert.strictEqual(runtime.getCredentialSocketPath(), path.join(xdgRuntimeDir, 'dexbot2', 'dexbot-cred-daemon.sock'));
            assert.strictEqual(runtime.getCredentialReadyFilePath(), path.join(xdgRuntimeDir, 'dexbot2', 'dexbot-cred-daemon.ready'));
        } finally {
            try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
        }
    });
}

function testEnsureRuntimeDirUsesPrivatePermissions() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-runtime-test-'));
    const runtimeDir = path.join(baseDir, 'run');

    try {
        const resolved = runtime.ensureCredentialRuntimeDirSync({ runtimeDir });
        assert.strictEqual(resolved, runtimeDir);
        assert.ok(fs.existsSync(runtimeDir), 'runtime directory should be created');
        if (process.platform !== 'win32') {
            const mode = fs.statSync(runtimeDir).mode & 0o777;
            assert.strictEqual(mode, 0o700, 'runtime directory should use private permissions');
        }
    } finally {
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
    }
}

async function testSecurePathChecksRecognizePrivateFilesAndSockets() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-runtime-secure-'));
    const runtimeDir = path.join(baseDir, 'run');
    const socketPath = path.join(baseDir, 'daemon.sock');
    const filePath = path.join(baseDir, 'ready.file');

    try {
        runtime.ensureCredentialRuntimeDirSync({ runtimeDir });
        assert.ok(
            runtime.isPrivatePathSecure(runtimeDir, { expectedType: 'dir', requiredMode: 0o700 }),
            'runtime dir should pass the private-path check'
        );

        fs.writeFileSync(filePath, 'ready', { mode: 0o600 });
        assert.ok(
            runtime.isPrivatePathSecure(filePath, { expectedType: 'file', requiredMode: 0o600 }),
            'ready file should pass the private-path check'
        );

        let server;
        try {
            server = net.createServer();
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(socketPath, resolve);
            });
            try {
                fs.chmodSync(socketPath, 0o600);
            } catch (err) { }

            assert.ok(
                runtime.isPrivatePathSecure(socketPath, { expectedType: 'socket', requiredMode: 0o600 }),
                'daemon socket should pass the private-path check'
            );
        } catch (error) {
            if (error && (error as any).code === 'EPERM') {
                console.log('Skipping socket security test under sandbox restrictions');
                return;
            }
            throw error;
        } finally {
            if (server) {
                await new Promise((resolve) => server.close(resolve));
            }
        }
    } finally {
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
    }
}

function testInvalidXdgRuntimeFallsBackToProfilesRun() {
    withConfigSnapshot((restore) => {
        const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-runtime-fallback-'));
        const invalidXdg = path.join(baseDir, 'missing', 'runtime');

        Config.DEXBOT_CRED_RUNTIME_DIR = undefined;
        Config.DEXBOT_CRED_DAEMON_SOCKET = undefined;
        Config.DEXBOT_CRED_DAEMON_READY_FILE = undefined;
        Config.XDG_RUNTIME_DIR = invalidXdg;

        try {
            const expectedRuntimeDir = PATHS.CREDENTIAL_RUN_DIR;
            assert.strictEqual(
                runtime.getCredentialRuntimeDir(),
                expectedRuntimeDir,
                'invalid XDG runtime directories should fall back to profiles/run'
            );
            assert.strictEqual(
                runtime.ensureCredentialRuntimeDirSync(),
                expectedRuntimeDir,
                'runtime directory creation should also use the fallback path'
            );
            assert.ok(fs.existsSync(expectedRuntimeDir), 'fallback runtime directory should be created');
        } finally {
            try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
        }
    });
}

function testRootBypassesOwnerCheck() {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-root-bypass-'));
    const testFile = path.join(baseDir, 'test.key');

    try {
        fs.writeFileSync(testFile, 'test', { mode: 0o600 });

        const originalGetuid = process.getuid;

        // Non-root uid different from file owner should throw
        process.getuid = () => 9999;
        assert.throws(
            () => runtime.assertPrivatePathSecurity(testFile, { expectedType: 'file', requiredMode: 0o600 }),
            /Unexpected owner/,
            'non-root uid should reject mismatched owner'
        );

        // Root (uid 0) should bypass owner check entirely
        process.getuid = () => 0;
        assert.doesNotThrow(
            () => runtime.assertPrivatePathSecurity(testFile, { expectedType: 'file', requiredMode: 0o600 }),
            'root should bypass owner check'
        );

        // requireOwner: false should also bypass
        process.getuid = () => 9999;
        assert.doesNotThrow(
            () => runtime.assertPrivatePathSecurity(testFile, { expectedType: 'file', requiredMode: 0o600, requireOwner: false }),
            'requireOwner: false should bypass owner check'
        );

        process.getuid = originalGetuid;
    } finally {
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (err) { }
    }
}

(async () => {
    // NOTE: process.exit() does not unwind the stack, so cleanup MUST happen
    // in this finally BEFORE the exit call below.
    let passed = false;
    try {
        testDefaultPathsUseProfilesRun();
        testXdgRuntimeOverride();
        testEnsureRuntimeDirUsesPrivatePermissions();
        await testSecurePathChecksRecognizePrivateFilesAndSockets();
        testInvalidXdgRuntimeFallsBackToProfilesRun();
        testRootBypassesOwnerCheck();
        passed = true;
    } finally {
        try { fs.rmSync(TEST_PROFILE_ROOT, { recursive: true, force: true }); } catch (err) { }
        if (ORIGINAL_DEXBOT_PROFILE_ROOT === undefined) delete process.env.DEXBOT_PROFILE_ROOT;
        else process.env.DEXBOT_PROFILE_ROOT = ORIGINAL_DEXBOT_PROFILE_ROOT;
    }
    if (passed) {
        console.log('credential runtime path tests passed');
        process.exit(0);
    }
    process.exit(1);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
