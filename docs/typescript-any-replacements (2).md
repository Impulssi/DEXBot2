# Replacing `any` in TypeScript — Best Options for DEXBot2

`any` is not a type, it is an off-switch for the compiler. Every `any` disables
checking not just at that line but for everything it flows into.

This guide is the working plan for removing explicit `any` from DEXBot2. It was
rewritten after auditing the repo — the previous revision overstated coverage
and recommended two types that do not exist here (see "Corrections" below).

## 0. Current state (measured, not estimated)

- `strict: true` and `noImplicitAny: true` are already enabled
  (`tsconfig.json`). `npx tsc --noEmit` is **green today**. So this is *not* a
  "make it compile" task — it is removing **explicit** `any`, which the compiler
  currently accepts.
- **~7,500 explicit `any` token occurrences** on code lines (line-based
  `grep` shows ~5,350 lines) across **200 of 251** TypeScript files. The count
  is enforced by `npm run check:any` against `any-budget.json`.
- Rough shape of the code-line occurrences (overlapping categories):
  | Pattern | Occurrences |
  | --- | ---: |
  | `: any` (parameter / return / variable annotations) | ~6,400 |
  | `as any` | ~650 |
  | `catch (...: any)` | ~650 |
  | `any[]` | ~520 |
  | `Record<string, any>` | ~170 |
  | `Promise<any>` | ~115 |
  | `...args: any` rest shims | ~26 |
- The top offenders are the runtime/order-engine files, e.g.
  `dexbot_cow_runtime.ts` (~485), `credit_runtime.ts` (~322),
  `order/utils/order.ts` (~303), `dexbot_maintenance_runtime.ts` (~294),
  `order/grid_reconcile_internal.ts` (~262).
- `as any` is a *compiler off-switch that also silences assignability*; it is
  the highest-risk category because it hides the real incompatibility.

Reproduce the inventory:

```bash
# authoritative per-file token counts (ignores comments, excludes legacy tests)
npm run check:any:list

# quick line-based count
node dist/scripts/check_any.js --list | tail -1
```

### Progress log

The ratchet baseline was recorded at **7,503** code-line `any` occurrences.
Work completed so far (each step verified with `npx tsc --noEmit` and the test
suite):

| Step | Change | Effect |
| --- | --- | --- |
| Foundation | `modules/types.ts` primitives (`JsonValue`, `UnknownRecord`, `LogFn`, `LoggerLike`, `ChainOrder`, `Deferred`, `CodedError`, `OrderId`/`BotKey`, guards), ratchet at `any-budget.json` | shared vocabulary + regression gate |
| Engine contracts | `BotLike` grown from a stub to a real interface; `OrderManagerLike` + `AssetPair`/`AccountTotals`/`ManagerFunds`/`ManagedOrder`/`GridConfig`/`ManagerLock`/`AccountantLike`/`SyncResult` etc. `OrderManager implements OrderManagerLike` | engine no longer needs `manager: any` |
| Runtime contract | full `BotLike` (154 members enumerated, **no index signature**), `DEXBot implements BotLike`, `ProcessedFillStoreLike`/`AccountOrdersLike`/`IllegalStateSignal`/`AccountingFailureSignal`/`FundDriftCheck`/`RebalanceResult`/`BotMetrics`/`SyncResult`/`IncomingFill`/`UnmatchedChainOrder`; `dexbot_state_recovery.ts` is the migrated canary | runtime boundary is now structural, not `any` |
| Runtime layer | **all** `bot: any` migrated → `bot: BotLike` in `dexbot_{cow,maintenance,fill,startup,state_recovery}_runtime.ts` + `credit_runtime.ts`; helper `manager: any` → `OrderManagerLike`; `manager`-taking config access typed | ~150 gone |
| Leaf utilities (round 2) | `order/format.ts` (`value: unknown`), `order/logger_state.ts`, `order/async_lock.ts` (ALS ctor + `QueueItem<unknown>`), `order/genesis_policy.ts` (`GridGenesis`-typed), `order/utils/withPoolRef.ts` | ~50 gone |
| Order-engine leaves (round 3) | `order/index.ts`, `order/processed_fill_store.ts` (`AccountOrdersLike`), `order/working_grid.ts` (`Map<string, ManagedOrder>`), `order/logger.ts` (`LoggerConfig`/`LoggerState`/`ManagedOrder`), `order/export.ts` (`FillEntry`/`FeeEntry`/`GridFileDoc`/`FillBlock`) | ~60 gone |
| Error surface | `handle`-less `catch (err)` migration + `getErrorMessage` / `getErrorCode` / `getErrorName` / `getErrorField` helpers in `modules/utils/errors.ts` | ~650 `catch (…: any)` gone |
| Rest shims | `...args: any` → `...args: unknown[]` / `never[]` in the runtime re-export shims | ~100 gone |
| Error accessors | `(err as any).message/.code/.name/.stack` → typed helpers | ~40 gone |
| JSDoc | `@param {any}` / `{any}` → `{unknown}` | docs aligned |
| Foundational modules | `settings_merge`, `constants`, `general_settings`, `fund_registry`, `bot_defaults`, `bot_settings`, `runtime_settings`, `slot`, `timeout`, `storage/**` (interface + node/browser adapters), `market_adapter/utils/**` | ~350 gone |
| Order-engine boundary | `manager: any` → `OrderManagerLike` in `order/{manager,grid,grid_reconcile,grid_reconcile_internal,sync_engine,accounting,strategy,logger,genesis_policy}.ts` and `order/utils/{math,order,system}`; consequential cleanup at call sites | ~100 gone |
| Runtime imports | `module as any` bindings in `dexbot_cow_runtime` / `dexbot_maintenance_runtime` typed | ~20 gone |
| Reconcile + validate + accounting | `order/grid_reconcile.ts` (fully typed), `order/utils/validate.ts` (fully typed: `CowAction`/`ValidationIssue`/option interfaces), `order/accounting.ts` (helper/public signatures, `mgr: OrderManagerLike`, fill-op shapes), `parseChainOrder` → `ParsedChainOrder`, plus `ParsedChainEntry`/`ChainOrdersLike`/`Startup*Plan` | ~240 gone |
| Reconcile internals + order utils | `order/grid_reconcile_internal.ts` (fully typed), `order/utils/order.ts` (fully typed: `SlotLike`/`CrossingCandidate`/`ReserveConfig`/`DeltaAction`, `parseChainOrder`/`ChainOrder`/`ManagedOrder` throughout) | ~490 gone |
| Order manager | `order/manager.ts` (fully typed: concrete field types, `GridConfig`/`ManagedOrder`/`ManagerLock`/`WorkingGrid`/`BotMetrics`, COW engine deps + `RebalanceResult` returns) | 192 gone |
| Grid engine | `order/grid.ts` (fully typed: `ManagedOrder` throughout, `SpreadCorrection`/`FundStateSnapshot`/`PrioritizedTarget`/`AmaSnapshot`, typed divergence + dust helpers) | 130 gone |
| Math utils | `order/utils/math.ts` (fully typed: `AccountTotals`/`ManagerFunds`/`AssetPair`/`GridConfig`/`GridLimitsLike`/`WeightDistributionConfig`, `FeeCacheEntry`/`CollisionItem`, `GridGenesis` ladder helpers) | 184 gone |
| Strategy engine | `order/strategy.ts` (fully typed: `FillInput`, `ManagedOrder`/`GridConfig`/`AssetPair`/`ProjectedFunds` params, typed window/reserve/rail logic) | 59 gone |
| Sync engine | `order/sync_engine.ts` (fully typed: `ChainOrderInput`/`SyncFillEvent`/`FillOpInput`/`FillEntry`/`FillTransitionParams`/`SyncChainData`, `ParsedChainOrder`/`PendingPriceCorrection`/`UnmatchedChainOrder`, typed seams + pass-1/pass-2 adoption + fill-batch pipeline) | 140 gone |
| System utils | `order/utils/system.ts` + `order/utils/withPoolRef.ts` (fully typed: `BitSharesClient`/`AssetMeta`/`PoolEntry` external-SDK views, typed fee cache, persistence/pivot helpers, `AmaCenterSnapshot`, stdin prompt loop; **the entire `modules/order/` tree now has 0 explicit `any`**) | 114 gone |
| Launcher / runtime | `launcher/adapter_requirement.ts`, `launcher/status_reporting.ts`, `launcher/credential_bootstrap.ts`, `version_notice.ts`, `authority_resolver.ts`, `dexbot_credential_client.ts`, `key_store.ts`, `dexbot_startup_runtime.ts`, `dexbot_state_recovery.ts` (typed bot-config views, process-status surface, bootstrap socket server/client, fetch/response seam, authority walk, daemon request/response seam, signing-token/store contracts, startup + state-recovery sequences) | 205 gone |
| Chain | `chain_orders.ts` (fully typed: `ChainOrder`/`OperationLike`/`UpdateOrderParams`, typed read/build/update/create/cancel/batch surface, `BtsdexTx` tx seam, broadcast-result classification) | 94 gone |
| Bitshares native | `bitshares-native/chain_client.ts`, `bitshares-native/transport.ts`, `node_manager.ts`, `bitshares-native/signing_client.ts`, `bitshares-native/resolvers.ts`, `bitshares-native/serial/serializer.ts`, `bitshares-native/serial/types.ts` (typed RPC client surface, `transport.call` results, WebSocket event/message shapes, connect race, node-stat/health surface, `BtsdexTx`/`SigningClient`/`TxBuilderLike` wrapper contract, asset/account resolver views, serializer instances, full `SerType`/`SerDebug`/`FieldDef`/`ObjectId` codec surface) | 348 gone |
| Wave 2 sweep | launcher residuals (`credential_daemon`, `foreign_cred_daemon`, `market_adapter_runtime`, `market_adapter_watchdog`, `monolithic_runtime`), crypto/math/chart helpers (`crypto/sync`, `math_utils`/`chart_utils`, `price_sources`, `candle_utils`), bitshares-native (`lru_cache` generic `LRUCache<V>`, `tx/builder`, `tx/tx_cache`, `signing_client`), strategies (`ama`, `regime_gate`), plus ~40 small/medium files across `analysis/` and `scripts/` | 7,503 → 1,699 |

Current budget: see `any-budget.json` (**7,503 → 1,699** at the time of
writing). Engine + runtime contracts, the whole runtime layer, and the small
order-engine leaf utilities are typed. The residual ~6.1k is dominated by
intra-function locals in the large order-engine files
(`order/utils/order.ts`, `grid_reconcile_internal.ts`, `manager.ts`, `grid.ts`,
`math.ts`, `sync_engine.ts`), the runtime file *bodies* still at ~300 each
(`dexbot_cow_runtime.ts`, `credit_runtime.ts`), market_adapter, chain/native,
and scripts/analysis — Phase 3b–6 of §13. This is a multi-session grind, not a
single-wave deliverable.

## 1. Corrections to the previous revision

1. **"~7,000 anys"** — close for token occurrences (~7,500), but the old text
   implied `modules/types.ts` alone "covers ~80%". Adding a type name covers
   **0%** until usages are migrated; types are necessary but not sufficient.
2. **`OpContext = CreateOpContext | CancelOpContext | UpdateOpContext` does not
   exist in this repo.** Do not add speculative union names. The real operation
   shapes live in `modules/chain_orders.ts`
   (`buildCreateOrderOp` / `buildUpdateOrderOp` / `buildCancelOrderOp`); type
   those against the actual BitShares operation objects instead.
3. **`BotLike = { config, manager, _log }` is not sufficient.** The runtime files
   (`dexbot_cow_runtime.ts`, `dexbot_maintenance_runtime.ts`) touch far more of
   the bot (`bot.manager`, `bot.config`, `bot._log`, `bot._warn`, `bot.account`,
   `bot.accountId`, `bot.privateKey`, plus dozens of `_camelCase` internals).
   **Resolved:** `BotLike` now names that surface (`config: GridConfig`,
   `manager: OrderManagerLike`, `accountOrders`, `account`/`accountId`/
   `privateKey`, `_log`/`_warn`) and keeps an index signature for the remaining
   `_camelCase` internals. `OrderManager` structurally satisfies
   `OrderManagerLike`, so the engine types `manager` against the interface and
   never imports the concrete class. See §7.
4. **`unknown` is not a drop-in for `any`.** A blind
   `sed 's/: any/: unknown/g'` produces hundreds of cascading errors per file
   (`unknown` is not assignable to typed parameters; property access is
   rejected). Migration must be per-file and semantic, verified by `tsc` after
   each batch. Never mass-replace.
5. **Avoid `object` and `{}` as well.** `{}` means "anything non-nullish"
   (including `42` and `"x"`), and `object` carries no property information.
   Prefer `UnknownRecord`, a real interface, or a generic.

## 2. Direct `any` killers

- `unknown` — "check me first". For `catch (err)`, untrusted JSON, plugin
  input. Forces narrowing before use. `getErrorMessage(err)` in
  `modules/utils/errors.ts` already accepts `unknown`.
- `never` — "impossible". For exhaustive `switch` branches and dead code.
  Pair with a `assertNever(x: never): never` helper.
- `void` — function returns nothing. For log / cleanup callbacks.
- `satisfies T` — validate a literal's shape *without* widening its inferred
  type. Prefer over `: T` when you want literal keys preserved, and over
  `as any` when a config object mismatches.

## 3. Objects

- `UnknownRecord = Record<string, unknown>` — dict with unknown values.
  Replaces `Record<string, any>`. Values need narrowing, which is the point.
- `JsonValue` / `JsonObject` — for anything serialized (persisted grids, chain
  JSON, config files, cache shards). `JsonObject` is a *closed* recursive type,
  so `JSON.parse` output still needs a guard, but persisted data gets an honest
  contract.
- `interface` / inline `{ id: string; price: number }` — when you know 2–3
  fields, write them. Chasing a full struct is not required to delete an `any`.
- `Partial<T>`, `Pick<T, 'a' | 'b'>`, `Omit<T, 'x'>`, `Required<T>`,
  `Readonly<T>` — variants without new named types.
- `Record<string, never>` — an empty object (better than `{}` when you mean it).

## 4. Functions

- Never `: Function`. Write the shape instead:
  `(msg: string, level?: string) => void` (the `LogFn` pattern).
- Logger params: `{ log?: LogFn; warn?: LogFn; info?: LogFn; debug?: LogFn }`
  (`LoggerLike`), matching how callers actually use them.
- Unknown wrapper: `(...args: unknown[]) => unknown` — only truly appropriate
  for re-export shims such as `dexbot_maintenance_runtime.ts`, and even there
  prefer typing the real signature when the target is a single function.

## 5. Unions, not `any`

- `string | number`, `Order | null`, `'buy' | 'sell' | 'spread'` — the same
  pattern already used in `modules/types.ts` for
  `Order = VirtualOrder | ActiveOrder | PartialOrder`.
- `T | null | undefined` + `?.` for chain fields that may be missing.
- Prefer a discriminated union over an optional-field bag when a value drives a
  behavior branch — it makes the `switch` exhaustive (`never` check).

## 6. Generics instead of `(x: any) => any`

- `<T>(item: T, toOrder: (t: T) => Order | null)` — for helpers like
  `buildOutsideInPairGroups` in `modules/order/utils/order.ts`.
- `<T extends UnknownRecord>(obj: T): T` for passthrough config normalizers
  (e.g. `canonicalizeBotAssetSymbols`).
- `keyof T`, `T[K]` — for `getField(obj, key)` style helpers.
- Constrain instead of `any`: `<T extends { id: string }>`, not `<T = any>`.

## 7. Branded IDs (cheap, high value here)

- `type BotKey = string & { readonly __brand: 'BotKey' }`,
  `type OrderId = string & { readonly __brand: 'OrderId' }` — zero runtime cost,
  stops `slotId` vs `orderId` mixups in `dexbot_cow_runtime.ts` /
  `sync_engine.ts`.
- Introduce brands *incrementally* (parse at the boundary, brand the result).
  Do not brand every `string` at once — it will cascade.
- `ChainOrder` should be a real interface matching the BitShares core
  `limit_order_object` (`id`, `sell_price.base/quote {amount, asset_id}`,
  `for_sale`, `seller`, `expiration`, …). Reference:
  `../bitshares-core-7.0.2/libraries/protocol/include/graphene/protocol/`.

## 8. Type guards

- `x is ChainOrder`, `asserts x is string` — for `parseChainOrder()` and
  validators. Narrows `unknown` into a real type.
- Put runtime validators next to their type in `modules/types.ts` or a sibling
  `guards.ts` so the type and the check cannot drift.
- Prefer guard functions over `as` casts at I/O boundaries: validate once, then
  the rest of the module is typed.

## 9. `catch` handling standard

`useUnknownInCatchVariables` is on via `strict`, but `catch (err: any)` is still
allowed. Standard:

```ts
try { ... } catch (err) {            // err: unknown
  logger.warn(`...: ${getErrorMessage(err)}`);
}
```

Use `getErrorMessage` / `getErrorCode` / `getErrorName` / `getErrorField` from
`modules/utils/errors.ts` instead of `(err as any).message` / `.code` / `.name` /

## 10. What belongs in `modules/types.ts`

Add these shared primitives (done as part of this program):

- `JsonPrimitive`, `JsonValue`, `JsonObject`, `JsonArray`
- `UnknownRecord`
- `LogFn`, `LoggerLike`, `getErrorMessage`-style error guard
- `ChainOrder` (+ `ChainAssetAmount`, `ChainPrice`)
- `BotLike` — the real minimal runtime surface (grown as the runtime layer is
  typed, not guessed up front)
- `Deferred<T>` for the `{ promise, resolve, reject }` pattern
- branded `OrderId` / `BotKey` (opt-in)

The rest is `unknown` + unions + real interfaces. `OpContext` is intentionally
**not** added — the op shapes are owned by `chain_orders.ts`.

## 11. Enforcement (make progress monotonic)

Blind cleanup regresses. This repo has no ESLint, so enforcement is a
count-based ratchet:

- `scripts/check_any.ts` counts code-line `any` and fails when the count rises
  above the committed budget.
- Budget lives in `any-budget.json`; lower it as waves land.
- Run: `npm run check:any` (verify), `npm run check:any:update` (re-baseline),
  `npm run check:any:list` (per-file counts).
- Wire into CI / pre-commit alongside `npm run typecheck`.
- Optional later: add `@typescript-eslint/no-explicit-any` once ESLint is
  introduced.

## 12. Migration protocol (per file)

1. Pick a file. Run `npx tsc --noEmit` to confirm green before starting.
2. Replace in this order (cheapest, safest first):
   1. JSDoc `{any}` → real/`unknown` (documentation only, zero risk).
   2. `catch (x: any)` → `catch (x)` + `getErrorMessage`.
   3. `const x: any = expr` → `const x = expr` (let inference work). Caveat:
      if `x` is a CLI-options/config bag that is later mutated with different
      value types, inference narrows it to the seed literal and breaks
      assignments — annotate the bag with a small interface instead.
   4. Domain params with an obvious type (`orderId: string`, `manager`).
   5. `Record<string, any>` → `UnknownRecord` / a real interface.
   6. `as any` → guard/`unknown` narrowing (highest risk, do last).
3. `npx tsc --noEmit` after each file; fix forward.
4. Run the relevant tests (`npm run build:tests && node dist/...` — see
   `tests/README.md`).
5. Lower `any-budget.json`.
6. Commit one file/group at a time with a `refactor(types):` message.

## 13. Phased program

1. **Foundation** — add the shared types (§10), the ratchet script, and fix the
   `OrderBase.metadata` type. *(this change)*
2. **Leaf utilities** — `modules/utils/*`, `settings_merge.ts`,
   `runtime_settings.ts`, `bot_defaults.ts`, `constants.ts` (few `any`s, high
   fan-in).
3. **Order engine** — `modules/order/**`. *(started)* The `manager`/`bot`
   boundary is typed via `OrderManagerLike`/`BotLike`; `OrderManager implements
   OrderManagerLike`. Remaining work is the intra-function locals (`value: any`
   numeric params, `Record<string, any>` caches) — keep going file-by-file.
4. **Runtime layer** — `dexbot_cow_runtime.ts`, `dexbot_maintenance_runtime.ts`,
   `dexbot_fill_runtime.ts`, `credit_runtime.ts`. **DONE.** Option A chosen and
   executed: full index-signature-free `BotLike`, `DEXBot implements BotLike`,
   every runtime file migrated off `bot: any`.
5. **Chain/native** — `chain_orders.ts`, `bitshares-native/**`, clients.
6. **Entrypoints/scripts/analysis** — `*.ts`, `scripts/**`, `analysis/**`.

## Rule of thumb

- Unknown shape → `unknown`
- Arbitrary JSON → `JsonValue` / `JsonObject`
- Dict → `UnknownRecord`
- Known 2–3 fields → inline interface
- Domain object → named type (`ChainOrder`, `Order`, `BotLike`)
- Never `any`, never `object`, never `Function`
