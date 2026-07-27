/** Fill processing runtime - handles order fill events and replay-safe accounting */

import { PROCESSED_FILL_PERSISTENCE_MODES } from './order/processed_fill_store';
import { NATIVE_CLIENT, FILL_PROCESSING, TIMING, MAINTENANCE, ORDER_TYPES } from './constants';
function buildFillKey(...args: any) { return require('./order/utils/order').buildFillKey(...args); }
function correctAllPriceMismatches(...args: any) { return require('./order/utils/order').correctAllPriceMismatches(...args); }
function retryPersistenceIfNeeded(...args: any) { return require('./order/utils/system').retryPersistenceIfNeeded(...args); }

/**
 * Wire processed fill tracking into the manager and processed fill store.
 * Establishes the bidirectional link between the runtime's processed fill store
 * and the OrderManager's processed fill tracker.
 * @param {import('./dexbot_class').DEXBot} bot
 */
function wireProcessedFillTracking(bot: any) {
    if (!bot.manager) return;

    bot._processedFillStore.configure({
        accountOrders: bot.accountOrders
    });

    bot._processedFillStore.mergeTracker(bot.manager.processedFillTracker);

    bot.manager.processedFillTracker = bot._recentlyProcessedFills;
    bot.manager.processedFillStore = bot._processedFillStore;
}

/**
 * Flush all pending processed fill writes to persistent storage.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} [reason='manual'] - Reason label for the flush
 * @param {Object} [options] - Flush options forwarded to ProcessedFillStore.flush
 * @returns {Promise<void>}
 */
async function flushProcessedFillPersistence(bot: any, reason: any = 'manual', options: any = {}) {
    bot._processedFillStore.setShuttingDown(bot._shuttingDown);
    await bot._processedFillStore.flush(reason, options);
}

/**
 * Flush pending processed fill writes for specific fill keys.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string[]|Set<string>} fillKeys - Fill keys to flush
 * @param {string} [reason='manual-selected'] - Reason label for the flush
 * @param {Object} [options] - Flush options forwarded to ProcessedFillStore.flushKeys
 * @returns {Promise<void>}
 */
async function flushProcessedFillPersistenceForKeys(bot: any, fillKeys: any, reason: any = 'manual-selected', options: any = {}) {
    bot._processedFillStore.setShuttingDown(bot._shuttingDown);
    await bot._processedFillStore.flushKeys(fillKeys, reason, options);
}

/**
 * Discard pending processed fill writes for specific fill keys from the queue.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string[]|Set<string>} fillKeys - Fill keys to discard
 */
function discardPendingProcessedFillPersistence(bot: any, fillKeys: any) {
    bot._processedFillStore.discardKeys(fillKeys);
}

/**
 * Build a degraded orphan fill replay key when the standard fill history id is missing.
 * The fallback key is derived from order_id, block_num, pays/receives amounts and asset IDs.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {import('./types').FillEvent} fill - Raw fill event
 * @returns {string|null} Orphan fallback key or null if insufficient data
 */
function buildOrphanFillFallbackKey(bot: any, fill: any) {
    const fillOp = fill?.op?.[1];
    const orderId = fillOp?.order_id;
    const blockNum = fill?.block_num;
    const paysAssetId = fillOp?.pays?.asset_id;
    const paysAmount = fillOp?.pays?.amount;
    const receivesAssetId = fillOp?.receives?.asset_id;
    const receivesAmount = fillOp?.receives?.amount;
    if (fillOp?.is_maker == null) {
        bot?._warn?.(`[ORPHAN-FALLBACK] is_maker undefined for fill ${fillOp?.order_id}; defaulting to 'maker' for dedup key`);
    }
    const makerRole = fillOp?.is_maker === false ? 'taker' : 'maker';
    // Include operation-type ID, transaction-in-block index, and
    // operation-in-transaction index to reduce collision risk when
    // multiple fills match on order + amounts + block number.
    const opType = fill?.op?.[0];
    const trxInBlock = fill?.trx_in_block;
    const opInTrx = fill?.op_in_trx;
    if (!orderId || blockNum == null || !paysAssetId || paysAmount == null || !receivesAssetId || receivesAmount == null) {
        return null;
    }
    return `orphan:${orderId}:${blockNum}:${paysAssetId}:${paysAmount}:${receivesAssetId}:${receivesAmount}:${makerRole}:${opType ?? ''}:${trxInBlock ?? ''}:${opInTrx ?? ''}`;
}

/**
 * Apply fill accounting with replay-safe deduplication.
 * Prevents the same fill from being accounted twice across restarts or re-syncs.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {import('./types').FillEvent} fill - Raw fill event
 * @param {import('./types').FillOperationData} fillOp - Extracted fill operation data
 * @param {Object} [options] - Options
 * @param {Function} [options.missingKeyMessage] - Callback to generate log message when fill key is missing
 * @param {Function} [options.fallbackKeyMessage] - Callback to generate log message when fallback key is used
 * @param {Function} [options.replayMessage] - Callback to generate log message on duplicate fill
 * @param {Function} [options.errorMessage] - Callback to generate log message on error
 * @param {Object} [options.logger] - Logger instance
 * @param {string} [options.missingKeyLevel='warn'] - Log level for missing key messages
 * @param {string} [options.fallbackKeyLevel='warn'] - Log level for fallback key messages
 * @param {string} [options.replayLevel='debug'] - Log level for replay messages
 * @param {string} [options.persistenceMode='immediate'] - Processed fill persistence mode (wrappers default to 'batched')
 * @param {boolean} [options.allowOrphanFallbackKey=false] - Allow degraded orphan fallback key
 * @returns {Promise<import('./types').ReplaySafeFillResult>}
 */
async function applyReplaySafeFillAccounting(bot: any, fill: any, fillOp: any, {
    missingKeyMessage,
    fallbackKeyMessage,
    replayMessage,
    errorMessage,
    logger = bot.manager?.logger,
    missingKeyLevel = 'warn',
    fallbackKeyLevel = 'warn',
    replayLevel = 'debug',
    persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE,
    allowOrphanFallbackKey = false
}: {
    missingKeyMessage?: any;
    fallbackKeyMessage?: any;
    replayMessage?: any;
    errorMessage?: any;
    logger?: any;
    missingKeyLevel?: string;
    fallbackKeyLevel?: string;
    replayLevel?: string;
    persistenceMode?: any;
    allowOrphanFallbackKey?: boolean;
} = {}) {
    let fillKey = buildFillKey(fill);
    let usedFallbackKey = false;

    if (!fillKey && allowOrphanFallbackKey) {
        fillKey = buildOrphanFillFallbackKey(bot, fill);
        usedFallbackKey = Boolean(fillKey);
        if (usedFallbackKey && fallbackKeyMessage) {
            logger?.log?.(fallbackKeyMessage(fillOp, fill, fillKey), fallbackKeyLevel);
        }
    }

    if (!fillKey) {
        if (missingKeyMessage) {
            logger?.log?.(missingKeyMessage(fillOp, fill), missingKeyLevel);
        }
        return { status: 'missing_key', fillKey: null };
    }

    try {
        const applied = await bot.manager.accountant.processFillAccounting(fillOp, fillKey, { persistenceMode });
        if (!applied) {
            if (replayMessage) {
                logger?.log?.(replayMessage(fillOp, fill, fillKey), replayLevel);
            }
            return { status: 'duplicate', fillKey };
        }

        return { status: 'applied', fillKey, usedFallbackKey };
    } catch (err: any) {
        if (errorMessage) {
            logger?.log?.(errorMessage(fillOp, fill, err), 'error');
            return { status: 'error', fillKey, error: err };
        }
        throw err;
    }
}

/**
 * Apply replay-safe fill accounting for tracked fills (with fill history id).
 * Wraps applyReplaySafeFillAccounting with context and default message builders.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {import('./types').FillEvent} fill - Raw fill event
 * @param {import('./types').FillOperationData} fillOp - Extracted fill operation data
 * @param {Object} [options] - Options
 * @param {string} [options.context] - Context label for log messages
 * @param {Object} [options.logger] - Logger instance
 * @param {Function} [options.replayMessage] - Callback to generate log message on duplicate fill
 * @param {string} [options.persistenceMode='batched'] - Processed fill persistence mode
 * @returns {Promise<import('./types').ReplaySafeFillResult>}
 */
async function applyReplaySafeTrackedFillAccounting(bot: any, fill: any, fillOp: any, {
    context,
    logger = bot.manager?.logger,
    replayMessage,
    persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
}: {
    context?: string;
    logger?: any;
    replayMessage?: any;
    persistenceMode?: any;
} = {}) {
    return applyReplaySafeFillAccounting(bot, fill, fillOp, {
        logger,
        missingKeyMessage: (op: any) => `[${context}] Missing fill history id for ${op.order_id}; deferring to open-orders sync`,
        replayMessage,
        errorMessage: (op: any, _fill: any, err: any) => `[${context}] Failed to process accounting for ${op.order_id}: ${err.message}`,
        persistenceMode
    });
}

/**
 * Apply replay-safe fill accounting for orphan fills (missing fill history id).
 * Uses a degraded orphan fallback key when the standard key is unavailable.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {import('./types').FillEvent} fill - Raw fill event
 * @param {import('./types').FillOperationData} fillOp - Extracted fill operation data
 * @param {Object} [options] - Options
 * @param {string} [options.context] - Context label for log messages
 * @param {Object} [options.logger] - Logger instance
 * @param {Function} [options.replayMessage] - Callback to generate log message on duplicate fill
 * @param {string} [options.persistenceMode='batched'] - Processed fill persistence mode
 * @returns {Promise<import('./types').ReplaySafeFillResult>}
 */
async function applyReplaySafeOrphanFillAccounting(bot: any, fill: any, fillOp: any, {
    context,
    logger = bot.manager?.logger,
    replayMessage,
    persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
}: {
    context?: string;
    logger?: any;
    replayMessage?: any;
    persistenceMode?: any;
} = {}) {
    return applyReplaySafeFillAccounting(bot, fill, fillOp, {
        logger,
        missingKeyMessage: (op: any) => `[${context}] Missing fill history id and orphan fallback key for ${op.order_id}; deferring to open-orders sync`,
        fallbackKeyMessage: (op: any) => `[${context}] Missing fill history id for orphan fill ${op.order_id}; using degraded orphan replay key for proceeds-only accounting`,
        replayMessage,
        errorMessage: (op: any, _fill: any, err: any) => `[${context}] Failed to process accounting for ${op.order_id}: ${err.message}`,
        persistenceMode,
        allowOrphanFallbackKey: true
    });
}

/**
 * Create a fill callback handler for blockchain subscription events.
 * Queues incoming fills and triggers fill queue consumption.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module
 * @returns {Function} Async callback function accepting an array of fill events
 */
function createFillCallback(bot: any, chainOrders: any) {
    return async (fills: any) => {
        if (bot._shuttingDown) {
            return;
        }

        if (bot.manager && !bot.config.dryRun && Array.isArray(fills) && fills.length > 0) {
            const maxQueueDepth = NATIVE_CLIENT.SUBSCRIPTIONS.MAX_INCOMING_FILL_QUEUE;
            if (bot._incomingFillQueue.length + fills.length > maxQueueDepth) {
                const message = `Incoming fill queue back-pressure: ${bot._incomingFillQueue.length} queued + ${fills.length} incoming exceeds limit ${maxQueueDepth}`;
                bot._warn(message);
                throw new Error(message);
            }
            bot._markGridActivity?.('fill queued');
            bot._incomingFillQueue.push(...fills);
            bot._consumeFillQueue(chainOrders).catch((err: any) => {
                bot._warn(`Fill queue consume failed: ${err.message}`);
            });
        }
    };
}

/**
 * Returns the maximum consecutive fill consumer failures allowed before backoff.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {number}
 */
function maxConsecutiveFillConsumerFailures(bot: any) {
    return bot.config.fillProcessing?.MAX_CONSECUTIVE_CONSUMER_FAILURES ?? FILL_PROCESSING.MAX_CONSECUTIVE_CONSUMER_FAILURES;
}

/**
 * Compute the backoff delay for fill-consumer retries after the failure
 * budget (MAX_CONSECUTIVE_CONSUMER_FAILURES) is exhausted. Each retry
 * doubles the previous delay, capped at CONSUMER_BACKOFF_MAX_MS. The
 * consumer NEVER permanently stops re-scheduling — it just slows down.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {number} failures The current consecutive-failure count.
 * @returns {number} Delay in milliseconds before the next retry.
 */
function computeFillConsumerBackoffMs(bot: any, failures: any) {
    const fp = bot.config.fillProcessing || FILL_PROCESSING;
    const initial = fp.CONSUMER_BACKOFF_INITIAL_MS;
    const max = fp.CONSUMER_BACKOFF_MAX_MS;
    const stepAfterMax = Math.max(0, failures - maxConsecutiveFillConsumerFailures(bot));
    return Math.min(max, initial * Math.pow(2, stepAfterMax));
}

/**
 * Schedule a fill consumer restart with exponential backoff when the
 * failure budget is exhausted, or immediate retry via setImmediate when
 * within the budget. The consumer NEVER permanently stops re-scheduling.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module
 */
function scheduleFillConsumerRestart(bot: any, chainOrders: any) {
    const failures = bot._consecutiveConsumeFailures;
    if (failures >= maxConsecutiveFillConsumerFailures(bot)) {
        const backoffMs = computeFillConsumerBackoffMs(bot, failures);
        const elapsedSec = bot._consumeFailureFirstAt
            ? Math.round((Date.now() - bot._consumeFailureFirstAt) / TIMING.MILLISECONDS_PER_SECOND)
            : null;
        const elapsed = elapsedSec !== null ? `${elapsedSec}s` : 'unknown';
        const sustainedLevel = (failures >= 20 || (elapsedSec !== null && elapsedSec >= 900))
            ? 'critical'
            : (failures >= 10 || (elapsedSec !== null && elapsedSec >= 300))
                ? 'error'
                : 'warn';
        bot._log(
            `[FILL-QUEUE] Fill consumer has failed ${failures} consecutive times over ${elapsed}; ` +
            `backing off ${Math.round(backoffMs / TIMING.MILLISECONDS_PER_SECOND)}s before retry. ` +
            `Queue: ${bot._incomingFillQueue.length} fills.`,
            sustainedLevel
        );
        setTimeout(() => {
            if (bot._shuttingDown) return;
            bot._consumeFillQueue(chainOrders).catch((err: any) => {
                if (!bot._consumeFailureFirstAt) {
                    bot._consumeFailureFirstAt = Date.now();
                }
                bot._consecutiveConsumeFailures++;
                const newFailures = bot._consecutiveConsumeFailures;
                const newElapsedSec = bot._consumeFailureFirstAt
                    ? Math.round((Date.now() - bot._consumeFailureFirstAt) / TIMING.MILLISECONDS_PER_SECOND)
                    : null;
                const resumeLevel = (newFailures >= 20 || (newElapsedSec !== null && newElapsedSec >= 900))
                    ? 'critical'
                    : (newFailures >= 10 || (newElapsedSec !== null && newElapsedSec >= 300))
                        ? 'error'
                        : 'warn';
                bot._log(
                    `Fill consumer resume after backoff failed ` +
                    `(${newFailures} total, ` +
                    `next backoff ${Math.round(computeFillConsumerBackoffMs(bot, newFailures) / TIMING.MILLISECONDS_PER_SECOND)}s): ` +
                    `${err.message}`,
                    resumeLevel
                );
                bot._scheduleFillConsumerRestart(chainOrders);
            });
        }, backoffMs);
        return;
    }

    setImmediate(() => bot._consumeFillQueue(chainOrders).catch((err: any) => {
        if (!bot._consumeFailureFirstAt) {
            bot._consumeFailureFirstAt = Date.now();
        }
        bot._consecutiveConsumeFailures++;
        const remaining = maxConsecutiveFillConsumerFailures(bot) - bot._consecutiveConsumeFailures;
        bot._log(
            `Fill consumer failed (${bot._consecutiveConsumeFailures}/${maxConsecutiveFillConsumerFailures(bot)}, ` +
            `${remaining} attempts remaining): ${err.message}`,
            bot._consecutiveConsumeFailures >= 3 ? 'warn' : 'error'
        );
    }));
}

/**
 * Process fills during bootstrap phase using the standard fill pipeline.
 * Delegates to the same fill pipeline as the post-reset path.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module for blockchain operations
 * @returns {Promise<void>}
 */
async function processFillsWithBootstrapMode(bot: any, chainOrders: any) {
    if (bot._incomingFillQueue.length === 0) return;

    const startTime = Date.now();
    const fills = bot._incomingFillQueue.splice(0);
    const validFills: any[] = [];
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
            if (orphanFillKey && !bot._isNewFillKey(orphanFillKey, processedFillKeys, '[BOOTSTRAP]', fillOp.order_id)) {
                continue;
            }

            bot.manager.logger.log(`[BOOTSTRAP] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
            const accountingResult = await bot._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
                context: 'BOOTSTRAP'
            });
            if (accountingResult.status === 'missing_key') {
                requiresOpenOrdersSync = true;
            }
            continue;
        }

        const trackedFillKey = buildFillKey(fill);
        if (trackedFillKey && !bot._isNewFillKey(trackedFillKey, processedFillKeys, '[BOOTSTRAP]', fillOp.order_id)) {
            continue;
        }

        bot.manager.lockOrders([gridOrder.id]);
        try {
            const accountingResult = await bot._applyReplaySafeTrackedFillAccounting(fill, fillOp, {
                context: 'BOOTSTRAP',
                replayMessage: (op: any) => `[BOOTSTRAP] Replay detected for ${op.order_id}; skipping duplicate bootstrap rebalance`
            });
            if (accountingResult.status === 'missing_key') {
                requiresOpenOrdersSync = true;
                continue;
            }
            if (accountingResult.status !== 'applied') {
                continue;
            }

            validFills.push({ ...fill, gridOrder });

            const fillType = gridOrder.type === ORDER_TYPES.BUY ? 'BUY' : 'SELL';
            bot._log(`[BOOTSTRAP] Fill detected: ${fillType} order (${fillOp.is_maker !== false ? 'maker' : 'taker'})`);
        } finally {
            bot.manager.unlockOrders([gridOrder.id]);
        }
    }

    if (requiresOpenOrdersSync) {
        bot._log('[BOOTSTRAP] Falling back to open-orders sync for fill(s) missing replay-safe history identifiers', 'warn');
        const bootstrapChainOpenOrders = await chainOrders.readOpenOrders(bot.accountId);
        const syncResult = await bot.manager.syncFromOpenOrders(bootstrapChainOpenOrders);
        if (syncResult.filledOrders?.length > 0) {
            const queuedOrderIds = new Set(validFills.map((fill: any) => fill?.gridOrder?.orderId).filter(Boolean));
            for (const filledOrder of syncResult.filledOrders) {
                if (!filledOrder?.orderId || queuedOrderIds.has(filledOrder.orderId)) continue;
                validFills.push({ gridOrder: filledOrder });
                queuedOrderIds.add(filledOrder.orderId);
            }
        }
    }

    await bot._flushProcessedFillPersistence('bootstrap-batch');

    if (validFills.length === 0) return;

    try {
        bot._log(`[BOOTSTRAP] Processing ${validFills.length} fill(s) through standard pipeline`, 'info');

        const filledOrders = validFills.map((f: any) => f.gridOrder);
        const result = await bot._processFillsWithBatching(
            filledOrders,
            new Set(),
            '[BOOTSTRAP] fill processing'
        );

        if (result.aborted) {
            bot._warn('[BOOTSTRAP] Aborted batch due to illegal state; skipping grid persistence this cycle');
        }

        bot._metrics.fillsProcessed += validFills.length;
        bot._metrics.fillProcessingTimeMs += Date.now() - startTime;
    } catch (err: any) {
        bot._warn(`[BOOTSTRAP] Error processing fills: ${err.message}`);
        bot.manager.logger.log(`[BOOTSTRAP] Fill error: ${err.message}`, 'error');
    }
}

/**
 * Consume queued fills from incomingFillQueue and rebalance.
 * Deduplicates fills against already-processed set (replay-safe), syncs filled
 * orders from history or open orders mode, handles price mismatches, processes
 * fills sequentially with interruptible rebalancing, and periodically cleans old
 * fill records.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} chainOrders - Chain orders module for blockchain operations
 */
async function consumeFillQueue(bot: any, chainOrders: any) {
    const resetFailureWatchdogIfSet = () => {
        if (bot._consecutiveConsumeFailures > 0 || bot._consumeFailureFirstAt > 0) {
            bot._consecutiveConsumeFailures = 0;
            bot._consumeFailureFirstAt = 0;
        }
    };

    if (bot._incomingFillQueue.length === 0) {
        resetFailureWatchdogIfSet();
        return;
    }

    if (bot._shuttingDown) {
        bot._warn('Fill processing skipped: shutdown in progress');
        resetFailureWatchdogIfSet();
        return;
    }

    if (bot._batchInFlight || bot._recoverySyncInFlight) {
        bot.manager?.logger?.log?.(
            `Fill processing deferred: order pipeline active (${bot._incomingFillQueue.length} queued)`,
            'debug'
        );
        resetFailureWatchdogIfSet();
        return;
    }

    let pendingFillKeysForCurrentCycle = new Set();
    try {
        if (bot.manager.isBootstrapping()) {
            let bootstrapSkipped = false;
            await bot.manager._fillProcessingLock.acquire(async () => {
                if (!bot.manager.isBootstrapping()) {
                    bootstrapSkipped = true;
                    return;
                }
                await bot._processFillsWithBootstrapMode(chainOrders);
            });
            if (bootstrapSkipped) {
                resetFailureWatchdogIfSet();
            }
            return;
        }

        if (bot.manager._fillProcessingLock.getQueueLength() > 0) {
            bot._metrics.lockContentionEvents++;
            resetFailureWatchdogIfSet();
            return;
        }

        await bot.manager._fillProcessingLock.acquire(async () => {
            bot.manager._orphanFillsCreditedAt = null;

            while (bot._incomingFillQueue.length > 0) {
                const batchStartTime = Date.now();
                bot._metrics.maxQueueDepth = Math.max(bot._metrics.maxQueueDepth, bot._incomingFillQueue.length);

                const allFills = bot._incomingFillQueue.splice(0);

                const validFills: any[] = [];
                const processedFillKeys = new Set();
                pendingFillKeysForCurrentCycle = new Set();
                let requiresOpenOrdersSync = false;

                for (const fill of allFills) {
                    if (fill && fill.op && fill.op[0] === FILL_PROCESSING.OPERATION_TYPE) {
                        const fillOp = fill.op[1];

                        const hasFillEconomics = fillOp?.pays?.asset_id && fillOp?.pays?.amount != null
                            && fillOp?.receives?.asset_id && fillOp?.receives?.amount != null;

                        if (chainOrders && typeof chainOrders.wasRecentlyOwnCancelled === 'function'
                            && chainOrders.wasRecentlyOwnCancelled(fillOp.order_id)
                            && !hasFillEconomics) {
                            bot.manager.logger.log(
                                `[SELF-CANCEL] Skipping non-economic fill artifact for order ${fillOp.order_id} (just cancelled by this bot)`,
                                'debug'
                            );
                            continue;
                        }

                        const gridOrder = bot.manager.orders.get(fillOp.order_id) ||
            (Array.from(bot.manager.orders.values()) as any[]).find((o: any) => o.orderId === fillOp.order_id);
                        if (!gridOrder) {
                            const staleMarkedAt = bot._staleCleanedOrderIds.get(fillOp.order_id);
                            if (staleMarkedAt != null) {
                                const staleAgeMs = Date.now() - staleMarkedAt;
                                if (staleAgeMs <= bot._staleCleanupRetentionMs) {
                                    bot.manager.logger.log(
                                        `[ORPHAN-FILL] Skipping double-credit for stale-cleaned order ${fillOp.order_id} ` +
                                        `(funds already freed by batch cleanup, age=${staleAgeMs}ms)`,
                                        'warn'
                                    );
                                    continue;
                                }
                                bot._staleCleanedOrderIds.delete(fillOp.order_id);
                            }

                            let orphanFillKey = buildFillKey(fill);
                            if (!orphanFillKey) {
                                orphanFillKey = bot._buildOrphanFillFallbackKey(fill);
                            }
                            if (orphanFillKey && !bot._isNewFillKey(orphanFillKey, processedFillKeys, '[ORPHAN-FILL]', fillOp.order_id)) {
                                continue;
                            }

                            bot.manager.logger.log(`[ORPHAN-FILL] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                            const accountingResult = await bot._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
                                context: 'ORPHAN-FILL',
                                replayMessage: (op: any) => `[ORPHAN-FILL] Replay detected for ${op.order_id}; skipping duplicate credit`
                            });
                            if (accountingResult.status === 'missing_key') {
                                requiresOpenOrdersSync = true;
                            }
                            bot.manager._orphanFillsCreditedAt = Date.now();
                            continue;
                        }

                        const roleStr = fillOp.is_maker !== false ? 'maker' : 'taker';
                        bot.manager.logger.log(`Processing ${roleStr} fill for order ${fillOp.order_id}`, 'debug');

                        const fillKey = buildFillKey(fill);
                        if (!fillKey) {
                            bot.manager.logger.log(
                                `[FILL] Missing history id for order ${fillOp.order_id} block ${fill.block_num}; deferring to open-orders sync`,
                                'warn'
                            );
                            requiresOpenOrdersSync = true;
                            continue;
                        }
                        if (!bot._isNewFillKey(fillKey, processedFillKeys, '[FILL]', fillOp.order_id)) {
                            continue;
                        }
                        validFills.push(fill);

                        const paysAmount = fillOp.pays ? fillOp.pays.amount : '?';
                        const receivesAmount = fillOp.receives ? fillOp.receives.amount : '?';
                        bot._log(`\n===== FILL DETECTED =====`);
                        bot._log(`Order ID: ${fillOp.order_id}`);
                        bot._log(`Pays: ${paysAmount}, Receives: ${receivesAmount}`);
                        bot._log(`Block: ${fill.block_num} (History ID: ${fill.id || 'N/A'})`);
                        bot._log(`=========================\n`);
                    }
                }

                const cleanupTimestamp = Date.now();
                let cleanedCount = 0;
                for (const [key, timestamp] of bot._recentlyQueuedFills) {
                    if (cleanupTimestamp - timestamp > bot._fillDedupeWindowMs) {
                        bot._recentlyQueuedFills.delete(key);
                        cleanedCount++;
                    }
                }
                if (cleanedCount > 0) {
                    bot.manager.logger.log(`Cleaned ${cleanedCount} old queued fill records. Remaining: ${bot._recentlyQueuedFills.size}`, 'debug');
                }

                if (validFills.length === 0 && !requiresOpenOrdersSync) continue;

                let allFilledOrders: any[] = [];
                let ordersNeedingCorrection: any[] = [];
                const fillMode = chainOrders.getFillProcessingMode();

                const processValidFills = async (fillsToSync: any) => {
                    let resolvedOrders: any[] = [];
                    if (fillMode === 'history') {
                        bot.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (history mode)`, 'info');

                        if (fillsToSync.length >= 2) {
                            const batchResult = await bot.manager.syncFromFillHistoryBatch(fillsToSync, {
                                persistenceMode: PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
                            });
                            for (const fill of fillsToSync) {
                                const fillKey = buildFillKey({
                                    orderId: fill?.op?.[1]?.order_id,
                                    blockNum: fill?.block_num,
                                    historyId: fill?.id
                                });
                                if (fillKey) pendingFillKeysForCurrentCycle.add(fillKey);
                            }
                            if (batchResult.filledOrders) resolvedOrders.push(...batchResult.filledOrders);
                            if (batchResult.requiresOpenOrdersSync) requiresOpenOrdersSync = true;
                        } else {
                            for (const fill of fillsToSync) {
                                const resultHistory = await bot.manager.syncFromFillHistory(fill, {
                                    persistenceMode: PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
                                });
                                const fillKey = buildFillKey({
                                    orderId: fill?.op?.[1]?.order_id,
                                    blockNum: fill?.block_num,
                                    historyId: fill?.id
                                });
                                if (fillKey) pendingFillKeysForCurrentCycle.add(fillKey);
                                if (resultHistory.filledOrders) resolvedOrders.push(...resultHistory.filledOrders);
                                if (resultHistory.requiresOpenOrdersSync) requiresOpenOrdersSync = true;
                            }
                        }
                    }

                    if (fillMode !== 'history' || requiresOpenOrdersSync) {
                        if (fillMode === 'history' && requiresOpenOrdersSync) {
                            bot.manager.logger.log(
                                'Falling back to open-orders sync for fill(s) missing replay-safe history identifiers',
                                'warn'
                            );
                        }
                        bot.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (open orders mode)`, 'info');
                        const chainOpenOrders = await chainOrders.readOpenOrders(bot.account);
                        const resultOpenOrders = await bot.manager.syncFromOpenOrders(chainOpenOrders);
                        if (resultOpenOrders.filledOrders) resolvedOrders.push(...resultOpenOrders.filledOrders);
                        if (resultOpenOrders.ordersNeedingCorrection) ordersNeedingCorrection.push(...resultOpenOrders.ordersNeedingCorrection);
                    }
                    return resolvedOrders;
                };

                bot.manager.pauseFundRecalc();
                try {
                    const fillsByBlock = new Map();
                    const fillsWithoutBlock: any[] = [];
                    for (const fill of validFills) {
                        if (fill.block_num != null) {
                            const list = fillsByBlock.get(fill.block_num);
                            if (list) list.push(fill);
                            else fillsByBlock.set(fill.block_num, [fill]);
                        } else {
                            fillsWithoutBlock.push(fill);
                        }
                    }

                    const sortedBlocks = [...fillsByBlock.keys()].sort((a: any, b: any) => a - b);
                    const accumulatedOrders: any[] = [];
                    let anyRequiresSync = false;
                    const initialRequiresSync = requiresOpenOrdersSync;
                    for (const blockNum of sortedBlocks) {
                        requiresOpenOrdersSync = false;
                        bot.manager.logger.log(
                            `[FILL-BLOCK] Processing ${fillsByBlock.get(blockNum).length} fill(s) from block ${blockNum}`,
                            'debug'
                        );
                        const blockResult = await processValidFills(fillsByBlock.get(blockNum));
                        accumulatedOrders.push(...blockResult);
                        if (requiresOpenOrdersSync) anyRequiresSync = true;
                    }
                    requiresOpenOrdersSync = anyRequiresSync || initialRequiresSync;
                    if (fillsWithoutBlock.length > 0) {
                        bot.manager.logger.log(
                            `[FILL-BLOCK] Processing ${fillsWithoutBlock.length} fill(s) without block info`,
                            'debug'
                        );
                        const noBlockResult = await processValidFills(fillsWithoutBlock);
                        accumulatedOrders.push(...noBlockResult);
                        if (requiresOpenOrdersSync) anyRequiresSync = true;
                    }
                    if (requiresOpenOrdersSync && !anyRequiresSync) {
                        bot.manager.logger.log(
                            '[FILL-BLOCK] Running open-orders sync for fills with missing history identifiers',
                            'warn'
                        );
                        const fallbackOrders = await processValidFills([]);
                        accumulatedOrders.push(...fallbackOrders);
                    }
                    allFilledOrders = accumulatedOrders;

                    if (ordersNeedingCorrection.length > 0) {
                        const correctionResult = await correctAllPriceMismatches(
                            bot.manager, bot.account, bot.privateKey, chainOrders
                        );
                        if (correctionResult.failed > 0) bot.manager.logger.log(`${correctionResult.failed} corrections failed`, 'error');
                    }

                } finally {
                    await bot.manager.resumeFundRecalc();
                }

                bot._refreshDynamicWeightDistribution('fill queue');

                if (allFilledOrders.length > 0) {
                    const result = await bot._processFillsWithBatching(
                        allFilledOrders, null, 'fill set'
                    );
                    let abortedFillCycle = result.aborted;
                    if (!abortedFillCycle) {
                        const batchFillKeys = new Set(allFilledOrders.map((filledOrder: any) => buildFillKey({
                            orderId: filledOrder?.orderId,
                            blockNum: filledOrder?.blockNum,
                            historyId: filledOrder?.historyId
                        })).filter(Boolean));
                        await bot._flushProcessedFillPersistenceForKeys(batchFillKeys, 'fill-batch-committed');
                    } else {
                        bot.manager.logger.log(
                            '[FILL-DEDUP] Fill cycle aborted; fill key persistence guarded under abort path.',
                            'warn'
                        );
                    }

                    const fullFillCount = allFilledOrders.filter((o: any) =>
                        o && o.isPartial !== true
                    ).length;
                    const hasAnyFills = allFilledOrders.some((o: any) => o);
                    const shouldRunPostFillChecks = !abortedFillCycle && fullFillCount > 0;
                    const shouldRunDustDetection = !abortedFillCycle && hasAnyFills;

                    if (shouldRunDustDetection) {
                        const healthResult = await bot.manager.checkGridHealth(
                            bot.updateOrdersOnChainPlan.bind(bot)
                        );
                        const allDust = [
                            ...(healthResult.buyDustOrders || []),
                            ...(healthResult.sellDustOrders || []),
                        ];
                        if (allDust.length > 0) {
                            const dustCancelResult = await bot._cancelDustOrders({
                                buy: healthResult.buyDustOrders,
                                sell: healthResult.sellDustOrders,
                            });
                            if (dustCancelResult?.batchResult?.aborted) {
                                abortedFillCycle = true;
                            }
                        }
                    }

                    if (shouldRunPostFillChecks && !abortedFillCycle) {
                        await bot._runGridMaintenance('post-fill');
                    }
                } else if (pendingFillKeysForCurrentCycle.size > 0) {
                    await bot._flushProcessedFillPersistenceForKeys(
                        pendingFillKeysForCurrentCycle, 'fill-batch-no-rotations'
                    );
                }

                bot.manager._recentFillKeysSnapshot = bot._getRecentFillKeysSnapshot();
                await retryPersistenceIfNeeded(bot.manager);

                bot._fillCleanupCounter += validFills.length;

                const cleanupThreshold = MAINTENANCE.CLEANUP_PROBABILITY > 0 && MAINTENANCE.CLEANUP_PROBABILITY < 1
                    ? Math.floor(1 / MAINTENANCE.CLEANUP_PROBABILITY)
                    : 100;

                if (bot._fillCleanupCounter >= cleanupThreshold) {
                    try {
                        await bot.accountOrders.cleanOldProcessedFills(TIMING.FILL_RECORD_RETENTION_MS);
                        bot._fillCleanupCounter = 0;
                    } catch (err: any) {
                        bot.manager?.logger?.log(`Warning: Fill cleanup failed (will retry): ${err.message}`, 'warn');
                    }
                }

                bot._metrics.fillsProcessed += validFills.length;
                bot._metrics.fillProcessingTimeMs += Date.now() - batchStartTime;

                if (bot._staleCleanedOrderIds.size > 0) {
                    const now = Date.now();
                    let prunedCount = 0;
                    for (const [orderId, markedAt] of bot._staleCleanedOrderIds) {
                        if (now - markedAt > bot._staleCleanupRetentionMs) {
                            bot._staleCleanedOrderIds.delete(orderId);
                            prunedCount++;
                        }
                    }
                    if (prunedCount > 0) {
                        bot.manager.logger.log(
                            `[STALE-CLEANUP] Pruned ${prunedCount} expired stale-cleaned order IDs ` +
                            `(retention=${bot._staleCleanupRetentionMs}ms, remaining=${bot._staleCleanedOrderIds.size})`,
                            'debug'
                        );
                    }
                }

            }

            bot._markGridActivity('fill processing end');
            bot._consecutiveConsumeFailures = 0;
            bot._consumeFailureFirstAt = 0;
        });
    } catch (err: any) {
        const isCredentialOutage = bot._isCredentialDaemonError(err);
        if (pendingFillKeysForCurrentCycle.size > 0) {
            const flushReason = isCredentialOutage
                ? 'credential-outage-verified-fills'
                : 'fill-cycle-error-verified-fills';

            if (isCredentialOutage) {
                bot._credentialRecoveryNeeded = true;
                bot._suspendGridPersistenceForCredentialOutage(`credential outage during fill processing: ${err.message}`);
            }

            try {
                await bot._flushProcessedFillPersistenceForKeys(
                    pendingFillKeysForCurrentCycle, flushReason, { throwOnError: true }
                );
                const credentialSuffix = isCredentialOutage
                    ? '; grid persistence is suspended until recovery'
                    : '';
                bot.manager?.logger?.log?.(
                    `[FILL-DEDUP] Persisted ${pendingFillKeysForCurrentCycle.size} verified processed-fill write(s) after fill cycle error${credentialSuffix}.`,
                    isCredentialOutage ? 'warn' : 'info'
                );
            } catch (flushErr: any) {
                bot.manager?.logger?.log?.(
                    `[FILL-DEDUP] Failed to persist verified fill keys during fill error handling: ${flushErr.message}`,
                    'warn'
                );
            }
        }

        if (isCredentialOutage && pendingFillKeysForCurrentCycle.size === 0) {
            bot._credentialRecoveryNeeded = true;
            bot._suspendGridPersistenceForCredentialOutage(`credential outage during fill processing: ${err.message}`);
        }
        bot._log(`Error processing fills: ${err.message}`, 'error');
        if (err.stack) bot._log(err.stack, 'error');
    }

    if (!bot._shuttingDown && bot._incomingFillQueue.length > 0) {
        scheduleFillConsumerRestart(bot, chainOrders);
    }
}

export { wireProcessedFillTracking, flushProcessedFillPersistence, flushProcessedFillPersistenceForKeys, discardPendingProcessedFillPersistence, buildOrphanFillFallbackKey, applyReplaySafeFillAccounting, applyReplaySafeTrackedFillAccounting, applyReplaySafeOrphanFillAccounting, createFillCallback, maxConsecutiveFillConsumerFailures, computeFillConsumerBackoffMs, scheduleFillConsumerRestart, consumeFillQueue, processFillsWithBootstrapMode }

