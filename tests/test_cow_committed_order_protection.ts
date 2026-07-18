const assert = require('assert');
const { OrderManager } = require('../modules/order/index');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { createSilentLogger } = require('./helpers/silent_logger');

const OrderUtils = require('../modules/order/utils/math');
const originalGetAssetFees = OrderUtils.getAssetFees;
OrderUtils.getAssetFees = (asset) => {
    if (asset === 'BTS') {
        return { total: 0.011, createFee: 0.1, updateFee: 0.001, makerNetFee: 0.01, takerNetFee: 0.1, netFee: 0.01, isMaker: true };
    }
    return 1.0;
};

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

    console.log(' - Protection flag preserves committed order during recovery sync...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-1', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.100'
        });
        manager._committedOrderIds.add('1.7.100');
        const result = await manager.sync.syncFromOpenOrders([], { protectCommittedOrders: true });
        const order = manager.orders.get('slot-1');
        assert.strictEqual(order.state, ORDER_STATES.ACTIVE, 'Committed order should remain ACTIVE with protection flag');
        assert.strictEqual(result.filledOrders.length, 0, 'No fills should be reported for protected order');
    }

    console.log(' - Missing flag virtualizes committed order...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-2', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.101'
        });
        manager._committedOrderIds.add('1.7.101');
        const result = await manager.sync.syncFromOpenOrders([], {});
        const order = manager.orders.get('slot-2');
        assert.strictEqual(order.state, ORDER_STATES.VIRTUAL, 'Committed order should be virtualized without protection flag');
        assert.strictEqual(result.filledOrders.length, 1, 'Fill should be reported for unprotected order');
        assert.strictEqual(result.filledOrders[0].id, 'slot-2', 'Fill should reference the correct slot');
    }

    console.log(' - Flag does not protect non-committed order...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-3', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.102'
        });
        const result = await manager.sync.syncFromOpenOrders([], { protectCommittedOrders: true });
        const order = manager.orders.get('slot-3');
        assert.strictEqual(order.state, ORDER_STATES.VIRTUAL, 'Non-committed order should be virtualized even with protection flag');
        assert.strictEqual(result.filledOrders.length, 1, 'Fill should be reported for non-committed order');
    }

    console.log(' - Order removed from committed set on fill is not protected...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-4', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.103'
        });
        manager._committedOrderIds.add('1.7.103');
        manager._committedOrderIds.delete('1.7.103');
        const result = await manager.sync.syncFromOpenOrders([], { protectCommittedOrders: true });
        const order = manager.orders.get('slot-4');
        assert.strictEqual(order.state, ORDER_STATES.VIRTUAL, 'Order removed from committed set should be virtualized');
        assert.strictEqual(result.filledOrders.length, 1, 'Fill should be reported');
    }

    console.log(' - Protection flag threaded through synchronizeWithChain readOpenOrders...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-5', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.104'
        });
        manager._committedOrderIds.add('1.7.104');
        const result = await manager.synchronizeWithChain([], 'readOpenOrders', { protectCommittedOrders: true });
        const order = manager.orders.get('slot-5');
        assert.strictEqual(order.state, ORDER_STATES.ACTIVE, 'Committed order should remain ACTIVE via synchronizeWithChain with protection flag');
    }

    console.log(' - Protection flag not passed through synchronizeWithChain readOpenOrders...');
    {
        const manager = await createManager();
        await manager._updateOrder({
            id: 'slot-6', state: ORDER_STATES.ACTIVE, type: ORDER_TYPES.BUY,
            size: 100, price: 50, orderId: '1.7.105'
        });
        manager._committedOrderIds.add('1.7.105');
        const result = await manager.synchronizeWithChain([], 'readOpenOrders', {});
        const order = manager.orders.get('slot-6');
        assert.strictEqual(order.state, ORDER_STATES.VIRTUAL, 'Committed order should be virtualized via synchronizeWithChain without protection flag');
    }

    console.log('All committed order protection tests passed.');
}

runTests().then(() => process.exit(0)).catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
