const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testSpreadRedistributionFallback() {
    console.log('Running test: Spread Redistribution Fallback');

    const mgr = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 910, sell: 100 },
        activeOrders: { buy: 2, sell: 1 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });

    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    // BUY side setup:
    // - buy-donor is over-allocated and can be reduced
    // - buy-edge is the edge partial that should be topped up first
    // - spread-1 is the missing slot to create
    await mgr._updateOrder({
        id: 'buy-donor',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 0.80,
        size: 900,
        orderId: '1.7.101'
    });
    await mgr._updateOrder({
        id: 'buy-edge',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        price: 0.90,
        size: 10,
        orderId: '1.7.102'
    });
    await mgr._updateOrder({
        id: 'spread-1',
        type: ORDER_TYPES.SPREAD,
        state: ORDER_STATES.VIRTUAL,
        price: 0.95,
        size: 0
    });

    // Two buy slots above the spread-1 slot — boundary sits at index 2 so spread-1
    // (price-sorted idx=2) computes as BUY under the boundary-correct type filter.
    mgr.boundaryIdx = 2;

    // No free buy funds, all buy capital is committed on-chain.
    await mgr.setAccountTotals({ buy: 910, sell: 0, buyFree: 0, sellFree: 0 });
    await mgr.recalculateFunds();
    assert.strictEqual(mgr.funds.available.buy, 0, 'Precondition failed: buy free funds must be zero');

    console.log('  Scenario A: side selection falls back to committed inventory');
    const decision = Grid.determineOrderSideByFunds(mgr, 1);
    assert.strictEqual(decision.side, ORDER_TYPES.BUY, 'Should select BUY side using committed-inventory fallback');
    console.log('  ✓ Committed-inventory fallback selected BUY with zero free funds');

    console.log('  Scenario B: spread correction plans redistribution-funded actions');
    const correction = await Grid.prepareSpreadCorrectionOrders(mgr, ORDER_TYPES.BUY, 1);

    assert.strictEqual(correction.ordersToPlace.length, 1, 'Should create one spread correction slot');
    assert(correction.ordersToUpdate.some(u => u?.partialOrder?.id === 'buy-donor'), 'Should downsize donor to recover budget');
    assert(correction.ordersToUpdate.some(u => u?.partialOrder?.id === 'buy-edge'), 'Should top up edge partial');

    const donorUpdate = correction.ordersToUpdate.find(u => u?.partialOrder?.id === 'buy-donor');
    assert(donorUpdate.newSize < 900, 'Donor must be reduced below original size');

    const create = correction.ordersToPlace[0];
    assert.strictEqual(create.id, 'spread-1', 'Should place into the nearest spread slot');
    assert(create.size > 0, 'Created spread slot must have positive size');
    console.log('  ✓ Redistribution produced donor downsize + edge top-up + create');

    console.log('✓ Spread Redistribution Fallback test PASSED\n');
}

testSpreadRedistributionFallback().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
