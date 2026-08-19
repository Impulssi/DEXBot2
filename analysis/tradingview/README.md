# TradingView HTML Exporter

This exporter generates a standalone HTML chart in the `analysis/charts/` folder using the local `uPlot`-based TradingView-style renderer.

## What It Produces

- Log-scale price chart
- Candle timeframe buttons: `1h`, `4h`, `1d`, `1w`
- Pair-orientation switcher for `A/B` and `B/A`
- SMA overlay
- AMA overlay with explicit `erPeriod`, `fastPeriod`, and `slowPeriod` inputs
- VWMA overlay
- Bottom volume panel
- Crosshair legend with current candle values

## Quick Start

A chart requires candle data. Either pass an explicit candle file or let the exporter resolve a bot's candles and AMA settings:

```bash
# From an explicit candle JSON file (json source is the default)
npm run analysis:tradingview -- \
  --file market_adapter/data/market_adapter_<bot-key>_1h.json
```

Or with a bot key (see [Bot-Key Usage](#bot-key-usage-recommended) below):

```bash
npm run analysis:tradingview -- \
  --source market_adapter \
  --bot-key <bot-key>
```

This writes:

```text
analysis/charts/tradingview_chart.html
```

> The bare `npm run analysis:tradingview` (no args) errors out — the default `json`
> source requires `--file`, and the `market_adapter` source requires `--bot-key`.

## Bot-Key Usage (Recommended)

The easiest way to generate a chart for a specific bot. Pass the bot key from `profiles/bots.json` and the exporter automatically resolves the candle file and AMA settings:

```bash
npm run analysis:tradingview -- \
  --source market_adapter \
  --bot-key <bot-key>
```

This picks up the bot's asset pair, market profile AMA defaults, and candle data from `market_adapter/data/`. AMA is auto-enabled when the bot uses `gridPrice: "ama"` (or ama1-4).

With a custom chart path:

```bash
npm run analysis:tradingview -- \
  --source market_adapter \
  --bot-key <bot-key> \
  --chart analysis/charts/<pair>_tradingview.html
```

CLI direct equivalent:

```bash
node dist/analysis/tradingview/analyze_tradingview.js \
  --source market_adapter \
  --bot-key <bot-key>
```

### How It Works

1. Reads `profiles/bots.json` to find the bot's `assetA`, `assetB`, and `ama` settings.
2. Resolves the candle file at `market_adapter/data/market_adapter_<bot-key>_1h.json`.
3. Looks up the matching market profile in `profiles/market_profiles.json` for AMA defaults.
4. AMA settings priority: bot-specific `ama` object > market profile > constants (AMA3, slowPeriod 82.7).

> The candle file must exist — run the market adapter LP exporter first if needed (see [Getting Blockchain Data](#getting-blockchain-data)).

## From an Explicit Candle File

```bash
node dist/analysis/tradingview/analyze_tradingview.js \
  --file market_adapter/data/market_adapter_<bot-key>_1h.json \
  --chart analysis/charts/<pair>_tradingview.html
```

Using LP candle files directly:

```bash
node dist/analysis/tradingview/analyze_tradingview.js \
  --file market_adapter/data/lp/<pair-folder>/lp_pool_<id>_<interval>.json \
  --chart analysis/charts/tradingview_chart.html
```

## Input Format

The exporter accepts candle data in either of these shapes:

- Array rows: `[timestamp_ms, open, high, low, close, volume]`
- Object rows: `{ time|timestamp|ts, open, high, low, close, volume }`

If you pass a raw JSON file, the runner normalizes the candles before rendering.

## Getting Blockchain Data

Use the market adapter LP exporter to pull blockchain-backed candles before generating the HTML:

```bash
node dist/market_adapter/inputs/fetch_lp_data.js --pool 133 --precA 4 --precB 5 --interval 1h --lookback 26280h
```

For date range fetching, use `--start` and `--end` (e.g. `--start 2024-03-06 --end 2025-03-06`).

That writes a JSON file under `market_adapter/data/lp/` which you can then pass to the TradingView exporter.

For manual pool discovery, use `--pool`, `--precA`, and `--precB` instead of `--bot`.

## CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--source <json\|market_adapter>` | Data source type | `json` |
| `--file <path>` | Candle JSON input file (required for `json` source) | — |
| `--bot-key <key>` | Bot key for `market_adapter` source | — |
| `--chart <path>` | Output HTML file | `analysis/charts/tradingview_chart.html` |
| `--title <text>` | Chart title | auto-generated from meta |
| `--sma-period <n>` | SMA period | `500` |
| `--ama-er-period <n>` | AMA ER period | `781` |
| `--ama-fast-period <n>` | AMA fast period | `5.2` |
| `--ama-slow-period <n>` | AMA slow period | `82.7` |
| `--price-scale <log\|linear>` | Price axis scale | `log` |
| `--scale <log\|linear>` | Alias for `--price-scale` | `log` |
| `--vwap-bars <n>` | Rolling VWMA window | `500` |
| `--no-sma` | Disable SMA | — |
| `--no-ama` | Disable AMA | — |
| `--no-vwap` | Disable VWMA | — |
| `--quiet` | Suppress progress logs | — |

## Notes

- The chart uses vendored `uPlot` from `analysis/uplot/` in the generated HTML (no CDN dependency).
- The displayed indicators are computed from the 1h base candles and then sampled onto the selected timeframe.
- The current volume-weighted overlay is a rolling `VWMA`, not a session-reset VWAP.
- SMA is disabled by default.
- VWMA is disabled by default.
- AMA is auto-enabled when the bot has `gridPrice: "ama"` (or ama1-4), otherwise disabled by default.
- The AMA controls start with the bot-specific AMA, then pair-specific entry from `profiles/market_profiles.json` when available, falling back to AMA3 values from `modules/constants.ts`.
- The AMA `Reset` button restores the HTML defaults, not the browser-stored overrides.
- The pair switcher inverts the candles client-side, so you can inspect both `A/B` and `B/A` views from one export.
- Indicator, timeframe, and scale changes are persisted in browser `localStorage` for the generated HTML.
- The price axis defaults to log base `10`, with a toolbar switch for `Log` / `Linear`.
- If you regenerate the HTML and then open it later, no CDN access is needed — `uPlot` is loaded from the vendored local copy at `analysis/uplot/`.

## Typical Workflow

1. Pick or generate a candle JSON file.
2. Run `npm run analysis:tradingview` or call the runner directly.
3. Open `analysis/charts/tradingview_chart.html` in a browser.
4. Use the timeframe buttons and indicator controls at the top of the page.
