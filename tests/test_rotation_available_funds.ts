const assert = require('assert');
console.log('Running rotation available-funds tests');

const { OrderManager, grid: Grid, constants } = require('../modules/order/index').default;
const ORDER_TYPES = constants.ORDER_TYPES;
const ORDER_STATES = constants.ORDER_STATES;

async function makeManager() {
    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 100,
        minPrice: 50, maxPrice: 200, incrementPercent: 10, targetSpreadPercent: 20,
        botFunds: { buy: 1000, sell: 10 }, activeOrders: { buy: 2, sell: 2 }
    });
    mgr.assets = { assetA: { precision: 5 }, assetB: { precision: 5 } };
    await mgr.setAccountTotals({ buy: 1000, sell: 10, buyFree: 1000, sellFree: 10 });
    await mgr.resetFunds();
    return mgr;
}

async function seedGridForRotation(mgr, targetType) {
    // Clear state
    mgr.orders = new Map();
    mgr._ordersByState = { [ORDER_STATES.VIRTUAL]: new Set(), [ORDER_STATES.ACTIVE]: new Set(), [ORDER_STATES.PARTIAL]: new Set() };
    mgr._ordersByType = { [ORDER_TYPES.BUY]: new Set(), [ORDER_TYPES.SELL]: new Set(), [ORDER_TYPES.SPREAD]: new Set() };

    // Inward slots (SPREAD zone)
    await mgr._updateOrder({ id: 'buy-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 95 });
    await mgr._updateOrder({ id: 'sell-0', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, price: 105 });

    // Middle slots
    await mgr._updateOrder({ id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 85 });
    await mgr._updateOrder({ id: 'sell-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 115 });

    // Outer slots
    await mgr._updateOrder({ id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, price: 75 });
    await mgr._updateOrder({ id: 'sell-2', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, price: 125 });
}

(async () => {
    // Test 1: Rebalance uses available-funds budget
    const mgr = await makeManager();
    await seedGridForRotation(mgr, ORDER_TYPES.BUY);
    
    // Set 2 active orders at the furthest positions
    await mgr._updateOrder({ id: 'buy-1', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: '1.7.1', price: 85, size: 50 });
    await mgr._updateOrder({ id: 'buy-2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, orderId: '1.7.2', price: 75, size: 50 });
    
    // Set up funds
    mgr.funds.available.buy = 100;
    await mgr.recalculateFunds();

    // Trigger rebalance with an opposite side fill to force inward rotation
    const result = await mgr.performSafeRebalance([{ type: ORDER_TYPES.SELL, price: 105 }]);

    // Modern rotation-first COW plan: the 2 ACTIVE buys are rotated inward
    // (UPDATE with newGridId: buy-2 → sell-0 slot, buy-1 → buy-0 slot) and
    // the sell side is seeded with 2 CREATE placements sized from the
    // available sell budget (10 split across sell-1 + sell-2).
    const creates = result.actions.filter(a => a.type === constants.COW_ACTIONS.CREATE);
    assert.strictEqual(creates.length, 2);
    for (const c of creates) {
        assert(c.order && c.order.size > 0, `Expected a placement with positive size, got ${c.order?.size}`);
        assert(c.order.type === ORDER_TYPES.SELL, 'Expected new placements to be on the SELL side');
    }
    const rotations = result.actions.filter(a => a.type === constants.COW_ACTIONS.UPDATE && a.newGridId);
    assert.strictEqual(rotations.length, 2, 'Expected the 2 active buys to be rotated inward');

    console.log('Test 1 passed: rebalance uses available funds to seed new placements');

    console.log('rotation available-funds tests passed');
})();
