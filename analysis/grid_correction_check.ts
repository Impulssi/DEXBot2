#!/usr/bin/env node
'use strict';

/**
 * GRID CORRECTION CHECK
 *
 * Validates LAST-FILL-GUARD discipline (ceb53819): pivot ± halfIncrement
 *   Last fill @x with increment i (half=i/2) gates BOTH sides regardless of
 *   last side — BUY must be < x*(1-half/100), SELL > x*(1+half/100).
 *   e.g. x=1000, i=0.5% => BUY < 997.5 / SELL > 1002.5.
 *   Cold start (no previous fill) is disabled.
 *   Intentional offline gaps (documented, acceptable):
 *   - Runtime pivots on _lastFilledPrice/_lastFilledType at decision time; tool
 *     checks consecutive fill pairs. For batch-placed orders (multiple orders
 *     guarded against the same pivot in one COW batch) this diverges — inherent
 *     offline approximation.
 *   - Spread-correction bypass (cowResult.origin === 'spread-correction') is
 *     not simulated — every consecutive pair is checked.
 *
 * Mirrors modules/dexbot_cow_runtime.ts:isLastFillGuardBlocked 1:1 and
 * modules/constants.ts:DEFAULT_CONFIG.incrementPercent fallback (0.5).
 *
 * Fetches fill_order operations from Kibana (same pipeline as
 * trade_profitability.ts) and checks for price-order violations.
 *
 * Usage:
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 168
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --start 2025-01-01 --end 2025-06-01
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720 --account 1.2.123
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720 --json results.json
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720 --csv violations.csv
 *   node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720 --increment 0.5
 *   node dist/analysis/grid_correction_check.js --list-bots
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as KC from '../market_adapter/core/kibana_client.js';
import * as C from '../modules/constants.js';
import { loadBotMeta, loadBotSettings, computeBotKey } from './bot_key_utils.js';

const { kibanaSearch, DEFAULT_CONFIG: BASE_CONFIG } = KC;

const OP_FILL_ORDER = 4;
const BTS_ID = '1.3.0';

interface AssetInfo { symbol: string; precision: number; }
const ASSETS: Record<string, AssetInfo> = {
    '1.3.0':    { symbol: 'BTS',          precision: 5 },
    '1.3.118':  { symbol: 'GBP',          precision: 4 },
    '1.3.119':  { symbol: 'JPY',          precision: 2 },
    '1.3.120':  { symbol: 'EUR',          precision: 4 },
    '1.3.1325': { symbol: 'RUBLE',        precision: 5 },
    '1.3.2512': { symbol: 'EVRAZ',        precision: 4 },
    '1.3.3291': { symbol: 'TWENTIX',      precision: 5 },
    '1.3.4099': { symbol: 'XBTSX.STH',    precision: 6 },
    '1.3.4156': { symbol: 'XBTSX.DOGE',   precision: 5 },
    '1.3.4157': { symbol: 'XBTSX.BTC',    precision: 8 },
    '1.3.4159': { symbol: 'XBTSX.LTC',    precision: 8 },
    '1.3.4176': { symbol: 'XBTSX.DASH',   precision: 8 },
    '1.3.4274': { symbol: 'XBTSX.BCH',    precision: 8 },
    '1.3.4760': { symbol: 'XBTSX.ETH',    precision: 7 },
    '1.3.5537': { symbol: 'IOB.XRP',      precision: 4 },
    '1.3.5541': { symbol: 'XBTSX.BNB',    precision: 7 },
    '1.3.5589': { symbol: 'XBTSX.USDT',   precision: 6 },
    '1.3.5641': { symbol: 'HONEST.CNY',   precision: 4 },
    '1.3.5649': { symbol: 'HONEST.USD',   precision: 4 },
    '1.3.5650': { symbol: 'HONEST.BTC',   precision: 8 },
    '1.3.5659': { symbol: 'HONEST.ETH',   precision: 6 },
    '1.3.5870': { symbol: 'XBTSX.FIL',    precision: 6 },
    '1.3.5887': { symbol: 'XBTSX.RUB',    precision: 4 },
    '1.3.5902': { symbol: 'XBTSX.USDC',   precision: 6 },
    '1.3.6013': { symbol: 'XBTSX.HIVE',   precision: 6 },
    '1.3.6124': { symbol: 'XBTSX.AVAX',   precision: 6 },
    '1.3.6139': { symbol: 'XBTSX.XAUT',   precision: 6 },
    '1.3.6166': { symbol: 'XBTSX.MATIC',  precision: 5 },
    '1.3.6241': { symbol: 'XBTSX.ETC',    precision: 7 },
    '1.3.6268': { symbol: 'BTWTY.EOS',    precision: 4 },
    '1.3.6301': { symbol: 'HONEST.MONEY', precision: 8 },
    '1.3.6304': { symbol: 'HONEST.ADA',   precision: 8 },
    '1.3.6305': { symbol: 'HONEST.DOT',   precision: 8 },
    '1.3.6309': { symbol: 'HONEST.ATOM',  precision: 8 },
    '1.3.6311': { symbol: 'HONEST.ALGO',  precision: 8 },
    '1.3.6312': { symbol: 'HONEST.FIL',   precision: 8 },
    '1.3.6313': { symbol: 'HONEST.EOS',   precision: 8 },
    '1.3.6315': { symbol: 'HONEST.EUR',   precision: 4 },
    '1.3.6316': { symbol: 'HONEST.GBP',   precision: 4 },
    '1.3.6317': { symbol: 'HONEST.JPY',   precision: 4 },
    '1.3.6444': { symbol: 'IOB.XLM',      precision: 4 },
    '1.3.6573': { symbol: 'XBTSX.DAI',    precision: 6 },
    '1.3.6620': { symbol: 'XBTSX.A',      precision: 6 },
    '1.3.6627': { symbol: 'XBTSX.LINK',   precision: 6 },
};
const resolvedPrecisions: Record<string, number> = {};
function assetSymbol(id: string): string { return ASSETS[id]?.symbol ?? id; }
function assetPrec(id: string): number | undefined { return ASSETS[id]?.precision ?? resolvedPrecisions[id]; }
function toReal(amount: number, assetId: string): number {
    const p = assetPrec(assetId);
    if (p === undefined) return NaN;
    return amount / Math.pow(10, p);
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface FillRecord {
    time: string;
    blockNum: number;
    opNum: number;
    orderId: string;
    accountId: string;
    pays: { amount: number; asset_id: string };
    receives: { amount: number; asset_id: string };
    fee: { amount: number; asset_id: string };
    isMaker: boolean;
    sort: any[];
}
interface TradeFill {
    time: string;
    orderId: string;
    direction: 'buy' | 'sell';
    baseAsset: string;
    quoteAsset: string;
    baseAmount: number;
    quoteAmount: number;
    price: number;
    isMaker: boolean;
    sequence: number;
}
interface Violation {
    index: number;
    pair: string;
    direction: 'buy' | 'sell';
    expected: string;
    prev: TradeFill;
    curr: TradeFill;
    priceDelta: number;
    priceDeltaPct: number;
    pivot: number;
    halfInc: number;
    threshold: number;
}
interface AggregatedOrder {
    orderId: string;
    direction: 'buy' | 'sell';
    baseAsset: string;
    quoteAsset: string;
    baseAmount: number;
    quoteAmount: number;
    price: number;
    time: string;
    sequence: number;
    fillCount: number;
    isMaker: boolean;
}

// ─── LAST-FILL-GUARD helper (1:1 with dexbot_cow_runtime.ts) ─────────────────

/**
 * LAST-FILL-GUARD helper — pivot ± halfIncrement (replaces price-tolerance).
 *  last fill @x with increment i: BUY < x*(1 - i/2/100), SELL > x*(1 + i/2/100)
 *  e.g. x=1000, i=0.5% => BUY < 997.5, SELL > 1002.5
 * Cold (pivot null or lastType null) => disabled.
 * @param {number} price - Target order price
 * @param {string} type - buy/sell
 * @param {number|null} lastPrice - Most recent fill price
 * @param {string|null} lastType - Most recent fill side (buy/sell)
 * @param {number|any} incrementPercent - Grid increment percent (e.g. 0.5). If not finite/<=0 falls back to DEFAULT_CONFIG.
 * @returns {{blocked: boolean, pivot: number|null, halfInc: number, threshold: number|null}}
 */
function isLastFillGuardBlocked(
    price: any,
    type: any,
    lastPrice: any,
    lastType: any,
    incrementPercent: any,
): { blocked: boolean; pivot: number | null; halfInc?: number; threshold?: number | null } {
    const numPrice = Number(price);
    if (!Number.isFinite(numPrice)) return { blocked: false, pivot: null };
    if (lastPrice == null || !Number.isFinite(Number(lastPrice)) || lastType == null) return { blocked: false, pivot: null };
    const pivot = Number(lastPrice);
    let inc = Number(incrementPercent);
    if (!Number.isFinite(inc) || inc <= 0) {
        inc = Number((C as any)?.DEFAULT_CONFIG?.incrementPercent ?? 0.5);
    }
    if (!Number.isFinite(inc) || inc <= 0) return { blocked: false, pivot: null };
    const halfInc = inc / 2;
    const halfPct = halfInc / 100;
    const buyThreshold = pivot * (1 - halfPct);
    const sellThreshold = pivot * (1 + halfPct);
    if (type === 'buy' && numPrice > buyThreshold) return { blocked: true, pivot, halfInc, threshold: buyThreshold };
    if (type === 'sell' && numPrice < sellThreshold) return { blocked: true, pivot, halfInc, threshold: sellThreshold };
    return { blocked: false, pivot: null, halfInc, threshold: null };
}

function resolveIncrementPercent(botMeta: any, override: number | null): number {
    if (override != null && Number.isFinite(override) && override > 0) return override;
    const fromBot = Number(botMeta?.incrementPercent);
    if (Number.isFinite(fromBot) && fromBot > 0) return fromBot;
    const fromDefault = Number((C as any)?.DEFAULT_CONFIG?.incrementPercent ?? 0.5);
    if (Number.isFinite(fromDefault) && fromDefault > 0) return fromDefault;
    return 0.5;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function printHelp() {
    console.log(`\
Usage: node dist/analysis/grid_correction_check.js --bot-key <key> [options]

Validates LAST-FILL-GUARD discipline (pivot ± halfIncrement):
  last fill @x with increment i (half=i/2) gates both sides —
  BUY must be < x*(1-half/100), SELL > x*(1+half/100).
  e.g. x=1000, i=0.5% => BUY < 997.5 / SELL > 1002.5.
  Mirrors dexbot_cow_runtime:isLastFillGuardBlocked 1:1.

Required:
  --bot-key <key>        Bot key (e.g. my-grid-bot) or bot name (use --list-bots)

Time range (one of):
  --hours <n>            Lookback hours from now (default: 168)
  --start <iso>          Start time (ISO 8601)
  --end <iso>            End time (ISO 8601, default: now)

Options:
  --account <id>         Override account ID (default: from bot preferredAccount)
  --lookup               Resolve account name to ID via BitShares node
  --node <url>           BitShares node URL for --lookup / precision resolution
  --increment <pct>      Grid increment percent (default: from bot config or ${Number((C as any)?.DEFAULT_CONFIG?.incrementPercent ?? 0.5)})
  --tolerance <pct>      Deprecated alias for --increment (kept for compat, prefer --increment)
  --per-fill             Check at fill granularity (default: per-order aggregated)
  --include-cross-pair   Check consecutive fills across different pairs (default: same pair only)
  --json <file>          Export violations as JSON
  --csv <file>           Export violations as CSV
  --verbose              Show all consecutive pairs, not just violations
  --list-bots            List available bot keys and exit
  --help, -h             Show this help

Examples:
  node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 720
  node dist/analysis/grid_correction_check.js --bot-key "<bot-key>" --start 2025-01-01 --end 2025-06-01
  node dist/analysis/grid_correction_check.js --bot-key <bot-key> --hours 168 --increment 1.0
`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) { printHelp(); process.exit(0); }
    if (args.includes('--list-bots')) {
        const settings = loadBotSettings();
        const entries = settings?.bots ?? [];
        if (!entries.length) { console.log('No bots in profiles/bots.json'); process.exit(0); }
        console.log('Available bot keys:');
        for (let i = 0; i < entries.length; i++) {
            const k = computeBotKey(entries[i], i);
            console.log(`  ${k}  (name: ${entries[i].name ?? '-'}, ${entries[i].assetA}/${entries[i].assetB}, account: ${entries[i].preferredAccount ?? '-'})`);
        }
        process.exit(0);
    }

    const opts: any = {
        botKey: null,
        hours: null,
        start: null,
        end: null,
        account: null,
        lookup: false,
        node: C.NODE_MANAGEMENT.DEFAULT_NODES[0],
        perFill: false,
        includeCrossPair: false,
        incrementPercent: null as number | null,
        json: null,
        csv: null,
        verbose: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--bot-key': opts.botKey = args[++i]; break;
            case '--hours': opts.hours = parseInt(args[++i], 10); break;
            case '--start': opts.start = args[++i]; break;
            case '--end': opts.end = args[++i]; break;
            case '--account': opts.account = args[++i]; break;
            case '--lookup': opts.lookup = true; break;
            case '--node': opts.node = args[++i]; break;
            case '--per-fill': opts.perFill = true; break;
            case '--include-cross-pair': opts.includeCrossPair = true; break;
            case '--increment': opts.incrementPercent = parseFloat(args[++i]); break;
            case '--tolerance': {
                const v = parseFloat(args[++i]);
                // Back-compat: old --tolerance was adverse pct before flagging; now map to increment if user still passes it
                // Prefer explicit --increment; don't overwrite if already set
                if (opts.incrementPercent == null) opts.incrementPercent = v > 0 ? v * 2 : null; // heuristic: old tolerance ~ halfInc, so inc ~ 2*tolerance
                console.warn(`[warn] --tolerance is deprecated, use --increment <pct> (e.g. --increment ${v > 0 ? (v*2) : 0.5})`);
                break;
            }
            case '--json': opts.json = args[++i]; break;
            case '--csv': opts.csv = args[++i]; break;
            case '--verbose': opts.verbose = true; break;
            default:
                console.error(`Unknown option: ${args[i]}`);
                printHelp();
                process.exit(1);
        }
    }

    if (!opts.botKey) {
        console.error('Error: --bot-key is required (use --list-bots to see available keys)');
        printHelp();
        process.exit(1);
    }
    if (!opts.hours && !opts.start) opts.hours = 168;
    if (opts.incrementPercent != null && (isNaN(opts.incrementPercent) || opts.incrementPercent < 0)) {
        console.error('Error: --increment must be a non-negative number');
        process.exit(1);
    }
    return opts;
}

// ─── Time helpers ─────────────────────────────────────────────────────────────
function resolveTimeRange(opts: any): { gte: string; lte: string; label: string } {
    let gte: string, lte: string;
    if (opts.start) {
        const s = new Date(opts.start);
        if (isNaN(s.getTime())) { console.error(`Invalid --start: ${opts.start}`); process.exit(1); }
        gte = s.toISOString();
    } else {
        const h = opts.hours ?? 168;
        gte = new Date(Date.now() - h * 3600_000).toISOString();
    }
    if (opts.end) {
        const e = new Date(opts.end);
        if (isNaN(e.getTime())) { console.error(`Invalid --end: ${opts.end}`); process.exit(1); }
        lte = e.toISOString();
    } else {
        lte = new Date().toISOString();
    }
    const label = `${gte} → ${lte}`;
    return { gte, lte, label };
}

// ─── Account resolution ───────────────────────────────────────────────────────
async function resolveAccountId(name: string, nodeUrl: string): Promise<string | null> {
    const { createReadOnlyClient } = await import('../modules/bitshares-native/index.js');
    const client = createReadOnlyClient({ nodes: [nodeUrl] });
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    try {
        await client.connect();
        const accounts = await client.db('lookup_account_names', [[name]]);
        if (Array.isArray(accounts) && accounts[0]?.id) return accounts[0].id;
        return null;
    } catch (e: any) {
        console.warn(`  [warn] Account resolution failed: ${e.message}`);
        return null;
    } finally {
        try { client.disconnect(); } catch (_) {}
        process.env.LOG_LEVEL = prevLevel;
    }
}

async function resolveAccountForBot(botKey: string, overrideAccount: string | null, nodeUrl: string, doLookup: boolean): Promise<{ accountId: string; botMeta: any }> {
    const botMeta = loadBotMeta(botKey);
    if (!botMeta && !overrideAccount) {
        console.error(`Error: bot key '${botKey}' not found in profiles/bots.json and no --account provided.`);
        console.error(`Use --list-bots to see available keys, or pass --account <1.2.x> explicitly.`);
        process.exit(1);
    }
    let accountId = overrideAccount ?? botMeta?.preferredAccount ?? null;
    if (!accountId) {
        console.error(`Error: bot '${botKey}' has no preferredAccount and no --account provided.`);
        process.exit(1);
    }
    // If account looks like a name, resolve it
    if (!/^1\.2\.\d+$/.test(String(accountId))) {
        if (doLookup || !String(accountId).startsWith('1.2.')) {
            console.log(`  Resolving account name '${accountId}'...`);
            const resolved = await resolveAccountId(String(accountId), nodeUrl);
            if (!resolved) {
                console.error(`Error: failed to resolve account name '${accountId}' to 1.2.x`);
                process.exit(1);
            }
            console.log(`  → ${resolved}`);
            accountId = resolved;
        }
    }
    return { accountId: String(accountId), botMeta };
}

// ─── Asset precision resolution ───────────────────────────────────────────────
async function resolveAssetPrecisions(fills: FillRecord[], nodeUrl: string | null): Promise<void> {
    const unknownIds = new Set<string>();
    for (const f of fills) {
        for (const id of [f.pays.asset_id, f.receives.asset_id, f.fee.asset_id]) {
            if (id !== BTS_ID && !(id in ASSETS) && !(id in resolvedPrecisions)) unknownIds.add(id);
        }
    }
    if (unknownIds.size === 0 || !nodeUrl) return;
    const ids = [...unknownIds];
    console.log(`  Resolving ${ids.length} unknown asset(s) from blockchain...`);
    const { createReadOnlyClient } = await import('../modules/bitshares-native/index.js');
    const client = createReadOnlyClient({ nodes: [nodeUrl] });
    try {
        await client.connect();
        const assets = await client.db('get_assets', [ids]);
        if (Array.isArray(assets)) {
            for (const asset of assets) {
                if (asset?.id && asset.precision != null) {
                    resolvedPrecisions[asset.id] = asset.precision;
                    console.log(`    ${asset.id} → ${asset.symbol || '?'} (precision ${asset.precision})`);
                }
            }
        }
        const missing = ids.filter(id => !(id in resolvedPrecisions));
        if (missing.length > 0) console.warn(`  [warn] ${missing.length} asset(s) not found on chain: ${missing.join(', ')}`);
    } catch (e: any) {
        console.warn(`  [warn] Asset resolution failed: ${e.message}`);
    } finally {
        try { client.disconnect(); } catch (_) {}
    }
}

// ─── Kibana fetch ─────────────────────────────────────────────────────────────
function buildFillQuery(accountId: string, gte: string, lte: string, size: number) {
    return {
        size,
        track_total_hits: false,
        _source: [
            'block_data.block_time',
            'block_data.block_num',
            'operation_id_num',
            'operation_history.op_object.pays',
            'operation_history.op_object.receives',
            'operation_history.op_object.fee',
            'operation_history.op_object.order_id',
            'operation_history.op_object.account_id',
            'operation_history.op_object.is_maker',
        ],
        query: {
            bool: {
                filter: [
                    { term: { operation_type: OP_FILL_ORDER } },
                    { term: { 'operation_history.op_object.account_id.keyword': accountId } },
                    { range: { 'block_data.block_time': { gte, lte } } },
                ],
            },
        },
        sort: [
            { 'block_data.block_time': { order: 'asc' } },
            { operation_id_num: { order: 'asc' } },
        ],
    };
}

async function fetchAllFills(config: any, accountId: string, gte: string, lte: string): Promise<FillRecord[]> {
    const pageSize = 10000;
    const fills: FillRecord[] = [];
    let searchAfter: any[] | null = null;
    const cfg = { ...BASE_CONFIG, timeout: 60000, ...config };
    while (true) {
        const query = buildFillQuery(accountId, gte, lte, pageSize);
        if (searchAfter) (query as any).search_after = searchAfter;
        const result: any = await kibanaSearch(cfg, query);
        const hits = result?.hits?.hits ?? [];
        if (!hits.length) break;
        for (const hit of hits) {
            const src = hit?._source;
            const op = src?.operation_history?.op_object;
            if (!op || !op.pays || !op.receives) continue;
            fills.push({
                time: src.block_data?.block_time ?? '',
                blockNum: src.block_data?.block_num ?? 0,
                opNum: Number(src.operation_id_num ?? 0),
                orderId: op.order_id ?? '',
                accountId: op.account_id ?? '',
                pays: { amount: Number(op.pays.amount ?? 0), asset_id: op.pays.asset_id ?? '' },
                receives: { amount: Number(op.receives.amount ?? 0), asset_id: op.receives.asset_id ?? '' },
                fee: { amount: Number(op.fee?.amount ?? 0), asset_id: op.fee?.asset_id ?? '' },
                isMaker: op.is_maker ?? false,
                sort: hit.sort,
            });
        }
        if (hits.length < pageSize) break;
        searchAfter = hits[hits.length - 1].sort;
        if (!Array.isArray(searchAfter)) break;
    }
    return fills;
}

// ─── Fill classification ─────────────────────────────────────────────────────
function classifyFills(fills: FillRecord[]): { trades: TradeFill[]; skipped: number } {
    const trades: TradeFill[] = [];
    let skipped = 0;
    for (const f of fills) {
        const pAsset = f.pays.asset_id;
        const rAsset = f.receives.asset_id;
        let direction: 'buy' | 'sell';
        let baseAsset: string;
        let quoteAsset: string;
        let baseAmount: number;
        let quoteAmount: number;
        let price: number;

        if (pAsset === BTS_ID && rAsset !== BTS_ID) {
            direction = 'buy';
            baseAsset = rAsset; quoteAsset = BTS_ID;
            baseAmount = toReal(f.receives.amount, rAsset);
            quoteAmount = toReal(f.pays.amount, BTS_ID);
            if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) { skipped++; continue; }
            price = quoteAmount / baseAmount;
        } else if (rAsset === BTS_ID && pAsset !== BTS_ID) {
            direction = 'sell';
            baseAsset = pAsset; quoteAsset = BTS_ID;
            baseAmount = toReal(f.pays.amount, pAsset);
            quoteAmount = toReal(f.receives.amount, BTS_ID);
            if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) { skipped++; continue; }
            price = quoteAmount / baseAmount;
        } else {
            const baseForCheck = pAsset < rAsset ? pAsset : rAsset;
            const quoteForCheck = pAsset < rAsset ? rAsset : pAsset;
            if (assetPrec(baseForCheck) === undefined || assetPrec(quoteForCheck) === undefined) { skipped++; continue; }
            const isSell = pAsset < rAsset;
            direction = isSell ? 'sell' : 'buy';
            baseAsset = isSell ? pAsset : rAsset;
            quoteAsset = isSell ? rAsset : pAsset;
            baseAmount = toReal(isSell ? f.pays.amount : f.receives.amount, baseAsset);
            quoteAmount = toReal(isSell ? f.receives.amount : f.pays.amount, quoteAsset);
            if (!Number.isFinite(baseAmount) || !Number.isFinite(quoteAmount) || baseAmount <= 0 || quoteAmount <= 0) { skipped++; continue; }
            price = quoteAmount / baseAmount;
        }

        trades.push({
            time: f.time,
            orderId: f.orderId,
            direction,
            baseAsset,
            quoteAsset,
            baseAmount,
            quoteAmount,
            price,
            isMaker: f.isMaker,
            sequence: f.blockNum * 1e6 + f.opNum,
        });
    }
    return { trades, skipped };
}

// ─── Per-order aggregation (collapses multi-fill orders to weighted avg price) ──
function aggregateByOrder(trades: TradeFill[]): AggregatedOrder[] {
    const map = new Map<string, { trades: TradeFill[] }>();
    for (const t of trades) {
        const k = t.orderId || `__fill_${t.sequence}`;
        if (!map.has(k)) map.set(k, { trades: [] });
        map.get(k)!.trades.push(t);
    }
    const orders: AggregatedOrder[] = [];
    for (const [orderId, group] of map) {
        const first = group.trades[0];
        // All fills for same order should share direction/pair, but validate
        const directions = new Set(group.trades.map(t => t.direction));
        const pairs = new Set(group.trades.map(t => `${t.baseAsset}:${t.quoteAsset}`));
        if (directions.size > 1 || pairs.size > 1) {
            // Mixed direction/pair for same orderId should not happen; keep fills separate
            for (const t of group.trades) {
                orders.push({
                    orderId: t.orderId, direction: t.direction, baseAsset: t.baseAsset, quoteAsset: t.quoteAsset,
                    baseAmount: t.baseAmount, quoteAmount: t.quoteAmount, price: t.price,
                    time: t.time, sequence: t.sequence, fillCount: 1, isMaker: t.isMaker,
                });
            }
            continue;
        }
        const baseAmount = group.trades.reduce((s, t) => s + t.baseAmount, 0);
        const quoteAmount = group.trades.reduce((s, t) => s + t.quoteAmount, 0);
        const price = baseAmount > 0 ? quoteAmount / baseAmount : first.price;
        // Use earliest time / smallest sequence for ordering; last time for display is earliest fill
        const sorted = [...group.trades].sort((a, b) => a.sequence - b.sequence);
        orders.push({
            orderId, direction: first.direction, baseAsset: first.baseAsset, quoteAsset: first.quoteAsset,
            baseAmount, quoteAmount, price,
            time: sorted[0].time,
            sequence: sorted[0].sequence,
            fillCount: group.trades.length,
            isMaker: group.trades.every(t => t.isMaker),
        });
    }
    return orders.sort((a, b) => a.sequence - b.sequence);
}

// ─── Violation detection (LAST-FILL-GUARD 1:1) ────────────────────────────────
function detectViolations(
    items: (TradeFill | AggregatedOrder)[],
    includeCrossPair: boolean,
    incrementPercent: number,
): { violations: Violation[]; checkedPairs: number; sameDirectionPairs: number } {
    const violations: Violation[] = [];
    let checkedPairs = 0;
    let sameDirectionPairs = 0;

    // Helper for a single chronological sequence (already filtered to one pair or global)
    function checkSequence(seq: (TradeFill | AggregatedOrder)[]) {
        for (let i = 1; i < seq.length; i++) {
            const prev = seq[i - 1] as any;
            const curr = seq[i] as any;
            // Skip same orderId (multi-fill split of one order) — aggregated mode already collapsed, but per-fill may split
            if (prev.orderId && prev.orderId === curr.orderId) continue;
            checkedPairs++;
            if (prev.direction === curr.direction) sameDirectionPairs++;

            const check = isLastFillGuardBlocked(curr.price, curr.direction, prev.price, prev.direction, incrementPercent);
            if (check.blocked) {
                const delta = curr.price - prev.price;
                const deltaPct = prev.price !== 0 ? (delta / prev.price) * 100 : 0;
                const isSell = curr.direction === 'sell';
                violations.push({
                    index: i,
                    pair: `${curr.baseAsset}:${curr.quoteAsset}`,
                    direction: curr.direction,
                    expected: isSell ? `> ${check.threshold?.toFixed(6)} (pivot ${check.pivot} +${check.halfInc}%)` : `< ${check.threshold?.toFixed(6)} (pivot ${check.pivot} -${check.halfInc}%)`,
                    prev: prev as TradeFill,
                    curr: curr as TradeFill,
                    priceDelta: delta,
                    priceDeltaPct: deltaPct,
                    pivot: check.pivot as number,
                    halfInc: check.halfInc as number,
                    threshold: check.threshold as number,
                });
            }
        }
    }

    if (includeCrossPair) {
        // Global consecutive check regardless of pair
        const sorted = [...items].sort((a, b) => (a as any).sequence - (b as any).sequence);
        checkSequence(sorted);
    } else {
        // Per-pair independent sequences (bot trades one pair; cross-pair interleaving is irrelevant)
        const byPair = new Map<string, (TradeFill | AggregatedOrder)[]>();
        for (const it of items) {
            const k = `${(it as any).baseAsset}:${(it as any).quoteAsset}`;
            if (!byPair.has(k)) byPair.set(k, []);
            byPair.get(k)!.push(it);
        }
        for (const [, seq] of byPair) {
            seq.sort((a: any, b: any) => a.sequence - b.sequence);
            checkSequence(seq);
        }
    }
    // Sort violations chronologically for reporting
    violations.sort((a, b) => new Date(a.curr.time).getTime() - new Date(b.curr.time).getTime());
    return { violations, checkedPairs, sameDirectionPairs };
}

// ─── Reporting ────────────────────────────────────────────────────────────────
function fmt(n: number, d = 4): string {
    if (!Number.isFinite(n)) return 'NaN';
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function printReport(
    trades: TradeFill[],
    orders: AggregatedOrder[] | null,
    violations: Violation[],
    checkedPairs: number,
    sameDirectionPairs: number,
    skipped: number,
    rangeLabel: string,
    botKey: string,
    accountId: string,
    botMeta: any,
    perFill: boolean,
    includeCrossPair: boolean,
    incrementPercent: number,
    gte: string,
    _lte: string,
) {
    const pairGroups = new Map<string, TradeFill[]>();
    for (const t of trades) {
        const k = `${assetSymbol(t.baseAsset)}/${assetSymbol(t.quoteAsset)}`;
        if (!pairGroups.has(k)) pairGroups.set(k, []);
        pairGroups.get(k)!.push(t);
    }

    const halfInc = incrementPercent / 2;

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  GRID CORRECTION CHECK — LAST-FILL-GUARD (pivot ± halfIncrement)');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Bot key:      ${botKey}${botMeta?.name ? `  (name: ${botMeta.name})` : ''}`);
    if (botMeta) console.log(`  Pair:         ${botMeta.assetA ?? '?'} / ${botMeta.assetB ?? '?'}`);
    console.log(`  Account:      ${accountId}`);
    console.log(`  Range:        ${rangeLabel}`);
    console.log(`  Mode:         ${perFill ? 'per-fill' : 'per-order (aggregated)'}${includeCrossPair ? ', cross-pair enabled' : ', same-pair only'}`);
    console.log(`  Increment:    ${incrementPercent}%  (halfInc ${halfInc}%)`);
    console.log(`  Guard:        BUY < pivot*(1-${halfInc}%) / SELL > pivot*(1+${halfInc}%)  — both sides, global pivot`);
    console.log('');

    const buyCount = trades.filter(t => t.direction === 'buy').length;
    const sellCount = trades.filter(t => t.direction === 'sell').length;
    console.log(`  Fills fetched:        ${trades.length}  (buy: ${buyCount}, sell: ${sellCount})`);
    if (orders) console.log(`  Orders (aggregated):  ${orders.length}  (from ${trades.length} fills)`);
    console.log(`  Pairs observed:       ${[...pairGroups.keys()].join(', ') || '-'}`);
    if (skipped > 0) console.log(`  Skipped (precision):  ${skipped}`);
    console.log(`  Pairs checked:        ${checkedPairs} consecutive pairs (same-direction pairs: ${sameDirectionPairs})`);
    console.log(`  Violations:           ${violations.length}${checkedPairs > 0 ? `  (${((violations.length / checkedPairs) * 100).toFixed(2)}%)` : ''}`);
    console.log('');

    if (violations.length === 0) {
        console.log('  ✅  PASS — no grid inversions detected (all BUY < pivot-half, SELL > pivot+half).');
        console.log('');
        if (checkedPairs === 0) {
            console.log('  Note: no consecutive pairs in range to check.');
            console.log('  (Need at least two fills/orders on the same pair.)');
        }
        console.log('');
        return;
    }

    console.log(`  ❌  FAIL — ${violations.length} violation(s) detected:`);
    console.log('');

    // Per-direction breakdown (blocked side = curr direction)
    const buyV = violations.filter(v => v.direction === 'buy').length;
    const sellV = violations.filter(v => v.direction === 'sell').length;
    console.log(`  Breakdown:  sell violations: ${sellV}  (SELL < pivot+half),  buy violations: ${buyV}  (BUY > pivot-half)`);
    console.log('');

    // Timeline clustering by day
    const dayBuckets = new Map<string, number>();
    for (const v of violations) {
        const day = (v.curr.time || '').slice(0, 10) || 'unknown';
        dayBuckets.set(day, (dayBuckets.get(day) || 0) + 1);
    }
    const sortedDays = [...dayBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    console.log('  Incidents by day:');
    for (const [day, count] of sortedDays) {
        const bar = '█'.repeat(Math.min(count, 40));
        console.log(`    ${day}  ${String(count).padStart(3)}  ${bar}`);
    }
    // Overall incident time span
    const times = violations.map(v => v.curr.time).filter(Boolean).sort();
    if (times.length > 0) {
        console.log(`\n  Incident range: ${times[0]} → ${times[times.length - 1]}`);
        // Also show in hours from start
        const gteMs = new Date(gte).getTime();
        const firstMs = new Date(times[0]).getTime();
        const lastMs = new Date(times[times.length - 1]).getTime();
        if (!isNaN(gteMs) && !isNaN(firstMs)) {
            const firstH = ((firstMs - gteMs) / 3600000).toFixed(1);
            const lastH = ((lastMs - gteMs) / 3600000).toFixed(1);
            console.log(`  (hours into range: ${firstH}h → ${lastH}h)`);
        }
    }
    console.log('');

    // Detailed violation table
    console.log('  ── Violations (pivot ± halfIncrement) ──');
    console.log('');
    const hdr = '  #  Pair          Dir   Prev Price     Curr Price     Thr            Δ%        Half%   Prev Time              Curr Time              Prev Order          Curr Order';
    console.log(hdr);
    console.log('  ' + '─'.repeat(hdr.length - 2));
    for (let i = 0; i < violations.length; i++) {
        const v = violations[i];
        const pairLabel = `${assetSymbol(v.prev.baseAsset)}/${assetSymbol(v.prev.quoteAsset)}`.padEnd(12);
        const dir = v.direction.padEnd(4);
        const pPrice = fmt(v.prev.price, 6).padStart(12);
        const cPrice = fmt(v.curr.price, 6).padStart(12);
        const thr = fmt(v.threshold, 6).padStart(12);
        const delta = (v.priceDeltaPct >= 0 ? '+' : '') + v.priceDeltaPct.toFixed(4) + '%';
        const deltaStr = delta.padStart(9);
        const halfStr = (v.halfInc.toFixed(3) + '%').padStart(6);
        const pTime = (v.prev.time || '').slice(0, 19).replace('T', ' ').padEnd(19);
        const cTime = (v.curr.time || '').slice(0, 19).replace('T', ' ').padEnd(19);
        const pOrd = (v.prev.orderId || '-').slice(0, 16).padEnd(16);
        const cOrd = (v.curr.orderId || '-').slice(0, 16).padEnd(16);
        const marker = v.direction === 'sell' ? `SELL < ${fmt(v.threshold,4)}` : `BUY > ${fmt(v.threshold,4)}`;
        console.log(`  ${(String(i + 1)).padStart(2)}  ${pairLabel}  ${dir}  ${pPrice}  ${cPrice}  ${thr}  ${deltaStr}  ${halfStr}  ${pTime}  ${cTime}  ${pOrd}  ${cOrd}  ${marker}`);
    }
    console.log('');
    console.log(`  Guard: BUY must be < pivot*(1-${halfInc}%), SELL > pivot*(1+${halfInc}%) — blocked if violated (mirrors bot).`);
    console.log(`  Increment ${incrementPercent}% => halfInc ${halfInc}% — e.g. pivot 1000 => BUY thr ${(1000*(1-halfInc/100)).toFixed(4)}, SELL thr ${(1000*(1+halfInc/100)).toFixed(4)}`);
    console.log('');
}

function exportJson(filePath: string, violations: Violation[], trades: TradeFill[], rangeLabel: string, botKey: string, accountId: string, incrementPercent: number) {
    const payload = {
        botKey, accountId, range: rangeLabel,
        incrementPercent,
        halfIncrement: incrementPercent / 2,
        totalFills: trades.length,
        violations: violations.map(v => ({
            pair: `${assetSymbol(v.prev.baseAsset)}/${assetSymbol(v.prev.quoteAsset)}`,
            pairIds: { base: v.prev.baseAsset, quote: v.prev.quoteAsset },
            direction: v.direction,
            expected: v.expected,
            prev: { time: v.prev.time, orderId: v.prev.orderId, price: v.prev.price, baseAmount: v.prev.baseAmount, quoteAmount: v.prev.quoteAmount, isMaker: v.prev.isMaker },
            curr: { time: v.curr.time, orderId: v.curr.orderId, price: v.curr.price, baseAmount: v.curr.baseAmount, quoteAmount: v.curr.quoteAmount, isMaker: v.curr.isMaker },
            pivot: v.pivot,
            halfInc: v.halfInc,
            threshold: v.threshold,
            priceDelta: v.priceDelta,
            priceDeltaPct: v.priceDeltaPct,
        })),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`  JSON exported to ${filePath}`);
}

function exportCsv(filePath: string, violations: Violation[]) {
    const header = 'index,pair,direction,expected,prev_time,prev_order,prev_price,curr_time,curr_order,curr_price,threshold,halfInc,pivot,delta_pct';
    const rows = violations.map((v, i) =>
        [
            i + 1,
            `${assetSymbol(v.prev.baseAsset)}/${assetSymbol(v.prev.quoteAsset)}`,
            v.direction, v.expected,
            v.prev.time, v.prev.orderId, v.prev.price,
            v.curr.time, v.curr.orderId, v.curr.price,
            v.threshold, v.halfInc, v.pivot,
            v.priceDeltaPct.toFixed(6),
        ].map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')
    );
    fs.writeFileSync(filePath, [header, ...rows].join('\n') + '\n', 'utf-8');
    console.log(`  CSV exported to ${filePath}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs();
    const { gte, lte, label } = resolveTimeRange(opts);

    console.log(`\nGrid correction check — bot-key: ${opts.botKey}`);
    console.log(`Range: ${label}`);

    const { accountId, botMeta } = await resolveAccountForBot(opts.botKey, opts.account, opts.node, opts.lookup);
    console.log(`Account: ${accountId}${botMeta ? `  (${botMeta.assetA}/${botMeta.assetB})` : ''}`);
    const incrementPercent = resolveIncrementPercent(botMeta, opts.incrementPercent);
    console.log(`Increment: ${incrementPercent}% (halfInc ${incrementPercent/2}%)${opts.incrementPercent == null && botMeta?.incrementPercent != null ? ' — from bot config' : opts.incrementPercent != null ? ' — from --increment' : ' — default'}`);

    console.log(`\nFetching fills from Kibana...`);
    const fills = await fetchAllFills({}, accountId, gte, lte);
    console.log(`  Fetched ${fills.length} fill_order operation(s)`);

    if (fills.length === 0) {
        console.log('\nNo fills in range — nothing to check.');
        process.exit(0);
    }

    await resolveAssetPrecisions(fills, opts.node);

    const { trades, skipped } = classifyFills(fills);
    console.log(`  Classified ${trades.length} trade(s)${skipped > 0 ? `, ${skipped} skipped (unknown precision)` : ''}`);
    if (trades.length < 2) {
        console.log('\nFewer than 2 trade fills — no consecutive pairs to check.');
        process.exit(0);
    }

    // Sort chronologically
    trades.sort((a, b) => a.sequence - b.sequence);

    if (opts.verbose) {
        console.log('\n  ── Trade sequence ──');
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            const pair = `${assetSymbol(t.baseAsset)}/${assetSymbol(t.quoteAsset)}`;
            console.log(`    ${String(i + 1).padStart(3)}  ${t.time.slice(0, 19)}  ${t.direction.padEnd(4)}  ${pair.padEnd(18)}  price ${fmt(t.price, 6)}  order ${t.orderId}`);
        }
    }

    // Choose per-fill or per-order mode
    let items: (TradeFill | AggregatedOrder)[];
    if (opts.perFill) {
        items = trades;
    } else {
        const orders = aggregateByOrder(trades);
        console.log(`  Aggregated into ${orders.length} order(s) (multi-fill orders collapsed by weighted avg price)`);
        items = orders;
    }

    const { violations, checkedPairs, sameDirectionPairs } = detectViolations(items, opts.includeCrossPair, incrementPercent);

    const ordersForReport = opts.perFill ? null : (items as AggregatedOrder[]);
    printReport(trades, ordersForReport, violations, checkedPairs, sameDirectionPairs, skipped, label, opts.botKey, accountId, botMeta, opts.perFill, opts.includeCrossPair, incrementPercent, gte, lte);

    if (opts.json) exportJson(opts.json, violations, trades, label, opts.botKey, accountId, incrementPercent);
    if (opts.csv) exportCsv(opts.csv, violations);

    process.exit(violations.length > 0 ? 2 : 0);
}

export { isLastFillGuardBlocked, classifyFills, aggregateByOrder, detectViolations, TradeFill, FillRecord, Violation, AggregatedOrder };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(e => {
        console.error('\n[fatal]', (e as any)?.message ?? e);
        if (process.env.DEBUG) console.error((e as any)?.stack);
        process.exit(1);
    });
}
