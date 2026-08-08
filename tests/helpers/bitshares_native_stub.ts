/**
 * Writable bitshares-native module stub.
 *
 * Mirrors chain_orders_stub.ts: snapshots the real bitshares-native module's
 * exports into a plain writable object so tests can assign overrides like
 * `native.createChainClient = ...` without hitting the immutable ESM
 * namespace (getter-only exports).
 */
const { setCachedModule } = require('./module_cache_stub');
const path = require('node:path');

const nativePath = path.resolve(__dirname, '..', '..', 'modules', 'bitshares-native', 'index.ts');

function installBitsharesNativeStub() {
    const real = require(path.resolve(__dirname, '..', '..', 'modules', 'bitshares-native'));
    const writable: Record<string, unknown> = {};
    for (const key of Object.keys(real)) {
        writable[key] = (real as Record<string, unknown>)[key];
    }
    const original = setCachedModule(nativePath, writable);
    return {
        native: writable as any,
        restore: () => {
            require.cache[nativePath] = original;
        },
    };
}

module.exports = {
    installBitsharesNativeStub,
};
