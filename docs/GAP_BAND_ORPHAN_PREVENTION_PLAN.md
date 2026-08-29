# Gap-Band Orphan Prevention Plan (P1–P6)

Status: proposed
Incident window: 2026-08-29 09:29–12:00 UTC (bot `1.2.x`-style account placeholder, market `IOB.XRP/BTS`)

## Incident summary

A live chain sell order (`1.7.x` placeholder) was stranded at the spread price
`1063.734837` (slot-144) and later filled unattended. Root-cause chain:

1. After a corrupted-snapshot rejection, recovery restored a **stale persisted
   boundary (131)** while the true market position was ~140+
   (`Restored boundary index: 131`, then
   `[RECOVERY][SNAPSHOT-REJECT] ... drift sell=0.00 buy=2036.67`).
2. With boundary=131, slot-144 classified as valid sell-rail, so the startup
   reconcile legitimately adopted/updated an unmatched chain sell to slot-144's
   price (`Startup: Updating chain SELL ... -> grid slot-144`), broadcast in the
   35-op startup update batch.
3. Fills swept the price up; the price-anchored boundary correction
   (commit `2bc1efe3`) snapped the boundary up toward the true traded position.
   Slot-144 fell inside the new gap band. Its local record was re-typed
   `SPREAD/virtual, size->0, orderId=""` (spread normalization), while the live
   chain order stayed on the book inside the gap.
4. No cleanup path caught it:
   - sync pass-2 only queues `cancelOnly` corrections for orphans that
     duplicate an **active price level** — slot-144 was empty, so no match;
   - adoption refuses gap-band slots (`no adoptable slot found`);
   - runtime reconcile only warns (`no active same-side grid order exists`);
   - startup excess-cancel only fires when `chainCount > targetCount` during a
     reconcile — never triggered.
5. The GAP-BAND detector fired at 09:33:57
   (`GAP-BAND INVARIANT VIOLATION after commit: placed sell slot-136 ...`),
   but only flagged `structuralResyncRequested`; the requested structural
   resync was silently skipped and never ran. The orphan partially filled at
   09:53, 10:08 and 11:36 (each credited via the orphan-fill path as
   `Processing funds for unknown order ...`), and fully filled ~12:00 with the
   bot offline.

Core defect: the invariant *"no live order inside the gap band"* is enforced by
detectors and warnings, but never by a writer. Every layer that noticed the
problem flagged it and moved on.

## P1 — Cancel in the same batch that strands (writer-side fix, highest leverage)

When a boundary advance moves a placed order's slot into the gap band, the
cancel must ride in the **same COW plan** that moves the boundary — not a later
cycle.

- In `calculateTargetGrid` (`modules/order/strategy.ts`, SPREAD GUARD section)
  the guard already identifies stray in-band slots with live orders and keeps
  them typed BUY/SELL. Its comment claims misplacements are "cancelled by sync
  pass-1 type-mismatch handling" — that path never fired in the incident.
  Instead: emit `cancelOnly` ops for orderId-bearing slots that fall in-band in
  the new geometry, as part of the same plan (model: the duplicate-price
  `cancelOnly` correction at `modules/order/sync_engine.ts` pass-2).
- Belt-and-braces: `_assertGapBandIntactPostCommit`
  (`modules/order/manager.ts`) already collects the exact stranded
  `{id, price}` list in `problems`. On detection, immediately queue
  `cancelOnly` corrections for those orderIds instead of only setting
  `structuralResyncRequested`.

With P1 alone, the incident dies at the 09:33:57 violation: the stranded order
is cancelled within the same commit cycle instead of being logged.

## P2 — Gap-band orphan sweep (self-healing net)

For anything that leaks anyway (e.g. crash between boundary commit and cancel):

- Sync pass-2 (`modules/order/sync_engine.ts`, unmatched-chain-order branch)
  and runtime reconcile (`modules/order/grid_reconcile.ts`, phase-1 unmatched
  loop): when an unmatched chain order's price sits **strictly inside the
  implied gap band** (geometry test via shared `MathUtils.isSlotInRail`),
  queue a `cancelOnly` correction instead of logging
  `no adoptable slot found` / `no active same-side grid order exists`.
- This also provides the tool to clean any orphan that is already live
  (e.g. the second orphan buy observed during the incident) within one sync
  cycle after restart.

## P3 — Never place against an unvalidated boundary (the origin)

The poison input was `_restoreBoundary(131)` from a snapshot that was stale
versus traded price — after which the reconcile *moved money* (updated a chain
order to slot-144's price) based on it. `validatePersistedBoundary` could not
catch it: at restore time the band was empty; the stranding was created after,
by the placement itself.

- After restore/rebuild, re-derive the boundary from chain evidence before any
  placement:
  - placed-order distribution (highest live BUY / lowest live SELL),
  - the market anchor,
  - recent fill evidence via `computePriceAnchoredBoundaryTarget`
    (`modules/order/utils/order.ts`).
  If the derived boundary disagrees with the restored one by more than a
  threshold, use the derived one and log loudly.
- Gate `_reconcileStartupSide` (`modules/order/grid_reconcile_internal.ts`):
  *adopting* existing chain orders to slots is safe (claims existing orders,
  moves nothing); **creating or price-updating orders into a rail position
  requires a boundary validated against chain+fills in the current session**.
  Without that validation, adoption-only is allowed; placements are deferred
  until the boundary pass completes.

## P4 — Snapshot-reject must discard the boundary too

At 09:29:39 the sequence was `Restored boundary index: 131` *then*
`[SNAPSHOT-REJECT] ... Deleting corrupted snapshot` — the rejected snapshot's
boundary stayed in effect for the rebuild.

- In `recoverFromPersistedGrid` (`modules/dexbot_state_recovery.ts`): validate
  first, restore only on pass; on fail, discard the boundary together with the
  snapshot and fall through to re-derivation (P3).

## P5 — Structural resync requests must not vanish

The 09:33:57 `Requesting structural resync` was silently swallowed
(`requestStructuralGridResync` in `modules/dexbot_maintenance_runtime.ts`
skips when a resync is already scheduled or running, and the `_batchInFlight`
deferral re-arms its timer without a cap). The flag went unanswered for hours.

- Log every skip/defer with the reason (already-scheduled / batch-in-flight).
- Add a max-defer deadline after which the resync forces instead of re-arming.

## P6 — Regression test for the exact incident

- Test A (P1): restore stale boundary -> startup reconcile updates an order
  into slot X -> boundary snaps past X -> assert a cancel op for that order is
  emitted in the same commit batch and no live order remains in-band.
- Test B (P2): seed a live orphan priced strictly inside the implied gap band
  with no duplicate active price level -> run sync pass-2 / reconcile -> assert
  a `cancelOnly` correction is queued and executed within one cycle.
- Test C (P3/P4): corrupted snapshot with stale boundary vs. fill evidence ->
  rebuild -> assert placements use the re-derived boundary, and the rejected
  snapshot's boundary is not reused.

## Rollout order

1. **P1 + P2 + P4** — make the invariant self-enforcing regardless of how the
   boundary got there (writer-side cancel, sweep, reject-discard).
2. **P5** — observability/force path for recovery requests.
3. **P3** — boundary re-derivation gate as fast-follow (largest surface).
4. **P6** — regression tests accompany each step.
