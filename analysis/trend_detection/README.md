# Trend Detection

This folder contains the chart generators and re-export shims used by the analysis runners. The canonical AMA, Kalman, Hurst, and Permutation Entropy implementations live in `market_adapter/core/` (see below).

## Docs

- [DYNAMIC_WEIGHT_RESEARCH.md](DYNAMIC_WEIGHT_RESEARCH.md) - dynamic weight research notes for the Kalman/Hurst/PE blend

## Live Counterpart

- [Market Adapter](../../market_adapter/README.md) - live AMA pricing, dynamic weights, and recalc triggers

## Modules

- `dynamic_weight_chart_generator.ts`
- `kalman_chart_generator.ts`
- `regime_chart_generator.ts`
- `volatility_chart_generator.ts`

## Backtests

- `backtest_ama_slope_huber.ts` — sweeps the Huber slope lookback window
  (`--lookback`, default 8..28 bars; the live default is
  `DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS` = 16) over an LP candle
  shard directory and reports **lag** (cross-correlation group delay vs centred
  price/AMA slope, plus reversal-confirmation delay), **resets** (the canonical
  `simulateGridResetSeries` drift + slope-delta decision path: counts, reason
  split, rate, gap distribution, whipsaws) and **noise** (slope std, bar-to-bar
  wobble, second-difference energy, zero-crossing rate, saturation, range tilt).

  ```bash
  npm run build
  node dist/analysis/trend_detection/backtest_ama_slope_huber.js \
    --data market_adapter/data/lp/<market-pair> --lookback 8:28:2
  ```

  Run `--help` for the full option list (AMA preset/overrides, reset thresholds,
  confirmation gate, whipsaw definition, JSON output path).

  `revLag` is measured against a centred reference whose half-window is
  `--truth-window` (default = max lookback), so compare it across runs only at a
  fixed truth window; `amaLag` (cross-correlation group delay) is reference-robust.

The Kalman/Hurst/PE analyzers below are re-export shims; the implementations live in `market_adapter/core/signals/` and are shared with the live market adapter:

- `hurst_analyzer.ts` → `market_adapter/core/signals/hurst_analyzer.ts`
- `kalman_trend_analyzer.ts` → `market_adapter/core/signals/kalman_trend_analyzer.ts`
- `kalman_velocity_smoothing.ts` → `market_adapter/core/signals/kalman_velocity_smoothing.ts`
- `permutation_entropy_analyzer.ts` → `market_adapter/core/signals/permutation_entropy_analyzer.ts`
