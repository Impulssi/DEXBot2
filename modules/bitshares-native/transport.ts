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
    validateNode?: (() => Promise<void>) | null;
    keepAliveIntervalMs?: number;
}

function createTransport(config: TransportConfig = {}) {
    const {
        connectTimeoutMs = CONNECT_TIMEOUT_MS,
        rpcTimeoutMs = RPC_TIMEOUT_MS,
        onStatusChange = null,
        onReconnect = null,
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
                    if (keepAliveFailures >= MAX_KEEPALIVE_FAILURES) {
                        console.warn(`[TRANSPORT] Keep-alive failed ${keepAliveFailures} times, forcing reconnect`);
                        autoreconnect = true;
                        intentionalClose = false;
                        if (ws) {
                            try { ws.close(); } catch (_: any) {}
                        }
                    } else {
                        console.warn(`[TRANSPORT] Keep-alive call failed (${keepAliveFailures}/${MAX_KEEPALIVE_FAILURES})`);
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
        nodeUrl = url;
        nodeIndex = idx;
        reconnectAttempts = 0;
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

    async function tryConnect(): Promise<void> {
        intentionalClose = false;
        const list = [...nodeList];
        if (list.length === 0) {
            setStatus('closed');
            return;
        }

        const wasReconnect = reconnectAttempts > 0;

        // Parallel connect strategy: race all nodes concurrently so the fastest
        // connecting node wins. Each individual connectOne still has its own
        // per-node timeout (connectTimeoutMs), so worst-case wall time is
        // connectTimeoutMs instead of list.length * connectTimeoutMs.
        const connectPromises = list.map((_url, i) => {
            const idx = (nodeIndex + i) % list.length;
            const actualUrl = list[idx];
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
            return;
        } catch (firstErr: any) {
            // All parallel attempts failed. Fall back to sequential retry for
            // environments where parallel connection floods are problematic.
            const errMsg = firstErr?.errors ? firstErr.errors.map((e: any) => e?.message || e).join('; ') : (firstErr?.message || firstErr);
            transportLogger.warn(`Parallel connect failed (${list.length} nodes), falling back to sequential: ${errMsg}`);
            // Fall through to sequential logic below
        }

        // Sequential fallback pass.
        const errors: Error[] = [];
        for (let i = 0; i < list.length; i++) {
            const idx = (nodeIndex + i) % list.length;
            const url = list[idx];
            try {
                setStatus('connecting');
                const socket = await connectOne(url);
                await _onConnected(socket, url, idx, wasReconnect);
                return;
            } catch (err: any) {
                if (ws) {
                    ws.onclose = null;
                    try { ws.close(); } catch (_: any) {}
                    ws = null;
                }
                errors.push(err);
            }
        }

        nodeIndex = 0;
        setStatus('closed');
        throw new AllNodesFailed(errors);
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

