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
- **Broadcast**: uncertain-broadcast recovery, retry, deadlock-free reconcile.

## Invariant Prefixes

| Prefix | Subsystem |
|--------|-----------|
| `INV-COW` | COW pipeline |
| `INV-PROJ` | Projection |
| `INV-ID` | Order identity |
| `INV-ACC` | Accounting / fund tracking |
| `INV-SYNC` | Sync engine |
| `INV-MAINT` | Maintenance runtime |
| `INV-GRID` | Grid structure |
| `INV-RECON` | Reconcile |
| `INV-BATCH` | Batch / pipeline |
| `INV-STATE` | State / lifecycle |
| `INV-REG` | Fund registry |
| `INV-SUB` | Subscriptions |
| `INV-BROADCAST` | Broadcast |

---

## COW Pipeline

- `INV-COW-001` Master immutability until commit
  - The master grid must not be mutated during planning/execution prep.
  - All intermediate mutations happen in `WorkingGrid`.
  - Master updates occur only during commit after guard checks pass.

- `INV-COW-002` Commit atomicity
  - Commit swaps working state to master atomically.
  - On failed/aborted execution, working state is discarded and master remains unchanged.

- `INV-PROJ-001` New projected orders remain virtual
  - Orders projected into empty slots must be `VIRTUAL` with no `orderId` until chain confirmation.

- `INV-PROJ-002` Preserve on-chain PARTIAL size in projection
  - If identity is retained (`keepOrderId=true`) and current state is `PARTIAL`, projected size must preserve current on-chain remaining size.
  - It must not be overwritten by ideal geometric `targetSize`.
  - Exception: a `PARTIAL` with a rotation/size-update action targeting its `orderId` does use `targetSize` (the explicit-UPDATE path at `modules/order/utils/validate.ts:827`).
  - Preserve-path size must be normalized to finite, non-negative value.

- `INV-PROJ-003` ACTIVE on-chain projection preserves current size (same as PARTIAL)
  - If identity is retained and state is `ACTIVE`, projection preserves current on-chain size via the same `shouldPreserveSize` path as `PARTIAL` (`validate.ts:818-832`).
  - An explicit UPDATE action targeting the `orderId` is required to apply `targetSize`.

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
  - Registry failure logs an error (`accounting.ts:554-563`, with a "CRITICAL FIX: Log as ERROR instead of WARN" comment), not a silent skip.

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
  - After authoritative open-order sync, `checkFundDriftAfterFills` is expected to return `isValid=true` as a design consequence (no enforcement code exists — this sub-clause expresses the intended post-condition, not an assertion).

---

## Maintenance Runtime

- `INV-MAINT-001` Pipeline in-flight defers maintenance
  - When `isPipelineEmpty` returns `isEmpty=false` (batch in-flight, recovery in-flight, or broadcasting active), `checkSpreadCondition` and broadcast actions (`cancelDustOrders`) must be skipped.
  - A read-only `checkGridHealth` detection pass runs before the gate by design — it only populates `_dustSinceMap` so the dust timer starts burning while the pipeline is blocked; no broadcast/cancel may fire until the pipeline is empty.
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

- `INV-RECON-001` Rotation-only size updates in reconcile
  - `reconcileGrid` does not emit generic in-place size UPDATEs for active slot diffs.
  - Size-changing UPDATE actions are rotation updates (`newGridId` path).
  - Non-rotation size correction is handled by dedicated maintenance flows.

- `INV-RECON-002` Dust health gating parity
  - Dust health thresholding applies consistently to both CREATE and rotation destination holes.

- `INV-RECON-003` Reconcile cancels duplicate chain orders unconditionally
  - When an unmatched order is within `looseTolerance` of an active grid order, it must be cancelled on chain via `_cancelChainOrder` with `releaseUntrackedFunds: true`.
  - Cancelled IDs are filtered out of `unmatchedParsed` to prevent reprocessing.
  - No size guard — any duplicate at the same price is a violation.
  - `SUSPECTED_DUPLICATE_TOLERANCE_FLOOR` (absolute price floor) is removed — only `tolerance * SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER` is used.
  - `SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER` is a file-local constant (`modules/order/grid_reconcile.ts`, value `5`), not a centralized `constants.ts` entry.

- `INV-RECON-004` Rebalance must not convert on-chain slots to SPREAD via CREATE
  - `performSafeRebalance` must not emit `CREATE` actions that convert existing on-chain slots into SPREAD orders.
  - On-chain mid-slot must keep its BUY/SELL type before commit.

- `INV-RECON-005` Extreme placement ordering
  - BUY placements must use nearest available free slots first (descending price, so the nearest-to-center slots fill first — `validate.ts:465-468`).
  - SELL placements must use nearest available free slots first (ascending price).

---

## Batch / Pipeline

- `INV-BATCH-001` Illegal state batch abort
  - `executeBatch` throws `ILLEGAL_SPREAD_STATE` on an illegal grid layout (emitted at `modules/order/utils/validate.ts`, propagated via `modules/order/manager.ts` `_throwOnIllegalState`).
  - The `_handleBatchHardAbort` catch for `ILLEGAL_ORDER_STATE` (`dexbot_class.ts:469`) is a test-only dead branch — production never emits that code; only the test stub at `tests/test_patch17_invariants.ts:387` uses it.
  - In production, recovery + cooldown are armed on the next maintenance tick via `_abortFlowIfIllegalState` (the `INV-MAINT-002` path), returning `abortedForIllegalState: true` to the caller. The caller does not need to return immediately; the maintenance tick handles recovery.
  - Hard abort triggers one immediate recovery sync (`_triggerStateRecoverySync`) plus arms one maintenance cooldown cycle (`_maintenanceCooldownCycles = Math.max(current, 1)`).

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
  - Fast path: if the batch result indicates `ORDER_SIZE_DRIFT_TARGETED` (`dexbot_class.ts:593-599`), a targeted repair applies the correction directly and skips `_triggerStateRecoverySync`.

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
  - Violation triggers an error-level log entry (not silent), with tolerance `max(PERCENT_TOLERANCE * 3, 0.15)`.
  - Registry registration is pre-flight + atomic; only shared-account bots register (`dexbot.ts:521` filters `accountGroups[a].length > 1`), and registration completes before any shared-account bot starts.
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

## Change Policy

- Any intentional invariant change must:
  - Update this document in the same PR/commit.
  - Include explicit rationale and risk note.
  - Add or update regression tests in the relevant test files.
