/**
 * tests/test_sync_fill_history_batch.ts
 *
 * Tests syncFromFillHistoryBatch — batch processing of multiple fill-history
 * events that acquires _gridLock once and batches drift refetch into one RPC.
 *
 * Coverage:
 *   1. Two partial fills in one batch (drift refetch batched)
 *   2. Full + partial mix in batch
 *   3. Ghost order detection preserves orderId in batch.
 *   4. Replay fill filtered during accounting (skip in batch)
 *   5. Missing grid order skipped gracefully
 *   6. Fallback to individual on batch drift refetch error
 *   7. (removed — ghost order batch aggregation retired)
 *   8. Empty fills array returns early
 *   9. Sequential processValidFills branch: single fill still uses individual path
 *  10. SPREAD-slot full/partial fills resolve the real side (BUY/SELL) on the
 *      fill object so the boundary crawl is not lost (regression for the
 *      filledOrderResult.type gap).
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const chainOrders = require('../modules/chain_orders');

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

function makeSellFillEvent(orderId, amountXrp, blockNum = 12345, historyId = '1.11.999001') {
    const price = 1041.273399444015;
    return {
        block_num: blockNum,
        id: historyId,
        op: [1, {
            order_id: orderId,
            pays: { amount: Math.round(amountXrp * 10000), asset_id: '1.3.5537' },
            receives: { amount: Math.round(amountXrp * price * 100000), asset_id: '1.3.0' },
            is_maker: true
        }]
    };
}

function _makeBuyFillEvent(orderId, amountBts, blockNum = 12346, historyId = '1.11.999002') {
    return {
        block_num: blockNum,
        id: historyId,
        op: [1, {
            order_id: orderId,
            pays: { amount: Math.round(amountBts * 100000), asset_id: '1.3.0' },
            receives: { amount: Math.round(amountBts / 1041.27 * 10000), asset_id: '1.3.5537' },
            is_maker: true
        }]
    };
}

function installBatchReadOrdersMock(_mgr, mockImpl) {
    const original = chainOrders.batchReadOrders;
    chainOrders.batchReadOrders = mockImpl;
    return () => { chainOrders.batchReadOrders = original; };
}

async function testTwoPartialFillsBatch() {
    console.log('\n - Two partial fills in one batch (batched drift refetch)...');
    const mgr = createManager();
    const orderId1 = '1.7.100001';
    const orderId2 = '1.7.100002';

    // Place two active orders
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId1,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });
    await mgr._updateOrder({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 3.0, price: 1041.273399444015, orderId: orderId2,
        rawOnChain: { for_sale: String(Math.round(3.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill1 = makeSellFillEvent(orderId1, 0.5, 100, '1.11.1001');
    const fill2 = makeSellFillEvent(orderId2, 0.3, 100, '1.11.1002');

    const result = await mgr.syncFromFillHistoryBatch([fill1, fill2], {
        persistenceMode: 'batched'
    });

    assert.ok(result.filledOrders.length >= 1, 'Should produce at least one filled order');
    assert.ok(result.partialFill, 'Should be partial fills');
    const slot0 = mgr.orders.get('slot-0');
    const slot1 = mgr.orders.get('slot-1');
    assert.ok(slot0.size < 5.0, 'slot-0 size should have decreased');
    assert.ok(slot1.size < 3.0, 'slot-1 size should have decreased');
    console.log('  PASS');
}

async function testFullAndPartialMix() {
    console.log('\n - Full fill + partial fill in same batch...');
    const mgr = createManager();
    const orderId1 = '1.7.200001';
    const orderId2 = '1.7.200002';

    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 1041.273399444015, orderId: orderId1,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });
    await mgr._updateOrder({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId2,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    // Full fill on slot-0 (1.0 XRP at low price -> other side rounds to 0 -> ghost)
    // Partial on slot-1 (0.5 XRP)
    const fill1 = makeSellFillEvent(orderId1, 1.0, 200, '1.11.2001');
    const fill2 = makeSellFillEvent(orderId2, 0.5, 200, '1.11.2002');

    await mgr.syncFromFillHistoryBatch([fill1, fill2], {
        persistenceMode: 'batched'
    });

    const slot0 = mgr.orders.get('slot-0');
    const slot1 = mgr.orders.get('slot-1');
    // Full fill with low price -> other-side rounds to 0 -> ghost (PARTIAL with orderId)
    assert.ok(slot0.state === ORDER_STATES.PARTIAL, `Ghost-filled slot should be PARTIAL, got ${slot0.state}`);
    assert.ok(slot0.size === 0, 'Full-filled slot size should be 0');
    assert.ok(slot1.state === ORDER_STATES.PARTIAL, 'Partial-filled slot should be PARTIAL');
    assert.ok(slot1.size < 5.0, 'Partial-filled slot size should have decreased');
    console.log('  PASS');
}

async function testGhostOrderInBatch() {
    console.log('\n - Ghost order detection in batch preserves orderId...');
    const mgr = createManager();
    // Use a high-precision asset B where the "other side" rounds to 0
    const orderId = '1.7.300001';

    // Sell 1 XRP at 1041.27 -> receives ~1041.27 BTS
    // If we fill the entire sell, the other side is 0 -> ghost
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 0.0001, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill = makeSellFillEvent(orderId, 1.0, 300, '1.11.3001');
    const result = await mgr.syncFromFillHistoryBatch([fill], {
        persistenceMode: 'batched'
    });

    const slot0 = mgr.orders.get('slot-0');
    // Ghost: SPREAD state, orderId preserved (as PARTIAL)
    assert.ok(slot0.state === ORDER_STATES.PARTIAL || slot0.state === ORDER_STATES.SPREAD,
        `Ghost slot should not be ACTIVE (state=${slot0.state})`);
    console.log('  PASS');
}

async function testReplayFillSkippedInBatch() {
    console.log('\n - Replay fill is skipped in batch...');
    const mgr = createManager();
    const orderId = '1.7.400001';

    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill = makeSellFillEvent(orderId, 0.5, 400, '1.11.4001');

    // Process twice: first applies, second should be replay
    const result1 = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });
    const result2 = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });

    assert.ok(result1.filledOrders.length > 0, 'First call should produce filled orders');
    assert.ok(result2.filledOrders.length === 0, 'Replay call should produce no filled orders');
    const slot0 = mgr.orders.get('slot-0');
    assert.ok(slot0.size < 5.0, 'Slot size should reflect only the first fill');
    console.log('  PASS');
}

async function testMissingGridOrderSkipped() {
    console.log('\n - Missing grid order is skipped gracefully in batch...');
    const mgr = createManager();
    const orderIdKnown = '1.7.500001';
    const orderIdUnknown = '1.7.599999';

    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderIdKnown,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    const fillKnown = makeSellFillEvent(orderIdKnown, 0.5, 500, '1.11.5001');
    const fillUnknown = makeSellFillEvent(orderIdUnknown, 0.3, 500, '1.11.5999');

    // Should not throw despite unknown order
    const result = await mgr.syncFromFillHistoryBatch([fillKnown, fillUnknown], {
        persistenceMode: 'batched'
    });

    assert.ok(result.filledOrders.length >= 1, 'Known order fill should still produce filled orders');
    assert.strictEqual(result.requiresOpenOrdersSync, true, 'Unknown order fill should request open-orders sync');
    console.log('  PASS');
}

async function testBatchDriftRefetchFallback() {
    console.log('\n - Batch drift refetch error falls back to cache...');
    const mgr = createManager();
    const orderId = '1.7.600001';

    // Drift signal: cached < grid
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });

    // Mock batchReadOrders to throw
    const restore = installBatchReadOrdersMock(mgr, async () => {
        throw new Error('connection refused (simulated)');
    });
    try {
        const fill = makeSellFillEvent(orderId, 0.5, 600, '1.11.6001');
        const result = await mgr.syncFromFillHistoryBatch([fill], {
            persistenceMode: 'batched'
        });
        // Should still produce a result, using cached value as fallback.
        // The fallback must use the cached rawOnChain.for_sale (1.0), not the
        // grid size (5.0): effectiveRawForSale = refetchInfo ?? rawForSaleInt
        // (sync_engine.ts). Pinning the exact arithmetic distinguishes the
        // cache-derived remaining size (1.0 - 0.5 = 0.5) from a regression
        // that silently fell back to the grid (5.0 - 0.5 = 4.5) or zeroed the
        // baseline (full-fill virtualization, size 0).
        assert.strictEqual(result.filledOrders.length, 1, 'refetch failure should still produce the filled order');
        assert.strictEqual(result.partialFill, true,
            'refetch failure must stay a partial fill — the cache cannot confirm chain emptiness');
        const slot0 = mgr.orders.get('slot-0');
        assert.strictEqual(slot0.size, 0.5,
            'fallback must use cached for_sale (1.0) - 0.5 fill = 0.5 remaining, not the grid-based 4.5');
        assert.strictEqual(slot0.state, ORDER_STATES.PARTIAL,
            'slot must remain PARTIAL (chain-confirm gate closed on refetch error)');
        assert.strictEqual(slot0.rawOnChain.for_sale, '5000',
            'cached for_sale must be decremented by the fill (10000 - 5000)');
    } finally {
        restore();
    }
    console.log('  PASS');
}

async function testEmptyFillsArray() {
    console.log('\n - Empty fills array returns early...');
    const mgr = createManager();
    const result = await mgr.syncFromFillHistoryBatch([], { persistenceMode: 'batched' });
    assert.ok(result.filledOrders.length === 0, 'Should have no filled orders');
    assert.strictEqual(result.partialFill, false, 'Should not be partial');
    console.log('  PASS');
}

async function testAggregatedGhostOrderIds() {
    console.log('\n - Batch returns aggregated ghostOrderIds from multiple fills... (retired)');
    const mgr = createManager();
    const orderId1 = '1.7.700001';
    const orderId2 = '1.7.700002';

    // Two orders that will both produce ghost fills
    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 0.0001, orderId: orderId1,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });
    await mgr._updateOrder({
        id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 1.0, price: 0.0001, orderId: orderId2,
        rawOnChain: { for_sale: String(Math.round(1.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill1 = makeSellFillEvent(orderId1, 1.0, 700, '1.11.7001');
    const fill2 = makeSellFillEvent(orderId2, 1.0, 700, '1.11.7002');

    await mgr.syncFromFillHistoryBatch([fill1, fill2], {
        persistenceMode: 'batched'
    });

    console.log('  PASS');
}

async function testSingleFillViaBatch() {
    console.log('\n - syncFromFillHistoryBatch handles a single fill correctly...');
    const mgr = createManager();
    const orderId = '1.7.800001';

    await mgr._updateOrder({
        id: 'slot-0', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
        size: 5.0, price: 1041.273399444015, orderId: orderId,
        rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
    });

    const fill = makeSellFillEvent(orderId, 0.5, 800, '1.11.8001');
    // syncFromFillHistoryBatch with a single fill should work like syncFromFillHistory
    const result = await mgr.syncFromFillHistoryBatch([fill], {
        persistenceMode: 'batched'
    });

    assert.ok(result.filledOrders.length > 0, 'Single fill should produce filled orders');
    const slot0 = mgr.orders.get('slot-0');
    assert.ok(slot0.size < 5.0, 'Slot size should reflect fill');
    console.log('  PASS');
}

/**
 * Regression: a SPREAD slot carrying an on-chain order (spread-correction
 * activation) must report the resolved BUY/SELL side on the fill object.
 * Before the fix filledOrderResult kept the SPREAD grid type, so
 * deriveTargetBoundary (which only shifts on BUY/SELL) never crawled the
 * boundary — the grid shift was silently lost on full/ghost fills.
 */
function boundaryShiftOf(filledOrder, allSlots) {
    const { deriveTargetBoundary } = require('../modules/order/utils/order');
    const { boundaryIdx } = deriveTargetBoundary(
        [filledOrder],
        1,
        allSlots,
        { startPrice: 1000, activeOrders: { sell: 5, buy: 5 } },
        3
    );
    return boundaryIdx;
}

async function testSpreadSlotFullFillResolvesBuySide() {
    console.log('\n - Full (ghost) fill on SPREAD slot resolves BUY side and shifts boundary...');
    const mgr = createManager();
    const orderId = '1.7.900001';
    const price = 1041.273399444015;

    // Dirty-state setup: a SPREAD slot carrying an on-chain order (legacy grid /
    // spread-correction activation). Validated update paths refuse SPREAD+ACTIVE,
    // so inject directly into the orders map to simulate the state the defensive
    // fill handling is designed for.
    // BUY side: size is in BTS (assetB, precision 5).
    const ordersMap = new Map([
        ['slot-spread', {
            id: 'slot-spread', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SPREAD,
            size: 10.0, price, orderId,
            rawOnChain: { for_sale: String(Math.round(10.0 * 100000)), fetchedAt: Date.now() }
        }],
        // Neighbor slot so the boundary has room to crawl.
        ['slot-1', {
            id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
            size: 5.0, price: price + 1, orderId: '1.7.900002',
            rawOnChain: { for_sale: String(Math.round(5.0 * 10000)), fetchedAt: Date.now() }
        }]
    ]);
    mgr.orders = Object.freeze(ordersMap);

    // Full fill paying assetB (BTS) → resolved side must be BUY.
    const fill = _makeBuyFillEvent(orderId, 10.0, 900, '1.11.9001');
    const result = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });

    assert.ok(result.filledOrders.length === 1, 'Full fill should produce exactly one filled order');
    const filledOrder = result.filledOrders[0];
    assert.strictEqual(filledOrder.type, ORDER_TYPES.BUY,
        `fill on SPREAD slot must resolve to BUY, got ${filledOrder.type}`);

    // Slot virtualized: ghost keeps orderId (blocks duplicate CREATE), size 0, not ACTIVE.
    const slot = mgr.orders.get('slot-spread');
    assert.ok(slot.state !== ORDER_STATES.ACTIVE, `filled slot must leave ACTIVE (state=${slot.state})`);
    assert.strictEqual(slot.size, 0, 'filled slot must be zero-sized');
    assert.ok(slot.isGhost === true || slot.state === ORDER_STATES.SPREAD, 'slot should be ghost or spread placeholder');

    // Boundary crawl: BUY fill shifts boundary left; the pre-fix SPREAD type must NOT.
    const allSlots = Array.from(mgr.orders.values()).filter((o) => o.price != null).sort((a, b) => a.price - b.price);
    assert.strictEqual(boundaryShiftOf(filledOrder, allSlots), 0, 'BUY-typed fill must shift boundary left');
    assert.strictEqual(boundaryShiftOf({ ...filledOrder, type: ORDER_TYPES.SPREAD }, allSlots), 1,
        'SPREAD-typed fill (pre-fix) must not shift the boundary');
    console.log('  PASS');
}

async function testSpreadSlotPartialFillResolvesBuySide() {
    console.log('\n - Partial fill on SPREAD slot resolves BUY side (consistency)...');
    const mgr = createManager();
    const orderId = '1.7.900011';
    const price = 1041.273399444015;

    const ordersMap = new Map([
        ['slot-spread', {
            id: 'slot-spread', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SPREAD,
            size: 10.0, price, orderId,
            rawOnChain: { for_sale: String(Math.round(10.0 * 100000)), fetchedAt: Date.now() }
        }]
    ]);
    mgr.orders = Object.freeze(ordersMap);

    // Half fill paying assetB (BTS): received XRP does not round to 0 → partial branch.
    const fill = _makeBuyFillEvent(orderId, 5.0, 901, '1.11.9002');
    const result = await mgr.syncFromFillHistoryBatch([fill], { persistenceMode: 'batched' });

    assert.ok(result.filledOrders.length === 1, 'Partial fill should produce a filled order');
    const filledOrder = result.filledOrders[0];
    assert.strictEqual(filledOrder.type, ORDER_TYPES.BUY,
        `partial fill on SPREAD slot must resolve to BUY, got ${filledOrder.type}`);
    assert.strictEqual(filledOrder.isPartial, true, 'fill must be marked partial');
    assert.strictEqual(filledOrder.size, 5.0, 'fill size must reflect the filled amount');

    const slot = mgr.orders.get('slot-spread');
    assert.strictEqual(slot.state, ORDER_STATES.PARTIAL, 'partially filled slot must be PARTIAL');
    assert.ok(slot.size < 10.0, 'slot size must have decreased');
    console.log('  PASS');
}

async function runTests() {
    suppressNoise();

    await testTwoPartialFillsBatch();
    await testFullAndPartialMix();
    await testGhostOrderInBatch();
    await testReplayFillSkippedInBatch();
    await testMissingGridOrderSkipped();
    await testBatchDriftRefetchFallback();
    await testEmptyFillsArray();
    await testAggregatedGhostOrderIds();
    await testSingleFillViaBatch();
    await testSpreadSlotFullFillResolvesBuySide();
    await testSpreadSlotPartialFillResolvesBuySide();

    console.log('\n✓ All syncFromFillHistoryBatch tests passed!\n');
}

runTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
