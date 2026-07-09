# Analysis

**What this is for:** This directory holds tools that examine your DEXBot's trading behavior and the market data it operates on. You can answer questions like:

- "Is my bot actually making money?" (`trade_profitability.ts`)
- "Where did trading volume cluster around my price target?" (`analyze_trade_heatmap.ts`)
- "Are my buy/sell weights tuned correctly for current market conditions?" (`analyze_dynamic_weight.ts`)
- "What should my grid spacing and spread be?" (`bot_fitting/`)

All output is interactive HTML charts — not used in production. Runners write self-contained HTML to `charts/`. These files are regenerated on each run and are not committed.

## Key Terms

Before diving in, here's what the common abbreviations mean:

| Term | Full name | Plain English |
|------|-----------|---------------|
| **OHLC** | Open, High, Low, Close | The four price points that describe each candle (bar) on a chart |
| **AMA** | Adaptive Moving Average | A trend line that speeds up in trending markets and slows down in choppy ones. AMA1–AMA4 are presets with different speeds. |
| **ER** | Efficiency Ratio | How directional price movement was in a period (0 = pure noise, 1 = straight line) |
| **ATR** | Average True Range | How much the price typically moves per bar — a volatility measure |
| **Kalman** | Kalman Filter | A mathematical filter that estimates the true trend by separating signal from noise |
| **Hurst** | Hurst Exponent | A number (0–1) that tells you if the market is trending (>0.5), mean-reverting (<0.5), or random (=0.5) |
| **PE** | Permutation Entropy | How unpredictable the price pattern is — low PE = orderly trend, high PE = chaos |
| **LIFO** | Last In, First Out | Sell the most recently bought asset first (matches grid-bot cycles) |
| **FIFO** | First In, First Out | Sell the oldest purchased asset first (conservative, reflects holding cost) |
| **PnL** | Profit and Loss | Net earnings from trading |
| **SMA** | Simple Moving Average | Average price over N bars — the basic trend line |
| **VWMA** | Volume-Weighted Moving Average | Like SMA but gives more weight to bars with higher volume |

## Quick Start

Most runners default to the market adapter source — just pass a bot key from `profiles/bots.json`:

```bash
# Trade PnL analysis (last 7 days)
npm run analysis:trade-pnl -- <account-id> --hours 168

# TradingView-style chart
npm run analysis:tradingview -- --source market_adapter --bot-key <bot-key>
```

> The market adapter source reads from `market_adapter/state/market_adapter_centers.json` — make sure the bot has been running and produced state data first.

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

## Trade & Portfolio Analysis

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

### Trade Profitability Analyzer (`trade_profitability.ts`)

Fetches `fill_order` operations for a BitShares account from Kibana within a specified time range, then computes realized PnL via sequential (LIFO) or FIFO inventory tracking per asset pair.

**Pipeline:** Kibana fill query → on-chain asset precision resolution → buy/sell classification → chronological matching (sequential LIFO by default) → per-pair summary + optional per-match detail.

```bash
# Account by ID, last 7 days (default)
tsx analysis/trade_profitability.ts 1.2.123456

# Account by name with on-chain resolution
tsx analysis/trade_profitability.ts "1.2.x" --lookup --hours 720

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
| `--node <url>` | first healthy from built-in pool (8 nodes) | BitShares node for account + asset resolution |
| `--csv <file>` | — | Export chronologically sorted trade list |
| `--json <file>` | — | Export full analysis with per-pair PnL data |
| `--match-mode <mode>` | `sequential` | Matching mode: `sequential` (LIFO, default) or `fifo` |
| `--trades` | off | Show per-order PnL detail (hidden by default) |
| `--fee-per-order <bts>` | `0.09652` | Blockchain fee per limit_order_create op (BTS); approximate |
| `--verbose` | off | Print per-pair trade counts during processing |

**Asset precision handling:**

1. Assets listed in the static `ASSETS` table (BTS, TWENTIX, XBTSX.*, HONEST.*, IOB.*, etc.) resolve instantly.
2. Unknown assets are resolved on-chain via `get_assets` when `--node` is provided, with results cached at runtime.
3. If no `--node` is given and an asset is unknown, the fill is **skipped** with a warning (no abort).

**PnL methodology:**

- **Ordering:** Trades within each pair are sorted chronologically (block number + operation index).
- **Lot tracking:** Buys add lots to an inventory queue.
- **LIFO (default):** Sells consume the newest lots first — matching the actual grid cycle where a buy at one level is sold at the next tick up.
- **FIFO:** Sells consume the oldest lots first, reflecting the real cost of carrying inventory through a trend.
- **Per-match PnL:** `(sellPrice − buyPrice) × matchedAmount`, reported in quote-asset units and as a percentage of the buy price.
- **Summary PnL%:** Uses volume-weighted average prices from matched lots only.
- **Unmatched sells:** Sells without a preceding buy in the window are surfaced in the pair summary.
- **Maker/taker flags:** The per-match detail table includes these for both the entry (buy) and exit (sell) legs, sourced from the blockchain operation.
- **Cross pairs:** For non-BTS pairs, assets are normalised by ordering the lower asset ID as base so buy/sell direction is consistent. PnL is reported in the pair's quote asset — a warning is shown when non-BTS quotes are present.
- **Programmatic use:** The script exports `analyzePair`, `classifyFills`, `computeMetrics`, and their TypeScript types.

**Metrics glossary** (each line in the metrics output, plain English):

> **R** = the size of the average losing trade. Think of it as your "unit of pain" — a trade earning 3R made 3× what a typical loser costs you.

| Output line | Meaning |
|-------------|---------|
| `Win Rate` | % of trades that made money. Higher is better, but above 90% with small wins can hide tail risk. |
| `Profit Factor` | Total BTS won ÷ total BTS lost. Above 1.0 means you're profitable; above 2.0 is strong. |
| `Fee Drag` | % of gross profit eaten by blockchain order-creation fees. Lower = more efficient. |
| `Avg Win / Avg Loss` | Ratio of average winner size to average loser size. Above 1.0 means winners are bigger. |
| `Expectancy (gross)` | How much one trade is expected to earn before fees. Positive = edge exists. The `R` version normalises this by the average loss size (reports in R-multiples instead of BTS). The `net` version subtracts fees. |
| `Median R` | The middle R-multiple value (half of trades are above, half below). `>1R` / `>2R` = % of trades that earned more than 1× or 2× the average loss. `<-1R` = % that lost more than 1× the average loss. |
| `PnL distribution` | Median, P25, P75, Best, Worst — the centre, spread, and extremes of per-trade return %. Not annualised, just per cycle. |
| `Sharpe (ann)` | How consistent your daily net PnL is per unit of volatility. Dimensionful (based on absolute daily PnL, not % returns) — use for ranking your own runs, not comparing across account sizes. |
| `Sortino (ann)` | Same method but only penalises days where you lost money (downside volatility). Higher than the Sharpe is normal; a big gap means most volatility came from winning days. |
| `Max Drawdown` | Largest peak-to-trough equity decline as a % of the peak. How bad things got. |
| `Max Recovery Time` | Longest time (in days) from the deepest point of a drawdown back to a new equity high. |
| `Max Consecutive W/L` | Longest streak of winning or losing round-trips. Grouped by sell order, so one order covering multiple buy lots counts as one result. Grid bots naturally cluster wins during trends — streaks of 100-200 are not alarming. |
| `Avg hold time` | Average time (hours) between buying an asset and selling it. |
| `Maker / Taker` | % of trade legs (buys + sells combined) where the bot provided liquidity (maker, resting on the book) vs took it (taker). Higher maker % = lower fees. |
| `Sell orders filled` | Number of distinct sell orders that were filled in the period. |
| `Partial fills/order` | How many buy lots each sell order consumed (mean, median, max). For a grid bot: 2.0 median means half the orders clear 2 grid levels; 18 max means one big sweep. |
| `One-shot orders` | % of orders that matched exactly 1 buy lot. Low % = your grid is thick enough that orders routinely cover multiple levels. |
| `Fills/day` | Average matched lots per calendar day. Raw activity speed. |
| `Avg vol/day` | Average daily trading volume in the quote asset. |

## Visualization

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

## Trend & Price Analysis

Two weight-tuning paths feed into the market adapter:

- **Asymmetric** — AMA slope + Kalman, gated by Hurst/PE regime. Shifts buy/sell weight bias.
- **Symmetric** — ATR volatility penalty. Reduces both weights equally in volatile markets.

### Dynamic Weight Research (`analyze_dynamic_weight.ts`)

Interactive 4-panel chart for the asymmetric path: AMA slope plus Kalman confirmation, gated by Hurst Exponent and Permutation Entropy. Use this when tuning buy/sell weight bias, AMA slope offset behavior, and regime damping.

```bash
tsx analysis/analyze_dynamic_weight.ts --bot-key <bot-key>

# From LP candle file with custom parameters
tsx analysis/analyze_dynamic_weight.ts \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --alpha 0.6 --gain 0.25 --clip 20
```

Full research docs: [DYNAMIC_WEIGHT_RESEARCH.md](trend_detection/DYNAMIC_WEIGHT_RESEARCH.md)

### Volatility (`analyze_volatility.ts`)

ATR-based symmetric volatility penalty. Use when both buy and sell weights are being reduced too much or too little.

```bash
tsx analysis/analyze_volatility.ts --bot-key <bot-key>
```

Supporting sub-signals (regime, Kalman, regime windows) are available as standalone analyzers — see `trend_detection/` below.

## Subarea Reference

### `trend_detection/`

Shared analyzers and chart renderers for the dynamic-weight signal path. Core engines: Kalman filter, Hurst Exponent, Permutation Entropy, ATR volatility.

**Research docs:**
- [DYNAMIC_WEIGHT_RESEARCH.md](trend_detection/DYNAMIC_WEIGHT_RESEARCH.md) — AMA+Kalman blend with Hurst/PE regime gating, formula reference, knob guide
- [SIGNAL_DOCUMENTATION.md](trend_detection/SIGNAL_DOCUMENTATION.md) — legacy SMA/MACD/RSI derivative signal layer

**Tests:**

```bash
tsx analysis/trend_detection/tests/test_kalman_trend.ts
tsx analysis/trend_detection/tests/test_kalman_velocity_smoothing.ts
```

**Note:** `trend_detection/` has no external dependencies — runs directly with `tsx`.

### `ama_fitting/`

AMA parameter optimization and comparison tools.

| Script | Purpose |
|--------|---------|
| `optimizer_high_resolution.ts` | AMA parameter optimizer (erPeriod, fast/slow bounds) |
| `generate_unified_comparison_chart.ts` | AMA comparison chart across multiple parameter sets |
| `analyze_ama_price_changes.ts` | AMA price-change analysis |
| `fetch_lp_candles.ts` | LP candle data fetcher |
| `calibrate_convergence_er.ts` | Calibrate AMA_CONVERGENCE_ER_AVG from LP data |

The AMA implementation itself lives at `market_adapter/core/strategies/ama.ts`.

**Calibration workflow (ER convergence):**

`calibrate_convergence_er.ts` computes the implied Efficiency Ratio that reproduces the empirical average smoothing constant (SC) from real LP candle data.

In plain terms: the smoothing constant formula squares a weighted blend of the Efficiency Ratio, and because squaring bends the relationship (it's convex), the average of the smoothing constants is *not* the same as the smoothing constant of the average ER. The arithmetic mean ER would underestimate the true convergence speed, so the tool computes the correct value instead.

The current fetched 3-year pool 133 1h dataset calibrates `AMA_CONVERGENCE_ER_AVG` to `0.151`.

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

## Shared Helpers

| File | Purpose |
|------|---------|
| `price_sources.ts` | Unified candle source abstraction (`json`, `market_adapter`) |
| `chart_utils.ts` | Shared chart rendering utilities |
| `math_utils.ts` | Shared math utilities |
| `bot_key_utils.ts` | Bot-key resolution and candle file lookup |

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

## Related Docs

- [Market Adapter](../market_adapter/README.md) — live AMA pricing, grid triggers, dynamic weights, and recalc triggers
- [DEXBot2 Tuning Cheat Sheet](../claw/docs/DEXBOT2_TUNING_CHEAT_SHEET.md) — grid tuning reference for live bots
