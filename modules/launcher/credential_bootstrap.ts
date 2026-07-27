
import net from 'node:net';
import os from 'node:os';
import { path } from '../path_api';
import { TIMING } from '../constants';
import { safeUnlink } from '../utils/fs_utils';
import { assertPrivatePathSecurity } from '../credential_runtime';
import { getStorage } from '../storage';
const storage = getStorage();

const BOOTSTRAP_SOCKET_PREFIX = 'dexbot-cred-bootstrap-';
const DEFAULT_TIMEOUT_MS = TIMING.DAEMON_STARTUP_TIMEOUT_MS;

function debugLog(message: any, err: any = null) {
    const suffix = err && err.message ? `: ${err.message}` : '';
    console.error(`[credential-bootstrap][debug] ${message}${suffix}`);
}

function cleanupBootstrapArtifacts(socketPath: any, socketDir: any) {
    if (socketPath) {
        safeUnlink(socketPath)
    }
    if (socketDir) {
        try { storage.rmdir(socketDir); } catch (err: any) { }
    }
}

/**
 * Try a short connect to determine whether a Unix socket is live.
 * Returns true if the socket accepted the connection (server is listening).
 */
function probeBootstrapSocket(socketPath: any, timeoutMs: any) {
    return new Promise((resolve: any) => {
        const socket = net.createConnection(socketPath, () => {
            socket.end();
            resolve(true);
        });
        socket.on('error', () => resolve(false));
        socket.setTimeout(timeoutMs, () => {
            socket.destroy();
            resolve(false);
        });
    });
}

async function cleanupStaleBootstrapDirs() {
    const tmpDir = os.tmpdir();
    let entries;
    try {
        entries = storage.readdir(tmpDir);
    } catch (err: any) {
        return;
    }
    const now = Date.now();
    const staleThresholdMs = 30 * 60 * 1000;
    for (const entry of entries) {
        if (!entry.startsWith(BOOTSTRAP_SOCKET_PREFIX)) continue;
        const dirPath = path.join(tmpDir, entry);
        let stat;
        try { stat = storage.stat(dirPath); } catch (err: any) { continue; }
        if (!stat.isDirectory()) continue;
        // Only delete if the dir is older than the threshold AND there is no
        // live Unix socket inside.  A stale regular file named `bootstrap.sock`
        // (leftover artifact) is still eligible for cleanup.  For real Unix
        // sockets we attempt a short connection to distinguish live from stale.
        const socketPath = path.join(dirPath, 'bootstrap.sock');
        try {
            const socketStat = storage.stat(socketPath);
            if ((socketStat as any).isSocket()) {
                // Probe the socket with a short connect.  If it succeeds the
                // server is (or was very recently) listening — do not delete.
                const probeResult = await probeBootstrapSocket(socketPath, 300);
                if (probeResult) continue;
                // Connect failed → stale socket inode → fall through to mtime.
            }
        } catch (_) {
            // stat failed – socket file doesn't exist or can't be read,
            // proceed to mtime check.
        }
        if (now - stat.mtimeMs <= staleThresholdMs) continue;
        try { storage.rm(dirPath, { recursive: true, force: true }); } catch (err: any) { }
    }
}

async function createBootstrapSocketDir() {
    await cleanupStaleBootstrapDirs();
    const dir = storage.mkdtemp(path.join(os.tmpdir(), BOOTSTRAP_SOCKET_PREFIX));
    try {
        storage.chmod(dir, 0o700);
        assertPrivatePathSecurity(dir, { expectedType: 'dir', requiredMode: 0o700 });
    } catch (err: any) {
        debugLog(`Unable to secure bootstrap dir ${dir}`, err);
    }
    return dir;
}

function fetchBootstrapPassword({
    socketPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 0,
}: {
    socketPath?: string;
    timeoutMs?: number;
    retries?: number;
} = {}) {
    if (!socketPath) {
        return Promise.reject(new Error('Missing bootstrap socket'));
    }

    return attemptFetch(retries);

    function attemptFetch(remainingRetries: any) {
        return new Promise((resolve: any, reject: any) => {
            let settled = false;
            let buffer = '';
            const socket = (net as any).createConnection(socketPath, () => {
                socket.write(JSON.stringify({ type: 'bootstrap-password' }) + '\n');
            });

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                socket.destroy();
                const err = new Error(`Timed out waiting for bootstrap password after ${timeoutMs}ms`);
                reject(err);
            }, timeoutMs);

            function finish(fn: any, value: any) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(value);
            }

            socket.on('data', (data: any) => {
                buffer += data.toString();
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex === -1) return;

                const line = buffer.slice(0, newlineIndex).trim();
                try {
                    const response = JSON.parse(line);
                    if (!response || response.success !== true) {
                        finish(reject, new Error(response && response.error ? response.error : 'Invalid bootstrap response'));
                        return;
                    }
                    if (typeof response.password === 'string') {
                        socket.end();
                        finish(resolve, response.password);
                        return;
                    }
                    if (typeof response.secret !== 'undefined') {
                        socket.end();
                        finish(resolve, response.secret);
                        return;
                    }
                    finish(reject, new Error('Invalid bootstrap response'));
                } catch (error: any) {
                    finish(reject, new Error('Invalid bootstrap response'));
                }
            });

            socket.on('error', (error: any) => {
                // Retry on transient socket errors (ECONNREFUSED, ECONNRESET)
                if (!settled && remainingRetries > 0 && isTransientSocketError(error)) {
                    settled = true;
                    clearTimeout(timer);
                    const delay = Math.min(200 * Math.pow(2, retries - remainingRetries), 2000);
                    debugLog(`Bootstrap socket error (${remainingRetries} retries left), retrying in ${delay}ms`, error as any);
                    setTimeout(() => {
                        attemptFetch(remainingRetries - 1).then(resolve, reject);
                    }, delay);
                    return;
                }
                finish(reject, error);
            });

            socket.on('end', () => {
                if (!settled) {
                    finish(reject, new Error('Bootstrap socket closed before password was received'));
                }
            });
        });
    }
}

function isTransientSocketError(error: any) {
    const code = error?.code || '';
    // ENOENT can occur when the bootstrap server has not yet created the
    // socket file, or when a previous connection attempt consumed the
    // one-shot socket before the daemon read the secret.  Retry to give
    // the server time to become ready or for the daemon to reconnect.
    return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAGAIN' || code === 'ENOENT';
}

async function createPasswordBootstrapServer({
    password,
    secret,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
    password?: string;
    secret?: any;
    timeoutMs?: number;
} = {}) {
    const credential = typeof secret !== 'undefined' ? secret : password;
    const credentialType = typeof secret !== 'undefined' ? 'secret' : 'password';
    if (credentialType === 'password') {
        if (typeof credential !== 'string' || credential.length === 0) {
            throw new Error('Bootstrap password must be a non-empty string');
        }
    } else if (typeof credential === 'undefined' || credential === null) {
        throw new Error('Bootstrap secret must be defined');
    }

    const socketDir = await createBootstrapSocketDir();
    const socketPath = path.join(socketDir, 'bootstrap.sock');
    let server: any = null;
    let settled = false;
    let cleanedUp = false;
    let timeoutHandle: any = null;
    let resolveTransfer: any;
    let rejectTransfer: any;

    const transferPromise = new Promise((resolve: any, reject: any) => {
        resolveTransfer = resolve;
        rejectTransfer = reject;
    });

    function cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
        }
        if (server) {
            try { server.close(); } catch (err: any) { }
            server = null;
        }
        cleanupBootstrapArtifacts(socketPath, socketDir);
    }

    function settle(fn: any, value: any) {
        if (settled) return;
        settled = true;
        fn(value);
        cleanup();
    }

    await new Promise((resolve: any, reject: any) => {
        server = net.createServer((socket: any) => {
            let buffer = '';

            socket.on('data', (data: any) => {
                buffer += data.toString();
                const newlineIndex = buffer.indexOf('\n');
                if (newlineIndex === -1) return;

                const line = buffer.slice(0, newlineIndex).trim();
                try {
                    const request = JSON.parse(line);
                    if (!request || request.type !== 'bootstrap-password') {
                        socket.write(JSON.stringify({ success: false, error: 'Invalid bootstrap request' }) + '\n');
                        socket.end();
                        return;
                    }

                    socket.write(JSON.stringify({ success: true, [credentialType]: credential }) + '\n');
                    socket.end();
                    // One-shot: the socket is closed and the temp dir is removed
                    // immediately after the first connection.  If the daemon crashes
                    // before consuming the secret, a restarted daemon will find
                    // neither the socket nor the bootstrap path file and will fall
                    // through to interactive auth.  This is by design — the secret
                    // channel is intentionally single-use.
                    settle(resolveTransfer, undefined);
                } catch (error: any) {
                    socket.write(JSON.stringify({ success: false, error: 'Invalid bootstrap request' }) + '\n');
                    socket.end();
                }
            });

            socket.on('error', () => {
            });
        });

        server.on('error', (error: any) => {
            cleanup();
            reject(error);
        });

        server.listen(socketPath, () => {
            try {
                storage.chmod(socketPath, 0o600);
            } catch (err: any) {
                debugLog(`Unable to chmod bootstrap socket ${socketPath}`, err);
            }
            resolve(undefined);
        });
    });

    timeoutHandle = setTimeout(() => {
        settle(rejectTransfer, new Error(`Timed out waiting for credential daemon bootstrap after ${timeoutMs}ms`));
    }, timeoutMs);

    return {
        socketPath,
        close: cleanup,
        waitForTransfer: () => transferPromise.finally(() => cleanup()),
    };
}

export { BOOTSTRAP_SOCKET_PREFIX, DEFAULT_TIMEOUT_MS, createPasswordBootstrapServer, fetchBootstrapPassword }

