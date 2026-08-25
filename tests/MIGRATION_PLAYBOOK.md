# Migration Playbook: de-tsx test fixes

Repo state: tsx removed; everything runs via plain node on compiled `dist/`.
Build+verify loop for any change:

```bash
npm run build && npm run build:tests   # prod + tests
node dist/tests/<name>.js              # must exit 0, internal PASS lines visible
```

Root tests are CJS-flavored TS in `tests/*.ts`, compiled to `dist/tests/*.js`
(package `{"type":"commonjs"}` marker is copied in by build:tests).

## Core constraint

Compiled ESM namespaces are FROZEN:
- `SomeModule.exportedFn = ...` throws `TypeError: Cannot assign to read only property`
  or silently no-ops (sloppy-mode files).
- `delete require.cache[...]` is a NO-OP for ESM-loaded modules; injecting cache
  entries before loading consumers does NOT intercept their static ESM imports.
- `require('./x.js')` inside function bodies (lazy) bypasses ESM loader hooks.

## Established seams (USE THESE FIRST — prior art cited)

1. **Fee cache** — `modules/order/utils/math.ts` exports `_setFeeCache(cache)`.
   `getAssetFees(sym)` throws unless `feeCache[sym]` exists, else computes
   deterministic fees from
   `{ [sym]: { limitOrderCreate:{bts}, limitOrderUpdate:{bts}, limitOrderCancel:{bts}, makerFeeDiscountPercent } }`
   (+ assetAmount/isMaker args → net proceeds). Seed fixtures via `_setFeeCache`
   instead of patching `OrderUtils.getAssetFees`. Prior art: tests/test_dust_rebalance_logic.ts.
2. **Price derivation** — `modules/order/utils/system.ts` exports
   `setDerivePriceTestHook(fn | null)`; `derivePrice` delegates to it first.
   Return number or null. Prior art: tests/test_grid_logic.ts (pool fallback case).
3. **Bot-level hooks** (prod checks `typeof bot.X === 'function'`):
   - `bot._submitCancelOrder(orderId)` — dust-cancel chain submission
     (dexbot_maintenance_runtime.cancelOrderDeferredOnUncertain). Prior art: tests/test_dust_rebalance_logic.ts.
   - `bot._syncMarketAdapterHook(context)` — periodic market-adapter sync.
   - `bot._readOpenOrdersHook()` — guarded open-orders reads in periodic fetch,
     open-orders sync loop, startup sequence. Return array = clean read; null = defer/truncated.
     Prior art: tests/test_periodic_sync_fill_rebalance.ts, tests/test_main_loop_sync_fill_rebalance.ts,
     tests/test_dexbot_startup_dynamic_weight_wiring.ts.
   - `bot._gridModule` / `bot._gridReconcileModule` — object swaps consumed by
     placeInitialOrders/finishStartupSequence (initializeGrid/loadGrid/
     decideStartupGridAction/reconcileGridOrders/attemptResumePersistedGridByPriceMatch).
   - `bot._listenForFillsHook()` — fill subscription. Same startup test prior art.
4. **Plain-object injection still works**: `bot.manager = {...}` stubs,
   overriding bot methods (`bot.updateOrdersOnChainBatch = ...`,
   `bot._runGridMaintenance = ...`), fs.existsSync/readFileSync patches on the
   CJS core module, global.setInterval captures, process.env manipulation
   (set BEFORE requiring config-dependent modules — Config snapshots env at load).
5. **ESM module mocks via loader hooks** — `tests/helpers/esm_mocks.ts`
   (compiled to dist) exports:
   - `runEsmMockStages(stages: string[], runStage: (stage: string) => Promise<void>|void)`
     Parent spawns one hooked child per stage (stops at first failure, forwards
     exit code); child runs only its stage. Annotate callback `(stage: string)`.
   - `defineEsmMockAbs(absPath, exportNames: string[], exportsObject)` — mock a
     compiled module (path from `require.resolve('../modules/x')`). Mock fns stay
     main-thread; call recording works. Consumers' NAMED imports are satisfied by
     synthetic re-exports — you MUST list every statically imported name or linking
     fails with SyntaxError.
   Runtime files esm_mock_hooks.mjs/esm_mock_loader.mjs are copied to dist by build:tests.
   Pilots: claw/tests/test_claw_bridge.ts, claw/tests/test_claw_chain_layer.ts,
   claw/tests/test_claw_regressions.ts (staged harness pattern).
6. **When no seam exists**, prefer restructuring the assertion to observe the same
   contract through injectable collaborators (manager stubs, payload assertions)
   as done in tests/test_dust_rebalance_logic.ts (cancelCalls removed,
   synchronizeWithChain payload assertions kept). Add a NEW minimal prod seam only
   when nothing else works; follow house pattern (optional bot-level function
   check), document it in your report.

## Pitfalls

- Requiring a real module BEFORE registering an ESM mock poisons the module
  cache — replicate tiny pure helpers inline instead.
- Two harnesses needing DIFFERENT mocks for the SAME consumer require separate
  stages/processes (ESM caches per process).
- Tests that spawn child processes (`bot_startup_output`, pm2/unlock output
  tests) may HANG waiting on stdin prompts ("Enter master password:") or network
  when stubs died — check what they pass on stdin/env; ensure spawned entry is
  `dist/dexbot.js` etc. with proper env (DEXBOT_TEST_* vars are read directly by
  Config at load).
- Keep assertions intact; do NOT delete coverage to make tests pass. When an old
  patch provided fixture data, move the fixture into the seam input (cache/hook).

## Verification discipline

After each fixed test: run it directly until exit 0. At the end of your batch,
re-run the full set of your assigned tests plus these canaries:
`test_grid_logic`, `test_dust_rebalance_logic`, `test_main_loop_sync_fill_rebalance`,
`test_periodic_sync_fill_rebalance`, `test_dexbot_startup_dynamic_weight_wiring`.
Then `npx tsc --noEmit && npx tsc -p tsconfig.tests.json --noEmit` must both exit 0.
