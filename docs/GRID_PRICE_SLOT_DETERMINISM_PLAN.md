# Grid Price-Slot Determinism Plan — Nearest-Slot, Genesis-Frozen, No Legacy

> **Status:** draft for review — implements decision: price is single authority for slot identity.
> **Updated:** 2026-09-01 to match `test@8d1b3dee` (`origin/test` vs `origin/main dd2d21b5`, +5832/-715, 45 files).
> Previous anchor/boundary-evidence divergence (`MarketAnchor`, `validateBoundaryAgainstChainEvidence`) was reverted in `e7231534`; `8d1b3dee` (prev `ceb53819`) replaced dual-pivot (`_lastFilledBuyPrice/_lastFilledSellPrice`) with single pivot (`_lastFilledPrice/_lastFilledType`) ± halfIncrement in `modules/dexbot_cow_runtime.ts:1624` `isLastFillGuardBlocked` (doc comment at :1611; manager retains `recordLastFilledPrices:1679` + `seedLastFilledPricesFromBook:1705`). Allowed region is `BUY <= pivot*(1-half)`, `SELL >= pivot*(1+half)`; the complement is blocked (`BUY > pivot*(1-half)` or `SELL < pivot*(1+half)`). `findCrossedOrder` crossing guard retained (`math.ts:914`).
>
> **Decisions locked:**
> 1. Nearest slot only, **no tolerance** — `chain.price -> slotIndexForPrice -> slot-N`.
> 2. Genesis frozen at creation (`startPrice`, `incrementPercent`, `gapSlots`) persisted in `modules/account_orders.ts:336` `storeMasterGrid` (extend current sig).
> 3. No legacy `!^slot-\d+$` support — `modules/order/utils/order.ts:915` `parseSlotIndex` (`^slot-(\d+)$` at `order.ts:917`) must succeed or slot is invalid → virtualize.

## 1. Problem Statement

Current grid mixes two identities for a slot. See `modules/order/grid.ts:383-513` (`createOrderGrid` geometric `priceLevels -> slot-N`) vs persisted array order (`modules/account_orders.ts:342`), `Map` insertion order (`modules/order/manager.ts` / `modules/order/working_grid.ts:93`), and fallback `grid.map((o,i)=>i)` / `parseSlotIndex(o.id) ?? i` (`modules/order/grid.ts:808` `countGapBandSpread`, `modules/order/strategy.ts` window fallback, `modules/order/utils/order.ts:932` `chainOrderMatchesSlot`). On-chain adoption `modules/order/sync_engine.ts:714-932` Pass1 exact `orderId (1.7.x)` is deterministic, Pass2 `modules/order/utils/order.ts:266` `findMatchingGridOrderByOpenOrder` is heuristic `priceDiff <= calculatePriceTolerance(size)` (`modules/order/utils/math.ts:791`) with `bestPriceDiff` tie = insertion order (nondeterministic). The earlier `validateBoundaryAgainstChainEvidence` (`modules/order/grid_reconcile.ts:359`) was removed in `e7231534`; boundary now derives from `calculateIdealBoundary` (`modules/order/utils/order.ts:1216`, imported by `grid.ts:160`) + `LAST-FILL-GUARD` (`modules/order/manager.ts:1679` `recordLastFilledPrices` / `dexbot_cow_runtime.ts:1624` `isLastFillGuardBlocked`) and can still flip `BUY/SELL/SPREAD` for same `slot-N` if re-interpreted from persisted `boundaryIdx`.

Goal: make price the single authority. `slot-N` must be derivable from `genesis + price` via pure math, not array position or last iteration order. `orderId (1.7.x)` remains only for chain object identity.

## 2. Canonical Price-Slot Registry

### 2.1 New pure functions — `modules/order/utils/math.ts` (browser-safe; add re-export in `order.ts` if kept in `math.ts`)

Current `test` has no genesis helpers yet — `math.ts:1-1691` exports ~60 functions (`math.ts:1624` re-export block) but none of `priceLevelsForGenesis/slotIndexForPrice`. This section is additive. Note: `order.ts` currently only imports math helpers (no re-export block; `order.ts:1735` exports 50 order-local functions) — add a re-export if genesis helpers live in `math.ts`.

```ts
type GridGenesis = {
  startPrice: number;            // frozen at createOrderGrid
  incrementPercent: number;       // frozen
  gapSlots: number;               // frozen — do not recompute from live increment
  priceLevels: number[];          // frozen geometric rail
  priceLevelsHash: string;        // hash of priceLevels for migration check
  createdAt: number;
};

function priceLevelsForGenesis(g: GridGenesis): number[] // pure geometric, same as grid.ts:437-456
function priceForSlot(idx: number, g: GridGenesis): number // g.priceLevels[idx]
function slotIndexForPrice(price: number, g: GridGenesis): number // binary search nearest — see §2.2
function slotIdForPrice(price: number, g: GridGenesis): string // `slot-${slotIndexForPrice(price,g)}`
function assertSlotPriceInvariant(slot: Order, g: GridGenesis): void // |slot.price - priceForSlot(parseIdx,g)| < EPS
```

All float comparisons via **single epsilon** — integer round-trip `floatToBlockchainInt(blockchainToFloat(...), precision)` (`modules/order/utils/math.ts:649-730` `blockchainToFloat:649`/`floatToBlockchainInt:670`/`quantizeFloat:315` plus `quantumForPrecision:717`/`getPrecisionSlack:729`). Retire the competing epsilons: `strategy.ts` `GRID-DEDUPE` tolerance (`1e-8` at `strategy.ts:279` via `snapRail:295-340`), `math.ts:717` quantum, `constants.ts:481` `PRICE_TOLERANCE_MIN_ABSOLUTE` (`:477` cap, `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER` declared at `:490`, comment at `:483`), and additionally `ORDER_RELATIVE_TOLERANCE` (`order.ts:1404`) / `resolvePriceTolerance` (`order.ts:1453`) used by `ordersEqual:1525` (via `resolvePriceTolerance:1525`) — `_isProjectionUnchanged:917` uses strict `===` and is the companion site to unify via `priceSlotEqual` using `floatToBlockchainInt` equality. New helper `priceSlotEqual(a,b,precision)` uses `floatToBlockchainInt` equality.

Location: `modules/order/utils/math.ts` stays browser-safe (`docs/BROWSER_COMPAT_PLAN.md:264`). Genesis I/O (`account_orders.ts`) is Node-only — keep pure math browser-safe, storage bridge in Node module. Add to `package.json:133` browser `false` map if new `price_slots.ts` created, or keep in `math.ts`.

**Duplicate parser gap:** `isSlotInRail` (`math.ts:1611`, `^slot-(\d+)$` at `:1613`) embeds a second slot-N parser that **fails open** — parse failure → `return true` (not excluded). Decision #3 ("no legacy, parse or virtualize") should mandate unifying parsers and making `isSlotInRail` fail-closed; currently only `order.ts:915` is cited. Unify on `parseSlotIndex` or extract a shared helper and make unparseable ids a hard exclude/virtualize.

**Tolerance fallback note:** `findMatchingGridOrderByOpenOrder` (`order.ts:266`) silently falls back to `tolerance = 0` when `calcToleranceFn` is omitted (`order.ts:302` `|| 0` — virtual/spread slots only match at exact price). Worth noting when deleting it: nearest-slot must not reintroduce a hidden 0-tolerance exact-match path.

### 2.2 Nearest-slot rule (no tolerance)

```
idx = binarySearch(priceLevels, price) // returns nearest index; never null
tie: |price - priceLevels[idx]| == |price - priceLevels[idx+1]| → lower idx wins
out-of-bounds: price < priceLevels[0] → idx=0; price > priceLevels[N-1] → idx=N-1
  but adoption still checks isSlotAvailable + !isSlotInRail gap (see §4) — edge slot
  may be VIRTUAL SPREAD gap → nearest fails → unmatched → cancelOnly (deterministic)
```

No `calculatePriceTolerance` for slotting. Keep it only for fee/balance display and current crossing guard `findCrossedOrder:914` until slotId equality lands.

## 3. Genesis Plumbing

* `modules/order/grid.ts:383` `createOrderGrid(config)` → returns `{orders, boundaryIdx, genesis}`. Compute `priceLevels` via `priceLevelsForGenesis` (extract inline `437-456` logic). Hash `priceLevels` for migration.
* `modules/account_orders.ts:336` `storeMasterGrid(orders,btsFeesOwed,boundaryIdx,assets,debugInputs,recentFillKeys)` — **current sig has 6 args, no genesis**. Extend to `storeMasterGrid(..., genesis)` and persist as `data.genesis` alongside `data.grid/boundaryIdx/assets` (`account_orders.ts:149` `emptyData()` + `336-342` persist). `loadProcessedFills:504` unchanged. Migration: if `data.genesis` missing, recompute from live `startPrice/minPrice/maxPrice` (see §4).
* `modules/constants.ts:450` `GRID_LIMITS` — document genesis frozen fields; deprecate live re-derivation `calculateGapSlots:1354` / `getSellStartIdx:1371` / `resolveGapSlots:1381` (JSDoc at `1377-1380`) from `manager.config.incrementPercent` on every `strategy.ts` call. Freeze `gapSlots` from genesis instead of recomputing. Note: `manager.ts:422` is only the `_gapSlots: number` type decl — no `?? calculateGapSlots(...)` fallback lives in `manager.ts`; that pattern lives in `grid.ts:1644/1996`, `strategy.ts:230`, `utils/system.ts:936/1183` via `resolveGapSlots`.
* `modules/settings_merge.ts` / `modules/runtime_settings.ts` — genesis is snapshot at creation vs live config: snapshot once, do not re-derive `gapSlots`/`incrementPercent` on every strategy calc.

## 4. Load Determinism

`modules/order/grid.ts:556` `loadGrid(manager, grid, boundaryIdx)` — current `test` steps (boundary gate `validatePersistedBoundary` `grid.ts:600,617` via `math.ts:1544`, bloat guard `isGridBloated:175/726`, `createUncertain` sanitizer `770-798`, type reassignment `663-722` via `buyEndIdx` geometry, `countGapBandSpread:808` with `parseSlotIndex(o.id) ?? i` fallback `808-810`):

1. Load `genesis` from snapshot; if missing (pre-migration grid) → migrate: recompute `priceLevels` from live `startPrice/minPrice/maxPrice:383-456` (`grid.ts:437-456`), build genesis, validate each slot via `assertSlotPriceInvariant`; if slot price mismatches → virtualize. If `parseSlotIndex` order != price-sorted order → re-sort persisted array to canonical `priceLevels` order and rewrite snapshot (one-time).
2. Derive `priceLevels = genesis.priceLevels` (do not recompute).
3. Validate `assertSlotPriceInvariant` per slot; on fail → virtualize (no silent `parseSlotIndex(o.id) ?? i` fallback `grid.ts:808-810` — require `parseSlotIndex(o.id)!` and drop `allowNullType` vacuous path).
4. Replace `grid.map((slot,i)=>i)` type reassignment `grid.ts:663-672` with `idx = parseSlotIndex(slot.id)!` (current code uses `i` which equals slot-N only when persisted array is price-sorted; after genesis freeze use canonical idx).
5. `modules/order/accounting.ts:394` `resolveSpreadOrderSide(price,startPrice)` → replace with `isSlotInRail(boundaryIdx,gapSlots,type,slot)` via `parseSlotIndex` (see `modules/order/utils/math.ts:1611` `isSlotInRail`; `order.ts:1259` is `assignOnChain` — not the predicate; `isSlotInRail` at `math.ts:1612` returns `true` on `null/NaN` — not `:52`). `startPrice` only for `calculateAvailableFundsValue` valuation (defined at `math.ts:463`, used at `accounting.ts:431-432`). Keep `createUncertain` handling: only `VIRTUAL && !hasOnChainId && size>0 && createUncertain===true` is sanitized (`grid.ts:770-787`); normal sized VIRTUAL is the planned-but-unplaced rail budget and must survive reload.
6. `modules/order/working_grid.ts:93` `WorkingGrid._cloneGrid` add `getOrderedSlots(): Order[]` sorted by `parseSlotIndex`; mandate for `modules/order/strategy.ts:219` window, `modules/order/utils/validate.ts:357` `reconcileGrid` hole/surplus pairing, `modules/order/grid.ts:808` counting. Current `WorkingGrid` has only `values()/entries()` unordered iteration.

## 5. Nearest-Slot Adoption (Pass2) — No Tolerance Scan

Current `test` Pass2 `modules/order/sync_engine.ts:934-1193`:
- Duplicate-price guard `sync_engine.ts:940-989` (`Math.abs(price-price) <= tolerance` with `calculatePriceTolerance:791`, tag `duplicate-price-level` at `:966`) before adoption.
- `findMatchingGridOrderByOpenOrder` `sync_engine.ts:991-1002` with `calcToleranceFn: (p,s,t)=>calculatePriceTolerance(p,s,t)` + `requireAvailableSlot + excludeGridOrderIds`, plus widened `sync_engine.ts:1038` size-sync `targetInt !== chainInt` via `floatToBlockchainInt:670` (orphan widening `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER:490` `constants.ts:490`, comment at `:483`, value `4`, used at `sync_engine.ts:1114` is at adoption, size path is separate).
- Suspect-empty guard `sync_engine.ts:559-585` (`SYNC_SUSPECT_EMPTY_READ_LIMIT:242` `constants.ts:242`), drift tag `computeOutOfToleranceDriftTag:218` with `PRICE_DRIFT_TOLERANCE_MULTIPLIER:573` `constants.ts:573` (comment at `:569-572`).

Proposal:

* Pre-sort `parsedChainOrders` by `abs(chain.price - anchorPrice)` — makes `matchedGridOrderIds` exclusion deterministic (today `get_full_accounts` seller-id ascending `modules/chain_orders.ts:665` (doc comment at `633-648`) truncates freshest last, 500 cap → truncated flag).
* For each `chainOrder`:
  ```ts
  idx = slotIndexForPrice(chain.price, genesis) // nearest, never null
  slot = mgr.orders.get(`slot-${idx}`)
  if (isSlotAvailable(slot) && typeCompat(slot, chain) && !matchedGridOrderIds.has(slot.id)
      && !isSlotInRailGap(slot, boundaryIdx, gapSlots)) // gap SPREAD not adoptable
       adopt → ACTIVE
  else
       unmatchedChainOrders.push("no-available-nearest-slot"); queueCorrection(cancelOnly:true)
  ```
* Delete `modules/order/utils/order.ts:266` `findMatchingGridOrderByOpenOrder` price scan + `calculatePriceTolerance:791` for this path. Keep function only for `modules/order/grid_reconcile.ts` suspect-duplicate tagging or replace with `slotId` equality.
* Remove `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER*4` widened check (`constants.ts:490`) — nearest-slot is the check. This widening was introduced by `4838bcb0` ("stop recovery re-anchoring / orphan adoption durable"); `cd690000` is the sized-orphan healing that depends on it — document the dependency when deciding to drop the multiplier.
* `modules/dexbot_fill_runtime.ts:532` fill lookup `manager.orders.get(fillOp.order_id) || values().find(o=>o.orderId)` linear fallback for fills → keep `orderId` exact only. `processSweepOrphanFill:97` + `isUnknownFillOrderAdoptable:35` (defined at `:35`, price gate at `:58`) price-range `min/1.25..max*1.25:71-72` → replace with `slotIndexForPrice` + availability check; `chainOrderMatchesSlot:932` asset gate stays, price gate becomes nearest-slot.
* `modules/order/grid_reconcile.ts` `SUSPECTED_DUPLICATE_TOLERANCE_MULTIPLIER=5` channel (removed in `e7231534` with anchor) — if reintroduced, replace with `slotId` equality (`slotIdForPrice(chain.price) === existingSlot.id`). Keep current duplicate-price guard shape but switch predicate to `slotId` equality.
* Retain `sync_engine.ts:559` suspect-empty guard and `sync_engine.ts:940` duplicate-price guard shape (predicate becomes `slotId` equality), and `math.ts:914` `findCrossedOrder` / `order.ts:482` `CROSS-GUARD` for self-trade until slotId adoption proves crossing impossible.

**Size handling — identity vs accounting:** slot identity ignores `size`; `size` is preserved on-chain for `PARTIAL/ACTIVE` per `docs/COW_INVARIANTS.md:62` `INV-PROJ-002/003`. `modules/order/accounting.ts:346` `recalculateFunds` (aggregation loop `383-410`) aggregates `order.size` for `chainBuy/chainSell`; do not overwrite `PARTIAL` size with ideal size unless explicit `UPDATE`. Size divergence triggers existing `checkFundDrift` (`validate.ts:292`, imported by `accounting.ts`) + `getPrecisionSlack` (`math.ts:729`, used at `validate.ts:320`) `PERCENT_TOLERANCE` — keep, but do not use size to choose slot. `resolveSpreadOrderSide` is defined at `order.ts:901` (used at `accounting.ts:394`); `calculateAvailableFundsValue` is defined at `math.ts:463` (used at `accounting.ts:431-432`).

## 6. Validation & Reconcile Updates

Current `modules/order/utils/validate.ts:649` `validateCreateTargetSlots` four layers (`slot_occupied` `682`, `price_collision` `710` via `findPriceCollision:840`, `chain_orphan_collision` `741`, `same_batch_price_collision` `770` via `calculatePriceTolerance:791` with `min(tolA,tolB)`):

* Replace layers 2-4 with `slotId` equality: two targets share `slot-N` or target `slotId` equals placed `slotId` → collision. Keep layer 1 `slot_occupied` (`isOrderOnChain`).
* `validate.ts:451` `pairRotations` sorts holes/surpluses by `price` distance → sort by `|parseSlotIndex(hole.id) - parseSlotIndex(surplus.id)|` then price as tie-break. `validate.ts:524` `optimizeRebalanceActions` `abs(toPrice-fromPrice)` → `abs(toIdx - fromIdx)` (slot distance) determinism.
* `validate.ts:917` `_isProjectionUnchanged` `price===targetPrice` vs `strategy.ts` dedupe tolerance → unify via `priceSlotEqual` (integer sats `floatToBlockchainInt:670`). Note `ORDER_RELATIVE_TOLERANCE` (`order.ts:1404`) and `resolvePriceTolerance` (`order.ts:1453`) are the competing epsilons on this path.
* `modules/order/strategy.ts:219-426` `StrategyEngine` window `inBuyRail/inSellRail` `isSlotInRail` + current dedupe `strategy.ts:295-340` `snapRail` (`[GRID-DEDUPE]` at `323/330`, tolerance `1e-8` at `:279`, applied `342-343` before sizing; `396-397` are just `applySizes` calls) — keep window discipline; gap mid-price tie (two equidistant slots, one gap-excluded) deterministically adopts the rail slot, gap slot remains `SPREAD` VIRTUAL. After migration, dedupe → `slotId` equality. No `enforceMonotonic` helper exists — do not reference it; if a monotonic price guard is desired, introduce it as a new slot-index check. After nearest-slot, monotonic holds by construction (priceLevels sorted), but keep guard with slot-index check. Budget non-redistribution is pre-existing — flag for follow-up (not in scope).

## 7. Boundary Crawl Wiring

Current `test` boundary (post-revert `e7231534`):
- `modules/dexbot_fill_runtime.ts:793-872` is `syncFromFillHistoryBatch` (not `deriveTargetBoundary`); `deriveTargetBoundary` lives at `modules/order/utils/order.ts:1593` (`isShiftEligibleFill:1589`) and is invoked from `modules/order/strategy.ts:232` (fill-batch `deriveTargetBoundary` count-crawl with `LAST-FILL-GUARD` (`manager._lastFilledPrice/_lastFilledType` `manager.ts:1679` `recordLastFilledPrices` + `1705` `seedLastFilledPricesFromBook` from live book, halfIncrement via `dexbot_cow_runtime.ts:1624` `isLastFillGuardBlocked`) and `findCrossedOrder:914` guard (`dexbot_cow_runtime.ts` intra-batch `intraBatchCandidates`).
- No `validateBoundaryAgainstChainEvidence` — deleted. `calculateIdealBoundary` (`order.ts:1216`) + `getSellStartIdx:1371` (`math.ts:1371`) derive from `gapSlots` live.

After genesis freeze, `calculateIdealBoundary` uses `genesis.priceLevels` not live `startPrice`. `modules/dexbot_maintenance_runtime.ts:83-106` AMA `delta_threshold/slope_delta` grid-resync reasons → before rebuild, pin `gridCenterPrice` to `genesis.startPrice`; if AMA center drifts beyond `genesis.priceLevels` bounds → nearest edge slot adoption (§5) + boundary shift, not rail rebuild with new center. Add `promoteAmaCenterSnapshotForGridReset:730` guard in `modules/dexbot_maintenance_runtime.ts:730` (not `market_adapter_service.ts`): do not mutate `genesis`.

## 8. Fund Invariants Separation

* `modules/order/accounting.ts:346` `recalculateFunds` (aggregation `383-410`) + `checkFundDrift:292` (`validate.ts:292`, via `getPrecisionSlack:729`) `PERCENT_TOLERANCE` + `fund_registry.ts:170` `getEffectiveAllocationSync` assume committed `size` fits share. With size-ignored identity, `INV-ACC-002` widening `PERCENT_TOLERANCE*3` still applies (see `docs/COW_INVARIANTS.md:87` / `:256` `INV-ACC-003`; `INV-ACC-002` at `:80`); no change needed except clarify: slot identity does not imply size equality. `docs/FUND_MOVEMENT_AND_ACCOUNTING.md` needs note.
* `docs/COW_INVARIANTS.md` is 309 lines: `INV-GRID-002` at `:171-174`; `INV-SYNC-004` at `:108`, `INV-RECON-003` at `:193-198`. They codify `calculatePriceTolerance:791` (`Math.max(size)`) duplicate guard → update to `slotId equality` / `floatToBlockchainInt:670` integer equality via `priceSlotEqual`.

## 9. Market Adapter Genesis Pinning

* `modules/order/grid.ts:888-1020` `gp` from `pool/book` or `amaCenterPrice:915-928` + `market_adapter/core/market_adapter_service.ts:392` `clampGridPriceToBounds` + `computeAppliedAsymmetryMetrics:407` + `modules/dexbot_maintenance_runtime.ts:730` `promoteAmaCenterSnapshotForGridReset` mutating `centerPrice` in `.dynamicgrid.json` — pin to `genesis.startPrice`; AMA triggers (`dexbot_maintenance_runtime.ts:83`) shift boundary, not genesis. Current asymmetric bounds `applyAsymmetricBounds:957` still widens `resolvedMinP/MaxP` from live `gp`; after freeze `resolvedMinP/MaxP` must be derived from genesis rail, not live `gp`.

## 10. Edge Cases

| Case | Rule | File |
|------|------|------|
| Price exactly midpoint between two slots | Lower `idx` wins | `math.ts:slotIndexForPrice` |
| Price outside grid (`<min` or `>max`) | Nearest edge slot `0`/`N-1`; if gap or occupied → `no-available-nearest-slot` cancelOnly | `sync_engine.ts:934` |
| Price maps to gap `SPREAD` slot | Gap excluded via `isSlotInRail` — nearest fails, cancelOnly | `strategy.ts:219` window + `sync_engine:934` |
| On-chain residual `size` != ideal slot size | Preserve `PARTIAL` size; identity still nearest-slot | `COW_INVARIANTS.md:62` + `order.ts:331` `applyChainSizeToGridOrder` |
| Floating rounding (precision 0) | `priceSlotEqual` via `floatToBlockchainInt:670` round-trip | `math.ts:649-670` |
| Persisted grid without genesis | Migrate: recompute `priceLevels` from `startPrice/minPrice/maxPrice:383`, build genesis, re-sort array, rewrite snapshot | `account_orders.ts:336` + `grid.ts:556` |
| `createUncertain` sized VIRTUAL | Only `createUncertain===true && VIRTUAL && !orderId && size>0` is sized-orphan candidate (`grid.ts:770`) — normal sized VIRTUAL must survive migration unsanitized | `grid.ts:770-783` |
| Suspect empty read | `SYNC_SUSPECT_EMPTY_READ_LIMIT=3` consecutive empties required before virtualizing (`sync_engine.ts:559`) — nearest-slot must not bypass this guard | `constants.ts:242` |

## 11. Browser-Safe & Config Caching

* Pure `priceForSlot/slotIndexForPrice` stays browser-safe (`package.json:133` not `false`). Genesis I/O stays Node-only (`modules/account_orders.ts`, `modules/storage/node_adapter.ts`). Guard with `modules/env.ts: isBrowser`. Current `math.ts:39` (`getPrecisionSlack` comment) / `math.ts:120` is browser-safe; `account_orders.ts` Node-only confirmed.
* `modules/config.ts:215-230` live `Config` getters (ESM `Object.defineProperty`; `212` is `setUmask`) + `modules/paths.ts:80` `getHomeConfigDir()` live — set `GRID_PRICE_SLOT_VALIDATION` before `require()` or mutate `Config` after. Document in plan rollout. No change needed vs `test` — already live.

## 12. Tests & Gates

* New `tests/test_grid_price_slot_invariant.ts`: `priceForSlot` round-trip, midpoint tie-break, shuffled `chainOrders` determinism, out-of-bounds edge, gap exclusion, legacy `parseSlotIndex` failure → virtualize, `createUncertain` preservation.
* Extend `tests/test_is_slot_in_rail.ts:22`, `tests/test_cow_boundary_slot_replacement.ts:120` with invariant `parseSlotIndex order == price order` after `loadGrid`.
* Update `tests/test_sync_excess_orphan.ts:80` — `:80` asserts NOT adopted with no tag (`SYNC-EXCESS-001`); the `price-drift-orphan` tag assertion is at `:128` (`SYNC-EXCESS-002c`). After nearest-slot, expect `no-available-nearest-slot` not `price-drift-orphan` for that case; keep `test_cow_crossing_guard.ts:181` + `test_startup_cross_guard.ts:243` until slotId proves crossing impossible.
* Run `npm run analysis:grid-check` (`analysis/grid_correction_check.ts:805`) monotonicity gate. For reconcile/commit tests, **do not use** `npm test -- test_grid_reconcile` — `npm test` ignores argv and runs the full triple build then every `dist/tests/test_*.js`. Instead, after `npm run build`, run targeted files directly: `node dist/tests/test_grid_reconcile.js`, `node dist/tests/test_cow_commit_guards.js`, `node dist/tests/test_sync_excess_orphan.js`, `node dist/tests/test_grid_robustness.js` (current `snapRail` GRID-DEDUPE cases). Add `priceSlotEqual` unit tests.

## 13. Rollout (test → dev → main, per `docs/WORKFLOW.md` / `AGENTS.md`)

1. `test` branch: land Phase1-2 (genesis + load) with `GRID_PRICE_SLOT_VALIDATION=log` (no virtualize), soak 1 cycle, inspect new `GRID_ORDER_MISMATCH`-family diagnostics (tag introduced by Phase 1-2; does not exist in `test@8d1b3dee` — state this explicitly or reuse existing `price-drift-orphan`/`duplicate-price-level` tags during soak). Keep `LAST-FILL-GUARD` and `findCrossedOrder` guards until slotId adoption is proven.
2. Flip to `enforce`, land Phase5-6 (Pass2, validate, strategy). Monitor `no-available-nearest-slot` cancels vs previous `price-drift-orphan` + `duplicate-price-level`. Decide to drop or keep `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER` fallback.
3. Manual merge `test → dev` (default `npm run ptest` / `npm run pdev` force-push skips merge — use manual flow unless user asks).
4. Update `docs/COW_INVARIANTS.md`, `docs/GRID_RECONCILE.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md`.

## 14. Risks & Mitigations

* **Re-sorting persisted array** changes `Map` iteration order — low risk (`WorkingGrid.getOrderedSlots` will enforce price order; current `grid.ts:808` already uses `parseSlotIndex` for `spreadCount`).
* **Fixed nearest-slot may increase `cancelOnly`** for drifted chain orders vs tolerance grace — mitigated by deterministic `no-available-nearest-slot` tagging and existing `batchReadOrders` + `LAST-FILL-GUARD` (`manager.ts:recordLastFilledPrices`) + `suspectEmpty` guard.
* **`get_full_accounts` truncation `modules/chain_orders.ts:665`** (doc comment `633-648`) — nearest-slot deterministic even when tail truncated (missing priceLevels tail has no chain order).
* **`startPrice` string `"pool"` (`grid.ts:865` `derivePriceWithPoolRef` via `utils/withPoolRef.ts:126`, guarded by `Number(derived)` at `865/903` with guards `866/904`)** — `isSlotInRail` `null/NaN → true` at `math.ts:1612` masks bugs — add explicit error when `boundaryIdx` null during strategy calc after genesis freeze.
* **Dropping `*4` widening** reintroduces regeneration leftovers — the exact regression the sized-orphan healing (`cd690000`) fixed, which depends on widening introduced by `4838bcb0`; soak with `4x` fallback `|| nearestSlot` before full removal.

## 15. Execution Checklist

- [ ] `modules/order/utils/math.ts` — add `priceLevelsForGenesis/priceForSlot/slotIndexForPrice/slotIdForPrice/priceSlotEqual`, deprecate `calculatePriceTolerance` for slotting (keep for `findCrossedOrder` until removed); unify `isSlotInRail:1611` parser with `parseSlotIndex:915` (fail-closed)
- [ ] `modules/order/grid.ts:383,488,556,808,888` — genesis plumbing, load validation, re-sort, `parseSlotIndex!`, preserve `createUncertain` sanitizer
- [ ] `modules/account_orders.ts:149,336,342,504` — persist `genesis` (`data.genesis`), migration for legacy grids, extend `storeMasterGrid` sig
- [ ] `modules/order/working_grid.ts:93` — `getOrderedSlots()` sorted by `parseSlotIndex` (`_cloneGrid`)
- [ ] `modules/order/accounting.ts:346` (`recalculateFunds:346`, loop `383-410`) / `validate.ts:292` (`checkFundDrift`) / `math.ts:729` (`getPrecisionSlack`) / `math.ts:463` (`calculateAvailableFundsValue` used at `accounting.ts:431-432`) / `order.ts:901` (`resolveSpreadOrderSide` used at `accounting.ts:394`) — rail via `isSlotInRail` (`math.ts:1611`), valuation via `calculateAvailableFundsValue` unchanged
- [ ] `modules/order/strategy.ts:219,295-340` — ordered slots, frozen `gapSlots` from genesis, dedupe `snapRail:295-340` (`1e-8` at `:279`) → `slotId` equality, keep window `applySizes` until slotId lands
- [ ] `modules/order/utils/order.ts:915,932,1216,1589,1593` — `parseSlotIndex` strict, `chainOrderMatchesSlot` retired for adoption (keep asset gate), `calculateIdealBoundary:1216` / `findCrossedOrder:914` / `isShiftEligibleFill:1589` / `deriveTargetBoundary:1593` (invoked from `strategy.ts:232`) retained until slotId; note `ORDER_RELATIVE_TOLERANCE:1404` / `resolvePriceTolerance:1453` and `findMatchingGridOrderByOpenOrder:266` `tolerance||0` fallback at `:302`
- [ ] `modules/order/utils/validate.ts:357,451,524,649,917` — slotId equality, slot-distance pairing (`pairRotations:451`/`optimizeRebalanceActions:524`), epsilon unification via `priceSlotEqual` (`floatToBlockchainInt:670`)
- [ ] `modules/order/sync_engine.ts:559,714-932,934-1193,991-1002` — nearest-slot adoption, pre-sort, gap exclusion, keep suspect-empty + duplicate-price (`940-989`, tag at `966`) shape, decide `ORPHAN_ADOPTION_TOLERANCE_MULTIPLIER:490` removal
- [ ] `modules/order/grid_reconcile.ts` + `modules/dexbot_fill_runtime.ts:35,532` (`isUnknownFillOrderAdoptable:35`) + `dexbot_cow_runtime.ts:1624` (`isLastFillGuardBlocked:1624`, comment `:1611`) — nearest-slot adoptable, keep `LAST-FILL-GUARD` (`isLastFillGuardBlocked:1624`/`manager:1679`) + `findCrossedOrder:914` until boundary wiring is genesis-based
- [ ] `market_adapter/core/market_adapter_service.ts:392,407` + `modules/dexbot_maintenance_runtime.ts:730` (`promoteAmaCenterSnapshotForGridReset:730`) — pin genesis, not `centerPrice`; keep asymmetric bounds clamp (`clampGridPriceToBounds:392`) against genesis rail
- [ ] `docs/COW_INVARIANTS.md:171` (309 lines; `INV-GRID-002:171-174`, `INV-SYNC-004:108`, `INV-RECON-003:193`), `docs/GRID_RECONCILE.md`, `docs/FUND_MOVEMENT_AND_ACCOUNTING.md` — invariant updates (`slotId equality` + `priceSlotEqual` via `floatToBlockchainInt:670`; `INV-ACC-002:80`, `×3` at `:87`/`:256`)
- [ ] `tests/` — new invariant test + extensions, `analysis/grid_correction_check.ts:805` gate, keep `test_grid_robustness` cases until slotId dedupe lands; run via `node dist/tests/test_*.js` after build (not `npm test -- <filter>`)
