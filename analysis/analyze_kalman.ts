#!/usr/bin/env node

/**
 * KALMAN TREND ANALYSIS RUNNER
 *
 * Runs KalmanTrendAnalyzer over candle data and generates an interactive HTML chart.
 *
 * Usage:
 *   tsx analysis/analyze_kalman.ts \
 *     --source json \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 */

import { PATHS } from '../modules/paths.js';
import { KalmanTrendAnalyzer } from './trend_detection/kalman_trend_analyzer.js';
import { generateHTML } from './trend_detection/kalman_chart_generator.js';
import { createSource } from './price_sources.js';
import { calculateAMA } from '../market_adapter/core/strategies/ama.js';
import { computeAverageAmaSlopePct } from '../market_adapter/core/strategies/dynamic_weight_series.js';
import { getCandleClose } from './math_utils.js';
import { writeChartFile } from './chart_utils.js';

'use strict';

// Standalone analysis defaults (reuses calculateAMA from production but constants are independent)
const AMA_ER_PERIOD   = 10;
const AMA_FAST        = 2;
const AMA_SLOW        = 30;
const LOOKBACK_BARS   = 72;
const NEUTRAL_ZONE    = 0.15;
const MAX_SLOPE_PCT   = 3.0;
const MAX_SLOPE_OFFSET = 0.5;

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: { botKey: string; filePath?: string; stateDir?: string } };
        rNoise: number;
        qNoise: number;
        chartFile: string;
        quiet: boolean;
    } = {
        source: { type: 'market_adapter', config: { botKey: '' } },
        rNoise: 0.05,
        qNoise: 0.005,
        chartFile: 'analysis/charts/kalman_chart.html',
        quiet: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--source') config.source.type = args[++i];
        else if (arg === '--bot-key') config.source.config.botKey = args[++i];
        else if (arg === '--file') {
            config.source.config.filePath = args[++i];
            config.source.type = 'json';
        }
        else if (arg === '--r') config.rNoise = parseFloat(args[++i]);
        else if (arg === '--q') config.qNoise = parseFloat(args[++i]);
        else if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

async function main() {
    const config = parseArgs();

    try {
        const srcConfig = config.source.config;
        if (config.source.type === 'market_adapter' && !srcConfig.stateDir) {
            srcConfig.stateDir = PATHS.MARKET_ADAPTER.STATE_DIR;
        }

        const source = createSource(config.source.type, srcConfig);
        if (!config.quiet) console.log(`[Kalman] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        // ── Kalman analysis ──────────────────────────────────────────────────
        const analyzer = new KalmanTrendAnalyzer({
            rNoise: config.rNoise,
            qNoise: config.qNoise
        });

        const allResults: any[] = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const result = analyzer.update(marketPrice);
            result.timestamp = timestamp;
            allResults.push(result);
        }

        // ── AMA weight offset (for comparison panel) ─────────────────────────
        const closes    = candles.map(c => getCandleClose(c) ?? 0);
        const amaValues = calculateAMA(closes, { erPeriod: AMA_ER_PERIOD, fastPeriod: AMA_FAST, slowPeriod: AMA_SLOW });
        const warmup    = AMA_ER_PERIOD + LOOKBACK_BARS + 1;

        for (let i = 0; i < allResults.length; i++) {
            if (i < warmup) { allResults[i].amaWeightOffset = null; continue; }
            const last = amaValues[i];
            const past = amaValues[i - LOOKBACK_BARS];
            if (!last || !past || past === 0) { allResults[i].amaWeightOffset = null; continue; }
            const slopePct = computeAverageAmaSlopePct(last, past, LOOKBACK_BARS)! * LOOKBACK_BARS;
            if (Math.abs(slopePct) < NEUTRAL_ZONE) {
                allResults[i].amaWeightOffset = 0;
            } else {
                allResults[i].amaWeightOffset = Math.max(-MAX_SLOPE_OFFSET,
                    Math.min(MAX_SLOPE_OFFSET, (slopePct / MAX_SLOPE_PCT) * MAX_SLOPE_OFFSET));
            }
        }

        // ── Generate chart ───────────────────────────────────────────────────
        const html = generateHTML({ allResults }, 'Kalman Trend Analysis');
        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(`[Kalman] ✓ Chart saved to ${config.chartFile}`);
    } catch (err: unknown) {
        console.error(`[Kalman] Error: ${(err as any)?.message ?? err}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
