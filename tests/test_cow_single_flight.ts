/**
 * tests/test_cow_single_flight.ts
 *
 * Verifies the COW single-flight broadcast guard added to
 * updateOrdersOnChainBatchCOW (dexbot_cow_runtime.ts):
 *
 *  - While one COW batch is broadcasting (bot._cowBroadcastInFlight = true),
 *    a second batch defers instead of broadcasting concurrently.
 *  - The deferred batch proceeds only after the in-flight batch settles, so
 *    two broadcasts never overlap (overlap causes the later working-grid
 *    commit to be refused on a base-version mismatch, followed by a snapshot
 *    reload that can drop a placed order and produce an orphan fill).
 *  - The flag is cleared in the outer finally so a stuck broadcast cannot
 *    permanently block the pipeline (the SINGLE_FLIGHT_MAX_WAIT_MS cap is a
 *    further safety valve, not exercised here).
 */

const assert = require('assert');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const { installChainOrdersStub } = require('./helpers/chain_orders_stub');
const { chainOrders } = installChainOrdersStub();
const DEXBot = require('../modules/dexbot_class').default;
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES, COW_ACTIONS } = require('../modules/constants');

let testsComplete = false;

process.on('unhandledRejection', (reason) => {
    if (testsComplete) return;
    console.error('Test failed:', reason);
    process.exit(1);
});

const { ensureFeeCache } = require('./helpers/fee_cache_init');
ensureFeeCache();

function makeBot() {
    const bot = new DEXBot({
        botKey: 'test_cow_single_flight',
        dryRun: false,
        startPrice: 100,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });
    const logEntries = [];
    const orders = new Map();
    const manager = {
        _gridVersion: 0,
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.121', precision: 5, symbol: 'USD' }
        },
        orders,
        logger: {
            log: (msg, level) => { logEntries.push({ msg: String(msg), level }); },
            logFundsStatus: () => {}
        },
        _logEntries: logEntries,
        lockOrders: () => {},
        unlockOrders: () => {},
        _setRebalanceState: () => {},
        _resetRebalanceStateToDepth: () => {},
        startBroadcasting: () => {},
        stopBroadcasting: () => {},
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        _commitWorkingGrid: async () => true,
        _clearWorkingGridRef: () => {},
        _clearPendingBroadcasts: () => {},
        _persistenceWarning: undefined,
        _recoveryState: { attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0, structuralResyncRequested: false },
        _pendingBroadcasts: new Map(),
        persistGrid: async () => ({ isValid: true, skipped: false }),
        getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
        synchronizeWithChain: async () => {},
        accountant: {
            updateOptimisticFreeBalance: async () => {}
        },
        applyGridUpdateBatch: async () => {},
    };
    bot.manager = manager;
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';
    return { bot, manager, logEntries };
}

function makeCreateAction(bot, slotId, chainIdSuffix) {
    const plannedOrder = {
        id: slotId,
        type: ORDER_TYPES.SELL,
        price: 100,
        size: 10,
        state: ORDER_STATES.VIRTUAL,
        orderId: ''
    };
    const workingGrid = new WorkingGrid(bot.manager.orders, { baseVersion: bot.manager._gridVersion ?? 0 });
    workingGrid.set(slotId, { ...plannedOrder });
    return {
        cowResult: {
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions: [{ type: COW_ACTIONS.CREATE, id: slotId, order: plannedOrder }]
        },
        plannedOrder
    };
}

async function testSingleFlightDefersSecondBroadcast() {
    console.log('\n[COW-SINGLE-FLIGHT-001] second batch defers while a broadcast is in flight...');
    const { bot, logEntries } = makeBot();

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    let broadcastCalls = 0;
    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve as any; });

    chainOrders.buildCreateOrderOp = async (_account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => ({
        op: {
            op_name: 'limit_order_create',
            op_data: {
                amount_to_sell: { amount: amountToSell, asset_id: sellAssetId },
                min_to_receive: { amount: minToReceive, asset_id: receiveAssetId }
            }
        },
        finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
    });

    chainOrders.executeBatch = async (_account, _key, ops) => {
        broadcastCalls++;
        if (broadcastCalls === 1) {
            await firstBlocked;
        }
        return {
            success: true,
            operation_results: ops.map(() => [1, `1.7.57353000${broadcastCalls}`])
        };
    };

    try {
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'flag starts clear');

        const first = makeCreateAction(bot, 'slot-sf-1');
        const second = makeCreateAction(bot, 'slot-sf-2');

        const p1 = bot._updateOrdersOnChainBatchCOW(first.cowResult);
        // Wait until the first broadcast is actually on the wire (flag set).
        const deadline = Date.now() + 10000;
        while (broadcastCalls < 1 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
        }
        assert.strictEqual(broadcastCalls, 1, 'first batch must broadcast');
        assert.strictEqual(bot._cowBroadcastInFlight, true, 'flag must be set while first broadcast is in flight');

        // Start the second batch while the first is still broadcasting.
        const p2 = bot._updateOrdersOnChainBatchCOW(second.cowResult);

        // Give the second batch time to reach the single-flight wait.
        await new Promise((r) => setTimeout(r, 150));
        assert.strictEqual(broadcastCalls, 1, 'second batch must NOT broadcast while first is in flight');
        const deferLog = logEntries.find((l) => l.msg.includes('already in flight') || l.msg.includes('deferring this batch'));
        assert.ok(deferLog, 'single-flight defer log must be emitted');

        // Release the first broadcast; the second must then proceed.
        releaseFirst!();
        const results = await Promise.all([p1, p2]);

        assert.strictEqual(broadcastCalls, 2, 'both batches must eventually broadcast exactly once each');
        assert.strictEqual(results[0].executed, true, 'first batch executes');
        assert.strictEqual(results[1].executed, true, 'second batch executes after the first settles');
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'flag must be cleared after both batches settle');
    } finally {
        releaseFirst?.();
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('✓ COW-SINGLE-FLIGHT-001 passed');
}

async function testFlagClearedOnFailedBroadcast() {
    console.log('\n[COW-SINGLE-FLIGHT-002] flag is cleared when a broadcast fails...');
    const { bot } = makeBot();

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    chainOrders.buildCreateOrderOp = async (_account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => ({
        op: {
            op_name: 'limit_order_create',
            op_data: {
                amount_to_sell: { amount: amountToSell, asset_id: sellAssetId },
                min_to_receive: { amount: minToReceive, asset_id: receiveAssetId }
            }
        },
        finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
    });
    chainOrders.executeBatch = async () => {
        throw new Error('network down');
    };

    try {
        bot._handleBatchHardAbort = async (err: any) => { throw err; };
        const { cowResult } = makeCreateAction(bot, 'slot-sf-fail');
        await assert.rejects(
            () => bot._updateOrdersOnChainBatchCOW(cowResult),
            /network down/
        );
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'flag must be cleared after a failed broadcast');
    } finally {
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('✓ COW-SINGLE-FLIGHT-002 passed');
}

async function testPreBroadcastRaceRecheck() {
    console.log('\n[COW-SINGLE-FLIGHT-003] pre-broadcast recheck catches planning-phase race...');
    const { bot, logEntries } = makeBot();

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;

    let broadcastCalls = 0;
    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve as any; });

    // First buildCreateOrderOp call (the slower-started batch) is delayed so
    // the other batch can pass the entry single-flight check (flag still
    // clear), plan, and claim the broadcast slot before the first batch
    // reaches its own pre-broadcast check.
    let buildCalls = 0;
    chainOrders.buildCreateOrderOp = async (_account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        buildCalls++;
        if (buildCalls === 1) {
            await new Promise((r) => setTimeout(r, 150));
        }
        return {
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: amountToSell, asset_id: sellAssetId },
                    min_to_receive: { amount: minToReceive, asset_id: receiveAssetId }
                }
            },
            finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
        };
    };

    chainOrders.executeBatch = async (_account, _key, ops) => {
        broadcastCalls++;
        if (broadcastCalls === 1) {
            await firstBlocked;
        }
        return {
            success: true,
            operation_results: ops.map(() => [1, `1.7.57353001${broadcastCalls}`])
        };
    };

    try {
        const slow = makeCreateAction(bot, 'slot-sf-slow');
        const fast = makeCreateAction(bot, 'slot-sf-fast');

        // Start the slow batch first: it passes the entry check (flag clear)
        // and then blocks inside buildCreateOrderOp.
        const pSlow = bot._updateOrdersOnChainBatchCOW(slow.cowResult);
        // Let the slow batch get past its entry check and into build.
        await new Promise((r) => setTimeout(r, 30));
        // Start the fast batch: it also passes the entry check (flag still
        // clear), finishes planning, and claims the broadcast slot first.
        const pFast = bot._updateOrdersOnChainBatchCOW(fast.cowResult);

        // Wait for the fast batch to claim the slot and start broadcasting.
        const deadline = Date.now() + 10000;
        while (broadcastCalls < 1 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
        }
        assert.strictEqual(broadcastCalls, 1, 'only one broadcast may be in flight during the planning race');
        assert.strictEqual(bot._cowBroadcastInFlight, true, 'slot must be claimed by the fast batch');

        // The slow batch finishes building and must now wait at the
        // pre-broadcast recheck instead of broadcasting alongside.
        await new Promise((r) => setTimeout(r, 250));
        assert.strictEqual(broadcastCalls, 1, 'slow batch must NOT broadcast while fast batch is in flight');
        const preBroadcastLog = logEntries.find((l) => l.msg.includes('pre-broadcast') && l.msg.includes('already in flight'));
        assert.ok(preBroadcastLog, 'pre-broadcast defer log must be emitted for the racing batch');

        // Release the fast batch; the slow batch then proceeds.
        releaseFirst!();
        const results = await Promise.all([pFast, pSlow]);

        assert.strictEqual(broadcastCalls, 2, 'both batches must eventually broadcast exactly once each');
        assert.strictEqual(results[0].executed, true, 'fast batch executes');
        assert.strictEqual(results[1].executed, true, 'slow batch executes after the fast batch settles');
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'flag must be cleared after both settle');
    } finally {
        releaseFirst?.();
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
    }
    console.log('✓ COW-SINGLE-FLIGHT-003 passed');
}

async function testEarlyReturnDoesNotClearAnotherBatchSlot() {
    console.log('\n[COW-SINGLE-FLIGHT-004] a batch that early-returns after planning must not clear another batch\'s in-flight slot...');
    const { bot } = makeBot();

    const originalBuildCreate = chainOrders.buildCreateOrderOp;
    const originalExecuteBatch = chainOrders.executeBatch;
    const originalGetSnapshot = bot.manager.getChainFundsSnapshot;

    let broadcastCalls = 0;
    let releaseFirst: (() => void) | null = null;
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve as any; });

    // The first (slower) batch blocks inside build so the second batch can
    // pass the entry single-flight check while the flag is still clear.
    let buildCalls = 0;
    chainOrders.buildCreateOrderOp = async (_account, amountToSell, sellAssetId, minToReceive, receiveAssetId) => {
        buildCalls++;
        if (buildCalls === 1) {
            await new Promise((r) => setTimeout(r, 150));
        }
        return {
            op: {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: amountToSell, asset_id: sellAssetId },
                    min_to_receive: { amount: minToReceive, asset_id: receiveAssetId }
                }
            },
            finalInts: { sell: amountToSell, receive: minToReceive, sellAssetId, receiveAssetId }
        };
    };

    chainOrders.executeBatch = async (_account, _key, ops) => {
        broadcastCalls++;
        if (broadcastCalls === 1) {
            await firstBlocked;
        }
        return {
            success: true,
            operation_results: ops.map(() => [1, '1.7.57353004'])
        };
    };

    try {
        const slow = makeCreateAction(bot, 'slot-sf-004-slow');
        const fast = makeCreateAction(bot, 'slot-sf-004-fast');

        // Batch B (slow) passes the entry check (flag clear) and blocks in build.
        const pSlow = bot._updateOrdersOnChainBatchCOW(slow.cowResult);
        await new Promise((r) => setTimeout(r, 30));

        // Batch A (fast) also passes the entry check (flag still clear), claims
        // the broadcast slot, and starts broadcasting (blocked on the wire).
        const pFast = bot._updateOrdersOnChainBatchCOW(fast.cowResult);
        const deadline = Date.now() + 10000;
        while (broadcastCalls < 1 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
        }
        assert.strictEqual(broadcastCalls, 1, 'only A may be broadcasting');
        assert.strictEqual(bot._cowBroadcastInFlight, true, 'A must hold the broadcast slot');

        // Force B's fund validation to fail so B early-returns at the
        // pre-broadcast validation instead of claiming the slot.
        bot.manager.getChainFundsSnapshot = () => ({ chainFreeSell: 0, chainFreeBuy: 0 });

        // B resumes, validates funds (fails), and returns without claiming.
        const bResult = await pSlow;
        assert.strictEqual(bResult.executed, false, 'B must early-return on fund validation failure');
        assert.strictEqual(broadcastCalls, 1, 'B must never broadcast');
        assert.strictEqual(
            bot._cowBroadcastInFlight,
            true,
            'B must NOT clear A\'s in-flight slot on its early return (ownership guard)'
        );

        // Restore A's snapshot, then let A settle normally and clear its own slot.
        bot.manager.getChainFundsSnapshot = originalGetSnapshot;
        releaseFirst!();
        const aResult = await pFast;
        assert.strictEqual(aResult.executed, true, 'A must complete its broadcast');
        assert.strictEqual(bot._cowBroadcastInFlight, false, 'A clears the slot it owns');
    } finally {
        releaseFirst?.();
        chainOrders.buildCreateOrderOp = originalBuildCreate;
        chainOrders.executeBatch = originalExecuteBatch;
        bot.manager.getChainFundsSnapshot = originalGetSnapshot;
    }
    console.log('✓ COW-SINGLE-FLIGHT-004 passed');
}

async function main() {
    await testSingleFlightDefersSecondBroadcast();
    await testFlagClearedOnFailedBroadcast();
    await testPreBroadcastRaceRecheck();
    await testEarlyReturnDoesNotClearAnotherBatchSlot();
    testsComplete = true;
    console.log('\n✓ All COW single-flight tests passed!');
}

main().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
});
