# Position Health And Decision Loop

This document covers the position health subsystem: on-chain position discovery, collateral ratio assessment, trend alignment, and the decision loop that ties them together.

## Overview

The subsystem has three layers:

1. **Discovery** (`modules/position_discovery.ts`) — scans an account's on-chain call orders and normalizes them into position objects.
2. **Health assessment** (`modules/position_health.ts`) — classifies each position into a collateral ratio zone, checks trend alignment, and recommends actions.
3. **Decision loop** (`modules/decision_loop.ts`) — orchestrates discovery, trend analysis, and health assessment into a single evaluation cycle.

The subsystem evaluates and recommends. It does not execute trades.

## Position Discovery

`discoverPositions(accountName)` scans the account's call orders on-chain and returns normalized position objects. It does not depend on PositionManager state files — it sees what actually exists on-chain.

Each discovered position includes:

- call order ID, borrower, market pair
- debt amount and collateral amount (float-converted)
- BTS-per-MPA derived from the settlement feed
- computed collateral ratio
- feed publication time

`discoverPositionsSummary(accountName)` returns a compact summary with rounded values for quick inspection.

## 3-Zone CR Model

The health assessor classifies collateral ratios into three zones using the thresholds from `CR_ZONES` in the repo-root `modules/constants.ts`:

| Zone | CR range | Status | Meaning |
|---|---|---|---|
| `red_low` | below `CR_ZONES.RED_LOW` (1.7) | `not_acceptable` | Near liquidation, immediate action needed |
| `green` | `CR_ZONES.RED_LOW` (1.7) ≤ CR < `CR_ZONES.RED_HIGH` (3.0) | `safe` | Healthy operating range |
| `red_high` | above `CR_ZONES.RED_HIGH` (3.0) | `over_collateralized` | Capital sitting idle, consider deploying |

## Dual-Layer Actions

When a position needs adjustment, the assessor recommends actions in two layers:

- **Layer 1 (primary)**: adjust debt first — reduce debt when CR is low, increase debt when CR is high.
- **Layer 2 (fallback)**: adjust collateral if debt changes are insufficient — add collateral when CR is low, withdraw collateral when CR is high.

This mirrors the actual strategy levers: debt adjustments are the primary tool, collateral adjustments are the backup.

Action priorities:

| Zone | Priority | Layer 1 | Layer 2 |
|---|---|---|---|
| `red_low` | `immediate` | `reduce_debt` | `add_collateral` |
| `green` | — | no action | no action |
| `red_high` | `immediate` | `increase_debt` | `withdraw_collateral` |

## Trend Alignment

When a trend signal is available, the assessor checks whether the position direction is aligned with the trend:

- A short position aligned with a `DOWN` trend is `aligned`.
- A short position opposed to an `UP` trend with confidence >= 50% triggers a `review_direction` action.
- Neutral trends produce no directional action.

## CR Adjustment Planning

CR math is handled by the shared planner at `modules/cr_planner.ts` (root level, not claw), which provides `debtDeltaForTargetCr()` and `collateralDeltaForTargetCr()`. Claw's position health module consumes these through the planner interface. Any executed CR adjustment should be followed by a grid rebuild, because the available-funds baseline is no longer valid after the debt or collateral leg changes.

## Decision Loop Planning

The decision loop in `modules/decision_loop.ts` combines all signals into a unified assessment:

- CR adjustment intent (debt first, collateral second)
- price range ratio recommendation based on historical price action
- the CR plan should be treated as structural, not tactical, so execution code must rebuild the grid after it applies

## Decision Loop

`evaluate(accountName, options)` runs one full cycle:

1. Discover all on-chain positions for the account.
2. Fetch trend input per market (feed price + market price).
3. Update a per-market trend analyzer (Kalman filter-based, state persists across calls).
4. Assess each position's health with the trend signal.
5. Sort assessments by action priority (immediate first).
6. Return assessments with a summary of zone distribution and action counts.

The summary includes:

- zone counts (`red_low`, `green`, `red_high`)
- immediate action count
- `allGreen` flag for quick health checks

## Position Manager Watch

`modules/position_manager_watch.ts` is a PM2-compatible watcher process that keeps `PositionManager` state synchronized and reacts to fills. It does not invoke `decision_loop.evaluate()` itself.

```bash
npm run service:position-watch -- --account your-account
```

## Related Modules

- `modules/feed_price_source.ts` — fetches on-chain settlement feed prices and order book mid-prices for trend input.
- `modules/kibana_price_source.ts` — alternative price source using Kibana for historical candle data (order book fills and LP pool swaps).
- `modules/position_manager.ts` — persistent short-position tracking (create, update, close, export). Separate from on-chain discovery.

## Source Of Truth

The executable behavior lives in the modules. This document should be kept aligned with:

- `../../modules/cr_planner.ts` (root level)
- `modules/position_health.ts`
- `modules/position_discovery.ts`
- `modules/decision_loop.ts`
- `modules/feed_price_source.ts`
- `modules/position_manager_watch.ts`
- `claw/tests/test_position_health.ts`
