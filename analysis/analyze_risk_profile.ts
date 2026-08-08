#!/usr/bin/env node
/**
 * RISK PROFILE ANALYZER
 *
 * Unified utility to measure historical inventory drift (divergence quantiles
 * and max divergence) to characterize risk bounds and establish safe ranges.
 *
 * Also computes the empirical standard deviation of per-bar AMA movement
 * (σ_ama_delta) for calibrating AMA_DELTA_THRESHOLD_PERCENT.
 */
import fs from 'node:fs';
import { calculateAMA } from '../market_adapter/core/strategies/ama';
import { MARKET_ADAPTER } from '../modules/constants';
import { generateHTML } from '../market_adapter/lp_chart_core';

'use strict';
function normSInv(p) {
    if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
    const p_low = 0.02425;
    const p_high = 1 - p_low;
    if (p < p_low) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= p_high) {
        const q = p - 0.5;
        const r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        return -((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1));
    }
}
function quantileToSigma(q) {
    return normSInv((1 + q) / 2);
}
import { calcStdDev } from './math_utils';
import { getStorage } from '../modules/storage';
const { readJSON } = getStorage();
function getAmaDeltaStdDev(closes, amaConfig, warmup) {
    const amaValues = calculateAMA(closes, amaConfig);
    const deltas: number[] = [];
    for (let i = warmup + 1; i < closes.length; i++) {
        const prev = amaValues[i - 1];
        const cur = amaValues[i];
        if (!prev || !cur) continue;
        deltas.push((cur - prev) / prev);
    }
    return deltas.length ? calcStdDev(deltas) : null;
}
function getDivergenceDist(closes, amaConfig) {
    const amaValues = calculateAMA(closes, amaConfig);
    const dists: number[] = [];
    // Skip initial warmup
    for (let i = 1600; i < closes.length; i++) {
        const ama = amaValues[i];
        if (!ama) continue;
        dists.push(Math.abs(closes[i] - ama) / ama);
    }
    return dists.sort((a, b) => a - b);
}
function main() {
    const args = process.argv.slice(2);
    
    const dataIdx = args.indexOf('--data');
    const dataPath = dataIdx !== -1 ? args[dataIdx + 1] : null;
    if (!dataPath) {
        console.error('Usage: tsx analysis/analyze_risk_profile.ts --data <path_to_json> [--ama <AMA_PRESET>] [--output <output_path>]');
        process.exit(1);
    }
    const amaIdx = args.indexOf('--ama');
    const selectedAma = amaIdx !== -1 ? args[amaIdx + 1] : 'AMA3';
    
    const outIdx = args.indexOf('--output');
    const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
    
    if (!fs.existsSync(dataPath)) {
        console.error(`Data file not found: ${dataPath}`);
        process.exit(1);
    }
    const data = readJSON(dataPath);
    if (!data.candles || !Array.isArray(data.candles)) {
        console.error('Invalid data format: Expected "candles" array.');
        process.exit(1);
    }
    const closes = data.candles.map(c => Number(c[4]));
    const warmup = 1600;
    const presets = ['AMA1', 'AMA2', 'AMA3', 'AMA4'];
    const quantiles = [0.999, 0.9999, 0.99999];
    console.log(`Analyzing: ${dataPath}`);
    const sigmaLabels = quantiles.map(q => `${(q * 100).toFixed(3)}% — ${quantileToSigma(q).toFixed(2)}σ`);
    console.log('Preset, Max_Divergence(x), ' + sigmaLabels.map((l, i) => `${l} (${['Soft','Hard','Emergency'][i]})`).join(', '));
    presets.forEach(name => {
        const config = MARKET_ADAPTER.AMAS[name as keyof typeof MARKET_ADAPTER.AMAS];
        const allDists = getDivergenceDist(closes, config);
        
        if (allDists.length === 0) {
            console.log(`${name}, N/A, N/A, N/A, N/A`);
            return;
        }
        const maxDist = allDists[allDists.length - 1];
        const meanDist = allDists.reduce((a, b) => a + b, 0) / allDists.length;
        const stdDist = calcStdDev(allDists);
        const amaDeltaSigma = getAmaDeltaStdDev(closes, config, warmup);
        const quantileResults = quantiles.map(q => {
            const val = allDists[Math.min(Math.floor(allDists.length * q), allDists.length - 1)];
            const sigma = quantileToSigma(q);
            const empSigma = (val - meanDist) / stdDist;
            return `${(1 + val).toFixed(3)}x (${sigma.toFixed(2)}σt, ${empSigma.toFixed(2)}σe)`;
        });
        console.log(`${name}, ${(1 + maxDist).toFixed(3)}x, ${quantileResults.join(', ')}`);
        console.log(`  σ_div: ${(stdDist * 100).toFixed(3)}% | mean_div: ${(meanDist * 100).toFixed(3)}% | σ_ama_delta: ${amaDeltaSigma !== null ? (amaDeltaSigma * 100).toFixed(3) : 'N/A'}%`);
    });
    if (outPath) {
        if (!MARKET_ADAPTER.AMAS[selectedAma as keyof typeof MARKET_ADAPTER.AMAS]) {
            console.error(`Invalid AMA preset for output: ${selectedAma}. Choose from: ${Object.keys(MARKET_ADAPTER.AMAS).join(', ')}`);
            process.exit(1);
        }
        
        const config = MARKET_ADAPTER.AMAS[selectedAma as keyof typeof MARKET_ADAPTER.AMAS];
        const amaValues = calculateAMA(closes, config);
        const candleArrays = data.candles.map(c => [c[0], c[1], c[2], c[3], c[4], c[5]]);
        
        // Calculate thresholds for display
        const allDists = getDivergenceDist(closes, config);
        const quantiles = [0.999, 0.9999, 0.99999];
        const amaDeltaSigma = getAmaDeltaStdDev(closes, config, warmup);
        const thresholds = quantiles.map(q => {
            const val = allDists[Math.min(Math.floor(allDists.length * q), allDists.length - 1)];
            return { quantile: q, multiplier: (1 + val).toFixed(3) };
        });
        const amaResult = { 
            name: selectedAma, 
            values: amaValues, 
            color: '#e3b341', 
            lineWidth: 2,
            erPeriod: config.erPeriod,
            fastPeriod: config.fastPeriod,
            slowPeriod: config.slowPeriod
        };
        
        // Try to extract symbols from path or metadata if available, otherwise use generic
        const pairMatch = dataPath.match(/\/lp\/([^\/]+)\//);
        const pairName = pairMatch ? pairMatch[1].replace(/_/g, '-') : 'Market';
        const meta = { 
            pool: `${pairName} ${selectedAma} Risk Analysis`, 
            assetA: { symbol: 'Base' }, 
            assetB: { symbol: 'Quote' }, 
            intervalSeconds: data.candles.length > 1 ? (data.candles[1][0] - data.candles[0][0]) / 1000 : 3600,
            thresholds: thresholds,
            sigmaAmaDelta: amaDeltaSigma !== null ? +((amaDeltaSigma * 100).toFixed(3)) : null
        };
        
        const html = generateHTML(meta, candleArrays, [amaResult]);
        fs.writeFileSync(outPath, html);
        console.log(`\nRisk dashboard generated: ${outPath}`);
    }
}
main();
