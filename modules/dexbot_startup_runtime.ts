/** Startup runtime - bot initialization, grid placement, and startup sequence */
const { path } = require('./path_api');
const { BitShares, onReconnect: registerReconnectHook } = require('./bitshares_client');
const chainOrders = require('./chain_orders');
const { OrderManager, grid: Grid } = require('./order');
function initializeFeeCache(...args) { return require('./order/utils/system').initializeFeeCache(...args); }
function parseJsonWithComments(...args) { return require('./order/utils/system').parseJsonWithComments(...args); }
function buildFillKey(...args) { return require('./order/utils/order').buildFillKey(...args); }
function correctAllPriceMismatches(...args) { return require('./order/utils/order').correctAllPriceMismatches(...args); }
function parseChainOrder(...args) { return require('./order/utils/order').parseChainOrder(...args); }
const { ORDER_STATES } = require('./constants');
const { PATHS } = require('./paths');
const { getStorage } = require('./storage');
const storage = getStorage();
const { normalizeBotEntry } = require('./bot_settings');
const Format = require('./order/format');
function attemptResumePersistedGridByPriceMatch(...args) { return require('./order/grid_reconcile').attemptResumePersistedGridByPriceMatch(...args); }
function decideStartupGridAction(...args) { return require('./order/grid_reconcile').decideStartupGridAction(...args); }
function reconcileGridOrders(...args) { return require('./order/grid_reconcile').reconcileGridOrders(...args); }
const { AccountOrders } = require('./account_orders');
const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;

/**
 * Initialize the startup state: account orders, manager, persisted data.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Promise<Object>} startupState
 */
async function initializeStartupState(bot) {
    bot.accountOrders = new AccountOrders({ botKey: bot.config.botKey });
    bot._processedFillStore.configure({
        accountOrders: bot.accountOrders
    });

    const loadedPersistedFills = bot._processedFillStore.loadPersisted({
        minTimestamp: Date.now() - bot._fillRecordRetentionMs
    });
    if (loadedPersistedFills > 0) {
        bot._log(`Loaded ${loadedPersistedFills} persisted fill records to prevent reprocessing`);
    }

    const raw = storage.readFile(PROFILES_BOTS_FILE);
    const allBotsConfig = parseJsonWithComments(raw).bots || [];
    const myBotConfig = allBotsConfig
        .map((b, originalIdx) => b.active !== false ? normalizeBotEntry(b, originalIdx) : null)
        .find(b => b && b.botKey === bot.config.botKey);

    if (myBotConfig) {
        await bot.accountOrders.syncMeta(myBotConfig);
    }

    if (!bot.manager) {
        const mgrLogFile = bot.config?.name ? path.join(PATHS.LOGS_DIR, `${bot.config.name}.log`) : undefined;
        bot.manager = new OrderManager({ ...bot.config, logFile: mgrLogFile });
        bot.manager.account = bot.account;
        bot.manager.accountId = bot.accountId;
        bot.manager.accountOrders = bot.accountOrders;
    }
    bot._wireStructuralGridResyncRequest();
    bot._wireProcessedFillTracking();
    bot.manager.startBootstrap();
    try {
        try {
            if (bot.accountId && bot.config.assetA && bot.config.assetB) {
                await bot.manager._initializeAssets();
                await bot.manager.fetchAccountTotals(bot.accountId);
                bot._log('Fetched blockchain account balances at startup');
            }
        } catch (err: any) {
            bot._log(`Startup balance fetch FAILED: ${err.message}. Order sizing may be incorrect until next successful sync.`, 'error');
        }

        try {
            await initializeFeeCache([bot.config || {}], BitShares);
        } catch (err: any) {
            bot._log(`Fee cache initialization FAILED: ${err.message}. Fee calculations will use defaults until cache is refreshed.`, 'error');
        }

        const persistedGrid = bot.accountOrders.loadGrid();

        let repairedGrid = persistedGrid;
        if (persistedGrid && persistedGrid.length > 0) {
            let repairCount = 0;
            repairedGrid = persistedGrid.map(order => {
                if (order && order.orderId && order.orderId === order.id) {
                    repairCount++;
                    const repairedOrder = { ...order, orderId: '' };
                    if (repairedOrder.state === ORDER_STATES.ACTIVE || repairedOrder.state === ORDER_STATES.PARTIAL) {
                        repairedOrder.state = ORDER_STATES.VIRTUAL;
                    }
                    return repairedOrder;
                }
                return order;
            });
            if (repairCount > 0) {
                bot._log(`[REPAIR] Stripped ${repairCount} fake orderId(s) from persisted grid to restore rebalancing logic.`);
            }
        }

        const persistedBtsFeesOwed = bot.accountOrders.loadBtsFeesOwed();
        const persistedBoundaryIdx = bot.accountOrders.loadBoundaryIdx();
        const persistedBtsBalance = bot.accountOrders.loadBtsBalance();
        const persistedRecentFillKeys = bot.accountOrders.loadRecentFillKeys();

        return {
            persistedGrid: repairedGrid,
            persistedBtsFeesOwed,
            persistedBoundaryIdx,
            persistedBtsBalance,
            persistedRecentFillKeys,
        };
    } finally {
        bot.manager.finishBootstrap();
    }
}

/**
 * Finish the startup sequence: activate fill listener, reconcile grid, place initial orders.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} startupState
 */
async function finishStartupSequence(bot, startupState) {
    let {
        persistedGrid,
        persistedBtsFeesOwed,
        persistedBoundaryIdx,
        persistedBtsBalance,
        persistedRecentFillKeys,
    } = startupState;

    try {
        if (typeof bot._fillsUnsubscribe === 'function') {
            await bot._fillsUnsubscribe().catch(() => { });
        }
        bot._fillsUnsubscribe = await chainOrders.listenForFills(bot.account || undefined, bot._createFillCallback(chainOrders));
        if (typeof bot._fillsUnsubscribe !== 'function') {
            bot._warn('Fill listener did not provide an unsubscribe handler. Shutdown cleanup may be incomplete.');
            bot._fillsUnsubscribe = null;
        }
        bot._log('Fill listener activated (ready to process fills during startup)');

        if (!bot._reconnectUnregister) {
            bot._reconnectUnregister = registerReconnectHook(() => {
                bot._log('Blockchain connection re-established; scheduling safety-net sync');
                const runSafetyNetSync = async () => {
                    if (bot.manager && bot.accountId && !bot._shuttingDown && !bot.config.dryRun) {
                        const safetyNetTimeoutMs = bot.config.timing?.SAFETY_NET_SYNC_TIMEOUT_MS;
                        let safetyNetTimer;
                        const workPromise = bot.manager._fillProcessingLock.acquire(async () => {
                            if (bot._shuttingDown) return;
                            const chainOpenOrders = await chainOrders.readOpenOrders(bot.accountId);
                            if (bot._shuttingDown) return;
                            const syncResult = await bot.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                            if (bot._shuttingDown) return;
                            if (syncResult?.filledOrders?.length > 0) {
                                bot._refreshDynamicWeightDistribution('post-reconnect sync fill');
                                bot._log(`Post-reconnect sync: ${syncResult.filledOrders.length} grid order(s) found filled.`, 'info');
                                await bot._processFillsWithBatching(syncResult.filledOrders, new Set(), 'post-reconnect sync fill');
                                if (bot._shuttingDown) return;
                            }
                            bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
                            await bot.manager.persistGrid();

                            if (!bot._shuttingDown) {
                                try {
                                    const reconnectHealth = await bot.manager.checkGridHealth(
                                        bot.updateOrdersOnChainPlan.bind(bot)
                                    );
                                    await bot._cancelDustOrders({
                                        buy: reconnectHealth.buyDustOrders,
                                        sell: reconnectHealth.sellDustOrders,
                                    });
                                } catch (_dustErr: any) {
                                    bot._warn(`[RECONNECT] Dust cancel failed: ${_dustErr.message}`);
                                }
                            }
                        });
                        try {
                            await Promise.race([
                                workPromise,
                                new Promise((_, reject) => {
                                    safetyNetTimer = setTimeout(
                                        () => reject(new Error(`Safety-net sync exceeded ${safetyNetTimeoutMs}ms cap`)),
                                        safetyNetTimeoutMs
                                    );
                                })
                            ]);
                        } catch (capErr: any) {
                            const fallback = await Promise.race([
                                workPromise.then(() => ({ ok: true as const })),
                                new Promise<{ ok: false }>(resolve => setTimeout(() => resolve({ ok: false }), 0))
                            ]);
                            if (fallback.ok) {
                                bot._log(`Safety-net sync completed despite timeout — ignoring spurious error.`, 'info');
                            } else {
                                bot._warn(`Post-reconnect safety-net sync aborted: ${capErr?.message || capErr}`);
                            }
                        } finally {
                            if (safetyNetTimer) clearTimeout(safetyNetTimer);
                        }
                    }
                };
                setImmediate(() => {
                    runSafetyNetSync().catch(err => {
                        try {
                            bot._warn('Post-reconnect safety-net sync failed: ' + (err?.message || err));
                        } catch (_warnErr: any) {
                        }
                    });
                });
            });
        }

        const hadTriggerReset = await bot._handlePendingTriggerReset();

        if (hadTriggerReset) {
            bot._log('Trigger reset completed. Skipping normal startup grid initialization.');

            await bot.manager._fillProcessingLock.acquire(async () => {
                if (bot._incomingFillQueue.length > 0) {
                    bot._log(`[POST-RESET] ${bot._incomingFillQueue.length} fill(s) detected during trigger reset. Processing...`);

                    const fills = bot._incomingFillQueue.splice(0);
                    const processedFillKeys = new Set();
                    let requiresOpenOrdersSync = false;

                    for (const fill of fills) {
                        if (!fill || fill.op?.[0] !== 4) continue;

                        const fillOp = fill.op[1];
                        const gridOrder = bot.manager.orders.get(fillOp.order_id) ||
                            (Array.from(bot.manager.orders.values()) as any[]).find((o: any) => o.orderId === fillOp.order_id);

                        if (!gridOrder) {
                            let orphanFillKey = buildFillKey(fill);
                            if (!orphanFillKey) {
                                orphanFillKey = bot._buildOrphanFillFallbackKey(fill);
                            }
                            if (orphanFillKey && !bot._isNewFillKey(orphanFillKey, processedFillKeys, '[POST-RESET]', fillOp.order_id)) {
                                continue;
                            }

                            bot._log(`[POST-RESET] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                            const accountingResult = await bot._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
                                context: 'POST-RESET',
                                logger: { log: bot._log.bind(bot) },
                                replayMessage: (op) => `[POST-RESET] Replay detected for orphan fill ${op.order_id}; skipping duplicate credit`
                            });
                            if (accountingResult.status === 'missing_key') {
                                requiresOpenOrdersSync = true;
                            }
                            continue;
                        }

                        bot._log(`[POST-RESET] Processing fill for ${gridOrder.type} order ${gridOrder.id} at price ${gridOrder.price}`);

                        const trackedFillKey = buildFillKey(fill);
                        if (trackedFillKey && !bot._isNewFillKey(trackedFillKey, processedFillKeys, '[POST-RESET]', fillOp.order_id)) {
                            continue;
                        }

                        bot.manager.lockOrders([gridOrder.id]);
                        try {
                            const accountingResult = await bot._applyReplaySafeTrackedFillAccounting(fill, fillOp, {
                                context: 'POST-RESET',
                                logger: { log: bot._log.bind(bot) },
                                replayMessage: (op) => `[POST-RESET] Replay detected for ${op.order_id}; skipping duplicate rebalance`
                            });
                            if (accountingResult.status === 'missing_key') {
                                requiresOpenOrdersSync = true;
                                continue;
                            }
                            if (accountingResult.status !== 'applied') {
                                continue;
                            }
                            const result = await bot._processFillsWithBatching([gridOrder], new Set(), `[POST-RESET] fill ${gridOrder.id}`);
                            if (result.aborted) {
                                bot._warn('[POST-RESET] Aborted batch due to illegal state; skipping grid persistence this cycle');
                                continue;
                            }
                        } finally {
                            bot.manager.unlockOrders([gridOrder.id]);
                        }
                    }

                    if (requiresOpenOrdersSync) {
                        bot._log('[POST-RESET] Falling back to open-orders sync for fill(s) missing replay-safe history identifiers', 'warn');
                        const postResetChainOpenOrders = await chainOrders.readOpenOrders(bot.accountId);
                        const syncResult = await bot.manager.syncFromOpenOrders(postResetChainOpenOrders);
                        if (syncResult.filledOrders?.length > 0) {
                            await bot._processFillsWithBatching(syncResult.filledOrders, new Set(), '[POST-RESET] open-orders fallback');
                        }
                    }

                    await bot._flushProcessedFillPersistence('post-reset-batch');

                    bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
                    await bot.manager.persistGrid();
                }

                const { aborted: postResetAborted, hasUnmatched: postResetUnmatched } =
                    await bot._syncOpenOrdersAndProcessFills('[POST-RESET] pre-spread');

                if (postResetUnmatched) {
                    bot._warn(`[POST-RESET] Skipping spread correction: ${postResetUnmatched} unmatched chain order(s) require maintenance reconciliation`);
                }

                await bot.manager.recalculateFunds();
                if (!postResetAborted && !postResetUnmatched) {
                    const spreadResult = await bot.manager.checkSpreadCondition(
                        BitShares,
                        bot.updateOrdersOnChainPlan.bind(bot)
                    );
                    if (spreadResult && spreadResult.ordersPlaced > 0) {
                        bot._log(`✓ Spread correction after trigger reset: ${spreadResult.ordersPlaced} order(s) placed`);
                        await bot._persistAndRecoverIfNeeded();
                    }
                }

                if (!bot._shuttingDown) {
                    try {
                        const postResetHealth = await bot.manager.checkGridHealth(
                            bot.updateOrdersOnChainPlan.bind(bot)
                        );
                        await bot._cancelDustOrders({
                            buy: postResetHealth.buyDustOrders,
                            sell: postResetHealth.sellDustOrders,
                        });
                    } catch (_dustErr: any) {
                        bot._warn(`[POST-RESET] Dust cancel failed: ${_dustErr.message}`);
                    }
                }
                bot._log('Bootstrap phase complete - fill processing resumed', 'info');
            });

            await bot._setupTriggerFileDetection();
            await bot._setupCreditRuntime();
            await bot._refreshAndSyncCreditRuntime();
            bot._setupBlockchainFetchInterval();
            bot._setupCreditWatchdogInterval();
            bot._setupCredentialDaemonWatchdogInterval();
            bot._setupDustHealthCheckInterval();
            await bot._runDustHealthCheck();
            bot._log('[DUST] Startup health check complete');

            if (bot._isOpenOrdersSyncLoopEnabled()) {
                bot._startOpenOrdersSyncLoop();
            } else {
                bot._log('Open-orders sync loop disabled by configuration');
            }
            bot._log(`DEXBot started. OrderManager running (dryRun=${!!bot.config.dryRun})`);
            return;
        }

        bot.manager.resetFunds();
        if (persistedBtsFeesOwed && persistedBtsFeesOwed > 0) {
            bot.manager.funds.btsFeesOwed = Number(persistedBtsFeesOwed);
        }
        if (bot.config.assetA !== 'BTS' && bot.config.assetB !== 'BTS') {
            if (persistedBtsBalance && typeof persistedBtsBalance === 'object') {
                bot.manager.btsBalance = {
                    free: persistedBtsBalance.free || 0,
                    total: persistedBtsBalance.total || 0,
                    locked: persistedBtsBalance.locked || 0
                };
            }
        }

        if (persistedRecentFillKeys && typeof persistedRecentFillKeys === 'object') {
            for (const [fillKey, timestamp] of Object.entries(persistedRecentFillKeys)) {
                bot._recentlyQueuedFills.set(fillKey, Number(timestamp));
            }
            bot._log(`Restored ${Object.keys(persistedRecentFillKeys).length} recently queued fill key(s) from persisted snapshot`, 'debug');
        }

        if (!bot.config.dryRun && !bot.accountId) {
            throw new Error('Cannot start bot without a resolved account ID');
        }

        const chainOpenOrders = bot.config.dryRun ? [] : await chainOrders.readOpenOrders(bot.accountId);

        let shouldRegenerate = false;
        if (!persistedGrid || persistedGrid.length === 0) {
            shouldRegenerate = true;
            bot._log('No persisted grid found. Generating new grid.');
        } else {
            await bot.manager._initializeAssets();
            const decision = await decideStartupGridAction({
                persistedGrid,
                chainOpenOrders,
                manager: bot.manager,
                logger: { log: (msg) => bot._log(msg) },
                storeGrid: async (orders) => {
                    await bot.manager.persistGrid(orders);
                },
                attemptResumeFn: attemptResumePersistedGridByPriceMatch,
            });
            shouldRegenerate = decision.shouldRegenerate;

            if (shouldRegenerate && chainOpenOrders.length === 0) {
                bot._log('Persisted grid found, but no matching active orders on-chain. Generating new grid.');
            }

            if (shouldRegenerate && chainOpenOrders.length > 0 && bot.manager?.assets) {
                const orderCount = chainOpenOrders.filter(
                    o => parseChainOrder(o, bot.manager.assets) !== null
                ).length;
                if (orderCount === 0) {
                    bot._log(`Persisted grid found with no matching orders (${chainOpenOrders.length} other-pair order(s) on account). Generating new grid.`);
                }
            }
        }

        if (!shouldRegenerate) {
            if (persistedBtsFeesOwed > 0) {
                bot.manager.funds.btsFeesOwed = persistedBtsFeesOwed;
                bot._log(`✓ Restored BTS fees owed: ${Format.formatAmount8(persistedBtsFeesOwed)} BTS`);
            }
        } else {
            bot._log(`ℹ Grid regenerating - resetting BTS fees to clean state`);
            bot.manager.funds.btsFeesOwed = 0;
        }

        await bot.manager._fillProcessingLock.acquire(async () => {
            try {
                bot._refreshDynamicWeightDistribution('startup');
                if (shouldRegenerate) {
                    await bot.manager._initializeAssets();

                    if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                        bot._log('Generating new grid and syncing with existing on-chain orders...');
                        await Grid.initializeGrid(bot.manager);
                        await bot.manager.syncFromOpenOrders(chainOpenOrders, { skipAccounting: true });
                        const rebalanceResult = await reconcileGridOrders({
                            manager: bot.manager,
                            config: bot.config,
                            account: bot.account,
                            privateKey: bot.privateKey,
                            chainOrders,
                            chainOpenOrders,
                        });

                        await bot._executeBatchIfNeeded(rebalanceResult, 'startup reconcile (regenerated grid)');
                    } else {
                        bot._log('Generating new grid and placing initial orders on-chain...');
                        await bot.placeInitialOrders();
                    }
                    await bot._persistAndRecoverIfNeeded();
                } else {
                    bot._log('Found active session. Loading and syncing existing grid.');
                    await Grid.loadGrid(bot.manager, persistedGrid, persistedBoundaryIdx);
                    let startupChainOpenOrders = chainOpenOrders;
                    const syncResult = await bot.manager.syncFromOpenOrders(startupChainOpenOrders, { skipAccounting: true });

                    if (syncResult.ordersNeedingCorrection?.length > 0) {
                        await correctAllPriceMismatches(
                            bot.manager, bot.account, bot.privateKey, chainOrders
                        );
                    }

                    if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                        bot._log(`Startup sync: ${syncResult.filledOrders.length} grid order(s) found filled. Processing proceeds.`, 'info');
                        const batchResult = await bot._processFillsWithBatching(
                            syncResult.filledOrders, new Set(), 'startup sync fill rebalance',
                            { skipAccountTotalsUpdate: true }
                        );

                        if (!batchResult?.aborted) {
                            startupChainOpenOrders = await chainOrders.readOpenOrders(bot.accountId);
                            await bot.manager.synchronizeWithChain(startupChainOpenOrders, 'readOpenOrders');
                        }
                    }

                    const rebalanceResult = await reconcileGridOrders({
                        manager: bot.manager,
                        config: bot.config,
                        account: bot.account,
                        privateKey: bot.privateKey,
                        chainOrders,
                        chainOpenOrders: startupChainOpenOrders,
                    });

                    await bot._executeBatchIfNeeded(rebalanceResult, 'startup reconcile (loaded grid)');

                    await bot._persistAndRecoverIfNeeded();

                    await bot._rejectCorruptedGridSnapshot('startup');
                }

                if (bot._incomingFillQueue.length > 0) {
                    bot._log(`[STARTUP] Processing ${bot._incomingFillQueue.length} queued fill(s) before bootstrap ends`);
                    await bot._processFillsWithBootstrapMode(chainOrders);
                }

                bot.manager.finishBootstrap();

                const FETCH_TIMEOUT_MS = 30000;
                let _fetchTimeoutHandle: NodeJS.Timeout;
                try {
                    await Promise.race([
                        bot.manager.fetchAccountTotals(),
                        new Promise((_, reject) => {
                            _fetchTimeoutHandle = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS);
                        })
                    ]);
                } catch (fetchErr: any) {
                    bot._log(
                        `[STARTUP] [${bot.config?.botKey || 'unknown'}] fetchAccountTotals ${fetchErr.message === 'timeout' ? 'timed out' : 'failed'} (${fetchErr.message}). Continuing with cached account totals.`,
                        'warn'
                    );
                } finally {
                    clearTimeout(_fetchTimeoutHandle!);
                }

                await bot._runGridMaintenance('startup');

                const startupHealth = await bot.manager.checkGridHealth(
                    bot.updateOrdersOnChainPlan.bind(bot)
                );
                await bot._cancelDustOrders({
                    buy: startupHealth.buyDustOrders,
                    sell: startupHealth.sellDustOrders,
                });

                bot._log('Bootstrap phase complete - fill processing resumed', 'info');
            } finally {
                bot.manager.finishBootstrap();
            }
        });

        await bot._setupTriggerFileDetection();
        await bot._setupCreditRuntime();
        await bot._refreshAndSyncCreditRuntime();
        await bot._runCreditRuntimeMaintenance('startup');
        bot._setupBlockchainFetchInterval();
        bot._setupCreditWatchdogInterval();
        bot._setupCredentialDaemonWatchdogInterval();

        bot._setupDustHealthCheckInterval();
        await bot._runDustHealthCheck();
        bot._log('[DUST] Startup health check complete');

        if (bot._isOpenOrdersSyncLoopEnabled()) {
            bot._startOpenOrdersSyncLoop();
        } else {
            bot._log('Open-orders sync loop disabled by configuration');
        }
        bot._log(`DEXBot started. OrderManager running (dryRun=${!!bot.config.dryRun})`);

    } catch (err: any) {
        bot._warn(`Error during grid initialization: ${err.message}`);
        await bot.shutdown();
        throw err;
    }
}

/**
 * Place initial orders on the blockchain (extracted logic from original placeInitialOrders).
 * @param {import('./dexbot_class').DEXBot} bot
 */
async function placeInitialOrdersImpl(bot) {
    if (!bot.manager) {
        const mgrLogFile = bot.config?.name ? path.join(PATHS.LOGS_DIR, `${bot.config.name}.log`) : undefined;
        bot.manager = new OrderManager({ ...bot.config, logFile: mgrLogFile });
        bot.manager.accountOrders = bot.accountOrders;
    }
    bot._wireStructuralGridResyncRequest();
    bot.manager.startBootstrap();
    try {
        try {
            const botFunds = bot.config && bot.config.botFunds ? bot.config.botFunds : {};
            const needsPercent = (v) => typeof v === 'string' && v.includes('%');
            if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (bot.accountId || bot.account)) {
                if (typeof bot.manager._fetchAccountBalancesAndSetTotals === 'function') {
                    await bot.manager._fetchAccountBalancesAndSetTotals();
                }
            }
        } catch (errFetch: any) {
            bot._warn(`Could not fetch account totals before initializing grid: ${errFetch && errFetch.message ? errFetch.message : errFetch}`);
        }

        await Grid.initializeGrid(bot.manager);

        if (bot.config.dryRun) {
            bot.manager.logger.log('Dry run enabled, skipping on-chain order placement.', 'info');
            await bot.manager.persistGrid();
            return;
        }

        bot.manager.logger.log('Placing initial orders on-chain...', 'info');
        const ordersToActivate = bot.manager.getInitialOrdersToActivate();

        const orderGroups = bot._buildOutsideInPairGroupsForOrders(ordersToActivate);

        for (const group of orderGroups) {
            await bot.updateOrdersOnChainPlan({ ordersToPlace: group });
        }

        await bot.manager.persistGrid();
    } finally {
        bot.manager.finishBootstrap();
    }
}

export = {
    initializeStartupState,
    finishStartupSequence,
    placeInitialOrdersImpl,
};
