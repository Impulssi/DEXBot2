# Trend Detection Service

## Scope

This is the shared DEXBot/Claw trend service. It is independent of margin-trading and should be used for any bot that needs signal generation, parameter tuning, and bot-setting updates.

## Signal Flow

1. `claw/modules/feed_price_source.ts` fetches the **order-book mid price** (`get_order_book`) and the **feed price** for a market, computing the premium/discount.
2. `claw/modules/decision_loop.ts` feeds those prices into `KalmanTrendAnalyzer` (per market) and uses the resulting trend for position health assessment.
3. `market_adapter/core/signals/kalman_trend_analyzer.ts` is the canonical analyzer implementation; `analysis/trend_detection/kalman_trend_analyzer.ts` re-exports it so production, analysis tooling, and tests resolve one shared module.
4. Claw applies supported setting changes through `bot-settings-preview` and `bot-settings-apply`.

Note: the analyzer input is the live order-book mid price plus the feed price — **not** candles.

## Inputs

- Order-book mid price from `fetchMidPrice('BTS', mpaSymbol)`
- Feed price / settlement reference (`fetchFeedPrice`)
- Trend analyzer configuration (`KalmanTrendConfig`):
  - `rNoise` — measurement noise (default `0.05`)
  - `qTactical` — tactical filter process noise (default `qNoise` or `0.01`)
  - `qModal` — modal filter process noise (default `qNoise` or `0.0001`)
  - `qNoise` — shared process-noise fallback for both filters
  - `beamCount` — max projected trajectory beams (default `100`)
  - `dt` — time step per update (default `1`)
  - `warmupBars` — warmup updates before `isReady` (default `20`)
- Bot settings fields that the signal may update:
  - `weightDistribution`

## Outputs

- `trend`: `UP`, `DOWN`, or `FLAT` (from tactical velocity sign)
- `signal`: `BULLISH_DISPLACEMENT`, `BEARISH_DISPLACEMENT`, `EQUILIBRIUM`, or `NEUTRAL`
- `confidence`: 0–100 (warmup progress + velocity magnitude)
- `velocityPct` / `velocityFilteredPct` — raw and smoothed velocity
- `displacementPct` — price offset from the modal (long-term) estimate
- Premium / discount signal
- Oscillation / range context (beams + projections)
- Proposed bot-setting patch for the next cycle

## Control Surfaces

- General settings: `profiles/general.settings.json` (auto-generated on first run; may not exist until then)
- Per-bot settings: `profiles/bots.json`
- Recalc triggers: `profiles/recalculate.<botKey>.trigger`
- Signal state: `market_adapter/state/market_adapter_state.json`
- Center snapshot: `market_adapter/state/market_adapter_centers.json`

## Operating Rule

Treat the trend signal as configuration input, not as trading logic. The shared service can tune bot settings and trigger recalculation, but it should not own order placement or margin-position policy.