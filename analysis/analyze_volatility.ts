#!/usr/bin/env node

/**
 * VOLATILITY / SYMMETRIC SHIFT RESEARCH TOOL
 *
 * Computes the symmetric volatility shift used by the market adapter.
 *
 * Signal path:
 *   ATR(period, default 14) -> weightVariance = atr / amaPrice
 *   rawSymmetricDelta = -pow(weightVariance, volatilityExponent) * volatilityScaleX
 *   clampedRawDelta = clamp(rawSymmetricDelta, -DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP, 0)
 *   symmetricDelta = |clampedRawDelta| < volatilityThreshold ? 0 : clampedRawDelta
 *
 * The live adapter adds this penalty to both sides after the trend term is built.
 * This runner intentionally omits the directional trend branch so the volatility
 * effect can be researched in isolation.
 *
 * Usage:
 *   tsx analysis/analyze_volatility.ts \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../modules/paths.js';

import { createSource } from './price_sources.js';
import { calculateAMA } from '../market_adapter/core/strategies/ama.js';
import { computeATRSeries } from '../market_adapter/core/strategies/atr/calculator.js';
import { normalizeAtrPeriod } from '../market_adapter/core/config_normalizers.js';
import { computeVolatilityShift } from '../market_adapter/core/strategies/volatility_shift.js';
import { generateHTML } from './trend_detection/volatility_chart_generator.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { getCandleClose } from './math_utils.js';
import { writeChartFile } from './chart_utils.js';

'use strict';

const AMA_CONFIG = MARKET_ADAPTER.AMAS.AMA3;
const DEFAULT_ATR_PERIOD = MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT;
const MIN_WEIGHT = MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT;
const MAX_WEIGHT = MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT;
const DEFAULT_THRESHOLD = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD;
const DEFAULT_CLAMP = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP;
const DEFAULT_CHART_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'charts');
const DEFAULT_CHART_FILE = path.join(DEFAULT_CHART_DIR, 'volatility_chart.html');

function computeATRSeriesNormalized(candles, period = DEFAULT_ATR_PERIOD) {
    return computeATRSeries(candles, normalizeAtrPeriod(period));
}

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source:    { type: string; config: { botKey: string; filePath?: string; stateDir?: string } };
        chartFile: string;
        threshold: number;
        atrPeriod: number;
        exponent:  number;
        scaleX:    number;
        clamp:     number;
        quiet:     boolean;
    } = {
        source: { type: 'market_adapter', config: { botKey: '' } },
        chartFile: DEFAULT_CHART_FILE,
        threshold: DEFAULT_THRESHOLD,
        atrPeriod: DEFAULT_ATR_PERIOD,
        exponent: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
        scaleX: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
        clamp: DEFAULT_CLAMP,
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
        else if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--threshold') config.threshold = parseFloat(args[++i]);
        else if (arg === '--atr-period') {
            const next = parseInt(args[++i], 10);
            if (Number.isFinite(next)) config.atrPeriod = normalizeAtrPeriod(next);
        }
        else if (arg === '--exp') config.exponent = parseFloat(args[++i]);
        else if (arg === '--scale-x') config.scaleX = parseFloat(args[++i]);
        else if (arg === '--clamp') config.clamp = parseFloat(args[++i]);
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

function computeShift(weightVariance, exponent, scaleX, threshold, clampValue) {
    const shift = computeVolatilityShift(weightVariance, {
        exponent,
        scaleX,
        threshold,
        clampValue,
        minWeight: MIN_WEIGHT,
        maxWeight: MAX_WEIGHT,
    });
    return {
        rawSymmetricDelta: shift.rawSymmetricDelta,
        symmetricDelta: shift.symmetricDelta,
        effectiveWeight: shift.effectiveWeight,
        sellW: shift.sellW,
        buyW: shift.buyW,
    };
}

async function main() {
    try {
        const config = parseArgs();
        const srcConfig = config.source.config;
        if (config.source.type === 'market_adapter' && !srcConfig.stateDir) {
            srcConfig.stateDir = PATHS.MARKET_ADAPTER.STATE_DIR;
        }

        const source = createSource(config.source.type, srcConfig);
        if (!config.quiet) console.log(`[Volatility] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const closes = candles.map(c => getCandleClose(c) ?? 0);
        const ama3Values = calculateAMA(closes, AMA_CONFIG);
        const atrPeriod = normalizeAtrPeriod(config.atrPeriod);
        const atrs = computeATRSeriesNormalized(candles, atrPeriod);

        const allResults: any[] = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const amaPrice = ama3Values[i] ?? null;
            const atr = atrs[i] ?? 0;
            const weightVariance = amaPrice > 0 ? atr / amaPrice : 0;
            const shift = computeShift(weightVariance, config.exponent, config.scaleX, config.threshold, config.clamp);

            allResults.push({
                timestamp,
                price: marketPrice,
                ama3Price: amaPrice,
                atr,
                weightVariance,
                rawSymmetricDelta: shift.rawSymmetricDelta,
                symmetricDelta: shift.symmetricDelta,
                effectiveWeight: shift.effectiveWeight,
                sellW: shift.sellW,
                buyW: shift.buyW,
            });
        }

        const html = generateHTML({
            allResults,
            candles,
            volatilityThreshold: config.threshold,
            volatilityExponent: config.exponent,
            volatilityScaleX: config.scaleX,
            volatilityClamp: config.clamp,
            atrPeriod,
            minWeight: MIN_WEIGHT,
            maxWeight: MAX_WEIGHT,
            marketAdapter: MARKET_ADAPTER,
        }, 'ATR Volatility Research');

        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(`[Volatility] ✓ Chart saved to ${config.chartFile}`);
    } catch (err: unknown) {
        console.error(`[Volatility] Error: ${(err as any)?.message ?? err}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
