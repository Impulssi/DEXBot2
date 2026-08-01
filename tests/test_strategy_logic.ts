/**
 * tests/test_strategy_logic.ts
 * 
 * Ported from tests/unit/strategy.test.js
 * Comprehensive unit tests for strategy.js - Rebalancing logic and order placement
 * Uses native assert to avoid Jest dependency.
 * 
 * UPDATED: Uses modern performSafeRebalance() (COW pipeline) instead of legacy rebalance().
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

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
    console.log('Running Strategy Logic Tests (COW)...');

    const createManager = async () => {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            startPrice: 100, incrementPercent: 1, targetSpreadPercent: 2,
            activeOrders: { buy: 5, sell: 5 }, weightDistribution: { sell: 0.5, buy: 0.5 }
        });
        mgr.logger.level = 'debug';
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        await mgr.resetFunds();
        return mgr;
    };

    console.log(' - Testing VIRTUAL Order Placement Capping...');
    {
        const manager = await createManager();
        const virtualOrders = [
            { id: 'v-b-1', type: ORDER_TYPES.BUY, price: 99, size: 500, state: ORDER_STATES.VIRTUAL },
            { id: 'v-s-1', type: ORDER_TYPES.SELL, price: 101, size: 50, state: ORDER_STATES.VIRTUAL }
        ];
        manager.pauseFundRecalc();
        for (const o of virtualOrders) {
            await manager._updateOrder(o);
        }
        await manager.resumeFundRecalc();

        // In modern architecture, we use total budget, so available=0 doesn't block placement
        // if total budget (liquid + committed) is sufficient.
        manager.funds.available.buy = 0;
        manager.funds.available.sell = 0;

        const result = await manager.performSafeRebalance();
        const placements = result.actions.filter(a => a.type === 'create' && virtualOrders.some(v => v.id === a.id));
        assert(placements.length > 0, 'Should have placements for VIRTUAL orders');
        assert(placements[0].order.size > 0, 'Placement size should be greater than 0');
    }

    console.log(' - Testing PARTIAL Order Handling...');
    {
        const manager = await createManager();
        manager.config.targetSpreadPercent = 0; // Ensure minimal spread gap
        // Add many slots to push the boundary far away from our test order (price 90)
        for (let i = 0; i < 10; i++) {
            await manager._updateOrder({ id: `v-extra-${i}`, type: ORDER_TYPES.BUY, price: 80 + i, size: 0, state: ORDER_STATES.VIRTUAL });
        }
        await manager._updateOrder({ id: 'p-d-1', type: ORDER_TYPES.BUY, price: 90, size: 5, state: ORDER_STATES.PARTIAL, orderId: 'c1' });
        await manager._updateOrder({ id: 'v-boundary-push', type: ORDER_TYPES.BUY, price: 91, size: 0, state: ORDER_STATES.VIRTUAL });
        
        const result = await manager.performSafeRebalance();

        // Modern COW planner keeps in-place non-rotation size updates out of strategy
        // and lets dedicated maintenance flows handle those updates.
        const partialCancel = result.actions.find(a => a.type === 'cancel' && (a.id === 'p-d-1' || a.orderId === 'c1'));
        assert(partialCancel === undefined, 'Should not cancel existing PARTIAL in rebalance plan');

        const creates = result.actions.filter(a => a.type === 'create');
        assert(creates.length > 0, 'Should create nearby target slots while PARTIAL remains managed');

        const partialOrder = manager.orders.get('p-d-1');
        assert(partialOrder && partialOrder.state === ORDER_STATES.PARTIAL, 'PARTIAL order should remain PARTIAL after planning');
    }

    console.log(' - Testing Boundary Index Initialization...');
    {
        const manager = await createManager();
        manager.boundaryIdx = undefined;
        manager.pauseFundRecalc();
        for (let i = 0; i < 10; i++) {
            const price = 95 + (i * 1.0);
            await manager._updateOrder({ id: `o-${i}`, type: price < 100 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL, price, size: 100, state: ORDER_STATES.VIRTUAL });
        }
        await manager.resumeFundRecalc();
        
        const result = await manager.performSafeRebalance();
        assert(result.workingBoundary !== undefined, 'workingBoundary should be initialized');
    }

    console.log(' - Testing BUY Side Weighting...');
    {
        const manager = await createManager();
        manager.pauseFundRecalc();
        await manager._updateOrder({ id: 'b-far', type: ORDER_TYPES.BUY, price: 85, size: 0, state: ORDER_STATES.VIRTUAL });
        await manager._updateOrder({ id: 'b-near', type: ORDER_TYPES.BUY, price: 99, size: 0, state: ORDER_STATES.VIRTUAL });
        await manager.resumeFundRecalc();

        const result = await manager.performSafeRebalance();
        const near = result.actions.find(a => a.type === 'create' && a.id === 'b-near');
        const far = result.actions.find(a => a.type === 'create' && a.id === 'b-far');
        if (near && far) {
            assert(near.order.size >= far.order.size, 'Market-closest BUY should have more capital');
        }
    }

    console.log(' - Testing Sizing Capping...');
    {
        const manager = await createManager();
        manager.config.targetSpreadPercent = 0; 

        // Set totals so total budget is limited
        await manager.setAccountTotals({ buy: 100, sell: 1000, buyFree: 100, sellFree: 1000 });
        await manager.resetFunds();

        // Mock a target slot near market (shortage)
        await manager._updateOrder({ id: 'target-1', type: ORDER_TYPES.BUY, price: 99, size: 0, state: ORDER_STATES.VIRTUAL });

        const result = await manager.performSafeRebalance();
        const placement = result.actions.find(a => a.type === 'create' && a.id === 'target-1');

        if (placement) {
            assert(placement.order.size > 0, 'New placement size should be positive');
            assert(placement.order.size <= 100, 'New placement size should respect budget');
        }
    }

    OrderUtils.getAssetFees = originalGetAssetFees;
    console.log('✓ Strategy logic tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
