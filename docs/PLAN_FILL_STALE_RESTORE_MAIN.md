# Plan: Restore Main Fill Behavior + Fix Remaining Main Gaps (Stale Fill Recovery)

**Status:** Draft for `test` branch
**Date:** 2026-08-31
**Issue:** `profiles/logs/<market>.log` went stale after full resync; blockchain fills (multiple `1.11.x` operations for `1.2.x`) never produced `FILL DETECTED`. Last log line `Bootstrap phase complete`. Next periodic fallback `240min` -> `~67min` staleness.
**Root cause in `test` vs `main`:** `test` added `isBroadcastingActive` gate without reschedule (see §1). `main` at `modules/dexbot_fill_runtime.ts:562` only gated `_batchInFlight||_recoverySyncInFlight`; `test:651` adds `|| isBroadcastingActive` and returns at `debug` without retry. This starves queued fills during any `COW` broadcast (chunked broadcast `>100s`) and leaves `4h` fallback as only recovery.

---

## 0. Decisions Needed Before Edit

1. **Periodic safety net:** `main` and `test` share `TIMING.BLOCKCHAIN_FETCH_INTERVAL_MIN=240` (`modules/constants.ts:207`) + `OPEN_ORDERS_SYNC_LOOP_ENABLED=false` (`:253`) -> `Open-orders sync loop disabled by configuration` (`modules/dexbot_startup_runtime.ts:390`). Keep `240min` (minimal change) or enable?
   * A) Enable open-orders loop `true` default `5min` (`TIMING.RUN_LOOP_DEFAULT_MS=300000` at `:252`, `modules/dexbot_maintenance_runtime.ts:1067`)
   * B) Lower `BLOCKCHAIN_FETCH` to `30` (or `15`) for non-shared; shared already `5min` via `fundRegistry.isSharedAccount()` (`:1219`)
   * **Recommendation:** A+B (loop `5min` + fetch `30min`) - cost `~1 page/5min` vs `4h` drift. Keep flag configurable via `profiles/general.settings.json` override.
2. **Scope:** Restore `main` fully or patched `test` (keep beneficial hardenings)? **Recommended:** patched `test` - keep `HISTORY_GAP_LOOKBACK_OPS=2000`, `SYNC_SUSPECT_EMPTY_READ_LIMIT=3`, `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER=4`. Confirm.

---

## 1. P0 - Restore Main Fill Handling (Primary Sabotage)

### 1a File `modules/dexbot_fill_runtime.ts:651-658`

```ts
// main:562  if (bot._batchInFlight || bot._recoverySyncInFlight)
// test:651  if (bot._batchInFlight || bot._recoverySyncInFlight || bot.manager?.isBroadcastingActive?.()) {
//              log 'Fill processing deferred...' 'debug'; resetWatchdog(); return; }
```

**Fix (preferred 1a):** Revert gate to `main`:
```ts
if (bot._batchInFlight || bot._recoverySyncInFlight) {
```
Remove `isBroadcastingActive` from queue gate. `COW` exclusivity already enforced by `_fillProcessingLock.acquire` at `:683` and stale-plan check in `dexbot_cow_runtime`.

**Alternative 1b (if gate must stay):** Keep gate but always reschedule:
```ts
if (bot._batchInFlight || bot._recoverySyncInFlight || bot.manager?.isBroadcastingActive?.()) {
    bot.manager?.logger?.log?.(`Fill processing deferred: ...`,'debug');
    resetFailureWatchdogIfSet();
    bot._scheduleFillConsumerRestart(chainOrders); // or setTimeout(()=>consumeFillQueue,1000)
    // warn if queue >0 for >60s, increment lockContentionEvents
    return;
}
```
Also add `WARN` when `queue>0` for `>60s` (currently `debug` hides starvation).

### 1b Wire Drain Correctly

`test` added mitigations that only cover `_recoverySyncInFlight`:
* `modules/dexbot_maintenance_runtime.ts:2234 drainFillQueueAfterPipelineClear` checks `_recoverySyncInFlight==0 && !isBroadcastingActive()` (`:2237`) and is called only from `requestGridReset:2280,2404`.
* `modules/dexbot_class.ts:1792 _wireBroadcastRegionEndDrain` assigns `manager._onBroadcastRegionEnd` but `dexbot_cow_runtime` never calls it at chunk commit.

**Fix:** Extend `drainFillQueueAfterPipelineClear` to also watch `_batchInFlight`:
```ts
if ((bot._recoverySyncInFlight||0)>0 || (bot._batchInFlight||0)>0 || bot.manager?.isBroadcastingActive?.()) return;
```
And invoke `manager._onBroadcastRegionEnd?.()` at end of `dexbot_cow_runtime` broadcast region (after `commit`/`refuse`), so normal `COW` batches drain deferred fills.

### 1c Orphan Deferral Cap

`modules/dexbot_fill_runtime.ts:35-118` `isUnknownFillOrderAdoptable:35` + `processSweepOrphanFill:106` defers LIVE orders to open-orders sync. If `readOpenOrdersGuarded` returns `null` (truncated) `>3x`, fall back to orphan credit instead of infinite defer.

**Validation:** `tests/test_fill_gap_recovery.ts`, `tests/test_periodic_sync_fill_rebalance.ts`, `tests/test_orphan_cascade_fixes.ts:592` plus new `tests/test_fill_broadcast_deferral.ts` (enqueue 5 fills while `isBroadcastingActive=true` -> assert drain within `1s` after clear).

---

## 2. P1 - Fix Remaining Main-Inherited Staleness

### 2a WebSocket Liveness Watchdog

**Files:** `modules/bitshares-native/subscriptions.ts:316,772`, `modules/node_manager.ts:312`, `modules/bitshares_client.ts:345`

Gap-recovery `HISTORY_GAP_LOOKBACK_OPS=2000` (`modules/constants.ts:1693`, `subscriptions.ts:114-598`, eager `250ms` at `:507`) only arms when `gap>1` in `handleNotice:488` or on `reconnect:761,968`. `startFillPolling:779` (`60s`) explicitly does NOT arm lookback (`:653` comment) and `assessFailover` only on `closed`, not stall.

**Fix:** In `startFillPolling` loop, if `Date.now() - sub.lastNoticeAt > 5min` and `!reconnecting && ! _processingHistory`, arm `sub._gapRecovery=true` or trigger `assessFailover('stalled')`. After `3` empty polls, force `lookbackOps=2000` scan.

### 2b Keep Beneficial Test Hardening

Keep `HISTORY_GAP_LOOKBACK_OPS=2000`, cursor advance only to fill ids (`:448` fix that prevented skipping fills between `oldCursor` and `max notice id`), `SYNC_SUSPECT_EMPTY_READ_LIMIT=3` (`:233`), `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER=4` (`:472`), `MAX_CANCELS_PER_BROADCAST=20`, `ADOPTION_READ_MAX_ATTEMPTS=3`, `skipIdle:true` for trigger resync (`:971,1022`).

---

## 3. Observability

* Promote `Fill processing deferred` from `debug` to `warn` if `queue>0` for `>60s`.
* Expose `getMetrics` `recoveryInFlight`, `broadcasting`, `queueDepth`, `lastNoticeAge` (`modules/dexbot_maintenance_runtime.ts:2435`).
* Log `gap-recovery scan` (`:598` `processObjects: gap-recovery scan ...`) already `info` - keep.

---

## 4. Implementation Steps

1. Branch `fix/fill-stale-restore-main` from `test`.
2. Edit `modules/dexbot_fill_runtime.ts:651` per §1a, patch `drainFillQueueAfterPipelineClear` per §1b.
3. Add `tests/test_fill_broadcast_deferral.ts`, run `npm test` (focus `test_fill_*`, `test_periodic_sync*`, `test_orphan*`, `test_boundary*`).
4. Apply §2a WebSocket liveness watchdog (deferred per user - transport keepalive + 60s poll covers main).
5. Canary on `<market>` (single bot): watch `FILL DETECTED` latency `<5s`, no `Deferring` >60s, verify `gap-recovery scan` recovers burst.
6. Merge `test -> dev` via manual merge (per `AGENTS.md` Absolute Git Action Gate, `test -> dev` one direction).

---

## 5. Risks & Alternatives

* **Risk of removing gate:** Re-introduces `main` race where fill `COW` interleaves with broadcast commit; mitigated by `_fillProcessingLock:683` and `COW` stale-plan refusal (`Refusing stale working grid commit`).
* **Alternative:** Keep gate but always `scheduleFillConsumerRestart` - adds `1s` latency vs immediate.

---

## 6. References

* Log: `profiles/logs/<market>.log` (example truncated excerpt; fills not logged after bootstrap)
* Diffs: `git diff main...test -- modules/dexbot_fill_runtime.ts`, `modules/bitshares-native/subscriptions.ts`, `modules/constants.ts`, `modules/dexbot_maintenance_runtime.ts`, `modules/dexbot_class.ts`
* Docs: `docs/CONSOLIDATED_ORPHAN_FIX_SUMMARY.md`, `docs/EVOLUTION.md`
