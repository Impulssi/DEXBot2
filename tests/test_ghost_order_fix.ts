/**
 * tests/test_ghost_order_fix.ts
 * 
 * Verifies the fix for "ghost orders" where tiny remainders (below minimum order size)
 * were causing orders to stay in PARTIAL state instead of being marked as filled.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { _setFeeCache } = require('../modules/order/utils/math');
const { getPartialsByType } = require('../modules/order/utils/order');

async function runTests() {
    console.log('Running Ghost Order Fix Tests...');

    // Mock fee cache for tests
    _setFeeCache({
        'BTS': { limitOrderCreate: { bts: 0.1 }, limitOrderUpdate: { bts: 0.001 } },
        'XRP': { marketFee: { percent: 0.2 }, takerFee: { percent: 0.2 } }
    });

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'XRP/BTS', assetA: 'XRP', assetB: 'BTS'
        });
        // XRP: precision 4, BTS: precision 5
        mgr.assets = { 
            assetA: { symbol: 'XRP', id: '1.3.5537', precision: 4 }, 
            assetB: { symbol: 'BTS', id: '1.3.0', precision: 5 } 
        };
        await mgr.setAccountTotals({ buy: 100000, sell: 1000, buyFree: 100000, sellFree: 1000 });
        return mgr;
    };

    console.log(' - Testing tiny remainder rounding to full fill (SyncEngine)...');
    {
        const manager = await createManager();

        // Setup initial order: Buy XRP with 249.27798 BTS (exactly the case from the log)
        const initialSize = 249.27798;
        // Provide a fresh rawOnChain snapshot. With drift-only refetch (no TTL),
        // the sync engine will only consult the chain if the cache and the grid
        // disagree. Seeding the cache here keeps the test self-contained.
        const initialSizeInt = Math.round(initialSize * 100000);
        await manager._updateOrder({
            id: 'slot-164',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: initialSize,
            price: 1450.94267,
            orderId: '1.7.570062650',
            rawOnChain: { for_sale: String(initialSizeInt), fetchedAt: Date.now() }
        });

        // Simulate a fill that leaves 0.00003 BTS (below minAbsoluteSize of 0.0005)
        const filledAmount = 249.27795; // Resulting in 0.00003 remainder

        const fillEvent = {
            block_num: 123456,
            id: '1.11.999',
            op: [1, {
                order_id: '1.7.570062650',
                pays: { amount: Math.round(filledAmount * 100000), asset_id: '1.3.0' }, // BTS units (Asset B)
                receives: { amount: 1718, asset_id: '1.3.5537' }, // XRP units (Asset A)
                is_maker: true
            }]
        };

        const result = await manager.sync.syncFromFillHistory(fillEvent);

        // Assertions
        assert.strictEqual(result.partialFill, false, 'Should be treated as full fill despite non-zero remainder');
        assert.strictEqual(result.filledOrders[0].isPartial, undefined, 'filledOrder should NOT be marked as partial to trigger rotation');

        const slot = manager.orders.get('slot-164');
        assert.strictEqual(slot.state, ORDER_STATES.PARTIAL, 'Ghost order slot should be PARTIAL (not VIRTUAL) to prevent duplicate CREATE');
        assert.strictEqual(slot.size, 0, 'Ghost order slot size should be 0');
        assert.strictEqual(slot.orderId, '1.7.570062650', 'Ghost order slot should preserve orderId so guards see it as occupied');
    }

    console.log('✓ Ghost order fix tests passed!');
}

runTests().catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});
