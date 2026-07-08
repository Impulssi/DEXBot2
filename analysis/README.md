# Analysis

This directory contains research runners, chart generators, and helper modules used to inspect market behavior and tune analysis parameters. All output is interactive HTML charts — not used in production.

All runners write self-contained HTML to `charts/`. These files are regenerated on each run and are not committed.

## Quick Start

Most runners default to the market adapter source — just pass a bot key from `profiles/bots.json`:

```bash
# Dynamic weight research (AMA + Kalman + Hurst)
tsx analysis/analyze_dynamic_weight.ts --bot-key <bot-key>

# TradingView-style chart
npm run analysis:tradingview -- --source market_adapter --bot-key <bot-key>
```

> The market adapter source reads from `market_adapter/state/market_adapter_centers.json` — make sure the bot has been running and produced state data first.

## Main Entry Points

The order below follows the live market adapter path:

1. Candle data/state feeds the adapter.
2. AMA computes the grid center and divergence risk.
3. AMA slope and Kalman drive asymmetric dynamic weights and range/offset signals.
4. ATR volatility applies the symmetric weight penalty.
5. Hurst and Permutation Entropy gate trend signals by regime.
6. Chart tools inspect the combined output.

### Dynamic Weight Research (`analyze_dynamic_weight.ts`)

Interactive 4-panel chart for the production trend-weight path: AMA slope plus Kalman confirmation, gated by Hurst Exponent and Permutation Entropy. Use this first when tuning asymmetric buy/sell weight bias, AMA slope offset behavior, and regime damping.

```bash
# Bot-key (uses market adapter source)
tsx analysis/analyze_dynamic_weight.ts --bot-key <bot-key>

# From LP candle file with custom parameters
tsx analysis/analyze_dynamic_weight.ts \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --alpha 0.6 --gain 0.25 --clip 20
```

Full research docs: [DYNAMIC_WEIGHT_RESEARCH.md](trend_detection/DYNAMIC_WEIGHT_RESEARCH.md)

Legacy asymmetric-weight reference: [Derivative signal documentation](trend_detection/SIGNAL_DOCUMENTATION.md).

#### Supporting Dynamic Weight Analyzers

These isolate the sub-signals used by the dynamic-weight path. Use them when the combined chart needs a narrower diagnosis:

| Analyzer | Focus | Use when |
|----------|-------|----------|
| `analyze_volatility.ts` | ATR-based symmetric volatility penalty | Buy and sell weights are both being reduced too much or too little |
| `analyze_regime.ts` | Hurst + Permutation Entropy regime classification | Trend signals need more or less regime damping |
| `analyze_regime_windows.ts` | Alternate Hurst/PE window configurations | Testing whether the regime gate is too slow or too noisy |
| `analyze_kalman.ts` | Kalman velocity/displacement trend state | Isolating the Kalman side of the AMA/Kalman blend |

```bash
# Volatility: ATR-based symmetric penalty
tsx analysis/analyze_volatility.ts --bot-key <bot-key>

# Regime gate: Hurst + Permutation Entropy
tsx analysis/analyze_regime.ts --bot-key <bot-key>
tsx analysis/analyze_regime_windows.ts --bot-key <bot-key>

# Kalman side of the trend blend
tsx analysis/analyze_kalman.ts --bot-key <bot-key>

# All also accept explicit LP candle files
tsx analysis/analyze_volatility.ts \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

### Risk Profile Analyzer (`analyze_risk_profile.ts`)

Measures inventory risk by calculating empirical divergence quantiles (based on price-to-AMA deviation). Use this to calibrate 'Safe Range' clamping tiers for your liquidity strategy.

```bash
tsx analysis/analyze_risk_profile.ts \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_1h.json \
  --ama AMA3 \
  --output analysis/charts/risk_report.html
```

Metrics include:
- **Max Divergence:** Structural risk limit of the AMA preset.
- **Quantiles (99.9%, 99.99%, 99.999%):** Safe Range bounds for clamping tiers.
- **σ_ama_delta:** Std dev of per-bar AMA movement — use this to calibrate `AMA_DELTA_THRESHOLD_PERCENT`.

### Trade Heatmap (`analyze_trade_heatmap.ts`)

Generates a 2D heatmap + summed histogram showing where trade volume concentrates relative to AMA deviation. Time-slice rows show how the distribution evolved; the bottom histogram shows the aggregate bell-curve shape with threshold annotations.

```bash
tsx analysis/analyze_trade_heatmap.ts \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --ama AMA3 \
  --output analysis/charts/trade_heatmap.html \
  --bin-size 5 \
  --max-neg 50 \
  --max-pos 60 \
  --slice-months 6
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--data` | — | Path to LP candle JSON (required) |
| `--ama` | `AMA3` | AMA preset (AMA1–AMA4) |
| `--output` | `analysis/charts/trade_heatmap.html` | Output path |
| `--bin-size` | `5` | Percentage points per bin |
| `--max-neg` | `bin-size × 10` | Max negative deviation % |
| `--max-pos` | `bin-size × 10` | Max positive deviation % |
| `--buckets` | — | Total bins (symmetric, overrides `--max-neg/--max-pos`) |
| `--warmup` | AMA erPeriod | Bars to skip for AMA warmup |
| `--slice-months` | `12` | Months per time-slice row |
| `--thresholds` | `1,2,3,5,10,20` | Deviation % thresholds for volume concentration table |
| `--verbose` | off | Print processing info |

### TradingView Chart (`analyze_tradingview.ts`)

Generates a standalone TradingView-style HTML chart with candle OHLC, SMA, AMA, VWMA, and volume panel. See [tradingview/README.md](tradingview/README.md) for full documentation.

```bash
# Bot-key (auto-resolves candle file and AMA settings)
npm run analysis:tradingview -- --source market_adapter --bot-key <bot-key>

# From an explicit candle file
tsx analysis/tradingview/analyze_tradingview.ts \
  --file market_adapter/data/market_adapter_<bot-key>_1h.json \
  --chart analysis/charts/<pair>_tradingview.html
```

## Data Prerequisites

Most runners expect candle data. Two paths to get it:

**Market adapter source** (default for most runners) — reads from `market_adapter/state/market_adapter_centers.json`. No setup needed; just run the bot first to populate state.

**LP candle files** — for deeper analysis with full OHLC data:

```bash
# Via the market adapter LP exporter (recommended for blockchain-backed candles)
tsx market_adapter/inputs/fetch_lp_data.ts --pool 133 --precA 4 --precB 5 --interval 1h --lookback 26280h

# Via the analysis fetcher (uses Kibana source directly)
tsx analysis/ama_fitting/fetch_lp_candles.ts --pool 1.19.133 \
  --assetA <ASSET_A> --assetAId <asset_a_id> --assetAPrecision <n> \
  --assetB <ASSET_B>     --assetBId <asset_b_id>    --assetBPrecision <n>
```

See [ama_fitting/README.md](ama_fitting/README.md) for full fetch options and data format.

## Subarea Details

### `trend_detection/`

Shared analyzers and chart renderers for regime work. Contains the core signal engines behind the runner scripts above.

**Research docs:**
- [DYNAMIC_WEIGHT_RESEARCH.md](trend_detection/DYNAMIC_WEIGHT_RESEARCH.md) — AMA+Kalman blend with Hurst/PE regime gating, formula reference, knob guide

**Modules:**

| Module | Purpose |
|--------|---------|
| `dynamic_weight_chart_generator.ts` | 4-panel uPlot chart with interactive knobs for dynamic weight tuning |
| `kalman_trend_analyzer.ts` | Kalman filter with tactical (velocity) and modal (displacement) states |
| `kalman_velocity_smoothing.ts` | Adaptive EMA smoothing for Kalman velocity (kf/kfd/kdt/kfs knobs) |
| `kalman_chart_generator.ts` | Kalman signal chart generator |
| `hurst_analyzer.ts` | Hurst Exponent via R/S analysis (rolling 256-bar window) |
| `permutation_entropy_analyzer.ts` | Permutation Entropy via ordinal pattern counting (m=5, window=54) |
| `volatility_chart_generator.ts` | ATR volatility / symmetric shift chart generator |
| `regime_chart_generator.ts` | Regime classification chart generator |

**Tests:** `analysis/trend_detection/tests/test_kalman_trend.ts`, `analysis/trend_detection/tests/test_kalman_velocity_smoothing.ts`

```bash
tsx analysis/trend_detection/tests/test_kalman_trend.ts
tsx analysis/trend_detection/tests/test_kalman_velocity_smoothing.ts
```

**Note:** `trend_detection/` has no external dependencies — runs directly with `tsx`.

### `ama_fitting/`

AMA parameter optimization and comparison tools.

| Script | Purpose |
|--------|---------|
| `market_adapter/core/strategies/ama.ts` | Kaufman Adaptive Moving Average implementation |
| `optimizer_high_resolution.ts` | AMA parameter optimizer (erPeriod, fast/slow bounds) |
| `generate_unified_comparison_chart.ts` | AMA comparison chart across multiple parameter sets |
| `analyze_ama_price_changes.ts` | AMA price-change analysis |
| `fetch_lp_candles.ts` | LP candle data fetcher |
| `calibrate_convergence_er.ts` | Calibrate AMA_CONVERGENCE_ER_AVG from LP data |

**Calibration workflow (ER convergence):**

`calibrate_convergence_er.ts` computes the implied Efficiency Ratio that reproduces the empirical average SC (smoothing constant) from real LP candle data. Because `SC = (ER × deltaSC + slowSC)²` is convex, `E[f(ER)] ≠ f(E[ER])` — the arithmetic mean ER underestimates true convergence. The current fetched 3-year pool 133 1h dataset calibrates `AMA_CONVERGENCE_ER_AVG` to `0.151`.

```bash
# Default data file (pool 133 1h)
tsx analysis/ama_fitting/calibrate_convergence_er.ts

# Custom data, specific AMAs
tsx analysis/ama_fitting/calibrate_convergence_er.ts \
  --data market_adapter/data/lp/<path>/<file>.json \
  --amas AMA1,AMA3
```

**Note:** `ama_fitting/` has no external dependencies — runs directly with `tsx`.

### `bot_fitting/`

Parameter sweep backtests that simulate grid fills for the AMA winners from `ama_fitting/`. Optimizes spread, increment, and max/min ratio for each AMA strategy.

| Script | Purpose |
|--------|---------|
| `backtest_bot_fitting.ts` | Lightweight sweep across spread / increment / ratio with basic risk scoring |
| `backtest_ama_sweep.ts` | Persistent grid simulation with fixed-chain-price mechanics, reposition thresholds, and worker-thread parallelization |
| `shared_utils.ts` | Candle normalization and shared backtest utilities |

```bash
tsx analysis/bot_fitting/backtest_bot_fitting.ts \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

```bash
tsx analysis/bot_fitting/backtest_ama_sweep.ts \
  --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --spread 4:16:1 --increment 0.5:4:0.25
```

Details: [bot_fitting/README.md](bot_fitting/README.md)

### `bot_usage/`

| Script | Purpose |
|--------|---------|
| `discover_bot_accounts.ts` | Discover DEXBot accounts on-chain |
| `kibana_bot_queries.ts` | Kibana query helpers for bot activity |

### Trade Profitability Analyzer (`trade_profitability.ts`)

Fetches `fill_order` operations for a BitShares account from Kibana within a specified time range, then computes realized PnL via sequential (LIFO) or FIFO inventory tracking per asset pair.

**Pipeline:** Kibana fill query → on-chain asset precision resolution → buy/sell classification → chronological matching (sequential LIFO by default) → per-pair summary + optional per-match detail.

```bash
# Account by ID, last 7 days (default)
tsx analysis/trade_profitability.ts 1.2.123456

# Account by name with on-chain resolution
tsx analysis/trade_profitability.ts "bbot5" --lookup --hours 720

# Absolute window with asset filter
tsx analysis/trade_profitability.ts 1.2.123456 \
  --start 2026-07-01 --end 2026-07-07 --asset 1.3.3291

# Export trade log and full analysis
tsx analysis/trade_profitability.ts 1.2.123456 \
  --hours 168 --csv trades.csv --json results.json

# Conservative accounting (FIFO)
tsx analysis/trade_profitability.ts 1.2.123456 \
  --hours 168 --match-mode fifo
```

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--start <iso>` | — | Start time (ISO 8601) |
| `--end <iso>` | — | End time |
| `--hours <n>` | `168` (7d) | Lookback hours (alternative to start/end) |
| `--asset <id>` | all | Filter to one base asset ID |
| `--lookup` | off | Resolve account name to 1.2.x ID via BitShares node |
| `--node <url>` | `wss://dex.iobanker.com/ws` | BitShares node for account + asset resolution |
| `--csv <file>` | — | Export chronologically sorted trade list |
| `--json <file>` | — | Export full analysis with per-pair PnL data |
| `--match-mode <mode>` | `sequential` | Matching mode: `sequential` (LIFO, default) or `fifo` |
| `--trades` | off | Show per-order PnL detail (hidden by default) |
| `--verbose` | off | Print per-pair trade counts during processing |

**Asset precision handling:**

1. Assets listed in `KNOWN_PRECISIONS` (BTS, TWENTIX, XBTSX.*, HONEST.*, IOB.*, etc.) resolve instantly.
2. Unknown assets are resolved on-chain via `get_assets` when `--node` is provided, with results cached at runtime.
3. If no `--node` is given and an asset is unknown, the script errors immediately.

**PnL methodology:** Trades within each pair are sorted chronologically (block number + operation index). Buys add lots to an inventory queue. In sequential (LIFO) mode (default), sells consume the newest lots first — matching the actual grid cycle where a buy at one level is sold at the next tick up. In FIFO mode (`--match-mode fifo`), sells consume the oldest lots first, reflecting the real cost of carrying inventory through a trend. Each match's PnL is `(sellPrice − buyPrice) × matchedAmount`, reported in quote-asset units and as a percentage of the buy price. The summary PnL% uses volume-weighted average prices from matched lots only. Unmatched sell volume (sells without a preceding buy in the window) is surfaced in the pair summary. The per-match detail table includes a Maker/Taker flag sourced from the blockchain operation. |

### `tradingview/`

Generates a standalone TradingView-style HTML chart. See [tradingview/README.md](tradingview/README.md) for full documentation.

## Shared Helpers

| File | Purpose |
|------|---------|
| `price_sources.ts` | Unified candle source abstraction (`json`, `market_adapter`) |
| `chart_utils.ts` | Shared chart rendering utilities |
| `math_utils.ts` | Shared math utilities |

## npm Script Shortcuts

These npm scripts wrap common analysis runners:

| Script | Command |
|--------|---------|
| `npm run analysis:tradingview` | `tsx analysis/tradingview/analyze_tradingview.ts` |
| `npm run analysis:trade-pnl` | `tsx analysis/trade_profitability.ts` |
| `npm run ama:chart:lp-local` | `tsx analysis/ama_fitting/generate_unified_comparison_chart.ts` |

All accept `--` forwarded flags.

```bash
# Bot-key shortcuts
npm run analysis:tradingview -- --source market_adapter --bot-key <bot-key>

# Trade PnL
npm run analysis:trade-pnl -- 1.2.123456 --hours 720

# File-based
npm run analysis:tradingview -- --file market_adapter/data/market_adapter_<bot-key>_1h.json
npm run ama:chart:lp-local -- --data market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json
```

Dynamic-weight research and its supporting analyzers are invoked directly:

```bash
tsx analysis/analyze_dynamic_weight.ts --bot-key <bot-key>
tsx analysis/analyze_volatility.ts --bot-key <bot-key>
tsx analysis/analyze_regime.ts --bot-key <bot-key>
tsx analysis/analyze_regime_windows.ts --bot-key <bot-key>
tsx analysis/analyze_kalman.ts --bot-key <bot-key>
```

## Related Docs

- [Market Adapter](../market_adapter/README.md) — live AMA pricing, grid triggers, dynamic weights, and recalc triggers
- [DEXBot2 Tuning Cheat Sheet](../claw/docs/DEXBOT2_TUNING_CHEAT_SHEET.md) — grid tuning reference for live bots
