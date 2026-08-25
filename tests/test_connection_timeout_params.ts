/**
 * tests/test_connection_timeout_params.ts — Verify connection timeout wiring
 *
 * Confirms that bitshares_client.ts correctly passes BOTH
 * rpcTimeoutMs AND connectTimeoutMs to createChainClient matching
 * TIMING.CONNECTION_TIMEOUT_MS.
 *
 * Compiled ESM namespaces are frozen, so the native client module is stubbed
 * through the loader-hook harness instead of namespace mutation.
 */
'use strict';

const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

esmMockEntry();

const assert = require('assert');

const { TIMING, NATIVE_CLIENT } = require('../modules/constants');
const CONNECTION_TIMEOUT_MS = TIMING.CONNECTION_TIMEOUT_MS;

console.log('=== Connection Timeout Parameter Verification ===\n');

console.log('TIMING.CONNECTION_TIMEOUT_MS            =', CONNECTION_TIMEOUT_MS);
console.log('NATIVE_CLIENT.TRANSPORT.CONNECT_TIMEOUT_MS =', NATIVE_CLIENT.TRANSPORT.CONNECT_TIMEOUT_MS);
console.log('NATIVE_CLIENT.TRANSPORT.RPC_TIMEOUT_MS     =', NATIVE_CLIENT.TRANSPORT.RPC_TIMEOUT_MS);
console.log('');

let capturedConfig: any = null;

defineEsmMockAbs(require.resolve('../modules/bitshares-native/index'), [
    'createChainClient',
    'createSubscriptionManager',
    'createResolvers',
    'createSigningClient',
], {
    createChainClient: (config: any) => {
        capturedConfig = config;
        return {
            connect: async () => {},
            disconnect: () => {},
            setNodes: () => {},
            getNodes: () => [],
            getStatus: () => 'closed',
            getConfig: () => null,
            getCoreAsset: () => '1.3.0',
            db: { call: async () => {} },
            history: { call: async () => {} },
            broadcast: { call: async () => {} },
            login: async () => {},
        };
    },
    createSubscriptionManager: () => ({
        subscribe: () => {},
        unsubscribe: () => {},
        onReconnect: async () => {},
        removeNoticeSubscription: () => {},
    }),
    createResolvers: () => ({
        resolveAsset: () => null,
        resolveAccount: async () => null,
    }),
    createSigningClient: () => ({}),
});

const origLog = console.log;
const origWarn = console.warn;
console.log = () => {};
console.warn = () => {};

const facade = require('../modules/bitshares_client');

// Trigger lazy initialization (the _lazyBitShares proxy calls ensureInitialized
// on first property access)
facade.getConnectionStatus();
console.log = origLog;
console.warn = origWarn;

assert.ok(capturedConfig, 'createChainClient should have been called');

console.log('Config received by createChainClient (from bitshares_client):\n');
console.log('  rpcTimeoutMs:     ', capturedConfig.rpcTimeoutMs);
console.log('  connectTimeoutMs: ', capturedConfig.connectTimeoutMs);
console.log('');

assert.strictEqual(
    capturedConfig.rpcTimeoutMs,
    CONNECTION_TIMEOUT_MS,
    `rpcTimeoutMs must equal TIMING.CONNECTION_TIMEOUT_MS (${CONNECTION_TIMEOUT_MS})`
);

assert.strictEqual(
    capturedConfig.connectTimeoutMs,
    CONNECTION_TIMEOUT_MS,
    `connectTimeoutMs must equal TIMING.CONNECTION_TIMEOUT_MS (${CONNECTION_TIMEOUT_MS})`
);

console.log('=== PASS: Both timeout parameters correctly wired ===');
console.log(`Both use the configured ${CONNECTION_TIMEOUT_MS}ms value.`);
console.log('\n=== Verification complete ===');
