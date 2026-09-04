#!/usr/bin/env node
'use strict';
/**
 * dexbot tv — TradingView chart shortcut.
 *
 * Usage:
 *   dexbot tv <bot|pool-id|AssetA/AssetB> [--month N] [--chart <path>] [--scale log|linear]
 *
 * - 1h candles, N months of history (default 3).
 * - Target resolution:
 *   - bot name/key from profiles/bots.json
 *   - pool id (e.g. 133 or 1.19.133)
 *   - AssetA/AssetB symbols (pool-first, orderbook fill fallback when no pool)
 *
 * This script ONLY pulls fresh candle data and writes it to a temp JSON file.
 * Rendering (chart HTML, AMA overlay like the exporter, auto chart path + print)
 * is delegated to the existing analyzer at analysis/tradingview/analyze_tradingview.js.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { loadBotMeta, resolveAmaConfig, loadBotSettings, computeBotKey } from '../analysis/bot_key_utils.js';
import { PATHS } from '../modules/paths.js';
import { normalizePoolId, resolveAsset, findPoolByAssets } from '../market_adapter/utils/chain.js';
import { fetchCandlesSequentially, outputPath, buildFetchWindowsFromRange } from '../market_adapter/inputs/fetch_lp_data.js';
import { getMarketCandles } from '../market_adapter/core/kibana_market_candles.js';
import { mergeCandles } from '../market_adapter/candle_utils.js';
import { getErrorMessage } from '../modules/utils/errors.js';
import { muteChainLogs } from '../modules/utils/chain_logs.js';
import { isSameBotName, sanitizeKey } from '../modules/utils/sanitize_key.js';

const INTERVAL_SECONDS = 3600;
const DEFAULT_MONTHS = 3;
const HOURS_PER_MONTH = 730;

function printUsage(): void {
    console.log('Usage: dexbot tv <bot|pool-id|AssetA/AssetB> [--month N] [--chart <path>] [--scale log|linear]');
    console.log('');
    console.log('  <bot>          Bot name or key from profiles/bots.json (AMA overlay like the exporter)');
    console.log('  <pool-id>      Liquidity pool id, e.g. 133 or 1.19.133');
    console.log('  AssetA/AssetB  Pair symbols, e.g. TOKENA/TOKENB (pool-first, orderbook fallback)');
    console.log('');
    console.log('Options:');
    console.log(`  --month N        Months of 1h history (default ${DEFAULT_MONTHS})`);
    console.log('  --months N       Alias for --month');
    console.log('  --chart <path>   Override auto output path');
    console.log('  --scale <log|linear>  Price axis scale (default log)');
}

function parseArgs(argv: string[]): { target: string | null; months: number; chart: string | null; priceScale: string; help: boolean } {
    let target: string | null = null;
    let months = DEFAULT_MONTHS;
    let chart: string | null = null;
    let priceScale = 'log';
    let help = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') help = true;
        else if (arg === '--month' || arg === '--months') {
            const raw = argv[++i];
            const n = Number(raw);
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--month: invalid value "${raw}" (expected positive months, e.g. --month 6)`);
            months = n;
        } else if (arg.startsWith('--month=')) {
            const n = Number(arg.split('=')[1]);
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--month: invalid value "${arg}" (expected positive months)`);
            months = n;
        } else if (arg.startsWith('--months=')) {
            const n = Number(arg.split('=')[1]);
            if (!Number.isFinite(n) || n <= 0) throw new Error(`--months: invalid value "${arg}" (expected positive months)`);
            months = n;
        } else if (arg === '--chart') {
            chart = String(argv[++i] || '');
            if (!chart) throw new Error('--chart: missing path');
        } else if (arg.startsWith('--chart=')) {
            chart = arg.split('=').slice(1).join('=');
            if (!chart) throw new Error('--chart: missing path');
        } else if (arg === '--scale' || arg === '--price-scale') {
            priceScale = String(argv[++i] || 'log').toLowerCase();
            if (priceScale !== 'log' && priceScale !== 'linear') throw new Error(`--scale: unsupported value "${priceScale}" (use log|linear)`);
        } else if (arg.startsWith('--scale=')) {
            priceScale = arg.split('=')[1]?.toLowerCase() || 'log';
            if (priceScale !== 'log' && priceScale !== 'linear') throw new Error(`--scale: unsupported value "${priceScale}" (use log|linear)`);
        } else if (arg.startsWith('--')) {
            throw new Error(`Unknown flag "${arg}". Usage: dexbot tv <bot|pool-id|AssetA/AssetB> [--month N]`);
        } else if (!target) {
            target = arg;
        } else {
            throw new Error(`Unexpected argument "${arg}". Only one target is supported. Usage: dexbot tv <bot|pool-id|AssetA/AssetB> [--month N]`);
        }
    }
    return { target, months, chart, priceScale, help };
}

function isPoolIdTarget(target: string): boolean {
    return /^(1\.19\.\d+|\d+)$/.test(target.trim());
}

function findBotByTarget(target: string): { botKey: string; meta: any } | null {
    const settings = loadBotSettings();
    const entries = Array.isArray((settings as any)?.bots) ? (settings as any).bots : [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry) continue;
        if (isSameBotName(entry.name, target)) return { botKey: computeBotKey(entry, i), meta: entry };
    }
    const meta = loadBotMeta(target);
    if (meta) {
        const idx = entries.indexOf(meta);
        return { botKey: computeBotKey(meta, idx >= 0 ? idx : 0), meta };
    }
    return null;
}

function slugPart(value: any): string {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function monthsLabel(months: number): string {
    return Number.isInteger(months) ? `${months}m` : `${String(months).replace('.', 'p')}m`;
}

async function resolvePoolAssets(poolId: string, bitsharesClient: any): Promise<{ assetA: any; assetB: any }> {
    const fullId = normalizePoolId(poolId) as string;
    // Chain pool object via get_objects([poolId]) → asset_a / asset_b.
    const db = bitsharesClient.BitShares?.db;
    if (db && typeof db.get_objects === 'function') {
        try {
            const objs = await db.get_objects([fullId]);
            const pool = Array.isArray(objs) ? objs[0] : null;
            const idA = pool?.asset_a || pool?.asset_ids?.[0];
            const idB = pool?.asset_b || pool?.asset_ids?.[1];
            if (idA && idB) {
                const assets = typeof db.get_assets === 'function' ? await db.get_assets([String(idA), String(idB)]) : null;
                // Tolerate both [..] and [[..]] result shapes.
                const list = Array.isArray(assets) ? assets.flat(Infinity) : [];
                const metaA = list.find((a: any) => String(a?.id) === String(idA));
                const metaB = list.find((a: any) => String(a?.id) === String(idB));
                if (metaA && metaB) {
                    return {
                        assetA: { id: String(metaA.id), precision: Number(metaA.precision), symbol: String(metaA.symbol || idA) },
                        assetB: { id: String(metaB.id), precision: Number(metaB.precision), symbol: String(metaB.symbol || idB) },
                    };
                }
            }
        } catch (_) {
            // Fall through to Kibana discovery below.
        }
    }
    // Fallback: Kibana discovery (what went into the pool) + chain precision lookup.
    const { discoverPoolAssets } = await import('../market_adapter/inputs/kibana_source.js');
    const ids = await discoverPoolAssets(fullId, {});
    if (!Array.isArray(ids) || ids.length !== 2) {
        throw new Error(`Pool ${fullId}: expected exactly 2 assets, discovered [${(ids || []).join(', ')}]. Pass AssetA/AssetB instead.`);
    }
    const [idA, idB] = ids.map(String);
    const assets = await db.get_assets([idA, idB]);
    const metaA = (assets || []).find((a: any) => String(a?.id) === idA);
    const metaB = (assets || []).find((a: any) => String(a?.id) === idB);
    if (!metaA || !metaB || !Number.isFinite(Number(metaA.precision)) || !Number.isFinite(Number(metaB.precision))) {
        throw new Error(`Pool ${fullId}: failed to resolve asset metadata for ${idA}/${idB}`);
    }
    return {
        assetA: { id: idA, precision: Number(metaA.precision), symbol: String(metaA.symbol || idA) },
        assetB: { id: idB, precision: Number(metaB.precision), symbol: String(metaB.symbol || idB) },
    };
}

async function run(): Promise<void> {
    // Mute chain connection chatter first — shared helper, console.error untouched.
    muteChainLogs();
    const { target, months, chart, priceScale, help } = parseArgs(process.argv.slice(2));
    if (help || !target) {
        printUsage();
        if (!target && !help) process.exit(1);
        process.exit(0);
    }

    const lookbackHours = Math.max(1, Math.round(months * HOURS_PER_MONTH));
    const bucketMs = INTERVAL_SECONDS * 1000;
    const endMs = Math.floor(Date.now() / bucketMs) * bucketMs;
    const startMs = endMs - lookbackHours * 3600 * 1000;
    const timeRange = { gte: new Date(startMs).toISOString(), lte: new Date(endMs).toISOString() };

    // Classify the target locally first so a typo'd bot / malformed pair
    // fails fast without waiting for a chain connection.
    const botHit = findBotByTarget(target as string);
    const poolTarget = !botHit && isPoolIdTarget(target as string);
    const pairTarget = !botHit && !poolTarget && (target as string).includes('/');
    const pairParts = pairTarget ? (target as string).split('/').map((s) => s.trim()).filter(Boolean) : [];
    if (!botHit && !poolTarget && !pairTarget) {
        const settings = loadBotSettings();
        const entries = Array.isArray((settings as any)?.bots) ? (settings as any).bots : [];
        const keys = entries.map((b: any, i: number) => computeBotKey(b, i)).filter(Boolean);
        throw new Error(`Unknown target "${target}". Use a bot name/key${keys.length ? ` (${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''})` : ''}, a pool id (e.g. 133), or AssetA/AssetB.`);
    }
    if (pairTarget && pairParts.length !== 2) throw new Error(`Invalid pair "${target}". Use AssetA/AssetB, e.g. TOKENA/TOKENB`);

    const bitsharesClient = await import('../modules/bitshares_client.js');
    const { waitForConnected } = bitsharesClient;
    await waitForConnected();

    let tmpFile: string | null = null;
    try {
        let assetA: any;
        let assetB: any;
        let poolId: string | null = null;
        let sourceLabel = '';
        let botKey: string | null = null;
        let botMeta: any = null;

        if (botHit) {
            botKey = botHit.botKey;
            botMeta = botHit.meta;
            const symA = botMeta.assetA;
            const symB = botMeta.assetB;
            if (!symA || !symB) throw new Error(`Bot '${target}' has no assetA/assetB pair in profiles/bots.json`);
            const [metaA, metaB] = await Promise.all([resolveAsset(symA, bitsharesClient), resolveAsset(symB, bitsharesClient)]);
            assetA = { id: metaA.id, precision: metaA.precision, symbol: symA };
            assetB = { id: metaB.id, precision: metaB.precision, symbol: symB };
            try {
                poolId = (await findPoolByAssets(assetA.id, assetB.id, { bitsharesClient, sortBy: 'assetABalance' })).id;
            } catch (_) {
                poolId = null;
            }
            sourceLabel = poolId ? `pool ${poolId}` : 'orderbook';
        } else if (poolTarget) {
            poolId = normalizePoolId((target as string).trim()) as string;
            const resolved = await resolvePoolAssets(poolId, bitsharesClient);
            assetA = resolved.assetA;
            assetB = resolved.assetB;
            sourceLabel = `pool ${poolId}`;
        } else {
            const [metaA, metaB] = await Promise.all([resolveAsset(pairParts[0], bitsharesClient), resolveAsset(pairParts[1], bitsharesClient)]);
            assetA = { id: metaA.id, precision: metaA.precision, symbol: pairParts[0] };
            assetB = { id: metaB.id, precision: metaB.precision, symbol: pairParts[1] };
            try {
                poolId = (await findPoolByAssets(assetA.id, assetB.id, { bitsharesClient, sortBy: 'assetABalance' })).id;
            } catch (_) {
                poolId = null;
            }
            sourceLabel = poolId ? `pool ${poolId}` : 'orderbook';
        }

        // ── Data pull (the only job of this script) ──────────────────────────
        // Both paths reuse the existing Kibana infrastructure in 1-month
        // windows: LP goes through the fetcher's manifest/resume + per-chunk
        // timeout/retry machinery, book fills use the same windowing with the
        // shared mergeCandles helper. No fetch logic is duplicated here.
        const TV_CHUNK_MONTHS = 1;
        console.log(`[tv] Fetching 1h candles (${months}mo, ${timeRange.gte.slice(0, 10)} → ${timeRange.lte.slice(0, 10)}) from ${sourceLabel} for ${assetA.symbol}/${assetB.symbol}...`);
        let candles: any[];
        if (poolId) {
            candles = await fetchCandlesSequentially(poolId, assetA, assetB, {
                intervalSeconds: INTERVAL_SECONDS,
                timeRange,
                chunkMonths: TV_CHUNK_MONTHS,
            }, outputPath(poolId, INTERVAL_SECONDS, assetA, assetB));
        } else {
            const windows = buildFetchWindowsFromRange(timeRange, TV_CHUNK_MONTHS);
            let merged: any[] = [];
            for (let w = 0; w < windows.length; w++) {
                console.log(`  Window ${w + 1}/${windows.length}: ${windows[w].gte.slice(0, 10)} → ${windows[w].lte.slice(0, 10)}`);
                const part = await getMarketCandles(assetA, assetB, { intervalSeconds: INTERVAL_SECONDS, timeRange: windows[w] });
                console.log(`    -> ${part.length} candles`);
                merged = merged.length === 0
                    ? part
                    : mergeCandles(merged, part, {
                        onCollision: (existing: any, incoming: any) => incoming[5] > existing[5] ? incoming : existing,
                    });
            }
            candles = merged;
        }
        if (!Array.isArray(candles) || candles.length === 0) throw new Error('No candles returned for the requested range');
        console.log(`[tv] Fetched ${candles.length} candles`);

        tmpFile = path.join(os.tmpdir(), `dexbot-tv-${sanitizeKey(botKey || assetA.symbol + '-' + assetB.symbol)}-${process.pid}.json`);
        fs.writeFileSync(tmpFile, JSON.stringify({
            meta: {
                fetchedAt: new Date().toISOString(),
                source: `dexbot tv (${sourceLabel})`,
                pool: poolId,
                assetA: { id: assetA.id, precision: assetA.precision, symbol: assetA.symbol },
                assetB: { id: assetB.id, precision: assetB.precision, symbol: assetB.symbol },
                intervalSeconds: INTERVAL_SECONDS,
                lookbackHours,
                format: '[timestamp_ms, open, high, low, close, volume_A]',
            },
            candles,
        }), 'utf8');

        // ── Delegate rendering to the existing TradingView exporter ──────────
        const analyzer = path.join(__dirname, '..', 'analysis', 'tradingview', 'analyze_tradingview.js');
        if (!fs.existsSync(analyzer)) throw new Error(`TradingView exporter not found at ${analyzer} (run npm run build first)`);
        const baseName = botKey
            ? `tv_${sanitizeKey(botKey)}`
            : poolId
                ? `tv_pool_${String(poolId).replace(/^1\.19\./, '')}`
                : `tv_${slugPart(assetA.symbol)}_${slugPart(assetB.symbol)}`;
        const chartFile = chart
            ? path.resolve(chart)
            : path.join(PATHS.ANALYSIS.CHARTS_DIR, `${baseName}_1h_${monthsLabel(months)}.html`);
        const label = poolId ? `Pool ${String(poolId).replace(/^1\.19\./, '')}` : `${assetA.symbol}/${assetB.symbol}`;
        const title = botKey && botMeta?.name ? `${botMeta.name} · ${label} · 1h · TradingView` : `${label} · 1h · TradingView`;
        const analyzerArgs = ['--file', tmpFile, '--chart', chartFile, '--title', title, '--scale', priceScale];
        if (botKey) {
            // Same AMA overlay the exporter resolves for this bot.
            const ama = resolveAmaConfig(botKey);
            analyzerArgs.push('--bot-key', botKey,
                '--ama-er-period', String(ama.erPeriod),
                '--ama-fast-period', String(ama.fastPeriod),
                '--ama-slow-period', String(ama.slowPeriod));
        }
        const result = spawnSync(process.execPath, [analyzer, ...analyzerArgs], { stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`TradingView exporter exited with status ${result.status}`);
        try { fs.unlinkSync(tmpFile); } catch (_) { /* keep on failure path only */ }
        tmpFile = null;
    } finally {
        try {
            const { disconnectClient: dc } = await import('../modules/bitshares_client.js');
            dc();
        } catch (_) { /* best-effort */ }
        // The BitShares WS + node monitor keep the event loop alive; exit explicitly.
        setTimeout(() => process.exit(0), 50).unref();
    }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
    run().catch((err: unknown) => {
        console.error(`[tv] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    });
}

export { parseArgs, isPoolIdTarget }
