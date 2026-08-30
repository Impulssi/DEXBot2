# Root Cause: Sell Orders Placed In Front Of Live Asks (Aug 26–30 2026)

**Naming:** bot instance names and on-chain order IDs are genericized in this document.
`bot-A` = BTS/USDT grid bot, `bot-B` = TWENTIX/BTS credit bot, `bot-C` = MONEY/BTS credit bot,
`bot-D` / `bot-D2` = XRP/BTS grid bots. `<order-N>` tokens stand in for real limit-order IDs
(`1.7.x`) — the same token always refers to the same order within a section.

**Status:** Analysis complete; fixes ranked and scoped (see "Ranked Fixes"). **Fixes #1–#7 implemented 2026-08-30**: both re-anchor sites flipped (fix #1), pass-2 adoption widened via `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER` (fix #2), update-first reconcile with surplus-only cancels (fix #3, revised — see its section), NO_FEASIBLE re-validation + boundary persist (fix #5), boundary debug logging (fix #4), uncertain-read escalation cooldown (fix #6), defer-log throttle + MAINT correction detail (fix #7). Two scope notes: fix #6 landed as an escalation **cooldown only** (read-back retry/backoff still open), and the adoption multiplier is bounded at 4× (see coverage note in fix #2). Covers the post-`cd690000` audit of the bot-A / bot-B / bot-C logs (window 2026-08-30T00:24:26Z → ~07:48Z).
**Scope:** Grid regeneration / order identity (`modules/order/grid.ts`, `modules/order/sync_engine.ts`, `modules/dexbot_maintenance_runtime.ts`); COW commit geometry (`modules/order/manager.ts`), startup reconcile; boundary evidence derivation/persistence (`modules/order/grid_reconcile.ts:344-390`, `manager._restoreBoundary`).
**Related:** `PRICE_FIRST_ALIGNMENT_PLAN.md` (boundary lag — a separate, secondary mechanism), `ORPHAN_FILL_INVARIANT_ROOT_CAUSE_AND_FIX.md` (orphan fill accounting), `GAP_BAND_ORPHAN_PREVENTION_PLAN.md`

> **Reproduced post-fix (systemic, not bot-D-only):** identical `Unmatched chain order` + `Fund invariant violation` + `ANCHOR-DIVERGENCE` signatures appear on `bot-A`, `bot-B` (TWENTIX/BTS) and `bot-C` (MONEY/BTS) logs through 2026-08-30 — **after** commit `cd690000` ("heal and prevent sized-orphan phantom orders"). This confirms the re-anchor (fix #1) is the real root cause; the phantom-order heal treated a symptom. Fix #1 has since been applied (2026-08-30). Counting bases (all greps reproducible):
>
> | Metric | bot-A | bot-B | bot-C | Basis |
> |---|---|---|---|---|
> | Distinct orphaned order IDs (`Unmatched chain order`) | 229 | 107 | 172 | full log file (Aug 17–30) |
> | Distinct orphaned order IDs, post-`cd690000` window only | 58 | 60 | 91 | 2026-08-30T00:24:26Z → log end (~07:48Z) |
> | `Unmatched chain order` occurrences, post-commit window | 280 | 228 | 241 | same window |
> | Adoptions (`adopted into slot`), post-commit window | 2 | 14 | 64 | same window — adoption volume is ~1–2 orders of magnitude below the orphan population |
> | `Restored boundary` (snapshot restores) | 51 | 53 | 52 | full log file |
> | Structural resyncs (`[CR-RESET] rms_structural_grid_resync`) | 2 | 2 | 2 | full log file |
>
> The post-commit window contains **zero** pre-commit unmatched warnings (00:00–00:24Z is quiet), so the 58/60/91 distinct IDs are attributable to the post-`cd690000` code.

## Symptom

During a falling market on Aug 28 (after ~17:00 UTC), the bot repeatedly placed **new SELL orders below its own still-live sell orders** — undercutting itself. The next day, the orphaned asks filled on a bounce and their proceeds were credited **outside grid accounting** (`[ORPHAN-FILL] Processing funds for unknown order`), producing the ±22-slot `[ANCHOR-DIVERGENCE]` observed on Aug 29 (12:40 onward).

This is **not** the boundary count-crawl lag problem — the dominant *trigger* here is regeneration re-anchor, not boundary drift. The boundary-from-price draft would not have prevented the Aug 28–29 re-anchor cascade; it addresses a separate, lag-mode sell-below-fill instead (see "Relation to the boundary draft").

### Four modes, one symptom family — all logged

**Mode A — orphan (re-anchor).** Aug 28 evening: regeneration re-centers the ladder, live asks become
unmanaged (see "Root cause chain"), new SELL rail starts below them. This document's primary subject.

**Mode B — lag (stale boundary).** Aug 29 09:32, landed and instantly filled:

| Time (UTC) | Event |
|---|---|
| 09:30–09:32 | Market sweeps **up** through the sell rail; bot places/fills sells at slots 147–158 (price-sorted rail) |
| 09:32:21 | `Placed sell order slot-129 -> <order-1>` → **full fill 250ms later** |
| 09:32:33 | `Placed sell order slot-131 -> <order-2>` → **full fill same second** |
| 09:32:42 | `Placed sell order slot-132 -> <order-3>` → **full fill same second** |

Slots 129–132 sit ~15–25 price levels below the 147+ rail the market was trading through at that
moment; a sell that fills within 250ms of placement is by definition below the recent filled sells.
Same timestamp: `[ANCHOR-DIVERGENCE] projected=138 bookkept=123 drift=15` — the boundary had crawled
down with the falling-market buy fills minutes earlier, so the stale bookkeeping re-roled slots
129–132 as SELL into a rising market. The cycle then repeated: one of these instant fills set
`maxFilledSellPrice=1044.79`, and the placement guard caught further attempts at 15:47 (1 sell slot
below 1044.79) and 17:27 (4 + 8 sell slots below 1099.37/1112.62).

Mode B is what the boundary solve-from-price draft fixes; Mode A is what Fix #1 below fixes.

**Mode C — COW commit-path geometry (separate bug surface, not a re-anchor mode).** Two errors fit neither Mode A nor B. Attribution corrected after the 2026-08-30 audit:

- `Batch transaction failed: Execution error: Order does not exist … cannot update` — **confirmed in the post-`cd690000` window on bot-B**: `<order-4>` (00:28:51Z, chunk 1/3) and `<order-5>` (06:43:09Z, chunk 5/9); plus `<order-6>` (00:29:30Z) caught by the newer pre-broadcast size-drift detection (`limit_order_update delta=-2341206 targets an order missing on chain`). A broadcast references an orderId absent on chain; the chunk aborts and leaves a partial grid.
- `GAP-BAND INVARIANT VIOLATION after commit: placed … sits inside gap band (…) → Requesting structural resync.` — **NOT present in the post-`cd690000` bot-A / bot-B / bot-C logs** (0 occurrences in the post-commit window). Evidence is from `bot-D.log` (4) and `bot-D2.log` (11), dated Aug 26 / 28 / 29 — pre-`cd690000`. The gap-band item remains valid but must not be cited as a post-fix regression.

Both need their own fix independent of fix #1:

- (a) the COW plan must **reject any placement inside the gap band before broadcast** (the
  Aug 26–29 / bot-D violations show the check is missing or bypassed at commit time);
- (b) a **pre-broadcast order-existence check** keyed off the live slot→orderId map.

Note: the `Order does not exist` case may itself be a downstream symptom of Mode A's stale slot
maps (dangling orderIds) — verify that first; the gap-band case looks independent. Hardening, not
blocked on fix #1.

**Mode D — boundary-evidence re-derivation is never persisted (placements freeze).** Distinct from
Mode B (boundary *crawl* lag) and from `Restored boundary` (snapshot restore): the P3
boundary-evidence gate in `modules/order/grid_reconcile.ts:344-390` re-derives a corrected boundary
when the stored one contradicts chain evidence, applies it via `manager._restoreBoundary`
(`:374`), but the corrected value does not survive to the next resync cycle — the subsequent
hourly regeneration recomputes the stale boundary again, so the same `ERROR` re-fires indefinitely.
Post-`cd690000` evidence:

- bot-A re-derived the boundary at **every** hourly resync: 117→118 (00:28:48Z), 118→119
  (01:00Z), 118→115 (02:00Z), 118→114 (03:00Z, 04:00Z), 118→115 (04:30Z, 05:00Z), 122→119 (07:00Z).
  Eight identical-pattern `ERROR`s in ~7h; the stored boundary is always stale again by the next
  cycle.
- bot-C hit `NO_FEASIBLE_BOUNDARY` (no `suggestedBoundary` derivable) → "startup placements
  deferred (adoption-only reconcile)" at 00:27:17Z, 00:31:12Z and 04:27:48Z. After the 04:27:48Z
  deferral the bot placed **zero orders from 04:27:48Z to 07:15:27Z (~2h48m)** — the only activity
  was fill processing and `[ORPHAN-FILL]` warnings. An earlier freeze ran 00:31Z → 00:54Z. The bot
  only resumed placing when fill-driven rotation (a different placement path) fired at 07:15Z.

Impact: the bot can silently go passive for hours while orphan fills keep accruing outside grid
accounting. Fix = Fix #5 below.

### Post-commit hardening items (observed 2026-08-30, not orphaning modes)

Three smaller mechanisms surfaced by the post-`cd690000` audit; none is a Mode A/B/C/D trigger,
but each amplifies recovery churn or hides state:

1. **Lagging-node adoption read-back thrash (bot-B 06:43:09–06:47:09Z).** After chunk 5/9 failed
   (`<order-5> does not exist`), fresh CREATEs were absent from the chain read-back
   (`<order-7> … likely lagging node`); pending-broadcast protection piled to **14**, all
   subsequent CREATE batches rejected, the 30s defer cap hit and a resync forced mid-broadcast —
   ~4 min / 24 churn events before reconciling (12 then 10 adopted). Remedy: Fix #6.
2. **Sync lock contention.** `Sync timed out after 20000ms` inside recovery plus
   `[SYNC] Sync abandoned: force-released during sync (69355ms); discarding result` (bot-B
   06:44–06:45Z) — ~70s of sync work lost.   bot-C also emitted **~110** `Structural resync defer`
   warnings at 250ms intervals over one 30s cap window (00:30:42–00:31:12Z). Remedy: Fix #7.
3. **`[MAINT]` price corrections partially failing with no retry or reason.** Observed ratios in
   the post-commit window: 2/3 and 2/2 (bot-A), 1/8, 2/25, 1/23, 1/14 (bot-B). Likely the stale
   slot→orderId maps Mode A produces. Track as a regression-gate signal; expect 0 with fixes #1–#3
   (see Fix #7).

## Incident timeline (from the bot-D log, Aug 28 17:09 → Aug 29 17:27 UTC)

| Time (UTC) | Event |
|---|---|
| Aug 28 17:09 | Sells fill on the old ladder at 1110–1176 (slots 140–148). Grid tracking is correct at this point. |
| 17:10:01 | `[RECOVERY] structural full grid resync for pending broadcasts before COW create` → **grid regeneration** + **AMA center refreshed**. Ladder rebuilt from the new (lower) center. |
| 17:10:02 | **16+ live sell orders declared `[SYNC] Unmatched chain order ... no adoptable slot found`.** Price diff of every orphan vs nearest new-ladder slot: 0.43–0.57 vs adoption tolerance 0.036. The bot's own asks become unmanaged on-chain liquidity. |
| 17:10–18:37 | **7 more regenerations** (14 on Aug 28 total). Each re-anchors to the newest AMA center and orphans more orders. 31 distinct orphaned sells that evening; 2,071 unmatched-order warnings in the log overall. |
| 17:34:33 | Mode B: sells placed at slots 132, 135, 136 (~1054–1064) — below the fill range |
| 17:36:03 | Mode B: 11 more sells at slots 124–131, 133, 134 (~1028–1061); slot-124 partial fill **150ms after placement** |
| 17:37:48 | Recovery resync restores boundary to 119 (from 139/142) mid-drop — Mode A re-anchor; orphans the survivors. New ladder's SELL rail sits **below** the orphaned asks → new sells placed in front of the bot's own live asks. Boundary context: restored 142 (17:10) → 139 (17:15), then silently crawled down with the crash buy-fills to ~123 by 17:36 (the crawl is not logged; only restores are) — slots 124–136 re-rolled to SELL on the stale boundary, 20–80 BTS below the bot's own 17:09 fills. |
| 17:37:39–17:55:09 | Mode B: slots 124→130 swept (sequential full fills ~3s apart), then 131→136 — **all 14 orders filled** |
| 17:45 | `[DIVERGENCE-COW] Boundary-shift commit blocked (RECOVERY_EXHAUSTED)` — feedback loop: blocked commit → recovery resync → regeneration → orphans → more divergence. |
| 18:02 | First surplus cancels via DIVERGENCE-COW, ~50 min after orphaning. Partial. |
| Aug 29 12:29 | Orphaned sells fill on a bounce → proceeds credited outside grid accounting, no rotation, no anchor update. |
| Aug 29 12:40–17:27 | `[ANCHOR-DIVERGENCE]` drift up to ±22; 17:27 periodic sync discovers **40 filled orders at once** spanning a full V-sweep (buys 978–1026, sells 1099–1112); PLACEMENT-GUARD rotates up to 31 buy slots and 8 sell slots per batch. |

Also relevant context: 11 graceful restarts in 30 hours, each restoring the boundary from snapshot (`Restored boundary index: ...` 57 times in the log).

## Root cause chain (with code references)

1. **The ladder is quantized to the center.** `createOrderGrid` builds every price level as
   `startPrice × step^(k+1/2)` (`modules/order/grid.ts:441,449`).
   Any change of the center re-prices **every** slot. There is no "keep levels, move boundary" mode.

2. **Recovery resyncs re-anchor the grid — via two independent config points** (exact sites in
   Fix #1). Every structural resync runs `recalculateGrid` (`modules/order/grid.ts:1208`) →
   `initializeGrid` → fresh ladder from the newest AMA center.
   A recovery resync is state repair; silently re-anchoring geometry is a re-anchor decision nobody made.

3. **Matching tolerance is rounding-scale.** `calculatePriceTolerance` =
   `(1/satsA + 1/satsB) × price` (`modules/order/utils/math.ts:820-824`) ≈ **0.036** at price 1110 —
   one unit of the base asset's last decimal. The `PRICE_TOLERANCE_MAX_PERCENT: 0.01` cap
   (`modules/constants.ts:453`) never engages because the precision term is always smaller.
   The AMA center moved ~0.045% between regenerations → all slot prices shifted ~0.5 →
   **~15× tolerance** → pass-1 matching and pass-2 fallback adoption
   (`modules/order/sync_engine.ts:148-155`, `:1001`) reject every live order.

4. **Orphans are not even prioritized for cleanup.**
   `PRICE_DRIFT_TOLERANCE_MULTIPLIER: 4` (`modules/constants.ts:540`) gives a drift-tag budget of
   0.144 < the observed 0.43–0.57 diffs (`modules/order/sync_engine.ts:236-240`), so no
   `price-drift-orphan` tag → no prioritized auto-cancel. `unmatchedChainOrders` is only *logged*
   (`modules/dexbot_maintenance_runtime.ts:1264-1274`). Cancellation happened sporadically via
   DIVERGENCE-COW surplus ~50 minutes later.

5. **Consequences.** The regenerated ladder (centered lower in a falling market) starts its SELL rail
   below the orphaned asks → new sells in front of the bot's own live asks. The placement guard and
   the market anchor are blind to the orphans because they are not grid-tracked fills:
   `maxFilledSellPrice` / `minFilledBuyPrice` are built from grid-tracked fills only, so once a
   regeneration orphans the bot's own live orders, the "no sell below the last filled sell"
   invariant is unenforceable — the guard is protecting a ledger that no longer contains the bot's
   own orders. When the orphans later fill, proceeds are credited outside grid accounting and the
   anchor/boundary never learn.

## Why "just widen the tolerance" is second-best

Widening the pass-2 fallback adoption tolerance **would** work mechanically:

- Adoption writes the chain price into the slot (`modules/order/sync_engine.ts:1029`), so the slot
  tracks the real order even when off-grid by a fraction of a step.
- All chain orders are account-scoped — each pair runs its own BitShares account here (BTS/USDT,
  TWENTIX/BTS, MONEY/BTS), so there is no third-party adoption risk *in the current deployment*. If
  shared-account bots ever co-exist, widening adoption tolerance would need to be scoped per-bot.
- Nearest-slot adoption preserves price monotonicity.

But it treats the symptom. The primary trigger is that recovery resyncs re-anchor at all.
Removing the re-anchor from the recovery path prevents the orphaning outright.

## Ranked fixes

### 1. Stop re-anchoring on recovery resyncs (two config points, highest leverage)

`rms_structural_grid_resync` re-anchors via **two** independent sites; both must be flipped:

- `modules/dexbot_maintenance_runtime.ts:2227` — hardcoded `refreshCenterPrice: true` → `false`
  (the `requestStructuralGridResync` → `requestGridReset` path).
- `modules/dexbot_maintenance_runtime.ts:100-104` — `GRID_RESYNC_REASONS.rms_structural_grid_resync.
  shouldRefreshCenterPrice: true` → `false` (covers the `buildGridResyncOptions('rms_structural_grid_resync')`
  call sites at `:969`, `:1016`, `:1655-1657`).

A structural resync keeps the current geometry; the regenerated ladder is then identical to the
old one, orders re-match, zero orphans. Re-anchoring should happen only on manual/trigger-file
resets and genuine re-anchor triggers. This alone would have prevented the entire Aug 28 cascade
(7 recovery resyncs × full orphaning each).

**Scope / safety note:** `requestGridReset` defaults `refreshCenterPrice` to `TRUE`
(`modules/dexbot_maintenance_runtime.ts:2119`) so manual/trigger-file resets still re-anchor as
intended. The remaining `shouldRefreshCenterPrice: true` entries in `GRID_RESYNC_REASONS` —
manual (`:74`) and the market-adapter delta/slope/bootstrap triggers (`:81/:86/:91`) — are
genuine re-anchor events (the AMA center moved beyond its delta threshold) and intentionally
stay enabled. Capital-based `GRID_REGENERATION_PERCENTAGE` regenerations are separate,
intentional re-anchors and out of scope here. Residual risk if the center genuinely moved:
keeping geometry leaves orders briefly mispriced versus the market but still *managed*; the
boundary/anchor adaptation re-centers over time. The alternative (re-anchor) is precisely what
orphans them.

### 2. Regeneration must preserve order identity (defense-in-depth)

In `recalculateGrid`, after `initializeGrid` builds the new ladder, adopt the existing
`chainOpenOrders` (already in hand) into nearest slots at chain price **before**
`reconcileGridOrders` runs. Alternative: widen pass-2 fallback adoption
(`modules/order/sync_engine.ts:1001-1012`) to ~0.25 grid steps for VIRTUAL slots only.

**Coverage note on the landed multiplier (4×).** `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER: 4`
(`modules/constants.ts` GRID_LIMITS) admits drift up to ~0.144 at price 1110 (~¼ grid step) — the
bot-D orphan diffs (0.43–0.57) are **beyond** this band. That is coherent layering, not a gap:
fix #1 removes the re-anchor that produced those large diffs, and anything still unadoptable falls
to fix #3's surplus-only cancel in the update-first reconcile instead of surviving as unmanaged liquidity. The adoption
knob only needs to cover residual small drifts. Note the widened band also pre-empts the
`price-drift-orphan` tag in the empty-slot regime (both use (strict, 4×] on empty slots), so the
tag now fires mainly when adoption is disabled or the slot is unavailable.

Invariant to establish: **a resync — including the startup reconcile — may never leave a live order unmanaged.**

**Orphaning also occurs on the startup reconcile (not only recovery resync).** An Aug 30 bot-A
trace shows `Placed sell order slot-141 -> <order-8>` (06:42) → `Startup: Updating chain SELL
<order-8> -> grid slot-140` (07:00) → still `Unmatched chain order … no active same-side grid
order exists`. A second, stronger bot-A trace shows the full loop: `<order-9>` was
re-adopted at **six consecutive resyncs** (01:00→slot-119, 02:00→slot-96, 03:00→slot-95,
04:00→slot-95, 04:30→slot-96, 05:00→slot-96 — each hour `Unmatched` again, each hour
`Startup: Updating chain BUY …`), and when it finally filled at 06:42:15Z it was processed as
`[ORPHAN-FILL] Processing funds for unknown order <order-9>` — adopted six times, tracked at
fill time zero times. The order was re-adopted into a slot yet ended up unmanaged, i.e. the
orphaning path is not exclusively the Mode A re-anchor: adoption does not survive the next grid
re-plan. Extend the adoption-before-reconcile step to the **startup reconcile** path as well, and
add the same "no live order survives unmanaged" assertion there. Fix #1 alone will not fully close
this case.

### 3. Reconcile is update-first: never pre-emptively cancel unmatched orders (containment, revised)

Original draft: force-cancel anything still unmatched after a regeneration, so no unmanaged
order survives a resync cycle. Landed that way on 2026-08-30 and **regressed the reset path**:
on a reset the freshly generated grid has no ACTIVE slot bindings yet, so live orders failed
the "nearest active grid order within loose tolerance" check and were pre-emptively cancelled
instead of being batch-updated onto the new rail — cancel+create churn (per-order operations)
replacing one batched update.

Landed behavior (revised): `reconcileGridOrders` never cancels unmatched orders in the
duplicate/route phase. Unmatched orders flow into `_reconcileStartupSide`, which
1. **updates** them onto target slots in a single batch (`plannedUpdates` →
   `_executeStartupUpdateBatch`),
2. **creates** missing orders when the chain has fewer than the target,
3. **cancels only true surplus** (`chainCount - targetCount`, farthest-from-grid first), plus
   Phase-3 stale surplus beyond target on the fresh post-Phase-2 read.

The "no unmanaged order survives a resync" invariant still holds: every unmatched order is
either adopted onto a slot (batch update) or cancelled as surplus. The surplus gate
(`matchedOnGrid > 0 || neededSlots === 0`) still prevents nuking live orders on a false-positive
fresh-grid match, and freshly broadcast orders remain protected by the absence-decision guard.

### 4. Log the live boundary on every role assignment (observability, zero risk)

The boundary crawl is invisible in the logs: only *restores* are logged (`Restored boundary index:
142/139/119`), never the silent crawl between them. The Aug 28 17:36 dump (14 sells at slots
124–136, 20–80 BTS below own fills) is only explainable in hindsight by inferring the boundary
from which slots got SELL role — at the time, nothing in the log showed boundary ≈ 123 while the
market traded at slot-140+ levels. Add a debug-level line logging the boundary whenever roles are
assigned or a placement is computed, e.g.:

```
[BOUNDARY] boundary=123 sellStart=128 spread=4 anchorProjected=138 maxFilledSell=1044.79
```

(at minimum: `boundary` + `maxFilledSell` on every batch that places orders). This makes Mode B
diagnosable in real time — one glance shows bookkept boundary far below the filled-sell price —
and gives the solve-from-price draft a direct before/after comparison signal. Zero behavioral
risk; log-only.

### 5. Persist the boundary-evidence re-derivation and define NO_FEASIBLE recovery (Mode D, high operational impact)

Two halves:

- **Persistence.** When `validateBoundaryAgainstChainEvidence` returns a `suggestedBoundary` and
  `manager._restoreBoundary` applies it (`modules/order/grid_reconcile.ts:373-381`), the corrected
  boundary must survive the *next* resync/regeneration cycle — today it does not (see Mode D).
  Either `_restoreBoundary` is not persisted to the grid snapshot, or a later step in the same
  regeneration recomputes the boundary from slot state and overwrites it. Verify which, then fix
  that site. Post-fix: the `[BOUNDARY-EVIDENCE]` contradiction ERROR fires at most once per
  genuinely stale boundary, not once per resync.
- **NO_FEASIBLE recovery.** When `suggestedBoundary` is null (`grid_reconcile.ts:382-388`), the
  bot goes adoption-only with no scheduled retry (the bot-C ~2h48m freeze — see Mode D). Add an
  explicit recovery path: re-run boundary validation on the next sync tick (not the next full
  resync), and log at WARN on each deferred cycle so the freeze is visible in monitoring.

### 6. Retry/backoff the post-broadcast adoption read-back instead of escalating to structural resync (bot-B 06:43Z thrash)

When `By-id adoption deferred: fresh CREATE … absent from chain read (likely lagging node)` fires,
the broadcast already succeeded — the read is the problem. Current behavior piles pending
broadcasts (up to 14), rejects every subsequent CREATE batch, hits the 30s structural-resync defer
cap, and forces a resync mid-broadcast. Instead: short retry with backoff against the same node,
then failover to another node, and only escalate to structural resync if the order is confirmed
absent after the retry budget. The Mode C(b) pre-broadcast order-existence check already
handles the genuinely-missing case; this path is about node lag.

**Implementation status (2026-08-30): partial.** Landed as a 30s escalation cooldown in
`deferUncertainBroadcastRead` (`modules/dexbot_cow_runtime.ts:~300`): the pending-broadcast
protection is retained and the structural resync escalates at most once per cooldown window
(`uncertainReadResyncCooldownMs`), which bounds the bot-B-style thrash. The read-back
retry/backoff against the same node remains open — the cooldown suppresses the *frequency* of
escalation but a genuinely lagging read still costs one resync per window.

### 7. Hardening: sync-lock contention and maintenance-correction observability

- Throttle `Structural resync defer` logging to first/last occurrence per cap window (bot-C: 120
  lines in 30s). Keep the counter in a periodic summary line.
- Log (and optionally retry once) `[MAINT] n/m price correction(s) failed` with the failing
  orderId and reason — today the failure is a bare count with no follow-up. Expect the count to
  fall to 0 once fixes #1–#3 remove the stale slot→orderId maps.

## Relation to the boundary draft (solve boundary from live price)

The incident has multiple components (see "Four modes, one symptom family"): Mode A (re-anchor
orphaning) is independent of boundary count-crawl lag; Mode B (Aug 29 09:32 landed triple) **is**
the lag mode; Mode D (boundary-evidence non-persistence) is a persistence bug in the same subsystem:

- Fixing #1 removes Mode A and removes a major *feeder* of boundary churn (mid-recovery boundary
  restores such as 142 → 139 → 119 on Aug 28, and the ±22 anchor divergence driven by untracked
  orphan fills).
- The boundary draft remains valid for Mode B (the 09:32 landed triple is its direct target; the
  17:27 sweep — bookkept=135 vs projected=155, per-burst budget smaller than real market
  displacement, discovery gaps via history-mode sync — shows the same mechanism at scale).
- Fix #5 (Mode D) is complementary, not competing: the draft solves *which* boundary to use, #5
  makes the already-corrected one stick across resyncs — a draft that recomputes from price would
  otherwise mask the persistence bug.
- Recommended sequencing: land fix #1 first, then the boundary solve-from-price draft behind its
  flag, then #2/#3 as hardening. Fixes #4 and #5 can land independently at any time (#4 is
  log-only, #5 removes an active multi-hour placements freeze).

## Suggested verification

- Unit: regeneration with an unchanged center must re-match all previously live orders (no
  `unmatchedChainOrders`).
- Unit: recovery resync (`rms_structural_grid_resync`) must not call the AMA snapshot promotion.
- Unit: after a regeneration with a shifted center, every live order is either adopted into the
  nearest slot or queued for immediate cancel — never silently unmanaged.
- Unit: **startup reconcile** must adopt a just-placed order (replay the Aug 30 bot-A 07:00:01
  trace — `<order-8>` re-adopted to a slot must NOT end up `Unmatched`; replay the
  `<order-9>` six-resync adoption loop — adoption must survive the next re-plan).
- Unit: **boundary re-derivation must persist across the next resync** (replay the bot-A
  00:28–07:00 loop: the boundary seen at resync N+1 must equal the value re-derived at N; zero
  repeated `[BOUNDARY-EVIDENCE]` contradictions for an unchanged chain state).
- Unit: **NO_FEASIBLE_BOUNDARY must recover on the next sync tick** (replay bot-C 04:27:48Z —
  placements must resume without waiting for a fill-driven path; adoption-only period must be
  bounded, not hours).
- Unit: **post-broadcast adoption read-back must retry/backoff** (replay bot-B 06:43:33Z — a
  lagging chain read must not pile 14 pending broadcasts or force a mid-broadcast structural
  resync).
- Unit: **COW commit must never place an order inside the gap band** and must run a
  **pre-broadcast order-existence check** (replay the bot-B Aug 30 `Order does not exist` events —
  `<order-4>`, `<order-5>` — and the Aug 26–29 `GAP-BAND INVARIANT` events from
  bot-D/bot-D2; zero such errors after fix).
- Replay: the Aug 28 17:09–17:16 burst (sells 1110–1176, 3 regenerations in 6 minutes) must produce
  zero orphaned orders and zero sells placed below the pre-existing asks.
- **Regression gate (post-fix):** re-run on `bot-A` / `bot-B` / `bot-C` over a comparable
  ~7h window and require all of:
  - distinct `Unmatched chain order` IDs → ~0 (post-`cd690000` baseline 58 / 60 / 91; full-file
    baseline 229 / 107 / 172) — proving the phantom-order heal did not close the loop and fix #1
    is required;
  - `CRITICAL|WARN: Fund invariant violation` → 0 (post-commit baseline: bot-A SELL drift grew
    3077.07 → 3184.93 within 42 min; bot-B/bot-C each hit 2–3 BUY violations, one recovery
    initially failed on BUY drift 432.8 > 28.1);
  - `[ORPHAN-FILL] Processing funds for unknown order` → 0 (post-commit baseline: 7 / 33 / 22);
  - repeated `[BOUNDARY-EVIDENCE]` re-derivations for unchanged chain state → 0, and zero
    placements-deferred minutes (post-commit baseline: bot-C ~2h48m freeze);
  - `[MAINT] .* price correction(s) failed` → 0 (post-commit baseline: 2/3, 2/2, 1/8, 2/25, 1/23,
    1/14).
