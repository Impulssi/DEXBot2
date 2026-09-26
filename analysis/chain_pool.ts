'use strict';

/**
 * SHARED CHAIN POOL (analysis)
 *
 * Single source of truth for the node list and the ephemeral read-only
 * connection used by analysis tools for small on-chain lookups (account name
 * resolution, asset precision resolution).
 *
 * Analysis tools deliberately do NOT use the production singleton client
 * (modules/bitshares_client.ts): they are short-lived processes and must never
 * disturb a running bot's connection state. Instead each lookup opens a fresh
 * read-only client over the built-in node pool, which the native transport
 * races in parallel and then retries sequentially — so one dead node is not
 * fatal.
 */

import * as C from '../modules/constants.js';

/** Nodes for ephemeral read-only analysis connections (node management pool). */
function defaultNodePool(): string[] {
    return [...C.NODE_MANAGEMENT.DEFAULT_NODES];
}

/**
 * Run `fn` against a fresh read-only client connected over the built-in pool.
 * Transport INFO logging is silenced for the duration of the short-lived
 * connection and the client is always disconnected afterwards.
 */
async function withReadOnlyClient<T>(fn: (client: any) => Promise<T>): Promise<T> {
    const { createReadOnlyClient } = await import('../modules/bitshares-native/index.js');
    const client = createReadOnlyClient({ nodes: defaultNodePool() });
    // Suppress transport INFO logs during ephemeral connection:
    // bitshares-native transport logger (new Logger('Transport')) writes
    // "[timestamp] [INFO] [Transport] ..." — silence by raising log level.
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    try {
        await client.connect();
        return await fn(client);
    } finally {
        try { client.disconnect(); } catch (_) { /* best-effort cleanup */ }
        process.env.LOG_LEVEL = prevLevel;
    }
}

export { withReadOnlyClient };
