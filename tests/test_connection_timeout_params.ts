/**
 * tests/test_connection_timeout_params.ts — Verify connection timeout wiring
 *
 * Confirms that bitshares_client.ts correctly passes BOTH
 * rpcTimeoutMs AND connectTimeoutMs to createChainClient matching
 * TIMING.CONNECTION_TIMEOUT_MS.
 */
const assert = require('assert');

console.log('=== Connection Timeout Parameter Verification ===\n');

const { TIMING, NATIVE_CLIENT } = require('../modules/constants');
const CONNECTION_TIMEOUT_MS = TIMING.CONNECTION_TIMEOUT_MS;

console.log('TIMING.CONNECTION_TIMEOUT_MS            =', CONNECTION_TIMEOUT_MS);
console.log('NATIVE_CLIENT.TRANSPORT.CONNECT_TIMEOUT_MS =', NATIVE_CLIENT.TRANSPORT.CONNECT_TIMEOUT_MS);
console.log('NATIVE_CLIENT.TRANSPORT.RPC_TIMEOUT_MS     =', NATIVE_CLIENT.TRANSPORT.RPC_TIMEOUT_MS);
console.log('');

const { installBitsharesNativeStub } = require('./helpers/bitshares_native_stub');
const { native } = installBitsharesNativeStub();

let capturedConfig: any = null;
native.createChainClient = function (config) {
  capturedConfig = config;
  return {
    connect: async () => {},
    disconnect: () => {},
    setNodes: () => {},
    getNodes: () => [],
    getStatus: () => 'closed',
    getConfig: () => null,
    getCoreAsset: () => '1.3.0',
    db:  { call: async () => {} },
    history: { call: async () => {} },
    broadcast: { call: async () => {} },
    login: async () => {},
  };
};

const facadePath = require.resolve('../modules/bitshares_client');
delete require.cache[facadePath];
delete require.cache[require.resolve('../modules/general_settings')];

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
