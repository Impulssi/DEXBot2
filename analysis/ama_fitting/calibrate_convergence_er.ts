#!/usr/bin/env node
import path from 'node:path';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { getStorage } from '../../modules/storage/index.js';
const { readJSON } = getStorage();
import { PATHS } from '../../modules/paths.js';
import { roundTo } from '../../modules/order/utils/math.js';

'use strict';
/**
 * AMA CONVERGENCE ER CALIBRATION
 *
 * Computes the correct AMA_CONVERGENCE_ER_AVG from real LP candle data.
 *
 * The formula `(ER_avg × deltaSC + slowSC)²` suffers from Jensen's inequality:
 * E[f(ER)] ≠ f(E[ER]) when f is convex (x²). The arithmetic mean ER
 * underestimates the true average SC because high-ER periods contribute
 * quadratically more to convergence.
 *
 * This script computes the implied ER — the value that, when plugged into
 * the formula, reproduces the empirical arithmetic SC_avg — and prints
 * the recommended constant for modules/constants.ts.
 *
 * Usage:
 *   tsx analysis/ama_fitting/calibrate_convergence_er.ts
 *   tsx analysis/ama_fitting/calibrate_convergence_er.ts --data <lp-file.json>
 *   tsx analysis/ama_fitting/calibrate_convergence_er.ts --data <lp-file.json> --amas AMA3
 */
const DEFAULT_DATA = path.join(PATHS.MARKET_ADAPTER.LP_DATA_DIR,
    '1_3_5537_1_3_0', 'lp_pool_133_1h.json');
const FALLBACK_ER_PERIOD = 781;
function parseArgs() {
    const args = process.argv.slice(2);
    const opts: { data: string; amas: string[] | null } = { data: DEFAULT_DATA, amas: null };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--data' && args[i + 1]) opts.data = args[++i];
        if (args[i] === '--amas' && args[i + 1]) opts.amas = args[++i].split(',');
    }
    return opts;
}
/**
 * Compute per-bar SC values and return { scAvg, erValues, avgER }.
 * scAvg = mean of (ER × deltaSC + slowSC)² across all bars.
 */
function computeSCstats(closes: any, erPeriod: any, fastPeriod: any, slowPeriod: any) {
    const fastSC = 2 / (fastPeriod + 1);
    const slowSC = 2 / (slowPeriod + 1);
    const deltaSC = fastSC - slowSC;
    let sumSC = 0;
    const erValues: number[] = [];
    for (let i = erPeriod; i < closes.length; i++) {
        const dir = Math.abs(closes[i] - closes[i - erPeriod]);
        let vol = 0;
        for (let j = i - erPeriod + 1; j <= i; j++) {
            vol += Math.abs(closes[j] - closes[j - 1]);
        }
        const er = vol === 0 ? 0 : dir / vol;
        erValues.push(er);
        sumSC += (er * deltaSC + slowSC) ** 2;
    }
    const count = erValues.length;
    const scAvg = count > 0 ? sumSC / count : 0;
    const avgER = count > 0 ? erValues.reduce((a, b) => a + b) / count : 0;
    return { scAvg, erValues, avgER, count };
}
/**
 * Format a column-aligned markdown table row.
 */
function row(cells: any, widths: any) {
    const parts = cells.map((c: any, i: any) => {
        const s = String(c);
        return i < widths.length ? s.padEnd(widths[i]) : s;
    });
    return `| ${parts.join(' | ')} |`;
}
function main() {
    const opts = parseArgs();
    // ── Load and validate data ──────────────────────────────────────────
    let data;
    try {
        data = readJSON(opts.data);
    } catch (err: unknown) {
        const e = err as any;
        if (e.code === 'ENOENT') {
            console.error(`Data file not found: ${opts.data}`);
            console.error('Export LP candles first, or point --data at an existing file.');
            console.error('  tsx market_adapter/inputs/fetch_lp_data.ts --pool 133 --precA 4 --precB 5 --interval 1h --lookback 26280h');
        } else if (e instanceof SyntaxError) {
            console.error(`Failed to parse JSON from: ${opts.data}`);
            console.error(e.message);
        } else {
            console.error(`Error reading data file: ${e.message}`);
        }
        process.exit(1);
    }
    const closes = (data.candles || []).map((c: any) => Number(c[4]))
        .filter((v: any) => Number.isFinite(v) && v > 0);
    if (closes.length < 100) {
        console.error(`Not enough candles (need > 100, got ${closes.length})`);
        process.exit(1);
    }
    const amas = MARKET_ADAPTER.AMAS as Record<string, typeof MARKET_ADAPTER.AMAS.AMA1>;
    const keys = opts.amas || Object.keys(amas);
    const eps = MARKET_ADAPTER.AMA_CONVERGENCE_EPSILON;
    console.log(`Data:    ${opts.data}`);
    console.log(`Candles: ${closes.length}  |  EPSILON: ${eps}`);
    console.log('');
    // ── ER distribution display (using first AMA's erPeriod) ──────────
    const refKey = keys[0];
    const refCfg = amas[refKey];
    const erP = refCfg?.erPeriod || FALLBACK_ER_PERIOD;
    const { erValues, avgER: refAvgER } = computeSCstats(closes, erP, refCfg.fastPeriod, refCfg.slowPeriod);
    erValues.sort((a, b) => a - b);
    const n = erValues.length;
    const p5  = erValues[Math.floor(0.05 * n)].toFixed(4);
    const p50 = erValues[Math.floor(0.50 * n)].toFixed(4);
    const p95 = erValues[Math.floor(0.95 * n)].toFixed(4);
    console.log(`--- ER distribution (erPeriod=${erP}) ---`);
    console.log(`  p5 ${p5}  p50 ${p50}  p95 ${p95}  avg ${refAvgER.toFixed(4)}`);
    console.log('');
    // ── Per-AMA analysis (compute once, cache results) ─────────────────
    const results: any[] = [];
    // Validate erPeriod / fastPeriod consistency for meaningful naiveSC comparison
    const erPeriods = new Set();
    const fastPeriods = new Set();
    for (const key of keys) {
        if (amas[key]) {
            erPeriods.add(amas[key].erPeriod);
            fastPeriods.add(amas[key].fastPeriod);
        }
    }
    const consistentER = erPeriods.size === 1 && fastPeriods.size === 1;
    for (const key of keys) {
        const cfg = amas[key];
        if (!cfg) continue;
        const { scAvg, avgER, count } = computeSCstats(closes, cfg.erPeriod, cfg.fastPeriod, cfg.slowPeriod);
        const fastSC = 2 / (cfg.fastPeriod + 1);
        const slowSC = 2 / (cfg.slowPeriod + 1);
        const deltaSC = fastSC - slowSC;
        const naiveSC = (avgER * deltaSC + slowSC) ** 2;
        const impliedER = Math.max(0, Math.min(1, (Math.sqrt(scAvg) - slowSC) / deltaSC));
        const convBars = Math.ceil(Math.log(eps) / Math.log(1 - scAvg));
        results.push({ key, cfg, fastSC, slowSC, deltaSC, scAvg, avgER, naiveSC, impliedER, convBars, count });
    }
    // ── Print analysis table ───────────────────────────────────────────
    console.log('--- Per-AMA SC analysis ---');
    if (!consistentER) {
        console.log('(note: selected AMAs have different erPeriod/fastPeriod — naiveSC column is per-AMA)');
    }
    const hdr = row(['AMA', 'fastSC', 'slowSC', 'emp SC_avg', 'naive SC (E[ER])', 'implied ER', 'conv bars'],
        [5, 8, 8, 11, 17, 11, 10]);
    const sep = row(['-----', '--------', '--------', '-----------', '-----------------', '-----------', '----------'],
        [5, 8, 8, 11, 17, 11, 10]);
    console.log(hdr);
    console.log(sep);
    for (const r of results) {
        console.log(row([
            r.key,
            r.fastSC.toFixed(4),
            r.slowSC.toFixed(4),
            r.scAvg.toExponential(4),
            r.naiveSC.toExponential(4),
            r.impliedER.toFixed(4),
            r.convBars,
        ], [5, 8, 8, 11, 17, 11, 10]));
    }
    // ── Recommended constant ───────────────────────────────────────────
    const avgImpliedER = results.reduce((a, r) => a + r.impliedER, 0) / results.length;
    const recRounded = roundTo(avgImpliedER, 1000);
    console.log('');
    console.log('--- Recommended constant ---');
    console.log(`  Average implied ER: ${avgImpliedER.toFixed(4)}`);
    console.log(`  Rounded:            ${recRounded.toFixed(3)}`);
    console.log('');
    console.log(`  Current in constants.ts: AMA_CONVERGENCE_ER_AVG = ${MARKET_ADAPTER.AMA_CONVERGENCE_ER_AVG}`);
    console.log(`  Suggested update:        AMA_CONVERGENCE_ER_AVG = ${recRounded.toFixed(3)}`);
    // ── Convergence bars comparison (using cached results) ─────────────
    console.log('');
    console.log('--- Convergence bars comparison (current vs recommended ER) ---');
    const cmpHdr = row(['AMA', `curr ER=${MARKET_ADAPTER.AMA_CONVERGENCE_ER_AVG}`, `rec ER=${recRounded.toFixed(3)}`, 'empirical'],
        [5, 14, 14, 10]);
    const cmpSep = row(['-----', '--------------', '--------------', '----------'],
        [5, 14, 14, 10]);
    console.log(cmpHdr);
    console.log(cmpSep);
    for (const r of results) {
        const curSC = (MARKET_ADAPTER.AMA_CONVERGENCE_ER_AVG * r.deltaSC + r.slowSC) ** 2;
        const curBars = Math.ceil(Math.log(eps) / Math.log(1 - curSC));
        const recSC = (recRounded * r.deltaSC + r.slowSC) ** 2;
        const recBars = Math.ceil(Math.log(eps) / Math.log(1 - recSC));
        console.log(row([
            r.key,
            curBars + r.cfg.erPeriod,
            recBars + r.cfg.erPeriod,
            r.convBars + r.cfg.erPeriod,
        ], [5, 14, 14, 10]));
    }
}
main();
