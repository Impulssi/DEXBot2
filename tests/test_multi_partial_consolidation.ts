const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { createTestLogger } = require('./helpers/silent_logger');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('='.repeat(70));
console.log('Testing Multi-Partial Consolidation Rule (COW)');
console.log('='.repeat(70));

// Helper to setup a manager with grid and test orders
async function setupManager() {
    const cfg = {
        assetA: 'BTS',
        assetB: 'USD',
        startPrice: 1.0,
        botFunds: { buy: 10000, sell: 10000 },
        activeOrders: { buy: 2, sell: 2 },
        incrementPercent: 1,
        weightDistribution: { buy: 0.5, sell: 0.5 }
    };

    const mgr = new OrderManager(cfg);
    mgr.logger = createTestLogger({
        includeFundsStatus: false,
        onLog: (msg, level) => {
            if (level !== 'debug') console.log(`    [${level}] ${msg}`);
        }
    });

    mgr.assets = {
        assetA: { id: '1.3.0', precision: 8 },
        assetB: { id: '1.3.121', precision: 5 }
    };

    await mgr.setAccountTotals({ buy: 10000, sell: 10000, buyFree: 10000, sellFree: 10000 });

    // Setup a simple grid
    mgr.orders.set('sell-0', { id: 'sell-0', type: ORDER_TYPES.SELL, price: 1.30, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-v1', { id: 'sell-v1', type: ORDER_TYPES.SELL, price: 1.25, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-1', { id: 'sell-1', type: ORDER_TYPES.SELL, price: 1.20, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-v2', { id: 'sell-v2', type: ORDER_TYPES.SELL, price: 1.15, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-2', { id: 'sell-2', type: ORDER_TYPES.SELL, price: 1.10, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('sell-v3', { id: 'sell-v3', type: ORDER_TYPES.SELL, price: 1.05, size: 10, state: ORDER_STATES.VIRTUAL });
    mgr.orders.set('buy-0', { id: 'buy-0', type: ORDER_TYPES.BUY, price: 0.90, size: 10, state: ORDER_STATES.ACTIVE });
    mgr.orders.set('buy-1', { id: 'buy-1', type: ORDER_TYPES.BUY, price: 0.80, size: 10, state: ORDER_STATES.ACTIVE });

    // Initialize indices
    for (const order of Array.from(mgr.orders.values())) {
        await mgr._updateOrder(order);
    }

    return mgr;
}

async function testMultiPartialConsolidation() {
    console.log('\n[Test] Consolidating 3 SELL partials');
    console.log('-'.repeat(70));

    const mgr = await setupManager();

    // Setup 3 partial SELL orders
    // P1 (130, size 2) - Outermost
    // P2 (120, size 15) - Middle
    // P3 (110, size 1) - Innermost
    const p1 = { id: 'sell-0', orderId: 'chain-p1', type: ORDER_TYPES.SELL, price: 1.30, size: 2, state: ORDER_STATES.PARTIAL };
    const p2 = { id: 'sell-1', orderId: 'chain-p2', type: ORDER_TYPES.SELL, price: 1.20, size: 15, state: ORDER_STATES.PARTIAL };
    const p3 = { id: 'sell-2', orderId: 'chain-p3', type: ORDER_TYPES.SELL, price: 1.10, size: 1, state: ORDER_STATES.PARTIAL };

    await mgr._updateOrder(p1);
    await mgr._updateOrder(p2);
    await mgr._updateOrder(p3);

    // Execute COW rebalance
    const result = await mgr.performSafeRebalance([{ type: ORDER_TYPES.BUY, price: 0.95 }]);

    console.log('  Verifying strategy actions:');
    console.log(`  Actions count: ${result.actions.length}`);

    // Check that we have some actions
    assert(result.actions.length > 0, 'Should have actions for partials');

    // Modern rotation-first strategy. The BUY fill at 0.95 crawls the boundary
    // left: the buy-0 slot (0.90) turns into a SELL slot and sell-2 (1.10)
    // becomes the SPREAD slot. Target window holds the two in-zone SELL slots.
    // On-chain orders outside the window are surplus and get ROTATED (UPDATE)
    // into empty in-window holes: sell-0 -> buy-0 slot, sell-1 -> sell-v3.
    // The partial whose slot became SPREAD (sell-2) has no rotation target
    // and is CANCELLED ('surplus-no-rotation-target'). All three partials
    // must be resolved (rotated or cancelled) - none left dangling.

    const updateP1 = result.actions.find(a => a.type === 'update' && a.id === 'sell-0' && a.newGridId === 'buy-0');
    const updateP2 = result.actions.find(a => a.type === 'update' && a.id === 'sell-1' && a.newGridId === 'sell-v3');
    const cancelP3 = result.actions.find(a => a.type === 'cancel' && a.id === 'sell-2');

    assert(updateP1, 'sell-0 (p1) should be rotated into the buy-0 slot');
    assert(updateP2, 'sell-1 (p2) should be rotated into the sell-v3 slot');
    assert(cancelP3, 'sell-2 (p3) should be cancelled (no rotation target)');

    console.log(`  ✓ Multi-partial handling verified via unified strategy (COW)`);
}

(async () => {
    try {
        await testMultiPartialConsolidation();
        console.log('\n' + '='.repeat(70));
        console.log('All Multi-Partial Consolidation Tests Passed!');
        console.log('='.repeat(70));
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Test failed:', getErrorMessage(err));
        console.error((err as any).stack);
        process.exit(1);
    }
})();
