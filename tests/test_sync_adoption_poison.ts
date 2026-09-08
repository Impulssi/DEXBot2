/**
 * tests/test_sync_adoption_poison.ts
 *
 * Regression test: a rejected pass-2 adoption must not poison the slot for
 * the next chain order (matchedGridOrderIds un-poisoning in
 * adoptChainOrderIntoSlot).
 *
 * Incident class: chain order A adopts into its nearest slot (slot-50) but
 * the slot update is rejected (fatal validation → _applyOrderUpdate returns
 * false). The slot was marked matched BEFORE the apply, so without the
 * un-poisoning delete, chain order B — whose nearest slot is also slot-50 —
 * sees `matchedGridOrderIds.has(slot.id)` and is misclassified as
 * 'no-available-nearest-slot' instead of being adopted.
 *
 * Harness reuses the makeMgr()/makeChainOrder() pattern from
 * test_sync_duplicate_orphan_swap.ts and the genesis fixture pattern from
 * test_sync_logic.ts (buildGenesisFromPriceLevels).
 */
const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const AsyncLock = require('../modules/order/async_lock').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { buildGenesisFromPriceLevels } = require('../modules/order/utils/math');

const SLOT_IDX = 50;
const SLOT_ID = `slot-${SLOT_IDX}`;
const CHAIN_SIZE = 10;

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
    // Reject ONLY the first pass-2 orphan adoption (chain order A's); every
    // later apply (chain order B's) lands normally.
    let rejectFirstOrphan = true;
    return {
        orders,
        assets,
        config: (opts as any).config,
        boundaryIdx: (opts as any).boundaryIdx,
        _gapSlots: (opts as any).gapSlots,
        _genesis: (opts as any).genesis,
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
            if (reason === 'sync-pass2-orphan' && rejectFirstOrphan) {
                rejectFirstOrphan = false;
                return false;
            }
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

async function testRejectedAdoptionDoesNotPoisonSlot() {
    console.log(' - Rejected adoption releases the slot: second order at the same level is adopted...');
    // Geometric rail: levels[i] = 100 * 1.01^i, i = 0..50. Chain price sits
    // exactly on levels[50] → nearest slot is slot-50 for both orders.
    const levels = Array.from({ length: SLOT_IDX + 1 }, (_, i) => 100 * Math.pow(1.01, i));
    const slotPrice = levels[SLOT_IDX];
    const genesis = buildGenesisFromPriceLevels(100, 1, 4, levels);
    const mgr = makeMgr({
        orders: [{
            id: SLOT_ID,
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.VIRTUAL,
            price: slotPrice,
            size: CHAIN_SIZE,
        }],
        genesis,
        boundaryIdx: 40, // sellStart = 40 + 4 + 1 = 45 → slot-50 is rail
        gapSlots: 4,
    });
    const engine = new SyncEngine(mgr);

    const chain = [
        makeChainOrder('1.7.900001', ORDER_TYPES.SELL, slotPrice, CHAIN_SIZE),
        makeChainOrder('1.7.900002', ORDER_TYPES.SELL, slotPrice, CHAIN_SIZE),
    ];
    const result = await engine.syncFromOpenOrders(chain, { skipAccounting: true });

    // B (the second order) must be adopted: the slot carries B's orderId.
    const slot = mgr.orders.get(SLOT_ID);
    assert.strictEqual(slot.orderId, '1.7.900002', 'Slot must carry the second order after the first adoption is rejected');
    assert.ok(
        slot.state === ORDER_STATES.ACTIVE || slot.state === ORDER_STATES.PARTIAL,
        'Adopted slot must be tracked (ACTIVE/PARTIAL)'
    );

    // A must have a cancelOnly correction queued (existing :1067-1069-style
    // adoption-rejected handling), not dangle untracked.
    const corrections = mgr.ordersNeedingPriceCorrection;
    const cancelA = corrections.find((c: any) => c.chainOrderId === '1.7.900001');
    assert.ok(cancelA, 'Rejected order A must be queued for cancellation');
    assert.strictEqual(cancelA.cancelOnly, true, 'Cancellation must be cancel-only');

    // B must NOT be classified as no-available-nearest-slot (the poisoned
    // outcome this test guards against — it fails on unfixed code).
    assert.ok(
        !result.unmatchedChainOrders.some((u: any) => u.chainOrderId === '1.7.900002' && u.reason === 'no-available-nearest-slot'),
        'Second order must not be misclassified as no-available-nearest-slot'
    );
    assert.ok(
        !result.unmatchedChainOrders.some((u: any) => u.chainOrderId === '1.7.900002'),
        'Adopted second order must not remain unmatched'
    );
    console.log('✓ ADOPT-POISON-001 passed');
}

async function runTests() {
    console.log('Running Sync Engine Adoption-Poison Tests...');
    await testRejectedAdoptionDoesNotPoisonSlot();
    console.log('✓ Sync engine adoption-poison tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('✗ Sync engine adoption-poison tests failed');
    console.error(err);
    process.exit(1);
});
