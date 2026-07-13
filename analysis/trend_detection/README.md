# Trend Detection

This folder contains the AMA, Kalman, Hurst, Permutation Entropy, and regime analysis code used by the analysis runners. The legacy SMA/MACD/RSI derivative signal layer is in `derivative_analyzer.ts`.

## Docs

- [DYNAMIC_WEIGHT_RESEARCH.md](DYNAMIC_WEIGHT_RESEARCH.md) - dynamic weight research notes for the Kalman/Hurst/PE blend
- [SIGNAL_DOCUMENTATION.md](SIGNAL_DOCUMENTATION.md) - derivative signal layer documentation

## Live Counterpart

- [Market Adapter](../../market_adapter/README.md) - live AMA pricing, dynamic weights, and recalc triggers

## Modules

- `derivative_analyzer.ts`
- `dynamic_weight_chart_generator.ts`
- `hurst_analyzer.ts`
- `kalman_chart_generator.ts`
- `kalman_trend_analyzer.ts`
- `kalman_velocity_smoothing.ts`
- `permutation_entropy_analyzer.ts`
- `regime_chart_generator.ts`
- `volatility_chart_generator.ts`
