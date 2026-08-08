/**
 * Writable chain_keys module stub.
 *
 * Mirrors chain_orders_stub.ts: snapshots the real chain_keys module's
 * exports into a plain writable object so tests can assign overrides like
 * `chainKeys.isDaemonResponsive = ...` without hitting the immutable ESM
 * namespace (getter-only exports).
 */
const { setCachedModule } = require('./module_cache_stub');
const path = require('node:path');

const chainKeysPath = path.resolve(__dirname, '..', '..', 'modules', 'chain_keys.ts');

function installChainKeysStub() {
    const real = require(path.resolve(__dirname, '..', '..', 'modules', 'chain_keys'));
    const writable: Record<string, unknown> = {};
    for (const key of Object.keys(real)) {
        writable[key] = (real as Record<string, unknown>)[key];
    }
    const original = setCachedModule(chainKeysPath, writable);
    return {
        chainKeys: writable as any,
        restore: () => {
            require.cache[chainKeysPath] = original;
        },
    };
}

module.exports = {
    installChainKeysStub,
};
