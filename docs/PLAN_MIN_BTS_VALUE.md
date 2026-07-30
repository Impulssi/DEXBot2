# Plan: `min_BTS_value` for Non-BTS Paired Bots (✅ COMPLETED)

**Status:** All implementation phases (1–5) are complete. Phase 6 (tests) was not created — `tests/test_non_bts_fee_handling.ts` does not exist on disk. This document is preserved for historical reference.

> **Note:** The actual implementation diverges from this plan in one area: no `calculateMinBtsValue()` helper was created. The code uses `calculateOrderCreationFees()` directly with a `configMinBtsValue` parameter instead. See `modules/order/utils/math.ts` and `modules/dexbot_maintenance_runtime.ts` for the live implementation.

## Problem

On BitShares, **every** limit order operation (create/update/cancel) pays fees in BTS (`1.3.0`) regardless of the trading pair. For BTS-paired bots (e.g. XRP/**BTS**), the bot holds BTS on one side so fees are naturally deducted. For **non-BTS pairs** (e.g. XRP/USD), the bot never touches BTS through trading — yet fees still drain BTS.

The codebase currently has **zero** handling:
- `calculateOrderCreationFees()` returns 0 when neither asset is BTS (`utils/math.ts:985`)
- BTS balance is never fetched
- No BTS deficit detection or acquisition exists

---

## Existing BTS Reservation (for reference)

BTS-paired bots have four layers of fee management, all gated on BTS being in the pair:

| Layer | File | What it does |
|---|---|---|
| Fee budget reservation | `utils/math.ts:984-993` | `createFee × totalOrders × 5` — returns 0 for non-BTS |
| Available funds deduction | `utils/math.ts:361-378` | Subtracts from chainFree — skipped for non-BTS |
| Grid budget deduction | `grid.ts:189-202` | Subtracts from order budget — skipped for non-BTS |
| Fee lifecycle tracking | `accounting.ts:147-255, 906-915` | Deferred fee tracking — skipped for non-BTS |

---

## Implementation Plan

### Phase 1: Constants

**`modules/constants.ts`**

| Change | Detail |
|---|---|
| Add `MIN_BTS_VALUE: null` to `DEFAULT_CONFIG` (~line 197) | `null` = auto-calculate. Override via `general.settings.json` `DEFAULT_CONFIG.MIN_BTS_VALUE`. |
| Add `BTS_ACQUIRE_THRESHOLD: 1` to `FEE_PARAMETERS` | Trigger acquisition when BTS free drops below `min_BTS_value × BTS_ACQUIRE_THRESHOLD` (1 = at exactly `min_BTS_value`) |
| Add `BTS_ACQUIRE_TARGET_MULTIPLIER: 3` to `FEE_PARAMETERS` | Target BTS after acquisition = `min_BTS_value × BTS_ACQUIRE_TARGET_MULTIPLIER`. This creates a hysteresis band: trigger at 1×, fill to 3×. |
| Add `POOL_SLIPPAGE_TOLERANCE: 0.02` to `FEE_PARAMETERS` | 2% max slippage for pool swaps |
| Add `BTS_ACQUIRE_COOLDOWN_MIN: 60` to `TIMING` | Min time between acquisitions (prevents rapid retries on failed/below-target swaps) |

**Hysteresis logic:**
```
trigger_at = min_BTS_value × 1.0
target     = min_BTS_value × 3.0

When BTS free < trigger_at:
    deficit = target - BTS free
    acquire deficit worth of BTS via pool swap

Next acquisition only fires when BTS drops below trigger_at again.
```
This gives a 3× buffer — the bot won't re-acquire until it burns through 2× `min_BTS_value` in fees.

---

### Phase 2: BTS Balance Tracking

#### 2a. Extend balance fetch

**`modules/order/sync_engine.ts`** — `fetchAccountBalancesAndSetTotals()` (~line 1127)

```typescript
async fetchAccountBalancesAndSetTotals() {
    const assetList = [assetAId, assetBId];

    // For non-BTS pairs, also fetch core asset (BTS) balance
    const config = mgr.config;
    if (config.assetA !== 'BTS' && config.assetB !== 'BTS') {
        assetList.push(CHAIN.CORE_ASSET_ID); // '1.3.0'
    }

    const lookup = await getOnChainAssetBalances(accountIdOrName, assetList);
    // ... existing assetA/assetB handling ...

    // Store BTS balance if fetched
    const btsInfo = lookup?.[CHAIN.CORE_ASSET_ID];
    if (btsInfo) {
        mgr.btsBalance = { free: btsInfo.free, total: btsInfo.total, locked: 0 };
        // locked is always 0 for non-BTS pairs — bot doesn't trade BTS
    }
}
```

#### 2b. Add state fields

**`modules/order/manager.ts`** — Add to initial state:

```typescript
btsBalance: { free: 0, total: 0, locked: 0 }
```

#### 2c. Persist across restarts

**`modules/order/utils/system.ts`** — `persistGridSnapshot()`

Add `btsBalance` to the snapshot alongside `btsFeesOwed`.

**`modules/account_orders.ts`** — Add `btsBalance` to save/load schema (alongside `btsFeesOwed` at lines ~366, ~489).

---

### Phase 3: `min_BTS_value` Calculation

**No new function needed.** The existing `calculateOrderCreationFees()` in `modules/order/utils/math.ts:984-993` already uses the correct formula:
```
createFee × totalOrders × BTS_RESERVATION_MULTIPLIER
```

The only change: removed the early return `if (assetA !== 'BTS' && assetB !== 'BTS') return 0;` so the function works for all pairs. All existing call sites already guard with `isBtsSide` checks, so this is safe.

The `min_BTS_value` for non-BTS pairs is simply the value of `calculateOrderCreationFees(assetA, assetB, totalOrders)`. If an explicit override is set via `config.min_BTS_value` (from `general.settings.json`), that value is used instead.

---

### Phase 4: Available Funds Reservation

**Goal:** Deduct the expected BTS acquisition cost from both sides' available funds, so the bot doesn't over-commit capital it will need to swap for BTS.

#### 4a. `calculateAvailableFundsValue()` — `modules/order/utils/math.ts:361-378`

After the existing BTS-pair block:

```typescript
// Non-BTS pair: reserve proportional share for BTS fee budget
if (!btsSide && activeOrders) {
    const targetBuy = Math.max(0, toFiniteNumber(activeOrders?.buy, 1));
    const targetSell = Math.max(0, toFiniteNumber(activeOrders?.sell, 1));
    const totalTargetOrders = targetBuy + targetSell;
    const btsFeeBudget = calculateOrderCreationFees(assetA, assetB, totalTargetOrders, FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER);
    const btsFree = toFiniteNumber(funds?.btsBalance?.free, 0);
    const btsDeficit = Math.max(0, btsFeeBudget - btsFree);
    if (btsDeficit > 0) {
        const totalFree = toFiniteNumber(accountTotals?.buyFree, 0)
                        + toFiniteNumber(accountTotals?.sellFree, 0);
        if (totalFree > 0) {
            const sideFree = toFiniteNumber(side === 'buy' ? accountTotals?.buyFree : accountTotals?.sellFree, 0);
            const share = sideFree / totalFree;
            return Math.max(0, chainFree - virtualReservation - btsDeficit * share);
        }
    }
}
```

This self-corrects on next `recalculateFunds()` — once acquisition raises `btsBalance.free`, the deficit shrinks and the deduction disappears.

#### 4b. `_getSizingContext()` — `modules/order/grid.ts:189-202`

After the existing BTS-pair block:

```typescript
if (!isBtsSide && budget > 0) {
    const btsFree = toFiniteNumber(manager.funds?.btsBalance?.free, 0);
    const targetBuy = Math.max(0, manager.config.activeOrders?.buy || 1);
    const targetSell = Math.max(0, manager.config.activeOrders?.sell || 1);
    const minBtsVal = calculateMinBtsValue(
        manager.config.assetA, manager.config.assetB,
        { buy: targetBuy, sell: targetSell }
    );
    const btsDeficit = Math.max(0, minBtsVal - btsFree);
    if (btsDeficit > 0) {
        const sideRatio = isBuy
            ? toFiniteNumber(manager.accountTotals?.buyFree, 0)
            : toFiniteNumber(manager.accountTotals?.sellFree, 0);
        const totalFree = toFiniteNumber(manager.accountTotals?.buyFree, 0)
                        + toFiniteNumber(manager.accountTotals?.sellFree, 0);
        const share = totalFree > 0 ? sideRatio / totalFree : 0.5;
        budget = Math.max(0, budget - btsDeficit * share);
    }
}
```

#### 4c. `getSideBudget()` — `modules/order/utils/order.ts:1018-1024`

Same proportional deduction pattern.

---

### Phase 5: BTS Acquisition via Pool Swap

#### 5a. Pool discovery

**New helper — `modules/order/utils/math.ts`** (or `system.ts`, colocated with `derivePoolPrice`):

```typescript
async function findBtsPoolForAsset(BitShares, assetId) {
    const poolData = await findPoolByAssets(assetId, CHAIN.CORE_ASSET_ID);
    if (!poolData) return null;

    const isAssetA = poolData.asset_a === assetId;
    return {
        poolId: poolData.id,
        assetReserve: isAssetA ? blockchainToFloat(poolData.balance_a) : blockchainToFloat(poolData.balance_b),
        btsReserve: isAssetA ? blockchainToFloat(poolData.balance_b) : blockchainToFloat(poolData.balance_a),
        rawPool: poolData
    };
}
```

Reuses the pool discovery from `market_adapter/utils/chain.ts:findPoolByAssets()`. Import via the existing `modules/order/utils/system.ts:derivePoolPrice()` code path to avoid cross-directory dependency.

#### 5b. Swap operation builder

**New — `modules/chain_orders.ts`:**

```typescript
function buildLiquidityPoolExchangeOp(accountId, poolId, sellAmountInt, sellAssetId, minReceiveInt, receiveAssetId) {
    return {
        op_name: 'liquidity_pool_exchange',
        op_data: {
            fee: { amount: 0, asset_id: CHAIN.CORE_ASSET_ID },
            account: accountId,
            pool: poolId,
            amount_to_sell: { amount: sellAmountInt, asset_id: sellAssetId },
            min_to_receive: { amount: minReceiveInt, asset_id: receiveAssetId },
            extensions: []
        }
    };
}
```

#### 5c. Add op 63 serializer

**`modules/bitshares-native/serial/operations.ts`**

BitShares op code 63 structure:

```
struct liquidity_pool_exchange {
    fee:            asset            (operation fee in BTS)
    account:        account_id       (1.2.x)
    pool:           liquidity_pool_id (1.19.x)
    amount_to_sell: asset            (amount + asset_id)
    min_to_receive: asset            (amount + asset_id)
    extensions:     extensions       (empty array)
}
```

Add entry to `st_operations[63]` in the `operation.st_operations` array. Need a `liquidity_pool_id` protocol type serializer — add it alongside the existing `asset_id`, `account_id` serializers if not already present for `1.19.x` objects.

#### 5d. Acquisition orchestrator

**New functions — `modules/dexbot_maintenance_runtime.ts`:**

```typescript
const _lastBtsAcquisitionTimestamps = new Map(); // botKey → timestamp

async function checkBtsBalanceAndAcquire() {
    if (this.config.dryRun) return;
    if (this.config.assetA === 'BTS' || this.config.assetB === 'BTS') return;

    // Cooldown check
    const cooldownMs = (TIMING.BTS_ACQUIRE_COOLDOWN_MIN || 60) * 60 * 1000;
    const lastAcq = _lastBtsAcquisitionTimestamps.get(this.config.botKey || this.config.name);
    if (lastAcq && (Date.now() - lastAcq) < cooldownMs) return;

    if (!this.manager.btsBalance) return;

    const minBtsVal = calculateMinBtsValue(
        this.config.assetA, this.config.assetB,
        this.config.activeOrders,
        this.config.min_BTS_value  // may be null
    );
    if (minBtsVal <= 0) return;

    const btsFree = this.manager.btsBalance.free || 0;
    const triggerAt = minBtsVal * FEE_PARAMETERS.BTS_ACQUIRE_THRESHOLD;
    if (btsFree >= triggerAt) return;

    // Deficit: acquire up to target
    const target = minBtsVal * FEE_PARAMETERS.BTS_ACQUIRE_TARGET_MULTIPLIER;
    const deficit = Math.max(0, target - btsFree);
    await acquireBts.call(this, deficit);
}

async function acquireBts(deficit) {
    const { BitShares } = require('../bitshares_client');
    const assets = [
        { id: this.assets?.assetA?.id, free: this.manager.accountTotals?.sellFree || 0, precision: this.assets?.assetA?.precision, symbol: this.config.assetA },
        { id: this.assets?.assetB?.id, free: this.manager.accountTotals?.buyFree || 0, precision: this.assets?.assetB?.precision, symbol: this.config.assetB }
    ];

    // Find available BTS pools, score by liquidity
    const candidates = [];
    for (const asset of assets) {
        if (!asset.id || asset.free <= 0) continue;
        const pool = await findBtsPoolForAsset(BitShares, asset.id);
        if (!pool) continue;

        const sellAmount = calculateSwapInAmount(deficit, pool.btsReserve, pool.assetReserve);
        if (sellAmount <= 0 || sellAmount > asset.free) continue;

        candidates.push({ asset, pool, sellAmount, priceImpact: sellAmount / pool.assetReserve });
    }

    if (candidates.length === 0) {
        this.log('CRITICAL: Cannot acquire BTS — no pool with sufficient liquidity for either asset', 'error');
        return;
    }

    // Pick best: lowest price impact
    candidates.sort((a, b) => a.priceImpact - b.priceImpact);
    const best = candidates[0];

    // Apply slippage tolerance to min_to_receive
    const minReceive = deficit * (1 - FEE_PARAMETERS.POOL_SLIPPAGE_TOLERANCE);
    const sellInt = floatToBlockchainInt(best.sellAmount, best.asset.precision);
    const minReceiveInt = floatToBlockchainInt(minReceive, BTS_PRECISION);

    const op = buildLiquidityPoolExchangeOp(
        this.accountId, best.pool.poolId,
        sellInt, best.asset.id,
        minReceiveInt, CHAIN.CORE_ASSET_ID
    );

    // Broadcast via credential daemon or direct key
    let result;
    if (this.credentialPolicy) {
        result = await this._broadcastWithCredentialPolicy([op]);
    } else if (this.privateKey) {
        result = await executeBatch([op], this.privateKey);
    } else {
        this.log('CRITICAL: No signing method for BTS acquisition', 'error');
        return;
    }

    if (result) {
        _lastBtsAcquisitionTimestamps.set(this.config.botKey || this.config.name, Date.now());

        // Optimistic balance update
        await this.manager.accountant.adjustTotalBalance(
            best.asset.id === this.assets?.assetA?.id ? ORDER_TYPES.SELL : ORDER_TYPES.BUY,
            -best.sellAmount,
            'bts-acquisition-swap-sell'
        );
        this.manager.btsBalance.free = (this.manager.btsBalance.free || 0) + deficit;
        this.manager.btsBalance.total = (this.manager.btsBalance.total || 0) + deficit;

        this.log(
            `Acquired ~${deficit} BTS: sold ${best.sellAmount} ${best.asset.symbol} ` +
            `via pool ${best.pool.poolId} (min_receive: ${minReceive} BTS, slippage: ${FEE_PARAMETERS.POOL_SLIPPAGE_TOLERANCE * 100}%)`,
            'info'
        );
    }
}
```

#### 5e. Integration into maintenance loop

**`modules/dexbot_maintenance_runtime.ts:1163`** — `executeMaintenanceLogic()`

Add at the top, after `recalculateFunds()`:

```typescript
await checkBtsBalanceAndAcquire.call(this);
```

Also in `setupBlockchainFetchInterval()` callback (~line 963), after the periodic balance fetch and grid checks.

#### 5f. Price/slippage math

**New helper — `modules/order/utils/math.ts`:**

```typescript
function calculateSwapInAmount(targetReceive, poolReserveOut, poolReserveIn) {
    if (targetReceive <= 0) return 0;
    // Safety cap: never swap more than 50% of pool to prevent extreme slippage
    if (targetReceive >= poolReserveOut * 0.5) {
        targetReceive = poolReserveOut * 0.5;
    }
    const k = poolReserveIn * poolReserveOut;
    const newReserveOut = poolReserveOut - targetReceive;
    if (newReserveOut <= 0) return 0;
    const newReserveIn = k / newReserveOut;
    return newReserveIn - poolReserveIn;
}
```

---

### Phase 6: Tests

**`tests/test_non_bts_fee_handling.ts`**

1. `calculateMinBtsValue()` returns > 0 for non-BTS, 0 for BTS pair
2. `calculateMinBtsValue()` respects explicit config override
3. `calculateAvailableFundsValue()` proportionally deducts BTS deficit from both sides
4. BTS balance fetched alongside assetA/assetB for non-BTS pairs
5. `calculateSwapInAmount()` math matches constant product formula
6. Pool discovery returns valid pool for known asset/BTS pairs
7. Acquisition threshold: fires only below `min_BTS_value × threshold`
8. Acquisition target: acquires `(target_multiplier × min_BTS_value) - current`
9. Cooldown: does not re-acquire before `BTS_ACQUIRE_COOLDOWN_MIN`
10. Dry-run: no-op
11. Both-assets pool test: picks lower price impact pool
12. No-pool case: critical warning, no crash
13. Regression: BTS-paired bots unchanged

---

## File Change Summary

| File | Phase | Change |
|---|---|---|
| `modules/constants.ts` | 1 | Add `MIN_BTS_VALUE` to `DEFAULT_CONFIG`, add `BTS_ACQUIRE_THRESHOLD`, `BTS_ACQUIRE_TARGET_MULTIPLIER`, `POOL_SLIPPAGE_TOLERANCE` to `FEE_PARAMETERS`, add `BTS_ACQUIRE_COOLDOWN_MIN` to `TIMING` |
| `modules/order/sync_engine.ts` | 2a | Extend `fetchAccountBalancesAndSetTotals()` — fetch BTS for non-BTS pairs |
| `modules/order/manager.ts` | 2b | Add `btsBalance` field |
| `modules/order/utils/system.ts` | 2c | Persist/restore `btsBalance` in snapshot |
| `modules/account_orders.ts` | 2c | Add `btsBalance` to save/load schema |
| `modules/order/utils/math.ts` | 3,4a,5f | Remove early return guard from `calculateOrderCreationFees()`, new `calculateSwapInAmount()`, non-BTS deduction in `calculateAvailableFundsValue()` |
| `modules/order/grid.ts` | 4b | Non-BTS proportional deduction in `_getSizingContext()` |
| `modules/order/utils/order.ts` | 4c | Non-BTS proportional deduction in `getSideBudget()` |
| `modules/chain_orders.ts` | 5b | New `buildLiquidityPoolExchangeOp()` |
| `modules/bitshares-native/serial/operations.ts` | 5c | Add op 63 `liquidity_pool_exchange` serializer |
| `modules/dexbot_maintenance_runtime.ts` | 5d+5e | New `checkBtsBalanceAndAcquire()`, `acquireBts()`, integrated into maintenance loop |
| `tests/test_non_bts_fee_handling.ts` | 6 | Full test suite |

---

## Edge Cases & Risks

| Risk | Mitigation |
|---|---|
| No BTS pool exists for either asset | Critical warning logged. Bot continues until BTS runs out, then TXs fail. User must fund BTS manually. |
| Pool liquidity too low for deficit | `calculateSwapInAmount()` caps at 50% pool depth. Acquires what it can, waits for next cycle. |
| Both assets have BTS pools | Picks lowest price impact (highest BTS reserve). |
| Swap fails (stale reserves) | BitShares validates at broadcast; exception caught and logged. Cooldown prevents immediate retry. |
| Cooldown prevents acquisition after partial fill | If the swap fills less-than-expected, optimistic balance update may overstate BTS. Next periodic fetch corrects it, and cooldown ensures we wait before retrying. |
| Credential daemon blocks pool exchange | `liquidity_pool_exchange` is already in `ALLOWED_OP_TYPES` (`credential_policy.ts:35`). Must ensure user's policy allows it. |
| Bot restarts mid-acquisition | Optimistic update lost on restart. Next periodic fetch sees real BTS balance and re-triggers if still below threshold. |
| Hysteresis band too wide (3×) | Configurable via `BTS_ACQUIRE_TARGET_MULTIPLIER` in `general.settings.json`. Can be lowered if BTS price is volatile. |
