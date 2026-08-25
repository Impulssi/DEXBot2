#!/usr/bin/env node
import path from 'node:path';
import { calculateAMA } from '../../market_adapter/core/strategies/ama.js';
import { getStorage } from '../../modules/storage/index.js';
const { readJSON } = getStorage();
import { MARKET_ADAPTER } from '../../modules/constants.js';

'use strict';
/**
 * AMA REPOSITION FREQUENCY ANALYSIS
 *
 * Simulates AMA_DELTA_THRESHOLD_PERCENT grid-reposition logic for all four AMA
 * series on LP candle data.
 *
 * Uses the production threshold from MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT
 * (modules/constants.ts).
 *
 * Usage:
 *   node dist/analysis/ama_fitting/analyze_ama_price_changes.js --data <path-to-lp-candles.json> --results <path-to-optimization-results.json>
 */
const REPOS_THRESHOLD_PCT = MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT;

/**
 * Simulate AMA_DELTA_THRESHOLD_PERCENT reposition logic.
 *
 * Starting from the first post-warmup AMA value, track cumulative drift from
 * the last reposition baseline.  When drift ≥ threshold, a reposition fires:
 * record step-count since previous reposition, reset baseline to current AMA.
 */
function trackRepositions(amaValues: any, thresholdPct: any, warmup: any) {
    let events = 0;
    const steps: number[] = [];
    let baseline = amaValues[warmup];
    let stepCounter = 0;
    for (let i = warmup + 1; i < amaValues.length; i++) {
        const curr = amaValues[i];
        if (baseline === 0) continue;
        stepCounter++;
        const driftPct = Math.abs((curr - baseline) / baseline) * 100;
        if (driftPct >= thresholdPct) {
            events++;
            steps.push(stepCounter);
            baseline = curr;
            stepCounter = 0;
        }
    }
    const min = steps.length > 0 ? Math.min(...steps) : 0;
    const max = steps.length > 0 ? Math.max(...steps) : 0;
    const avg = steps.length > 0 ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;
    return { events, steps, min, max, avg };
}

// ── Load data ─────────────────────────────────────────────────────────────────
function loadData(filePath: any) {
    const json    = readJSON(filePath);
    const candles = json.candles ?? json;
    return {
        candles: candles.map((c: any) => ({ timestamp: c[0], close: c[4] })),
        meta: json.meta ?? null,
    };
}
function loadAmaParams(resultsPath: any) {
    const json = readJSON(resultsPath);
    const amas = json.meta?.amas;
    if (!amas) throw new Error('No amas found in results file');
    return [
        { key: 'AMA1', label: amas.AMA1.label, er: amas.AMA1.er, fast: amas.AMA1.fast, slow: amas.AMA1.slow },
        { key: 'AMA2', label: amas.AMA2.label, er: amas.AMA2.er, fast: amas.AMA2.fast, slow: amas.AMA2.slow },
        { key: 'AMA3', label: amas.AMA3.label, er: amas.AMA3.er, fast: amas.AMA3.fast, slow: amas.AMA3.slow },
        { key: 'AMA4', label: amas.AMA4.label, er: amas.AMA4.er, fast: amas.AMA4.fast, slow: amas.AMA4.slow },
    ];
}
// ── Analysis ──────────────────────────────────────────────────────────────────

// ── Main ──────────────────────────────────────────────────────────────────────
function run() {
    const dataArgIdx    = process.argv.indexOf('--data');
    const resultsArgIdx = process.argv.indexOf('--results');
    if (dataArgIdx === -1) {
        throw new Error('--data <path-to-lp-candles.json> is required');
    }
    if (resultsArgIdx === -1) {
        throw new Error('--results <path-to-optimization-results.json> is required');
    }
    const dataFile    = path.resolve(process.argv[dataArgIdx + 1]);
    const resultsFile = path.resolve(process.argv[resultsArgIdx + 1]);
    const { candles, meta } = loadData(dataFile);
    const amaParams         = loadAmaParams(resultsFile);
    const closes            = candles.map((c: any) => c.close);
    const totalSteps        = closes.length - 1; // candle-to-candle transitions
    const label = meta?.pool
        ? `LP Pool ${meta.pool}`
        : path.basename(dataFile, '.json');
    const interval = meta?.intervalSeconds
        ? `${meta.intervalSeconds / 3600}h`
        : '?h';
    console.log('');
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log(' AMA Reposition Frequency Analysis  (AMA_DELTA_THRESHOLD_PERCENT simulation)');
    console.log('════════════════════════════════════════════════════════════════════════════════');
    console.log(` Dataset:    ${label}  (${interval} candles)`);
    console.log(` Candles:    ${candles.length}  →  ${totalSteps} steps total`);
    console.log(` Threshold:   ${REPOS_THRESHOLD_PCT}%  (from MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT)`);
    console.log('');
    console.log(' Logic: set baseline at warmup end, count steps until AMA drifts ≥ threshold,');
    console.log('        record reposition + reset baseline.  Repeat for full live window.');
    console.log('');
    const results: any[] = [];
    for (const params of amaParams) {
        const values = calculateAMA(closes, {
            erPeriod:   params.er,
            fastPeriod: params.fast,
            slowPeriod: params.slow,
        });
        const r = trackRepositions(values, REPOS_THRESHOLD_PCT, params.er);
        const liveSteps = totalSteps - params.er;
        const freq = liveSteps > 0 ? (r.events / liveSteps * 1000).toFixed(1) : '–';
        const avg  = r.events > 0 ? r.avg.toFixed(1) : '–';
        const suffix = String(params.label).replace(/^AMA\d\s*/i, '').replace(/^[-:\s]+/, '').trim();
        const rowLabel = `${params.key} ${suffix}`;
        console.log(` ── ${rowLabel}  (warmup: ${params.er}  live: ${liveSteps} steps) ──`);
        console.log(`    ≥${REPOS_THRESHOLD_PCT}%  repositions: ${r.events}  avg steps: ${avg}  min: ${r.events > 0 ? r.min : '–'}  max: ${r.events > 0 ? r.max : '–'}  freq: ${freq}/1k steps`);
        console.log('');
        results.push({
            label: rowLabel,
            events: r.events,
            avg: r.avg,
            freq: liveSteps > 0 ? r.events / liveSteps * 1000 : 0,
        });
    }
    console.log(' Note: warmup candles excluded (AMA initializes from SMA of the ER window).');
    console.log('');
    // ── Ranking: fewest repositions ────────────────────────────────────────────
    results.sort((a, b) => a.events - b.events);
    console.log(' Ranking — fewest repositions (least grid changes):');
    console.log('');
    console.log('    ' + '#'.padEnd(4) + 'AMA'.padEnd(20) + 'repositions'.padStart(12) + 'avg steps'.padStart(10) + ' /1000 steps');
    console.log('    ' + '─'.repeat(4 + 20 + 12 + 10 + 12));
    results.forEach((r, i) => {
        console.log(
            '    ' +
            String(i + 1).padEnd(4) +
            r.label.padEnd(20) +
            String(r.events).padStart(12) +
            r.avg.toFixed(1).padStart(10) +
            `  ${r.freq.toFixed(1)}`
        );
    });
    console.log('');
}
run();
