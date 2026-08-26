/**
 * modules/bitshares_client.ts - BitShares Connection Manager
 *
 * Centralized BitShares client connection and account client factory.
 *
 * Features:
 * - Single shared connection for all database queries
 * - Connection state tracking with waitForConnected() helper
 * - Per-account client factory for signing/broadcasting transactions
 * - Subscription and event handling
 *
 * ===============================================================================
 * EXPORTS (16 items)
 * ===============================================================================
 *
 * 1. BitShares - Shared BitShares class for database operations
 *    Used for: querying accounts, assets, orders, subscriptions
 *    Never use for signing transactions
 *
 * 2. createAccountClient(name, key) - Create per-account client for signing
 * 3. waitForConnected(timeoutMs) - Wait for connection to ready state (async)
 * 4. getConnectionStatus() - Get current connection status
 * 5. disconnectClient() - Disconnect the client
 * 6. reconnectForCycle() - Reconnect for maintenance cycle
 * 7. setSuppressConnectionLog(bool) - Suppress/restore connection log output
 * 8. getNodeManager() - Get the NodeManager instance
 * 9. getNodeStats() - Get node health statistics
 * 10. getNodeSummary() - Get node summary
 * 11. getConnectionError() - Get last connection error
 * 12. onReconnect(callback) - Register reconnect callback
 * 13. onReconnect(callback) - Register reconnect callback
 * 14. withTimeout(promise, timeoutMs, options) - Wrap promise with timeout (re-exported from order/utils/timeout.js)
 * 15. _assessFailover() - Internal failover assessment
 * 16. _internal - @internal Internal state (connected flag) — test-only, do not rely on in production
 * ===============================================================================
 */


import { TIMING, NODE_MANAGEMENT, NATIVE_CLIENT } from './constants.js';
import NodeManager from './node_manager.js';
import { readGeneralSettings } from './general_settings.js';
import { sleep } from './order/utils/system.js';
import { withTimeout } from './order/utils/timeout.js';
import Logger from './order/logger.js';
import * as native from './bitshares-native/index.js';
import { createSigningClient } from './bitshares-native/index.js';
import { getErrorMessage } from './utils/errors.js';
const { TRANSPORT } = NATIVE_CLIENT;
const logger = new Logger('bitshares_client');

let connected = false;
let suppressConnectionLog = false;
let lastConnectionError: any = null;
let intentionalDisconnect = false;
let nodeManager: any = null;
let nodeConfig: any = null;
let nodeManagerEnabled = false;
let startupNodeRefreshPromise: any = null;
let failoverAssessmentPromise: any = null;
let reconnectInProgress = false;
let lastFailoverAssessmentAt = 0;
const failoverAssessmentCooldownMs = NODE_MANAGEMENT.FAILOVER_ASSESSMENT_COOLDOWN_MS;

// Reconnection callbacks registered by consumers (e.g. DEXBot)
const _reconnectCallbacks = new Set<() => void>();

/**
 * Register a callback to be called after a successful reconnection.
 * @param {Function} callback - Called with no arguments after subscription re-establishment
 * @returns {Function} Unregister function
 */
function onReconnect(callback: any) {
    if (typeof callback !== 'function') {
        logger.warn(`onReconnect requires a function, got ${typeof callback}`);
        return () => {};
    }
    _reconnectCallbacks.add(callback);
    return () => { _reconnectCallbacks.delete(callback); };
}

async function notifyReconnectCallbacks() {
    if (_reconnectCallbacks.size === 0) return;
    for (const cb of [..._reconnectCallbacks]) {
        try { await Promise.resolve(cb()); } catch (err: any) {
            logger.warn(`Reconnect callback error: ${err?.message || err}`);
        }
    }
}

// Lazy initialization guard
let _initialized = false;

// Native client references (lazily initialized)
let _nativeClient: any = null;
let _subscriptionManager: any = null;
let _nativeBitSharesProxy: any = null;
let _resolvers: any = null;

// Monotonic generation counter for native _nativeClient.connect() calls.
// The native transport's connect() sweep cannot be cancelled, so a timeout
// in the outer withTimeout wrapper only stops the *awaiter* — the sweep
// continues in the background and may resolve later. If the caller has
// since moved on (e.g. failover to a different node list), a late
// resolution would leave _nativeClient connected to the stale node set
// while the caller assumes the connect was abandoned. We tag each
// connect attempt with the current generation and, on resolution, drop
// the result and force a disconnect if the generation has moved on.
let _connectGeneration = 0;

function ensureInitialized() {
    if (_initialized) return;
    _initialized = true;

    const { createSubscriptionManager, createResolvers } = native;
    _nativeClient = native.createChainClient({
        onStatusChange: handleConnectionStatus,
        rpcTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
        connectTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
    });
    _subscriptionManager = createSubscriptionManager(_nativeClient);
    _nativeClient.onReconnect = async () => {
        await _subscriptionManager.onReconnect();
        await notifyReconnectCallbacks();
    };
    _nativeClient.reportNodeFailure = (nodeUrl: string, errorMessage?: string, source?: string) => {
        if (nodeManager) {
            nodeManager.reportNodeFailure(nodeUrl, errorMessage, source);
        }
    };
    _resolvers = createResolvers(_nativeClient);

    _nativeBitSharesProxy = {
        get connect() {
            return (servers: any, _autoreconnect: any) => {
                if (Array.isArray(servers)) _nativeClient.setNodes(servers);
                return _nativeClient.connect();
            };
        },
        get disconnect() { return () => _nativeClient.disconnect(); },
        get node() { return _nativeClient.getNodes(); },
        set node(_v) { _nativeClient.setNodes(Array.isArray(_v) ? _v : []); },
        get autoreconnect() { return true; },
        set autoreconnect(_v) {},
        get connectPromise() { return undefined; },
        set connectPromise(_v) {},
        get subscribe() {
            return (eventType: any, callback: any, accountName: any) => {
                if (eventType === 'account') {
                    return _subscriptionManager.subscribe(accountName, callback);
                }
                if (_nativeClient && _nativeClient.subscribe) {
                    return _nativeClient.subscribe(eventType, callback, accountName);
                }
            };
        },
        get unsubscribe() {
            return (eventType: any, callback: any, accountName: any) => {
                if (eventType === 'account') {
                    return _subscriptionManager.unsubscribe(accountName, callback);
                }
                if (_nativeClient && _nativeClient.unsubscribe) {
                    return _nativeClient.unsubscribe(eventType, callback, accountName);
                }
            };
        },
        get assets() {
            return new Proxy({}, {
                get(_target: any, prop: any) {
                    if (typeof prop !== 'string') return undefined;
                    return _resolvers.resolveAsset(prop);
                },
            });
        },
        get accounts() {
            return new Proxy({}, {
                get(_target: any, prop: any) {
                    if (typeof prop !== 'string') return undefined;
                    return _resolvers.resolveAccount(prop).then((acc: any) => acc || null);
                },
            });
        },
        get chain() { return { get coreAsset() { return _nativeClient.getCoreAsset(); } }; },
        get db() {
            // The native transport (modules/bitshares-native/transport.ts:380)
            // already enforces a per-RPC timeout of TRANSPORT.RPC_TIMEOUT_MS
            // (15s) on every call(). An additional wrapper here would only add
            // dead slack past the native rejection and produce misleading
            // error messages. Pass through directly.
            return new Proxy(_nativeClient.db, {
                get(target: any, prop: any) {
                    if (typeof target[prop] === 'function') {
                        return (...args: any) => target[prop](...args);
                    }
                    return (...args: any) => target.call(prop, args);
                },
            });
        },
        get history() {
            return new Proxy(_nativeClient.history, {
                get(target: any, prop: any) {
                    if (typeof target[prop] === 'function') {
                        return (...args: any) => target[prop](...args);
                    }
                    return (...args: any) => target.call(prop, args);
                },
            });
        },
    };

    const settings = readGeneralSettings({
        fallback: null,
        onError: (err: any) => {
            logger.warn(`Config load failed, continuing with defaults: ${getErrorMessage(err)}`);
        },
    });

    const nodeSettings = settings?.NODES;
    const configuredNodes = Array.isArray(nodeSettings?.list)
        ? nodeSettings.list.filter((node: any) => typeof node === 'string' && node.trim())
        : [];
    nodeManagerEnabled = nodeSettings?.enabled ?? NODE_MANAGEMENT.DEFAULT_ENABLED;

    const effectiveNodes = configuredNodes.length > 0 ? configuredNodes : NODE_MANAGEMENT.DEFAULT_NODES;
    _nativeClient.setNodes(effectiveNodes.slice());
    if (nodeManagerEnabled) {
        nodeConfig = {
            ...nodeSettings,
            enabled: nodeManagerEnabled,
            list: effectiveNodes,
        };
        nodeManager = new NodeManager(nodeConfig);
        logger.info(`Loaded config for ${nodeConfig.list.length} nodes`);
    } else {
        logger.info(`Node management disabled; using ${effectiveNodes.length} configured node(s)`);
    }
}

// BitShares proxy that auto-initializes on first property access
const _lazyBitShares: any = new Proxy({}, {
    get(_target: any, prop: any) {
        ensureInitialized();
        return _nativeBitSharesProxy[prop];
    },
    set(_target: any, prop: any, value: any) {
        ensureInitialized();
        _nativeBitSharesProxy[prop] = value;
        return true;
    },
});

/**
 * Suppress or restore connection log output.
 * @param {boolean} suppress - Whether to suppress connection logs
 * @returns {void}
 */
function setSuppressConnectionLog(suppress: any) {
    suppressConnectionLog = suppress;
}

/**
 * Restart the BitShares connection with a new server list.
 * @param {string|string[]} serverList - Node URL or array of node URLs
 * @param {string} [reason='startup'] - Reason for reconnection
 * @returns {Promise<boolean>} True if connection succeeded
 */
async function restartBitsharesConnection(serverList: any, reason: any = 'startup') {
    ensureInitialized();
    if (reconnectInProgress) return false;
    const servers = Array.isArray(serverList)
        ? serverList.filter((server: any) => typeof server === 'string' && server.trim())
        : [];
    if (servers.length === 0) return false;

    try {
        reconnectInProgress = true;
        connected = false;

        try { _nativeClient.disconnect(); } catch (_: any) {}
        _nativeClient.setNodes(servers);
        const myGeneration = ++_connectGeneration;
        const connectPromise = _nativeClient.connect();
        try {
            await withTimeout(
                connectPromise,
                TRANSPORT.CONNECT_TOTAL_TIMEOUT_MS,
                { label: 'BitShares connection' }
            );
        } catch (connectErr: any) {
            // The native connect() sweep continues in the background even
            // though withTimeout rejected. Tag the sweep with the generation
            // it was started under — its eventual settlement forces a
            // disconnect to keep isConnected() consistent with the caller's
            // timeout. Two cases:
            //   - Generation has moved: a NEW connect is in progress. The
            //     late success would interfere with it, so force-disconnect.
            //   - Generation has NOT moved: no new connect was started. The
            //     late success would leave the transport internally connected
            //     while the module-level `connected` flag is still false,
            //     creating a state mismatch where isConnected() returns false
            //     but the transport is actually live. Force-disconnect to
            //     keep the state consistent.
            connectPromise
                .then(() => {
                    logger.warn(
                        `Late native connect success after timeout ` +
                        `(attempt generation=${myGeneration}, current=${_connectGeneration}). ` +
                        `Forcing disconnect to keep isConnected() state consistent.`
                    );
                    try { _nativeClient.disconnect(); } catch (_: any) {}
                })
                .catch(() => { /* expected when sweep gives up */ });
            throw connectErr;
        }
        if (_subscriptionManager) {
            try { await _subscriptionManager.onReconnect(); } catch (err: any) {
                logger.warn(`Subscription re-establishment after reconnect failed: ${err?.message || err}`);
            }
        }

        // Notify registered reconnection callbacks (e.g. DEXBot safety-net sync)
        await notifyReconnectCallbacks();

        if (!suppressConnectionLog) {
            logger.info(`${reason}: reconnect requested across ${servers.length} node(s)`);
        }
        return true;
    } catch (err: any) {
        lastConnectionError = err;
        try { _nativeClient.disconnect(); } catch (_: any) {}
        if (!suppressConnectionLog) {
            logger.warn(`${reason}: reconnect request failed: ${getErrorMessage(err) || err}`);
        }
        return false;
    } finally {
        reconnectInProgress = false;
    }
}

/**
 * Assess failover: check node health and reconnect to a healthy node if current one is down.
 * @param {string} [reason='status change'] - Reason for failover assessment
 * @returns {Promise<boolean>} True if failover reconnect succeeded
 * @private
 */
async function assessFailover(reason: any = 'status change') {
    ensureInitialized();
    if (!nodeManager || nodeConfig?.healthCheck?.enabled === false) return false;
    if (reconnectInProgress) return false;
    if (failoverAssessmentPromise) return failoverAssessmentPromise;
    // Cooldown: a single close can fan into multiple assessFailover calls
    // (probe socket close + live transport close). Skip the second one for a
    // short window so we only ever do one probe+restart per real disconnect.
    const now = Date.now();
    if (now - lastFailoverAssessmentAt < failoverAssessmentCooldownMs) return false;
    lastFailoverAssessmentAt = now;

    failoverAssessmentPromise = (async () => {
        logger.warn(`${reason}, triggering failover assessment`);
        try {
            const activeNode = _nativeClient?.transport?.getNodeUrl?.();

            await nodeManager.checkAllNodes();
            const healthyNodes = nodeManager.getHealthyNodes();
            const availableHealthyNodes = activeNode
                ? healthyNodes.filter((node: any) => node !== activeNode)
                : healthyNodes;
            const fallbackNodes = getConfiguredOrDefaultNodes();
            const availableFallbackNodes = activeNode
                ? fallbackNodes.filter((node: any) => node !== activeNode)
                : fallbackNodes;
            const nextNodes = availableHealthyNodes.length > 0
                ? availableHealthyNodes
                : (healthyNodes.length > 0 ? healthyNodes : (availableFallbackNodes.length > 0 ? availableFallbackNodes : fallbackNodes));
            // Avoid restarting to the same node we are already on. With the
            // transport connect() no-op, a redundant restart is at best a
            // no-op and at worst a forced disconnect cycle.
            if (activeNode && (nextNodes.length === 0 || (nextNodes.length === 1 && nextNodes[0] === activeNode))) {
                logger.info(`${reason}: no better node available, keeping ${activeNode}`);
                return false;
            }
            return restartBitsharesConnection(nextNodes, reason);
        } catch (err: any) {
            logger.warn(`Failover assessment error: ${getErrorMessage(err)}`);
            return false;
        }
    })();

    try {
        return await failoverAssessmentPromise;
    } finally {
        failoverAssessmentPromise = null;
    }
}

/**
 * Get the configured node list, falling back to defaults.
 * @returns {string[]} Array of node URLs
 */
function getConfiguredOrDefaultNodes() {
    ensureInitialized();
    return Array.isArray(nodeConfig?.list) && nodeConfig.list.length > 0
        ? nodeConfig.list
        : NODE_MANAGEMENT.DEFAULT_NODES;
}

/**
 * Handle connection status change events from the native client.
 * @param {string} status - Connection status string ('connected', 'connecting', 'closed')
 * @returns {boolean} Whether the event was handled
 */
function handleConnectionStatus(status: any) {
    const canHandleFailover = nodeManager && nodeConfig?.healthCheck?.enabled !== false;

    if (status === 'connected') {
        connected = true;
        lastConnectionError = null;
        if (nodeManager && nodeConfig?.healthCheck?.enabled !== false && !nodeManager.monitoringActive) {
            nodeManager.start();
        }
        if (!suppressConnectionLog) {
            logger.info('BitShares connected');
        }
        return false;
    }

    if (status === 'closed') {
        connected = false;
        if (canHandleFailover && !reconnectInProgress) {
            if (intentionalDisconnect) {
                return true;
            }
            assessFailover('Connection closed').catch((err: any) => {
                logger.warn(`Failover assessment failed: ${getErrorMessage(err)}`);
            });
            return true;
        }
    }
    return false;
}

/**
 * Refresh node servers at startup by health-checking all configured nodes.
 * @param {string} [reason='startup'] - Reason for the refresh
 * @returns {Promise<string[]>} Array of selected node URLs
 */
async function refreshStartupNodeServers(reason: any = 'startup') {
    ensureInitialized();
    if (!nodeManager || !nodeConfig?.list?.length) {
        return Array.isArray(nodeConfig?.list) ? nodeConfig.list : [];
    }
    if (startupNodeRefreshPromise) return startupNodeRefreshPromise;

    startupNodeRefreshPromise = (async () => {
        try {
            if (nodeConfig.healthCheck?.enabled === false) {
                const fallbackNodes = getConfiguredOrDefaultNodes();
                await restartBitsharesConnection(fallbackNodes, `Startup ${reason}`);
                if (!suppressConnectionLog) {
                    logger.info(`Startup ${reason}: using ${fallbackNodes.length} configured node(s) without health probing`);
                }
                return fallbackNodes;
            }
            await nodeManager.checkAllNodes();
            const healthyNodes = nodeManager.getHealthyNodes();
            const nextNodes = healthyNodes.length > 0 ? healthyNodes : getConfiguredOrDefaultNodes();
            await restartBitsharesConnection(nextNodes, `Startup ${reason}`);
            if (!suppressConnectionLog) {
                logger.info(`Startup ${reason}: using ${nextNodes.length} node(s)`);
            }
            return nextNodes;
        } catch (err: any) {
            if (!suppressConnectionLog) {
                logger.warn(`Startup ${reason} node refresh failed: ${getErrorMessage(err)}`);
            }
            return getConfiguredOrDefaultNodes();
        }
    })();

    try {
        return await startupNodeRefreshPromise;
    } finally {
        startupNodeRefreshPromise = null;
    }
}

/**
 * Wait for the BitShares connection to become ready.
 * @param {number} [timeoutMs=TIMING.CONNECTION_TIMEOUT_MS] - Max time to wait in ms
 * @param {Object} [options={}] - Wait options
 * @param {number} [options.retryDelayMs] - Initial retry delay in ms
 * @param {number} [options.maxRetryDelayMs] - Maximum retry delay in ms
 * @param {number} [options.refreshNodesEveryMs] - Interval to refresh nodes while waiting
 * @returns {Promise<boolean>} True when connected
 * @throws {Error} If connection times out
 */
async function waitForConnected(timeoutMs: any = TIMING.CONNECTION_TIMEOUT_MS, options: { retryDelayMs?: number; maxRetryDelayMs?: number; refreshNodesEveryMs?: number } = {}) {
    ensureInitialized();
    const start = Date.now();
    const initialDelayMs = Number.isFinite(options.retryDelayMs)
        ? Math.max(0, options.retryDelayMs!)
        : NODE_MANAGEMENT.STARTUP_RETRY_INITIAL_DELAY_MS;
    const maxDelayMs = Number.isFinite(options.maxRetryDelayMs)
        ? Math.max(initialDelayMs, options.maxRetryDelayMs!)
        : NODE_MANAGEMENT.STARTUP_RETRY_MAX_DELAY_MS;
    const refreshNodesEveryMs = Number.isFinite(options.refreshNodesEveryMs)
        ? Math.max(0, options.refreshNodesEveryMs!)
        : NODE_MANAGEMENT.STARTUP_REFRESH_INTERVAL_MS;
    let retryDelayMs = initialDelayMs;
    let nextNodeRefreshAt = 0;

    while (!connected) {
        const elapsedMs = Date.now() - start;
        if (elapsedMs >= timeoutMs) break;

        if (nodeManagerEnabled && Date.now() >= nextNodeRefreshAt) {
            const remainingBeforeRefreshMs = timeoutMs - (Date.now() - start);
            if (remainingBeforeRefreshMs <= 0) break;
            await Promise.race([
                refreshStartupNodeServers(elapsedMs === 0 ? 'initial' : 'retry'),
                sleep(Math.max(0, remainingBeforeRefreshMs)),
            ]);
            nextNodeRefreshAt = Date.now() + refreshNodesEveryMs;
        }

        if (connected) break;

        const remainingMs = timeoutMs - (Date.now() - start);
        const sleepMs = Math.min(retryDelayMs, Math.max(0, remainingMs));
        if (sleepMs > 0) await sleep(sleepMs);
        retryDelayMs = Math.min(maxDelayMs, retryDelayMs > 0 ? retryDelayMs * 2 : maxDelayMs);
    }

    if (!connected) {
        const suffix = lastConnectionError?.message ? ` Last error: ${lastConnectionError.message}` : '';
        throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms.${suffix}`);
    }
    return true;
}

/**
 * Create a per-account client for signing transactions.
 * @param {string} accountName - Account name
 * @param {string|Object} privateKey - Private key or daemon signing token
 * @returns {Promise<Object>} Account client with initPromise, newTx(), broadcast()
 */
async function createAccountClient(accountName: any, privateKey: any) {
    ensureInitialized();
    await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);

    const signingClient = createSigningClient(_nativeClient, accountName, privateKey);
    return signingClient.client;
}

/**
 * Get the current connection status.
 * @returns {string} Status string from native client
 */
function getConnectionStatus() {
    ensureInitialized();
    return _nativeClient.getStatus();
}

/**
 * Disconnect the BitShares client.
 * @returns {Promise<void>}
 */
async function disconnectClient() {
    // Nothing to tear down if the client was never initialized. Calling
    // ensureInitialized() here would lazily create the whole client stack
    // (including the "Loaded config for N nodes" log) just to immediately
    // discard it — e.g. `dexbot bot` after an idle bot-manager session.
    if (!_initialized) return;
    intentionalDisconnect = true;
    connected = false;
    try {
        try { _nativeClient.disconnect(); } catch (_: any) {}
        if (_subscriptionManager) {
            try {
                if (typeof _subscriptionManager.removeNoticeSubscription === 'function') {
                    _subscriptionManager.removeNoticeSubscription();
                }
            } catch (_: any) {}
        }
    } finally {
        intentionalDisconnect = false;
    }
}

/**
 * Reconnect using healthy nodes (for adapter cycles or periodic refresh).
 * @param {string} [reason='adapter-cycle'] - Reason for reconnection
 * @returns {Promise<boolean>} True if reconnection succeeded
 */
async function reconnectForCycle(reason: any = 'adapter-cycle') {
    ensureInitialized();
    const nodes = nodeManager && nodeConfig?.healthCheck?.enabled !== false
        ? nodeManager.getHealthyNodes()
        : [];
    const effective = nodes.length > 0 ? nodes : getConfiguredOrDefaultNodes();
    return restartBitsharesConnection(effective, reason);
}

function getNodeManager() {
    ensureInitialized();
    return nodeManager;
}
function getNodeStats() {
    ensureInitialized();
    return nodeManager?.getStats();
}
function getNodeSummary() {
    ensureInitialized();
    return nodeManager?.getSummary();
}
function getConnectionError() {
    return lastConnectionError;
}
/** @internal Exposed for unit tests only — do not rely on in production code. */
const _internal = {
    get connected() { return connected; },
};

const _default = { BitShares: _lazyBitShares, createAccountClient, waitForConnected, getConnectionStatus, disconnectClient, reconnectForCycle, setSuppressConnectionLog, onReconnect, withTimeout, _assessFailover: assessFailover, getNodeManager, getNodeStats, getNodeSummary, getConnectionError, _internal }
export default _default;
export { _lazyBitShares as BitShares, createAccountClient, waitForConnected, getConnectionStatus, disconnectClient, reconnectForCycle, setSuppressConnectionLog, onReconnect, withTimeout, assessFailover as _assessFailover, getNodeManager, getNodeStats, getNodeSummary, getConnectionError, _internal }
