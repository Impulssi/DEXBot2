/**
 * tests/test_sync_excess_orphan.ts
 *
 * Pass-2 orphan classification, genesis-frozen (nearest-slot).
 *
 * There is no tolerance band any more: a chain order belongs to exactly one
 * slot — the one its price maps to (slotIndexForPrice) — and the engine's job
 * is to say WHY it was not adopted when that slot is unavailable:
 *   - out of grid range          -> 'out-of-grid-deferred' (hold, never adopt
 *                                  into a clamped edge slot, never cancel)
 *   - level already occupied     -> 'duplicate-price-level' (cancel-only)
 *   - slot exists and is free    -> adopted, and the slot keeps its own level
 * The old price-drift-orphan band (PRICE_DRIFT_TOLERANCE_MULTIPLIER) and the
 * widened orphan-adoption band (ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER) are
 * gone with the no-genesis fallback they existed for.
 */
const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const AsyncLock = require('../modules/order/async_lock').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { buildGenesisFromPriceLevels } = require('../modules/order/utils/math');

const ASSETS = {
    assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
    assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
};

// A 1%-wide ladder, genesis-frozen: slot-<i> IS LEVELS[i].
const LEVELS = Array.from({ length: 51 }, (_, i) => 100 * Math.pow(1.01, i));
const GENESIS = () => buildGenesisFromPriceLevels(100, 1, 4, LEVELS);

function makeMgr(opts: any = {}) {
    const orders = new Map();
    for (const o of opts.orders || []) {
        orders.set(o.id, { ...o });
    }
    const logEntries: any[] = [];
    return {
        orders,
        assets: ASSETS,
        config: opts.config,
        _genesis: ('genesis' in opts) ? opts.genesis : GENESIS(),
        boundaryIdx: opts.boundaryIdx,
        _gapSlots: opts.gapSlots,
        logger: { log: (msg: string, level: string) => { logEntries.push({ msg, level }); } },
        _logEntries: logEntries,
        _gridPersistenceSuspendedReason: null,
        _persistenceWarning: undefined,
        _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false },
        _syncLock: new AsyncLock(),
        _fillProcessingLock: new AsyncLock(),
        _gridLock: new AsyncLock(),
        ordersNeedingPriceCorrection: [],
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        lockOrders: () => {},
        unlockOrders: () => {},
        shadowOrderIds: new Map(),
        _applyOrderUpdate: async (order: any, _reason: string, _opts2: any) => {
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

async function testOutOfGridOrphanIsHeld() {
    console.log(' - Below-grid orphan is held (out-of-grid-deferred), never adopted into the clamped edge slot...');
    const mgr = makeMgr({
        orders: [
            { id: 'slot-0', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: LEVELS[0], size: 0, orderId: '' }
        ],
        boundaryIdx: 40,
        gapSlots: 4
    });
    const engine = new SyncEngine(mgr);

    // 10% below the ladder floor: slotIndexForPrice would clamp it onto slot-0,
    // which is NOT a match.
    const chainOrder = makeChainOrder('1.7.572311649', ORDER_TYPES.SELL, LEVELS[0] * 0.9, 10);
    const result = await engine.syncFromOpenOrders([chainOrder], { skipAccounting: true });

    assert.strictEqual(result.filledOrders.length, 0, 'No fills expected');
    assert.strictEqual(result.unmatchedChainOrders.length, 1, 'Out-of-grid orphan should be unmatched');
    assert.strictEqual(result.unmatchedChainOrders[0].reason, 'out-of-grid-deferred', 'Held, not cancelled as a duplicate');
    assert.strictEqual(result.unmatchedChainOrders[0].chainOrderId, '1.7.572311649', 'Chain order id preserved');
    const slot = mgr.orders.get('slot-0');
    assert.ok(!slot.orderId, 'Out-of-grid orphan must NOT be adopted (no chain binding)');
    assert.strictEqual(mgr.ordersNeedingPriceCorrection.length, 0, 'A held orphan must not be queued for cancellation');
    console.log('   ✓ SYNC-EXCESS-001 passed');
}

async function testInGridOrphanAdoptsIntoNearestSlot() {
    console.log(' - In-grid orphan is adopted into the slot its price maps to...');
    const mgr = makeMgr({
        orders: [
            { id: 'slot-20', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: LEVELS[20], size: 0, orderId: '' }
        ],
        boundaryIdx: 0,
        gapSlots: 4
    });
    const engine = new SyncEngine(mgr);

    // Rests a few quanta off the level, still inside slot-20's basin.
    const restingPrice = LEVELS[20] * 1.0004;
    const chainOrder = makeChainOrder('1.7.572311650', ORDER_TYPES.SELL, restingPrice, 10);
    const result = await engine.syncFromOpenOrders([chainOrder], { skipAccounting: true });

    assert.strictEqual(result.unmatchedChainOrders.length, 0, 'In-grid orphan should be adopted, not unmatched');
    const slot = mgr.orders.get('slot-20');
    assert.strictEqual(slot.orderId, '1.7.572311650', 'Slot should now be bound to the resting chain order');
    assert.strictEqual(slot.size, 10, 'Chain size (real state) is adopted');
    assert.strictEqual(slot.price, LEVELS[20], 'The slot keeps its own ladder level, never the chain price');
    assert.ok([ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL].includes(slot.state), 'Adopted slot should be ACTIVE or PARTIAL');
    console.log('   ✓ SYNC-EXCESS-002 passed');
}

async function testOccupiedLevelIsDuplicate() {
    console.log(' - A second order resting on an occupied level is a duplicate-price orphan (cancel-only)...');
    const mgr = makeMgr({
        orders: [
            { id: 'slot-20', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: LEVELS[20], size: 10, orderId: '1.7.1' }
        ],
        boundaryIdx: 0,
        gapSlots: 4
    });
    const engine = new SyncEngine(mgr);

    const chainOrder = makeChainOrder('1.7.572311651', ORDER_TYPES.SELL, LEVELS[20] * 1.0002, 11);
    const result = await engine.syncFromOpenOrders([
        makeChainOrder('1.7.1', ORDER_TYPES.SELL, LEVELS[20], 10), // the occupying order
        chainOrder
    ]);

    assert.strictEqual(result.unmatchedChainOrders.length, 1, 'Duplicate at an occupied level must be unmatched');
    assert.strictEqual(result.unmatchedChainOrders[0].reason, 'duplicate-price-level', 'Reason must name the occupied level');
    const queued = mgr.ordersNeedingPriceCorrection.find((c: any) => c.chainOrderId === '1.7.572311651');
    assert.ok(queued, 'The duplicate must be queued');
    assert.strictEqual(queued.cancelOnly, true, 'A duplicate is cancelled, never re-priced into the slot');
    assert.strictEqual(mgr.orders.get('slot-20').orderId, '1.7.1', 'The occupying order keeps the slot');
    console.log('   ✓ SYNC-EXCESS-003 passed');
}

async function testLadderlessGridRefusesTheSync() {
    console.log(' - A ladder-less grid refuses the whole sync (no tolerance matcher remains)...');
    const mgr = makeMgr({
        orders: [
            { id: 'slot-20', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: LEVELS[20], size: 0, orderId: '' }
        ],
        genesis: null,
        boundaryIdx: 0,
        gapSlots: 4
    });
    let resyncReason: string | null = null;
    (mgr as any).requestStructuralGridResync = async (reason: string) => { resyncReason = reason; };
    const engine = new SyncEngine(mgr);

    const chainOrder = makeChainOrder('1.7.572311652', ORDER_TYPES.SELL, LEVELS[20], 10);
    const result = await engine.syncFromOpenOrders([chainOrder], { skipAccounting: true });

    assert.strictEqual(result.unmatchedChainOrders.length, 0, 'A refused sync reports nothing — it never ran');
    assert.strictEqual(mgr.orders.get('slot-20').orderId, '', 'No adoption on a ladder-less grid');
    assert.strictEqual(resyncReason, 'missing-genesis', 'A structural resync must be requested to re-derive the ladder');
    assert.ok(
        mgr._logEntries.some((e: any) => e.level === 'error' && String(e.msg).includes('sync REFUSED')),
        'The refusal must be logged as an error'
    );
    console.log('   ✓ SYNC-EXCESS-004 passed');
}

async function runTests() {
    console.log('Running Sync Engine Excess-Orphan Tests...');
    await testOutOfGridOrphanIsHeld();
    await testInGridOrphanAdoptsIntoNearestSlot();
    await testOccupiedLevelIsDuplicate();
    await testLadderlessGridRefusesTheSync();
    console.log('✓ Sync engine excess-orphan tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('✗ Sync engine excess-orphan tests failed');
    console.error(err);
    process.exit(1);
});
