# Copy-on-Write (COW) Grid Master Plan

**Author:** froooze  
**Status:** Implemented & Stabilized  
**Objective:** Eliminate optimistic state corruption by separating "Blockchain Truth" from "Strategy Targets" using immutable master grids and Copy-on-Write semantics.

## Overview

The Copy-on-Write (COW) Grid Architecture replaces the old optimistic mutation pattern with a cleaner approach: **master grid is never modified until blockchain confirmation**.

This architecture implements the core philosophy of **"Verify, Then Commit"**:

1. **Immutable Master Grid:** The master grid is never directly modified during planning.
2. **Atomic Promotion:** Changes only move from working copy to master upon verified blockchain success.
3. **Delta-Only Execution:** Only the difference between Master and Target triggers blockchain actions.
4. **Side Invariance:** Order side (BUY/SELL) is absolute. Any price-flip requires a full `Cancel` → `Place` sequence.

## Architecture

### COW Pattern

```
1. Create WorkingGrid (clone of master)
2. Modify working copy
3. Broadcast to blockchain
4. On success: atomic swap (working → master)
5. On failure: discard working (master unchanged)
```

### Freeze + COW Hybrid

The production implementation uses both `Object.freeze()` and COW as complementary layers:

1. **`Object.freeze()`** on the master Map and `deepFreeze()` on individual order objects
   provides runtime enforcement — any accidental direct mutation throws in strict mode.
   Each `_applyOrderUpdate` call creates a new frozen Map via immutable-swap pattern:

   ```javascript
   const newMap = cloneMap(this.orders);
   newMap.set(id, deepFreeze({ ...nextOrder }));
   this.orders = Object.freeze(newMap);
   ```

2. **COW working grids** provide the planning/broadcast lifecycle isolation — strategy
   computes target state on a mutable clone, and master is only replaced after blockchain
   confirmation via `_commitWorkingGrid()`.

The freeze layer catches bugs that COW alone wouldn't (e.g., code that reads `manager.orders`
and mutates an order object in-place). The COW layer provides the transactional semantics
(plan, broadcast, commit-or-discard).

## State Machine

```
NORMAL → REBALANCING → BROADCASTING → _commitWorkingGrid() → NORMAL
                                          ↓ (on failure)
                                    _clearWorkingGridRef() → NORMAL
                                        (master unchanged)
```

**State transitions:**
- `NORMAL → REBALANCING`: `_applySafeRebalanceCOW()` begins planning.
- `REBALANCING → BROADCASTING`: `_updateOrdersOnChainBatchCOW()` starts blockchain ops.
- `BROADCASTING → NORMAL`: `_clearWorkingGridRef()` always called on exit (success or failure).
- Fill during `REBALANCING`/`BROADCASTING`: marks working grid stale, syncs order from master.

**COW State Machine Cheat Sheet:**

| State | Fill Handling | Working Grid Action | Commit Outcome |
|-------|---------------|---------------------|----------------|
| `NORMAL` | Apply fill to master immediately | No working-grid sync | Not applicable |
| `REBALANCING` | Apply fill to master immediately | Mark stale + sync changed order from master | Planning returns aborted result |
| `BROADCASTING` | Apply fill to master immediately | Mark stale + sync changed order from master | Commit guard rejects stale/version-mismatch grid |

**Single-source rules (no special cases):**
- Master grid always updates first (blockchain truth).
- If planning/broadcasting is active, sync the changed order into the working grid.
- Any master mutation marks the working grid stale.
- Commit succeeds only when stale/version/delta guards all pass.

## Data Flow

### Normal Rebalance Flow

```
1. performSafeRebalance(fills, excludeIds)
   └─> _applySafeRebalanceCOW()
       ├─> Create WorkingGrid (clone master)
       ├─> Calculate target grid (from strategy)
       ├─> Reconcile against working copy
       ├─> Validate working grid funds
       └─> Return { workingGrid, actions, ... }

2. updateOrdersOnChainBatch(result)
   └─> _updateOrdersOnChainBatchCOW()
        ├─> Lock order IDs
        ├─> Build blockchain operations
        ├─> Pre-broadcast staleness guard (evaluateCommit):
        │   ├─> Plan stale (master mutated mid-planning) => replanStaleBatch:
        │   │   ├─> Re-plan ONCE from fresh master with same fills
        │   │   ├─> Restore boundary-shift budget + clear only the abandoned
        │   │   │   batch's own pending-broadcast entries
        │   │   ├─> No executable actions => skip stale plan (grid already consistent)
        │   │   └─> Still stale / no fill context => proceed + structural resync
        │   └─> Plan valid => continue
        ├─> Execute batch
        ├─> On success:
        │   ├─> _commitWorkingGrid()  → atomic swap
        │   │   └─> commit refused (master changed during broadcast)
        │   │       └─> adopt placed orders from chain; keep pending-broadcast
        │   │           protection + structural resync if adoption unavailable
        │   └─> persistGrid()          → write to disk
        └─> On failure:
            └─> workingGrid discarded (master unchanged)
```

### Fill Processing Flow

```
NEW FILL ARRIVES
   │
   ▼
[ Type of update? ]
   │
   ├─ individual fill (boundary shift only)
   │     update master grid
   │     sync working grid if planning active
   │     continue current operations
   │
   └─ full side update (divergence / cache threshold)
         │
         ├─ BROADCASTING  => abort; discard working grid
         ├─ REBALANCING   => block; wait for fills=0
         └─ NORMAL        => safe to proceed
```

## Fill Handling Strategy

**Decision:** "Selective abort — continue individual fills, block full-side updates."

| Scenario | Scope | Action | Reason |
|----------|-------|--------|--------|
| Individual fill | Single slot (boundary shift) | Process immediately | Just moves boundary, doesn't modify filled order. Low risk. |
| Divergence-triggered full update | Entire side of grid | Block if fills pending | Rebuilding all orders — needs stable state, no concurrent fills. |
| Cache threshold full update | Entire side of grid | Block if fills pending | Rebalancing depleted side — complex planning, can't have stale data. |

### Individual Fills (Grid Maintenance)

- Only move boundary and handle next slot — **don't modify the filled order itself**.
- Fills keep the grid alive by shifting the boundary as market moves.
- Low risk, can sync to working grid and continue current rebalance.
- **Never abort blockchain operations for individual fills.**

### Full Side Updates (Major Planning)

- Divergence: rebuild entire side of grid (potentially dozens of orders).
- Cache threshold: rebalance all orders on depleted side.
- High risk — complex planning that shouldn't run with stale state.
- **Block if fills pending or during `BROADCASTING`.**

**Key distinction:** individual fills move the boundary; full updates rebuild everything.

### Divergence & Cache Checks Blocked During Rebalance

```javascript
if (fills.length === 0 && rebalanceState === REBALANCE_STATES.NORMAL) {
    // Safe to check divergence
    // Safe to update cache functions
}
```

**Why this restriction:**
- Divergence calculations assume stable grid state.
- Fills modify the grid mid-calculation.
- Cache updates must reflect committed state, not speculative working state.
- Prevents race conditions between fill processing and cache invalidation.

### Working Grid Synchronization

When fills arrive during `REBALANCING` state (before `BROADCASTING`):

1. Update master grid immediately (blockchain truth).
2. **Also apply same fill to working grid** (keep copies in sync).
3. Continue with current rebalance using updated working copy.

```javascript
// Implementation in _applyOrderUpdate (manager.ts)
async _applyOrderUpdate(order, context, options = {}) {
    // ... update master grid (immutable swap) ...

    // Centralized adapter handles:
    // 1) planning-state gate,
    // 2) markStale(),
    // 3) syncFromMaster(),
    // 4) sync error handling.
    this._syncWorkingGridFromMasterMutation(order.id, context);
}

// WorkingGrid.syncFromMaster (working_grid.ts)
syncFromMaster(masterGrid, orderId, masterVersion?) {
    const masterOrder = masterGrid.get(orderId);
    if (masterOrder) {
        this.grid.set(orderId, this._cloneOrder(masterOrder));
        this.modified.add(orderId);
        this._indexes = null;
    }
    if (Number.isFinite(masterVersion)) {
        this.baseVersion = masterVersion;
    }
}
```

**Why this matters:**
- Working grid must reflect all blockchain state changes.
- Prevents stale data from being committed.
- Avoids unnecessary aborts for individual fills.

## Historical Context: Immutable Master Grid Evolution

The COW architecture evolved from earlier attempts to achieve grid immutability. The three
eras below describe design evolution over time; they are **distinct from the Build Steps**
numbered 0–9 in the *Implementation Status* section (Build Steps track the construction
work that produced the current code).

### Era 0: Original Optimistic State (Pre-v1.0) — ❌ Removed
- **Approach:** Direct in-memory mutation of master grid during planning.
- **Pattern:** Modify master directly → Broadcast to blockchain → No recovery mechanism.
- **Vulnerability:** State corruption during any failure, no isolation between planning and committed state, no rollback capability.
- **Incident:** This approach caused the Price Jump incident — a sudden market move corrupted in-flight grid state because planning mutations were applied directly to the master grid, with no isolation or rollback.

### Era 1: Frozen Master State (v1.0) — ✅ Retained as defense-in-depth
- **Approach:** `Object.freeze()` on Maps and order objects.
- **Implementation:** Each `_applyOrderUpdate` creates a new frozen Map via immutable-swap pattern.
- **Advantage:** Runtime enforcement prevents accidental mutations; catches bugs that read `manager.orders` and mutate in-place.
- **Original concern:** Performance overhead, complexity in deep-freezing nested structures.

### Era 2: Copy-on-Write (v2.0 — Current) — ✅ Production-ready
- **Approach:** Working copy during planning, atomic swap on blockchain confirmation.
- **Pattern:** Clone → Modify working copy → Broadcast → Commit on success / Discard on failure.
- **Advantage:** True transactional semantics; master never in intermediate state; cleaner than snapshot/rollback.

The production implementation uses both Era 1 (`Object.freeze`) and Era 2 (COW) as
complementary layers; see **Freeze + COW Hybrid** under *Architecture* above.

## Implementation Status

Build Steps track the construction work that produced the current code; they are distinct
from the *Era* numbering used in *Historical Context*.

### Build Step 0: Dependencies ✅
Dependency utilities merged into `modules/order/utils/order.ts` during v0.6.0-patch.19 consolidation.

### Build Step 1: Infrastructure ✅
- Created `modules/order/working_grid.ts` — WorkingGrid class.
- Added `COW_PERFORMANCE` thresholds to `modules/constants.ts`.

### Build Step 2: Core Integration ✅
- `performSafeRebalance()` → delegates to `_applySafeRebalanceCOW()`.
- `_applySafeRebalanceCOW()` — creates working grid, runs planning, returns result without modifying master.
- `WorkingGrid.buildDelta()` — delta reconciliation against working copy (`modules/order/working_grid.ts:204`, delegating to `utils/order.ts`).
- `_commitWorkingGrid()` — atomic swap from working to master.

### Build Step 3: Broadcast Integration ✅
- `updateOrdersOnChainBatch()` — routes to COW path when `workingGrid` present.
- `_updateOrdersOnChainBatchCOW()` — full COW broadcast with commit on success.
- Removed legacy rollback code.

### Build Step 4: Fill Handling Strategy ✅
**Decision:** "Selective abort — continue individual fills, block full-side updates."  
Full design is documented in the **Fill Handling Strategy** section above.

### Build Step 5: Tests ✅
- `tests/test_cow_master_plan.ts` — 11 COW core tests.
- `tests/test_cow_commit_guards.ts` — commit guard regression tests.
- `tests/test_cow_concurrent_fills.ts` — concurrent fill integration tests.
- `tests/test_cow_divergence_correction.ts` — divergence correction COW tests.
- `tests/test_cow_orchestration_fixes.ts` — COW orchestration fixes.
- `tests/test_cow_structural_resync.ts` — structural grid resync tests.
- `tests/test_cow_static_analysis.ts` — static analysis and invariant checks.
- `tests/test_cow_index_mutation_detection.ts` — index mutation detection.
- `tests/test_cow_fund_validation_precision.ts` — fund validation precision tests.
- `tests/test_cow_set_mutation_report.ts` — set mutation report tests.
- `tests/test_sync_lock_routing.ts` — lock routing verification tests.
- `tests/test_working_grid.ts` — WorkingGrid unit tests.

### Build Step 6: Divergence & Cache Updates ✅
Divergence checks and cache function updates only execute when no fills are pending. See
**Fill Handling Strategy → Divergence & Cache Checks Blocked During Rebalance**.

### Build Step 7: Divergence Correction COW Migration ✅
Migrated `applyGridDivergenceCorrections` from queue-based cancellations to full COW pattern.

**Atomic Boundary Shifts (Patch 20):** Boundary index changes during divergence correction are
now atomic with slot-type reassignment. The `pendingBoundaryIdx` variable carries boundary
changes through the COW pipeline without touching `manager.boundaryIdx` until
`_commitWorkingGrid` completes. This prevents temporary mismatches between boundary position
and slot BUY/SELL roles during blockchain execution.

```javascript
// Boundary changes flow through COW pipeline atomically
const boundarySync = syncBoundaryToFunds(manager);  // Returns { changed, newIdx }
if (boundarySync.changed) {
    pendingBoundaryIdx = boundarySync.newIdx;  // NOT manager.boundaryIdx!
    // updateGridFromBlockchainSnapshot reassigns slot types in WorkingGrid
    // manager.boundaryIdx updated atomically in _commitWorkingGrid
}
```

**Before (Queue-Based):**
```javascript
// Detect divergence → Queue corrections → Execute batch → Clear queue
// Master grid stays ACTIVE during entire process (race condition)
ordersNeedingPriceCorrection.push({ gridOrder, chainOrderId, isSurplus: true });
// ...later...
await updateOrdersOnChainBatchFn({ ordersToCancel, ordersToPlace, ordersToRotate });
```

**After (COW-Based):**
```javascript
// Detect divergence → Create WorkingGrid → Update sizes in working copy
// → Execute UPDATE/CANCEL/CREATE ops on chain → Commit working grid on success
const workingGrid = new WorkingGrid(manager.orders);
workingGrid.set(orderId, convertToSpreadPlaceholder(order)); // Surplus → virtual slot
const actions = [{ type: COW_ACTIONS.CANCEL, id, orderId }, ...];
const cowResult = { actions, workingGrid, ... };
await updateOrdersOnChainBatch(cowResult); // Commit only on success
```

**Key Changes:**
1. **Surplus orders**: `CANCEL` on-chain and virtualize in working grid.
2. **State preservation**: `ACTIVE`/`PARTIAL` orders keep their state in working grid.
3. **No race conditions**: master unchanged until blockchain confirms.
4. **Unified flow**: same COW pattern as fill rebalancing.

**Grid Resizing Also Migrated:** `updateGridFromBlockchainSnapshot` now returns a COW result:

```javascript
// Before: Modified master grid directly
await Grid.updateGridFromBlockchainSnapshot(manager, 'buy'); // Direct update!

// After: Returns COW result for batch execution
const cowResult = await Grid.updateGridFromBlockchainSnapshot(manager, 'buy');
await updateOrdersOnChainBatch(cowResult); // Execute via COW
```

### Build Step 8: Benchmarks ✅
- 100 orders: ~0.03ms clone
- 500 orders: ~0.05ms clone
- 1000 orders: ~0.08ms clone
- 5000 orders: ~0.5ms clone

### Build Step 9: Cleanup ✅
- Removed snapshot/rollback pattern; `performSafeRebalance()` now delegates to `_applySafeRebalanceCOW()`.
- Removed duplicate `_updateOrdersOnChainBatchCOW`.
- Removed legacy rollback references in `dexbot_class.ts`.

## Key Methods

### OrderManager (`modules/order/manager.ts`)

| Method | Description |
|--------|-------------|
| `performSafeRebalance(fills, excludeIds)` | Entry point — delegates to COW |
| `_applySafeRebalanceCOW(fills, excludeIds)` | Creates working grid, runs planning |
| `WorkingGrid.buildDelta(masterGrid)` | Delta between master and working copy (`modules/order/working_grid.ts:204`, delegating to `utils/order.ts`) |
| `_commitWorkingGrid(workingGrid, indexes, boundary, options = {})` | Atomic swap to master |
| `_setRebalanceState(state)` | Track rebalance state |
| `_currentWorkingGrid` | Reference to working grid during rebalance for fill sync |
| `_applyOrderUpdate(order, context, options = {})` | Lock-free order update (immutable swap); routes fill sync to `_syncWorkingGridFromMasterMutation` |
| `_syncWorkingGridFromMasterMutation(orderId, context)` | Adapter: planning-state gate → `markStale()` + `syncFromMaster()` → sync error handling |

### DEXBot (`modules/dexbot_class.ts`)

| Method | Description |
|--------|-------------|
| `updateOrdersOnChainBatch(rebalanceResult)` | Routes to COW broadcast |
| `_updateOrdersOnChainBatchCOW(rebalanceResult)` | Full COW broadcast with commit |

### WorkingGrid (`modules/order/working_grid.ts`)

| Method | Description |
|--------|-------------|
| `syncFromMaster(masterGrid, orderId, masterVersion?)` | Sync specific order from master to working grid during fill processing |
| `buildDelta(masterGrid)` | Build delta actions between master and working grid |
| `getIndexes()` | Get cached grid indexes |

## Operational Rules

### 1. Fill Priority Always Wins
Filled orders are blockchain truth and always processed immediately. See the
**Fill Handling Strategy** section for the full Individual Fills vs Full Side Updates rules.

### 2. Divergence & Cache Checks Blocked During Rebalance
Divergence detection and cache function updates are deferred when fills are pending or when
rebalancing is in progress. See **Fill Handling Strategy → Divergence & Cache Checks Blocked
During Rebalance**.

## Safety Guardrails

1. **Accountant Dry-Run:** `Accountant.validateTargetGrid(targetMap)` verifies that the entire proposed grid fits within `Liquid + CurrentOrderValue` *before* broadcasting.
2. **Atomic Transaction Semantics:** Large boundary shifts (>5 slots) are inherently safe because the COW pattern only commits after successful blockchain confirmation. If market volatility causes rapid shifts during planning, the plan is caught by the **pre-broadcast staleness guard** (`evaluateCommit` against `_gridVersion`): it re-plans ONCE from the fresh master with the same fills (`replanStaleBatch`, bounded by `STALE_PLAN_REPLAN_LIMIT`), then proceeds + structural resync if still stale — never a silent discard that drops the fill set. If the master changes *during* broadcast, the commit-time guard refuses the commit and the placed orders are adopted from chain so on-chain state never runs ahead of the grid.
3. **Resync on Error:** If any blockchain action fails (e.g., "Insufficient funds"), the bot discards the working grid and triggers `grid_reconcile.ts` for a fresh blockchain sync ([GRID_RECONCILE.md](GRID_RECONCILE.md)).

## Backward Compatibility

None. COW is the **only standard**. The old snapshot/rollback pattern has been completely removed.

## Verification

This architecture makes the "Metadata Reinterpretation" bug impossible by ensuring that memory is only a reflection of verified blockchain state. The master grid is never partially modified — it's either the old state or the new state, with no intermediate "limbo" states.

---

## Appendix A: Files

### Files Created
- `modules/order/working_grid.ts` — WorkingGrid class (COW wrapper with clone/delta/stale tracking).
- Test files listed under **Build Step 5**.
- *Dependency utilities consolidated into `modules/order/utils/order.ts` during v0.6.0-patch.19.*

### Files Modified
- `modules/constants.ts` — added `COW_PERFORMANCE` thresholds.
- `modules/order/manager.ts` — added COW methods, immutable master (`Object.freeze`), version tracking.
- `modules/dexbot_class.ts` — wired COW broadcast, removed legacy rollback.
- `modules/order/sync_engine.ts` — uses `_applyOrderUpdate` (lock-free) for all sync paths.
- `modules/order/grid_reconcile.ts` — uses `_applySync` (lock-free) when inside `_gridLock`.
- `modules/order/utils/system.ts` — migrated `applyGridDivergenceCorrections` to full COW pattern.
- `modules/order/grid.ts` — migrated `updateGridFromBlockchainSnapshot` to return COW result instead of modifying master directly.

## Appendix B: Test Results

```
Core COW Tests (test_cow_master_plan.ts):
  ✓ COW-001: Master unchanged on failure
  ✓ COW-002: Master updated only on success
  ✓ COW-003: Index transfer
  ✓ COW-004: Fund recalculation
  ✓ COW-005: Order comparison
  ✓ COW-006: Delta building
  ✓ COW-007: Index validation
  ✓ COW-008: Working grid independence
  ✓ COW-009: Empty grid handling
  ✓ COW-010: Memory stats
  ✓ COW-011: No spurious updates on unchanged grid

Commit Guard Tests (test_cow_commit_guards.ts):
  ✓ COW-COMMIT-001: Version mismatch rejection
  ✓ COW-COMMIT-002: Empty delta rejection

Concurrent Fill Tests (test_cow_concurrent_fills.ts):
  ✓ COW-FILL-001: Fill during REBALANCING syncs to working grid
  ✓ COW-FILL-002: Fill during BROADCASTING syncs to working grid
  ✓ COW-FILL-003: Commit rejected after fill during broadcast
  ✓ COW-FILL-004: No working grid sync during NORMAL state
  ✓ COW-FILL-005: _cloneOrder deep-clones rawOnChain
  ✓ COW-FILL-006: _cloneOrder handles missing rawOnChain
  ✓ COW-FILL-007: Staleness reason includes phase context

Divergence Correction Tests (test_cow_divergence_correction.ts):
  ✓ Surplus orders are CANCELLED (not UPDATE to size=0)
  ✓ Working grid preserves order states (ACTIVE, PARTIAL)
  ✓ Orders within target window get size updates
  ✓ No duplicate UPDATE/CANCEL overlap for same order

Stale-Plan & Stack Discipline Tests (v1.4.8):
  ✓ test_cow_guard_replan.ts — bounded re-plan from fresh master, boundary-budget
    restore, push-marker contract, no double-pop on re-plan failure
  ✓ test_cow_stale_slot_guard.ts — slot-id based stale-placement veto,
    boundary-only semantics, rotation-UPDATE coverage
  ✓ test_cow_commit_guards.ts — empty-action / never-pushed marker contract
  ✓ test_uncertain_broadcast.ts — verify-before-retry per op kind, truncated-read
    deferral, pending-broadcast protection kept on ambiguous reads
```

**Additional Checks:**
- Unchanged grids do not emit global COW `update` actions.
- Missing on-chain `ACTIVE` order with `orderId` appears in `filledOrders` from open-order sync.

## Appendix C: Constants Added (`modules/constants.ts`)

### COW Performance Thresholds
- `COW_PERFORMANCE.MAX_REBALANCE_PLANNING_MS` — planning-phase duration above which a slow-plan warning is logged (100ms).
- `COW_PERFORMANCE.GRID_MEMORY_WARNING` — working grid size (bytes) that triggers a memory warning (5,000).
- `COW_PERFORMANCE.WORKING_GRID_BYTES_PER_ORDER` — estimated memory per order (500 bytes).
- `COW_PERFORMANCE.MAX_OPS_PER_BROADCAST` — maximum order operations (creates, updates, cancels) per broadcast transaction (4); larger batches are split into sequential broadcasts.

### Pipeline Timing
- `PIPELINE_TIMING.RECOVERY_DECAY_FALLBACK_MS` — recovery decay fallback (180 seconds).

### Grid & Timing
- `GRID_LIMITS.RELATIVE_ORDER_UPDATE_THRESHOLD_PERCENT` — relative threshold (%) for in-memory COW order equality checks.
- `TIMING.LOCK_REFRESH_MIN_MS` — minimum lock refresh interval (250ms).

## Appendix D: Validation Gates

Run these tests before promotion:
- `tsx tests/test_engine_integration.ts`
- `tsx tests/test_sequential_multi_fill.ts`
- `tsx tests/test_sync_logic.ts`
- `tsx tests/test_ghost_order_fix.ts`
- `tsx tests/test_working_grid.ts`
- `tsx tests/test_cow_master_plan.ts`
- `tsx tests/test_cow_commit_guards.ts`
- `tsx tests/test_cow_concurrent_fills.ts`
- `tsx tests/test_cow_divergence_correction.ts`