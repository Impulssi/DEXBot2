/**
 * tests/test_sync_duplicate_orphan_swap.ts
 *
 * Regression tests for the SIZE-CONSISTENCY TIEBREAK (sync_engine pass 1).
 *
 * Incident (AAA-BBB2 2026-08-31T22:59Z): a trigger reset rebuilt the grid over
 * a live order (0-order phantom read). The rebuild's duplicate-price order
 * (…047, full size) raced the fill booking, the slot's orderId was
 * mis-assigned to it, and the REAL order (…029, post-fill size 0.5626) was
 * classified as the duplicate orphan and queued for cancellation — the inverse
 * of the correct outcome.
 *
 * The tiebreak: when the tracked order's chain size disagrees with the slot's
 * booked remaining size AND another chain order at the same price level
 * matches the booked size exactly, the slot rebinds to that order and the
 * previously-tracked order falls through to pass 2 as a duplicate-price
 * orphan (queued for cancellation).
 */
const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const AsyncLock = require('../modules/order/async_lock').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const SLOT_PRICE = 1014.1608858656156;
const CHAIN_PRICE = 1014.1608800120139;
const BOOKED_SIZE = 0.5626;   // post-fill remaining (booked by fill processing)
const FULL_SIZE = 0.6659;     // pre-fill size (the mis-tracked duplicate)

function makeMgr(opts = {}) {
    const orders = new Map();
    for (const o of (opts as any).orders || []) {
        orders.set(o.id, { ...o });
    }
    const assets = (opts as any).assets || {
        assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
        assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
    };
    const logEntries: any[] = [];
    const updateReasons: string[] = [];
    return {
        orders,
        assets,
        config: (opts as any).config,
        logger: {
            log: (msg: string, level: string) => { logEntries.push({ msg, level }); }
        },
        _logEntries: logEntries,
        _updateReasons: updateReasons,
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
        _applyOrderUpdate: async (order: any, reason: string, _opts2: any) => {
            updateReasons.push(reason);
            orders.set(order.id, { ...(orders.get(order.id) || {}), ...order });
            return orders.get(order.id);
        }
    };
}

function makeChainOrder(id: string, type: string, price: number, size: number, deferredFee: any = undefined) {
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
        ...(deferredFee !== undefined ? { deferred_fee: deferredFee } : {}),
        type,
        price,
        size
    };
}

function makeIncidentSlot() {
    // The incident state entering the 22:59:54 sync: slot-140 booked post-fill
    // size 0.5626 (PARTIAL) but tracked to the mis-assigned duplicate …047.
    return {
        id: 'slot-140',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: SLOT_PRICE,
        size: BOOKED_SIZE,
        orderId: '1.7.573974047'
    };
}

async function testMisTrackedDuplicateSwapsToSizeMatchingOrder() {
    console.log(' - Mis-tracked duplicate: slot rebinds to the size-matching order, wrong order queued for cancel...');
    const mgr = makeMgr({ orders: [makeIncidentSlot()] });
    const engine = new SyncEngine(mgr);

    // …047 = full-size duplicate (tracked), …029 = the REAL post-fill order.
    const chain = [
        makeChainOrder('1.7.573974047', ORDER_TYPES.SELL, CHAIN_PRICE, FULL_SIZE, '3600000'),
        makeChainOrder('1.7.573974029', ORDER_TYPES.SELL, CHAIN_PRICE, BOOKED_SIZE, '0')
    ];
    const result = await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    const slot = mgr.orders.get('slot-140');
    assert.strictEqual(
        slot.orderId, '1.7.573974029',
        'Slot must rebind to the order whose chain size matches the booked remaining size'
    );
    assert.strictEqual(slot.size, BOOKED_SIZE, 'Booked remaining size must be preserved by the swap');
    assert.strictEqual(slot.state, ORDER_STATES.PARTIAL, 'Partially-filled order stays PARTIAL (deferred_fee=0)');

    const swapApplied = mgr._updateReasons.includes('sync-pass1-duplicate-swap');
    assert.ok(swapApplied, 'Swap must be applied via sync-pass1-duplicate-swap');

    const corrections = mgr.ordersNeedingPriceCorrection;
    const cancelEntry = corrections.find((c: any) => c.chainOrderId === '1.7.573974047');
    assert.ok(cancelEntry, 'Previously-tracked order must be queued for cancellation');
    assert.strictEqual(cancelEntry.cancelOnly, true, 'Cancellation must be cancel-only (no slot rewrite)');

    const unmatched047 = result.unmatchedChainOrders.find((u: any) => u.chainOrderId === '1.7.573974047');
    assert.ok(unmatched047, 'Previously-tracked order falls through to pass 2 as duplicate-price orphan');
    assert.strictEqual(unmatched047.reason, 'duplicate-price-level', 'Orphan reason must be duplicate-price-level');
    assert.ok(
        !result.unmatchedChainOrders.some((u: any) => u.chainOrderId === '1.7.573974029'),
        'The real order must NOT be classified as an orphan'
    );
    assert.ok(
        !corrections.some((c: any) => c.chainOrderId === '1.7.573974029'),
        'The real order must NOT be queued for cancellation'
    );
    console.log('\u2713 DUP-SWAP-001 passed');
}

async function testNoSwapWhenAlternativeSizeDiffers() {
    console.log(' - No swap when the same-level alternative does not match the booked size...');
    const mgr = makeMgr({ orders: [makeIncidentSlot()] });
    const engine = new SyncEngine(mgr);

    const chain = [
        makeChainOrder('1.7.573974047', ORDER_TYPES.SELL, CHAIN_PRICE, FULL_SIZE, '3600000'),
        makeChainOrder('1.7.573999999', ORDER_TYPES.SELL, CHAIN_PRICE, 0.5, '3600000')
    ];
    await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    const slot = mgr.orders.get('slot-140');
    assert.strictEqual(slot.orderId, '1.7.573974047', 'Tracked order must be kept when no candidate matches booked size');
    assert.ok(
        !mgr._updateReasons.includes('sync-pass1-duplicate-swap'),
        'No swap must be applied'
    );
    assert.ok(
        mgr.ordersNeedingPriceCorrection.some((c: any) => c.chainOrderId === '1.7.573999999' && c.cancelOnly === true),
        'The non-matching duplicate is still queued for cancellation (existing duplicate guard)'
    );
    console.log('\u2713 DUP-SWAP-002 passed');
}

async function testNoSwapWhenTrackedOrderAbsentFromRead() {
    console.log(' - No swap when the tracked order is absent from the chain read (conservative)...');
    const mgr = makeMgr({ orders: [makeIncidentSlot()] });
    const engine = new SyncEngine(mgr);

    const chain = [
        makeChainOrder('1.7.573974029', ORDER_TYPES.SELL, CHAIN_PRICE, BOOKED_SIZE, '0')
    ];
    await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    assert.ok(
        !mgr._updateReasons.includes('sync-pass1-duplicate-swap'),
        'Swap must not fire without the tracked order present in the same read'
    );
    console.log('\u2713 DUP-SWAP-003 passed');
}

async function testNoSwapOnLegitPartialFill() {
    console.log(' - No swap on a legitimate partial fill (tracked order size = booked size after sync)...');
    // Legit world: slot booked FULL size pre-sync, tracked order partially
    // filled on chain. No second order at the level -> no swap; pass 1 adopts
    // the chain size as today.
    const mgr = makeMgr({
        orders: [{
            id: 'slot-100',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 1014.1608858656156,
            size: FULL_SIZE,
            orderId: '1.7.573974029'
        }]
    });
    const engine = new SyncEngine(mgr);

    const chain = [
        makeChainOrder('1.7.573974029', ORDER_TYPES.SELL, CHAIN_PRICE, BOOKED_SIZE, '0')
    ];
    await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    assert.ok(
        !mgr._updateReasons.includes('sync-pass1-duplicate-swap'),
        'No swap when there is no second order at the price level'
    );
    const slot = mgr.orders.get('slot-100');
    assert.strictEqual(slot.orderId, '1.7.573974029', 'Tracked order kept');
    assert.strictEqual(slot.size, BOOKED_SIZE, 'Chain size adopted via the normal pass-1 path');
    assert.strictEqual(slot.state, ORDER_STATES.PARTIAL, 'Legit partial fill transitions to PARTIAL');
    console.log('\u2713 DUP-SWAP-004 passed');
}

async function runTests() {
    console.log('Running Sync Engine Duplicate-Orphan Swap Tests...');
    await testMisTrackedDuplicateSwapsToSizeMatchingOrder();
    await testNoSwapWhenAlternativeSizeDiffers();
    await testNoSwapWhenTrackedOrderAbsentFromRead();
    await testNoSwapOnLegitPartialFill();
    console.log('\u2713 Sync engine duplicate-orphan swap tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('\u2717 Sync engine duplicate-orphan swap tests failed');
    console.error(err);
    process.exit(1);
});
