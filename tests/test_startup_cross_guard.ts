/**
 * tests/test_startup_cross_guard.ts
 *
 * Regression tests for the startup-reconcile and price-correction
 * crossing guards (STARTUP-CROSS-GUARD / CROSS-GUARD), closing the
 * remaining grid-sabotage audit gaps:
 *
 * 1. Relocation updates (_prepareStartupUpdatePlan) re-price a chain
 *    order onto a rail slot — they must not cross an opposite-side live
 *    order (master grid or unmatched chain orphan). A failed Phase-2
 *    cancel leaves the straddler live; the guard refuses to re-price
 *    across it instead of self-trading during the broadcast window.
 * 2. Startup creates (_createOrderFromGrid) must not cross live
 *    opposite-side orders either.
 * 3. correctOrderPriceOnChain re-prices to the slot's committed price —
 *    must skip (and drop for re-queue) when the target price crosses a
 *    live opposite-side order (broken grid geometry).
 */
const assert = require('assert');
const {
    _prepareStartupUpdatePlan,
    _createOrderFromGrid
} = require('../modules/order/grid_reconcile_internal');
const { correctOrderPriceOnChain } = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const ASSETS = {
    assetA: { id: '1.3.0', precision: 6, symbol: 'ASSET_A' },
    assetB: { id: '1.3.1', precision: 5, symbol: 'ASSET_B' }
};

function createManager(ordersList, unmatched = []) {
    const logs = [];
    const manager = {
        orders: new Map(ordersList.map(o => [o.id, { ...o }])),
        _lastUnmatchedChainOrders: unmatched,
        assets: ASSETS,
        ordersNeedingPriceCorrection: [],
        logger: { log: (msg, level) => logs.push(`[${level}] ${msg}`) }
    };
    return { manager, logs };
}

function liveOrder(id, orderId, type, price, size = 0.06) {
    return { id, orderId, type, price, size, state: ORDER_STATES.ACTIVE };
}

function emptySlot(id, type, price) {
    return { id, orderId: null, type, price, size: 0, state: ORDER_STATES.VIRTUAL };
}

async function run() {
    console.log('Running startup cross guard tests...');

    // ---- 1. Relocation update must not cross a live master sell ----
    {
        const { manager, logs } = createManager([
            liveOrder('slot-20', '1.7.100', ORDER_TYPES.SELL, 865.3848),
            emptySlot('slot-10', ORDER_TYPES.BUY, 840.0)
        ]);
        const plan = {
            chainOrderId: '1.7.200',
            gridOrder: { id: 'slot-10', price: 865.378, type: ORDER_TYPES.BUY, size: 0.06 },
            chainOrderObj: null
        };
        const prepared = _prepareStartupUpdatePlan(plan, manager, manager.logger);
        assert.strictEqual(prepared, null, 'relocation onto a crossed price must be rejected');
        assert(
            logs.some(l => l.includes('[STARTUP-CROSS-GUARD]')),
            'guard must log the skipped relocation'
        );
        console.log('  - relocation update crossing a live sell is rejected');
    }

    // ---- 2. Relocating the crossed order itself is exempt ----
    {
        const { manager, logs } = createManager([
            liveOrder('slot-20', '1.7.100', ORDER_TYPES.SELL, 865.3848),
            emptySlot('slot-10', ORDER_TYPES.BUY, 840.0)
        ]);
        const plan = {
            chainOrderId: '1.7.100',
            gridOrder: { id: 'slot-10', price: 865.378, type: ORDER_TYPES.BUY, size: 0.06 },
            chainOrderObj: null
        };
        const prepared = _prepareStartupUpdatePlan(plan, manager, manager.logger);
        assert(prepared, 'relocating the crossed order itself must not be flagged');
        assert.strictEqual(prepared.updateParams.newPrice, 865.378);
        assert(
            !logs.some(l => l.includes('[STARTUP-CROSS-GUARD]')),
            'exempt relocation must not log a crossing'
        );
        console.log('  - self-relocation (excludeChainOrderId) is exempt');
    }

    // ---- 3. Unmatched chain orphans are crossing candidates ----
    {
        const { manager } = createManager([
            emptySlot('slot-10', ORDER_TYPES.BUY, 840.0)
        ], [
            { chainOrderId: '1.7.300', type: ORDER_TYPES.SELL, price: 870.0, size: 0.1, reason: 'price-drift-orphan' }
        ]);
        const plan = {
            chainOrderId: '1.7.200',
            gridOrder: { id: 'slot-10', price: 871.0, type: ORDER_TYPES.BUY, size: 0.06 },
            chainOrderObj: null
        };
        const prepared = _prepareStartupUpdatePlan(plan, manager, manager.logger);
        assert.strictEqual(prepared, null, 'relocation must not cross an unmatched chain orphan');
        // Clean price below the orphan passes.
        const clean = _prepareStartupUpdatePlan({
            ...plan,
            gridOrder: { id: 'slot-10', price: 860.0, type: ORDER_TYPES.BUY, size: 0.06 }
        }, manager, manager.logger);
        assert(clean, 'relocation below the orphan must pass');
        assert.strictEqual(clean.updateParams.newPrice, 860.0);
        console.log('  - unmatched chain orphans are crossing candidates');
    }

    // ---- 4. Startup create must not cross a live master sell ----
    {
        const { manager, logs } = createManager([
            liveOrder('slot-20', '1.7.100', ORDER_TYPES.SELL, 865.3848),
            emptySlot('slot-10', ORDER_TYPES.BUY, 840.0)
        ]);
        let createCalled = false;
        const chainOrders = {
            createOrder: async () => { createCalled = true; return null; }
        };
        const result = await _createOrderFromGrid({
            chainOrders,
            account: 'test-account',
            privateKey: 'k',
            manager,
            gridOrder: { id: 'slot-10', price: 865.378, type: ORDER_TYPES.BUY, size: 0.06 },
            dryRun: false
        });
        assert.strictEqual(result, null, 'create at a crossed price must be rejected');
        assert.strictEqual(createCalled, false, 'createOrder must not be called for a crossed placement');
        assert(
            logs.some(l => l.includes('STARTUP-CROSS-GUARD')),
            'create guard must log the skipped create'
        );
        console.log('  - startup create crossing a live sell is rejected before broadcast');
    }

    // ---- 5. Startup create passes on a clean book ----
    {
        const { manager } = createManager([
            emptySlot('slot-10', ORDER_TYPES.BUY, 840.0)
        ]);
        let createCalled = false;
        const chainOrders = {
            createOrder: async () => { createCalled = true; return {}; }
        };
        const result = await _createOrderFromGrid({
            chainOrders,
            account: 'test-account',
            privateKey: 'k',
            manager,
            gridOrder: { id: 'slot-10', price: 860.0, type: ORDER_TYPES.BUY, size: 0.06 },
            dryRun: false
        });
        assert.strictEqual(createCalled, true, 'clean create must reach the chain layer');
        assert.strictEqual(result, null, 'mocked broadcast yields no chain id (expected in unit harness)');
        console.log('  - clean startup create reaches the chain layer');
    }

    // ---- 6. correctOrderPriceOnChain skips (and drops for re-queue) on crossing ----
    {
        const { manager, logs } = createManager([
            liveOrder('slot-20', '1.7.100', ORDER_TYPES.SELL, 865.3848)
        ]);
        manager.ordersNeedingPriceCorrection = [{ chainOrderId: '1.7.200' }];
        let updateCalled = false;
        const accountOrders = {
            updateOrder: async () => { updateCalled = true; return {}; }
        };
        const result = await correctOrderPriceOnChain(
            manager,
            {
                gridOrder: { id: 'slot-10' },
                chainOrderId: '1.7.200',
                expectedPrice: 865.378,
                size: 0.06,
                type: ORDER_TYPES.BUY,
                isSurplus: false,
                cancelOnly: false
            },
            'test-account', 'k', accountOrders
        );
        assert.strictEqual(updateCalled, false, 'crossed correction must not broadcast');
        assert.strictEqual(result.success, false, 'crossed correction must not report success');
        assert.strictEqual(result.skipped, true, 'crossed correction must be skipped');
        assert.strictEqual(result.error, 'crossed-placement-guard');
        assert(
            logs.some(l => l.includes('[CROSS-GUARD]')),
            'correction guard must log the skip'
        );
        assert.strictEqual(
            manager.ordersNeedingPriceCorrection.length,
            0,
            'entry must be dropped from the correction queue (re-queued by next sync if still needed)'
        );
        console.log('  - price correction crossing a live sell is skipped and dropped');
    }

    // ---- 7. correctOrderPriceOnChain proceeds on a clean book ----
    {
        const { manager } = createManager([
            emptySlot('slot-10', ORDER_TYPES.BUY, 840.0)
        ]);
        manager.ordersNeedingPriceCorrection = [{ chainOrderId: '1.7.200' }];
        let updateCalled = false;
        const accountOrders = {
            updateOrder: async () => { updateCalled = true; return {}; }
        };
        const result = await correctOrderPriceOnChain(
            manager,
            {
                gridOrder: { id: 'slot-10' },
                chainOrderId: '1.7.200',
                expectedPrice: 840.0,
                size: 0.06,
                type: ORDER_TYPES.BUY,
                isSurplus: false,
                cancelOnly: false
            },
            'test-account', 'k', accountOrders
        );
        assert.strictEqual(updateCalled, true, 'clean correction must broadcast');
        assert.strictEqual(result.success, true, 'clean correction must succeed');
        console.log('  - clean price correction broadcasts normally');
    }

    console.log('PASS test_startup_cross_guard');
}

run().catch(err => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});
