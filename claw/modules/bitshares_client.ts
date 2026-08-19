// Claw shares the DEXBot2 chain client infrastructure but tracks connection state separately for subsystem isolation.


import { TIMING, NODE_MANAGEMENT } from '../../modules/constants.js';
import { sleep } from '../../modules/order/utils/system.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { readGeneralSettings } from '../../modules/general_settings.js';
import { createChainClient, createSigningClient, createSubscriptionManager } from '../../modules/bitshares-native/index.js';
const DEFAULT_TIMEOUT_MS = TIMING.CONNECTION_TIMEOUT_MS;
const DEFAULT_CHECK_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

let connected = false;
let suppressConnectionLog = false;
let _nativeClient: any = null;
let _connectPromise: any = null;
let _subscriptionManager: any = null;

_nativeClient = createChainClient({
    onStatusChange: handleConnectionStatus,
    rpcTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
    connectTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
});
_nativeClient.setNodes(resolveConfiguredNodes());
_subscriptionManager = createSubscriptionManager(_nativeClient);
_nativeClient.onReconnect = async () => {
    if (_subscriptionManager && typeof _subscriptionManager.onReconnect === 'function') {
        await _subscriptionManager.onReconnect();
    }
};

function resolveConfiguredNodes(): string[] {
    const settings = readGeneralSettings({ fallback: null });
    const configuredNodes = Array.isArray(settings?.NODES?.list)
        ? settings.NODES.list.filter((node: any) => typeof node === 'string' && node.trim())
        : [];
    return configuredNodes.length > 0 ? configuredNodes : NODE_MANAGEMENT.DEFAULT_NODES;
}

function handleConnectionStatus(status: any) {
    const effectiveStatus = status === 'connected' ? 'open' : status;
    if (effectiveStatus === 'open') {
        connected = true;
        if (!suppressConnectionLog) {
            console.log('BitShares shared client connected');
        }
    }
    if (effectiveStatus === 'closed' || effectiveStatus === 'closing') {
        connected = false;
        if (!suppressConnectionLog) {
            console.warn('BitShares shared client disconnected');
        }
    }
}

function setSuppressConnectionLog(suppress: any) {
    suppressConnectionLog = Boolean(suppress);
}

async function ensureConnected() {
    if (connected) return;
    if (_connectPromise) return _connectPromise;

    if (!Array.isArray(_nativeClient.getNodes()) || _nativeClient.getNodes().length === 0) {
        _nativeClient.setNodes(NODE_MANAGEMENT.DEFAULT_NODES);
    }

    _connectPromise = _nativeClient.connect().finally(() => {
        _connectPromise = null;
    });

    return _connectPromise;
}

async function waitForConnected(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const start = Date.now();
    let attemptDelayMs = DEFAULT_CHECK_INTERVAL_MS;

    while (!connected) {
        if (!_connectPromise && _nativeClient.getStatus() !== 'connecting') {
            ensureConnected().catch((err: any) => {
                console.warn(`[CLAW] Connection attempt failed: ${getErrorMessage(err)}`);
            });
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms`);
        }
        // Exponential backoff between retry sweeps so a fast-failing node list
        // does not hammer the network in a tight loop.
        await sleep(attemptDelayMs);
        attemptDelayMs = Math.min(attemptDelayMs * 2, Math.max(DEFAULT_CHECK_INTERVAL_MS, 15000));
    }
}

async function createAccountClient(accountName: any, privateKey: any) {
    if (!accountName) throw new Error('accountName is required');
    if (!privateKey) throw new Error('privateKey is required');

    await waitForConnected();

    const signingClient = createSigningClient(_nativeClient, accountName, privateKey);
    return signingClient.client;
}

function isConnected() {
    return connected;
}

export { createAccountClient, setSuppressConnectionLog, waitForConnected, isConnected }
const BitShares = new Proxy(_nativeClient, {
    get(target: any, prop: string) {
        if (prop === 'node') return target.getNodes();
        if (prop === 'subscribe') {
            return (eventType: any, callback: any, accountName: any) => {
                if (eventType === 'account' && _subscriptionManager) {
                    return _subscriptionManager.subscribe(accountName, callback);
                }
                if (target.subscribe) {
                    return target.subscribe(eventType, callback, accountName);
                }
                throw new Error(`Unsupported subscription event type: ${eventType}`);
            };
        }
        if (prop === 'unsubscribe') {
            return (eventType: any, callback: any, accountName: any) => {
                if (eventType === 'account' && _subscriptionManager) {
                    return _subscriptionManager.unsubscribe(accountName, callback);
                }
                if (target.unsubscribe) {
                    return target.unsubscribe(eventType, callback, accountName);
                }
                throw new Error(`Unsupported subscription event type: ${eventType}`);
            };
        }
        return target[prop];
    }
});
export { BitShares }