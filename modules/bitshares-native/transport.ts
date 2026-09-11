'use strict';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { NATIVE_CLIENT } from '../constants.js';
import Logger from '../order/logger.js';
import { getErrorMessage } from '../utils/errors.js';

// Native WebSocket only — Node >= 22 provides globalThis.WebSocket. No fallback package.
type WebSocketLike = WebSocket;

let _WebSocketCtor: (new (url: string) => WebSocketLike) | null = null;
function getWebSocketConstructor(): new (url: string) => WebSocketLike {
    if (!_WebSocketCtor) {
        const ws = (globalThis as any).WebSocket;
        if (!ws) {
            throw new Error('WebSocket is not available — DEXBot2 requires Node.js >= 22 (native globalThis.WebSocket)');
        }
        _WebSocketCtor = ws as new (url: string) => WebSocketLike;
    }
    return _WebSocketCtor;
}

const { TRANSPORT } = NATIVE_CLIENT;

const transportLogger = new Logger('Transport');

const CONNECT_TIMEOUT_MS: number = TRANSPORT.CONNECT_TIMEOUT_MS;
const RPC_TIMEOUT_MS: number = TRANSPORT.RPC_TIMEOUT_MS;
const KEEPALIVE_INTERVAL_MS: number = TRANSPORT.KEEPALIVE_INTERVAL_MS;
const CLOSE_COALESCE_MS: number = TRANSPORT.CLOSE_COALESCE_MS;
// Close codes that do not indicate a node problem (normal closure / going away).
const BENIGN_CLOSE_CODES: Set<number> = new Set<number>(Array.isArray(TRANSPORT.BENIGN_CLOSE_CODES) ? TRANSPORT.BENIGN_CLOSE_CODES : [1000, 1001]);

let _rpcId = 0;

class RpcTimeoutError extends Error {
    code: string;
    method: string;
    constructor(method: string, timeoutMs: number) {
        super(`RPC timeout ${timeoutMs}ms for ${method}`);
        this.code = 'RPC_TIMEOUT';
        this.method = method;
    }
}

class ConnectionError extends Error {
    code: string;
    constructor(message: string) {
        super(message);
        this.code = 'CONNECTION_ERROR';
    }
}

class AllNodesFailed extends Error {
    code: string;
    errors: Error[];
    constructor(errors: Error[]) {
        const msgs = errors.map(e => e.message).join('; ');
        super(`All nodes unreachable: ${msgs}`);
        this.code = 'ALL_NODES_FAILED';
        this.errors = errors;
    }
}

class RpcError extends Error {
    code: string;
    method: string;
    params: any[];
    constructor(message: string, code: string | undefined, method: string, params: any[]) {
        super(message);
        this.code = code || 'RPC_ERROR';
        this.method = method;
        this.params = params;
    }
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
    method: string;
    params: any[];
}

type TransportStatus = 'closed' | 'connecting' | 'connected';

interface TransportConfig {
    connectTimeoutMs?: number;
    rpcTimeoutMs?: number;
    onStatusChange?: ((status: string, nodeUrl: string | null) => void) | null;
    onReconnect?: ((nodeUrl: string) => Promise<void>) | null;
    onNodeFailure?: ((nodeUrl: string, message: string, source: string) => void) | null;
    // Optional predicate: return true to deprioritize a node for the next
    // reconnect (e.g. blacklisted/failed per NodeManager). Unlike the internal
    // recently-failed set, this is consulted on every connect attempt.
    shouldSkipNode?: ((nodeUrl: string) => boolean) | null;
    validateNode?: (() => Promise<void>) | null;
    keepAliveIntervalMs?: number;
}

function createTransport(config: TransportConfig = {}) {
    const {
        connectTimeoutMs = CONNECT_TIMEOUT_MS,
        rpcTimeoutMs = RPC_TIMEOUT_MS,
        onStatusChange = null,
        onReconnect = null,
        onNodeFailure = null,
        shouldSkipNode = null,
        validateNode = null,
        keepAliveIntervalMs = KEEPALIVE_INTERVAL_MS,
    } = config;

    let ws: WebSocketLike | null = null;
    let nodeUrl: string | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let keepAliveInFlight = false;
    let keepAliveFailures = 0;
    const MAX_KEEPALIVE_FAILURES = 3;
    let nodeList: string[] = [];
    let nodeIndex = 0;
    let autoreconnect = false;
    let intentionalClose = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 20;
    // Close-event debounce for the currently active socket only. Stale sockets
    // are ignored by identity so a fresh socket close can never be suppressed by
    // an older socket's close event.
    let lastCloseSocket: WebSocketLike | null = null;
    let lastCloseAt: number = 0;
    const closeCoalesceMs = CLOSE_COALESCE_MS;
    let pendingRequests = new Map<string, PendingRequest>();
    let onMessageHandlers: Array<(params: any) => void> = [];
    let status: TransportStatus = 'closed';
    // In-flight connect handshakes (connectOne sockets not yet assigned to ws).
    // disconnect() closes them so a concurrent connect sweep (e.g. a
    // deadline-aborted broadcast's reconnect racing the next request) cannot
    // leave a zombie handshake that later assigns itself as the active socket.
    const connectingSockets = new Set<WebSocketLike>();
    // Nodes that failed during this transport's lifetime (keep-alive trip or
    // abnormal close). Deprioritized on the next reconnect but cleared as soon
    // as the node connects successfully, so a recovered node is re-admitted.
    const failedNodes = new Set<string>();
    // Set when the keep-alive path already reported a failure for the active
    // socket, so the ensuing close does not double-count the same event.
    let suppressNextCloseFailure = false;
    // Errors from the most recent connect sweep, used for the aggregate throw.
    let lastConnectErrors: Error[] = [];

    /**
     * Record a node failure: remember it for reconnect deprioritization and
     * forward to the optional onNodeFailure observer (which feeds NodeManager).
     * Never throws into the transport's own control flow.
     */
    function notifyNodeFailure(failedUrl: string | null, message: string, source: string): void {
        if (!failedUrl) return;
        failedNodes.add(failedUrl);
        if (onNodeFailure) {
            try { onNodeFailure(failedUrl, message, source); } catch (_: any) {}
        }
    }

    /** True when a close code/wasClean pair should NOT count as a node failure. */
    function isBenignClose(code: any, wasClean: boolean): boolean {
        if (wasClean === false) return false;
        return typeof code === 'number' && BENIGN_CLOSE_CODES.has(code);
    }

    /** True when a node should be skipped in favor of another candidate. */
    function shouldDeprioritize(url: string): boolean {
        if (failedNodes.has(url)) return true;
        if (shouldSkipNode) {
            try { return !!shouldSkipNode(url); } catch (_: any) { return false; }
        }
        return false;
    }

    function setStatus(newStatus: TransportStatus): void {
        if (status !== newStatus) {
            const prevStatus = status;
            status = newStatus;
            transportLogger.info(`status change: ${prevStatus} -> ${newStatus} (node=${nodeUrl})`);
            if (onStatusChange) {
                try { onStatusChange(newStatus, nodeUrl); } catch (_: any) {}
            }
        }
    }

    function cleanup(): void {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
        keepAliveInFlight = false;
        keepAliveFailures = 0;
        onMessageHandlers = [];
        for (const [, req] of pendingRequests) {
            if (req.timer) clearTimeout(req.timer);
            req.reject(new ConnectionError('Connection closed'));
        }
        pendingRequests.clear();
    }

    function scheduleReconnect(): void {
        if (intentionalClose || !autoreconnect || nodeList.length === 0 || reconnectTimer) return;
        if (reconnectAttempts >= maxReconnectAttempts) {
            // Switch to slow perpetual retry instead of giving up permanently.
            // The transport will keep polling at SLOW_RECONNECT_INTERVAL_MS until
            // either a connection succeeds or intentionalClose is set.
            const SLOW_RECONNECT_INTERVAL_MS = require('../constants').TIMING.SLOW_RECONNECT_INTERVAL_MS;
            transportLogger.warn(`Max reconnection attempts (${maxReconnectAttempts}) reached; switching to slow perpetual retry every ${SLOW_RECONNECT_INTERVAL_MS / 1000}s`);
            reconnectAttempts = maxReconnectAttempts; // stay in slow mode
            setStatus('closed');
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                tryConnect().catch(() => scheduleReconnect());
            }, SLOW_RECONNECT_INTERVAL_MS);
            return;
        }
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts) + Math.random() * 1000, 30000);
        reconnectAttempts++;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            tryConnect().catch(() => scheduleReconnect());
        }, delay);
    }

    function startKeepAlive(): void {
        if (!Number.isFinite(keepAliveIntervalMs) || keepAliveIntervalMs <= 0 || keepAliveTimer) return;
        keepAliveTimer = setInterval(() => {
            if (!ws || ws.readyState !== 1) return;
            if (keepAliveInFlight) return;
            keepAliveInFlight = true;
            const safe = setTimeout(() => {
                keepAliveInFlight = false;
            }, Math.min(rpcTimeoutMs, 15000));
            call('call', [1, 'login', ['', '']], Math.min(rpcTimeoutMs, 10000))
                .then(() => {
                    keepAliveFailures = 0;
                })
                .catch(() => {
                    keepAliveFailures++;
                    const failedNode = nodeUrl;
                    if (keepAliveFailures >= MAX_KEEPALIVE_FAILURES) {
                        console.warn(`[TRANSPORT] Keep-alive failed ${keepAliveFailures} times on ${failedNode || 'unknown node'}, forcing reconnect`);
                        // Report once here; suppress the follow-up connection
                        // report from the close this triggers.
                        suppressNextCloseFailure = true;
                        notifyNodeFailure(failedNode, `keep-alive failed ${keepAliveFailures} times`, 'keep-alive');
                        autoreconnect = true;
                        intentionalClose = false;
                        if (ws) {
                            try { ws.close(); } catch (_: any) {}
                        }
                    } else {
                        console.warn(`[TRANSPORT] Keep-alive call failed (${keepAliveFailures}/${MAX_KEEPALIVE_FAILURES}) on ${failedNode || 'unknown node'}`);
                    }
                })
                .finally(() => {
                    clearTimeout(safe);
                    keepAliveInFlight = false;
                });
        }, keepAliveIntervalMs);
        if (typeof keepAliveTimer!.unref === 'function') {
            keepAliveTimer!.unref();
        }
    }

    function connectOne(url: string): Promise<WebSocketLike> {
        return new Promise((resolve, reject) => {
            try {
                const socket = new (getWebSocketConstructor())(url);
                connectingSockets.add(socket);
                const timer = setTimeout(() => {
                    connectingSockets.delete(socket);
                    try { socket.close(); } catch (_: any) {}
                    reject(new ConnectionError(`handshake timeout ${connectTimeoutMs}ms for ${url}`));
                }, connectTimeoutMs);

                socket.onopen = () => {
                    connectingSockets.delete(socket);
                    clearTimeout(timer);
                    resolve(socket);
                };
                socket.onerror = (evt: any) => {
                    connectingSockets.delete(socket);
                    clearTimeout(timer);
                    const msg = evt && evt.message ? evt.message : 'WebSocket connection error';
                    reject(new ConnectionError(msg));
                };
                socket.onclose = (evt: any) => {
                    connectingSockets.delete(socket);
                    clearTimeout(timer);
                    reject(new ConnectionError(`handshake closed code=${evt.code} for ${url}`));
                };
            } catch (err: any) {
                reject(new ConnectionError(`Failed to create WebSocket for ${url}: ${getErrorMessage(err)}`));
            }
        });
    }

    function setupMessageHandler(socket: WebSocketLike): void {
        socket.onmessage = (raw: any) => {
            let msg: any;
            try { msg = JSON.parse(raw.data); } catch (_: any) { return; }

            if (typeof msg.id !== 'undefined') {
                const id = String(msg.id);
                const req = pendingRequests.get(id);
                if (req) {
                    if (req.timer) clearTimeout(req.timer);
                    pendingRequests.delete(id);
                    if (msg.error) {
                        req.reject(new RpcError(
                            msg.error.message || JSON.stringify(msg.error),
                            msg.error.code,
                            req.method,
                            req.params
                        ));
                    } else {
                        req.resolve(msg.result);
                    }
                }
            }

            if (typeof msg.method === 'string' && msg.method === 'notice') {
                for (const handler of onMessageHandlers) {
                    try { handler(msg.params); } catch (_: any) {}
                }
            }
        };

        socket.onclose = (evt: any) => {
            if (socket !== ws) return;
            // Consume the keep-alive suppression flag regardless of the
            // coalescing path, so a later unrelated close is never suppressed.
            const suppressCloseFailure = suppressNextCloseFailure;
            suppressNextCloseFailure = false;
            const code = evt?.code;
            const reason = evt?.reason || '';
            const wasClean = evt?.wasClean !== false;
            const now = Date.now();
            // Coalesce close events that arrive within `closeCoalesceMs` of one
            // another from the same active socket. The first event runs cleanup
            // + the reconnect schedule; subsequent same-socket events only
            // update the timestamp.
            if (lastCloseSocket === socket && now - lastCloseAt < closeCoalesceMs) {
                lastCloseAt = now;
                return;
            }
            lastCloseSocket = socket;
            lastCloseAt = now;
            transportLogger.warn(`WebSocket closed on ${nodeUrl}: code=${code}, wasClean=${wasClean}, reason="${reason}"`);
            // Only abnormal, unexpected closes count as a node failure. A normal
            // closure (1000) or going-away (1001, server deploy) is benign, and
            // a keep-alive trip was already reported.
            if (!intentionalClose && nodeUrl && !suppressCloseFailure && !isBenignClose(code, wasClean)) {
                notifyNodeFailure(nodeUrl, `WebSocket closed code=${code} wasClean=${wasClean} reason="${reason}"`, 'connection');
            }
            setStatus('closed');
            cleanup();

            scheduleReconnect();
        };

        socket.onerror = (evt: any) => {
            const msg = evt && evt.message ? evt.message : 'WebSocket connection error';
            transportLogger.warn(`WebSocket error on ${nodeUrl}: ${msg}`);
        };
    }

    function _onConnected(socket: WebSocketLike, url: string, idx: number, wasReconnect: boolean): Promise<void> {
        if (ws) {
            ws.onclose = null;
            try { ws.close(); } catch (_: any) {}
        }
        ws = socket;
        // A new active socket supersedes any pending close-suppression: the
        // flag only ever refers to the socket the keep-alive trip tore down,
        // whose onclose was just detached above (or may fire after this
        // connect). Leaving it armed would suppress this socket's next genuine
        // failure report — a one-strike leak, but avoidable.
        suppressNextCloseFailure = false;
        nodeUrl = url;
        nodeIndex = idx;
        reconnectAttempts = 0;
        // A successful connection clears the deprioritization for this node.
        failedNodes.delete(url);
        setupMessageHandler(socket);
        return (async () => {
            if (validateNode) {
                await validateNode();
            }
            setStatus('connected');
            startKeepAlive();
            if (wasReconnect && onReconnect) {
                try {
                    await onReconnect(nodeUrl);
                } catch (err: any) {
                    transportLogger.warn(`Reconnect callback (subscription re-establishment) failed: ${getErrorMessage(err)}`);
                }
            }
        })();
    }

    /**
     * Attempt to connect over a specific candidate set.
     * Parallel race first (fastest handshake wins), then a sequential pass for
     * environments where parallel connection floods are problematic.
     * @returns true when a connection was established.
     */
    async function attemptConnect(candidates: string[], wasReconnect: boolean): Promise<boolean> {
        if (candidates.length === 0) return false;

        // Parallel connect strategy: race all candidates concurrently so the
        // fastest connecting node wins. Each individual connectOne still has
        // its own per-node timeout (connectTimeoutMs), so worst-case wall time
        // is connectTimeoutMs instead of list.length * connectTimeoutMs.
        const connectPromises = candidates.map((_url, i) => {
            const idx = (nodeIndex + i) % candidates.length;
            const actualUrl = candidates[idx];
            return connectOne(actualUrl)
                .then(socket => ({ socket, url: actualUrl, idx }))
                .catch(err => { throw { url: actualUrl, error: err }; });
        });

        try {
            setStatus('connecting');
            const winner: any = await Promise.any(connectPromises);
            // Cancel remaining in-flight connections (best-effort, no throw).
            for (const p of connectPromises) {
                p.then((other: any) => {
                    if (other.socket && other.socket !== winner?.socket) {
                        try { other.socket.close(); } catch (_: any) {}
                    }
                }).catch(() => {});
            }
            await _onConnected(winner.socket, winner.url, winner.idx, wasReconnect);
            return true;
        } catch (firstErr: any) {
            // All parallel attempts failed. Fall back to sequential retry for
            // environments where parallel connection floods are problematic.
            const errMsg = firstErr?.errors ? firstErr.errors.map((e: any) => e?.message || e).join('; ') : (firstErr?.message || firstErr);
            transportLogger.warn(`Parallel connect failed (${candidates.length} nodes), falling back to sequential: ${errMsg}`);
        }

        // Sequential fallback pass.
        for (let i = 0; i < candidates.length; i++) {
            const idx = (nodeIndex + i) % candidates.length;
            const url = candidates[idx];
            try {
                setStatus('connecting');
                const socket = await connectOne(url);
                await _onConnected(socket, url, idx, wasReconnect);
                return true;
            } catch (err: any) {
                if (ws) {
                    ws.onclose = null;
                    try { ws.close(); } catch (_: any) {}
                    ws = null;
                }
                lastConnectErrors.push(err);
            }
        }
        return false;
    }

    async function tryConnect(): Promise<void> {
        intentionalClose = false;
        const list = [...nodeList];
        if (list.length === 0) {
            setStatus('closed');
            return;
        }

        const wasReconnect = reconnectAttempts > 0;
        lastConnectErrors = [];

        // Prefer nodes that have not just failed and are not reported as
        // unusable by the caller's shouldSkipNode predicate. This is what makes
        // a stale node get switched away from instead of winning the reconnect
        // race again. If every node is deprioritized we still fall back to the
        // full list so the transport can never wedge permanently.
        const preferred = list.filter(url => !shouldDeprioritize(url));
        const candidates = preferred.length > 0 ? preferred : list;

        if (await attemptConnect(candidates, wasReconnect)) return;

        if (preferred.length > 0 && preferred.length < list.length) {
            transportLogger.warn(`All ${preferred.length} preferred node(s) failed; retrying including recently-failed node(s)`);
            if (await attemptConnect(list, wasReconnect)) return;
        }

        nodeIndex = 0;
        setStatus('closed');
        throw new AllNodesFailed(lastConnectErrors);
    }

    async function connect(servers?: string[], autoReconnect = false): Promise<void> {
        if (Array.isArray(servers)) {
            nodeList = servers.filter(s => s && typeof s === 'string');
        }
        if (nodeList.length === 0) {
            throw new ConnectionError('No servers provided');
        }

        // No-op when the transport is already connected to one of the requested
        // nodes. This breaks the cycle-boundary thrash where the market_adapter
        // re-issues connectClient() every hour and the bot's transport flips
        // open/closed each time. setNodes() may still have updated the list, so
        // we keep that change but skip the disconnect/connect cycle.
        //
        // CONTRACT for wrappers using a connect-generation counter
        // (see modules/bitshares_client.ts withTimeout wrapper around
        // _nativeClient.connect()): the no-op early return resolves the
        // returned Promise IMMEDIATELY without sweeping nodes. If the wrapper
        // previously captured a generation, a "late success" handler that
        // sees the new connect sweep finish will see this resolve as a
        // success, not a no-op — but the connection itself is unchanged.
        // To avoid any generation-counter confusion, callers SHOULD call
        // disconnect() before connect() so the no-op path is bypassed and
        // the connect sweep runs normally. restartBitsharesConnection in
        // bitshares_client.ts does this. New callers should follow the same
        // pattern unless they have a specific reason not to.
        if (ws && ws.readyState === 1 && nodeUrl && nodeList.includes(nodeUrl)) {
            autoreconnect = autoReconnect;
            intentionalClose = false;
            return;
        }

        nodeIndex = 0;
        reconnectAttempts = 0;

        disconnect();
        autoreconnect = autoReconnect;
        intentionalClose = false;
        await tryConnect();
    }

    function disconnect(): void {
        intentionalClose = true;
        autoreconnect = false;

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        cleanup();

        if (ws) {
            try { ws.close(); } catch (_: any) {}
            ws = null;
        }
        // Abort any in-flight connect handshakes: ws is only assigned after a
        // handshake completes, so closing ws alone cannot reach them. A zombie
        // handshake that later assigns itself would resurrect a connection the
        // caller explicitly tore down (deadline aborts, node rotation).
        for (const socket of connectingSockets) {
            try { socket.close(); } catch (_: any) {}
        }
        connectingSockets.clear();
        nodeUrl = null;
        setStatus('closed');
    }

    function call(method: string, params: any[], timeoutMs: number = rpcTimeoutMs): Promise<any> {
        if (!ws || ws.readyState !== 1) {
            return Promise.reject(new ConnectionError('WebSocket not open'));
        }

        const id = String(_rpcId++);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingRequests.delete(id);
                reject(new RpcTimeoutError(method, timeoutMs));
            }, timeoutMs);

            pendingRequests.set(id, {
                resolve,
                reject,
                timer,
                method,
                params,
            });

            try {
                ws!.send(JSON.stringify({
                    id: Number(id),
                    jsonrpc: '2.0',
                    method,
                    params,
                }));
            } catch (err: any) {
                clearTimeout(timer);
                pendingRequests.delete(id);
                reject(new ConnectionError(`Failed to send: ${getErrorMessage(err)}`));
            }
        });
    }

    function addMessageHandler(handler: (params: any) => void): (() => void) & { isActive: () => boolean } {
        onMessageHandlers.push(handler);
        const unsubscribe = (() => {
            const idx = onMessageHandlers.indexOf(handler);
            if (idx !== -1) onMessageHandlers.splice(idx, 1);
        }) as (() => void) & { isActive: () => boolean };
        unsubscribe.isActive = () => onMessageHandlers.includes(handler);
        return unsubscribe;
    }

    function getStatus(): string {
        return ws && ws.readyState === 1 ? 'connected' : status;
    }

    function getNodeUrl(): string | null { return nodeUrl; }
    function _setNodes(nodes: string[]): void { nodeList = Array.isArray(nodes) ? [...nodes] : []; }
    function _getNodes(): string[] { return [...nodeList]; }
    function _setAutoReconnect(flag: boolean): void { autoreconnect = !!flag; }
    function isConnected(): boolean { return !!(ws && ws.readyState === 1); }

    return {
        connect,
        disconnect,
        call,
        addMessageHandler,
        getStatus,
        getNodeUrl,
        isConnected,
        _setNodes,
        _getNodes,
        _setAutoReconnect,
    };
}

export { createTransport, ConnectionError, AllNodesFailed, RpcError, RpcTimeoutError }

