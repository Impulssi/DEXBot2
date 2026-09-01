# Consolidated Orphan-Fix Summary — Supersedes 4 Test-Branch Plans

> **Supersedes (safe to delete next commit):**
> `docs/GAP_BAND_ORPHAN_PREVENTION_PLAN.md` · `docs/LADDER_RECENTER_ORPHAN_ROOT_CAUSE.md` · `docs/ORPHAN_FILL_INVARIANT_ROOT_CAUSE_AND_FIX.md` · `docs/PRICE_FIRST_ALIGNMENT_PLAN.md`
> All content below is merged in condensed form — incident data, fix lists, invariants, verification targets and rollback gates are preserved; some narrative rationale is compressed. Original files were added only on `test` (`git diff origin/dev...HEAD --diff-filter=A` shows only these 4 `*.md` adds).

**Scope:** `modules/order/{grid,strategy,sync_engine,manager,grid_reconcile*}` · `modules/order/utils/{math,order,system}` · `modules/{dexbot_class,dexbot_cow_runtime,dexbot_maintenance_runtime,dexbot_fill_runtime,dexbot_state_recovery,chain_orders,config,constants,paths}` · `market_adapter` re-anchor triggers · `analysis/grid_correction_check.ts`
**Statuses corrected against `test` HEAD `a54863ca` (2026-08-31):** the source docs' own wording (`proposed` / `analysis complete` / `investigation complete — fix plan pending` / `Phase 2 flag enabled`) predated later fix commits, so each plan item now carries a `LANDED` / `REVERTED` / `SUPERSEDED` annotation with the implementing commit hash. Key corrections: GAP P1–P5 landed `f94d6ec4` but the P2 sweep was reverted (`3713c496`) and the P1 writer + post-commit assert reverted (`e2898e51`); PRICE_FIRST Phase 2 projection was enabled (`1bbf1a23`) then removed (`3713c496`) — the anchor is shadow telemetry only.

---

## 0. Terminology

**Naming:** instance/order IDs are genericized (`bot-A` = grid bot, `bot-B`/`bot-C` = credit bots, `bot-D/D2` = grid bots; `<order-N>` = `1.7.x`). Same token = same order within a section. Market pairs are genericized as `<pair>`; account names `1.2.x` placeholders.

**Grid terms:** `boundary` = discrete sell/buy split index; `gap band` = `SPREAD/virtual` slots around boundary; `sellStartIdx = splitIdx - floor(gap/2) - 1`; center-priced ladder `createOrderGrid` = `startPrice × step^(k+½)` (`modules/order/grid.ts:441,449`); `MarketAnchor` = fill-derived `lastFillPrice/maxFilledSellPrice/minFilledBuyPrice/lastFillSide`; tolerance helpers `calculatePriceTolerance = (1/satsA+1/satsB)×price` (`modules/order/utils/math.ts:820-824`), `PRICE_TOLERANCE_MAX_PERCENT 0.01` (`constants.ts:461`).

**Validation tool:** `analysis/grid_correction_check.ts` (test-only, mirrors `analysis/trade_profitability.ts` Kibana path `https://kibana.bitshares.dev`, `bitshares-*`, `operation_type:4` `fill_order` only; `buildFillQuery`, paginated `search_after`, `_source` `block_data` fields). **Invariants:** `sell→sell` with no `buy` between must rise (`curr > prev`, equal OK), `buy→buy` must fall (`curr < prev`); `per-order` aggregated default (weighted avg collapses multi-fill `1.7.x`), `--per-fill` raw. Resolution via `bot_key_utils.ts` `loadBotMeta/computeBotKey`. Reports violations, `%`, daily histogram, time/range, table with price/Δ%/times/orderIds; `--json/--csv` export; exit `0` pass / `2` fail. Strict sat-level is ground truth (`--tolerance P` allows `b < a*(1-P/100)` sell / `b > a*(1+P/100)` buy). Used as regression gate below; pre-fix per-account baselines are intentionally omitted here — §7 states the targets (`0` violations).

---

## 1. Gap-Band Orphan — Prevention Plan (P1–P6) — from `GAP_BAND_ORPHAN_PREVENTION_PLAN.md` (Status: implemented `f94d6ec4` 2026-08-29, with subsequent amendments — landing map below)

**Landing map (corrected 2026-08-31):**
- **P1** — landed `f94d6ec4` (same-batch CANCEL injection in `COWRebalanceEngine.execute` + `_assertGapBandIntactPostCommit` cancelOnly). **REVERTED `e2898e51`** ("remove placement guards that interfered with normal operation") — both sites removed; stranding is now handled by the P3 chain-evidence gate + adoption path instead of cancellation.
- **P2** — landed `f94d6ec4`; **REVERTED `3713c496`** after a live-bot incident (the sweep cancelled two legitimate boundary buys under a stale boundary). In-gap chain orders are now *adopted* by the normal reconcile path once the boundary is re-derived from chain evidence; cancellation is never used as a self-healing net.
- **P3** — landed `f94d6ec4` (`validateBoundaryAgainstChainEvidence` + reconcile phase-1 gate + `placementsAllowed` adoption-only mode); amended `3713c496` (anchor demoted to non-authoritative hint, can never veto); extended `a54863ca` (NO_FEASIBLE escalates a straddle-cancel ladder instead of freezing). **Live** — `grid_reconcile.ts:359-502`.
- **P4** — landed `f94d6ec4` (`dexbot_state_recovery.ts:581 rejectCorruptedGridSnapshot` clears in-memory + persisted boundary on reject). Live.
- **P5** — landed `f94d6ec4` (skip/defer logging + `STRUCTURAL_RESYNC_MAX_DEFER_MS` force, `dexbot_maintenance_runtime.ts:2242-2266`). Live.
- **P6** — landed `f94d6ec4` as `tests/test_gap_band_regression.ts` + `tests/test_boundary_chain_evidence.ts` (updated by `3713c496`/`e2898e51`/`a54863ca` to the amended behavior).

### 1.1 Incident summary (2026-08-29 09:29–12:00 UTC, `<pair>`, generic `1.2.x/1.7.x`)

1. After corrupted-snapshot rejection, recovery restored **stale persisted boundary 131** while true market was ~140+ (`Restored boundary index: 131` then `[RECOVERY][SNAPSHOT-REJECT] drift sell=0.00 buy=2036.67`).
2. With boundary 131, slot-144 was valid sell-rail; startup reconcile adopted/updated unmatched chain sell to slot-144 (`Startup: Updating chain SELL ... -> grid slot-144`), broadcast in 35-op startup batch.
3. Fills swept up; price-anchored boundary correction (`2bc1efe3`) snapped boundary up. Slot-144 fell inside new gap band; local record re-typed `SPREAD/virtual, size->0, orderId=""` (spread normalization) while live chain order stayed inside gap.
4. No cleanup caught it: sync pass-2 only queues `cancelOnly` for orphans duplicating an **active price level** (slot-144 empty → no match); adoption refuses gap slots (`no adoptable slot found`); runtime reconcile only warns (`no active same-side grid order exists`); startup excess-cancel only on `chainCount > targetCount`.
5. Detector fired `09:33:57 GAP-BAND INVARIANT VIOLATION after commit: placed sell slot-136 ...` but only set `structuralResyncRequested`; resync was silently skipped/never ran. Orphan partially filled `09:53, 10:08, 11:36` via `Processing funds for unknown order ...`, fully filled ~12:00 bot offline.

**Core defect:** invariant *"no live order inside gap band"* enforced by detectors/warnings, never by a writer.

### 1.2 P1 — Cancel in same batch that strands (highest leverage) *(LANDED `f94d6ec4`; REVERTED `e2898e51` — see landing map)*
- `calculateTargetGrid` (`modules/order/strategy.ts` SPREAD GUARD) already identifies stray in-band slots with live orders and keeps them `BUY/SELL`; comment claims `cancelled by sync pass-1 type-mismatch handling` — never fired. **Change:** emit `cancelOnly` ops for orderId-bearing in-band slots in same COW plan (model: duplicate-price `cancelOnly` at `sync_engine.ts` pass-2).
- Belt-and-braces: `_assertGapBandIntactPostCommit` (`manager.ts`) already collects `problems {id, price}`; on detection immediately queue `cancelOnly` for those ids instead of only flagging. **With P1, incident dies at 09:33:57 — stranded order cancelled same commit.**

### 1.3 P2 — Gap-band orphan sweep (self-healing net) *(LANDED `f94d6ec4`; REVERTED `3713c496` — replaced by adopt-after-chain-evidence-correction; see landing map)*
- Sync pass-2 (`sync_engine.ts` unmatched-chain branch) + runtime reconcile (`grid_reconcile.ts` phase-1): when unmatched chain price sits **strictly inside implied gap band** (shared `MathUtils.isSlotInRail` geometry test) → queue `cancelOnly` instead of `no adoptable slot found` / `no active same-side grid order exists`. Cleans any already-live orphan within one sync cycle.

### 1.4 P3 — Never place against unvalidated boundary (origin) *(LANDED `f94d6ec4`; amended `3713c496`, `a54863ca` — live)*
Poison input was `_restoreBoundary(131)` from stale snapshot; `validatePersistedBoundary` couldn't catch (band empty at restore, stranding created by placement).
- After restore/rebuild, re-derive boundary from chain before placement: placed-order distribution (highest live BUY / lowest live SELL), market anchor, recent fill evidence via `computePriceAnchoredBoundaryTarget` (`order/utils/order.ts`). If derived disagrees beyond threshold, use derived + loud log.
- Gate `_reconcileStartupSide` (`grid_reconcile_internal.ts`): adoption of existing chain orders to slots is safe; **creating/price-updating into rail requires boundary validated against chain+fills** in current session; without validation → adoption-only, defer placements.

### 1.5 P4 — Snapshot-reject must discard boundary *(LANDED `f94d6ec4` — live)*
Sequence `Restored boundary index: 131` *then* `[SNAPSHOT-REJECT] Deleting corrupted snapshot` — rejected boundary stayed. In `recoverFromPersistedGrid` (`dexbot_state_recovery.ts`): validate first, restore only on pass; on fail discard boundary with snapshot, fall through to P3 re-derivation.

### 1.6 P5 — Structural resync requests must not vanish *(LANDED `f94d6ec4` — live)*
`09:33:57 Requesting structural resync` swallowed (`requestStructuralGridResync` in `dexbot_maintenance_runtime.ts` skips if already scheduled/running, `_batchInFlight` deferral re-arms timer uncapped). Hours unanswered.
- Log every skip/defer with reason; add max-defer deadline forcing resync after re-arms.

### 1.7 P6 — Regression tests *(LANDED `f94d6ec4` as `test_gap_band_regression.ts` + `test_boundary_chain_evidence.ts`)*
- A (P1): stale boundary → startup updates into slot X → boundary snaps past X → assert cancel emitted same batch, no live in-band.
- B (P2): seed live orphan strictly inside gap with no duplicate price → sync/reconcile → assert `cancelOnly` within one cycle.
- C (P3/P4): corrupted snapshot stale vs fill evidence → rebuild → assert placements use re-derived boundary, rejected boundary not reused.

### 1.8 Rollout order
1. **P1+P2+P4** (writer cancel + sweep + reject-discard) — self-enforcing invariant
2. **P5** observability/force
3. **P3** re-derivation gate (largest surface, fast-follow)
4. **P6** tests accompany each step

---

## 2. Ladder Recenter Orphan — Root Cause (Aug 26–30 2026) — from `LADDER_RECENTER_ORPHAN_ROOT_CAUSE.md` (Status: analysis complete; Fixes #1–#7 landed 2026-08-30 per doc header)

### 2.1 Symptom
Falling market Aug 28 after ~17:00 UTC: bot **placed new SELLs below own live sells** (self-undercut). Next day orphans filled on bounce, proceeds credited outside grid accounting (`[ORPHAN-FILL] Processing funds for unknown order`), drift `±22` slots `[ANCHOR-DIVERGENCE]` from Aug 29 12:40. Not boundary crawl — dominant trigger is **regeneration re-anchor** (separate from PRICE_FIRST lag mode).

### 2.2 Reproduction (systemic, not bot-D-only) — post-`cd690000` (commit "heal and prevent sized-orphan phantom orders") audit window `2026-08-30T00:24:26Z→07:48Z`

| Metric | bot-A | bot-B | bot-C | Basis |
|---|---|---|---|---|
| Distinct orphaned IDs (`Unmatched chain order`) full log Aug 17–30 | 229 | 107 | 172 | full file |
| Distinct post-commit window | 58 | 60 | 91 | 00:24:26Z→end |
| Occurrences post-commit | 280 | 228 | 241 | same |
| Adoptions post-commit | 2 | 14 | 64 | vs orphans 1–2 orders magnitude low |
| `Restored boundary` (snapshot restores) | 51 | 53 | 52 | full file |
| Structural resyncs (`[CR-RESET] rms_structural_grid_resync`) | 2 | 2 | 2 | full file |

`00:00–00:24Z` quiet → 58/60/91 attributable to post-`cd690000` code. Confirms re-anchor (fix #1) is root cause; phantom-order heal treated symptom.

### 2.3 Four modes, one symptom family

**Mode A — orphan (re-anchor) — primary.** Aug 28 evening: regeneration re-centers ladder, live asks unmanaged, new sell rail starts below them. Timeline Table §2.6.

**Mode B — lag (stale boundary).** Aug 29 09:32 swept up through sell rail slots 147–158 → then `09:32:21 Placed sell slot-129 -> <order-1>` filled 250 ms later, `09:32:33 slot-131`, `09:32:42 slot-132` — 15–25 levels below rail; `ANCHOR-DIVERGENCE projected=138 bookkept=123 drift=15`. Boundary crawled down with falling-market buys, re-rolled slots 129–132 as SELL into rising market. One instant fill set `maxFilledSellPrice=1044.79`, guard caught later attempts `15:47` (1 slot below) and `17:27` (4+8 below 1099.37/1112.62). **What PRICE_FIRST Phase 2 fixes.**

**Mode C — COW commit geometry (separate).** Attribution corrected: `Batch transaction failed: Execution error: Order does not exist … cannot update` confirmed post-commit on bot-B: `<order-4>` `00:28:51 chunk1/3`, `<order-5>` `06:43:09 chunk5/9`, `<order-6>` `00:29:30` (`limit_order_update delta=-2341206 targets missing`). Broadcast refs missing orderId, aborts partial grid. `GAP-BAND VIOLATION after commit` = 0 in post-commit bot-A/B/C logs (evidence is bot-D `4` + D2 `11` dated Aug 26/28/29). Need: (a) COW rejects placement inside gap pre-broadcast; (b) pre-broadcast existence check off slot→orderId map. Gap case hardening independent.

**Mode D — boundary-evidence re-derivation not persisted (freeze).** `grid_reconcile.ts:359-502` re-derives corrected boundary via `manager._restoreBoundary (:380)` but didn't survive next resync; bot-A re-derived at *every* hourly resync: `117→118 (00:28:48)`, `118→119 (01:00)`, `118→115 (02:00)`, `118→114 (03:00,04:00)`, `118→115 (04:30,05:00)`, `122→119 (07:00)` — 8× identical `ERROR` in ~7h. Bot-C `NO_FEASIBLE_BOUNDARY` → adoption-only at `00:27:17, 00:31:12, 04:27:48`; after `04:27:48` placed **zero orders 04:27:48→07:15:27 (~2h48m)** — only fills + `[ORPHAN-FILL]`. Earlier freeze `00:31→00:54`. Resumed only via fill-driven rotation `07:15`. → Fix #5 (LANDED).

**Post-commit hardening (§2.3 sub):** (1) lagging-node read-back thrash bot-B `06:43:09–06:47:09` after chunk5/9 fail — fresh CREATEs absent (`<order-7> likely lagging node`), protection piled to 14, all CREATEs rejected, 30s cap forced resync mid-broadcast ~4 min/24 events; (2) sync lock `timed out after 20000ms` + `[SYNC] abandoned force-released 69355ms` (~70s lost), bot-C ~110 `Structural resync defer` warnings at 250 ms/30s; (3) `[MAINT] n/m price correction(s) failed` ratios `2/3,2/2,1/8,2/25,1/23,1/14` — stale slot maps.

### 2.4 Incident timeline (bot-D Aug 28 17:09→Aug 29 17:27)

| Time | Event |
|---|---|
| Aug 28 17:09 | Sells fill at 1110–1176 (slots 140–148), tracking correct |
| 17:10:01 | `[RECOVERY] structural full grid resync for pending broadcasts before COW create` → regeneration + AMA refreshed |
| 17:10:02 | **16+ live sells `[SYNC] Unmatched chain order ... no adoptable slot found`** diff 0.43–0.57 vs tolerance 0.036 |
| 17:10–18:37 | 7 more regenerations (14 on Aug 28), each re-anchors to newest AMA center, 31 distinct orphaned sells that evening; 2071 warnings |
| 17:34:33 | Mode B sells slots 132/135/136 (~1054–1064) below fill range |
| 17:36:03 | 11 sells slots 124–131/133/134 (~1028–1061); slot-124 filled 150 ms after |
| 17:37:48 | Recovery resync restores boundary 119 (from 139/142) mid-drop — Mode A; new sell rail below orphans. Boundary crawled 142→139 silently to ~123 by 17:36 → slots 124–136 re-rolled to SELL, 20–80 BTS below own 17:09 fills |
| 17:37:39–17:55:09 | Slots 124→130 swept (~3s), then 131→136 — all 14 filled |
| 17:45 | `[DIVERGENCE-COW] Boundary-shift commit blocked (RECOVERY_EXHAUSTED)` — loop: blocked→resync→orphans→divergence |
| 18:02 | First surplus cancels via DIVERGENCE-COW ~50 min after orphaning |
| Aug 29 12:29 | Orphaned sells fill on bounce → outside grid accounting |
| 12:40–17:27 | `[ANCHOR-DIVERGENCE]` ±22; 17:27 periodic sync finds 40 filled at once (buys 978–1026, sells 1099–1112); PLACEMENT-GUARD rotates up to 31 buys + 8 sells/batch |

+ 11 graceful restarts in 30h (`Restored boundary` 57×).

### 2.5 Root-cause chain (code refs)
1. Ladder quantized to center. 2. Recovery resyncs re-anchor via two config points (see Fix #1). 3. Tolerance rounding-scale `≈0.036` at 1110 vs AMA shift `0.045%` → `~0.5` shift = 15× tolerance → pass-1 + pass-2 adoption (`sync_engine.ts:146-156,:1040-1060`) reject. 4. `PRICE_DRIFT_TOLERANCE_MULTIPLIER 4` (`constants.ts:557`) → budget 0.144 < 0.43 diff → no `price-drift-orphan` → only logged (`dexbot_maintenance_runtime.ts:1311-1317`). 5. Regenerated ladder sell rail below orphans → self-undercut; `maxFilledSellPrice/minFilledBuyPrice` built from grid-tracked fills only → guard unenforceable once orphans unmanaged; orphans later fill outside accounting.

### 2.6 Ranked fixes (with 2026-08-30 landed status)

**#1 Stop re-anchoring on recovery resyncs (two config points, highest leverage) — LANDED 2026-08-30 (`4838bcb0`).**
`rms_structural_grid_resync` → both flipped: (`dexbot_maintenance_runtime.ts:2327` `requestGridReset` call, hardcoded `refreshCenterPrice:false`) + (`:102` `GRID_RESYNC_REASONS.rms_structural_grid_resync.shouldRefreshCenterPrice: false`, covers the `buildGridResyncOptions('rms_structural_grid_resync')` call sites at `:1710-1712`). Structural resync keeps geometry; re-anchor only on manual/trigger-file and `GRID_RESYNC_REASONS` market-adapter delta/slope/bootstrap — intentionally stay `true`. `requestGridReset` default `TRUE` (`:2194`) so manual resets still re-anchor. Risk if center moved: geometry briefly mispriced but managed vs orphaning.

**#2 Regeneration must preserve order identity (defense-in-depth) — LANDED bounded 4×.**
`recalculateGrid` after `initializeGrid` adopts `chainOpenOrders` into nearest slots at chain price before reconcile; alt widen pass-2 fallback to ~0.25 step for VIRTUAL only. `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER 4` (`constants.ts` GRID_LIMITS) → 0.144 at 1110 (~¼ step); bot-D diffs 0.43–0.57 beyond band — coherent layering: #1 removes large diffs, residual → #3 surplus cancel. Also pre-empts `price-drift-orphan` on empty slots. Invariant: resync (incl. startup reconcile) never leaves live order unmanaged. Also covers startup reconcile (bot-A `<order-8>` 06:42→07:00 adopted to slot-140 still `Unmatched`; `<order-9>` re-adopted 6× 01:00–05:00 then `06:42:15 ORPHAN-FILL`).

**#3 Reconcile is update-first: never pre-emptively cancel unmatched (revised) — LANDED 2026-08-30 revised.**
Original force-cancel regressed reset path (fresh grid no ACTIVE bindings → cancelled instead of batch-updated). Revised `reconcileGridOrders`: never cancels in duplicate/route phase; `_reconcileStartupSide` 1. updates onto target slots batched (`plannedUpdates → _executeStartupUpdateBatch`), 2. creates missing, 3. cancels surplus only (`chainCount-targetCount` farthest-first) + Phase-3 stale surplus beyond target on fresh post-Phase-2 read. Invariant holds via adoption-or-surplus; guard `matchedOnGrid>0 || neededSlots===0` prevents fresh-grid nuking; pending-broadcast protection stays.

**#4 Log live boundary on every role (observability, zero risk) — LANDED.**
Debug line: `[BOUNDARY] boundary=123 sellStart=128 spread=4 anchorProjected=138 maxFilledSell=1044.79` on role/placement — makes Mode B diagnosable.

**#5 Persist boundary-evidence + define NO_FEASIBLE recovery (Mode D, high impact) — LANDED 2026-08-30 (`4838bcb0`), extended `a54863ca`.**
(a) Persistence: `recalculateGrid` persists the reconciled grid after reconcile, so the `manager._restoreBoundary` re-derivation (`grid_reconcile.ts:380`) survives to the next cycle. After fix: `[BOUNDARY-EVIDENCE]` contradiction fires at most once per stale boundary. (b) NO_FEASIBLE: bounded periodic re-validation (5min cooldown, 20 attempts) landed with `4838bcb0`; `a54863ca` went further — the validator enumerates straddling orders (`conflictingBuyIds/conflictingSellIds`) and the reconcile escalates a cancel ladder (smaller single side → other side → both, `grid_reconcile.ts:417-444`), re-derives the boundary and proceeds with placements; the adoption-only freeze remains only as a defensive fallback.

**#6 Retry/backoff post-broadcast adoption read-back — LANDED (cooldown `4838bcb0` + retry `d808c052`).**
`deferUncertainBroadcastRead` (`dexbot_cow_runtime.ts:301`) 30s escalation cooldown bounds thrash; `adoptPlacedBatchFromChain` retries lagging/failed by-id reads (3 attempts, 2s/4s backoff) before deferring with pending-broadcast protection kept. Cross-node failover remains open.

**#7 Sync-lock/maintenance observability — LANDED.**
Throttle `Structural resync defer` to first/last per cap window (was 120/30s); log/retry `[MAINT] n/m failed` with orderId/reason.

**Mode C hardening — OPEN.** (a) COW pre-broadcast gap-band reject; (b) order-existence check off slot→orderId map. Note: the GAP-P1 same-batch cancel that covered commit-time in-gap placement was reverted `e2898e51`; commit-time in-gap placement is currently caught only by the P3 boundary-evidence gate + adoption.

### 2.7 Relation to PRICE_FIRST draft
#1 removes Mode A & major boundary churn; PRICE_FIRST fixes Mode B (09:32 triple direct target, 17:27 sweep budget < displacement shows lag at scale); #5 complementary (draft solves *which* boundary, #5 makes it stick). Sequence: #1 → PRICE_FIRST flag → #2/#3 → #4/#5.

### 2.8 Verification — moved to §7 (plus gap/Mode C/drift targets there)

---

## 3. Orphan-Fill & Fund-Invariant — Root Cause & Fix Plan — from `ORPHAN_FILL_INVARIANT_ROOT_CAUSE_AND_FIX.md` (Status: P0s + rotation LANDED `1b27f6eb`/`4838bcb0`/`d808c052`; P1 atomicity PARTIAL; duplicate-cancel hard-error and P2 counters still open; Scope: `dexbot_cow_runtime.ts, sync_engine.ts, chain_orders.ts, dexbot_state_recovery.ts, dexbot_maintenance_runtime.ts, strategy.ts, constants.ts`; Evidence: `profiles/logs/<bot>.log` Aug 28 17:40–17:57, Aug 29 15:13–15:19)

### 3.1 TL;DR — one cascade
1. COW concurrency lets fill batch plan against stale master and double-place at same price. 2. Second batch commit refused (`master mutation during rebalancing`) → fresh chain orders not in master. 3. Fallback adoption re-reads capped `get_full_accounts` truncating freshest orders + lossy duplicate-price skip → master diverges. 4. Fund recalc flags violation → recovery deletes (now "corrupted") snapshot, regenerates from truncated read (40/42) permanently orphaning two orders. 5. Orphans fill no-slot → `ORPHAN-FILL` → more violations → recovery reloads stale boundary → slot-90 same-slot refill loop.

Slot-90 loop is *proximate* form; rotation suppression is mechanism, cascade is upstream cause detaching boundary.

### 3.2 Full picture
**Step 1 — Race:** ~`17:40:39–51` market moved fast, buys filled, boundary crawled down, sells `<order-1>…<order-4>`, `<order-5>`, `<order-6>…<order-10>`. `_batchInFlight` serializes fill consumer but planning+broadcast not atomic with master commit: Batch A broadcasts `<order-1>…<order-4>,<order-5>` at `17:40:39`; Batch B plans stale, places `<order-6>/<order-7>` at same prices (`17:40:42 a COW broadcast is already in flight; deferring`), commit refused `17:40:51.237 [COW] Refusing stale working grid commit: master mutation during rebalancing` (now `utils/validate.ts:1102`), adoption `Orphaned chain order … duplicates price level of active slot-88` (`sync_engine.ts:906`).

**Step 2 — Refused → invariant:** Fresh sells not recorded, adoption `adoptPlacedBatchFromChain` (`dexbot_cow_runtime.ts:3364`) capped window drops freshest (`chain_orders.ts:573-638`), adoption lossy `<order-6> NOT adopted / <order-9>→slot-106 / <order-10>→slot-107`, collides with re-plan `Rejecting CREATE for slot-105/106 existing orderId=<order-8>/<order-9>` (`17:40:51.335`). Fund recalc `CRITICAL: Fund invariant violation (SELL): blockchainTotal (474877) != trackedTotal (473173) diff:1703.62 allowed:474.87`.

**Step 3 — Recovery:** `Fund invariant → state recovery (1/5)` → `Restored boundary 82` → `[SNAPSHOT-REJECT] drift sell=1703.62 — Deleting snapshot` → `Synchronization from 40 blockchain orders — TRUNCATED: 42 live, 40 read` → regeneration matches `165→91,167→108,168→110` but `169,174` never matched (dropped).

**Step 4 — ORPHAN-FILL:** `17:57:18 WARN [ORPHAN-FILL] Processing funds for unknown order <order-10>/<order-9> (not in grid but crediting proceeds)` — no slot virtualized → more violations → Aug 29 stale boundary `90` (`Restored boundary index: 90`).

**Step 5 — Rotation same-slot:** `15:19:06` partial fill `<order-11>` slot-90 dust `2.92`, dust detection cancelled the residual, synthesizing a fill with `skipBoundaryShift:true` (removed `1b27f6eb`; defensive check removed this commit — `order/utils/order.ts` and `manager.ts` no longer inspect `skipBoundaryShift`; reintroduction would silently restore the same-slot fill loop) → `isShiftEligibleFill` false → boundary crawl suppressed. `processFilledOrders` only rebalances non-partial (`manager.ts:1460`) but synthetic `isDelayedRotationTrigger` forces rebalance with boundary frozen → slot-90 stays `BUY` → `Placed buy slot-90 -> <order-12>` `15:19:15` → `FILL DETECTED slot-90` `15:19:39`. Boundary detached (`projected=72 drift -18`, `PROJECTION_ENABLED false` `constants.ts:729`; the projection override itself was removed `3713c496`) → buy above market re-fills. Root fix: filled buy should rotate (SELL or bottom BUY), not re-stamp same price — LANDED `1b27f6eb`.

### 3.3 Fix plan (layered; statuses corrected against HEAD — see §3 header)

**P0 Reliable ID-based adoption after refused commit — LANDED `1b27f6eb` (hardened `d808c052`).** Kills orphan/invariant at source: `adoptPlacedBatchFromChain` builds `collectKnownOnChainOrderIds(mgr, placedResults, placedContexts)` (`dexbot_cow_runtime.ts:3281,3364`) = `mgr.grid[*].orderId ∪ fresh CREATE ids from `extractBatchOperationResults(result)[i][1]`↔`executedContexts[i]` (`:3293`); re-read by ID `chainOrders.batchReadOrders (chain_orders.ts:530)` → `syncFromOpenOrders(fullChain, {skipAccounting:false})`; lagging-node deferral: if ANY fresh CREATE id `null` → defer (`return false`) keep protection (later read adopts), by-id error → defer (no fallback to window); absent master ids = expected. `d808c052` added a retry (3 attempts, 2s/4s backoff) before deferring. Window read remains fallback only and defers on `truncated`.

**P0 Recovery must not lose orders when snapshot deleted — LANDED `1b27f6eb`.** `recoverFromPersistedGrid` (`dexbot_state_recovery.ts:314`) on truncated window falls back to `batchReadOrders` over `persistedGrid[*].orderId` (recovers bot's own incl. ID-adopted creates now persisted), without virtualizing ACTIVE; cannot discover brand-new orphans (prevented above); with no known ids still defers. Intentionally lossy for unenumeratable = reconcile virtualize-as-filled acceptable here; adoption path hard-defers.

**P1 Atomic plan→broadcast→commit — PARTIAL.** Landed pieces: `restoreBoundaryAfterAdoption` re-applies the batch's shifted boundary immediately after by-id adoption (`1b27f6eb`); Phase-2 reconcile wrapped in a refcounted broadcast flag with `_awaitBroadcastIdle` deferral (`d808c052`); stale-commit refusal lives at `utils/validate.ts:1102`. Still open: full re-plan from fresh master after winning `waitForCowBroadcastSingleFlight` + a COW-plan mutex covering the entire plan→broadcast→commit; dust-cancel `checkGridHealth` waits.

**P1 Rotation same-slot — LANDED core (`1b27f6eb`); sub-fixes superseded.** (1) `skipBoundaryShift:true` removed from both dust synthetic fills (was `dexbot_maintenance_runtime.ts:1821/:1826`) — dust fills are shift-eligible again; regression guard `tests/test_rotation_no_same_slot.ts` now 4 cases (ROT-4 same-slot loop case removed this commit, guard deleted); no defensive `skipBoundaryShift` check remains (`order/utils/order.ts` + `manager.ts` removed). Reintroduction of the flag would silently restore the same-slot fill loop. (2) moot — dust fills now trigger the crawl naturally. (3) SUPERSEDED — the Phase-2 projection override was removed entirely (`3713c496`); `ANCHOR.PROJECTION_ENABLED` (`constants.ts:729`) is an unused constant. (4) SUPERSEDED — the `d808c052` anchor-refill/price-sanity guard extensions were removed `e2898e51`; the original `calculateTargetGrid` fill-range rotation (`strategy.ts:345-369`) remains.

**P1 Duplicate-orphan cancellation reliable — OPEN (partially mitigated).** Verify `queueCorrection` cancelOnly (`sync_engine.ts:913`) executes, not blocked by in-flight; hard error if cannot cancel. `d808c052` mitigates the consequences (unknown-fill adoption-before-credit + empty-read guard) but the explicit verify/hard-error behavior is still open.

**P2 Observability — PARTIAL.** `d808c052` added anchor price-outlier rejection with rate-limited warns; drift logging/alert >active window, re-stamp BUY above anchor metric, and refused-commit/orphan-fill counters remain open. (The `d808c052` price-sanity warn surface was removed `e2898e51`.)

### 3.4 Key code references (from source table)

`dexbot_cow_runtime.ts:3281,3364` by-id adoption (`collectKnownOnChainOrderIds`/`adoptPlacedBatchFromChain`); `:3293` placed IDs from broadcast result; stale-commit refusal `utils/validate.ts:1102`; `sync_engine.ts:906-913` duplicate skip + `queueCorrection`; `chain_orders.ts:573-638` truncation cap; `:503 readSingleOrder, :530 batchReadOrders` immune; `dexbot_state_recovery.ts:314,581` recovery/reject; `dexbot_maintenance_runtime.ts:806 performGridResync`; `order/utils/order.ts:1560-1561` `isShiftEligibleFill`; `strategy.ts:345-369` fill-range rotation guard; `constants.ts:729` `PROJECTION_ENABLED` (unused since `3713c496`); `<bot>.log 15:19:06→39` slot-90 loop.

---

## 4. Price-First Alignment Plan — from `PRICE_FIRST_ALIGNMENT_PLAN.md` (Status: Phase 1 SHIPPED and live as shadow telemetry; **Phase 2 projection was enabled `1bbf1a23`, then REMOVED `3713c496`** after a live-bot incident — the anchor veto overrode chain evidence and drove destructive gap-band cancels; the anchor is now observability-only and the boundary is chain-evidence-derived. Phase 3 is moot (no second write path to retire); Phase 4 golden tests landed (`tests/test_anchor_golden_geometry.ts`). Scope: grid boundary state `modules/order/`; Related: three-layer crawl/anchor/guard fix)

### 4.1 Goal
One source of truth `MarketAnchor` (fill-derived), boundary demoted to rebuildable cache. Phase 2 is goal; Phase 3 deletion conditional on soak evidence. **KPI:** `[PLACEMENT-GUARD]` rotations = 0 + divergence telemetry flatlined.

### 4.2 Background
Grid's "where is market" maintained two ways that disagree: boundary (discrete, crawled) vs fill prices (continuous, authoritative). Every incident = boundary diverging from price.

### 4.3 Key decisions
| # | Decision | Rationale |
|---|---|---|
| D1 | Price overrides funds, bounded fund floor (≤½ active window; severe shortfalls reduce sizes via `calculateBudgetedSizes`) | Preserve I1 unconditionally; sizing degrades gracefully |
| D2 | Projection reuses `getSellStartIdx`/`isSlotInRail` only | No new gap conventions, avoid baking `splitIdx - floor(gap/2) - 1` asymmetries |
| D3 | Single boolean flag `projectionEnabled` | One test matrix, legacy stays as rollback |
| D4 | Fills applied in block order (`block_num` before trailing) | Replay order would flip correction direction |
| D5 | Anchor never persisted — book-seeded (highest buy / lowest sell) startup, `startPrice` fallback | No schema/migration, fossilized book; guard covers until first fill |
| D6 | Deletion evidence-gated (14-day) | Phases 1–2 carry safety; deletion hygiene must earn risk |

### 4.4 Invariants I1–I6
I1 No order on wrong side of just-filled price (`sell ≤ maxFill, buy > minFill`) — `test_boundary_price_anchor.ts`; I2 Single eligible fill ±1 crawl — `test_multi_partial_consolidation.ts`; I3 Just-filled BUY refills as BUY at fill price — `test_multifill_opposite_partial.ts`; I4 Boundary never exceeds gap-aware ceiling / collapses on degenerate geometry — `test_boundary_restore_validation.ts`; I5 Price-less fills degrade conservatively — `test_boundary_price_anchor.ts #4`; I6 COW-commit-only writes (`_setBoundary`) — `test_cow_boundary_slot_replacement.ts`.

### 4.5 Phase 1 — MarketAnchor + divergence telemetry (no behavior change) — SHIPPED
In-memory `marketAnchor` on manager (`dexbot_fill_runtime.ts`) `lastFillPrice/maxFilledSellPrice/minFilledBuyPrice/lastFillSide/updatedAt` updated on eligible fill (`isShiftEligibleFill`), `buildFillKey` deduped, block ordered (D4, D5); book-seeding; shadow log `[ANCHOR-DIVERGENCE] projected=X bookkept=Y drift=Z` `|Z|>1` warn (>~3), thresholds `constants.ts`; freshness 15 min OR >3 increments beyond anchor (`ANCHOR_FRESHNESS`); replay protection history uses latest only; tagging replay vs live via `sync_engine.ts`. Gate: suite green + unit for idempotent/block/replay/freshness/book-seeding.

### 4.6 Phase 2 — Projection live (goal) — SUPERSEDED: landed `1bbf1a23` (flag on), REMOVED `3713c496`
Pure `projectAnchorToGrid(anchor, allSlots, gapSlots)` via `computePriceAnchoredBoundaryTarget` (`order/utils/order.ts`), gap centered on traded range + I4 ceiling; `calculateTargetGrid` (`strategy.ts`): `boundaryIdx = anchorFresh ? project(...) : legacyDeriveTargetBoundary(...)` gated `projectionEnabled` (D3); fund floor D1 at most ½ window (`syncBoundaryToFunds/calculateFundDrivenBoundary` `utils/system.ts`); placement guard unchanged as enforcement I1; stale-anchor continues from last range decayed to AMA center (not fall back to crawl). Gate: suite green flag on/off + property harness random bursts/re-plans/replays/empty-book all I1–I6; flip per-bot start smaller, 48h soak watcher `ANCHOR-DIVERGENCE`/`PLACEMENT-GUARD`/fund friction. **Done = incident class closed, rollback = flag flip.**
**Post-mortem (`3713c496`):** the projection override plus the anchor's veto role let a fresh fill-anchor override chain evidence under a stale boundary, and the gap-band sweep then cancelled legitimate orders. Removed: the `projectionEnabled` gating, the `projectAnchorToGrid` boundary override, and the fund-floor pull in `calculateTargetGrid`. `strategy.ts:232-236` records the decision — the anchor is shadow telemetry only (`[ANCHOR-DIVERGENCE]`/`[ANCHOR-STALE]`). The original fill-range rotation guard remains at `strategy.ts:345-369`; the `d808c052` price-sanity/anchor-refill guard extensions were removed `e2898e51`.

### 4.7 Phase 3 — Conditional deletion (evidence-gated 14-day zero rotations + flat divergence) *(MOOT: Phase 2 was removed `3713c496`, so there is no second write path to retire; the legacy machinery below is the live path)*
3a: `deriveTargetBoundary` collapses to initial-recovery + projection; delete `netShift`/cross-chunk budget/window-cap; delete `_boundaryShiftBudget/_boundaryShiftBudgetBase/_boundaryAnchor` (`dexbot_class.ts`) + re-plan restore (`dexbot_cow_runtime.ts`); fund sync now D1 floor only; spread-correction promotes via anchor; remaining readers projection-based; `manager._setBoundary` stays (I6). 3b: `account_orders.loadBoundaryIdx` (`validatePersistedBoundary` `dexbot_state_recovery.ts`) + `storeGrid` (`utils/system.ts`) stop persisting boundary; startup = load grid → book-seed → project. Gate: harness + fund-floor/recovery cases; kill-switch: corrupt/delete snapshot must converge from chain alone.

### 4.8 Phase 4 — Geometry golden tests (pin, don't refactor) *(LANDED: `tests/test_anchor_golden_geometry.ts`)*
Golden files canonical grid × gap `{0,1,2,3}` × price at/between slots × direction asserting `calculateIdealBoundary/getSellStartIdx/projectAnchorToGrid` agree. Gate: green.

### 4.9 Sequencing & risk
| Phase | Size | Risk | Rollback |
|---|---|---|---|
| 1 | 2–3d | none | delete struct |
| 2 | 3–5d | medium | `projectionEnabled=false` |
| 3 | 3–4d | low (evidence-gated) | revert |
| 4 | 1d | none | n/a |
Work on `test`; per-phase mergeable unit with soak; flag flip is sharp edge — per-bot; D1 validated in soak; if 14-day never clean → stop at Phase 2 (guard+projection hold invariants).

### 4.10 Definition of Done
Goal (Phase 2): I1–I6 property pass, full suite green, harness random, 48h per-bot no fund-invariant; Full alignment (Phase 3): 14-day zero guard rotations + zero divergence warnings, no path increments `boundaryIdx` (only read/project), answer "where will next sell be?" from one struct.

---

## 5. Cross-doc fix lineup (deduplicated, dependency order)

1. **GAP P1+P2+P4** + **LADDER #1** earliest (gap writer + re-anchor stop — highest leverage, prevents Aug 28 cascade 7 regs×orphaning). — *GAP P1/P2 landed `f94d6ec4` then reverted (`3713c496`/`e2898e51`); GAP P4 + LADDER #1 live.*
2. **LADDER #4 / PRICE Phase 1** log-only, parallel. — *done (`4838bcb0`; Phase 1 telemetry live).*
3. **PRICE Phase 2** flag per-bot 48h (Mode B lag) — price-first truth. — *SUPERSEDED: landed `1bbf1a23`, removed `3713c496` (see §4).*
4. **LADDER #2/#3** identity + update-first hardening. — *done (`4838bcb0`).*
5. **LADDER #5 / ORPHAN P0 recovery-by-ID** persistence (long freeze). — *done (`4838bcb0`, extended `a54863ca`; recovery-by-ID `1b27f6eb`).*
6. **ORPHAN P0 ID-based adoption** + **P1 atomicity** (stale-plan race). — *P0 done (`1b27f6eb`, retry `d808c052`); atomicity partial.*
7. **ORPHAN P1 rotation + P1 duplicate + GAP P3/P5 + Mode C guards + P2 guardrails** fast-follow. — *rotation + GAP P3/P5 done; duplicate-cancel hard-error, Mode C guards and P2 counters open.*
8. **PRICE Phase 3/4** only after evidence (`grid_correction_check` see §7). If soak never clean, stop at Phase 2. — *Phase 3 moot; Phase 4 golden tests landed.*

---

## 6. Consolidated invariants (what must hold after all fixes)
- **Gap-band (amended `3713c496`/`e2898e51`):** in-gap chain orders are never cancelled as a self-healing net; they are adopted by the normal reconcile path once the boundary is re-derived from chain evidence (P3 gate). Placement into the band is prevented by the boundary gate, not by cancellation sweeps.
- **Identity:** every resync (incl. startup reconcile) leaves no live order unmanaged (adopted-or-cancelled-as-surplus, surplus = `chainCount-targetCount` farthest-first).
- **Monotonicity (grid-check):** adjacent same-direction fills monotonic rising sell / falling buy (equal OK).
- **I1–I6 PRICE_FIRST** plus COW-commit-only boundary writes and price-less degrades conservatively.

---

## 7. Consolidated verification — grid-correction check as regression gate

**Tooling (new):** `analysis/grid_correction_check.ts` (see §0) — primary external check for all docs' inversions; run per market:
```
npm run analysis:grid-check -- --bot-key <bot-key> --account 1.2.xxxxx --hours 168
npm run analysis:grid-check -- --bot-key <bot-key> --account 1.2.xxxxx --hours 720
npm run analysis:grid-check -- --bot-key <bot-key> --account 1.2.xxxxx --hours 168 --json out.json --csv out.csv
# cross-pair opt: --include-cross-pair ; per-fill opt: --per-fill ; tolerance opt: --tolerance 0.1
```
Pairs-checked base excludes cross-pair unless flagged; strict sat-level detection (`detectViolations`, `aggregateByOrder`).

**Targets (replay the windows in the 4 docs):**
- Regeneration unchanged center → `0` `Unmatched chain order`; recovery `rms_structural_grid_resync` not promote AMA.
- Shifted center → every live order adopted or immediate cancel (no silent unmanaged); startup reconcile replays: bot-A `<order-8>` 07:00 and `<order-9>` 6× loop must stay managed, no `ORPHAN-FILL`.
- Boundary re-derivation persists: bot-A `00:28–07:00` must not repeat `[BOUNDARY-EVIDENCE]` for unchanged chain.
- `NO_FEASIBLE_BOUNDARY` bot-C `04:27:48` resumes on next sync tick (bounded, not hours) with WARN.
- Post-broadcast read-back retry: bot-B `06:43` no `14` piled / forced resync mid-broadcast.
- COW commit never places inside gap; pre-broadcast existence check: bot-B `<order-4/5>` + bot-D/D2 `GAP-BAND` fixtures → `0`. *(Amended: the commit-time in-gap cancel sweep was reverted `e2898e51` — current expectation is adoption-after-chain-evidence-correction; `0` unmanaged in-gap orders remains the target.)*
- Aug 28 burst `17:09–17:16` (3 regs/6m, sells 1110–1176) → `0` orphans, `0` sells below asks.
- **Orphan regression over ~7h post-`cd690000` on bot-A/B/C:** distinct `Unmatched` `58/60/91 → ~0` (full `229/107/172 → ~0`), `Fund invariant violation` `0` (was `3077.07→3184.93` etc.), `ORPHAN-FILL` `0` (was `7/33/22`), repeated `[BOUNDARY-EVIDENCE]` `0`, deferred minutes `0`, `[MAINT] n/m failed` `0`.
- **Grid-correction soak (external, strict):** pre-fix baselines on the affected markets showed double-digit `%` same-direction inversion rates over 7d/30d windows → `0` sustained. Sustain 48h per-bot (Phase 2) and 14-day zero-guard/divergence (Phase 3). *(Phase 2/3 soak gates moot since `3713c496` — projection removed; the divergence telemetry remains as a monitoring signal.)* **Failure = place `sell→sell` lower / `buy→buy` higher.**

Original doc regression excerpts preserved: GAP P6 A/B/C; LADDER §2.8 checks (10 bullets); ORPHAN §3 guardrails; PRICE §4.7/4.10 kill-switch. The randomized chaos/property harness was the PRICE_FIRST Phase 2 gate (§4.6), not part of LADDER §2.8.

---

## 8. Deletion checklist (next commit)

- [x] `git rm docs/GAP_BAND_ORPHAN_PREVENTION_PLAN.md docs/LADDER_RECENTER_ORPHAN_ROOT_CAUSE.md docs/ORPHAN_FILL_INVARIANT_ROOT_CAUSE_AND_FIX.md docs/PRICE_FIRST_ALIGNMENT_PLAN.md` (staged 2026-08-31)
- [x] No other doc/index lists the four (verified 2026-08-31); `analysis/README.md` documents the new `grid_correction_check` tool.
- [x] Stale `*.md` filename references in code comments/tests updated to this file (9 module files, 6 test files).
- [ ] No code refs lost — all paths in §§1–4 remain anchored to this file.

*Generated 2026-08-31 from the 4 test-only docs at their HEAD contents; statuses corrected against `test` HEAD `a54863ca` the same day (landed/reverted/superseded annotations with commit hashes; line references re-verified at that HEAD and subject to drift).*
