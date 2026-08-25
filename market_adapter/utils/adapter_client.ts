'use strict';

import { NODE_MANAGEMENT, TIMING } from '../../modules/constants.js';
import { createReadOnlyClient } from '../../modules/bitshares-native/index.js';

/**
 * market_adapter/utils/adapter_client.ts — Singleton BitShares WS client
 *
 * Provides the same interface as bitshares_client.ts but backed by the native
 * bitshares-native read-only client. No subscriptions — just connect, query,
 * disconnect, with the native transport's node failover and timeout handling.
 *
 * Exported interface (mirrors bitshares_client.ts):
 *   BitShares    — { db, history } JSON-RPC proxies
 *   connectClient(servers)  — connect to a list of WSS nodes
 *   disconnectClient()      — tear down the WebSocket
 *   isConnected()           — check if the WS is open
 *   getNodeUrl()            — currently connected node URL
 */


let _nativeClient: any = null;

function _getClient() {
    if (!_nativeClient) {
        _nativeClient = createReadOnlyClient({
            rpcTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
            connectTimeoutMs: TIMING.CONNECTION_TIMEOUT_MS,
        });
    }
    return _nativeClient;
}

async function connectClient(servers: any) {
    const c = _getClient();
    const list = Array.isArray(servers) && servers.length > 0
        ? servers
        : NODE_MANAGEMENT.DEFAULT_NODES;
    return c.connect(list);
}

function disconnectClient() {
    if (_nativeClient) { _nativeClient.disconnect(); _nativeClient = null; }
}

function isConnected() {
    return _nativeClient ? _nativeClient.isConnected() : false;
}

function getNodeUrl() {
    return _nativeClient ? _nativeClient.getNodeUrl() : null;
}

function _call(api: any, method: any, args: any) {
    const c = _getClient();
    if (!c.isConnected()) {
        return Promise.reject(new Error('WebSocket is not open'));
    }
    return c[api](method, args);
}

const BitShares = {
    db: new Proxy({}, {
        get(_target, method) {
            return (...args: any[]) => _call('db', method, args);
        },
    }),
    history: new Proxy({}, {
        get(_target, method) {
            return (...args: any[]) => _call('history', method, args);
        },
    }),
};

export { BitShares, connectClient, disconnectClient, isConnected, getNodeUrl }

