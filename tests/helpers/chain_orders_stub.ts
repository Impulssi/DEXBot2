/**
 * Writable chain_orders module stub.
 *
 * Under ESM the real chain_orders module exposes an immutable namespace
 * (getter-only exports), so tests that assign overrides like
 * `chainOrders.executeBatch = ...` would throw. This helper snapshots the
 * real module's exports into a plain writable object...
 *
 * LIMITATION: the snapshot only affects CJS `require()` consumers. The
 * compiled ESM graph (sync_engine, accounting, COW runtime, ...) imports
 * chain_orders statically, so it ALWAYS sees the real module — the stub
 * never intercepts those paths. Tests that need to control chain reads on
 * ESM paths must use the loader-hook harness (esm_mocks.ts) or stub a
 * different seam (e.g. manager._readSingleOrderFn). Assigning
 * `chainOrders.readSingleOrder` on the object returned here only affects CJS
 * consumers.
 *
 * NOTE: the offline-safe defaults below apply only to files that actually
 * call installChainOrdersStub(); importing this helper has no effect on its
 * own.
 *
 * Chain reads default to offline-safe stubs (empty / null) so CJS tests
 * that never configure them do not open real WebSocket connections...
 */
const { setCachedModule, restoreCachedModule } = require('./module_cache_stub');
const path = require('node:path');

const chainOrdersPath = path.resolve(__dirname, '..', '..', 'modules', 'chain_orders.ts');
// NOTE: under the compiled layout __dirname is dist/tests/helpers, so the
// path above already points at dist/modules/chain_orders.ts. The
// module_cache_stub dist-mirror would derive dist/dist/... from it, so
// mirror explicitly instead of relying on the default derivation.

const OFFLINE_SAFE_DEFAULTS: Record<string, unknown> = {
    // Targeted order refetch: null = "order is gone" (authoritative empty).
    readSingleOrder: async () => null,
    // Batched refetch: empty map = nothing found on chain.
    batchReadOrders: async () => new Map(),
};

function installChainOrdersStub(overrides: Record<string, unknown> = {}) {
    const real = require(path.resolve(__dirname, '..', '..', 'modules', 'chain_orders'));
    const writable: Record<string, unknown> = {};
    for (const key of Object.keys(real)) {
        writable[key] = (real as Record<string, unknown>)[key];
    }
    Object.assign(writable, OFFLINE_SAFE_DEFAULTS, overrides);
    // { mirrorDist: false }: chainOrdersPath already resolves to the dist
    // file under the compiled layout; the default mirror derivation would
    // target dist/dist/... and miss the module the ESM graph actually uses.
    const original = setCachedModule(chainOrdersPath, writable, { mirrorDist: false } as any);
    return {
        chainOrders: writable as any,
        // Delegate to restoreCachedModule so the restore is symmetric with
        // setCachedModule: an absent original deletes the cache entry instead
        // of leaving `undefined` behind, and the `.ts` alias written above is
        // cleared too (a raw require.cache write here left the stub reachable
        // under the alias).
        restore: () => restoreCachedModule(chainOrdersPath, original, { mirrorDist: false } as any),
    };
}

module.exports = {
    installChainOrdersStub,
};
