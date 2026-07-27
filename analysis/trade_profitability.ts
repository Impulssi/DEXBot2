#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import * as KC from '../market_adapter/core/kibana_client';
import * as C from '../modules/constants';

const { kibanaSearch, DEFAULT_CONFIG: BASE_CONFIG } = KC;

/**
 * TRADE PROFITABILITY ANALYZER
 *
 * Fetches fill_order operations for a BitShares account from Kibana
 * within a specified time range, then analyzes profitability using
 * FIFO or sequential (LIFO) inventory tracking per asset pair.
 *
 * Usage:
 *   tsx analysis/trade_profitability.ts 1.2.3 --start 2025-01-01 --end 2025-06-01
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 720
 *   tsx analysis/trade_profitability.ts 1.2.3 --start 2025-01-01T00:00:00Z --end 2025-06-01T00:00:00Z
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 168 --asset 1.3.113
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 168 --csv trades.csv
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 168 --json results.json
 *   tsx analysis/trade_profitability.ts "account-name" --lookup
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 168 --trades
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 168 --match-mode fifo
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_FILL_ORDER = 4;
const BTS_ID = '1.3.0';
let BLOCKCHAIN_FEE_PER_FILL = 0.09652; // BTS — flat blockchain operation fee (not market fee); override with --fee-per-order

interface AssetInfo {
    symbol: string;
    precision: number;
}

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

function assetSymbol(id: string): string {
    return ASSETS[id]?.symbol ?? id;
}
function assetPrec(id: string): number | undefined {
    return ASSETS[id]?.precision ?? resolvedPrecisions[id];
}
function getPrec(id: string): number | undefined {
    return assetPrec(id);
}

function toReal(amount: number, assetId: string): number {
    const p = getPrec(assetId);
    if (p === undefined) return NaN;
    return amount / Math.pow(10, p);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface AssetAmount {
    amount: number;
    asset_id: string;
}

interface FillRecord {
    time: string;
    blockNum: number;
    opNum: number;
    orderId: string;
    accountId: string;
    pays: AssetAmount;
    receives: AssetAmount;
    fee: AssetAmount;
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
    marketFeeReal: number;
    marketFeeAsset: string;
}

interface InventoryLot {
    amount: number;
    grossPrice: number;
    effPrice: number;
    time: string;
    entryOrderId: string;
    entryIsMaker: boolean;
}

interface RealizedPnl {
    sellPrice: number;
    buyPrice: number;
    amount: number;
    pnl: number;
    pnlPct: number;
    effPrice: number;
    marketFeeEntry: number;
    marketFeeExit: number;
    feeBts: number;
    pnlNet: number;
    pnlNetPct: number;
    entryTime: string;
    exitTime: string;
    entryOrderId: string;
    exitOrderId: string;
    entryIsMaker: boolean;
    exitIsMaker: boolean;
}

interface PairAnalysis {
    baseAsset: string;
    quoteAsset: string;
    buys: TradeFill[];
    sells: TradeFill[];
    realizedPnls: RealizedPnl[];
    totalBuyBase: number;
    totalSellBase: number;
    totalBuyQuote: number;
    totalSellQuote: number;
    unmatchedSellBase: number;
    totalRealizedPnl: number;
    totalMarketFees: number;
    totalBlockchainFees: number;
    totalRealizedPnlNet: number;
    netPosition: number;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`\
Usage: tsx analysis/trade_profitability.ts <accountId> [options]

Analyzes filled orders for a BitShares account, computing realized PnL
via FIFO or sequential (LIFO) inventory tracking.

Arguments:
  accountId              BitShares account ID (1.2.x) or name (with --lookup)

Options:
  --start <iso>          Start time (ISO 8601, e.g. 2025-01-01 or 2025-01-01T00:00:00Z)
  --end <iso>            End time (ISO 8601)
  --hours <n>            Lookback hours from now (alternative to --start/--end)
  --asset <assetId>      Filter to one base asset (e.g. 1.3.113 for bitUSD)
  --lookup               Resolve account name to ID via BitShares node
  --node <url>           BitShares node URL (default: first healthy from built-in pool)
  --csv <file>           Export trade list as CSV
  --json <file>          Export full analysis as JSON
  --trades               Show per-order PnL detail (hidden by default)
  --match-mode <mode>    Matching mode: sequential (default, LIFO) or fifo
  --fee-per-order <bts>  Blockchain fee per limit_order_create op in BTS (default: 0.09652)
  --verbose              Print extra debug info
  --help, -h             Show this help

Examples:
  tsx analysis/trade_profitability.ts 1.2.123456 --hours 720
  tsx analysis/trade_profitability.ts 1.2.123456 --start 2025-01-01 --end 2025-06-01
  tsx analysis/trade_profitability.ts "my-bot-account" --lookup --hours 168
  tsx analysis/trade_profitability.ts 1.2.123456 --hours 720 --asset 1.3.113 --csv trades.csv
  tsx analysis/trade_profitability.ts 1.2.123456 --hours 720 --match-mode sequential`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printHelp();
        process.exit(0);
    }

    const opts: any = {
        accountId: args[0],
        hours: null,
        start: null,
        end: null,
        asset: null,
        lookup: false,
        node: C.NODE_MANAGEMENT.DEFAULT_NODES[0],
        csv: null,
        json: null,
        matchMode: 'sequential',
        showPnlDetail: false,
        verbose: false,
        feePerOrder: BLOCKCHAIN_FEE_PER_FILL,
    };

    for (let i = 1; i < args.length; i++) {
        switch (args[i]) {
            case '--hours':        opts.hours    = parseInt(args[++i], 10); break;
            case '--start':        opts.start    = args[++i]; break;
            case '--end':          opts.end      = args[++i]; break;
            case '--asset':        opts.asset    = args[++i]; break;
            case '--lookup':       opts.lookup   = true; break;
            case '--node':         opts.node     = args[++i]; break;
            case '--csv':          opts.csv      = args[++i]; break;
            case '--json':         opts.json     = args[++i]; break;
            case '--trades':         opts.showPnlDetail  = true; break;
            case '--fee-per-order':  opts.feePerOrder = parseFloat(args[++i]); break;
            case '--match-mode': {
                const m = args[++i];
                if (m !== 'sequential' && m !== 'fifo') {
                    console.error(`Invalid --match-mode: ${m} (expected: sequential | fifo)`);
                    process.exit(1);
                }
                opts.matchMode = m;
                break;
            }
            case '--verbose':        opts.verbose   = true; break;
            default:
                console.error(`Unknown option: ${args[i]}`);
                process.exit(1);
        }
    }

    if (!opts.hours && !opts.start) {
        opts.hours = 168; // default: 7 days
    }

    return opts;
}

// ─── Account name resolution ─────────────────────────────────────────────────

async function resolveAccountId(name: string, nodeUrl: string): Promise<string | null> {
    const mod: any = await import('../modules/bitshares-native/index.js');
    const { createReadOnlyClient } = mod.default;
    const client = createReadOnlyClient({ nodes: [nodeUrl] });
    // Suppress transport INFO logs during ephemeral connection:
    // bitshares-native transport logger (new Logger('Transport')) writes
    // "[timestamp] [INFO] [Transport] ..." — silence by raising log level.
    const prevLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    try {
        await client.connect();
        const accounts = await client.db('lookup_account_names', [[name]]);
        if (Array.isArray(accounts) && accounts[0]?.id) {
            return accounts[0].id;
        }
        return null;
    } catch (e: any) {
        console.warn(`  [warn] Account resolution failed: ${e.message}`);
        return null;
    } finally {
        try { client.disconnect(); } catch (_) {}
        process.env.LOG_LEVEL = prevLevel;
    }
}

// ─── On-chain asset precision resolution ────────────────────────────────────

/**
 * Collects all unique non-BTS asset IDs from fills, resolves unknown
 * precisions from the blockchain, and populates the runtime cache.
 */
async function resolveAssetPrecisions(fills: FillRecord[], nodeUrl: string | null): Promise<void> {
    const unknownIds = new Set<string>();
    for (const f of fills) {
        for (const id of [f.pays.asset_id, f.receives.asset_id, f.fee.asset_id]) {
            if (id !== BTS_ID && !(id in ASSETS) && !(id in resolvedPrecisions)) {
                unknownIds.add(id);
            }
        }
    }
    if (unknownIds.size === 0 || !nodeUrl) return;

    const ids = [...unknownIds];
    console.log(`  Resolving ${ids.length} unknown asset(s) from blockchain...`);

    const mod: any = await import('../modules/bitshares-native/index.js');
    const { createReadOnlyClient } = mod.default;
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
        if (missing.length > 0) {
            console.warn(`  [warn] ${missing.length} asset(s) not found on chain: ${missing.join(', ')}. Fills referencing them will be skipped.`);
        }
    } catch (e: any) {
        console.warn(`  [warn] Asset resolution failed: ${e.message}. Fills with unknown assets will be skipped.`);
    } finally {
        try { client.disconnect(); } catch (_) {}
    }
}

// ─── Kibana Query ────────────────────────────────────────────────────────────

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

// ─── Fill Classification ─────────────────────────────────────────────────────

function classifyFills(fills: FillRecord[], filterAsset: string | null): { trades: TradeFill[]; pairs: Set<string> } {
    const trades: TradeFill[] = [];
    const pairs = new Set<string>();
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
        let marketFeeReal: number;
        let marketFeeAsset: string;

        const feePrec = getPrec(f.fee.asset_id);
        if (feePrec === undefined || isNaN(f.fee.amount)) { skipped++; continue; }
        const feeReal = f.fee.amount / Math.pow(10, feePrec);

        if (pAsset === BTS_ID && rAsset !== BTS_ID) {
            direction = 'buy';
            baseAsset = rAsset;
            quoteAsset = BTS_ID;
            baseAmount = toReal(f.receives.amount, rAsset);
            quoteAmount = toReal(f.pays.amount, BTS_ID);
            if (isNaN(baseAmount) || isNaN(quoteAmount)) { skipped++; continue; }
            price = quoteAmount / baseAmount;
            marketFeeReal = feeReal;
            marketFeeAsset = f.fee.asset_id;
        } else if (rAsset === BTS_ID && pAsset !== BTS_ID) {
            direction = 'sell';
            baseAsset = pAsset;
            quoteAsset = BTS_ID;
            baseAmount = toReal(f.pays.amount, pAsset);
            quoteAmount = toReal(f.receives.amount, BTS_ID);
            if (isNaN(baseAmount) || isNaN(quoteAmount)) { skipped++; continue; }
            price = quoteAmount / baseAmount;
            marketFeeReal = feeReal;
            marketFeeAsset = f.fee.asset_id;
        } else {
            // Non-BTS cross-pair: use consistent ordering (lower asset ID = base)
            const baseForCheck = pAsset < rAsset ? pAsset : rAsset;
            const quoteForCheck = pAsset < rAsset ? rAsset : pAsset;
            // Skip if either asset precision is unknown
            if (getPrec(baseForCheck) === undefined || getPrec(quoteForCheck) === undefined) { skipped++; continue; }
            const isSell = pAsset < rAsset;
            direction = isSell ? 'sell' : 'buy';
            baseAsset = isSell ? pAsset : rAsset;
            quoteAsset = isSell ? rAsset : pAsset;
            baseAmount = toReal(isSell ? f.pays.amount : f.receives.amount, baseAsset);
            quoteAmount = toReal(isSell ? f.receives.amount : f.pays.amount, quoteAsset);
            if (isNaN(baseAmount) || isNaN(quoteAmount)) { skipped++; continue; }
            price = quoteAmount / baseAmount;
            marketFeeReal = feeReal;
            marketFeeAsset = f.fee.asset_id;
        }

        if (filterAsset && baseAsset !== filterAsset) continue;

        // Validate market fee asset: fee is always deducted from receives
        // (base for buys, quote for sells). Warn if unexpected.
        if (marketFeeReal > 0 && marketFeeAsset !== '' && marketFeeAsset !== rAsset) {
            console.warn(`  [warn] Fill ${f.orderId}: fee asset ${marketFeeAsset} ≠ receives asset ${rAsset}. Market fee PnL may be incorrect.`);
        }

        const pairKey = `${baseAsset}:${quoteAsset}`;
        pairs.add(pairKey);

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
            marketFeeReal,
            marketFeeAsset,
        });
    }

    if (skipped > 0) {
        console.warn(`  [warn] ${skipped} fill(s) skipped due to unknown asset precision.`);
    }

    return { trades, pairs };
}

// ─── PnL Calculation (FIFO / Sequential) ─────────────────────────────────────

function analyzePair(trades: TradeFill[], matchMode: 'fifo' | 'sequential' = 'sequential'): PairAnalysis {
    const buys = trades.filter(t => t.direction === 'buy').sort((a, b) => a.sequence - b.sequence);
    const sells = trades.filter(t => t.direction === 'sell').sort((a, b) => a.sequence - b.sequence);

    const totalBuyBase = buys.reduce((s, t) => s + t.baseAmount, 0);
    const totalSellBase = sells.reduce((s, t) => s + t.baseAmount, 0);
    const totalBuyQuote = buys.reduce((s, t) => s + t.quoteAmount, 0);
    const totalSellQuote = sells.reduce((s, t) => s + t.quoteAmount, 0);

    // Merge all trades chronologically.
    // FIFO: buys add to queue, sells consume oldest lots (queue front).
    // Sequential: buys add to queue, sells consume newest lots (queue back / LIFO).
    const all = [...trades].sort((a, b) => a.sequence - b.sequence);
    const inventory: InventoryLot[] = [];
    const realizedPnls: RealizedPnl[] = [];
    let unmatchedSellBase = 0;

    for (const trade of all) {
        const grossPrice = trade.price;

        if (trade.direction === 'buy') {
            // Enter lot with net amount (gross receives minus market fee on receives)
            const lotAmount = trade.baseAmount - trade.marketFeeReal;
            if (lotAmount < 1e-12) continue;
            const lotEffPrice = trade.quoteAmount / lotAmount;
            inventory.push({
                amount: lotAmount,
                grossPrice: grossPrice,
                effPrice: lotEffPrice,
                time: trade.time,
                entryOrderId: trade.orderId,
                entryIsMaker: trade.isMaker,
            });
        } else {
            let remaining = trade.baseAmount;

            while (remaining > 0.00000001 && inventory.length > 0) {
                const lotIndex = matchMode === 'sequential' ? inventory.length - 1 : 0;
                const lot = inventory[lotIndex];
                const matched = Math.min(remaining, lot.amount);

                // Gross PnL using gross prices (before market fee deduction)
                const grossPnl = (grossPrice - lot.grossPrice) * matched;
                const grossPnlPct = lot.grossPrice > 0 ? ((grossPrice - lot.grossPrice) / lot.grossPrice) * 100 : 0;

                realizedPnls.push({
                    sellPrice: grossPrice,
                    buyPrice: lot.grossPrice,
                    amount: matched,
                    pnl: grossPnl,
                    pnlPct: grossPnlPct,
                    effPrice: lot.effPrice,
                    marketFeeEntry: 0,
                    marketFeeExit: 0,
                    feeBts: 0,
                    pnlNet: grossPnl,
                    pnlNetPct: grossPnlPct,
                    entryTime: lot.time,
                    exitTime: trade.time,
                    entryOrderId: lot.entryOrderId,
                    exitOrderId: trade.orderId,
                    entryIsMaker: lot.entryIsMaker,
                    exitIsMaker: trade.isMaker,
                });

                lot.amount -= matched;
                remaining -= matched;

                if (lot.amount < 0.00000001) {
                    if (matchMode === 'sequential') {
                        inventory.pop();
                    } else {
                        inventory.shift();
                    }
                }
            }

            if (remaining > 0.00000001) {
                unmatchedSellBase += remaining;
            }
        }
    }

    // ─── Market fee allocation (aggregated per order) ──────────────────────
    // A limit order may be filled across multiple fill_order_operations with
    // the same orderId.  Aggregate all fills' market fees per order, then
    // allocate pro-rata using the fill's net acquired amount as denominator.
    // (Market fee is paid on acquisition; the portion tied to unsold inventory
    //  is not yet realised.)
    const entryOrderFees = new Map<string, { feeInQuote: number; totalAcquired: number }>();
    const exitOrderFees = new Map<string, { feeInQuote: number; totalDisposed: number }>();

    for (const t of buys) {
        const e = entryOrderFees.get(t.orderId) || { feeInQuote: 0, totalAcquired: 0 };
        if (t.marketFeeReal > 0) {
            // Buy-side fee is in base → convert to quote using effective price
            const netBase = t.baseAmount - t.marketFeeReal;
            e.feeInQuote += netBase > 0 ? t.marketFeeReal * (t.quoteAmount / netBase) : 0;
        }
        e.totalAcquired += t.baseAmount - t.marketFeeReal;
        entryOrderFees.set(t.orderId, e);
    }

    for (const t of sells) {
        const e = exitOrderFees.get(t.orderId) || { feeInQuote: 0, totalDisposed: 0 };
        if (t.marketFeeReal > 0)
            e.feeInQuote += t.marketFeeReal; // Sell-side fee is already in quote
        e.totalDisposed += t.baseAmount;
        exitOrderFees.set(t.orderId, e);
    }

    for (const r of realizedPnls) {
        const eObj = entryOrderFees.get(r.entryOrderId);
        if (eObj && eObj.totalAcquired > 0)
            r.marketFeeEntry = eObj.feeInQuote * (r.amount / eObj.totalAcquired);

        const xObj = exitOrderFees.get(r.exitOrderId);
        if (xObj && xObj.totalDisposed > 0)
            r.marketFeeExit = xObj.feeInQuote * (r.amount / xObj.totalDisposed);

        r.pnlNet = r.pnl - r.marketFeeEntry - r.marketFeeExit;
        r.pnlNetPct = r.buyPrice > 0 ? (r.pnlNet / (r.buyPrice * r.amount)) * 100 : 0;
    }

    // ─── Blockchain fee allocation ─────────────────────────────────────────
    const buyOrderIds = new Set(buys.map(t => t.orderId));
    const sellOrderIds = new Set(sells.map(t => t.orderId));
    const entryTotalMatched = new Map<string, number>();
    const exitTotalMatched = new Map<string, number>();
    for (const r of realizedPnls) {
        entryTotalMatched.set(r.entryOrderId, (entryTotalMatched.get(r.entryOrderId) || 0) + r.amount);
        exitTotalMatched.set(r.exitOrderId, (exitTotalMatched.get(r.exitOrderId) || 0) + r.amount);
    }

    const totalBlockchainFees = (buyOrderIds.size + sellOrderIds.size) * BLOCKCHAIN_FEE_PER_FILL;
    for (const r of realizedPnls) {
        const eTotal = entryTotalMatched.get(r.entryOrderId) || 1;
        const xTotal = exitTotalMatched.get(r.exitOrderId) || 1;
        r.feeBts = BLOCKCHAIN_FEE_PER_FILL * (r.amount / eTotal) + BLOCKCHAIN_FEE_PER_FILL * (r.amount / xTotal);
        r.pnlNet -= r.feeBts;
        const costBasis = r.effPrice * r.amount;
        r.pnlNetPct = costBasis > 0 ? (r.pnlNet / costBasis) * 100 : 0;
    }

    const totalBuyBaseNet = buys.reduce((s, t) => s + t.baseAmount - t.marketFeeReal, 0);
    const totalRealizedPnl = realizedPnls.reduce((s, r) => s + r.pnl, 0);
    const totalMarketFees = realizedPnls.reduce((s, r) => s + r.marketFeeEntry + r.marketFeeExit, 0);
    const totalRealizedPnlNet = realizedPnls.reduce((s, r) => s + r.pnlNet, 0);
    const netPosition = totalBuyBaseNet - totalSellBase;
    const baseAsset = trades[0]?.baseAsset ?? '';
    const quoteAsset = trades[0]?.quoteAsset ?? '';

    return {
        baseAsset,
        quoteAsset,
        buys,
        sells,
        realizedPnls,
        totalBuyBase,
        totalSellBase,
        totalBuyQuote,
        totalSellQuote,
        unmatchedSellBase,
        totalRealizedPnl,
        totalMarketFees,
        totalBlockchainFees,
        totalRealizedPnlNet,
        netPosition,
    };
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

function fmt(n: number, decimals = 4): string {
    if (!Number.isFinite(n)) return 'NaN';
    return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPct(n: number): string {
    if (!Number.isFinite(n)) return 'NaN%';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtAsset(id: string): string {
    return assetSymbol(id);
}

function printSummary(pairs: PairAnalysis[], _accountId: string, _start: string, _end: string, _matchMode: 'fifo' | 'sequential' = 'sequential') {
    console.log('');

    for (const pair of pairs) {
        const pairLabel = `${fmtAsset(pair.baseAsset)}/${fmtAsset(pair.quoteAsset)}`;
        const totalBought = pair.totalBuyBase;
        const totalSold = pair.totalSellBase;
        const avgBuy = pair.totalBuyBase > 0 ? pair.totalBuyQuote / pair.totalBuyBase : 0;
        const avgSell = pair.totalSellBase > 0 ? pair.totalSellQuote / pair.totalSellBase : 0;

        console.log(` ── ${pairLabel}`);
        console.log(`    Buys:        ${fmt(totalBought, 4)} @ ${fmt(avgBuy, 6)} = ${fmt(pair.totalBuyQuote, 4)} ${fmtAsset(pair.quoteAsset)}`);
        console.log(`    Sells:       ${fmt(totalSold, 4)} @ ${fmt(avgSell, 6)} = ${fmt(pair.totalSellQuote, 4)} ${fmtAsset(pair.quoteAsset)}`);
        console.log(`    Net traded:  ${fmt(pair.netPosition, 4)} ${fmtAsset(pair.baseAsset)} (window flow)`);
        console.log(`    Trades:      ${pair.realizedPnls.length} matched lots, ${pair.buys.length} buys, ${pair.sells.length} sells`);
        if (pair.unmatchedSellBase > 0.0001) {
            console.log(`    Unmatched:   ${fmt(pair.unmatchedSellBase, 4)} ${fmtAsset(pair.baseAsset)} (sold without prior buy in window — expected if inventory predates window)`);
        }
        console.log(`    Gross PnL:    ${fmtAsset(pair.quoteAsset)} ${fmt(pair.totalRealizedPnl, 4)}`);
        const mktFee = pair.totalMarketFees;
        const blkFee = pair.totalBlockchainFees;
        if (mktFee > 0.0001) {
            console.log(`    Market fees:  ${fmtAsset(pair.quoteAsset)} ${fmt(-mktFee, 4)}`);
        }
        if (blkFee > 0.0001) {
            console.log(`    Blockchain:   BTS ${fmt(-blkFee, 4)}`);
        }
        console.log(`    Net PnL:      ${fmtAsset(pair.quoteAsset)} ${fmt(pair.totalRealizedPnlNet, 4)}`);
        if (pair.quoteAsset !== BTS_ID) {
            console.log(`    ⚠ Non-BTS quote — PnL is in ${fmtAsset(pair.quoteAsset)}, not BTS`);
        }
        console.log('');
    }

    // Grand totals grouped by quote asset
    const quoteGroups = new Map<string, PairAnalysis[]>();
    for (const p of pairs) {
        const q = p.quoteAsset;
        if (!quoteGroups.has(q)) quoteGroups.set(q, []);
        quoteGroups.get(q)!.push(p);
    }
    if (pairs.length > 1 && quoteGroups.size > 0) {
        for (const [quoteAsset, group] of quoteGroups) {
            const groupPnl = group.reduce((s, p) => s + p.totalRealizedPnl, 0);
            const groupMktFees = group.reduce((s, p) => s + p.totalMarketFees, 0);
            const groupBlkFees = group.reduce((s, p) => s + p.totalBlockchainFees, 0);
            const groupNet = group.reduce((s, p) => s + p.totalRealizedPnlNet, 0);
            const groupVol = group.reduce((s, p) => s + p.totalBuyQuote + p.totalSellQuote, 0);
            const qSymbol = fmtAsset(quoteAsset);
            console.log(` ── TOTAL (${qSymbol}) — ${group.length} pair(s)`);
            console.log(`    Gross PnL:    ${fmtAsset(quoteAsset)} ${fmt(groupPnl, 4)}`);
            if (groupMktFees > 0.0001) {
                console.log(`    Market fees:  ${fmtAsset(quoteAsset)} ${fmt(-groupMktFees, 4)}`);
            }
            if (groupBlkFees > 0.0001) {
                console.log(`    Blockchain:   BTS ${fmt(-groupBlkFees, 4)}`);
            }
            console.log(`    Net PnL:      ${fmtAsset(quoteAsset)} ${fmt(groupNet, 4)}`);
            console.log(`    Volume:       ${fmt(groupVol, 4)} ${qSymbol}`);
            console.log('');
        }
    }
    console.log(`  Note: PnL uses gross prices. Net PnL deducts market fees (charged by`);
    console.log(`        asset issuer on receives, both issuer and network portions) and`);
    console.log(`        blockchain operation fees (BTS per limit_order_create). Market`);
    console.log(`        fees are converted to quote asset. Buy lots are entered at net`);
    console.log(`        receives (gross minus buy-side market fee) so inventory matching`);
    console.log(`        reflects what the account actually held. If inventory predates the`);
    console.log(`        window or crosses asset pairs, the matched lots may not reflect`);
    console.log(`        true trade economics.`);
    console.log('');
}

function printPnlDetail(pairs: PairAnalysis[]) {
    for (const pair of pairs) {
        if (pair.realizedPnls.length === 0) continue;

        const pairLabel = `${fmtAsset(pair.baseAsset)}/${fmtAsset(pair.quoteAsset)}`;
        console.log('');
        console.log(` ── ${pairLabel} — Realized PnL Detail`);
        console.log('');

        const hdr = ' #   Buy Price    EffBuy      Sell Price   Amount    PnL         PnL%      MktFee    OpFeeBTS  Net PnL     Net%     Legs  Entry Time              Exit Time';
        console.log(hdr);
        console.log(' ' + '─'.repeat(hdr.length - 1));

        for (let i = 0; i < pair.realizedPnls.length; i++) {
            const r = pair.realizedPnls[i];
            const idx = String(i + 1).padStart(2);
            const bp = fmt(r.buyPrice, 8).padStart(11);
            const ep = fmt(r.effPrice, 8).padStart(11);
            const sp = fmt(r.sellPrice, 8).padStart(11);
            const amt = fmt(r.amount, 4).padStart(9);
            const pnlStr = fmt(r.pnl, 6).padStart(9);
            const pctStr = fmtPct(r.pnlPct).padStart(8);
            const mktFeeStr = fmt(r.marketFeeEntry + r.marketFeeExit, 4).padStart(8);
            const feeStr = fmt(r.feeBts, 4).padStart(8);
            const netStr = fmt(r.pnlNet, 6).padStart(10);
            const netPctStr = fmtPct(r.pnlNetPct).padStart(8);
            const mk = (r.entryIsMaker ? 'M' : 'T') + '/' + (r.exitIsMaker ? 'M' : 'T') + ' ';
            const et = (r.entryTime || '').slice(0, 22).padEnd(22);
            const xt = (r.exitTime || '').slice(0, 22).padEnd(22);
            console.log(` ${idx}  ${bp}  ${ep}  ${sp}  ${amt}  ${pnlStr}  ${pctStr}  ${mktFeeStr}  ${feeStr}  ${netStr}  ${netPctStr}  ${mk}  ${et}  ${xt}`);
        }
        console.log('');
    }
}

// ─── Performance Metrics ──────────────────────────────────────────────────────

interface TradingMetrics {
    totalLots: number;
    winRate: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    avgWinLossRatio: number;
    expectancyBts: number;
    expectancyPct: number;
    expectancyR: number;
    netExpectancyBts: number;
    dailyPnlRatio: number;
    dailyDownsideRatio: number;
    maxConsecWins: number;
    maxConsecLosses: number;
    avgHoldHours: number;
    limitOrderRatio: number;
    bestTradePct: number;
    worstTradePct: number;
    mddPct: number;
    mddHadStablePeak: boolean;
    isOngoingRecovery: boolean;
    currentDrawdownDays: number;
    medianPnlPct: number;
    p25PnlPct: number;
    p75PnlPct: number;

    feeDragPct: number;
    maxRecoveryDays: number;
    sellOrdersFilled: number;
    fillsPerOrderMean: number;
    fillsPerOrderMedian: number;
    fillsPerOrderMax: number;
    oneShotOrderRatio: number;
    fillsPerDay: number;
    avgVolumePerDay: number;
    medianR: number;
    pctRGreater1: number;
    pctRGreater2: number;
    pctRLessNeg1: number;
}

function percentile(sorted: number[], p: number): number {
    const n = sorted.length;
    if (n === 0) return 0;
    if (n === 1) return sorted[0];
    const k = (p / 100) * (n - 1);
    const f = Math.floor(k);
    const c = Math.ceil(k);
    if (f === c) return sorted[f];
    return sorted[f] * (c - k) + sorted[c] * (k - f);
}

function computeMetrics(pair: PairAnalysis): TradingMetrics {
    const pnls = pair.realizedPnls;
    const total = pnls.length;
    if (total === 0) {
        return {
            totalLots: 0, winRate: 0, profitFactor: 0,
            avgWin: 0, avgLoss: 0, avgWinLossRatio: 0,
            expectancyBts: 0, expectancyPct: 0, expectancyR: 0,
            netExpectancyBts: 0,
            dailyPnlRatio: 0, dailyDownsideRatio: 0,
            maxConsecWins: 0, maxConsecLosses: 0,
            avgHoldHours: 0, limitOrderRatio: 0,
            bestTradePct: 0, worstTradePct: 0,
            mddPct: 0,
            mddHadStablePeak: false,
            isOngoingRecovery: false,
            currentDrawdownDays: 0,
            medianPnlPct: 0, p25PnlPct: 0, p75PnlPct: 0,
            feeDragPct: 0, maxRecoveryDays: 0,
            medianR: 0, pctRGreater1: 0, pctRGreater2: 0, pctRLessNeg1: 0,
            sellOrdersFilled: 0, fillsPerOrderMean: 0, fillsPerOrderMedian: 0,
            fillsPerOrderMax: 0, oneShotOrderRatio: 0, fillsPerDay: 0, avgVolumePerDay: 0,
        };
    }

    const wins = pnls.filter(r => r.pnl > 0);
    const losses = pnls.filter(r => r.pnl < 0);
    const winRate = wins.length / total;
    const makerEntryCount = pnls.filter(r => r.entryIsMaker).length;
    const makerExitCount = pnls.filter(r => r.exitIsMaker).length;
    const totalMakerLegs = makerEntryCount + makerExitCount;

    const grossProfit = wins.reduce((s, r) => s + r.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, r) => s + r.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const totalFeeDrag = pair.totalMarketFees + pair.totalBlockchainFees;
    const feeDragPct = grossProfit > 0 ? (totalFeeDrag / grossProfit) * 100 : 0;

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, r) => s + r.pnl, 0) / losses.length : 0;

    const avgWinPct = wins.length > 0 ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0;
    const avgLossPct = losses.length > 0 ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0;

    const avgWinLossRatio = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? Infinity : 0;

    const expectancyBts = (winRate * avgWin) + ((1 - winRate) * avgLoss);
    const expectancyPct = (winRate * avgWinPct) + ((1 - winRate) * avgLossPct);
    const rMultiple = Math.abs(avgLoss);
    const expectancyR = rMultiple > 0
        ? winRate * (avgWin / rMultiple) - (1 - winRate)
        : Infinity;

    const netExpectancyBts = pair.totalRealizedPnlNet / total;

    // Daily-binned net PnL for mean/std ratio (dimensionful — not a Sharpe ratio)
    const dayBuckets: Record<string, number> = {};
    for (const r of pnls) {
        const day = r.exitTime.slice(0, 10);
        dayBuckets[day] = (dayBuckets[day] || 0) + r.pnlNet;
    }
    const dailyRets = Object.values(dayBuckets);
    const nDays = dailyRets.length;

    const meanDailyRet = nDays > 0 ? dailyRets.reduce((s, v) => s + v, 0) / nDays : 0;
    const dailyVar = nDays > 0
        ? dailyRets.reduce((s, v) => s + (v - meanDailyRet) ** 2, 0) / nDays
        : 0;
    const dailyStd = Math.sqrt(dailyVar);
    const annFactor = Math.sqrt(365);
    const dailyPnlRatio = dailyStd > 0 ? (meanDailyRet / dailyStd) * annFactor : 0;

    // Downside deviation uses only negative returns; same N denominator
    const downsideVar = nDays > 0
        ? dailyRets.reduce((s, v) => s + (v < 0 ? v * v : 0), 0) / nDays
        : 0;
    const downsideStd = Math.sqrt(downsideVar);
    const dailyDownsideRatio = downsideStd > 0 ? (meanDailyRet / downsideStd) * annFactor : 0;

    // Fills-per-order distribution (grouped by sell order)
    const fillCounts: number[] = [];
    const orderMap = new Map<string, number>();
    for (const r of pnls) {
        orderMap.set(r.exitOrderId, (orderMap.get(r.exitOrderId) || 0) + 1);
    }
    for (const c of orderMap.values()) fillCounts.push(c);
    const sellOrdersFilled = orderMap.size;
    const fillsPerOrderMean = sellOrdersFilled > 0
        ? fillCounts.reduce((s, v) => s + v, 0) / sellOrdersFilled
        : 0;
    const fillsPerOrderMax = sellOrdersFilled > 0
        ? fillCounts.reduce((a, b) => Math.max(a, b), 0)
        : 0;
    const sortedCounts = [...fillCounts].sort((a, b) => a - b);
    const fillsPerOrderMedian = sellOrdersFilled > 0 ? percentile(sortedCounts, 50) : 0;
    const oneShotOrderRatio = sellOrdersFilled > 0
        ? fillCounts.filter(c => c === 1).length / sellOrdersFilled
        : 0;
    const fillsPerDay = nDays > 0 ? total / nDays : 0;
    const avgVolumePerDay = nDays > 0 ? (pair.totalBuyQuote + pair.totalSellQuote) / nDays : 0;

    // Avg hold duration
    let totalHours = 0;
    let hourCount = 0;
    for (const r of pnls) {
        const entry = new Date(r.entryTime).getTime();
        const exit = new Date(r.exitTime).getTime();
        if (!isNaN(entry) && !isNaN(exit) && exit > entry) {
            totalHours += (exit - entry) / 3600000;
            hourCount++;
        }
    }
    const avgHoldHours = hourCount > 0 ? totalHours / hourCount : 0;

    // Max consecutive wins / losses (aggregated by exit order)
    const orderPnls = new Map<string, { pnl: number; time: string }>();
    for (const r of pnls) {
        const existing = orderPnls.get(r.exitOrderId);
        if (existing) {
            existing.pnl += r.pnl;
        } else {
            orderPnls.set(r.exitOrderId, { pnl: r.pnl, time: r.exitTime });
        }
    }
    const orderResults = [...orderPnls.values()].sort((a, b) =>
        new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    let consecW = 0, consecL = 0;
    let maxW = 0, maxL = 0;
    for (const { pnl } of orderResults) {
        if (pnl > 0) { consecW++; consecL = 0; maxW = Math.max(maxW, consecW); }
        else if (pnl < 0) { consecL++; consecW = 0; maxL = Math.max(maxL, consecL); }
        else { consecW = 0; consecL = 0; }
    }

    // ─── Max Drawdown + Recovery Time ───────────────────────────────────
    const STABILITY_TRADES = 3;
    const MIN_TRADES_FOR_PEAK = 10; // backstop for monotonic equity curves
    const chronological = [...pnls].sort((a, b) =>
        new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime()
    );
    let equity = 0, peak = 0, mddPct = 0;
    let maxRecoveryDays = 0;
    let isOngoingRecovery = false;
    let currentDrawdownDays = 0;
    let drawdownStartTime = 0;
    let troughTime = 0;
    let currentTroughEquity = Infinity;
    let hadStablePeak = false;
    let tradesSincePeakSet = 0;
    let hasPrePeakEquity = false;
    let prePeakMinEquity = 0;
    let totalTradesProcessed = 0;

    for (const r of chronological) {
        totalTradesProcessed++;
        equity += r.pnlNet;
        if (equity > peak) {
            if (troughTime > 0 && hadStablePeak) {
                const recoveryDays = (new Date(r.exitTime).getTime() - troughTime) / 86400000;
                if (recoveryDays > maxRecoveryDays) maxRecoveryDays = recoveryDays;
            }
            peak = equity;
            tradesSincePeakSet = 0;
            currentTroughEquity = Infinity;
            troughTime = 0;
            drawdownStartTime = 0;
        } else {
            tradesSincePeakSet++;
            if (tradesSincePeakSet >= STABILITY_TRADES) {
                hadStablePeak = true;
            }
        }
        if (!hadStablePeak && totalTradesProcessed >= MIN_TRADES_FOR_PEAK) {
            hadStablePeak = true;
        }

        if (hadStablePeak && equity < peak && peak > 0) {
            if (drawdownStartTime === 0) drawdownStartTime = new Date(r.exitTime).getTime();
            if (equity < currentTroughEquity) {
                currentTroughEquity = equity;
                troughTime = new Date(r.exitTime).getTime();
            }
            const dd = (equity - peak) / peak;
            if (dd < mddPct) mddPct = dd;
        }

        if (peak > 0 && !hadStablePeak) {
            if (!hasPrePeakEquity || equity < prePeakMinEquity) {
                prePeakMinEquity = equity;
                hasPrePeakEquity = true;
            }
        }
    }

    if (drawdownStartTime > 0 && hadStablePeak) {
        const lastTime = new Date(chronological[chronological.length - 1].exitTime).getTime();
        currentDrawdownDays = (lastTime - drawdownStartTime) / 86400000;
        isOngoingRecovery = true;
        if (currentDrawdownDays > maxRecoveryDays) {
            maxRecoveryDays = currentDrawdownDays;
        }
    }

    if (hadStablePeak) {
        mddPct *= 100;
    } else {
        mddPct = hasPrePeakEquity ? prePeakMinEquity : 0;
    }

    // Payoff distribution stats
    const pnlPcts = [...pnls.map(r => r.pnlPct)].sort((a, b) => a - b);
    const medianPnlPct = percentile(pnlPcts, 50);
    const p25PnlPct = percentile(pnlPcts, 25);
    const p75PnlPct = percentile(pnlPcts, 75);
    const absAvgLoss = Math.abs(avgLoss);
    let rValues: number[] = [];
    if (absAvgLoss > 0) {
        rValues = pnls.map(r => r.pnl / absAvgLoss).sort((a, b) => a - b);
    }
    const medianR = rValues.length > 0 ? percentile(rValues, 50) : 0;
    const pctRGreater1 = rValues.length > 0 ? rValues.filter(r => r > 1).length / rValues.length : 0;
    const pctRGreater2 = rValues.length > 0 ? rValues.filter(r => r > 2).length / rValues.length : 0;
    const pctRLessNeg1 = rValues.length > 0 ? rValues.filter(r => r < -1).length / rValues.length : 0;

    const bestTradePct = pnlPcts.length > 0 ? pnlPcts[pnlPcts.length - 1] : 0;
    const worstTradePct = pnlPcts.length > 0 ? pnlPcts[0] : 0;

    return {
        totalLots: total,
        winRate,
        profitFactor,
        avgWin,
        avgLoss,
        avgWinLossRatio,
        expectancyBts,
        expectancyPct,
        expectancyR,
        netExpectancyBts,
        dailyPnlRatio,
        dailyDownsideRatio,
        feeDragPct,
        maxConsecWins: maxW,
        maxConsecLosses: maxL,
        avgHoldHours,
        limitOrderRatio: total > 0 ? totalMakerLegs / (total * 2) : 0,
        bestTradePct,
        worstTradePct,
        mddPct,
        mddHadStablePeak: hadStablePeak,
        isOngoingRecovery,
        currentDrawdownDays,
        maxRecoveryDays,
        medianPnlPct,
        p25PnlPct,
        p75PnlPct,
        medianR,
        pctRGreater1,
        pctRGreater2,
        pctRLessNeg1,
        sellOrdersFilled,
        fillsPerOrderMean,
        fillsPerOrderMedian,
        fillsPerOrderMax,
        oneShotOrderRatio,
        fillsPerDay,
        avgVolumePerDay,
    };
}

function printMetrics(pairs: PairAnalysis[]) {
    for (const pair of pairs) {
        if (pair.realizedPnls.length === 0) continue;

        const m = computeMetrics(pair);
        const pairLabel = `${fmtAsset(pair.baseAsset)}/${fmtAsset(pair.quoteAsset)}`;

        console.log('');
        console.log(` ── ${pairLabel} — Performance Metrics`);
        console.log('');
        // Edge
        console.log(`  Win Rate:             ${(m.winRate * 100).toFixed(1)}%`);
        console.log(`  Profit Factor:        ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}`);
        const mktFeeStr = pair.totalMarketFees > 0.0001 ? ` (market ${fmt(pair.totalMarketFees, 4)})` : '';
        const blkFeeStr = pair.totalBlockchainFees > 0.0001 ? ` (op ${fmt(pair.totalBlockchainFees, 4)} BTS)` : '';
        console.log(`  Fee Drag:             ${m.feeDragPct > 0 ? m.feeDragPct.toFixed(2) + '% of gross profit' + mktFeeStr + blkFeeStr : '—'}`);
        console.log(`  Avg Win / Avg Loss:   ${m.avgWinLossRatio === Infinity ? '∞' : m.avgWinLossRatio.toFixed(2)}`);
        const qSymbol = fmtAsset(pair.quoteAsset);
        console.log(`  Expectancy (gross):   ${fmt(m.expectancyBts, 4)} ${qSymbol} (${fmtPct(m.expectancyPct)}) per trade`);
        const rDisplay = m.expectancyR === Infinity ? '∞' : m.expectancyR.toFixed(3) + 'R';
        console.log(`  Expectancy (R):       ${rDisplay}`);
        console.log(`  Expectancy (net):     ${fmt(m.netExpectancyBts, 4)} ${qSymbol} per trade`);
        console.log('');
        // Edge quality
        console.log(`  Median R:             ${m.medianR.toFixed(2)}`);
        console.log(`  Trades > 1R / > 2R:   ${(m.pctRGreater1 * 100).toFixed(1)}% / ${(m.pctRGreater2 * 100).toFixed(1)}%`);
        console.log(`  Trades < -1R:         ${(m.pctRLessNeg1 * 100).toFixed(1)}%`);
        console.log('');
        // PnL distribution
        console.log(`  Median PnL:           ${fmtPct(m.medianPnlPct)}`);
        console.log(`  P25 / P75:            ${fmtPct(m.p25PnlPct)} / ${fmtPct(m.p75PnlPct)}`);
        console.log(`  Best / Worst Trade:   ${fmtPct(m.bestTradePct)} / ${fmtPct(m.worstTradePct)}`);
        console.log('');
        // Risk-adjusted (dimensionful — based on absolute daily PnL, not % returns)
        console.log(`  Sharpe (ann):         ${m.dailyPnlRatio.toFixed(2)}`);
        console.log(`  Sortino (ann):        ${m.dailyDownsideRatio.toFixed(2)}`);
        console.log('');
        // Tail risk
        if (m.mddHadStablePeak) {
            console.log(`  Max Drawdown:         ${fmtPct(m.mddPct)}`);
        } else {
            console.log(`  Min Equity:            ${fmt(m.mddPct, 4)} ${fmtAsset(pair.quoteAsset)}`);
        }
        const recLabel = m.maxRecoveryDays > 0 ? m.maxRecoveryDays.toFixed(1) + ' days' + (m.isOngoingRecovery ? ' (ongoing)' : '') : '—';
        console.log(`  Max Recovery Time:    ${recLabel}`);
        if (m.currentDrawdownDays > 0) {
            console.log(`  Current Drawdown:     ${m.currentDrawdownDays.toFixed(1)} days (active)`);
        }
        console.log('');
        // Behavioral
        console.log(`  Max Consecutive W/L:  ${m.maxConsecWins} / ${m.maxConsecLosses}`);
        const holdDisplay = m.avgHoldHours > 0 ? m.avgHoldHours.toFixed(1) : '—';
        console.log(`  Avg hold time:        ${holdDisplay} hours`);
        console.log(`  Maker / Taker:        ${(m.limitOrderRatio * 100).toFixed(1)}% / ${((1 - m.limitOrderRatio) * 100).toFixed(1)}%`);
        console.log('');
        // Activity
        console.log(`  Sell orders filled:   ${m.sellOrdersFilled}`);
        console.log(`  Partial fills/order:  ${m.fillsPerOrderMean.toFixed(2)} mean, ${m.fillsPerOrderMedian.toFixed(1)} med, ${m.fillsPerOrderMax} max`);
        console.log(`  One-shot orders:      ${(m.oneShotOrderRatio * 100).toFixed(0)}%`);
        console.log(`  Fills/day:            ${m.fillsPerDay.toFixed(2)}`);
        console.log(`  Avg vol/day:          ${fmt(m.avgVolumePerDay, 2)} ${fmtAsset(pair.quoteAsset)}`);
        console.log('');

    }

    // Grand totals grouped by quote asset
    const quoteGroups = new Map<string, PairAnalysis[]>();
    for (const p of pairs) {
        const q = p.quoteAsset;
        if (!quoteGroups.has(q)) quoteGroups.set(q, []);
        quoteGroups.get(q)!.push(p);
    }
    if (pairs.length > 1 && quoteGroups.size > 0) {
        for (const [quoteAsset, group] of quoteGroups) {
            const totalLots = group.reduce((s, p) => s + p.realizedPnls.length, 0);
            const totalNet = group.reduce((s, p) => s + p.totalRealizedPnlNet, 0);
            const totalMktFees = group.reduce((s, p) => s + p.totalMarketFees, 0);
            const totalBlkFees = group.reduce((s, p) => s + p.totalBlockchainFees, 0);
            const qSymbol = fmtAsset(quoteAsset);
            console.log(` ── TOTAL (${qSymbol}) — ${group.length} pair(s)`);
            console.log(`    Lots:      ${totalLots}`);
            const feeParts: string[] = [];
            if (totalMktFees > 0.0001) feeParts.push(`market ${fmt(totalMktFees, 4)} ${qSymbol}`);
            if (totalBlkFees > 0.0001) feeParts.push(`op ${fmt(totalBlkFees, 4)} BTS`);
            const feeSuffix = feeParts.length > 0 ? `  (${feeParts.join(', ')})` : '';
            console.log(`    Net PnL:   ${fmtAsset(quoteAsset)} ${fmt(totalNet, 4)}${feeSuffix}`);
            console.log('');
        }
    }
}

// ─── CSV Export ──────────────────────────────────────────────────────────────

function exportCsv(pairs: PairAnalysis[], filePath: string) {
    const esc = (v: any) => { const s = String(v); return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = ['time,orderId,direction,baseAsset,quoteAsset,baseAmount,quoteAmount,price,isMaker,marketFeeReal,marketFeeAsset'];

    for (const pair of pairs) {
        for (const t of [...pair.buys, ...pair.sells].sort((a, b) => a.sequence - b.sequence)) {
            lines.push([
                esc(t.time),
                esc(t.orderId),
                esc(t.direction),
                esc(t.baseAsset),
                esc(t.quoteAsset),
                t.baseAmount,
                t.quoteAmount,
                t.price,
                t.isMaker ? '1' : '0',
                t.marketFeeReal,
                esc(t.marketFeeAsset),
            ].join(','));
        }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    console.log(`  Trades exported to ${filePath}`);
}

// ─── JSON Export ─────────────────────────────────────────────────────────────

function exportJson(accountId: string, start: string, end: string, pairs: PairAnalysis[], filePath: string) {
    const data = {
        accountId,
        period: { start, end },
        pairs: pairs.map(p => ({
            baseAsset: p.baseAsset,
            quoteAsset: p.quoteAsset,
            summary: {
                totalBuyBase: p.totalBuyBase,
                totalSellBase: p.totalSellBase,
                totalBuyQuote: p.totalBuyQuote,
                totalSellQuote: p.totalSellQuote,
                netPosition: p.netPosition,
                totalRealizedPnl: p.totalRealizedPnl,
                totalMarketFees: p.totalMarketFees,
                totalBlockchainFees: p.totalBlockchainFees,
                totalRealizedPnlNet: p.totalRealizedPnlNet,
            },
            realizedPnls: p.realizedPnls.map(r => ({
                ...r,
                marketFeeEntry: r.marketFeeEntry,
                marketFeeExit: r.marketFeeExit,
                feeBts: r.feeBts,
                pnlNet: r.pnlNet,
                pnlNetPct: r.pnlNetPct,
            })),
            totalBuys: p.buys.length,
            totalSells: p.sells.length,
        })),
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`  Full analysis exported to ${filePath}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
    const opts = parseArgs();
    let accountId = opts.accountId;

    if (opts.lookup) {
        const resolved = await resolveAccountId(accountId, opts.node);
        if (!resolved) {
            console.error(`  Could not resolve "${accountId}" to an account ID`);
            process.exit(1);
        }
        accountId = resolved;
    }

    // Build time range
    const now = new Date();
    let gte: string, lte: string;

    if (opts.start && opts.end) {
        gte = opts.start;
        lte = opts.end;
    } else if (opts.start) {
        gte = opts.start;
        lte = now.toISOString();
    } else {
        const hours = opts.hours || 168;
        const start = new Date(now.getTime() - hours * 3600 * 1000);
        gte = start.toISOString();
        lte = now.toISOString();
    }

    // Ensure times end with Z for ES
    if (!gte.endsWith('Z')) gte += gte.includes('T') ? 'Z' : 'T00:00:00Z';
    if (!lte.endsWith('Z')) lte += lte.includes('T') ? 'Z' : 'T00:00:00Z';

    const KIBANA_CFG = { timeout: 60000 };

    const fills = await fetchAllFills(KIBANA_CFG, accountId, gte, lte);

    if (fills.length === 0) {
        console.log('  No fills found in the specified time range.');
        process.exit(0);
    }

    // Resolve unknown asset precisions from blockchain
    await resolveAssetPrecisions(fills, opts.node);

    // Classify fills
    const { trades, pairs } = classifyFills(fills, opts.asset);

    if (trades.length === 0) {
        console.log('  No trades could be classified (check asset filter or time range).');
        process.exit(0);
    }

    console.log(`Account:  ${accountId}`);
    console.log(`Period:   ${gte.slice(0, 10)}  →  ${lte.slice(0, 10)}`);
    console.log(`Pairs:    ${pairs.size}, ${trades.length} classified trades`);
    const hasCrossPair = [...pairs].some(p => p.split(':')[1] !== BTS_ID);
    if (hasCrossPair) {
        console.log(`  Note: cross-pair trades (non-BTS quote) are included but PnL is in the pair's quote asset.`);
    }
    console.log('');

    // Override blockchain fee from CLI if provided
    if (opts.feePerOrder) BLOCKCHAIN_FEE_PER_FILL = opts.feePerOrder;

    // Analyze each pair
    const pairMap = new Map<string, TradeFill[]>();
    for (const t of trades) {
        const pairKey = `${t.baseAsset}:${t.quoteAsset}`;
        if (!pairMap.has(pairKey)) pairMap.set(pairKey, []);
        pairMap.get(pairKey)!.push(t);
    }

    const analyses: PairAnalysis[] = [];
    for (const [key, pairTrades] of pairMap) {
        const analysis = analyzePair(pairTrades, opts.matchMode);
        analyses.push(analysis);

        if (opts.verbose) {
            const [base, quote] = key.split(':');
            console.log(`  ${fmtAsset(base)}/${fmtAsset(quote)}: ${pairTrades.filter(t => t.direction === 'buy').length} buys, ${pairTrades.filter(t => t.direction === 'sell').length} sells, ${analysis.realizedPnls.length} matched lots`);
        }
    }

    // Sort pairs by volume (total quote)
    analyses.sort((a, b) => (b.totalBuyQuote + b.totalSellQuote) - (a.totalBuyQuote + a.totalSellQuote));

    // Output: summaries → grand total → per-match detail
    printSummary(analyses, accountId, gte, lte, opts.matchMode);

    if (opts.showPnlDetail) {
        printPnlDetail(analyses);
    }

    printMetrics(analyses);

    if (opts.csv) {
        exportCsv(analyses, opts.csv);
    }

    if (opts.json) {
        exportJson(accountId, gte, lte, analyses, opts.json);
    }
}

export { analyzePair, classifyFills, computeMetrics, TradeFill, FillRecord, RealizedPnl, PairAnalysis, TradingMetrics };

if (require.main === module) {
    run().then(() => process.exit(0)).catch(e => {
        console.error('\n[fatal]', e.message);
        if (process.env.DEBUG) console.error(e.stack);
        process.exit(1);
    });
}
