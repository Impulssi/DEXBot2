# Trend Detection Service

## Scope

This is the shared DEXBot/Claw trend service. It is independent of margin-trading and should be used for any bot that needs candle-driven signal generation, parameter tuning, and bot-setting updates.

## Signal Flow

1. `market_adapter/market_adapter.ts` keeps candles current and emits the per-bot center/state snapshot.
2. `analysis/trend_detection/kalman_trend_analyzer.ts` turns candle input plus feed price into trend output.
3. The service monitors the signal output, premium/discount, and price-ratio context.
4. Claw applies supported setting changes through `bot-settings-preview` and `bot-settings-apply`.

## Inputs

- Candle history from the market adapter
- Feed price / settlement reference
- Trend analyzer parameters:
  - `erPeriod`
  - `fastPeriod`
  - `slowPeriod`
  - `thresholdPercent`
  - `minBarsForConfirmation`
  - `deadZonePercent`
- Bot settings fields that the signal may update:
  - `weightDistribution`
## Outputs

- `UP`, `DOWN`, or `NEUTRAL`
- Confidence score
- Premium / discount signal
- Oscillation / range context
- Proposed bot-setting patch for the next cycle

## Control Surfaces

- General settings: `profiles/general.settings.json` (auto-generated on first run; may not exist until then)
- Per-bot settings: `profiles/bots.json`
- Recalc triggers: `profiles/recalculate.<botKey>.trigger`
- Signal state: `market_adapter/state/market_adapter_state.json`
- Center snapshot: `market_adapter/state/market_adapter_centers.json`

## Operating Rule

Treat the trend signal as configuration input, not as trading logic. The shared service can tune bot settings and trigger recalculation, but it should not own order placement or margin-position policy.
