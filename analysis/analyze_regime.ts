#!/usr/bin/env node

/**
 * REGIME ANALYSIS TOOL
 *
 * Computes Hurst Exponent and Permutation Entropy over historical candle data.
 *
 *   Hurst H > 0.55 = trending (persistent)  → trust trend-following signals
 *   Hurst H ≈ 0.50 = random walk            → no edge, stay flat
 *   Hurst H < 0.45 = mean-reverting         → suppress or invert trend signals
 *
 *   Norm. PE < 0.60 = structured            → signals are reliable
 *   Norm. PE > 0.85 = noise                 → no exploitable structure
 *
 * Usage:
 *   tsx analysis/analyze_regime.ts \
 *     --source json \
 *     --file market_adapter/data/lp/<path>/<to>/<lp-candles>.json
 */

'use strict';

const path = require('path');
const { PATHS } = require('../modules/paths');

const { MARKET_ADAPTER }              = require('../modules/constants');
const HURST_CONFIG = MARKET_ADAPTER.HURST_CONFIG;
const PE_CONFIG = MARKET_ADAPTER.PE_CONFIG;
const { HurstAnalyzer }               = require('./trend_detection/hurst_analyzer');
const { PermutationEntropyAnalyzer }  = require('./trend_detection/permutation_entropy_analyzer');
const { generateRegimeHTML }          = require('./trend_detection/regime_chart_generator');
const { createSource }                = require('./price_sources');
const { calculateAMA }                = require('../market_adapter/core/strategies/ama');
const { writeChartFile }              = require('./chart_utils');
const { getCandleClose }              = require('./math_utils');

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source:      { type: string; config: { botKey: string; filePath?: string; stateDir?: string } };
        chartFile:   string;
        hurstWindow: number;
        peWindow:    number;
        peM:         number;
        quiet:       boolean;
    } = {
        source:      { type: 'market_adapter', config: { botKey: '' } },
        chartFile:   'analysis/charts/regime_chart.html',
        hurstWindow: HURST_CONFIG.window,
        peWindow:    PE_CONFIG.window,
        peM:         PE_CONFIG.m,
        quiet:       false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if      (arg === '--source')       config.source.type              = args[++i];
        else if (arg === '--bot-key')      config.source.config.botKey     = args[++i];
        else if (arg === '--file') {
            config.source.config.filePath = args[++i];
            config.source.type = 'json';
        }
        else if (arg === '--chart')        config.chartFile                = args[++i];
        else if (arg === '--hurst-window') config.hurstWindow              = parseInt(args[++i], 10);
        else if (arg === '--pe-window')    config.peWindow                 = parseInt(args[++i], 10);
        else if (arg === '--pe-m')         config.peM                      = parseInt(args[++i], 10);
        else if (arg === '--quiet')        config.quiet                    = true;
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
        if (!config.quiet) console.log(`[Regime] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        // ── Regime analyzers ─────────────────────────────────────────────────
        const hurstAnalyzer = new HurstAnalyzer({
            window: config.hurstWindow,
            scales: HURST_CONFIG.scales,
        });
        const peAnalyzer = new PermutationEntropyAnalyzer({
            m:      config.peM,
            delay:  PE_CONFIG.delay,
            window: config.peWindow,
        });

        const allResults = [];
        for (let i = 0; i < candles.length; i++) {
            const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
            const hurst = hurstAnalyzer.update(marketPrice);
            const pe    = peAnalyzer.update(marketPrice);

            allResults.push({
                timestamp,
                price:               marketPrice,
                hurst:               hurst.hurst,
                hurstRegime:         hurst.regime,
                hurstRegimeStrength: hurst.regimeStrength,
                hurstReady:          hurst.isReady,
                normalizedEntropy:   pe.normalizedEntropy,
                entropy:             pe.entropy,
                peRegime:            pe.regime,
                peRegimeStrength:    pe.regimeStrength,
                peReady:             pe.isReady,
            });
        }

        // ── AMA3 overlay for price panel ─────────────────────────────────────
        const closes    = candles.map(c => getCandleClose(c) ?? 0);
        const ama3Values = calculateAMA(closes, MARKET_ADAPTER.AMAS.AMA3);
        for (let i = 0; i < allResults.length; i++) {
            allResults[i].ama3Price = ama3Values[i] ?? null;
        }

        // ── Print tail summary ───────────────────────────────────────────────
        if (!config.quiet) {
            const last = allResults[allResults.length - 1];
            console.log(`[Regime] ${candles.length} bars processed`);
            console.log(`[Regime] Last bar:`);
            console.log(`         Hurst H=${last.hurst}  regime=${last.hurstRegime}`);
            console.log(`         PE    e=${last.normalizedEntropy}  regime=${last.peRegime}`);
        }

        // ── Generate chart ───────────────────────────────────────────────────
        const html = generateRegimeHTML({
            allResults,
            hurstConfig: { window: config.hurstWindow, scales: HURST_CONFIG.scales },
            peConfig:    { m: config.peM, window: config.peWindow },
        }, 'Regime Analysis \u2014 Hurst \u00b7 Permutation Entropy');

        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(`[Regime] \u2713 Chart saved to ${config.chartFile}`);

    } catch (err) {
        console.error(`[Regime] Error: ${err.message}`);
        process.exit(1);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
