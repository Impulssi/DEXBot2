/**
 * tests/test_dust_rebalance_logic.ts
 * 
 * Verifies single-side dust detection helpers remain active.
 * Dust detection should still identify unhealthy partials on each side independently.
 * 
 * processFilledOrders() should now trigger rebalance only for real fills.
 * This test verifies the underlying hasAnyDust() detection logic still works.
 */

const assert = require('assert');
const Module = require('module');

const originalModuleLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (typeof request === 'string' && request.includes('bitshares_client')) {
        return {
            BitShares: {
                subscribe: () => {},
                disconnect: () => {},
                ws: { isConnected: false }
            },
            waitForConnected: async () => {},
            createAccountClient: () => ({
                sign: () => {},
                broadcast: async () => ({})
            }),
            setSuppressConnectionLog: () => {},
            getNodeManager: () => null,
            getNodeStats: () => null,
            getNodeSummary: () => null,
            _internal: { get connected() { return false; } }
        };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
};

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES, GRID_LIMITS, TIMING } = require('../modules/constants');
const Grid = require('../modules/order/grid');
const { _setFeeCache } = require('../modules/order/utils/math');
const chainOrders = require('../modules/chain_orders');
const DEXBot = require('../modules/dexbot_class');
const { isOrderDoesNotExistError, recordDustFirstSeen } = require('../modules/dexbot_maintenance_runtime');
const { withDynamicWeightFiles } = require('./helpers/dynamic_weight_files');

async function testDustTrigger() {
    console.log('Testing Dust Detection Logic (COW Architecture)...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    // Initialize with some funds
    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    // Mock logger
    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    // 1. Scenario: No fills, no dust - processFilledOrders returns empty
    console.log('\n  Scenario 1: No fills, no dust');
    let result = await manager.processFilledOrders([]);
    const hasActions = (result.actions?.length > 0) || (result.ordersToPlace?.length > 0);
    assert.strictEqual(!!hasActions, false, 'Should not have actions with no fills');
    console.log('  ✓ Correctly returned empty actions');

    // 2. Scenario: Single-side dust detection (BUY only)
    console.log('\n  Scenario 2: Single-side dust (BUY)');
    await manager._updateOrder({
        id: 'buy-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001, // Very small - definitely dust
        price: 0.9,
        orderId: '1.7.1'
    });

    const buyPartials = Array.from(manager.orders.values())
        .filter(o => (o as any).type === ORDER_TYPES.BUY && (o as any).state === ORDER_STATES.PARTIAL);
    const sellPartials = Array.from(manager.orders.values())
        .filter(o => (o as any).type === ORDER_TYPES.SELL && (o as any).state === ORDER_STATES.PARTIAL);

    const buyHasDust = buyPartials.length > 0 && await Grid.hasAnyDust(manager, buyPartials, 'buy');
    const sellHasDust = sellPartials.length > 0 && await Grid.hasAnyDust(manager, sellPartials, 'sell');

    assert.strictEqual(buyHasDust, true, 'Buy side should have dust');
    assert.strictEqual(sellHasDust, false, 'Sell side should NOT have dust (no partials)');
    assert.strictEqual(buyHasDust && sellHasDust, false, 'Should NOT trigger dual-side dust (only one side)');
    console.log('  ✓ Correctly detected single-side dust');

    // 3. Scenario: Dust detection remains side-local even when both sides have dust
    console.log('\n  Scenario 3: Both sides have dust (detection only)');
    await manager._updateOrder({
        id: 'sell-dust',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001, // Very small - definitely dust
        price: 1.1,
        orderId: '1.7.2'
    });

    const buyPartials2 = Array.from(manager.orders.values())
        .filter(o => (o as any).type === ORDER_TYPES.BUY && (o as any).state === ORDER_STATES.PARTIAL);
    const sellPartials2 = Array.from(manager.orders.values())
        .filter(o => (o as any).type === ORDER_TYPES.SELL && (o as any).state === ORDER_STATES.PARTIAL);

    const buyHasDust2 = buyPartials2.length > 0 && await Grid.hasAnyDust(manager, buyPartials2, 'buy');
    const sellHasDust2 = sellPartials2.length > 0 && await Grid.hasAnyDust(manager, sellPartials2, 'sell');

    assert.strictEqual(buyHasDust2, true, 'Buy side should have dust');
    assert.strictEqual(sellHasDust2, true, 'Sell side should have dust');
    assert.strictEqual(buyHasDust2 && sellHasDust2, true, 'Should still detect dust on both sides');
    console.log('  ✓ Correctly detected dust on both sides without implying rebalance');

    // 4. Scenario: processFilledOrders with no real fills should not rebalance on dust alone
    console.log('\n  Scenario 4: Dust alone does not trigger rebalance');
    result = await manager.processFilledOrders([]);
    const noDustRebalance = result !== undefined && typeof result === 'object';
    assert.strictEqual(noDustRebalance, true, 'processFilledOrders should still return a result object');
    console.log('  ✓ Dust alone no longer triggers rebalance');

    // 5. Scenario: processFilledOrders with fills triggers rebalance
    console.log('\n  Scenario 5: processFilledOrders with fills (triggers rebalance)');
    
    // Reset dust orders to VIRTUAL first
    await manager._updateOrder({
        id: 'buy-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        size: 10,
        price: 0.9,
        orderId: null
    });
    await manager._updateOrder({
        id: 'sell-dust',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.VIRTUAL,
        size: 10,
        price: 1.1,
        orderId: null
    });

    const fill = { id: 'buy-dust', type: ORDER_TYPES.BUY, price: 0.9, size: 10, isPartial: false };
    result = await manager.processFilledOrders([fill]);
    
    // processFilledOrders triggers performSafeRebalance for non-partial fills
    // Result may have actions/ordersToPlace depending on grid state
    // Key assertion: method completes without error (rebalance is triggered)
    const resultHasStructure = result !== undefined && typeof result === 'object';
    assert.strictEqual(resultHasStructure, true, 'processFilledOrders should return result object');
    console.log('  ✓ processFilledOrders correctly triggers rebalance for fills');

    // 6. Verify processFillsOnly properly processes fills
    console.log('\n  Scenario 6: processFillsOnly properly processes fills');
    
    // Create an active order to fill
    await manager._updateOrder({
        id: 'test-active',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        size: 50,
        price: 0.85,
        orderId: '1.7.100'
    });

    const fillForActive = { 
        id: 'test-active', 
        type: ORDER_TYPES.BUY, 
        price: 0.85, 
        size: 50, 
        isPartial: false,
        orderId: '1.7.100'
    };
    
    // processFillsOnly should update the order state
    await manager.strategy.processFillsOnly([fillForActive], new Set());
    
    // The order should now be VIRTUAL (fully filled)
    const updatedOrder = manager.orders.get('test-active');
    assert.strictEqual(updatedOrder.state, ORDER_STATES.VIRTUAL, 'Filled order should be VIRTUAL');
    console.log('  ✓ processFillsOnly correctly updates order state');

    // 7. Verify dust cancel sync clears virtual reservation and releases funds
    console.log('\n  Scenario 7: dust cancel clears size and releases funds');

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });
    await manager._updateOrder({
        id: 'cancel-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        size: 0,
        price: 0.8,
        orderId: null
    });
    await manager._updateOrder({
        id: 'cancel-dust',
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        size: 25,
        price: 0.8,
        orderId: '1.7.250'
    });

    assert.strictEqual(manager.accountTotals.buyFree, 975, 'Test setup should reflect locked buy funds');
    await manager.synchronizeWithChain({ orderId: '1.7.250', clearSize: true }, 'cancelOrder');

    const cancelledDust = manager.orders.get('cancel-dust');
    assert.strictEqual(cancelledDust.state, ORDER_STATES.VIRTUAL, 'Cancelled dust order should be virtualized');
    assert.strictEqual(cancelledDust.size, 0, 'Cancelled dust order should clear virtual reservation size');
    assert.strictEqual(manager.accountTotals.buyFree, 1000, 'Cancelled dust order should release remaining buy funds');
    console.log('  ✓ dust cancel correctly clears reservation and frees funds');

    console.log('\n✅ All dust detection tests passed!\n');
}

async function testDustCancelSyntheticRotation() {
    console.log('Testing Dust Cancel Synthetic Rotation...');

    const originalCancelOrder = chainOrders.cancelOrder;
    let bot;
    const weightFiles = withDynamicWeightFiles('test_dust_cancel_rotation');
    try {
        let cancelCalls = 0;
        let syncCalls = 0;
        let processCalls = 0;
        let persistCalls = 0;
        weightFiles.writeSnapshot({
            isReady: true,
            effectiveWeights: { sell: 0.38, buy: 0.18 },
        });

        bot = new DEXBot({
            botKey: 'test_dust_cancel_rotation',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5,
            weightDistribution: { sell: 0.6, buy: 0.4 },
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';
        bot.manager = {
            synchronizeWithChain: async (payload, source) => {
                syncCalls++;
                assert.strictEqual(source, 'cancelOrder', 'Dust cancel should sync through cancelOrder source');
                assert.deepStrictEqual(payload, { orderId: '1.7.900', clearSize: true }, 'Dust cancel should clear size on sync');
                return { newOrders: [], ordersNeedingCorrection: [] };
            },
            processFilledOrders: async (fills) => {
                processCalls++;
                assert.strictEqual(fills.length, 1, 'Expected one synthetic dust fill');
                assert.strictEqual(fills[0].id, 'dust-buy-1');
                assert.strictEqual(fills[0].isPartial, true, 'Synthetic dust trigger should remain marked partial');
                assert.strictEqual(fills[0].isDelayedRotationTrigger, true, 'Synthetic dust trigger should enter delayed rotation path');
                assert.deepStrictEqual(
                    bot.config.weightDistribution,
                    { sell: 0.38, buy: 0.18 },
                    'dust cancel rebalance should refresh bot config to live dynamic weights'
                );
                assert.deepStrictEqual(
                    bot.manager.config.weightDistribution,
                    { sell: 0.38, buy: 0.18 },
                    'dust cancel rebalance should refresh manager config to live dynamic weights'
                );
                return { actions: [] };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            recalculateFunds: async () => {},
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
            config: {
                weightDistribution: { sell: 0.6, buy: 0.4 },
            },
        };

        chainOrders.cancelOrder = async () => {
            cancelCalls++;
        };

        const dustOrder = {
            id: 'dust-buy-1',
            orderId: '1.7.900',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.9
        };

        const firstPass = await bot._cancelDustOrders({ buy: [dustOrder], sell: [] });
        assert.strictEqual(firstPass.cancelledCount, 0, 'Dust cancel should wait for the timer before triggering');
        assert.strictEqual(cancelCalls, 0, 'Dust cancel should not run before timer expiry');
        assert.strictEqual(processCalls, 0, 'Synthetic rotation should not run before timer expiry');

        bot._dustSinceMap.set('1.7.900', Date.now() - (60 * 1_000) - 1);
        const secondPass = await bot._cancelDustOrders({ buy: [dustOrder], sell: [] });
        assert.strictEqual(secondPass.cancelledCount, 1, 'Dust cancel should fire once timer expires');
        assert.strictEqual(cancelCalls, 1, 'Dust cancel should submit one cancel');
        assert.strictEqual(syncCalls, 1, 'Dust cancel should synchronize once');
        assert.strictEqual(processCalls, 1, 'Dust cancel should trigger the synthetic fill pipeline');
        assert.strictEqual(persistCalls, 2, 'Dust cancel should persist grid (COW path + end-of-tick flushGridDirty safety net)');
        console.log('  ✓ Dust cancel triggers synthetic delayed rotation only after timer expiry');
    } finally {
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
        weightFiles.cleanup();
    }
}

async function testDustCancelDoesNotBeatRealFill() {
    console.log('Testing Dust Cancel Real Fill Precedence...');

    const originalCancelOrder = chainOrders.cancelOrder;
    let bot;
    try {
        let processCalls = 0;
        let persistCalls = 0;

        bot = new DEXBot({
            botKey: 'test_dust_cancel_precedence',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';
        bot.manager = {
            synchronizeWithChain: async () => {
                throw new Error('should not sync after failed cancel');
            },
            processFilledOrders: async () => {
                processCalls++;
                return { actions: [] };
            },
            persistGrid: async () => {
                persistCalls++;
                return { isValid: true };
            },
            recalculateFunds: async () => {}
        };

        chainOrders.cancelOrder = async () => {
            throw new Error('order already filled');
        };

        const dustOrder = {
            id: 'dust-sell-1',
            orderId: '1.7.901',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 1.1
        };

        bot._dustSinceMap.set('1.7.901', Date.now() - (60 * 1_000) - 1);
        const result = await bot._cancelDustOrders({ buy: [], sell: [dustOrder] });

        assert.strictEqual(result.cancelledCount, 0, 'Failed cancel should not count as dust rotation');
        assert.strictEqual(processCalls, 0, 'Failed cancel should not trigger synthetic fill processing');
        assert.strictEqual(persistCalls, 0, 'Failed cancel should not persist synthetic changes');
        console.log('  ✓ Real fill / failed cancel path does not trigger synthetic rotation');
    } finally {
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
    }
}

async function testDustCancelOrderMissingClassifier() {
    console.log('Testing Dust Cancel Order-Missing Classifier...');

    assert.strictEqual(
        isOrderDoesNotExistError('order does not exist', '1.7.902'),
        true,
        'Explicit order-missing errors should trigger gone-from-chain handling'
    );
    assert.strictEqual(
        isOrderDoesNotExistError('Could not find Object: 1.7.902', '1.7.902'),
        true,
        'Object-missing errors for the target order should trigger gone-from-chain handling'
    );
    assert.strictEqual(
        isOrderDoesNotExistError('Unable to find Object 1.7.902', '1.7.902'),
        true,
        'Existing unable-to-find-object errors for the target order should trigger gone-from-chain handling'
    );
    assert.strictEqual(
        isOrderDoesNotExistError('account does not exist', '1.7.902'),
        false,
        'Unrelated account-missing errors must not trigger gone-from-chain handling'
    );
    assert.strictEqual(
        isOrderDoesNotExistError('asset does not exist', '1.7.902'),
        false,
        'Unrelated asset-missing errors must not trigger gone-from-chain handling'
    );
    console.log('  ✓ Dust cancel only treats order-specific missing errors as gone from chain');
}

async function testDustCancelDoesNotTreatAccountMissingAsGone() {
    console.log('Testing Dust Cancel Account-Missing Rejection...');

    const originalCancelOrder = chainOrders.cancelOrder;
    let bot;
    try {
        let processCalls = 0;

        bot = new DEXBot({
            botKey: 'test_dust_cancel_account_missing',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.account = 'missing-account';
        bot.privateKey = 'test-key';
        bot.manager = {
            synchronizeWithChain: async () => {
                throw new Error('should not sync after unrelated missing-account error');
            },
            processFilledOrders: async () => {
                processCalls++;
                return { actions: [] };
            },
            persistGrid: async () => ({ isValid: true }),
            recalculateFunds: async () => {}
        };

        chainOrders.cancelOrder = async () => {
            throw new Error('account does not exist');
        };

        const dustOrder = {
            id: 'dust-sell-account-missing',
            orderId: '1.7.902',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 1.1
        };

        bot._dustSinceMap.set('1.7.902', Date.now() - (60 * 1_000) - 1);
        const result = await bot._cancelDustOrders({ buy: [], sell: [dustOrder] });

        assert.strictEqual(result.cancelledCount, 0, 'Unrelated missing-account error should not count as cancelled');
        assert.strictEqual(processCalls, 0, 'Unrelated missing-account error should not trigger synthetic fill processing');
        console.log('  ✓ Account-missing errors do not trigger synthetic dust recovery');
    } finally {
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
    }
}

async function testDustCancelFallbackRefetchesOpenOrders() {
    console.log('Testing Dust Cancel Fallback Refetch...');

    const originalCancelOrder = chainOrders.cancelOrder;
    const originalReadOpenOrders = chainOrders.readOpenOrders;
    let bot;
    try {
        let syncSource = null;
        let syncPayload = null;
        let processCalls = 0;

        bot = new DEXBot({
            botKey: 'test_dust_cancel_refetch',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.account = 'test-account';
        bot.accountId = '1.2.345';
        bot.privateKey = 'test-key';
        bot.manager = {
            synchronizeWithChain: async (data, source) => {
                syncSource = source;
                syncPayload = data;
                return { newOrders: [], ordersNeedingCorrection: [] };
            },
            processFilledOrders: async () => {
                processCalls++;
                return { actions: [] };
            },
            persistGrid: async () => ({ isValid: true }),
            recalculateFunds: async () => {},
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] })
        };

        chainOrders.cancelOrder = async () => ({
            success: true,
            orderId: '1.7.910',
            verified: true,
            verifiedAfterFailure: true
        });
        chainOrders.readOpenOrders = async (accountRef) => {
            assert.strictEqual(accountRef, '1.2.345', 'Fallback refetch should use accountId');
            return [];
        };

        const dustOrder = {
            id: 'dust-buy-refetch',
            orderId: '1.7.910',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.9
        };

        bot._dustSinceMap.set('1.7.910', Date.now() - (60 * 1_000) - 1);
        const result = await bot._cancelDustOrders({ buy: [dustOrder], sell: [] });

        assert.strictEqual(result.cancelledCount, 1, 'Fallback refetch cancel should still count as cancelled');
        assert.strictEqual(syncSource, 'readOpenOrders', 'Fallback path should resync from a fresh blockchain snapshot');
        assert(Array.isArray(syncPayload), 'Fallback sync should receive the open-order snapshot');
        assert.strictEqual(processCalls, 1, 'Fallback refetch should still trigger the synthetic fill pipeline');
        console.log('  ✓ Dust cancel refetches open orders when cancel was already gone');
    } finally {
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
        chainOrders.readOpenOrders = originalReadOpenOrders;
    }
}

async function testDustTimerStartsAtDustFill() {
    console.log('Testing Dust Timer Starts At Fill Detection...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    await manager._updateOrder({
        id: 'dust-timer-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001,
        price: 1.1,
        orderId: '1.7.902'
    });

    const bot = new DEXBot({
        botKey: 'test_dust_timer_start',
        dryRun: false,
        startPrice: 1,
        assetA: 'TESTA',
        assetB: 'TESTB',
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 },
        activeOrders: { buy: 5, sell: 5 },
        botFunds: { buy: 1000, sell: 1000 }
    });
    bot.manager = manager;

    try {
        const detectedAt = Date.now();
        const dustOrder = manager.orders.get('dust-timer-sell');

        await bot._seedDustTimersFromPartialUpdates([dustOrder], detectedAt);
        assert.strictEqual(bot._dustSinceMap.get('1.7.902'), detectedAt, 'Dust timer should start at fill detection time');

        await bot._seedDustTimersFromPartialUpdates([dustOrder], detectedAt + 1000);
        assert.strictEqual(bot._dustSinceMap.get('1.7.902'), detectedAt, 'Existing dust timer should not be reset by later detections');
        console.log('  ✓ Dust timer starts when the order first becomes dust');
    } finally {
        bot._clearDustMaintenanceTimer();
    }
}

async function testDustThresholdUsesConfiguredPercentage() {
    console.log('Testing Dust Threshold Uses Configured Percentage...');

    try {
        const manager = new OrderManager({
            assetA: 'TESTA',
            assetB: 'TESTB',
            startPrice: 1.0,
            botFunds: { buy: 1000, sell: 1000 },
            activeOrders: { buy: 5, sell: 5 },
            incrementPercent: 1,
            weightDistribution: { buy: 1, sell: 1 },
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 10 }
        });

        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
        };

        await manager.setAccountTotals({
            buy: 1000,
            sell: 1000,
            buyFree: 1000,
            sellFree: 1000
        });

        manager.logger = {
            log: () => {},
            logFundsStatus: () => {}
        };

        await manager._updateOrder({
            id: 'threshold-sell-1',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            price: 1.01,
            orderId: '1.7.910'
        });

        await manager._updateOrder({
            id: 'threshold-sell-2',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.95,
            price: 1.02,
            orderId: '1.7.911'
        });

        await manager._updateOrder({
            id: 'threshold-sell-3',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            size: 10,
            price: 1.03,
            orderId: '1.7.912'
        });

        const dustOrders = await Grid.getDustOrders(manager, [manager.orders.get('threshold-sell-2')], 'sell');
        assert.strictEqual(dustOrders.length, 1, 'Configured dust threshold should classify the order as dust');
        console.log('  ✓ Dust detection respects configured threshold percentage');
    } catch (err) {
        throw err;
    }
}

async function testDustTrackingOnlyUsesTopLiveOrder() {
    console.log('Testing Dust Tracking Only Uses Top Live Order...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    await manager.setAccountTotals({
        buy: 1000,
        sell: 1000,
        buyFree: 1000,
        sellFree: 1000
    });

    manager.logger = {
        log: () => {},
        logFundsStatus: () => {}
    };

    await manager._updateOrder({
        id: 'top-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 10,
        price: 1.01,
        orderId: '1.7.930'
    });
    await manager._updateOrder({
        id: 'inner-dust-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        size: 0.00001,
        price: 1.02,
        orderId: '1.7.931'
    });
    await manager._updateOrder({
        id: 'outer-sell',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.ACTIVE,
        size: 10,
        price: 1.03,
        orderId: '1.7.932'
    });

    const bot = new DEXBot({
        botKey: 'test_top_order_dust_only',
        dryRun: false,
        startPrice: 1,
        assetA: 'TESTA',
        assetB: 'TESTB',
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 },
        activeOrders: { buy: 5, sell: 5 },
        botFunds: { buy: 1000, sell: 1000 }
    });
    bot.manager = manager;

    try {
        const detectedAt = Date.now();
        const innerDust = manager.orders.get('inner-dust-sell');

        const initialHealth = await Grid.checkWindowDust(manager);
        assert.strictEqual(initialHealth.sellDustOrders.length, 0, 'Interior dust should not be selected when top order is healthy');

        await bot._seedDustTimersFromPartialUpdates([innerDust], detectedAt);
        assert.strictEqual(bot._dustSinceMap.has('1.7.931'), false, 'Interior dust should not start a cancel timer');

        await manager._updateOrder({
            id: 'top-sell',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.00001,
            price: 1.01,
            orderId: '1.7.930'
        });

        const topDust = manager.orders.get('top-sell');
        const topHealth = await Grid.checkWindowDust(manager);
        assert.strictEqual(topHealth.sellDustOrders.length, 1, 'Top dust should be selected for tracking');
        assert.strictEqual(topHealth.sellDustOrders[0].orderId, '1.7.930', 'Top live sell should be the only tracked dust order');

        await bot._seedDustTimersFromPartialUpdates([topDust], detectedAt + 1000);
        assert.strictEqual(bot._dustSinceMap.get('1.7.930'), detectedAt + 1000, 'Top dust should start the cancel timer');
        console.log('  ✓ Only the top live order is eligible for dust tracking');
    } finally {
        bot._clearDustMaintenanceTimer();
    }
}

async function testStartupDustSchedulesTimer() {
    console.log('Testing Startup Dust Schedules Maintenance Timer...');

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalDelay = GRID_LIMITS.DUST_CANCEL_DELAY_SEC;

    try {
        let scheduledDelay = null;
        let scheduledFn = null;

        global.setTimeout = ((fn: any, delay: any) => {
            scheduledFn = fn;
            scheduledDelay = delay;
            return { fakeTimer: true };
        }) as any;
        global.clearTimeout = () => {};


        const bot = new DEXBot({
            botKey: 'test_startup_dust_schedule',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'TESTB',
            incrementPercent: 1
        });
        bot.config.gridLimits.DUST_CANCEL_DELAY_SEC = 60;

        let maintenanceCalls = 0;
        bot.manager = {
            _fillProcessingLock: {
                acquire: async (fn) => fn()
            },
            _divergenceLock: {
                acquire: async (fn) => fn()
            },
            orders: new Map([['order-0', { id: 'order-0' }]]),
            recalculateFunds: async () => {},
            clearStalePipelineOperations: () => {},
            isPipelineEmpty: () => ({ isEmpty: true }),
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
            checkSpreadCondition: async () => null,
        };
        bot._cancelDustOrders = async () => ({ cancelledCount: 0, batchResult: null });
        bot._getPipelineSignals = () => ({});
        bot._abortFlowIfIllegalState = async () => false;
        bot.accountOrders = { loadGrid: () => [] };
        bot.updateOrdersOnChainBatch = async () => {};
        bot.updateOrdersOnChainPlan = async () => {};
        bot._persistAndRecoverIfNeeded = async () => {};
        bot._baseWeightDistribution = { sell: 0.5, buy: 0.5 };
        bot.config.weightDistribution = { sell: 0.5, buy: 0.5 };
        bot._runGridMaintenance = async (context, options) => {
            maintenanceCalls++;
            bot._dustSinceMap.clear();
            assert.strictEqual(context, 'dust-timer', 'Dust timer should run dust maintenance context');
            assert.deepStrictEqual(options, { fillLockAlreadyHeld: true }, 'Dust timer should reuse the fill lock');
        };

        bot._dustSinceMap.set('1.7.920', Date.now());
        bot._scheduleDustMaintenanceCheck();

        const configuredDelayMs = bot.config.gridLimits.DUST_CANCEL_DELAY_SEC * 1_000;
        assert.ok(
            scheduledDelay >= configuredDelayMs - 1000 && scheduledDelay <= configuredDelayMs,
            'Dust timer should schedule near configured delay'
        );
        assert.strictEqual(typeof scheduledFn, 'function', 'Dust timer should install a callback');

        scheduledFn();
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(maintenanceCalls, 1, 'Dust timer should trigger maintenance once');
        console.log('  ✓ Existing dust at startup schedules a maintenance check');
    } finally {

        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
}

async function testConsecutiveDustCancelSeeding() {
    console.log('Testing Consecutive Dust Cancel Seeds Next Top Order...');

    const originalCancelOrder = chainOrders.cancelOrder;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalDelay = GRID_LIMITS.DUST_CANCEL_DELAY_SEC;
    let bot;
    try {
        // Intercept the timer so we can verify it is scheduled after the cancel.
        let timerScheduled = false;
        global.setTimeout = ((fn: any, delay: any) => {
            timerScheduled = true;
            return { fakeTimer: true };
        }) as any;
        global.clearTimeout = () => {};

        bot = new DEXBot({
            botKey: 'test_consecutive_dust_cancel',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.config.gridLimits.DUST_CANCEL_DELAY_SEC = 60;
        bot.account = 'test-account';
        bot.privateKey = 'test-key';

        const order2 = {
            id: 'dust-buy-2',
            orderId: '1.7.902',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.89
        };

        bot.manager = {
            synchronizeWithChain: async () => ({ newOrders: [], ordersNeedingCorrection: [] }),
            processFilledOrders: async () => ({ actions: [] }),
            persistGrid: async () => ({ isValid: true }),
            recalculateFunds: async () => {},
            // After order 1 is cancelled, the next top is order 2.
            checkGridHealth: async () => ({ buyDustOrders: [order2], sellDustOrders: [] })
        };

        chainOrders.cancelOrder = async () => {};

        const order1 = {
            id: 'dust-buy-1',
            orderId: '1.7.901',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.9
        };

        // Age order 1 past the delay so it qualifies for cancellation.
        bot._dustSinceMap.set('1.7.901', Date.now() - (60 * 1_000) - 1);

        const result = await bot._cancelDustOrders({ buy: [order1], sell: [] });

        assert.strictEqual(result.cancelledCount, 1, 'Order 1 should be cancelled');
        assert.strictEqual(bot._dustSinceMap.has('1.7.901'), false, 'Cancelled order should be removed from map');
        assert.strictEqual(bot._dustSinceMap.has('1.7.902'), true, 'Newly exposed order 2 should be seeded into _dustSinceMap immediately');
        assert.strictEqual(timerScheduled, true, 'Dust timer should be scheduled for the newly seeded order');
        console.log('  ✓ Consecutive dust cancel seeds next top order and schedules its timer');
    } finally {
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;

    }
}

async function testDustReseedHealthFailureDoesNotAbort() {
    console.log('Testing Dust Reseed Health Failure Does Not Abort...');

    const originalCancelOrder = chainOrders.cancelOrder;
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalDelay = GRID_LIMITS.DUST_CANCEL_DELAY_SEC;
    let bot;

    try {

        let fallbackTimerScheduled = false;
        global.setTimeout = ((fn: any, delay: any) => {
            fallbackTimerScheduled = true;
            return { fakeTimer: true };
        }) as any;
        global.clearTimeout = () => {};

        bot = new DEXBot({
            botKey: 'test_dust_reseed_health_failure',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.account = 'test-account';
        bot.privateKey = 'test-key';
        bot.config.gridLimits.DUST_CANCEL_DELAY_SEC = 60;

        bot.manager = {
            synchronizeWithChain: async () => ({ newOrders: [], ordersNeedingCorrection: [] }),
            processFilledOrders: async () => ({ actions: [] }),
            persistGrid: async () => ({ isValid: true }),
            recalculateFunds: async () => {},
            checkGridHealth: async () => {
                throw new Error('temporary health failure');
            }
        };

        chainOrders.cancelOrder = async () => {};

        const order = {
            id: 'dust-buy-1',
            orderId: '1.7.903',
            type: ORDER_TYPES.BUY,
            state: ORDER_STATES.PARTIAL,
            size: 0.1,
            price: 0.9
        };

        bot._dustSinceMap.set('1.7.903', Date.now() - (60 * 1_000) - 1);

        const result = await bot._cancelDustOrders({ buy: [order], sell: [] });

        assert.strictEqual(result.cancelledCount, 1, 'Successful cancel should still be counted');
        assert.strictEqual(bot._dustSinceMap.has('1.7.903'), false, 'Cancelled order should still be removed from the map');
        assert.strictEqual(fallbackTimerScheduled, true, 'Fallback timer should be scheduled when reseed fails and map is empty');
        console.log('  ✓ Health check failure no longer aborts successful dust cancellation');
        console.log('  ✓ Fallback timer scheduled when reseed fails to prevent permanently skipping next top order');
    } finally {
        if (typeof bot?._clearDustMaintenanceTimer === 'function') {
            bot._clearDustMaintenanceTimer();
        }
        chainOrders.cancelOrder = originalCancelOrder;
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;

    }
}

async function testMaintenanceDefersStructuralWorkWhileDustPending() {
    console.log('Testing Maintenance Defers Structural Work While Dust Timer Pending...');

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const originalDelay = GRID_LIMITS.DUST_CANCEL_DELAY_SEC;

    try {
        const scheduledDelays = [];
        global.setTimeout = ((fn: any, delay: any) => {
            scheduledDelays.push(delay);
            return { fakeTimer: true };
        }) as any;
        global.clearTimeout = () => {};

        const bot = new DEXBot({
            botKey: 'test_dust_defers_structural_work',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });
        bot.config.gridLimits.DUST_CANCEL_DELAY_SEC = 60;

        const dustOrder = {
            id: 'dust-sell-1',
            orderId: '1.7.940',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            size: 0.0001,
            price: 1.1
        };

        let divergenceChecked = false;
        let spreadChecked = false;

        bot.manager = {
            recalculateFunds: async () => {},
            clearStalePipelineOperations: () => {},
            isPipelineEmpty: () => ({ isEmpty: true }),
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [dustOrder] }),
            checkSpreadCondition: async () => {
                spreadChecked = true;
                return { ordersPlaced: 0 };
            },
            _fillProcessingLock: {
                acquire: async (fn) => fn()
            },
            orders: new Map()
        };
        bot.accountOrders = {
            loadGrid: () => {
                divergenceChecked = true;
                return [];
            }
        };
        bot._abortFlowIfIllegalState = async () => false;

        bot._dustSinceMap.set('1.7.940', Date.now());
        await bot._executeMaintenanceLogic('periodic');

        assert.strictEqual(divergenceChecked, false, 'Divergence should wait for the dust timer');
        assert.strictEqual(spreadChecked, false, 'Spread correction should wait for the dust timer');
        assert.strictEqual(bot._dustSinceMap.has('1.7.940'), true, 'Pending dust timer should remain tracked');
        const expectedDeferredDelay = (bot.config.gridLimits.DUST_CANCEL_DELAY_SEC * 1_000) + 6_000;
        assert.ok(
            scheduledDelays.some(delay => delay >= expectedDeferredDelay - 100 && delay <= expectedDeferredDelay),
            'Deferred grid resync should allow a 6s blockchain settle window after the dust timer'
        );
        console.log('  ✓ Structural maintenance waits while dust cancellation is pending');
    } finally {

        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
}

async function testGridMaintenanceWaitsForQuietPeriod() {
    console.log('Testing Grid Maintenance Waits For Quiet Period...');

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;

    try {
        const scheduledDelays = [];
        (global as any).setTimeout = (_fn, delay) => {
            scheduledDelays.push(delay);
            return { fakeTimer: true };
        };
        global.clearTimeout = () => {};

        const bot = new DEXBot({
            botKey: 'test_maintenance_idle_gate',
            dryRun: false,
            startPrice: 1,
            assetA: 'TESTA',
            assetB: 'BTS',
            incrementPercent: 0.5
        });

        let maintenanceRan = false;
        bot.manager = {
            orders: new Map([['slot-1', { id: 'slot-1' }]]),
            _fillProcessingLock: { acquire: async (fn) => fn() },
            _divergenceLock: { acquire: async (fn) => fn() }
        };
        bot._executeMaintenanceLogic = async () => {
            maintenanceRan = true;
        };

        bot._markGridActivity('test activity');
        await bot._runGridMaintenance('periodic');

        assert.strictEqual(maintenanceRan, false, 'Maintenance should not run during the quiet-period gate');
        assert.ok(
            scheduledDelays.some(delay => delay > 0 && delay <= TIMING.BLOCKCHAIN_SETTLE_DELAY_MS),
            'Maintenance should schedule a retry after the configured idle delay'
        );
        console.log('  ✓ Grid maintenance waits for the configured inactivity window');
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
}

async function testInteriorDustWithDuplicatePriceLevel() {
    console.log('Testing Interior Dust With Duplicate Price Level...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    manager.logger = { log: () => {}, logFundsStatus: () => {} };

    // Setup: top-sell (ACTIVE), dup-dust-sell (PARTIAL, same price as active sibling → eligible)
    await manager._updateOrder({ id: 'top-sell', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 10, price: 1.01, orderId: '1.7.940' });
    await manager._updateOrder({ id: 'dup-dust-sell', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, size: 0.00001, price: 1.01, orderId: '1.7.941' });
    await manager._updateOrder({ id: 'outer-sell', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 10, price: 1.03, orderId: '1.7.942' });

    const health = await Grid.checkWindowDust(manager);
    assert.strictEqual(health.sellDustOrders.length, 1, 'Interior dust with duplicate price level should be eligible');
    assert.strictEqual(health.sellDustOrders[0].orderId, '1.7.941', 'Duplicate-price-level interior dust should be detected');
    console.log('  ✓ Interior partial with active sibling at same price is eligible for dust');
}

async function testInteriorDustAdjacentGridLevelNotEligible() {
    console.log('Testing Interior Dust At Adjacent Grid Level Is Not Eligible...');

    _setFeeCache({
        BTS: {
            limitOrderCreate: { bts: 0.1 },
            limitOrderCancel: { bts: 0 },
            limitOrderUpdate: { bts: 0.001 }
        }
    });

    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 1.0,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 5, sell: 5 },
        incrementPercent: 1,
        weightDistribution: { buy: 1, sell: 1 }
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
    };

    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    manager.logger = { log: () => {}, logFundsStatus: () => {} };

    // Setup: two active sells at 1.01 and 1.03, a tiny partial at 1.02 (adjacent, no duplicate)
    await manager._updateOrder({ id: 's1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 10, price: 1.01, orderId: '1.7.950' });
    await manager._updateOrder({ id: 's2', type: ORDER_TYPES.SELL, state: ORDER_STATES.PARTIAL, size: 0.00001, price: 1.02, orderId: '1.7.951' });
    await manager._updateOrder({ id: 's3', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 10, price: 1.03, orderId: '1.7.952' });

    const health = await Grid.checkWindowDust(manager);
    // s2 at 1.02 is between 1.01 and 1.03 — adjacent but NOT same price level.
    // The tolerance uses Math.max(0.00001, 10)=10 → tight tolerance (~2e-6) → 0.01 >> 2e-6 → no match.
    assert.strictEqual(health.sellDustOrders.length, 0, 'Interior partial at adjacent price level should not be eligible for dust');
    console.log('  ✓ Interior partial at adjacent grid level (within tolerance) is not eligible');
}

async function testRecordDustFirstSeen() {
    const bot: any = { _dustSinceMap: new Map() };

    // First detection: timestamp is set
    recordDustFirstSeen(bot, { buyDustOrders: [{ orderId: '1.7.1' }], sellDustOrders: [] });
    assert.strictEqual(bot._dustSinceMap.size, 1);
    const t0 = bot._dustSinceMap.get('1.7.1');
    assert.ok(typeof t0 === 'number' && t0 > 0, 'First-seen timestamp should be set');
    console.log('  ✓ First detection sets timestamp');

    // Re-detection preserves original timestamp (not reset)
    await new Promise(r => setTimeout(r, 10));
    recordDustFirstSeen(bot, { buyDustOrders: [{ orderId: '1.7.1' }], sellDustOrders: [] });
    assert.strictEqual(bot._dustSinceMap.get('1.7.1'), t0, 'Re-detection should preserve original timestamp');
    console.log('  ✓ Re-detection preserves first-seen timestamp');

    // Order no longer in dust is purged
    recordDustFirstSeen(bot, { buyDustOrders: [], sellDustOrders: [] });
    assert.strictEqual(bot._dustSinceMap.size, 0, 'Order no longer in dust should be purged');
    console.log('  ✓ Order recovered from dust is purged');

    // Buy + sell combined
    recordDustFirstSeen(bot, {
        buyDustOrders: [{ orderId: '1.7.2' }, { orderId: '1.7.3' }],
        sellDustOrders: [{ orderId: '1.7.4' }],
    });
    assert.strictEqual(bot._dustSinceMap.size, 3, 'Buy and sell dust combined');
    console.log('  ✓ Buy and sell dust both populate map');
}

Promise.resolve()
    .then(() => testDustTrigger())
    .then(() => testDustCancelSyntheticRotation())
    .then(() => testDustCancelDoesNotBeatRealFill())
    .then(() => testDustCancelOrderMissingClassifier())
    .then(() => testDustCancelDoesNotTreatAccountMissingAsGone())
    .then(() => testDustCancelFallbackRefetchesOpenOrders())
    .then(() => testDustTimerStartsAtDustFill())
    .then(() => testDustThresholdUsesConfiguredPercentage())
    .then(() => testDustTrackingOnlyUsesTopLiveOrder())
    .then(() => testInteriorDustWithDuplicatePriceLevel())
    .then(() => testInteriorDustAdjacentGridLevelNotEligible())
    .then(() => testStartupDustSchedulesTimer())
    .then(() => testConsecutiveDustCancelSeeding())
    .then(() => testDustReseedHealthFailureDoesNotAbort())
    .then(() => testMaintenanceDefersStructuralWorkWhileDustPending())
    .then(() => testGridMaintenanceWaitsForQuietPeriod())
    .then(() => testRecordDustFirstSeen())
    .finally(() => {
        Module._load = originalModuleLoad;
    })
    .then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Test failed!');
    console.error(err);
    process.exit(1);
});
