/**
 * tests/test_correction_queue_staleness.ts
 *
 * Regression tests for the stale-correction replay incident class
 * (duplicate price levels from a resync-reverting UPDATE):
 *
 * Fix 1 — correctAllPriceMismatches validates price-update entries against
 *   the LIVE slot at drain time and drops stale ones without broadcasting:
 *   1a. Re-slotted entry (slot now owns a different chain order) is dropped.
 *   1b. Re-priced entry (slot now targets a different price) is dropped.
 *   1c. Fresh entry (slot still owns the order at the queued price) broadcasts.
 *   1d. Cancel-type entries (cancelOnly / isSurplus) are exempt from validation.
 * Fix 2 — a zero-delta updateOrder (null) counts as resolved, not failed:
 *   2a. null update yields {success:true, skipped:true} (not failed).
 *   2b. correctAllPriceMismatches reports failed===0 for a no-op drain.
 * Fix 3 — provenance: stale-drop log names the queuing detector + time.
 */
const assert = require('assert');
const {
    correctOrderPriceOnChain,
    correctAllPriceMismatches,
    _validatePriceCorrectionEntry,
    _stampCorrectionProvenance,
} = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const ASSETS = {
    assetA: { id: '1.3.0', precision: 5, symbol: 'HONEST' },
    assetB: { id: '1.3.861', precision: 5, symbol: 'BTS' },
};

function liveSell(id, orderId, price, size = 850) {
    return { id, orderId, type: ORDER_TYPES.SELL, price, size, state: ORDER_STATES.ACTIVE };
}

// Minimal manager harness: live slots Map + correction queue + logger + fake _gridLock.
function createManager(ordersList, queue = []) {
    const logs = [];
    const manager = {
        orders: new Map(ordersList.map((o) => [o.id, { ...o }])),
        assets: ASSETS,
        ordersNeedingPriceCorrection: queue.map((e) => ({ ...e })),
        logger: { log: (msg, level) => logs.push(`[${level}] ${msg}`) },
        _gridLock: { acquire: async (fn) => fn() },
    };
    return { manager, logs };
}

function priceEntry(slotId, chainOrderId, expectedPrice, extra = {}) {
    return {
        gridOrder: { id: slotId },
        chainOrderId,
        expectedPrice,
        actualPrice: expectedPrice - 0.001,
        size: 850,
        type: ORDER_TYPES.SELL,
        isSurplus: false,
        cancelOnly: false,
        queuedAt: Date.now() - 3600_000,
        queuedBy: 'sync-price-mismatch',
        ...extra,
    };
}

async function run() {
    console.log('Running correction queue staleness tests...');

    // ---- 1a. Re-slotted entry is dropped without broadcast ----
    {
        const { manager, logs } = createManager(
            [liveSell('slot-89', '1.7.999', 0.312638)], // slot re-slotted to a NEW chain order
            [priceEntry('slot-89', '1.7.574249250', 0.312638)]
        );
        let updateCalled = false;
        const accountOrders = { updateOrder: async () => { updateCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(updateCalled, false, 'stale re-slotted entry must not broadcast');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'stale entry must be dropped');
        assert.strictEqual(out.staleDropped, 1, 'summary must count the stale drop');
        assert.strictEqual(out.failed, 0, 'stale drop must not count as failed');
        assert(logs.some((l) => l.includes('Dropping stale price correction for 1.7.574249250')), 'must log the drop');
        assert(logs.some((l) => l.includes('sync-price-mismatch')), 'drop log must name the queuing detector');
        console.log('  - re-slotted entry dropped without broadcast');
    }

    // ---- 1b. Re-priced entry is dropped without broadcast ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.320000)], // same order, slot moved on
            [priceEntry('slot-89', '1.7.574249250', 0.312638)]
        );
        let updateCalled = false;
        const accountOrders = { updateOrder: async () => { updateCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(updateCalled, false, 'stale re-priced entry must not broadcast');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'stale entry must be dropped');
        assert.strictEqual(out.staleDropped, 1);
        console.log('  - re-priced entry dropped without broadcast');
    }

    // ---- 1c. Fresh entry still broadcasts ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638)],
            [priceEntry('slot-89', '1.7.574249250', 0.312638)]
        );
        let updateCalled = false;
        const accountOrders = { updateOrder: async () => { updateCalled = true; return { success: true }; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(updateCalled, true, 'fresh entry must broadcast');
        assert.strictEqual(out.corrected, 1);
        assert.strictEqual(out.staleDropped, 0);
        console.log('  - fresh entry broadcasts normally');
    }

    // ---- 1d. Cancel-type entries bypass validation ----
    {
        const { manager } = createManager(
            [], // slot gone entirely — price entry would drop, cancel must still fire
            [{
                gridOrder: { id: 'slot-89' },
                chainOrderId: '1.7.111',
                expectedPrice: 0.31,
                size: 850,
                type: ORDER_TYPES.SELL,
                isSurplus: true,
                cancelOnly: true,
                queuedAt: Date.now(),
                queuedBy: 'sync-duplicate-orphan',
            }]
        );
        let cancelCalled = false;
        const accountOrders = { cancelOrder: async () => { cancelCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(cancelCalled, true, 'cancel-only entry must not be staleness-dropped');
        assert.strictEqual(out.corrected, 1);
        console.log('  - cancel-only entries exempt from staleness validation');
    }

    // ---- 1e. Missing slot drops the entry (unit-level) ----
    {
        const { manager } = createManager([], []);
        const check = _validatePriceCorrectionEntry(manager, priceEntry('slot-89', '1.7.1', 0.31));
        assert.strictEqual(check.valid, false, 'entry for a missing slot is stale');
        assert(check.reason.includes('no longer exists'));
        console.log('  - missing-slot entry invalid');
    }

    // ---- 1f. Fill-changed size drops the entry without broadcast ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638, 400)], // partial fill: 850 -> 400
            [priceEntry('slot-89', '1.7.574249250', 0.312638, { size: 850 })]
        );
        let updateCalled = false;
        const accountOrders = { updateOrder: async () => { updateCalled = true; return {}; } };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(updateCalled, false, 'fill-changed entry must not broadcast stale size');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'stale entry must be dropped');
        assert.strictEqual(out.staleDropped, 1);
        console.log('  - fill-changed size entry dropped without broadcast');
    }

    // ---- 1g. Sibling entries sharing a chain id are removed independently ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638)],
            [
                // Same chain id, different queue keys: the cancel sibling must
                // survive when the price sibling is consumed.
                priceEntry('slot-89', '1.7.574249250', 0.312638),
                {
                    gridOrder: { id: 'slot-89' },
                    chainOrderId: '1.7.574249250',
                    expectedPrice: 0.312638,
                    size: 850,
                    type: ORDER_TYPES.SELL,
                    isSurplus: true,
                    cancelOnly: true,
                    queuedAt: Date.now(),
                    queuedBy: 'sync-duplicate-orphan',
                },
            ]
        );
        const accountOrders = {
            updateOrder: async () => ({ success: true }),
            cancelOrder: async () => ({ success: true }),
        };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        // Both siblings drain (full-key dedupe keeps both): price entry
        // broadcasts its update, cancel entry fires its cancel.
        assert.strictEqual(out.corrected, 2, 'both siblings must drain');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'both consumed');
        console.log('  - full-key removal preserves sibling entries');
    }

    // ---- 1h. Sibling survives when only the price entry is consumed ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638)],
            [
                priceEntry('slot-89', '1.7.574249250', 0.312638),
                {
                    gridOrder: { id: 'slot-89' },
                    chainOrderId: '1.7.574249250',
                    expectedPrice: 0.312638,
                    size: 850,
                    type: ORDER_TYPES.SELL,
                    isSurplus: true,
                    cancelOnly: true,
                    queuedAt: Date.now(),
                    queuedBy: 'sync-duplicate-orphan',
                },
            ]
        );
        // Only the price entry executes: its full-key removal must leave the
        // cancel sibling queued. (correctOrderPriceOnChain consumes one entry.)
        const accountOrders = { updateOrder: async () => ({ success: true }) };
        const priceOnly = manager.ordersNeedingPriceCorrection.find((e) => !e.isSurplus);
        const { correctOrderPriceOnChain: single } = require('../modules/order/utils/order');
        await single(manager, priceOnly, 'acct', 'k', accountOrders);
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 1, 'sibling entry must survive');
        assert.strictEqual(
            manager.ordersNeedingPriceCorrection[0].cancelOnly, true, 'survivor must be the cancel sibling'
        );
        console.log('  - single-entry removal preserves the sibling');
    }

    // ---- 2a. Zero-delta (null) update resolves instead of failing ----
    {
        const { manager } = createManager([liveSell('slot-89', '1.7.574249250', 0.312638)]);
        manager.ordersNeedingPriceCorrection = [{ chainOrderId: '1.7.574249250' }];
        const accountOrders = { updateOrder: async () => null }; // "Delta is 0; skipping"
        const result = await correctOrderPriceOnChain(
            manager, priceEntry('slot-89', '1.7.574249250', 0.312638), 'acct', 'k', accountOrders
        );
        assert.strictEqual(result.success, true, 'no-op update must report success');
        assert.strictEqual(result.skipped, true, 'no-op update must report skipped');
        assert.strictEqual(result.error, undefined, 'no-op update must carry no error');
        assert.strictEqual(manager.ordersNeedingPriceCorrection.length, 0, 'no-op entry must be dequeued');
        console.log('  - zero-delta update counts as resolved');
    }

    // ---- 2b. No-op drain reports failed===0 ----
    {
        const { manager } = createManager(
            [liveSell('slot-89', '1.7.574249250', 0.312638)],
            [priceEntry('slot-89', '1.7.574249250', 0.312638)]
        );
        const accountOrders = { updateOrder: async () => null };
        const out = await correctAllPriceMismatches(manager, 'acct', 'k', accountOrders);
        assert.strictEqual(out.corrected, 1, 'no-op counts as corrected (resolved)');
        assert.strictEqual(out.failed, 0, 'no-op must not count as failed');
        console.log('  - no-op drain reports zero failures');
    }

    // ---- 3. Provenance stamping preserves first-seen values ----
    {
        const first = _stampCorrectionProvenance({ chainOrderId: '1.7.1' }, 'sync-price-mismatch');
        assert(first.queuedAt > 0 && first.queuedBy === 'sync-price-mismatch', 'stamp must fill missing provenance');
        const kept = _stampCorrectionProvenance(
            { chainOrderId: '1.7.1', queuedAt: 123, queuedBy: 'sync-duplicate-orphan' },
            'sync-price-mismatch'
        );
        assert.strictEqual(kept.queuedAt, 123, 're-queue must keep original queuedAt');
        assert.strictEqual(kept.queuedBy, 'sync-duplicate-orphan', 're-queue must keep original detector');
        console.log('  - provenance stamping preserves first-seen values');
    }

    console.log('PASS test_correction_queue_staleness');
}

run().catch((err) => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});
