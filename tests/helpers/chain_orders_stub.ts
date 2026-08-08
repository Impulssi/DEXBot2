/**
 * Writable chain_orders module stub.
 *
 * Under ESM the real chain_orders module exposes an immutable namespace
 * (getter-only exports), so tests that assign overrides like
 * `chainOrders.executeBatch = ...` would throw. This helper snapshots the
 * real module's exports into a plain writable object and re-registers it in
 * require.cache so every CJS `require()` of chain_orders — and any module
 * loaded through the require-hook (the test runtime graph) — resolves to the
 * same mutable instance.
 */
const { setCachedModule } = require('./module_cache_stub');
const path = require('node:path');

const chainOrdersPath = path.resolve(__dirname, '..', '..', 'modules', 'chain_orders.ts');

function installChainOrdersStub() {
    const real = require(path.resolve(__dirname, '..', '..', 'modules', 'chain_orders'));
    const writable: Record<string, unknown> = {};
    for (const key of Object.keys(real)) {
        writable[key] = (real as Record<string, unknown>)[key];
    }
    const original = setCachedModule(chainOrdersPath, writable);
    return {
        chainOrders: writable as any,
        restore: () => {
            require.cache[chainOrdersPath] = original;
        },
    };
}

module.exports = {
    installChainOrdersStub,
};
