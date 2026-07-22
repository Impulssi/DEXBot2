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
    assert.strictEqual(syncOptions?.gridLockAlreadyHeld, true, 'Fallback sync should reuse the caller-held grid lock');
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

(async () => {
    console.log('\n========== STARTUP RECONCILE REGRESSION TESTS ==========\n');
    await testUnmatchedCancelReleasesFundsAndHandlesNullEntries();
    await testVerifiedAfterFailureRefetchesOpenOrders();
    await testSkipUpdateWhenSlotAlreadyMapped();
    await testAttemptResumeAwaitsStoreGrid();
    console.log('\n✅ Startup reconcile regression tests passed!\n');
})().catch((err) => {
    console.error('\n❌ STARTUP RECONCILE REGRESSION TEST FAILED:');
    console.error(err);
    process.exit(1);
});
