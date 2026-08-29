# Orphan-Fill & Fund-Invariant Root Cause and Fix Plan

**Status:** Investigation complete — fix plan pending implementation
**Scope:** `modules/dexbot_cow_runtime.ts`, `modules/order/sync_engine.ts`, `modules/chain_orders.ts`, `modules/dexbot_state_recovery.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/order/strategy.ts`, `modules/constants.ts`
**Evidence source:** `profiles/logs/H-BTS.log` (Aug 28 17:40–17:57, Aug 29 15:13–15:19)

---

## TL;DR

The "orphan fill" and "fund invariant violation" are **one cascade**, and they are the
*upstream* cause of the slot-90 same-slot refill loop that was reported separately.

1. A **concurrency race** in the COW pipeline lets a fill batch plan against a stale master
   and double-place sell orders at price levels another in-flight batch already used.
2. When the second batch's **commit is refused** (`master mutation during rebalancing`), the
   freshly-placed chain orders are never written into the master grid.
3. The fallback adoption re-reads the **capped `get_full_accounts` window**, which truncates
   the *freshest* orders — exactly the ones just placed — and is also lossy (duplicate-price
   orphans are skipped). The master therefore stays divergent from chain.
4. The fund recalc then flags a **fund invariant violation**; recovery deletes the (now
   "corrupted") snapshot and regenerates the grid from a **truncated read**, permanently
   orphaning the two dropped orders.
5. Those orphans later **fill on chain with no grid slot** → `ORPHAN-FILL` (proceeds credited,
   slot never virtualized) → more invariant violations → recovery reloads a **stale boundary**,
   which is the exact condition that drives the slot-90 buy-re-stamp loop.

**The slot-90 "same-slot" placement originally reported is the *proximate* form of this
cascade** (detailed in Step 5 and the Rotation fix below): once the boundary is stale/detached
from the market, a partial fill + dust-cancel suppresses the slot's rotation, so the bot
re-stamps a buy on the very slot it just filled — and that buy sits above the market, so it
re-fills. The orphan/fund-invariant cascade is the *upstream* cause that detaches the boundary
in the first place; the rotation suppression is the mechanism that turns the detachment into a
visible wrong-order loop.

---

## Full Picture (causal chain, with log evidence)

### Step 1 — Concurrency race during a fast market

Around `17:40:39–17:40:51` the market moved fast. Buys filled, the boundary crawled down, and
the bot placed a burst of SELL orders at the top: `1.7.573894144…147`, then `162`, then
`165, 167, 168, 169, 174`.

Fill batches fire faster than they settle. `_batchInFlight` serializes *fill consumer* passes,
but **planning and broadcasting are not atomic with the master commit**:

- Batch A broadcasts sells `144…147`, `162` at `17:40:39`.
- While A's broadcast is in flight, batch B plans against a stale master that does not yet show
  A's placed orders, so B places `165`/`167` at the **same price levels** A already used.
  (`17:40:42` → `a COW broadcast is already in flight; deferring this batch` — the single-flight
  guard serializes the *broadcast*, but B's stale *plan* survives.)
- When A's commit lands, B's commit is **refused**:

```
17:40:51.237 [COW] Refusing stale working grid commit: master mutation during rebalancing (handle-fill-batch)
17:40:51.237 [COW] Commit refused after broadcast; adopting placed orders from chain to keep master in sync
```

The duplicate-price orphans `165`/`167` are genuine *double-placements* at A's price levels
(`sync_engine.ts:888` "duplicates price level of active slot-88"). The single-flight guard
serializes broadcasts but **not planning**, so a stale-plan placement slips through.

### Step 2 — Refused commit leaves orders unrecorded → fund invariant

A's sells (`168`/`169`/`174`) succeeded on chain but their commit was refused, so master never
recorded them. The fallback `adoptPlacedBatchFromChain` (`dexbot_cow_runtime.ts:3274`) re-reads
open orders and calls `syncFromOpenOrders`. That read is the capped `get_full_accounts` window —
and **the freshest orders are the ones truncated away first** (`chain_orders.ts:637-642`).

Adoption is also lossy:

```
17:40:51.258 [SYNC] Orphaned chain order 1.7.573894165 (sell) — NOT adopted: duplicates price level of active slot-88
17:40:51.264 [SYNC] Orphaned chain order 1.7.573894169 (sell) adopted into slot slot-106
17:40:51.266 [SYNC] Orphaned chain order 1.7.573894174 (sell) adopted into slot slot-107
```

…and immediately collides with a parallel re-plan:

```
17:40:51.335 [COW] Rejecting CREATE for slot slot-105: existing orderId=1.7.573894168
17:40:51.335 [COW] Rejecting CREATE for slot slot-106: existing orderId=1.7.573894169
```

Within milliseconds the fund recalc sees chain funds ~1703 higher than tracked:

```
17:40:51.354 [ERROR] CRITICAL: Fund invariant violation (SELL): blockchainTotal (474877) != trackedTotal (473173) (diff: 1703.61802072, allowed: 474.87741520)
```

### Step 3 — Recovery deletes the snapshot and regenerates from a truncated read

```
17:40:51.354 [RECOVERY] Fund invariant violation - attempting state recovery (attempt 1/5)
17:40:54.179 [RECOVERY] Attempting full grid reload from persisted snapshot...
17:40:54.181 [RECOVERY] Restored boundary index: 82
17:40:54.202 [RECOVERY][SNAPSHOT-REJECT] Corrupted grid snapshot detected: drift sell=1703.62 — Deleting corrupted snapshot
17:40:54.222 [RECOVERY] Running structural full grid resync for fund invariant structural drift
17:40:54.290 [SYNC] Synchronization from 40 blockchain orders   <-- TRUNCATED: 42 live, 40 read
```

The regenerated grid's startup reconcile matches `165→slot-91`, `167→slot-108`, `168→slot-110`
by price, but **`169` and `174` are never matched to any slot** — they were the two freshest
orders dropped by the truncated 40-order read.

### Step 4 — Orphans fill later → ORPHAN-FILL, feeding the slot-90 loop

```
17:57:18.492 [WARN] [ORPHAN-FILL] Processing funds for unknown order 1.7.573894174 (not in grid but crediting proceeds)
17:57:18.493 [WARN] [ORPHAN-FILL] Processing funds for unknown order 1.7.573894169 (not in grid but crediting proceeds)
```

When `169`/`174` fill, the fill handler finds no grid order → credits proceeds but **never
virtualizes a slot** → repeated invariant violations → more recovery → the Aug 29 restart reloads
a **stale boundary (90)** (`Restored boundary index: 90`). That detached boundary is exactly the
condition that makes the dust-cancel path re-stamp a buy on slot-90 (see Step 5).

### Step 5 — Rotation problem: same-slot re-placement (the reported symptom)

This is the *proximate* cause of "the bot fills at slot X, then places a new order on slot X."

- `15:19:06` partial fill of `1.7.573894111` on **slot-90** (newSize=2.92 dust).
- Dust detection cancels the residual and synthesizes a fill with `skipBoundaryShift: true`
  (`dexbot_maintenance_runtime.ts:1821`), so `isShiftEligibleFill` (`order/utils/order.ts:1389`)
  returns false and the boundary-crawl rotation is suppressed.
- `processFilledOrders` only rebalances for non-partial fills (`modules/order/manager.ts:1506`),
  but the synthetic dust fill forces a rebalance (`isDelayedRotationTrigger`) with the boundary
  frozen → slot-90 keeps its **BUY** role → a fresh buy is re-placed on slot-90 at 0.32053.
- The bookkept boundary (90) has diverged from the market (anchor `projected=72`, drift −18;
  `ANCHOR.PROJECTION_ENABLED` defaults to `false` at `constants.ts:704`), so slot-90's price sits
  **above the market** and fills instantly → loop.

```
15:19:15.023 [INFO] Placed buy order slot-90 -> 1.7.573915942
15:19:39.424 [INFO] ===== FILL DETECTED ===== for order 1.7.573915942 (slot slot-90)
```

**Why the slot does not rotate:** the boundary is the only thing that re-types a slot from BUY
to SELL (or moves the BUY to the bottom of the grid). Two mechanisms are supposed to move it —
the count-based crawl in `deriveTargetBoundary` and the price-anchored projection. Both are
skipped here: (a) partial fills are excluded from the rebalance trigger and the crawl
(`isShiftEligibleFill`); (b) the dust synthetic fill sets `skipBoundaryShift: true`, which also
disables the crawl; (c) the projection is off by default, so the boundary never self-corrects to
the market. With all three disabled, slot-90 stays BUY forever and is simply re-stamped. The
stale boundary (from the Step 1–4 cascade) is what makes the re-stamped buy land above market
and re-fill — but even with a correct boundary, freezing the rotation on a filled slot is wrong:
a filled buy slot should rotate (become SELL to take profit, or a fresh BUY at the bottom), not
be re-bought at the same price.

---

## Fix Plan

Layered, highest-leverage first. **Implementation status noted inline; code is on the `test`
branch (working tree, not yet committed).**

### P0 — Reliable ID-based adoption after a refused commit
**Kills the orphan + invariant at the source.** Eliminates the truncation-drop that permanently
orphans orders and the divergence that triggers recovery.

`adoptPlacedBatchFromChain` (`dexbot_cow_runtime.ts:3274`) previously re-read the whole capped
window (`readOpenOrdersWithMetaSafe`). After a successful broadcast we **already hold the exact
placed order IDs** in `executedContexts` (`extractBatchOperationResults(result)[i][1]` aligns
positionally with `executedContexts[i]`). Implemented as:

1. `collectKnownOnChainOrderIds(mgr, placedResults, placedContexts)` builds the complete id set =
   master's tracked order ids (`mgr.grid[*].orderId`) **∪** the batch's fresh CREATE ids from the
   broadcast result. The two sets are kept distinct.
2. Re-read the set by ID via `chainOrders.batchReadOrders` (`chain_orders.ts:530`) — **immune to
   the `limit_orders` window cap** — and feed the resolved orders to `syncFromOpenOrders(fullChain,
   { skipAccounting: false })`. Reusing `syncFromOpenOrders` (rather than hand-writing each slot)
   keeps all size/state/accounting reconciliation in one well-tested path.
3. **Lagging-node deferral (phantom-virtualization guard):** a freshly-broadcast CREATE id that
   comes back `null` from the by-id read almost certainly means the queried node has not yet
   indexed the just-placed order, not that it is gone. Adopting a partial set would let
   `syncFromOpenOrders` phantom-cleanup virtualize that live order and re-create a duplicate. So
   when ANY fresh CREATE id is absent, adoption **defers** (`return false`) and keeps the
   pending-broadcast protection, letting a later caught-up read adopt it. A by-id read error also
   defers rather than falling through to the truncation-prone window read. Absent *master* ids
   (pre-existing orders) are expected — those were cancelled/filled in the batch — and are logged
   at debug level.
4. A `null` id for a genuinely-filled/cancelled-in-flight order resolves naturally through
   `syncFromOpenOrders` (slot virtualized).

Window read remains only as a fallback (no broadcast result available, e.g. uncertain paths) and
still defers on `truncated`.

### P0 — Recovery must not lose orders when the snapshot is deleted
**Stops truncated regeneration from dropping orders.**

When `recoverFromPersistedGrid` (`dexbot_state_recovery.ts:314`) hits a truncated window read, it
now falls back to an ID-based read of the order ids the persisted snapshot already tracks
(`chainOrders.batchReadOrders` over `persistedGrid[*].orderId`). This recovers the bot's own
orders — including creates adopted by id after a refused COW commit, whose ids are now persisted —
even when the account exceeds the `get_full_accounts` window, without virtualizing live ACTIVE
slots. It cannot discover brand-new orphans whose ids are nowhere in the snapshot; those are
prevented at source by the P0 adoption path. When no known ids are available, it still defers.

> Note: this recovery fallback is intentionally lossy for ids it cannot enumerate (it virtualizes
> them as filled). That is acceptable reconcile behavior here; the adoption path above is where
> silent loss would be harmful, which is why it hard-defers instead.

### P1 — Make plan → broadcast → commit atomic
**Prevents the race that creates duplicate-price orphans (the true root cause).**

The bug is stale-plan placement. Harden so a batch cannot commit a plan built before a
concurrent placement landed:

1. In the COW executor, **re-plan from a fresh master AFTER winning
   `waitForCowBroadcastSingleFlight`** (post-broadcast-slot, pre-broadcast), not before. This
   guarantees batch B sees batch A's committed orders and will not double-place at A's price.
2. Ensure `_batchInFlight` (and ideally a dedicated COW-plan mutex) covers the *entire*
   plan+broadcast+commit, and that any second rebalance trigger (e.g. dust-cancel from
   `checkGridHealth`) waits for the in-flight commit rather than planning against stale master.

### P1 — Rotation: a filled slot must retype, not be re-stamped (the reported same-slot symptom)
**Directly resolves "the bot fills at slot X, then places a new order on slot X."**

Root cause (Step 5): a filled buy slot never rotates off BUY because (a) partial fills are
excluded from the rebalance trigger (`modules/order/manager.ts:1506`), (b) the dust synthetic
fill sets `skipBoundaryShift: true` (`modules/dexbot_maintenance_runtime.ts:1821`), which makes
`isShiftEligibleFill` false (`modules/order/utils/order.ts:1389`) and freezes the boundary-crawl,
and (c) price-first projection is off by default (`constants.ts:704`). With the boundary frozen,
the rebalance re-stamps a BUY on the same slot; and because the boundary is detached from the
market (upstream cascade), that buy lands above market and re-fills.

Fixes (apply together — (1)+(2) stop the freeze, (3) is the robust backstop, (4) is defense-in-depth):

1. **Stop freezing the boundary on dust-cancel.** Remove `skipBoundaryShift: true` from the dust
   synthetic fill (`dexbot_maintenance_runtime.ts:1821` / `:1826`), or make it conditional: only
   skip the crawl when the bookkept boundary already matches the anchor-projected boundary. This
   lets the boundary crawl/rotate so the filled slot becomes SELL (take-profit) or a fresh BUY is
   placed at the bottom of the grid, instead of being re-bought at the same slot.
2. **Let partial fills / dust-cancels trigger boundary re-evaluation against the anchor.** When
   the bookkept boundary diverges from the projected anchor by more than the active window, force a
   correction even on partial/dust fills (currently both the count-crawl and
   `computePriceAnchoredBoundaryTarget` skip partial fills at `order/utils/order.ts:1389` / `:1447`).
3. **Enable price-first boundary projection** (`ANCHOR.PROJECTION_ENABLED` / `anchor.projectionEnabled`)
   so `calculateTargetGrid` self-corrects the boundary to the market every cycle regardless of fill
   partiality. This is the strongest guard: even if a rotation is momentarily skipped, the boundary
   converges to the market so a re-stamped buy is never placed above market.
4. **Harden the placement guard.** Extend the existing `PLACEMENT-GUARD` in `modules/order/strategy.ts:367-422`
   to also reject an anchor-refill BUY placed at a price above the market anchor, forcing that slot
   to rotate to the opposite rail instead of being re-stamped.

### P1 — Make duplicate-orphan cancellation reliable
The duplicate guard queues a `cancelOnly` correction (`sync_engine.ts:908`) but the log shows
`re-detected 2×; cancel may be failing`. Verify `queueCorrection` cancelOnly actually executes
and is not blocked by the same in-flight/path issues; surface a hard error if the duplicate
cannot be cancelled so it cannot later fill as an orphan.

### P2 — Observability / guardrails
1. Log the boundary drift (bookkept vs anchor-projected) on every rebalance and alert when it
   exceeds the active window — this is the early warning that the rotation freeze is biting.
2. Emit a metric/alert when a slot is re-stamped BUY at a price above the anchor (the loop signature).
3. Track counts of refused commits and orphan fills to validate the P0 fixes.

---

## Suggested implementation order

1. **P0 ID-based adoption** — smallest change, largest impact; directly eliminates the
   orphan-fill and fund-invariant from refused commits.
2. **P0 recovery-by-ID** — stops truncated regeneration from dropping orders.
3. **P1 atomic plan/broadcast/commit** — removes the duplicate-price race at its source.
4. **P1 rotation fix** — directly resolves the reported same-slot re-placement (sub-items 1–4).
5. **P1 duplicate-cancel reliability.**
6. **P2 observability / guardrails** — confirms the fixes hold.

---

## Key code references

| Concern | Location |
| --- | --- |
| Commit refused + adoption fallback | `modules/dexbot_cow_runtime.ts:3002-3027`, `:3274-3303` |
| Placed order IDs available post-broadcast | `modules/dexbot_cow_runtime.ts:3476`, `:3501` |
| Duplicate-price skip (orphan NOT adopted) | `modules/order/sync_engine.ts:876-918` |
| Truncated window cap (freshest dropped) | `modules/chain_orders.ts:637-642`, `:608-634` |
| ID-based reads (immune to cap) | `modules/chain_orders.ts:479` (`readSingleOrder`), `:517` (`batchReadOrders`) |
| Snapshot-delete + regeneration | `modules/dexbot_state_recovery.ts`, `modules/dexbot_maintenance_runtime.ts:803` (`performGridResync`) |
| `skipBoundaryShift` on dust synthetic fill | `modules/dexbot_maintenance_runtime.ts:1821`, `:1826` |
| Partial fill skipped from rebalance | `modules/order/manager.ts:1506` |
| `isShiftEligibleFill` (partial + skipBoundaryShift) | `modules/order/utils/order.ts:1389-1392` |
| Rotation freeze (skipBoundaryShift) on dust cancel | `modules/dexbot_maintenance_runtime.ts:1821`, `:1826` |
| Partial fill excluded from rebalance trigger | `modules/order/manager.ts:1506` |
| `PLACEMENT-GUARD` (extend to anchor-refill buys) | `modules/order/strategy.ts:367-422` |
| Projection disabled by default | `modules/constants.ts:704` (`PROJECTION_ENABLED: false`) |
| Slot-90 loop evidence | `profiles/logs/H-BTS.log` `15:19:06` → `15:19:39` (Aug 29) |
| Orphan/fund-invariant evidence | `profiles/logs/H-BTS.log` `17:40:51` → `17:57:18` (Aug 28) |
