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

The reconcile runs from [`recalculateGrid`](../modules/order/grid.ts) during startup full-resync. **There is no per-attempt wall-clock race around the reconcile itself** — an outer timeout would fire mid-batch and orphan in-flight broadcasts (the duplicate-accumulation death spiral). The reconcile is bounded only by the 10-minute total resync safety net, and every internal chain read follows the shared guarded-read standard.

Phase 1 does all reasoning in memory under `_gridLock` (fast); Phases 2 and 3 execute outside the lock — holding a lock across RPC calls would block fills, sync, and divergence checks for hundreds of milliseconds each. All execution operations in Phases 2–3 re-acquire `_gridLock` individually (via `synchronizeWithChain` / per-op guards) so the lock is held briefly per operation, never for an entire phase.

Phase 2 and 3 both respect the `dryRun` flag: when true, no on-chain mutations are attempted — plans are logged but not executed.

`targetCount` (per side, `targetSell`/`targetBuy`) is sourced from bot config and determines how many active orders each side should maintain. The internal `planOnly` flag controls whether `_reconcileStartupSide` records plans for Phase 2 or executes inline — Phase 1 always calls with `planOnly=true`.

```
                    Grid generated
                            │
                            ▼
┌──────────────────────────────────────────────────┐
│  PHASE 1: Planning (under _gridLock)             │
│                                                  │
│  • Sanitize phantom orders (ACTIVE/PARTIAL with  │
│    orderId absent on-chain → VIRTUAL, skip);     │
│    defer freshly-assigned orderIds, ghost pass   │
│  • Detect suspected duplicates (within 5× tol) → │
│    queue for Phase 2 cancel                      │
│  • Match unmatched chain orders to virtual slots │
│    → plan updates                                │
│  • Detect grid-edge lockup → plan largest-order  │
│    cancel to free funds                          │
│  • Detect excess chain orders → plan cancels     │
│  • No on-chain RPC calls inside this phase       │
└──────────────────┬───────────────────────────────┘
                   ▼
   returns { plannedCreates, plannedUpdates, plannedCancels }
┌──────────────────────────────────────────────────┐
│  PHASE 2: Execution (outside _gridLock)          │
│                                                  │
│  1. Cancellations — duplicates, edge releases,   │
│     excess chain orders                          │
│  2. Updates — batch (3 retries), then sequential │
│     fallback with per-failure recovery sync      │
│  3. Creates — outside-in pairing (outermost grid │
│     slots first, BUY desc / SELL asc), batched   │
│     where the DEX supports batch creates;        │
│     uncertain lands adopt; created IDs tracked   │
│     for Phase-3 protection                       │
└──────────────────┬───────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────┐
│  PHASE 3: Fresh Count + Stale Surplus Cleanup    │
│                                                  │
│  • Re-fetch chain state after Phase 2 (guarded)  │
│  • Adopt uncertain-landed creates into VIRTUAL   │
│    slots                                         │
│  • Protect Phase-2 created IDs from surplus      │
│    cancel                                        │
│  • Cancel orders exceeding per-side target not   │
│    tracked by any grid slot's orderId (orphans)  │
└──────────────────────────────────────────────────┘
```

### Phase 1 — Pure Planning Under `_gridLock`

**`grid_reconcile.ts:205-356`**

1. **Phantom order sanitization** (lines 211-244): For each `isOrderPlaced()` order whose `orderId` is not in the chain snapshot, reset it to VIRTUAL with `skipAccounting` to prevent fund inflation. Two absence-decision guards make this safe:
   - **Freshly-assigned deferral** (lines 215-233): an `orderId` assigned within `TIMING.SYNC_LOCK_TIMEOUT_MS` (via `manager._orderIdAssignedAt`) may be an in-flight create/adopt whose broadcast has not landed or is not yet visible to a lagging/truncated read — virtualizing it and re-creating would duplicate a real live order (the reconcile-timeout death-spiral root cause). It is skipped (deferred) rather than virtualized.
   - **Ghost heuristic** (line 225): an order with `size <= 0` && `PARTIAL` (a known filled ghost) still passes through so known fills get cleaned up.
   - Virtualization always uses `{ skipAccounting: true }` so startup cleanup never inflates `ChainFree`.

2. **Duplicate detection** (lines 246-311): For each unmatched chain order, find the nearest active same-side grid order. If `priceDiff ≤ tolerance × 5`, flag it as a suspected duplicate and queue for a Phase 2 cancel (never cancelled under lock). Tolerance is computed from price impact via `calculatePriceTolerance`: capped at `PRICE_TOLERANCE_MAX_PERCENT` (1%) with a `PRICE_TOLERANCE_MIN_ABSOLUTE` (0.0001) floor. Duplicate IDs are removed from the unmatched set so they aren't also paired for updates/creates.

3. **Per-side reconciliation** via `_reconcileStartupSide(planOnly=true)` (lines 323-353):
   - Count `matchedOnGrid` (active grid orders with `orderId`)
   - `neededSlots = targetCount - matchedOnGrid`; pick virtual slots to activate
   - Match sorted unmatched chain orders to virtual slots → `plannedUpdates`
   - Detect grid-edge lock and plan a largest-order cancel
   - Plan creates for remaining slots
   - Plan excess cancellations (guarded by `matchedOnGrid > 0`)

Returns `{ plannedCreates, plannedUpdates, plannedCancels, chainSellCount, chainBuyCount }`.

### Phase 2 — Blockchain Execution Outside Lock

**`grid_reconcile.ts:358-480`**

Each sub-phase releases `_gridLock` before starting and re-acquires it per operation (through `synchronizeWithChain` in individual helpers). No single long-held lock blocks fills, sync, or divergence checks — but each operation still runs under the lock for consistency.

**Cancellations** (lines 366-391): Execute `plannedCancels`. Each `_cancelChainOrder` acquires `_gridLock` internally. This covers duplicate cancels, edge-release cancels, and excess-order cancels.

**Updates** (lines 393-465):
- Batch via `_executeStartupUpdateBatch` when `supportsBatchUpdate` is available
- Retry up to 3× (`maxBatchAttempts = 3`)
- On each failure: `_recoverStartupSyncFailure()` re-fetches open orders from chain (guarded read) and re-syncs `manager` state via `manager.syncFromOpenOrders()`, then `_refreshStartupUpdatePlans()` rebuilds plans against the fresh chain state
- If retries exhausted or batch helpers are unavailable → `_executeStartupSequentialUpdateFallback()` one-by-one with per-failure recovery

**Creates** (lines 467-480): `_executePlannedStartupCreates` runs with the outside-in pair grouping — grouped from the outermost grid slots toward the center, BUY descending / SELL ascending, so the most price-critical orders are placed first. BitShares DEX batch-create operations are used where supported. Every created chain ID is captured into `phase2CreatedOrderIds` so Phase 3 cannot later cancel the freshly-created orders.

### Phase 3 — Fresh Re-read, Adoption, Stale Surplus Cleanup

**`grid_reconcile.ts:502-631`** (guarded by `if (!dryRun)` at line 504)

1. **Guarded fresh re-read** (lines 512-516): `readOpenOrdersGuarded` re-fetches all open orders. On a truncated/empty read it returns early (defers), keeping the pre-Phase-2 counts for the summary log — a capped window omits exactly the freshest Phase-2 creates.

2. **Adopt uncertain-landed creates** (lines 533-578): For any fresh chain order not matching a grid `orderId` and not created by a slot, it attempts targeted slot adoption — matching a VIRTUAL slot by type+price+size (within tolerance) and registering it via `_applySync(..., 'createOrder')` with the create-fee deduction. Full `syncFromOpenOrders` is deliberately **not** used here (its pass-1 virtualizes ACTIVE slots missing from the snapshot, and a lagging read right after the Phase-2 broadcast would destroy the confirmed grid). If adoption fails, the ID is still protected from surplus-cancel; the next sync loop's orphan adoption registers it.

3. **Stale surplus cancellation** (lines 579-599): Per side, count orders exceeding `targetCount` that no grid slot holds via `orderId` (including the phase-2 created IDs). Cancel only these untracked surplus orders, sorted by chain ID for determinism. This catches orphans lost during grid reinitialization — on-chain orders with no corresponding grid slot.

### Partial Failure State

If Phase 2 partially succeeds (some cancels, some creates fail), there is no rollback. The bot proceeds with the resulting state. Because the reconcile runs at startup before the fill pipeline activates, no fills are missed during this window. Remaining mismatches are caught by the next maintenance/structural divergence cycle or the next startup reconcile.

### Timeouts and Read Coverage

- **No per-attempt race** around the reconcile itself — the 1.4.8 change removed it to avoid orphaning mid-batch broadcasts (see the [`recalculateGrid`](../modules/order/grid.ts) call site in `modules/order/grid.ts`).
- The whole resync is bounded by a **10-minute total timeout** (`PIPELINE_TIMING.TIMEOUT_MS * 2` at `grid.ts:1122`), applied via `Promise.race` at `grid.ts:1217`.
- Every internal chain read goes through `readOpenOrdersGuarded` (`chain_orders.ts:611`) with the 30s / 3-retry / node-failover standard, and empty/truncated reads are treated as **ambiguous** — never as authoritative absence.

---

## Edge Cases (All Hit in Production or Code Review)

### Fresh Grid Guard (`matchedOnGrid > 0`)

**`grid_reconcile_internal.ts:1604-1616`**

When a brand-new grid is generated, every slot is VIRTUAL — `matchedOnGrid = 0`. Without a guard, every on-chain order appears "unmatched" and would be cancelled as excess:

```typescript
if (matchedOnGrid > 0 || neededSlots === 0) {
    cancelCount = Math.max(0, chainCount - targetCount);
}
```

When `matchedOnGrid === 0` AND scaling up (`neededSlots > 0`), excess cancellation is skipped — the guard covers both the fresh-grid scenario and the scale-down case (`neededSlots === 0`). Stale duplicates are still caught by the SUSPECTED DUPLICATE detection in Phase 1 of `reconcileGridOrders`.

### Grid-Edge Lock

**`grid_reconcile_internal.ts:259`** — `_isGridEdgeFullyActive` detects when the grid boundary is fully active (all slots on-chain) before cancelling excess orders.

When all outermost orders of a side are ACTIVE with `orderId`, all balance is committed to the edges. Cancel the **largest** order among the update candidates (`_cancelLargestOrder`, line 329) to free maximum funds with minimum operations, since the DEX does not expose partial-reduce in one operation. The cancelled slot gets a replacement create.

Detection (`_isGridEdgeFullyActive`, line 259): sort orders by price (BUY descending, SELL ascending), and check the outermost ones are all `isOrderPlaced()`.

### Duplicate Tolerance (5× Multiplier)

**`grid_reconcile.ts:246-311`**

`SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER = 5`. An unmatched chain order within 5× price tolerance of an active same-type grid slot is a suspected duplicate → queued for Phase 2 cancellation (not cancelled under lock). The base tolerance comes from `calculatePriceTolerance`, which estimates the maximum acceptable price deviation for the order's size and the grid's price step.

### Batch Update Failure Recovery

**`grid_reconcile.ts:393-465`**

Up to 3 batch attempts. Each failure triggers a recovery sync + plan refresh. If all plans are empty → resolved early. After 3× → sequential fallback with per-plan recovery (each individual failure triggers a recovery sync + queue refresh).

### Phantom Orders via Reconcile

**`grid_reconcile.ts:211-244`** — Reconcile's role in the defense-in-depth: during Phase 1, any ACTIVE/PARTIAL order whose `orderId` is not found on-chain is reset to VIRTUAL with `skipAccounting`. The freshly-assigned deferral protects in-flight broadcasts, and the ghost heuristic lets known fills pass. See [`developer_guide.md`](developer_guide.md#phantom-orders-prevention-defense-in-depth) for the full 3-layer defense.

### COW Interaction

Reconcile Phase 1 runs under `_gridLock` with no side effects on the frozen master Map. The working grid is not involved — reconcile is a startup operation that runs before the COW pipeline is active. See [`COPY_ON_WRITE_MASTER_PLAN.md`](COPY_ON_WRITE_MASTER_PLAN.md#safety-guardrails) and [`COW_INVARIANTS.md`](COW_INVARIANTS.md#reconcile-grid_reconcilemd) for COW rules.

### Truncated-Read Ambiguity (since 1.4.8)

Every chain read feeding an absence/surplus decision goes through `readOpenOrdersGuarded` (`chain_orders.ts:611`) and treats an empty or truncated snapshot as **unreadable** — never as "nothing landed" or "nothing to cancel":

- `_recoverSyncFromChain` (`grid_reconcile_internal.ts:607`) — plus its three recovery sites in `_createOrderFromGrid` / `_cancelChainOrder` — defers on empty/truncated reads (`deferEmpty: true`). A pass-1 phantom cleanup would otherwise virtualize live slots from a partial window.
- `_adoptPossiblyLandedCreate` (`grid_reconcile_internal.ts:947`) defers to an uncertain outcome on truncated reads, and the startup group batch uncertain verification follows the same rule.
- Phase 3 final refresh (`grid_reconcile.ts:512`) skips adoption/surplus-cancel on a truncated read, keeping the pre-phase-2 counts for the summary log.
- Adoption paths (`_adoptPossiblyLandedCreate`, grouping path, reconcile adoption loop) apply the create-fee deduction via `_applySync` for accounting parity.

The underlying rule is `INV-BROADCAST-004`: a capped `get_full_accounts` window omits the freshest orders (fresh creates sort last), so absence can never be authoritative on a truncated read.

---

## Lock Hierarchy

**`manager.ts:471-486`** — canonical reference in [`developer_guide.md`](developer_guide.md#lock-ordering-for-deadlock-prevention).

```
Level 0: _fillProcessingLock    Level 1: _divergenceLock
Level 2: _syncLock              Level 3: _gridLock
Level 4: _fundLock
```

Acquire in ascending level order only. AsyncLock is re-entrant (nested `acquire()` run directly, not queued).

### Historical Correction (1.4.6)

Before 1.4.6, `_syncLock` was Level 3 and `_gridLock` was Level 2, causing ABBA deadlock when reconcile needed `_gridLock` (old Level 2) while holding `_syncLock` (old Level 3). The workaround flag `gridLockAlreadyHeld` patched 8 call sites.

Commit `705cde9c` fixed it: swapped levels (`_syncLock → 2`, `_gridLock → 3`), eliminated the flag, and restructured Phase 1 to be purely in-memory so no RPC calls run under `_gridLock` ([`developer_guide.md` §Startup Sequence](developer_guide.md#startup-sequence--lock-ordering)).

### Nesting Safety (1.4.6)

Commit `e64db685` replaced 6 single-value boolean state fields with refcounts/stacks to prevent premature resume from re-entrant nested acquisitions.

---

## Key Constants

| Constant | Value | File | Role |
|----------|-------|------|------|
| `SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER` | `5` | `grid_reconcile.ts:20` | Amplifies base tolerance for duplicate detection |
| `maxBatchAttempts` | `3` | `grid_reconcile.ts:415` | Update-batch retry limit |
| `PRICE_TOLERANCE_MAX_PERCENT` | `0.01` (1%) | `constants.ts:452` | Cap on price tolerance |
| `PRICE_TOLERANCE_MIN_ABSOLUTE` | `0.0001` | `constants.ts:456` | Floor for price tolerance |
| `PIPELINE_TIMING.TIMEOUT_MS` | `300000` (5min) | `constants.ts:805` | Base pipeline timing; resync uses 2× (10 min) |

---

## Testing Coverage

| Test File | Coverage |
|-----------|----------|
| `tests/test_grid_reconcile.ts` | 8: grid detection, largest-order cancel, ordering |
| `tests/test_grid_reconcile_regressions.ts` | 6: unmatched-cancel guard, verifiedAfterFailure, slot-mapped skip, storeGrid await, `matchedOnGrid` guard, Phase 3 surplus; plus 1.4.8 regression 1b (empty refetch after verified cancel defers) |
| `tests/test_resync_duplicate_race.ts` | Phase 3 duplicate race |
| `tests/test_resync_balance_fix.ts` | Fund reuse during Phase 3 |
| `tests/test_resync_invariants.ts` | Fund invariant suppression during transient resync |
| `tests/test_uncertain_broadcast.ts` | Startup uncertain-create adoption + truncated-read deferral (UNC-013e–g, 1.4.8) |
| `tests/test_race_condition_fixes_batch1.ts` | ABBA deadlock (RC-1B) |
| `tests/test_async_lock_force_release.ts` | Nested multi-lock re-entrancy |
| `tests/test_targeted_drift_reconcile.ts` | Active-order shortfall triggers sync |
| `tests/repro_phantom_orders.ts` | Phantom order prevention |

---

## File Reference

| File | Role |
|------|------|
| `modules/order/grid_reconcile.ts` | Public API + 3-phase orchestrator (642 lines) |
| `modules/order/grid_reconcile_internal.ts` | Internal helpers — `_reconcileStartupSide`, grid detection, recovery, uncertainty (1690 lines) |
| `modules/order/manager.ts` | Lock hierarchy definition, `_applyOrderUpdate`, phantom guard, `reconcileGrid` entry, COW integration |
| `modules/order/async_lock.ts` | AsyncLock engine with ALS re-entrancy (424 lines) |
| `modules/order/sync_engine.ts` | Blockchain sync pipeline |
| `modules/order/grid.ts` | Grid creation, `recalculateGrid` (full resync) calls reconcile |
| `modules/chain_orders.ts` | `readOpenOrdersGuarded` / guarded read infrastructure |
| `modules/constants.ts` | Timing, tolerance, retry constants |
