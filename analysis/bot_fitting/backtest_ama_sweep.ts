
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { calculateAMA } from '../../market_adapter/core/strategies/ama.js';
import { range } from '../math_utils.js';
import { parseListOrRange, loadLpData, fmt } from './shared_utils.js';
import { getStorage } from '../../modules/storage/index.js';
const { readJSON, writeJSON } = getStorage();
'use strict';

/**
 * AMA SWEEP BACKTEST — persistent grid simulation
 *
 * Models the real bot mechanics:
 *   - Orders sit at FIXED chain prices until canceled or filled
 *   - When AMA drifts past reposition threshold, grid re-centers
 *   - Grid compression: AMA shift pushes one side's orders closer to market
 *   - Order sizing depends on capital, ratio (range width), and weight profile
 *   - Three weight profiles: valley, neutral, mountain (symmetric buy/sell)
 *
 * Usage:
 *   tsx analysis/bot_fitting/backtest_ama_sweep.ts --data <path-to-lp-candles.json>
 *   tsx analysis/bot_fitting/backtest_ama_sweep.ts --data <path-to-lp-candles.json> --spread 4:16:1 --increment 0.5:4:0.25
 */


const DEFAULT_MAX_ORDERS = 20; // matches bot default activeOrders per side
const DEFAULT_FEE_ROUNDTRIP_PCT = 0.20;
const DEFAULT_MIN_SPREAD_FACTOR = 2.1;
const DEFAULT_CAPITAL = 10000; // notional units per side
const DEFAULT_BTS_CREATE_FEE = 0.48260;
const DEFAULT_BTS_CANCEL_FEE = 0.00482;
const DEFAULT_BTS_MAKER_CREATE_FACTOR = 0.10;
const DEFAULT_TX_FEE_PRICE = 1.0;

// Weight profiles (symmetric for both sides)
//   valley:   heavier at edges (outer levels), lighter near center
//   neutral:  equal across all levels
//   mountain: heavier near center, lighter at edges
const WEIGHT_PROFILES = {
    valley:   -0.8,   // negative = invert decay → outer levels get more
    neutral:   0,     // flat = equal distribution
    mountain:  1.5,   // strong decay → inner levels get more
};

// Search grid defaults — centered around bot defaults (spread=2%, increment=0.5%)
// Spread = distance from center to first order on each side (half the bid-ask gap)
// Increment = distance between successive orders on the same side
const DEFAULT_SPREAD_VALUES = [...range(0.5, 4, 0.25), ...range(5, 12, 1)];
const DEFAULT_INCREMENT_VALUES = [...range(0.2, 2, 0.1), ...range(2.5, 8, 0.5)];
const DEFAULT_RATIO_VALUES = [1.05, 1.1, 1.15, 1.2, 1.3, 1.5, 2, 3, 5, 10];
// Reposition threshold: AMA must move this fraction from last grid center to trigger re-center
const DEFAULT_REPOSITION_PCT = 2.5;


function parseArgs() {
    const args = process.argv.slice(2);
    const out: {
        dataPath: string | null;
        resultsPath: string | null;
        spreadValues: number[];
        incrementValues: number[];
        ratioValues: number[];
        maxOrders: number;
        feeRoundtripPct: number;
        minSpreadFactor: number;
        capital: number;
        repositionPct: number;
        btsCreateFee: number;
        btsCancelFee: number;
        makerCreateFactor: number;
        txFeePrice: number;
        topN: number;
    } = {
        dataPath: null,
        resultsPath: null,
        spreadValues: DEFAULT_SPREAD_VALUES,
        incrementValues: DEFAULT_INCREMENT_VALUES,
        ratioValues: DEFAULT_RATIO_VALUES,
        maxOrders: DEFAULT_MAX_ORDERS,
        feeRoundtripPct: DEFAULT_FEE_ROUNDTRIP_PCT,
        minSpreadFactor: DEFAULT_MIN_SPREAD_FACTOR,
        capital: DEFAULT_CAPITAL,
        repositionPct: DEFAULT_REPOSITION_PCT,
        btsCreateFee: DEFAULT_BTS_CREATE_FEE,
        btsCancelFee: DEFAULT_BTS_CANCEL_FEE,
        makerCreateFactor: DEFAULT_BTS_MAKER_CREATE_FACTOR,
        txFeePrice: DEFAULT_TX_FEE_PRICE,
        topN: 15,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const val = args[i + 1];
        if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
        if (!val) continue;
        switch (arg) {
            case '--data': out.dataPath = path.resolve(val); i++; break;
            case '--results': out.resultsPath = path.resolve(val); i++; break;
            case '--spread': out.spreadValues = parseListOrRange(val, DEFAULT_SPREAD_VALUES); i++; break;
            case '--increment': out.incrementValues = parseListOrRange(val, DEFAULT_INCREMENT_VALUES); i++; break;
            case '--ratio': out.ratioValues = parseListOrRange(val, DEFAULT_RATIO_VALUES); i++; break;
            case '--max-orders': out.maxOrders = Number(val); i++; break;
            case '--fee': out.feeRoundtripPct = Number(val); i++; break;
            case '--min-spread-factor': out.minSpreadFactor = Number(val); i++; break;
            case '--capital': out.capital = Number(val); i++; break;
            case '--reposition': out.repositionPct = Number(val); i++; break;
            case '--bts-create-fee': out.btsCreateFee = Number(val); i++; break;
            case '--bts-cancel-fee': out.btsCancelFee = Number(val); i++; break;
            case '--maker-create-factor': out.makerCreateFactor = Number(val); i++; break;
            case '--tx-fee-price': out.txFeePrice = Number(val); i++; break;
            case '--top': out.topN = Number(val); i++; break;
        }
    }
    if (!out.dataPath) {
        throw new Error('--data <path-to-lp-candles.json> is required');
    }
    if (!out.resultsPath) {
        throw new Error('--results <path-to-optimization-results.json> is required');
    }
    return out;
}

function printHelp() {
    console.log('AMA Sweep Backtest — persistent grid simulation with weight profiles');
    console.log('');
    console.log('Usage:');
    console.log('  node dist/analysis/bot_fitting/backtest_ama_sweep.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --data <path>           LP candle JSON');
    console.log('  --results <path>        AMA optimizer results JSON');
    console.log('  --spread <spec>         Spread values (% ): 1:10:0.5 or 2,4,8');
    console.log('  --increment <spec>      Increment values (%): 0.5:5:0.5 or 1,2,3');
    console.log('  --ratio <spec>          Max/min ratio: 1.5,2,3,5');
    console.log('  --max-orders <n>        Max orders per side (default: 20, actual limited by ratio+increment)');
    console.log('  --fee <pct>             Round-trip fee % (default: 0.20)');
    console.log('  --min-spread-factor <n> Spread >= factor * increment (default: 2.1)');
    console.log('  --capital <n>           Notional capital per side (default: 10000)');
    console.log('  --reposition <pct>      AMA drift % to trigger re-center (default: 2.5)');
    console.log('  --bts-create-fee <n>    BTS create fee (default: 0.48260)');
    console.log('  --bts-cancel-fee <n>    BTS cancel fee (default: 0.00482)');
    console.log('  --maker-create-factor   Maker share of create fee (default: 0.10)');
    console.log('  --tx-fee-price <n>      Convert BTS fees into backtest units (default: 1.0)');
    console.log('  --top <n>               Show top N results (default: 15)');
}

function loadAmaStrategies(resultsPath: string) {
    const json = readJSON(resultsPath);
    const amas = (json.meta as any)?.amas;
    if (!amas) throw new Error('No meta.amas found in results file.');

    const out: any[] = [];
    for (const [key, val] of Object.entries(amas)) {
        const v = val as any;
        if (!v || !Number.isFinite(v.er)) continue;
        out.push({ id: key, name: v.label || key, er: v.er, fast: v.fast, slow: v.slow });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    if (out.length === 0) throw new Error('No valid AMA strategies found');
    return out;
}

// ── Order sizing with weight profiles ────────────────────────────────────────

/**
 * Allocate capital across N levels using weight profile.
 *   weight > 0: mountain (more near center, exponential decay outward)
 *   weight = 0: neutral (equal)
 *   weight < 0: valley (more at edges, inverted decay)
 *
 * @param {number} totalFunds   Capital for this side
 * @param {number} n            Number of levels
 * @param {number} weight       Profile weight factor
 * @param {number} incrementFactor  Increment as fraction (e.g. 0.02 for 2%)
 * @returns {number[]}          Size per level, index 0 = closest to center
 */
function allocateFundsByWeights(totalFunds: number, n: number, weight: number, incrementFactor: number): number[] {
    if (n <= 0) return [];
    if (weight === 0) {
        const sz = totalFunds / n;
        return new Array(n).fill(sz);
    }

    const base = 1 - incrementFactor;
    const absWeight = Math.abs(weight);
    const raw = new Array(n);
    for (let i = 0; i < n; i++) {
        // i=0 is closest to center
        raw[i] = Math.pow(base, i * absWeight);
    }
    if (weight < 0) {
        // Valley: reverse so outer levels (high i) get the large weights
        raw.reverse();
    }
    const total = raw.reduce((s, w) => s + w, 0) || 1;
    return raw.map((w) => (w / total) * totalFunds);
}

// ── Persistent grid simulation ───────────────────────────────────────────────

/**
 * Build a fresh grid centered at `center`.
 *
 * Grid placement (matches real bot):
 *   Level k (1-based):
 *     offset_k = spreadPct/2/100 + (k-1) * incrementPct
 *     buyPrice  = center * (1 - offset_k)
 *     sellPrice = center * (1 + offset_k)
 *
 * So spread controls the dead zone around center (no orders within spread/2),
 * and increment is the gap between successive orders on the same side.
 *
 * Returns arrays of buy and sell order objects with fixed chain prices and sizes.
 */
function buildGrid(center: number, params: any, capitalPerSide: number, weightFactor: number) {
    const { incrementPct, maxMinRatio, maxOrders, spreadPct } = params;
    const minBound = center / maxMinRatio;
    const maxBound = center * maxMinRatio;
    const halfSpread = spreadPct / 200; // as fraction

    const buys: any[] = [];
    const sells: any[] = [];

    // Fill as many levels as fit within ratio bounds (up to maxOrders cap)
    for (let k = 1; k <= maxOrders; k++) {
        const offset = halfSpread + (k - 1) * incrementPct;
        if (offset >= 0.95) continue;
        const buyPrice = center * (1 - offset);
        const sellPrice = center * (1 + offset);

        // Bounds check — skip levels outside ratio range
        if (buyPrice < minBound || sellPrice > maxBound) continue;

        buys.push({ level: k, price: buyPrice, filledBar: -1, size: 0 });
        sells.push({ level: k, price: sellPrice, filledBar: -1, size: 0 });
    }

    // Size allocation — index 0 = closest to center
    const buySizes = allocateFundsByWeights(capitalPerSide, buys.length, weightFactor, incrementPct);
    const sellSizes = allocateFundsByWeights(capitalPerSide, sells.length, weightFactor, incrementPct);
    buys.forEach((o, i) => { o.size = buySizes[i] || 0; });
    sells.forEach((o, i) => { o.size = sellSizes[i] || 0; });

    return { buys, sells };
}

function closeFilledInventoryAtPrice(openBuys: Map<any, any>, openSells: Map<any, any>, exitPrice: number, feeRoundtripPct: number) {
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
        return { grossUnits: 0, profitUnits: 0, closedOrders: 0 };
    }

    let grossUnits = 0;
    let profitUnits = 0;
    let closedOrders = 0;

    for (const order of openBuys.values()) {
        if (!order?.filled || !Number.isFinite(order.price) || order.price <= 0) continue;
        if (!Number.isFinite(order.size) || order.size <= 0) continue;
        const grossPct = (exitPrice / order.price - 1) * 100;
        const netPct = grossPct - feeRoundtripPct;
        grossUnits += order.size * (grossPct / 100);
        profitUnits += order.size * (netPct / 100);
        closedOrders++;
    }

    for (const order of openSells.values()) {
        if (!order?.filled || !Number.isFinite(order.price) || order.price <= 0) continue;
        if (!Number.isFinite(order.size) || order.size <= 0) continue;
        const grossPct = (order.price / exitPrice - 1) * 100;
        const netPct = grossPct - feeRoundtripPct;
        grossUnits += order.size * (grossPct / 100);
        profitUnits += order.size * (netPct / 100);
        closedOrders++;
    }

    return { grossUnits, profitUnits, closedOrders };
}

function countCancelableOrders(openBuys: Map<any, any>, openSells: Map<any, any>): number {
    let count = 0;
    for (const order of openBuys.values()) {
        if (!order?.filled) count++;
    }
    for (const order of openSells.values()) {
        if (!order?.filled) count++;
    }
    return count;
}

function simulatePersistentGrid(candles: any[], amaValues: number[], params: any, weightName: string, weightFactor: number) {
    const { spreadPct, incrementPct, maxMinRatio, maxOrders, feeRoundtripPct,
            capital, repositionThreshold, btsCreateFee, btsCancelFee,
            makerCreateFactor, txFeePrice } = params;
    const skip = Math.max(20, Math.floor(candles.length * 0.1));
    const capitalPerSide = capital;

    // State
    let gridCenter = amaValues[skip];
    let grid = buildGrid(gridCenter, params, capitalPerSide, weightFactor);
    let lastRepositionBar = skip;

    // Open orders: maps level -> { price, size, bar, side }
    const openBuys = new Map();
    const openSells = new Map();
    // Place initial orders
    for (const o of grid.buys) openBuys.set(o.level, { price: o.price, size: o.size, bar: skip });
    for (const o of grid.sells) openSells.set(o.level, { price: o.price, size: o.size, bar: skip });

    let matchedPairs = 0;
    let totalProfitUnits = 0; // profit in capital units (size * netPct)
    let totalGrossUnits = 0;
    let touchedOrders = 0;
    let canceledOnReposition = 0;
    let repositionCount = 0;
    let peakOpenOrders = 0;
    let imbalanceSum = 0;
    let imbalanceSamples = 0;
    let matchedOpenDurationBars = 0;
    let gridAgeSumBars = 0;
    let maxGridAgeBars = 0;
    let centerDriftSumPct = 0;
    let maxCenterDriftPct = 0;
    let nearThresholdBars = 0;
    let triggerDriftSumPct = 0;
    let runningProfit = 0;
    let peakEquityProfit = 0;
    let maxDrawdown = 0;
    // Track inventory risk: net exposure from filled-but-unmatched orders
    let inventoryExposure = 0; // positive = long (bought), negative = short (sold)
    let maxInventoryExposure = 0;

    const liveBars = candles.length - skip - 1;
    const ordersPerSide = grid.buys.length; // actual orders placed per side (clipped by ratio)
    const makerCreateFeeBts = btsCreateFee * makerCreateFactor;
    const newOrdersPerReposition = ordersPerSide * 2;

    for (let i = skip + 1; i < candles.length; i++) {
        const ama = amaValues[i];
        const hi = candles[i].high;
        const lo = candles[i].low;
        const gridAgeBars = i - lastRepositionBar;

        // ── Reposition check: AMA drifted too far from grid center ──────
        const drift = Math.abs(ama - gridCenter) / gridCenter;
        const driftPct = drift * 100;
        centerDriftSumPct += driftPct;
        if (driftPct > maxCenterDriftPct) maxCenterDriftPct = driftPct;
        gridAgeSumBars += gridAgeBars;
        if (gridAgeBars > maxGridAgeBars) maxGridAgeBars = gridAgeBars;
        if (drift >= repositionThreshold * 0.5) nearThresholdBars++;
        if (drift >= repositionThreshold) {
            triggerDriftSumPct += driftPct;
            canceledOnReposition += countCancelableOrders(openBuys, openSells);
            repositionCount++;
            const exitPrice = Number.isFinite(ama) && ama > 0 ? ama : candles[i].close;
            const forcedClose = closeFilledInventoryAtPrice(openBuys, openSells, exitPrice, feeRoundtripPct);
            totalGrossUnits += forcedClose.grossUnits;
            totalProfitUnits += forcedClose.profitUnits;
            runningProfit += forcedClose.profitUnits;
            // Unmatched inventory is realized on reposition (position closed at market)
            inventoryExposure = 0;
            openBuys.clear();
            openSells.clear();

            // Re-center grid
            gridCenter = ama;
            grid = buildGrid(gridCenter, params, capitalPerSide, weightFactor);
            lastRepositionBar = i;

            for (const o of grid.buys) openBuys.set(o.level, { price: o.price, size: o.size, bar: i });
            for (const o of grid.sells) openSells.set(o.level, { price: o.price, size: o.size, bar: i });
        }

        // ── Track imbalance & peak ──────────────────────────────────────
        const currentOpen = openBuys.size + openSells.size;
        if (currentOpen > peakOpenOrders) peakOpenOrders = currentOpen;
        imbalanceSum += Math.abs(openBuys.size - openSells.size);
        imbalanceSamples++;

        // ── Check fills on PERSISTENT orders (fixed chain prices) ───────
        // Only check UNFILLED orders (skip already-filled pending match)
        const filledBuysThisBar: any[] = [];
        const filledSellsThisBar: any[] = [];

        for (const [lvl, order] of openBuys) {
            if (!order.filled && lo <= order.price) {
                filledBuysThisBar.push({ lvl, order });
            }
        }
        for (const [lvl, order] of openSells) {
            if (!order.filled && hi >= order.price) {
                filledSellsThisBar.push({ lvl, order });
            }
        }

        // Process buy fills
        for (const fb of filledBuysThisBar) {
            touchedOrders++;
            inventoryExposure += fb.order.size; // bought → long exposure
            // Mark as filled, waiting for paired sell at same level
            openBuys.set(fb.lvl, { ...fb.order, filled: true, filledBar: i, side: 'buy' });
        }

        // Process sell fills
        for (const fs of filledSellsThisBar) {
            touchedOrders++;
            inventoryExposure -= fs.order.size; // sold → short exposure
            // Mark as filled, waiting for paired buy at same level
            openSells.set(fs.lvl, { ...fs.order, filled: true, filledBar: i, side: 'sell' });
        }

        // Match completed pairs: both buy AND sell at same level are filled
        for (let k = 1; k <= maxOrders; k++) {
            const buyEntry = openBuys.get(k);
            const sellEntry = openSells.get(k);
            if (!buyEntry?.filled || !sellEntry?.filled) continue;

            // Matched pair!
            openBuys.delete(k);
            openSells.delete(k);
            matchedPairs++;
            const duration = Math.abs(sellEntry.filledBar - buyEntry.filledBar);
            matchedOpenDurationBars += duration;
            const avgSize = (buyEntry.size + sellEntry.size) / 2;
            const pairGrossPct = (sellEntry.price / buyEntry.price - 1) * 100;
            const pairNetPct = pairGrossPct - feeRoundtripPct;
            const profitUnits = avgSize * (pairNetPct / 100);
            totalGrossUnits += avgSize * (pairGrossPct / 100);
            totalProfitUnits += profitUnits;
            runningProfit += profitUnits;
        }

        // Track max inventory exposure
        const absExposure = Math.abs(inventoryExposure);
        if (absExposure > maxInventoryExposure) maxInventoryExposure = absExposure;

        // ── Drawdown tracking ───────────────────────────────────────────
        const markPrice = Number.isFinite(candles[i].close) && candles[i].close > 0
            ? candles[i].close
            : ((Number.isFinite(ama) && ama > 0) ? ama : gridCenter);
        const unrealized = closeFilledInventoryAtPrice(openBuys, openSells, markPrice, feeRoundtripPct).profitUnits;
        const equityProfit = runningProfit + unrealized;
        if (equityProfit > peakEquityProfit) peakEquityProfit = equityProfit;
        const dd = peakEquityProfit - equityProfit;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const fillEfficiency = touchedOrders > 0 ? (matchedPairs / touchedOrders) * 100 : 0;
    const pairsPerDay = liveBars > 0 ? matchedPairs / (liveBars / 24) : 0;
    const avgOpenDurationBars = matchedPairs > 0 ? matchedOpenDurationBars / matchedPairs : 0;
    const avgImbalance = imbalanceSamples > 0 ? imbalanceSum / imbalanceSamples : 0;
    const avgProfitPerPair = matchedPairs > 0 ? totalProfitUnits / matchedPairs : 0;
    const profitPerCapital = capital > 0 ? totalProfitUnits / (capital * 2) : 0; // total capital = 2 sides
    const maxDrawdownPct = capital > 0 ? (maxDrawdown / (capital * 2)) * 100 : 0;
    const avgGridAgeBars = liveBars > 0 ? gridAgeSumBars / liveBars : 0;
    const avgCenterDriftPct = liveBars > 0 ? centerDriftSumPct / liveBars : 0;
    const nearThresholdBarsPct = liveBars > 0 ? (nearThresholdBars / liveBars) * 100 : 0;
    const avgTriggerDriftPct = repositionCount > 0 ? triggerDriftSumPct / repositionCount : 0;
    const avgCancelOrdersPerReposition = repositionCount > 0 ? canceledOnReposition / repositionCount : 0;
    const estimatedFeePerRepositionBts = newOrdersPerReposition * makerCreateFeeBts + avgCancelOrdersPerReposition * btsCancelFee;
    const totalRepositionFeesBts = repositionCount * estimatedFeePerRepositionBts;
    const feePerDayBts = liveBars > 0 ? totalRepositionFeesBts / (liveBars / 24) : 0;
    const totalRepositionFeeUnits = totalRepositionFeesBts * txFeePrice;
    const netProfitUnits = totalProfitUnits - totalRepositionFeeUnits;
    const netProfitPerCapital = capital > 0 ? netProfitUnits / (capital * 2) : 0;

    // Score: profit per capital scaled by activity (log pairs to avoid pure frequency chasing)
    const activityBonus = matchedPairs > 0 ? Math.log10(matchedPairs) : null;
    const grossScore = activityBonus == null ? -Infinity : (profitPerCapital * 100 * activityBonus - maxDrawdownPct * 0.5);
    const netScore = activityBonus == null ? -Infinity : (netProfitPerCapital * 100 * activityBonus - maxDrawdownPct * 0.5);
    const score = netScore;

    return {
        weightName,
        spreadPct,
        incrementPct: incrementPct * 100, // store as %
        maxMinRatio,
        matchedPairs,
        touchedOrders,
        fillEfficiency,
        totalProfitUnits,
        totalGrossUnits,
        profitPerCapital,
        pairsPerDay,
        avgOpenDurationBars,
        avgProfitPerPair,
        peakOpenOrders,
        avgImbalance,
        canceledOnReposition,
        repositionCount,
        maxDrawdown,
        maxDrawdownPct,
        maxInventoryExposure,
        avgGridAgeBars,
        maxGridAgeBars,
        avgCenterDriftPct,
        maxCenterDriftPct,
        nearThresholdBarsPct,
        avgTriggerDriftPct,
        makerCreateFeeBts,
        btsCancelFee,
        avgCancelOrdersPerReposition,
        estimatedFeePerRepositionBts,
        totalRepositionFeesBts,
        feePerDayBts,
        netProfitUnits,
        netProfitPerCapital,
        ordersPerSide,
        grossScore,
        netScore,
        score,
    };
}

// ── Per-AMA sweep logic (runs in main thread or worker) ─────────────────────

function sweepOneAma(strategy: any, candles: any[], closes: number[], weightEntries: [string, number][], cfg: any) {
    const amaValues = calculateAMA(closes, { erPeriod: strategy.er, fastPeriod: strategy.fast, slowPeriod: strategy.slow });
    let best: any = null;
    const top5: any[] = [];
    const allSims: any[] = [];
    let evaluated = 0;
    const minSpreadFactor = Number.isFinite(cfg.minSpreadFactor) && cfg.minSpreadFactor > 0 ? cfg.minSpreadFactor : null;

    for (const spreadPct of cfg.spreadValues) {
        for (const incrementPctRaw of cfg.incrementValues) {
            if (spreadPct < cfg.feeRoundtripPct + 0.01) continue;
            if (minSpreadFactor != null && spreadPct < (incrementPctRaw * minSpreadFactor)) continue;
            for (const maxMinRatio of cfg.ratioValues) {
                for (const [weightName, weightFactor] of weightEntries) {
                    evaluated++;
                    const sim = simulatePersistentGrid(candles, amaValues, {
                        spreadPct,
                        incrementPct: incrementPctRaw / 100,
                        maxMinRatio,
                        maxOrders: cfg.maxOrders,
                        feeRoundtripPct: cfg.feeRoundtripPct,
                        capital: cfg.capital,
                        repositionThreshold: cfg.repositionPct / 100,
                        btsCreateFee: cfg.btsCreateFee,
                        btsCancelFee: cfg.btsCancelFee,
                        makerCreateFactor: cfg.makerCreateFactor,
                        txFeePrice: cfg.txFeePrice,
                    }, weightName, weightFactor);

                    if (!best || sim.score > best.score) best = sim;

                    if (sim.matchedPairs > 0) {
                        const t5key = `${sim.spreadPct}|${sim.incrementPct}|${sim.maxMinRatio}|${sim.weightName}`;
                        const existing = top5.findIndex((t) =>
                            `${t.spreadPct}|${t.incrementPct}|${t.maxMinRatio}|${t.weightName}` === t5key);
                        if (existing < 0) {
                            top5.push(sim);
                            top5.sort((a, b) => b.score - a.score);
                            if (top5.length > 5) top5.length = 5;
                        }
                        allSims.push(sim);
                    }
                }
            }
        }
    }

    return { strategy, best, top5, allSims, evaluated };
}

// ── Worker thread handler ───────────────────────────────────────────────────

if (!isMainThread) {
    const { strategy, candles, closes, weightEntries, cfg } = workerData;
    const result = sweepOneAma(strategy, candles, closes, weightEntries, cfg);
        parentPort!.postMessage(result);
    process.exit(0);
}

// ── Parallel dispatch (main thread) ─────────────────────────────────────────

function runParallel(strategies: any[], candles: any[], closes: number[], weightEntries: [string, number][], cfg: any): Promise<any[]> {
    const numCpus = Math.min(os.cpus().length, strategies.length);
    console.log(`  Workers:      ${numCpus} threads (${os.cpus().length} CPUs available)\n`);

    return Promise.all(strategies.map((strategy) => {
        return new Promise((resolve, reject) => {
            const worker = new Worker(__filename, {
                workerData: { strategy, candles, closes, weightEntries, cfg },
            });
            worker.on('message', resolve);
            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
            });
        });
    }));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
    const cfg = parseArgs();

    const loaded = loadLpData(cfg.dataPath!);
    const candles = loaded.candles;
    const closes = candles.map((c: any) => c.close);
    const strategies = loadAmaStrategies(cfg.resultsPath!);

    const weightEntries = Object.entries(WEIGHT_PROFILES);
    const totalCombos = cfg.spreadValues.length * cfg.incrementValues.length *
        cfg.ratioValues.length * weightEntries.length;

    console.log('================================================================================');
    console.log(' AMA SWEEP BACKTEST — persistent grid + weight profiles');
    console.log('================================================================================');
    console.log(`  Data:         ${path.basename(cfg.dataPath!)} (${candles.length} candles, ~${(candles.length / 24).toFixed(0)} days)`);
    console.log(`  AMAs:         ${strategies.map((s) => s.id).join(', ')}`);
    console.log(`  Weights:      ${weightEntries.map(([n, w]) => `${n}(${w})`).join(', ')}`);
    console.log(`  Spread:       ${cfg.spreadValues[0]}..${cfg.spreadValues[cfg.spreadValues.length - 1]}% (${cfg.spreadValues.length})`);
    console.log(`  Increment:    ${cfg.incrementValues[0]}..${cfg.incrementValues[cfg.incrementValues.length - 1]}% (${cfg.incrementValues.length})`);
    console.log(`  Ratio:        ${cfg.ratioValues[0]}..${cfg.ratioValues[cfg.ratioValues.length - 1]} (${cfg.ratioValues.length})`);
    console.log(`  Max orders:   ${cfg.maxOrders}/side (actual count from ratio+increment) | Capital: ${cfg.capital}/side | Fee: ${cfg.feeRoundtripPct}%`);
    console.log(`  Spread floor: > fee (${cfg.feeRoundtripPct}%)`);
    console.log(`  Reposition:   ${cfg.repositionPct}% AMA drift from grid center`);
    console.log(`  Tx model:     create=${fmt(cfg.btsCreateFee, 5)} BTS, cancel=${fmt(cfg.btsCancelFee, 5)} BTS, maker=${fmt(cfg.makerCreateFactor * 100, 1)}%, 1 BTS=${fmt(cfg.txFeePrice, 2)} units`);
    console.log(`  Combos/AMA:   ${totalCombos}  |  Total: ${totalCombos * strategies.length}\n`);

    // ── Run AMA sweeps in parallel (one worker per AMA strategy) ──────
    const byAma: any[] = [];
    const allResults: any[] = [];

    const workerResults = await runParallel(strategies, candles, closes, weightEntries, cfg);

    for (const wr of workerResults) {
        byAma.push(wr);
        for (const sim of wr.allSims) {
            allResults.push({ strategy: wr.strategy, sim });
        }
        const b = wr.best;
        const bestLabel = b && b.matchedPairs > 0
            ? `score=${fmt(b.score, 1)} pairs=${b.matchedPairs} net/cap=${fmt(b.netProfitPerCapital * 100, 1)}% gross=${fmt(b.profitPerCapital * 100, 1)}%`
            : 'no fills';
        process.stdout.write(`  ${wr.strategy.id} (ER=${wr.strategy.er}, F=${wr.strategy.fast}, S=${wr.strategy.slow}): ${wr.evaluated} combos, ${bestLabel}\n`);
    }

    // ── Per-AMA best ────────────────────────────────────────────────────────
    console.log('\n================================================================================');
    console.log(' BEST PARAMS PER AMA');
    console.log('================================================================================');
    console.log('AMA   | wt    | spr%  | inc%  | ratio | nOrd |  pairs | net/cap | gross/cap | drift | fee/d | score');
    console.log('------+-------+-------+-------+-------+------+--------+---------+-----------+-------+-------+------');
    for (const row of byAma) {
        const b = row.best;
        if (!b || b.matchedPairs === 0) {
            console.log(`${row.strategy.id.padEnd(5)} | (no fills)`);
            continue;
        }
        console.log(
            `${row.strategy.id.padEnd(5)} | ` +
            `${b.weightName.padEnd(5)} | ` +
            `${fmt(b.spreadPct, 1).padStart(5)} | ` +
            `${fmt(b.incrementPct, 1).padStart(5)} | ` +
            `${fmt(b.maxMinRatio, 2).padStart(5)} | ` +
            `${String(b.ordersPerSide).padStart(4)} | ` +
            `${String(b.matchedPairs).padStart(6)} | ` +
            `${fmt(b.netProfitPerCapital * 100, 2).padStart(7)}% | ` +
            `${fmt(b.profitPerCapital * 100, 2).padStart(10)}% | ` +
            `${fmt(b.avgCenterDriftPct, 2).padStart(5)}% | ` +
            `${fmt(b.feePerDayBts, 2).padStart(5)} | ` +
            `${fmt(b.score, 1).padStart(6)}`
        );
    }

    // ── Top 5 per AMA ───────────────────────────────────────────────────────
    for (const row of byAma) {
        if (row.top5.length === 0) continue;
        console.log(`\n  ${row.strategy.id} — Top 5:`);
        console.log('  # | wt    | spr%  | inc%  | ratio | nOrd |  pairs | net/cap | drift | gAge | fee/d | score');
        console.log('  --+-------+-------+-------+-------+------+--------+---------+-------+------+-------+------');
        row.top5.forEach((b: any, idx: number) => {
            console.log(
                `  ${idx + 1} | ` +
                `${b.weightName.padEnd(5)} | ` +
                `${fmt(b.spreadPct, 1).padStart(5)} | ` +
                `${fmt(b.incrementPct, 1).padStart(5)} | ` +
                `${fmt(b.maxMinRatio, 2).padStart(5)} | ` +
                `${String(b.ordersPerSide).padStart(4)} | ` +
                `${String(b.matchedPairs).padStart(6)} | ` +
                `${fmt(b.netProfitPerCapital * 100, 2).padStart(7)}% | ` +
                `${fmt(b.avgCenterDriftPct, 2).padStart(5)}% | ` +
                `${fmt(b.avgGridAgeBars, 0).padStart(4)} | ` +
                `${fmt(b.feePerDayBts, 2).padStart(5)} | ` +
                `${fmt(b.score, 1).padStart(6)}`
            );
        });
    }

    // ── Global ranking (deduplicated) ───────────────────────────────────────
    allResults.sort((a, b) => b.sim.score - a.sim.score);
    const seen = new Set();
    const deduped: any[] = [];
    for (const r of allResults) {
        const key = `${r.strategy.id}|${r.sim.spreadPct}|${r.sim.incrementPct}|${r.sim.maxMinRatio}|${r.sim.weightName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(r);
    }

    if (deduped.length === 0) {
        console.log('\n  NO CONFIGURATIONS PRODUCED ANY MATCHED PAIRS.');
        return;
    }

    const topN = Math.min(cfg.topN, deduped.length);
    console.log(`\n================================================================================`);
    console.log(` GLOBAL TOP ${topN}`);
    console.log('================================================================================');
    console.log('#  | AMA   | wt    | spr%  | inc%  | ratio | nOrd |  pairs | net/cap | drift | fee/d | score');
    console.log('---+-------+-------+-------+-------+-------+------+--------+---------+-------+-------+------');
    for (let i = 0; i < topN; i++) {
        const { strategy, sim } = deduped[i];
        console.log(
            `${String(i + 1).padStart(2)} | ` +
            `${strategy.id.padEnd(5)} | ` +
            `${sim.weightName.padEnd(5)} | ` +
            `${fmt(sim.spreadPct, 1).padStart(5)} | ` +
            `${fmt(sim.incrementPct, 1).padStart(5)} | ` +
            `${fmt(sim.maxMinRatio, 2).padStart(5)} | ` +
            `${String(sim.ordersPerSide).padStart(4)} | ` +
            `${String(sim.matchedPairs).padStart(6)} | ` +
            `${fmt(sim.netProfitPerCapital * 100, 2).padStart(7)}% | ` +
            `${fmt(sim.avgCenterDriftPct, 2).padStart(5)}% | ` +
            `${fmt(sim.feePerDayBts, 2).padStart(5)} | ` +
            `${fmt(sim.score, 1).padStart(6)}`
        );
    }

    // ── Winner ──────────────────────────────────────────────────────────────
    const winner = deduped[0];
    console.log(`\n================================================================================`);
    console.log(` WINNER`);
    console.log('================================================================================');
    console.log(`  AMA:         ${winner.strategy.id} (ER=${winner.strategy.er}, Fast=${winner.strategy.fast}, Slow=${winner.strategy.slow})`);
    console.log(`  Weight:      ${winner.sim.weightName} (${WEIGHT_PROFILES[winner.sim.weightName as keyof typeof WEIGHT_PROFILES]})`);
    console.log(`  Spread:      ${fmt(winner.sim.spreadPct, 1)}%`);
    console.log(`  Increment:   ${fmt(winner.sim.incrementPct, 1)}%`);
    console.log(`  Ratio:       ${fmt(winner.sim.maxMinRatio, 1)}x`);
    console.log(`  Pairs:       ${winner.sim.matchedPairs} (${fmt(winner.sim.pairsPerDay, 2)}/day)`);
    console.log(`  Fill eff:    ${fmt(winner.sim.fillEfficiency, 1)}%`);
    console.log(`  Profit/cap:  gross ${fmt(winner.sim.profitPerCapital * 100, 2)}% | net ${fmt(winner.sim.netProfitPerCapital * 100, 2)}%`);
    console.log(`  Net profit:  ${fmt(winner.sim.netProfitUnits, 0)} units after ${fmt(winner.sim.totalRepositionFeesBts, 1)} BTS reposition fees`);
    console.log(`  Avg/pair:    ${fmt(winner.sim.avgProfitPerPair, 2)} units`);
    console.log(`  Max DD:      ${fmt(winner.sim.maxDrawdownPct, 2)}%`);
    console.log(`  Repositions: ${winner.sim.repositionCount}`);
    console.log(`  Grid age:    avg ${fmt(winner.sim.avgGridAgeBars, 1)} bars | max ${fmt(winner.sim.maxGridAgeBars, 0)} bars`);
    console.log(`  Drift:       avg ${fmt(winner.sim.avgCenterDriftPct, 2)}% | max ${fmt(winner.sim.maxCenterDriftPct, 2)}% | near-threshold ${fmt(winner.sim.nearThresholdBarsPct, 1)}%`);
    console.log(`  Tx burn:     ${fmt(winner.sim.estimatedFeePerRepositionBts, 4)} BTS/reposition | ${fmt(winner.sim.feePerDayBts, 2)} BTS/day`);
    console.log(`  Score:       ${fmt(winner.sim.score, 2)}`);

    // ── Save JSON ───────────────────────────────────────────────────────────
    const outName = `ama_sweep_results_${path.basename(cfg.dataPath!, '.json')}.json`;
    const outPath = path.join(__dirname, outName);
    writeJSON(outPath, {
        meta: {
            generatedAt: new Date().toISOString(),
            dataPath: path.relative(process.cwd(), cfg.dataPath!),
            resultsPath: path.relative(process.cwd(), cfg.resultsPath!),
            candles: candles.length,
            days: candles.length / 24,
            maxOrders: cfg.maxOrders,
            capitalPerSide: cfg.capital,
            feeRoundtripPct: cfg.feeRoundtripPct,
            repositionPct: cfg.repositionPct,
            btsCreateFee: cfg.btsCreateFee,
            btsCancelFee: cfg.btsCancelFee,
            makerCreateFactor: cfg.makerCreateFactor,
            txFeePrice: cfg.txFeePrice,
            weightProfiles: WEIGHT_PROFILES,
            search: {
                spreadValues: cfg.spreadValues,
                incrementValues: cfg.incrementValues,
                ratioValues: cfg.ratioValues,
                minSpreadFactor: cfg.minSpreadFactor,
                combosPerAma: totalCombos,
                totalCombos: totalCombos * strategies.length,
            },
            scoring: 'netProfitPerCapital * 100 * log10(max(1, matchedPairs)) - maxDrawdownPct * 0.5',
        },
        strategies,
        perAma: byAma.map((row) => ({
            strategy: row.strategy,
            evaluated: row.evaluated,
            best: row.best,
            top5: row.top5,
        })),
        globalTop: deduped.slice(0, Math.max(cfg.topN, 20)).map(({ strategy, sim }) => ({
            ama: strategy.id,
            amaParams: { er: strategy.er, fast: strategy.fast, slow: strategy.slow },
            ...sim,
        })),
        winner: {
            ama: winner.strategy.id,
            amaParams: { er: winner.strategy.er, fast: winner.strategy.fast, slow: winner.strategy.slow },
            ...winner.sim,
        },
    });

    console.log(`\nSaved: ${path.relative(process.cwd(), outPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().catch((err) => { console.error(err); process.exit(1); });
}

export { WEIGHT_PROFILES, allocateFundsByWeights, buildGrid, closeFilledInventoryAtPrice, countCancelableOrders, simulatePersistentGrid, sweepOneAma }

