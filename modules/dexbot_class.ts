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

const { BitShares, waitForConnected } = require('./bitshares_client');
const chainKeys = require('./chain_keys');
const { getKeyStore } = require('./key_store');
const chainOrders = require('./chain_orders');
const fundRegistry = require('./fund_registry');
const {
    hasExecutableActions,
} = require('./order/utils/validate');
const {
    ProcessedFillStore,
    PROCESSED_FILL_PERSISTENCE_MODES
} = require('./order/processed_fill_store');
const DexbotFillRuntime = require('./dexbot_fill_runtime');
const DexbotMaintenanceRuntime = require('./dexbot_maintenance_runtime');
const DexbotStateRecovery = require('./dexbot_state_recovery');
const DexbotStartupRuntime = require('./dexbot_startup_runtime');
const CreditRuntime = require('./credit_runtime');
const {
    TIMING,
    FILL_PROCESSING,
    DAEMON_CODES,
} = require('./constants');
const { PATHS, getRecalculateTriggerFile } = require('./paths');
const { cloneWeightDistribution } = require('./order/utils/math');
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
    _lastBroadcastHeartbeatAt: number | undefined;
    _lastDeferredDustCount: number;
    _currentBatchId: string | number | null | undefined;

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
        return DexbotStateRecovery.persistAndRecoverIfNeeded(this);
    }

    /**
     * Snapshot the recently queued fill keys as a plain object for crash-durable persistence.
     * Merges with any existing snapshot to avoid losing keys that were evicted from the
     * in-memory map between persist cycles but remain within the dedup window.
     * Only includes entries within the dedup window to avoid writing stale keys.
     * @returns {Record<string, number>}
     */
    _getRecentFillKeysSnapshot() {
        return DexbotStateRecovery.getRecentFillKeysSnapshot(this);
    }

    /**
     * Get current pipeline signal state for congestion checks.
     * @returns {{incomingFillQueueLength: number, shadowLocks: number, batchInFlight: boolean, recoveryInFlight: boolean, broadcasting: boolean}}
     */
    _getPipelineSignals() {
        return DexbotMaintenanceRuntime.getPipelineSignals(this);
    }

    /**
     * Mark that grid activity occurred (updates idle timer).
     * @param {string} [reason='activity'] - Reason for activity
     * @returns {void}
     */
    _markGridActivity(reason = 'activity') {
        return DexbotMaintenanceRuntime.markGridActivity(this, reason);
    }

    /**
     * Trigger a full state recovery sync (fetch chain + sync from open orders + persist).
     * @param {string} [reason='state recovery sync'] - Reason for recovery
     * @returns {Promise<void>}
     */
    async _triggerStateRecoverySync(reason = 'state recovery sync') {
        return DexbotStateRecovery.triggerStateRecoverySync(this, reason);
    }

    /**
     * Abort the current flow if an illegal state signal was raised.
     * @param {string} flowContext - Description of the flow being aborted
     * @returns {Promise<boolean>} True if flow was aborted
     */
    async _abortFlowIfIllegalState(flowContext) {
        return DexbotStateRecovery.abortFlowIfIllegalState(this, flowContext);
    }

    /**
     * Handle a hard abort from batch processing due to illegal state or accounting failure.
     * @param {Error} err - The error that triggered the abort
     * @param {string} [phase='batch processing'] - Phase description
     * @param {number} [opsCount=0] - Number of operations in the batch
     * @returns {Promise<Object>} Abort result object
     */
    async _handleBatchHardAbort(err, phase = 'batch processing', opsCount = 0) {
        return DexbotStateRecovery.handleBatchHardAbort(this, err, phase, opsCount);
    }

    /**
     * Apply recoverable grid updates (order virtualisation) after a batch failure.
     * @param {Array<Object>} updates - Array of order update objects
     * @param {string} [context='recoverable-grid-update'] - Context label for logging
     * @returns {Promise<number>} Number of updates applied
     */
    async _applyRecoverableGridUpdates(updates, context = 'recoverable-grid-update') {
        return DexbotStateRecovery.applyRecoverableGridUpdates(this, updates, context);
    }

    /**
     * Recover from explicit stale order errors by virtualizing affected grid slots.
     * @param {Set<string>|string[]} staleOrderIds - Set or array of stale chain order IDs
     * @param {string} [reason='stale order cleanup'] - Reason for cleanup
     * @returns {Promise<{executed: boolean, hadRotation: boolean, stale: boolean, recoveredByVirtualization?: boolean}>}
     */
    async _recoverExplicitStaleOrders(staleOrderIds, reason = 'stale order cleanup') {
        return DexbotStateRecovery.recoverExplicitStaleOrders(this, staleOrderIds, reason);
    }

    /**
     * Recover from on-chain size drift detected during batch broadcast.
     * @param {Error} err - The size drift error
     * @returns {Promise<{executed: boolean, hadRotation: boolean, recoveredBySync: boolean, reason: string}>}
     */
    async _recoverBatchSizeDrift(err, opContexts = []) {
        return DexbotStateRecovery.recoverBatchSizeDrift(this, err, opContexts);
    }

    /**
     * Extract chain order IDs from opContexts for operations that could
     * trigger a size-drift error (size-update and rotation update).
     * @param {Array<Object>} opContexts
     * @returns {string[]} Unique chain order IDs
     */
    _extractSizeDriftOrderIds(opContexts) {
        return DexbotStateRecovery.extractSizeDriftOrderIds(opContexts);
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
        return DexbotStateRecovery.recoverFromPersistedGrid(this);
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
        return DexbotStateRecovery.rejectCorruptedGridSnapshot(this, context);
    }

    /**
     * Attempt to repair size-drift for specific order IDs by reading their
     * current on-chain state and correcting the local grid directly.
     * Falls back gracefully (returns false) on any error.
     * @param {string[]} orderIds
     * @returns {Promise<boolean>} True if all affected orders were repaired
     */
    async _targetedOrderRepair(orderIds) {
        return DexbotStateRecovery.targetedOrderRepair(this, orderIds);
    }

    /**
     * Initialize bot state from storage and blockchain.
     * Consolidates common initialization logic for start() and startWithPrivateKey().
     * @returns {{persistedGrid: Object, persistedBtsFeesOwed: number, persistedBoundaryIdx: number, persistedBtsBalance: number, persistedRecentFillKeys: Object}}
     * @private
     */
    async _initializeStartupState() {
        return DexbotStartupRuntime.initializeStartupState(this);
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
        return DexbotStartupRuntime.finishStartupSequence(this, startupState);
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
        return DexbotMaintenanceRuntime.syncOpenOrdersAndProcessFills(this, tag);
    }

    _maxConsecutiveFillConsumerFailures() {
        return DexbotFillRuntime.maxConsecutiveFillConsumerFailures(this);
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
        return DexbotFillRuntime.computeFillConsumerBackoffMs(this, failures);
    }

    _scheduleFillConsumerRestart(chainOrders) {
        DexbotFillRuntime.scheduleFillConsumerRestart(this, chainOrders);
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
        return DexbotFillRuntime.consumeFillQueue(this, chainOrders);
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
        return DexbotFillRuntime.processFillsWithBootstrapMode(this, chainOrders);
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
        return DexbotStartupRuntime.placeInitialOrdersImpl(this);
    }

    /**
     * Build outside-in pair groups for initial order placement.
     * @param {Array<Object>} orders - Array of order objects
     * @returns {Array<Array<Object>>} Grouped order arrays
     */
    _buildOutsideInPairGroupsForOrders(orders) {
        return cowRuntime.buildOutsideInPairGroupsForOrders(orders);
    }

    /**
     * Build outside-in pair groups for create entry contexts.
     * @param {Array<Object>} createEntries - Array of create entry objects with context.order
     * @returns {Array<Array<Object>>} Grouped entry arrays
     */
    _buildOutsideInPairGroupsForCreateEntries(createEntries) {
        return cowRuntime.buildOutsideInPairGroupsForCreateEntries(createEntries);
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
        return cowRuntime.extractOperationResults(result, warnContext, this.manager?.logger?.log?.bind(this.manager?.logger));
    }

    /**
     * Find CREATE operation contexts whose broadcast result did not include a chain order id.
     *
     * @param {Array} operationResults - operation_results aligned with opContexts.
     * @param {Array<Object>} opContexts - Operation context metadata aligned with operations.
     * @returns {Array<{index:number, ctx:Object}>} Missing create result contexts.
     */
    _findMissingCreateResultContexts(operationResults, opContexts) {
        return cowRuntime.findMissingCreateResultContexts(operationResults, opContexts);
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
        return cowRuntime.formatUnmatchedChainOrderForLog(order);
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
        return cowRuntime.clearPendingBroadcasts(this.manager?._pendingBroadcasts);
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
        return DexbotMaintenanceRuntime.requestGridReset(this, reason, options);
    }

    _wireStructuralGridResyncRequest() {
        return DexbotMaintenanceRuntime.wireStructuralGridResyncRequest(this);
    }

    /**
     * Get current metrics for monitoring and debugging.
     * @returns {Object} Metrics snapshot
     */
    getMetrics() {
        return DexbotMaintenanceRuntime.getMetrics(this);
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
        return DexbotMaintenanceRuntime.runDustHealthCheck(this);
    }

    /**
     * Set up the periodic dust health check interval.
     * Catches partials below the dust threshold that were missed by the post-fill
     * pipeline (e.g. from a prior bot lifetime after crash/restart).
     * Calls _runDustHealthCheck on each tick.
     * @private
     */
    _setupDustHealthCheckInterval() {
        return DexbotMaintenanceRuntime.setupDustHealthCheckInterval(this);
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
