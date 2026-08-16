# Trend Detection

This folder contains the chart generators, derivative signal layer, and re-export shims used by the analysis runners. The canonical AMA, Kalman, Hurst, and Permutation Entropy implementations live in `market_adapter/core/` (see below); the legacy SMA/MACD/RSI derivative signal layer is in `derivative_analyzer.ts`.

## Docs

- [DYNAMIC_WEIGHT_RESEARCH.md](DYNAMIC_WEIGHT_RESEARCH.md) - dynamic weight research notes for the Kalman/Hurst/PE blend
- [SIGNAL_DOCUMENTATION.md](SIGNAL_DOCUMENTATION.md) - derivative signal layer documentation

## Live Counterpart

- [Market Adapter](../../market_adapter/README.md) - live AMA pricing, dynamic weights, and recalc triggers

## Modules

- `derivative_analyzer.ts`
- `dynamic_weight_chart_generator.ts`
- `kalman_chart_generator.ts`
- `regime_chart_generator.ts`
- `volatility_chart_generator.ts`

The Kalman/Hurst/PE analyzers below are re-export shims; the implementations live in `market_adapter/core/signals/` and are shared with the live market adapter:

- `hurst_analyzer.ts` → `market_adapter/core/signals/hurst_analyzer.ts`
- `kalman_trend_analyzer.ts` → `market_adapter/core/signals/kalman_trend_analyzer.ts`
- `kalman_velocity_smoothing.ts` → `market_adapter/core/signals/kalman_velocity_smoothing.ts`
- `permutation_entropy_analyzer.ts` → `market_adapter/core/signals/permutation_entropy_analyzer.ts`
