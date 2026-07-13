'use strict';

const fs   = require('fs');
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { calculateAMA } = require('../../market_adapter/core/strategies/ama');
const { toIntervalLabel } = require('../../market_adapter/interval_utils');
const { generateHTML } = require('../../market_adapter/lp_chart_core');
const {
    loadLpDataFile,
} = require('../../market_adapter/lp_chart_runner');

const { PATHS } = require('../../modules/paths');
const AMA_PROFILES_FILE = PATHS.PROFILES.MARKET_PROFILES_JSON;

/**
 * AMA GEOMETRIC OPTIMIZER
 *
 * Finds AMA parameters (ER, Fast, Slow) using geometric metrics only.
 *
 * Objective flow:
 *   1. Compute a per-AMA max-distance cap from the max candle deviation percentile.
 *   2. Keep only candidates at or below that cap.
 *   3. Select the candidate with the lowest additive linear score.
 *
 * Distance to price is still tracked for reporting.
 * Winner selection uses an additive tradeoff between AMA movement and
 * AMA-to-price distance, so candidates must stay close enough while also
 * being smooth.
 *
 * Usage:
 *   tsx optimizer_high_resolution.ts --data <path-to-lp-candles.json>
 *   tsx optimizer_high_resolution.ts --data <path-to-lp-candles.json> --write-profiles
 *   tsx optimizer_high_resolution.ts --data <path-to-lp-candles.json> --erMax 400 --fastMax 20 --slowMax 200
 *
 */

const DEFAULT_SEARCH = {
    er: { min: 500, max: 1000, count: 15, step: null, quantum: 1 },
    fast: { min: 2, max: 8, count: 30, step: null, quantum: 0.01 },
    slow: { min: 50, max: 200, count: 30, step: null, quantum: 0.1 },
};

// ── Geometric analysis constants ──────────────────────────────────────────────
const BASE_DISTANCE_WEIGHT = 0.0022;
const DISTANCE_WEIGHT_STEP  = 0.0002;

const AMA_OBJECTIVES = [
    { key: 'AMA1', name: 'AMA1 (min move, cap 25%)', distanceCapQuantile: 0.25 },
    { key: 'AMA2', name: 'AMA2 (min move, cap 30%)', distanceCapQuantile: 0.30 },
    { key: 'AMA3', name: 'AMA3 (min move, cap 35%)', distanceCapQuantile: 0.35 },
    { key: 'AMA4', name: 'AMA4 (min move, cap 40%)', distanceCapQuantile: 0.40 },
];

function cloneObjectives() {
    return AMA_OBJECTIVES.map((o) => ({ ...o }));
}

// ── Parameter ranges ──────────────────────────────────────────────────────────
function quantize(value, quantum) {
    if (!Number.isFinite(quantum) || quantum <= 0) return value;
    return Math.round(value / quantum) * quantum;
}

function geometricRange(min, max, count, quantum = null) {
    const out = [];
    const ratio = Math.pow(max / min, 1 / (count - 1));
    for (let i = 0; i < count; i++) {
        let v = min * Math.pow(ratio, i);
        if (i === 0) v = min;
        if (i === count - 1) v = max;
        v = quantize(v, quantum);
        v = Math.max(min, Math.min(max, v));
        out.push(parseFloat(v.toFixed(6)));
    }
    return [...new Set(out)].sort((a, b) => a - b);
}

function buildDimension(label, cfg) {
    const min = Number(cfg.min);
    const max = Number(cfg.max);
    const step = Number(cfg.step);
    const count = Number(cfg.count);
    const quantum = Number(cfg.quantum);

    if (Number.isFinite(step) && step > 0) {
        const values = range(min, max, step, 2);
        return {
            values,
            meta: {
                mode: 'linear',
                min: values[0],
                max: values[values.length - 1],
                step,
                quantum: Number.isFinite(quantum) && quantum > 0 ? quantum : null,
                count: values.length,
                ratio: null,
            },
        };
    }

    const ratio = Math.pow(max / min, 1 / (count - 1));
    const values = geometricRange(min, max, count, quantum);
    return {
        values,
        meta: {
            mode: 'geometric',
            min: values[0],
            max: values[values.length - 1],
            step: null,
            quantum: Number.isFinite(quantum) && quantum > 0 ? quantum : null,
            count: values.length,
            ratio,
        },
    };
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = Array.isArray(argv) ? argv : [];
    const out = {
        dataFile: null,
        er: { ...DEFAULT_SEARCH.er },
        fast: { ...DEFAULT_SEARCH.fast },
        slow: { ...DEFAULT_SEARCH.slow },
        workers: null,
        writeProfiles: false,
    };

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const v = args[i + 1];
        switch (a) {
            case '--data': out.dataFile = v || null; i++; break;
            case '--erMin': out.er.min = Number(v); i++; break;
            case '--erMax': out.er.max = Number(v); i++; break;
            case '--erStep': out.er.step = Number(v); i++; break;
            case '--erCount': out.er.count = Number(v); i++; break;
            case '--fastMin': out.fast.min = Number(v); i++; break;
            case '--fastMax': out.fast.max = Number(v); i++; break;
            case '--fastStep': out.fast.step = Number(v); i++; break;
            case '--fastCount': out.fast.count = Number(v); i++; break;
            case '--slowMin': out.slow.min = Number(v); i++; break;
            case '--slowMax': out.slow.max = Number(v); i++; break;
            case '--slowStep': out.slow.step = Number(v); i++; break;
            case '--slowCount': out.slow.count = Number(v); i++; break;
            case '--ama1Cap': (out as any).ama1Cap = Number(v); i++; break;
            case '--ama2Cap': (out as any).ama2Cap = Number(v); i++; break;
            case '--ama3Cap': (out as any).ama3Cap = Number(v); i++; break;
            case '--ama4Cap': (out as any).ama4Cap = Number(v); i++; break;
            case '--workers': out.workers = Number(v); i++; break;
            case '--write-profiles': out.writeProfiles = true; break;
        }
    }

    return out;
}

function percentile(values, q) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const qq = Math.max(0, Math.min(1, q));
    const pos = (sorted.length - 1) * qq;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    const t = pos - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function getAmaObjectivesFromArgs(args) {
    const objectives = cloneObjectives();
    for (const o of objectives) {
        const id = o.key.toLowerCase();
        const cap = args[`${id}Cap`];
        if (Number.isFinite(cap)) o.distanceCapQuantile = cap;
        if (!Number.isFinite(o.distanceCapQuantile) || o.distanceCapQuantile <= 0 || o.distanceCapQuantile > 1) {
            throw new Error(`Invalid cap for ${o.key}: ${o.distanceCapQuantile}. Use 0 < cap <= 1`);
        }
    }
    return objectives;
}

function ensureValidRange(label, cfg) {
    const { min, max, step, count } = cfg;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
        throw new Error(`Invalid ${label} range: min=${min}, max=${max}`);
    }
    if (Number.isFinite(step) && step > 0) return;
    if (!Number.isFinite(count) || count < 2) {
        throw new Error(`Invalid ${label} geometric sampling count: ${count}`);
    }
}

function boundaryFlags(winner, erValues, fastValues, slowValues) {
    if (!winner) return { er: null, fast: null, slow: null, any: false };
    const eps = 1e-9;
    const minEr = erValues[0], maxEr = erValues[erValues.length - 1];
    const minFast = fastValues[0], maxFast = fastValues[fastValues.length - 1];
    const minSlow = slowValues[0], maxSlow = slowValues[slowValues.length - 1];
    const er = Math.abs(winner.er - minEr) < eps ? 'min' : (Math.abs(winner.er - maxEr) < eps ? 'max' : null);
    const fast = Math.abs(winner.fast - minFast) < eps ? 'min' : (Math.abs(winner.fast - maxFast) < eps ? 'max' : null);
    const slow = Math.abs(winner.slow - minSlow) < eps ? 'min' : (Math.abs(winner.slow - maxSlow) < eps ? 'max' : null);
    return { er, fast, slow, any: !!(er || fast || slow) };
}

const { ensureDir } = require('../../modules/order/utils/system');
const { range } = require('../math_utils');
const { readJSON, writeJSON } = require('../../modules/utils/fs_utils');

// ── Data loaders ──────────────────────────────────────────────────────────────

function normalizeSymbol(value) {
    return String(value || '').trim().toUpperCase();
}

function inferIntervalLabel(dataFile, meta) {
    const fromMeta = Number(meta?.intervalSeconds);
    if (Number.isFinite(fromMeta) && fromMeta > 0) {
        return toIntervalLabel(fromMeta);
    }

    const m = String(path.basename(dataFile || '')).match(/_(\d+)([mhd])\.json$/i);
    return m ? `${m[1]}${m[2].toLowerCase()}` : '1h';
}

function updateAmaProfilesFile({ dataFile, meta, winners, sourceResultsFile }) {
    const assetASymbol = normalizeSymbol(meta?.assetA?.symbol);
    const assetBSymbol = normalizeSymbol(meta?.assetB?.symbol);
    const assetAId = normalizeSymbol(meta?.assetA?.id);
    const assetBId = normalizeSymbol(meta?.assetB?.id);
    const assetA = assetASymbol || assetAId;
    const assetB = assetBSymbol || assetBId;
    if (!assetA || !assetB) return;

    const intervalSeconds = Number(meta?.intervalSeconds);
    const intervalLabel = inferIntervalLabel(dataFile, meta);
    const key = `${assetA}|${assetB}|${Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : intervalLabel}`;

    const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        profiles: [],
    };

    if (fs.existsSync(AMA_PROFILES_FILE)) {
        try {
            const current = readJSON(AMA_PROFILES_FILE);
            if (current && typeof current === 'object') {
                payload.version = Number(current.version) || 1;
                payload.profiles = Array.isArray(current.profiles) ? current.profiles : [];
            }
        } catch (_) {}
    }

    const profile = {
        key,
        assetA,
        assetB,
        assetAId: assetAId || null,
        assetBId: assetBId || null,
        poolId: meta?.pool || null,
        intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : null,
        intervalLabel,
        defaultAma: 'AMA3',
        sourceResultsFile,
        updatedAt: payload.updatedAt,
        amas: {
            AMA1: {
                name: winners.ama1.label,
                erPeriod: winners.ama1.er,
                fastPeriod: winners.ama1.fast,
                slowPeriod: winners.ama1.slow,
            },
            AMA2: {
                name: winners.ama2.label,
                erPeriod: winners.ama2.er,
                fastPeriod: winners.ama2.fast,
                slowPeriod: winners.ama2.slow,
            },
            AMA3: {
                name: winners.ama3.label,
                erPeriod: winners.ama3.er,
                fastPeriod: winners.ama3.fast,
                slowPeriod: winners.ama3.slow,
            },
            AMA4: {
                name: winners.ama4.label,
                erPeriod: winners.ama4.er,
                fastPeriod: winners.ama4.fast,
                slowPeriod: winners.ama4.slow,
            },
        },
    };

    const idx = payload.profiles.findIndex((p) => String(p?.key || '') === key);
    if (idx >= 0) payload.profiles[idx] = profile;
    else payload.profiles.push(profile);

    ensureDir(path.dirname(AMA_PROFILES_FILE));
    writeJSON(AMA_PROFILES_FILE, payload);
}

function calcTotalAmaMovement(amaValues) {
    const skip = Math.max(20, Math.floor(amaValues.length * 0.1));
    let total = 0;
    for (let i = skip + 1; i < amaValues.length; i++) {
        total += Math.abs(amaValues[i] - amaValues[i - 1]) / amaValues[i - 1];
    }
    return total;
}

// ── Informational: area above/below AMA ──────────────────────────────────────

function calcArea(amaValues, candles) {
    const skip = Math.max(20, Math.floor(candles.length * 0.1));
    let above = 0, below = 0, maxUp = 0, maxDown = 0;
    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        if (candles[i].high > ama) {
            const d = (candles[i].high - ama) / ama;
            above += d;
            if (d > maxUp) maxUp = d;
        }
        if (candles[i].low < ama) {
            const d = (ama - candles[i].low) / ama;
            below += d;
            if (d > maxDown) maxDown = d;
        }
    }
    const total   = above + below;
    const maxDist = Math.max(maxUp, maxDown);
    return { above, below, total, maxUp, maxDown, maxDist };
}

function calcTotalRelativeDistance(amaValues, candles) {
    const skip = Math.max(20, Math.floor(candles.length * 0.1));
    let total = 0;
    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        const close = candles[i].close;
        total += Math.abs(close - ama) / ama;
    }
    return total;
}

function runSearchShard(payload, onProgress = null) {
    const {
        workerId,
        erShard,
        fastValues,
        slowValues,
        candles,
        closes,
    } = payload;

    const totalCombos = erShard.length * fastValues.length * slowValues.length;
    const progressStep = Math.max(2000, Math.floor(totalCombos / 20));
    let checked = 0;
    let valid = 0;
    const entries = [];
    const startMs = Date.now();

    for (const er of erShard) {
        for (const fast of fastValues) {
            for (const slow of slowValues) {
                checked++;
                if (fast >= slow) {
                    if (onProgress && (checked % progressStep === 0 || checked === totalCombos)) {
                        const elapsedSec = (Date.now() - startMs) / 1000;
                        onProgress({ workerId, checked, total: totalCombos, elapsedSec });
                    }
                    continue;
                }
                valid++;

                const ama = calculateAMA(closes, { erPeriod: er, fastPeriod: fast, slowPeriod: slow });
                const area = calcArea(ama, candles);
                const amaMovementTotal = calcTotalAmaMovement(ama);
                const distanceTotal = calcTotalRelativeDistance(ama, candles);
                const bandFactorPct = area.maxDist * 200;
                const entry = {
                    er, fast, slow,
                    area,
                    amaMovementTotal,
                    bandFactorPct,
                    distanceTotal,
                };
                entries.push(entry);

                if (onProgress && (checked % progressStep === 0 || checked === totalCombos)) {
                    const elapsedSec = (Date.now() - startMs) / 1000;
                    onProgress({ workerId, checked, total: totalCombos, elapsedSec });
                }
            }
        }
    }

    return { workerId, entries, totalCombos, validCombos: valid };
}

function spawnShardWorker(payload, onProgress) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: { type: 'search_shard', payload } });
        worker.on('message', (msg) => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'progress') {
                if (onProgress) onProgress(msg);
                return;
            }
            if (msg.type === 'done') resolve(msg.result);
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
    });
}

function splitIntoShards(values, shardCount) {
    const out = [];
    const size = Math.ceil(values.length / shardCount);
    for (let i = 0; i < values.length; i += size) {
        out.push(values.slice(i, i + size));
    }
    return out.filter((s) => s.length > 0);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
    const args = parseArgs();
    let dataFile = args.dataFile;
    const objectives = getAmaObjectivesFromArgs(args);

    ensureValidRange('ER', args.er);
    ensureValidRange('Fast', args.fast);
    ensureValidRange('Slow', args.slow);

    const erDim = buildDimension('ER', args.er);
    const fastDim = buildDimension('Fast', args.fast);
    const slowDim = buildDimension('Slow', args.slow);

    const ER_VALUES = erDim.values;
    const FAST_VALUES = fastDim.values;
    const SLOW_VALUES_AREA = slowDim.values;

    const totalCombos = ER_VALUES.length * FAST_VALUES.length * SLOW_VALUES_AREA.length;
    const startMs = Date.now();

    console.log('================================================================================');
    console.log(' AMA GEOMETRIC OPTIMIZER');
    console.log('================================================================================');
    console.log(`  4 AMAs — pure geometric, no grid or bot settings`);
    console.log('  Objective: minimise movement + λ·distance under per-AMA max distance caps');
    for (const o of objectives) {
        console.log(`  ${o.key}: distance cap quantile q=${o.distanceCapQuantile.toFixed(2)}`);
    }
    console.log(`  Distance penalty: λ=${BASE_DISTANCE_WEIGHT} → ${BASE_DISTANCE_WEIGHT - DISTANCE_WEIGHT_STEP * (objectives.length - 1)}`);
    console.log(`  Ranges:     ER ${ER_VALUES[0]}–${ER_VALUES[ER_VALUES.length-1]}  Fast ${FAST_VALUES[0]}–${FAST_VALUES[FAST_VALUES.length-1]}  Slow ${SLOW_VALUES_AREA[0]}–${SLOW_VALUES_AREA[SLOW_VALUES_AREA.length-1]}`);
    console.log(`  Sampling:   ER ${erDim.meta.mode}(${erDim.meta.count}${erDim.meta.ratio ? `,x${erDim.meta.ratio.toFixed(3)}` : ''})  Fast ${fastDim.meta.mode}(${fastDim.meta.count}${fastDim.meta.ratio ? `,x${fastDim.meta.ratio.toFixed(3)}` : ''})  Slow ${slowDim.meta.mode}(${slowDim.meta.count}${slowDim.meta.ratio ? `,x${slowDim.meta.ratio.toFixed(3)}` : ''})`);
    console.log(`  Combos:     ${totalCombos}\n`);

    // Load data
    let candles, dataLabel, dataMeta = null;
    if (!dataFile) {
        throw new Error('Optimizer requires --data <lp_pool_*.json>. Use --write-profiles to also update profiles/market_profiles.json.');
    }
    const loaded = loadLpDataFile(path.resolve(dataFile));
    candles   = loaded.candleObjects;
    const m   = loaded.meta;
    dataMeta = m;
    dataLabel = m ? `LP Pool ${m.pool} (${m.assetA?.symbol}/${m.assetB?.symbol})` : path.basename(dataFile);
    const closes = candles.map(c => c.close);
    console.log(`  Data:       ${dataLabel}  (${candles.length} candles)\n`);

    // ── Run: core-parallel full-grid scan split by ER shards ──────────────────
    const cpuCount = Math.max(1, os.cpus().length);
    const requestedWorkers = Number.isFinite(args.workers) && args.workers > 0 ? Math.floor(args.workers) : cpuCount;
    const workerCount = Math.max(1, Math.min(requestedWorkers, ER_VALUES.length));
    const erShards = splitIntoShards(ER_VALUES, workerCount);
    const shardTotals = erShards.map((shard) => shard.length * FAST_VALUES.length * SLOW_VALUES_AREA.length);
    const shardProgress = new Map();

    console.log(`  Parallel workers: ${erShards.length} shard workers (CPU cores available: ${cpuCount})`);
    const shardResults = await Promise.all(erShards.map((erShard, idx) => {
        const workerPayload = {
            workerId: idx + 1,
            erShard,
            fastValues: FAST_VALUES,
            slowValues: SLOW_VALUES_AREA,
            candles,
            closes,
        };
        return spawnShardWorker(workerPayload, (msg) => {
            shardProgress.set(msg.workerId, msg.checked);
            const done = shardTotals.reduce((acc, total, i) => acc + Math.min(total, shardProgress.get(i + 1) || 0), 0);
            const pct = ((done / totalCombos) * 100).toFixed(1);
            console.log(`  [scan] ${pct}%  (${done}/${totalCombos})  w${msg.workerId} ${msg.elapsedSec.toFixed(1)}s`);
        });
    }));

    const entries = shardResults.flatMap((r) => (r as any).entries);
    const validCombos = shardResults.reduce((acc, r) => acc + (r as any).validCombos, 0);
    const maxDistVals = entries.map((e) => e.area.maxDist);

    const objectiveResults = objectives.map((objective, idx) => {
        const distanceWeight = BASE_DISTANCE_WEIGHT - (DISTANCE_WEIGHT_STEP * idx);
        const computedCap = percentile(maxDistVals, objective.distanceCapQuantile);
        const cappedEntries = entries.filter((e) => e.area.maxDist <= computedCap);

        let best = null;
        for (const e of cappedEntries) {
            const score = e.amaMovementTotal + (distanceWeight * e.distanceTotal);
            const bestScore = best ? best.weightedScore : Infinity;
            if (!best || score < bestScore || (score === bestScore && e.amaMovementTotal < best.amaMovementTotal) || (score === bestScore && e.amaMovementTotal === best.amaMovementTotal && e.distanceTotal < best.distanceTotal)) {
                best = {
                    ...e,
                    weightedScore: score,
                    normDistance: null,
                    normMovement: null,
                    key: objective.key,
                    label: objective.name,
                };
            }
        }

        return {
            objective,
            distanceWeight,
            best,
            totalCombos,
            validCombos,
            candidatesUnderCap: cappedEntries.length,
            maxDistanceCap: computedCap,
        };
    });
    const elapsedSec = (Date.now() - startMs) / 1000;
    console.log(`  Completed parallel search in ${elapsedSec.toFixed(1)}s  (valid combos: ${validCombos})\n`);

    const selected = objectiveResults.map((r) => r.best).filter(Boolean);
    const failed = objectiveResults.filter((r) => !r.best).map((r) => r.objective?.key || '?');
    if (failed.length > 0) {
        throw new Error(`No candidate under distance cap for: ${failed.join(', ')}. Increase corresponding cap (e.g. --ama4Cap 0.35).`);
    }

    const ama1 = selected.find((s) => s.key === 'AMA1') || null;
    const ama2 = selected.find((s) => s.key === 'AMA2') || null;
    const ama3 = selected.find((s) => s.key === 'AMA3') || null;
    const ama4 = selected.find((s) => s.key === 'AMA4') || null;

    function detail(label, r, optimisedFor) {
        if (!r) {
            console.log(`  ${label}`);
            console.log('  └─ No valid candidate under constraint\n');
            return;
        }
        const asymmetry = Math.abs(r.area.above - r.area.below);
        const bias      = r.area.above > r.area.below ? 'AMA below price' : 'AMA above price';
        console.log(`  ${label}`);
        console.log(`  ├─ Optimised for:  ${optimisedFor}`);
        console.log(`  ├─ Params:         ER=${r.er}  Fast=${r.fast}  Slow=${r.slow}`);
        console.log(`  ├─ Area total:     ${r.area.total.toFixed(2)}  (above ${r.area.above.toFixed(2)}  below ${r.area.below.toFixed(2)})`);
        console.log(`  ├─ Asymmetry:      ${asymmetry.toFixed(2)}  (${bias})`);
        console.log(`  └─ Movement:       ${r.amaMovementTotal.toFixed(4)}\n`);
    }

    console.log('================================================================================');
    console.log(` 4 AMAs  —  pure geometric  (${ER_VALUES.length}×${FAST_VALUES.length}×${SLOW_VALUES_AREA.length} combinations)`);
    console.log('================================================================================\n');

    for (const w of selected) {
        detail(w.label, w,
            `score=${w.weightedScore.toFixed(6)}  λ=${objectiveResults.find((r) => r.objective?.key === w.key)?.distanceWeight?.toFixed(4) || 'n/a'}  rawDist=${w.distanceTotal.toFixed(2)}  rawMove=${w.amaMovementTotal.toFixed(2)}`);
    }

    for (const r of objectiveResults) {
        if (Number.isFinite(r.maxDistanceCap)) {
            console.log(`  ${r.objective.key} cap value: ${r.maxDistanceCap.toFixed(4)}  (candidates under cap: ${r.candidatesUnderCap})`);
        }
    }
    console.log();

    // ── Side-by-side summary ───────────────────────────────────────────────────
    console.log('================================================================================');
    console.log(' SUMMARY');
    console.log('================================================================================\n');
    console.log('                |  ER  | Fast | Slow | Dist    | Move    | Area    | MaxDist');
    console.log('────────────────┼──────┼──────┼──────┼─────────┼─────────┼─────────┼─────────');
    for (const r of selected) {
        const name = r.key;
        if (!r) continue;
        console.log(
            `${name.padEnd(15)} | ` +
            `${r.er.toString().padStart(4)} | ` +
            `${r.fast.toFixed(1).padStart(4)} | ` +
            `${r.slow.toFixed(1).padStart(4)} | ` +
            `${r.distanceTotal.toFixed(2).padStart(7)} | ` +
            `${r.amaMovementTotal.toFixed(2).padStart(7)} | ` +
            `${r.area.total.toFixed(2).padStart(7)} | ` +
            `${(r.area.maxDist * 100).toFixed(1).padStart(7)}%`
        );
    }
    console.log();

    const boundarySummary = {
        AMA1: boundaryFlags(ama1, ER_VALUES, FAST_VALUES, SLOW_VALUES_AREA),
        AMA2: boundaryFlags(ama2, ER_VALUES, FAST_VALUES, SLOW_VALUES_AREA),
        AMA3: boundaryFlags(ama3, ER_VALUES, FAST_VALUES, SLOW_VALUES_AREA),
        AMA4: boundaryFlags(ama4, ER_VALUES, FAST_VALUES, SLOW_VALUES_AREA),
    };

    console.log(' Boundary Check');
    console.log('────────────────────────────────────────────────────────────────────────────────');
    for (const [name, b] of Object.entries(boundarySummary)) {
        const txt = b.any ? `ER:${b.er || '-'} Fast:${b.fast || '-'} Slow:${b.slow || '-'}` : 'none';
        console.log(`${name.padEnd(24)} ${txt}`);
    }
    console.log();

    // ── Chart ─────────────────────────────────────────────────────────────────
    const ws = (v) => String(v).replace('.', '_');
    const lambdaSuffix = `_l${ws(BASE_DISTANCE_WEIGHT)}_s${ws(DISTANCE_WEIGHT_STEP)}`;
    const COLOR_CYCLE = ['#26a69a', '#fb8c00', '#5c9ee6', '#ef5350'];
    const DASH_CYCLE = ['dot', 'solid', 'dash', 'dashdot'];
    const candleArrays = candles.map(c => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
    const chartMeta = {
        ...(dataMeta || {}),
        assetA: dataMeta?.assetA || { symbol: '?' },
        assetB: dataMeta?.assetB || { symbol: '?' },
        intervalSeconds: dataMeta?.intervalSeconds || 3600,
        fetchedAt: dataMeta?.fetchedAt || new Date().toISOString(),
    };
    const amaResults = selected.map((w, i) => {
        const ama = calculateAMA(closes, { erPeriod: w.er, fastPeriod: w.fast, slowPeriod: w.slow });
        return {
            name: w.label,
            erPeriod: w.er,
            fastPeriod: w.fast,
            slowPeriod: w.slow,
            color: COLOR_CYCLE[i % COLOR_CYCLE.length],
            dash: DASH_CYCLE[i % DASH_CYCLE.length],
            lineWidth: i === 0 ? 2 : 1.5,
            values: ama,
        };
    });
    const chartName = dataFile
        ? `optimization_chart_${path.basename(dataFile, '.json')}${lambdaSuffix}.html`
        : `optimization_chart_high_resolution${lambdaSuffix}.html`;
    const chartPath = path.join(PATHS.ANALYSIS.CHARTS_DIR, chartName);
    ensureDir(path.dirname(chartPath));
    const html = generateHTML(chartMeta, candleArrays, amaResults);
    fs.writeFileSync(chartPath, html, 'utf8');
    console.log(`  Chart:       ${path.relative(process.cwd(), chartPath)}\n`);

    // ── Save ──────────────────────────────────────────────────────────────────
    const outName = dataFile
        ? `optimization_results_${path.basename(dataFile, '.json')}${lambdaSuffix}.json`
        : `optimization_results_high_resolution${lambdaSuffix}.json`;
    const outPath = path.join(__dirname, outName);
    writeJSON(outPath, {
        meta: {
            dataLabel,
            candles: candles.length,
            totalCombos,
            ranges: {
                er: { ...erDim.meta },
                fast: { ...fastDim.meta },
                slow: { ...slowDim.meta },
            },
            boundaryFlags: boundarySummary,
            objective: {
                type: 'distance_cap_then_movement_plus_linear_distance_minimization',
                distanceMetric: 'sum(abs(close-ama)/ama)',
                movementMetric: 'sum(abs(ama_t-ama_t-1)/ama_t-1)',
                baseDistanceWeight: BASE_DISTANCE_WEIGHT,
                distanceWeightStep: DISTANCE_WEIGHT_STEP,
                distanceWeightByAma: Object.fromEntries(objectiveResults.map((r) => [r.objective.key, r.distanceWeight])),
                weights: objectives,
                maxDistanceCap: {
                    value: null,
                    quantileByAma: Object.fromEntries(objectives.map((o) => [o.key, o.distanceCapQuantile])),
                    appliedValueByAma: Object.fromEntries(objectiveResults.map((r) => [r.objective.key, r.maxDistanceCap])),
                },
            },
            amas: {
                AMA1: ama1,
                AMA2: ama2,
                AMA3: ama3,
                AMA4: ama4,
            },
        },
    });

    if (args.writeProfiles && dataFile && ama1 && ama2 && ama3 && ama4) {
        updateAmaProfilesFile({
            dataFile,
            meta: dataMeta,
            winners: { ama1, ama2, ama3, ama4 },
            sourceResultsFile: outName,
        });
    }

    console.log(`================================================================================`);
    console.log(`  Saved: ${outName}\n`);
    if (args.writeProfiles && dataFile) {
        console.log(`  Updated: ${path.relative(process.cwd(), AMA_PROFILES_FILE)}\n`);
    } else {
        console.log(`  Profiles unchanged. Add --write-profiles to update ${path.relative(process.cwd(), AMA_PROFILES_FILE)}.\n`);
    }
}

if (!isMainThread) {
    if (workerData?.type === 'search_shard') {
        const result = runSearchShard(workerData.payload, (p) => {
            parentPort.postMessage({ type: 'progress', ...p });
        });
        parentPort.postMessage({ type: 'done', result });
    } else {
        throw new Error('Unknown worker task type');
    }
} else if (require.main === module) {
    run().catch((err) => {
        console.error('Fatal:', err);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
};
