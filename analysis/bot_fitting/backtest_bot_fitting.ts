import fs from 'node:fs';
import path from 'node:path';
import { calculateAMA } from '../../market_adapter/core/strategies/ama.js';
import { range } from '../math_utils.js';
import { parseListOrRange, loadLpData, fmt } from './shared_utils.js';
import { getStorage } from '../../modules/storage/index.js';
const { ensureDir, readJSON, writeJSON } = getStorage();

'use strict';

const DEFAULT_ACTIVE_ORDERS = 5;
const DEFAULT_FEE_ROUNDTRIP_PCT = 0.20;
const DEFAULT_MIN_SPREAD_FACTOR = 2.1;

// Inventory-risk penalty weights (in score points)
const RISK_W_DURATION = 1.0;   // avg open bars
const RISK_W_PEAK_OPEN = 2.0;  // peak simultaneous open orders
const RISK_W_IMBALANCE = 1.2;  // avg |openBuy-openSell|
const RISK_W_CANCEL = 0.15;    // canceled on reposition

const DEFAULT_SPREAD_VALUES = range(0.4, 1.6, 0.1);
const DEFAULT_INCREMENT_VALUES = range(0.2, 0.8, 0.1);
const DEFAULT_RATIO_VALUES = [1.5, 1.75, 2, 2.5, 3, 4, 5, 8, 10];

function parseArgs() {
    const args = process.argv.slice(2);
    const out: {
        dataPath: string | null;
        resultsPath: string | null;
        spreadValues: number[];
        incrementValues: number[];
        ratioValues: number[];
        activeOrders: number;
        feeRoundtripPct: number;
        minSpreadFactor: number;
        riskWDuration: number;
        riskWPeakOpen: number;
        riskWImbalance: number;
        riskWCancel: number;
    } = {
        dataPath: null,
        resultsPath: null,
        spreadValues: DEFAULT_SPREAD_VALUES,
        incrementValues: DEFAULT_INCREMENT_VALUES,
        ratioValues: DEFAULT_RATIO_VALUES,
        activeOrders: DEFAULT_ACTIVE_ORDERS,
        feeRoundtripPct: DEFAULT_FEE_ROUNDTRIP_PCT,
        minSpreadFactor: DEFAULT_MIN_SPREAD_FACTOR,
        riskWDuration: RISK_W_DURATION,
        riskWPeakOpen: RISK_W_PEAK_OPEN,
        riskWImbalance: RISK_W_IMBALANCE,
        riskWCancel: RISK_W_CANCEL,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const val = args[i + 1];
        if (!val) continue;
        switch (arg) {
            case '--data':
                out.dataPath = path.resolve(val);
                i++;
                break;
            case '--results':
                out.resultsPath = path.resolve(val);
                i++;
                break;
            case '--spread':
                out.spreadValues = parseListOrRange(val, DEFAULT_SPREAD_VALUES);
                i++;
                break;
            case '--increment':
                out.incrementValues = parseListOrRange(val, DEFAULT_INCREMENT_VALUES);
                i++;
                break;
            case '--ratio':
                out.ratioValues = parseListOrRange(val, DEFAULT_RATIO_VALUES);
                i++;
                break;
            case '--active-orders':
                out.activeOrders = Number(val);
                i++;
                break;
            case '--fee':
                out.feeRoundtripPct = Number(val);
                i++;
                break;
            case '--min-spread-factor':
                out.minSpreadFactor = Number(val);
                i++;
                break;
            case '--risk-duration':
                out.riskWDuration = Number(val);
                i++;
                break;
            case '--risk-peak-open':
                out.riskWPeakOpen = Number(val);
                i++;
                break;
            case '--risk-imbalance':
                out.riskWImbalance = Number(val);
                i++;
                break;
            case '--risk-cancel':
                out.riskWCancel = Number(val);
                i++;
                break;
        }
    }

    if (!out.dataPath) {
        throw new Error('--data <path-to-lp-candles.json> is required');
    }

    if (!out.resultsPath) {
        out.resultsPath = resolveAutoResultsPath(out.dataPath);
    }

    return out;
}

/**
 * Auto-derive the AMA optimizer results file for a given LP candle data file.
 *
 * The optimizer names results `optimization_results_<base>_w<λ1>_<λ2>_<λ3>_<λ4>.json`
 * (per-AMA distance weights appended as a `_w...` suffix). To stay robust against
 * weight overrides, pick the most recently written `optimization_results_<base>_w*.json`
 * in `ama_fitting/`; fall back to the legacy `optimization_results_<base>.json` name
 * if no suffixed file exists.
 */
function resolveAutoResultsPath(dataPath: string): string {
    const base = path.basename(dataPath, '.json');
    const dir = path.join(__dirname, '..', 'ama_fitting');
    const prefix = `optimization_results_${base}_w`;
    let newest: { file: string; mtimeMs: number } | null = null;
    try {
        for (const entry of fs.readdirSync(dir)) {
            if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
            const full = path.join(dir, entry);
            const stat = fs.statSync(full);
            if (!newest || stat.mtimeMs > newest.mtimeMs) {
                newest = { file: full, mtimeMs: stat.mtimeMs };
            }
        }
    } catch {
        // dir unreadable — fall through to legacy name check
    }
    if (newest) return newest.file;
    return path.join(dir, `optimization_results_${base}.json`);
}

function loadAmaStrategies(resultsPath) {
    const json = readJSON(resultsPath);
    const amas = (json.meta?.amas ?? {}) as any;
    const labels = { AMA1: 'AMA1', AMA2: 'AMA2', AMA3: 'AMA3', AMA4: 'AMA4' as string };

    const out: any[] = [];
    for (const [key, val] of Object.entries(amas)) {
        const a = val as any;
        if (!a || !Number.isFinite(a.er) || !Number.isFinite(a.fast) || !Number.isFinite(a.slow)) continue;
        out.push({
            id: key,
            name: labels[key as keyof typeof labels] ?? key,
            er: a.er,
            fast: a.fast,
            slow: a.slow,
        });
    }

    if (out.length !== 4) {
        throw new Error(`Expected 4 AMA strategies in results meta.amas, found ${out.length}`);
    }
    return out;
}

function levelGrossSpreadPct(levelRatio) {
    return (((1 + levelRatio) / (1 - levelRatio)) - 1) * 100;
}

function simulateForParams(candles, amaValues, params) {
    const { spreadPct, incrementPct, maxMinRatio, activeOrders, feeRoundtripPct, risk } = params;
    const skip = Math.max(20, Math.floor(candles.length * 0.1));
    const levels = Array.from({ length: activeOrders }, (_, i) => incrementPct * (i + 1));

    const openBuy = new Map();   // lvl -> openedAtBarIdx
    const openSell = new Map();  // lvl -> openedAtBarIdx

    let touchedOrders = 0;
    let matchedPairs = 0;
    let canceledOnReposition = 0;
    let totalGrossCapturePct = 0;
    let totalNetCapturePct = 0;
    let activeLevelTouches = 0;
    let peakOpenOrders = 0;
    let imbalanceSum = 0;
    let imbalanceSamples = 0;
    let matchedOpenDurationBars = 0;

    for (let i = skip + 1; i < candles.length; i++) {
        const ama = amaValues[i];
        const prevAma = amaValues[i - 1];
        const hi = candles[i].high;
        const lo = candles[i].low;

        if (Math.abs(ama - prevAma) / prevAma > incrementPct) {
            canceledOnReposition += openBuy.size + openSell.size;
            openBuy.clear();
            openSell.clear();
        }

        const currentOpen = openBuy.size + openSell.size;
        if (currentOpen > peakOpenOrders) peakOpenOrders = currentOpen;
        imbalanceSum += Math.abs(openBuy.size - openSell.size);
        imbalanceSamples++;

        const minBound = ama / maxMinRatio;
        const maxBound = ama * maxMinRatio;

        for (let lvl = 0; lvl < levels.length; lvl++) {
            const r = levels[lvl];
            if (r >= 0.95) continue;
            const buyPrice = ama * (1 - r);
            const sellPrice = ama * (1 + r);

            if (buyPrice < minBound || sellPrice > maxBound) continue;

            const grossPct = levelGrossSpreadPct(r);
            if (grossPct < spreadPct) continue;

            const touchBuy = lo <= buyPrice;
            const touchSell = hi >= sellPrice;
            if (!touchBuy && !touchSell) continue;

            activeLevelTouches++;

            if (touchBuy && !openBuy.has(lvl)) {
                touchedOrders++;
                if (openSell.has(lvl)) {
                    const openedAt = openSell.get(lvl);
                    matchedOpenDurationBars += (i - openedAt);
                    matchedPairs++;
                    openSell.delete(lvl);
                    totalGrossCapturePct += grossPct;
                } else {
                    openBuy.set(lvl, i);
                }
            }

            if (touchSell && !openSell.has(lvl)) {
                touchedOrders++;
                if (openBuy.has(lvl)) {
                    const openedAt = openBuy.get(lvl);
                    matchedOpenDurationBars += (i - openedAt);
                    matchedPairs++;
                    openBuy.delete(lvl);
                    totalGrossCapturePct += grossPct;
                } else {
                    openSell.set(lvl, i);
                }
            }
        }
    }

    // Profit model requested: totalProfit = fills * (spread - increment)
    // (all values in percentage points)
    const incrementPctPoints = incrementPct * 100;
    const netPerFillPct = Math.max(0, spreadPct - incrementPctPoints - feeRoundtripPct);
    totalNetCapturePct = matchedPairs * netPerFillPct;

    const fillEfficiency = touchedOrders > 0 ? (matchedPairs / touchedOrders) * 100 : 0;
    const avgNetPerPair = matchedPairs > 0 ? totalNetCapturePct / matchedPairs : 0;
    const utilization = (activeLevelTouches / Math.max(1, (candles.length - skip))) * 100;
    const baseScore = totalNetCapturePct * (fillEfficiency / 100);
    const avgOpenDurationBars = matchedPairs > 0 ? (matchedOpenDurationBars / matchedPairs) : 0;
    const avgImbalance = imbalanceSamples > 0 ? (imbalanceSum / imbalanceSamples) : 0;
    const riskPenalty =
        (avgOpenDurationBars * risk.duration) +
        (peakOpenOrders * risk.peakOpen) +
        (avgImbalance * risk.imbalance) +
        (canceledOnReposition * risk.cancel);
    const score = baseScore - riskPenalty;

    return {
        spreadPct,
        incrementPct,
        maxMinRatio,
        touchedOrders,
        matchedPairs,
        fillEfficiency,
        totalGrossCapturePct,
        totalNetCapturePct,
        avgNetPerPair,
        canceledOnReposition,
        avgOpenDurationBars,
        peakOpenOrders,
        avgImbalance,
        riskPenalty,
        baseScore,
        utilization,
        score,
    };
}

function run() {
    const cfg = parseArgs();
    if (!Number.isFinite(cfg.minSpreadFactor) || cfg.minSpreadFactor <= 0) {
        throw new Error(`Invalid min spread factor: ${cfg.minSpreadFactor}`);
    }
    for (const [k, v] of Object.entries({
        riskDuration: cfg.riskWDuration,
        riskPeakOpen: cfg.riskWPeakOpen,
        riskImbalance: cfg.riskWImbalance,
        riskCancel: cfg.riskWCancel,
    })) {
        if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid ${k}: ${v}`);
    }
    const loaded = loadLpData(cfg.dataPath!);
    const candles = loaded.candles;
    const closes = candles.map((c) => c.close);
    const strategies = loadAmaStrategies(cfg.resultsPath!);

    const totalCombos = cfg.spreadValues.length * cfg.incrementValues.length * cfg.ratioValues.length;

    console.log('================================================================================');
    console.log(' BOT FITTING BACKTEST (1h LP candles)');
    console.log('================================================================================');
    console.log(`  Data:         ${path.basename(cfg.dataPath!)} (${candles.length} candles)`);
    console.log(`  Results file: ${path.basename(cfg.resultsPath!)}`);
    console.log(`  Spread grid:  ${cfg.spreadValues[0]}..${cfg.spreadValues[cfg.spreadValues.length - 1]}% (${cfg.spreadValues.length})`);
    console.log(`  Increment:    ${cfg.incrementValues[0]}..${cfg.incrementValues[cfg.incrementValues.length - 1]}% (${cfg.incrementValues.length})`);
    console.log(`  Max/Min ratio:${cfg.ratioValues[0]}..${cfg.ratioValues[cfg.ratioValues.length - 1]} (${cfg.ratioValues.length})`);
    console.log(`  Active orders:${cfg.activeOrders} per side`);
    console.log(`  Fee RT:       ${cfg.feeRoundtripPct}%`);
    console.log(`  Spread floor: spread >= ${cfg.minSpreadFactor} x increment`);
    console.log(`  Risk W:       duration=${cfg.riskWDuration}, peakOpen=${cfg.riskWPeakOpen}, imbalance=${cfg.riskWImbalance}, cancel=${cfg.riskWCancel}`);
    console.log(`  Combos/AMA:   ${totalCombos}\n`);

    const byAma: any[] = [];

    for (const s of strategies) {
        const amaValues = calculateAMA(closes, { erPeriod: s.er, fastPeriod: s.fast, slowPeriod: s.slow });
        let best: any = null;

        for (const spreadPct of cfg.spreadValues) {
            for (const incrementPct of cfg.incrementValues) {
                for (const maxMinRatio of cfg.ratioValues) {
                    if (spreadPct + Number.EPSILON < (cfg.minSpreadFactor * incrementPct)) continue;
                    const sim = simulateForParams(candles, amaValues, {
                        spreadPct,
                        incrementPct: incrementPct / 100,
                        maxMinRatio,
                        activeOrders: cfg.activeOrders,
                        feeRoundtripPct: cfg.feeRoundtripPct,
                        risk: {
                            duration: cfg.riskWDuration,
                            peakOpen: cfg.riskWPeakOpen,
                            imbalance: cfg.riskWImbalance,
                            cancel: cfg.riskWCancel,
                        },
                    });
                    if (!best || sim.score > best.score) best = sim;
                }
            }
        }

        byAma.push({ strategy: s, best });
    }

    console.log('BEST PARAMS PER AMA');
    console.log('--------------------------------------------------------------------------------');
    console.log('AMA                              | spread | incr | ratio | pairs | fill% | net%   | risk  | score');
    console.log('---------------------------------|--------|------|-------|-------|-------|--------|-------|-------');
    for (const row of byAma) {
        const b = row.best;
        if (!b) continue;
        console.log(
            `${row.strategy.name.padEnd(33)}| ` +
            `${fmt(b.spreadPct, 2).padStart(6)} | ` +
            `${fmt(b.incrementPct * 100, 2).padStart(4)} | ` +
            `${fmt(b.maxMinRatio, 2).padStart(5)} | ` +
            `${String(b.matchedPairs).padStart(5)} | ` +
            `${fmt(b.fillEfficiency, 1).padStart(5)} | ` +
            `${fmt(b.totalNetCapturePct, 1).padStart(6)} | ` +
            `${fmt(b.riskPenalty, 1).padStart(5)} | ` +
            `${fmt(b.score, 1).padStart(5)}`
        );
    }
    console.log();

    const outName = `bot_fitting_results_${path.basename(cfg.dataPath!, '.json')}.json`;
    const outPath = path.join(__dirname, outName);
    ensureDir(__dirname);
    writeJSON(outPath, {
        meta: {
            generatedAt: new Date().toISOString(),
            dataPath: path.relative(process.cwd(), cfg.dataPath!),
            resultsPath: path.relative(process.cwd(), cfg.resultsPath!),
            candles: candles.length,
            activeOrders: cfg.activeOrders,
            feeRoundtripPct: cfg.feeRoundtripPct,
            search: {
                spreadValues: cfg.spreadValues,
                incrementValues: cfg.incrementValues,
                ratioValues: cfg.ratioValues,
                minSpreadFactor: cfg.minSpreadFactor,
                combosPerAma: totalCombos,
            },
            scoring: {
                baseScore: 'totalNetCapturePct * (fillEfficiency / 100)',
                totalNetCapturePct: 'matchedPairs * (spread - increment - fee)',
                riskPenalty: `avgOpenDurationBars*${cfg.riskWDuration} + peakOpenOrders*${cfg.riskWPeakOpen} + avgImbalance*${cfg.riskWImbalance} + canceledOnReposition*${cfg.riskWCancel}`,
                finalScore: 'baseScore - riskPenalty',
            },
        },
        results: byAma,
    });

    console.log(`Saved: ${path.relative(process.cwd(), outPath)}`);
}

run();
