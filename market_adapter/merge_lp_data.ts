#!/usr/bin/env node
'use strict';

/**
 * MERGE LP DATA FILES
 *
 * Merges two JSON files produced by fetch_lp_data.ts into one,
 * deduplicating candles by timestamp and sorting chronologically.
 *
 * Both files must have the same pool ID, interval, and asset pair.
 *
 * Usage:
 *   tsx market_adapter/merge_lp_data.ts <file1> <file2> --out <output>
 *
 * Example (2-year 1h dataset):
 *   tsx market_adapter/inputs/fetch_lp_data.ts --pool <poolId> --precA <precA> --precB <precB> --interval 1h --start 2024-03-06 --end 2025-03-06
 *   tsx market_adapter/inputs/fetch_lp_data.ts --pool <poolId> --precA <precA> --precB <precB> --interval 1h --start 2025-03-06 --end 2026-03-06
 *   tsx market_adapter/merge_lp_data.ts \
 *     market_adapter/data/lp/<pair>/lp_pool_<poolShort>_1h_2024.json \
 *     market_adapter/data/lp/<pair>/lp_pool_<poolShort>_1h_2025.json \
 *     --out market_adapter/data/lp/<pair>/lp_pool_<poolShort>_1h.json
 */

import { path } from '../modules/path_api.js';
import { getStorage } from '../modules/storage/index.js';
import { mergeCandles } from './candle_utils.js';
import { ensureDir, readJSON, writeJSON } from '../modules/utils/fs_utils.js';
const storage = getStorage();

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const files: string[] = [];
    let out: string | null = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--out' && args[i + 1]) {
            out = args[++i];
        } else if (!args[i].startsWith('--')) {
            files.push(args[i]);
        }
    }

    if (files.length !== 2) {
        console.error('Usage: merge_lp_data.ts <file1> <file2> --out <output>');
        process.exit(1);
    }

    return { files, out };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(a: any, b: any) {
    if (a.meta.pool !== b.meta.pool) {
        throw new Error(`Pool mismatch: ${a.meta.pool} vs ${b.meta.pool}`);
    }
    if (a.meta.intervalSeconds !== b.meta.intervalSeconds) {
        throw new Error(`Interval mismatch: ${a.meta.intervalSeconds}s vs ${b.meta.intervalSeconds}s`);
    }
    if (a.meta.assetA.id !== b.meta.assetA.id || a.meta.assetB.id !== b.meta.assetB.id) {
        throw new Error(
            `Asset pair mismatch:\n` +
            `  file1: ${a.meta.assetA.id} / ${a.meta.assetB.id}\n` +
            `  file2: ${b.meta.assetA.id} / ${b.meta.assetB.id}`
        );
    }
    if (a.meta.assetA.precision !== b.meta.assetA.precision || a.meta.assetB.precision !== b.meta.assetB.precision) {
        throw new Error(
            `Precision mismatch:\n` +
            `  file1: precA=${a.meta.assetA.precision} precB=${a.meta.assetB.precision}\n` +
            `  file2: precA=${b.meta.assetA.precision} precB=${b.meta.assetB.precision}`
        );
    }
}

// ─── Merge ────────────────────────────────────────────────────────────────────

// ─── Main ─────────────────────────────────────────────────────────────────────

function run() {
    const { files, out } = parseArgs();

    console.log('');
    console.log('══════════════════════════════════════════════');
    console.log(' LP Data Merger');
    console.log('══════════════════════════════════════════════');

    const [dataA, dataB] = files.map((f, i) => {
        const resolved = path.resolve(f);
        if (!storage.exists(resolved)) throw new Error(`File not found: ${resolved}`);
        const parsed = readJSON(resolved);
        console.log(`  file${i + 1}: ${path.relative(process.cwd(), resolved)}  (${parsed.candles.length} candles)`);
        return parsed;
    });

    validate(dataA, dataB);

    const merged = mergeCandles(dataA.candles, dataB.candles, {
        onCollision: (existing: any, incoming: any) => incoming[5] > existing[5] ? incoming : existing,
    });

    const firstTs = new Date(merged[0][0]).toISOString();
    const lastTs  = new Date(merged[merged.length - 1][0]).toISOString();

    console.log('');
    console.log(`  file1 range: ${new Date(dataA.candles[0][0]).toISOString()} → ${new Date(dataA.candles[dataA.candles.length - 1][0]).toISOString()}`);
    console.log(`  file2 range: ${new Date(dataB.candles[0][0]).toISOString()} → ${new Date(dataB.candles[dataB.candles.length - 1][0]).toISOString()}`);
    console.log(`  merged:      ${firstTs} → ${lastTs}  (${merged.length} candles)`);

    // Overlap check
    const bTimestamps = new Set(dataB.candles.map((c: any) => c[0]));
    const overlapCount = dataA.candles.filter((c: any) => bTimestamps.has(c[0])).length;
    if (overlapCount > 0) {
        console.log(`  overlap:     ${overlapCount} candles (deduplicated, higher-volume kept)`);
    }

    const output = {
        meta: {
            ...dataA.meta,
            fetchedAt:   new Date().toISOString(),
            mergedFrom:  files.map(f => path.relative(process.cwd(), path.resolve(f))),
            candleCount: merged.length,
            lookbackHours: Math.round((merged[merged.length - 1][0] - merged[0][0]) / 3600000),
        },
        candles: merged,
    };

    const outPath = out
        ? path.resolve(out)
        : path.join(path.dirname(path.resolve(files[1])), path.basename(files[1]));

    ensureDir(path.dirname(outPath));
    writeJSON(outPath, output);
    const kb = ((storage.stat(outPath) as any).size / 1024).toFixed(1);

    console.log('');
    console.log(`  Saved: ${path.relative(process.cwd(), outPath)}  (${kb} KB)`);
    console.log('');
}

try {
    run();
} catch (e: any) {
    console.error('\n[error]', e.message);
    process.exit(1);
}
