// Claw shares the DEXBot2 chain client infrastructure but tracks connection state separately for subsystem isolation.


import { TIMING, NODE_MANAGEMENT } from '../../modules/constants';
import { sleep } from '../../modules/order/utils/system';
import * as native from '../../modules/bitshares-native';
import { createSigningClient } from '../../modules/bitshares-native';
const DEFAULT_TIMEOUT_MS = TIMING.CONNECTION_TIMEOUT_MS;
const DEFAULT_CHECK_INTERVAL_MS = TIMING.CHECK_INTERVAL_MS;

let connected = false;
let suppressConnectionLog = false;
let _nativeClient: any = null;
let _connectPromise: any = null;

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
        return target[prop];
    }
});
export { BitShares }

