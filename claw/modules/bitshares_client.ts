// Claw shares the DEXBot2 chain client infrastructure but tracks connection state separately for subsystem isolation.
const { TIMING, NODE_MANAGEMENT } = require('../../modules/constants');
const { sleep } = require('../../modules/order/utils/system');

const DEFAULT_TIMEOUT_MS = TIMING.CONNECTION_TIMEOUT_MS;
const DEFAULT_CHECK_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

let connected = false;
let suppressConnectionLog = false;
let _nativeClient: any = null;
let _connectPromise: any = null;

const native = require('../../modules/bitshares-native');
_nativeClient = native.createChainClient({
    onStatusChange: handleConnectionStatus,
    rpcTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
    connectTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
});
_nativeClient.setNodes(NODE_MANAGEMENT.DEFAULT_NODES);

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

    while (!connected) {
        if (!_connectPromise && _nativeClient.getStatus() !== 'connecting') {
            ensureConnected().catch((err: any) => {
                console.warn(`[CLAW] Connection attempt failed: ${err.message}`);
            });
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timed out waiting for BitShares connection after ${timeoutMs}ms`);
        }
        await sleep(DEFAULT_CHECK_INTERVAL_MS);
    }
}

async function createAccountClient(accountName: any, privateKey: any) {
    if (!accountName) throw new Error('accountName is required');
    if (!privateKey) throw new Error('privateKey is required');

    await waitForConnected();

    const { createSigningClient } = require('../../modules/bitshares-native');
    const signingClient = createSigningClient(_nativeClient, accountName, privateKey);
    return signingClient.client;
}

export = {
    BitShares: _nativeClient ? {
        get connect() {
            return (servers: any) => {
                if (Array.isArray(servers) && servers.length > 0) {
                    _nativeClient.setNodes(servers);
                }
                return ensureConnected();
            };
        },
        get disconnect() {
            return () => {
                _connectPromise = null;
                return _nativeClient.disconnect();
            };
        },
        get node() { return _nativeClient.getNodes(); },
        set node(v) { _nativeClient.setNodes(Array.isArray(v) ? v : []); },
        get chain() { return { get coreAsset() { return _nativeClient.getCoreAsset(); } }; },
        get db() { return _nativeClient.db; },
        get history() { return _nativeClient.history; },
        subscribe(...args: any[]) { return _nativeClient.subscribe ? _nativeClient.subscribe(...args) : undefined; },
        unsubscribe(...args: any[]) { if (_nativeClient.unsubscribe) _nativeClient.unsubscribe(...args); },
    } : null,
    createAccountClient,
    isConnected: () => connected,
    setSuppressConnectionLog,
    waitForConnected,
};
