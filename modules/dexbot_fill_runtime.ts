/** Fill processing runtime - handles order fill events and replay-safe accounting */
const { buildFillKey } = require('./order/utils/order');
const { PROCESSED_FILL_PERSISTENCE_MODES } = require('./order/processed_fill_store');
const { NATIVE_CLIENT } = require('./constants');

/**
 * Wire processed fill tracking into the manager and processed fill store.
 * Establishes the bidirectional link between the runtime's processed fill store
 * and the OrderManager's processed fill tracker.
 * @param {import('./dexbot_class').DEXBot} bot
 */
function wireProcessedFillTracking(bot) {
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
async function flushProcessedFillPersistence(bot, reason = 'manual', options = {}) {
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
async function flushProcessedFillPersistenceForKeys(bot, fillKeys, reason = 'manual-selected', options = {}) {
    bot._processedFillStore.setShuttingDown(bot._shuttingDown);
    await bot._processedFillStore.flushKeys(fillKeys, reason, options);
}

/**
 * Discard pending processed fill writes for specific fill keys from the queue.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string[]|Set<string>} fillKeys - Fill keys to discard
 */
function discardPendingProcessedFillPersistence(bot, fillKeys) {
    bot._processedFillStore.discardKeys(fillKeys);
}

/**
 * Build a degraded orphan fill replay key when the standard fill history id is missing.
 * The fallback key is derived from order_id, block_num, pays/receives amounts and asset IDs.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {import('./types').FillEvent} fill - Raw fill event
 * @returns {string|null} Orphan fallback key or null if insufficient data
 */
function buildOrphanFillFallbackKey(bot, fill) {
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
async function applyReplaySafeFillAccounting(bot, fill, fillOp, {
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
async function applyReplaySafeTrackedFillAccounting(bot, fill, fillOp, {
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
        missingKeyMessage: (op) => `[${context}] Missing fill history id for ${op.order_id}; deferring to open-orders sync`,
        replayMessage,
        errorMessage: (op, _fill, err) => `[${context}] Failed to process accounting for ${op.order_id}: ${err.message}`,
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
async function applyReplaySafeOrphanFillAccounting(bot, fill, fillOp, {
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
        missingKeyMessage: (op) => `[${context}] Missing fill history id and orphan fallback key for ${op.order_id}; deferring to open-orders sync`,
        fallbackKeyMessage: (op) => `[${context}] Missing fill history id for orphan fill ${op.order_id}; using degraded orphan replay key for proceeds-only accounting`,
        replayMessage,
        errorMessage: (op, _fill, err) => `[${context}] Failed to process accounting for ${op.order_id}: ${err.message}`,
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
function createFillCallback(bot, chainOrders) {
    return async (fills) => {
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
            bot._consumeFillQueue(chainOrders).catch(err => {
                bot._warn(`Fill queue consume failed: ${err.message}`);
            });
        }
    };
}

export = {
    wireProcessedFillTracking,
    flushProcessedFillPersistence,
    flushProcessedFillPersistenceForKeys,
    discardPendingProcessedFillPersistence,
    buildOrphanFillFallbackKey,
    applyReplaySafeFillAccounting,
    applyReplaySafeTrackedFillAccounting,
    applyReplaySafeOrphanFillAccounting,
    createFillCallback
};
