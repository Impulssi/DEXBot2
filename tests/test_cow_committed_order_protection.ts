const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { createSilentLogger } = require('./helpers/silent_logger');

// Compiled ESM namespaces are frozen: seed the fee cache via the _setFeeCache
// seam instead of patching OrderUtils.getAssetFees (createFee=0.1, updateFee=0.001).
require('../modules/order/utils/math')._setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderUpdate: { bts: 0.001 },
        limitOrderCancel: { bts: 0 },
        makerFeeDiscountPercent: 0.9,
    },
    TEST: { chargesMarketFees: false },
});

async function runTests() {
    console.log('Running Committed Order Protection Tests...');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS'
        });
        mgr.logger = createSilentLogger();
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        return mgr;
    };

    console.log(' - _committedOrderIds always protects during snapshot sync...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.100'
        });
        manager._committedOrderIds.add('1.7.100');
        // Commit timestamp must be within SYNC_LOCK_TIMEOUT_MS (20s) to stay protected
        manager._committedOrderIdsBuiltAt = Date.now();
        const result = await manager.sync.syncFromOpenOrders([], {});
        const order = manager.orders.get('slot-1');
        assert.strictEqual(order.state, ORDER_STATES.ACTIVE, 'Committed order should remain ACTIVE during snapshot sync');
        assert.strictEqual(result.filledOrders.length, 0, 'No fills should be reported for protected order');
    }

    console.log(' - Non-committed order is virtualized...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-2', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.101'
        });
        const result = await manager.sync.syncFromOpenOrders([], {});
        const order = manager.orders.get('slot-2');
        assert.strictEqual(order.state, ORDER_STATES.VIRTUAL, 'Non-committed order should be virtualized');
        assert.strictEqual(result.filledOrders.length, 1, 'Fill should be reported for non-committed order');
        assert.strictEqual(result.filledOrders[0].id, 'slot-2', 'Fill should reference the correct slot');
    }

    console.log(' - Order removed from committed set is not protected...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-3', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.102'
        });
        manager._committedOrderIds.add('1.7.102');
        manager._committedOrderIds.delete('1.7.102');
        const result = await manager.sync.syncFromOpenOrders([], {});
        const order = manager.orders.get('slot-3');
        assert.strictEqual(order.state, ORDER_STATES.VIRTUAL, 'Order removed from committed set should be virtualized');
        assert.strictEqual(result.filledOrders.length, 1, 'Fill should be reported');
    }

    console.log(' - Protection works through synchronizeWithChain readOpenOrders...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-4', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.103'
        });
        manager._committedOrderIds.add('1.7.103');
        manager._committedOrderIdsBuiltAt = Date.now();
        const result = await manager.synchronizeWithChain([], 'readOpenOrders');
        const order = manager.orders.get('slot-4');
        assert.strictEqual(order.state, ORDER_STATES.ACTIVE, 'Committed order should remain ACTIVE via synchronizeWithChain readOpenOrders');
    }

    console.log(' - Protection always active for readOpenOrders source...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-5', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.104'
        });
        manager._committedOrderIds.add('1.7.104');
        manager._committedOrderIdsBuiltAt = Date.now();
        const result = await manager.synchronizeWithChain([], 'readOpenOrders');
        const order = manager.orders.get('slot-5');
        assert.strictEqual(order.state, ORDER_STATES.ACTIVE, 'Committed order should remain ACTIVE — protection is always on for snapshot syncs');
    }

    console.log(' - Ghost order (PARTIAL+size=0) escapes committed-order protection...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'ghost-slot', state: ORDER_STATES.PARTIAL, type: ORDER_TYPES.BUY,
            size: 0, price: 50, orderId: '1.7.200'
        });
        manager._committedOrderIds.add('1.7.200');
        manager._committedOrderIdsBuiltAt = Date.now();
        const result = await manager.sync.syncFromOpenOrders([], {});
        const order = manager.orders.get('ghost-slot');
        assert.strictEqual(order.state, ORDER_STATES.VIRTUAL, 'Ghost order (PARTIAL+size=0) should be virtualized despite being in committed set');
        assert.strictEqual(result.filledOrders.length, 1, 'Fill should be reported for ghost order');
        assert.strictEqual(result.filledOrders[0].id, 'ghost-slot', 'Fill should reference ghost slot');
    }

    console.log(' - Old committed order escapes protection via time-based hatch...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'old-committed', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.201'
        });
        manager._committedOrderIds.add('1.7.201');
        manager._committedOrderIdsBuiltAt = 1;
        const result = await manager.sync.syncFromOpenOrders([], {});
        const order = manager.orders.get('old-committed');
        assert.strictEqual(order.state, ORDER_STATES.VIRTUAL, 'Old committed order should be virtualized via time-based hatch');
        assert.strictEqual(result.filledOrders.length, 1, 'Fill should be reported for old committed order');
    }

    console.log(' - Recently committed order stays protected within grace window...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'recent-committed', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.202'
        });
        manager._committedOrderIds.add('1.7.202');
        manager._committedOrderIdsBuiltAt = Date.now();
        const result = await manager.sync.syncFromOpenOrders([], {});
        const order = manager.orders.get('recent-committed');
        assert.strictEqual(order.state, ORDER_STATES.ACTIVE, 'Recently committed order should remain protected within grace window');
        assert.strictEqual(result.filledOrders.length, 0, 'No fills should be reported for recently committed order');
    }

    console.log('All committed order protection tests passed.');
}

runTests().then(() => process.exit(0)).catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
