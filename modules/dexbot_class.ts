/**
 * modules/dexbot_class.ts - DEXBot Core Engine
 *
 * Core trading bot implementation shared by bot.ts (single) and dexbot.ts (multi-bot).
 * Implements complete grid trading bot lifecycle.
 *
 * Responsibilities:
 * - Bot initialization and account setup
 * - Order placement and batch operations
 * - Fill processing and synchronization
 * - Grid rebalancing and order rotation
 * - Divergence detection and correction
 * - State persistence and recovery
 * - Market monitoring and health checks
 *
 * ===============================================================================
 * CORE CLASS: DEXBot
 * ===============================================================================
 *
 * LIFECYCLE METHODS:
 *   - constructor(config) - Initialize bot with configuration
 *   - run() - Start bot operation loop
 *   - shutdown() - Graceful shutdown
 *
 * FILL PROCESSING:
 *   - processFills() - Handle fill events
 *
 * SYNCHRONIZATION:
 *   - reconcileGrid() - Reconcile grid state with blockchain
 *
 * MONITORING:
 *   - monitorHealth() - Check bot health status
 *
 * ===============================================================================
 *
 * HELPER FUNCTIONS (module-level):
 *   - normalizeBotEntry() - Normalize bot configuration object
 *
 * ===============================================================================
 *
 * STATE MANAGEMENT:
 * - Internal OrderManager maintains all state
 * - Persists grid snapshots to profiles/orders/{botKey}.json
 * - Recovers from persisted state on startup
 * - Real-time synchronization with blockchain
 *
 * ERROR HANDLING:
 * - Graceful error recovery
 * - Automatic reconnection on connection loss
 * - Anomaly detection and correction
 * - Detailed logging for debugging
 *
 * ===============================================================================
 */

const { path } = require('./path_api');
const { BitShares, waitForConnected, onReconnect: registerReconnectHook } = require('./bitshares_client');
const { getStorage } = require('./storage');
const storage = getStorage();
const chainKeys = require('./chain_keys');
const { getKeyStore } = require('./key_store');
const chainOrders = require('./chain_orders');
const fundRegistry = require('./fund_registry');
const { OrderManager, grid: Grid } = require('./order');
const {
    retryPersistenceIfNeeded,
    initializeFeeCache,
} = require('./order/utils/system');
const {
    hasExecutableActions,
} = require('./order/utils/validate');
const {
    virtualizeOrder,
    correctAllPriceMismatches,
    buildFillKey,
    parseChainOrder
} = require('./order/utils/order');
const {
    ProcessedFillStore,
    PROCESSED_FILL_PERSISTENCE_MODES
} = require('./order/processed_fill_store');
const DexbotFillRuntime = require('./dexbot_fill_runtime');
const DexbotMaintenanceRuntime = require('./dexbot_maintenance_runtime');
const CreditRuntime = require('./credit_runtime');
const {
    ORDER_STATES,
    ORDER_TYPES,
    TIMING,
    GRID_LIMITS,
    MAINTENANCE,
    FILL_PROCESSING,
    DAEMON_CODES,
} = require('./constants');
const { PATHS, getRecalculateTriggerFile } = require('./paths');
const { attemptResumePersistedGridByPriceMatch, decideStartupGridAction, reconcileGridOrders } = require('./order/grid_reconcile');
const { AccountOrders } = require('./account_orders');
const { parseJsonWithComments } = require('./order/utils/system');
const { cloneWeightDistribution } = require('./order/utils/math');
const { normalizeBotEntry } = require('./bot_settings');
const Format = require('./order/format');
const { resolveBotRuntimeSettings } = require('./runtime_settings');

const cowRuntime = require('./dexbot_cow_runtime');

const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const PROFILES_DIR = PATHS.PROFILES_DIR;

class DEXBot {
    config: any;
    _baseWeightDistribution: { sell: number; buy: number };
    account: any;
    accountId: string | null = null;
    privateKey: any;
    manager: any;
    accountOrders: any;
    triggerFile: string;
    _recentlyQueuedFills: Map<any, any>;
    _fillCleanupCounter: number;
    _fillDedupeWindowMs: number;
    _fillRecordRetentionMs: number;
    _processedFillPersistBatchMs: number;
    _processedFillPersistBatchSize: number;
    _processedFillStore: any;
    _recentlyProcessedFills: any;
    _pendingProcessedFillWrites: any;
    _incomingFillQueue: any[];
    logPrefix: string;
    _credentialDaemonWatchdogInterval: any;
    _credentialDaemonDown: boolean;
    _credentialRecoveryNeeded: boolean;
    _credentialRecoveryInFlight: boolean;
    _credentialDaemonWatchdogInFlight: boolean;
    _staleCleanedOrderIds: Map<string, number>;
    _staleCleanupRetentionMs: number;
    _metrics: any;
    _shuttingDown: boolean;
    _shutdownPromise: Promise<void> | null;
    _blockchainFetchInterval: any;
    _blockchainFetchInFlight: boolean;
    _fillsUnsubscribe: any;
    _triggerWatcher: any;
    _triggerDebounceTimer: any;
    _deferredGridResyncTimer: any;
    _maintenanceIdleTimer: any;
    _mainLoopActive: boolean;
    _mainLoopPromise: any;
    _creditRuntime: any;
    _creditWatchdogInterval: any;
    _batchInFlight: boolean;
    _recoverySyncInFlight: boolean;
    _lastTargetedDriftSyncAt: number;
    _lightweightSyncCheckAt: number;
    _targetedDriftSyncCooldownMs: number;
    _maintenanceCooldownCycles: number;
    _lastGridActivityAt: number;
    _currentCycleId: number;
    _autoCancelOrphanCycleMarker: number | null;
    _autoCancelOrphanSubCount: number;
    _consecutiveConsumeFailures: number;
    _consumeFailureFirstAt: number;
    _reconnectUnregister: any;
    _credentialRecoveryDeferredTimer: any;
    _structuralGridResyncTimer: any;
    _structuralGridResyncRunning: boolean;
    _ghostOrderCancelAttempted: Set<string> | null;
    _dustHealthCheckTimer: any;
    _lastBroadcastHeartbeatAt: number;
    _lastDeferredDustCount: number;
    _currentBatchId: any;

    /**
     * Create a new DEXBot instance
     * @param {Object} config - Bot configuration from profiles/bots.json
     * @param {Object} options - Optional settings
     * @param {string} options.logPrefix - Prefix for console logs (e.g., "[bot.js]")
     */
    constructor(config, options: { logPrefix?: string } = {}) {
        this._validateStartupConfig(config);

        this.config = config;
        this._baseWeightDistribution = cloneWeightDistribution(config.weightDistribution) || { sell: 0.5, buy: 0.5 };
        this.account = null;
        this.privateKey = null;
        this.manager = null;
        this.accountOrders = null;
        this.triggerFile = getRecalculateTriggerFile(config.botKey);
        this._recentlyQueuedFills = new Map();
        this._fillCleanupCounter = 0;

        const rs = resolveBotRuntimeSettings(this.config);
        this.config.gridLimits = rs.gridLimits;
        this.config.feeParams = rs.feeParams;
        this.config.incrementBounds = rs.incrementBounds;
        this.config.timing = rs.timing;
        this.config.fillProcessing = rs.fillProcessing;
        this.config.pipelineTiming = rs.pipelineTiming;
        this.config.logging = rs.logging;

        this._fillDedupeWindowMs = this.config.timing.FILL_DEDUPE_WINDOW_MS;
        this._fillRecordRetentionMs = this.config.timing.FILL_RECORD_RETENTION_MS;
        this._processedFillPersistBatchMs = TIMING.PROCESSED_FILL_PERSIST_BATCH_MS;
        this._processedFillPersistBatchSize = TIMING.PROCESSED_FILL_PERSIST_BATCH_SIZE;
        this._processedFillStore = new ProcessedFillStore({
            batchMs: this._processedFillPersistBatchMs,
            batchSize: this._processedFillPersistBatchSize,
            warn: (message) => this._warn(message)
        });
        this._recentlyProcessedFills = this._processedFillStore.tracker;
        this._pendingProcessedFillWrites = this._processedFillStore.pendingWrites;

        this._incomingFillQueue = [];
        this.logPrefix = options.logPrefix || '';
        this._credentialDaemonWatchdogInterval = null;
        this._credentialDaemonDown = false;
        this._credentialRecoveryNeeded = false;
        this._credentialRecoveryInFlight = false;
        this._credentialDaemonWatchdogInFlight = false;

        // TTL cache of order IDs freed by stale-order batch cleanup.
        // If an orphan fill arrives for a stale-cleaned order within the retention
        // window, we skip the credit to avoid double-counting freed capital.
        this._staleCleanedOrderIds = new Map();
        this._staleCleanupRetentionMs = Math.max(this._fillDedupeWindowMs || 0, 5 * 60 * 1000);

        // Metrics for monitoring lock contention and fill processing
        this._metrics = {
            fillsProcessed: 0,
            fillProcessingTimeMs: 0,
            batchesExecuted: 0,
            lockContentionEvents: 0,
            maxQueueDepth: 0
        };

        // Shutdown state
        this._shuttingDown = false;
        this._shutdownPromise = null;

        // Runtime handles for graceful lifecycle management
        this._blockchainFetchInterval = null;
        this._blockchainFetchInFlight = false;
        this._fillsUnsubscribe = null;
        this._triggerWatcher = null;
        this._triggerDebounceTimer = null;
        this._deferredGridResyncTimer = null;
        this._maintenanceIdleTimer = null;
        this._mainLoopActive = false;
        this._mainLoopPromise = null;
        this._creditRuntime = null;
        this._creditWatchdogInterval = null;

        // Pipeline state flags (used by maintenance gating)
        this._batchInFlight = false;
        this._recoverySyncInFlight = false;
        this._lastTargetedDriftSyncAt = 0;
        this._lightweightSyncCheckAt = 0;
        this._targetedDriftSyncCooldownMs = this.config.timing.TARGETED_DRIFT_SYNC_COOLDOWN_MS;
        this._maintenanceCooldownCycles = 0;
        this._lastGridActivityAt = 0;
        this._lastDeferredDustCount = 0;
        this._currentCycleId = 0;
        this._autoCancelOrphanCycleMarker = null;
        this._autoCancelOrphanSubCount = 0;
        // Per-session guard: ghost order IDs successfully cancelled
        // (avoids spamming the chain with repeated cancel attempts for the same
        // orphan residual on every fill cycle).
        this._ghostOrderCancelAttempted = null as Set<string> | null;

        // Dust cancellation uses immediate on-chain cancel — no maps or timers needed.
        this._dustHealthCheckTimer = null;

        // Fill consumer watchdog: consecutive failure tracking.
        // Reset on successful consumption; above _maxConsumeFailures, the
        // re-schedule backs off and logs CRITICAL.
        this._consecutiveConsumeFailures = 0;
        this._consumeFailureFirstAt = 0;
    }

    /**
     * Validate startup configuration to catch errors early.
     * Ensures critical values are valid before bot starts.
     * @param {Object} config - Configuration object to validate
     * @throws {Error} If critical validation fails
     * @private
     */
    _validateStartupConfig(config) {
        const errors = [];

        // Skip trading field validation in credit-only mode
        if (!config.creditOnly) {
            // Validate startPrice is numeric or valid string mode
            const startPrice = config.startPrice;
            const validPriceModes = ['pool', 'book'];
            const isPriceNumeric = typeof startPrice === 'number' && Number.isFinite(startPrice) && startPrice > 0;
            const isPriceMode = typeof startPrice === 'string' && validPriceModes.includes(startPrice.toLowerCase());
            if (!isPriceNumeric && !isPriceMode) {
                errors.push(`startPrice must be a positive number or valid mode (${validPriceModes.join('/')}), got: ${startPrice}`);
            }

            // Validate assetA and assetB are present
            if (!config.assetA || typeof config.assetA !== 'string') {
                errors.push(`assetA must be a non-empty string, got: ${config.assetA}`);
            }
            if (!config.assetB || typeof config.assetB !== 'string') {
                errors.push(`assetB must be a non-empty string, got: ${config.assetB}`);
            }

            // Validate incrementPercent
            const increment = config.incrementPercent;
            if (!Number.isFinite(increment) || increment <= 0 || increment > 100) {
                errors.push(`incrementPercent must be between 0 and 100, got: ${increment}`);
            }
        }

        // Throw all validation errors at once
        if (errors.length > 0) {
            throw new Error(`Config validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
        }
    }

    /**
     * Log a message to the console with the bot's prefix.
     * @param {string} msg - The message to log.
     * @param {string} [level='info'] - The log level ('debug', 'info', 'warn', 'error').
     * @private
     */
    _log(msg, level = 'info') {
        if (level === 'warn') {
            this._warn(msg);
            return;
        }

        const line = this.logPrefix ? `${this.logPrefix} ${msg}` : msg;
        const logger = this.manager?.logger;
        if (logger && typeof logger.log === 'function') {
            logger.log(line, level);
            return;
        }
        if (level === 'error') {
            console.error(line);
            return;
        }

        console.log(line);
    }

    /**
     * Log a warning message to the console with the bot's prefix.
     * @param {string} msg - The message to log.
     * @private
     */
    _warn(msg) {
        const line = this.logPrefix ? `${this.logPrefix} ${msg}` : msg;
        const logger = this.manager?.logger;
        if (logger && typeof logger.log === 'function') {
            logger.log(line, 'warn');
            return;
        }
        if (this.logPrefix) {
            console.warn(line);
        } else {
            console.warn(msg);
        }
    }

    /**
     * Persist the grid and trigger immediate recovery if validation fails.
     * Used during startup to ensure bot begins in a stable state.
     * @private
     */
    async _persistAndRecoverIfNeeded() {
        this.manager._recentFillKeysSnapshot = this._getRecentFillKeysSnapshot();
        const validation = await this.manager.persistGrid();
        if (!validation.isValid) {
            this._warn(`Startup validation failed: ${validation.reason}. Triggering immediate recovery...`);
            // Trigger centralized recovery (Hard Reset)
            const recoveryValidation = await this.manager.accountant._performStateRecovery(this.manager);
            if (recoveryValidation.isValid) {
                this._log(`✓ Startup recovery successful. Persistent state restored.`);
                this.manager._recentFillKeysSnapshot = this._getRecentFillKeysSnapshot();
                await this.manager.persistGrid();
            } else {
                this._warn(`Startup recovery failed: ${recoveryValidation.reason}. Bot proceeding with caution.`);
            }
        }
    }

    /**
     * Snapshot the recently queued fill keys as a plain object for crash-durable persistence.
     * Merges with any existing snapshot to avoid losing keys that were evicted from the
     * in-memory map between persist cycles but remain within the dedup window.
     * Only includes entries within the dedup window to avoid writing stale keys.
     * @returns {Record<string, number>}
     */
    _getRecentFillKeysSnapshot() {
        const snapshot = {};
        const now = Date.now();
        // 1. Collect live keys from the in-memory map
        for (const [key, timestamp] of this._recentlyQueuedFills) {
            if (now - Number(timestamp) < this._fillDedupeWindowMs) {
                snapshot[key] = Number(timestamp);
            }
        }
        // 2. Merge with the previous snapshot — carry forward any keys that
        //    were present in a prior persist cycle, are still within the
        //    dedup window, but have been evicted from _recentlyQueuedFills
        //    (e.g. by TTL-based pruning between two persistGrid calls).
        //    This prevents a crash + restart from losing keys that were
        //    processed but not yet persisted.
        if (this.manager?._recentFillKeysSnapshot) {
            for (const [key, timestamp] of Object.entries(this.manager._recentFillKeysSnapshot)) {
                if (!(key in snapshot) && now - Number(timestamp) < this._fillDedupeWindowMs) {
                    snapshot[key] = Number(timestamp);
                }
            }
        }
        return snapshot;
    }

    /**
     * Get current pipeline signal state for congestion checks.
     * @returns {{incomingFillQueueLength: number, shadowLocks: number, batchInFlight: boolean, recoveryInFlight: boolean, broadcasting: boolean}}
     */
    _getPipelineSignals() {
        this.manager?._cleanExpiredLocks?.();
        return {
            incomingFillQueueLength: this._incomingFillQueue.length,
            shadowLocks: this.manager?.shadowOrderIds?.size || 0,
            batchInFlight: this._batchInFlight,
            recoveryInFlight: this._recoverySyncInFlight,
            broadcasting: this.manager?.isBroadcastingActive?.() || false
        };
    }

    /**
     * Mark that grid activity occurred (updates idle timer).
     * @param {string} [reason='activity'] - Reason for activity
     * @returns {void}
     */
    _markGridActivity(reason = 'activity') {
        this._lastGridActivityAt = Date.now();
        this.manager?.logger?.log?.(`[MAINT-IDLE] Activity observed: ${reason}`, 'debug');
    }

    /**
     * Trigger a full state recovery sync (fetch chain + sync from open orders + persist).
     * @param {string} [reason='state recovery sync'] - Reason for recovery
     * @returns {Promise<void>}
     */
    async _triggerStateRecoverySync(reason = 'state recovery sync') {
        if (!this.manager) return;

        if (this._recoverySyncInFlight) {
            this.manager.logger.log(`[RECOVERY] Skipping duplicate recovery request: ${reason}`, 'warn');
            return;
        }

        this._recoverySyncInFlight = true;
        try {
            this.manager.logger.log(`Triggering state recovery sync (${reason})...`, 'info');
            await this.manager.fetchAccountTotals(this.accountId);
            const openOrders = await chainOrders.readOpenOrders(this.accountId);
            await this.manager.syncFromOpenOrders(openOrders, { skipAccounting: true });
            if (typeof this.manager.persistGrid === 'function') {
                await this.manager.persistGrid();
            }
        } finally {
            this._recoverySyncInFlight = false;
        }
    }

    /**
     * Abort the current flow if an illegal state signal was raised.
     * @param {string} flowContext - Description of the flow being aborted
     * @returns {Promise<boolean>} True if flow was aborted
     */
    async _abortFlowIfIllegalState(flowContext) {
        const illegalSignal = this.manager?.consumeIllegalStateSignal?.();
        if (!illegalSignal) {
            return false;
        }

        this.manager.logger.log(
            `[HARD-ABORT] ${flowContext} aborted due to illegal state (${illegalSignal.context}): ${illegalSignal.message}`,
            'error'
        );
        await this._triggerStateRecoverySync(`hard-abort ${flowContext}`);
        this._maintenanceCooldownCycles = Math.max(this._maintenanceCooldownCycles, 1);
        return true;
    }

    /**
     * Handle a hard abort from batch processing due to illegal state or accounting failure.
     * @param {Error} err - The error that triggered the abort
     * @param {string} [phase='batch processing'] - Phase description
     * @param {number} [opsCount=0] - Number of operations in the batch
     * @returns {Promise<Object>} Abort result object
     */
    async _handleBatchHardAbort(err, phase = 'batch processing', opsCount = 0) {
        const baseResult = { executed: false, hadRotation: false };
        const opsInfo = opsCount > 0 ? ` with ${opsCount} ops` : '';

        if (err?.code === 'ILLEGAL_ORDER_STATE') {
            const illegalSignal = this.manager.consumeIllegalStateSignal?.();
            await this._triggerStateRecoverySync(illegalSignal?.message || `illegal order state during ${phase}${opsInfo}`);
            this._maintenanceCooldownCycles = Math.max(this._maintenanceCooldownCycles, 1);
            return { ...baseResult, abortedForIllegalState: true };
        }

        if (err?.code === 'ACCOUNTING_COMMITMENT_FAILED') {
            const accountingSignal = this.manager.consumeAccountingFailureSignal?.();
            const reason = accountingSignal
                ? `accounting lock failure (${accountingSignal.side} ${Format.formatAmount8(accountingSignal.amount)}) during ${accountingSignal.context}`
                : `accounting commitment lock failure during ${phase}${opsInfo}`;
            await this._triggerStateRecoverySync(reason);
            this._maintenanceCooldownCycles = Math.max(this._maintenanceCooldownCycles, 1);
            return { ...baseResult, abortedForAccountingFailure: true };
        }

        return null;
    }

    /**
     * Apply recoverable grid updates (order virtualisation) after a batch failure.
     * @param {Array<Object>} updates - Array of order update objects
     * @param {string} [context='recoverable-grid-update'] - Context label for logging
     * @returns {Promise<number>} Number of updates applied
     */
    async _applyRecoverableGridUpdates(updates, context = 'recoverable-grid-update') {
        if (!this.manager || !Array.isArray(updates) || updates.length === 0) {
            return 0;
        }

        let applied;
        if (typeof this.manager.applyGridUpdateBatch === 'function') {
            await this.manager.applyGridUpdateBatch(updates, context);
            applied = updates.length;
        } else {
            applied = 0;
            for (const update of updates) {
                if (typeof this.manager._updateOrder !== 'function') break;
                await this.manager._updateOrder(update, context);
                applied++;
            }
        }

        // Persist master grid mutations applied outside COW (stale-order
        // virtualization, size-drift corrections). These run in the COW catch
        // handler where the success-path persistGrid is never reached.
        if (applied > 0 && typeof this.manager.persistGrid === 'function') {
            await this.manager.persistGrid();
        }

        return applied;
    }

    /**
     * Recover from explicit stale order errors by virtualizing affected grid slots.
     * @param {Set<string>|string[]} staleOrderIds - Set or array of stale chain order IDs
     * @param {string} [reason='stale order cleanup'] - Reason for cleanup
     * @returns {Promise<{executed: boolean, hadRotation: boolean, stale: boolean, recoveredByVirtualization?: boolean}>}
     */
    async _recoverExplicitStaleOrders(staleOrderIds, reason = 'stale order cleanup') {
        const staleIds = Array.from(staleOrderIds || []).filter(Boolean) as string[];
        if (staleIds.length === 0) {
            return { executed: false, hadRotation: false, stale: false };
        }

        this.manager.logger.log(
            `[COW] Stale order(s) detected: ${staleIds.join(', ')}. Applying targeted cleanup.`,
            'warn'
        );

        const updates = [];

        for (const [, gridOrder] of this.manager.orders.entries()) {
            if (!gridOrder?.orderId || !staleOrderIds.has(gridOrder.orderId)) continue;
            this._staleCleanedOrderIds.set(gridOrder.orderId, Date.now());
            updates.push({ ...virtualizeOrder(gridOrder), size: 0 });
        }

        // Register any stale IDs that had no matching grid slot
        for (const orderId of staleIds) {
            if (!this._staleCleanedOrderIds.has(orderId)) {
                this._staleCleanedOrderIds.set(orderId, Date.now());
            }
        }

        if (updates.length > 0) {
            await this._applyRecoverableGridUpdates(updates, reason);
        } else {
            this.manager.logger.log(
                `[COW] No local grid slot matched stale order cleanup request (${staleIds.join(', ')}).`,
                'debug'
            );
        }

        return {
            executed: false,
            hadRotation: false,
            stale: true,
            recoveredByVirtualization: updates.length > 0
        };
    }

    /**
     * Recover from on-chain size drift detected during batch broadcast.
     * @param {Error} err - The size drift error
     * @returns {Promise<{executed: boolean, hadRotation: boolean, recoveredBySync: boolean, reason: string}>}
     */
    async _recoverBatchSizeDrift(err, opContexts = []) {
        // Try a targeted fix first: extract the affected order IDs from the
        // operation contexts and correct them directly from chain.  This
        // avoids a full state recovery sync in the common single-order case.
        const affectedOrderIds = this._extractSizeDriftOrderIds(opContexts);
        if (affectedOrderIds.length > 0) {
            this.manager.logger.log(
                `[COW] Targeted size-drift repair for ${affectedOrderIds.length} order(s): ${affectedOrderIds.join(', ')}`,
                'debug'
            );
            const repaired = await this._targetedOrderRepair(affectedOrderIds);
            if (repaired) {
                return {
                    executed: false,
                    hadRotation: false,
                    recoveredBySync: true,
                    reason: 'ORDER_SIZE_DRIFT_TARGETED'
                };
            }
            this.manager.logger.log(
                '[COW] Targeted repair failed, falling back to full state recovery sync.',
                'warn'
            );
        }

        const reason = `recoverable size drift during COW batch: ${err.message}`;
        this.manager.logger.log(
            `[COW] Recovering from on-chain size drift via recovery sync: ${err.message}`,
            'warn'
        );
        await this._triggerStateRecoverySync(reason);
        return {
            executed: false,
            hadRotation: false,
            recoveredBySync: true,
            reason: 'ORDER_SIZE_DRIFT'
        };
    }

    /**
     * Extract chain order IDs from opContexts for operations that could
     * trigger a size-drift error (size-update and rotation update).
     * @param {Array<Object>} opContexts
     * @returns {string[]} Unique chain order IDs
     */
    _extractSizeDriftOrderIds(opContexts) {
        if (!Array.isArray(opContexts)) return [];
        const ids = new Set();
        for (const ctx of opContexts) {
            if (ctx?.kind === 'size-update' && ctx?.updateInfo?.partialOrder?.orderId) {
                ids.add(ctx.updateInfo.partialOrder.orderId);
            } else if (ctx?.kind === 'rotation' && ctx?.rotation?.oldOrder?.orderId) {
                ids.add(ctx.rotation.oldOrder.orderId);
            }
        }
        return Array.from(ids);
    }

    /**
     * Reload the entire grid from the persisted on-disk snapshot and reconcile
     * with current chain state. Mirrors the startup recovery path.
     *
     * LOCK SAFETY: Does NOT acquire _fillProcessingLock. Caller must either
     * hold it already or accept concurrent fill-processing risk — matches
     * the startup pattern at line ~1340.
     *
     * @returns {Promise<{success: boolean, reason?: string}>}
     */
    async _recoverFromPersistedGrid() {
        if (!this.accountOrders || !this.manager) {
            return { success: false, reason: 'accountOrders or manager unavailable' };
        }

        const accountRef = this.accountId || this.account?.id || this.account;
        if (!accountRef) {
            return { success: false, reason: 'no account reference' };
        }

        this.manager.logger.log('[RECOVERY] Attempting full grid reload from persisted snapshot...', 'warn');

        try {
            // 1. Force reload from disk
            const persistedGrid = this.accountOrders.loadGrid(true);
            if (!persistedGrid || persistedGrid.length === 0) {
                return { success: false, reason: 'no persisted grid on disk' };
            }

            const boundaryIdx = this.accountOrders.loadBoundaryIdx(true);

            // 2. Load into manager (same path as startup at line 1340)
            await Grid.loadGrid(this.manager, persistedGrid, boundaryIdx);

            // Gap 1: Grid snapshot sanity check — shared logic with startup path.
            if (await this._rejectCorruptedGridSnapshot('recovery')) {
                return { success: false, reason: 'corrupted grid snapshot rejected (fund drift)' };
            }

            // 3. Read current chain state
            const chainOpenOrders = await chainOrders.readOpenOrders(accountRef);

            // 4. Reconcile
            if (chainOpenOrders.length > 0 && this.manager?.syncFromOpenOrders) {
                    await this.manager.syncFromOpenOrders(chainOpenOrders, {
                        skipAccounting: true,
                    });
            }

            // 5. Persist the reconciled state
            if (typeof this.manager.persistGrid === 'function') {
                await this.manager.persistGrid();
            }

            const assets = this.manager?.assets;
            const matchedCount = assets
                ? chainOpenOrders.filter(o => parseChainOrder(o, assets) !== null).length
                : chainOpenOrders.length;
            this.manager.logger.log(
                `[RECOVERY] Grid reloaded from persisted snapshot: ${this.manager.orders.size} orders, ` +
                `${matchedCount} on-chain orders synced`,
                'info'
            );

            // Gap 2: Check for unmatched chain orders after reload + sync.
            // If the sync resolved all unmatched entries, _lastUnmatchedChainOrders
            // was cleared by the sync engine. If any remain, the persisted snapshot
            // produced an inconsistent grid — reject so the structural resync
            // falls through to requestGridReset (full rebuild from chain).
            const remainingUnmatched = Array.isArray(this.manager?._lastUnmatchedChainOrders)
                ? this.manager._lastUnmatchedChainOrders
                : [];
            if (remainingUnmatched.length > 0) {
                const sample = remainingUnmatched.slice(0, 3)
                    .map(o => this._formatUnmatchedChainOrderForLog(o))
                    .join(' | ');
                this.manager.logger.log(
                    `[RECOVERY] Persisted grid reloaded but ${remainingUnmatched.length} unmatched chain order(s) ` +
                    `remain${sample ? ` (${sample})` : ''}. Rejecting — full grid reset required.`,
                    'warn'
                );
                return { success: false, reason: `grid inconsistent after reload: ${remainingUnmatched.length} unmatched remain` };
            }

            // If the reloaded grid is still bloated, reject recovery so the
            // caller falls through to a full grid reset (requestGridReset).
            // Without this check, a bloated snapshot gets accepted as "success"
            // and the structural-resync loop loads the same broken state forever.
            //
            // NOTE: loadGrid() already fires requestStructuralGridResync when it
            // detects bloat internally, so the inner async resync may be in flight
            // by the time this outer check runs. That's fine — the structural-resync
            // gate (_structuralGridResyncRunning / _structuralGridResyncTimer) dedup's
            // concurrent requests. This outer check exists so the synchronous return
            // value is honest about the state; the inner resync is a safety net.
            const { isGridBloated } = require('./order/grid');
            const ordersArr = Array.from(this.manager.orders.values());
            const bloatPostRecovery = isGridBloated(this.manager, ordersArr);
            if (bloatPostRecovery.bloated) {
                const d = bloatPostRecovery.details;
                this.manager.logger.log(
                    `[RECOVERY] Persisted grid reloaded but still bloated ` +
                    `(${d.gridSize} slots, max ${d.maxAllowed}). Rejecting — full grid reset required.`,
                    'warn'
                );
                return { success: false, reason: 'grid still bloated after reload' };
            }

            return { success: true };
        } catch (err: any) {
            this.manager.logger.log(
                `[RECOVERY] Full grid reload from persisted snapshot failed: ${err.message}`,
                'error'
            );
            return { success: false, reason: err.message };
        }
    }

    /**
     * Reject a corrupted grid snapshot when catastrophic fund drift is detected.
     * Shared between startup and recovery paths to avoid duplicating the
     * drift-ratio math and snapshot-clearing logic.
     *
     * @param {'startup'|'recovery'} context - Controls log prefix.
     * @returns {Promise<boolean>} True if the snapshot was rejected (cleared).
     */
    async _rejectCorruptedGridSnapshot(context) {
        if (!this.manager?.checkFundDriftAfterFills) return false;
        const driftCheck = this.manager.checkFundDriftAfterFills();
        if (driftCheck.isValid) return false;

        const tag = context === 'recovery' ? '[RECOVERY][SNAPSHOT-REJECT]' : '[SNAPSHOT-REJECT]';
        this._warn(
            `${tag} Corrupted grid snapshot detected: ` +
            `drift sell=${driftCheck.driftSell.toFixed(2)} buy=${driftCheck.driftBuy.toFixed(2)}. ` +
            `Deleting corrupted snapshot.`
        );
        if (this.accountOrders && typeof this.accountOrders.clearGrid === 'function') {
            try {
                await this.accountOrders.clearGrid();
                this._warn(`${tag} Corrupted grid snapshot deleted.`);
            } catch (clearErr) {
                this._warn(`${tag} Failed to delete corrupted snapshot: ${clearErr.message}`);
            }
        }
        return true;
    }

    /**
     * Attempt to repair size-drift for specific order IDs by reading their
     * current on-chain state and correcting the local grid directly.
     * Falls back gracefully (returns false) on any error.
     * @param {string[]} orderIds
     * @returns {Promise<boolean>} True if all affected orders were repaired
     */
    async _targetedOrderRepair(orderIds) {
        try {
            const objects = await BitShares.db.get_objects(orderIds);
            if (!Array.isArray(objects) || objects.length !== orderIds.length) return false;

            const updates = [];
            for (let i = 0; i < orderIds.length; i++) {
                const chainOrder = objects[i];
                const gridOrder = (Array.from(this.manager.orders.values()) as any[])
                    .find((o: any) => o.orderId === orderIds[i]);
                if (!gridOrder) continue;

                if (!chainOrder || typeof chainOrder.for_sale === 'undefined') {
                    // Order no longer exists on chain -> fully filled or cancelled.
                    updates.push({ ...virtualizeOrder(gridOrder), size: 0 });
                } else {
                    const chainUnits = Number(chainOrder.for_sale);
                    if (Number.isFinite(chainUnits)) {
                        const { blockchainToFloat } = require('./order/utils/math');
                        const prec = gridOrder.type === ORDER_TYPES.SELL
                            ? this.manager.assets.assetA.precision
                            : this.manager.assets.assetB.precision;
                        const floatSize = blockchainToFloat(chainUnits, prec);
                        if (floatSize !== gridOrder.size) {
                            updates.push({
                                id: gridOrder.id,
                                size: floatSize,
                                rawOnChain: chainOrder,
                            });
                        }
                    }
                }
            }

            if (updates.length > 0) {
                await this._applyRecoverableGridUpdates(updates, 'targeted-size-drift-repair');
            }
            return true;
        } catch (err) {
            this.manager.logger.log(
                `[COW] Targeted order repair failed: ${err.message}`,
                'debug'
            );
            return false;
        }
    }

    /**
     * Initialize bot state from storage and blockchain.
     * Consolidates common initialization logic for start() and startWithPrivateKey().
     * @returns {{persistedGrid: Object, persistedBtsFeesOwed: number, persistedBoundaryIdx: number, persistedBtsBalance: number}}
     * @private
     */
    async _initializeStartupState() {
        // Create AccountOrders with bot-specific file (one file per bot)
        this.accountOrders = new AccountOrders({ botKey: this.config.botKey });
        this._processedFillStore.configure({
            accountOrders: this.accountOrders
        });

        // Load persisted processed fills to prevent reprocessing after restart
        const loadedPersistedFills = this._processedFillStore.loadPersisted({
            minTimestamp: Date.now() - this._fillRecordRetentionMs
        });
        if (loadedPersistedFills > 0) {
            this._log(`Loaded ${loadedPersistedFills} persisted fill records to prevent reprocessing`);
        }

        // Ensure bot metadata is properly initialized in storage BEFORE any Grid operations
        const raw = storage.readFile(PROFILES_BOTS_FILE);
        const allBotsConfig = parseJsonWithComments(raw).bots || [];
        const myBotConfig = allBotsConfig
            .map((b, originalIdx) => b.active !== false ? normalizeBotEntry(b, originalIdx) : null)
            .find(b => b && b.botKey === this.config.botKey);

        if (myBotConfig) {
            await this.accountOrders.syncMeta(myBotConfig);
        }

        if (!this.manager) {
            const mgrLogFile = this.config?.name ? path.join(PATHS.LOGS_DIR, `${this.config.name}.log`) : undefined;
            this.manager = new OrderManager({ ...this.config, logFile: mgrLogFile });
            this.manager.account = this.account;
            this.manager.accountId = this.accountId;
            this.manager.accountOrders = this.accountOrders;
        }
        this._wireStructuralGridResyncRequest();
        this._wireProcessedFillTracking();
        this.manager.startBootstrap();
        try {
            // Fetch account totals from blockchain at startup to initialize funds
            try {
                if (this.accountId && this.config.assetA && this.config.assetB) {
                    await this.manager._initializeAssets();
                    await this.manager.fetchAccountTotals(this.accountId);
                    this._log('Fetched blockchain account balances at startup');
                }
            } catch (err: any) {
                this._log(`Startup balance fetch FAILED: ${err.message}. Order sizing may be incorrect until next successful sync.`, 'error');
            }

            // Ensure fee cache is initialized before any fill processing that calls getAssetFees().
            try {
                await initializeFeeCache([this.config || {}], BitShares);
            } catch (err: any) {
                this._log(`Fee cache initialization FAILED: ${err.message}. Fee calculations will use defaults until cache is refreshed.`, 'error');
            }

            const persistedGrid = this.accountOrders.loadGrid();

            // CRITICAL REPAIR: Strip fake orderIds where orderId === id (e.g. "slot-0")
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
                    this._log(`[REPAIR] Stripped ${repairCount} fake orderId(s) from persisted grid to restore rebalancing logic.`);
                }
            }

            const persistedBtsFeesOwed = this.accountOrders.loadBtsFeesOwed();
            const persistedBoundaryIdx = this.accountOrders.loadBoundaryIdx();
            const persistedBtsBalance = this.accountOrders.loadBtsBalance();
            const persistedRecentFillKeys = this.accountOrders.loadRecentFillKeys();

            return {
                persistedGrid: repairedGrid,
                persistedBtsFeesOwed,
                persistedBoundaryIdx,
                persistedBtsBalance,
                persistedRecentFillKeys,
            };
        } finally {
            this.manager.finishBootstrap();
        }
    }

    /**
     * Wire processed fill tracking into the manager.
     * @returns {void}
     */
    _wireProcessedFillTracking() {
        return DexbotFillRuntime.wireProcessedFillTracking(this);
    }

    /**
     * Flush pending processed fill persistence to disk.
     * @param {string} [reason='manual'] - Reason for flushing
     * @param {Object} [options={}] - Flush options
     * @returns {Promise<void>}
     */
    async _flushProcessedFillPersistence(reason = 'manual', options = {}) {
        return DexbotFillRuntime.flushProcessedFillPersistence(this, reason, options);
    }

    /**
     * Flush persistence for specific fill keys.
     * @param {Set<string>|string[]} fillKeys - Fill keys to persist
     * @param {string} [reason='manual-selected'] - Reason for flushing
     * @param {Object} [options={}] - Flush options
     * @returns {Promise<void>}
     */
    async _flushProcessedFillPersistenceForKeys(fillKeys, reason = 'manual-selected', options = {}) {
        return DexbotFillRuntime.flushProcessedFillPersistenceForKeys(this, fillKeys, reason, options);
    }

    /**
     * Discard pending persistence for specific fill keys.
     * @param {string[]|Set<string>} fillKeys - Fill keys to discard
     * @returns {void}
     */
    _discardPendingProcessedFillPersistence(fillKeys) {
        return DexbotFillRuntime.discardPendingProcessedFillPersistence(this, fillKeys);
    }

    /**
     * Build a fallback deduplication key for an orphan fill (when standard keys are unavailable).
     * @param {Object} fill - Fill event object
     * @returns {string|null} Fallback key or null
     */
    _buildOrphanFillFallbackKey(fill) {
        return DexbotFillRuntime.buildOrphanFillFallbackKey(this, fill);
    }

    _isNewFillKey(fillKey, processedFillKeys, label = '', orderId = '') {
        const now = Date.now();
        if (this._recentlyQueuedFills.has(fillKey)) {
            const lastProcessed = this._recentlyQueuedFills.get(fillKey);
            if (now - lastProcessed < this._fillDedupeWindowMs) {
                if (label) {
                    const idSuffix = orderId ? ` for ${orderId}` : '';
                    this.manager?.logger?.log?.(
                        `${label} Skipping duplicate fill${idSuffix} (processed ${now - lastProcessed}ms ago)`, 'debug');
                }
                return false;
            }
        }
        if (processedFillKeys.has(fillKey)) return false;
        processedFillKeys.add(fillKey);
        this._recentlyQueuedFills.set(fillKey, now);
        return true;
    }

    /**
     * Apply replay-safe fill accounting using a provided fill key.
     * @param {Object} fill - Fill event object
     * @param {import('./types').FillOperationData} fillOp - Fill operation data
     * @param {Object} [options={}] - Options
     * @param {string} [options.missingKeyMessage]
     * @param {string} [options.fallbackKeyMessage]
     * @param {string} [options.replayMessage]
     * @param {string} [options.errorMessage]
     * @param {Object} [options.logger]
     * @param {string} [options.missingKeyLevel='warn']
     * @param {string} [options.fallbackKeyLevel='warn']
     * @param {string} [options.replayLevel='debug']
     * @param {string} [options.persistenceMode='immediate']
     * @param {boolean} [options.allowOrphanFallbackKey=false]
     * @returns {Promise<import('./types').ReplaySafeFillResult>}
     */
    async _applyReplaySafeFillAccounting(fill, fillOp, {
        missingKeyMessage,
        fallbackKeyMessage,
        replayMessage,
        errorMessage,
        logger = this.manager?.logger,
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
        return DexbotFillRuntime.applyReplaySafeFillAccounting(this, fill, fillOp, {
            missingKeyMessage,
            fallbackKeyMessage,
            replayMessage,
            errorMessage,
            logger,
            missingKeyLevel,
            fallbackKeyLevel,
            replayLevel,
            persistenceMode,
            allowOrphanFallbackKey
        });
    }

    /**
     * Apply replay-safe fill accounting for tracked fills (those with a valid grid order).
     * @param {Object} fill - Fill event object
     * @param {import('./types').FillOperationData} fillOp - Fill operation data
     * @param {Object} [options={}]
     * @param {string} [options.context]
     * @param {Object} [options.logger]
     * @param {string} [options.replayMessage]
     * @param {string} [options.persistenceMode='batched']
     * @returns {Promise<import('./types').ReplaySafeFillResult>}
     */
    async _applyReplaySafeTrackedFillAccounting(fill, fillOp, {
        context,
        logger = this.manager?.logger,
        replayMessage,
        persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
    }: {
        context?: string;
        logger?: any;
        replayMessage?: any;
        persistenceMode?: any;
    } = {}) {
        return DexbotFillRuntime.applyReplaySafeTrackedFillAccounting(this, fill, fillOp, {
            context,
            logger,
            replayMessage,
            persistenceMode
        });
    }

    /**
     * Apply replay-safe fill accounting for orphan fills (grid order not found).
     * @param {Object} fill - Fill event object
     * @param {import('./types').FillOperationData} fillOp - Fill operation data
     * @param {Object} [options={}]
     * @param {string} [options.context]
     * @param {Object} [options.logger]
     * @param {string} [options.replayMessage]
     * @param {string} [options.persistenceMode='batched']
     * @returns {Promise<import('./types').ReplaySafeFillResult>}
     */
    async _applyReplaySafeOrphanFillAccounting(fill, fillOp, {
        context,
        logger = this.manager?.logger,
        replayMessage,
        persistenceMode = PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
    }: {
        context?: string;
        logger?: any;
        replayMessage?: any;
        persistenceMode?: any;
    } = {}) {
        return DexbotFillRuntime.applyReplaySafeOrphanFillAccounting(this, fill, fillOp, {
            context,
            logger,
            replayMessage,
            persistenceMode
        });
    }

    /**
     * Refresh dynamic weight distribution from market adapter.
     * @param {string} [context='runtime'] - Context label for logging
     * @returns {import('./types').DynamicWeightRefreshResult|null}
     */
    _refreshDynamicWeightDistribution(context = 'runtime') {
        return DexbotMaintenanceRuntime.refreshDynamicWeightDistribution(this, context);
    }

    /**
     * Finalize the bot startup after account and initial grid sync are complete.
     * Consolidates common logic for start() and startWithPrivateKey().
     * @param {Object} startupState - The startup state from _initializeStartupState.
     * @private
     */
    async _finishStartupSequence(startupState) {
        let {
            persistedGrid,
            persistedBtsFeesOwed,
            persistedBoundaryIdx,
            persistedBtsBalance,
            persistedRecentFillKeys,
        } = startupState;

        try {
            // CRITICAL: Activate fill listener EARLY - before ANY operations that place orders
            // This ensures fills during trigger reset and grid initialization are captured
            if (typeof this._fillsUnsubscribe === 'function') {
                await this._fillsUnsubscribe().catch(() => { });
            }
            this._fillsUnsubscribe = await chainOrders.listenForFills(this.account || undefined, this._createFillCallback(chainOrders));
            if (typeof this._fillsUnsubscribe !== 'function') {
                this._warn('Fill listener did not provide an unsubscribe handler. Shutdown cleanup may be incomplete.');
                this._fillsUnsubscribe = null;
            }
            this._log('Fill listener activated (ready to process fills during startup)');

            // Register reconnection callback for safety-net sync after websocket reconnect
            if (!this._reconnectUnregister) {
                this._reconnectUnregister = registerReconnectHook(() => {
                    this._log('Blockchain connection re-established; scheduling safety-net sync');
                    const runSafetyNetSync = async () => {
                        if (this.manager && this.accountId && !this._shuttingDown && !this.config.dryRun) {
                            // Cap the entire safety-net sync at TIMING.SAFETY_NET_SYNC_TIMEOUT_MS so it can
                            // never hold _fillProcessingLock longer than the
                            // 20s shutdown lock timeout. readOpenOrders +
                            // synchronizeWithChain + batch + persist can be
                            // ~45s worst case without a cap, which would
                            // stall shutdown until the 20s timeout fires.
                            const safetyNetTimeoutMs = this.config.timing?.SAFETY_NET_SYNC_TIMEOUT_MS;
                            let safetyNetTimer;
                            const workPromise = this.manager._fillProcessingLock.acquire(async () => {
                                if (this._shuttingDown) return;
                                const chainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                                if (this._shuttingDown) return;
                                const syncResult = await this.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                                if (this._shuttingDown) return;
                                if (syncResult?.filledOrders?.length > 0) {
                                    this._refreshDynamicWeightDistribution('post-reconnect sync fill');
                                    this._log(`Post-reconnect sync: ${syncResult.filledOrders.length} grid order(s) found filled.`, 'info');
                                    await this._processFillsWithBatching(syncResult.filledOrders, new Set(), 'post-reconnect sync fill');
                                    if (this._shuttingDown) return;
                                }
                                this.manager._recentFillKeysSnapshot = this._getRecentFillKeysSnapshot();
                                await this.manager.persistGrid();

                                // Cancel any dust created by reconnect fills immediately.
                                if (!this._shuttingDown) {
                                    try {
                                        const reconnectHealth = await this.manager.checkGridHealth(
                                            this.updateOrdersOnChainPlan.bind(this)
                                        );
                                        await this._cancelDustOrders({
                                            buy: reconnectHealth.buyDustOrders,
                                            sell: reconnectHealth.sellDustOrders,
                                        });
                                    } catch (_dustErr: any) {
                                        this._warn(`[RECONNECT] Dust cancel failed: ${_dustErr.message}`);
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
                                    this._log(`Safety-net sync completed despite timeout — ignoring spurious error.`, 'info');
                                } else {
                                    this._warn(`Post-reconnect safety-net sync aborted: ${capErr?.message || capErr}`);
                                }
                            } finally {
                                if (safetyNetTimer) clearTimeout(safetyNetTimer);
                            }
                        }
                    };
                    // The setImmediate callback returns a Promise; we MUST attach
                    // a .catch so a rejection here does not propagate to
                    // process.on('unhandledRejection') and tear down the bot.
                    setImmediate(() => {
                        runSafetyNetSync().catch(err => {
                            try {
                                this._warn('Post-reconnect safety-net sync failed: ' + (err?.message || err));
                            } catch (_warnErr: any) {
                                // _warn itself inaccessible — last line of defense.
                            }
                        });
                    });
                });
            }

            // CRITICAL: Handle any pending trigger file reset FIRST before any other startup operations
            const hadTriggerReset = await this._handlePendingTriggerReset();

            // CRITICAL: After trigger reset, skip normal startup - grid is already fully initialized
            // The trigger reset already did: grid init, order placement, sync, and persistence
            if (hadTriggerReset) {
                this._log('Trigger reset completed. Skipping normal startup grid initialization.');

                // Post-bootstrap validation and fill processing
                await this.manager._fillProcessingLock.acquire(async () => {
                    // STEP 1: Check for fills that occurred during trigger reset
                    // These are orders that got filled while Grid.recalculateGrid() was running.
                    // The filled slots need new orders placed on them.
                    if (this._incomingFillQueue.length > 0) {
                        this._log(`[POST-RESET] ${this._incomingFillQueue.length} fill(s) detected during trigger reset. Processing...`);

                        // Process fills - this will place new orders on the filled slots
                        // Use normal fill processing since bootstrap is complete
                        const fills = this._incomingFillQueue.splice(0);
                        const processedFillKeys = new Set();
                        let requiresOpenOrdersSync = false;

                        for (const fill of fills) {
                            if (!fill || fill.op?.[0] !== 4) continue;

                            const fillOp = fill.op[1];
                            const gridOrder = this.manager.orders.get(fillOp.order_id) ||
                                (Array.from(this.manager.orders.values()) as any[]).find((o: any) => o.orderId === fillOp.order_id);

                            if (!gridOrder) {
                                // CRITICAL FIX: Even if order not in grid, we must still credit the fill proceeds
                                // This can happen when fills arrive after an order was marked VIRTUAL during sequential processing

                                let orphanFillKey = buildFillKey(fill);
                                if (!orphanFillKey) {
                                    orphanFillKey = this._buildOrphanFillFallbackKey(fill);
                                }
                                if (orphanFillKey && !this._isNewFillKey(orphanFillKey, processedFillKeys, '[POST-RESET]', fillOp.order_id)) {
                                    continue;
                                }

                                 this._log(`[POST-RESET] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                                 const accountingResult = await this._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
                                     context: 'POST-RESET',
                                     logger: { log: this._log.bind(this) },
                                     replayMessage: (op) => `[POST-RESET] Replay detected for orphan fill ${op.order_id}; skipping duplicate credit`
                                 });
                                 if (accountingResult.status === 'missing_key') {
                                     requiresOpenOrdersSync = true;
                                 }
                                continue;
                            }

                            this._log(`[POST-RESET] Processing fill for ${gridOrder.type} order ${gridOrder.id} at price ${gridOrder.price}`);

                            const trackedFillKey = buildFillKey(fill);
                            if (trackedFillKey && !this._isNewFillKey(trackedFillKey, processedFillKeys, '[POST-RESET]', fillOp.order_id)) {
                                continue;
                            }

                            this.manager.lockOrders([gridOrder.id]);
                            try {
                             const accountingResult = await this._applyReplaySafeTrackedFillAccounting(fill, fillOp, {
                                 context: 'POST-RESET',
                                 logger: { log: this._log.bind(this) },
                                 replayMessage: (op) => `[POST-RESET] Replay detected for ${op.order_id}; skipping duplicate rebalance`
                             });
                             if (accountingResult.status === 'missing_key') {
                                 requiresOpenOrdersSync = true;
                                 continue;
                             }
                             if (accountingResult.status !== 'applied') {
                                 continue;
                             }
                            // Process this fill through the full rebalance pipeline
                            // This will shift the boundary and place a new order on the filled slot
                            const result = await this._processFillsWithBatching([gridOrder], new Set(), `[POST-RESET] fill ${gridOrder.id}`);
                            if (result.aborted) {
                                this._warn('[POST-RESET] Aborted batch due to illegal state; skipping grid persistence this cycle');
                                continue;
                            }
                            } finally {
                                this.manager.unlockOrders([gridOrder.id]);
                            }
                        }

                        if (requiresOpenOrdersSync) {
                            this._log('[POST-RESET] Falling back to open-orders sync for fill(s) missing replay-safe history identifiers', 'warn');
                            const postResetChainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                            const syncResult = await this.manager.syncFromOpenOrders(postResetChainOpenOrders);
                            if (syncResult.filledOrders?.length > 0) {
                                await this._processFillsWithBatching(syncResult.filledOrders, new Set(), '[POST-RESET] open-orders fallback');
                            }
                        }

                        await this._flushProcessedFillPersistence('post-reset-batch');

                        this.manager._recentFillKeysSnapshot = this._getRecentFillKeysSnapshot();
                        await this.manager.persistGrid();
                    }

                    // STEP 2: Refresh chain truth before spread correction. Trigger
                    // reset can create/cancel orders and fills can arrive while the
                    // reset is running; spread decisions must not use stale local grid.
                    const { aborted: postResetAborted, hasUnmatched: postResetUnmatched } =
                        await this._syncOpenOrdersAndProcessFills('[POST-RESET] pre-spread');

                    if (postResetUnmatched) {
                        this._warn(`[POST-RESET] Skipping spread correction: ${postResetUnmatched} unmatched chain order(s) require maintenance reconciliation`);
                    }

                    // STEP 3: Spread check AFTER fills are processed and chain truth refreshed
                    await this.manager.recalculateFunds();
                    if (!postResetAborted && !postResetUnmatched) {
                        const spreadResult = await this.manager.checkSpreadCondition(
                            BitShares,
                            this.updateOrdersOnChainPlan.bind(this)
                        );
                        if (spreadResult && spreadResult.ordersPlaced > 0) {
                            this._log(`✓ Spread correction after trigger reset: ${spreadResult.ordersPlaced} order(s) placed`);
                            await this._persistAndRecoverIfNeeded();
                        }

                    }

                    // Cancel any dust created by post-reset fills immediately.
                    if (!this._shuttingDown) {
                        try {
                            const postResetHealth = await this.manager.checkGridHealth(
                                this.updateOrdersOnChainPlan.bind(this)
                            );
                            await this._cancelDustOrders({
                                buy: postResetHealth.buyDustOrders,
                                sell: postResetHealth.sellDustOrders,
                            });
                        } catch (_dustErr: any) {
                            this._warn(`[POST-RESET] Dust cancel failed: ${_dustErr.message}`);
                        }
                    }
                    this._log('Bootstrap phase complete - fill processing resumed', 'info');
                });

                await this._setupTriggerFileDetection();
                await this._setupCreditRuntime();
                await this._refreshAndSyncCreditRuntime();
                this._setupBlockchainFetchInterval();
                this._setupCreditWatchdogInterval();
                this._setupCredentialDaemonWatchdogInterval();
                this._setupDustHealthCheckInterval();
                await this._runDustHealthCheck();
                this._log('[DUST] Startup health check complete');

                if (this._isOpenOrdersSyncLoopEnabled()) {
                    this._startOpenOrdersSyncLoop();
                } else {
                    this._log('Open-orders sync loop disabled by configuration (TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED=false)');
                }
                this._log(`DEXBot started. OrderManager running (dryRun=${!!this.config.dryRun})`);
                return; // Skip normal startup path
            }

            // Restore persisted BTS fee
            // SAFE: Done at startup before orders are created, and within fill lock when needed
            this.manager.resetFunds();
            // CRITICAL FIX: Restore BTS fees owed from persistence
            if (persistedBtsFeesOwed && persistedBtsFeesOwed > 0) {
                this.manager.funds.btsFeesOwed = Number(persistedBtsFeesOwed);
            }
            // Restore BTS balance for non-BTS pairs
            if (this.config.assetA !== 'BTS' && this.config.assetB !== 'BTS') {
                if (persistedBtsBalance && typeof persistedBtsBalance === 'object') {
                    this.manager.btsBalance = {
                        free: persistedBtsBalance.free || 0,
                        total: persistedBtsBalance.total || 0,
                        locked: persistedBtsBalance.locked || 0
                    };
                }
            }

            // Restore recently queued fill keys for crash-durable dedup window.
            // All persisted keys are restored; the in-memory TTL (_fillDedupeWindowMs)
            // will naturally evict any that are already expired on the next fill cycle.
            if (persistedRecentFillKeys && typeof persistedRecentFillKeys === 'object') {
                for (const [fillKey, timestamp] of Object.entries(persistedRecentFillKeys)) {
                    this._recentlyQueuedFills.set(fillKey, Number(timestamp));
                }
                this._log(`Restored ${Object.keys(persistedRecentFillKeys).length} recently queued fill key(s) from persisted snapshot`, 'debug');
            }

            if (!this.config.dryRun && !this.accountId) {
                throw new Error('Cannot start bot without a resolved account ID');
            }

            // Use this.accountId which was set during initialize()
            const chainOpenOrders = this.config.dryRun ? [] : await chainOrders.readOpenOrders(this.accountId);

            let shouldRegenerate = false;
            if (!persistedGrid || persistedGrid.length === 0) {
                shouldRegenerate = true;
                this._log('No persisted grid found. Generating new grid.');
            } else {
                await this.manager._initializeAssets();
                const decision = await decideStartupGridAction({
                    persistedGrid,
                    chainOpenOrders,
                    manager: this.manager,
                    logger: { log: (msg) => this._log(msg) },
                    storeGrid: async (orders) => {
                        // Pass the snapshot directly to persistGrid so the live
                        // `manager.orders` map is not briefly swapped (which would
                        // leave the _ordersByState/_ordersByType indexes inconsistent
                        // with the map for the duration of the persist call).
                        await this.manager.persistGrid(orders);
                    },
                    attemptResumeFn: attemptResumePersistedGridByPriceMatch,
                });
                shouldRegenerate = decision.shouldRegenerate;

                if (shouldRegenerate && chainOpenOrders.length === 0) {
                    this._log('Persisted grid found, but no matching active orders on-chain. Generating new grid.');
                }

                // Also log when regeneration is needed but other pairs' orders
                // suppress the "no matching orders" message above.
                if (shouldRegenerate && chainOpenOrders.length > 0 && this.manager?.assets) {
                    const orderCount = chainOpenOrders.filter(
                        o => parseChainOrder(o, this.manager.assets) !== null
                    ).length;
                    if (orderCount === 0) {
                        this._log(`Persisted grid found with no matching orders (${chainOpenOrders.length} other-pair order(s) on account). Generating new grid.`);
                    }
                }
            }

            // Restore BTS fees owed ONLY if we're NOT regenerating the grid
            if (!shouldRegenerate) {
                // CRITICAL: Restore BTS fees owed from blockchain operations
                if (persistedBtsFeesOwed > 0) {
                    this.manager.funds.btsFeesOwed = persistedBtsFeesOwed;
                    this._log(`✓ Restored BTS fees owed: ${Format.formatAmount8(persistedBtsFeesOwed)} BTS`);
                }
            } else {
                this._log(`ℹ Grid regenerating - resetting BTS fees to clean state`);
                this.manager.funds.btsFeesOwed = 0;
            }

            // CRITICAL: Use fill lock during ENTIRE startup synchronization to prevent races.
            // This includes grid init, finishBootstrap, and maintenance - all in one atomic block.
            // Lock order: _fillProcessingLock → _divergenceLock (canonical order, same as _consumeFillQueue)
            await this.manager._fillProcessingLock.acquire(async () => {
                try {

                    this._refreshDynamicWeightDistribution('startup');
                    if (shouldRegenerate) {
                        await this.manager._initializeAssets();

                        if (Array.isArray(chainOpenOrders) && chainOpenOrders.length > 0) {
                            this._log('Generating new grid and syncing with existing on-chain orders...');
                            await Grid.initializeGrid(this.manager);
                            await this.manager.syncFromOpenOrders(chainOpenOrders, { skipAccounting: true });
                            const rebalanceResult = await reconcileGridOrders({
                                manager: this.manager,
                                config: this.config,
                                account: this.account,
                                privateKey: this.privateKey,
                                chainOrders,
                                chainOpenOrders,
                            });

                            await this._executeBatchIfNeeded(rebalanceResult, 'startup reconcile (regenerated grid)');
                        } else {
                            this._log('Generating new grid and placing initial orders on-chain...');
                            await this.placeInitialOrders();
                        }
                        await this._persistAndRecoverIfNeeded();
                    } else {
                        this._log('Found active session. Loading and syncing existing grid.');
                        await Grid.loadGrid(this.manager, persistedGrid, persistedBoundaryIdx);
                        let startupChainOpenOrders = chainOpenOrders;
                        const syncResult = await this.manager.syncFromOpenOrders(startupChainOpenOrders, { skipAccounting: true });

                        // Process price corrections queued during startup sync.
                        // These are not picked up by _consumeFillQueue until a fill
                        // arrives, which may never come for an idle market.
                        if (syncResult.ordersNeedingCorrection?.length > 0) {
                            await correctAllPriceMismatches(
                                this.manager, this.account, this.privateKey, chainOrders
                            );
                        }

                        if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                            this._log(`Startup sync: ${syncResult.filledOrders.length} grid order(s) found filled. Processing proceeds.`, 'info');
                            const batchResult = await this._processFillsWithBatching(
                                syncResult.filledOrders, new Set(), 'startup sync fill rebalance',
                                { skipAccountTotalsUpdate: true }
                            );

                            if (!batchResult?.aborted) {
                                // Refresh open orders so startup reconcile works with post-batch chain reality
                                // and avoids reconciling against a stale pre-batch snapshot.
                                startupChainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
                                await this.manager.synchronizeWithChain(startupChainOpenOrders, 'readOpenOrders');
                            }
                        }

                        const rebalanceResult = await reconcileGridOrders({
                            manager: this.manager,
                            config: this.config,
                            account: this.account,
                            privateKey: this.privateKey,
                            chainOrders,
                            chainOpenOrders: startupChainOpenOrders,
                        });

                        await this._executeBatchIfNeeded(rebalanceResult, 'startup reconcile (loaded grid)');

                        // Dust state is no longer persisted — cancelled immediately on detection.

                        await this._persistAndRecoverIfNeeded();

                        // Gap 1: Grid snapshot sanity check — shared logic with recovery path.
                        await this._rejectCorruptedGridSnapshot('startup');
                    }

                    // Drain any fills that arrived during startup while still in bootstrap
                    // mode. Safe to call directly since we already hold _fillProcessingLock
                    // and _processFillsWithBootstrapMode does NOT re-acquire it.
                    if (this._incomingFillQueue.length > 0) {
                        this._log(`[STARTUP] Processing ${this._incomingFillQueue.length} queued fill(s) before bootstrap ends`);
                        await this._processFillsWithBootstrapMode(chainOrders);
                    }

                    this.manager.finishBootstrap();

                    // Refresh account totals after bootstrap to eliminate the timing
                    // gap between the initial balance fetch and grid operations (sync,
                    // reconcile, fills). Without this, the first maintenance cycle sees
                    // a fund drift (expected at bootstrap) and triggers an unnecessary
                    // invariant violation + full recovery cycle.
                    // Bound by a timeout to avoid blocking _fillProcessingLock on a
                    // flaky node. If the fetch times out, continue with cached values;
                    // the next periodic maintenance cycle will retry.
                    const FETCH_TIMEOUT_MS = 30000;
                    let _fetchTimeoutHandle: NodeJS.Timeout;
                    try {
                        await Promise.race([
                            this.manager.fetchAccountTotals(),
                            new Promise((_, reject) => {
                                _fetchTimeoutHandle = setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS);
                            })
                        ]);
                    } catch (fetchErr: any) {
                        this._log(
                            `[STARTUP] [${this.config?.botKey || 'unknown'}] fetchAccountTotals ${fetchErr.message === 'timeout' ? 'timed out' : 'failed'} (${fetchErr.message}). Continuing with cached account totals.`,
                            'warn'
                        );
                    } finally {
                        clearTimeout(_fetchTimeoutHandle!);
                    }

                    // Perform initial grid maintenance (thresholds, divergence, spread, health)
                    // Consolidated into shared logic to ensure consistent behavior at boot and runtime.
                    // CRITICAL: Pass lockAlreadyHeld since we're inside _fillProcessingLock.acquire()
                    await this._runGridMaintenance('startup');

                    // Cancel any dust from a previous bot lifetime immediately.
                    const startupHealth = await this.manager.checkGridHealth(
                        this.updateOrdersOnChainPlan.bind(this)
                    );
                    await this._cancelDustOrders({
                        buy: startupHealth.buyDustOrders,
                        sell: startupHealth.sellDustOrders,
                    });

                    this._log('Bootstrap phase complete - fill processing resumed', 'info');
                } finally {
                    // CRITICAL: Always clear bootstrap flag, even on error
                    this.manager.finishBootstrap();
                }
            });

            await this._setupTriggerFileDetection();
            await this._setupCreditRuntime();
            await this._refreshAndSyncCreditRuntime();
            await this._runCreditRuntimeMaintenance('startup');
            this._setupBlockchainFetchInterval();
            this._setupCreditWatchdogInterval();
            this._setupCredentialDaemonWatchdogInterval();

            // Periodic dust health check — catches partials that fell below threshold
            // without triggering the post-fill pipeline. Cancels immediately inside the
            // fill-processing lock to avoid racing with fill batches or sync operations.
            this._setupDustHealthCheckInterval();
            await this._runDustHealthCheck();
            this._log('[DUST] Startup health check complete');

            if (this._isOpenOrdersSyncLoopEnabled()) {
                this._startOpenOrdersSyncLoop();
            } else {
                this._log('Open-orders sync loop disabled by configuration (TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED=false)');
            }
            this._log(`DEXBot started. OrderManager running (dryRun=${!!this.config.dryRun})`);

        } catch (err: any) {
            this._warn(`Error during grid initialization: ${err.message}`);
            await this.shutdown();
            throw err;
        }
    }

    /**
     * Create the fill callback for listenForFills.
     * Separated from start() to allow deferred activation after startup completes.
     * @param {Object} chainOrders - Chain orders module for blockchain operations
     * @returns {Function} Async callback for processing fills
     * @private
     */
    _createFillCallback(chainOrders) {
        return DexbotFillRuntime.createFillCallback(this, chainOrders);
    }

    /**
     * Read open orders from chain, sync with local state, and process any fills found.
     * Shared helper used by post-reset spread check and targeted drift reconciliation.
     * @param {string} tag - Context label for logging
     * @returns {Promise<{syncResult: Object|null, aborted: boolean, hasUnmatched: number, openOrders: Array|null}>}
     */
    async _syncOpenOrdersAndProcessFills(tag) {
        if (!this.accountId || this.config?.dryRun) {
            return { syncResult: null, aborted: false, hasUnmatched: 0, openOrders: null };
        }
        try {
            let openOrders = await chainOrders.readOpenOrders(this.accountId);
            const syncResult = await this.manager.synchronizeWithChain(
                openOrders,
                'readOpenOrders'
            );
            let aborted = false;
            if (syncResult?.filledOrders?.length > 0) {
                this._refreshDynamicWeightDistribution(`${tag} sync-fill`);
                this._log(`[SYNC-CHAIN] ${syncResult.filledOrders.length} filled order(s) found during ${tag}`, 'info');
                const batchResult = await this._processFillsWithBatching(
                    syncResult.filledOrders,
                    new Set(),
                    `${tag} sync-fill`
                );
                if (!batchResult?.aborted) {
                    openOrders = await chainOrders.readOpenOrders(this.accountId);
                    await this.manager.synchronizeWithChain(openOrders, 'readOpenOrders');
                } else {
                    aborted = true;
                }
            }
            const hasUnmatched = syncResult?.unmatchedChainOrders?.length || 0;
            return { syncResult, aborted, hasUnmatched, openOrders };
        } catch (err) {
            this._warn(`[SYNC-CHAIN] Open-orders sync failed during ${tag}: ${err.message}`);
            return { syncResult: null, aborted: true, hasUnmatched: -1, openOrders: null };
        }
    }

    _maxConsecutiveFillConsumerFailures() {
        return this.config.fillProcessing?.MAX_CONSECUTIVE_CONSUMER_FAILURES ?? FILL_PROCESSING.MAX_CONSECUTIVE_CONSUMER_FAILURES;
    }

    /**
     * Compute the backoff delay for fill-consumer retries after the failure
     * budget (MAX_CONSECUTIVE_CONSUMER_FAILURES) is exhausted. Each retry
     * doubles the previous delay, capped at CONSUMER_BACKOFF_MAX_MS. The
     * consumer NEVER permanently stops re-scheduling — it just slows down.
     * @param {number} failures The current consecutive-failure count.
     * @returns {number} Delay in milliseconds before the next retry.
     * @private
     */
    _computeFillConsumerBackoffMs(failures) {
        const fp = this.config.fillProcessing || FILL_PROCESSING;
        const initial = fp.CONSUMER_BACKOFF_INITIAL_MS;
        const max = fp.CONSUMER_BACKOFF_MAX_MS;
        const stepAfterMax = Math.max(0, failures - this._maxConsecutiveFillConsumerFailures());
        // 0 -> initial, 1 -> 2*initial, 2 -> 4*initial, ... capped at max.
        return Math.min(max, initial * Math.pow(2, stepAfterMax));
    }

    _scheduleFillConsumerRestart(chainOrders) {
        const failures = this._consecutiveConsumeFailures;
        if (failures >= this._maxConsecutiveFillConsumerFailures()) {
            // Past the failure budget: switch from tight setImmediate loop to
            // exponential backoff. The consumer continues to retry — a transient
            // outage (e.g., credential daemon recovery) will resume normal
            // operation as soon as one cycle succeeds and resets the counter.
            // A permanent failure mode yields slower-but-still-progressing
            // retries capped at CONSUMER_BACKOFF_MAX_MS, with no permanent
            // stop that would require a bot restart.
            const backoffMs = this._computeFillConsumerBackoffMs(failures);
            const elapsedSec = this._consumeFailureFirstAt
                ? Math.round((Date.now() - this._consumeFailureFirstAt) / TIMING.MILLISECONDS_PER_SECOND)
                : null;
            const elapsed = elapsedSec !== null ? `${elapsedSec}s` : 'unknown';
            // Escalate log level on sustained failure so operators monitoring
            // for error/critical alerts are not blind to a stuck consumer.
            //   - warn   : within the first escalation window (5-9 failures,
            //              <5 min) — could be a slow recovery
            //   - error  : 10+ failures OR 5+ minutes of sustained failure
            //   - critical: 20+ failures OR 15+ minutes of sustained failure —
            //              this is the "permanent fault" signal
            const sustainedLevel = (failures >= 20 || (elapsedSec !== null && elapsedSec >= 900))
                ? 'critical'
                : (failures >= 10 || (elapsedSec !== null && elapsedSec >= 300))
                    ? 'error'
                    : 'warn';
            this._log(
                `[FILL-QUEUE] Fill consumer has failed ${failures} consecutive times over ${elapsed}; ` +
                `backing off ${Math.round(backoffMs / TIMING.MILLISECONDS_PER_SECOND)}s before retry. ` +
                `Queue: ${this._incomingFillQueue.length} fills.`,
                sustainedLevel
            );
            setTimeout(() => {
                if (this._shuttingDown) return;
                this._consumeFillQueue(chainOrders).catch(err => {
                    if (!this._consumeFailureFirstAt) {
                        this._consumeFailureFirstAt = Date.now();
                    }
                    this._consecutiveConsumeFailures++;
                    const newFailures = this._consecutiveConsumeFailures;
                    const newElapsedSec = this._consumeFailureFirstAt
                        ? Math.round((Date.now() - this._consumeFailureFirstAt) / TIMING.MILLISECONDS_PER_SECOND)
                        : null;
                    const resumeLevel = (newFailures >= 20 || (newElapsedSec !== null && newElapsedSec >= 900))
                        ? 'critical'
                        : (newFailures >= 10 || (newElapsedSec !== null && newElapsedSec >= 300))
                            ? 'error'
                            : 'warn';
                    this._log(
                        `Fill consumer resume after backoff failed ` +
                        `(${newFailures} total, ` +
                        `next backoff ${Math.round(this._computeFillConsumerBackoffMs(newFailures) / TIMING.MILLISECONDS_PER_SECOND)}s): ` +
                        `${err.message}`,
                        resumeLevel
                    );
                    // Continue the backoff loop. The success path of
                    // _consumeFillQueue resets the counter, breaking the cycle.
                    this._scheduleFillConsumerRestart(chainOrders);
                });
            }, backoffMs);
            return;
        }

        setImmediate(() => this._consumeFillQueue(chainOrders).catch(err => {
            if (!this._consumeFailureFirstAt) {
                this._consumeFailureFirstAt = Date.now();
            }
            this._consecutiveConsumeFailures++;
            const remaining = this._maxConsecutiveFillConsumerFailures() - this._consecutiveConsumeFailures;
            this._log(
                `Fill consumer failed (${this._consecutiveConsumeFailures}/${this._maxConsecutiveFillConsumerFailures()}, ` +
                `${remaining} attempts remaining): ${err.message}`,
                this._consecutiveConsumeFailures >= 3 ? 'warn' : 'error'
            );
        }));
    }

    /**
     * Consume queued fills from incomingFillQueue and rebalance.
     *
     * 1. Deduplicates fills against already-processed set (replay-safe)
     * 2. Syncs filled orders from history or open orders mode
     * 3. Handles price mismatches via correctAllPriceMismatches
     * 4. Processes fills sequentially with interruptible rebalancing (merges new work between fills)
     * 5. Periodically cleans old fill records to prevent memory leaks
     *
     * Atomic lock behavior: If already processing or has waiters, returns immediately (no double-queuing)
     * @param {Object} chainOrders - Chain orders module for blockchain operations
     * @private
     */
    async _consumeFillQueue(chainOrders) {
        // Helper: every early return below is a "deferral", not a failure.
        // The counter only tracks actual failures, so any healthy deferral
        // path should also reset the counter. Without this, a sequence of
        // F-S-F-S-F-S-F-S-F (fail, succeed, fail, succeed, ...) would still
        // reach the max and trip backoff, OR a failure followed by an empty
        // queue / shutdown / in-flight batch would leave the counter sticky
        // and trigger backoff one step sooner on the next real failure.
        const resetFailureWatchdogIfSet = () => {
            if (this._consecutiveConsumeFailures > 0 || this._consumeFailureFirstAt > 0) {
                this._consecutiveConsumeFailures = 0;
                this._consumeFailureFirstAt = 0;
            }
        };

        // ATOMIC: Only attempt lock acquisition if queue has work
        // This prevents unnecessary lock contention on empty queues
        if (this._incomingFillQueue.length === 0) {
            // Empty queue = consumer is healthy, just idle.
            resetFailureWatchdogIfSet();
            return;
        }

        // Check shutdown state
        if (this._shuttingDown) {
            this._warn('Fill processing skipped: shutdown in progress');
            resetFailureWatchdogIfSet();
            return;
        }

        if (this._batchInFlight || this._recoverySyncInFlight) {
            this.manager?.logger?.log?.(
                `Fill processing deferred: order pipeline active (${this._incomingFillQueue.length} queued)`,
                'debug'
            );
            // A batch is in flight, not a failure. The next iteration will
            // either succeed (and reset the counter on the success path) or
            // fail and increment it. Either way, leaving an old failure
            // count here would double-count.
            resetFailureWatchdogIfSet();
            return;
        }

        let pendingFillKeysForCurrentCycle = new Set();
        try {
            // BOOTSTRAP OPTIMIZATION: During bootstrap, prioritize fill processing over grid-wide checks
            // Process fills immediately with side-only rebalancing (no expensive full grid recalculations)
            if (this.manager.isBootstrapping()) {
                // During bootstrap: skip lock contention checks, process fills directly
                let bootstrapSkipped = false;
                await this.manager._fillProcessingLock.acquire(async () => {
                    if (!this.manager.isBootstrapping()) {
                        // Bootstrap finished while waiting for the lock — no
                        // work to do, but the iteration is still healthy.
                        bootstrapSkipped = true;
                        return;
                    }
                    await this._processFillsWithBootstrapMode(chainOrders);
                });
                if (bootstrapSkipped) {
                    // Bootstrap-mode lock callback returned without doing
                    // work; the .acquire() success path at line ~1941 that
                    // would normally reset the counter is not reached in
                    // this branch. Reset here so a stale counter from a
                    // prior failure doesn't carry over.
                    resetFailureWatchdogIfSet();
                }
                return;
            }

            // NORMAL MODE: Non-blocking check if lock already has waiters
            // This prevents unbounded queue growth while still ensuring processing
            // Note: We DO proceed if lock is held but has no waiters - we'll wait our turn
            if (this.manager._fillProcessingLock.getQueueLength() > 0) {
                this._metrics.lockContentionEvents++;
                // Deferral, not a failure. Reset the watchdog so the next
                // call (which may now find an empty queue, or process
                // successfully) doesn't inherit a stale counter.
                resetFailureWatchdogIfSet();
                return;
            }

            await this.manager._fillProcessingLock.acquire(async () => {
                // Reset orphan-fill credit timestamp at the start of each
                // fill cycle. It is re-set when orphan fills are credited,
                // and consumed (set to null) on the next fund-invariant check
                // in accounting.ts, which widens tolerance by 5x while set.
                // Written to this.manager (not this) because accounting.ts
                // reads from the OrderManager reference (mgr).
                // Also cleared by _performStateRecovery after a fresh chain
                // fetch. The timestamp value itself is not compared against a
                // window — it acts as a consume-on-read boolean.
                this.manager._orphanFillsCreditedAt = null;

                while (this._incomingFillQueue.length > 0) {
                    const batchStartTime = Date.now();

                    // Track max queue depth
                    this._metrics.maxQueueDepth = Math.max(this._metrics.maxQueueDepth, this._incomingFillQueue.length);

                    // 1. Take snapshot of current work (ATOMIC: splice removes and returns fills atomically)
                    const allFills = this._incomingFillQueue.splice(0);  // Atomically clear and get all fills

                    const validFills = [];
                    const processedFillKeys = new Set();
                    pendingFillKeysForCurrentCycle = new Set();
                    let requiresOpenOrdersSync = false;

                    // 2. Filter and Deduplicate (Standard Logic)
                    for (const fill of allFills) {
                        if (fill && fill.op && fill.op[0] === FILL_PROCESSING.OPERATION_TYPE) {
                            const fillOp = fill.op[1];

                            // SELF-CANCEL GUARD: only drop malformed, cancel-like
                            // artifacts for an order the local process just cancelled.
                            // Real fill_order ops carry economic data and must still be
                            // accounted even if they arrive shortly after a successful
                            // cancel broadcast.
                            const hasFillEconomics = fillOp?.pays?.asset_id && fillOp?.pays?.amount != null
                                && fillOp?.receives?.asset_id && fillOp?.receives?.amount != null;
                            if (chainOrders && typeof chainOrders.wasRecentlyOwnCancelled === 'function'
                                && chainOrders.wasRecentlyOwnCancelled(fillOp.order_id)
                                && !hasFillEconomics) {
                                this.manager.logger.log(
                                    `[SELF-CANCEL] Skipping non-economic fill artifact for order ${fillOp.order_id} (just cancelled by this bot)`,
                                    'debug'
                                );
                                continue;
                            }

                            // ACCOUNT VALIDATION: Verify the filled order belongs to this bot's account/grid
                            // Only process fills for orders we actually manage
                            const gridOrder = this.manager.orders.get(fillOp.order_id) ||
                                (Array.from(this.manager.orders.values()) as any[]).find((o: any) => o.orderId === fillOp.order_id);
                            if (!gridOrder) {
                                // Check if this order was already freed by stale-order batch cleanup.
                                // When a batch fails due to a stale order reference, the cleanup converts the
                                // slot to VIRTUAL/SPREAD, releasing committed funds to chainFree. If we also
                                // credit the fill proceeds here, we double-count the capital.
                                const staleMarkedAt = this._staleCleanedOrderIds.get(fillOp.order_id);
                                if (staleMarkedAt != null) {
                                    const staleAgeMs = Date.now() - staleMarkedAt;
                                    if (staleAgeMs <= this._staleCleanupRetentionMs) {
                                        this.manager.logger.log(
                                            `[ORPHAN-FILL] Skipping double-credit for stale-cleaned order ${fillOp.order_id} ` +
                                            `(funds already freed by batch cleanup, age=${staleAgeMs}ms)`,
                                            'warn'
                                        );
                                        continue;
                                    }
                                    this._staleCleanedOrderIds.delete(fillOp.order_id);
                                }

                                // Legitimate orphan fill: order was virtualized during sequential processing
                                // but a fill arrived afterward. Credit proceeds to maintain fund tracking.

                                let orphanFillKey = buildFillKey(fill);
                                if (!orphanFillKey) {
                                    orphanFillKey = this._buildOrphanFillFallbackKey(fill);
                                }
                                if (orphanFillKey && !this._isNewFillKey(orphanFillKey, processedFillKeys, '[ORPHAN-FILL]', fillOp.order_id)) {
                                    continue;
                                }

                                 this.manager.logger.log(`[ORPHAN-FILL] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                                 const accountingResult = await this._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
                                     context: 'ORPHAN-FILL',
                                     replayMessage: (op) => `[ORPHAN-FILL] Replay detected for ${op.order_id}; skipping duplicate credit`
                                 });
                                 if (accountingResult.status === 'missing_key') {
                                     requiresOpenOrdersSync = true;
                                 }
                                 // Record orphan fill credit timestamp for fund invariant
                                 // tolerance widening. Written to this.manager because
                                 // accounting.ts reads from the OrderManager (mgr).
                                 this.manager._orphanFillsCreditedAt = Date.now();
                                // Don't add to validFills - we can't do rebalancing without a grid slot
                                // But the funds are now credited, preventing fund invariant violation
                                continue;
                            }

                            // Process both maker and taker fills for our grid orders
                            // Grid validation ensures we only process fills belonging to our account
                            // Taker fills are included because the bot may execute market orders or act as taker
                            const roleStr = fillOp.is_maker !== false ? 'maker' : 'taker';
                            this.manager.logger.log(`Processing ${roleStr} fill for order ${fillOp.order_id}`, 'debug');

                            const fillKey = buildFillKey(fill);
                            if (!fillKey) {
                                this.manager.logger.log(
                                    `[FILL] Missing history id for order ${fillOp.order_id} block ${fill.block_num}; deferring to open-orders sync`,
                                    'warn'
                                );
                                requiresOpenOrdersSync = true;
                                continue;
                            }
                            if (!this._isNewFillKey(fillKey, processedFillKeys, '[FILL]', fillOp.order_id)) {
                                continue;
                            }
                            validFills.push(fill);

                            // Log info
                            const paysAmount = fillOp.pays ? fillOp.pays.amount : '?';
                            const receivesAmount = fillOp.receives ? fillOp.receives.amount : '?';
                            this._log(`\n===== FILL DETECTED =====`);
                            this._log(`Order ID: ${fillOp.order_id}`);
                            this._log(`Pays: ${paysAmount}, Receives: ${receivesAmount}`);
                            this._log(`Block: ${fill.block_num} (History ID: ${fill.id || 'N/A'})`);
                            this._log(`=========================\n`);
                        }
                    }

                    // Clean up short-lived queue dedupe cache to prevent memory leak.
                    const cleanupTimestamp = Date.now();
                    let cleanedCount = 0;
                    for (const [key, timestamp] of this._recentlyQueuedFills) {
                        if (cleanupTimestamp - timestamp > this._fillDedupeWindowMs) {
                            this._recentlyQueuedFills.delete(key);
                            cleanedCount++;
                        }
                    }
                    if (cleanedCount > 0) {
                        this.manager.logger.log(`Cleaned ${cleanedCount} old queued fill records. Remaining: ${this._recentlyQueuedFills.size}`, 'debug');
                    }

                    if (validFills.length === 0 && !requiresOpenOrdersSync) continue; // Loop back for more

                    // 3. Sync and Collect Filled Orders
                    let allFilledOrders = [];
                    let ordersNeedingCorrection = [];
                    const pendingGhostOrders = new Set<string>();
                    const fillMode = chainOrders.getFillProcessingMode();

                    const processValidFills = async (fillsToSync) => {
                        let resolvedOrders = [];
                        if (fillMode === 'history') {
                            this.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (history mode)`, 'info');

                            // Batch mode for 2+ fills: acquires _gridLock once, batches drift refetch
                            if (fillsToSync.length >= 2) {
                                const batchResult = await this.manager.syncFromFillHistoryBatch(fillsToSync, {
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
                                if (batchResult.ghostOrderIds?.length > 0) {
                                    for (const id of batchResult.ghostOrderIds) {
                                        pendingGhostOrders.add(id);
                                    }
                                }
                            } else {
                                // Single fill: use individual per-fill path
                                for (const fill of fillsToSync) {
                                    const resultHistory = await this.manager.syncFromFillHistory(fill, {
                                        persistenceMode: PROCESSED_FILL_PERSISTENCE_MODES.BATCHED
                                    });
                                    const fillKey = buildFillKey({
                                        orderId: fill?.op?.[1]?.order_id,
                                        blockNum: fill?.block_num,
                                        historyId: fill?.id
                                    });
                                    if (fillKey) pendingFillKeysForCurrentCycle.add(fillKey);
                                    // Dust is handled by post-fill detection below.
                                    if (resultHistory.filledOrders) resolvedOrders.push(...resultHistory.filledOrders);
                                    if (resultHistory.requiresOpenOrdersSync) requiresOpenOrdersSync = true;
                                    if (resultHistory.ghostOrderId) pendingGhostOrders.add(resultHistory.ghostOrderId);
                                }
                            }
                        }

                        if (fillMode !== 'history' || requiresOpenOrdersSync) {
                            if (fillMode === 'history' && requiresOpenOrdersSync) {
                                this.manager.logger.log(
                                    'Falling back to open-orders sync for fill(s) missing replay-safe history identifiers',
                                    'warn'
                                );
                            }
                            this.manager.logger.log(`Syncing ${fillsToSync.length} fill(s) (open orders mode)`, 'info');
                            const chainOpenOrders = await chainOrders.readOpenOrders(this.account);
                            const resultOpenOrders = await this.manager.syncFromOpenOrders(chainOpenOrders);
                            // Dust is handled by post-fill detection below.
                            if (resultOpenOrders.filledOrders) resolvedOrders.push(...resultOpenOrders.filledOrders);
                            if (resultOpenOrders.ordersNeedingCorrection) ordersNeedingCorrection.push(...resultOpenOrders.ordersNeedingCorrection);
                        }
                        return resolvedOrders;
                    };

                    this.manager.pauseFundRecalc();
                    try {
                        // FIX 1: Block-level fill batching — group valid fills by block
                        // and process each block group as a unit. This prevents slot
                        // collisions when fills from the same block (original + replacement
                        // orders both filled) arrive in different sync batches. Processing
                        // all fills from a block together lets the sync engine see every
                        // fill for overlapping slots simultaneously.
                        const fillsByBlock = new Map<number, any[]>();
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

                        // Process block groups in ascending block order so the sync
                        // engine sees a deterministic, chronological fill sequence.
                        const sortedBlocks = [...fillsByBlock.keys()].sort((a, b) => a - b);
                        const accumulatedOrders = [];
                        let anyRequiresSync = false;
                        // Capture whether any fill was skipped during validation
                        // (e.g. missing history ID) and set the sync flag. The
                        // per-block reset below would lose this state since those
                        // fills were filtered out of validFills and never enter
                        // any block group.
                        const initialRequiresSync = requiresOpenOrdersSync;
                        for (const blockNum of sortedBlocks) {
                            // Reset requiresOpenOrdersSync per block group so one
                            // block's history-id gap doesn't force the next block
                            // into an unnecessary open-orders snapshot re-fetch.
                            requiresOpenOrdersSync = false;
                            this.manager.logger.log(
                                `[FILL-BLOCK] Processing ${fillsByBlock.get(blockNum)!.length} fill(s) from block ${blockNum}`,
                                'debug'
                            );
                            const blockResult = await processValidFills(fillsByBlock.get(blockNum)!);
                            accumulatedOrders.push(...blockResult);
                            if (requiresOpenOrdersSync) anyRequiresSync = true;
                        }
                        // Preserve both per-block sync flags and the initial flag
                        // from filtered-out fills (missing history ID).
                        requiresOpenOrdersSync = anyRequiresSync || initialRequiresSync;
                        if (fillsWithoutBlock.length > 0) {
                            this.manager.logger.log(
                                `[FILL-BLOCK] Processing ${fillsWithoutBlock.length} fill(s) without block info`,
                                'debug'
                            );
                            const noBlockResult = await processValidFills(fillsWithoutBlock);
                            accumulatedOrders.push(...noBlockResult);
                            if (requiresOpenOrdersSync) anyRequiresSync = true;
                        }
                        // If a fill was filtered out during validation (e.g. missing
                        // history ID) and no block group triggered the open-orders
                        // sync, run it now so the grid state is reconciled.
                        if (requiresOpenOrdersSync && !anyRequiresSync) {
                            this.manager.logger.log(
                                '[FILL-BLOCK] Running open-orders sync for fills with missing history identifiers',
                                'warn'
                            );
                            const fallbackOrders = await processValidFills([]);
                            accumulatedOrders.push(...fallbackOrders);
                            // Flag consumed — variable goes out of scope on
                            // next while iteration.
                        }
                        allFilledOrders = accumulatedOrders;

                        // 4. Handle Price Corrections
                        if (ordersNeedingCorrection.length > 0) {
                            const correctionResult = await correctAllPriceMismatches(
                                this.manager, this.account, this.privateKey, chainOrders
                            );
                            if (correctionResult.failed > 0) this.manager.logger.log(`${correctionResult.failed} corrections failed`, 'error');
                        }

                    } finally {
                        // 4b. Cancel orphaned chain orders detected by other-side rounding.
                        //     These orders have a tiny residual that the bot treated as fully
                        //     filled, but the blockchain did not close the order. We send a
                        //     cancel tx to clean up the zombie order on chain.
                        //     Runs in the finally so it still fires even if processValidFills
                        //     throws after collecting ghost IDs into pendingGhostOrders.
                        //
                        //     OPTIMIZATION: Batch all new ghost cancels into one executeBatch
                        //     call with multiple cancelOrder ops, reducing per-order tx fees
                        //     and broadcast overhead. Falls back to individual cancels on
                        //     batch failure.
                        if (pendingGhostOrders.size > 0) {
                            if (!this._ghostOrderCancelAttempted) this._ghostOrderCancelAttempted = new Set<string>();
                            const newGhostIds = [...pendingGhostOrders].filter(
                                id => !this._ghostOrderCancelAttempted.has(id)
                            );
                            if (newGhostIds.length > 0) {
                                const MAX_OPS_PER_TX = 200;
                                let batchFailed = false;

                                // Build cancel ops with per-ID error tolerance.
                                // Index correlates 1:1 with newGhostIds (allSettled preserves order).
                                const buildResults = await Promise.allSettled(
                                    newGhostIds.map(id =>
                                        chainOrders.buildCancelOrderOp(this.account, id)
                                    )
                                );
                                const cancelOps: any[] = [];
                                for (let i = 0; i < buildResults.length; i++) {
                                    const result = buildResults[i];
                                    const id = newGhostIds[i];
                                    if (result.status === 'fulfilled') {
                                        cancelOps.push(result.value);
                                    } else {
                                        this.manager.logger.log(
                                            `[SYNC] Failed to build cancel op for ghost order ${id}: ${result.reason?.message || result.reason}`,
                                            'warn'
                                        );
                                    }
                                }

                                // Chunk into batches respecting MAX_OPS_PER_TX
                                for (let i = 0; i < cancelOps.length; i += MAX_OPS_PER_TX) {
                                    const chunk = cancelOps.slice(i, i + MAX_OPS_PER_TX);
                                    const batchIds = newGhostIds.slice(i, i + MAX_OPS_PER_TX);
                                    try {
                                        this.manager.logger.log(
                                            `[SYNC] Batch-cancelling ${chunk.length} orphaned chain order(s) ` +
                                            `(batch ${Math.floor(i / MAX_OPS_PER_TX) + 1}/${Math.ceil(cancelOps.length / MAX_OPS_PER_TX)})`,
                                            'info'
                                        );
                                        await chainOrders.executeBatch(this.account, this.privateKey, chunk);
                                        // Mark successfully cancelled IDs immediately
                                        for (const id of batchIds) {
                                            this._ghostOrderCancelAttempted.add(id);
                                        }
                                    } catch (batchErr: any) {
                                        batchFailed = true;
                                        this.manager.logger.log(
                                            `[SYNC] Batch ghost cancel failed for chunk ${Math.floor(i / MAX_OPS_PER_TX) + 1} ` +
                                            `(${chunk.length} orders): ${batchErr?.message || batchErr}`,
                                            'warn'
                                        );
                                    }
                                }

                                // Log overall success if all chunks and all builds succeeded
                                if (!batchFailed && cancelOps.length === newGhostIds.length) {
                                    this.manager.logger.log(
                                        `[SYNC] Successfully batch-cancelled ${newGhostIds.length} orphaned chain order(s)`,
                                        'info'
                                    );
                                }

                                // Fallback: individual cancels for IDs that were not marked successful
                                for (const ghostOrderId of newGhostIds) {
                                    if (this._ghostOrderCancelAttempted.has(ghostOrderId)) continue;
                                    try {
                                        this.manager.logger.log(
                                            `[SYNC] Cancelling orphaned chain order ${ghostOrderId} (other-side full-fill residual)`,
                                            'info'
                                        );
                                        await chainOrders.cancelOrder(this.account, this.privateKey, ghostOrderId);
                                        this._ghostOrderCancelAttempted.add(ghostOrderId);
                                    } catch (err: any) {
                                        this.manager.logger.log(
                                            `[SYNC] Failed to cancel orphaned order ${ghostOrderId}: ${err?.message || err}`,
                                            'warn'
                                        );
                                    }
                                }
                            }
                        }
                        await this.manager.resumeFundRecalc();
                    }

                    // Refresh dynamic weight distribution before processing fills
                    // so the rebalance uses the latest market adapter weights, not
                    // stale values from the last periodic refresh cycle.
                    // Lightweight: reads local JSON snapshot file.
                    this._refreshDynamicWeightDistribution('fill queue');

                    // 5. Fixed-Cap Fill Rebalance
                    // - 1..MAX_FILL_BATCH_SIZE fills: unified full-set planning
                    // - larger bursts: fixed-size chunking at MAX_FILL_BATCH_SIZE
                    if (allFilledOrders.length > 0) {
                        const result = await this._processFillsWithBatching(
                            allFilledOrders, null, 'fill set'
                        );
                        let abortedFillCycle = result.aborted;
                        if (!abortedFillCycle) {
                            const batchFillKeys = new Set(allFilledOrders.map(filledOrder => buildFillKey({
                                orderId: filledOrder?.orderId,
                                blockNum: filledOrder?.blockNum,
                                historyId: filledOrder?.historyId
                            })).filter(Boolean));
                            await this._flushProcessedFillPersistenceForKeys(batchFillKeys, 'fill-batch-committed');
                        } else {
                            this.manager.logger.log(
                                '[FILL-DEDUP] Fill cycle aborted; fill key persistence guarded under abort path.',
                                'warn'
                            );
                        }

                        // 6. Rebalance Recovery Loop (Sequential Extensions)
                        // DISABLED FOR SEQUENTIAL: Each sequential fill already triggers a full rebalance with proper
                        // boundary shift. An additional recovery loop with EMPTY fills causes the boundary to remain
                        // at the last fill's position, leading to wrong operation types (updates instead of rotations)
                        // and operations on the wrong side.
                        //
                        // In the future, recovery loop can be re-enabled for single fills if needed, but ONLY
                        // if it passes the actual fills to processFilledOrders so the boundary shifts correctly.
                        // For now: Each fill = full rebalance with boundary shift = complete correction in one pass.
                        // CRITICAL: Do NOT run spread correction here during sequential fill processing.
                        // The rebalance from each fill should maintain spread naturally. Running spread correction
                        // immediately after creates new orders that may get filled by market before next cycle,
                        // causing cascading fills and potentially SPREAD slots becoming PARTIAL (error condition).
                        // Spread correction runs in the main loop instead.
                        const fullFillCount = allFilledOrders.filter(o =>
                            o && o.isPartial !== true
                        ).length;
                        const hasAnyFills = allFilledOrders.some(o => o);
                        const shouldRunPostFillChecks = !abortedFillCycle && fullFillCount > 0;
                        const shouldRunDustDetection = !abortedFillCycle && hasAnyFills;

                        if (shouldRunDustDetection) {
                            const healthResult = await this.manager.checkGridHealth(
                                this.updateOrdersOnChainPlan.bind(this)
                            );
                            const allDust = [
                                ...(healthResult.buyDustOrders || []),
                                ...(healthResult.sellDustOrders || []),
                            ];
                            if (allDust.length > 0) {
                                const dustCancelResult = await this._cancelDustOrders({
                                    buy: healthResult.buyDustOrders,
                                    sell: healthResult.sellDustOrders,
                                });
                                if (dustCancelResult?.batchResult?.aborted) {
                                    abortedFillCycle = true;
                                }
                            }
                        }

                        // Run grid maintenance after fills to rebuild degraded grid.
                        // CRITICAL FIX (commit a946c33): Replaced inline divergence checks with centralized
                        // _runGridMaintenance call to ensure pipeline protection applies consistently.
                        // Before: Divergence checks ran immediately after fills, causing race-to-resize
                        // After: Grid maintenance waits for isPipelineEmpty() before structural changes
                        // Run only when the cycle contains at least one full fill.
                        if (shouldRunPostFillChecks && !abortedFillCycle) {
                            await this._runGridMaintenance('post-fill');
                        }
                    } else if (pendingFillKeysForCurrentCycle.size > 0) {
                        await this._flushProcessedFillPersistenceForKeys(
                            pendingFillKeysForCurrentCycle,
                            'fill-batch-no-rotations'
                        );
                    }

                    this.manager._recentFillKeysSnapshot = this._getRecentFillKeysSnapshot();
                    await retryPersistenceIfNeeded(this.manager);

                    // Periodically clean up old fill records after processing N fills.
                    // Counter is protected by _fillProcessingLock during fill consumption.
                    this._fillCleanupCounter += validFills.length;

                    const cleanupThreshold = MAINTENANCE.CLEANUP_PROBABILITY > 0 && MAINTENANCE.CLEANUP_PROBABILITY < 1
                        ? Math.floor(1 / MAINTENANCE.CLEANUP_PROBABILITY)
                        : 100; // Default: every 100 fills

                    if (this._fillCleanupCounter >= cleanupThreshold) {
                        try {
                            await this.accountOrders.cleanOldProcessedFills(TIMING.FILL_RECORD_RETENTION_MS);
                            this._fillCleanupCounter = 0;  // Reset counter after cleanup (success or retry on next batch if failed)
                        } catch (err: any) {
                            this.manager?.logger?.log(`Warning: Fill cleanup failed (will retry): ${err.message}`, 'warn');
                        }
                    }

                    // Update metrics
                    this._metrics.fillsProcessed += validFills.length;
                    this._metrics.fillProcessingTimeMs += Date.now() - batchStartTime;

                    // Prune expired stale-cleaned order IDs after each processing cycle.
                    if (this._staleCleanedOrderIds.size > 0) {
                        const now = Date.now();
                        let prunedCount = 0;
                        for (const [orderId, markedAt] of this._staleCleanedOrderIds) {
                            if (now - markedAt > this._staleCleanupRetentionMs) {
                                this._staleCleanedOrderIds.delete(orderId);
                                prunedCount++;
                            }
                        }
                        if (prunedCount > 0) {
                            this.manager.logger.log(
                                `[STALE-CLEANUP] Pruned ${prunedCount} expired stale-cleaned order IDs ` +
                                `(retention=${this._staleCleanupRetentionMs}ms, remaining=${this._staleCleanedOrderIds.size})`,
                                'debug'
                            );
                        }
                    }

                } // End while(_incomingFillQueue)

                this._markGridActivity('fill processing end');
                // Reset the fill-consumer watchdog on the success path. The
                // counter is only incremented by _scheduleFillConsumerRestart's
                // catch handler; without this reset, a fill pattern of
                // F-S-F-S-F-S-F-S-F would still reach the max and the consumer
                // would stop being re-scheduled.
                this._consecutiveConsumeFailures = 0;
                this._consumeFailureFirstAt = 0;
            });
        } catch (err: any) {
            const isCredentialOutage = this._isCredentialDaemonError(err);
            if (pendingFillKeysForCurrentCycle.size > 0) {
                const flushReason = isCredentialOutage
                    ? 'credential-outage-verified-fills'
                    : 'fill-cycle-error-verified-fills';

                if (isCredentialOutage) {
                    this._credentialRecoveryNeeded = true;
                    this._suspendGridPersistenceForCredentialOutage(`credential outage during fill processing: ${err.message}`);
                }

                try {
                    await this._flushProcessedFillPersistenceForKeys(
                        pendingFillKeysForCurrentCycle,
                        flushReason,
                        { throwOnError: true }
                    );
                    const credentialSuffix = isCredentialOutage
                        ? '; grid persistence is suspended until recovery'
                        : '';
                    this.manager?.logger?.log?.(
                        `[FILL-DEDUP] Persisted ${pendingFillKeysForCurrentCycle.size} verified processed-fill write(s) after fill cycle error${credentialSuffix}.`,
                        isCredentialOutage ? 'warn' : 'info'
                    );
                } catch (flushErr: any) {
                    this.manager?.logger?.log?.(
                        `[FILL-DEDUP] Failed to persist verified fill keys during fill error handling: ${flushErr.message}`,
                        'warn'
                    );
                }
            }

            if (isCredentialOutage && pendingFillKeysForCurrentCycle.size === 0) {
                this._credentialRecoveryNeeded = true;
                this._suspendGridPersistenceForCredentialOutage(`credential outage during fill processing: ${err.message}`);
            }
            this._log(`Error processing fills: ${err.message}`, 'error');
            if (err.stack) this._log(err.stack, 'error');
        }

        // Post-processing: If new fills arrived while processing, schedule another cycle
        // SAFE: Done outside lock context, no async work in finally block
        if (!this._shuttingDown && this._incomingFillQueue.length > 0) {
            this._scheduleFillConsumerRestart(chainOrders);
        }
    }

    /**
     * Process fills during bootstrap phase using the standard fill pipeline.
     *
     * BOOTSTRAP MODE STRATEGY:
     * - Delegate to the same fill pipeline as the post-reset path
     * - Same-side replacement at the filled slot (handled by processFillsOnly)
     * - Symmetric grid regen via COW rebalance (calculateTargetGrid + reconcileGrid)
     * - Dust orders are cancelled by the rebalance's isCreateHealthy / cancelSurpluses
     *
     * This ensures:
     * - Identical behavior between bootstrap and post-reset
     * - Grid symmetry maintained by the rebalance, not by manual rotation
     * - Budget safety enforced by validateWorkingGridFunds in the COW engine
     *
     * @param {Object} chainOrders - Chain orders instance for broadcasting
     * @returns {Promise<void>}
     */
    async _processFillsWithBootstrapMode(chainOrders) {
        if (this._incomingFillQueue.length === 0) return;

        const startTime = Date.now();
        const fills = this._incomingFillQueue.splice(0);
        const validFills = [];
        const processedFillKeys = new Set();
        let requiresOpenOrdersSync = false;

        // 1. Validate and deduplicate fills
        for (const fill of fills) {
            if (!fill || fill.op?.[0] !== 4) continue;

            const fillOp = fill.op[1];
            const gridOrder = this.manager.orders.get(fillOp.order_id) ||
                (Array.from(this.manager.orders.values()) as any[]).find((o: any) => o.orderId === fillOp.order_id);

            if (!gridOrder) {
                // CRITICAL FIX: Even if order not in grid, we must still credit the fill proceeds
                // This can happen when fills arrive after an order was marked VIRTUAL during sequential processing

                let orphanFillKey = buildFillKey(fill);
                if (!orphanFillKey) {
                    orphanFillKey = this._buildOrphanFillFallbackKey(fill);
                }
                if (orphanFillKey && !this._isNewFillKey(orphanFillKey, processedFillKeys, '[BOOTSTRAP]', fillOp.order_id)) {
                    continue;
                }

                 this.manager.logger.log(`[BOOTSTRAP] Processing funds for unknown order ${fillOp.order_id} (not in grid but crediting proceeds)`, 'warn');
                 const accountingResult = await this._applyReplaySafeOrphanFillAccounting(fill, fillOp, {
                     context: 'BOOTSTRAP'
                 });
                 if (accountingResult.status === 'missing_key') {
                     requiresOpenOrdersSync = true;
                 }
                continue;
            }

            const trackedFillKey = buildFillKey(fill);
            if (trackedFillKey && !this._isNewFillKey(trackedFillKey, processedFillKeys, '[BOOTSTRAP]', fillOp.order_id)) {
                continue;
            }

            this.manager.lockOrders([gridOrder.id]);
            try {
            const accountingResult = await this._applyReplaySafeTrackedFillAccounting(fill, fillOp, {
                context: 'BOOTSTRAP',
                replayMessage: (op) => `[BOOTSTRAP] Replay detected for ${op.order_id}; skipping duplicate bootstrap rebalance`
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
            this._log(`[BOOTSTRAP] Fill detected: ${fillType} order (${fillOp.is_maker !== false ? 'maker' : 'taker'})`);
            } finally {
                this.manager.unlockOrders([gridOrder.id]);
            }
         }

        if (requiresOpenOrdersSync) {
            this._log('[BOOTSTRAP] Falling back to open-orders sync for fill(s) missing replay-safe history identifiers', 'warn');
            const bootstrapChainOpenOrders = await chainOrders.readOpenOrders(this.accountId);
            const syncResult = await this.manager.syncFromOpenOrders(bootstrapChainOpenOrders);
            if (syncResult.filledOrders?.length > 0) {
                const queuedOrderIds = new Set(validFills.map(fill => fill?.gridOrder?.orderId).filter(Boolean));
                for (const filledOrder of syncResult.filledOrders) {
                    if (!filledOrder?.orderId || queuedOrderIds.has(filledOrder.orderId)) continue;
                    validFills.push({ gridOrder: filledOrder });
                    queuedOrderIds.add(filledOrder.orderId);
                }
            }
        }

        await this._flushProcessedFillPersistence('bootstrap-batch');

        if (validFills.length === 0) return;

        // 2. Process fills through the standard fill pipeline.
        // This handles same-side replacement, symmetric rebalance, and dust cleanup
        // via the same path used by the post-reset flow.
        try {
            this._log(`[BOOTSTRAP] Processing ${validFills.length} fill(s) through standard pipeline`, 'info');

            const filledOrders = validFills.map(f => f.gridOrder);
            const result = await this._processFillsWithBatching(
                filledOrders,
                new Set(),
                '[BOOTSTRAP] fill processing'
            );

            if (result.aborted) {
                this._warn('[BOOTSTRAP] Aborted batch due to illegal state; skipping grid persistence this cycle');
            }

            this._metrics.fillsProcessed += validFills.length;
            this._metrics.fillProcessingTimeMs += Date.now() - startTime;
        } catch (err: any) {
            this._warn(`[BOOTSTRAP] Error processing fills: ${err.message}`);
            this.manager.logger.log(`[BOOTSTRAP] Fill error: ${err.message}`, 'error');
        }
    }

    /**
     * Set up account identifier and configure global context.
     * @param {string} accountName - The name of the account to set up
     * @private
     */
    async _setupAccountContext(accountName) {
        const accId = await chainOrders.resolveAccountId(accountName);

        if (!accId) {
            const isIdFormat = /^1\.2\.\d+$/.test(accountName);
            throw new Error(
                `Unable to resolve account${isIdFormat ? ' ID' : ''} '${accountName}' on the BitShares blockchain. ` +
                `Verify the account ${isIdFormat ? 'ID is correct' : 'name is registered and active on chain'}.`
            );
        }

        await chainOrders.setPreferredAccount(accId, accountName);
        this.account = accountName;
        this.accountId = accId;
        this._log(`Initialized DEXBot for account: ${this.account}`);
    }

    /**
     * Initialize the bot by connecting to BitShares and setting up the account.
     * @param {string|Object|Buffer} [vaultSecret=null] - The unlock secret for authentication.
     * @returns {Promise<void>}
     * @throws {Error} If initialization fails or preferredAccount is missing.
     */
    async initialize(vaultSecret = null) {
        await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);
        if (this.config && this.config.preferredAccount) {
            try {
                let privateKey = null;

                try {
                    privateKey = await getKeyStore().resolveSigningKey(
                        this.config.preferredAccount,
                        vaultSecret,
                        BitShares
                    );
                } catch (err: any) {
                    if (vaultSecret) throw err;
                    this._warn(`Credential daemon probe failed: ${err.message}. Falling back to interactive authentication.`);
                }

                if (!privateKey) {
                    const unlockSecret = await chainKeys.authenticate();
                    privateKey = await chainKeys.resolvePrivateKey(this.config.preferredAccount, unlockSecret, BitShares);
                }

                this.privateKey = privateKey;
                await this._setupAccountContext(this.config.preferredAccount);
            } catch (err: any) {
                if (chainKeys.isMasterPasswordFailure(err)) {
                    throw err;
                }
                this._warn(`Auto-selection of preferredAccount failed: ${err.message}`);
                // dexbot.ts has fallback to selectAccount, bot.ts throws
                if (typeof chainOrders.selectAccount === 'function') {
                    const accountData = await chainOrders.selectAccount();
                    this.privateKey = accountData.privateKey;
                    await this._setupAccountContext(accountData.accountName);
                } else {
                    throw err;
                }
            }
        } else {
            throw new Error('No preferredAccount configured');
        }
    }

    /**
     * Places initial orders on the blockchain.
     * @returns {Promise<void>}
     */
    async placeInitialOrders() {
        if (!this.manager) {
            const mgrLogFile = this.config?.name ? path.join(PATHS.LOGS_DIR, `${this.config.name}.log`) : undefined;
            this.manager = new OrderManager({ ...this.config, logFile: mgrLogFile });
            this.manager.accountOrders = this.accountOrders;
        }
        this._wireStructuralGridResyncRequest();
        this.manager.startBootstrap();
        try {
            try {
                const botFunds = this.config && this.config.botFunds ? this.config.botFunds : {};
                const needsPercent = (v) => typeof v === 'string' && v.includes('%');
                if ((needsPercent(botFunds.buy) || needsPercent(botFunds.sell)) && (this.accountId || this.account)) {
                    if (typeof this.manager._fetchAccountBalancesAndSetTotals === 'function') {
                        await this.manager._fetchAccountBalancesAndSetTotals();
                    }
                }
            } catch (errFetch: any) {
                this._warn(`Could not fetch account totals before initializing grid: ${errFetch && errFetch.message ? errFetch.message : errFetch}`);
            }

            await Grid.initializeGrid(this.manager);

            if (this.config.dryRun) {
                this.manager.logger.log('Dry run enabled, skipping on-chain order placement.', 'info');
                await this.manager.persistGrid();
                return;
            }

            this.manager.logger.log('Placing initial orders on-chain...', 'info');
            const ordersToActivate = this.manager.getInitialOrdersToActivate();

            const orderGroups = this._buildOutsideInPairGroupsForOrders(ordersToActivate);

            for (const group of orderGroups) {
                await this.updateOrdersOnChainPlan({ ordersToPlace: group });
            }

            await this.manager.persistGrid();
        } finally {
            this.manager.finishBootstrap();
        }
    }

    /**
     * Build outside-in pair groups for initial order placement.
     * @param {Array<Object>} orders - Array of order objects
     * @returns {Array<Array<Object>>} Grouped order arrays
     */
    _buildOutsideInPairGroupsForOrders(orders) {
        return cowRuntime.buildOutsideInPairGroupsForOrders(this, orders);
    }

    /**
     * Build outside-in pair groups for create entry contexts.
     * @param {Array<Object>} createEntries - Array of create entry objects with context.order
     * @returns {Array<Array<Object>>} Grouped entry arrays
     */
    _buildOutsideInPairGroupsForCreateEntries(createEntries) {
        return cowRuntime.buildOutsideInPairGroupsForCreateEntries(this, createEntries);
    }

    /**
     * Resolve the centralized fill batch cap.
     * @returns {number} Positive maximum number of fill-driven rotations per broadcast cycle
     */
    _getMaxFillBatchSize() {
        return Math.max(1, this.config.fillProcessing?.MAX_FILL_BATCH_SIZE ?? FILL_PROCESSING.MAX_FILL_BATCH_SIZE);
    }

    /**
     * Extract operation results from a batch transaction result.
     * @param {Object|Array|null} result - Transaction result from executeBatch
     * @param {string} [warnContext=''] - Context for warning messages
     * @returns {Array} Array of operation result entries
     */
    _extractOperationResults(result, warnContext = '') {
        return cowRuntime.extractOperationResults(this, result, warnContext);
    }

    /**
     * Find CREATE operation contexts whose broadcast result did not include a chain order id.
     *
     * @param {Array} operationResults - operation_results aligned with opContexts.
     * @param {Array<Object>} opContexts - Operation context metadata aligned with operations.
     * @returns {Array<{index:number, ctx:Object}>} Missing create result contexts.
     */
    _findMissingCreateResultContexts(operationResults, opContexts) {
        return cowRuntime.findMissingCreateResultContexts(this, operationResults, opContexts);
    }

    /**
     * Run an immediate chain sync after a successful CREATE broadcast returned incomplete ids.
     *
     * Missing-create blockers are intentionally preserved if the recovery snapshot does not
     * account for the affected local slot. The sync engine owns normal clearing of
     * _lastUnmatchedChainOrders after a successful clean snapshot; this method prevents a
     * lagging empty snapshot from clearing blockers that were just created by this flow.
     *
     * @param {string} [reason] - Human-readable recovery context for logs.
     * @returns {Promise<void>}
     */
    async _recoverAfterMissingCreateResults(reason = 'missing create operation results') {
        return cowRuntime.recoverAfterMissingCreateResults(this, reason);
    }

    /**
     * Restore unresolved missing-create blockers after recovery if sync did not adopt them.
     *
     * @param {Array<Object>} blockers - Pre-recovery missing-create blockers.
     * @param {Object} recoveryResult - Result returned by manager.syncFromOpenOrders.
     * @returns {void}
     */
    _preserveMissingCreateBlockersAfterRecovery(blockers, recoveryResult) {
        return cowRuntime.preserveMissingCreateBlockersAfterRecovery(this, blockers, recoveryResult);
    }

    /**
     * Merge missing CREATE result contexts into manager._lastUnmatchedChainOrders.
     *
     * The sync engine sets and clears _lastUnmatchedChainOrders on full sync snapshots.
     * COW uses the same manager field as a structural create blocker before broadcasting.
     * Missing-create entries are keyed by reason:slotId:operationIndex to avoid replacing
     * unrelated unmatched chain orders that may already be blocking new creates.
     *
     * @param {Array<{index:number, ctx:Object}>} missingCreateResults - Missing CREATE results.
     * @returns {void}
     */
    _markMissingCreateResultsAsStructuralBlocker(missingCreateResults) {
        return cowRuntime.markMissingCreateResultsAsStructuralBlocker(this, missingCreateResults);
    }

    /**
     * Format an unmatched chain order/blocker for COW logs.
     *
     * @param {Object} order - Unmatched chain order or structural blocker.
     * @returns {string} Compact human-readable diagnostic.
     */
    _formatUnmatchedChainOrderForLog(order) {
        return cowRuntime.formatUnmatchedChainOrderForLog(this, order);
    }

    /**
     * Record a pending CREATE broadcast on the manager.
     *
     * Called immediately after each CREATE op is built into the opContext list.
     * The fingerprint and op indices are stashed so the recovery path in
     * _reconcileAfterUncertainBroadcast can correlate the planned op with an
     * on-chain order (or discard it as a chain-side orphan).
     *
     * Storage: manager._pendingBroadcasts is a Map<fingerprint, PendingEntry>.
     * We store on the manager (not on the bot) so the sync engine, grid
     * reconcile, and any other consumer can read it without crossing the
     * bot/manager boundary.
     *
     * @param {Object} entry
     * @param {number} entry.opIndex - Index into the operations array
     * @param {number} entry.ctxIndex - Index into opContexts
     * @param {Object} entry.order - The grid order being broadcast
     * @param {Object} entry.finalInts - { amountToSell, minToReceive, ... } blockchain integers
     * @returns {void}
     */
    _recordPendingBroadcast(entry) {
        return cowRuntime.recordPendingBroadcast(this, entry);
    }

    /**
     * Clear the pending-broadcast cache.
     *
     * Called after a successful commit, after a confirmed failure (so the
     * stale entries don't block the next cycle), and after a successful
     * recovery adoption (matched entries are explicitly removed by
     * _reconcileAfterUncertainBroadcast before calling this).
     */
    _clearPendingBroadcasts() {
        return cowRuntime.clearPendingBroadcasts(this);
    }

    /**
     * Build a fingerprint for an on-chain order so it can be matched against
     * the pending-broadcast cache.
     *
     * @param {Object} chainOrder - Parsed chain order (id, sell, receive, sellAssetId, receiveAssetId, ...)
     * @param {string} slotId - The grid slot id (order.id) we expect this chain order to belong to
     * @returns {string|null} Fingerprint or null on bad input
     */
    _buildChainOrderFingerprint(chainOrder, slotId) {
        return cowRuntime.buildChainOrderFingerprint(this, chainOrder, slotId);
    }

    /**
     * Normalize raw BitShares limit_order_object data into the integer tuple
     * used by pending-broadcast recovery.
     *
     * readOpenOrders() returns raw orders with sell_price/for_sale, not the
     * parsed DEXBot fields type/sellInt/receiveInt. Test fixtures may still
     * pass the parsed shape, so this helper accepts both.
     *
     * @param {Object} chainOrder
     * @returns {{side: string, assetA: string, assetB: string, sellInt: number, receiveInt: number}|null}
     */
    _normalizeChainOrderForPendingMatch(chainOrder) {
        return cowRuntime.normalizeChainOrderForPendingMatch(this, chainOrder);
    }

    /**
     * Find a chain order that matches a planned slot using price+size proximity.
     *
     * Fallback for the case where the chain order's integer pair doesn't
     * bit-match the planned op (e.g. the daemon normalized the minToReceive
     * by ±1 unit to force an op, or precision rounding changed a value by 1).
     * For each open chain order we build a fingerprint candidate per known
     * slot id and accept the first exact match; if none, we look for a near
     * match by sell+receive integer proximity.
     *
     * @param {Array<Object>} chainOrders - Open chain orders for the account
     * @param {string} slotId - Planned grid slot id
     * @param {Object} planned - { sell, receive, orderType } integers from the planned op
     * @returns {Object|null} Matching chain order, or null
     */
    _findChainOrderForSlot(chainOrders, slotId, planned) {
        return cowRuntime.findChainOrderForSlot(this, chainOrders, slotId, planned);
    }

    /**
     * Reconcile a broadcast whose chain state is unknown.
     *
     * Triggered when the credential daemon times out (or hits its inner
     * deadline) before confirming the broadcast. The chain may or may not
     * have accepted the operations; we MUST treat the state as uncertain
     * and recover deterministically.
     *
     * Algorithm:
     *   1. Read the account's current open orders from the chain.
     *   2. For each pending-broadcast entry (fingerprinted CREATE op), look
     *      for a matching chain order. If found: adopt it (set the opContext's
     *      chainOrderId and continue with the existing planned slot).
     *   3. For pending entries with no chain match: virtualize (mark the
     *      opContext as discarded; the planned slot stays empty until the
     *      next planning cycle).
     *   4. Persist + log a structured [COW][UNCERTAIN] summary.
     *
     * After this method returns, the bot has either adopted the on-chain
     * result (good case — chain accepted but we didn't see the reply) or
     * accepted the discard (chain rejected or never received the op).
     *
     * @param {BroadcastUncertainError} err - The thrown error
     * @param {Array<Object>} opContexts - Original opContexts from the failed batch
     * @returns {Promise<Object>} Result object compatible with batch return shape
     */
    async _reconcileAfterUncertainBroadcast(err, opContexts, options: Record<string, any> = {}) {
        return cowRuntime.reconcileAfterUncertainBroadcast(this, err, opContexts, options);
    }

    async _reconcileAfterUncertainBroadcastImpl(err, opContexts, options) {
        return cowRuntime.reconcileAfterUncertainBroadcastImpl(this, err, opContexts, options);
    }
    /**
     * Auto-cancel a price-drift orphan from the unmatched-order snapshot.
     *
     * Only cancels entries with reason === 'price-drift-orphan' — these are
     * surplus orders that drifted away from their slot price and have no
     * adoptable grid slot. All other unmatched orders (duplicate-price-level,
     * already-matched-slot, etc.) are adoptable positions that the structural
     * resync will integrate into the grid; cancelling them destroys capital.
     *
     * This is the post-recovery safety net: if, after
     * _reconcileAfterUncertainBroadcast runs, there are still price-drift
     * orphans, cancel ONE per cycle. Per-cycle cap = 1 (or 5 in recovery mode)
     * — the next cycle will pick up the next orphan if more remain.
     *
     * Safety conditions (ALL must hold):
     *   1. _pendingBroadcasts is empty (no in-flight recovery)
     *   2. _lastUnmatchedChainOrders contains at least one price-drift-orphan
     *   3. The current cycle has not already auto-cancelled an orphan
     *      (tracked via this._autoCancelOrphanCycleMarker)
     *
     * Records the cancel via _recordOwnCancelOps so the fill consumer
     * doesn't trip the self-cancel guard.
     *
     * @returns {Promise<{cancelled: boolean, orderId?: string, reason?: string}>}
     */
    async _autoCancelOneUnmatchedOrphan() {
        return cowRuntime.autoCancelOneUnmatchedOrphan(this);
    }

    // Pair mode applies only when create contexts include both BUY and SELL.
    // Single-side create batches intentionally remain a single executeBatch.
    /**
     * Check whether to execute creates in outside-in pair mode (mixed BUY/SELL operations).
     * @param {Array<Object>} opContexts - Operation contexts array
     * @returns {boolean} True if pair mode should be used
     */
    _shouldExecuteCreatePairMode(opContexts) {
        return cowRuntime.shouldExecuteCreatePairMode(this, opContexts);
    }

    /**
     * Execute operations with retry on BroadcastUncertainError.
     * The daemon already retries internally against a 25s deadline.
     * If all expire, a fresh bot-level attempt buys a new 25s window.
     *
     * Skips retry when partialOnChainState is true (pair-mode grouped
     * execution where earlier groups already committed). Re-broadcasting
     * the full operations array would duplicate those creates on chain.
     */
    async _executeWithRetryOnUncertain(operations, opContexts) {
        return cowRuntime.executeWithRetryOnUncertain(this, operations, opContexts);
    }

    /**
     * Execute blockchain operations with appropriate strategy (single batch or pair mode).
     * @param {Array<import('./types').CreatedOperation>} operations - Array of operation objects
     * @param {Array<Object>} opContexts - Array of operation context metadata (1:1 with operations)
     * @returns {Promise<{result: Object, opContexts: Array}>} Execution result with contexts
     */
    async _executeOperationsWithStrategy(operations, opContexts) {
        return cowRuntime.executeOperationsWithStrategy(this, operations, opContexts);
    }

    /**
     * Validate that operations can be executed with available funds before broadcasting.
     * Checks sufficient available funds for all operations.
     * @param {Array} operations - Operations to validate
     * @param {Object} assetA - Asset A metadata (id, precision, symbol)
     * @param {Object} assetB - Asset B metadata (id, precision, symbol)
     * @returns {Object} { isValid: boolean, summary: string }
     * @private
     */
    _validateOperationFunds(operations, assetA, assetB) {
        return cowRuntime.validateOperationFunds(this, operations, assetA, assetB);
    }

    /**
     * Resolve the ideal size from an order-like object with fallback.
     * @param {Object|null} orderLike - Order-like object with optional idealSize/size nested properties
     * @param {number|null} [fallbackSize=null] - Fallback size if none found
     * @returns {number|null} Resolved size or null
     */
    _resolveIdealSizeForValidation(orderLike, fallbackSize = null) {
        return cowRuntime.resolveIdealSizeForValidation(this, orderLike, fallbackSize);
    }

    /**
     * Validate that an order size is safe to execute (above minimum dust thresholds).
     * @param {number} size - Order size to validate
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {Object|null} [orderLike=null] - Optional order-like object for ideal size comparison
     * @param {number|null} [fallbackSize=null] - Fallback ideal size
     * @returns {import('./types').OrderValidationResult}
     */
    _validateOrderSizeForExecution(size, type, orderLike = null, fallbackSize = null) {
        return cowRuntime.validateOrderSizeForExecution(this, size, type, orderLike, fallbackSize);
    }

    /**
     * Execute a batch of order operations if the rebalance result has executable actions.
     * @param {Object} rebalanceResult - COW rebalance result with actions
     * @param {string} [contextLabel='rebalance'] - Context label for logging
     * @returns {Promise<Object>} Batch execution result
     */
    async _executeBatchIfNeeded(rebalanceResult, contextLabel = 'rebalance') {
        if (!hasExecutableActions(rebalanceResult)) {
            this.manager?.logger?.log?.(`[COW] No actions needed for ${contextLabel}`, 'debug');
            // Clear REBALANCING state even when there are no actions to execute.
            // _applySafeRebalanceCOW sets REBALANCING before calling the COW engine;
            // if the engine returns an empty actions list (not aborted), the state
            // would otherwise remain stuck at REBALANCING permanently, blocking
            // all subsequent fill processing and rebalance attempts.
            this.manager?._clearWorkingGridRef?.();
            // Persist master grid mutations that may have occurred outside COW
            // broadcast (e.g., partial-fill size updates applied directly by the
            // sync engine). Without this, a partial fill that does not trigger a
            // COW rebalance leaves the in-memory master grid ahead of the on-disk
            // snapshot, so the updated size is lost on restart.
            if (typeof this.manager?.persistGrid === 'function') {
                const persistResult = await this.manager.persistGrid();
                // persistGrid returns:
                //   - { isValid: true, skipped: true, suspended: true } when persistence is suspended
                //   - { isValid: false, reason } when validation rejects the state
                //   - { isValid: true } on success (skipped is absent/undefined)
                // Warn only when validation actively rejected the state — not
                // when persistence was suspended (handled by the persistence
                // gate elsewhere).
                if (persistResult
                    && persistResult.skipped !== true
                    && persistResult.isValid === false) {
                    this.manager.logger.log(
                        `[COW] Master grid persistence validation failed after no-action batch (${contextLabel}): ${persistResult.reason || 'unknown'}`,
                        'warn'
                    );
                }
            }
            return { executed: false, hadRotation: false, skippedNoActions: true };
        }
        return await this.updateOrdersOnChainBatch(rebalanceResult);
    }

    /**
     * Process filled orders in capped batches per FILL_PROCESSING.MAX_FILL_BATCH_SIZE.
     * Each chunk triggers its own processFilledOrders → COW plan → broadcast cycle.
     *
     * @param {Array} fills - Filled order objects to process
     * @param {Set|null} excl - Exclusion set (order IDs to skip)
     * @param {string} contextLabel - Label for logging and batch context
     * @param {Object} [options={}] - Passed through to processFilledOrders
     * @returns {{aborted: boolean}}
     */
    async _processFillsWithBatching(fills, excl, contextLabel, options = {}) {
        if (!fills || fills.length === 0) {
            return { aborted: false };
        }

        const managerLog = this.manager?.logger?.log?.bind(this.manager.logger) || (() => {});
        const maxBatch = this._getMaxFillBatchSize();
        const totalFills = fills.length;
        const useUnifiedPlan = totalFills <= maxBatch;
        const modeLabel = useUnifiedPlan ? 'unified' : 'chunked';

        managerLog(
            `Processing ${totalFills} filled orders (${modeLabel}, baseBatch=${useUnifiedPlan ? totalFills : maxBatch})...`,
            'info'
        );

        if (typeof this.manager?.pauseFundRecalc === 'function') {
            this.manager.pauseFundRecalc();
        }
        try {
            let i = 0;
            while (i < totalFills) {
                const remaining = totalFills - i;
                const currentBatchSize = useUnifiedPlan ? remaining : Math.min(maxBatch, remaining);
                const batchEnd = Math.min(i + currentBatchSize, totalFills);
                const fillBatch = fills.slice(i, batchEnd);
                i = batchEnd;

                const batchIds = fillBatch.map(f => f.id).join(', ');
                const label = `${contextLabel} [${batchIds}]`;
                managerLog(
                    `>>> Processing fill set ${label} (${i}/${totalFills})`,
                    'info'
                );

                let fullExcludeSet = excl || new Set();
                if (!useUnifiedPlan) {
                    const batchIdSet = new Set(fillBatch.map(f => f.id));
                    fullExcludeSet = new Set(excl || []);
                    for (const other of fills) {
                        if (batchIdSet.has(other.id)) continue;
                        if (other.orderId) fullExcludeSet.add(other.orderId);
                        if (other.id) fullExcludeSet.add(other.id);
                    }
                }

                const rebalanceResult = await this.manager.processFilledOrders(
                    fillBatch, fullExcludeSet, options
                );
                const batchResult = await this._executeBatchIfNeeded(rebalanceResult, label);

                if (batchResult?.abortedForIllegalState || batchResult?.abortedForAccountingFailure) {
                    managerLog(
                        `[HARD-ABORT] ${label} aborted due to critical state. Skipping remaining fills.`,
                        'error'
                    );
                    return { aborted: true };
                }
            }
        } finally {
            if (typeof this.manager?.resumeFundRecalc === 'function') {
                await this.manager.resumeFundRecalc();
            }
            // End-of-tick safety net: any direct master-grid mutations that
            // did not reach a known persistGrid() site are still persisted
            // here. This catches partial-only fill batches that update slot
            // sizes in-memory via _applyOrderUpdate without triggering a
            // COW rebalance (the bug that left slot-108 with stale size
            // 0.3293 instead of 0.0001 across restarts).
            if (typeof this.manager?.flushGridDirty === 'function') {
                await this.manager.flushGridDirty('end-of-tick fill processing');
            }
        }

        return { aborted: false };
    }

    /**
     * Check if the bot requires credential daemon for write operations.
     * @returns {boolean}
     */
    _isCredentialDaemonWriteRequired() {
        return getKeyStore().isDaemonSigningKey(this.privateKey);
    }

    /**
     * Suspend grid persistence due to credential daemon outage.
     * @param {string} reason - Reason for suspension
     * @returns {void}
     */
    _suspendGridPersistenceForCredentialOutage(reason) {
        if (typeof this.manager?.suspendGridPersistence === 'function') {
            this.manager.suspendGridPersistence(reason);
        }
    }

    /**
     * Resume grid persistence after credential daemon recovery.
     * @param {string} reason - Reason for resuming
     * @returns {void}
     */
    _resumeGridPersistenceAfterCredentialRecovery(reason) {
        if (typeof this.manager?.resumeGridPersistence === 'function') {
            this.manager.resumeGridPersistence(reason);
        }
    }

    /**
     * Ensure the credential daemon is writable before broadcasting operations.
     * @param {string} [contextLabel='write batch'] - Context label for logging
     * @returns {Promise<void>}
     * @throws {Error} With code CREDENTIAL_DAEMON_UNAVAILABLE if daemon is down
     */
    async _ensureCredentialDaemonWritable(contextLabel = 'write batch') {
        if (!this._isCredentialDaemonWriteRequired()) {
            return;
        }

        try {
            if (this.privateKey && getKeyStore().isDaemonSigningKey(this.privateKey)) {
                await chainKeys.pingDaemon(
                    this.privateKey.accountName,
                    Math.min(TIMING.DAEMON_PING_TIMEOUT_MS, TIMING.DAEMON_STARTUP_TIMEOUT_MS),
                    { socketPath: this.privateKey.socketPath }
                );
            }
        } catch (err: any) {
            const message = `Credential daemon unavailable before ${contextLabel}: ${err.message}`;
            this._credentialDaemonDown = true;
            this._credentialRecoveryNeeded = true;
            this._suspendGridPersistenceForCredentialOutage(message);
            this.manager?.logger?.log?.(`[CREDENTIAL] ${message}. Write operations paused; re-unlock with dexbot pm2.`, 'error');
            const wrapped: any = new Error(message);
            wrapped.code = DAEMON_CODES.CREDENTIAL_DAEMON_UNAVAILABLE;
            wrapped.cause = err;
            throw wrapped;
        }
    }

    /**
     * Check if an error is related to credential daemon unavailability.
     * @param {Error|*} err - Error to check
     * @returns {boolean}
     */
    _isCredentialDaemonError(err) {
        if (!err) return false;
        if (err.code === DAEMON_CODES.CREDENTIAL_DAEMON_UNAVAILABLE) return true;
        const message = String(err.message || '');
        return /Credential daemon|Daemon connection failed|daemon .*unavailable|dexbot-cred-daemon\.sock|ECONNREFUSED|ENOENT/.test(message);
    }

    /**
     * Run state recovery after credential daemon is restored.
     * @returns {Promise<void>}
     */
    async _runCredentialRecoveryAfterDaemonRestored() {
        if (this._credentialRecoveryInFlight || !this._credentialRecoveryNeeded || this._shuttingDown) {
            return;
        }

        if (this.manager?.isBootstrapping?.() || this.manager?.isBroadcastingActive?.()) {
            if (!this._credentialRecoveryDeferredTimer) {
                this.manager?.logger?.log?.(
                    '[CREDENTIAL] Deferring credential recovery until startup/broadcast activity is idle.',
                    'info'
                );
                this._credentialRecoveryDeferredTimer = setTimeout(() => {
                    this._credentialRecoveryDeferredTimer = null;
                    this._runCredentialRecoveryAfterDaemonRestored().catch(err => {
                        this.manager?.logger?.log?.(`[CREDENTIAL] Deferred recovery failed: ${err.message}`, 'error');
                        if (this.manager) {
                            this.manager._recoveryState = { ...this.manager._recoveryState, lastFailureAt: Date.now() };
                        }
                    });
                }, 1000);
            }
            return;
        }

        this._credentialRecoveryInFlight = true;
        try {
            this.manager?.logger?.log?.(
                '[CREDENTIAL] Credential daemon restored; reconciling chain state before resuming write batches.',
                'info'
            );
            this._resumeGridPersistenceAfterCredentialRecovery('credential recovery started');
            const runRecovery = async () => {
                await this._triggerStateRecoverySync('credential daemon restored');
                await this._runGridMaintenance('credential-recovery');
            };
            if (this.manager?._fillProcessingLock) {
                await this.manager._fillProcessingLock.acquire(runRecovery);
            } else {
                await runRecovery();
            }
            this._credentialRecoveryNeeded = false;
            this.manager?.logger?.log?.('[CREDENTIAL] Credential recovery sync complete.', 'info');
        } catch (err: any) {
            this._credentialRecoveryNeeded = true;
            this._suspendGridPersistenceForCredentialOutage(`credential recovery failed: ${err.message}`);
            this.manager?.logger?.log?.(
                `[CREDENTIAL] Credential recovery sync failed: ${err.message}. Writes remain guarded by preflight.`,
                'error'
            );
        } finally {
            this._credentialRecoveryInFlight = false;
        }
    }

    /**
     * Start the credential daemon watchdog interval that periodically probes daemon health.
     * @returns {void}
     */
    _setupCredentialDaemonWatchdogInterval() {
        if (this._credentialDaemonWatchdogInterval) {
            clearInterval(this._credentialDaemonWatchdogInterval);
            this._credentialDaemonWatchdogInterval = null;
        }

        if (!this._isCredentialDaemonWriteRequired()) {
            this._credentialDaemonDown = false;
            return;
        }

        const intervalMs = Math.max(TIMING.DAEMON_PING_TIMEOUT_MS, TIMING.CREDENTIAL_DAEMON_WATCHDOG_MS);
        const probe = async () => {
            if (this._shuttingDown || !this._isCredentialDaemonWriteRequired()) return;
            // Guard against overlapping ticks: if the previous probe is still
            // running (slow chain / stall), skip rather than queue a second
            // pingDaemon and a second recovery attempt.
            if (this._credentialDaemonWatchdogInFlight) return;
            this._credentialDaemonWatchdogInFlight = true;
            try {
                const token = this.privateKey;
                try {
                    if (getKeyStore().isDaemonSigningKey(token)) {
                        await chainKeys.pingDaemon(
                            token.accountName,
                            2000,
                            { socketPath: token.socketPath }
                        );
                    }
                    if (this._credentialDaemonDown) {
                        this.manager?.logger?.log?.('[CREDENTIAL] Credential daemon responsive again.', 'info');
                    }
                    this._credentialDaemonDown = false;
                    await this._runCredentialRecoveryAfterDaemonRestored();
                } catch (err: any) {
                    if (!this._credentialDaemonDown) {
                        const errMsg = String(err.message || '');
                        let hint = '';
                        if (errMsg.includes('ENOENT')) {
                            hint = `Socket file missing at ${token.socketPath}. The credential daemon process may have been killed (e.g. by stray Ctrl-C). Restart it with: dexbot pm2 restart dexbot-cred. If the problem persists, check the daemon log: profiles/logs/dexbot-cred.log`;
                        } else if (errMsg.includes('ECONNREFUSED')) {
                            hint = `Connection refused at ${token.socketPath}. The daemon may be in a zombie state or restarting. Try: dexbot pm2 restart dexbot-cred.`;
                        } else if (errMsg.includes('timeout')) {
                            hint = `Probe timed out. The daemon may be under heavy load or blocked. Check profiles/logs/dexbot-cred.log.`;
                        } else {
                            hint = `Write operations will remain paused until re-unlocked with dexbot pm2.`;
                        }

                        this.manager?.logger?.log?.(
                            `[CREDENTIAL] Credential daemon watchdog failed: ${err.message}. ${hint}`,
                            'error'
                        );
                    }
                    this._credentialDaemonDown = true;
                    this._suspendGridPersistenceForCredentialOutage(`credential daemon watchdog failed: ${err.message}`);
                }
            } finally {
                this._credentialDaemonWatchdogInFlight = false;
            }
        };

        this._credentialDaemonWatchdogInterval = setInterval(() => {
            probe().catch(err => {
                this.manager?.logger?.log?.(`[CREDENTIAL] Credential daemon watchdog error: ${err.message}`, 'warn');
            });
        }, intervalMs);
        if (typeof this._credentialDaemonWatchdogInterval.unref === 'function') {
            this._credentialDaemonWatchdogInterval.unref();
        }
        void probe();
        this._log(`Credential daemon watchdog started (${Math.round(intervalMs / TIMING.MILLISECONDS_PER_SECOND)}s interval)`);
    }

    /**
     * Stop the credential daemon watchdog interval.
     * @returns {void}
     */
    _stopCredentialDaemonWatchdogInterval() {
        if (this._credentialDaemonWatchdogInterval) {
            clearInterval(this._credentialDaemonWatchdogInterval);
            this._credentialDaemonWatchdogInterval = null;
        }
    }

    /**
     * Executes a batch of order operations on the blockchain using COW pattern.
     * Master grid is only updated after successful blockchain confirmation.
     * @param {Object} rebalanceResult - COW result containing workingGrid + actions.
     * @returns {Promise<Object>} The batch result.
     */
    async updateOrdersOnChainBatch(rebalanceResult) {
        if (!rebalanceResult || !rebalanceResult.workingGrid) {
            const reason = 'NON_COW_PAYLOAD';
            this.manager?.logger?.log?.(
                `[COW] Rejected non-COW batch payload. Use updateOrdersOnChainPlan() for plan inputs.`,
                'error'
            );
            return { executed: false, aborted: true, reason };
        }

        return await this._updateOrdersOnChainBatchCOW(rebalanceResult);
    }

    /**
     * Converts simple plan payloads (place/update/rotate/cancel) into a COW batch.
     * Used by spread/divergence maintenance and bootstrap helpers.
     * @param {Object|Array} plan - Plan object or array of ordersToPlace
     * @returns {Promise<Object>} Batch execution result
     */
    async updateOrdersOnChainPlan(plan) {
        const cowResult = this._buildCowResultFromPlan(plan);
        return await this._updateOrdersOnChainBatchCOW(cowResult);
    }

    /**
     * Build COW actions array from a simple plan object or array of ordersToPlace.
     * @param {Object|Array} plan - Plan object with ordersToPlace/ordersToRotate/ordersToUpdate/ordersToCancel, or array of ordersToPlace
     * @returns {Array<{type: string, id: string, order?: Object, orderId?: string, newSize?: number, newPrice?: number, newGridId?: string}>}
     */
    _buildActionsFromPlan(plan) {
        return cowRuntime.buildActionsFromPlan(this, plan);
    }

    /**
     * Build a COW result object (workingGrid + actions) from a simple plan.
     * @param {Object|Array} plan - Plan object or array of ordersToPlace
     * @returns {{workingGrid: import('./types').WorkingGrid, workingIndexes: Object, workingBoundary: number, actions: Array}}
     */
    _buildCowResultFromPlan(plan) {
        return cowRuntime.buildCowResultFromPlan(this, plan);
    }

    /**
     * Restore skipped update slots in the working grid to master state.
     * @param {import('./types').WorkingGrid} workingGrid - Working grid to restore slots into
     * @param {Set<string>} skippedSlotIds - Set of slot IDs that were skipped
     * @param {number} [skippedCount=0] - Count of skipped actions for logging
     * @returns {void}
     */
    _restoreSkippedUpdateSlotsInWorkingGrid(workingGrid, skippedSlotIds, skippedCount = 0) {
        return cowRuntime.restoreSkippedUpdateSlotsInWorkingGrid(this, workingGrid, skippedSlotIds, skippedCount);
    }

    /**
     * COW broadcast: Execute blockchain operations and commit working grid on success.
     * Master grid is ONLY updated after successful blockchain confirmation.
     * @param {Object} cowResult - COW result with workingGrid, actions, etc.
     * @returns {Promise<Object>} The batch result.
     * @private
     */
    async _updateOrdersOnChainBatchCOW(cowResult) {
        return cowRuntime.updateOrdersOnChainBatchCOW(this, cowResult);
    }

    async _processBatchResults(result, opContexts) {
        return cowRuntime.processBatchResults(this, result, opContexts);
    }
    /**
     * Perform grid recalculation triggered by trigger file.
     * Reloads config from disk, recalculates grid, resets funds, and removes trigger file.
     * Must be called with _fillProcessingLock already held.
     * @param {Object} [options] - Optional configuration for grid resync.
     * @returns {Promise<boolean>} True if resync succeeded
     * @private
     */
    async _performGridResync(options = {}) {
        return DexbotMaintenanceRuntime.performGridResync(this, options);
    }

    /**
     * Handle any pending trigger file reset at startup.
     * This is called FIRST during startup before any grid operations.
     * @returns {Promise<boolean>} True if trigger reset completed successfully, false otherwise
     * @private
     */
    async _handlePendingTriggerReset() {
        return DexbotMaintenanceRuntime.handlePendingTriggerReset(this);
    }

    /**
     * Setup trigger file detection for grid reset.
     * Monitors the trigger file and performs grid resync when it's created.
     * @private
     */
    async _setupTriggerFileDetection() {
        return DexbotMaintenanceRuntime.setupTriggerFileDetection(this);
    }

    /**
     * Starts the bot's operation.
     * @param {string|Object|Buffer} [vaultSecret=null] - The unlock secret.
     * @returns {Promise<void>}
     */
    async start(vaultSecret = null) {
        await this.initialize(vaultSecret);
        await this._runStartupSequence();
    }

    /**
     * Start bot with a pre-decrypted private key.
     * Alternative to start(vaultSecret) when the signing secret is already available.
     * @param {string|Object} privateKey - Pre-decrypted private key or daemon signing token
     * @returns {Promise<void>}
     */
    async startWithPrivateKey(privateKey) {
        // Initialize account data with provided private key
        await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);

        if (this.config && this.config.preferredAccount) {
            try {
                this.privateKey = privateKey;
                await this._setupAccountContext(this.config.preferredAccount);
            } catch (err: any) {
                this._warn(`Auto-selection of preferredAccount failed: ${err.message}`);
                throw err;
            }
        } else {
            throw new Error('No preferredAccount configured');
        }

        await this._runStartupSequence();
    }

    /**
     * Common startup sequence logic shared between start() and startWithPrivateKey().
     * @private
     */
    async _runStartupSequence() {
        try {
            if (this.config.creditOnly) {
                await this._runCreditOnlyStartup();
                return;
            }
            const startupState = await this._initializeStartupState();
            await this._finishStartupSequence(startupState);
        } catch (err: any) {
            this._warn(`Error during grid initialization: ${err.message}`);
            await this.shutdown();
            throw err;
        }
    }

    async _runCreditOnlyStartup() {
        await this._setupCreditRuntime();
        await this._refreshAndSyncCreditRuntime();
        await this._runCreditRuntimeMaintenance('startup');
        this._setupCreditWatchdogInterval();
        this._setupCredentialDaemonWatchdogInterval();
        this._log('DEXBot started (credit-only mode)');
    }

    /**
     * Perform periodic grid checks: fund thresholds, spread condition, grid health.
     * Called by the periodic blockchain fetch interval to check if grid needs updates.
     *
     * IMPORTANT: This method MUST only be called from within _fillProcessingLock.acquire()
     * (specifically from _setupBlockchainFetchInterval).
     *
     * @private
     */
    async _performPeriodicGridChecks() {
        return DexbotMaintenanceRuntime.performPeriodicGridChecks(this);
    }

    _isOpenOrdersSyncLoopEnabled() {
        return DexbotMaintenanceRuntime.isOpenOrdersSyncLoopEnabled(this);
    }

    /**
     * Start the open-orders watchdog sync loop.
     * Uses fill lock contention checks to avoid competing with fill processing.
     * @private
     */
    _startOpenOrdersSyncLoop() {
        return DexbotMaintenanceRuntime.startOpenOrdersSyncLoop(this);
    }

    /**
     * Stop the open-orders watchdog sync loop.
     * @private
     */
    async _stopOpenOrdersSyncLoop() {
        return DexbotMaintenanceRuntime.stopOpenOrdersSyncLoop(this);
    }

    /**
     * Set up periodic blockchain account balance fetch interval.
     * Fetches available funds at regular intervals to keep blockchain variables up-to-date.
     * @private
     */
    _setupBlockchainFetchInterval() {
        return DexbotMaintenanceRuntime.setupBlockchainFetchInterval(this);
    }

    /**
     * Stop the periodic blockchain fetch interval.
     * @private
     */
    _stopBlockchainFetchInterval() {
        return DexbotMaintenanceRuntime.stopBlockchainFetchInterval(this);
    }

    async _releaseMarketAdapterRuntime(context = 'shutdown') {
        return DexbotMaintenanceRuntime.releaseMarketAdapterRuntime(this, this.config?.botKey || this.config?.name, context);
    }

    /**
     * Get or create the credit runtime for debt policy management.
     * @returns {import('./credit_runtime').CreditRuntime|null}
     */
    _getCreditRuntime() {
        const lending = this.config?.debtPolicy?.lending;
        const enabledPolicy = Array.isArray(lending)
            && lending.length > 0
            && lending.every((item) => typeof item?.collateralAsset === 'string' && item.collateralAsset.length > 0);
        if (!enabledPolicy) {
            this._creditRuntime = null;
            return null;
        }
        if (!this._creditRuntime) {
            this._creditRuntime = new CreditRuntime(this, {
                stateDir: PATHS.CREDIT_RUNTIME_DIR,
            });
        }
        return this._creditRuntime;
    }

    /**
     * Set up the credit runtime by loading its persisted state.
     * @returns {Promise<import('./credit_runtime').CreditRuntime|null>}
     */
    async _setupCreditRuntime() {
        const runtime = this._getCreditRuntime();
        if (!runtime) {
            return null;
        }
        await runtime.loadState();
        return runtime;
    }

    /**
     * Refresh credit runtime state from chain and sync internal tracking.
     * @returns {Promise<void>}
     */
    async _refreshAndSyncCreditRuntime() {
        const runtime = this._getCreditRuntime();
        if (!runtime) return;
        try {
            await runtime.refreshState();
        } catch (err: any) {
            this._warn(`Credit runtime refresh/sync failed: ${err.message}`);
        }
    }

    /**
     * Run credit runtime maintenance (deal checks, collateral monitoring).
     * @param {string} [context='periodic'] - Maintenance context
     * @param {Object} [options={}] - Maintenance options
     * @returns {Promise<*>} Maintenance result from runtime
     */
    async _runCreditRuntimeMaintenance(context = 'periodic', options = {}) {
        const runtime = this._getCreditRuntime();
        if (!runtime) {
            return null;
        }
        return runtime.runMaintenance(context, options);
    }

    /**
     * Start the credit deal watchdog interval.
     * @returns {void}
     */
    _setupCreditWatchdogInterval() {
        const runtime = this._getCreditRuntime();
        if (!runtime) {
            return;
        }
        const intervalMin = Number(this.config?.TIMING?.CREDIT_DEAL_CHECK_INTERVAL_MIN ?? TIMING.CREDIT_DEAL_CHECK_INTERVAL_MIN);
        if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
            this._log('Credit deal watchdog disabled by configuration (TIMING.CREDIT_DEAL_CHECK_INTERVAL_MIN <= 0)');
            return;
        }
        if (this._creditWatchdogInterval) {
            clearInterval(this._creditWatchdogInterval);
            this._creditWatchdogInterval = null;
        }
        const intervalMs = intervalMin * 60 * TIMING.MILLISECONDS_PER_SECOND;
        this._creditWatchdogInterval = setInterval(async () => {
            try {
                await runtime.runCreditWatchdog();
            } catch (err: any) {
                this._warn(`Credit watchdog error: ${err.message}`);
            }
        }, intervalMs);
        if (typeof this._creditWatchdogInterval?.unref === 'function') {
            this._creditWatchdogInterval.unref();
        }
        this._log(`Credit deal watchdog started (${intervalMin}min interval)`);
    }

    /**
     * Stop the credit deal watchdog interval.
     * @returns {void}
     */
    _stopCreditWatchdogInterval() {
        if (this._creditWatchdogInterval) {
            clearInterval(this._creditWatchdogInterval);
            this._creditWatchdogInterval = null;
        }
    }

    async requestGridReset(reason = 'structural change', options: { refreshCenterPrice?: boolean; [key: string]: any } = {}) {
        if (!this.manager || typeof this._performGridResync !== 'function') {
            return { skipped: true, reason: 'grid resync unavailable' };
        }

        const message = reason ? `[CR-RESET] ${reason}` : '[CR-RESET] grid reset requested';
        this._log(`${message}; rebuilding grid from fresh on-chain state`, 'info');
        const resetOptions = {
            ...options,
            refreshCenterPrice: options.refreshCenterPrice !== false,
        };

        // Skip acquire if no lock exists (no fill processing to serialize against)
        // or if the caller already holds the lock (re-entrant). In the latter case
        // the lock's isReentrant() check prevents queueing and runs inline.
        // Otherwise, wait on the queue — this is the intended path for callers
        // outside the fill-processing context that need exclusive access.
        if (!this.manager._fillProcessingLock || this.manager._fillProcessingLock.isReentrant()) {
            return this._performGridResync(resetOptions);
        }

        return this.manager._fillProcessingLock.acquire(async () => this._performGridResync(resetOptions));
    }

    _wireStructuralGridResyncRequest() {
        if (!this.manager || this.manager.requestStructuralGridResync) return;

        this.manager.requestStructuralGridResync = async (reason = 'structural recovery', details: { unmatchedChainOrders?: any[]; [key: string]: any } = {}) => {
            if (this._shuttingDown) {
                return { skipped: true, reason: 'shutting down' };
            }

            if (this._structuralGridResyncRunning || this._structuralGridResyncTimer) {
                return { skipped: true, reason: 'structural grid resync already scheduled' };
            }

            const unmatchedCount = Array.isArray(details?.unmatchedChainOrders)
                ? details.unmatchedChainOrders.length
                : 0;
            this._structuralGridResyncTimer = setTimeout(async () => {
                this._structuralGridResyncTimer = null;
                if (this._shuttingDown) return;

                this._structuralGridResyncRunning = true;
                try {
                    // Try the lighter persisted-grid reload before full reset.
                    const persistedResult = await this._recoverFromPersistedGrid();
                    if (persistedResult.success) {
                        if (this.manager?._recoveryState) {
                            this.manager._recoveryState = { ...this.manager._recoveryState, attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0 };
                        }
                        return;
                    }

                    const suffix = unmatchedCount > 0 ? ` (${unmatchedCount} unmatched chain order(s))` : '';
                    this._warn(`[RECOVERY] Running structural full grid resync for ${reason}${suffix}`);
                    const resetResult = await this.requestGridReset('rms_structural_grid_resync', {
                        refreshCenterPrice: true,
                    });
                    if (resetResult && this.manager?._recoveryState) {
                        this.manager._recoveryState = { ...this.manager._recoveryState, attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0 };
                    }
                } catch (err: any) {
                    this._warn(`[RECOVERY] Structural full grid resync failed: ${err.message}`);
                } finally {
                    this._structuralGridResyncRunning = false;
                    if (this.manager?._recoveryState) {
                        this.manager._recoveryState = { ...this.manager._recoveryState, structuralResyncRequested: false };
                    }
                }
            }, 0);

            return { scheduled: true };
        };
    }

    /**
     * Get current metrics for monitoring and debugging.
     * @returns {Object} Metrics snapshot
     */
    getMetrics() {
        this.manager?._cleanExpiredLocks?.();
        return {
            ...this._metrics,
            queueDepth: this._incomingFillQueue.length,
            fillProcessingLockActive: this.manager?._fillProcessingLock?.isLocked() || false,
            divergenceLockActive: this.manager?._divergenceLock?.isLocked() || false,
            shadowLocksActive: this.manager?.shadowOrderIds?.size || 0,
            recoveryExhaustedAt: this.manager?._recoveryExhaustedAt || null,
            recentFillsTracked: this._recentlyProcessedFills.size
        };
    }

    /**
     * Execute grid maintenance checks in strict order with pipeline consensus.
     *
     * CRITICAL DESIGN: All structural grid modifications are deferred until the pipeline
     * is empty to prevent "race-to-resize" conditions where the bot attempts to reallocate
     * temporary fund surpluses from filled orders before their counter-orders/rotations
     * are placed.
     *
     * MAINTENANCE SEQUENCE:
     * 1. Fund Recalculation (ALWAYS) - Updates internal fund metrics
     * 2. Pipeline Check (GATE) - Verifies no pending operations
     * 3. Health Check (IF IDLE) - Detects and cleans dust orders
     * 4. Divergence Detection (IF IDLE) - Identifies structural mismatches
     * 5. Grid Resizing (IF IDLE) - Applies size corrections on-chain
     * 6. Spread Correction (IF IDLE) - Corrects spread after structural work completes
     *
     * WHY PIPELINE CONSENSUS MATTERS:
     * - After a fill, funds temporarily show a "surplus" from the filled order
     * - If grid maintenance runs immediately, it sees the surplus and triggers a resize
     * - The resize attempts to allocate funds that will be consumed by pending counter-orders
     * - This causes cascading trades, fund accounting errors, and grid instability
     * - Solution: Wait for pipeline to empty (all rotations placed) before resizing
     *
     * TIMEOUT SAFETY:
     * - clearStalePipelineOperations() clears stuck operations after 5-minute timeout
     * - Called before pipeline check to prevent indefinite blocking
     * - See manager.clearStalePipelineOperations() for details
     *
     * @param {Object} context - Maintenance context for logging.
     * @private
     */
    async _executeMaintenanceLogic(context) {
        return DexbotMaintenanceRuntime.executeMaintenanceLogic(this, context);
    }

    /**
     * Cancel dust partial orders immediately — no maps, no timers, no delay.
     * Each dust order is cancelled on chain and its slot rotated through the
     * synthetic-fill pipeline.
     * @param {{ buy: Array, sell: Array }} options
     * @returns {Promise<{cancelledCount: number, batchResult: {aborted: boolean}|null}>}
     * @private
     */
    async _cancelDustOrders({ buy: buyDust = [], sell: sellDust = [] } = {}) {
        return DexbotMaintenanceRuntime.cancelDustOrders(this, { buy: buyDust, sell: sellDust });
    }

    /**
     * Run a single dust health check cycle: inspect grid for partials below the
     * configured dust threshold and cancel them immediately inside the fill-
     * processing lock (with timeout).  Safe to call from the periodic timer or
     * once at startup.
     * @private
     */
    async _runDustHealthCheck() {
        if (this._shuttingDown || !this.manager) return;
        try {
            const health = await this.manager.checkGridHealth(
                this.updateOrdersOnChainPlan?.bind(this)
            );
            const buyDust = health.buyDustOrders || [];
            const sellDust = health.sellDustOrders || [];
            const totalDust = buyDust.length + sellDust.length;
            if (totalDust > 0) {
                this._log(`[DUST] Health check: ${totalDust} dust order(s) (buy=${buyDust.length}, sell=${sellDust.length})`);
                const lock = this.manager._fillProcessingLock;
                if (lock && typeof lock.acquire === 'function') {
                    await lock.acquire(async () => {
                        await this._cancelDustOrders({
                            buy: health.buyDustOrders,
                            sell: health.sellDustOrders,
                        });
                    }, { timeout: TIMING.DUST_CANCEL_TIMEOUT_MS });
                } else {
                    this._warn('[DUST] Fill lock unavailable — cancelling dust without lock (potential race)');
                    await this._cancelDustOrders({
                        buy: health.buyDustOrders,
                        sell: health.sellDustOrders,
                    });
                }
            }
        } catch (err) {
            if (err?.message?.includes('Lock acquisition timeout')) {
                this._warn('[DUST] Lock busy, skipping dust cancel this cycle (retry in 5 min)');
            } else {
                this._warn(`[DUST] Health check error (retry in 5 min): ${err?.message || err}`);
            }
        }
    }

    /**
     * Set up the periodic dust health check interval.
     * Catches partials below the dust threshold that were missed by the post-fill
     * pipeline (e.g. from a prior bot lifetime after crash/restart).
     * Calls _runDustHealthCheck on each tick.
     * @private
     */
    _setupDustHealthCheckInterval() {
        this._dustHealthCheckTimer = setInterval(() => {
            this._runDustHealthCheck();
        }, TIMING.DUST_HEALTH_CHECK_INTERVAL_MS);
        if (typeof this._dustHealthCheckTimer?.unref === 'function') {
            this._dustHealthCheckTimer.unref();
        }
    }

    /**
     * Perform grid maintenance: fund thresholds, spread condition, grid health, divergence.
     * Consolidates maintenance checks used during startup, periodic updates, and post-fill.
     *
     * ENTRY POINTS:
     * 1. Startup (line ~681): After grid initialization, ensures grid is healthy
     * 2. Periodic (line ~2682): Every BLOCKCHAIN_FETCH_INTERVAL_MIN (default 240 min)
     * 3. Post-Fill (line ~1059): After order fills are rotated
     *
     * PIPELINE PROTECTION:
     * All maintenance operations inside _executeMaintenanceLogic respect isPipelineEmpty().
     * This prevents grid modifications while fills/rotations/corrections are pending.
     * See _executeMaintenanceLogic documentation for detailed rationale.
     *
     * LOCK ORDERING:
     * - Canonical order: _fillProcessingLock → _divergenceLock
     * - When called from post-fill context, fill lock is already held
     * - When called from periodic context, both locks must be acquired
     * - Matches the order used in _consumeFillQueue to prevent deadlocks
     *
     * @param {string} context - Maintenance context for logging (e.g. 'startup', 'periodic', 'post-fill')
     * @param {Object} options - Maintenance options
     * @private
     */
    async _runGridMaintenance(context = 'periodic', options = {}) {
        return DexbotMaintenanceRuntime.runGridMaintenance(this, context, options);
    }

    /**
     * Gracefully shutdown the bot.
     * Waits for current fill processing to complete, persists state, and stops intervals.
     * Idempotent: subsequent calls await the first shutdown so duplicate cleanup
     * invocations do not run the body twice or exit before persistence finishes.
     * @returns {Promise<void>}
     */
    async shutdown() {
        if (this._shuttingDown) {
            this._log('Shutdown already in progress; ignoring re-entrant call');
            return this._shutdownPromise || Promise.resolve();
        }
        this._shuttingDown = true;
        const shutdownImpl = typeof this._shutdownImpl === 'function'
            ? this._shutdownImpl
            : DEXBot.prototype._shutdownImpl;
        this._shutdownPromise = shutdownImpl.call(this);
        return this._shutdownPromise;
    }

    async _shutdownImpl() {
        this._log('Initiating graceful shutdown...');
        this._processedFillStore.setShuttingDown(true);

        // Stop accepting new work
        this._stopBlockchainFetchInterval();

        if (this._triggerDebounceTimer) {
            clearTimeout(this._triggerDebounceTimer);
            this._triggerDebounceTimer = null;
        }

        if (this._deferredGridResyncTimer) {
            clearTimeout(this._deferredGridResyncTimer);
            this._deferredGridResyncTimer = null;
        }

        if (this._maintenanceIdleTimer) {
            clearTimeout(this._maintenanceIdleTimer);
            this._maintenanceIdleTimer = null;
        }

        if (this._credentialRecoveryDeferredTimer) {
            clearTimeout(this._credentialRecoveryDeferredTimer);
            this._credentialRecoveryDeferredTimer = null;
        }

        if (this._structuralGridResyncTimer) {
            clearTimeout(this._structuralGridResyncTimer);
            this._structuralGridResyncTimer = null;
        }

        if (this._dustHealthCheckTimer) {
            clearInterval(this._dustHealthCheckTimer);
            this._dustHealthCheckTimer = null;
        }

        this._stopCreditWatchdogInterval();
        this._stopCredentialDaemonWatchdogInterval();

        if (this._creditRuntime) {
            try {
                await this._creditRuntime.shutdown();
            } catch (err: any) {
                this._warn(`Failed to persist credit runtime state: ${err.message}`);
            }
        }

        if (this._triggerWatcher && typeof this._triggerWatcher.close === 'function') {
            try {
                this._triggerWatcher.close();
            } catch (err: any) {
                this._warn(`Failed to close trigger watcher: ${err.message}`);
            } finally {
                this._triggerWatcher = null;
            }
        }

        if (typeof this._fillsUnsubscribe === 'function') {
            try {
                await this._fillsUnsubscribe();
            } catch (err: any) {
                this._warn(`Failed to unsubscribe fill listener: ${err.message}`);
            } finally {
                this._fillsUnsubscribe = null;
            }
        }

        if (typeof this._reconnectUnregister === 'function') {
            try { this._reconnectUnregister(); } catch (err: any) {
                this._warn(`Error unregistering reconnect callback: ${err.message}`);
            }
            this._reconnectUnregister = null;
        }

        try {
            await this._stopOpenOrdersSyncLoop();
        } catch (err: any) {
            this._warn(`Error while stopping open-orders sync loop: ${err.message}`);
        }

        try {
            await this._releaseMarketAdapterRuntime('shutdown');
        } catch (err: any) {
            this._warn(`Error while releasing market adapter runtime: ${err.message}`);
        }

        // Wait for current fill processing to complete
        try {
            if (!this.manager?._fillProcessingLock) {
                this._warn('Shutdown lock skipped: manager or fillProcessingLock unavailable');
            } else {
                const shutdownLockTimeoutMs = this.config?.timing?.SYNC_LOCK_TIMEOUT_MS;
                let shutdownLockTimer;
                // AsyncLock starts the callback as soon as the lock is available,
                // which can be a few ms after the timeout fires. Without this
                // claim flag, the lock callback and the fallback path would both
                // run their own _flushProcessedFillPersistence + persistGrid,
                // racing on the same persistence targets. Set the flag the moment
                // the timeout fires (and at the top of the lock callback) so
                // exactly one path performs the flush.
                let flushClaimed = false;
                const lockResult = await Promise.race([
                    this.manager._fillProcessingLock.acquire(async () => {
                        if (flushClaimed) {
                            this._log('Shutdown: fallback flush already ran, skipping lock-protected flush');
                            return;
                        }
                        flushClaimed = true;
                        this._log('Fill processing lock acquired for shutdown');

                        // Log any remaining queued fills
                        if (this._incomingFillQueue.length > 0) {
                            this._warn(`${this._incomingFillQueue.length} fills queued but not processed at shutdown`);
                        }

                        await this._flushProcessedFillPersistence('shutdown');

                        // Persist final state
                        if (this.manager && this.accountOrders && this.config?.botKey) {
                            try {
                                await this.manager.persistGrid();
                                this._log('Final grid snapshot persisted');
                            } catch (err: any) {
                                this._warn(`Failed to persist final state: ${err.message}`);
                            }
                        }
                    }).then(() => 'acquired'),
                    new Promise<string>((resolve) => {
                        shutdownLockTimer = setTimeout(() => {
                            // Claim the flush for the fallback path BEFORE the
                            // race resolves, so if the lock callback starts
                            // microseconds later it sees the claim.
                            flushClaimed = true;
                            resolve('timed-out');
                        }, shutdownLockTimeoutMs);
                    })
                ]).finally(() => {
                    if (shutdownLockTimer) clearTimeout(shutdownLockTimer);
                });

                if (lockResult === 'timed-out') {
                    this._warn(
                        `Shutdown: _fillProcessingLock not acquired within ${shutdownLockTimeoutMs}ms — ` +
                        `falling back to best-effort flush without lock.`
                    );
                    // Best-effort flush without the lock. The lock's only
                    // purpose during shutdown is to prevent concurrent
                    // updates; if we're shutting down, no other updater is
                    // running. The risk is if the bot is being restarted
                    // (not stopped) — in which case the same race window
                    // applies. The trade-off is: prefer losing one batch of
                    // recent fills over skipping persistence entirely.
                    try {
                        if (this._incomingFillQueue.length > 0) {
                            this._warn(
                                `${this._incomingFillQueue.length} fills queued at shutdown; ` +
                                `persisting without lock.`
                            );
                        }
                        await this._flushProcessedFillPersistence('shutdown-fallback');
                        if (this.manager && this.accountOrders && this.config?.botKey) {
                            try {
                                await this.manager.persistGrid();
                                this._log('Final grid snapshot persisted (best-effort, lock not held)');
                            } catch (err: any) {
                                this._warn(`Failed to persist final state (best-effort): ${err.message}`);
                            }
                        }
                    } catch (err: any) {
                        this._warn(`Best-effort flush during shutdown failed: ${err.message}`);
                    }
                }

                // Always reset the fill-consumer watchdog on shutdown completion,
                // regardless of whether persistGrid ran or succeeded.
                this._consecutiveConsumeFailures = 0;
                this._consumeFailureFirstAt = 0;
            }
        } catch (err: any) {
            this._warn(`Error during shutdown lock acquisition: ${err.message}`);
        }

        // Release fund registry allocation
        if (this.config?.preferredAccount) {
            const botName = this.config.botKey;
            if (botName) {
                fundRegistry.releaseAllocation(this.config.preferredAccount, botName).catch((err: any) => {
                    this._warn(`Failed to release fund allocation for ${botName}: ${err.message}`);
                });
            }
        }

        // Log final metrics
        const metrics = this.getMetrics();
        this._log(`Shutdown complete. Final metrics: fills=${metrics.fillsProcessed}, batches=${metrics.batchesExecuted}, ` +
            `avgProcessingTime=${metrics.fillsProcessed > 0 ? Format.formatMetric2(metrics.fillProcessingTimeMs / metrics.fillsProcessed) : 0}ms, ` +
            `lockContentions=${metrics.lockContentionEvents}, maxQueueDepth=${metrics.maxQueueDepth}`);

        // Drop botHmacSecret reference from the signing token (V8 string cannot
        // be zeroed in place, but dropping the reference allows GC to reclaim it).
        if (this.privateKey && getKeyStore().isDaemonSigningKey(this.privateKey)) {
            this.privateKey.botHmacSecret = null;
        }

        await this.manager?.logger?.flush();
    }
}

export = Object.assign(DEXBot, {
    normalizeBotEntry: require('./bot_settings').normalizeBotEntry
});
