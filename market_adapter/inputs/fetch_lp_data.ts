/**
 * FETCH LP PRICE DATA FROM KIBANA — Pool-centric
 *
 * Reads profiles/bots.json for asset pairs, connects to
 * the BitShares blockchain to resolve asset precisions and the pool ID
 * (using the same logic as derivePoolPrice in modules/order/utils/system.ts),
 * then fetches all swap history from Kibana and exports OHLCV candles to JSON.
 *
 * Usage:
 *   node dist/market_adapter/inputs/fetch_lp_data.js
 *   node dist/market_adapter/inputs/fetch_lp_data.js --bot <botName> --interval 4h --lookback 8760h
 *
 * Manual override (no blockchain connection needed):
 *   node dist/market_adapter/inputs/fetch_lp_data.js --pool <poolId> --precA <precA> --precB <precB>
 *
 * Date range fetch (for historical windows or multi-step fetching):
 *   node dist/market_adapter/inputs/fetch_lp_data.js --pool <poolId> --precA <precA> --precB <precB> --interval 1h --start 2024-03-06 --end 2025-03-06
 *   node dist/market_adapter/inputs/fetch_lp_data.js --pool <poolId> --precA <precA> --precB <precB> --interval 1h --start 2025-03-06 --end 2026-03-06
 *
 * Output:
 *   market_adapter/data/lp/<assetA>_<assetB>/lp_pool_<poolId>_<interval>.json
 *
 * Precision:
 *   Resolved automatically from the BitShares blockchain via lookup_asset_symbols.
 *   Use --precA / --precB to override if needed.
 */


import { path } from '../../modules/path_api.js';
import { getStorage } from '../../modules/storage/index.js';
import * as kibanaSource from './kibana_source.js';
import { mergeCandles } from '../candle_utils.js';
import { toIntervalLabel } from '../interval_utils.js';
import { parseJsonWithComments } from '../../modules/order/utils/system.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { normalizePoolId, resolveAsset, findPoolByAssets } from '../utils/chain.js';
import { writeJsonAtomic } from '../utils/atomic_write.js';
import { PATHS } from '../../modules/paths.js';
import * as bitsharesClient from '../../modules/bitshares_client.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { pathToFileURL } from 'node:url';
'use strict';

const storage = getStorage();
const { readJSON } = storage;

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: {
    intervalSeconds: number;
    lookbackHours: number;
    apiKey: string | null;
    chunkMonths: number;
    timeRange?: { gte?: string; lte?: string };
    outPath?: string;
} = {
    intervalSeconds: 3600,
    lookbackHours: 26280,
    apiKey: null,
    chunkMonths: MARKET_ADAPTER.KIBANA_FETCH_CHUNK_MONTHS,
};

const FETCH_TIMEOUT_MS = MARKET_ADAPTER.KIBANA_REQUEST_TIMEOUT_MS;
const FETCH_MAX_ATTEMPTS = MARKET_ADAPTER.RUNTIME_DEFAULTS.sourceRetries;
const FETCH_MANIFEST_VERSION = 1;

const BOTS_JSON = PATHS.PROFILES.BOTS_JSON;

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args   = process.argv.slice(2);
    const config = { ...DEFAULT_CONFIG };
    let poolId: string | null = null;   // null = auto-discover from bots.json
    let botName: string | null = null;
    let precA: number | null = null;   // null = auto from blockchain
    let precB: number | null = null;

    const intervalMap = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const val = args[i + 1];

        switch (arg) {
            case '--bot':      botName                = val; i++; break;
            case '--pool':     poolId                 = val; i++; break;
            case '--interval': config.intervalSeconds = (intervalMap as Record<string, number>)[val] ?? parseInt(val, 10); i++; break;
            case '--lookback': config.lookbackHours   = parseInt(val.replace('h', ''), 10); i++; break;
            case '--chunkMonths': config.chunkMonths  = parseInt(val, 10); i++; break;
            case '--precA':    precA                  = parseInt(val, 10); i++; break;
            case '--precB':    precB                  = parseInt(val, 10); i++; break;
            case '--apiKey':   config.apiKey          = val; i++; break;
            case '--start':    config.timeRange       = { ...(config.timeRange || {}), gte: val }; i++; break;
            case '--end':      config.timeRange       = { ...(config.timeRange || {}), lte: val }; i++; break;
            case '--out':      config.outPath         = val; i++; break;
        }
    }

    return { poolId, botName, precA, precB, config };
}

// ─── Output path ──────────────────────────────────────────────────────────────

function slugPart(value: any) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';
}

function pairFolderName(assetA: any, assetB: any) {
    return `${slugPart(assetA?.symbol)}_${slugPart(assetB?.symbol)}`;
}

function outputPath(poolId: any, intervalSeconds: any, assetA: any, assetB: any) {
    const label = toIntervalLabel(intervalSeconds);
    const id  = String(poolId).replace('1.19.', '');
    const pairFolder = pairFolderName(assetA, assetB);
    return path.join(PATHS.MARKET_ADAPTER.LP_DATA_DIR, pairFolder, `lp_pool_${id}_${label}.json`);
}

function applyPrecisionOverrides(assetA: any, assetB: any, precA: any, precB: any) {
    return {
        assetA: precA != null ? { ...assetA, precision: precA } : assetA,
        assetB: precB != null ? { ...assetB, precision: precB } : assetB,
    };
}

function pairFolderPath(assetASymbol: any, assetBSymbol: any) {
    return path.join(PATHS.MARKET_ADAPTER.LP_DATA_DIR, pairFolderName(
        { symbol: assetASymbol },
        { symbol: assetBSymbol }
    ));
}

function manifestPathFor(outPath: any) {
    return `${outPath}.fetch_manifest.json`;
}

function chunkPathFor(outPath: any, index: any, window: any) {
    const parsed = path.parse(outPath);
    const start = window.gte.slice(0, 10);
    const end = window.lte.slice(0, 10);
    return path.join(parsed.dir, `${parsed.name}.chunk_${String(index).padStart(2, '0')}_${start}_${end}${parsed.ext}`);
}

function addUtcMonths(date: any, months: any) {
    const result = new Date(date.getTime());
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(
        result.getUTCFullYear(),
        result.getUTCMonth() + 1,
        0
    )).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
}

function normalizeDateInput(raw: any, label: any) {
    const ms = Date.parse(String(raw || ''));
    if (!Number.isFinite(ms)) {
        throw new Error(`Invalid ${label} date: ${raw}`);
    }
    return new Date(ms);
}

function resolveChunkMonths(config: any) {
    const months = Number(config.chunkMonths);
    if (!Number.isFinite(months) || months <= 0) {
        throw new Error(`Invalid chunkMonths: ${config.chunkMonths}`);
    }
    return Math.max(1, Math.round(months));
}

function normalizeLookbackRange(config: any, nowMs: any = Date.now()) {
    const lookbackHours = Number(config.lookbackHours);
    if (!Number.isFinite(lookbackHours) || lookbackHours <= 0) {
        throw new Error(`Invalid lookbackHours: ${config.lookbackHours}`);
    }

    const bucketMs = Number(config.intervalSeconds) * 1000;
    const safeBucketMs = Number.isFinite(bucketMs) && bucketMs > 0 ? bucketMs : MARKET_ADAPTER.RUNTIME_DEFAULTS.intervalSeconds * 1000;
    const endMs = Math.floor(nowMs / safeBucketMs) * safeBucketMs;
    const startMs = endMs - (lookbackHours * 3600 * 1000);
    return {
        gte: new Date(startMs).toISOString(),
        lte: new Date(endMs).toISOString(),
    };
}

function buildFetchWindowsFromRange(timeRange: any, chunkMonths: any) {
    let start;
    let end;

    start = normalizeDateInput(timeRange.gte, 'start');
    end = normalizeDateInput(timeRange.lte, 'end');

    if (start >= end) {
        throw new Error(`Invalid fetch range: ${start.toISOString()} must be earlier than ${end.toISOString()}`);
    }

    const windows: any[] = [];
    let cursor = start;
    while (cursor < end) {
        const next = addUtcMonths(cursor, chunkMonths);
        const windowEnd = next < end ? next : end;
        windows.push({
            gte: cursor.toISOString(),
            lte: windowEnd.toISOString(),
        });
        cursor = windowEnd;
    }

    return windows;
}

function loadManifest(manifestPath: any) {
    if (!storage.exists(manifestPath)) return null;
    try {
        return readJSON(manifestPath);
    } catch (_: any) {
        return null;
    }
}

function loadCachedFetchContext(bot: any, intervalSeconds: any) {
    const dir = pairFolderPath(bot.assetA, bot.assetB);
    if (!storage.exists(dir)) return null;

    const label = toIntervalLabel(intervalSeconds);
    const manifestFiles = storage.readdir(dir)
        .filter((name: any) => name.endsWith(`${label}.json.fetch_manifest.json`))
        .sort();

    for (const file of manifestFiles) {
        const manifest = loadManifest(path.join(dir, file));
        const request = manifest?.request;
        if (!request) continue;
        if (request.intervalSeconds !== intervalSeconds) continue;
        if (request.assetA?.symbol !== bot.assetA) continue;
        if (request.assetB?.symbol !== bot.assetB) continue;
        if (!request.pool || !request.assetA?.id || !request.assetB?.id) continue;
        if (!Number.isFinite(request.assetA?.precision) || !Number.isFinite(request.assetB?.precision)) continue;
        return {
            poolId: request.pool,
            assetA: request.assetA,
            assetB: request.assetB,
            source: 'manifest',
            path: path.join(dir, file),
        };
    }

    const dataFiles = storage.readdir(dir)
        .filter((name: any) => name.endsWith(`${label}.json`) && !name.includes('.chunk_') && !name.endsWith('.fetch_manifest.json'))
        .sort();

    for (const file of dataFiles) {
        try {
            const parsed = readJSON(path.join(dir, file));
            const meta = parsed?.meta;
            if (!meta) continue;
            if (meta.intervalSeconds !== intervalSeconds) continue;
            if (meta.assetA?.symbol !== bot.assetA) continue;
            if (meta.assetB?.symbol !== bot.assetB) continue;
            if (!meta.pool || !meta.assetA?.id || !meta.assetB?.id) continue;
            if (!Number.isFinite(meta.assetA?.precision) || !Number.isFinite(meta.assetB?.precision)) continue;
            return {
                poolId: meta.pool,
                assetA: meta.assetA,
                assetB: meta.assetB,
                source: 'data',
                path: path.join(dir, file),
            };
        } catch (_: any) {}
    }

    return null;
}

function sameRequest(a: any, b: any) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function buildRequestKey(config: any, fullPoolId: any, assetA: any, assetB: any, timeRange: any, outPath: any) {
    const chunkMonths = resolveChunkMonths(config);
    return {
        pool: fullPoolId,
        assetA: { id: assetA.id, precision: assetA.precision, symbol: assetA.symbol },
        assetB: { id: assetB.id, precision: assetB.precision, symbol: assetB.symbol },
        intervalSeconds: config.intervalSeconds,
        lookbackHours: config.timeRange ? null : config.lookbackHours,
        timeRange,
        outPath: path.resolve(outPath),
        chunkMonths,
    };
}

function buildManifest(requestKey: any, windows: any, outPath: any) {
    return {
        version: FETCH_MANIFEST_VERSION,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        request: requestKey,
        status: 'in_progress',
        windows: windows.map((window: any, idx: any) => ({
            index: idx + 1,
            gte: window.gte,
            lte: window.lte,
            file: chunkPathFor(outPath, idx + 1, window),
            status: 'pending',
            candleCount: null,
            firstTs: null,
            lastTs: null,
            completedAt: null,
            lastError: null,
        })),
    };
}

function saveManifest(manifestPath: any, manifest: any) {
    manifest.updatedAt = new Date().toISOString();
    writeJsonAtomic(manifestPath, manifest);
}

function validateChunkFile(chunkFile: any, requestKey: any, windowEntry: any) {
    if (!storage.exists(chunkFile)) return null;
    try {
        const parsed = readJSON(chunkFile);
        const meta = parsed?.meta || {};
        if (meta.pool !== requestKey.pool) return null;
        if (meta.intervalSeconds !== requestKey.intervalSeconds) return null;
        if (meta.assetA?.id !== requestKey.assetA.id || meta.assetB?.id !== requestKey.assetB.id) return null;
        if (meta.assetA?.precision !== requestKey.assetA.precision || meta.assetB?.precision !== requestKey.assetB.precision) return null;
        if (meta.timeRange?.gte !== windowEntry.gte || meta.timeRange?.lte !== windowEntry.lte) return null;
        if (!Array.isArray(parsed.candles)) return null;
        const candles = parsed.candles;
        return {
            candles,
            candleCount: candles.length,
            firstTs: candles.length > 0 ? new Date(candles[0][0]).toISOString() : null,
            lastTs: candles.length > 0 ? new Date(candles[candles.length - 1][0]).toISOString() : null,
        };
    } catch (_: any) {
        return null;
    }
}

function persistChunkFile(chunkFile: any, requestKey: any, windowEntry: any, candles: any) {
    const payload = {
        meta: {
            fetchedAt: new Date().toISOString(),
            source: `https://kibana.bitshares.dev (bitshares-*, op_type 63, pool ${requestKey.pool})`,
            pool: requestKey.pool,
            assetA: requestKey.assetA,
            assetB: requestKey.assetB,
            intervalSeconds: requestKey.intervalSeconds,
            candleCount: candles.length,
            chunkIndex: windowEntry.index,
            timeRange: {
                gte: windowEntry.gte,
                lte: windowEntry.lte,
            },
            format: '[timestamp_ms, open, high, low, close, volume_A]',
        },
        candles,
    };
    writeJsonAtomic(chunkFile, payload);
}

function ensureManifest(config: any, fullPoolId: any, assetA: any, assetB: any, outPath: any, nowMs: any = Date.now()) {
    const manifestPath = manifestPathFor(outPath);
    const existing = loadManifest(manifestPath);
    const chunkMonths = resolveChunkMonths(config);
    const resolvedOutPath = path.resolve(outPath);

    if (
        existing
        && existing.version === FETCH_MANIFEST_VERSION
        && !config.timeRange
        && existing.status !== 'complete'
        && existing.request?.pool === fullPoolId
        && existing.request?.intervalSeconds === config.intervalSeconds
        && existing.request?.lookbackHours === config.lookbackHours
        && existing.request?.outPath === resolvedOutPath
        && existing.request?.chunkMonths === chunkMonths
        && existing.request?.assetA?.id === assetA.id
        && existing.request?.assetA?.precision === assetA.precision
        && existing.request?.assetB?.id === assetB.id
        && existing.request?.assetB?.precision === assetB.precision
        && Array.isArray(existing.windows)
        && existing.windows.length > 0
    ) {
        return { manifestPath, manifest: existing, requestKey: existing.request };
    }

    const effectiveTimeRange = config.timeRange
        ? { gte: config.timeRange.gte, lte: config.timeRange.lte }
        : normalizeLookbackRange(config, nowMs);
    const requestKey = buildRequestKey(config, fullPoolId, assetA, assetB, effectiveTimeRange, outPath);

    if (existing && existing.version === FETCH_MANIFEST_VERSION && sameRequest(existing.request, requestKey) && Array.isArray(existing.windows) && existing.windows.length > 0) {
        return { manifestPath, manifest: existing, requestKey };
    }

    const windows = buildFetchWindowsFromRange(effectiveTimeRange, chunkMonths);
    const manifest = buildManifest(requestKey, windows, outPath);
    saveManifest(manifestPath, manifest);
    return { manifestPath, manifest, requestKey };
}

async function withTimeout(run: any, timeoutMs: any, description: any) {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const timeoutMessage = `${description} timed out after ${Math.round(timeoutMs / 1000)}s`;

    timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(timeoutMessage));
    }, timeoutMs);

    try {
        return await run(controller.signal);
    } catch (err: any) {
        if (timedOut && (err?.name === 'AbortError' || err?.message === timeoutMessage)) {
            throw new Error(timeoutMessage);
        }
        throw err;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

async function fetchWindowCandles(fullPoolId: any, assetA: any, assetB: any, config: any, windowEntry: any, total: any) {
    const label = `${windowEntry.gte} → ${windowEntry.lte}`;
    let lastErr = null;

    for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
        console.log(`  Chunk ${windowEntry.index}/${total}: ${label} (attempt ${attempt}/${FETCH_MAX_ATTEMPTS})`);
        try {
            const candles = await withTimeout((signal: any) => kibanaSource.getLpCandlesForPool(fullPoolId, assetA, assetB, {
                    ...config,
                    timeout: FETCH_TIMEOUT_MS,
                    signal,
                    timeRange: {
                        gte: windowEntry.gte,
                        lte: windowEntry.lte,
                    },
                }),
                FETCH_TIMEOUT_MS,
                `Chunk ${windowEntry.index}/${total}`);
            console.log(`    -> ${candles.length} candles`);
            return candles;
        } catch (err: any) {
            lastErr = err;
            console.warn(`    retrying after failure: ${getErrorMessage(err)}`);
        }
    }

    throw lastErr;
}

async function fetchCandlesSequentially(fullPoolId: any, assetA: any, assetB: any, config: any, outPath: any) {
    const { manifestPath, manifest, requestKey } = ensureManifest(config, fullPoolId, assetA, assetB, outPath);
    const total = manifest.windows.length;
    const chunkMonths = resolveChunkMonths(config);

    if (total > 1) {
        console.log(`  Auto-splitting fetch into ${total} sequential ${chunkMonths}-month chunks`);
    }

    for (const windowEntry of manifest.windows) {
        const cached = validateChunkFile(windowEntry.file, requestKey, windowEntry);
        if (cached) {
            windowEntry.status = 'done';
            windowEntry.candleCount = cached.candleCount;
            windowEntry.firstTs = cached.firstTs;
            windowEntry.lastTs = cached.lastTs;
            windowEntry.lastError = null;
            console.log(`  Chunk ${windowEntry.index}/${total}: ${windowEntry.gte} → ${windowEntry.lte} (cached ${cached.candleCount} candles)`);
            saveManifest(manifestPath, manifest);
            continue;
        }

        windowEntry.status = 'fetching';
        windowEntry.lastError = null;
        saveManifest(manifestPath, manifest);

        try {
            const candles = await fetchWindowCandles(fullPoolId, assetA, assetB, config, windowEntry, total);
            persistChunkFile(windowEntry.file, requestKey, windowEntry, candles);
            windowEntry.status = 'done';
            windowEntry.candleCount = candles.length;
            windowEntry.firstTs = candles.length > 0 ? new Date(candles[0][0]).toISOString() : null;
            windowEntry.lastTs = candles.length > 0 ? new Date(candles[candles.length - 1][0]).toISOString() : null;
            windowEntry.completedAt = new Date().toISOString();
            windowEntry.lastError = null;
            saveManifest(manifestPath, manifest);
        } catch (err: any) {
            windowEntry.status = 'failed';
            windowEntry.lastError = getErrorMessage(err);
            saveManifest(manifestPath, manifest);
            throw err;
        }
    }

    let merged: any[] = [];
    for (const windowEntry of manifest.windows) {
        const cached = validateChunkFile(windowEntry.file, requestKey, windowEntry);
        if (!cached) {
            throw new Error(`Chunk file missing or invalid after fetch: ${path.relative(process.cwd(), windowEntry.file)}`);
        }
        merged = merged.length === 0
            ? cached.candles
            : mergeCandles(merged, cached.candles, {
                onCollision: (existing: any, incoming: any) => incoming[5] > existing[5] ? incoming : existing,
            });
    }

    manifest.status = 'complete';
    saveManifest(manifestPath, manifest);
    return merged;
}

// ─── bots.json helper ─────────────────────────────────────────────────────────

function loadBotsJson() {
    if (!storage.exists(BOTS_JSON)) {
        throw new Error(`bots.json not found at ${BOTS_JSON}`);
    }
    return parseBotsConfig(storage.readFile(BOTS_JSON), BOTS_JSON);
}

function parseBotsConfig(raw: any, sourceLabel: any = BOTS_JSON) {
    const parsed = parseJsonWithComments(raw);
    const bots = Array.isArray(parsed?.bots) ? parsed.bots : (Array.isArray(parsed) ? parsed : null);
    if (!bots) {
        throw new Error(`Invalid bots.json format: ${sourceLabel}`);
    }
    return bots;
}

/**
 * Pick a bot: by name if given, otherwise first active bot with startPrice: "pool".
 */
function selectBot(bots: any, botName: any) {
    if (botName) {
        const bot = bots.find((b: any) => b.name === botName);
        if (!bot) throw new Error(`Bot "${botName}" not found in bots.json`);
        return bot;
    }
    const bot = bots.find((b: any) => b.active && b.startPrice === 'pool');
    if (!bot) throw new Error('No active pool-price bot found in bots.json. Use --bot NAME to specify one.');
    return bot;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
    const { poolId: cliPoolId, botName, precA: cliPrecA, precB: cliPrecB, config } = parseArgs();

    const bucketLabel = toIntervalLabel(config.intervalSeconds);

    console.log('══════════════════════════════════════════════');
    console.log(' Kibana LP Fetcher — Pool-centric');
    console.log('══════════════════════════════════════════════');

    let fullPoolId, assetA, assetB;

    // ── Mode A: manual --pool override (no blockchain connection needed) ──────
    if (cliPoolId) {
        console.log(`  Mode:     Manual (--pool ${cliPoolId})`);
        fullPoolId = normalizePoolId(cliPoolId);

        // Still need to discover asset IDs from Kibana; precisions from CLI or default
        console.log(`  Pool:     ${fullPoolId}`);
        console.log(`  Interval: ${bucketLabel} candles`);
        console.log(`  Range:    ${config.timeRange ? `${config.timeRange.gte} → ${config.timeRange.lte}` : `last ${config.lookbackHours}h (${(config.lookbackHours / 24 / 365).toFixed(2)} years)`}`);
        console.log('══════════════════════════════════════════════');

        console.log(`\n[1/4] Discovering assets in pool ${fullPoolId}...`);
        let assetIds;
        try {
            assetIds = await kibanaSource.discoverPoolAssets(fullPoolId, config);
        } catch (err: any) {
            console.error(`  Discovery failed: ${getErrorMessage(err)}`);
            process.exit(1);
        }

        if (assetIds.length < 2) {
            console.error(`  Expected 2 asset IDs in pool trades, found ${assetIds.length}: [${assetIds.join(', ')}]. Widen the window with --lookback.`);
            process.exit(1);
        }
        if (assetIds.length > 2) {
            // Discovery buckets are ordered by trade count desc — picking the
            // "first two" of a larger set silently guesses the pair and can
            // flip between runs. Fail loudly instead.
            console.error(`  Expected exactly 2 asset IDs in pool trades, found ${assetIds.length}: [${assetIds.join(', ')}]. Narrow the window with --lookback or use auto mode (bots.json).`);
            process.exit(1);
        }

        const [idA, idB] = assetIds;
        if (cliPrecA == null || cliPrecB == null) {
            console.error(`Precisions required in manual mode. Use --precA and --precB.`);
            process.exit(1);
        }
        const precA = cliPrecA;
        const precB = cliPrecB;

        console.log(`  Asset A: ${idA} (precision ${precA})`);
        console.log(`  Asset B: ${idB} (precision ${precB})`);

        assetA = { id: idA, precision: precA, symbol: idA };
        assetB = { id: idB, precision: precB, symbol: idB };

    // ── Mode B: auto-resolve from bots.json + blockchain (default) ───────────
    } else {
        const bots = loadBotsJson();
        const bot  = selectBot(bots, botName);
        const cachedContext = loadCachedFetchContext(bot, config.intervalSeconds);

        console.log(`  Mode:     Auto (bots.json → blockchain → Kibana)`);
        console.log(`  Bot:      ${bot.name} (${bot.assetA} / ${bot.assetB})`);
        console.log(`  Interval: ${bucketLabel} candles`);
        console.log(`  Range:    ${config.timeRange ? `${config.timeRange.gte} → ${config.timeRange.lte}` : `last ${config.lookbackHours}h (${(config.lookbackHours / 24 / 365).toFixed(2)} years)`}`);
        console.log(`  Auth:     ${config.apiKey ? 'API key set' : 'open (no auth)'}`);
        console.log('══════════════════════════════════════════════');

        if (cachedContext) {
            console.log('\n[1/4] Reusing cached fetch context...');
            assetA = { ...cachedContext.assetA, symbol: bot.assetA };
            assetB = { ...cachedContext.assetB, symbol: bot.assetB };
            ({ assetA, assetB } = applyPrecisionOverrides(assetA, assetB, cliPrecA, cliPrecB));
            fullPoolId = cachedContext.poolId;
            console.log(`  Source:  ${cachedContext.source} (${path.relative(process.cwd(), cachedContext.path)})`);
            console.log(`  Asset A: ${bot.assetA} → ${assetA.id} (precision ${assetA.precision})`);
            console.log(`  Asset B: ${bot.assetB} → ${assetB.id} (precision ${assetB.precision})`);
            console.log(`  Pool:    ${fullPoolId}`);
        } else {
            const { waitForConnected } = bitsharesClient;

            // ── Step 1: Connect + resolve asset metadata ─────────────────────────
            console.log('\n[1/4] Connecting to BitShares and resolving asset metadata...');
            await waitForConnected();
            console.log('  Connected.');

            let metaA, metaB;
            try {
                [metaA, metaB] = await Promise.all([
                    resolveAsset(bot.assetA, bitsharesClient),
                    resolveAsset(bot.assetB, bitsharesClient),
                ]);
            } catch (err: any) {
                console.error(`  Asset resolution failed: ${getErrorMessage(err)}`);
                process.exit(1);
            }

            assetA = { id: metaA.id, precision: metaA.precision, symbol: bot.assetA };
            assetB = { id: metaB.id, precision: metaB.precision, symbol: bot.assetB };
            ({ assetA, assetB } = applyPrecisionOverrides(assetA, assetB, cliPrecA, cliPrecB));

            console.log(`  Asset A: ${bot.assetA} → ${assetA.id} (precision ${assetA.precision})`);
            console.log(`  Asset B: ${bot.assetB} → ${assetB.id} (precision ${assetB.precision})`);

            // ── Step 2: Find liquidity pool ───────────────────────────────────────
            console.log(`\n[2/4] Finding liquidity pool for ${bot.assetA} / ${bot.assetB}...`);
            let pool;
            try {
                pool = await findPoolByAssets(assetA.id, assetB.id, { bitsharesClient, sortBy: 'assetABalance' });
            } catch (err: any) {
                console.error(`  Pool lookup failed: ${getErrorMessage(err)}`);
                process.exit(1);
            }

            fullPoolId = pool.id;
            console.log(`  Pool:    ${fullPoolId}`);
        }
    }

    // ── Probe (or renumber steps in manual mode) ──────────────────────────────
    const stepProbe  = cliPoolId ? 2 : 3;
    const stepFetch  = cliPoolId ? 3 : 4;

    // The probe is informational (nothing branches on it): with --start/--end
    // it checks the range actually being fetched; otherwise a cheap recent
    // window capped at 48h. The resolved window below feeds BOTH the query and
    // the labels, so they can never diverge.
    const probeCapHours = Math.min(config.lookbackHours, 48);
    const probeTimeRange = config.timeRange
        ? {
            gte: config.timeRange.gte ?? new Date(Date.now() - probeCapHours * 3600 * 1000).toISOString(),
            lte: config.timeRange.lte ?? new Date().toISOString(),
        }
        : null;
    const probeWindowLabel = probeTimeRange
        ? `${probeTimeRange.gte} → ${probeTimeRange.lte}`
        : `last ${probeCapHours}h`;

    console.log(`\n[${stepProbe}/4] Probing data availability (${probeWindowLabel})...`);
    try {
        const probeCandles = await kibanaSource.getLpCandlesForPool(fullPoolId, assetA, assetB, {
            ...config,
            timeout: FETCH_TIMEOUT_MS,
            lookbackHours: probeCapHours,
            fillGaps: false,
            fillGapsToRequestedRange: false,
            timeRange: probeTimeRange,
        });
        const volumeCandles = probeCandles.filter((c: any) => Number(c[5] || 0) > 0);
        const nonFlatCandles = volumeCandles.filter((c: any) => c[1] !== c[2] || c[1] !== c[3] || c[1] !== c[4]);

        console.log(`  Candles with trades in probed window: ${volumeCandles.length}`);
        console.log(`  Non-flat OHLC candles:               ${nonFlatCandles.length}`);

        const sample = volumeCandles[0];
        if (sample) {
            console.log(`  Sample candle: ${new Date(sample[0]).toISOString()} O=${sample[1]} H=${sample[2]} L=${sample[3]} C=${sample[4]} vol=${sample[5]}`);
        } else {
            console.warn('  No trade candles in the probed window — pool may be inactive during this period. Proceeding with full fetch.');
        }
    } catch (err: any) {
        console.error(`  Probe failed: ${getErrorMessage(err)}`);
        process.exit(1);
    }

    const outPath = config.outPath
        ? path.resolve(config.outPath)
        : outputPath(fullPoolId, config.intervalSeconds, assetA, assetB);

    // ── Fetch full history ────────────────────────────────────────────────────
    console.log(`\n[${stepFetch}/4] Fetching full history (${config.lookbackHours}h, ${bucketLabel} buckets)...`);
    let candles;
    try {
        candles = await fetchCandlesSequentially(fullPoolId, assetA, assetB, config, outPath);
        console.log(`  Total candles: ${candles.length}`);

        if (candles.length === 0) {
            console.error('  No candles returned.');
            process.exit(1);
        }

        const firstTs  = new Date(candles[0][0]).toISOString();
        const lastTs   = new Date(candles[candles.length - 1][0]).toISOString();
        const closes   = candles.map((c: any) => c[4]);
        const minPrice = Math.min(...closes);
        const maxPrice = Math.max(...closes);
        const avgPrice = closes.reduce((a: any, b: any) => a + b, 0) / closes.length;

        console.log(`  Date range:  ${firstTs}  →  ${lastTs}`);
        console.log(`  Price range: ${minPrice.toFixed(8)} – ${maxPrice.toFixed(8)}`);
        console.log(`  Avg price:   ${avgPrice.toFixed(8)}  (${assetB.symbol} per ${assetA.symbol})`);
    } catch (err: any) {
        console.error(`  Fetch failed: ${getErrorMessage(err)}`);
        process.exit(1);
    }

    // ── Save ──────────────────────────────────────────────────────────────────
    console.log('\n[4/4] Saving...');
    const pair = {
        symbols: `${assetA.symbol}/${assetB.symbol}`,
        ids: `${assetA.id}/${assetB.id}`,
        keyBySymbols: `${assetA.symbol}|${assetB.symbol}`,
        keyByIds: `${assetA.id}|${assetB.id}`,
    };

    const output = {
        meta: {
            fetchedAt:       new Date().toISOString(),
            source:          `https://kibana.bitshares.dev (bitshares-*, op_type 63, pool ${fullPoolId})`,
            pool:            fullPoolId,
            assetA,
            assetB,
            pair,
            intervalSeconds: config.intervalSeconds,
            lookbackHours:   config.lookbackHours,
            candleCount:     candles.length,
            priceUnit:       `${assetB.symbol} per ${assetA.symbol}`,
            // Candle format: [timestamp_ms, open, high, low, close, volume_in_assetA]
            // Raw Kibana LP exchange documents are ordered and converted to true OHLC.
            // If both swap directions exist in the same interval, they share one
            // B-per-A candle and volume is expressed in assetA units.
            // Actual received used (operation_result_object), not min_to_receive.
            format:          '[timestamp_ms, open, high, low, close, volume_A]',
        },
        candles,
    };

    writeJsonAtomic(outPath, output);
    const kb = ((storage.stat(outPath) as any).size / 1024).toFixed(1);
    console.log(`  Saved: ${path.relative(process.cwd(), outPath)}  (${kb} KB)`);

    console.log('\nNext — chart it:');
    console.log(`  npm run lp:chart -- --data ${path.relative(process.cwd(), outPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    run().catch((err: any) => {
        console.error('Fatal:', err);
        process.exit(1);
    });
}

export { applyPrecisionOverrides, parseBotsConfig, selectBot }

