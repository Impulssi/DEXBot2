/**
 * tests/test_sync_fill_drift_refetch.ts
 *
 * Regression coverage for the "bot went stale because the first of 5 partial
 * fills was misclassified as a full fill" incident (XRP-BTS, 2026-07-03).
 *
 * The fix is two-part, both exercised here:
 *
 *   1. Drift-only refetch: when the cached rawOnChain.for_sale is *smaller*
 *      than the grid's own size (a "drift signal" — chain size can only
 *      decrease, never grow on its own), syncFromFillHistory refetches the
 *      order via readSingleOrder. The refetch is best-effort: a network
 *      error falls back to the cache, and the open-orders sync is the
 *      ultimate recovery channel.
 *
 *   2. Chain-confirmed-empty gate: isEffectivelyFull now requires the chain
 *      to have *freshly* confirmed the order is gone (drift refetch returned
 *      null) OR the grid to also be at 0 OR the other side to round to 0.
 *      It deliberately no longer uses `newSizeInt <= 0` alone — that
 *      misclassification on a stale cache is the bug we're guarding against.
 *
 * Sub-cases:
 *   A. Drift detected + chain still has the order → refetch, partial fill.
 *   B. Drift detected + chain says order is gone (refetch null) → full fill.
 *   C. Drift detected + refetch throws → fall back to cache, do not promote
 *      to "chain confirms empty".
 *   D. No drift (cache == grid) → no refetch; behaviour matches the legacy
 *      self-correcting cache path.
 *   E. No cache at all (no rawOnChain) → no refetch; falls back to grid
 *      size (legacy behaviour preserved for orders that were never synced).
 */

const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');
// Compiled ESM namespaces are frozen: chain_orders is mocked via loader hooks
// so sync_engine's static import resolves to this plain object and per-test
// readSingleOrder behavior can be swapped through the delegating binding.
esmMockEntry();

let readSingleOrderImpl: any = async () => null;
defineEsmMockAbs(require.resolve('../modules/chain_orders'), [
    'selectAccount', 'setPreferredAccount', 'resolveAccountId', 'resolveAccountName',
    'readOpenOrders', 'readOpenOrdersWithMeta', 'readOpenOrdersWithMetaSafe', 'readOpenOrdersGuarded',
    'readSingleOrder', 'batchReadOrders', 'listenForFills', 'updateOrder', 'createOrder', 'cancelOrder',
    'getOnChainAssetBalances', 'getFillProcessingMode', 'buildUpdateOrderOp', 'buildCreateOrderOp',
    'buildCancelOrderOp', 'buildLiquidityPoolExchangeOp', 'executeBatch',
    'findOverReducingUpdateOpError', 'wasRecentlyOwnCancelled', 'recordOwnCancel',
    'BroadcastUncertainError', 'broadcastTxWithClassification'
], {
    BroadcastUncertainError: require('../modules/dexbot_credential_client').BroadcastUncertainError,
    readSingleOrder: (...args: any[]) => readSingleOrderImpl(...args),
    readOpenOrders: async () => [],
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    batchReadOrders: async () => [],
    getOnChainAssetBalances: async () => ({}),
    getFillProcessingMode: async () => 'history',
    wasRecentlyOwnCancelled: () => false,
    recordOwnCancel: () => {},
});

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { _setFeeCache } = require('../modules/order/utils/math');

function suppressNoise() {
    const bsModule = require('../modules/bitshares_client');
    if (bsModule.setSuppressConnectionLog) bsModule.setSuppressConnectionLog(true);
}

function createManager() {
    const mgr = new OrderManager({
        market: 'XRP/BTS', assetA: 'XRP', assetB: 'BTS'
    });
    mgr.assets = {
        assetA: { id: '1.3.5537', symbol: 'XRP', precision: 4 },
        assetB: { id: '1.3.0', symbol: 'BTS', precision: 5 }
    };
    mgr.logger = {
        log: (msg, level) => {
            if (level === 'debug') return;
            console.log(`  ${msg}`);
        }
    };
    // Fresh accountTotals snapshot so the stale-totals fill gate short-circuits
    // (real fetch is unavailable in this test environment).
    mgr.accountTotals = { buy: 100000, sell: 100000, buyFree: 50000, sellFree: 50000, _lastFetchedAt: Date.now() };
    return mgr;
}

function makeSellFillEvent(orderId, amountXrp) {
    return {
        block_num: 12345,
        id: '1.11.999001',
        op: [1, {
            order_id: orderId,
            pays: { amount: Math.round(amountXrp * 10000), asset_id: '1.3.5537' }, // XRP (Asset A)
            receives: { amount: Math.round(amountXrp * 1041.27 * 100000), asset_id: '1.3.0' }, // BTS
            is_maker: true
        }]
    };
}

function installReadSingleOrderMock(_mgr, mockImpl) {
    const original = readSingleOrderImpl;
    readSingleOrderImpl = mockImpl;
    return () => { readSingleOrderImpl = original; };
}

async function testDriftTriggersRefetch() {
    console.log('\n - Drift detected → refetch restores partial fill...');
    const mgr = createManager();
    const orderId = '1.7.572840453';

    // Grid says 2.5788 XRP. Cache says 1.2796 XRP (a prior in-memory reduction
    // that the chain never saw). The drift signal (cached < grid) must fire.
    const staleCachedInt = Math.round(1.2796 * 10000);
    const trueChainInt = Math.round(2.5788 * 10000);
    await mgr._updateOrder({
        id: 'slot-109',
        state: ORDER_STATES.ACTIVE,
        type: ORDER_TYPES.SELL,
        size: 2.5788,
        price: 1041.273399444015,
        orderId,
        rawOnChain: { for_sale: String(staleCachedInt), fetchedAt: Date.now() }
    });

    const restore = installReadSingleOrderMock(mgr, async (id) => {
        assert.strictEqual(id, orderId, 'refetch should target the filled order id');
        return {
            id,
            for_sale: String(trueChainInt),
            sell_price: { base: { amount: 1, asset_id: '1.3.5537' }, quote: { amount: 1041, asset_id: '1.3.0' } }
        };
    });
    try {
        const result = await mgr.sync.syncFromFillHistory(makeSellFillEvent(orderId, 1.2992));

        assert.strictEqual(result.partialFill, true,
            'Drift + working refetch → partial fill (the bot-stale scenario)');
        const slot = mgr.orders.get('slot-109');
        assert.ok(slot, 'slot-109 should still exist');
        assert.strictEqual(slot.state, ORDER_STATES.PARTIAL,
            'Slot should be PARTIAL (chain still has satoshis, refetch was successful)');
    } finally {
        restore();
    }
}

async function testDriftChainConfirmsEmpty() {
    console.log('\n - Drift refetch returns null → chain confirms empty → full fill...');
    const mgr = createManager();
    const orderId = '1.7.572840453';

    const staleCachedInt = Math.round(1.2796 * 10000);
    await mgr._updateOrder({
        id: 'slot-109',
        state: ORDER_STATES.ACTIVE,
        type: ORDER_TYPES.SELL,
        size: 2.5788,
        price: 1041.273399444015,
        orderId,
        rawOnChain: { for_sale: String(staleCachedInt), fetchedAt: Date.now() }
    });

    const restore = installReadSingleOrderMock(mgr, async () => null);
    try {
        const result = await mgr.sync.syncFromFillHistory(makeSellFillEvent(orderId, 1.2992));

        assert.strictEqual(result.partialFill, false,
            'When the chain has confirmed the order is gone, the fill is a full fill');
        const slot = mgr.orders.get('slot-109');
        assert.ok(slot, 'slot-109 should still exist');
        assert.strictEqual(slot.state, ORDER_STATES.VIRTUAL,
            'Slot should be virtualized after a chain-confirmed full fill');
    } finally {
        restore();
    }
}

async function testDriftRefetchFailsFallsBackToCache() {
    console.log('\n - Drift refetch throws → fall back to cache, do not chain-confirm...');
    const mgr = createManager();
    const orderId = '1.7.572840453';

    // Cache has a value larger than the fill so the math clearly does not
    // cross zero, isolating the "no chain-confirm despite drift" behaviour.
    const cachedInt = Math.round(2.5 * 10000);
    await mgr._updateOrder({
        id: 'slot-109',
        state: ORDER_STATES.ACTIVE,
        type: ORDER_TYPES.SELL,
        size: 2.5788,
        price: 1041.273399444015,
        orderId,
        rawOnChain: { for_sale: String(cachedInt), fetchedAt: Date.now() }
    });

    let refetchCalled = false;
    const restore = installReadSingleOrderMock(mgr, async () => {
        refetchCalled = true;
        throw new Error('connection refused');
    });
    try {
        const result = await mgr.sync.syncFromFillHistory(makeSellFillEvent(orderId, 0.1));

        assert.strictEqual(refetchCalled, true, 'drift should trigger a refetch attempt');
        assert.strictEqual(result.partialFill, true,
            'Refetch failure should fall back to the cache (partial fill, not chain-confirmed empty)');
        const slot = mgr.orders.get('slot-109');
        assert.ok(slot, 'slot-109 should still exist');
        assert.strictEqual(slot.state, ORDER_STATES.PARTIAL,
            'Slot should be PARTIAL (chain-confirm gate is closed when refetch fails)');
    } finally {
        restore();
    }
}

async function testNoDriftNoRefetch() {
    console.log('\n - No drift (cache == grid) → no refetch, self-correcting cache path...');
    const mgr = createManager();
    const orderId = '1.7.572840453';

    const sizeInt = Math.round(2.5788 * 10000);
    await mgr._updateOrder({
        id: 'slot-109',
        state: ORDER_STATES.ACTIVE,
        type: ORDER_TYPES.SELL,
        size: 2.5788,
        price: 1041.273399444015,
        orderId,
        rawOnChain: { for_sale: String(sizeInt), fetchedAt: Date.now() }
    });

    let refetchCalled = false;
    const restore = installReadSingleOrderMock(mgr, async () => {
        refetchCalled = true;
        return null;
    });
    try {
        const result = await mgr.sync.syncFromFillHistory(makeSellFillEvent(orderId, 1.2992));
        assert.strictEqual(refetchCalled, false,
            'Cache == grid → no drift signal → no refetch (cache is self-correcting across sequential fills)');
        assert.strictEqual(result.partialFill, true,
            '1.2992 of 2.5788 is a partial fill');
    } finally {
        restore();
    }
}

async function testNoCacheFallsBackToGrid() {
    console.log('\n - No rawOnChain at all → no refetch, fall back to grid size (legacy)...');
    const mgr = createManager();
    const orderId = '1.7.572840453';

    // No rawOnChain seeded (e.g., order that was never reached by an open-orders
    // sync). The legacy fallback path uses the grid's own size.
    await mgr._updateOrder({
        id: 'slot-109',
        state: ORDER_STATES.ACTIVE,
        type: ORDER_TYPES.SELL,
        size: 2.5788,
        price: 1041.273399444015,
        orderId
    });

    let refetchCalled = false;
    const restore = installReadSingleOrderMock(mgr, async () => {
        refetchCalled = true;
        return null;
    });
    try {
        const result = await mgr.sync.syncFromFillHistory(makeSellFillEvent(orderId, 1.2992));
        assert.strictEqual(refetchCalled, false,
            'No cache → no drift signal → no refetch (legacy fallback applies)');
        assert.strictEqual(result.partialFill, true,
            'With no cache, grid size 2.5788 minus 1.2992 fill = 1.2796 partial');
    } finally {
        restore();
    }
}

async function runAll() {
    console.log('Running Drift-Only Refetch Tests...');

    _setFeeCache({
        'BTS': { limitOrderCreate: { bts: 0.1 }, limitOrderUpdate: { bts: 0.001 } },
        'XRP': { marketFee: { percent: 0.2 }, takerFee: { percent: 0.2 } }
    });

    suppressNoise();

    await testDriftTriggersRefetch();
    await testDriftChainConfirmsEmpty();
    await testDriftRefetchFailsFallsBackToCache();
    await testNoDriftNoRefetch();
    await testNoCacheFallsBackToGrid();

    console.log('\n✓ All drift-only refetch tests passed!');
}

runAll().catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});
