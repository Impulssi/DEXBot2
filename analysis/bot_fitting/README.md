## Bot Fitting Backtest

This folder contains parameter sweep backtests that simulate grid fills for the four AMA winners from `analysis/ama_fitting`.

### What it optimizes

For each of the 4 AMA strategies, it searches for best:

- `spread` (% target round-trip spread)
- `increment` (% grid step)
- `max/min ratio` (symmetric range around AMA, e.g. `2.0` means `[AMA/2, AMA*2]`)

### Scripts

- `backtest_bot_fitting.ts` — lightweight sweep across spread / increment / ratio with basic risk scoring
- `backtest_ama_sweep.ts` — persistent grid simulation with fixed-chain-price mechanics, reposition thresholds, and worker-thread parallelization
- `shared_utils.ts` — shared helpers (argument parsing, data loading, formatting) used by both scripts

### Input dependencies

Both scripts require:

- **LP candles JSON** (recommended 1h), from `market_adapter/data/lp/` — pass via `--data`
- **AMA optimization winners JSON**, from `analysis/ama_fitting/` — for `backtest_ama_sweep.ts`, pass via `--results`

### Run

```bash
# Lightweight sweep
node dist/analysis/bot_fitting/backtest_bot_fitting.js \
  --data <path-to-lp-candles.json>

# Persistent grid simulation with AMA winners
node dist/analysis/bot_fitting/backtest_ama_sweep.js \
  --data <path-to-lp-candles.json> \
  --results <path-to-optimization-results.json>
```

> `backtest_bot_fitting.ts` auto-derives `--results` from the `--data` filename
> (`analysis/ama_fitting/optimization_results_<base>_w<λ1>_<λ2>_<λ3>_<λ4>.json`,
> newest `_w*` file matching the base name; falls back to the legacy
> `optimization_results_<base>.json`) when omitted.
> `backtest_ama_sweep.ts` requires `--results` explicitly.

Optional tuning (values shown are examples, not defaults):

```bash
node dist/analysis/bot_fitting/backtest_bot_fitting.js \
  --data <path-to-lp-candles.json> \
  --spread 0.4:1.6:0.1 \
  --increment 0.2:0.8:0.1 \
  --ratio 1.5,2,2.5,3,4,5,8,10 \
  --active-orders 5 \
  --fee 0.20 \
  --min-spread-factor 2.1 \
  --risk-duration 1.0 \
  --risk-peak-open 2.0 \
  --risk-imbalance 1.2 \
  --risk-cancel 0.15
```

> Default `--ratio` is `1.5,1.75,2,2.5,3,4,5,8,10` (includes `1.75`).

### Output

Results are written to `analysis/bot_fitting/` (filenames derived from the input data file: `bot_fitting_results_<base>.json` for the lightweight sweep, `ama_sweep_results_<base>.json` for the persistent grid simulation).

The console also prints best parameter set per AMA with matched pairs, fill efficiency, net capture and score.

### Notes

- This is an offline simulation proxy, not a full chain execution model.
- Reposition reset is modeled when AMA changes by more than increment in one candle.
- Pair search enforces bot rule: `spread >= 2.1 x increment` by default
  (`--min-spread-factor` to override).
- Score used for ranking:
  - `totalNetCapturePct = matchedPairs * (spread - increment - fee)`
  - `baseScore = totalNetCapturePct * (fillEfficiency / 100)`
  - `riskPenalty = avgOpenDurationBars*1.0 + peakOpenOrders*2.0 + avgImbalance*1.2 + canceledOnReposition*0.15`
  - `finalScore = baseScore - riskPenalty`

## Persistent Grid Simulation Details

`backtest_ama_sweep.ts` models the real bot mechanics:

- Orders sit at FIXED chain prices until canceled or filled
- When AMA drifts past reposition threshold, grid re-centers
- Grid compression: AMA shift pushes one side's orders closer to market
- Order sizing depends on capital, ratio (range width), and weight profile
- Three weight profiles: valley, neutral, mountain (symmetric buy/sell)

Search grid defaults — centered around bot defaults (spread=2%, increment=0.5%):

| Param | Default Range |
|-------|--------------|
| Spread | 0.5:4:0.25 + 5:12:1 (%) |
| Increment | 0.2:2:0.1 + 2.5:8:0.5 (%) |
| Max/min ratio | 1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 2, 3, 5, 10 |
| Reposition threshold | 2.5% |
| Max orders per side | 20 |
| Round-trip fee | 0.20% |
| Spread ≥ factor × increment | 2.1 |

All parameters above are tunable via CLI flags. Additional tuning flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--capital <n>` | 10000 | Notional capital per side |
| `--reposition <pct>` | 2.5 | AMA drift % to trigger re-center |
| `--bts-create-fee <n>` | 0.48260 | BTS create order fee |
| `--bts-cancel-fee <n>` | 0.00482 | BTS cancel order fee |
| `--maker-create-factor <n>` | 0.10 | Maker share of create fee |
| `--tx-fee-price <n>` | 1.0 | Convert BTS fees into backtest units |
| `--top <n>` | 15 | Top N results displayed per AMA |
| `--help` | — | Print full usage |

The sweep parallelizes across combos using worker threads (one per CPU core). Use `--help` for the complete option list.

```bash
node dist/analysis/bot_fitting/backtest_ama_sweep.js \
  --data <path-to-lp-candles.json> \
  --results <path-to-optimization-results.json> \
  --spread 4:16:1 --increment 0.5:4:0.25
```
