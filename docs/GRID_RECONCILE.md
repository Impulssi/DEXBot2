# Grid Reconciliation: Distributed State Mismatch in a Single-Threaded Runtime

## The Core Problem

DEXBot2 holds an **intended grid state** — which orders should be on-chain, at what prices and sizes, each assigned a grid slot with an `orderId`. The blockchain holds the **actual state** — the limit orders that physically exist. Fills, partial cancellations, race conditions, and external cancellations or manual order edits cause these to diverge.

| Side | What it holds | Ground truth? |
|------|---------------|---------------|
| **Bot model** (`manager.orders`) | Grid slots with target price, size, state, `orderId` | Optimistic — set before confirmation, updated after broadcast |
| **Blockchain** (BitShares DEX) | Limit orders with ID, price, for_sale, filled | Yes — this is reality |

Reconciliation aligns the bot's model with on-chain reality. It runs at startup when the gap is widest (bot was offline, fills happened, grid may have been regenerated).

### Why Not Cancel Everything

- No atomic cancel+create on BitShares — `cancel_order` cancels the full order; there is no partial size reduction
- A full teardown leaves the bot unable to trade during the rebuild window

---

## Architecture: 3-Phase Plan-then-Execute

The entire reconcile operation is wrapped in a 300-second `Promise.race` ceiling (`PIPELINE_TIMING.TIMEOUT_MS`). If Phase 2 exceeds this limit, the reconcile aborts and the bot proceeds with whatever partial state was achieved — subsequent RMS divergence cycles or the next startup will clean up remaining mismatches.

Phase 1 does all reasoning in memory under `_gridLock` (fast); Phases 2 and 3 execute outside the lock — holding a lock across RPC calls would block fills, sync, and divergence checks for hundreds of milliseconds each. All execution operations in Phases 2–3 re-acquire `_gridLock` individually (via `synchronizeWithChain`) so the lock is held briefly per operation, not for the entire phase.

Phase 2 and 3 both respect the `dryRun` flag: when true, no on-chain mutations are attempted — plans are logged but not executed.

`targetCount` (per side, `targetSell`/`targetBuy`) is sourced from bot config and determines how many active orders each side should maintain. The internal `planOnly` flag controls whether `_reconcileStartupSide` records plans for Phase 2 or executes inline — Phase 1 always calls with `planOnly=true`.

```
                    Grid generated
                            │
                            ▼
┌──────────────────────────────────────────────────────┐
│  PHASE 1: Planning (under _gridLock)                 │
│                                                      │
│  • Sanitize phantom orders (ACTIVE/PARTIAL without   │
│    on-chain orderId → VIRTUAL, skip accounting)      │
│  • Detect suspected duplicates (within 5× price      │
│    tolerance) → queue for cancel                     │
│  • Per-side: match unmatched chain orders to virtual │
│    grid slots → plan updates                         │
│  • Detect grid-edge lockup → plan largest-order      │
│    cancel to free funds                              │
│  • Detect excess chain orders → plan cancels         │
│  • No on-chain RPC calls inside this phase           │
└──────────────────────┬───────────────────────────────┘
                       │ returns { plannedCreates, plannedUpdates, plannedCancels }
                       ▼
┌──────────────────────────────────────────────────────┐
│  PHASE 2: Execution (outside _gridLock)              │
│                                                      │
│  1. Cancellations — duplicates, edge releases,       │
│     excess chain orders                              │
│  2. Updates — batch (3 retries), then sequential     │
│     fallback with per-failure recovery sync          │
│  3. Creates — outside-in pairing (outermost grid     │
│     slots first, BUY desc, SELL asc), batched where  │
│     BitShares DEX supports batch creates             │
└──────────────────────┬───────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────┐
│  PHASE 3: Stale Surplus Cleanup                      │
│                                                      │
│  • Re-fetch chain state after Phase 2                │
│  • Cancel orders exceeding per-side target that      │
│    are NOT tracked by any grid slot's orderId        │
│  • Catch orphans lost during grid reinitialization   │
└──────────────────────────────────────────────────────┘
```

### Phase 1 — Pure Planning Under `_gridLock`

**`grid_reconcile.ts:204-336`**

1. **Phantom order sanitization** (lines 210-223): Reset ACTIVE/PARTIAL orders whose `orderId` is missing on-chain to VIRTUAL with `skipAccounting` to prevent fund inflation.

2. **Duplicate detection** (lines 240-287): For each unmatched chain order, find the nearest active same-side grid order. If `priceDiff ≤ tolerance × 5`, flag as suspected duplicate and queue for Phase 2 cancel. Tolerance is computed from price impact via `calculatePriceTolerance`: capped at `PRICE_TOLERANCE_MAX_PERCENT` (1%) with `PRICE_TOLERANCE_MIN_ABSOLUTE` (0.0001) floor.

3. **Per-side reconciliation** via `_reconcileStartupSide(planOnly=true)` (lines 303-333):
   - Count `matchedOnGrid` (active grid orders with `orderId`)
   - `neededSlots = targetCount - matchedOnGrid`; pick virtual slots to activate
   - Match sorted unmatched chain orders to virtual slots → `plannedUpdates`
   - Detect grid-edge lockup → plan largest-order cancel
   - Plan creates for remaining slots
   - Plan excess cancellations (guarded by `matchedOnGrid > 0`)

Returns `{ plannedCreates, plannedUpdates, plannedCancels }`.

### Phase 2 — Blockchain Execution Outside Lock

**`grid_reconcile.ts:338-456`**

Each sub-phase releases `_gridLock` before starting and re-acquires it per operation (via `synchronizeWithChain` in individual helpers). This means no single long-held lock blocks fills, sync, or divergence checks during execution — but each operation still runs under the lock for consistency.

**Cancellations** (lines 346-371): Execute `plannedCancels`. Each `_cancelChainOrder` acquires `_gridLock` internally via `synchronizeWithChain`.

**Updates** (lines 373-445):
- Batch via `buildUpdateOrderOp` + `executeBatch` when available
- Retry up to 3× (`maxBatchAttempts = 3`)
- On failure: `_recoverStartupSyncFailure()` re-fetches open orders from chain and re-syncs `manager` state via `manager.syncFromOpenOrders()`, then `_refreshStartupUpdatePlans()` rebuilds plans against the fresh chain state
- Retries exhausted → `_executeStartupSequentialUpdateFallback()` one-by-one with per-failure recovery

**Creates** (lines 447-456): `_executePlannedStartupCreates` with outside-in pair grouping — creates are grouped from the outermost grid slots toward the center, with BUY orders sorted descending and SELL orders ascending, so the most price-critical orders are placed first. BitShares DEX batch create operations are used where supported.

### Phase 3 — Stale Surplus Cleanup

**`grid_reconcile.ts:458-527`** (guarded by `if (!dryRun)` at line 460)

Re-fetch all open orders from chain. Per side: count orders exceeding `targetCount` that no grid slot tracks via `orderId`. Cancel only these untracked surplus orders. Catch orphans from grid reinitialization — orders that ended up on-chain but have no corresponding grid slot.

### Partial Failure State

If Phase 2 partially succeeds (some cancels go through, some creates fail), there is no rollback. The bot proceeds with the resulting state. Because the reconcile runs at startup before the fill pipeline activates, no fills are missed during this window. Remaining mismatches are caught by the next RMS structural divergence cycle or the next startup reconcile.

---

## Edge Cases (All Hit in Production or Code Review)

### Fresh Grid Guard (`matchedOnGrid > 0`)

**`grid_reconcile_internal.ts:1083-1096`**

When a brand-new grid is generated, every slot is VIRTUAL — `matchedOnGrid = 0`. Without a guard, every on-chain order appears "unmatched" and would be cancelled as excess:

```typescript
if (matchedOnGrid > 0 || neededSlots === 0) {
    cancelCount = Math.max(0, chainCount - targetCount);
}
```

When `matchedOnGrid === 0` AND scaling up (`neededSlots > 0`), excess cancellation is skipped — the guard covers both the fresh-grid scenario and the scale-down case (`neededSlots === 0`). Suspected duplicate detection still catches real duplicates; remainder is handled by the next Root Mean Square (RMS) divergence cycle.

### Grid-Edge Lockup

**`grid_reconcile_internal.ts:983-1006`**

When all outermost orders of a side are ACTIVE with `orderId`, all balance is committed to the edges. BitShares DEX may not allow partial-reduce in one operation, so canceling the **largest** order among update candidates (`_cancelLargestOrder`, lines 169-200+) frees maximum funds with minimum operations. The cancelled slot gets a replacement create.

Detection (`_isGridEdgeFullyActive`, lines 99-122): sort orders by price (BUY descending, SELL ascending), check outermost N are all `isOrderPlaced()`.

### Duplicate Tolerance (5× Multiplier)

**`grid_reconcile.ts:240-287`**

`SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER = 5`. An unmatched chain order within 5× price tolerance of an active same-type grid slot is a suspected duplicate → queued for Phase 2 cancellation (not cancelled under lock). The base tolerance comes from `calculatePriceTolerance`, which estimates the maximum acceptable price deviation given the order's size and the grid's price step.

### Batch Update Failure Recovery

**`grid_reconcile.ts:373-445`**

Up to 3 batch attempts. Each failure triggers recovery sync + plan refresh. If plans empty → resolved. After 3× → sequential fallback with per-plan recovery (each individual failure triggers recovery sync + queue refresh).

### Phantom Orders via Reconcile

**`grid_reconcile.ts:210-223`** — Reconcile's role in the defense-in-depth: during Phase 1, any ACTIVE/PARTIAL order whose `orderId` is not found on-chain is reset to VIRTUAL. See [`developer_guide.md`](developer_guide.md#phantom-orders-prevention-defense-in-depth) for the full 3-layer defense.

### COW Interaction

Reconcile Phase 1 runs under `_gridLock` with no side effects on the frozen master Map. The working grid is not involved — reconcile is a startup operation that runs before the COW pipeline is active. See [`COPY_ON_WRITE_MASTER_PLAN.md`](COPY_ON_WRITE_MASTER_PLAN.md#safety-guardrails) and [`COW_INVARIANTS.md`](COW_INVARIANTS.md#reconcile) for COW rules.

### Truncated-Read Ambiguity (1.4.8)

**`grid_reconcile_internal.ts`** — every chain read feeding an absence/surplus decision goes through `readOpenOrdersWithMeta` and treats an empty or truncated snapshot as *unreadable* — never as "nothing landed" or "nothing to cancel":

- `_recoverSyncFromChain` (plus its three recovery sites in `_createOrderFromGrid`/`_cancelChainOrder`), `_adoptPossiblyLandedCreate`, and the startup group-batch uncertain verification all defer on empty/truncated reads — pass-1 phantom cleanup would otherwise virtualize live slots from a partial window, and a truncated window omits exactly the batch's freshest creates.
- Phase 3 final refresh skips adoption/surplus-cancel on a truncated read, keeping the pre-Phase-2 counts for the summary log.
- Adoption paths (`_adoptPossiblyLandedCreate`, group path, reconcile adoption loop) apply the create-fee deduction via `_applySync` for accounting parity.

The underlying rule is `INV-BROADCAST-004`: a capped `get_full_accounts` window omits the freshest orders (fresh creates sort last), so absence can never be authoritative on a truncated read.

---

## Lock Hierarchy

**`manager.ts:390-406`** — Full canonical reference in [`developer_guide.md`](developer_guide.md#lock-ordering-for-deadlock-prevention).

```
Level 0: _fillProcessingLock    Level 1: _divergenceLock
Level 2: _syncLock              Level 3: _gridLock
Level 4: _fundLock
```

Acquire in ascending level order only. AsyncLock is re-entrant (nested `acquire()` runs directly, not queued).

### Historical Correction (1.4.6)

Before 1.4.6, `_syncLock` was Level 3 and `_gridLock` was Level 2, causing ABBA deadlock when reconcile needed `_gridLock` (old Level 2) while holding `_syncLock` (old Level 3). The workaround flag `gridLockAlreadyHeld` patched 8 call sites.

Commit `705cde9c` fixed it: swapped levels (`_syncLock → 2`, `_gridLock → 3`), eliminated the flag, and restructured Phase 1 to be pure in-memory so no RPC calls run under `_gridLock` ([`developer_guide.md` §Startup Sequence](developer_guide.md#startup-sequence--lock-ordering)).

### Nesting Safety (1.4.6)

Commit `e64db685` replaced 6 single-value boolean state fields with refcounts/stacks to prevent premature resume from re-entrant nested acquisitions.

---

## Key Constants

| Constant | Value | File | Role |
|----------|-------|------|------|
| `SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER` | `5` | `grid_reconcile.ts:15` | Amplifies base tolerance for duplicate detection |
| `maxBatchAttempts` | `3` | `grid_reconcile.ts:375` | Update batch retry limit |
| `PRICE_TOLERANCE_MAX_PERCENT` | `0.01` (1%) | `constants.ts:429` | Cap on price tolerance |
| `PRICE_TOLERANCE_MIN_ABSOLUTE` | `0.0001` | `constants.ts:433` | Floor for price tolerance |
| `PIPELINE_TIMING.TIMEOUT_MS` | `300000` (5min) | `constants.ts` | Reconcile timeout override |

---

## Test Coverage

| Test File | Coverage |
|-----------|----------|
| `tests/test_grid_reconcile.ts` | 8: edge detection, largest-order, ordering |
| `tests/test_grid_reconcile_regressions.ts` | 6: unmatched cancel, verifiedAfterFailure, slot-mapped skip, storeGrid await, matchedOnGrid guard, Phase 3 surplus |
| `tests/test_resync_duplicate_race.ts` | Phase 2 duplicate race |
| `tests/test_resync_balance_fix.ts` | Fund reuse during Phase 2 |
| `tests/test_resync_invariants.ts` | Fund invariant suppression during transient resync state |
| `tests/test_grid_reconcile_regressions.ts` | Regression 1b: empty refetch after verified cancel defers sync (1.4.8) |
| `tests/test_uncertain_broadcast.ts` | Startup uncertain-create adoption + truncated-read deferral (UNC-013e–g, 1.4.8) |
| `tests/test_race_condition_fixes_batch1.ts` | ABBA deadlock (RC-1B) |
| `tests/test_async_lock_force_release.ts` | Nested multi-lock re-entrancy |
| `tests/test_targeted_drift_reconcile.ts` | Active-order shortfall triggers sync |
| `tests/repro_phantom_orders.ts` | Phantom order prevention |

---

## File Reference

| File | Role |
|------|------|
| `modules/order/grid_reconcile.ts` | Public API + 3-phase orchestrator (538 lines) |
| `modules/order/grid_reconcile_internal.ts` | Internal helpers — `_reconcileStartupSide`, edge detection, batch/sequential execution (1169 lines) |
| `modules/order/manager.ts` | Lock hierarchy definition, `_applyOrderUpdate`, phantom guard, `reconcileGrid` entry point, COW integration |
| `modules/order/async_lock.ts` | AsyncLock engine with ALS re-entrancy (385 lines) |
| `modules/order/sync_engine.ts` | Blockchain sync pipeline |
| `modules/order/grid.ts` | Grid creation, `recalculateGrid` calls reconcile |
| `modules/constants.ts` | Timing, tolerance, retry constants |
