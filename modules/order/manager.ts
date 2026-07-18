/**
 * modules/order/manager.ts - OrderManager Engine
 *
 * Core grid-based order management system for DEXBot2.
 * Uses utils/validate.ts, strategy.ts, and utils/order.ts for validation and rebalance logic.
 *
 * ===============================================================================
 * TABLE OF CONTENTS
 * ===============================================================================
 *
 * SECTION 1: EXTERNAL DEPENDENCIES
 * SECTION 2: COW REBALANCE ENGINE
 * SECTION 3: STATE MANAGER
 * SECTION 4: ORDER MANAGER CLASS
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: EXTERNAL DEPENDENCIES
// ===============================================================================

const {
    ORDER_TYPES,
    ORDER_STATES,
    REBALANCE_STATES,
    COW_ACTIONS,
    DEFAULT_CONFIG,
    TIMING,
    LOG_LEVEL,
    PIPELINE_TIMING,
    COW_PERFORMANCE
} = require('../constants');
const {
    getMinAbsoluteOrderSize,
    computeChainFundTotals,
    hasValidAccountTotals,
    resolveConfigValue,
    resolveConfigValueWithRegistry,
    isExplicitZeroAllocation,
    floatToBlockchainInt,
    getPrecisionSlack
} = require('./utils/math');
const {
    isOrderOnChain,
    isPhantomOrder,
    hasOnChainId,
    convertToSpreadPlaceholder
} = require('./utils/order');
const { persistGridSnapshot, deepFreeze, cloneMap } = require('./utils/system');
const {
    validateOrder,
    validateGridForPersistence,
    calculateRequiredFunds,
    validateWorkingGridFunds,
    checkFundDrift,
    reconcileGrid,
    optimizeRebalanceActions,
    summarizeActions,
    projectTargetToWorkingGrid,
    buildStateUpdates,
    buildAbortedResult,
    buildSuccessResult,
    evaluateCommit
} = require('./utils/validate');
const { WorkingGrid } = require('./working_grid');
const Logger = require('./logger');
const AsyncLock = require('./async_lock');
const Accountant = require('./accounting');
const StrategyEngine = require('./strategy');
const SyncEngine = require('./sync_engine');
const Grid = require('./grid');
const Format = require('./format');
const { toFiniteNumber, isValidNumber } = Format;

// ===============================================================================
// SECTION 2: COW REBALANCE ENGINE
// ===============================================================================
//
// COPY-ON-WRITE (COW) PATTERN FOR SAFE REBALANCING
//
// Problem Solved:
// Traditional approach: Modify orders in-place while calculating new grid
// Issue: If fills arrive DURING rebalance, they corrupt the working state
//
// Solution: Copy-on-Write pattern isolates rebalancing from incoming fills
//
// WORKFLOW:
// 1. Clone master grid → WorkingGrid (immutable during rebalance)
// 2. Calculate target state from strategy engine
// 3. Reconcile master vs target → generate COW_ACTIONS (CREATE/UPDATE/CANCEL/ROTATE)
// 4. Project target to working grid (working becomes target)
// 5. Validate funds and check for staleness (abort if fills arrived)
// 6. Build blockchain operations from delta
// 7. Atomic commit to master on broadcast success (or discard on failure)
//
// KEY INVARIANTS:
// 1. Master grid NEVER modified during planning (immutable during rebalance)
// 2. Fills that arrive during rebalance are QUEUED, not lost
// 3. Working grid is DISPOSABLE - if rebalance fails, discard it
// 4. Only ONE rebalance plan active at a time (StateManager.rebalance)
// 5. Staleness detection aborts if master changes (fills, manual commands)
//
// FILL HANDLING DURING REBALANCE:
// - SyncEngine.syncFromFillHistory() is called immediately on fill arrival
// - Updates to master grid only (not working grid)
// - Sets workingGrid.markStale() to signal version mismatch
// - Rebalance detects staleness → aborts → retries on next cycle
// - Fills are NEVER lost, just deferred until next rebalance cycle
//
// PERFORMANCE OPTIMIZATION:
// - COW_PERFORMANCE.WORKING_GRID_BYTES_PER_ORDER estimated memory per order
// - Modified Set only tracks changed order IDs (delta compression)
// - Lazy index calculation (prices, types, states) only on demand
// - Delta building is O(n) where n = modified orders count
//
// ===============================================================================

class COWRebalanceEngine {
    strategy: any;
    logger: any;
    assets: any;
    config: any;

    constructor(deps) {
        this.strategy = deps.strategy;
        this.logger = deps.logger;
        this.assets = deps.assets;
        this.config = deps.config;
    }

    async execute({
        masterGrid,
        gridVersion,
        boundaryIdx,
        funds,
        fills = [],
        excludeIds = new Set()
    }) {
        const startTime = Date.now();

        const workingGrid = new WorkingGrid(masterGrid, { baseVersion: gridVersion });

        const strategyParams = {
            frozenMasterGrid: masterGrid,
            config: this.config,
            accountAssets: this.assets,
            funds,
            excludeIds,
            fills,
            currentBoundaryIdx: boundaryIdx
        };

        const { targetGrid, boundaryIdx: targetBoundary } = this.strategy.calculateTargetGrid(strategyParams);

        let dustThresholdPercent = this.config?.gridLimits?.PARTIAL_DUST_THRESHOLD_PERCENTAGE;
        const reconcileResult = reconcileGrid(
            masterGrid,
            targetGrid,
            targetBoundary,
            {
                logger: (msg, level) => this.logger?.log(msg, level),
                dustThresholdPercent
            }
        );

        if (reconcileResult.aborted) {
            return buildAbortedResult(reconcileResult.reason);
        }

        const optimizedActions = optimizeRebalanceActions(reconcileResult.actions, masterGrid);
        projectTargetToWorkingGrid(workingGrid, targetGrid, { actions: optimizedActions });

        const precisions = {
            buyPrecision: this.assets?.assetB?.precision,
            sellPrecision: this.assets?.assetA?.precision
        };

        const fundCheck = validateWorkingGridFunds(workingGrid, funds, precisions, this.assets);
        if (!fundCheck.isValid) {
            this.logger?.log(`[COW] Fund validation failed: ${fundCheck.reason}`, 'warn');
            return buildAbortedResult(fundCheck.reason);
        }

        if (workingGrid.isStale()) {
            const reason = workingGrid.getStaleReason() || 'Master grid changed during planning';
            this.logger?.log(`[COW] Rebalance plan invalidated: ${reason}`, 'warn');
            return buildAbortedResult(reason);
        }

        const stateUpdates = buildStateUpdates(optimizedActions, masterGrid);

        const duration = Date.now() - startTime;
        if (duration > 100) {
            this.logger?.log(`[COW] Rebalance planning took ${duration}ms`, 'warn');
        }

        this.logger?.log(
            `[COW] Plan: Actions=${optimizedActions.length}, StateUpdates=${stateUpdates.length}`,
            'info'
        );

        return buildSuccessResult({
            actions: optimizedActions,
            stateUpdates,
            workingGrid,
            workingBoundary: targetBoundary,
            planningDuration: duration
        });
    }
}

// ===============================================================================
// SECTION 3: STATE MANAGER
// ===============================================================================

class StateManager {
    logger: any;
    rebalance: any;
    recovery: any;
    gridRegen: any;
    bootstrap: any;
    broadcast: any;
    signals: any;
    pipeline: any;

    constructor(options: any = {}) {
        this.logger = options.logger || null;
        this.reset();
    }

    reset() {
        this.rebalance = {
            state: REBALANCE_STATES.NORMAL,
            currentWorkingGrid: null
        };

        this.recovery = {
            attemptCount: 0,
            lastAttemptAt: 0,
            inFlight: false,
            lastFailureAt: 0
        };

        this.gridRegen = {
            buy: { armed: true, lastTriggeredAt: 0 },
            sell: { armed: true, lastTriggeredAt: 0 }
        };

        this.bootstrap = {
            isBootstrapping: false
        };

        this.broadcast = {
            isBroadcasting: false,
            startedAt: 0,
        };

        this.signals = {
            lastIllegalState: null,
            lastAccountingFailure: null
        };

        this.pipeline = {
            blockedSince: null,
            recoveryAttempted: false
        };

    }

    getRebalanceState() {
        return this.rebalance.state;
    }

    setRebalanceState(state) {
        this.rebalance.state = state;
        this.logger?.log(`[COW] Rebalance state: ${state}`, 'debug');
    }

    isRebalancing() {
        return this.rebalance.state === REBALANCE_STATES.REBALANCING;
    }

    isBroadcasting() {
        return this.rebalance.state === REBALANCE_STATES.BROADCASTING;
    }

    setWorkingGrid(workingGrid) {
        this.rebalance.currentWorkingGrid = workingGrid;
    }

    getWorkingGrid() {
        return this.rebalance.currentWorkingGrid;
    }

    clearWorkingGrid() {
        this.rebalance.currentWorkingGrid = null;
    }

    recordRecoveryAttempt() {
        this.recovery.attemptCount++;
        this.recovery.lastAttemptAt = Date.now();
        this.recovery.inFlight = true;
    }

    completeRecovery(success) {
        this.recovery.inFlight = false;
        if (!success) {
            this.recovery.lastFailureAt = Date.now();
        }
    }

    isRecoveryInFlight() {
        return this.recovery.inFlight;
    }

    getRecoveryStats() {
        return { ...this.recovery };
    }

    isSideArmed(side) {
        return this.gridRegen[side]?.armed ?? false;
    }

    disarmSide(side) {
        if (this.gridRegen[side]) {
            this.gridRegen[side].armed = false;
            this.gridRegen[side].lastTriggeredAt = Date.now();
        }
    }

    armSide(side) {
        if (this.gridRegen[side]) {
            this.gridRegen[side].armed = true;
        }
    }

    startBootstrap() {
        this.bootstrap.isBootstrapping = true;
        this.logger?.log('[BOOTSTRAP] Started', 'debug');
    }

    finishBootstrap() {
        this.bootstrap.isBootstrapping = false;
        this.logger?.log('[BOOTSTRAP] Finished', 'debug');
    }

    isBootstrapping() {
        return this.bootstrap.isBootstrapping;
    }

    startBroadcasting() {
        this.broadcast.isBroadcasting = true;
        this.broadcast.startedAt = Date.now();
        this.logger?.log?.('[BROADCAST] Flag set — fill processing will be deferred until stopBroadcasting()', 'debug');
    }

    stopBroadcasting() {
        this.broadcast.isBroadcasting = false;
        this.broadcast.startedAt = 0;
    }

    isBroadcastingActive() {
        if (this.broadcast.isBroadcasting && this.broadcast.startedAt > 0) {
            const elapsed = Date.now() - this.broadcast.startedAt;
            if (elapsed > 120000) {
                this.logger?.log?.('[BROADCAST] Auto-clearing stale broadcast flag after 120s', 'warn');
                this.broadcast.isBroadcasting = false;
                this.broadcast.startedAt = 0;
            }
        }
        return this.broadcast.isBroadcasting;
    }

    setIllegalStateSignal(signal) {
        this.signals.lastIllegalState = {
            ...signal,
            at: Date.now()
        };
    }

    consumeIllegalStateSignal() {
        const signal = this.signals.lastIllegalState;
        this.signals.lastIllegalState = null;
        return signal;
    }

    setAccountingFailureSignal(signal) {
        this.signals.lastAccountingFailure = {
            ...signal,
            at: Date.now()
        };
    }

    consumeAccountingFailureSignal() {
        const signal = this.signals.lastAccountingFailure;
        this.signals.lastAccountingFailure = null;
        return signal;
    }

    markPipelineBlocked() {
        if (!this.pipeline.blockedSince) {
            this.pipeline.blockedSince = Date.now();
        }
    }

    markPipelineClear() {
        this.pipeline.blockedSince = null;
        this.pipeline.recoveryAttempted = false;
    }

    getPipelineBlockedDuration() {
        return this.pipeline.blockedSince ? Date.now() - this.pipeline.blockedSince : 0;
    }

    isPipelineBlocked() {
        return this.pipeline.blockedSince !== null;
    }

    getState() {
        return {
            rebalance: { ...this.rebalance, currentWorkingGrid: null },
            recovery: { ...this.recovery },
            gridRegen: { ...this.gridRegen },
            bootstrap: { ...this.bootstrap },
            broadcast: { ...this.broadcast },
            pipeline: { ...this.pipeline }
        };
    }
}

// ===============================================================================
// SECTION 4: ORDER MANAGER CLASS
// ===============================================================================

class OrderManager {
    config: any;
    marketName: any;
    logger: any;
    orders: any;
    boundaryIdx: any;
    targetGrid: any;
    accountant: any;
    strategy: any;
    sync: any;
    _state: any;
    _ordersByState: Record<string, Set<string>>;
    _ordersByType: Record<string, Set<string>>;
    targetSpreadCount: number;
    currentSpreadCount: number;
    outOfSpread: number;
    assets: any;
    accountId: any;
    accountTotals: any;
    funds: any;
    _accountTotalsPromise: any;
    _accountTotalsResolve: any;
    _isFetchingTotals: boolean;
    ordersNeedingPriceCorrection: any[];
    shadowOrderIds: Map<any, any>;
    processedFillTracker: Map<any, any>;
    processedFillStore: any;
    _syncLock: any;
    _fillProcessingLock: any;
    _divergenceLock: any;
    _gridLock: any;
    _fundLock: any;
    _recentlyRotatedOrderIds: Set<any>;
    _gridSidesUpdated: Set<any>;
    _pauseFundRecalc: number;
    _pauseRecalcLogging: boolean;
    _throwOnIllegalState: boolean;
    _pipelineBlockedSince: any;
    _recoveryAttempted: boolean;
    _gridVersion: number;
    _gridPersistenceSuspendedReason: any;
    _pendingBroadcasts: Map<any, any>;
    _committedOrderIds: Set<string>;
    _gridDirtyAt: number | null;

    _metrics: any;
    _currentWorkingGrid: any;
    _cowEngine: any;
    accountOrders: any;
    btsBalance: { free: number; total: number; locked: number };

    /**
     * @param {Object} [config] - Configuration overrides
     */
    constructor(config: Record<string, any> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.marketName = this.config.market || (this.config.assetA && this.config.assetB ? `${this.config.assetA}/${this.config.assetB}` : null);
        const logFile = config.logFile || undefined;
        const loggingConfig = this.config.logging;
        this.logger = new Logger('DEXBot', {
            level: loggingConfig?.level ?? LOG_LEVEL,
            logFile,
            configOverride: loggingConfig?.config ?? undefined
        });
        this.logger.marketName = this.marketName;
        this.orders = Object.freeze(new Map());
        this.boundaryIdx = null;
        this.targetGrid = null;

        this.accountant = new Accountant(this);
        this.strategy = new StrategyEngine(this);
        this.sync = new SyncEngine(this);

        this._state = new StateManager({ logger: this.logger });

        // Index Sets use mutable mutation patterns controlled via _applyOrderUpdate
        // These are private implementation details and must NOT be mutated directly
        // All external code must go through the COW pipeline
        this._ordersByState = {
            [ORDER_STATES.VIRTUAL]: new Set(),
            [ORDER_STATES.ACTIVE]: new Set(),
            [ORDER_STATES.PARTIAL]: new Set()
        };
        this._ordersByType = {
            [ORDER_TYPES.BUY]: new Set(),
            [ORDER_TYPES.SELL]: new Set(),
            [ORDER_TYPES.SPREAD]: new Set()
        };

        this.resetFunds();
        this.btsBalance = { free: 0, total: 0, locked: 0 };
        this.targetSpreadCount = 0;
        this.currentSpreadCount = 0;
        this.outOfSpread = 0;
        this.assets = null;
        this._accountTotalsPromise = null;
        this._accountTotalsResolve = null;
        this._isFetchingTotals = false;
        this.ordersNeedingPriceCorrection = [];
        this.shadowOrderIds = new Map();
        this.processedFillTracker = new Map();
        this.processedFillStore = null;

        // LOCK HIERARCHY (convention — not enforced at runtime to avoid false
        // positives from async contention and multi-bot sharing a process).
        // Acquire in ascending level order only:
        //   Level 0: _divergenceLock   (divergence checks — outermost)
        //   Level 1: _fillProcessingLock  (fill processing)
        //   Level 2: _gridLock         (grid mutations)
        //   Level 3: _syncLock         (sync operations)
        //   Level 4: _fundLock         (fund operations — innermost)
        // WARNING: AsyncLock is NOT reentrant.
        this._divergenceLock = new AsyncLock({ level: 0 });
        this._fillProcessingLock = new AsyncLock({ level: 1 });
        this._gridLock = new AsyncLock({ level: 2 });
        this._syncLock = new AsyncLock({ level: 3 });
        this._fundLock = new AsyncLock({ level: 4, timeout: 30000 });

        this._recentlyRotatedOrderIds = new Set();
        this._gridSidesUpdated = new Set();
        this._pauseFundRecalc = 0;
        this._pauseRecalcLogging = false;
        this._throwOnIllegalState = false;
        this._pipelineBlockedSince = null;
        this._recoveryAttempted = false;
        this._gridVersion = 0;
        this._gridPersistenceSuspendedReason = null;
        this._pendingBroadcasts = new Map();
        this._committedOrderIds = new Set();
        this._gridDirtyAt = null;


        this._metrics = {
            fundRecalcCount: 0,
            invariantViolations: { buy: 0, sell: 0 },
            lockAcquisitions: 0,
            lockContentionSkips: 0,
            spreadRoleConversionBlocked: 0,
            lastSyncDurationMs: 0,
            metricsStartTime: Date.now()
        };

        this._state.startBootstrap();
        this._currentWorkingGrid = null;
        this._cowEngine = null;

        this._cleanExpiredLocks();
    }

    _getCOWEngine() {
        if (!this._cowEngine && this.assets) {
            this._cowEngine = new COWRebalanceEngine({
                strategy: this.strategy,
                logger: this.logger,
                assets: this.assets,
                config: this.config
            });
        }
        return this._cowEngine;
    }

    _clearWorkingGridRef() {
        this._currentWorkingGrid = null;
        this._state.clearWorkingGrid();
        this._state.setRebalanceState(REBALANCE_STATES.NORMAL);
    }

    _setRebalanceState(state) {
        this._state.setRebalanceState(state);
    }

    /**
     * @returns {boolean}
     */
    isRebalancing() {
        return this._state.isRebalancing();
    }

    /**
     * @returns {boolean}
     */
    isBroadcasting() {
        return this._state.isBroadcasting();
    }

    /**
     * @returns {boolean}
     */
    isPlanningActive() {
        return this.isRebalancing() || this.isBroadcasting();
    }

    /**
     * @returns {void}
     */
    startBootstrap() {
        this._state.startBootstrap();
    }

    /**
     * @returns {import('./types').BootstrapResult}
     */
    finishBootstrap() {
        const result = { hadDrift: false, driftInfo: null };

        if (this._state.isBootstrapping()) {
            this._state.finishBootstrap();

            // Validate fund state at bootstrap completion - if drift exists here,
            // it's not transient (grid is now stable) and indicates a potential bug
            const driftCheck = this.checkFundDriftAfterFills();
            if (!driftCheck.isValid) {
                result.hadDrift = true;
                result.driftInfo = driftCheck;
                this.logger.log(
                    `[BOOTSTRAP-END] Fund drift detected after bootstrap: ${driftCheck.reason}. ` +
                    `This may indicate a bug in grid initialization.`,
                    'warn'
                );
            }

            this.logger.log("Bootstrap phase complete. Grid health monitoring and fund invariants active.", "info");
        }

        return result;
    }

    /**
     * @returns {void}
     */
    startBroadcasting() {
        this._state.startBroadcasting();
    }

    /**
     * @returns {void}
     */
    stopBroadcasting() {
        this._state.stopBroadcasting();
    }

    /**
     * @returns {void}
     */
    resetFunds() {
        return this.accountant.resetFunds();
    }

    async _deductFromChainFree(orderType, size, operation) {
        if (!this.accountant) return;
        return await this.accountant.tryDeductFromChainFree(orderType, size, operation);
    }

    async _addToChainFree(orderType, size, operation) {
        if (!this.accountant) return;
        return await this.accountant.addToChainFree(orderType, size, operation);
    }

    _getGridTotal(side) {
        return (this.funds?.committed?.grid?.[side] || 0) + (this.funds?.virtual?.[side] || 0);
    }

    /**
     * @returns {import('./types').ChainFundsSnapshot}
     */
    getChainFundsSnapshot() {
        const totals = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);
        const allocatedBuy = toFiniteNumber(this.funds?.allocated?.buy, totals.chainTotalBuy);
        const allocatedSell = toFiniteNumber(this.funds?.allocated?.sell, totals.chainTotalSell);
        const btsBalance = (this.config.assetA !== 'BTS' && this.config.assetB !== 'BTS')
            ? (this.btsBalance || { free: 0, total: 0, locked: 0 })
            : null;
        return { ...totals, allocatedBuy, allocatedSell, btsBalance };
    }

    /**
     * @param {number} [timeoutMs]
     * @returns {Promise<void>}
     */
    async waitForAccountTotals(timeoutMs = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        if (hasValidAccountTotals(this.accountTotals, true)) return;

        let waitPromise = null;

        await this._fundLock.acquire(async () => {
            if (hasValidAccountTotals(this.accountTotals, true)) return;
            if (!this._accountTotalsPromise) {
                this._accountTotalsPromise = new Promise((resolve) => {
                    this._accountTotalsResolve = resolve;
                });
            }
            waitPromise = this._accountTotalsPromise;
        });

        if (!waitPromise) return;

        await Promise.race([
            waitPromise,
            new Promise<void>((resolve) => {
                setTimeout(() => {
                    this.logger.log('[FUND] Timeout waiting for account totals', 'warn');
                    resolve();
                }, timeoutMs);
            })
        ]);
    }

    /**
     * @param {string} [accountId] - Blockchain account ID
     * @returns {Promise<void>}
     */
    async fetchAccountTotals(accountId) {
        if (accountId) this.accountId = accountId;
        await this._fetchAccountBalancesAndSetTotals();
    }

    async _fetchAccountBalancesAndSetTotals() {
        return await this.sync.fetchAccountBalancesAndSetTotals();
    }

    /**
     * @param {import('./types').AccountTotals} totals - Account balance totals
     * @returns {Promise<void>}
     */
    async setAccountTotals(totals = { buy: null, sell: null, buyFree: null, sellFree: null }) {
        return await this._fundLock.acquire(async () => {
            return await this._setAccountTotals(totals);
        });
    }

    async _setAccountTotals(totals) {
        this.accountTotals = { ...(this.accountTotals || {}), ...totals };
        if (!this.funds) this.resetFunds();

        await this._recalculateFunds();

        if (hasValidAccountTotals(this.accountTotals, true) && typeof this._accountTotalsResolve === 'function') {
            try {
                this._accountTotalsResolve();
            } catch (e: any) {
                this.logger?.log?.(`Error resolving account totals promise: ${e.message}`, 'warn');
            }
            this._accountTotalsPromise = null;
            this._accountTotalsResolve = null;
        }
    }

    _triggerAccountTotalsFetchIfNeeded() {
        if (!this._isFetchingTotals) {
            this._isFetchingTotals = true;
            this._fetchAccountBalancesAndSetTotals().finally(() => {
                this._isFetchingTotals = false;
            });
        }
    }

    /**
     * @returns {void}
     */
    applyBotFundsAllocation() {
        if (!this.config.botFunds || !this.accountTotals) return;
        const { chainTotalBuy, chainTotalSell } = computeChainFundTotals(this.accountTotals, this.funds?.committed?.chain);

        const account = this.config.preferredAccount;
        const botName = this.config.botKey;
        const allocatedBuy = resolveConfigValueWithRegistry(this.config.botFunds.buy, chainTotalBuy, account, botName, 'buy');
        const allocatedSell = resolveConfigValueWithRegistry(this.config.botFunds.sell, chainTotalSell, account, botName, 'sell');

        if (allocatedBuy === 0 && typeof this.config.botFunds.buy === 'string' && this.config.botFunds.buy.trim().endsWith('%')) {
            if (chainTotalBuy === 0) this._triggerAccountTotalsFetchIfNeeded();
        }
        if (allocatedSell === 0 && typeof this.config.botFunds.sell === 'string' && this.config.botFunds.sell.trim().endsWith('%')) {
            if (chainTotalSell === 0) this._triggerAccountTotalsFetchIfNeeded();
        }

        this.funds.allocated = { buy: allocatedBuy, sell: allocatedSell };

        const shouldCapBuy = allocatedBuy > 0 || isExplicitZeroAllocation(this.config.botFunds.buy);
        const shouldCapSell = allocatedSell > 0 || isExplicitZeroAllocation(this.config.botFunds.sell);

        if (shouldCapBuy) this.funds.available.buy = Math.min(this.funds.available.buy, Math.max(0, allocatedBuy));
        if (shouldCapSell) this.funds.available.sell = Math.min(this.funds.available.sell, Math.max(0, allocatedSell));
    }

    /**
     * @returns {Promise<void>}
     */
    async recalculateFunds() {
        return await this._fundLock.acquire(async () => {
            return await this._recalculateFunds();
        });
    }

    async _recalculateFunds() {
        if (!this.accountant) return;
        this._metrics.fundRecalcCount++;
        await this.accountant.recalculateFunds();
    }

    /**
     * @returns {void}
     */
    pauseFundRecalc() {
        this._pauseFundRecalc++;
    }

    /**
     * @returns {Promise<void>}
     */
    async resumeFundRecalc() {
        this._pauseFundRecalc = Math.max(0, this._pauseFundRecalc - 1);
        if (this._pauseFundRecalc === 0) {
            await this.recalculateFunds();
        }
    }

    /**
     * @returns {void}
     */
    pauseRecalcLogging() {
        this._pauseRecalcLogging = true;
    }

    /**
     * @returns {void}
     */
    resumeRecalcLogging() {
        this._pauseRecalcLogging = false;
    }

    /**
     * @param {Array<import('./types').Order>} orders
     * @param {Object} info
     * @returns {Promise<import('./types').SyncResult>}
     */
    syncFromOpenOrders(orders, info) {
        return this.sync.syncFromOpenOrders(orders, info);
    }

    /**
     * @param {Object} fill - Fill event data
     * @param {Object} [options]
     * @returns {Promise<import('./types').SyncResult>}
     */
    syncFromFillHistory(fill, options) {
        return this.sync.syncFromFillHistory(fill, options);
    }

    /**
     * @param {Object} data - Chain data to synchronize
     * @param {string} src - Source identifier
     * @returns {Promise<import('./types').SyncResult>}
     */
    async synchronizeWithChain(data, src, options = {}) {
        // _gridLock acquisition is delegated to sync.synchronizeWithChain itself.
        // createOrder / cancelOrder acquire it inline; readOpenOrders and
        // periodicBlockchainFetch acquire it inside syncFromOpenOrders.
        return await this._applySync(data, src, options);
    }

    async _applySync(data, src, options = {}) {
        return await this.sync.synchronizeWithChain(data, src, options);
    }

    async _initializeAssets() {
        return await this.sync.initializeAssets();
    }

    /**
     * @param {string[]|Set<string>} orderIds - Order IDs to lock
     * @returns {void}
     */
    lockOrders(orderIds) {
        if (!orderIds) return;
        const expiration = Date.now() + TIMING.LOCK_TIMEOUT_MS;
        for (const id of orderIds) if (id) this.shadowOrderIds.set(id, expiration);
        this._cleanExpiredLocks();
    }

    /**
     * @param {string[]|Set<string>} orderIds - Order IDs to unlock
     * @returns {void}
     */
    unlockOrders(orderIds) {
        if (!orderIds) return;
        for (const id of orderIds) if (id) this.shadowOrderIds.delete(id);
        this._cleanExpiredLocks();
    }

    /**
     * @param {string} id - Order ID
     * @returns {boolean}
     */
    isOrderLocked(id) {
        const expiresAt = this.shadowOrderIds.get(id);
        if (!expiresAt) return false;
        if (Date.now() > expiresAt) {
            this.shadowOrderIds.delete(id);
            return false;
        }
        return true;
    }

    _cleanExpiredLocks() {
        const now = Date.now();
        for (const [id, expiresAt] of this.shadowOrderIds) {
            if (now > expiresAt) {
                this.shadowOrderIds.delete(id);
            }
        }
    }

    _normalizeOrderUpdateOptions(options: Record<string, any> = {}) {
        if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('Order update options must be an object');
        }

        return {
            skipAccounting: options.skipAccounting === true,
            fee: Number.isFinite(Number(options.fee)) ? Number(options.fee) : 0
        };
    }

    _normalizeCommitOptions(options: Record<string, any> = {}) {
        if (options === null || typeof options !== 'object' || Array.isArray(options)) {
            throw new TypeError('Commit options must be an object');
        }
        return { skipRecalc: options.skipRecalc === true };
    }

    async _updateOrder(order, context = 'updateOrder', options = {}) {
        const updateOptions = this._normalizeOrderUpdateOptions(options);
        return await this._gridLock.acquire(async () => {
            return await this._applyOrderUpdate(order, context, updateOptions);
        });
    }

    async _applyOrderUpdate(order, context = 'updateOrder', options = {}) {
        const updateOptions = this._normalizeOrderUpdateOptions(options);
        const { skipAccounting, fee: normalizedFee } = updateOptions;
        const oldOrder = this.orders.get(order.id);
        const validation = validateOrder(order, oldOrder, context);

        for (const warning of validation.warnings) {
            this.logger.log(warning.message, 'warn');
        }

        if (!validation.isValid && validation.errors.length > 0) {
            const fatalError = validation.errors.find(e => e.isFatal || e.code === 'ILLEGAL_SPREAD_STATE');
            if (fatalError) {
                this.logger.log(fatalError.message, 'error');
                this._state.setIllegalStateSignal({
                    id: order.id,
                    context,
                    message: fatalError.message
                });
                if (this._throwOnIllegalState) {
                    const err: any = new Error(fatalError.message);
                    err.code = fatalError.code;
                    throw err;
                }
                return false;
            }
        }

        // Ensure a mutable copy before passing to updateOptimisticFreeBalance.
        // validation.normalizedOrder may reference a frozen master-grid order,
        // and _resolveBtsFeeLifecycle mutates btsFeeState on the order object.
        let nextOrder = { ...validation.normalizedOrder };

        // Apply phantom order auto-correction to the normalized order
        const phantomError = validation.errors.find(e => e.code === 'PHANTOM_ORDER');
        if (phantomError && phantomError.autoCorrect) {
            nextOrder = { ...nextOrder, ...phantomError.autoCorrect };
        }

        if (this.accountant) {
            await this.accountant.updateOptimisticFreeBalance(oldOrder, nextOrder, context, normalizedFee, skipAccounting);
        }

        const updatedOrder = deepFreeze({ ...nextOrder });
        const id = order.id;

        Object.values(this._ordersByState).forEach(set => set.delete(id));
        Object.values(this._ordersByType).forEach(set => set.delete(id));

        if (this._ordersByState[updatedOrder.state]) {
            this._ordersByState[updatedOrder.state].add(id);
        }
        if (this._ordersByType[updatedOrder.type]) {
            this._ordersByType[updatedOrder.type].add(id);
        }

        const newMap = cloneMap(this.orders);
        newMap.set(id, updatedOrder);
        this.orders = Object.freeze(newMap);
        this._gridVersion++;

        this._syncWorkingGridFromMasterMutation(id, context);

        if (this._pauseFundRecalc === 0) {
            await this.recalculateFunds();
        }

        this._markGridDirty(context, id);

        return true;
    }

    _syncWorkingGridFromMasterMutation(orderId, context) {
        if (!this._currentWorkingGrid || !this.isPlanningActive()) {
            return;
        }

        try {
            this._currentWorkingGrid.markStale(
                `master mutation during ${this._rebalanceState.toLowerCase()} (${context})`
            );
            this._currentWorkingGrid.syncFromMaster(this.orders, orderId, this._gridVersion);
        } catch (syncErr: any) {
            this._currentWorkingGrid.markStale(`working-grid sync failure: ${syncErr.message}`);
            this.logger.log(`[COW] Failed to sync working grid for order ${orderId}: ${syncErr.message}`, 'warn');
        }
    }

    /**
     * @param {Array<import('./types').Order>} updates - Order updates to apply
     * @param {string} [context] - Update context label
     * @param {import('./types').OrderUpdateOptions} [options]
     * @returns {Promise<boolean>}
     */
    async applyGridUpdateBatch(updates, context = 'batch-update', options = {}) {
        const updateOptions = this._normalizeOrderUpdateOptions(options);
        return await this._gridLock.acquire(async () => {
            for (const update of updates) {
                await this._applyOrderUpdate(update, context, updateOptions);
            }
            return true;
        });
    }

    /**
     * Flag the in-memory master grid as dirty so the next flushGridDirty()
     * call persists it. Internal helper — every successful _applyOrderUpdate
     * call ends with this. External callers that mutate the grid through
     * other paths (e.g. raw `this.orders.set(...)` from a refactor) should
     * invoke this explicitly so the dirty-flag invariant still holds.
     *
     * @param {string} [reason='unknown'] - Context label for diagnostics
     * @param {string} [orderId=null] - Order that triggered the mutation
     * @returns {void}
     */
    _markGridDirty(reason = 'unknown', orderId: string = null) {
        if (this._gridDirtyAt == null) {
            this._gridDirtyAt = Date.now();
        }
    }

    /**
     * Clear the dirty flag after a successful flush. Internal helper.
     * @returns {void}
     */
    _clearGridDirty() {
        this._gridDirtyAt = null;
    }

    /**
     * Public read-only access to the dirty flag. Used by tick-end safety
     * nets and by tests/CI to verify the persistence invariant.
     * @returns {boolean}
     */
    isGridDirty() {
        return this._gridDirtyAt !== null;
    }

    /**
     * If the master grid has been mutated since the last successful
     * persistGrid() call, persist it now. This is the end-of-tick safety
     * net that catches direct _updateOrder() calls (e.g. partial-fill size
     * updates) that never reach a COW rebalance and therefore never reach
     * a known persistGrid() site.
     *
     * Idempotent: a no-op when the grid is not dirty. Honours
     * suspendGridPersistence(). Returns the underlying persistGrid()
     * result, or {skipped:true, reason:'not-dirty'} when the grid is clean.
     *
     * @param {string} [contextLabel='flush-grid-dirty'] - Label for logs
     * @returns {Promise<{skipped?: boolean, suspended?: boolean, isValid?: boolean, reason?: string}>}
     */
    async flushGridDirty(contextLabel = 'flush-grid-dirty') {
        if (this._gridDirtyAt == null) {
            return { skipped: true, reason: 'not-dirty' };
        }
        if (this._gridPersistenceSuspendedReason) {
            this.logger?.log?.(
                `[PERSISTENCE-FLUSH] Skipping dirty-flush while suspended: ${this._gridPersistenceSuspendedReason}`,
                'warn'
            );
            return { skipped: true, suspended: true, reason: this._gridPersistenceSuspendedReason };
        }
        const result = await this.persistGrid(undefined);
        if (result && result.skipped === true) {
            // Persistence was deferred (suspension, validation, etc.) — keep
            // the dirty flag so a later tick can retry.
            return result;
        }
        if (result && result.isValid === false) {
            this.logger?.log?.(
                `[PERSISTENCE-FLUSH] Dirty flush validation failed (${contextLabel}): ${result.reason || 'unknown'}`,
                'warn'
            );
            return result;
        }
        this._clearGridDirty();
        this.logger?.log?.(
            `[PERSISTENCE-FLUSH] Flushed dirty grid via ${contextLabel}`,
            'info'
        );
        return result || { isValid: true };
    }

    /**
     * @param {Array<import('./types').Order>} orders - Filled orders
     * @param {Set<string>} [excl] - Order IDs to exclude
     * @param {Object} [options]
     * @returns {Promise<import('./types').CowRebalanceResult>}
     */
    async processFilledOrders(orders, excl, options) {
        // Step 1: Handle Fills (Accounting & State Updates)
        await this.strategy.processFillsOnly(orders, excl);

        // Step 2: Trigger Safe Rebalance only for actual fills.
        const triggerFills = orders.filter(f => !f.isPartial || f.isDelayedRotationTrigger);
        const shouldRebalance = triggerFills.length > 0;

        if (shouldRebalance) {
            const rebalanceResult = await this.performSafeRebalance(orders, excl);
            return rebalanceResult;
        }

        const { WorkingGrid } = require('./working_grid');
        const workingGrid = new WorkingGrid(this.orders, { baseVersion: this._gridVersion });
        return { 
            actions: [], 
            stateUpdates: [], 
            hadRotation: false,
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: this.boundaryIdx,
            aborted: false
        };
    }

    /**
     * @returns {Array<import('./types').Order>}
     */
    getInitialOrdersToActivate() {
        // Apply activeOrders limit from config
        const sellCount = Math.max(0, toFiniteNumber(this.config.activeOrders?.sell, 1));
        const buyCount = Math.max(0, toFiniteNumber(this.config.activeOrders?.buy, 1));

        // Get minimum sizes for validation
        const minOrderSizeFactor = this.config?.gridLimits?.MIN_ORDER_SIZE_FACTOR;
        const minSellSize = getMinAbsoluteOrderSize(ORDER_TYPES.SELL, this.assets, minOrderSizeFactor);
        const minBuySize = getMinAbsoluteOrderSize(ORDER_TYPES.BUY, this.assets, minOrderSizeFactor);

        // Use integer arithmetic for size comparisons to match blockchain behavior
        const sellPrecision = this.assets?.assetA?.precision;
        const buyPrecision = this.assets?.assetB?.precision;
        const minSellSizeInt = floatToBlockchainInt(minSellSize, sellPrecision);
        const minBuySizeInt = floatToBlockchainInt(minBuySize, buyPrecision);

        // Get closest virtual sells (lowest prices first = closest to market), limit to sellCount
        const vSells = this.getOrdersByTypeAndState(ORDER_TYPES.SELL, ORDER_STATES.VIRTUAL)
            .sort((a, b) => a.price - b.price)
            .slice(0, sellCount);
        // Filter by minimum size, then reverse for placement order (highest first)
        const validSells = vSells
            .filter(o => floatToBlockchainInt(o.size, sellPrecision) >= minSellSizeInt)
            .sort((a, b) => b.price - a.price);

        // Get closest virtual buys (highest prices first = closest to market), limit to buyCount
        const vBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL)
            .sort((a, b) => b.price - a.price)
            .slice(0, buyCount);
        // Filter by minimum size, then reverse for placement order (lowest first)
        const validBuys = vBuys
            .filter(o => floatToBlockchainInt(o.size, buyPrecision) >= minBuySizeInt)
            .sort((a, b) => a.price - b.price);

        return [...validSells, ...validBuys];
    }

    /**
     * Get orders matching the specified type and state.
     * 
     * @param {string|null} type - Order type (ORDER_TYPES.BUY/SELL/SPREAD) or null for all types
     * @param {string} state - Order state (ORDER_STATES.ACTIVE/PARTIAL/VIRTUAL)
     * @returns {Array} Array of matching orders
     */
    getOrdersByTypeAndState(type, state) {
        const result = [];
        const ids = this._ordersByState[state];
        if (!ids) return result;
        for (const id of ids) {
            const order = this.orders.get(id);
            // If type is null/undefined, return all orders with matching state
            // Otherwise, filter by both type and state
            if (order && order.state === state && (type == null || order.type === type)) {
                result.push(order);
            }
        }
        return result;
    }

    /**
     * @param {string} type - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @returns {Array<import('./types').Order>}
     */
    getPartialOrdersOnSide(type) {
        return this.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL);
    }

    /**
     * @returns {boolean}
     */
    validateIndices() {
        for (const [id, order] of this.orders) {
            if (!order) {
                this.logger.log(`Index corruption: ${id} exists in orders Map but is null/undefined`, 'error');
                return false;
            }
            if (!order.state) {
                this.logger.log(`Index corruption: ${id} has no state`, 'error');
                return false;
            }
            if (!order.type) {
                this.logger.log(`Index corruption: ${id} has no type`, 'error');
                return false;
            }
            if (!this._ordersByState[order.state]?.has(id)) {
                this.logger.log(`Index mismatch: ${id} not in _ordersByState[${order.state}]`, 'error');
                return false;
            }
            if (!this._ordersByType[order.type]?.has(id)) {
                this.logger.log(`Index mismatch: ${id} not in _ordersByType[${order.type}]`, 'error');
                return false;
            }
        }

        for (const [state, orderIds] of Object.entries(this._ordersByState)) {
            for (const id of orderIds) {
                if (!id || !this.orders.has(id)) {
                    this.logger.log(`Index orphan: ${id} in _ordersByState[${state}] but not in orders Map`, 'error');
                    return false;
                }
            }
        }

        for (const [type, orderIds] of Object.entries(this._ordersByType)) {
            for (const id of orderIds) {
                if (!id || !this.orders.has(id)) {
                    this.logger.log(`Index orphan: ${id} in _ordersByType[${type}] but not in orders Map`, 'error');
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * @returns {boolean}
     */
    assertIndexConsistency() {
        if (!this.validateIndices()) {
            this.logger.log('CRITICAL: Index corruption detected! Attempting repair...', 'error');
            return this._repairIndices();
        }
        return true;
    }

    _repairIndices() {
        try {
            const rebuiltByState = {
                [ORDER_STATES.VIRTUAL]: new Set<string>(),
                [ORDER_STATES.ACTIVE]: new Set<string>(),
                [ORDER_STATES.PARTIAL]: new Set<string>()
            };
            const rebuiltByType = {
                [ORDER_TYPES.BUY]: new Set<string>(),
                [ORDER_TYPES.SELL]: new Set<string>(),
                [ORDER_TYPES.SPREAD]: new Set<string>()
            };

            for (const [id, order] of this.orders) {
                if (order && order.state && order.type) {
                    rebuiltByState[order.state]?.add(id);
                    rebuiltByType[order.type]?.add(id);
                } else {
                    this.logger.log(`Skipping corrupted order ${id} during index repair`, 'warn');
                }
            }

            this._ordersByState = rebuiltByState;
            this._ordersByType = rebuiltByType;

            if (this.validateIndices()) {
                this.logger.log('✓ Index repair successful', 'info');
                return true;
            }

            this.logger.log('✗ Index repair failed - structure is damaged', 'error');
            return false;
        } catch (e: any) {
            this.logger.log(`Index repair failed with exception: ${e.message}`, 'error');
            return false;
        }
    }

    /**
     * @returns {Object|null} The consumed signal or null
     */
    consumeIllegalStateSignal() {
        return this._state.consumeIllegalStateSignal();
    }

    /**
     * @returns {Object|null} The consumed signal or null
     */
    consumeAccountingFailureSignal() {
        return this._state.consumeAccountingFailureSignal();
    }

    /**
     * @param {Object} BitShares - BitShares API instance
     * @param {Function} batchCb - Batch callback
     * @returns {Promise<Object>}
     */
    async checkSpreadCondition(BitShares, batchCb) {
        return await Grid.checkSpreadCondition(this, BitShares, batchCb);
    }

    /**
     * @param {Function} batchCb - Batch callback
     * @returns {Promise<Object>}
     */
    async checkGridHealth(batchCb) {
        return await Grid.checkGridHealth(this, batchCb);
    }

    /**
     * @returns {Object} Current spread calculation
     */
    calculateCurrentSpread() {
        return Grid.calculateCurrentSpread(this);
    }

    /**
     * @returns {import('./types').DriftCheckResult}
     */
    checkFundDriftAfterFills() {
        if (!this.assets || !hasValidAccountTotals(this.accountTotals)) {
            return { isValid: true, reason: 'Skipped: missing assets or totals' };
        }
        return checkFundDrift(this.orders, this.accountTotals, this.assets, this.config?.gridLimits ?? null);
    }

    /**
     * @param {Object|number} [pipelineSignals] - Pipeline state signals or queue length
     * @returns {import('./types').PipelineEmptyResult}
     */
    isPipelineEmpty(pipelineSignals: number | Record<string, any> = 0) {
        const normalizedSignals: Record<string, any> = (typeof pipelineSignals === 'number')
            ? { incomingFillQueueLength: pipelineSignals }
            : (pipelineSignals || {});

        const incomingFillQueueLength = toFiniteNumber(normalizedSignals.incomingFillQueueLength);
        const shadowLocks = toFiniteNumber(normalizedSignals.shadowLocks);
        const batchInFlight = !!normalizedSignals.batchInFlight;
        const recoveryInFlight = !!normalizedSignals.recoveryInFlight;
        const broadcasting = !!normalizedSignals.broadcasting;

        this._cleanExpiredLocks();
        const reasons = [];

        // invariant: _gridSidesUpdated is pre-cleared by executeMaintenanceLogic
        // before calling isPipelineEmpty (see modules/dexbot_maintenance_runtime.ts:1378).
        // Any new caller must pre-clear or add its own gating to avoid a permanently
        // blocked pipeline.
        if (incomingFillQueueLength > 0) {
            reasons.push(`${incomingFillQueueLength} fills queued`);
        }
        if (this.ordersNeedingPriceCorrection.length > 0) {
            reasons.push(`${this.ordersNeedingPriceCorrection.length} corrections pending`);
        }
        if (shadowLocks > 0) {
            reasons.push(`${shadowLocks} shadow lock(s) active`);
        }
        if (batchInFlight) {
            reasons.push('batch broadcast in-flight');
        }
        if (recoveryInFlight) {
            reasons.push('recovery sync in-flight');
        }
        if (broadcasting || this._state.isBroadcastingActive()) {
            reasons.push('broadcasting active orders');
        }

        if (reasons.length > 0 && !this._pipelineBlockedSince) {
            this._pipelineBlockedSince = Date.now();
            this._state.markPipelineBlocked();
        } else if (reasons.length === 0) {
            this._pipelineBlockedSince = null;
            this._state.markPipelineClear();
        }

        return {
            isEmpty: reasons.length === 0,
            reasons
        };
    }

    /**
     * @returns {boolean} Whether stale operations were cleared
     */
    clearStalePipelineOperations() {
        if (!this._pipelineBlockedSince) return false;
        const age = Date.now() - this._pipelineBlockedSince;
        if (age < PIPELINE_TIMING.TIMEOUT_MS) return false;

        this.ordersNeedingPriceCorrection = [];
        this._pipelineBlockedSince = null;
        this._state.markPipelineClear();
        return true;
    }

    /**
     * @returns {import('./types').PipelineHealth}
     */
    getPipelineHealth() {
        const blockedDuration = this._pipelineBlockedSince
            ? Date.now() - this._pipelineBlockedSince
            : 0;

        return {
            isBlocked: this._pipelineBlockedSince !== null,
            blockedDurationMs: blockedDuration,
            hasStalled: blockedDuration > PIPELINE_TIMING.TIMEOUT_MS,
            recoveryAttempted: this._recoveryAttempted,
            correctionsPending: this.ordersNeedingPriceCorrection.length,
            gridSidesUpdated: this._gridSidesUpdated?.size || 0
        };
    }

    /**
     * @param {Map<string, import('./types').Order>} targetGrid
     * @param {number} targetBoundary
     * @returns {Object}
     */
    reconcileGrid(targetGrid, targetBoundary) {
        return reconcileGrid(this.orders, targetGrid, targetBoundary, {
            logger: (msg, level) => this.logger.log(msg, level),
            dustThresholdPercent: this.config?.gridLimits?.PARTIAL_DUST_THRESHOLD_PERCENTAGE
        });
    }

    /**
     * @param {Array} [fills] - Fill events triggering rebalance
     * @param {Set<string>} [excludeIds] - Order IDs to exclude
     * @returns {Promise<import('./types').CowRebalanceResult>}
     */
    async performSafeRebalance(fills = [], excludeIds = new Set()) {
        this.logger.log("[SAFE-REBALANCE] Starting with COW...", "info");
        return await this._gridLock.acquire(async () => {
            return await this._applySafeRebalanceCOW(fills, excludeIds);
        });
    }

    async _applySafeRebalanceCOW(fills = [], excludeIds = new Set()) {
        const cowEngine = this._getCOWEngine();
        if (!cowEngine) {
            return buildAbortedResult('COW Engine not initialized (assets not available)');
        }

        this._setRebalanceState(REBALANCE_STATES.REBALANCING);
        const result = await cowEngine.execute({
            masterGrid: this.orders,
            gridVersion: this._gridVersion,
            boundaryIdx: this.boundaryIdx,
            funds: this.getChainFundsSnapshot(),
            fills,
            excludeIds
        });

        if (result.aborted) {
            this._clearWorkingGridRef();
            return result;
        }

        this._currentWorkingGrid = result.workingGrid;
        return result;
    }

    _reconcileGridCOW(targetGrid, targetBoundary, workingGrid) {
        const result = this.reconcileGrid(targetGrid, targetBoundary);
        if (result.aborted) return result;

        const actions = optimizeRebalanceActions(result.actions || [], this.orders);
        projectTargetToWorkingGrid(workingGrid, targetGrid, { actions });

        return {
            ...result,
            actions,
            ...summarizeActions(actions)
        };
    }

    _validateWorkingGridFunds(workingGrid, projectedFunds) {
        return validateWorkingGridFunds(workingGrid, projectedFunds, {
            buyPrecision: this.assets?.assetB?.precision,
            sellPrecision: this.assets?.assetA?.precision
        }, this.assets);
    }

    _calculateRequiredFundsFromGrid(workingGrid, precisions: Record<string, any> = {}) {
        return calculateRequiredFunds(workingGrid, {
            buyPrecision: precisions.buyPrecision || this.assets?.assetB?.precision,
            sellPrecision: precisions.sellPrecision || this.assets?.assetA?.precision
        });
    }

    _getCowComparePrecisions() {
        const buyPrecisionRaw = this.assets?.assetB?.precision;
        const sellPrecisionRaw = this.assets?.assetA?.precision;
        const incrementPercentRaw = this.config?.incrementPercent;
        const buyPrecision = Number(buyPrecisionRaw);
        const sellPrecision = Number(sellPrecisionRaw);
        const incrementPercent = Number(incrementPercentRaw);

        if (!Number.isFinite(buyPrecision) || !Number.isFinite(sellPrecision)) {
            throw new Error(
                `CRITICAL: Missing asset precision for COW compare (buy=${buyPrecisionRaw}, sell=${sellPrecisionRaw}). ` +
                `Refusing commit-time delta comparison.`
            );
        }

        if (!Number.isFinite(incrementPercent) || incrementPercent <= 0) {
            throw new Error(
                `CRITICAL: Missing/invalid incrementPercent for COW compare (${incrementPercentRaw}). ` +
                `Refusing commit-time delta comparison.`
            );
        }

        // Relative price threshold = 1/10 of one configured increment step.
        // Example: incrementPercent=0.5 -> relative tolerance ratio=0.0005 (0.05%).
        const priceRelativeTolerance = incrementPercent / 1000;

        return {
            buyPrecision,
            sellPrecision,
            priceRelativeTolerance
        };
    }

    _buildStateUpdates(actions, masterGrid) {
        return buildStateUpdates(actions, masterGrid);
    }

    _buildAbortedCOWResult(reason) {
        return buildAbortedResult(reason);
    }

    async _commitWorkingGrid(workingGrid, workingIndexes, workingBoundary, options = {}) {
        const { skipRecalc } = this._normalizeCommitOptions(options);
        const startTime = Date.now();
        const stats = workingGrid.getMemoryStats();
        let committed = false;
        let comparePrecisions;

        try {
            comparePrecisions = this._getCowComparePrecisions();
        } catch (precisionErr: any) {
            this.logger.log(`[COW] ${precisionErr.message}`, 'error');
            this._clearWorkingGridRef();
            return false;
        }

        const preCommitGuard = evaluateCommit(workingGrid, {
            hasLock: false,
            currentVersion: this._gridVersion,
            masterGrid: this.orders,
            comparePrecisions
        });
        if (!preCommitGuard.canCommit) {
            this.logger.log(`[COW] ${preCommitGuard.reason}`, preCommitGuard.level || 'warn');
            this._clearWorkingGridRef();
            return false;
        }

        await this._gridLock.acquire(async () => {
            const lockCommitGuard = evaluateCommit(workingGrid, {
                hasLock: true,
                currentVersion: this._gridVersion,
                masterGrid: this.orders,
                comparePrecisions
            });
            if (!lockCommitGuard.canCommit) {
                this.logger.log(`[COW] ${lockCommitGuard.reason}`, lockCommitGuard.level || 'warn');
                this._clearWorkingGridRef();
                return;
            }

            this.logger.log(
                `[COW] Committing working grid: ${stats.size} orders, ${stats.modified} modified`,
                'debug'
            );

            const finalMap = workingGrid.toMap();
            // RC-4: Deep-freeze all modified orders before committing to master state
            // Ensures COW immutability invariants are maintained for all grid entries.
            for (const [id, order] of finalMap.entries()) {
                if (order && !Object.isFrozen(order)) {
                    deepFreeze(order);
                }
            }

            this.orders = Object.freeze(finalMap);
            this.boundaryIdx = workingBoundary;
            this._gridVersion++;
            committed = true;

            // Track orderIds from successful COW commits for recovery sync protection.
            // Cleared on every commit to reflect only the current confirmed state.
            this._committedOrderIds.clear();
            for (const [id, order] of finalMap.entries()) {
                if (order.orderId) this._committedOrderIds.add(order.orderId);
            }

            const freshIndexes = workingGrid.getIndexes();
            this._ordersByState = {
                [ORDER_STATES.VIRTUAL]: freshIndexes[ORDER_STATES.VIRTUAL] || new Set(),
                [ORDER_STATES.ACTIVE]: freshIndexes[ORDER_STATES.ACTIVE] || new Set(),
                [ORDER_STATES.PARTIAL]: freshIndexes[ORDER_STATES.PARTIAL] || new Set()
            };
            this._ordersByType = {
                [ORDER_TYPES.BUY]: freshIndexes[ORDER_TYPES.BUY] || new Set(),
                [ORDER_TYPES.SELL]: freshIndexes[ORDER_TYPES.SELL] || new Set(),
                [ORDER_TYPES.SPREAD]: freshIndexes[ORDER_TYPES.SPREAD] || new Set()
            };
        });

        if (!committed) {
            this._clearWorkingGridRef();
            return false;
        }

        try {
            if (!skipRecalc) {
                await this.recalculateFunds();
            }
            const duration = Date.now() - startTime;
            this.logger.log(`[COW] Grid committed in ${duration}ms`, 'debug');

            if (stats.size > COW_PERFORMANCE.GRID_MEMORY_WARNING) {
                this.logger.log(
                    `[COW] Warning: Large grid size (${stats.size} orders). Peak memory: ~${Math.round(stats.estimatedBytes / 1024)}KB`,
                    'warn'
                );
            }
        } catch (recalcErr: any) {
            this.logger.log(`[COW] Fund recalculation failed post-commit: ${recalcErr.message}`, 'error');
            this._recoveryState = this._recoveryState || {};
            this._recoveryState.lastFailureAt = Date.now();
        } finally {
            this._clearWorkingGridRef();
        }

        return true;
    }

    /**
     * @param {Object} [options]
     * @param {boolean} [options.allowBootstrapTransient]
     * @returns {import('./types').PersistenceValidationResult}
     */
    validateGridStateForPersistence(options: Record<string, any> = {}) {
        const result = validateGridForPersistence(this.orders, this.accountTotals);
        const allowBootstrapTransient = options.allowBootstrapTransient !== false;

        if (!result.isValid && allowBootstrapTransient && this._state.isBootstrapping()) {
            this.logger.log(`[BOOTSTRAP] Transient state (expected): ${result.reason}`, 'debug');
            return { isValid: true, reason: null };
        }

        return result;
    }

    /**
     * @param {string} [reason]
     * @returns {void}
     */
    suspendGridPersistence(reason = 'suspended') {
        this._gridPersistenceSuspendedReason = reason;
    }

    /**
     * @param {string} [reason]
     * @returns {void}
     */
    resumeGridPersistence(reason = null) {
        if (!this._gridPersistenceSuspendedReason) return;
        this.logger.log(
            `[PERSISTENCE-GATE] Resuming grid persistence${reason ? ` (${reason})` : ''}`,
            'info'
        );
        this._gridPersistenceSuspendedReason = null;
    }

    /**
     * @param {Array<Object>} [snapshotOrders] - Optional explicit orders to persist.
     *   When provided, this list is persisted as-is and the live `manager.orders`
     *   map is not touched. This is the only race-free way to persist a freshly
     *   built grid (e.g. from the startup `storeGrid` callback) without briefly
     *   swapping the live map and exposing it to concurrent readers.
     * @returns {Promise<import('./types').PersistenceValidationResult>}
     */
    async persistGrid(snapshotOrders) {
        if (this._gridPersistenceSuspendedReason) {
            this.logger.log(
                `[PERSISTENCE-GATE] Skipping grid persistence while suspended: ${this._gridPersistenceSuspendedReason}`,
                'warn'
            );
            return { isValid: true, skipped: true, suspended: true, reason: this._gridPersistenceSuspendedReason };
        }

        const validation = this.validateGridStateForPersistence();
        if (!validation.isValid) {
            this.logger.log(
                `[PERSISTENCE-GATE] Skipping persistence of corrupted state: ${validation.reason}`,
                'warn'
            );
            return validation;
        }

        await persistGridSnapshot(this, this.accountOrders, snapshotOrders);

        // On a successful live-grid persist (the default — no explicit
        // snapshotOrders was passed in), clear the dirty flag so that
        // a subsequent end-of-tick flushGridDirty() call sees the grid
        // as clean and skips the second snapshot write. When the caller
        // passes an explicit snapshotOrders (e.g. from the startup
        // storeGrid callback), the dirty flag is for the LIVE grid, not
        // the supplied snapshot, so we leave it alone.
        if (snapshotOrders === undefined && this._gridDirtyAt != null) {
            this._clearGridDirty();
        }

        return validation;
    }

    /**
     * @returns {import('./types').Metrics}
     */
    getMetrics() {
        return {
            ...this._metrics,
            state: this._state.getState(),
            currentTime: Date.now()
        };
    }

    _projectTargetToWorkingGrid(workingGrid, targetGrid) {
        return projectTargetToWorkingGrid(workingGrid, targetGrid);
    }

    _summarizeCowActions(actions) {
        return summarizeActions(actions);
    }

    _evaluateWorkingGridCommit(workingGrid, hasLock = false) {
        let comparePrecisions;
        try {
            comparePrecisions = this._getCowComparePrecisions();
        } catch (precisionErr: any) {
            return {
                canCommit: false,
                reason: precisionErr.message,
                level: 'error'
            };
        }

        return evaluateCommit(workingGrid, {
            hasLock,
            currentVersion: this._gridVersion,
            masterGrid: this.orders,
            comparePrecisions
        });
    }

    get _rebalanceState() {
        return this._state.getRebalanceState();
    }

    set _rebalanceState(value) {
        this._state.setRebalanceState(value);
    }

    get _lastIllegalState() {
        return this._state.signals?.lastIllegalState || null;
    }

    set _lastIllegalState(value) {
        if (value) {
            this._state.setIllegalStateSignal(value);
        }
    }

    get _lastAccountingFailure() {
        return this._state.signals?.lastAccountingFailure || null;
    }

    set _lastAccountingFailure(value) {
        if (value) {
            this._state.setAccountingFailureSignal(value);
        }
    }

    get _recoveryState() {
        return this._state.recovery;
    }

    set _recoveryState(value) {
        const fallback = {
            attemptCount: 0,
            lastAttemptAt: 0,
            inFlight: false,
            lastFailureAt: 0,
            structuralResyncRequested: false
        };
        this._state.recovery = {
            ...fallback,
            ...(value && typeof value === 'object' ? value : {})
        };
    }

    get _gridRegenState() {
        return this._state.gridRegen;
    }

    set _gridRegenState(value) {
        if (!value || typeof value !== 'object') return;

        const defaultSide = { armed: true, lastTriggeredAt: 0 };
        this._state.gridRegen = {
            buy: { ...defaultSide, ...(value.buy || {}) },
            sell: { ...defaultSide, ...(value.sell || {}) }
        };
    }

}

export = { OrderManager };
