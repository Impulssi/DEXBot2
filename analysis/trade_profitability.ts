#!/usr/bin/env node
'use strict';

/**
 * TRADE PROFITABILITY ANALYZER
 *
 * Fetches fill_order operations for a BitShares account from Kibana
 * within a specified time range, then analyzes profitability using
 * FIFO inventory tracking per asset pair.
 *
 * Usage:
 *   tsx analysis/trade_profitability.ts 1.2.3 --start 2025-01-01 --end 2025-06-01
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 720
 *   tsx analysis/trade_profitability.ts 1.2.3 --start 2025-01-01T00:00:00Z --end 2025-06-01T00:00:00Z
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 168 --asset 1.3.113
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 168 --csv trades.csv
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 168 --json results.json
 *   tsx analysis/trade_profitability.ts "account-name" --lookup
 *   tsx analysis/trade_profitability.ts 1.2.3 --hours 168 --no-pnl-summary
 */

const { kibanaSearch, DEFAULT_CONFIG: BASE_CONFIG } = require('../market_adapter/core/kibana_client');

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_FILL_ORDER = 4;
const BTS_ID = '1.3.0';

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
function getPrec(id: string): number {
    const p = assetPrec(id);
    if (p === undefined) throw new Error(`Unknown precision for asset ${id}. Use --node to enable on-chain lookup.`);
    return p;
}

function toReal(amount: number, assetId: string): number {
    return amount / Math.pow(10, getPrec(assetId));
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

interface InventoryLot {
    amount: number;
    price: number;
    time: string;
    entryOrderId: string;
}

interface RealizedPnl {
    sellPrice: number;
    buyPrice: number;
    amount: number;
    pnl: number;
    pnlPct: number;
    entryTime: string;
    exitTime: string;
    entryOrderId: string;
    exitOrderId: string;
    isMaker: boolean;
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
    totalRealizedPnlPct: number;
    netPosition: number;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`\
Usage: tsx analysis/trade_profitability.ts <accountId> [options]

Analyzes filled orders for a BitShares account, computing realized PnL
via FIFO inventory tracking.

Arguments:
  accountId              BitShares account ID (1.2.x) or name (with --lookup)

Options:
  --start <iso>          Start time (ISO 8601, e.g. 2025-01-01 or 2025-01-01T00:00:00Z)
  --end <iso>            End time (ISO 8601)
  --hours <n>            Lookback hours from now (alternative to --start/--end)
  --asset <assetId>      Filter to one base asset (e.g. 1.3.113 for bitUSD)
  --lookup               Resolve account name to ID via BitShares node
  --node <url>           BitShares node URL (default: wss://dex.iobanker.com/ws)
  --csv <file>           Export trade list as CSV
  --json <file>          Export full analysis as JSON
  --no-pnl-summary       Skip per-order PnL breakdown, only show pair summary
  --verbose              Print extra debug info
  --help, -h             Show this help

Examples:
  tsx analysis/trade_profitability.ts 1.2.123456 --hours 720
  tsx analysis/trade_profitability.ts 1.2.123456 --start 2025-01-01 --end 2025-06-01
  tsx analysis/trade_profitability.ts "my-bot-account" --lookup --hours 168
  tsx analysis/trade_profitability.ts 1.2.123456 --hours 720 --asset 1.3.113 --csv trades.csv`);
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
        node: 'wss://dex.iobanker.com/ws',
        csv: null,
        json: null,
        noPnlSummary: false,
        verbose: false,
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
            case '--no-pnl-summary': opts.noPnlSummary = true; break;
            case '--verbose':      opts.verbose  = true; break;
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
    const { createReadOnlyClient } = require('../modules/bitshares-native');
    const client = createReadOnlyClient({ nodes: [nodeUrl] });
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
        for (const id of [f.pays.asset_id, f.receives.asset_id]) {
            if (id !== '1.3.0' && !(id in ASSETS) && !(id in resolvedPrecisions)) {
                unknownIds.add(id);
            }
        }
    }
    if (unknownIds.size === 0) return;

    if (!nodeUrl) {
        console.error(`  [fatal] ${unknownIds.size} unknown asset(s): ${[...unknownIds].join(', ')}. Pass --node <url> to enable on-chain resolution.`);
        process.exit(1);
    }

    const ids = [...unknownIds];
    console.log(`  Resolving ${ids.length} unknown asset(s) from blockchain...`);

    const { createReadOnlyClient } = require('../modules/bitshares-native');
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
        for (const id of ids) {
            if (!(id in resolvedPrecisions)) {
                console.error(`  [fatal] Asset ${id} not found on chain.`);
                process.exit(1);
            }
        }
    } catch (e: any) {
        console.error(`  [fatal] Asset resolution failed: ${e.message}`);
        process.exit(1);
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

        const result = await kibanaSearch(cfg, query);
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
            baseAsset = rAsset;
            quoteAsset = BTS_ID;
            baseAmount = toReal(f.receives.amount, rAsset);
            quoteAmount = toReal(f.pays.amount, BTS_ID);
            price = quoteAmount / baseAmount;
        } else if (rAsset === BTS_ID && pAsset !== BTS_ID) {
            direction = 'sell';
            baseAsset = pAsset;
            quoteAsset = BTS_ID;
            baseAmount = toReal(f.pays.amount, pAsset);
            quoteAmount = toReal(f.receives.amount, BTS_ID);
            price = quoteAmount / baseAmount;
        } else {
            // Non-BTS cross-pair (neither side is BTS): treat pays as the
            // sold asset and receives as the bought asset.
            direction = 'sell';
            baseAsset = pAsset;
            quoteAsset = rAsset;
            baseAmount = toReal(f.pays.amount, pAsset);
            quoteAmount = toReal(f.receives.amount, rAsset);
            price = quoteAmount / baseAmount;
        }

        if (filterAsset && baseAsset !== filterAsset) continue;

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
        });
    }

    return { trades, pairs };
}

// ─── PnL Calculation (FIFO) ──────────────────────────────────────────────────

function analyzePair(trades: TradeFill[]): PairAnalysis {
    const buys = trades.filter(t => t.direction === 'buy').sort((a, b) => a.sequence - b.sequence);
    const sells = trades.filter(t => t.direction === 'sell').sort((a, b) => a.sequence - b.sequence);

    const totalBuyBase = buys.reduce((s, t) => s + t.baseAmount, 0);
    const totalSellBase = sells.reduce((s, t) => s + t.baseAmount, 0);
    const totalBuyQuote = buys.reduce((s, t) => s + t.quoteAmount, 0);
    const totalSellQuote = sells.reduce((s, t) => s + t.quoteAmount, 0);

    // Merge all trades chronologically: buys add to FIFO inventory,
    // sells match against oldest lots
    const all = [...trades].sort((a, b) => a.sequence - b.sequence);
    const inventory: InventoryLot[] = [];
    const realizedPnls: RealizedPnl[] = [];
    let unmatchedSellBase = 0;
    let matchedBuyBase = 0;
    let matchedBuyQuote = 0;

    for (const trade of all) {
        if (trade.direction === 'buy') {
            inventory.push({
                amount: trade.baseAmount,
                price: trade.price,
                time: trade.time,
                entryOrderId: trade.orderId,
            });
        } else {
            let remaining = trade.baseAmount;

            while (remaining > 0.00000001 && inventory.length > 0) {
                const lot = inventory[0];
                const matched = Math.min(remaining, lot.amount);

                const pnl = (trade.price - lot.price) * matched;
                const pnlPct = lot.price > 0 ? ((trade.price - lot.price) / lot.price) * 100 : 0;

                realizedPnls.push({
                    sellPrice: trade.price,
                    buyPrice: lot.price,
                    amount: matched,
                    pnl,
                    pnlPct,
                    entryTime: lot.time,
                    exitTime: trade.time,
                    entryOrderId: lot.entryOrderId,
                    exitOrderId: trade.orderId,
                    isMaker: trade.isMaker,
                });

                matchedBuyBase += matched;
                matchedBuyQuote += lot.price * matched;
                lot.amount -= matched;
                remaining -= matched;

                if (lot.amount < 0.00000001) {
                    inventory.shift();
                }
            }

            if (remaining > 0.00000001) {
                unmatchedSellBase += remaining;
            }
        }
    }

    const netPosition = totalBuyBase - totalSellBase;
    const avgBuyPrice = matchedBuyBase > 0 ? matchedBuyQuote / matchedBuyBase : 0;
    const avgSellPrice = realizedPnls.length > 0
        ? realizedPnls.reduce((s, r) => s + r.sellPrice * r.amount, 0) / realizedPnls.reduce((s, r) => s + r.amount, 0)
        : 0;
    const totalRealizedPnl = realizedPnls.reduce((s, r) => s + r.pnl, 0);
    const totalRealizedPnlPct = avgBuyPrice > 0
        ? ((avgSellPrice - avgBuyPrice) / avgBuyPrice) * 100
        : 0;

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
        totalRealizedPnlPct,
        netPosition,
    };
}

// ─── Output Helpers ──────────────────────────────────────────────────────────

function fmt(n: number, decimals = 4): string {
    if (!Number.isFinite(n)) return 'NaN';
    return n.toFixed(decimals);
}

function fmtPct(n: number): string {
    if (!Number.isFinite(n)) return 'NaN%';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtAsset(id: string): string {
    return assetSymbol(id);
}

function printSummary(pairs: PairAnalysis[], accountId: string, start: string, end: string) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(' TRADE PROFITABILITY ANALYSIS');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(` Account:  ${accountId}`);
    console.log(` Period:   ${start}  →  ${end}`);
    console.log(` Pairs:    ${pairs.length}`);
    console.log('');

    let grandTotalPnl = 0;
    let grandTotalVolume = 0;

    for (const pair of pairs) {
        const pairLabel = `${fmtAsset(pair.baseAsset)}/${fmtAsset(pair.quoteAsset)}`;
        const totalBought = pair.totalBuyBase;
        const totalSold = pair.totalSellBase;
        const avgBuy = pair.totalBuyBase > 0 ? pair.totalBuyQuote / pair.totalBuyBase : 0;
        const avgSell = pair.totalSellBase > 0 ? pair.totalSellQuote / pair.totalSellBase : 0;

        grandTotalPnl += pair.totalRealizedPnl;
        grandTotalVolume += pair.totalBuyQuote + pair.totalSellQuote;

        console.log(` ── ${pairLabel}`);
        console.log(`    Buys:        ${fmt(totalBought, 4)} @ ${fmt(avgBuy, 6)} = ${fmt(pair.totalBuyQuote, 4)} ${fmtAsset(pair.quoteAsset)}`);
        console.log(`    Sells:       ${fmt(totalSold, 4)} @ ${fmt(avgSell, 6)} = ${fmt(pair.totalSellQuote, 4)} ${fmtAsset(pair.quoteAsset)}`);
        console.log(`    Net pos:     ${fmt(pair.netPosition, 4)} ${fmtAsset(pair.baseAsset)}`);
        console.log(`    Trades:      ${pair.realizedPnls.length} matched lots, ${pair.buys.length} buys, ${pair.sells.length} sells`);
        if (pair.unmatchedSellBase > 0.0001) {
            console.log(`    Unmatched:   ${fmt(pair.unmatchedSellBase, 4)} ${fmtAsset(pair.baseAsset)} sold without prior buy`);
        }
        if (pair.totalRealizedPnl >= 0) {
            console.log(`    Realized PnL: ${fmtAsset(pair.quoteAsset)} ${fmt(pair.totalRealizedPnl, 4)} (${fmtPct(pair.totalRealizedPnlPct)})`);
        } else {
            console.log(`    Realized PnL: ${fmtAsset(pair.quoteAsset)} ${fmt(pair.totalRealizedPnl, 4)} (${fmtPct(pair.totalRealizedPnlPct)})`);
        }
        console.log('');
    }

    // Grand total
    if (pairs.length > 1) {
        console.log(` ── TOTAL`);
        console.log(`    Realized PnL: ${fmt(grandTotalPnl, 4)} across ${pairs.length} pairs`);
        console.log(`    Volume:       ${fmt(grandTotalVolume, 4)}`);
        console.log('');
    }
}

function printPnlDetail(pairs: PairAnalysis[]) {
    for (const pair of pairs) {
        if (pair.realizedPnls.length === 0) continue;

        const pairLabel = `${fmtAsset(pair.baseAsset)}/${fmtAsset(pair.quoteAsset)}`;
        console.log('');
        console.log(` ── ${pairLabel} — Realized PnL Detail (FIFO)`);
        console.log('');

        const hdr = ' #   Buy Price    Sell Price   Amount    PnL         PnL%      Maker  Entry Time              Exit Time';
        console.log(hdr);
        console.log(' ' + '─'.repeat(hdr.length - 1));

        for (let i = 0; i < pair.realizedPnls.length; i++) {
            const r = pair.realizedPnls[i];
            const idx = String(i + 1).padStart(2);
            const bp = fmt(r.buyPrice, 8).padStart(11);
            const sp = fmt(r.sellPrice, 8).padStart(11);
            const amt = fmt(r.amount, 4).padStart(9);
            const pnlStr = fmt(r.pnl, 6).padStart(9);
            const pctStr = fmtPct(r.pnlPct).padStart(8);
            const mk = r.isMaker ? '  M ' : '  T ';
            const et = (r.entryTime || '').slice(0, 22).padEnd(22);
            const xt = (r.exitTime || '').slice(0, 22).padEnd(22);
            console.log(` ${idx}  ${bp}  ${sp}  ${amt}  ${pnlStr}  ${pctStr}  ${mk}  ${et}  ${xt}`);
        }
        console.log('');
    }
}

// ─── CSV Export ──────────────────────────────────────────────────────────────

function exportCsv(pairs: PairAnalysis[], filePath: string) {
    const fs = require('fs');
    const lines = ['time,orderId,direction,baseAsset,quoteAsset,baseAmount,quoteAmount,price,isMaker'];

    for (const pair of pairs) {
        for (const t of [...pair.buys, ...pair.sells].sort((a, b) => a.sequence - b.sequence)) {
            lines.push([
                t.time,
                t.orderId,
                t.direction,
                t.baseAsset,
                t.quoteAsset,
                t.baseAmount,
                t.quoteAmount,
                t.price,
                t.isMaker ? '1' : '0',
            ].join(','));
        }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    console.log(`  Trades exported to ${filePath}`);
}

// ─── JSON Export ─────────────────────────────────────────────────────────────

function exportJson(accountId: string, start: string, end: string, pairs: PairAnalysis[], filePath: string) {
    const fs = require('fs');
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
                totalRealizedPnlPct: p.totalRealizedPnlPct,
            },
            realizedPnls: p.realizedPnls,
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
        console.log(`Resolving account name "${accountId}"...`);
        const resolved = await resolveAccountId(accountId, opts.node);
        if (!resolved) {
            console.error(`  Could not resolve "${accountId}" to an account ID`);
            process.exit(1);
        }
        console.log(`  Resolved to ${resolved}\n`);
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

    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(' Fetching fills from Kibana');
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log(` Account:     ${accountId}`);
    console.log(` Time range:  ${gte}  →  ${lte}`);
    if (opts.asset) console.log(` Asset:       ${opts.asset}`);
    console.log('');

    const fills = await fetchAllFills(KIBANA_CFG, accountId, gte, lte);
    console.log(`  Fetched ${fills.length} fill operations`);
    console.log('');

    if (fills.length === 0) {
        console.log('  No fills found in the specified time range.');
        return;
    }

    // Resolve unknown asset precisions from blockchain
    await resolveAssetPrecisions(fills, opts.node);

    // Classify fills
    const { trades, pairs } = classifyFills(fills, opts.asset);

    if (trades.length === 0) {
        console.log('  No trades could be classified (check asset filter or time range).');
        return;
    }

    console.log(`  Classified ${trades.length} trades across ${pairs.size} pair(s)`);
    console.log('');

    // Analyze each pair
    const pairMap = new Map<string, TradeFill[]>();
    for (const t of trades) {
        const key = `${t.baseAsset}:${t.quoteAsset}`;
        if (!pairMap.has(key)) pairMap.set(key, []);
        pairMap.get(key)!.push(t);
    }

    const analyses: PairAnalysis[] = [];
    for (const [key, pairTrades] of pairMap) {
        const analysis = analyzePair(pairTrades);
        analyses.push(analysis);

        if (opts.verbose) {
            const [base, quote] = key.split(':');
            console.log(`  ${fmtAsset(base)}/${fmtAsset(quote)}: ${pairTrades.filter(t => t.direction === 'buy').length} buys, ${pairTrades.filter(t => t.direction === 'sell').length} sells, ${analysis.realizedPnls.length} matched lots`);
        }
    }

    // Sort pairs by volume (total quote)
    analyses.sort((a, b) => (b.totalBuyQuote + b.totalSellQuote) - (a.totalBuyQuote + a.totalSellQuote));

    // Output: summaries → grand total → per-match detail
    printSummary(analyses, accountId, gte, lte);

    if (!opts.noPnlSummary) {
        printPnlDetail(analyses);
    }

    if (opts.csv) {
        exportCsv(analyses, opts.csv);
    }

    if (opts.json) {
        exportJson(accountId, gte, lte, analyses, opts.json);
    }
}

run().then(() => process.exit(0)).catch(e => {
    console.error('\n[fatal]', e.message);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
});
