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
 * SECTION 3: ORDER MANAGER CLASS
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: EXTERNAL DEPENDENCIES
// ===============================================================================


import { persistGridSnapshot, deepFreeze, cloneMap } from './utils/system';
import { withTimeout } from './utils/timeout';
import { WorkingGrid } from './working_grid';
import Logger from './logger';
import AsyncLock from './async_lock';
import Accountant from './accounting';
import StrategyEngine from './strategy';
import SyncEngine from './sync_engine';
import { calculateCurrentSpread, checkSpreadCondition, checkGridHealth } from './grid';
import * as Format from './format';
import {
    ORDER_TYPES,
    ORDER_STATES,
    REBALANCE_STATES,
    DEFAULT_CONFIG,
    TIMING,
    LOG_LEVEL,
    PIPELINE_TIMING,
    COW_PERFORMANCE
} from '../constants';
import {
    getMinAbsoluteOrderSize,
    computeChainFundTotals,
    hasValidAccountTotals,
    resolveConfigValueWithRegistry,
    isExplicitZeroAllocation,
    floatToBlockchainInt
} from './utils/math';
import {
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
} from './utils/validate';
import { getErrorMessage } from '../utils/errors';
const { toFiniteNumber } = Format;

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
// 4. Only ONE rebalance plan active at a time (_rebalanceState)
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

    constructor(deps: any) {
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
    }: any) {
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
                logger: (msg: any, level: any) => this.logger?.log(msg, level),
                dustThresholdPercent
            }
        );

        if (reconcileResult.aborted) {
            return buildAbortedResult((reconcileResult as any).reason);
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
// SECTION 3: ORDER MANAGER CLASS
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
    _rebalanceState: string;
    _bootstrapping: number;
    _broadcastingFlag: number;
    _broadcastingStartedAt: number;
    _illegalStateSignal: any;
    _accountingFailureSignal: any;
    _recoveryStateValue: { phase: string; attemptCount: number; lastAttemptAt: number; inFlight: boolean; lastFailureAt: number; structuralResyncRequested?: boolean };
    _gridRegenStateValue: { buy: { armed: boolean; lastTriggeredAt: number }; sell: { armed: boolean; lastTriggeredAt: number } };
    private _ordersByTypeCache: Record<string, Set<string>> | null = null;
    private _ordersByStateCache: Record<string, Set<string>> | null = null;
    private _ordersByTypeCacheVersion: number = -1;
    private _ordersByStateCacheVersion: number = -1;

    /**
     * Lazy-compute order-IDs grouped by type.
     *
     * Cache is invalidated when _gridVersion changes (bumped on each COW
     * commit).  The rebuild iterates this.orders (O(n) where n = total
     * slot count) but is amortized O(1) across accesses within the same
     * grid version — the cache is a derived snapshot, not a maintained
     * index, so explicit mutation paths no longer update it.
     *
     * THE SETTER stores into cache only; it does NOT populate this.orders.
     * Test mocks that assign _ordersByType directly are honored until the
     * next grid-version bump triggers a full rebuild from the real orders.
     */
    get _ordersByType(): Record<string, Set<string>> {
        if (this._ordersByTypeCache !== null && this._ordersByTypeCacheVersion === this._gridVersion) {
            return this._ordersByTypeCache;
        }
        const byType: Record<string, Set<string>> = {};
        for (const key of [ORDER_TYPES.BUY, ORDER_TYPES.SELL, ORDER_TYPES.SPREAD]) {
            byType[key] = new Set();
        }
        for (const [id, o] of this.orders) {
            if (byType[o.type]) byType[o.type].add(id);
        }
        this._ordersByTypeCache = byType;
        this._ordersByTypeCacheVersion = this._gridVersion;
        return byType;
    }
    set _ordersByType(val: Record<string, Set<string>>) {
        this._ordersByTypeCache = val;
        this._ordersByTypeCacheVersion = this._gridVersion;
    }

    /**
     * Lazy-compute order-IDs grouped by state.  Same semantics as
     * _ordersByType — see getter doc for details.
     */
    get _ordersByState(): Record<string, Set<string>> {
        if (this._ordersByStateCache !== null && this._ordersByStateCacheVersion === this._gridVersion) {
            return this._ordersByStateCache;
        }
        const byState: Record<string, Set<string>> = {};
        for (const key of [ORDER_STATES.VIRTUAL, ORDER_STATES.ACTIVE, ORDER_STATES.PARTIAL]) {
            byState[key] = new Set();
        }
        for (const [id, o] of this.orders) {
            if (byState[o.state]) byState[o.state].add(id);
        }
        this._ordersByStateCache = byState;
        this._ordersByStateCacheVersion = this._gridVersion;
        return byState;
    }
    set _ordersByState(val: Record<string, Set<string>>) {
        this._ordersByStateCache = val;
        this._ordersByStateCacheVersion = this._gridVersion;
    }
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
    _pauseFundRecalcWatchdog: ReturnType<typeof setTimeout> | null;
    _pauseRecalcLogging: boolean;
    _pauseRecalcLoggingWatchdog: ReturnType<typeof setTimeout> | null;
    _throwOnIllegalState: boolean;
    _pipelineBlockedSince: any;
    _recoveryAttempted: boolean;
    _syncGeneration: number;
    _gridVersion: number;
    _gridPersistenceSuspendedReason: any;
    _pendingBroadcasts: Map<any, any>;
    _committedOrderIds: Set<string>;
    _committedOrderIdsBuiltAt: number;
    _gapSlots: number;
    _gridDirtyAt: number | null;
    _orphanFillsCreditedAt: number | null;
    _pendingRecovery: Promise<void> | null;
    _recentFillKeysSnapshot: Record<string, number> | null;

    _metrics: any;
    private _currentWorkingGridStack: any[];
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

        this._rebalanceState = REBALANCE_STATES.NORMAL;
        this._bootstrapping = 0;
        this._broadcastingFlag = 0;
        this._broadcastingStartedAt = 0;
        this._illegalStateSignal = null;
        this._accountingFailureSignal = null;
        this._recoveryStateValue = {
            phase: 'idle',
            attemptCount: 0,
            lastAttemptAt: 0,
            inFlight: false,
            lastFailureAt: 0
        };
        this._gridRegenStateValue = {
            buy: { armed: true, lastTriggeredAt: 0 },
            sell: { armed: true, lastTriggeredAt: 0 }
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
        //   Level 0: _fillProcessingLock  (fill processing — outermost)
        //   Level 1: _divergenceLock   (divergence checks)
        //   Level 2: _syncLock         (sync operations — timeout-protected)
        //   Level 3: _gridLock         (grid mutations)
        //   Level 4: _fundLock         (fund operations — innermost)
        // Note: AsyncLock IS re-entrant (acquire detects nested calls via _holding).
        this._fillProcessingLock = new AsyncLock({ level: 0, timeout: TIMING.SYNC_LOCK_TIMEOUT_MS });
        this._divergenceLock = new AsyncLock({ level: 1 });
        this._syncLock = new AsyncLock({ level: 2 });
        this._gridLock = new AsyncLock({
            level: 3,
            onContention: () => { this._metrics.gridLockContention++; }
        });
        this._fundLock = new AsyncLock({ level: 4, timeout: 30000 });

        this._recentlyRotatedOrderIds = new Set();
        this._gridSidesUpdated = new Set();
        this._pauseFundRecalc = 0;
        this._pauseFundRecalcWatchdog = null;
        this._pauseRecalcLogging = false;
        this._pauseRecalcLoggingWatchdog = null;
        this._throwOnIllegalState = false;
        this._pipelineBlockedSince = null;
        this._recoveryAttempted = false;
        this._syncGeneration = 0;
        this._gridVersion = 0;
        this._gridPersistenceSuspendedReason = null;
        this._pendingBroadcasts = new Map();
        this._committedOrderIds = new Set();
        this._committedOrderIdsBuiltAt = 0;
        this._gapSlots = 0;
        this._gridDirtyAt = null;
        this._orphanFillsCreditedAt = null;
        this._pendingRecovery = null;
        this._recentFillKeysSnapshot = null;

        this._metrics = {
            fundRecalcCount: 0,
            lockAcquisitions: 0,
            lockContentionSkips: 0,
            gridLockContention: 0,
            spreadRoleConversionBlocked: 0,
            lastSyncDurationMs: 0,
            metricsStartTime: Date.now()
        };

        this._bootstrapping = 1;
        this.logger?.log('[BOOTSTRAP] Started', 'debug');
        this._currentWorkingGridStack = [];
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
        this._currentWorkingGridStack.pop();
        this._rebalanceState = this._currentWorkingGridStack.length > 0
            ? REBALANCE_STATES.REBALANCING
            : REBALANCE_STATES.NORMAL;
    }

    _setRebalanceState(state: any) {
        this._rebalanceState = state;
        this.logger?.log(`[COW] Rebalance state: ${state}`, 'debug');
    }

    _resetRebalanceStateToDepth() {
        this._rebalanceState = this._currentWorkingGridStack.length > 0
            ? REBALANCE_STATES.REBALANCING
            : REBALANCE_STATES.NORMAL;
    }

    /**
     * @returns {boolean}
     */
    isRebalancing() {
        return this._rebalanceState === REBALANCE_STATES.REBALANCING;
    }

    /**
     * @returns {boolean}
     */
    isBroadcasting() {
        return this._rebalanceState === REBALANCE_STATES.BROADCASTING;
    }

    /**
     * @returns {boolean}
     */
    isBootstrapping() {
        return this._bootstrapping > 0;
    }

    /**
     * Whether a broadcast is currently active (no side-effects).
     * @returns {boolean}
     */
    isBroadcastingActive() {
        return this._broadcastingFlag > 0;
    }

    /**
     * Auto-clears a stale broadcast flag after 120s so a hung
     * broadcast cannot permanently block rebalancing.
     * Separated from isBroadcastingActive() so the side-effect only
     * runs from one well-defined location (maintenance logic) instead
     * of from every read call-site.
     * @returns {void}
     */
    _clearStaleBroadcastFlag() {
        if (this._broadcastingFlag > 0 && this._broadcastingStartedAt > 0) {
            const elapsed = Date.now() - this._broadcastingStartedAt;
            if (elapsed > 120000) {
                this.logger?.log?.('[BROADCAST] Auto-clearing stale broadcast flag after 120s', 'warn');
                // Hard-reset to 0 (not decrement) — this is a safety valve for
                // a hung broadcast where stopBroadcasting() was never called.
                // The caller is released from the refcount contract.
                this._broadcastingFlag = 0;
                this._broadcastingStartedAt = 0;
            }
        }
    }

    /**
     * Whether the manager is in the middle of a rebalance plan or broadcast.
     * @returns {boolean}
     */
    isPlanningActive() {
        return this.isRebalancing() || this.isBroadcastingActive();
    }

    /**
     * @returns {void}
     */
    startBootstrap() {
        if (this._bootstrapping === 0) {
            this.logger?.log('[BOOTSTRAP] Started', 'debug');
        }
        this._bootstrapping++;
    }

    /**
     * @returns {import('./types').BootstrapResult}
     */
    finishBootstrap() {
        const result = { hadDrift: false, driftInfo: null };

        if (this._bootstrapping > 0) {
            this._bootstrapping--;
        }

        if (this._bootstrapping === 0) {
            this.logger?.log('[BOOTSTRAP] Finished', 'debug');

            // Validate fund state at bootstrap completion - if drift exists here,
            // it's not transient (grid is now stable) and indicates a potential bug
            const driftCheck = this.checkFundDriftAfterFills();
            if (!driftCheck.isValid) {
                result.hadDrift = true;
                result.driftInfo = driftCheck as any;
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
        if (this._broadcastingFlag === 0) {
            this._broadcastingStartedAt = Date.now();
        }
        this._broadcastingFlag++;
        this.logger?.log?.('[BROADCAST] Flag incremented — fill processing will be deferred until stopBroadcasting()', 'debug');
    }

    /**
     * @returns {void}
     */
    stopBroadcasting() {
        if (this._broadcastingFlag > 0) {
            this._broadcastingFlag--;
        }
        if (this._broadcastingFlag === 0) {
            this._broadcastingStartedAt = 0;
        }
    }

    /**
     * @returns {void}
     */
    resetFunds() {
        return this.accountant.resetFunds();
    }

    async _deductFromChainFree(orderType: any, size: any, operation: any) {
        if (!this.accountant) return;
        return await this.accountant.tryDeductFromChainFree(orderType, size, operation);
    }

    async _addToChainFree(orderType: any, size: any, operation: any) {
        if (!this.accountant) return;
        return await this.accountant.addToChainFree(orderType, size, operation);
    }

    _getGridTotal(side: any) {
        return (this.funds?.committed?.grid?.[side] || 0) + (this.funds?.virtual?.[side] || 0);
    }

    /**
     * Computes committed amounts directly from the orders map to ensure the
     * snapshot is internally consistent even when called inside a
     * pauseFundRecalc region.  Normally recalculateFunds() keeps
     * funds.committed.chain in sync, but when pauses are nested the cached
     * value can lag behind the actual orders state (virtualized orders
     * release committed capital via updateOptimisticFreeBalance without
     * triggering a recalc).  Reading from the orders map avoids that race.
     * @returns {import('./types').ChainFundsSnapshot}
     */
    getChainFundsSnapshot() {
        let committedBuy = 0, committedSell = 0;
        for (const order of this.orders.values()) {
            const isActive = (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) && !!order.orderId;
            if (!isActive) continue;
            const size = toFiniteNumber(order.size);
            if (size <= 0) continue;
            const isBuy = order.type === ORDER_TYPES.BUY || (order.type === ORDER_TYPES.SPREAD && order.price < this.config.startPrice);
            if (isBuy) committedBuy += size;
            else committedSell += size;
        }
        const totals = computeChainFundTotals(this.accountTotals, { buy: committedBuy, sell: committedSell });
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
    async waitForAccountTotals(timeoutMs: any = TIMING.ACCOUNT_TOTALS_TIMEOUT_MS) {
        if (hasValidAccountTotals(this.accountTotals, true)) return;

        let waitPromise = null;

        await this._fundLock.acquire(async () => {
            if (hasValidAccountTotals(this.accountTotals, true)) return;
            if (!this._accountTotalsPromise) {
                this._accountTotalsPromise = new Promise((resolve: any) => {
                    this._accountTotalsResolve = resolve;
                });
            }
            waitPromise = this._accountTotalsPromise;
        });

        if (!waitPromise) return;

        await withTimeout(waitPromise, timeoutMs, {
            onTimeout: 'resolve',
            defaultValue: undefined as any,
            onTimeoutCallback: () => this.logger.log('[FUND] Timeout waiting for account totals', 'warn'),
        });
    }

    /**
     * @param {string} [accountId] - Blockchain account ID
     * @returns {Promise<void>}
     */
    async fetchAccountTotals(accountId: any) {
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
    async setAccountTotals(totals: any = { buy: null, sell: null, buyFree: null, sellFree: null }) {
        return await this._fundLock.acquire(async () => {
            return await this._setAccountTotals(totals);
        });
    }

    async _setAccountTotals(totals: any) {
        this.accountTotals = { ...(this.accountTotals || {}), ...totals, _lastFetchedAt: Date.now() };
        if (!this.funds) this.resetFunds();

        await this._recalculateFunds();

        if (hasValidAccountTotals(this.accountTotals, true) && typeof this._accountTotalsResolve === 'function') {
            try {
                this._accountTotalsResolve();
            } catch (e: any) {
                this.logger?.log?.(`Error resolving account totals promise: ${getErrorMessage(e)}`, 'warn');
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
     * Suppress fund recalculation during batch mutations.
     *
     * Use when multiple _applyOrderUpdate calls would each trigger redundant
     * recalculateFunds (e.g. grid load, grid init, fill batch). Must be paired
     * with resumeFundRecalc() in a try/finally block.
     *
     * Supports nesting via depth counter — only the outermost resume triggers
     * the single consolidated recalculation.
     *
     * For bulk mutation sites that also need to suppress debug RECALC logging
     * during the loop, pair this with pauseRecalcLogging()/resumeRecalcLogging().
     *
     * Use independently of pauseRecalcLogging when you need recalc to still run
     * per-operation but want to batch the trigger (e.g. _updateOrdersForSide
     * needs per-call chain-free tracking but suppresses log spam).
     *
     * @returns {void}
     */
    pauseFundRecalc() {
        this._pauseFundRecalc++;
        // Safety watchdog: if pauseFundRecalc is not resumed within the timeout,
        // force-reset the counter to prevent permanent suppression from a missed
        // finally block. Only set when depth goes from 0 → 1 so only the outermost
        // pause has a watchdog.
        if (this._pauseFundRecalc === 1) {
            if (this._pauseFundRecalcWatchdog) {
                clearTimeout(this._pauseFundRecalcWatchdog);
            }
            this._pauseFundRecalcWatchdog = setTimeout(() => {
                if (this._pauseFundRecalc > 0) {
                    this.logger?.log?.(
                        `[MANAGER] pauseFundRecalc safety watchdog: resetting depth from ${this._pauseFundRecalc} to 0`,
                        'warn'
                    );
                    this._pauseFundRecalc = 0;
                    this._pauseFundRecalcWatchdog = null;
                    this._recalculateFunds().catch((err: any) => {
                        this.logger?.log?.(`[MANAGER] Watchdog recalc failed: ${getErrorMessage(err)}`, 'error');
                    });
                }
            }, TIMING.SAFETY_PAUSE_TIMEOUT_MS);
        }
    }

    /**
     * Resume fund recalculation and trigger one consolidated recalculateFunds()
     * when the outermost resume completes.
     * @returns {Promise<void>}
     */
    async resumeFundRecalc() {
        this._pauseFundRecalc = Math.max(0, this._pauseFundRecalc - 1);
        if (this._pauseFundRecalc === 0) {
            if (this._pauseFundRecalcWatchdog) {
                clearTimeout(this._pauseFundRecalcWatchdog);
                this._pauseFundRecalcWatchdog = null;
            }
            await this.recalculateFunds();
        }
    }

    /**
     * Suppress only the debug-level [RECALC] log lines inside recalculateFunds().
     *
     * Lighter than pauseFundRecalc — recalculation still runs, only log output
     * is suppressed. Use when individual _updateOrder calls must update chain-free
     * balances but the iterative debug logging would flood output
     * (e.g. _updateOrdersForSide grid resize loop).
     *
     * When paired with pauseFundRecalc/resumeFundRecalc (grid load/init),
     * both calcs and logging are suppressed during the batch. When used alone
     * (_updateOrdersForSide), recalc runs per-call but logs are suppressed.
     *
     * @returns {void}
     */
    pauseRecalcLogging() {
        this._pauseRecalcLogging = true;
        if (this._pauseRecalcLoggingWatchdog) {
            clearTimeout(this._pauseRecalcLoggingWatchdog);
        }
        this._pauseRecalcLoggingWatchdog = setTimeout(() => {
            this.logger?.log?.(
                `[MANAGER] pauseRecalcLogging safety watchdog: forcing resume after ${TIMING.SAFETY_PAUSE_TIMEOUT_MS}ms`,
                'warn'
            );
            this._pauseRecalcLogging = false;
            this._pauseRecalcLoggingWatchdog = null;
        }, TIMING.SAFETY_PAUSE_TIMEOUT_MS);
    }

    /**
     * Resume recalc debug logging.
     * @returns {void}
     */
    resumeRecalcLogging() {
        this._pauseRecalcLogging = false;
        if (this._pauseRecalcLoggingWatchdog) {
            clearTimeout(this._pauseRecalcLoggingWatchdog);
            this._pauseRecalcLoggingWatchdog = null;
        }
    }

    /**
     * @param {Array<import('./types').Order>} orders
     * @param {Object} info
     * @returns {Promise<import('./types').SyncResult>}
     */
    syncFromOpenOrders(orders: any, info: any) {
        return this.sync.syncFromOpenOrders(orders, info);
    }

    /**
     * @param {Object} fill - Fill event data
     * @param {Object} [options]
     * @returns {Promise<import('./types').SyncResult>}
     */
    syncFromFillHistory(fill: any, options: any) {
        return this.sync.syncFromFillHistory(fill, options);
    }

    /**
     * @param {Array} fills - Array of fill event objects (same block group)
     * @param {Object} [options]
     * @returns {Promise<import('./types').BatchSyncResult>}
     */
    syncFromFillHistoryBatch(fills: any, options: any) {
        return this.sync.syncFromFillHistoryBatch(fills, options);
    }

    /**
     * @param {Object} data - Chain data to synchronize
     * @param {string} src - Source identifier
     * @returns {Promise<import('./types').SyncResult>}
     */
    async synchronizeWithChain(data: any, src: any) {
        // Lock delegation: createOrder/cancelOrder acquire _gridLock internally;
        // readOpenOrders/periodicBlockchainFetch acquire _syncLock → _gridLock.
        return await this._applySync(data, src);
    }

    async _applySync(data: any, src: any) {
        return await this.sync.synchronizeWithChain(data, src);
    }

    async _initializeAssets() {
        return await this.sync.initializeAssets();
    }

    /**
     * @param {string[]|Set<string>} orderIds - Order IDs to lock
     * @returns {void}
     */
    lockOrders(orderIds: any) {
        if (!orderIds) return;
        const expiration = Date.now() + TIMING.LOCK_TIMEOUT_MS;
        for (const id of orderIds) if (id) this.shadowOrderIds.set(id, expiration);
        this._cleanExpiredLocks();
    }

    /**
     * @param {string[]|Set<string>} orderIds - Order IDs to unlock
     * @returns {void}
     */
    unlockOrders(orderIds: any) {
        if (!orderIds) return;
        for (const id of orderIds) if (id) this.shadowOrderIds.delete(id);
        this._cleanExpiredLocks();
    }

    /**
     * @param {string} id - Order ID
     * @returns {boolean}
     */
    isOrderLocked(id: any) {
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

    async _updateOrder(order: any, context: any = 'updateOrder', options: any = {}) {
        const updateOptions = this._normalizeOrderUpdateOptions(options);
        return await this._gridLock.acquire(async () => {
            return await this._applyOrderUpdate(order, context, updateOptions);
        });
    }

    async _applyOrderUpdate(order: any, context: any = 'updateOrder', options: any = {}) {
        const updateOptions = this._normalizeOrderUpdateOptions(options);
        const { skipAccounting, fee: normalizedFee } = updateOptions;
        const oldOrder = this.orders.get(order.id);
        const validation = validateOrder(order, oldOrder, context);

        for (const warning of validation.warnings) {
            this.logger.log(warning.message, 'warn');
        }

        if (!validation.isValid && validation.errors.length > 0) {
            const fatalError = validation.errors.find((e: any) => (e as any).isFatal || e.code === 'ILLEGAL_SPREAD_STATE');
            if (fatalError) {
                this.logger.log(fatalError.message, 'error');
                this._lastIllegalState = {
                    id: order.id,
                    context,
                    message: fatalError.message,
                };
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
        const phantomError = validation.errors.find((e: any) => e.code === 'PHANTOM_ORDER');
        let accountingSkip = skipAccounting;
        if (phantomError && (phantomError as any).autoCorrect) {
            nextOrder = { ...nextOrder, ...(phantomError as any).autoCorrect };
            // Phantom orders never had funds committed on-chain (no orderId).
            // The auto-correction transitions ACTIVE/PARTIAL → VIRTUAL which
            // updateOptimisticFreeBalance would treat as capital release,
            // inflating accountTotals.  Skip capital commitment accounting.
            accountingSkip = true;
        }

        if (this.accountant) {
            await this.accountant.updateOptimisticFreeBalance(oldOrder, nextOrder, context, normalizedFee, accountingSkip);
        }

        const updatedOrder = deepFreeze({ ...nextOrder });
        const id = order.id;

        const newMap = cloneMap(this.orders);
        newMap.set(id, updatedOrder);
        this.orders = Object.freeze(newMap);
        this._gridVersion++;

        this._syncWorkingGridFromMasterMutation(id, context);

        if (this._pauseFundRecalc === 0) {
            await this.recalculateFunds();
        }

        this._markGridDirty();

        return true;
    }

    /**
     * Backward-compatible accessor for _currentWorkingGrid.
     * Returns the top of the working grid stack (null if empty).
     */
    get _currentWorkingGrid(): any {
        return this._peekWorkingGrid();
    }

    set _currentWorkingGrid(val: any) {
        if (val !== null) {
            this._currentWorkingGridStack.push(val);
        }
    }

    _peekWorkingGrid(): any {
        const stack = this._currentWorkingGridStack;
        return stack.length > 0 ? stack[stack.length - 1] : null;
    }

    _syncWorkingGridFromMasterMutation(orderId: any, context: any) {
        const wg = this._peekWorkingGrid();
        if (!wg || !this.isPlanningActive()) {
            return;
        }

        try {
            wg.markStale(
                `master mutation during ${(this._rebalanceState || '').toLowerCase()} (${context})`
            );
            wg.syncFromMaster(this.orders, orderId, this._gridVersion);
        } catch (syncErr: any) {
            wg.markStale(`working-grid sync failure: ${getErrorMessage(syncErr)}`);
            this.logger.log(`[COW] Failed to sync working grid for order ${orderId}: ${getErrorMessage(syncErr)}`, 'warn');
        }
    }

    /**
     * @param {Array<import('./types').Order>} updates - Order updates to apply
     * @param {string} [context] - Update context label
     * @param {import('./types').OrderUpdateOptions} [options]
     * @returns {Promise<boolean>}
     */
    async applyGridUpdateBatch(updates: any, context: any = 'batch-update', options: any = {}) {
        const updateOptions = this._normalizeOrderUpdateOptions(options);
        return await this._gridLock.acquire(async () => {
            let allOk = true;
            for (const update of updates) {
                const ok = await this._applyOrderUpdate(update, context, updateOptions);
                if (ok === false) {
                    allOk = false;
                    // Stop on first fatal error (ILLEGAL_SPREAD_STATE).
                    // Remaining valid updates will be reconciled on the
                    // next sync cycle — safer than applying mutations on
                    // top of an inconsistent grid state.
                    break;
                }
            }
            return allOk;
        });
    }

    /**
     * Flag the in-memory master grid as dirty so the next flushGridDirty()
     * call persists it. Internal helper — every successful _applyOrderUpdate
     * call ends with this. External callers that mutate the grid through
     * other paths (e.g. raw `this.orders.set(...)` from a refactor) should
     * invoke this explicitly so the dirty-flag invariant still holds.
     *
     * @returns {void}
     */
    _markGridDirty() {
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
    async flushGridDirty(contextLabel: any = 'flush-grid-dirty') {
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
        if (result && (result as any).skipped === true) {
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
    async processFilledOrders(orders: any, excl: any, _options: any) {
        // Step 1: Handle Fills (Accounting & State Updates)
        await this.strategy.processFillsOnly(orders, excl);

        // Step 2: Trigger Safe Rebalance only for actual fills.
        const triggerFills = orders.filter((f: any) => !f.isPartial || f.isDelayedRotationTrigger);
        const shouldRebalance = triggerFills.length > 0;

        if (shouldRebalance) {
            const rebalanceResult = await this.performSafeRebalance(orders, excl);
            return rebalanceResult;
        }

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
            .sort((a: any, b: any) => a.price - b.price)
            .slice(0, sellCount);
        // Filter by minimum size, then reverse for placement order (highest first)
        const validSells = vSells
            .filter((o: any) => floatToBlockchainInt(o.size, sellPrecision) >= minSellSizeInt)
            .sort((a: any, b: any) => b.price - a.price);

        // Get closest virtual buys (highest prices first = closest to market), limit to buyCount
        const vBuys = this.getOrdersByTypeAndState(ORDER_TYPES.BUY, ORDER_STATES.VIRTUAL)
            .sort((a: any, b: any) => b.price - a.price)
            .slice(0, buyCount);
        // Filter by minimum size, then reverse for placement order (lowest first)
        const validBuys = vBuys
            .filter((o: any) => floatToBlockchainInt(o.size, buyPrecision) >= minBuySizeInt)
            .sort((a: any, b: any) => a.price - b.price);

        return [...validSells, ...validBuys];
    }

    /**
     * Get orders matching the specified type and state.
     * 
     * @param {string|null} type - Order type (ORDER_TYPES.BUY/SELL/SPREAD) or null for all types
     * @param {string} state - Order state (ORDER_STATES.ACTIVE/PARTIAL/VIRTUAL)
     * @returns {Array} Array of matching orders
     */
    getOrdersByTypeAndState(type: any, state: any) {
        const result: any[] = [];
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
    getPartialOrdersOnSide(type: any) {
        return this.getOrdersByTypeAndState(type, ORDER_STATES.PARTIAL);
    }

    /**
     * Write boundaryIdx under COW-commit-only discipline.
     *
     * Must only be called from within _commitWorkingGrid (which holds _gridLock).
     * If called outside the commit path, logs a warning — the write still proceeds
     * so a misbehaving caller doesn't silently lose the update, but the warning
     * flags a violation of the COW boundary-write invariant.
     */
    _setBoundary(newIdx: number): void {
        if (!this._gridLock?.isReentrant()) {
            this.logger?.log?.(
                `[COW] _setBoundary called outside _gridLock (boundary ${this.boundaryIdx} → ${newIdx}). ` +
                `Boundary writes should only happen inside _commitWorkingGrid.`,
                'warn'
            );
        }
        this.boundaryIdx = newIdx;
    }

    /**
     * Restore boundaryIdx outside the COW commit path (startup, recovery,
     * disk-load).  This is the same write as _setBoundary but without the
     * lock-hold warning — loadGrid / initializeGrid are single-threaded at
     * startup and the boundary is being restored from a known-good snapshot,
     * not committed alongside order mutations.
     */
    _restoreBoundary(newIdx: number): void {
        this.boundaryIdx = newIdx;
    }

    /**
     * @returns {Object|null} The consumed signal or null
     */
    consumeIllegalStateSignal() {
        const signal = this._illegalStateSignal;
        this._illegalStateSignal = null;
        return signal;
    }

    /**
     * @returns {Object|null} The consumed signal or null
     */
    consumeAccountingFailureSignal() {
        const signal = this._accountingFailureSignal;
        this._accountingFailureSignal = null;
        return signal;
    }

    /**
     * @param {Object} BitShares - BitShares API instance
     * @param {Function} batchCb - Batch callback
     * @returns {Promise<Object>}
     */
    async checkSpreadCondition(BitShares: any, batchCb: any) {
        return await checkSpreadCondition(this, BitShares, batchCb);
    }

    /**
     * @param {Function} batchCb - Batch callback
     * @returns {Promise<Object>}
     */
    async checkGridHealth(batchCb: any) {
        return await checkGridHealth(this, batchCb);
    }

    /**
     * @returns {Object} Current spread calculation
     */
    calculateCurrentSpread() {
        return calculateCurrentSpread(this);
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
        const reasons: string[] = [];

        // _gridSidesUpdated is cleared at the top of every maintenance tick before
        // divergence detection, so it cannot cause stale-side processing here.
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
        if (broadcasting || this.isBroadcastingActive()) {
            reasons.push('broadcasting active orders');
        }

        if (reasons.length > 0 && !this._pipelineBlockedSince) {
            this._pipelineBlockedSince = Date.now();
        } else if (reasons.length === 0) {
            this._pipelineBlockedSince = null;
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
        const timeoutMs = this.config?.pipelineTiming?.TIMEOUT_MS ?? PIPELINE_TIMING.TIMEOUT_MS;
        if (age < timeoutMs) return false;

        this.ordersNeedingPriceCorrection = [];
        this._pipelineBlockedSince = null;
        return true;
    }

    /**
     * @returns {import('./types').PipelineHealth}
     */
    getPipelineHealth() {
        const blockedDuration = this._pipelineBlockedSince
            ? Date.now() - this._pipelineBlockedSince
            : 0;
        const timeoutMs = this.config?.pipelineTiming?.TIMEOUT_MS ?? PIPELINE_TIMING.TIMEOUT_MS;

        return {
            isBlocked: this._pipelineBlockedSince !== null,
            blockedDurationMs: blockedDuration,
            hasStalled: blockedDuration > timeoutMs,
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
    reconcileGrid(targetGrid: any, targetBoundary: any) {
        return reconcileGrid(this.orders, targetGrid, targetBoundary, {
            logger: (msg: any, level: any) => this.logger.log(msg, level),
            dustThresholdPercent: this.config?.gridLimits?.PARTIAL_DUST_THRESHOLD_PERCENTAGE
        });
    }

    /**
     * @param {Array} [fills] - Fill events triggering rebalance
     * @param {Set<string>} [excludeIds] - Order IDs to exclude
     * @returns {Promise<import('./types').CowRebalanceResult>}
     */
    async performSafeRebalance(fills: any = [], excludeIds: any = new Set()) {
        this.logger.log("[SAFE-REBALANCE] Starting with COW...", "info");
        return await this._gridLock.acquire(async () => {
            return await this._applySafeRebalanceCOW(fills, excludeIds);
        });
    }

    async _applySafeRebalanceCOW(fills: any = [], excludeIds: any = new Set()) {
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

        this._currentWorkingGridStack.push(result.workingGrid);
        return result;
    }

    _reconcileGridCOW(targetGrid: any, targetBoundary: any, workingGrid: any) {
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

    _validateWorkingGridFunds(workingGrid: any, projectedFunds: any) {
        return validateWorkingGridFunds(workingGrid, projectedFunds, {
            buyPrecision: this.assets?.assetB?.precision,
            sellPrecision: this.assets?.assetA?.precision
        }, this.assets);
    }

    _calculateRequiredFundsFromGrid(workingGrid: any, precisions: Record<string, any> = {}) {
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

    _buildStateUpdates(actions: any, masterGrid: any) {
        return buildStateUpdates(actions, masterGrid);
    }

    _buildAbortedCOWResult(reason: any) {
        return buildAbortedResult(reason);
    }

    async _commitWorkingGrid(workingGrid: any, _workingIndexes: any, workingBoundary: any, options: any = {}) {
        const { skipRecalc } = this._normalizeCommitOptions(options);
        const startTime = Date.now();
        const stats = workingGrid.getMemoryStats();
        let committed = false;
        let comparePrecisions;

        try {
            comparePrecisions = this._getCowComparePrecisions();
        } catch (precisionErr: any) {
            this.logger.log(`[COW] ${getErrorMessage(precisionErr)}`, 'error');
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
            for (const [, order] of finalMap.entries()) {
                if (order && !Object.isFrozen(order)) {
                    deepFreeze(order);
                }
            }

            this.orders = Object.freeze(finalMap);
            this._setBoundary(workingBoundary);
            this._gridVersion++;
            committed = true;

            // Track orderIds from successful COW commits for recovery sync protection.
            // Build a new set from the committed finalMap and atomically swap to
            // avoid the intermediate empty state that clear() creates — a crash
            // during clear()+repopulate would lose all committed IDs.
            const newCommittedIds = new Set<string>();
            for (const [, order] of finalMap.entries()) {
                if (order.orderId) newCommittedIds.add(order.orderId);
            }
            this._committedOrderIds = newCommittedIds;
            this._committedOrderIdsBuiltAt = Date.now();

            // Index caches invalidated by _gridVersion bump above — lazy getters recompute from this.orders
        });

        if (!committed) {
            this._clearWorkingGridRef();
            return false;
        }

        try {
            if (!skipRecalc) {
                // If the last accounting failure was due to stale accountTotals,
                // the commit proceeded without locking funds. Refresh accountTotals
                // before recalculateFunds() to avoid a false-positive drift recovery.
                if (this._lastAccountingFailure?.reason === 'stale') {
                    this.logger.log(
                        '[COW] Stale accountTotals during commit; refreshing before recalculateFunds to avoid false recovery',
                        'warn'
                    );
                    await this.fetchAccountTotals(this.accountId);
                }
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
            this.logger.log(`[COW] Fund recalculation failed post-commit: ${getErrorMessage(recalcErr)}`, 'error');
            this._recoveryState = { ...this._recoveryState, lastFailureAt: Date.now() };
            // Re-throw to signal callers that the commit is incomplete
            // (grid state committed, but fund state is stale).
            throw recalcErr;
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

        if (!result.isValid && allowBootstrapTransient && this._bootstrapping) {
            this.logger.log(`[BOOTSTRAP] Transient state (expected): ${result.reason}`, 'debug');
            return { isValid: true, reason: null };
        }

        return result;
    }

    /**
     * @param {string} [reason]
     * @returns {void}
     */
    suspendGridPersistence(reason: any = 'suspended') {
        this._gridPersistenceSuspendedReason = reason;
    }

    /**
     * @param {string} [reason]
     * @returns {void}
     */
    resumeGridPersistence(reason: any = null) {
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
    async persistGrid(snapshotOrders: any, recentFillKeys?: any) {
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

        const persisted = await persistGridSnapshot(this, this.accountOrders, snapshotOrders, recentFillKeys);

        if (persisted === false) {
            this.logger.log(
                `[PERSIST] Grid persistence FAILED (disk full / permissions / write error)`,
                'error'
            );
            // Keep the dirty flag set so the next flush retries.
            return { isValid: false, reason: 'persistence write failed', skipped: false, suspended: false };
        }

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
            state: {
                rebalance: { state: this._rebalanceState, currentWorkingGrid: null },
                recovery: { ...this._recoveryStateValue },
                gridRegen: { ...this._gridRegenStateValue },
                bootstrap: { isBootstrapping: this._bootstrapping },
                broadcast: { isBroadcasting: this._broadcastingFlag, startedAt: this._broadcastingStartedAt },
                pipeline: { blockedSince: this._pipelineBlockedSince, recoveryAttempted: this._recoveryAttempted }
            },
            currentTime: Date.now()
        };
    }

    _projectTargetToWorkingGrid(workingGrid: any, targetGrid: any) {
        return projectTargetToWorkingGrid(workingGrid, targetGrid);
    }

    _summarizeCowActions(actions: any) {
        return summarizeActions(actions);
    }

    _evaluateWorkingGridCommit(workingGrid: any, hasLock: any = false) {
        let comparePrecisions;
        try {
            comparePrecisions = this._getCowComparePrecisions();
        } catch (precisionErr: any) {
            return {
                canCommit: false,
                reason: getErrorMessage(precisionErr),
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

    get _lastIllegalState() {
        return this._illegalStateSignal || null;
    }

    set _lastIllegalState(value) {
        if (value) {
            this._illegalStateSignal = {
                ...value,
                at: Date.now()
            };
        }
    }

    get _lastAccountingFailure() {
        return this._accountingFailureSignal || null;
    }

    set _lastAccountingFailure(value) {
        if (value) {
            this._accountingFailureSignal = {
                ...value,
                at: Date.now()
            };
        }
    }

    get _recoveryState() {
        return this._recoveryStateValue;
    }

    set _recoveryState(value) {
        const fallback = {
            phase: 'idle',
            attemptCount: 0,
            lastAttemptAt: 0,
            inFlight: false,
            lastFailureAt: 0,
            structuralResyncRequested: false
        };
        this._recoveryStateValue = {
            ...fallback,
            ...(value && typeof value === 'object' ? value : {})
        };
    }

    get _gridRegenState() {
        return this._gridRegenStateValue;
    }

    set _gridRegenState(value) {
        if (!value || typeof value !== 'object') return;

        const defaultSide = { armed: true, lastTriggeredAt: 0 };
        this._gridRegenStateValue = {
            buy: { ...defaultSide, ...(value.buy || {}) },
            sell: { ...defaultSide, ...(value.sell || {}) }
        };
    }

}

export { OrderManager }

