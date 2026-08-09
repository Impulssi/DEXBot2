const assert = require('assert');

const { installChainOrdersStub } = require('./helpers/chain_orders_stub');
const { chainOrders } = installChainOrdersStub();
const DEXBot = require('../modules/dexbot_class').default;
const { OrderManager } = require('../modules/order').default;
const { ORDER_STATES, ORDER_TYPES, TIMING, DAEMON_CODES } = require('../modules/constants');
const { buildFillKey } = require('../modules/order/utils/order');
const {
    ProcessedFillStore,
    PROCESSED_FILL_PERSISTENCE_MODES
} = require('../modules/order/processed_fill_store');

async function createBotFixture(botKey, options = {}) {
    const persistedFills = [];
    const persistedFillBatches = [];
    const bot = new DEXBot({
        botKey,
        dryRun: false,
        startPrice: 1,
        assetA: 'TEST',
        assetB: 'BTS',
        incrementPercent: 0.5
    });

    bot.accountOrders = {
        loadProcessedFills() {
            return new Map();
        },
        async updateProcessedFillsBatch(fills) {
            const entries = fills instanceof Map ? Array.from(fills.entries()) : [];
            if ((options as any).failProcessedFillWrites) {
                throw new Error((options as any).failProcessedFillWrites);
            }
            persistedFillBatches.push(entries);
            for (const [fillKey, timestamp] of entries) {
                persistedFills.push({ fillKey, timestamp });
            }
        },
        // No-op for persistGridSnapshot() — this test spies on processed-fill
        // persistence only, and a missing method logs persistence-failure noise.
        storeMasterGrid() {
            return undefined;
        }
    };

    bot.manager = new OrderManager({
        market: 'TEST/BTS',
        assetA: 'TEST',
        assetB: 'BTS',
        startPrice: 1
    });
    bot.manager.accountOrders = bot.accountOrders;
    bot.manager.assets = {
        assetA: { id: '1.3.0', symbol: 'TEST', precision: 5 },
        assetB: { id: '1.3.1', symbol: 'BTS', precision: 5 }
    };
    await bot.manager.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
    bot.manager.finishBootstrap();
    bot._wireProcessedFillTracking();

    return { bot, persistedFills, persistedFillBatches };
}

function buildFill(fillId) {
    return {
        block_num: 777,
        id: fillId,
        op: [4, {
            order_id: '1.7.424242',
            pays: { asset_id: '1.3.1', amount: 100000 },
            receives: { asset_id: '1.3.0', amount: 250000 },
            is_maker: true
        }]
    };
}

async function runTests() {
    console.log('Running Fill Replay Guard Tests...');

    console.log(' - Testing fills are deferred while order batch pipeline is active...');
    {
        const { bot } = await createBotFixture('test_fill_replay_defer_batch_active');
        const fill = buildFill('1.11.776');
        const sellBefore = bot.manager.accountTotals.sell;

        bot._batchInFlight = 1;
        bot._incomingFillQueue.push(fill);
        await bot._consumeFillQueue({ getFillProcessingMode: () => 'history', buildCancelOrderOp: async () => ({}) });

        assert.strictEqual(bot._incomingFillQueue.length, 1, 'Active batch must leave queued fills untouched');
        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore, 'Deferred fill must not credit proceeds yet');

        bot._batchInFlight = 0;
        await bot._consumeFillQueue({ getFillProcessingMode: () => 'history', buildCancelOrderOp: async () => ({}) });

        assert.strictEqual(bot._incomingFillQueue.length, 0, 'Queued fill should drain after batch clears');
        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore + 2.5, 'Deferred fill should credit proceeds after batch clears');
    }

    console.log(' - Testing bootstrap orphan fill persists accepted key and blocks delayed replay...');
    {
        const { bot, persistedFills } = await createBotFixture('test_fill_replay_bootstrap');
        const fill = buildFill('1.11.777');
        const fillKey = buildFillKey(fill);
        const sellBefore = bot.manager.accountTotals.sell;

        bot._incomingFillQueue.push(fill);
        await bot._processFillsWithBootstrapMode({});
        await bot._flushProcessedFillPersistence('test');

        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore + 2.5, 'Bootstrap orphan fill should credit proceeds once');
        assert.strictEqual(bot._recentlyProcessedFills.has(fillKey), true, 'Bootstrap path should register processed fill key');
        assert.strictEqual(persistedFills.length, 1, 'Bootstrap path should persist accepted fill key once flushed');

        bot._recentlyProcessedFills.set(fillKey, Date.now() - (TIMING.FILL_DEDUPE_WINDOW_MS + 1000));
        bot._incomingFillQueue.push(fill);
        await bot._processFillsWithBootstrapMode({});
        await bot._flushProcessedFillPersistence('test');

        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore + 2.5, 'Delayed bootstrap replay must not double-credit');
        assert.strictEqual(persistedFills.length, 1, 'Duplicate bootstrap replay should not persist a second record');
    }

    console.log(' - Testing orphan replay loaded from persisted tracker stays blocked after restart window...');
    {
        const { bot, persistedFills } = await createBotFixture('test_fill_replay_orphan');
        const fill = buildFill('1.11.778');
        const fillKey = buildFillKey(fill);
        const sellBefore = bot.manager.accountTotals.sell;

        bot._recentlyProcessedFills.set(fillKey, Date.now() - (TIMING.FILL_DEDUPE_WINDOW_MS + 1000));
        bot._incomingFillQueue.push(fill);
        await bot._consumeFillQueue({ getFillProcessingMode: () => 'history', buildCancelOrderOp: async () => ({}) });

        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore, 'Replay from persisted tracker must not credit proceeds again');
        assert.strictEqual(persistedFills.length, 0, 'Persisted replay skip should not write another processed-fill record');
    }

    console.log(' - Testing orphan fill without history id still credits proceeds once in live processing...');
    {
        const { bot } = await createBotFixture('test_fill_replay_orphan_missing_id_live');
        const malformedFill = buildFill(undefined);
        delete malformedFill.id;
        const fallbackKey = bot._buildOrphanFillFallbackKey(malformedFill);
        const sellBefore = bot.manager.accountTotals.sell;
        let openOrdersSyncCalled = false;

        bot._incomingFillQueue.push(malformedFill);
        await bot._consumeFillQueue({
            getFillProcessingMode: () => 'history',
            buildCancelOrderOp: async () => ({}),
            readOpenOrders: async () => {
                openOrdersSyncCalled = true;
                return [];
            }
        });

        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore + 2.5, 'Missing-history orphan fill should still credit proceeds');
        assert.strictEqual(bot._recentlyProcessedFills.has(fallbackKey), true, 'Missing-history orphan fill should use fallback replay key');
        assert.strictEqual(openOrdersSyncCalled, false, 'Missing-history orphan fill should not rely on open-orders sync for proceeds-only accounting');

        bot._incomingFillQueue.push(malformedFill);
        await bot._consumeFillQueue({
            getFillProcessingMode: () => 'history',
            buildCancelOrderOp: async () => ({}),
            readOpenOrders: async () => {
                openOrdersSyncCalled = true;
                return [];
            }
        });

        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore + 2.5, 'Missing-history orphan replay must not double-credit');
    }

    console.log(' - Testing self-cancel guard only skips non-economic artifacts...');
    {
        const { bot } = await createBotFixture('test_fill_replay_self_cancel_economic');
        const fill = buildFill('1.11.779');
        const sellBefore = bot.manager.accountTotals.sell;

        bot._incomingFillQueue.push(fill);
        await bot._consumeFillQueue({
            getFillProcessingMode: () => 'history',
            buildCancelOrderOp: async () => ({}),
            wasRecentlyOwnCancelled: () => true
        });

        assert.strictEqual(
            bot.manager.accountTotals.sell,
            sellBefore + 2.5,
            'Recently canceled order id must not suppress a real fill_order with pays/receives data'
        );

        const artifact = {
            block_num: 778,
            id: '1.11.7791',
            op: [4, { order_id: '1.7.424242' }]
        };
        bot._incomingFillQueue.push(artifact);
        await bot._consumeFillQueue({
            getFillProcessingMode: () => 'history',
            buildCancelOrderOp: async () => ({}),
            wasRecentlyOwnCancelled: () => true
        });

        assert.strictEqual(
            bot.manager.accountTotals.sell,
            sellBefore + 2.5,
            'Non-economic self-cancel artifact should be skipped without crediting proceeds'
        );
    }

    console.log(' - Testing processed fill persistence flushes durably for each accepted fill...');
    {
        const { bot, persistedFills, persistedFillBatches } = await createBotFixture('test_fill_replay_batching');
        const fillA = buildFill('1.11.780');
        const fillB = buildFill('1.11.781');

        await bot.manager.accountant.processFillAccounting(fillA.op[1], buildFillKey(fillA));
        assert.strictEqual(persistedFills.length, 1, 'First fill should be durably persisted before processFillAccounting returns');

        await bot.manager.accountant.processFillAccounting(fillB.op[1], buildFillKey(fillB));
        assert.strictEqual(persistedFills.length, 2, 'Second fill should be durably persisted before processFillAccounting returns');
        assert.strictEqual(persistedFillBatches.length, 2, 'Each fill should trigger its own durable flush');
    }

    console.log(' - Testing each processFillAccounting call durably persists before returning...');
    {
        const { bot, persistedFills } = await createBotFixture('test_fill_replay_durable_each');
        const count = 5;

        for (let i = 0; i < count; i++) {
            const fill = buildFill(`1.11.${800 + i}`);
            await bot.manager.accountant.processFillAccounting(fill.op[1], buildFillKey(fill));
            assert.strictEqual(persistedFills.length, i + 1, `Fill ${i + 1} should be durably persisted before processFillAccounting returns`);
        }

        assert.strictEqual(bot._pendingProcessedFillWrites.size, 0, 'All pending writes should be drained after sequential fills');
    }

    console.log(' - Testing deferred fill persistence batches multiple accepted fills into one flush...');
    {
        const { bot, persistedFills, persistedFillBatches } = await createBotFixture('test_fill_replay_deferred_batch');
        const fillA = buildFill('1.11.790');
        const fillB = buildFill('1.11.791');

        const resultA = await bot._applyReplaySafeFillAccounting(fillA, fillA.op[1], {
            persistenceMode: PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
        });
        const resultB = await bot._applyReplaySafeFillAccounting(fillB, fillB.op[1], {
            persistenceMode: PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
        });

        assert.strictEqual(resultA.status, 'applied', 'First deferred fill should still apply accounting');
        assert.strictEqual(resultB.status, 'applied', 'Second deferred fill should still apply accounting');
        assert.strictEqual(persistedFills.length, 0, 'Deferred persistence should not write to disk before the batch flush');
        assert.strictEqual(bot._pendingProcessedFillWrites.size, 2, 'Deferred persistence should queue both fills in memory');

        await bot._flushProcessedFillPersistence('test-deferred-batch');

        assert.strictEqual(persistedFillBatches.length, 1, 'Deferred persistence should flush both fills in one batch');
        assert.strictEqual(persistedFillBatches[0].length, 2, 'Deferred batch flush should persist both queued fill keys together');
        assert.strictEqual(persistedFills.length, 2, 'Deferred batch flush should persist every queued fill');
        assert.strictEqual(bot._pendingProcessedFillWrites.size, 0, 'Deferred batch flush should drain pending writes');
    }

    console.log(' - Testing selected fill flush waits for an already in-flight batch...');
    {
        let releaseFlush;
        let flushStarted;
        const flushStartedPromise = new Promise(resolve => { flushStarted = resolve; });
        const releaseFlushPromise = new Promise(resolve => { releaseFlush = resolve; });
        const store = new ProcessedFillStore({ batchMs: 60000, batchSize: 100 });
        store.configure({
            botKey: 'test_fill_replay_selected_barrier',
            accountOrders: {
                async updateProcessedFillsBatch() {
                    flushStarted();
                    await releaseFlushPromise;
                }
            }
        });

        await store.persist('1.7.424242:777:1.11.7920', Date.now(), {
            mode: PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
        });
        const firstFlush = store.flush('slow-test-flush');
        await flushStartedPromise;

        let selectedFlushResolved = false;
        const selectedFlush = store.flushKeys(
            new Set(['1.7.424242:777:1.11.7920']),
            'selected-barrier'
        ).then(() => {
            selectedFlushResolved = true;
        });

        await Promise.resolve();
        assert.strictEqual(selectedFlushResolved, false, 'Selected flush should wait for the in-flight batch containing the key');

        releaseFlush();
        await firstFlush;
        await selectedFlush;
        assert.strictEqual(selectedFlushResolved, true, 'Selected flush should resolve after the in-flight batch completes');
    }

    console.log(' - Testing OrderManager wrapper forwards fill sync options...');
    {
        const { bot } = await createBotFixture('test_fill_replay_wrapper_forwarding');
        const fill = buildFill('1.11.7910');
        let receivedOptions = null;
        const originalSyncFromFillHistory = bot.manager.sync.syncFromFillHistory.bind(bot.manager.sync);

        bot.manager.sync.syncFromFillHistory = async (incomingFill, options) => {
            receivedOptions = options;
            return originalSyncFromFillHistory(incomingFill, options);
        };

        await bot.manager.syncFromFillHistory(fill, {
            persistenceMode: PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
        });

        assert.strictEqual(
            receivedOptions?.persistenceMode,
            PROCESSED_FILL_PERSISTENCE_MODES.BATCHED,
            'Manager wrapper should forward the fill sync persistence mode'
        );
    }

    console.log(' - Testing non-credential fill-cycle errors persist verified fills...');
    {
        const { bot, persistedFills } = await createBotFixture('test_fill_replay_generic_error');
        await bot.manager._updateOrder({
            id: 'slot-generic-error',
            orderId: '1.7.424242',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 1,
            price: 1,
            baseAmount: 1,
            quoteAmount: 1,
            rawOnChain: { for_sale: '100000' }
        });

        const fill = buildFill('1.11.7921');
        const fillKey = buildFillKey(fill);
        bot.manager.processFilledOrders = async () => {
            return { actions: [{ type: 'generic-error-test' }] };
        };
        bot._executeBatchIfNeeded = async () => {
            throw new Error('generic post-accounting failure');
        };

        bot._incomingFillQueue.push(fill);
        await bot._consumeFillQueue({
            getFillProcessingMode: () => 'history',
            buildCancelOrderOp: async () => ({})
        });

        assert.strictEqual(persistedFills.length, 1, 'Generic fill-cycle errors should durably record verified processed fills');
        assert.strictEqual(persistedFills[0].fillKey, fillKey, 'Persisted fill key should match the verified chain fill');
        assert.strictEqual(bot._pendingProcessedFillWrites.size, 0, 'Generic error flush should drain pending processed-fill writes');
        assert.strictEqual(bot.manager._gridPersistenceSuspendedReason, null, 'Generic errors should not suspend grid persistence as a credential outage');
    }

    console.log(' - Testing credential outage persists verified fills while guarding grid persistence...');
    {
        const { bot, persistedFills } = await createBotFixture('test_fill_replay_credential_outage');
        await bot.manager._updateOrder({
            id: 'slot-credential-outage',
            orderId: '1.7.424242',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 1,
            price: 1,
            baseAmount: 1,
            quoteAmount: 1,
            rawOnChain: { for_sale: '100000' }
        });

        const fill = buildFill('1.11.793');
        const fillKey = buildFillKey(fill);
        let processFilledOrdersCalls = 0;
        let recoverySyncCalls = 0;
        let recoveryMaintenanceCalls = 0;
        let persistAttemptsWhileSuspended = 0;
        const originalPersistGrid = bot.manager.persistGrid.bind(bot.manager);

        bot.manager.processFilledOrders = async (filledOrders) => {
            processFilledOrdersCalls += 1;
            assert.strictEqual(filledOrders.length, 1, 'Credential outage scenario should reach fill rebalance planning');
            return { actions: [{ type: 'credential-outage-test' }] };
        };
        bot.manager.persistGrid = async () => {
            const result = await originalPersistGrid();
            if (result?.suspended) {
                persistAttemptsWhileSuspended += 1;
            }
            return result;
        };
        bot._executeBatchIfNeeded = async () => {
            const err = new Error('Credential daemon unavailable before COW batch broadcast: ENOENT');
            (err as any).code = DAEMON_CODES.CREDENTIAL_DAEMON_UNAVAILABLE;
            throw err;
        };
        bot._triggerStateRecoverySync = async () => {
            recoverySyncCalls += 1;
        };
        bot._runGridMaintenance = async () => {
            recoveryMaintenanceCalls += 1;
        };

        bot._incomingFillQueue.push(fill);
        await bot._consumeFillQueue({
            getFillProcessingMode: () => 'history',
            buildCancelOrderOp: async () => ({})
        });

        assert.strictEqual(processFilledOrdersCalls, 1, 'Fill should be planned before credential preflight failure');
        assert.strictEqual(persistedFills.length, 1, 'Credential outage should durably record verified processed fill');
        assert.strictEqual(persistedFills[0].fillKey, fillKey, 'Persisted fill key should match the verified chain fill');
        assert.strictEqual(bot._pendingProcessedFillWrites.size, 0, 'Credential outage should drain pending processed-fill writes');
        assert.strictEqual(bot._credentialRecoveryNeeded, true, 'Credential outage should request recovery after re-unlock');
        assert.strictEqual(bot._recentlyProcessedFills.has(fillKey), true, 'Current process should still know the fill was applied in memory');
        assert.strictEqual(bot.manager._gridPersistenceSuspendedReason.includes('credential outage'), true, 'Credential outage should suspend grid persistence');

        await bot.manager.persistGrid();
        assert.strictEqual(persistAttemptsWhileSuspended, 1, 'Grid persistence should be skipped while credential recovery is pending');

        await bot._runCredentialRecoveryAfterDaemonRestored();

        assert.strictEqual(recoverySyncCalls, 1, 'Recovery should reconcile chain state after daemon restore');
        assert.strictEqual(recoveryMaintenanceCalls, 1, 'Recovery should run guarded grid maintenance after reconcile');
        assert.strictEqual(bot._credentialRecoveryNeeded, false, 'Successful recovery should clear the credential recovery flag');
        assert.strictEqual(bot.manager._gridPersistenceSuspendedReason, null, 'Successful recovery should resume grid persistence');
    }

    console.log(' - Testing immediate persistence failure rolls back accounting and tracker state...');
    {
        const { bot, persistedFills } = await createBotFixture('test_fill_replay_immediate_failure', {
            failProcessedFillWrites: 'disk write failed'
        });
        const fill = buildFill('1.11.792');
        const fillKey = buildFillKey(fill);
        const sellBefore = bot.manager.accountTotals.sell;

        await assert.rejects(
            bot.manager.accountant.processFillAccounting(fill.op[1], fillKey),
            /disk write failed/,
            'Immediate persistence failure should reject the fill accounting call'
        );

        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore, 'Immediate persistence failure must roll back credited proceeds');
        assert.strictEqual(bot._recentlyProcessedFills.has(fillKey), false, 'Immediate persistence failure must remove the processed fill key');
        assert.strictEqual(bot._pendingProcessedFillWrites.size, 0, 'Immediate persistence failure must clear queued retry state after rollback');
        assert.strictEqual(persistedFills.length, 0, 'Immediate persistence failure must not record a successful processed-fill write');
    }

    console.log(' - Testing duplicate partial-fill replay does not mutate order state after accounting dedupe...');
    {
        const { bot } = await createBotFixture('test_fill_replay_partial_state');
        await bot.manager._updateOrder({
            id: 'slot-1',
            orderId: '1.7.424242',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 10,
            price: 1,
            baseAmount: 10,
            quoteAmount: 10
        });

        const fill = buildFill('1.11.782');
        const fillKey = buildFillKey(fill);

        const firstResult = await bot.manager.syncFromFillHistory(fill);
        assert.strictEqual(firstResult.partialFill, true, 'First fill should update order state as a partial fill');
        assert.strictEqual(bot.manager.orders.get('slot-1').size, 9, 'First fill should reduce the tracked order size once');

        bot._recentlyProcessedFills.set(fillKey, Date.now() - (TIMING.FILL_DEDUPE_WINDOW_MS + 1000));
        const replayResult = await bot.manager.syncFromFillHistory(fill);

        assert.strictEqual(replayResult.filledOrders.length, 0, 'Duplicate replay should not emit a second filled order');
        assert.strictEqual(replayResult.updatedOrders.length, 0, 'Duplicate replay should not emit a second state update');
        assert.strictEqual(bot.manager.orders.get('slot-1').size, 9, 'Duplicate replay must not shrink the tracked order again');
    }

    console.log(' - Testing missing history id defers sync instead of applying unguarded fill accounting...');
    {
        const { bot } = await createBotFixture('test_fill_replay_missing_history_id');
        await bot.manager._updateOrder({
            id: 'slot-2',
            orderId: '1.7.424242',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 10,
            price: 1,
            baseAmount: 10,
            quoteAmount: 10
        });

        const malformedFill = buildFill(undefined);
        delete malformedFill.id;
        const sellBefore = bot.manager.accountTotals.sell;
        const result = await bot.manager.syncFromFillHistory(malformedFill);

        assert.strictEqual(result.requiresOpenOrdersSync, true, 'Missing history id should force open-orders fallback');
        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore, 'Missing history id must not apply optimistic fill accounting');
        assert.strictEqual(bot.manager.orders.get('slot-2').size, 10, 'Missing history id must not mutate tracked order state');
    }

    console.log(' - Testing bootstrap path falls back to open-orders sync when fill has no history id...');
    {
        const { bot } = await createBotFixture('test_fill_replay_bootstrap_fallback');
        await bot.manager._updateOrder({
            id: 'slot-3',
            orderId: '1.7.424242',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 10,
            price: 1,
            baseAmount: 10,
            quoteAmount: 10
        });

        const malformedFill = buildFill(undefined);
        delete malformedFill.id;
        bot._incomingFillQueue.push(malformedFill);

        let openOrdersSyncCalled = false;
        const origSyncFromOpenOrders = bot.manager.syncFromOpenOrders.bind(bot.manager);
        bot.manager.syncFromOpenOrders = async (orders) => {
            openOrdersSyncCalled = true;
            return origSyncFromOpenOrders(orders);
        };

        // chainOrders argument needs readOpenOrders
        const mockChainOrders = {
            readOpenOrders: async () => [],
            getFillProcessingMode: () => 'history'
        };
        await bot._processFillsWithBootstrapMode(mockChainOrders);

        assert.strictEqual(openOrdersSyncCalled, true, 'Bootstrap path should fall back to open-orders sync when history id is missing');
    }

    console.log(' - Testing bootstrap orphan fill without history id still credits proceeds once...');
    {
        const { bot } = await createBotFixture('test_fill_replay_bootstrap_orphan_missing_id');
        const malformedFill = buildFill(undefined);
        delete malformedFill.id;
        const fallbackKey = bot._buildOrphanFillFallbackKey(malformedFill);
        const sellBefore = bot.manager.accountTotals.sell;
        let openOrdersSyncCalled = false;

        bot._incomingFillQueue.push(malformedFill);
        await bot._processFillsWithBootstrapMode({
            readOpenOrders: async () => {
                openOrdersSyncCalled = true;
                return [];
            },
            getFillProcessingMode: () => 'history'
        });

        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore + 2.5, 'Bootstrap orphan without history id should still credit proceeds');
        assert.strictEqual(bot._recentlyProcessedFills.has(fallbackKey), true, 'Bootstrap orphan without history id should use fallback replay key');
        assert.strictEqual(openOrdersSyncCalled, false, 'Bootstrap orphan without history id should not rely on open-orders sync for proceeds-only accounting');

        bot._incomingFillQueue.push(malformedFill);
        await bot._processFillsWithBootstrapMode({
            readOpenOrders: async () => {
                openOrdersSyncCalled = true;
                return [];
            },
            getFillProcessingMode: () => 'history'
        });

        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore + 2.5, 'Bootstrap orphan replay without history id must not double-credit');
    }

    console.log(' - Testing post-reset path falls back to open-orders sync when fill has no history id...');
    {
        const { bot } = await createBotFixture('test_fill_replay_postreset_fallback');
        await bot.manager._updateOrder({
            id: 'slot-4',
            orderId: '1.7.424242',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 10,
            price: 1,
            baseAmount: 10,
            quoteAmount: 10
        });

        const malformedFill = buildFill(undefined);
        delete malformedFill.id;

        const fillOp = malformedFill.op[1];
        const sellBefore = bot.manager.accountTotals.sell;

        // Test _applyReplaySafeFillAccounting returns missing_key for fills without history id
        const result = await bot._applyReplaySafeFillAccounting(malformedFill, fillOp, {
            missingKeyMessage: (op) => `Missing fill history id for ${op.order_id}; deferring`,
        });

        assert.strictEqual(result.status, 'missing_key', 'Post-reset path should get missing_key status for fill without history id');
        assert.strictEqual(bot.manager.accountTotals.sell, sellBefore, 'Missing-key fill should not apply unguarded accounting');
    }

    console.log(' - Testing post-reset spread check is skipped when pre-spread sync finds unmatched chain orders...');
    {
        const { bot } = await createBotFixture('test_fill_replay_postreset_spread_guard');
        const originalListenForFills = chainOrders.listenForFills;
        const originalReadOpenOrders = chainOrders.readOpenOrders;
        const originalReadOpenOrdersWithMeta = chainOrders.readOpenOrdersWithMeta;

        let spreadChecks = 0;
        let readOpenOrdersCalls = 0;
        let setupCalls = 0;

        chainOrders.listenForFills = async () => async () => {};
        chainOrders.readOpenOrders = async () => {
            readOpenOrdersCalls++;
            return [{ id: '1.7.999999' }];
        };
        chainOrders.readOpenOrdersWithMeta = async () => {
            readOpenOrdersCalls++;
            return { orders: [{ id: '1.7.999999' }], truncated: false };
        };

        bot.accountId = '1.2.345';
        bot.account = { id: '1.2.345' };
        bot.privateKey = 'test-key';
        bot._handlePendingTriggerReset = async () => true;
        bot._setupTriggerFileDetection = async () => { setupCalls++; };
        bot._setupCreditRuntime = async () => {};
        bot._refreshAndSyncCreditRuntime = async () => {};
        bot._setupBlockchainFetchInterval = () => {};
        bot._setupCreditWatchdogInterval = () => {};
        bot._setupCredentialDaemonWatchdogInterval = () => {};
        bot._isOpenOrdersSyncLoopEnabled = () => false;
        bot._startOpenOrdersSyncLoop = () => {};
        bot._refreshDynamicWeightDistribution = () => null;
        bot.manager.synchronizeWithChain = async () => ({
            filledOrders: [],
            unmatchedChainOrders: [{ chainOrderId: '1.7.999999', type: ORDER_TYPES.BUY }],
        });
        bot.manager.checkSpreadCondition = async () => {
            spreadChecks++;
            return { ordersPlaced: 1 };
        };

        try {
            await bot._finishStartupSequence({
                persistedGrid: [],
                persistedBtsFeesOwed: 0,
                persistedBoundaryIdx: 0,
                persistedBtsBalance: null,
            });
        } finally {
            chainOrders.listenForFills = originalListenForFills;
            chainOrders.readOpenOrders = originalReadOpenOrders;
            chainOrders.readOpenOrdersWithMeta = originalReadOpenOrdersWithMeta;
        }

        assert.strictEqual(readOpenOrdersCalls, 1, 'Post-reset path should refresh open orders before spread check');
        assert.strictEqual(spreadChecks, 0, 'Unmatched chain orders should block post-reset spread correction');
        assert.strictEqual(setupCalls, 1, 'Trigger-reset startup path should still complete setup');
    }

    console.log(' - Testing buildFillKey requires history id to avoid degraded dedupe keys...');
    {
        const malformedFill = buildFill(undefined);
        delete malformedFill.id;

        assert.strictEqual(
            buildFillKey(malformedFill),
            null,
            'Missing history id should disable dedupe instead of producing a partial key'
        );
    }

    console.log('✓ Fill replay guard tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('✗ Fill replay guard tests failed');
    console.error(err);
    process.exit(1);
});
