# The Grid-Price Invariant

Status: **implemented; the emission check is BLOCKING**
Last verified against `test` HEAD `1382f267` (2026-09-13).

## The invariant

> **`order.price` for a slot-`idx` order must equal `priceForSlot(idx, genesis)`.**

The genesis `priceLevels` table is the only authoritative source of a slot's
price. A slot id encodes an index; the genesis table turns that index into a
price. Nothing else is a legitimate price for a slot.

This is enforced at grid build/load by `assertSlotPriceInvariant(slot, genesis)`
(`modules/order/utils/math.ts`), called from `modules/order/grid.ts`.

**Historical failure:** that assertion was *never called on the broadcast path*.
Placement args were built from the mutable `slot.price` field, so any code that
wrote `slot.price` — or constructed an order object with its own `price` — could
broadcast a non-grid price, with no comparison against the genesis table on the
way out.

### Not to be confused with two related but weaker checks

| Check | Question it answers | Sufficient? |
|---|---|---|
| `isChainPriceOutOfGrid` | Is the price inside `[levels[0], levels[last]]`? | **No** — bounds, not membership |
| `checkPlacementPriceSanity` (removed) | Is the price within 5% of a market reference? | **No** — different reference, flat threshold |
| `assertSlotPriceInvariant` | Is the price *this slot's* level? | **Yes** — true by construction for a valid order |

The distinction matters because the failure band is wide. With a typical
geometry (`minPrice 1.65x`, `maxPrice 10x` around mid), the configured span is
roughly `[0.196, 3.234]`, while the active window is 20 buy + 20 sell slots —
about `[0.293, 0.357]` at 0.5% increment. **Between the window edge and the
configured bound there is a band where a non-grid price is simultaneously "in
range" (passes every range guard) and "not a valid slot" (violates the
invariant), with no check in between.** Range guards cannot see it; only a
grid-membership check can.

## The failure mechanism

The engine had two contradictory sources of truth for "what price is this slot":

| Concept | Source | Used by |
|---|---|---|
| Genesis table | `priceForSlot(idx, genesis)` | grid build, load validation |
| Live slot price | `slot.price`, mutated from chain | COW broadcast, fill guard pivot |

Every observed violation was the second winning over the first. Five distinct
mechanisms fed it:

- **S1 — chain price overwrote the slot's identity price.** Orphan adoption set
  `price: chainOrder.price`, so a slot's id and its price could disagree.
- **S2 — pre-broadcast substitution re-broadcast the corrupted price.** The
  planned (genesis-derived) price was replaced with `liveSlot.price` — i.e. with
  whatever S1 wrote — and logged at `debug`, so it was invisible.
- **S3 — guards tested range membership, never grid membership.** See the table
  above.
- **S4 — the fill-guard pivot was untrusted.** `_lastFilledPrice` was written
  from fill prices at four sites, none validated against the grid. A guard that
  keeps the grid consistent was anchored to the same fill chain that S1/S2 could
  corrupt. Nothing protected the pivot itself.
- **S5 — bypasses skipped even that guard.** Spread-correction origins bypass it
  by design; the guard was stated to run on the "final post-freshness price",
  i.e. the price S2 had already replaced.

The unifying hazard: a price that is off-grid becomes *grid evidence*, and is
then re-emitted as if it were real market structure.

## The writer chain (historical)

Both links are now closed. The trace is kept because the *shape* is what the
check guards against recurring.

1. **Adoption overwrote the grid level** — `modules/order/sync_engine.ts`, the
   legacy no-genesis fallback (`sync-pass2-adopt-orphan` branch):
   ```ts
   const adoptedOrder = {
       ...adoptedSlot, orderId: chainOrderId, type: chainOrder.type,
       state: adoptedState, size: chainOrder.size,
       price: chainOrder.price,   // <-- genesis price discarded
       ...
   };
   ```
   It also matched by price *tolerance* rather than
   `slotIndexForPrice` + `isSlotInRail`, so it could land an order in a slot
   whose genesis price was far away — then cement that distance.

2. **Pre-broadcast substitution propagated it** — `modules/dexbot_cow_runtime.ts`,
   the CREATE branch's `liveSlot`/`priceDrift` block:
   ```ts
   const effectiveOrder = (priceDrift > 0)
       ? { ...order, price: livePrice, ... }   // planned price discarded
       : order;
   ```
   The name "freshness" implied the live price was *more* correct. That is only
   safe if `slot.price` is invariantly a genesis level — the exact thing nothing
   enforced.

Net: a chain order at a non-grid price was adopted into a slot, became that
slot's price, and was re-broadcast as a fresh CREATE at the same non-grid price.
A buy above the book fills immediately; the fill price then fed downstream
consumers (role rotation, boundary heuristics, the fill-guard pivot), which
inherited it as evidence and ratcheted further.

The observed signature: escalating BUYs at `0.363 → 0.565 → 0.614 → 0.739 →
0.793` against a ~0.31 market — each a `BUY > pivot` violation — then matched
lots sold back at ~0.306 for roughly -61%, plus a 107-violation burst.

## Enforcement: the six emission sites

Every site that builds a create/update op now runs the invariant check via
`checkGridPriceInvariant` / `reportGridPriceInvariant`
(`modules/order/utils/order.ts`):

| Site | Location |
|---|---|
| `CREATE` | `dexbot_cow_runtime.ts` |
| `UPDATE` (rotation) | `dexbot_cow_runtime.ts` |
| `CREATE-FALLBACK` | `dexbot_cow_runtime.ts` |
| `RECONCILE-CREATE` | `grid_reconcile_internal.ts` |
| `RECONCILE-UPDATE` | `grid_reconcile_internal.ts` |
| `STARTUP-CREATE` | `grid_reconcile_internal.ts` |

**The check fails open on anything unjudgeable** — missing genesis, synthetic or
chain-order ids, out-of-ladder indices, non-finite prices — so it can only fire
on a genuine mismatch and cannot false-positive on a legitimately wide grid.
That property is why it is safe where the earlier tuned guards were not.

The correct pattern already existed in the codebase:
`isUnknownFillOrderAdoptable` (`modules/dexbot_fill_runtime.ts`) derives the
index, checks `isChainPriceOutOfGrid`, checks `isSlotInRail`, and requires the
slot be free. **The fill path was the one place that faithfully used the genesis
table; the broadcast and adoption paths did not.** That is the pattern the rest
of the engine should follow, and it is the model for the adoption fix below.

For the rotation `UPDATE`, the check is against **`action.newGridId`** (the
destination slot): a rotation re-prices to the destination's level, so that is
the slot whose genesis price the emitted price must match. Every planner
producer derives `newPrice` from the object `newGridId` names, so the pairing is
consistent by construction.

**The emitted rotation price is derived, not merely checked.** The planner sets
`newPrice = hole.order.price`, a *mutable* slot field, so the emission would
otherwise be only as sound as whatever last wrote that object. The UPDATE path
therefore derives the price with `deriveRotationPrice` —
`priceForSlot(parseSlotIndex(action.newGridId), genesis)` — and uses the planned
price only when there is no ladder to derive from (migration), warning on any
disagreement. The invariant check stays as the backstop for that no-genesis
case. Note this also means the last-fill guard and the gap-evacuation probe
judge the price that will actually be emitted.

The check is self-validating in the strong sense: `checkGridPriceInvariant`
re-derives the expected level from the slot *id* and compares it against the
passed price, so it never validates a price against itself. A producer that
paired a source price with a destination id is caught (13.9% drift in the
fixture), as is a destination hole carrying an already-corrupted price (28%).

### This BLOCKS

`recordGridPriceInvariantCheck` / `reportGridPriceInvariant` return whether the
caller may emit. On a genuine off-grid price the emission is **skipped** (the
slot is marked skipped so the next reconcile cycle re-plans), the per-site
warning names the slot, expected level and drift, and the batch summary reports
the aggregate.

The guard **fails open on anything it cannot judge** — no genesis (pre-genesis
startup), unparseable or synthetic slot ids, out-of-ladder indices, non-finite
prices, and any checker exception all permit the emission. A guard that blocked
on missing metadata would halt legitimate trading, which is worse than the bug
it prevents. Only `off-grid-price` blocks.

That fail-open property is what makes blocking safe where the earlier tuned
guards were not: a legitimate order always equals its genesis level by
construction, so a rejection can only mean the price was written from something
other than the ladder.

## Adoption: accept the chain price, don't adopt it

Adoption must accept a chain price that differs from the genesis level. That is
**not** a reason to write it into `slot.price`. Two different prices are
conflated here:

| Price | Meaning | Must equal a genesis level? |
|---|---|---|
| `order.price` | resting limit price on chain | **Yes** |
| `fill.price` | execution price of a fill | **No** — may be better |

A fill can execute better than its resting price, and a partial fill leaves the
order resting at its original price. So `fill.price != order.price` is normal
and is not corruption.

The real adoption case is **grid regeneration**: the grid is recentered but old
chain orders keep resting at the *old* grid's levels. With `incrementPercent
0.5%`, a resting order at `0.32667340` sits a fraction of a slot from the new
grid's `slot--17` at `0.32685210` — a `0.0547%` difference. Correct handling:
adopt into `slot--17` (via `slotIndexForPrice`) and **let the slot keep
`priceForSlot(-17)`**. The old price is chain metadata about where the order *was
placed*; it is not the slot's price, and it disappears on the next
rotation/cancel.

This is what the genesis path (`adoptChainOrderIntoSlot`) already did — it sets
`orderId`, `state`, `size`, `rawOnChain` and **never touches `price`**. The
legacy fallback was the only path that got it wrong; it now matches.

**Both paths now state this explicitly, and warn when it is broken.** Keeping
the slot's price by *not assigning it* is correct but invisible: nothing would
catch a later edit that reintroduced `price: chainOrder.price`, and nothing
would catch a slot whose price was **already** corrupted before it reached
adoption — it would simply be re-adopted. `adoptedSlotKeepsItsOwnPrice` runs on
both paths and warns, naming the path, slot, expected level and drift, when an
adopted slot's price is not its genesis level.

That check is deliberately **non-blocking**: the chain order is real and must be
tracked, so refusing the adoption would strand it untracked on the book —
strictly worse than the corrupt slot it reports. It is a signal, not a gate.

Note the two adoption paths are covered separately, because a fixture with a
genesis takes the genesis path and a fixture without one takes the legacy
fallback: LEGACY-ADOPT-001 covers the legacy path, ADOPT-NAME-001 the genesis
path. Each is mutation-tested against its own path.

## Healing a pre-existing off-grid slot price

The emission guard rejects an off-grid price, so a slot that *persists* one is
rejected on every cycle — a durable stall. `loadGrid` therefore **repairs** any
slot whose price disagrees with its genesis level, in both validation modes
(`modules/order/grid.ts`, at the genesis validation loop):

- the slot's price is set to `priceForSlot(idx, genesis)`;
- enforce mode still virtualizes it (`state: VIRTUAL`, `size: 0`, `orderId: ''`);
- both modes log the correction, naming the slot and the old → new price.

This is safe because **the slot id determines its price from the ladder**: no
legitimate slot can disagree with its own level, so there is no correct value
being overwritten. Before this, the mismatched price was preserved in *both*
modes, which meant a corrupt price survived a restart, re-activated into a
CREATE, and was rejected forever — the guard would have converted a corruption
bug into a permanent one.

Verified: a slot corrupted to 5% off its level is repaired in log and enforce
modes, and the repaired price passes the emission guard (otherwise the stall is
not actually healed). Mutation-checked: reverting the price assignment fails the
assertion.

### After a repair: expect one churn cycle

A repair changes `slot.price`, so any *resting* order still sitting at the old
corrupt price no longer matches its slot. It resolves on the next reconcile via
price-drift auto-cancel, which means **one cycle of cancel/replace churn after a
repair is expected, not a new fault**. Operators seeing a burst of cancels
immediately following a `[GENESIS] Slot … price repaired from genesis` line are
watching the repair settle.

### Repair only runs at load — so a persistent rejection escalates

`loadGrid` heals on reload, but an in-process corruption has no reload to wait
for. The recurring planner carries the slot's price straight from
`manager.orders`, so a corrupted slot is re-planned, rejected, and warned on
every cycle, forever. Nothing heals it short of a restart: the slot is dead
while the bot looks healthy, and the repeated warns train operators to ignore
them.

The guard therefore **counts consecutive rejecting batches per slot** and, after
`GRID_PRICE_INVARIANT_RESYNC_THRESHOLD` (3) of them, fires
`requestStructuralGridResync('grid-price-invariant-violation', {slotId, expected,
actual, site, streak})`. The resync is the same debounced, batch-in-flight-aware,
two-step (reload → full reset) path already used by the grid-bloat and
spread-stale detectors — a second repair mechanism would duplicate tested
machinery for no benefit. A dedicated
`GRID_PRICE_INVARIANT_RESYNC_COOLDOWN_MS` (15 min) bounds repeats, and a **clean
check clears the streak** so escalation means "rejected N *consecutive* batches",
not "rejected N times ever".

**Why not heal in place** (`slot.price = expected` at rejection time): the
checker does compute the right value, but silently rewriting it destroys the
diagnostic signal. The streak is what distinguishes the four corruption sources
— legacy persisted state, migration fallback, genesis-identity mismatch, or an
unknown live writer. Auto-heal makes all four look identical. Count first,
escalate on persistence; consider an in-place fast path only after a soak shows
in-process corruption is the common case.

The streak is **bot-scoped**, not module-scoped: the monolithic runtime
(`dexbot.ts`) runs every active bot in one process, so a shared count would pool
unrelated bots' rejections — one bot's two rejections would put the next bot at
the threshold on its first rejection and fire a spurious structural resync on a
healthy bot (verified by GPI-WIRE-007/008).

## Out-of-bounds policy: hold, and surface

**Decision: hold indefinitely, and warn.** Holding costs opportunity; wrong
placements cost capital. The grid geometry is not invalidated by the market
leaving it — every observed violation was on the *placement* side, not the
resting grid.

| Event | Action |
|---|---|
| Market moves beyond configured bounds | Keep the grid as-is. Do not recenter, rescale, or extend the boundary. |
| Chain order exists outside the grid range | Hold untouched (`out-of-grid-deferred`). Do not adopt, do not cancel. |
| Fill occurs while out of bounds | Apply its accounting; do **not** let its price become grid evidence. |
| A slot *inside* the grid empties | Refill at `priceForSlot(idx)` — **this continues even out of bounds.** |
| An order would need a non-grid price to "keep up" | Do not place it. |

The last two rows are the point: refilling an emptied slot at its genesis price
is always valid (the slot's price is still a grid price). What must stop is
emitting orders whose price is not a grid price.

Holds are classified non-blocking by `isNonBlockingUnmatchedOrder` (any
`*-deferred` reason), so they do not force a grid reset while they persist.

### Hold observability

The `[HOLD]` line names side, price, size, reason, and distance from the nearest
grid bound (as a percentage, so a near-miss is distinguishable from a
deliberately-placed far order). An unchanged set is re-warned slowly
(`TIMING.STALE_TOTALS_WARN_RATE_LIMIT_MS`), because "held indefinitely" must not
be indistinguishable from "bot silently stuck".

The gate is content-based, not count-based: same-count churn (one hold clearing
as another appears) previously looked like "no change" and was never logged.

The signature is also the **logging gate**, but it is NOT the staleness clock.
Age is measured **per stranded order** (`id@price/size:reason`) from the first
cycle that order was seen stranded, tracked in a bot-scoped map. Two earlier
choices were wrong, and each was caught by a test that now pins it:

1. `manager._lastUnmatchedChainOrdersAt` records "when we last looked", never
   "when the hold started" — an age gate on it could never fire (HOLD-007).
2. The whole-held-set signature clock looked correct but was **reset by
   unrelated churn**, because the signature includes every entry's reason. An
   unrelated hold flapping in and out changed the signature every cycle and
   restarted the clock, so a genuinely stranded order was starved of escalation
   forever (HOLD-010). A per-order clock is immune: age belongs to the order,
   not to the set.

A third defect sat in the same path: the signature-change branch used to
`return` before reaching the escalation call, so any churn skipped escalation
entirely. Escalation is now invoked on BOTH branches — a signature change is a
reason to re-log, not a reason to stop evaluating age.

When a stranded hold reaches `DEFERRED_HOLD_ESCALATE_MS` (24h) it escalates at
`error` and fires the same `requestStructuralGridResync('deferred-hold-stale',
...)` — the exit that a per-cycle hold-and-warn loop otherwise lacks.

Only genuinely **stranded** reasons are escalation triggers. Escalation uses a
narrow allow-list (`isStrandedHoldOrder`: `out-of-rail-deferred`,
`out-of-grid-deferred`) rather than the broad `-deferred` non-blocking filter.
A resync cannot end a broadcast region or re-evaluate an uncommitted boundary,
so `broadcast-active-deferred`, `boundary-hold-trailing-market`,
`boundary-unknown-deferred` and `held-plan-unchanged-deferred` are excluded:
escalating on them would spend a full grid reload on something the owning
machinery already resolves. The allow-list fails closed, so a future transient
reason is excluded by default instead of silently becoming a resync trigger
(HOLD-011).

That escalation is safe because the full reset's reconcile is **update-first**:
unmatched chain orders are price-updated onto rail slots (emitting the rail's
genesis level, so the RECONCILE-UPDATE guard does not block the resolution) and
only true surplus is cancelled. Funds are released by price-updating, not by
inventing a new cancellation policy. A dedicated
`DEFERRED_HOLD_RESYNC_COOLDOWN_MS` (6h) bounds repeats.

## Implementation status

| Item | State |
|---|---|
| Legacy adoption keeps `slot.price`; gains the rail guard | **landed** |
| Materialize path derives price from genesis, not the descriptor | **landed** |
| Materialize path derives ORDER TYPE from the same ladder level, not the descriptor | **landed** |
| Persistent off-grid rejection escalates to a structural resync (per-slot streak) | **landed** |
| Stale deferred hold escalates to a structural resync (per-order stranded clock) | **landed** |
| Pre-broadcast substitution removed (CREATE) | **landed** |
| Pre-broadcast substitution removed (CREATE-fallback) | **landed** |
| Invariant check at 6 emission sites | **landed — BLOCKING (rejects off-grid emissions)** |
| Fill-guard pivot validated onto the ladder (`resolveOnGridPivot`) | **landed** |
| `[HOLD]` enrichment + slow re-warn | **landed** |

`resolveOnGridPivot` snaps a near-ladder pivot to its slot level but **refuses to
rewrite a far-off-ladder one** onto an edge slot — silently clamping would dress
a corrupt pivot up as a legitimate edge fill. Off-ladder pivots are counted and
reported.

## Verification

- **Unit:** for every emitted op, `price === priceForSlot(idx, genesis)`.
  Rotation UPDATEs additionally assert `newPrice` matches the **destination**
  slot's level (GPI-010); an off-grid emission is **refused**, a genesis level is
  permitted (GPI-011); unjudgeable inputs fail open (GPI-012); the emitted
  rotation price is derived from the destination's genesis level (GPI-013), and
  the derivation declines — rather than inventing a price — with no ladder
  (GPI-014) or an out-of-ladder index (GPI-015).
- **Unit:** a legacy-path out-of-grid order is held, not adopted, and keeps its
  genesis price (LEGACY-ADOPT-001/002); the materialize path derives the slot
  price AND order type from genesis and warns when it cannot
  (MATERIALIZE-001/002/003); adoption
  keeps the slot's own level on the genesis path and does not warn when correct
  (ADOPT-NAME-001) (`tests/test_sync_out_of_grid_defer.ts`).
- **Unit:** pre-broadcast drift is reported at `warn` and the op is built from
  the *planned* price (`tests/test_cow_orchestration_fixes.ts`).
- **Unit:** pivot snapping and off-ladder refusal
  (`tests/test_last_fill_guard.ts`, PIVOT-001..003).
- **External gate:** `analysis/grid_correction_check.ts` — target 0 sustained
  violations at 168h/720h. **The baseline is NOT clean:** 4 of 5 bots were
  non-zero over 7 days, so this is a live signal, not a historical one.

Each behavioural fix above is mutation-tested (revert the fix, confirm the test
fails) so the tests are known to discriminate rather than merely pass.

**Emission-site wiring.** The guard's own rules (`checkGridPriceInvariant`,
`reportGridPriceInvariant`) are unit-tested by GPI-001..015, but that says
nothing about whether a live batch *consults* them — a mutation audit found the
three COW sites could be neutralised entirely with every COW test still green.
`tests/test_grid_price_invariant_wiring.ts` (GPI-WIRE-001..009) closes that: it
drives `updateOrdersOnChainBatchCOW` end-to-end with a real DEXBot/OrderManager
and asserts that no op reaches `buildCreateOrderOp`/`buildUpdateOrderOp` and
nothing is broadcast. Mutation-verified: disabling the blocking CREATE check
fails GPI-WIRE-001; reverting the rotation price derivation fails GPI-WIRE-004;
feeding the guard the raw pivot instead of the validated one fails GPI-WIRE-005.
The escalation is pinned by GPI-WIRE-006..009: removing the escalation call,
removing the streak reset on a clean check, and disabling the cooldown are each
caught, and GPI-WIRE-009 pins that the per-slot streak is bot-scoped — the
monolithic runtime runs every active bot in ONE process, so a module-level
streak would let one bot's rejections push another to the threshold on its first
rejection, firing a spurious resync on a healthy bot. The hold escape hatch is
pinned by HOLD-006..011 (`tests/test_hold_and_center_guards.ts`). Three
mutation-verified discriminators: HOLD-007 fails if age comes from
`_lastUnmatchedChainOrdersAt` (the clock that could never fire); HOLD-010 fails
if age comes from the whole-held-set signature clock (reset by unrelated churn,
starving a stranded order forever); HOLD-011 fails if the narrow stranded
allow-list is replaced by the broad `-deferred` filter (transient holds would
spend a grid reload).

**One site is not black-box reachable, by design.** The UPDATE check
(`action.newGridId`) is a backstop: `deriveRotationPrice` computes the emitted
price *from* the destination's genesis level before the check runs, so at the
check the id and price agree by construction. Disabling that check cannot be
caught from outside because there is no reachable input that makes it fire. The
reachable property — that a planner-supplied `action.newPrice` disagreeing with
the destination's level never reaches the chain — is what GPI-WIRE-004 pins.
Treat the UPDATE check as defence for a missing genesis ladder (it fails open
there), not as the only thing standing between a bad plan and a live order.

**False-positive audit (blocking enabled).** Because the check now rejects, it
was audited against real grid builds before enabling: **1,153 slots across five
geometries** — standard, wide (1.65x-10x), tight, wide at 2% increment, and the
incident geometry (1.65x-10x around ~0.32) — produced **zero** off-grid
rejections and zero uncheckable slots. The identity-preserving transforms
(`virtualizeOrder`, `convertToSpreadPlaceholder`, `toRailHolePlaceholder`) also
pass, while an order object carrying its own drifted price is caught (50% drift
in the fixture). That is the evidence that blocking is safe: a legitimate order
equals its genesis level by construction, so only a genuinely mis-priced
emission can be rejected.

## What is still open

1. **The blocking check has never seen live traffic.** `violated` and
   `pivotOffGrid` are unobserved: no bot has run this code. The guard is safe by
   construction (fail-open on everything unjudgeable; a legitimate order equals
   its genesis level), and the first live rejection should be read as a real
   writer rather than assumed to be a false positive — but the first
   `violated>0` in production is the signal to investigate, not to retune.
   Before enabling it on a live bot, confirm the fail-open paths are exercised
   at startup (no genesis) in whatever configuration is being run. The
   escalation thresholds (`GRID_PRICE_INVARIANT_RESYNC_THRESHOLD`,
   `DEFERRED_HOLD_ESCALATE_MS`) are in the same position: reasoned from the
   stall mechanism and mutation-tested, but never observed against a live
   corruption. Treat the first escalation as a genuine signal about how long an
   in-process corruption actually survives.
2. **Which writer caused the 2026-08-30 event is not confirmed.** The mechanism
   is proven real at HEAD; mapping it to that event is inference from fill
   prices/timestamps plus the removed `d808c052`/`e2898e51` code. That window's
   own logs are gone (retention starts 2026-09-11).
3. **No known remaining writer of `slot.price` from carried data.** The
   `sync_engine.ts` materialize path (a CREATE landing after master lost the
   slot) wrote `price: descriptorPrice` — the carried price — and now derives
   the level from `priceForSlot(parseSlotIndex(gridOrderId), genesis)` instead,
   keeping the descriptor price only when there is no genesis ladder to derive
   from (migration), and warning when it does. Note this path is **not covered
   by the emission check**, because it materializes a slot rather than emitting
   an order, so it needed its own fix.
   `virtualizeOrder`, `convertToSpreadPlaceholder` and `toRailHolePlaceholder`
   were audited and verified identity-preserving, including under the checker.
4. **No explicit "market has left the configured bounds" signal.** The hold is
   per-order and reactive, so the bot cannot distinguish "one stray order
   outside the range" from "the market left the range entirely", nor warn
   *before* orders become stranded. The designated place is the divergence
   telemetry (`ANCHOR.DIVERGENCE_INFO` / `DIVERGENCE_WARN`,
   `calculateGridSideDivergenceMetric`) — note those constants survive even
   though the anchor that fed them was removed, so consumers may be partly dead.
   Note the escape hatch is now time-based rather than market-aware: a 24h hold
   escalates whether the market left the bounds or one order is simply stranded,
   because neither case is distinguishable from the hold record alone. A genuine
   "market left the bounds" signal would let the escalation fire on cause rather
   than on a timer. The timer's blast radius is narrowed by restricting the
   trigger to genuinely stranded reasons (`isStrandedHoldOrder`): holds that the
   owning machinery already resolves — a broadcast region, an uncommitted
   boundary, an unchanged replan — no longer reach the escalation at all.

## The removed placement gate: do NOT naively re-land

`d808c052` added `checkPlacementPriceSanity` (reject a planned price >5% from a
traded-range mid). It was removed the same day by `e2898e51` because it "blocked
legitimate order creates and updates".

**That framing is misleading, and the code shows the real mechanism.** The
removal was not an over-tuned threshold — it was a **design deadlock**:

- `ANCHOR.PRICE_OUTLIER_FACTOR: 2` bounded the fills considered plausible.
- Out-of-bounds fill prices were then **skipped entirely** by
  `resolveFillPrice` / the burst fill loop.
- But those same fills were what boundary correction needed in order to *update*
  the anchor.
- So after a genuine trend beyond 2x, the correction bound could never be
  re-derived: the guard bounded the very evidence required to correct it.

Hence "too restrictive" describes a design flaw, not a tuning problem. Framing
it as tuning invited the wrong fix — deletion instead of repairing the
unbounded-anchor path. A re-land must address the deadlock, not retune a number.

The violator that ran free once the detector was gone was the **role-assignment
pass inside `calculateTargetGrid`** (`modules/order/strategy.ts`), which re-typed
slots relative to *fill prices* rather than the boundary — with an **unbounded**
BUY→SELL direction (`slot.price > minFilledBuyPrice` has no upper limit). With
`minFilledBuyPrice` inflated by a poisoned fill, every BUY below it flipped to
SELL and was re-created above it: the observed ratchet.

Implication: restoring `checkPlacementPriceSanity` alone would **not** fix that.
Any re-land must fix the out-of-bounds-skip deadlock *and* clamp the rotation
independently of the anchor. See `git show d808c052` for the removed
implementation; the removal provenance (symbol → built → removed) is recorded in
`docs/CONSOLIDATED_ORPHAN_FIX_SUMMARY.md`.

## Caveats

- Figures (`2.45x`, `~180 slots`, `[0.196, 3.234]`) are derived from typical
  configured multipliers and a representative reference price. Exact levels
  should be read from the persisted grid to confirm.
- The removed-path behaviour was read from `d808c052`/`e2898e51`, not executed.
- No real account names, bot names, or live market pairs are included.
