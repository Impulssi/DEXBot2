# DEXBot2 Logging System

## Quick Start

Edit `profiles/general.settings.json` to configure logging:

```json
{
  "LOG_LEVEL": "info",
  "LOGGING_CONFIG": {
    "categories": {
      "fundChanges": { "enabled": false },
      "orderStateChanges": { "enabled": true },
      "fillEvents": { "enabled": true },
      "boundaryEvents": { "enabled": true }
    }
  }
}
```

### Enable JSON Output

```json
{
  "LOGGING_CONFIG": {
    "json": { "enabled": true }
  }
}
```

Writes JSON lines to log files alongside human-readable console output — zero impact on terminal.

---

## Architecture

All log calls go through the centralized `Logger` class (`modules/order/logger.ts`), which handles console output, batched async file writes, size-based rotation, optional JSON lines, and correlation ID tracing. Callers only interact with `logger.log()`, `logger.info()`, etc. — queueing, rotation, and I/O are internal.

```
Module → Logger.log() ──┬→ console (stdout/stderr)
                        └→ write queue → file (100ms batch)
                              + rotation (total 1.1GB budget, 10 rotated files)
                              + JSON lines (optional)
```

---

## Log Levels

| Level | Value | Default | Color | When It Appears |
|-------|-------|---------|-------|-----------------|
| **debug** | 0 | No | Cyan | Calculation details, fund change tracking |
| **info** | 1 | **Yes** | White | State changes, fills, order placement, boundary events |
| **warn** | 2 | No | Yellow | Non-critical issues, recovery attempts, edge cases |
| **error** | 3 | No | Red | Broadcast failures, sustained fill errors (10+ fails or 5min+) |
| **critical** | 4 | No | Bright red | Fill-consumer cascade (20+ fails or 15min+) — permanent fault signal |

The default `LOG_LEVEL` is `"info"`. For production or minimal output, set to `"warn"` (see the Production config below).

---

## Logging Categories

6 independently enablable categories:

| Category | Default Level | Default | Purpose |
|----------|--------------|---------|---------|
| **fundChanges** | debug | on | Fund balance updates in detail |
| **orderStateChanges** | info | on | Order placement, cancellation, state transitions |
| **fillEvents** | info | on | Fill processing and fund updates |
| **boundaryEvents** | info | on | Grid boundary adjustments and recovery |
| **errorWarnings** | warn | on | Critical issues, all errors and warnings |
| **edgeCases** | warn | on | Unusual conditions that don't cause errors |

### Production config (-90%)

```json
{
  "LOG_LEVEL": "warn",
  "LOGGING_CONFIG": {
    "categories": {
      "fundChanges": { "enabled": false },
      "orderStateChanges": { "enabled": false },
      "fillEvents": { "enabled": false },
      "boundaryEvents": { "enabled": false }
    }
  }
}
```

### Debug config (full verbosity)

```json
{
  "LOG_LEVEL": "debug",
  "LOGGING_CONFIG": {
    "changeTracking": { "enabled": true },
    "categories": {
      "fundChanges": { "enabled": true },
      "orderStateChanges": { "enabled": true },
      "fillEvents": { "enabled": true },
      "boundaryEvents": { "enabled": true },
      "errorWarnings": { "enabled": true },
      "edgeCases": { "enabled": true }
    },
    "display": {
      "fundStatus": { "enabled": true, "showDetailed": true },
      "statusSummary": { "enabled": false }
    }
  }
}
```

---

## Display Features

| Feature | Default | Method | Purpose |
|---------|---------|--------|---------|
| **fundStatus** | off | `logFundsStatus(mgr, ctx, force)` | Detailed fund breakdown |
| **statusSummary** | off | `displayStatus(mgr, force)` | Comprehensive account/order status |

```json
{
  "LOGGING_CONFIG": {
    "display": {
      "fundStatus": { "enabled": true, "showDetailed": true },
      "statusSummary": { "enabled": true }
    }
  }
}
```

---

## Log Rotation

```json
{
  "LOGGING_CONFIG": {
    "rotation": {
      "enabled": true,
      "maxSize": 1181116007,
      "maxFiles": 10
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable rotation |
| `maxSize` | 1.1GB | **Total** disk budget for all log files (current + rotated). Per-file limit = `maxSize / (maxFiles + 1)`. |
| `maxFiles` | `10` | Rotated files to keep; older files pruned |

Example: 1.1GB budget with 10 rotated files → each file rotates at ~100MB, max total ~1.1GB.

Under PM2, rotation is auto-suppressed — PM2 handles its own log files.

---

## JSON Structured Output

When enabled, each `log()` call writes a JSON line to the log file:

```json
{"timestamp":"2026-06-12T10:30:00.123Z","level":"INFO","category":"DEXBot","message":"Fill processed: 100 OPEN @ 0.5432","correlationId":"fill-abc-123"}
```

| Field | Always | Description |
|-------|--------|-------------|
| `timestamp` | Yes | ISO 8601 |
| `level` | Yes | Uppercase (`DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`) |
| `category` | Yes | Logger category |
| `message` | Yes | Raw message, no ANSI codes |
| `correlationId` | No | Present when `setCorrelationId()` was called |

---

## Correlation IDs

Trace a single operation (e.g. a fill) across log lines:

```typescript
logger.setCorrelationId('fill-abc-123');
```

Included in JSON output when present. Propagate to child loggers:

```typescript
const child = new Logger('Accounting', { correlationId: parent.correlationId });
```

---

## Change Detection

`LoggerState` prevents redundant logs by tracking previous values:

- Ignores fund changes < 0.00000001 (8 decimals)
- Ignores price changes < 0.0001 (4 decimals)

| Config Profile | Output Reduction | Lines/Cycle |
|---|---|---|
| Production | 90%+ | ~10 |
| Standard | 40-50% | ~100-150 |
| Debug | 0% | ~200+ |

Force output even if unchanged:

```javascript
manager.logger.logFundsStatus(manager, ctx, true)
manager.logger.displayStatus(manager, true)
```

---

## Log Tags Reference

Prefix tags used in log messages to help operators identify event types. To find every call site of a tag, run: `rg -F "[TAG]" modules/`. This list covers the most operator-visible tags; the full set grows with the codebase.

| Tag | Module | Example |
|-----|--------|---------|
| `[COW]` | `dexbot_cow_runtime.ts`, `order/manager.ts`, `dexbot_state_recovery.ts` | Copy-on-write grid rebalance planning and broadcast |
| `[SYNC]` | `order/sync_engine.ts`, `order/manager.ts` | Blockchain order synchronization |
| `[RECOVERY]` | `dexbot_state_recovery.ts`, `order/accounting.ts` | Fund invariant recovery attempts and resets |
| `[ORPHAN-FILL]` | `dexbot_fill_runtime.ts` | Double-credit prevention for stale-cleaned orders |
| `[HARD-ABORT]` | `dexbot_state_recovery.ts`, `dexbot_class.ts` | Illegal state during batch processing |
| `[FILL-QUEUE]` | `dexbot_fill_runtime.ts` | Fill consumer health, backoff, and escalation |
| `[CREDENTIAL]` | `dexbot_class.ts` | Credential daemon errors, key unlock failures |
| `[BOOTSTRAP]` | `dexbot_fill_runtime.ts` | Startup fill/order reconciliation |
| `[VALIDATION]` | `dexbot_cow_runtime.ts` | Order/config validation errors |
| `[POST-RESET]` | `dexbot_startup_runtime.ts` | Post-AMA-reset fill queue processing |
| `[STALE-CLEANUP]` | `dexbot_fill_runtime.ts` | Pruning expired stale-cleaned order IDs |
| `[SELF-CANCEL]` | `dexbot_fill_runtime.ts` | Skipping non-economic fill artifacts |
| `[FILL-DEDUP]` | `dexbot_fill_runtime.ts` | Fill deduplication events |
| `[MAINT-COOLDOWN]` | `dexbot_maintenance_runtime.ts` | Maintenance cooldown after hard-abort recovery |
| `[DUST]` | `dexbot_maintenance_runtime.ts` | Dust order cancellation, health check, and truncation fallback |
| `[BTS-ACQ]` | `dexbot_maintenance_runtime.ts` | BTS acquisition for non-BTS pairs |
| `[TARGETED-SYNC]` | `dexbot_maintenance_runtime.ts` | Targeted drift synchronization deferral |
| `[MULTI-BOT]` | `chain_orders.ts` | Multi-bot shared-account coordination |
| `[BTS-FEE]` | `order/accounting.ts` | BTS fee deferred accounting |
| `[SPREAD-CORRECTION]` | `order/grid.ts` | Partial order spread correction |
| `[STRATEGY]` | `order/strategy.ts` | Fee event cache and strategy decisions |
| `[RECONCILE]` | `order/utils/validate.ts` | Grid reconciliation ([GRID_RECONCILE.md](GRID_RECONCILE.md)) |
| `[TRANSPORT]` | `bitshares-native/transport.ts` | WebSocket keep-alive and reconnect |

## 1.4.8 Markers

New/updated operator-visible messages added by the uncertain-broadcast and COW hardening work:

| Message | Meaning |
|---------|---------|
| `[COW] Dropping stale-slot ... > plan boundary ...` | Stale-placement guard vetoed a CREATE/UPDATE that crosses the plan's own target boundary (deferred to next cycle) |
| `[COW] Stale-placement guard removed N placement(s)` | Summary emitted when the guard filters actions |
| `[COW] Plan stale pre-broadcast (...); re-planning once from fresh master` | Pre-broadcast staleness guard fired; bounded re-plan in progress |
| `[COW] Re-plan produced no executable actions; grid is already consistent post-fills, skipping stale plan` | Re-plan confirmed the grid is consistent; the stale plan was not shipped |
| `[COW] Commit refused after broadcast; adopting placed orders from chain` | Master changed mid-broadcast; placed orders adopted so on-chain state converges |
| `[COW] Refusing to commit working grid: base version ... != current ...` | Version-mismatch commit refusal (`evaluateCommit`) |
| `[BROADCAST_DEADLINE]` / `BroadcastUncertainError` | Typed uncertain outcome — the daemon never re-signed; verify-before-retry engages |
| `⚠ FAILED attempt N/3` / `✗ BLACKLISTED after N failures` | Daemon node health ledger — per-node retry exhaustion then blacklist |
| `[DUST] Chain refetch after verified cancel is TRUNCATED/EMPTY; applying local cancel sync` | Truncated-read fallback in the dust-cancel refetch path |
| `authoritative absence verified` | Aligned retry log wording — re-broadcast only on provable absence |

---

## Fill History Scan Profiling

The `Subscriptions` logger emits `fetchFillHistoryEntries: maxPages (X) reached` at `debug` level when the fill-history scan reaches its configured page cap. On a busy account this is **normal** — the scan simply catches up over multiple polling cycles rather than in a single pass.

If the message recurs across many cycles **without any new fills being detected** (i.e. `maxPages` is hit but `highestReceived` never advances), the connected witness node is likely running with `--partial-operations` pruning enabled. This removes old `operation_history_objects` from the `by_op` index, so the scan can never re-fill the gap because the entries no longer exist on-chain.

**Operator checklist:**
1. Confirm the node config does not enable `--partial-operations` (or that the retention window covers the gap).
2. Restart the node after adjusting the config so the full `by_op` index is rebuilt.
3. If a full node is unavailable, point the bot at an archive endpoint for the initial history scan; subsequent incremental scans only need recent history.

---

## FAQ

**Q: How much output reduction can I expect?**
- Standard config: 40-50%
- Production config: 90%+
- Debug config: 0% (all logs)

**Q: Do I need to change my code?**
No. All existing `logger.log()` calls work unchanged.

**Q: How is config loaded?**
Defaults in `modules/constants.ts` → deep merged with `profiles/general.settings.json` → frozen (immutable).

**Q: Can I customize logging per bot?**
Yes — each bot entry in `profiles/bots.json` accepts an optional `logging` field:

```json
{
  "name": "EXAMPLE-BOT",
  "logging": {
    "level": "debug",
    "config": {
      "json": { "enabled": true },
      "categories": {
        "fundChanges": { "enabled": false }
      }
    }
  },
  ...
}
```

The per-bot `logging` is deep-merged on top of the global config from `general.settings.json`. See `modules/runtime_settings.ts` for the merge logic and `modules/order/manager.ts` for where the merged config reaches the logger.

**Q: What about PM2?**
The logger auto-detects PM2 and suppresses file writes (PM2 captures stdout/stderr). File rotation is also suppressed under PM2.

**Q: Are log lines lost on crash?**
Queued-but-unwritten lines could be lost. Critical errors go to stderr immediately (PM2 captures those). Queue drains every 100ms. Call `flush()` on shutdown.
