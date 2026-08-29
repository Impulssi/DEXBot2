# Price-First Alignment Plan

**Status:** Phase 2 flag enabled (global default on) — 48h per-bot soak pending; Phase 3 deletion still evidence-gated (14-day zero-guard run required)
**Scope:** Grid boundary state architecture (`modules/order/`)
**Related:** Boundary-crawl cap / placement-guard fix (three-layer version: count crawl + price anchor + placement guard)

## Goal

One source of truth for "where is the market" — a fill-derived `MarketAnchor` — with the
boundary index demoted to a rebuildable cache. When Phase 2 ships, the incident class
(sells below the last fill, boundary lagging a sweep) is dead: the guard enforces the
economic invariant at placement and the projection keeps geometry aligned with price.

**Phase 2 is the goal.** Phase 3 (deletion of the legacy machinery) is conditional on soak
evidence, not a scheduled milestone — it happens because the data proves it safe, and is
skipped without harm if it never does.

**Alignment KPI:** `[PLACEMENT-GUARD]` rotations = 0 over a soak period, and
boundary-divergence telemetry (Phase 1) flatlined. The guard going idle is the proof of
alignment.

## Background

Today the grid's notion of "where is the market" is maintained two ways that can disagree:

- **Boundary index** — discrete, bookkept state. Moved by count-based crawl, spread
  correction, fund-driven sync, reconcile, restore-from-snapshot. Must be *derived
  correctly* by every code path (fill processing, re-plans, recovery, resync).
- **Fill prices** — continuous, authoritative facts from the chain. Cannot drift; they
  *are* what happened.

Every incident in this class is the boundary diverging from price reality. The three-layer
fix repairs the divergence after the fact. This plan removes the class of bug by making
divergence impossible — with the minimum of new machinery.

## Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Price overrides funds, with a bounded fund floor.** The anchor/projection places the boundary; fund-driven logic may pull it toward the affordable rail by at most half an active window (never push it past price truth). Severe shortfalls reduce order *sizes*, not rail *locations*. | Preserves the price invariant (I1) unconditionally; sizing is already budget-aware (`calculateBudgetedSizes`), so unaffordable rails degrade gracefully. Validate in the Phase 2 soak — revisit if fund-floor friction shows up in logs. |
| D2 | **Projection reuses existing geometry helpers only** (`getSellStartIdx`, `isSlotInRail`); it introduces no new gap conventions. | Prevents baking today's subtle `splitIdx − floor(gap/2) − 1` asymmetries into the new primary path. |
| D3 | **Single boolean flag** (`projectionEnabled`), not a mode matrix. Cold-anchor falls back to the legacy path automatically. | One flag = one test matrix; the old path stays intact as the rollback. |
| D4 | **Anchor ordering: fills are applied in block order.** When history order is uncertain, order by `block_num` before computing the trailing direction. | The trailing-fill rule silently assumes chronological delivery; out-of-order replay would flip the correction direction. |
| D5 | **The anchor is never persisted.** It lives in memory; on startup it is seeded from the on-chain book (lowest live sell / highest live buy bound the traded range) and refined by the first fills. | The book is a fossilized anchor — persisting a second copy means snapshot schema changes, migration, and two write paths to retire, for no precision a grid bot needs. A cold start (empty book) falls back to `startPrice` geometry; the guard covers the window until the first fill. |
| D6 | **Deletion is evidence-gated.** The legacy crawl/persistence is removed only after a soak window (default 14 days) shows zero guard rotations and flat divergence. If the soak never passes, the machinery stays — the guard still holds the invariant. | Keeps the plan honest: phases 1–2 carry all the safety value; deletion is hygiene that must earn its risk. |

## Invariants (the contract every phase must preserve)

| # | Invariant | Encoded in |
|---|---|---|
| I1 | No order placed on the wrong side of a just-filled price (sell ≤ maxFill, buy > minFill) | `tests/test_boundary_price_anchor.ts` |
| I2 | Single eligible fill → exactly ±1 slot crawl | `tests/test_multi_partial_consolidation.ts` |
| I3 | Just-filled BUY slot refills as BUY at the fill price | `tests/test_multifill_opposite_partial.ts` |
| I4 | Boundary never exceeds gap-aware ceiling; never collapses on degenerate geometry | `tests/test_boundary_restore_validation.ts` |
| I5 | Price-less fills (no price, no slot match) degrade to conservative behavior | `tests/test_boundary_price_anchor.ts` #4 |
| I6 | COW-commit-only boundary writes (`_setBoundary` discipline) | `tests/test_cow_boundary_slot_replacement.ts` |

---

## Phase 1 — MarketAnchor state + divergence telemetry (no behavior change)

The anchor struct and its shadow logging are the same code in the same files — ship them
together. Nothing reads the anchor yet; zero behavioral risk.

- Introduce an **in-memory** `marketAnchor` on the manager
  (`modules/dexbot_fill_runtime.ts`): `lastFillPrice`, `maxFilledSellPrice`,
  `minFilledBuyPrice`, `lastFillSide`, `updatedAt` — updated on every *eligible* fill
  (same `isShiftEligibleFill` rule), idempotent under re-delivery (keyed by the existing
  `buildFillKey` dedupe), applied in block order (D4, D5).
- **Book-seeding at startup:** derive the initial anchor range from the active on-chain
  orders (highest live buy price, lowest live sell price). No persistence, no schema
  changes (D5).
- Shadow telemetry: on each `calculateTargetGrid` call, project the anchor to a boundary
  index and log `[ANCHOR-DIVERGENCE] projected=X bookkept=Y drift=Z` when `|Z| > 1` (warn
  above threshold ~3). Thresholds in `constants.ts`.
- Freshness rule (`constants.ts` `ANCHOR_FRESHNESS`): fresh for 15 minutes OR until price
  moves > 3 grid increments beyond the anchor's range without a fill (whichever first).
- Replay protection: history-replay fills set the anchor to the *latest* fill only, never
  the extreme of the whole replay window (prevents a 200-fill backfill slamming the range).
- Tag replay vs live fills (history-mode sync already distinguishes these via replay-safe
  identifiers in `sync_engine.ts`).

**Gate:** full suite green; unit tests for idempotent re-delivery, block ordering, replay
cap, freshness, book-seeding (including the empty-book cold start). A soak run produces a
divergence histogram that sizes the real-world drift and validates the Phase 2 design.

## Phase 2 — Projection goes live (the goal)

- Implement `projectAnchorToGrid(anchor, allSlots, gapSlots)` as a pure function in
  `modules/order/utils/order.ts` — the existing `computePriceAnchoredBoundaryTarget` bound
  generalized: gap band centered on the traded range, both directions, plus the I4 ceiling
  clamp. Built only on existing geometry helpers (D2).
- In `calculateTargetGrid` (`modules/order/strategy.ts`):
  `boundaryIdx = anchorFresh ? projectAnchorToGrid(...) : legacyDeriveTargetBoundary(fills, ...)`,
  gated by the `projectionEnabled` runtime flag (default `false`) (D3).
- Fund interplay (D1): the fund-driven boundary (`syncBoundaryToFunds` /
  `calculateFundDrivenBoundary` in `modules/order/utils/system.ts`) becomes a **floor
  constraint** — it may pull the projected boundary toward the affordable rail by at most
  half an active window; it may never push the boundary past price truth. Severe
  shortfalls are handled by sizing, not location.
- Keep the placement guard unchanged — it stays the enforcement point (I1) permanently.
- **Stale-anchor behavior:** when the anchor ages out mid-operation, the projection
  continues from the last known range (decayed toward the AMA center by the maintenance
  runtime's recalc triggers) — it does **not** fall back to the count crawl. The count
  crawl remains only for truly price-less fills (I5). This avoids resurrecting the
  original bug for exactly the fills that arrive while stale.

**Gate:** existing suite green with the flag off and on; property test harness (randomized
fill sequences — mixed sides, chunk sizes 1–4, injected stale re-plans, replays, empty
book starts — asserting I1–I6; this harness is the chaos suite). Flip the flag on one bot;
soak 48h watching `[ANCHOR-DIVERGENCE]`, `[PLACEMENT-GUARD]`, and fund-floor friction.

**Done here means the goal is met:** incident class closed, KPI measurable, rollback is a
flag flip. Everything below is optional.

## Phase 3 — Conditional deletion (evidence-gated)

Triggered only when a 14-day soak shows zero `[PLACEMENT-GUARD]` rotations and flat
`[ANCHOR-DIVERGENCE]` (D6). Two commits, one phase:

**3a. Delete the legacy crawl and the bookkept boundary's special status.**
- `deriveTargetBoundary` collapses to: initial-recovery (null boundary) + projection call.
  The count-based `netShift`, cross-chunk budget, and window-cap logic are deleted.
- Delete the per-burst `_boundaryShiftBudget` / `_boundaryShiftBudgetBase` /
  `_boundaryAnchor` bookkeeping in `dexbot_class.ts` and the re-plan budget restore in
  `dexbot_cow_runtime.ts`.
- Fund-driven sync (`syncBoundaryToFunds`, `pendingBoundaryIdx` in `utils/system.ts` +
  `dexbot_cow_runtime.ts`) is now the D1 floor constraint only.
- Spread-correction boundary promotion (rail-edge logic in `modules/order/grid.ts`)
  switches from mutating the index to writing the anchor's range forward.
- Remaining readers made projection-based or confirmed lag-tolerant cache readers:
  `grid_reconcile.ts` / `grid_reconcile_internal.ts` (rail checks),
  `notifyBoundaryUpdate` (grid.ts notification surface), `utils/validate.ts`.
  (Claw has no grid-boundary consumers — verified.)
- `manager._setBoundary` stays as the single write site (I6 preserved).

**3b. Stop persisting the boundary from both write paths.**
- `account_orders.loadBoundaryIdx` (with `validatePersistedBoundary` in
  `dexbot_state_recovery.ts`) and the `storeGrid` snapshot path
  (`modules/order/utils/system.ts`) stop writing/reading the boundary. Startup becomes:
  load grid → book-seed anchor (D5) → project.

**Gate:** property harness extended with fund-floor and recovery-trigger scenarios;
kill-switch test — corrupt/delete the snapshot; startup must still converge to a correct
grid from chain state alone.

## Phase 4 — Geometry golden tests (pin, don't refactor)

Pin the current rail conventions with executable spec instead of a unification refactor:

- Golden-file tests: for a canonical grid fixture × gap ∈ {0,1,2,3} × price at slot /
  between slots × fill direction — assert `calculateIdealBoundary`,
  `getSellStartIdx`, and `projectAnchorToGrid` agree with a documented table.
- No helper moves, no module consolidation. If a future off-by-one appears, the golden
  files locate it; consolidation can happen then, with evidence.

**Gate:** golden files committed and green.

---

## Sequencing & risk

| Phase | Size | Risk | Rollback |
|---|---|---|---|
| 1 | 2–3 days | none (no readers) | delete struct |
| 2 | 3–5 days | medium | flag off (`projectionEnabled=false`) |
| 3 | 3–4 days | low (evidence-gated) | only after soak proof; git revert |
| 4 | 1 day | none (test-only) | n/a |

- Work on the `test` branch per the pipeline; each phase is one mergeable unit with its own
  soak window before promotion.
- The flag flip (Phase 2) is the only behaviorally sharp edge — do it per-bot, start with
  the smaller bot, watch the divergence/guard telemetry for 48h before touching the second.
- D1 (fund floor) is the one semantic change with real surface area — validate it during
  the Phase 2 soak before Phase 3 makes it load-bearing.
- If the 14-day soak never comes back clean, stop at Phase 2: the guard + projection still
  hold every invariant, and the legacy machinery remains as harmless dead weight to revisit
  later.

## Definition of Done

**Goal (end of Phase 2):**

1. All six invariants pass as property tests, not just fixtures.
2. Full suite green; property harness covers randomized bursts, re-plans, replays, and
   empty-book cold starts.
3. 48h per-bot soak: flag on, no fund-invariant violations attributable to rotation.

**Full alignment (end of Phase 3, evidence-gated):**

4. 14-day soak: zero `[PLACEMENT-GUARD]` rotations, zero `[ANCHOR-DIVERGENCE]` warnings.
5. **No code path increments `boundaryIdx`** — it is only read or projected.
6. A developer can answer "where will the next sell be placed?" from one struct, not four
   subsystems.
