#!/usr/bin/env node
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePoolId } from '../../market_adapter/utils/chain.js';
import { toIntervalLabel } from '../../market_adapter/interval_utils.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import * as kibanaSource from '../../market_adapter/inputs/kibana_source.js';
import { PATHS } from '../../modules/paths.js';
import { getStorage } from '../../modules/storage/index.js';
const { ensureDir, writeJSON } = getStorage();
import { getErrorMessage } from '../../modules/utils/errors.js';

/**
 * Fetch LP pool candles from Kibana for AMA optimizer input.
 *
 * Uses the same kibana_source as the market_adapter bootstrap, but saves
 * the full uncut dataset (no pruning) for optimizer use.
 *
 * Usage:
 *   node dist/analysis/ama_fitting/fetch_lp_candles.js \
 *     --pool 1.19.133 \
 *     --assetA IOB.XRP --assetAId 1.3.3926 --assetAPrecision 4 \
 *     --assetB BTS     --assetBId 1.3.0    --assetBPrecision 5 \
 *     [--interval 1h] [--hours 26280] [--out my_file.json]
 *
 * Defaults: --interval 1h  --hours 26280 (3 years)
 * Output: market_adapter/data/lp/<assetA>_<assetB>/lp_pool_<poolShort>_<interval>.json
 */
const DATA_DIR = PATHS.MARKET_ADAPTER.LP_DATA_DIR;
const HOURS_3Y  = 3 * 365 * 24; // 26280
function slugPart(value: string | null | undefined): string {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';
}
function slugPairFolder(symbolA: string, symbolB: string): string {
    return `${slugPart(symbolA)}_${slugPart(symbolB)}`;
}
function parseArgs() {
    const args = process.argv.slice(2);
    const out: {
        pool: string | null;
        assetASymbol: string | null;
        assetAId: string | null;
        assetAPrecision: number | null;
        assetBSymbol: string | null;
        assetBId: string | null;
        assetBPrecision: number | null;
        intervalSeconds: number;
        hours: number;
        outFile: string | null;
    } = {
        pool:             null,
        assetASymbol:     null,
        assetAId:         null,
        assetAPrecision:  null,
        assetBSymbol:     null,
        assetBId:         null,
        assetBPrecision:  null,
        intervalSeconds:  MARKET_ADAPTER.RUNTIME_DEFAULTS.intervalSeconds,
        hours:            HOURS_3Y,
        outFile:          null,
    };
    const intervalMap: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const v = args[i + 1];
        switch (a) {
            case '--pool':             out.pool             = v;         i++; break;
            case '--assetA':           out.assetASymbol     = v;         i++; break;
            case '--assetAId':         out.assetAId         = v;         i++; break;
            case '--assetAPrecision':  out.assetAPrecision  = Number(v); i++; break;
            case '--assetB':           out.assetBSymbol     = v;         i++; break;
            case '--assetBId':         out.assetBId         = v;         i++; break;
            case '--assetBPrecision':  out.assetBPrecision  = Number(v); i++; break;
            case '--interval':         out.intervalSeconds  = intervalMap[v] ?? parseInt(v, 10); i++; break;
            case '--hours':            out.hours            = Number(v); i++; break;
            case '--out':              out.outFile          = v;         i++; break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
    }
    return out;
}
function printHelp() {
    console.log('fetch_lp_candles.ts — fetch LP pool candles from Kibana for AMA optimizer');
    console.log('');
    console.log('Usage:');
    console.log('  node dist/analysis/ama_fitting/fetch_lp_candles.js --pool 1.19.133 \\');
    console.log('    --assetA IOB.XRP --assetAId 1.3.3926 --assetAPrecision 4 \\');
    console.log('    --assetB BTS     --assetBId 1.3.0    --assetBPrecision 5');
    console.log('');
    console.log('Options:');
    console.log('  --pool <id>              Pool ID (e.g. 1.19.133)');
    console.log('  --assetA <symbol>        Asset A symbol (e.g. IOB.XRP)');
    console.log('  --assetAId <id>          Asset A object ID (e.g. 1.3.3926)');
    console.log('  --assetAPrecision <n>    Asset A precision (e.g. 8)');
    console.log('  --assetB <symbol>        Asset B symbol (e.g. BTS)');
    console.log('  --assetBId <id>          Asset B object ID (e.g. 1.3.0)');
    console.log('  --assetBPrecision <n>    Asset B precision (e.g. 5)');
    console.log('  --interval <label>       Candle interval (1m, 5m, 15m, 1h, 4h, 1d; default: 1h)');
    console.log('  --hours <n>              Lookback hours (default: 26280 = 3 years)');
    console.log('  --out <filename>         Output filename (default: auto-generated in market_adapter/data/lp/)');
}
function validateArgs(args: Record<string, any>) {
    if (!args.pool)            throw new Error('--pool is required');
    if (!args.assetAId)        throw new Error('--assetAId is required');
    if (!Number.isFinite(args.assetAPrecision)) throw new Error('--assetAPrecision is required');
    if (!args.assetBId)        throw new Error('--assetBId is required');
    if (!Number.isFinite(args.assetBPrecision)) throw new Error('--assetBPrecision is required');
    if (!Number.isFinite(args.hours) || args.hours <= 0) throw new Error('--hours must be > 0');
    // Reject unknown/NaN intervals here instead of letting NaN flow silently
    // into Kibana range queries (production throws on unsupported intervals).
    if (!Number.isFinite(args.intervalSeconds) || args.intervalSeconds <= 0) {
        throw new Error('Unsupported --interval: use one of 1m, 5m, 15m, 1h, 4h, 1d or a positive number of seconds');
    }
}
async function main() {
    const args = parseArgs();
    validateArgs(args);
    const assetA = {
        id:        args.assetAId,
        precision: args.assetAPrecision,
        symbol:    args.assetASymbol || args.assetAId || '',
    };
    const assetB = {
        id:        args.assetBId,
        precision: args.assetBPrecision,
        symbol:    args.assetBSymbol || args.assetBId || '',
    };
    const { intervalSeconds } = args;
    const intervalLabel    = toIntervalLabel(intervalSeconds);
    const poolId           = normalizePoolId(args.pool);
    const lookback         = Math.round(args.hours);
    const yearsApprox      = (lookback / (365 * 24)).toFixed(1);
    console.log(`Fetching LP candles from Kibana`);
    console.log(`  Pool:     ${poolId}`);
    console.log(`  Pair:     ${assetA.symbol} / ${assetB.symbol}`);
    console.log(`  Interval: ${intervalLabel}`);
    console.log(`  Lookback: ${lookback}h (~${yearsApprox} years)`);
    console.log('');
    const candles = await kibanaSource.getLpCandlesForPool(poolId, assetA, assetB, {
        intervalSeconds,
        lookbackHours:         lookback,
        consolidateByTimestamp: true,
        apiKey:                null,
        timeout:               60000,
    });
    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('Kibana returned no candles — check pool ID, asset IDs, and Kibana connectivity');
    }
    const firstTs = new Date(candles[0][0]).toISOString();
    const lastTs  = new Date(candles[candles.length - 1][0]).toISOString();
    console.log(`  Received: ${candles.length} candles  (${firstTs} → ${lastTs})`);
    const payload = {
        meta: {
            fetchedAt:       new Date().toISOString(),
            source:          'kibana',
            pool:            poolId,
            assetA,
            assetB,
            intervalSeconds,
            lookbackHours:   lookback,
            candleCount:     candles.length,
            format:          '[timestamp_ms, open, high, low, close, volume_A]',
        },
        candles,
    };
    const poolShort = (poolId || '').replace('1.19.', '');
    const pairFolder = slugPairFolder(assetA.symbol, assetB.symbol);
    const defaultName = `lp_pool_${poolShort}_${intervalLabel}.json`;
    const outName = args.outFile || defaultName;
    const outPath = args.outFile && path.isAbsolute(args.outFile)
        ? args.outFile
        : path.join(DATA_DIR, pairFolder, outName);
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) ensureDir(outDir);
    writeJSON(outPath, payload);
    console.log(`  Saved:    ${path.relative(process.cwd(), outPath)}`);
    console.log('');
    console.log('Run optimizer:');
    console.log(`  npm run build && node dist/analysis/ama_fitting/optimizer_high_resolution.js --data ${path.relative(process.cwd(), outPath)}`);
}
main().catch((err: any) => {
    console.error('Error:', getErrorMessage(err));
    process.exit(1);
});
