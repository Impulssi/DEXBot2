# MPA and Credit Usage

DEXBot2 supports native BitShares debt workflows through the bot-level `debtPolicy` config block. Each lending item declares its own collateral asset, and the runtime groups items by collateral to compute independent distributions. For the related AMA/grid side, see [Market Adapter](../market_adapter/README.md).

## Contents

- [Configuration Format](#configuration-format)
- [Collateral Distribution](#collateral-distribution)
- [Runtime Timing](#runtime-timing)
- [MPA Maintenance](#mpa-maintenance)
- [Credit Offer Maintenance](#credit-offer-maintenance)
- [LP-Backed Credit Collateral](#lp-backed-credit-collateral)
- [State Files](#state-files)
- [Operational Notes](#operational-notes)
- [Related Files](#related-files)

## Which section do I need?

| If you want to… | Read this | Key file / field |
|-----------------|-----------|-------------------|
| Configure a bot to borrow MPAs or credit offers | [Configuration Format](#configuration-format) | `debtPolicy.lending` in `bots.json` |
| Understand how collateral is split across lending items | [Collateral Distribution](#collateral-distribution) | `outputWeight` |
| Change how often the credit watchdog runs | [Runtime Timing](#runtime-timing) | `TIMING` in `constants.ts` |
| Know what happens when MPA CR drops below minimum | [MPA Maintenance](#mpa-maintenance) | `minCollateralRatio` |
| Know how credit deals are renewed and repaid | [Credit Offer Maintenance](#credit-offer-maintenance) | `autoReborrow` / `autoRepay` |
| Use LP shares as credit-offer collateral | [LP-Backed Credit Collateral](#lp-backed-credit-collateral) | automatic valuation |
| Diagnose pending reborrow or renewal issues | [State Files](#state-files) | `profiles/credit_runtime/<botKey>.json` |
| Safe operating practices | [Operational Notes](#operational-notes) | — |

## Configuration Format

Add `debtPolicy` to a bot entry in `profiles/bots.json`:

```json
{
  "name": "credit-bot-1",
  "preferredAccount": "my-account",
  "assetA": "BTS",
  "assetB": "HONEST.USD",
  "active": true,
  "debtPolicy": {
    "maxCollateralAmount": "80%",
    "lending": [
      {
        "asset": "HONEST.USD",
        "collateralAsset": "BTS",
        "type": "mpa",
        "outputWeight": 1,
        "maxBorrowAmount": 1000,
        "maxCollateralAmount": 5000,
        "minCollateralRatio": 2.0,
        "maxCollateralRatio": 2.5,
        "targetCollateralRatio": 2.2
      },
      {
        "asset": "HONEST.CNY",
        "collateralAsset": "BTS",
        "type": "creditOffer",
        "outputWeight": 1,
        "maxBorrowAmount": 1000,
        "maxCollateralRatio": 2.5,
        "maxFeeRatePerDay": 0.05,
        "autoReborrow": true,
        "autoRepay": 2
      }
    ]
  }
}
```

### Field Reference

<details><summary>All config fields (click to expand)</summary>

**Required Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `lending` | `array` | Non-empty array of lending items. Each item maps a debt asset to a debt type and collateral asset. |

**Lending Item Fields** (every item must have):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `asset` | `string` | Yes | Debt asset symbol or ID (e.g. `"HONEST.USD"`). |
| `collateralAsset` | `string` | Yes | Collateral asset (e.g. `"BTS"`). Multiple items may share the same collateral asset. |
| `type` | `string` | Yes | `"mpa"` (BitShares MPA call order) or `"creditOffer"` (credit offer deal). |

**Shared Optional Fields** (both `"mpa"` and `"creditOffer"`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `outputWeight` | `number` | No | Output weight for this asset. Controls the proportion of debt value across lending items (not collateral). Defaults to `1`. See **Collateral Distribution** below. |
| `maxBorrowAmount` | `number` | No | **Fixed** total debt ceiling. Must be a positive number (not a percentage). |
| `maxCollateralAmount` | `number \| percentage string` | No | Total collateral ceiling. Use a number for an absolute collateral amount, e.g. `5000`, or a percentage string of total available collateral, e.g. `"80%"`. |
| `minCollateralIncreaseThreshold` | `number \| percentage string` | No | Minimum unused collateral allocation before increasing debt. Use a number for an absolute collateral amount, e.g. `25`, or a percentage string of assigned collateral budget, e.g. `"5%"`. `0` means no minimum. |
| `maxCollateralRatio` | `number` | No\* | Behavior differs by type: MPA — hard CR ceiling above which debt is increased first; creditOffer — maximum effective ratio when accepting offers. **Required** for `creditOffer`. |

**MPA-Specific Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `targetCollateralRatio` | `number` | No | Preferred operating CR. If omitted, midpoint of min/max is used. |
| `minCollateralRatio` | `number` | No | Hard minimum CR floor. Below this, debt is reduced first. |
| `debtOnly` | `boolean` | No | If `true`, the bot only adjusts debt to manage the collateral ratio — collateral is never added or withdrawn. Combined with `minCollateralRatio`/`maxCollateralRatio`, this keeps the position size constant while maintaining CR bounds. |

**Credit-Offer-Specific Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `maxFeeRatePerDay` | `number` | No | Maximum acceptable daily fee rate. Defaults to `1/3000` (~0.033%/day). |
| `autoReborrow` | `boolean` | No | If `true`, the bot reborrows from the same offer after repayment. |
| `autoRepay` | `number` | No | On-chain auto-repay mode: `0` (off), `1` (full only), `2` (partial allowed). |
| `allowedOfferIds` | `string[]` | No | Whitelist of credit offer object IDs (1.21.x) the bot may accept. |
| `disallowedDealIds` | `string[]` | No | Denylist of credit deal object IDs (1.22.x) the bot must not reborrow from. Repay is unaffected — the bot can still repay deals in this list. |
| `renewOnly` | `boolean` | No | If `true`, the bot only reborrows existing deals — standalone credit borrows are refused. Default `false`. |
| `minDurationSeconds` | `number` | No | Minimum acceptable offer duration in seconds. Offers with `duration_seconds` below this value are skipped. |

**Global Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `maxCollateralAmount` | `number \| percentage string` | **Global** collateral cap across all lending items. Use a number for an absolute collateral amount, e.g. `10000`, or a percentage string of total available collateral, e.g. `"80%"`. |

</details>

There is no separate enable switch. If `debtPolicy.lending` is present, non-empty, and every item has a valid `collateralAsset`, the credit runtime loads for that bot.

### Collateral Increase Thresholds

`minCollateralIncreaseThreshold` is evaluated in collateral-asset units against the unused assigned collateral for that lending item:

- `25` means at least 25 units of the collateral asset, such as `25 BTS`.
- `"5%"` means at least 5% of that item’s assigned collateral budget.
- `0` means no minimum; any positive unused assigned collateral may trigger an increase.
- Omitted on credit-offer items leaves proactive credit increases disabled for backward compatibility.

## Collateral Distribution

The runtime calculates required collateral for each lending item **backwards from the desired debt output ratio**. The `outputWeight` field controls the proportion of debt value (not collateral) each item receives.

### Formulas

```
MPA weight_i    = outputWeight_i * feedPrice_i * targetCR_i
Credit weight_i = (outputWeight_i * maxCR_i) / conversionRate_i
C_total         = min(availableCollateral, globalMaxCollateral)
C_i             = C_total * weight_i / sum(all weights)
```

- **MPA**: `feedPrice_i` is the current settlement feed price (collateral per debt asset), discovered from the chain and cached per position.
- **Credit**: `conversionRate_i` is the offer's `acceptable_collateral` price (debt asset per collateral unit), discovered from existing deals or `allowedOfferIds`.
- **Fallback**: If the price cannot be discovered, `weight = outputWeight * targetCR` and a warning is logged.
- `outputWeight` is the user's output proportion. Equal weights produce **equal economic debt value** across all lending items, regardless of price or CR differences.

### Examples

**Two assets, equal weight** — collateral split 50:50.

**Two assets, 80% output on USD** — USD receives a proportionally smaller share of the configured collateral pool, CNY receives the remaining larger share.

**Three assets, equal weight** — collateral split 1/3 : 1/3 : 1/3.

## Runtime Timing

Credit and MPA maintenance are separated from periodic grid checks. DEXBot2 starts a dedicated credit watchdog interval during bot startup.

Timing defaults live in `modules/constants.ts`:

```json
{
  "TIMING": {
    "CREDIT_DEAL_CHECK_INTERVAL_MIN": 60,
    "CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS": 12
  }
}
```

- `CREDIT_DEAL_CHECK_INTERVAL_MIN`: how often the credit watchdog runs. Set to `0` or negative to disable.
- `CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS`: how far before `latest_repay_time` the bot proactively repays and reborrows.

## MPA Maintenance

For each `type: "mpa"` lending item:

- If CR is below `minCollateralRatio`, **reduce debt first**, then add collateral if needed.
- If CR is above `maxCollateralRatio`, **increase debt first**, then withdraw collateral if allowed.
- Debt increases are calculated from the current feed price and current call-order collateral, capped by the total outstanding debt ceiling in `maxBorrowAmount`.
- `minCollateralIncreaseThreshold` suppresses dust-sized increases when unused assigned collateral is below the configured absolute or percentage threshold.
- If the debt-first leg fails (e.g. insufficient free MPA to repay), the runtime attempts a collateral-only fallback.
- If `targetCollateralRatio` is not set, the midpoint of the min/max band is used.
- After any successful CR adjustment, the bot requests a grid reset so order sizing reflects the new capital base.
- `maxBorrowAmount` only prevents additional debt above the configured total; it does not block debt reduction. Must be a **fixed positive number** (no percentages).

## Credit Offer Maintenance

For each `type: "creditOffer"` lending item, the runtime:

- Discovers active credit deals on-chain.
- Validates deals against the per-item policy (`maxCollateralRatio`, `maxFeeRatePerDay`, `allowedOfferIds`, `disallowedDealIds`, etc.).
- Gates increases on unused assigned collateral. If the collateral shortfall is at least `minCollateralIncreaseThreshold`, it accepts an additional credit deal from the cheapest acceptable offer; the selected offer's price derives the borrow amount, capped by `maxBorrowAmount`. A borrow-cap-capped increase is skipped if the actual collateral used would fall below `minCollateralIncreaseThreshold`.
- Proactively repays deals nearing expiration (within `CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS`) and reborrows when `autoReborrow` is enabled.
- Ensures `auto_repay` on-chain matches the policy's `autoRepay` setting, updating local state after each successful broadcast.

### Amount Cap Semantics

| Policy | Field | Scope |
|--------|-------|-------|
| MPA | `maxBorrowAmount` | **Total debt ceiling** — call order debt cannot exceed this. |
| MPA | `maxCollateralAmount` | **Total collateral ceiling** — call order collateral cannot exceed this. Withdrawals still allowed. |
| Credit | `maxBorrowAmount` | **Total debt ceiling** — total credit debt for the asset cannot exceed this. |
| Credit | `maxCollateralAmount` | **Total collateral ceiling** — total credit collateral for the asset cannot exceed this. |

`maxBorrowAmount` is always a **fixed number** (no percentages). `maxCollateralAmount` may be a fixed number or a percentage.

### Credit Deal Renewal

When `renewOnly` is `true`, the bot refuses standalone credit borrows and only renews existing deals via repay+reborrow. This is useful when you want the bot to maintain existing positions but not open new ones.

When a deal's `latest_repay_time` is within `CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS`:

1. Repay the deal.
2. Reborrow from the same offer when `autoReborrow` is enabled, using the full `assignedCollateralBudget`.
3. Preserve configured `autoRepay` on the new credit-offer accept operation.

If inline reborrow cannot be built safely, the runtime stores a deferred reborrow request in `profiles/credit_runtime/<botKey>.json` and retries later.

### Collateral Switching on Renewal

You can switch a credit deal's collateral to a different asset on its next renewal by changing `lendingItem.collateralAsset` to the new asset in `bots.json`. The runtime detects existing deals whose collateral no longer matches the policy and migrates them during proactive expiry repay+reborrow. Requirements:

- The new asset must be listed in the credit offer's `acceptable_collateral`. The runtime rejects mismatched collateral with a specific error message.
- The bot must hold enough of the new collateral asset before the deal is repaid. The offer's minimum required collateral is computed from the borrow amount and the new collateral price — the old deal's collateral amount is not carried forward.
- Only applies to `type: "creditOffer"` items — MPA collateral is fixed by the call order asset.
- Deferred reborrow requests from before the switch may fail; drop stale pending reborrows by clearing `profiles/credit_runtime/<botKey>.json` or letting them expire naturally.
- If the switch produces no active reborrow (e.g., insufficient balance for the new collateral), the deal is repaid and the reborrow is deferred to the pending queue for later retry.

### auto_repay Enforcement

On each maintenance cycle, the runtime compares each deal's on-chain `auto_repay` against the policy's `autoRepay` value. If they differ, a `credit_deal_update` operation is broadcast. After a successful update, the local deal state is updated to prevent redundant broadcasts on the next cycle.

<details><summary>BitShares auto-repay modes (click to expand)</summary>

BitShares core 7.0.2 defines three auto-repay modes:

| Value | Mode | Behavior at `latest_repay_time` |
|-------|------|--------------------------------|
| `0` | `no_auto_repayment` | No auto-repay. Deal expires; collateral is liquidated to the offer owner. |
| `1` | `only_full_repayment` | Full repay if borrower balance >= debt + fee; otherwise deal expires. |
| `2` | `allow_partial_repayment` | Repay as much as possible with available balance; any remaining debt triggers expiry with proportional collateral liquidation. |

</details>

### Important Distinction

- `autoReborrow` is **DEXBot2 behavior** — the bot re-accepts the same offer after a repay.
- `autoRepay` is **BitShares chain behavior** — the chain attempts automatic repayment at deal expiry.

## LP-Backed Credit Collateral

Credit offers may accept liquidity-pool share assets as collateral. Before accepting an offer, DEXBot2:

1. Resolves the LP pool for the share asset.
2. Reads pool balances and share supply.
3. Computes the collateral value from the underlying reserves.
4. Converts that value into the debt asset denomination.
5. Rejects the borrow if the effective ratio exceeds the lending item's `maxCollateralRatio`.

If pool lookup, supply lookup, or valuation cannot be resolved, the runtime fails closed and does not sign the borrow.

## State Files

The runtime persists one state file per bot:

```text
profiles/credit_runtime/<botKey>.json
```

The file tracks discovered chain state and pending work, including:

- `positions` — per-position state map keyed as `debtAssetId:collateralAssetId`
- Active MPA call-order state and credit deal IDs per position
- `assignedCollateralBudget` per position
- Pending reborrow requests
- Last repay timestamp and grid reset request
- Debt snapshot across all assets

Treat this file as runtime state, not primary configuration. The source of truth for enabled policy is `profiles/bots.json`.

## Operational Notes

- Keep `debtPolicy` narrow. Only list assets and offers the bot is allowed to use.
- Use conservative CR bands. `minCollateralRatio` is a hard safety floor, not a target.
- Keep `maxFeeRatePerDay` explicit for credit offers.
- Credit-offer collateral ratio and MPA call-order CR are validated in separate paths.
- After editing `profiles/bots.json`, restart the bot so the runtime picks up the new policy.
- Review `profiles/credit_runtime/<botKey>.json` when diagnosing pending reborrow or renewal behavior.

## Related Files

<details><summary>Source files and tests (click to expand)</summary>

- `modules/credit_runtime.ts`: debt workflow executor
- `modules/dexbot_class.ts`: runtime startup and watchdog lifecycle
- `modules/bot_settings.ts`: `debtPolicy` validation
- `market_adapter/README.md`: AMA pricing, grid triggers, and dynamic-weight runtime
- `modules/credential_policy.ts`: signing constraints for credit and call-order operations
- `tests/test_credit_runtime.ts`: credit runtime behavior coverage
- `tests/test_multi_asset_distribution.ts`: collateral distribution and multi-asset state coverage

</details>
