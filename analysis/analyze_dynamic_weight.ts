#!/usr/bin/env node

/**
 * DYNAMIC WEIGHT RESEARCH TOOL
 *
 * Computes AMA slope + Kalman + Hurst + PE signals and generates an
 * interactive HTML chart for researching dynamic weight parameters.
 *
 * Usage:
 *   tsx analysis/analyze_dynamic_weight.ts \
 *     --source json \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 */

'use strict';

const path = require('path');
const { KalmanTrendAnalyzer } = require('./trend_detection/kalman_trend_analyzer');
const { HurstAnalyzer } = require('./trend_detection/hurst_analyzer');
const { PermutationEntropyAnalyzer } = require('./trend_detection/permutation_entropy_analyzer');
const { generateHTML } = require('./trend_detection/dynamic_weight_chart_generator');
const { createSource } = require('./price_sources');
const { calculateAMA } = require('../market_adapter/core/strategies/ama');
const { computeAmaSlopeWeights } = require('../market_adapter/core/strategies/ama_slope_model');
const { MARKET_ADAPTER } = require('../modules/constants');
const { writeChartFile } = require('./chart_utils');
const { getCandleClose } = require('./math_utils');
const { resolveCandleFile, resolveAmaConfig, resolveAmaKey } = require('./bot_key_utils');

const INTERVAL_LABEL = MARKET_ADAPTER.RUNTIME_DEFAULTS.intervalLabel;

// AMA Slope weight calculation config — use DEFAULTS from market adapter
const AMA_WEIGHT_CONFIG = {
    lookbackBars:           MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
    amaMaxSlopePct:         MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
    kalmanMaxSlopePct:      MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
    neutralZonePct:         MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
    volatilityExponent:     MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
    volatilityScaleX:       MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
    volatilityThreshold:    MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD,
    maxSlopeOffset:         MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
    maxVolatilityOffset:    MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP,
};

// Kalman configuration
const KALMAN_CONFIG = {
    rNoise: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_R_NOISE_DEFAULT,
    qTactical: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_TACTICAL_DEFAULT,
    qModal: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_Q_MODAL_DEFAULT,
};

// Regime analyzers configuration (Hurst + Permutation Entropy)
const { HURST_CONFIG, PE_CONFIG } = MARKET_ADAPTER;


function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: { botKey: string; filePath?: string } };
        chartFile: string;
        alpha: any;
        gain: any;
        dispWeight: any;
        clipPct: any;
        quiet: boolean;
        lookbackBars?: number;
        dispScaleMinPct?: number;
    } = {
        source: { type: 'market_adapter', config: { botKey: 'XRP-BTS' } },
        chartFile: 'analysis/charts/dynamic_weight_chart.html',
        alpha: MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA,
        gain: MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN,
        dispWeight: MARKET_ADAPTER.DYNAMIC_WEIGHT_DW,
        clipPct: MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE,
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
        else if (arg === '--alpha') config.alpha = parseFloat(args[++i]);
        else if (arg === '--gain') config.gain = parseFloat(args[++i]);
        else if (arg === '--dw') config.dispWeight = parseFloat(args[++i]);
        else if (arg === '--lb') config.lookbackBars = parseInt(args[++i], 10);
        else if (arg === '--clip') config.clipPct = parseFloat(args[++i]);
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

async function main() {
    try {
        const config = parseArgs();
        const srcConfig = config.source.config;

        if (config.source.type === 'market_adapter') {
            const candleFile = resolveCandleFile(srcConfig.botKey, INTERVAL_LABEL);
            if (!candleFile) {
                throw new Error(`No candle cache file found for bot '${srcConfig.botKey}'. Use --file to specify a data file directly.`);
            }
            srcConfig.filePath = candleFile;
            config.source.type = 'json';
            if (!config.quiet) console.log(`[DynamicWeight] Resolved bot '${srcConfig.botKey}' → ${path.basename(candleFile)}`);
        }

        const AMA_CONFIG = resolveAmaConfig(srcConfig.botKey);

        const source = createSource(config.source.type, srcConfig);
        if (!config.quiet) console.log(`[DynamicWeight] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        // ── Kalman analysis ──────────────────────────────────────────────────
        const analyzer = new KalmanTrendAnalyzer({
            rNoise: KALMAN_CONFIG.rNoise,
            qTactical: KALMAN_CONFIG.qTactical,
            qModal: KALMAN_CONFIG.qModal,
        });

        // ── Hurst & PE analyzers ──────────────────────────────────────────────
        const hurstAnalyzer = new HurstAnalyzer({
            window: HURST_CONFIG.window,
            scales: HURST_CONFIG.scales,
        });
        const peAnalyzer = new PermutationEntropyAnalyzer({
            m:      PE_CONFIG.m,
            delay:  PE_CONFIG.delay,
            window: PE_CONFIG.window,
        });

        const allResults = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const result = analyzer.update(marketPrice);
            const hurst = hurstAnalyzer.update(marketPrice);
            const pe    = peAnalyzer.update(marketPrice);
            result.timestamp = timestamp;
            result.price = marketPrice;
            result.hurst = hurst.isReady ? hurst.hurst : null;
            result.pe    = pe.isReady    ? pe.normalizedEntropy : null;
            allResults.push(result);
        }

        // ── AMA weight calculation ───────────────────────────────────────────
        const closes = candles.map(c => getCandleClose(c) ?? 0);
        const amaValues = calculateAMA(closes, AMA_CONFIG);
        for (let i = 0; i < allResults.length; i++) {
            // The research chart keeps ATR out of the Kalman branch on purpose.
            // Production applies ATR later as a separate symmetric volatility penalty.
            const atr = 0;
            const weightVariance = 0;

            const weights = computeAmaSlopeWeights(amaValues.slice(0, i + 1), weightVariance, {
                erPeriod: AMA_CONFIG.erPeriod,
                slowPeriod: AMA_CONFIG.slowPeriod,
                lookbackBars: config.lookbackBars ?? AMA_WEIGHT_CONFIG.lookbackBars,
                maxSlopePct: AMA_WEIGHT_CONFIG.amaMaxSlopePct,
                neutralZonePct: AMA_WEIGHT_CONFIG.neutralZonePct,
                volatilityExponent: AMA_WEIGHT_CONFIG.volatilityExponent,
                volatilityScaleX: AMA_WEIGHT_CONFIG.volatilityScaleX,
                volatilityThreshold: AMA_WEIGHT_CONFIG.volatilityThreshold,
                maxSlopeOffset: AMA_WEIGHT_CONFIG.maxSlopeOffset,
                maxVolatilityOffset: AMA_WEIGHT_CONFIG.maxVolatilityOffset,
            });

            allResults[i].ama3Price = amaValues[i] ?? null;
            allResults[i].atr = atr;
            allResults[i].weightVariance = weightVariance;
            allResults[i].amaSlopePct = weights.slopePct;
            allResults[i].amaWeightReady = weights.isReady;
            allResults[i].amaSlopeOffset = weights.slopeOffset;
            allResults[i].amaSymmetricDelta = weights.symmetricDelta;
        }

        // ── Generate chart ───────────────────────────────────────────────────
        const amaKey = resolveAmaKey(srcConfig.botKey);

        const html = generateHTML({
            allResults,
            amaConfig: AMA_CONFIG,
            amaKey,
            amaWeightConfig: {
                ...AMA_WEIGHT_CONFIG,
                lookbackBars: config.lookbackBars ?? AMA_WEIGHT_CONFIG.lookbackBars,
            },
            alpha: config.alpha,
            gain: config.gain,
            dispWeight: config.dispWeight,
            clipPct: config.clipPct,
            regimeSensitivity: MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY,
            dispScaleMinPct:  config.dispScaleMinPct  ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT,
            minOutputThreshold: MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD,
            outputClamp: MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
            marketAdapter: {
                alpha:                   MARKET_ADAPTER.DYNAMIC_WEIGHT_ALPHA,
                gain:                    MARKET_ADAPTER.DYNAMIC_WEIGHT_GAIN,
                dispWeight:              MARKET_ADAPTER.DYNAMIC_WEIGHT_DW,
                clipPercentile:         MARKET_ADAPTER.DYNAMIC_WEIGHT_CLIP_PERCENTILE,
                regimeSensitivity:       MARKET_ADAPTER.DYNAMIC_WEIGHT_REGIME_SENSITIVITY,
                minOutputThreshold:      MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_TREND_THRESHOLD,
                outputClamp:             MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP,
                amaLookbackBars:        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
                amaMaxSlopePct:         MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
                kalmanMaxSlopePct:      MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
                amaNeutralZonePct:      MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
                dispScaleMinPct:        MARKET_ADAPTER.DYNAMIC_WEIGHT_DISP_SCALE_MIN_PCT,
            },
        }, 'Dynamic Weight Research Tool');

        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(`[DynamicWeight] ✓ Chart saved to ${config.chartFile}`);
    } catch (err) {
        console.error(`[DynamicWeight] Error: ${err.message}`);
        process.exit(1);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
