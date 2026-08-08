const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const AsyncLock = require('../modules/order/async_lock').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { calculatePriceTolerance } = require('../modules/order/utils/math');

function makeMgr(opts = {}) {
    const orders = new Map();
    for (const o of (opts as any).orders || []) {
        orders.set(o.id, { ...o });
    }
    const assets = (opts as any).assets || {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
    };
    const logEntries = [];
    return {
        orders,
        assets,
        logger: {
            log: (msg, level) => { logEntries.push({ msg, level }); }
        },
        _logEntries: logEntries,
        _gridPersistenceSuspendedReason: null,
        _persistenceWarning: undefined,
        _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false },
        _syncLock: new AsyncLock(),
        _fillProcessingLock: new AsyncLock(),
        _gridLock: new AsyncLock(),
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        lockOrders: () => {},
        unlockOrders: () => {},
        shadowOrderIds: new Map(),
        _applyOrderUpdate: async (order, _reason, _opts2) => {
            orders.set(order.id, { ...(orders.get(order.id) || {}), ...order });
            return orders.get(order.id);
        }
    };
}

function makeChainOrder(id, type, price, size) {
    const baseAssetId = type === 'sell' ? '1.3.0' : '1.3.121';
    const quoteAssetId = type === 'sell' ? '1.3.121' : '1.3.0';
    const basePrecision = type === 'sell' ? 8 : 5;
    const quotePrecision = type === 'sell' ? 5 : 8;
    const forSaleInt = Math.round(size * Math.pow(10, basePrecision));
    const quoteInt = Math.round(size * price * Math.pow(10, quotePrecision));
    return {
        id,
        sell_price: {
            base: { amount: String(forSaleInt), asset_id: baseAssetId },
            quote: { amount: String(quoteInt), asset_id: quoteAssetId }
        },
        for_sale: String(forSaleInt),
        type,
        price,
        size
    };
}

async function testOutOfToleranceOrphanIsMarkedExcess() {
    console.log(' - Wildly out-of-tolerance orphan is unmatched (no price-drift tag, normal resync path)...');
    const mgr = makeMgr({
        orders: [
            { id: 'sell-5', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 100, size: 0, orderId: '' }
        ]
    });
    const engine = new SyncEngine(mgr);

    const chainOrder = makeChainOrder('1.7.572311649', ORDER_TYPES.SELL, 92.5, 10);
    const result = await engine.syncFromOpenOrders([chainOrder], { skipAccounting: true });

    assert.strictEqual(result.filledOrders.length, 0, 'No fills expected');
    assert.strictEqual(result.unmatchedChainOrders.length, 1, 'Out-of-tolerance orphan should be unmatched');
    const unmatched = result.unmatchedChainOrders[0];
    assert.strictEqual(unmatched.chainOrderId, '1.7.572311649', 'Chain order id preserved');
    const slot = mgr.orders.get('sell-5');
    assert.ok(!slot.orderId, 'Wildly out-of-tolerance slot must NOT be adopted (no chain binding)');
    console.log('\u2713 SYNC-EXCESS-001 passed');
}

async function testSmallDriftOrphanIsTagged() {
    console.log(' - Small-drift orphan (within 4x tolerance) is tagged price-drift-orphan with diagnostic fields...');
    const tolerance = calculatePriceTolerance(100, 10, ORDER_TYPES.SELL, {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
    }) || 0.5;
    const driftPrice = 100 + (tolerance * 2);
    const mgr = makeMgr({
        orders: [
            { id: 'sell-3', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 100, size: 0, orderId: '' }
        ]
    });
    const engine = new SyncEngine(mgr);

    const chainOrder = makeChainOrder('1.7.572311650', ORDER_TYPES.SELL, driftPrice, 10);
    const result = await engine.syncFromOpenOrders([chainOrder], { skipAccounting: true });

    assert.strictEqual(result.unmatchedChainOrders.length, 1, 'Small-drift orphan should be unmatched');
    const unmatched = result.unmatchedChainOrders[0];
    assert.strictEqual(unmatched.reason, 'price-drift-orphan', 'Small-drift reason should be price-drift-orphan');
    assert.strictEqual(unmatched.candidateSlotId, 'sell-3', 'Candidate slot id should be reported');
    assert.ok(unmatched.priceDiff > 0, 'priceDiff should be reported');
    assert.ok(unmatched.tolerance > 0, 'tolerance should be reported');
    assert.ok(unmatched.priceDiff <= unmatched.tolerance * 4, 'Drift should be within 4x tolerance budget');
    console.log('\u2713 SYNC-EXCESS-002b passed');
}

async function testInToleranceOrphanIsAdopted() {
    console.log(' - In-tolerance orphan in pass-2 fallback is adopted (within price tolerance)...');
    const mgr = makeMgr({
        orders: [
            { id: 'sell-3', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 100, size: 10, orderId: '' }
        ]
    });
    const engine = new SyncEngine(mgr);

    const tolerance = calculatePriceTolerance(100, 10, ORDER_TYPES.SELL, mgr.assets) || 0.5;
    const inTolerancePrice = 100 + (tolerance * 0.5);
    const chainOrder = makeChainOrder('1.7.572300001', ORDER_TYPES.SELL, inTolerancePrice, 10);
    const result = await engine.syncFromOpenOrders([chainOrder], { skipAccounting: true });

    assert.strictEqual(result.unmatchedChainOrders.length, 0, 'In-tolerance orphan should be adopted, not unmatched');
    const slot = mgr.orders.get('sell-3');
    assert.strictEqual(slot.orderId, '1.7.572300001', 'Slot should now be bound to chain order');
    assert.ok([ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL].includes(slot.state), 'Adopted slot should be ACTIVE or PARTIAL');
    console.log('\u2713 SYNC-EXCESS-003 passed');
}

async function runTests() {
    console.log('Running Sync Engine Excess-Orphan Tests...');
    await testOutOfToleranceOrphanIsMarkedExcess();
    await testSmallDriftOrphanIsTagged();
    await testInToleranceOrphanIsAdopted();
    console.log('\u2713 Sync engine excess-orphan tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('\u2717 Sync engine excess-orphan tests failed');
    console.error(err);
    process.exit(1);
});
