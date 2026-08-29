/**
 * modules/order/accounting.ts - Accountant Engine
 *
 * Specialized engine for financial state and fund tracking.
 * Responsible for calculating available funds, committed capital, and managing BTS blockchain fees.
 * Exports a single Accountant class that manages all fund accounting operations.
 *
 * ===============================================================================
 * TABLE OF CONTENTS - Accountant Class (18 methods)
 * ===============================================================================
 *
 * CORE INITIALIZATION & RECALCULATION (2 methods)
 *   1. constructor(manager) - Create new Accountant instance
 *   2. resetFunds() - Initialize funds structure with zeroed values
 *
 * MASTER FUND CALCULATIONS (1 method)
 *   3. recalculateFunds() - MASTER FUND CALCULATION: Recalculate all fund values based on order states
 *      Called after any state change. Aggregates committed/available funds and triggers allocation.
 *
 * VERIFICATION & RECOVERY (3 methods - async, internal)
 *   4. _verifyFundInvariants(mgr, chainFreeBuy, chainFreeSell, chainBuy, chainSell, actualBuy, actualSell) - Verify fund tracking invariants
 *   5. _performStateRecovery(mgr) - Centralized state recovery (fetch + sync + validate) (async, internal)
 *   6. _attemptFundRecovery(mgr, violationType) - Attempt immediate recovery from invariant violations (async, internal)
 *
 * CHAINFREE BALANCE MANAGEMENT (2 methods)
 *   7. tryDeductFromChainFree(orderType, size, operation) - Atomically deduct from FREE portion
 *   8. addToChainFree(orderType, size, operation) - Add amount back to optimistic chainFree balance
 *
 * BALANCE ADJUSTMENTS (5 methods)
 *   9. adjustTotalBalance(orderType, delta, operation) - Acquires _fundLock, adjusts total and free balances
 *   10. _adjustTotalBalanceLocked(orderType, delta, operation) - PRIVATE: body of adjustTotalBalance, caller must hold _fundLock
 *   11. _normalizeSideHint(sideHint) - Normalize side hint to standard key (internal)
 *   12. _resolveOrderSide(order, fallbackOrder, explicitSideHint) - Resolve order side (internal)
 *   13. updateOptimisticFreeBalance(oldOrder, newOrder, context, fee, skipAssetAccounting) - Update optimistic balance during transitions
 *
 * FEE MANAGEMENT (2 methods)
 *   14. deductBtsFees(requestedSide) - Deduct BTS fees using adjustTotalBalance with deferral strategy (async)
 *   15. _deductFeesFromProceeds(assetSymbol, rawAmount, isMaker) - Deduct fees from fill proceeds (internal)
 *
 * FILL BALANCE TRACKING (1 method)
 *   16. recordFillBalances(paysAsset, paysAmount, receivesAsset, receivesAmount, context) - Record fill proceeds (async)
 *
 * FILL PROCESSING (1 method)
 *   17. processFillAccounting(fillOp, fillKey, persistenceMode) - Process fund impact of order fill (atomically updates accountTotals)
 *
 * RECOVERY & VALIDATION (1 method)
 *   18. resetRecoveryState() - Reset recovery backoff and state
 *
 * ===============================================================================
 * FUND STRUCTURE (managed by Accountant)
 * ===============================================================================
 *
 * manager.funds = {
 *     available:   { buy, sell }          // Available funds for placement
 *     total:       { chain, grid }        // Total across blockchain + grid
 *     virtual:     { buy, sell }          // Virtual order capital
 *     committed:   { chain, grid }        // Capital locked in active orders
 *     btsFeesOwed: number                 // Unpaid BTS fees
 * }
 *
 * manager.accountTotals = {
 *     buy:      number                   // Total BUY balance on blockchain
 *     sell:     number                   // Total SELL balance on blockchain
 *     buyFree:  number                   // FREE BUY (not in any order)
 *     sellFree: number                   // FREE SELL (not in any order)
 * }
 *
 * ===============================================================================
 *
 * FUND INVARIANTS (verified by _verifyFundInvariants):
 * - blockchainTotal = chainFreeBalance + committedAmount
 * - Virtual orders don't reduce FREE balance
 *
 * ===============================================================================
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { ORDER_TYPES, ORDER_STATES, PIPELINE_TIMING, TIMING, FEE_PARAMETERS, GRID_LIMITS } from '../constants.js';
import { resolveAccountRef } from './utils/system.js';
import { resolveSpreadOrderSide, parseSlotIndex } from './utils/order.js';
import * as Format from './format.js';
import * as fundRegistry from '../fund_registry.js';
import * as chainOrders from '../chain_orders.js';
import { readOpenOrdersGuarded } from '../chain_orders.js';
import {
    calculateAvailableFundsValue,
    getAssetFees,
    blockchainToFloat,
    getPrecisionSlack,
    getBtsSide,
    countGapBandSpread
} from './utils/math.js';
import {
    PROCESSED_FILL_PERSISTENCE_MODES,
    resolveProcessedFillPersistenceMode
} from './processed_fill_store.js';
import { getErrorMessage } from '../utils/errors.js';
const { toFiniteNumber } = Format;

// Warn once per asset instead of once per fill/operation when the fee cache is
// missing, so a cold/absent fee cache does not flood the logs while the bot
// keeps running on fallback fees.
const warnedBtsFeeScheduleFallback = new Set<string>();
const warnedFillFeeSymbols = new Set<string>();

/**
 * Accountant engine - Specialized handler for fund tracking and calculations
 * @class Accountant
 */
class Accountant {
    /**
     * Create a new Accountant instance
     *
     * @param {Object} manager - OrderManager instance
     * @param {Map<string, Object>} manager.orders - Orders map
     * @param {Object} manager.accountTotals - Blockchain account balances
     * @param {Object} manager.funds - Fund tracking structure
     * @param {Logger} manager.logger - Logger instance
     */
    manager: any;
    _isVerifyingInvariants: boolean;
    _pendingInvariantSnapshot: { chainFreeBuy: number; chainFreeSell: number; chainBuy: number; chainSell: number } | null;
    _logThrottleState: Map<string, { lastAt: number; suppressed: number }>;

    constructor(manager: any) {
        this.manager = manager;
        this._isVerifyingInvariants = false;  // Prevents overlapping invariant checks
        this._pendingInvariantSnapshot = null;  // Coalesces latest request while one is running
        this._logThrottleState = new Map();
    }

    _logThrottled(key: any, message: any, level: any = 'warn', intervalMs: any = TIMING.LOG_THROTTLE_INTERVAL_MS) {
        const now = Date.now();
        let state = this._logThrottleState.get(key);

        if (!state || (now - state.lastAt) >= intervalMs) {
            const suffix = state && state.suppressed > 0 ? ` (suppressed ${state.suppressed} repeated log(s))` : '';
            this.manager?.logger?.log?.(`${message}${suffix}`, level);
            this._logThrottleState.set(key, { lastAt: now, suppressed: 0 });
            return true;
        }

        state.suppressed += 1;
        if (state.suppressed > 1_000_000) state.suppressed = 1_000_000;
        return false;
    }

    /**
     * Apply a list of balance adjustments.
     * @param {Array<{orderType: string, delta: number, operation: string}>} balanceAdjustments
     * @returns {void}
     */
    async _applyBalanceAdjustments(balanceAdjustments: any) {
        for (const adjustment of balanceAdjustments) {
            await this.adjustTotalBalance(adjustment.orderType, adjustment.delta, adjustment.operation);
        }
    }

    _getBtsOrderType() {
        return getBtsSide(this.manager.config?.assetA, this.manager.config?.assetB);
    }

    _normalizeBtsFeeState(order: any) {
        const deferredFee = toFiniteNumber(order?.btsFeeState?.deferredFee, 0);
        return {
            deferredFee: Math.max(0, deferredFee)
        };
    }

    _getBtsFeeSchedule() {
        try {
            const fees = getAssetFees('BTS');
            return {
                createFee: Math.max(0, toFiniteNumber(fees?.createFee, 0)),
                updateFee: Math.max(0, toFiniteNumber(fees?.updateFee, 0)),
                cancelFee: Math.max(0, toFiniteNumber(fees?.cancelFee, 0)),
                makerFeeDiscountPercent: Math.max(0, toFiniteNumber(fees?.makerFeeDiscountPercent, this.manager?.config?.feeParams?.MAKER_REFUND_PERCENT ?? FEE_PARAMETERS.MAKER_REFUND_PERCENT))
            };
        } catch (err: any) {
            if (!warnedBtsFeeScheduleFallback.has('BTS')) {
                warnedBtsFeeScheduleFallback.add('BTS');
                this.manager?.logger?.log?.(`[FEE] Failed to load BTS fee schedule: ${err?.message || err}; using fallback defaults`, 'warn');
            }
            return {
                createFee: 0,
                updateFee: 0,
                cancelFee: 0,
                makerFeeDiscountPercent: this.manager?.config?.feeParams?.MAKER_REFUND_PERCENT ?? FEE_PARAMETERS.MAKER_REFUND_PERCENT
            };
        }
    }

    _calculateUpdateDeferredCharge(oldDeferredFee: any, feeSchedule: any) {
        const deferred = Math.max(0, toFiniteNumber(oldDeferredFee, 0));
        const cancelFee = Math.max(0, toFiniteNumber(feeSchedule?.cancelFee, 0));
        const createFee = Math.max(0, toFiniteNumber(feeSchedule?.createFee, 0));
        const updateFee = Math.max(0, toFiniteNumber(feeSchedule?.updateFee, 0));

        if (deferred <= 0 || cancelFee <= 0) return 0;

        // Core's formula (process_deferred_fee market_evaluator.cpp:294-296):
        //   charge = cancel_fee * update_fee / create_fee  (integer division)
        // Cap at deferred_fee. All amounts are already in float BTS units.
        let charge = cancelFee;
        if (createFee > 0) {
            charge = (cancelFee * updateFee) / createFee;
        }
        return Math.min(deferred, Math.max(0, charge));
    }

    _resolveBtsFeeLifecycle(oldOrder: any, newOrder: any, context: any, explicitFee: any) {
        const fee = Math.max(0, toFiniteNumber(explicitFee, 0));
        const oldActive = !!(oldOrder && (oldOrder.state === ORDER_STATES.ACTIVE || oldOrder.state === ORDER_STATES.PARTIAL) && oldOrder.orderId);
        const newActive = !!(newOrder && (newOrder.state === ORDER_STATES.ACTIVE || newOrder.state === ORDER_STATES.PARTIAL) && newOrder.orderId);
        const oldDeferred = this._normalizeBtsFeeState(oldOrder).deferredFee;
        const sameChainOrder = oldActive && newActive && oldOrder.orderId === newOrder.orderId;
        const feeSchedule = this._getBtsFeeSchedule();
        const isFillTransition = typeof context === 'string' && context.startsWith('handle-fill-');

        let balanceDelta = 0;
        let nextDeferred = newActive ? oldDeferred : 0;

        if (!oldActive && newActive && fee > 0) {
            // Core stores limit_order_create fees as deferred_fee on the new order.
            balanceDelta -= fee;
            nextDeferred = fee;
        } else if (oldActive && sameChainOrder && fee > 0) {
            // Core processes the previous deferred fee before deferring the update fee.
            const oldDeferredCharge = this._calculateUpdateDeferredCharge(oldDeferred, feeSchedule);
            balanceDelta += oldDeferred - oldDeferredCharge;
            balanceDelta -= fee;
            nextDeferred = fee;
        } else if (oldActive && isFillTransition) {
            // Core processes deferred fees during fill_order handling, before
            // the in-memory order is resized or removed.
            nextDeferred = 0;
        } else if (oldActive && !newActive && fee > 0) {
            // A real cancel pays the cancel operation fee and refunds the remaining deferred fee.
            // Core caps the cancel fee at deferred_fee (cancel_limit_order db_market.cpp:551-554).
            balanceDelta += Math.max(0, oldDeferred - fee);
            nextDeferred = 0;
        } else if (!newActive) {
            nextDeferred = 0;
        }

        if (newOrder && typeof newOrder === 'object') {
            if (nextDeferred > 0) {
                newOrder.btsFeeState = {
                    ...(newOrder.btsFeeState || {}),
                    deferredFee: nextDeferred
                };
            } else if (newOrder.btsFeeState) {
                // nextDeferred is 0: the deferred fee is consumed on-chain
                // (fill, cancel, or order removed). Core zeros both
                // deferred_fee and deferred_paid_fee on the order at this
                // point, so clear the entire btsFeeState.
                delete newOrder.btsFeeState;
            }
        }

        if (this.manager?.logger?.level === 'debug' && Math.abs(balanceDelta) > 0) {
            this.manager.logger.log(
                `[BTS-FEE] ${context}: oldDeferred=${Format.formatAmount8(oldDeferred)}, fee=${Format.formatAmount8(fee)}, nextDeferred=${Format.formatAmount8(nextDeferred)}, delta=${Format.formatAmount8(balanceDelta)}`,
                'debug'
            );
        }

        return { balanceDelta, nextDeferred };
    }

    _buildBtsDeferredRefundAdjustment(orderId: any, isMaker: any) {
        const btsOrderType = this._getBtsOrderType();
        if (!btsOrderType || !orderId) return null;

        const order = (Array.from(this.manager.orders?.values?.() || []) as any[]).find((o: any) => o?.orderId === orderId);
        const deferredFee = this._normalizeBtsFeeState(order).deferredFee;
        if (deferredFee <= 0) return null;

        const feeSchedule = this._getBtsFeeSchedule();
        if (!isMaker) return null;

        // Core's BSIP85 maker refund: deferred_fee * maker_discount_percent / GRAPHENE_100_PERCENT
        const refund = deferredFee * feeSchedule.makerFeeDiscountPercent;
        if (refund <= 0) return null;

        return {
            orderType: btsOrderType,
            delta: refund,
            operation: 'fill-bts-deferred-fee-refund'
        };
    }

    /**
     * Initialize the funds structure with zeroed values.
     *
     * @returns {void}
     */
    resetFunds() {
        const mgr = this.manager;
        mgr.accountTotals = mgr.accountTotals || (mgr.config.accountTotals ? { ...mgr.config.accountTotals } : { buy: null, sell: null, buyFree: null, sellFree: null });

        mgr.funds = {
            available: { buy: 0, sell: 0 },
            total: { chain: { buy: 0, sell: 0 }, grid: { buy: 0, sell: 0 } },
            virtual: { buy: 0, sell: 0 },
            committed: { chain: { buy: 0, sell: 0 }, grid: { buy: 0, sell: 0 } },
            btsFeesOwed: 0,                        // Unpaid BTS fees
            btsBalance: { free: 0, total: 0, locked: 0 } // BTS balance for non-BTS pairs
        };
    }

    /**
     * Recalculate all fund values based on current order states.
     * This is THE MASTER FUND CALCULATION and must be called after any state change.
     * Called automatically by _updateOrder(), but can be manually triggered to verify consistency.
     *
     * PSEUDOCODE ALGORITHM:
     * =====================
     * 1. Initialize accumulators (gridBuy, gridSell, chainBuy, chainSell, virtualBuy, virtualSell)
     * 2. Classify each order's state (ACTIVE/PARTIAL = on-chain committed, VIRTUAL = pending)
     * 3. Determine side from order.type, or derive from SPREAD price vs startPrice threshold
     * 4. Aggregate sizes by side and state:
     *    - ACTIVE/PARTIAL orders → committed.grid and committed.chain
     *    - VIRTUAL orders → virtual pool
     *    - Skip zero-sized orders
     * 5. Calculate blockchain totals:
     *    - chainTotalBuy = chainFreeBuy (from accountTotals) + chainBuy (committed on-chain)
     *    - chainTotalSell = chainFreeSell + chainSell
     * 6. Calculate available funds by subtracting committed amounts from blockchain totals
     *    - available.buy = chainTotalBuy - committed.chain.buy (after grid allocation)
     *    - available.sell = chainTotalSell - committed.chain.sell (after grid allocation)
     * 7. Apply percentage-based fund allocations (botFunds) if configured
     * 8. Verify fund invariants (total = free + committed) to detect tracking drift
     *
     * CRITICAL INVARIANTS MAINTAINED:
     * - Total on-chain balance = Free portion + Committed portion
     * - Virtual orders don't reduce blockchain-tracked free balance
     * - Grid totals = committed amounts + virtual amounts (pending placements)
     * - Available funds represent true spending power (after commitment deductions)
     *
     * @returns {void}
     */
    async recalculateFunds() {
         const mgr = this.manager;
         if (mgr._pauseFundRecalc > 0) return;
         if (!mgr.funds) {
             // Lazy funds init mutates mgr.funds wholesale, so run it under
             // _fundLock when available (reentrant when the caller already
             // holds it, e.g. manager.recalculateFunds). Guards the direct
             // accountant.recalculateFunds() path against unlocked mutation.
             if (mgr._fundLock) {
                 await mgr._fundLock.acquire(async () => {
                     this.resetFunds();
                 });
             } else {
                 this.resetFunds();
             }
         }

         // Sync btsBalance from manager into funds for non-BTS pairs
         if (mgr.btsBalance) {
             mgr.funds.btsBalance = { ...mgr.funds.btsBalance, ...mgr.btsBalance };
         }

         // No lock needed for read-only access to frozen orders (COW pattern)
         const orderSnapshot = Array.from(mgr.orders.values()) as any[];

         let gridBuy = 0, gridSell = 0;
         let chainBuy = 0, chainSell = 0;
         let virtualBuy = 0, virtualSell = 0;

         // AUTO-SYNC SPREAD COUNT
         // Empty slots are normalized to SPREAD (side-neutral), so a raw
         // SPREAD-type count would include every empty slot on both rails.
         // countGapBandSpread requires both SPREAD type and band geometry —
         // matching initialSpreadCount (gapSlots) set at grid load/creation.
         mgr.currentSpreadCount = countGapBandSpread(mgr, orderSnapshot, (o: any) => parseSlotIndex(o.id));

          // STEP 1-4: Iterate all orders, classify, and aggregate by state
          for (const order of orderSnapshot) {
              const isActive = (order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL) && !!order.orderId;
              const isVirtual = (order.state === ORDER_STATES.VIRTUAL);
             const size = toFiniteNumber(order.size);
             if (size <= 0) continue;

             // SIDE DETERMINATION:
             // - Explicit BUY/SELL: use order.type directly
             // - SPREAD type: derive from price relation to startPrice (market midpoint)
             //   * price < startPrice → BUY side (lower prices are bids)
             //   * price >= startPrice → SELL side (higher prices are asks)
              const isBuy = order.type === ORDER_TYPES.BUY || (order.type === ORDER_TYPES.SPREAD && resolveSpreadOrderSide(order.price, mgr.config.startPrice) === ORDER_TYPES.BUY);
              const isSell = order.type === ORDER_TYPES.SELL || (order.type === ORDER_TYPES.SPREAD && resolveSpreadOrderSide(order.price, mgr.config.startPrice) === ORDER_TYPES.SELL);

             if (isBuy) {
                 if (isActive) {
                     gridBuy += size;
                     chainBuy += size;
                 }
                 if (isVirtual) virtualBuy += size;
             } else if (isSell) {
                 if (isActive) {
                     gridSell += size;
                     chainSell += size;
                 }
                 if (isVirtual) virtualSell += size;
             }
         }

         // STEP 5: Fetch blockchain free balances and compute totals
         const chainFreeBuy = mgr.accountTotals?.buyFree || 0;
         const chainFreeSell = mgr.accountTotals?.sellFree || 0;

         // Store committed amounts (on-chain and in-memory grid)
         mgr.funds.committed.grid = { buy: gridBuy, sell: gridSell };
         mgr.funds.committed.chain = { buy: chainBuy, sell: chainSell };
         mgr.funds.virtual = { buy: virtualBuy, sell: virtualSell };

         // STEP 5: Compute total balances (free + committed)
         // These represent ALL funds we have, regardless of state
         const chainTotalBuy = chainFreeBuy + chainBuy;
         const chainTotalSell = chainFreeSell + chainSell;

         mgr.funds.total.chain = { buy: chainTotalBuy, sell: chainTotalSell };
         mgr.funds.total.grid = { buy: gridBuy + virtualBuy, sell: gridSell + virtualSell };

         // STEP 6: Calculate available funds (what we can spend right now)
          // Uses utils::calculateAvailableFundsValue which deducts committe amounts
          mgr.funds.available.buy = calculateAvailableFundsValue('buy', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders, mgr.config.min_BTS_value, mgr.config?.feeParams ?? null);
          mgr.funds.available.sell = calculateAvailableFundsValue('sell', mgr.accountTotals, mgr.funds, mgr.config.assetA, mgr.config.assetB, mgr.config.activeOrders, mgr.config.min_BTS_value, mgr.config?.feeParams ?? null);

         // Ensure percentage-based allocations are applied to the newly calculated totals
         if (typeof mgr.applyBotFundsAllocation === 'function') {
             mgr.applyBotFundsAllocation();
         }

          if (mgr.logger && mgr.logger.level === 'debug' && mgr._pauseFundRecalc === 0 && !mgr._pauseRecalcLogging) {
              const buyPrecision = mgr.config?.assetB?.precision;
              const sellPrecision = mgr.config?.assetA?.precision;
             if (Number.isFinite(buyPrecision) && Number.isFinite(sellPrecision)) {
                 mgr.logger.log(`[RECALC] BUY: Total=${Format.formatAmountByPrecision(chainTotalBuy, buyPrecision)} (Free=${Format.formatAmountByPrecision(chainFreeBuy, buyPrecision)}, Grid=${Format.formatAmountByPrecision(gridBuy, buyPrecision)})`, 'debug');
                 mgr.logger.log(`[RECALC] SELL: Total=${Format.formatAmountByPrecision(chainTotalSell, sellPrecision)} (Free=${Format.formatAmountByPrecision(chainFreeSell, sellPrecision)}, Grid=${Format.formatAmountByPrecision(gridSell, sellPrecision)})`, 'debug');
             }
         }

        if (mgr._pauseFundRecalc === 0 && !mgr.isBootstrapping() && !mgr.isBroadcastingActive()) {
            const snapshot = { chainFreeBuy, chainFreeSell, chainBuy, chainSell, actualBuy: mgr.accountTotals?.buy, actualSell: mgr.accountTotals?.sell };

            const runVerification = (nextSnapshot: any) => {
                this._isVerifyingInvariants = true;
                this._verifyFundInvariants(
                    mgr,
                    nextSnapshot.chainFreeBuy,
                    nextSnapshot.chainFreeSell,
                    nextSnapshot.chainBuy,
                    nextSnapshot.chainSell,
                    nextSnapshot.actualBuy,
                    nextSnapshot.actualSell
                )
                    .catch((err: any) => {
                        mgr.logger?.log?.(`[RECOVERY] Verification error: ${getErrorMessage(err)}`, 'error');
                    })
                    .finally(() => {
                        this._isVerifyingInvariants = false;
                        if (this._pendingInvariantSnapshot) {
                            const pending = this._pendingInvariantSnapshot;
                            this._pendingInvariantSnapshot = null;
                            runVerification(pending);
                        }
                    });
            };

            // Deliberate: only the last pending snapshot runs. Intermediate snapshots
            // that self-correct within consecutive recalc calls are transient fluctuations,
            // not systemic drift. Running all snapshots in sequence would queue unboundedly.
            if (this._isVerifyingInvariants) {
                this._pendingInvariantSnapshot = snapshot;
            } else {
                runVerification(snapshot);
            }
        }
    }

     /**
      * Verify critical fund tracking invariants.
      *
      * Checks that accountTotals.buy/sell match chainFree + committed amounts
      * within combined precision and percentage tolerances. Detects fee double-
      * deductions, missing fills, and blockchain state desync.
      *
      * @param {Object} mgr - OrderManager instance
      * @param {number} chainFreeBuy - Free (unallocated) buy-side balance from chain
      * @param {number} chainFreeSell - Free (unallocated) sell-side balance from chain
      * @param {number} chainBuy - Committed buy-side balance from chain
      * @param {number} chainSell - Committed sell-side balance from chain
      * @returns {void}
      * @private
      */
      async _verifyFundInvariants(mgr: any, chainFreeBuy: any, chainFreeSell: any, chainBuy: any, chainSell: any, actualBuy: any, actualSell: any) {
          // Half-baked guard: while a fill batch is mid-accounting, the balance
          // snapshot may already reflect the just-filled orders on-chain while
          // the grid still counts them as committed (or the reverse during
          // optimistic fill adjustments). Running Total = Free + Committed in
          // that window produces a spurious CRITICAL equal to the batch size.
          // The check is deferred until the batch settles (grid mutation +
          // authoritative re-anchor) and is re-run by the resume recalculation.
          if ((mgr._fillBatchInFlight ?? 0) > 0) {
              if (mgr.logger?.level === 'debug') {
                  mgr.logger.log('[INVARIANT] Fill batch in flight; deferring fund-invariant check until batch settles.', 'debug');
              }
              return;
          }
          const buyPrecision = mgr.assets?.assetB?.precision;
          const sellPrecision = mgr.assets?.assetA?.precision;
          if (!Number.isFinite(buyPrecision) || !Number.isFinite(sellPrecision)) {
              return;  // Skip invariant check if precision not available
          }
          const precisionSlackBuy = getPrecisionSlack(buyPrecision);
         const precisionSlackSell = getPrecisionSlack(sellPrecision);
          const PERCENT_TOLERANCE = (mgr.config?.gridLimits?.FUND_INVARIANT_PERCENT_TOLERANCE ?? GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE) / 100;

         // FIX 5: Widen tolerance when orphan fills were recently credited.
         // Orphan fill accounting adjusts mgr.accountTotals optimistically, but
          // chainFree (sellFree/buyFree) from the last fetchAccountTotals call
          // may not yet reflect the proceeds. Widen tolerance to prevent false-
          // positive violations that trigger unproductive recovery cycles.
          // The timestamp is set at orphan-fill credit time and cleared by
          // _performStateRecovery (after a fresh chain fetch) or at the start
          // of the next fill cycle (_orphanFillsCreditedAt = null). It is NOT
          // consumed by this check — the widened tolerance persists through the
          // entire fill cycle so that multiple recalculateFunds calls within
          // the same cycle all see consistent tolerance.
          const orphanFillsAt = mgr._orphanFillsCreditedAt;
          const orphanToleranceMultiplier = (orphanFillsAt != null) ? 5 : 1;
         const effectivePercentTolerance = PERCENT_TOLERANCE * orphanToleranceMultiplier;

         let hasViolation = false;

         // INVARIANT 1: Drift detection
         // FORMULA: expectedBuy = chainFreeBuy + chainBuy (what we think we have)
         //          actualBuy = mgr.accountTotals.buy (what blockchain says)
         //          If |actualBuy - expectedBuy| > tolerance → fund tracking corruption detected
        const expectedBuy = chainFreeBuy + chainBuy;
        const diffBuy = Math.abs((actualBuy ?? expectedBuy) - expectedBuy);
         const allowedBuyTolerance = Math.max(precisionSlackBuy, (actualBuy || expectedBuy) * effectivePercentTolerance);

        if (actualBuy !== null && actualBuy !== undefined && diffBuy > allowedBuyTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR instead of WARN
            // Invariant violations indicate serious fund tracking corruption and must not be silent
            // This triggers immediate recovery attempt
            this._logThrottled(
                'fund-invariant-buy',
                `CRITICAL: Fund invariant violation (BUY): blockchainTotal (${Format.formatAmountByPrecision(actualBuy, buyPrecision)}) != trackedTotal (${Format.formatAmountByPrecision(expectedBuy, buyPrecision)}) (diff: ${Format.formatAmountByPrecision(diffBuy, buyPrecision)}, allowed: ${Format.formatAmountByPrecision(allowedBuyTolerance, buyPrecision)}${orphanFillsAt != null ? ', orphan-fill buffer active' : ''})`,
                orphanFillsAt != null ? 'warn' : 'error'
            );
        }

        const expectedSell = chainFreeSell + chainSell;
        const diffSell = Math.abs((actualSell ?? expectedSell) - expectedSell);
        const allowedSellTolerance = Math.max(precisionSlackSell, (actualSell || expectedSell) * effectivePercentTolerance);

        if (actualSell !== null && actualSell !== undefined && diffSell > allowedSellTolerance) {
            hasViolation = true;
            // CRITICAL FIX: Log as ERROR instead of WARN
            this._logThrottled(
                'fund-invariant-sell',
                `CRITICAL: Fund invariant violation (SELL): blockchainTotal (${Format.formatAmountByPrecision(actualSell, sellPrecision)}) != trackedTotal (${Format.formatAmountByPrecision(expectedSell, sellPrecision)}) (diff: ${Format.formatAmountByPrecision(diffSell, sellPrecision)}, allowed: ${Format.formatAmountByPrecision(allowedSellTolerance, sellPrecision)}${orphanFillsAt != null ? ', orphan-fill buffer active' : ''})`,
                orphanFillsAt != null ? 'warn' : 'error'
            );
        }

        // INVARIANT 3: Cross-bot registry invariant (shared accounts)
        // Checks that this bot's committed ≤ expected proportional share, with
        // a wider tolerance than per-bot invariant to accommodate transient
        // over-allocation during mid-flight rebalances.
        if (mgr.config?.preferredAccount && mgr.config.botKey) {
            try {
                const account = mgr.config.preferredAccount;
                const botName = mgr.config.botKey;
                const registeredBots = fundRegistry.getRegisteredBots(account);
                if (registeredBots.length > 1) {
                    const crossBotTolerance = Math.max(PERCENT_TOLERANCE * 3, 0.15);
                    const totalBuyPct = fundRegistry.getTotalAllocatedPct(account, 'buy');
                    const totalSellPct = fundRegistry.getTotalAllocatedPct(account, 'sell');
                    const myBuyPct = fundRegistry.getBotAllocationPct(account, botName, 'buy');
                    const mySellPct = fundRegistry.getBotAllocationPct(account, botName, 'sell');

                    if (myBuyPct !== null && totalBuyPct > 0) {
                        const proportionalBuy = (chainFreeBuy + chainBuy) * (myBuyPct / totalBuyPct);
                        const committedBuy = mgr.funds?.committed?.chain?.buy || 0;
                        const maxAllowedBuy = proportionalBuy * (1 + crossBotTolerance);
                        if (committedBuy > maxAllowedBuy && proportionalBuy > precisionSlackBuy) {
                            hasViolation = true;
                            this._logThrottled(
                                'fund-invariant-crossbot-buy',
                                `[SHARED ACCOUNT] BUY over-allocation: committed=${Format.formatAmountByPrecision(committedBuy, buyPrecision)}, ` +
                                `proportionalShare=${Format.formatAmountByPrecision(proportionalBuy, buyPrecision)} ` +
                                `(myPct=${(myBuyPct * 100).toFixed(1)}%, totalPct=${(totalBuyPct * 100).toFixed(1)}%)`,
                                'error'
                            );
                        }
                    }

                    if (mySellPct !== null && totalSellPct > 0) {
                        const proportionalSell = (chainFreeSell + chainSell) * (mySellPct / totalSellPct);
                        const committedSell = mgr.funds?.committed?.chain?.sell || 0;
                        const maxAllowedSell = proportionalSell * (1 + crossBotTolerance);
                        if (committedSell > maxAllowedSell && proportionalSell > precisionSlackSell) {
                            hasViolation = true;
                            this._logThrottled(
                                'fund-invariant-crossbot-sell',
                                `[SHARED ACCOUNT] SELL over-allocation: committed=${Format.formatAmountByPrecision(committedSell, sellPrecision)}, ` +
                                `proportionalShare=${Format.formatAmountByPrecision(proportionalSell, sellPrecision)} ` +
                                `(myPct=${(mySellPct * 100).toFixed(1)}%, totalPct=${(totalSellPct * 100).toFixed(1)}%)`,
                                'error'
                            );
                        }
                    }
                }
            } catch (_err: any) {
                mgr.logger?.log?.(`[INVARIANT] Cross-bot registry check skipped: ${getErrorMessage(_err)}`, 'warn');
            }
        }

        // NEW: Attempt immediate recovery if violation detected
        if (hasViolation) {
            const doRecovery = async () => {
                try {
                    await this._attemptFundRecovery(mgr, 'Fund invariant violation');
                } catch (err: any) {
                    mgr.logger?.log?.(`[RECOVERY] Deferred recovery failed: ${getErrorMessage(err)}`, 'error');
                    mgr._recoveryState = { ...mgr._recoveryState, lastFailureAt: Date.now() };
                }
            };
            if (mgr._gridLock?.isLocked?.()) {
                doRecovery().catch((err: any) => {
                    mgr.logger?.log?.(`[RECOVERY] Deferred recovery scheduling failed: ${getErrorMessage(err)}`, 'error');
                });
            } else {
                await doRecovery();
            }
        }
    }

    /**
     * Perform centralized state recovery (fetch + sync + validate).
     * Shared by both immediate recovery and stabilization gate.
     *
     * @param {Object} mgr - Manager instance
     * @returns {Promise<Object>} - Validation result from validateGridStateForPersistence()
     */
    async _performStateRecovery(mgr: any) {
        const accountRef = resolveAccountRef(mgr, '');
        if (!accountRef) {
            return {
                isValid: false,
                reason: 'Recovery skipped: missing account context (accountId/account)'
            };
        }

        // 1. Fetch fresh blockchain state
        await mgr.fetchAccountTotals(accountRef);
        // After a fresh chain fetch, reset the orphan-fill credit
        // timestamp. The fetched values now incorporate on-chain fill
        // proceeds, so the temporary invariant tolerance is no longer needed.
        mgr._orphanFillsCreditedAt = null;

        // 2. Sync from open orders
        // An empty/truncated read is ambiguous — the account is either genuinely
        // empty or the node is lagging/capped (fresh orders omitted). Running
        // syncFromOpenOrders on it would let pass-1 phantom cleanup virtualize
        // ACTIVE/PARTIAL slots that are live on chain, after which the next
        // cycle re-creates them as duplicates. Skip the sync and defer to the
        // next reconcile cycle, mirroring the other recovery-read guards.
        const openOrders = await readOpenOrdersGuarded(chainOrders, accountRef, {
            log: (message: string, level: any) => mgr.logger?.log?.(message, level),
            label: 'RECOVERY',
            detail: 'during state recovery',
            deferEmpty: true,
        });
        if (openOrders === null) {
            return {
                isValid: false,
                deferred: true,
                reason: 'Recovery sync skipped: ambiguous chain read (truncated or empty) - node may be lagging; deferring to next reconcile cycle',
            };
        }
        // Recovery runs after fetchAccountTotals() has refreshed authoritative balances
        // from chain. During this pass we only want to reconcile grid structure/order
        // mapping against open orders; re-applying optimistic accounting deltas here
        // double-counts commitment changes and can amplify invariant drift.
        const syncResult = await mgr.syncFromOpenOrders(openOrders, { skipAccounting: true });
        const unmatchedChainOrders = Array.isArray(syncResult?.unmatchedChainOrders)
            ? syncResult.unmatchedChainOrders
            : [];

        // 3. Validate recovery. Persistence validation catches structural
        // corruption; drift validation catches accounting mismatches that are
        // otherwise masked while bootstrap suppression is active.
        const persistenceValidation = mgr.validateGridStateForPersistence({ allowBootstrapTransient: false });
        if (!persistenceValidation.isValid) {
            if (unmatchedChainOrders.length > 0) {
                return {
                    ...persistenceValidation,
                    structuralGridResyncRequired: true,
                    unmatchedChainOrders,
                    reason: `${persistenceValidation.reason}; ${unmatchedChainOrders.length} unmatched chain order(s) require structural grid resync`
                };
            }
            return persistenceValidation;
        }

        if (typeof mgr.checkFundDriftAfterFills === 'function') {
            const driftValidation = mgr.checkFundDriftAfterFills();
            if (driftValidation && driftValidation.isValid === false) {
                if (unmatchedChainOrders.length > 0) {
                    return {
                        ...driftValidation,
                        structuralGridResyncRequired: true,
                        unmatchedChainOrders,
                        reason: `${driftValidation.reason}; ${unmatchedChainOrders.length} unmatched chain order(s) require structural grid resync`
                    };
                }
                return driftValidation;
            }
        }

        return persistenceValidation;
    }

      /**
       * Attempt immediate recovery from fund invariant violations.
       * Runs once per cycle - subsequent violations in same cycle are skipped.
       *
       * @param {Object} mgr - Manager instance
       * @param {string} violationType - Description of the violation for logging
       * @returns {Promise<boolean>} - True if recovery succeeded, false otherwise
       */
    async _attemptFundRecovery(mgr: any, violationType: any) {
          if (!mgr._recoveryState || typeof mgr._recoveryState !== 'object') {
              mgr._recoveryState = { attemptCount: 0, lastAttemptAt: 0, inFlight: false, lastFailureAt: 0, structuralResyncRequested: false };
          }

          const pt = mgr.config?.pipelineTiming || PIPELINE_TIMING;
          const state = mgr._recoveryState;
          const now = Date.now();
          const retryIntervalMs = Math.max(0, Number(pt.RECOVERY_RETRY_INTERVAL_MS));
          const maxAttemptsRaw = Number(pt.MAX_RECOVERY_ATTEMPTS);
          const hasAttemptLimit = Number.isFinite(maxAttemptsRaw) && maxAttemptsRaw > 0;

          if (state.inFlight) {
              mgr.logger?.log?.('[RECOVERY] Skipping recovery: attempt already in flight', 'debug');
              return false;
          }

          // Decay: if enough time has passed since the last failure, treat this
          // as a fresh violation cycle to prevent stale counts from a previous
          // cycle permanently exhausting the attempt budget.
          const decayMs = retryIntervalMs > 0 ? retryIntervalMs * 3 : (pt.RECOVERY_DECAY_FALLBACK_MS ?? PIPELINE_TIMING.RECOVERY_DECAY_FALLBACK_MS);
          if (state.attemptCount > 0 && state.lastFailureAt > 0 && (now - state.lastFailureAt) > decayMs) {
              // Log at 'info' level so operators can monitor for repeated decay patterns
              // which may indicate a persistent issue that self-corrects just long enough
              // to trigger decay, then recurs. Pattern: repeated "decayed" messages.
              mgr.logger?.log?.(
                  `[RECOVERY] Attempt count decayed (${state.attemptCount} -> 0) after ${Math.round((now - state.lastFailureAt) / TIMING.MILLISECONDS_PER_SECOND)}s idle`,
                  'info'
              );
              state.attemptCount = 0;
              state.lastFailureAt = 0;
          }

          if (hasAttemptLimit && state.attemptCount >= maxAttemptsRaw) {
              this._logThrottled(
                  'recovery-max-attempts',
                  `[RECOVERY] Max attempts reached (${state.attemptCount}/${maxAttemptsRaw}). ` +
                  `Entering idle-only mode — no new orders will be placed until next fill or sync cycle.`,
                  'warn'
              );
              // Gap 5: Set exhausted mode to block further CREATEs until the next
              // fill or blockchain fetch resets the recovery state. This prevents the
              // bot from spinning unproductively and generating more orphan orders.
              if (mgr && !mgr._recoveryExhaustedAt) {
                  mgr._recoveryExhaustedAt = Date.now();
                  if (mgr.logger) {
                      mgr.logger.log(
                          '[RECOVERY-EXHAUSTED] Recovery attempts exhausted. Bot will stop placing new orders ' +
                          'until the next fill or periodic sync cycle. Existing orders remain active and will ' +
                          'continue to be monitored. Manual intervention may be required if this state persists.',
                          'error'
                      );
                  }
              }
              return false;
          }

          if (state.attemptCount > 0 && retryIntervalMs > 0) {
              const elapsed = now - state.lastAttemptAt;
              if (elapsed < retryIntervalMs) {
                  mgr.logger?.log?.(
                      `[RECOVERY] Cooldown active (${elapsed}ms/${retryIntervalMs}ms). Skipping retry.`,
                      'debug'
                  );
                  return false;
              }
          }

          state.inFlight = true;
          state.attemptCount += 1;
          state.lastAttemptAt = now;
          mgr._recoveryAttempted = true;
          mgr.logger?.log?.(
              `[RECOVERY] ${violationType} - attempting state recovery (attempt ${state.attemptCount}${hasAttemptLimit ? `/${maxAttemptsRaw}` : ''})...`,
              'warn'
          );

          try {
              const validation = await this._performStateRecovery(mgr);

              if (validation?.deferred) {
                  // Ambiguous (empty/truncated) chain read: the recovery was
                  // DEFERRED, not failed. Roll back the attempt increment so an
                  // ambiguous snapshot can never burn the attempt budget toward
                  // MAX_RECOVERY_ATTEMPTS (which blocks all CREATEs until the
                  // next fill/sync cycle), and skip the structural resync — a
                  // full grid reset driven by an ambiguous read would
                  // virtualize live slots via pass-1 phantom cleanup.
                  state.attemptCount = Math.max(0, state.attemptCount - 1);
                  state.lastFailureAt = 0;
                  mgr.logger?.log?.(
                      `[RECOVERY] State recovery deferred (${validation.reason}); attempt not counted`,
                      'warn'
                  );
                  return false;
              }

              if (validation.isValid) {
                  mgr.logger?.log?.('[RECOVERY] State recovery succeeded', 'info');
                  state.structuralResyncRequested = false;
                  // NOTE: Do NOT reset attemptCount here. The fund invariant check will
                  // run again after recovery returns. If the invariant is still violated,
                  // we want the counter to increment properly (2/5, 3/5, etc.) rather
                  // than resetting to 1/5 each time. The decay logic (line ~402) will
                  // reset the counter if enough time passes without violations.
                  return true;
              }

              state.lastFailureAt = Date.now();
              if (validation.structuralGridResyncRequired && typeof mgr.requestStructuralGridResync === 'function') {
                  const unmatchedCount = Array.isArray(validation.unmatchedChainOrders)
                      ? validation.unmatchedChainOrders.length
                      : 0;
                  if (!state.structuralResyncRequested) {
                      state.structuralResyncRequested = true;
                      mgr.logger?.log?.(
                          `[RECOVERY] Structural drift detected (${unmatchedCount} unmatched chain order(s)); scheduling full grid resync.`,
                          'warn'
                      );
                      Promise.resolve()
                          .then(async () => {
                              const scheduleResult = await mgr.requestStructuralGridResync('fund invariant structural drift', {
                                  unmatchedChainOrders: validation.unmatchedChainOrders || [],
                                  source: 'fund-invariant-recovery'
                              });
                              if (scheduleResult?.skipped) {
                                  state.structuralResyncRequested = false;
                                  mgr.logger?.log?.(
                                      `[RECOVERY] Structural grid resync not scheduled: ${scheduleResult.reason || 'request skipped'}`,
                                      'warn'
                                  );
                              }
                          })
                          .catch((err: any) => {
                              state.structuralResyncRequested = false;
                              mgr.logger?.log?.(`[RECOVERY] Structural grid resync scheduling failed: ${getErrorMessage(err)}`, 'error');
                          });
                  } else {
                      this._logThrottled(
                          'structural-resync-already-requested',
                          '[RECOVERY] Structural grid resync already scheduled; suppressing duplicate request.',
                          'warn'
                      );
                  }
              }
              const level = validation.reason.includes('missing account context') ? 'warn' : 'error';
              mgr.logger?.log?.(`[RECOVERY] State recovery failed: ${validation.reason}`, level);
              return false;
          } catch (err: any) {
              state.lastFailureAt = Date.now();
              mgr.logger?.log?.(`[RECOVERY] State recovery error: ${getErrorMessage(err)}`, 'error');
              return false;
          } finally {
              state.inFlight = false;
              mgr._recoveryAttempted = false;
          }
      }

      /**
       * Reset the recovery attempt flag.
       * Called at the start of each fill processing cycle to allow fresh recovery attempts.
       * @returns {void}
       */
        resetRecoveryState() {
             if (!this.manager) return;
             this.manager._recoveryAttempted = false;
             this.manager._recoveryState = {
                 attemptCount: 0,
                 lastAttemptAt: 0,
                 inFlight: false,
                 lastFailureAt: 0,
                 structuralResyncRequested: false
             };
             // Gap 5: Clear exhausted flag so the bot can attempt new CREATEs
             // on the next fill or periodic sync cycle.
             this.manager._recoveryExhaustedAt = null;
         }

    /**
     * Check if sufficient funds exist AND atomically deduct (FREE portion only).
     * PRIVATE: Must be called while holding _fundLock.
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {number} size - Amount to deduct from chainFree
     * @param {string} [operation='move'] - Label for logging
     * @returns {Promise<{ok: boolean, reason?: string}>} {ok: true} on success, {ok: false, reason} on failure
     */
    async tryDeductFromChainFree(orderType: any, size: any, operation: any = 'move') {
         const mgr = this.manager;
         const isBuy = orderType === ORDER_TYPES.BUY;
         const key = isBuy ? 'buyFree' : 'sellFree';

          if (!mgr.accountTotals || mgr.accountTotals[key] === undefined) {
              return { ok: false, reason: 'undefined' };
          }

          // Stale-fetch guard: if accountTotals was fetched too long ago, refuse
          // optimistic deduction and force the caller to re-fetch. This prevents
          // optimistic balance drift from diverging too far from chain reality
          // between periodic blockchain fetches.
          const MAX_ACCOUNT_TOTALS_AGE_MS = require('../constants').TIMING.MAX_ACCOUNT_TOTALS_AGE_MS;
          const lastFetched = mgr.accountTotals._lastFetchedAt || 0;
          if (Date.now() - lastFetched > MAX_ACCOUNT_TOTALS_AGE_MS) {
              mgr.logger.log(
                  `[chainFree] ${orderType} ${operation}: STALE accountTotals (age=${Date.now() - lastFetched}ms > ${MAX_ACCOUNT_TOTALS_AGE_MS}ms). ` +
                  `Skipping optimistic deduction; caller should re-fetch.`,
                  'warn'
              );
              return { ok: false, reason: 'stale' };
          }

          const current = toFiniteNumber(mgr.accountTotals[key]);
         if (current < size) {
             mgr.logger.log(`[chainFree] ${orderType} ${operation}: INSUFFICIENT FUNDS (have ${Format.formatAmount8(current)}, need ${Format.formatAmount8(size)})`, 'warn');
             return { ok: false, reason: 'insufficient' };
         }

         const oldValue = mgr.accountTotals[key];
         mgr.accountTotals[key] = Math.max(0, current - size);

         if (mgr.logger && mgr.logger.level === 'debug') {
             mgr.logger.log(`[ACCOUNTING] ${key} -${Format.formatAmount8(size)} (${operation}) -> ${Format.formatAmount8(mgr.accountTotals[key])} (was ${Format.formatAmount8(oldValue)})`, 'debug');
         }
         return { ok: true };
    }

    /**
     * Add an amount back to the optimistic chainFree balance (FREE portion only).
     * PRIVATE: Must be called while holding _fundLock.
     * @param {string} orderType - ORDER_TYPES.BUY or ORDER_TYPES.SELL
     * @param {number} size - Amount to add to chainFree
     * @param {string} [operation='release'] - Label for logging
     * @returns {Promise<boolean>} true if addition succeeded
     */
    async addToChainFree(orderType: any, size: any, operation: any = 'release') {
         const mgr = this.manager;
         const isBuy = orderType === ORDER_TYPES.BUY;
         const key = isBuy ? 'buyFree' : 'sellFree';

         if (!mgr.accountTotals || mgr.accountTotals[key] === undefined) return false;

         const oldFree = toFiniteNumber(mgr.accountTotals[key]);
         mgr.accountTotals[key] = oldFree + size;

         if (mgr.logger && mgr.logger.level === 'debug') {
             mgr.logger.log(`[ACCOUNTING] ${key} +${Format.formatAmount8(size)} (${operation}) -> ${Format.formatAmount8(mgr.accountTotals[key])} (was ${Format.formatAmount8(oldFree)})`, 'debug');
          }
          return true;
    }

    /**
     * Record a fill in the optimistic total balances.
     * PUBLIC API: Acquires _fundLock.
     * @param {string} paysAsset - Asset symbol or ID the bot paid
     * @param {number} paysAmount - Amount the bot paid
     * @param {string} receivesAsset - Asset symbol or ID the bot received
     * @param {number} receivesAmount - Amount the bot received
     * @param {string} [context='fill'] - Label for logging
     * @returns {Promise<void>}
     */
    async recordFillBalances(paysAsset: any, paysAmount: any, _receivesAsset: any, receivesAmount: any, context: any = 'fill') {
        return await this.manager._fundLock.acquire(async () => {
            const mgr = this.manager;
            const assetA = mgr.config.assetA;

            // Determine orientation
            if (paysAsset === assetA) {
                // Bot paid assetA (Selling assetA, buying assetB)
                this._adjustTotalBalanceLocked(ORDER_TYPES.SELL, -paysAmount, `${context}-pays`);
                this._adjustTotalBalanceLocked(ORDER_TYPES.BUY, receivesAmount, `${context}-receives`);
            } else {
                // Bot paid assetB (Buying assetA, selling assetB)
                this._adjustTotalBalanceLocked(ORDER_TYPES.BUY, -paysAmount, `${context}-pays`);
                this._adjustTotalBalanceLocked(ORDER_TYPES.SELL, receivesAmount, `${context}-receives`);
            }
        });
    }


    /**
     * PRIVATE: Must be called while holding _fundLock.
     * Body of adjustTotalBalance; takes the lock externally for clean
     * nesting in callers that already hold the lock (e.g. recordFillBalances).
     */
    _adjustTotalBalanceLocked(orderType: any, delta: any, operation: any) {
        const mgr = this.manager;
        const isBuy = (orderType === ORDER_TYPES.BUY);
        const freeKey = isBuy ? 'buyFree' : 'sellFree';
        const totalKey = isBuy ? 'buy' : 'sell';

        if (!mgr.accountTotals) return;

        const oldFree = toFiniteNumber(mgr.accountTotals[freeKey]);
        // IMPORTANT: No clamping to 0 here. Allowing temporary negative Free balance
        // ensures the invariant Total = Free + Committed remains stable during
        // the short race between Fill detection and Order state update.
        mgr.accountTotals[freeKey] = oldFree + delta;

        if (mgr.accountTotals[totalKey] !== undefined && mgr.accountTotals[totalKey] !== null) {
            const oldTotal = toFiniteNumber(mgr.accountTotals[totalKey]);
            mgr.accountTotals[totalKey] = Math.max(0, oldTotal + delta);
        }

        if (mgr.logger && mgr.logger.level === 'debug') {
            mgr.logger.log(`[ACCOUNTING] ${totalKey} ${delta >= 0 ? '+' : ''}${Format.formatAmount8(delta)} (${operation}) -> Total: ${Format.formatAmount8(mgr.accountTotals[totalKey])}, Free: ${Format.formatAmount8(mgr.accountTotals[freeKey])}`, 'debug');
        }
    }

    /**
     * PUBLIC API: Acquires _fundLock.
     * Adjust both total and free balances (for fills, fees, deposits).
     * @returns {Promise<void>}
     */
    async adjustTotalBalance(orderType: any, delta: any, operation: any) {
        await this.manager._fundLock.acquire(async () => {
            this._adjustTotalBalanceLocked(orderType, delta, operation);
        });
    }

    /**
     * Normalize side hint to standard ORDER_TYPES constant.
     * @param {string|null} sideHint - Side hint ('buy', 'sell', ORDER_TYPES.BUY, ORDER_TYPES.SELL, or null)
     * @returns {string|null} Normalized side or null if unrecognised
     */
    _normalizeSideHint(sideHint: any) {
        if (sideHint === ORDER_TYPES.BUY || sideHint === 'buy') return ORDER_TYPES.BUY;
        if (sideHint === ORDER_TYPES.SELL || sideHint === 'sell') return ORDER_TYPES.SELL;
        return null;
    }

    /**
     * Resolve the effective order side from multiple sources of truth.
     * @param {Object|null} order - Order object carrying optional side hints
     * @param {Object|null} [fallbackOrder] - Fallback order object
     * @param {string|null} [explicitSideHint] - Explicit side override
     * @returns {string|null} Resolved side (ORDER_TYPES.BUY, ORDER_TYPES.SELL) or null
     */
    _resolveOrderSide(order: any, fallbackOrder: any = null, explicitSideHint: any = null) {
        const fromHint = this._normalizeSideHint(explicitSideHint);
        if (fromHint) return fromHint;

        // Prefer explicit order type over carried metadata.
        // committedSide/sideHint can be stale during boundary flips, but type is the
        // authoritative current side for BUY/SELL commitments.
        const fromOrderType = this._normalizeSideHint(order?.type);
        if (fromOrderType) return fromOrderType;

        const fromFallbackType = this._normalizeSideHint(fallbackOrder?.type);
        if (fromFallbackType) return fromFallbackType;

        const candidates = [
            order?.sideHint,
            order?.committedSide,
            fallbackOrder?.sideHint,
            fallbackOrder?.committedSide
        ];

        for (const candidate of candidates) {
            const normalized = this._normalizeSideHint(candidate);
            if (normalized) return normalized;
        }

        return null;
    }

    /**
     * Update optimistic balance during transitions.
     * @param {Object} oldOrder - Previous order state
     * @param {Object} newOrder - New order state
     * @param {string} context - Context for logging/tracking
     * @param {number} fee - Blockchain fee to deduct
     * @param {boolean} skipAssetAccounting - If true, skip capital commitment changes (asset amounts) but still process fees
     */
    async updateOptimisticFreeBalance(oldOrder: any, newOrder: any, context: any, fee: any = 0, skipAssetAccounting: any = false) {
        const mgr = this.manager;
        if (!oldOrder || !newOrder) return;

        // If this transition will LOCK capital, ensure a fresh accountTotals snapshot
        // BEFORE acquiring _fundLock. The refresh is a live chain RPC (30s timeout,
        // 3 retries, then node failover) — running it while holding _fundLock would
        // stall every other fund-critical waiter (deductBtsFees, setAccountTotals,
        // persistGrid) and, past the 30s acquire timeout, force them to throw instead
        // of deferring. Only the plain mutation runs under the lock.
        let preLockRefreshFailed = false;
        if (!skipAssetAccounting) {
            const oldIsActive = (oldOrder.state === ORDER_STATES.ACTIVE || oldOrder.state === ORDER_STATES.PARTIAL);
            const newIsActive = (newOrder.state === ORDER_STATES.ACTIVE || newOrder.state === ORDER_STATES.PARTIAL);
            const willLock = (newIsActive ? toFiniteNumber(newOrder.size) : 0) - (oldIsActive ? toFiniteNumber(oldOrder.size) : 0) > 0;
            if (willLock) {
                try {
                    const pre = await mgr.refreshAccountTotalsIfStale();
                    preLockRefreshFailed = !pre.ok;
                } catch (err: any) {
                    preLockRefreshFailed = true;
                    mgr.logger?.log?.(`[ACCOUNTING] pre-lock accountTotals refresh error: ${getErrorMessage(err)}`, 'warn');
                }
            }
        }

        return await mgr._fundLock.acquire(async () => {
            // Ensure a copy: _resolveBtsFeeLifecycle mutates btsFeeState on
            // newOrder (line 230), but the caller may pass a frozen master-grid order.
            if (Object.isFrozen(newOrder)) {
                newOrder = { ...newOrder };
            }

            if (!skipAssetAccounting) {
                const oldIsActive = (oldOrder.state === ORDER_STATES.ACTIVE || oldOrder.state === ORDER_STATES.PARTIAL);
                const newIsActive = (newOrder.state === ORDER_STATES.ACTIVE || newOrder.state === ORDER_STATES.PARTIAL);
                const oldSize = toFiniteNumber(oldOrder.size);
                const newSize = toFiniteNumber(newOrder.size);

                // 1. Handle Capital Commitment (Moves between FREE and LOCKED)
                // For COMMITMENT: Use GRID state (isActive), not blockchain ID
                const oldGridCommitted = oldIsActive ? oldSize : 0;
                const newGridCommitted = newIsActive ? newSize : 0;
                const commitmentDelta = newGridCommitted - oldGridCommitted;
                const newSideType = this._resolveOrderSide(newOrder, oldOrder);
                const oldSideType = this._resolveOrderSide(oldOrder, newOrder);
                const sideForPrecision = newSideType || oldSideType;

                if (mgr.logger && mgr.logger.level === 'debug') {
                    mgr.logger.log(
                        `[ACCOUNTING] updateOptimisticFreeBalance: id=${newOrder.id}, type=${newOrder.type}, ` +
                        `state=${oldOrder.state}->${newOrder.state}, ` +
                        `size=${Format.formatSizeByOrderType(oldSize, sideForPrecision ?? '', mgr.assets)}->${Format.formatSizeByOrderType(newSize, sideForPrecision ?? '', mgr.assets)}, ` +
                        `delta=${Format.formatSizeByOrderType(commitmentDelta, sideForPrecision ?? '', mgr.assets)}, context=${context}`,
                        'debug'
                    );
                }

                if (commitmentDelta > 0) {
                    // Lock capital: move from Free to Committed
                    const commitmentSide = newSideType || newOrder.type;
                    let result = await this.tryDeductFromChainFree(commitmentSide, commitmentDelta, `${context}`);

                    // Fix staleness in the first place: a stale snapshot refused
                    // the lock. When the pre-lock refresh was skipped (not needed)
                    // or is in flight and this deduction still races a fresh window,
                    // refresh accountTotals from chain and retry once. But if the
                    // pre-lock refresh already FAILED, the chain is unhealthy — do
                    // NOT re-run the 30s/3-retry/node-failover RPC while holding
                    // _fundLock (that would stall every other fund-critical waiter
                    // exactly like the regression this rework eliminated). Fall
                    // through to the failure/recovery path below instead.
                    if (!result.ok && result.reason === 'stale' && !preLockRefreshFailed) {
                        mgr.logger?.log?.(
                            `[ACCOUNTING] Stale accountTotals during ${context}; refreshing from chain before retrying optimistic lock.`,
                            'warn'
                        );
                        const refresh = await mgr.refreshAccountTotalsIfStale();
                        if (refresh.ok) {
                            result = await this.tryDeductFromChainFree(commitmentSide, commitmentDelta, `${context} (post-refresh retry)`);
                        } else if (mgr._rateLimitStaleTotalsWarn?.('refresh-failed') !== false) {
                            mgr.logger?.log?.(
                                `[ACCOUNTING] accountTotals refresh failed (${refresh.reason}); cannot retry optimistic lock of ${Format.formatAmount8(commitmentDelta)} for ${commitmentSide}.`,
                                'warn'
                            );
                        }
                    } else if (!result.ok && result.reason === 'stale' && preLockRefreshFailed) {
                        // The pre-lock refresh already failed (chain unhealthy) so we
                        // refuse to re-run the blocking RPC under _fundLock. Fall
                        // through to the stale failure/recovery path below; the batch
                        // stays accounted for and recovery is scheduled.
                        if (mgr._rateLimitStaleTotalsWarn?.('pre-lock-refresh-failed') !== false) {
                            mgr.logger?.log?.(
                                `[ACCOUNTING] Stale accountTotals during ${context}; pre-lock refresh failed, skipping in-lock refresh to avoid holding _fundLock across a blocking chain RPC.`,
                                'warn'
                            );
                        }
                    }

                    if (!result.ok) {
                        const failure = {
                            code: result.reason === 'stale' ? 'ACCOUNTING_STALE_ACCOUNT_TOTALS' : 'ACCOUNTING_COMMITMENT_FAILED',
                            side: commitmentSide,
                            amount: commitmentDelta,
                            context,
                            reason: result.reason,
                            at: Date.now()
                        };
                        mgr._lastAccountingFailure = failure;

                        if (result.reason === 'stale') {
                            if (mgr._rateLimitStaleTotalsWarn?.('skip-optimistic-lock') !== false) {
                                mgr.logger?.log?.(
                                    `[ACCOUNTING] Stale accountTotals: skipping optimistic lock of ${Format.formatAmount8(commitmentDelta)} for ${commitmentSide} during ${context}. Recovery scheduled.`,
                                    'warn'
                                );
                            }
                            // Schedule recovery but DON'T throw — staleness is transient.
                            // The batch already confirmed on-chain; aborting the commit
                            // would orphan a successful broadcast from the grid state.
                        } else {
                            mgr.logger?.log?.(
                                `[ACCOUNTING] CRITICAL: Failed to lock ${Format.formatAmount8(commitmentDelta)} for ${commitmentSide} during ${context}. Scheduling recovery.`,
                                'error'
                            );

                            if (mgr._throwOnIllegalState) {
                                const err = new Error(
                                    `CRITICAL ACCOUNTING STATE: failed to lock ${Format.formatAmount8(commitmentDelta)} ${commitmentSide} during ${context}`
                                );
                                (err as any).code = 'ACCOUNTING_COMMITMENT_FAILED';
                                throw err;
                            }
                        }

                        // Promote recovery from fire-and-forget to a stored promise.
                        // Subsequent callers can await the in-flight recovery before
                        // attempting new deductions, reducing redundant recovery cycles.
                        if (!mgr._pendingRecovery) {
                            mgr._pendingRecovery = this._attemptFundRecovery(mgr, 'Optimistic commitment deduction failure')
                                .catch((err: any) => {
                                    mgr.logger?.log?.(`[RECOVERY] Immediate recovery scheduling failed: ${getErrorMessage(err)}`, 'error');
                                    mgr._recoveryState = { ...mgr._recoveryState, lastFailureAt: Date.now() };
                                })
                                .finally(() => {
                                    mgr._pendingRecovery = null;
                                });
                        } else {
                            mgr.logger?.log?.(
                                `[ACCOUNTING] Recovery already in-flight; waiting for existing recovery to complete before retry deduction of ${Format.formatAmount8(commitmentDelta)} for ${commitmentSide}`,
                                'warn'
                            );
                        }
                    }
                } else if (commitmentDelta < 0) {
                    // Release capital: move from Committed back to Free
                    const releaseSide = oldSideType || oldOrder.type;
                    await this.addToChainFree(releaseSide, Math.abs(commitmentDelta), `${context}`);
                }
            }

            // 2. Handle BTS blockchain fee lifecycle.
            // BitShares stores create/update fees as order.deferred_fee and later
            // refunds or charges that deferred fee on fill, update, or cancel.
            const btsOrderType = this._getBtsOrderType();
            if (btsOrderType) {
                const { balanceDelta } = this._resolveBtsFeeLifecycle(oldOrder, newOrder, context, fee);
                if (Math.abs(balanceDelta) > 0) {
                    // Caller already holds _fundLock, so use the locked body directly
                    // (adjustTotalBalance would re-acquire the re-entrant lock).
                    this._adjustTotalBalanceLocked(btsOrderType, balanceDelta, `${context}-fee`);
                }
            }
        });
    }

    /**
     * Deduct BTS fees using adjustTotalBalance.
     *
     * Strategy: Accumulate fees in btsFeesOwed, then settle when sufficient funds available.
     * - Fees are part of chainFree (not separate capital)
     * - Full fee amount must reduce chainFree
     * - Defers settlement if insufficient funds (will retry when funds become available)
     * @param {string|null} [requestedSide=null] - ORDER_TYPES.BUY or ORDER_TYPES.SELL to target a specific side
     * @returns {void}
     */
    async deductBtsFees(requestedSide: any = null) {
        const mgr = this.manager;

        // Early returns for no work needed (existence checks only — value reads
        // happen inside _fundLock below so overlapping calls cannot double-deduct)
        if (!mgr.funds || !mgr.accountTotals) return;

        const btsSide = getBtsSide(mgr.config?.assetA, mgr.config?.assetB);
        const normalizedRequestedSide = (requestedSide === 'buy' || requestedSide === 'sell') ? requestedSide : null;
        let side = btsSide || normalizedRequestedSide;

        if (normalizedRequestedSide && btsSide && normalizedRequestedSide !== btsSide) {
            mgr.logger?.log?.(
                `[BTS-FEE] Ignoring requested side '${normalizedRequestedSide}' (configured BTS side is '${btsSide}').`,
                'warn'
            );
            side = btsSide;
        }

        if (!side) return;

        let settled = false;

        // ATOMIC: read btsFeesOwed + sufficiency check + deduction + reset in one
        // lock. Two overlapping calls then serialize: the second sees fees=0 and
        // no-ops instead of double-deducting a stale amount.
        await mgr._fundLock.acquire(async () => {
            const fees = mgr.funds.btsFeesOwed;
            if (!fees || fees <= 0) return;

            const orderType = (side === 'buy') ? ORDER_TYPES.BUY : ORDER_TYPES.SELL;
            const freeKey = (side === 'buy') ? 'buyFree' : 'sellFree';
            const chainFree = mgr.accountTotals[freeKey] || 0;

            // SUFFICIENCY CHECK: Defer if insufficient funds
            if (chainFree < fees) {
                if (mgr.logger && mgr.logger.level === 'debug') {
                    mgr.logger.log(`[BTS-FEE] Deferring settlement: need ${Format.formatAmount8(fees)}, have ${Format.formatAmount8(chainFree)}`, 'debug');
                }
                return;
            }

            this._adjustTotalBalanceLocked(orderType, -fees, 'bts-fee-settlement');
            mgr.funds.btsFeesOwed = 0;
            settled = true;

            if (mgr.logger && mgr.logger.level === 'debug') {
                mgr.logger.log(`[BTS-FEE] Settled: ${Format.formatAmount8(fees)} BTS`, 'debug');
            }
        });

        // Recalculate funds only when something was actually settled — the
        // no-op calls (no fees owed, or deferred for insufficient funds) skip
        // the full grid iteration.
        if (settled) {
            await mgr.recalculateFunds();
        }
    }


    /**
     * Centralized fee deduction helper - prevents duplicate logic across codebase.
     * Returns net proceeds after market fees, or raw amount if asset is not recognized.
     * @param {string} assetSymbol - Asset symbol (e.g., 'BTS', 'XRP')
     * @param {number} rawAmount - Amount before fees
     * @param {boolean} isMaker - Whether this was a maker order (lower fee) vs taker (full fee)
     * @returns {number} Net proceeds after fees, or rawAmount if symbol not found
     * @private
     */
    _deductFeesFromProceeds(assetSymbol: any, rawAmount: any, isMaker: any) {
        if (!assetSymbol) return rawAmount;

        // BTS has no market fee. Deferred order-fee refunds are handled from
        // fill_order.order_id in processFillAccounting so they are not tied to
        // whether BTS was the received asset.
        if (assetSymbol === 'BTS') {
            return rawAmount;
        }

        // For other assets: apply normal fee calculation (market fee %)
        // Fail-safe: if fee cache is missing/stale, do not crash fill processing.
        try {
            const feeInfo = getAssetFees(assetSymbol, rawAmount, isMaker);
            const netProceeds = toFiniteNumber(feeInfo?.netProceeds, null);
            if (netProceeds === null) {
                throw new Error('netProceeds is not finite');
            }
            return netProceeds;
        } catch (err: any) {
            if (!warnedFillFeeSymbols.has(assetSymbol)) {
                warnedFillFeeSymbols.add(assetSymbol);
                this.manager?.logger?.log?.(
                    `[FILL-FEE] CRITICAL: Failed to compute fees for ${assetSymbol}: ${getErrorMessage(err)}. Using raw proceeds (${Format.formatAmount8(rawAmount)}) — fund tracking will over-credit by un-deducted fee.`,
                    'error'
                );
            }
            return rawAmount;
        }
    }

     /**
      * Process the fund impact of an order fill.
      * Atomically updates accountTotals to keep internal state in sync with blockchain.
      * CRITICAL: Called within fill processing lock context to prevent race conditions.
      * @param {Object} fillOp - Fill operation object from chain history
      * @param {string} [fillKey=null] - Deduplication key for processed fill store
      * @param {Object} [options={}] - Persistence mode options
      * @returns {Promise<boolean>} true if fill was successfully processed
      */
    async processFillAccounting(fillOp: any, fillKey: any = null, options: any = {}) {
         const mgr = this.manager;
         // Persistence is durable by default. Callers that process many fills under
         // the fill lock can opt into deferred persistence and close the window with
         // one explicit batch flush before leaving the processing cycle.
         const persistenceMode = resolveProcessedFillPersistenceMode(options);
         const pays = fillOp?.pays;
         const receives = fillOp?.receives;
         if (!pays || !receives) return false;

         // Default to maker (not taker) because:
         // 1. This bot primarily places orders (maker orders, not taker)
         // 2. Maker fees are CHEAPER: 10% of fee vs 100% for taker
         // 3. When is_maker is missing, it's safer to assume maker (the normal case)
         // 4. Makers get 90% refund on BTS fees, so we account for that
         if (fillOp.is_maker === undefined) {
             mgr?.logger?.log?.(
                 `[FILL-FEE] is_maker flag missing from fill data for order ${fillOp.order_id}; defaulting to maker — fee and BTS refund will be optimistic`,
                 'warn'
             );
         }
         const isMaker = fillOp.is_maker !== false;

        const assetAId = mgr.assets?.assetA?.id;
        const assetBId = mgr.assets?.assetB?.id;

        const assetAPrecision = mgr.assets?.assetA?.precision;
        const assetBPrecision = mgr.assets?.assetB?.precision;

         if (assetAPrecision === undefined || assetBPrecision === undefined) return false;

         // Derive all numeric effects before recording the fill key.
         // This keeps retries safe if a later computation unexpectedly fails.
         const balanceAdjustments: any[] = [];
         const assetASymbol = mgr.config?.assetA;
         const assetBSymbol = mgr.config?.assetB;

         if (pays.asset_id === assetAId) {
             const amount = blockchainToFloat(pays.amount, assetAPrecision);
             balanceAdjustments.push({ orderType: ORDER_TYPES.SELL, delta: -amount, operation: 'fill-pays' });
         } else if (pays.asset_id === assetBId) {
             const amount = blockchainToFloat(pays.amount, assetBPrecision);
             balanceAdjustments.push({ orderType: ORDER_TYPES.BUY, delta: -amount, operation: 'fill-pays' });
         }

         if (receives.asset_id === assetAId) {
             const rawAmount = blockchainToFloat(receives.amount, assetAPrecision);
             const netAmount = this._deductFeesFromProceeds(assetASymbol, rawAmount, isMaker);
             balanceAdjustments.push({ orderType: ORDER_TYPES.SELL, delta: netAmount, operation: 'fill-receives' });
         } else if (receives.asset_id === assetBId) {
             const rawAmount = blockchainToFloat(receives.amount, assetBPrecision);
             const netAmount = this._deductFeesFromProceeds(assetBSymbol, rawAmount, isMaker);
             balanceAdjustments.push({ orderType: ORDER_TYPES.BUY, delta: netAmount, operation: 'fill-receives' });
         }

         const btsRefundAdjustment = this._buildBtsDeferredRefundAdjustment(fillOp.order_id, isMaker);
         if (btsRefundAdjustment) {
             balanceAdjustments.push(btsRefundAdjustment);
         }

         let processedAt: number | null = null;
          const tracker = fillKey ? this.manager.processedFillTracker : null;
         if (fillKey) {
             processedAt = Date.now();
             const lastProcessed = tracker.get(fillKey);
             if (lastProcessed !== undefined && (processedAt - lastProcessed) < TIMING.FILL_RECORD_RETENTION_MS) {
                 this.manager?.logger?.log(
                     `[FILL-DEDUP] Skipping duplicate credit for fill ${fillKey} (processed ${processedAt - lastProcessed}ms ago)`,
                     'warn'
                 );
                 return false;
             }
         }

          const processedFillStore = this.manager.processedFillStore;

          // Queue the dedup key before applying balance adjustments. This ensures
          // persist failures are caught before any balance mutation. The queue entry
          // is flushed only after balance adjustments succeed below.
          if (fillKey && processedFillStore) {
              try {
                  // Queue without flush — flush follows after balance adjustments succeed.
                  await processedFillStore.persist(fillKey, processedAt || Date.now(), { mode: PROCESSED_FILL_PERSISTENCE_MODES.MANUAL });
              } catch (err: any) {
                  mgr.logger?.log?.(
                      `[FILL-DEDUP] Failed to queue fill ${fillKey}: ${getErrorMessage(err)}`,
                      'warn'
                  );
                  return false;
              }
          }

          await this._applyBalanceAdjustments(balanceAdjustments);

          // Flush the queued dedup key now that balance adjustments succeeded.
          // For IMMEDIATE mode, this persists durably. For BATCHED mode, the
          // key remains queued for the caller's batch flush.
          if (fillKey && processedFillStore) {
              try {
                  if (persistenceMode === PROCESSED_FILL_PERSISTENCE_MODES.IMMEDIATE) {
                      await processedFillStore.flush('fill-persist', { throwOnError: true });
                  }
              } catch (err: any) {
                  // Roll back balance adjustments since the dedup key was not persisted.
                  // This keeps the invariant: dedup key persisted ⇔ balance adjustments applied.
                  for (const adj of balanceAdjustments) {
                      await this.adjustTotalBalance(adj.orderType, -adj.delta, 'rollback-' + adj.operation);
                  }
                  processedFillStore.discard(fillKey, processedAt || Date.now());
                  throw err;
              }
          }

          if (fillKey) {
              tracker.set(fillKey, processedAt || Date.now());
              // Prune entries beyond the retention horizon to prevent unbounded growth.
              if (tracker.size > 500) {
                  const cutoff = (processedAt || Date.now()) - TIMING.FILL_RECORD_RETENTION_MS;
                  for (const [k, ts] of tracker) {
                      if (ts < cutoff) tracker.delete(k);
                  }
              }
          }

         return true;
    }
}

export default Accountant
