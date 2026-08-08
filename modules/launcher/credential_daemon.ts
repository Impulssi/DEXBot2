
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
import { getErrorMessage } from '../utils/errors.js';

const DEFAULT_POLL_INTERVAL_MS = 1000;

function waitForExit(child: any): Promise<any> {
    return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code: any) => resolve(code));
    });
}

function createCredentialDaemonController({
    root = PATHS.PROJECT_ROOT,
    codeRoot = DEFAULT_CODE_ROOT,
    socketPath = getCredentialSocketPath({ root }),
    readyFilePath = getCredentialReadyFilePath({ root }),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
    let daemonProcess: any = null;
    let daemonExitPromise: any = null;

    async function isDaemonReady() {
        return chainKeys.isDaemonResponsive({ socketPath, readyFilePath });
    }

    async function removeStaleDaemonFiles() {
        if (await isDaemonReady()) return;
        try {
            if (storage.exists(socketPath)) {
                assertPrivatePathSecurity(socketPath, { expectedType: 'socket', requiredMode: 0o600 });
                storage.unlink(socketPath);
            }
        } catch (err: any) {
            throw new Error(`Insecure credential socket path: ${getErrorMessage(err)}`);
        }
        try {
            if (storage.exists(readyFilePath)) {
                assertPrivatePathSecurity(readyFilePath, { expectedType: 'file', requiredMode: 0o600 });
                storage.unlink(readyFilePath);
            }
        } catch (err: any) {
            throw new Error(`Insecure credential ready path: ${getErrorMessage(err)}`);
        }
    }

    function forwardSignal(signal: string): void {
        if (!daemonProcess || daemonProcess.killed) return;
        try {
            daemonProcess.kill(signal);
        } catch (err: any) {
            if (err.code === 'ESRCH') return;
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
        ensureCredentialRuntimeDirSync({ socketPath, readyFilePath, root } as any);
        credentialPolicy.ensurePolicyConfig(path.join(root, 'profiles', 'daemon-policies.json'));

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
        } catch (err: any) {
            bootstrap.close();
            throw new Error(
                `Cannot write bootstrap path file at ${bootstrapPathFile}: ${getErrorMessage(err)}`
            );
        }

        try {
            const childStdio: StdioOptions = stdioOption ?? (detached ? 'ignore' : 'inherit');
            daemonProcess = spawn(Config.EXEC_PATH, daemonArgs, {
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
                daemonExitPromise.then((exitCode: any) => {
                    throw new Error(
                        `credential daemon exited during startup (exit ${exitCode}). ` +
                        `Check the daemon logs for the startup error.`
                    );
                }),
            ]);
            return true;
        } catch (error: any) {
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
            { onTimeout: 'resolve', defaultValue: undefined as any }
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

export { createCredentialDaemonController, DEFAULT_POLL_INTERVAL_MS, waitForExit }

