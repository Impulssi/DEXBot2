/**
 * tests/test_native_facade.ts — Facade and feature flag tests
 *
 * Tests that the bitshares_client.ts facade correctly loads the native path
 * and exports the correct API surface.
 */

const assert = require('assert');

console.log('=== Native Facade Tests ===\n');

// ── Test 1: Native path loads correctly ──────────────────────────────────

console.log('Native facade load');

// Clear require cache to re-load the facade
 delete require.cache[require.resolve('../modules/bitshares_client')];
 delete require.cache[require.resolve('../modules/bitshares-native')];
 delete require.cache[require.resolve('../modules/bitshares-native/index')];

const facade = require('../modules/bitshares_client');

// Verify exports exist
assert.ok(facade.BitShares, 'BitShares should exist');
assert.strictEqual(typeof facade.BitShares, 'object', 'BitShares should be an object (proxy)');
assert.strictEqual(typeof facade.createAccountClient, 'function');
assert.strictEqual(typeof facade.waitForConnected, 'function');
assert.strictEqual(typeof facade.getConnectionStatus, 'function');
assert.strictEqual(typeof facade.disconnectClient, 'function');
assert.strictEqual(typeof facade.reconnectForCycle, 'function');
assert.strictEqual(typeof facade.setSuppressConnectionLog, 'function');
assert.strictEqual(typeof facade.getNodeManager, 'function');
assert.strictEqual(typeof facade.getNodeStats, 'function');
assert.strictEqual(typeof facade.getNodeSummary, 'function');
assert.strictEqual(typeof facade.getConnectionError, 'function');
assert.strictEqual(typeof facade._assessFailover, 'function');
assert.ok(facade._internal, '_internal should exist');

// Verify BitShares proxy methods
const bs = facade.BitShares;
assert.strictEqual(typeof bs.subscribe, 'function', 'BitShares.subscribe should be a function');
assert.strictEqual(typeof bs.unsubscribe, 'function', 'BitShares.unsubscribe should be a function');
assert.ok(bs.db, 'BitShares.db should exist');
assert.ok(bs.history, 'BitShares.history should exist');
assert.strictEqual(typeof bs.db.get_assets, 'function', 'db.get_assets should be a function');
assert.strictEqual(typeof bs.db.get_full_accounts, 'function', 'db.get_full_accounts should be a function');
assert.strictEqual(typeof bs.db.get_order_book, 'function', 'db.get_order_book should be a function');
assert.strictEqual(typeof bs.db.get_ticker, 'function', 'db.get_ticker should be a function');
assert.strictEqual(typeof bs.db.getGlobalProperties, 'function', 'db.getGlobalProperties should be a function');
assert.strictEqual(typeof bs.db.get_dynamic_global_properties, 'function', 'db.get_dynamic_global_properties should be a function');
assert.strictEqual(typeof bs.db.get_liquidity_pools_by_both_assets, 'function', 'db.get_liquidity_pools_by_both_assets should be a function');
assert.strictEqual(typeof bs.db.get_liquidity_pools_by_share_asset, 'function', 'db.get_liquidity_pools_by_share_asset should be a function');
assert.strictEqual(typeof bs.db.list_liquidity_pools, 'function', 'db.list_liquidity_pools should be a function');
assert.strictEqual(typeof bs.db.get_call_orders, 'function', 'db.get_call_orders should be a function');
assert.strictEqual(typeof bs.db.list_assets, 'function', 'db.list_assets should be a function');
assert.strictEqual(typeof bs.db.call, 'function', 'db.call should be a function');
assert.strictEqual(typeof bs.history.getMarketHistory, 'function', 'history.getMarketHistory should be a function');
assert.strictEqual(typeof bs.history.get_account_history_by_operations, 'function');
assert.strictEqual(typeof bs.history.get_liquidity_pool_history, 'function');
assert.strictEqual(typeof bs.history.call, 'function', 'history.call should be a function');
assert.ok(bs.chain, 'chain should exist');
assert.strictEqual(typeof bs.chain.coreAsset, 'string', 'chain.coreAsset should be a string');
assert.ok(bs.assets, 'assets cache should exist');
assert.ok(bs.accounts, 'accounts cache should exist');

// Verify node property
assert.ok(Array.isArray(bs.node), 'BitShares.node should be an array');

console.log('  PASS: All exports verified');

// ── Test 2: API compatibility matrix ─────────────────────────────────────

console.log('API compatibility matrix');

const requiredExports = [
    'BitShares', 'createAccountClient', 'waitForConnected',
    'getConnectionStatus', 'disconnectClient', 'reconnectForCycle',
    'setSuppressConnectionLog', 'getNodeManager', 'getNodeStats',
    'getNodeSummary', 'getConnectionError', '_assessFailover', '_internal',
];

for (const key of requiredExports) {
    assert.ok(key in facade, `facade missing export: ${key}`);
}

console.log('  PASS: All required exports present');

// ── Test 3: Resolvers ────────────────────────────────────────────────────

console.log('Resolvers (LRU Cache)');
const { LRUCache } = require('../modules/bitshares-native/lru_cache');
const { createResolvers } = require('../modules/bitshares-native/resolvers');

// LRU Cache
const cache = new LRUCache(3, 60000);
cache.set('a', 1);
cache.set('b', 2);
cache.set('c', 3);
// Access 'a' moves it to front (now order: b, c, a)
assert.strictEqual(cache.get('a'), 1);
// Set 'd' should evict 'b' (oldest after 'a' was refreshed)
cache.set('d', 4);
assert.strictEqual(cache.get('b'), undefined, 'b should be evicted (oldest)');
assert.strictEqual(cache.get('c'), 3);
assert.strictEqual(cache.get('d'), 4);
assert.strictEqual(cache.get('a'), 1);
assert.strictEqual(cache.size, 3);

// TTL expiration
const ttlCache = new LRUCache(10, 1); // 1ms TTL
ttlCache.set('x', 'value');
assert.strictEqual(ttlCache.get('x'), 'value');
// Wait for expiry
const start = Date.now();
while (Date.now() - start < 5) {} // ~5ms wait
assert.strictEqual(ttlCache.get('x'), undefined); // Should be expired

// Resolvers factory
const { createChainClient } = require('../modules/bitshares-native/chain_client');
const client = createChainClient({ nodes: [], autoreconnect: false });
const resolvers = createResolvers(client);
assert.strictEqual(typeof resolvers.resolveAsset, 'function');
assert.strictEqual(typeof resolvers.resolveAccount, 'function');
assert.strictEqual(typeof resolvers.resolveAccountId, 'function');
assert.strictEqual(typeof resolvers.resolveAccountName, 'function');

console.log('  PASS: Resolvers and LRU cache');

console.log('\n=== All facade tests passed ===');
