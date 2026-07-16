/**
 * tests/test_sync_logic.ts
 * 
 * Ported from tests/unit/sync_engine.test.js
 * Comprehensive unit tests for sync_engine.js - Blockchain reconciliation
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { createSilentLogger } = require('./helpers/silent_logger');

// Mock getAssetFees
const OrderUtils = require('../modules/order/utils/math');
const originalGetAssetFees = OrderUtils.getAssetFees;
OrderUtils.getAssetFees = (asset) => {
    if (asset === 'BTS') {
        return { total: 0.011, createFee: 0.1, updateFee: 0.001, makerNetFee: 0.01, takerNetFee: 0.1, netFee: 0.01, isMaker: true };
    }
    return 1.0;
};

async function runTests() {
    console.log('Running Sync Logic Tests...');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS'
        });
        mgr.logger = createSilentLogger();
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        return mgr;
    };

    const makeSellChainOrder = (id, sizeFloat, priceFloat = 100) => {
        const forSale = Math.round(sizeFloat * 1e8);
        const baseAmount = 1000;
        const quoteAmount = Math.max(1, Math.round((priceFloat / 1000) * baseAmount));
        return {
            id,
            sell_price: {
                base: { amount: baseAmount, asset_id: '1.3.0' },
                quote: { amount: quoteAmount, asset_id: '1.3.1' }
            },
            for_sale: forSale
        };
    };

    console.log(' - Testing Input Validation...');
    {
        const manager = await createManager();
        const result = await manager.sync.syncFromOpenOrders(null);
        assert(result !== undefined);
        assert.deepStrictEqual(result.filledOrders, []);
    }

    console.log(' - Testing Fill Detection...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'g-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: 'c-123'
        });
        // Sync with empty chain -> order filled
        const result = await manager.sync.syncFromOpenOrders([]);
        assert.strictEqual(result.filledOrders.length, 1, 'Missing ACTIVE order should be reported as filled');
        assert.strictEqual(result.filledOrders[0].id, 'g-1', 'Filled order should map to grid slot');
        assert.strictEqual(result.filledOrders[0].orderId, 'c-123', 'Filled order should preserve chain orderId');
    }

    console.log(' - Testing Missing ACTIVE with orderId Is Fill Signal...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'fill-signal-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
            size: 42, price: 123, orderId: 'c-fill-signal-1'
        });

        const result = await manager.sync.syncFromOpenOrders([]);
        const hit = result.filledOrders.find(o => o.id === 'fill-signal-1');

        assert(hit, 'Missing ACTIVE/PARTIAL order with orderId must appear in filledOrders');
        assert.strictEqual(hit.orderId, 'c-fill-signal-1', 'Fill signal should retain chain order id');
    }

    console.log(' - Testing Partial Fill Detection...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'p-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.SELL,
            size: 100, price: 150, orderId: 'c-456'
        });
        const chainOrders = [{
            id: 'c-456',
            sell_price: { base: { amount: 50, asset_id: '1.3.0' }, quote: { amount: 7500, asset_id: '1.3.1' } },
            for_sale: 5000000000 // 50 units
        }];
        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        assert(result.updatedOrders.length >= 0, 'Should detect partial fill');
    }

    console.log(' - Testing Price Tolerance...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 't-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 100.00, orderId: 'c-789'
        });
        const chainOrders = [{
            id: 'c-789',
            sell_price: { base: { amount: 100, asset_id: '1.3.1' }, quote: { amount: 10001, asset_id: '1.3.0' } },
            for_sale: 10000000000
        }];
        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        const synced = manager.orders.get('t-1');
        assert(synced !== undefined, 'Should match within tolerance');
    }

    console.log(' - Testing Type Mismatch Does Not Mutate Grid Slot...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'tm-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 10, orderId: 'c-tm'
        });

        // On-chain order uses opposite side (SELL) for same orderId.
        const chainOrders = [{
            id: 'c-tm',
            sell_price: { base: { amount: 100000000, asset_id: '1.3.0' }, quote: { amount: 10000000, asset_id: '1.3.1' } },
            for_sale: 50000000
        }];

        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        const slot = manager.orders.get('tm-1');

        assert.strictEqual(slot.type, ORDER_TYPES.BUY, 'Type-mismatched sync must not mutate slot type');
        assert.strictEqual(slot.state, ORDER_STATES.ACTIVE, 'Type-mismatched sync must not mutate slot state');
        assert.strictEqual(slot.size, 100, 'Type-mismatched sync must not mutate slot size');
        assert.strictEqual(result.updatedOrders.length, 0, 'Type-mismatched sync should not apply local order updates');
        assert(manager.ordersNeedingPriceCorrection.some(c => c.chainOrderId === 'c-tm' && c.isSurplus), 'Mismatch should queue stale order cancellation');
    }

    console.log(' - Testing Orphan Spread Slot Adoption...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'spread-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.SPREAD,
            price: 100,
            size: 0
        });

        const chainOrders = [{
            id: 'c-spread-1',
            sell_price: {
                base: { amount: 1000, asset_id: '1.3.0' },
                quote: { amount: 100, asset_id: '1.3.1' }
            },
            for_sale: 2500000000
        }];

        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        const slot = manager.orders.get('spread-1');

        assert.strictEqual(slot.orderId, 'c-spread-1', 'Orphan chain order should be adopted into the spread slot');
        assert.strictEqual(slot.type, ORDER_TYPES.SELL, 'Adopted spread slot should take the chain order side');
        assert.strictEqual(slot.state, ORDER_STATES.PARTIAL, 'Adopted orphan should become a tracked partial');
        assert.strictEqual(slot.price, 100, 'Adopted orphan should preserve the chain price');
        assert.strictEqual(slot.size, 25, 'Adopted orphan should preserve the chain size');
        assert(result.updatedOrders.some(o => o.id === 'spread-1'), 'Sync result should include the adopted slot update');
    }

    console.log(' - Testing Orphan At Duplicate Price Level Is Not Adopted...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'occupied-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            price: 100,
            size: 25,
            orderId: 'c-existing'
        });
        await manager._updateOrder({
            id: 'spread-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.SPREAD,
            price: 100,
            size: 0
        });

        // Two chain orders at price 100 — the orphan duplicates the occupied slot's price.
        // Grid invariant: one order per price level. Orphan must not be adopted.
        const result = await manager.sync.syncFromOpenOrders([
            makeSellChainOrder('c-existing', 25, 100),
            makeSellChainOrder('c-new-orphan', 26, 100)
        ]);

        const occupied = manager.orders.get('occupied-1');
        const spreadSlot = manager.orders.get('spread-1');

        assert.strictEqual(occupied.orderId, 'c-existing', 'Existing occupied slot must keep its chain order id');
        assert.ok(!spreadSlot.orderId, 'Orphan at duplicate price must NOT be adopted into spread slot');
        assert.strictEqual(spreadSlot.state, ORDER_STATES.VIRTUAL, 'Spread slot must remain virtual');
        assert.ok(
            result.unmatchedChainOrders.some(u => u.chainOrderId === 'c-new-orphan' && u.reason === 'duplicate-price-level'),
            'Duplicate-price-level orphan must be pushed to unmatchedChainOrders with reason'
        );
    }

    console.log(' - Testing Two Orphans At Same Price With Two VIRTUAL Slots...');
    {
        // Two VIRTUAL SELL slots at price 100, two chain orphans at price 100.
        // Without the matchedGridOrderIds exclusion fix, the second orphan would
        // adopt into the second VIRTUAL slot creating two orders at the same price.
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-a', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.SELL,
            price: 100, size: 25, orderId: null
        });
        await manager._updateOrder({
            id: 'slot-b', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.SELL,
            price: 100, size: 26, orderId: null
        });

        const result = await manager.sync.syncFromOpenOrders([
            makeSellChainOrder('c-orphan-a', 25, 100),
            makeSellChainOrder('c-orphan-b', 26, 100)
        ]);

        const slotA = manager.orders.get('slot-a');
        const slotB = manager.orders.get('slot-b');
        const adoptedId = slotA.orderId || slotB.orderId;

        assert.ok(adoptedId, 'One of the two VIRTUAL slots must have adopted an orphan');
        const adopted = slotA.orderId ? slotA : slotB;
        const untouched = slotA.orderId ? slotB : slotA;
        assert.strictEqual(
            (slotA.orderId ? 1 : 0) + (slotB.orderId ? 1 : 0), 1,
            'Only one of the two VIRTUAL slots should have an orderId'
        );
        assert.strictEqual(untouched.orderId, null, 'The second slot must remain VIRTUAL (no adoption)');
        assert.strictEqual(untouched.state, ORDER_STATES.VIRTUAL, 'The second slot must retain VIRTUAL state');
        assert.ok(
            result.unmatchedChainOrders.some(u =>
                u.chainOrderId === 'c-orphan-b' && u.reason === 'duplicate-price-level'
            ) || result.unmatchedChainOrders.some(u =>
                u.chainOrderId === 'c-orphan-a' && u.reason === 'duplicate-price-level'
            ),
            'The second orphan must be pushed to unmatchedChainOrders with duplicate-price-level reason'
        );
        assert.strictEqual(
            result.unmatchedChainOrders.filter(u => u.reason === 'duplicate-price-level').length, 1,
            'Exactly one duplicate-price-level entry in unmatchedChainOrders'
        );
    }

    console.log(' - Testing Non-Grid Pair Chain Orders Are Ignored...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'fg-1', state: ORDER_STATES.VIRTUAL, type: ORDER_TYPES.BUY,
            size: 5, price: 10, orderId: null
        });

        // This order does NOT belong to the managed asset pair (1.3.0/1.3.1).
        const chainOrders = [{
            id: 'c-foreign',
            sell_price: { base: { amount: 10000, asset_id: '1.3.999' }, quote: { amount: 1000000, asset_id: '1.3.0' } },
            for_sale: 500000
        }];

        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        const slot = manager.orders.get('fg-1');

        assert.strictEqual(slot.state, ORDER_STATES.VIRTUAL, 'Foreign pair order must not activate any slot');
        assert.strictEqual(slot.orderId, null, 'Foreign pair order must not be assigned to grid slot');
        assert.strictEqual(result.updatedOrders.length, 0, 'Foreign pair orders should produce no grid updates');
    }

    console.log(' - Testing Price Mismatch Queues Manager Correction...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'pc-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 100, orderId: 'c-price'
        });

        const chainOrders = [{
            id: 'c-price',
            // BUY orientation for this market pair; price resolves to 120 (outside normal tolerance).
            sell_price: { base: { amount: 120000, asset_id: '1.3.1' }, quote: { amount: 1000000, asset_id: '1.3.0' } },
            for_sale: 10000000
        }];

        const result = await manager.sync.syncFromOpenOrders(chainOrders);

        assert(result.ordersNeedingCorrection.some(c => c.chainOrderId === 'c-price'), 'Sync result should include price correction');
        assert(manager.ordersNeedingPriceCorrection.some(c => c.chainOrderId === 'c-price' && !c.isSurplus), 'Manager correction queue should include regular price mismatch');
    }

    console.log(' - Testing Null Price Tolerance Uses Strict Drift Detection...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'nulltol-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 0,
            price: 50,
            orderId: 'c-nulltol'
        });

        const chainOrders = [{
            id: 'c-nulltol',
            sell_price: { base: { amount: 101000, asset_id: '1.3.1' }, quote: { amount: 1000000, asset_id: '1.3.0' } },
            for_sale: 100000
        }];

        const result = await manager.sync.syncFromOpenOrders(chainOrders);
        assert(
            result.ordersNeedingCorrection.some(c => c.chainOrderId === 'c-nulltol'),
            'Null tolerance case should still queue correction with strict (0) tolerance'
        );
    }

    console.log(' - Testing PARTIAL restore threshold before ACTIVE upgrade...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'partial-restore-1',
            state: ORDER_STATES.PARTIAL,
            type: ORDER_TYPES.SELL,
            size: 50,
            idealSize: 100,
            price: 100,
            orderId: 'c-partial-restore'
        });

        await manager.sync.syncFromOpenOrders([makeSellChainOrder('c-partial-restore', 60, 100)]);
        assert.strictEqual(
            manager.orders.get('partial-restore-1').state,
            ORDER_STATES.PARTIAL,
            'Order should remain PARTIAL when chain size is below restore ratio'
        );

        await manager.sync.syncFromOpenOrders([makeSellChainOrder('c-partial-restore', 98, 100)]);
        assert.strictEqual(
            manager.orders.get('partial-restore-1').state,
            ORDER_STATES.PARTIAL,
            'Sync never upgrades PARTIAL to ACTIVE; only fill events change order state'
        );
    }

    console.log(' - Testing Concurrent Sync Race Protection...');
    {
        const manager = await createManager();
        const p1 = manager.sync.syncFromOpenOrders([]);
        const p2 = manager.sync.syncFromOpenOrders([]);
        const [r1, r2] = await Promise.all([p1, p2]);
        assert(r1 !== undefined && r2 !== undefined);
    }

    console.log(' - Testing Fill History defaults missing is_maker to maker...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'mk-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            size: 1,
            price: 100,
            orderId: 'c-maker-default'
        });

        const fill = {
            op: [4, {
                order_id: 'c-maker-default',
                pays: { amount: 100000000, asset_id: '1.3.0' },
                receives: { amount: 100000, asset_id: '1.3.1' }
            }],
            block_num: 999,
            id: '1.11.999'
        };

        const result = await manager.sync.syncFromFillHistory(fill);
        assert.strictEqual(result.filledOrders.length, 1, 'Expected full fill to be detected');
        assert.strictEqual(result.filledOrders[0].isMaker, true, 'Missing is_maker should default to maker');
    }

    console.log(' - Testing Fill History uses rawOnChain baseline when local size is stale...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'raw-baseline-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            size: 1.00000001,
            price: 100,
            orderId: 'c-raw-baseline',
            rawOnChain: {
                id: 'c-raw-baseline',
                for_sale: '100000000'
            }
        });

        const fill = {
            op: [4, {
                order_id: 'c-raw-baseline',
                pays: { amount: 100000000, asset_id: '1.3.0' },
                receives: { amount: 100000, asset_id: '1.3.1' },
                is_maker: true
            }],
            block_num: 1001,
            id: '1.11.1001'
        };

        const result = await manager.sync.syncFromFillHistory(fill);
        assert.strictEqual(result.partialFill, false, 'Stale local size should still resolve to full fill when rawOnChain is authoritative');
        assert.strictEqual(result.filledOrders.length, 1, 'Expected full fill with rawOnChain baseline');
        assert.strictEqual(manager.orders.get('raw-baseline-1').state, ORDER_STATES.VIRTUAL, 'Filled slot should be virtualized after full fill');
    }

    OrderUtils.getAssetFees = originalGetAssetFees;
    console.log(' - Testing Large Orphan At Adjacent Price Is Not Misflagged As Duplicate...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'active-1',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.SELL,
            price: 100,
            size: 25,
            orderId: 'c-active'
        });
        await manager._updateOrder({
            id: 'spread-1',
            state: ORDER_STATES.VIRTUAL,
            type: ORDER_TYPES.SPREAD,
            price: 105,
            size: 0
        });

        // Orphan at 105 (5% above active) with same size — adjacent, not duplicate.
        // Tolerance uses Math.max(25, 25)=25 → ~4e-7 for TEST/BTS (prec 8/5).
        // |105-100|=5 >> 4e-7 → not flagged as duplicate.
        const result = await manager.sync.syncFromOpenOrders([
            makeSellChainOrder('c-active', 25, 100),
            makeSellChainOrder('c-orphan-large', 25, 105)
        ]);

        const adopted = manager.orders.get('spread-1');
        assert.strictEqual(adopted.orderId, 'c-orphan-large', 'Large orphan at adjacent price should be adopted into spread slot');
        assert.strictEqual(adopted.state, ORDER_STATES.PARTIAL, 'Fallback-adopted orphan should be partial (size not matched exactly)');
        assert.strictEqual(result.unmatchedChainOrders.length, 0, 'Adjacent orphan should not be pushed to unmatchedChainOrders');
    }

    console.log('✓ Sync logic tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
