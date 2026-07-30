const assert = require('assert');

const {
    reconcileGridOrders,
    attemptResumePersistedGridByPriceMatch,
} = require('../modules/order/grid_reconcile');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

function createManager(overrides = {}) {
    const orders = new Map();
    const manager = {
        orders,
        logger: { log: () => {} },
        assets: {
            assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' },
            assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' },
        },
        accountTotals: { sellFree: 0, buyFree: 0 },
        strategy: {
            hasAnyDust: () => false,
            rebalance: async () => null,
        },
        accountant: {
            addToChainFree: (orderType, size) => {
                const key = orderType === ORDER_TYPES.SELL ? 'sellFree' : 'buyFree';
                manager.accountTotals[key] = (manager.accountTotals[key] || 0) + (Number(size) || 0);
            },
        },
        getOrdersByTypeAndState: (type, state) => {
            return Array.from(orders.values()).filter(o => o && o.type === type && o.state === state);
        },
        _gridLock: { acquire: async (fn) => await fn() },
        synchronizeWithChain: async () => {},
        _applySync: async () => {},
        _updateOrder: (order) => { orders.set(order.id, order); },
        _applyOrderUpdate: async (order) => { orders.set(order.id, order); return true; },
        ...overrides,
    };
    return manager;
}

async function testUnmatchedCancelReleasesFundsAndHandlesNullEntries() {
    const manager = createManager({ accountTotals: { sellFree: 1, buyFree: 0 } });

    const chainOpenOrders = [
        null,
        {
            id: '1.7.10',
            sell_price: {
                base: { amount: 1000000, asset_id: '1.3.1' },
                quote: { amount: 500000, asset_id: '1.3.0' },
            },
            for_sale: 1000000,
        },
    ];

    let cancelCalls = 0;
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({
            op: {
                op_name: 'limit_order_update',
                op_data: {
                    fee: { amount: 0, asset_id: '1.3.0' }
                }
            }
        }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => { cancelCalls++; },
        createOrder: async () => [],
        readOpenOrders: async () => [],
    };

    await reconcileGridOrders({
        manager,
        config: { activeOrders: { sell: 0, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(cancelCalls, 1, 'Should cancel unmatched excess chain order');
    assert.strictEqual(manager.accountTotals.sellFree, 11, 'Should release cancelled unmatched SELL size to sellFree');
    console.log('✅ Regression 1 passed: unmatched cancel releases funds and null chain entries are tolerated');
}

async function testVerifiedAfterFailureRefetchesOpenOrders() {
    const manager = createManager({ accountTotals: { sellFree: 1, buyFree: 0 } });

    let syncCalls = 0;
    let syncSource = null;
    let syncOptions = null;
    let syncPayload = null;
    (manager as any).syncFromOpenOrders = async (chainOrders, options) => {
        syncCalls++;
        syncPayload = chainOrders;
        syncOptions = options;
        syncSource = options?.source;
        return { filledOrders: [], updatedOrders: [], ordersNeedingCorrection: [] };
    };

    let cancelCalls = 0;
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => {
            cancelCalls++;
            return { success: true, orderId: '1.7.11', verified: true, verifiedAfterFailure: true };
        },
        createOrder: async () => [],
        readOpenOrders: async (accountRef) => {
            assert.strictEqual(accountRef, 'acct', 'Fallback refetch should resolve the account reference');
            return [];
        },
    };

    const chainOpenOrders = [
        {
            id: '1.7.11',
            sell_price: {
                base: { amount: 1000000, asset_id: '1.3.1' },
                quote: { amount: 500000, asset_id: '1.3.0' },
            },
            for_sale: 1000000,
        },
    ];

    await reconcileGridOrders({
        manager,
        config: { activeOrders: { sell: 0, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(cancelCalls, 1, 'Should attempt one cancel');
    assert.strictEqual(syncCalls, 1, 'Fallback cancel should trigger a fresh open-order sync');
    assert.deepStrictEqual(syncPayload, [], 'Fallback sync should use the refetched open-order snapshot');
    assert.strictEqual(syncSource, 'cancelOrder', 'Fallback sync should preserve cancelOrder source');
    assert.strictEqual(manager.accountTotals.sellFree, 11, 'Fallback sync should still release unmatched funds');
    console.log('✅ Regression 1b passed: verifiedAfterFailure cancel refetches open orders before sync');
}

async function testSkipUpdateWhenSlotAlreadyMapped() {
    const manager = createManager({ accountTotals: { sellFree: 100, buyFree: 100 } });

    manager.orders.set('sell-1', {
        id: 'sell-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        price: 0.5,
        size: 10,
        orderId: null,
    });

    let addToChainFreeCalls = 0;
    manager.accountant = {
        addToChainFree: () => { addToChainFreeCalls++; },
    };

    // Simulate race: by the time update executes, slot was already mapped by recovery sync.
    const mapGet = manager.orders.get.bind(manager.orders);
    manager.orders.get = (id) => {
        const slot = mapGet(id);
        if (!slot) return slot;
        return { ...slot, state: ORDER_STATES.ACTIVE, orderId: '1.7.20' };
    };

    let updateCalls = 0;
    const chainOrders = {
        updateOrder: async () => { updateCalls++; },
        buildUpdateOrderOp: async () => ({
            op: {
                op_name: 'limit_order_update',
                op_data: {
                    fee: { amount: 0, asset_id: '1.3.0' }
                }
            }
        }),
        executeBatch: async () => { updateCalls++; return { success: true, operation_results: [] }; },
        cancelOrder: async () => {},
        createOrder: async () => [],
        readOpenOrders: async () => [],
    };

    const chainOpenOrders = [
        {
            id: '1.7.20',
            sell_price: {
                base: { amount: 1000000, asset_id: '1.3.1' },
                quote: { amount: 500000, asset_id: '1.3.0' },
            },
            for_sale: 1000000,
        },
    ];

    await reconcileGridOrders({
        manager,
        config: { activeOrders: { sell: 1, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    assert.strictEqual(updateCalls, 0, 'Should skip update batch when slot already mapped to same chain order');
    assert.strictEqual(addToChainFreeCalls, 0, 'Should not addToChainFree when update is skipped');
    console.log('✅ Regression 2 passed: stale-slot update is skipped without double credit');
}

async function testAttemptResumeAwaitsStoreGrid() {
    const gridPath = require.resolve('../modules/order/grid');
    const realGrid = require(gridPath);
    const gridStub = Object.assign({}, realGrid);
    const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');
    setCachedModule(gridPath, gridStub);

    try {
        gridStub.loadGrid = async () => {};

        const manager = {
            orders: new Map([
                ['slot-1', { id: 'slot-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, orderId: '1.7.77' }],
            ]),
            synchronizeWithChain: async () => {},
        };

        let storeResolved = false;
        const storeGrid = async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
            storeResolved = true;
        };

        const result = await attemptResumePersistedGridByPriceMatch({
            manager,
            persistedGrid: [{ id: 'slot-1', state: ORDER_STATES.ACTIVE, orderId: '1.7.77' }],
            chainOpenOrders: [{ id: '1.7.77' }],
            logger: { log: () => {} },
            storeGrid,
        });

        assert.strictEqual(result.resumed, true, 'Price match resume should succeed');
        assert.strictEqual(storeResolved, true, 'Resume should await async storeGrid completion');
        console.log('✅ Regression 3 passed: attemptResume waits for async storeGrid');
    } finally {
        restoreCachedModule(gridPath, null);
    }
}

async function testPhase3CancelsStaleSurplusUntrackedByGrid() {
    // Regression: after Phase 2 updates+creates settle, any stale chain order
    // that exceeds the target per side AND is not tracked by the grid must be
    // cancelled in Phase 3 — even when matchedOnGrid was 0 on a fresh grid.

    const orders = new Map();
    const chainOpenOrders: any[] = [];
    let orderCounter = 100;
    const sellPrices = [1010, 1020, 1030, 1040, 1050, 1060, 1070];

    // 7 sell orders on chain, target is 5 → 2 surplus
    for (const price of sellPrices) {
        const id = `1.7.${orderCounter++}`;
        chainOpenOrders.push({
            id,
            sell_price: { base: { amount: 100000, asset_id: '1.3.1' }, quote: { amount: Math.round(price * 100), asset_id: '1.3.0' } },
            for_sale: 100000,
        });
    }

    // Grid has 5 virtual sell slots (no orderIds) — simulates a fresh grid
    // where the first 5 chain orders will be updated to these slots.
    // The 6th and 7th chain orders are untracked surplus.
    for (let i = 0; i < 5; i++) {
        const price = 1000 + i * 10;
        orders.set(`sell-${i}`, { id: `sell-${i}`, price, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, orderId: '', size: 100 });
    }

    // Track which chain order IDs are returned by readOpenOrders at Phase 3.
    // We return ALL original chain orders (the surplus ones haven't been
    // cancelled yet from the perspective of the re-fetch).
    let cancelCalls: string[] = [];
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async (account: any, privateKey: any, orderId: string) => { cancelCalls.push(orderId); },
        createOrder: async () => [],
        readOpenOrders: async () => chainOpenOrders,
    };

    const manager = {
        orders,
        logger: { log: () => {} },
        assets: { assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' }, assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' } },
        accountTotals: { sellFree: 10000, buyFree: 10000 },
        getOrdersByTypeAndState: (type: any, state: any) => Array.from(orders.values()).filter((o: any) => o && o.type === type && o.state === state),
        _gridLock: { acquire: async (fn: any) => await fn() },
        synchronizeWithChain: async () => {},
        _applySync: async (data: any) => {
            // Simulate Phase 2 finalization: register the orderId on the grid slot
            // so Phase 3 can distinguish tracked vs untracked orders.
            if (data && data.gridOrderId && data.chainOrderId) {
                const slot = orders.get(data.gridOrderId);
                if (slot) {
                    orders.set(data.gridOrderId, { ...slot, orderId: data.chainOrderId, state: ORDER_STATES.ACTIVE });
                }
            }
        },
        _applyOrderUpdate: async (order: any) => { orders.set(order.id, order); return true; },
        accountant: { addToChainFree: async () => {} },
    };

    await reconcileGridOrders({
        manager,
        config: { activeOrders: { sell: 5, buy: 0 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    // After Phase 2, 5 chain orders get updated to grid slots via _applySync
    // (the mock now registers chainOrderId on the grid slot). Phase 3 re-fetches
    // chain orders and must cancel exactly the 2 untracked surplus (7 > 5).
    // The guard at matchedOnGrid=0 prevents Phase 1 from cancelling these;
    // testNoExcessCancelWhenMatchedOnGridIsZero covers that separately.
    assert.strictEqual(cancelCalls.length, 2,
        `Phase 3 should cancel exactly 2 untracked surplus sells (got ${cancelCalls.length})`);

    // Collect orderIds that Phase 2 registered on grid slots (tracked orders).
    const gridTrackedIds = new Set<string>();
    for (const order of manager.orders.values()) {
        if (order.orderId) gridTrackedIds.add(order.orderId);
    }

    // The grid should track at most 5 orderIds (the target for sells).
    // It may track fewer if some Phase 2 updates were skipped, but must
    // not exceed the target.
    assert.ok(gridTrackedIds.size <= 5,
        `Grid should track at most 5 orderIds (got ${gridTrackedIds.size})`);

    // Every cancelled order must be UNTRACKED by the grid — Phase 3 must
    // NOT cancel orders that were successfully updated in Phase 2.
    for (const cid of cancelCalls) {
        assert.ok(!gridTrackedIds.has(cid),
            `Phase 3 must NOT cancel tracked order ${cid}`);
    }

    // Every cancelled order must be a real chain order.
    const chainOrderIdSet = new Set(chainOpenOrders.map((o: any) => o.id));
    for (const cid of cancelCalls) {
        assert.ok(chainOrderIdSet.has(cid),
            `Cancelled order ${cid} must be one of the chain open orders`);
    }

    console.log('✅ Regression 6 passed: Phase 3 cancels stale surplus orders untracked by grid');
}

async function testNoExcessCancelWhenMatchedOnGridIsZero() {
    // Regression: When matchedOnGrid === 0 (fresh grid, all VIRTUAL),
    // _reconcileStartupSide must NOT cancel chain orders as "excess".
    // Previously cancelCount = chainCount - targetCount would cancel
    // legitimate orders that simply hadn't been matched yet.

    const orders = new Map();
    const chainOpenOrders = [];
    const buyPrices = [1000, 990, 980, 970, 960];
    const sellPrices = [1010, 1020, 1030, 1040, 1050];
    let orderCounter = 1;

    for (const price of sellPrices) {
        const id = `1.7.${orderCounter++}`;
        chainOpenOrders.push({
            id,
            sell_price: { base: { amount: 100000, asset_id: '1.3.1' }, quote: { amount: Math.round(price * 100), asset_id: '1.3.0' } },
            for_sale: 100000,
        });
    }
    for (const price of buyPrices) {
        const id = `1.7.${orderCounter++}`;
        chainOpenOrders.push({
            id,
            sell_price: { base: { amount: Math.round(price * 100), asset_id: '1.3.0' }, quote: { amount: 100000, asset_id: '1.3.1' } },
            for_sale: 100000,
        });
    }

    // Populate grid with VIRTUAL orders (no orderIds) — simulates fresh grid.
    for (let i = 0; i < 10; i++) {
        const price = 950 + i * 10;
        orders.set(`slot-${i}`, { id: `slot-${i}`, price, type: i < 5 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, orderId: '', size: 100 });
    }

    let cancelCalls = 0;
    const chainOrders = {
        updateOrder: async () => {},
        buildUpdateOrderOp: async () => ({ op: { op_name: 'limit_order_update', op_data: { fee: { amount: 0, asset_id: '1.3.0' } } } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        cancelOrder: async () => { cancelCalls++; },
        createOrder: async () => [],
        readOpenOrders: async () => [],
    };

    const manager = {
        orders,
        logger: { log: () => {} },
        assets: { assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' }, assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' } },
        accountTotals: { sellFree: 10000, buyFree: 10000 },
        getOrdersByTypeAndState: (type, state) => Array.from(orders.values()).filter(o => o && o.type === type && o.state === state),
        _gridLock: { acquire: async (fn) => await fn() },
        synchronizeWithChain: async () => {},
        _applySync: async () => {},
        _applyOrderUpdate: async (order) => { orders.set(order.id, order); return true; },
        accountant: { addToChainFree: async () => {} },
    };

    await reconcileGridOrders({
        manager,
        config: { activeOrders: { sell: 5, buy: 5 } },
        account: 'acct',
        privateKey: 'pk',
        chainOrders,
        chainOpenOrders,
    });

    // matchedOnGrid was 0 (all VIRTUAL), so cancelCount should be 0.
    // Any cancel call means the guard failed.
    assert.strictEqual(cancelCalls, 0,
        `matchedOnGrid=0 must not issue excess cancels (got ${cancelCalls})`);
    console.log('✅ Regression 5 passed: no excess cancel when matchedOnGrid is zero (fresh grid)');
}

(async () => {
    console.log('\n========== STARTUP RECONCILE REGRESSION TESTS ==========\n');
    await testUnmatchedCancelReleasesFundsAndHandlesNullEntries();
    await testVerifiedAfterFailureRefetchesOpenOrders();
    await testSkipUpdateWhenSlotAlreadyMapped();
    await testAttemptResumeAwaitsStoreGrid();
    await testNoExcessCancelWhenMatchedOnGridIsZero();
    await testPhase3CancelsStaleSurplusUntrackedByGrid();
    console.log('\n✅ Startup reconcile regression tests passed!\n');
})().catch((err) => {
    console.error('\n❌ STARTUP RECONCILE REGRESSION TEST FAILED:');
    console.error(err);
    process.exit(1);
});
