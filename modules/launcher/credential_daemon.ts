
import { path } from '../path_api.js';
import { LAUNCHER } from '../constants.js';
import { getStorage } from '../storage/index.js';
import { spawn } from 'node:child_process';
import * as chainKeys from '../chain_keys.js';
import * as credentialPolicy from '../credential_policy.js';
import { createPasswordBootstrapServer } from './credential_bootstrap.js';
import { buildScopedChildEnv } from './child_env.js';
import { Config } from '../config.js';
import { PATHS } from '../paths.js';
import { readHeadlessPassword } from './headless_password.js';
import { sleep } from '../order/utils/system.js';
import { withTimeout } from '../order/utils/timeout.js';
import { getProcessDiscovery } from '../process_discovery.js';
import { isNodeProcessWithExactScript } from './bot_supervisor.js';
import { runtime } from '../runtime.js';
const storage = getStorage();
const { unlink: safeUnlink } = storage;
import type { StdioOptions } from 'child_process';
import {
    assertPrivatePathSecurity,
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialSocketPath,
} from '../credential_runtime.js';
import { buildRuntimeScriptArgs, SCRIPTS_ROOT as DEFAULT_CODE_ROOT } from './runtime_entry.js';
import { getErrorMessage, getErrorCode } from '../utils/errors.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;
// Kill timeout for the ordered handover: TERM, verify, KILL, verify.
const HANDOVER_KILL_TIMEOUT_MS = 5000;
// Minimum owner age for a kill: a younger owner may be a concurrent
// starter still mid-handshake — killing it would murder a healthy
// newcomer (Oct-11: fresh daemon SIGTERMed 1s after bind). Young owners
// fail loud instead so the operator retries or kills by hand.
const HANDOVER_MIN_OWNER_AGE_MS = 60 * 1000;

function waitForExit(child: import('node:child_process').ChildProcess): Promise<number | null> {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
    });
}

function isLiveCredentialDaemonProcess(pid: number): boolean {
    try {
        return Number.isInteger(pid) && pid > 0 && isNodeProcessWithExactScript(pid, ['credential-daemon']);
    } catch {
        return false;
    }
}

function isPidGone(pid: number): boolean {
    try {
        return !getProcessDiscovery().isAlive(pid);
    } catch {
        // Discovery unavailable: fall back to a kill(0) probe.
        try {
            runtime.kill(pid, 0 as unknown as NodeJS.Signals);
            return false;
        } catch {
            return true;
        }
    }
}

/**
 * Stop a stale credential daemon and VERIFY death (TERM, poll, KILL,
 * poll). A blind unlink orphans a live listener; an unverified kill
 * lets a newcomer bind into a still-dying owner's lap.
 */
async function stopStaleCredentialDaemon(pid: number, timeoutMs = HANDOVER_KILL_TIMEOUT_MS): Promise<boolean> {
    if (!isLiveCredentialDaemonProcess(pid)) return true;
    try {
        runtime.kill(pid, 'SIGTERM');
    } catch (err) {
        if (getErrorCode(err) === 'ESRCH') return true;
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (isPidGone(pid)) return true;
        await sleep(100);
    }
    try {
        runtime.kill(pid, 'SIGKILL');
    } catch (err) {
        if (getErrorCode(err) === 'ESRCH') return true;
    }
    const killSettledAt = Date.now();
    while (Date.now() - killSettledAt < timeoutMs) {
        if (isPidGone(pid)) return true;
        await sleep(100);
    }
    return isPidGone(pid);
}

function createCredentialDaemonController({
    root = PATHS.PROJECT_ROOT,
    codeRoot = DEFAULT_CODE_ROOT,
    socketPath = getCredentialSocketPath(),
    readyFilePath = getCredentialReadyFilePath(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    spawnFn = spawn,
} = {}) {
    let daemonProcess: import('node:child_process').ChildProcess | null = null;
    let daemonExitPromise: Promise<number | null> | null = null;

    async function isDaemonReady() {
        return chainKeys.isDaemonResponsive({ socketPath, readyFilePath });
    }

    async function removeStaleDaemonFiles() {
        if (await isDaemonReady()) return;
        // Ordered handover: a live daemon may still own the socket file
        // (or hold an already-unlinked inode of it). Killing it first and
        // verifying death keeps a newcomer from binding into a stale
        // listener's lap — and keeps us from unlinking a fresh socket a
        // concurrent starter just bound (Oct-11: launcher reported success
        // with an alive pid but no socket file). Only unlinks after the
        // owner is provably gone.
        try {
            const discovery = getProcessDiscovery();
            const owner = discovery.findSocketOwnerPid(socketPath, isLiveCredentialDaemonProcess);
            if (owner > 0) {
                // Age-guard against murdering a concurrent starter: only a
                // wedged (old, unresponsive) owner may die by our hand.
                let ownerAgeMs: number | null = null;
                try {
                    const stat = discovery.readStat(owner);
                    const uptimeSec = discovery.readSystemUptimeSec();
                    if (stat && uptimeSec > 0) {
                        ownerAgeMs = Math.max(0, (uptimeSec - stat.starttime / 100) * 1000);
                    }
                } catch { ownerAgeMs = null; }
                if (ownerAgeMs !== null && ownerAgeMs < HANDOVER_MIN_OWNER_AGE_MS) {
                    throw new Error(
                        `credential daemon PID ${owner} owns ${socketPath} but is only ${Math.round(ownerAgeMs / 1000)}s old — ` +
                        `possibly a concurrent starter. Refusing to kill it; wait a few seconds and retry, ` +
                        `or kill stale daemons by hand and retry`
                    );
                }
                // eslint-disable-next-line no-console
                console.warn(`[unlock] Stale credential daemon (PID ${owner}) owns ${socketPath} — stopping it before a fresh start.`);
                const dead = await stopStaleCredentialDaemon(owner);
                if (!dead) {
                    throw new Error(`stale credential daemon PID ${owner} would not die; refusing to steal its socket (kill it by hand and retry)`);
                }
            }
        } catch (err) {
            if (err instanceof Error && (/would not die/.test(err.message) || /concurrent starter/.test(err.message))) throw err;
            // Discovery unavailable or unreadable — fall through to the
            // file-existence cleanup below (previous behavior).
        }
        try {
            if (storage.exists(socketPath)) {
                assertPrivatePathSecurity(socketPath, { expectedType: 'socket', requiredMode: 0o600 });
                storage.unlink(socketPath);
            }
        } catch (err) {
            throw new Error(`Insecure credential socket path: ${getErrorMessage(err)}`);
        }
        try {
            if (storage.exists(readyFilePath)) {
                assertPrivatePathSecurity(readyFilePath, { expectedType: 'file', requiredMode: 0o600 });
                storage.unlink(readyFilePath);
            }
        } catch (err) {
            throw new Error(`Insecure credential ready path: ${getErrorMessage(err)}`);
        }
    }

    function forwardSignal(signal: string): void {
        if (!daemonProcess || daemonProcess.killed) return;
        try {
            daemonProcess.kill(signal as NodeJS.Signals);
        } catch (err) {
            if (getErrorCode(err) === 'ESRCH') return;
            throw err;
        }
    }

    async function ensureCredentialDaemon({ detached = false, stdio: stdioOption = undefined, headless = false, passwordFile = null }: {
        detached?: boolean;
        stdio?: StdioOptions;
        headless?: boolean;
        passwordFile?: string | null;
    } = {}) {
        if (await isDaemonReady()) {
            return false;
        }

        await removeStaleDaemonFiles();
        ensureCredentialRuntimeDirSync();
        credentialPolicy.ensurePolicyConfig(PATHS.PROFILES.DAEMON_POLICIES_JSON);

        let vaultSecret;

        if (headless) {
            vaultSecret = chainKeys.unlockWithPassword(readHeadlessPassword({ passwordFile }));
        } else {
            vaultSecret = await chainKeys.authenticate();
        }
        const bootstrap = await createPasswordBootstrapServer({ secret: vaultSecret });
        const daemonArgs = buildRuntimeScriptArgs({
            codeRoot,
            scriptSegments: ['credential-daemon'],
        });

        // Write the bootstrap socket path to a stable file in the runtime dir
        // so the credential daemon can find it via DEXBOT_CRED_BOOTSTRAP_PATH_FILE
        // instead of a PM2-persistable env var.
        const bootstrapPathFile = path.join(path.dirname(socketPath), '.dexbot-cred-bootstrap-path');
        try {
            storage.writeFile(bootstrapPathFile, bootstrap.socketPath, { mode: 0o600 });
        } catch (err) {
            bootstrap.close();
            throw new Error(
                `Cannot write bootstrap path file at ${bootstrapPathFile}: ${getErrorMessage(err)}`
            );
        }

        try {
            const childStdio: StdioOptions = stdioOption ?? (detached ? 'ignore' : 'inherit');
            daemonProcess = spawnFn(Config.EXEC_PATH, daemonArgs, {
                cwd: root,
                env: buildScopedChildEnv({
                    extra: {
                        DEXBOT_CRED_DAEMON_SOCKET: socketPath,
                        DEXBOT_CRED_DAEMON_READY_FILE: readyFilePath,
                        DEXBOT_CRED_BOOTSTRAP_PATH_FILE: bootstrapPathFile,
                    },
                }),
                stdio: childStdio,
                detached,
            });
            daemonExitPromise = waitForExit(daemonProcess);
            if (detached) {
                daemonProcess.unref();
            }

            // If the daemon child exits (or fails to spawn) before both the
            // readiness probe and the bootstrap transfer settle, surface the
            // failure immediately instead of burning the full startup timeout
            // (DAEMON_STARTUP_TIMEOUT_MS) waiting for a handshake that can
            // never happen.  The child's stderr carries the startup error
            // (monolithic mode: logs/monolithic-error.log).
            await Promise.race([
                Promise.all([
                    chainKeys.waitForDaemon(undefined, { socketPath, readyFilePath }),
                    bootstrap.waitForTransfer(),
                ]),
                daemonExitPromise.then((exitCode) => {
                    throw new Error(
                        `credential daemon exited during startup (exit ${exitCode}). ` +
                        `Check the daemon logs for the startup error.`
                    );
                }),
            ]);
            // Post-bind verify: a concurrent starter/stopper may have
            // unlinked our fresh socket between bind and readiness (Oct-11:
            // launcher reported success with an alive pid but no socket
            // file, wedging every later start). Never limp on — kill our
            // child and fail loud so the operator retries cleanly.
            if (!storage.exists(socketPath)) {
                try {
                    daemonProcess?.kill('SIGTERM');
                } catch { /* already gone */ }
                daemonProcess = null;
                daemonExitPromise = null;
                throw new Error(
                    `credential daemon socket missing after bind at ${socketPath} — ` +
                    `a concurrent start/stop likely unlinked it. Kill stale daemons and retry dexbot start.`
                );
            }
            return true;
        } catch (error) {
            bootstrap.close();
            throw error;
        }
    }

    function getManagedDaemonPid() {
        return daemonProcess && daemonProcess.pid ? daemonProcess.pid : null;
    }

    function releaseManagedDaemon() {
        daemonProcess = null;
        daemonExitPromise = null;
    }

    async function stopManagedDaemon() {
        if (!daemonProcess || daemonProcess.killed) return;

        forwardSignal('SIGTERM');
        await withTimeout(
            daemonExitPromise || waitForExit(daemonProcess),
            LAUNCHER.SUPERVISOR.SHUTDOWN_TIMEOUT_MS,
            { onTimeout: 'resolve', defaultValue: undefined }
        );

        safeUnlink(socketPath)
        safeUnlink(readyFilePath)
        daemonProcess = null;
        daemonExitPromise = null;
    }

    async function waitForManagedDaemon() {
        if (daemonProcess) {
            return daemonExitPromise || waitForExit(daemonProcess);
        }

        if (!(await isDaemonReady())) {
            return 0;
        }

        while (await isDaemonReady()) {
            await sleep(pollIntervalMs);
        }

        return 0;
    }

    return {
        ensureCredentialDaemon,
        forwardSignal,
        getManagedDaemonPid,
        isDaemonReady,
        releaseManagedDaemon,
        stopManagedDaemon,
        waitForManagedDaemon,
    };
}

export { createCredentialDaemonController, DEFAULT_POLL_INTERVAL_MS, waitForExit, stopStaleCredentialDaemon }

