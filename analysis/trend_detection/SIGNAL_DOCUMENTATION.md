# Signal & Indicator Documentation (Legacy)

**Note:** This documents the legacy SMA/MACD/RSI derivative signal layer. See `kalman_trend_analyzer.ts` for the current trend detection implementation.

## Overview

The derivative analyzer uses four indicators:

- `SMA` (slow) for macro trend / regime
- `fastSMA` (optional) for short-term direction — used as the trend filter source and fast-SMA commitment gate
- `MACD` for momentum
- `RSI` for exhaustion and counter-trend filtering

The output signal is one of:

- `BULL`
- `BULL_WEAK`
- `BEAR`
- `BEAR_WEAK`
- `OVERBOUGHT`
- `OVERSOLD`
- `NEUTRAL`

There are three independent output layers:

- `trend` / `rawTrend` / `isConfirmed` come from SMA direction alone. `--confirm` controls only this MA-trend confirmation layer.
- `interpretation` / `interpretationRaw` are the trading-style states (`BULL`, `BEAR`, `OVERBOUGHT`, etc.). `--interp-confirm` and `--interp-hold` control only this signal layer.
- `entryBias` and its boolean helpers are derived execution hints built on top of the final `interpretation` state. They do not change the base signal engine. They classify whether a directional setup is an early weak entry or a proper confirmation once slow and fast SMA alignment is in place.

---

## Indicators

### SMA

Simple moving average over the configured slow period.

**Derivative signal**

```text
d(SMA)/dt > 0  -> UP
d(SMA)/dt < 0  -> DOWN
d(SMA)/dt = 0  -> NEUTRAL
```

**Flag**

| Flag | Default | Meaning |
|------|---------|---------|
| `--sma N` | 500 | Slow SMA period |

The slow SMA defines the macro regime. It is the reference line for the price regime gate and the macro disagree cap (see Trend filter).

---

### fastSMA

Optional second moving average over a shorter period. When present it takes over from the slow SMA as the primary trend filter direction source and enables two additional signal quality checks.

**Derivative signal**

```text
d(fastSMA)/dt > 0  -> UP
d(fastSMA)/dt < 0  -> DOWN
d(fastSMA)/dt = 0  -> NEUTRAL
```

**Flag**

| Flag | Default | Meaning |
|------|---------|---------|
| `--fast-sma N` | off | Fast SMA period (e.g. 100) |

When `--fast-sma` is set:

- The trend filter reads **fastSMA direction** instead of slow SMA direction.
- **Macro disagree cap**: if fastSMA and slow SMA point in opposite directions, a full `BULL`/`BEAR` is capped to `BULL_WEAK`/`BEAR_WEAK`.
- **Fast-SMA commitment gate**: `BULL`/`BEAR` confirmation requires price to have been on the correct side of fastSMA for ≥ `--fast-sma-commitment-bars` consecutive bars (default 2). Failing bars reset the confirmation counter.

Both the price overlay line and the derivative direction panel in the chart show fastSMA alongside slow SMA.

---

### MACD

Momentum indicator built from the normalized MACD line, signal line, and histogram.

**Interpretation**

- Histogram > 0: bullish momentum
- Histogram < 0: bearish momentum
- Histogram shrinking: momentum fading
- MACD line > 0: positive regime
- MACD line < 0: negative regime

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `--macd-fast N` | 12 | Fast EMA period |
| `--macd-slow N` | 26 | Slow EMA period |
| `--macd-signal N` | 9 | Signal EMA period |
| `--macd-min-hist F` | 0.02 | Minimum histogram magnitude before a directional signal is allowed |

---

### RSI

Relative Strength Index used as a confidence modifier and exhaustion gate.

**Zones**

| RSI | Meaning |
|-----|---------|
| > `--rsi-extreme` | `OVERBOUGHT` |
| 50 + `--rsi-zone` | Bullish zone |
| 50 - `--rsi-zone` | Bearish zone |
| < 100 - `--rsi-extreme` | `OVERSOLD` |

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `--rsi N` | 14 | RSI period |
| `--rsi-zone N` | 10 | Distance from 50 for counter-trend downgrade |
| `--rsi-extreme N` | 90 | Exhaustion threshold |

RSI no longer hard-gates the base signal. It only downgrades or overrides it.

---

## Signal Rules

### Base direction

MACD histogram decides the initial directional candidate:

```text
hist >  macd-min-hist -> BULL candidate
hist < -macd-min-hist -> BEAR candidate
otherwise             -> NEUTRAL
```

### Confirmation

`BULL` and `BEAR` require sustained raw direction before they are confirmed.

**Flag**

| Flag | Default | Meaning |
|------|---------|---------|
| `--interp-confirm N` | 3 | Bars required to confirm a raw BULL/BEAR |

### Hysteresis

Confirmed `BULL`/`BEAR` states do not drop immediately on a minor fluctuation.

**Flag**

| Flag | Default | Meaning |
|------|---------|---------|
| `--interp-hold N` | 3 | Bars a downgrade must persist before it is applied |

### Hard invalidation

Some regime failures bypass hysteresis completely. A confirmed `BULL`/`BEAR` is dropped immediately when the signal is no longer structurally valid.

Immediate invalidation triggers:

- **Post-filter MACD line regime failure** — `BULL` requires MACD line >= `macd-min-hist`; `BEAR` requires MACD line <= `-macd-min-hist`.
- **Macro disagree failure** — when fastSMA and slow SMA disagree strongly enough to trigger the macro cap, a confirmed `BULL`/`BEAR` can no longer be held.
- **Price regime failure** — price loses the buffered slow-SMA regime gate.

### RSI overrides

- `BULL` + RSI > `--rsi-extreme` -> `OVERBOUGHT`
- `BEAR` + RSI < `100 - --rsi-extreme` -> `OVERSOLD`

### RSI weakens the signal

- `BULL` + RSI below the bearish zone and not rising -> `BULL_WEAK`
- `BEAR` + RSI above the bullish zone and not falling -> `BEAR_WEAK`

### Trend filter

The trend filter suppresses counter-trend signals when the fast MA (fastSMA if set, otherwise slow SMA) is clearly pointing the other way.

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `--trend-filter` | off | Enable trend direction filter |
| `--trend-filter-min-bars N` | 3 | Fast MA trend must persist this many bars before the filter applies |

When fastSMA is present, two additional checks run inside the trend filter:

- **Macro disagree cap** — fastSMA and slow SMA point in opposite directions → full `BULL`/`BEAR` capped to `BULL_WEAK`/`BEAR_WEAK`.
- **Fast-SMA commitment** — `BULL` requires price above fastSMA for ≥ N bars; `BEAR` requires price below fastSMA for ≥ N bars. Failing this downgrades to `BULL_WEAK`/`BEAR_WEAK`.

### Momentum gate

When the trend filter suppresses a directional candidate to `NEUTRAL`, the momentum gate can restore it as weak if MACD and RSI both support the reversal for enough bars.

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `--momentum-gate` | off | Enable recovery gate |
| `--momentum-gate-bars N` | 3 | Bars of sustained divergence required |
| `--momentum-gate-rsi-zone F` | 35 | RSI threshold for the divergence check |

The gate is only checked after a directional state was suppressed by the primary trend filter. It does not create weak signals from an already-neutral MACD/RSI reading.

### Price regime gate

Any directional state (`BULL`, `BULL_WEAK`, `BEAR`, `BEAR_WEAK`) is suppressed if price has not cleared the slow SMA by a small buffer.

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `--price-regime-buffer-pct N` | 0.35 | Required clearance from the slow SMA, in percent |
| `--no-price-regime-gate` | off | Disable the gate |

This is the trap filter that removes shallow bull/bear crosses from the chart.

The same gate is also treated as a hard invalidation for hysteresis. A confirmed `BULL`/`BEAR` is dropped immediately when the buffered slow-SMA regime is lost.

### MACD line regime gate

Inside the trend filter, the MACD line itself must agree with the regime:

- `BULL` needs MACD line > 0
- `BEAR` needs MACD line < 0

There is one extra bearish downgrade:

- `BEAR` + MACD histogram > 0 -> `BEAR_WEAK`

### Post-filter trap suppression

The final hard gate suppresses any remaining directional state while the MACD line is still too close to the wrong side of zero.

The threshold is not pure zero. It reuses `--macd-min-hist` as a small regime buffer:

- `BULL` / `BULL_WEAK` require MACD line >= `macd-min-hist`
- `BEAR` / `BEAR_WEAK` require MACD line <= `-macd-min-hist`

That means stale bullish or bearish holds are cleared immediately when the regime is invalidated.

---

## Entry Bias Metadata

The analyzer also exposes a derived `entryBias` classification for downstream execution logic and chart overlays.

Possible values:

- `NONE`
- `EARLY_LONG`
- `CONFIRM_LONG`
- `EARLY_SHORT`
- `CONFIRM_SHORT`

Boolean helpers are emitted alongside it:

- `isBullWeakEntry`
- `isBullConfirmation`
- `isBearWeakEntry`
- `isBearConfirmation`

These fields are computed from the final post-hysteresis `interpretation`, not from raw MACD/RSI candidates.
They are additionally gated by MA alignment:

- long entry hints require slow SMA `UP` and fast SMA `UP`
- short entry hints require slow SMA `DOWN` and fast SMA `DOWN`

### Long-side transitions

- `NEUTRAL -> BULL_WEAK` => `EARLY_LONG`
- `BULL_WEAK -> BULL` => `CONFIRM_LONG`

### Short-side transitions

- `NEUTRAL -> BEAR_WEAK` => `EARLY_SHORT`
- `BEAR_WEAK -> BEAR` => `CONFIRM_SHORT`

If a weak setup fails back to `NEUTRAL` or the signal flips to the opposite side, the setup state is cleared.

---

## Decision Tree

```text
|hist| <= macd-min-hist -> NEUTRAL

BULL candidate:
  RSI > extreme                       -> OVERBOUGHT
  RSI weakens bullishly               -> BULL_WEAK
  MACD line regime disagrees          -> BULL_WEAK
  trend filter rejects (fastSMA DOWN) -> NEUTRAL
  macro disagree cap (fastSMA≠SMA)    -> BULL_WEAK
  Fast-SMA commitment: price below fastSMA < N bars-> BULL_WEAK
  momentum gate restores              -> BULL_WEAK
  price regime gate rejects           -> NEUTRAL
  post-filter trap suppression        -> NEUTRAL
  Fast-SMA commitment not met         -> resets confirmation counter
  confirmed and held                  -> BULL

BEAR candidate:
  RSI < 100-extreme                   -> OVERSOLD
  RSI weakens bearishly               -> BEAR_WEAK
  MACD line regime disagrees          -> BEAR_WEAK
  trend filter rejects (fastSMA UP)   -> NEUTRAL
  macro disagree cap (fastSMA≠SMA)    -> BEAR_WEAK
  Fast-SMA commitment: price above fastSMA < N bars-> BEAR_WEAK
  momentum gate restores              -> BEAR_WEAK
  price regime gate rejects           -> NEUTRAL
  post-filter trap suppression        -> NEUTRAL
  Fast-SMA commitment not met         -> resets confirmation counter
  confirmed and held                  -> BEAR
```

---

## Parameter Reference

Start with the base indicator set below. These are the parameters that define the
signal model itself. The remaining flags are optional gates or advanced defaults
that only need adjustment when you want to change how strict the signal is.

### Base indicator set

| Flag | Default | Purpose |
|------|---------|---------|
| `--sma N` | 500 | Slow macro regime anchor |
| `--macd-fast N` | 12 | MACD fast EMA period |
| `--macd-slow N` | 26 | MACD slow EMA period |
| `--macd-signal N` | 9 | MACD signal EMA period |
| `--macd-min-hist F` | 0.02 | Minimum histogram magnitude for direction |
| `--rsi N` | 14 | RSI period |

### Optional gate knobs

| Flag | Default | Purpose |
|------|---------|---------|
| `--fast-sma N` | off | Short-term direction source and fast-SMA commitment gate |
| `--trend-filter` | off | Enables counter-trend suppression |
| `--fast-sma-commitment-bars N` | 2 | Requires price to stay beyond fastSMA before confirming |
| `--price-regime-buffer-pct N` | 0.35 | Requires price clearance from slow SMA |

### Advanced defaults

#### Confirmation and hysteresis

| Flag | Default | Description |
|------|---------|-------------|
| `--confirm N` | 3 | Bars required for trend confirmation |
| `--interp-confirm N` | 3 | Confirmation bars for BULL/BEAR |
| `--interp-hold N` | 3 | Hysteresis bars for downgrades |

#### Trend filters and gates

| Flag | Default | Description |
|------|---------|-------------|
| `--trend-filter-min-bars N` | 3 | SMA trend persistence before filtering |
| `--momentum-gate` | off | Enable MACD+RSI recovery gate |
| `--momentum-gate-bars N` | 3 | Momentum gate persistence |
| `--momentum-gate-rsi-zone F` | 35 | RSI divergence threshold |
| `--no-price-regime-gate` | off | Disable slow-SMA regime gate |

### Source input

| Flag | Default | Description |
|------|---------|-------------|
| `--source` | market_adapter | Data source |
| `--file PATH` | — | JSON candle input |
| `--bot-key KEY` | — | Market adapter bot key used to load `market_adapter/state/market_adapter_centers.json` |

### Output

| Flag | Default | Description |
|------|---------|-------------|
| `--chart FILE` | analysis/charts/derivative_chart.html | HTML output path |

---

## Recommended 1h Setup

```bash
node dist/analysis/analyze_derivatives.js \
  --source json \
  --file market_adapter/data/lp/<pair>/lp_pool_<id>_<interval>.json \
  --sma 500 --fast-sma 100 \
  --macd-fast 48 --macd-slow 104 --macd-signal 36 --macd-min-hist 0.02 \
  --rsi 96 --rsi-extreme 90 --rsi-zone 10 \
  --interp-confirm 3 --interp-hold 3 \
  --trend-filter --trend-filter-min-bars 3
```

If you want fewer shallow traps, keep the price regime gate enabled. If you want to
see every MACD/RSI turn regardless of slow-SMA clearance, disable it with
`--no-price-regime-gate`.
