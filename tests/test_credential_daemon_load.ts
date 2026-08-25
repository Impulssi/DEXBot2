const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running credential daemon load regression test');

// Regression guard for the ESM-migration class of bug: the daemon is loaded
// via CJS require() calls and must survive module evaluation.  Commit
// eaf21c01 removed the module.exports fallback from modules/order/logger.ts, which
// made `require('./modules/order/logger')` return the ESM namespace instead of the
// Logger class — the daemon crashed at load with "Logger is not a
// constructor" before it ever connected to the one-shot bootstrap socket,
// causing unlock to fail with "Timed out waiting for credential daemon
// bootstrap after 60000ms" after a full 60s wait.
//
// The test spawns the daemon exactly as the launcher does
// (node dist/credential-daemon.js) with an isolated profile root and
// a non-existent bootstrap path file.  A healthy daemon resolves the vault
// secret via the bootstrap path, fails to read it, and exits 0 via the
// "locked" path.  A module-load crash (TypeError) exits non-zero.

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-daemon-load-'));
try {
    fs.writeFileSync(path.join(tmp, 'keys.json'), '{}', { mode: 0o600 });
    const runDir = path.join(tmp, 'run');
    fs.mkdirSync(runDir);

    const run = spawnSync(process.execPath, [path.join(root, 'credential-daemon.js')], {
        cwd: root,
        env: {
            ...process.env,
            DEXBOT_PROFILE_ROOT: tmp,
            DEXBOT_CRED_RUNTIME_DIR: runDir,
            DEXBOT_CRED_DAEMON_SOCKET: path.join(runDir, 'cred.sock'),
            DEXBOT_CRED_DAEMON_READY_FILE: path.join(runDir, 'cred.ready'),
            DEXBOT_CRED_BOOTSTRAP_PATH_FILE: path.join(tmp, 'missing-bootstrap-path'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 30000,
    });

    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    assert.strictEqual(run.status, 0, `daemon should exit 0 via the locked path, got status ${run.status}\n${output}`);
    assert.ok(
        !output.includes('is not a constructor'),
        `daemon module load must not throw TypeError (ESM default-export interop regression)\n${output}`
    );
    assert.ok(
        output.includes('Credential daemon is locked'),
        `daemon should reach the locked-exit path (module loaded past Logger)\n${output}`
    );

    process.stdout.write('credential daemon load regression test passed\n');
    process.exit(0);
} catch (err) {
    console.error(err);
    process.exit(1);
} finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
