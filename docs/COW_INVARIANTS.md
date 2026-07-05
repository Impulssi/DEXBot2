# System Invariants (Stable Theory Contract)

This document defines the non-negotiable behavioral invariants for the DEXBot2 system. It is a contract for code review and release safety, not a design tutorial.

## Scope

- **COW Pipeline**: planning, projection, reconciliation, commit, and fund accounting flows.
- **Sync Engine**: fill history sync, open-order sync, orphan detection, cache vs chain consistency.
- **Maintenance Runtime**: pipeline gating, illegal-state handling, cooldown semantics, dust ordering.
- **Grid & Reconcile**: price-level uniqueness, dust detection scope, reconcile cancel semantics.
- **Batch & Pipeline**: stale handling, retry gating, stale-flag cleanup.
- **Fund Registry**: cross-bot allocation invariants.
- **Subscriptions**: health watchdog, silent-death detection.

## Invariant Prefixes

| Prefix | Subsystem |
|--------|-----------|
| `INV-COW` | COW pipeline |
| `INV-REC` | Reconcile |
| `INV-PROJ` | Projection |
| `INV-ID` | Order identity |
| `INV-ACC` | Accounting / fund tracking |
| `INV-DUST` | Dust health |
| `INV-SYNC` | Sync engine |
| `INV-MAINT` | Maintenance runtime |
| `INV-GRID` | Grid structure |
| `INV-RECON` | Reconcile layer |
| `INV-BATCH` | Batch / pipeline |
| `INV-PIPE` | Pipeline signals |
| `INV-STATE` | State / lifecycle |
| `INV-REG` | Fund registry |
| `INV-SUB` | Subscriptions |
| `INV-BOOT` | Bootstrap / resync |
| `INV-UPDATE` | On-chain updates |

---

## COW Pipeline

- `INV-COW-001` Master immutability until commit
  - The master grid must not be mutated during planning/execution prep.
  - All intermediate mutations happen in `WorkingGrid`.
  - Master updates occur only during commit after guard checks pass.

- `INV-COW-002` Commit atomicity
  - Commit swaps working state to master atomically.
  - On failed/aborted execution, working state is discarded and master remains unchanged.

- `INV-REC-001` Rotation-only size updates in reconcile
  - `reconcileGrid` does not emit generic in-place size UPDATEs for active slot diffs.
  - Size-changing UPDATE actions are rotation updates (`newGridId` path).
  - Non-rotation size correction is handled by dedicated maintenance flows.

- `INV-PROJ-001` New projected orders remain virtual
  - Orders projected into empty slots must be `VIRTUAL` with no `orderId` until chain confirmation.

- `INV-PROJ-002` Preserve on-chain PARTIAL size in projection
  - If identity is retained (`keepOrderId=true`) and current state is `PARTIAL`, projected size must preserve current on-chain remaining size.
  - It must not be overwritten by ideal geometric `targetSize`.
  - Preserve-path size must be normalized to finite, non-negative value.

- `INV-PROJ-003` ACTIVE on-chain projection follows target size
  - If identity is retained and state is `ACTIVE`, projection may apply target size normally.

- `INV-ID-001` Order identity retention rule
  - `orderId` and on-chain state are retained only when order is on-chain and side/type is unchanged.
  - Otherwise projected order becomes `VIRTUAL` with `orderId=null`.

- `INV-ACC-001` Committed accounting source of truth
  - Committed chain/grid totals derive only from on-chain orders (`ACTIVE`/`PARTIAL` with `orderId`) and their projected sizes.
  - Virtual orders contribute only to virtual pools, not committed chain totals.

- `INV-ACC-002` Fund invariant consistency (INVARIANT 1)
  - Tracked totals must remain consistent with blockchain totals within `FUND_INVARIANT_PERCENT_TOLERANCE`.
  - `Total = Free + Committed` must hold per side.
  - False violations due to ideal-size projection overstatement are prohibited.

- `INV-ACC-003` Cross-bot fund registry invariant (INVARIANT 3)
  - Shared-account per-bot commitment must not exceed the bot's proportional share of chain balance.
  - Checked with widened tolerance `max(PERCENT_TOLERANCE * 3, 0.15)`.
  - Registry failure logs a warning, not a silent skip.

- `INV-DUST-001` Dust health gating parity
  - Dust health thresholding applies consistently to both CREATE and rotation destination holes.

---

## Sync Engine

- `INV-SYNC-001` Drift-refetch for partial fill correctness
  - `isEffectivelyFull` must not unconditionally trust cached `rawOnChain.for_sale`.
  - When cached `for_sale` is smaller than the grid's own size (drift signal), refetch from chain via `readSingleOrder`.
  - `isEffectivelyFull` requires either: chain-confirmed empty (refetch returned null), grid also at 0, or the other side rounding to 0.
  - The legacy `newSizeInt <= 0` fast-path is forbidden.

- `INV-SYNC-002` No TTL-based chain refetch
  - Chain is only consulted on a drift signal (cache < grid size).
  - Time-based TTL refetches are prohibited — a stale-but-consistent cache is still correct.

- `INV-SYNC-003` Drift refetch null = chain-confirmed empty
  - When drift refetch returns null from `readSingleOrder`, the order is authoritatively gone.
  - The sync engine must treat this as a chain-confirmed empty, not a connection failure.

- `INV-SYNC-004` Orphan adoption rejects duplicate price levels
  - Pass-2 fallback adoption must check whether an active grid order of the same type already exists at the same price (within `calculatePriceTolerance` using `Math.max(size)`).
  - If a duplicate exists, the orphan is NOT adopted; it is pushed to `unmatchedChainOrders` for chain cancel.
  - Size is irrelevant — any duplicate violates the one-order-per-price-level invariant.

- `INV-SYNC-005` Fill queue back-pressure
  - Subscription callbacks must not push fills beyond `MAX_INCOMING_FILL_QUEUE`.
  - Rejected fills must leave subscription cursors retryable; the queue must remain unchanged.
  - Back-pressure must not start a consumer for rejected fills.

- `INV-SYNC-006` syncFromOpenOrders acquires fill-processing lock
  - `syncFromOpenOrders` acquires `_fillProcessingLock` by default.
  - Callers already inside the lock must pass `fillLockAlreadyHeld=true`.
  - Direct call sites without the lock contract are prohibited.

- `INV-SYNC-007` Authoritative sync preserves fetched free balances
  - `synchronizeWithChain` must not double-deduct already-locked funds from fetched `buyFree`/`sellFree`.
  - After authoritative open-order sync, `checkFundDriftAfterFills` must return `isValid=true`.

---

## Maintenance Runtime

- `INV-MAINT-001` Pipeline in-flight defers maintenance
  - When `isPipelineEmpty` returns `isEmpty=false` (batch in-flight, recovery in-flight, or broadcasting active), `checkSpreadCondition` and `checkGridHealth` must be skipped.
  - Pipeline signals (`batchInFlight`, `recoveryInFlight`, `broadcasting`) must be passed to `isPipelineEmpty`.

- `INV-MAINT-002` Illegal state abort
  - When `consumeIllegalStateSignal` returns a non-null signal, the maintenance cycle must:
    - Trigger immediate recovery sync (`_triggerStateRecoverySync`).
    - Skip persistence (`_persistAndRecoverIfNeeded`) in the same cycle.
    - Skip remaining maintenance steps (spread checks).
    - Arm one maintenance cooldown cycle (`_maintenanceCooldownCycles = 1`).

- `INV-MAINT-003` Maintenance cooldown
  - After a hard-abort (illegal state), the next maintenance cycle must skip all checks (spread, health, etc.).
  - Cooldown is exactly one cycle; normal checks resume on the subsequent cycle.
  - Cooldown must not stack or compound.

- `INV-MAINT-004` Maintenance idle gate
  - Maintenance must wait for a quiet window with no fill queue, sync, or batch activity (`BLOCKCHAIN_SETTLE_DELAY_MS`).
  - Recent activity tracking covers: fill queueing, fill processing completion, COW batch start/end, open-order sync, periodic fetches.

- `INV-MAINT-005` Dust-first ordering
  - Dust partials default to `DUST_CANCEL_DELAY_SEC` (30s).
  - Grid resync and structural maintenance must be deferred until dust timers complete, plus an additional blockchain settle delay before retrying reset work.

---

## Grid Structure

- `INV-GRID-001` One-to-one order mapping
  - One grid slot = at most one on-chain order. No two chain orders may map to the same grid slot.
  - Sync engine tracks `matchedGridOrderIds` through both sync passes and skips already-matched slots.
  - Surplus orders (matched count > `activeOrders.buy/sell` targets) are flagged for cancellation.

- `INV-GRID-002` One order per price level
  - The active grid must have at most one on-chain order per (type, price) pair.
  - Duplicate price levels are a structural violation — the sync engine must reject orphan adoption at a duplicate price, and the reconcile layer must cancel offenders on chain.
  - Size is irrelevant; any duplicate violates this invariant.

- `INV-GRID-003` Interior dust detection at duplicate price levels
  - Interior partials (not top-of-window) are eligible for dust detection if they share a price level with an ACTIVE sibling.
  - Top-of-window partials remain always eligible.
  - Two PARTIALs sharing a price with no active sibling do not qualify (left to rebalancer).

---

## Reconcile

- `INV-RECON-001` Reconcile cancels duplicate chain orders unconditionally
  - When an unmatched order is within `looseTolerance` of an active grid order, it must be cancelled on chain via `_cancelChainOrder` with `releaseUntrackedFunds: true`.
  - Cancelled IDs are filtered out of `unmatchedParsed` to prevent reprocessing.
  - No size guard — any duplicate at the same price is a violation.
  - `SUSPECTED_DUPLICATE_TOLERANCE_FLOOR` (absolute price floor) is removed — only `tolerance * SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER` is used.

- `INV-RECON-002` Rebalance must not convert on-chain slots to SPREAD via CREATE
  - `performSafeRebalance` must not emit `CREATE` actions that convert existing on-chain slots into SPREAD orders.
  - On-chain mid-slot must keep its BUY/SELL type before commit.

- `INV-RECON-003` Extreme placement ordering
  - BUY placements must use nearest available free slots first (ascending price).
  - SELL placements must use nearest available free slots first (descending price).

---

## Batch / Pipeline

- `INV-BATCH-001` Illegal state batch abort
  - When `executeBatch` throws `ILLEGAL_ORDER_STATE`, the caller must:
    - Return `abortedForIllegalState: true`.
    - Trigger one immediate recovery sync.
    - Arm one maintenance cooldown cycle.

- `INV-BATCH-002` Stale-only cancel fast path
  - When a cancel-only batch fails with "order does not exist" (stale), the handler must:
    - Virtualize the slot (`state = VIRTUAL`, `orderId = null`, `size = 0`, `rawOnChain = null`).
    - Return `stale: true`.
    - NOT trigger a recovery sync.
    - Track the stale order id in `_staleCleanedOrderIds` to prevent double-credit.
    - Preserve manager index validity.

- `INV-BATCH-003` "Cannot deduct" → recovery sync
  - When `executeBatch` throws "Cannot deduct all or more from order than order contains", the handler must:
    - Return `recoveredBySync: true`, `reason: 'ORDER_SIZE_DRIFT'`.
    - Trigger one recovery sync.
    - NOT virtualize the slot.
    - Preserve `orderId` until sync reconciles it.
    - NOT mark the order as stale-cleaned.

---

## Pipeline Signals

- `INV-PIPE-001` Stale correction entry removal
  - `correctOrderPriceOnChain` must remove the entry from `ordersNeedingPriceCorrection` in ALL exit paths: success, skip (updateOrder returns null), and error.
  - Use `try`/`catch`/`finally` with `.filter()` removal only in `finally`.

- `INV-PIPE-002` Throw-safe grid divergence corrections
  - `updateGridFromBlockchainSnapshot` called from `applyGridDivergenceCorrections` must be wrapped in try/catch that clears `_gridSidesUpdated` on failure.
  - A throw must not leave `_gridSidesUpdated` permanently set, which would block the next tick.

---

## State / Lifecycle

- `INV-STATE-001` Bootstrap suppresses invariant checks
  - While `isBootstrapping()` is true, `_verifyFundInvariants` must be suppressed.
  - Suppression covers `recalculateFunds` and `_updateOrder` trigger paths.

- `INV-STATE-002` Recovery validation not masked by bootstrap
  - `_performStateRecovery` must detect drift even when `isBootstrapping()` is true.
  - Bootstrap suppression of invariant checks must not also suppress recovery validation.

- `INV-STATE-003` Grid resize respects budget after capping
  - BUY allocation must not exceed calculated budget after `_recalculateGridOrderSizesFromBlockchain` capping.

---

## Fund Registry

- `INV-REG-001` Cross-bot allocation ≤ proportional share
  - Per-bot committed amounts (sum of on-chain orders) must not exceed `totalChainBalance × allocatedPercent`.
  - Violation triggers a warning-level log entry (not silent), with tolerance `max(PERCENT_TOLERANCE * 3, 0.15)`.
  - Registry registration is pre-flight + atomic; all bots register before any starts.
  - Release happens in `DEXBot.shutdown`.

- `INV-REG-002` Async-locked registry writes
  - All `fund_registry` mutations (register, update, release) must hold an async lock.
  - Concurrent writes from multiple bots sharing the same account must be serialized.

---

## Subscriptions

- `INV-SUB-001` Subscription health watchdog
  - A periodic timer (`SUBSCRIPTION_HEALTH_CHECK_INTERVAL_MS`) must check `lastNoticeAt` per subscription.
  - If silence exceeds `SUBSCRIPTION_SILENT_THRESHOLD_MS`, trigger `resubscribeEntry('healthcheck')`.
  - `reconnecting` flag must guard against concurrent resubscribe calls.

---

## Broadcast

- `INV-BROADCAST-001` BROADCAST_DEADLINE graceful recovery
  - On `BroadcastUncertainError`, the bot must:
    - Retry once with a fresh deadline window (`_executeWithRetryOnUncertain`).
    - Skip retry when `err.partialOnChainState` is true (pair-mode grouped execution).
    - After retry expiry, reconcile with `fillLockAlreadyHeld=true` to avoid AsyncLock deadlock.
  - Daemon broadcast retries are configurable via `CREDENTIAL_DAEMON_BROADCAST_RETRIES`.

- `INV-BROADCAST-002` Deadlock-free reconcile after uncertain broadcast
  - `_reconcileAfterUncertainBroadcast` must pass `fillLockAlreadyHeld=true` because `_fillProcessingLock` is already held by the fill-processing call chain.
  - AsyncLock is not reentrant; a second `acquire()` would queue forever.

---

## Constants & Precision

- `INV-CONST-001` All magic numbers centralized in `constants.ts`
  - Hardcoded fallbacks in runtime code are prohibited.
  - Every timing value, limit, and threshold must have a named constant.

- `INV-PREC-001` Precision helpers throw on invalid precision
  - `formatAmountByPrecision` and `formatSizeByOrderType` must throw when precision is undefined.
  - Silent fallback to `DEFAULT_ASSET_PRECISION (8)` is prohibited.
  - `floatToBlockchainInt` throws on undefined precision — callers must guarantee precision is available before calling.

---

## Test Mapping

### COW Pipeline
- `INV-COW-001`, `INV-COW-002`
  - `tests/test_cow_master_plan.ts` (`COW-001`, `COW-002`)
  - `tests/test_cow_commit_guards.ts`
- `INV-REC-001`
  - `tests/test_cow_master_plan.ts` (`COW-016`)
- `INV-PROJ-001`
  - `tests/test_cow_master_plan.ts` (`COW-012`, `COW-013`, `COW-014`)
- `INV-PROJ-002`
  - `tests/test_cow_master_plan.ts` (`COW-018`, `COW-018c`)
- `INV-PROJ-003`
  - `tests/test_cow_master_plan.ts` (`COW-018b`)
- `INV-DUST-001`
  - `tests/test_cow_master_plan.ts` (`COW-017`)

### Accounting / Fund Tracking
- `INV-ACC-001`, `INV-ACC-002`
  - `tests/test_funds.ts`
  - `modules/order/accounting.ts:472-594` (`_verifyFundInvariants`)
- `INV-ACC-003`
  - `modules/order/accounting.ts:534-583` (cross-bot INVARIANT 3)

### Sync Engine
- `INV-SYNC-001`, `INV-SYNC-002`, `INV-SYNC-003`
  - `tests/test_sync_fill_drift_refetch.ts` (5 sub-cases)
  - `tests/test_ghost_order_fix.ts`
- `INV-SYNC-004`
  - `tests/test_sync_logic.ts` (`testOrphanAtDuplicatePriceLevelIsNotAdopted`)
- `INV-SYNC-005`
  - `tests/test_patch17_invariants.ts` (`testFillCallbackAppliesQueueBackPressure`)
- `INV-SYNC-006`
  - `tests/test_sync_lock_routing.ts`
- `INV-SYNC-007`
  - `tests/test_resync_invariants.ts` (Case 5)

### Maintenance Runtime
- `INV-MAINT-001`
  - `tests/test_patch17_invariants.ts` (`testPipelineInFlightDefersMaintenance`)
- `INV-MAINT-002`, `INV-MAINT-003`
  - `tests/test_patch17_invariants.ts` (`testIllegalStateAbortResyncAndCooldown`)
- `INV-MAINT-004`, `INV-MAINT-005`
  - `tests/test_dust_rebalance_logic.ts`

### Grid Structure
- `INV-GRID-001`
  - `modules/order/sync_engine.ts` (one-to-one mapping via `matchedGridOrderIds`)
  - `tests/test_sync_logic.ts` (surplus order cancellation)
- `INV-GRID-002`
  - `modules/order/sync_engine.ts:804` (duplicate price level rejection)
  - `modules/order/grid_reconcile.ts` (duplicate chain order cancel)
- `INV-GRID-003`
  - `tests/test_dust_rebalance_logic.ts` (`testInteriorDustWithDuplicatePriceLevel`, `testInteriorDustAdjacentGridLevelNotEligible`)

### Reconcile
- `INV-RECON-001`
  - `modules/order/grid_reconcile.ts` (unconditional duplicate cancel)
- `INV-RECON-002`
  - `tests/test_patch17_invariants.ts` (`testRoleAssignmentBlocksOnChainSpreadConversion`)
- `INV-RECON-003`
  - `tests/test_patch17_invariants.ts` (`testExtremePlacementOrdering`)

### Batch / Pipeline
- `INV-BATCH-001`
  - `tests/test_patch17_invariants.ts` (`testIllegalBatchAbortArmsMaintenanceCooldown`)
- `INV-BATCH-002`
  - `tests/test_patch17_invariants.ts` (`testSingleStaleCancelBatchUsesStaleOnlyFastPath`)
- `INV-BATCH-003`
  - `tests/test_patch17_invariants.ts` (`testCannotDeductTriggersRecoverySyncInsteadOfVirtualizing`)

### Pipeline Signals
- `INV-PIPE-001`
  - `modules/order/utils/order.ts` (correction entry removal via finally)
- `INV-PIPE-002`
  - `modules/order/utils/system.ts` (try/catch wrapping grid divergence)

### State / Lifecycle
- `INV-STATE-001`, `INV-STATE-002`
  - `tests/test_resync_invariants.ts` (Cases 1-4)
- `INV-STATE-003`
  - `tests/test_patch17_invariants.ts` (`testGridResizeRespectsBudgetAfterCap`)

### Fund Registry
- `INV-REG-001`, `INV-REG-002`
  - `modules/fund_registry.ts`
  - `modules/order/accounting.ts:534-583`

### Subscriptions
- `INV-SUB-001`
  - `modules/bitshares-native/subscriptions.ts` (health watchdog)
  - `tests/test_native_subscriptions.ts`

### Broadcast
- `INV-BROADCAST-001`, `INV-BROADCAST-002`
  - `modules/dexbot_class.ts` (`_executeWithRetryOnUncertain`, `_reconcileAfterUncertainBroadcast`)

---

## Review Checklist (Quick Use)

For any change touching these subsystems, reviewers should verify:

- **COW/Accounting**: preserves `INV-PROJ-002` for on-chain PARTIAL orders; avoids non-rotation size UPDATE leakage (`INV-REC-001`); keeps virtual/on-chain separation (`INV-ACC-001`); preserves atomic commit (`INV-COW-001`, `INV-COW-002`).
- **Sync Engine**: does not reintroduce `newSizeInt <= 0` fast-path (`INV-SYNC-001`); does not add TTL-based refetch (`INV-SYNC-002`); orphan adoption checks price-level uniqueness (`INV-SYNC-004`).
- **Maintenance**: pipeline signals are passed to `isPipelineEmpty` (`INV-MAINT-001`); illegal-state abort arms cooldown (`INV-MAINT-002/003`).
- **Reconcile**: duplicate chain orders at same price are cancelled unconditionally (`INV-RECON-001`); no CREATE-based spread conversion of on-chain slots (`INV-RECON-002`).
- **Batch**: stale-only cancel uses fast path without recovery sync (`INV-BATCH-002`); "cannot deduct" triggers sync, not virtualization (`INV-BATCH-003`).
- **Are corresponding regression tests added/updated?**

## Change Policy

- Any intentional invariant change must:
  - Update this document in the same PR/commit.
  - Include explicit rationale and risk note.
  - Add or update regression tests linked in Test Mapping.
