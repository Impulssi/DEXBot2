/** Credential client module - connects to credential daemon for key operations */
const { getNodeRequire } = require('./env');
const _require = getNodeRequire();
let net;
try {
    net = _require ? _require('net') : undefined;
} catch {
    // Browser: Unix socket IPC unavailable; methods will throw when called
}
const { getStorage } = require('./storage');
const storage = getStorage();
const { createHmac } = require('./crypto/sync');
const { TIMING, DAEMON_CODES } = require('./constants');
const {
    getCredentialReadyFilePath,
    getCredentialSocketPath,
    isPrivatePathSecure,
} = require('./credential_runtime');

interface BroadcastUncertainErrorDetails {
    operations?: any[] | null;
    accountName?: string | null;
    batchId?: string | null;
    payload?: any;
    timeoutMs?: number | null;
}

interface CredentialClientOptions {
    socketPath?: string;
    readyFilePath?: string;
    pollIntervalMs?: number;
    requestType?: string;
    isBroadcast?: boolean;
    timeoutMs?: number;
    sessionId?: string | null;
    botHmacSecret?: string | null;
    batchId?: string | null;
    nodeUrl?: string;
    fallbackNodes?: string[];
}

interface CredentialDaemonMeta {
    uncertainOnTimeout?: boolean;
    operations?: any[] | null;
    accountName?: string | null;
    batchId?: string | null;
}

interface CredentialDaemonResponse {
    success?: boolean;
    error?: string;
    code?: string;
    raw?: any;
    operation_results?: any[];
}

interface RequestPayload {
    type: string;
    accountName: string;
    operations: any[];
    sessionId?: string | null;
    hmac?: string;
    nodeUrl?: string;
}

const DEFAULT_SOCKET_PATH = getCredentialSocketPath();
const DEFAULT_READY_FILE = getCredentialReadyFilePath();
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_BROADCAST_TIMEOUT_MS = TIMING.CREDENTIAL_BROADCAST_TIMEOUT_MS;
const DEFAULT_WAIT_TIMEOUT_MS = TIMING.DAEMON_STARTUP_TIMEOUT_MS;
const DEFAULT_POLL_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

/**
 * Typed error raised when the bot-side socket timer fires BEFORE the credential
 * daemon has responded. The chain status of the operations is unknown at this
 * point — the daemon may have signed and broadcast, or it may have stalled
 * before doing anything. Callers (chain_orders.ts / dexbot_class.ts) MUST catch
 * this and run the recovery path (read chain, match by fingerprint, adopt or
 * discard). A plain `Error` would lose the metadata the recovery path needs.
 *
 * Fields:
 *   - operations: the original op array sent to the daemon
 *   - accountName: account the ops were intended for
 *   - batchId: caller-provided correlation id (if any)
 *   - payload: the full request payload (for retry/log)
 *   - timeoutMs: the outer timeout that fired
 */
class BroadcastUncertainError extends Error {
    code: string;
    operations: any[] | null;
    accountName: string | null;
    batchId: string | null;
    payload: any;
    timeoutMs: number | null;

    constructor(message: string, details: BroadcastUncertainErrorDetails = {}) {
        super(message);
        this.name = 'BroadcastUncertainError';
        this.code = 'BROADCAST_UNCERTAIN';
        this.operations = details.operations || null;
        this.accountName = details.accountName || null;
        this.batchId = details.batchId || null;
        this.payload = details.payload || null;
        this.timeoutMs = details.timeoutMs || null;
    }
}

function getSocketPath(options: CredentialClientOptions = {}): string {
    return options.socketPath || DEFAULT_SOCKET_PATH;
}

function sendCredentialDaemonRequest(socketPath: string, payload: any, timeoutMs: number, meta: CredentialDaemonMeta = {}): Promise<CredentialDaemonResponse> {
    return new Promise<CredentialDaemonResponse>((resolve, reject) => {
        let settled = false;
        const socket = net.createConnection(socketPath, () => {
            socket.write(`${JSON.stringify(payload)}\n`);
        });

        let responseBuffer = '';
        const timer = setTimeout(() => {
            socket.destroy();
            if (!settled) {
                settled = true;
                // For broadcast requests the chain may have already accepted the
                // operations by the time we time out. Use a typed error so the
                // recovery path can detect this case explicitly. Non-broadcast
                // requests stay on the plain Error path.
                if (meta && meta.uncertainOnTimeout) {
                    reject(new BroadcastUncertainError(
                        `Credential daemon broadcast request timed out after ${timeoutMs}ms`,
                        {
                            operations: meta.operations || null,
                            accountName: meta.accountName || null,
                            batchId: meta.batchId || null,
                            payload,
                            timeoutMs,
                        }
                    ));
                } else {
                    reject(new Error(`Credential daemon request timed out after ${timeoutMs}ms`));
                }
            }
        }, timeoutMs);

        socket.on('data', (data) => {
            responseBuffer += data.toString();
            const lines = responseBuffer.split('\n');
            responseBuffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                clearTimeout(timer);
                socket.end();
                if (!settled) {
                    settled = true;
                    try {
                        resolve(JSON.parse(line));
                    } catch {
                        reject(new Error('Invalid credential daemon response'));
                    }
                }
                return;
            }
        });

        socket.on('error', (error) => {
            clearTimeout(timer);
            if (!settled) { settled = true; reject(new Error(`Credential daemon connection failed: ${error.message}`)); }
        });

        socket.on('end', () => {
            clearTimeout(timer);
            if (!settled && !responseBuffer.trim()) {
                settled = true;
                reject(new Error('Credential daemon closed the connection unexpectedly'));
            }
        });
    });
}

function getReadyFilePath(options: CredentialClientOptions = {}): string {
    return options.readyFilePath || DEFAULT_READY_FILE;
}

function isCredentialDaemonReady(options: CredentialClientOptions = {}): boolean {
    try {
        const readyFilePath = getReadyFilePath(options);
        const socketPath = getSocketPath(options);
        return storage.exists(readyFilePath) &&
            storage.exists(socketPath) &&
            isPrivatePathSecure(readyFilePath, { expectedType: 'file', requiredMode: 0o600 }) &&
            isPrivatePathSecure(socketPath, { expectedType: 'socket', requiredMode: 0o600 });
    } catch {
        return false;
    }
}

async function waitForCredentialDaemon(timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS, options: CredentialClientOptions = {}): Promise<void> {
    const pollIntervalMs = Number.isFinite(Number(options.pollIntervalMs))
        ? Number(options.pollIntervalMs)
        : DEFAULT_POLL_INTERVAL_MS;
    const start = Date.now();

    while (!isCredentialDaemonReady(options)) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for DEXBot2 credential daemon after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}

function extractHostname(url: string): string {
    try { return new URL(url).hostname; } catch { return url; }
}

async function executeOperationsViaCredentialDaemon(accountName: string, operations: any[], options: CredentialClientOptions = {}): Promise<CredentialDaemonResponse> {
    if (!accountName) {
        throw new Error('accountName is required to execute operations');
    }
    if (!Array.isArray(operations)) {
        throw new Error('operations must be an array');
    }

    const socketPath = getSocketPath(options);
    // Broadcast requests have their own (longer) outer timeout. Non-broadcast
    // callers can still pass timeoutMs explicitly to override.
    const isBroadcast = options.requestType === 'broadcast' || options.isBroadcast === true;
    const defaultTimeout = isBroadcast ? DEFAULT_BROADCAST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Number(options.timeoutMs)
        : defaultTimeout;

    const fallbackNodes = Array.isArray(options.fallbackNodes) ? options.fallbackNodes : [];
    const maxAttempts = 1 + fallbackNodes.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const nodeUrl = attempt === 0 ? (options.nodeUrl || undefined) : fallbackNodes[attempt - 1];

        const payload: RequestPayload = { type: 'execute-operations', accountName, operations };
        const sessionId = options.sessionId || null;
        if (sessionId) payload.sessionId = sessionId;
        if (nodeUrl) payload.nodeUrl = nodeUrl;

        const botHmacSecret = options.botHmacSecret || null;
        if (botHmacSecret && sessionId) {
            payload.hmac = createHmac('sha256', Buffer.from(botHmacSecret, 'hex'))
                .update(JSON.stringify({ sessionId, operations }))
                .digest('hex');
        }

        const meta = isBroadcast
            ? {
                uncertainOnTimeout: true,
                operations,
                accountName,
                batchId: options.batchId || null,
            }
            : {};

        try {
            const response = await sendCredentialDaemonRequest(socketPath, payload, timeoutMs, meta);
            if (response.success) {
                return response;
            }
            const errMsg = response.error || 'Unknown credential daemon error';
            const errCode = response.code || null;
            // The daemon hit its inner deadline (BROADCAST_DEADLINE) and the chain
            // state is uncertain. Convert this typed failure back to a
            // BroadcastUncertainError so the recovery path picks it up. Only
            // relevant for broadcast requests — non-broadcast callers don't carry
            // the uncertainOnTimeout flag.
            if (
                isBroadcast &&
                (errCode === DAEMON_CODES.BROADCAST_DEADLINE ||
                    (typeof errMsg === 'string' && errMsg.startsWith(DAEMON_CODES.BROADCAST_DEADLINE)))
            ) {
                throw new BroadcastUncertainError(
                    `Credential daemon broadcast uncertain: ${errCode || errMsg}`,
                    {
                        operations,
                        accountName,
                        batchId: options.batchId || null,
                        payload,
                        timeoutMs,
                    }
                );
            }
            // Typed failure reply from the daemon (e.g. policy denied, bad op) —
            // the chain state is known (chain NOT touched), so a plain Error is
            // fine.
            throw new Error(errMsg);
        } catch (err) {
            if (err instanceof BroadcastUncertainError && attempt < maxAttempts - 1) {
                const label = extractHostname(nodeUrl || '') || 'primary';
                const nextHost = extractHostname(fallbackNodes[attempt]);
                console.warn(`[cred-daemon-client] BROADCAST_DEADLINE on ${label}, retrying fallback ${nextHost}...`);
                await new Promise((resolve) => setTimeout(resolve, TIMING.BLOCKCHAIN_SETTLE_DELAY_MS));
                continue;
            }
            throw err;
        }
    }
}

export = {
    DEFAULT_READY_FILE,
    DEFAULT_SOCKET_PATH,
    DEFAULT_BROADCAST_TIMEOUT_MS,
    sendCredentialDaemonRequest,
    executeOperationsViaCredentialDaemon,
    isCredentialDaemonReady,
    waitForCredentialDaemon,
    BroadcastUncertainError,
};
