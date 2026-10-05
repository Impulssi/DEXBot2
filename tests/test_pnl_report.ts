'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running PnL report tests');

const {
    parseArgs,
    classifyFills,
    analyzePair,
    computeMetrics,
    reportFileName,
} = require('../analysis/trade_profitability');
const { renderPnlReportHtml, writePnlReport } = require('../analysis/pnl_report');
const { formatFundsValue } = require('../modules/order/format');

// ── 4-significant-figure rounding (shared with `dexbot order`) ────────────
assert.equal(formatFundsValue(19423608.6059), '19.42M');
assert.equal(formatFundsValue(14950.9704), '14.95K');
assert.equal(formatFundsValue(1009.79430322), '1.010K', 'significant trailing zero is kept');
assert.equal(formatFundsValue(10000), '10.00K');
assert.equal(formatFundsValue(1000), '1.000K');
assert.equal(formatFundsValue(1500000), '1.500M');
assert.equal(formatFundsValue(212593.47), '212.6K');
assert.equal(formatFundsValue(518.6985), '518.7');
assert.equal(formatFundsValue(82.66), '82.66');
assert.equal(formatFundsValue(0.09652), '0.09652');

const BTS = '1.3.0';
const XRP = '1.3.5537';   // IOB.XRP (static ASSETS table)
const USDT = '1.3.5589';  // XBTSX.USDT (static ASSETS table)

// ── CLI parsing ───────────────────────────────────────────────────────────
let o = parseArgs(['acc', '--month', '3', '--pair', 'IOB.XRP/BTS']);
assert.equal(o.months, 3);
assert.deepEqual(o.pair, { base: 'IOB.XRP', quote: 'BTS' });
assert.equal(o.html, false);

o = parseArgs(['acc', '--month=6', '--report', 'out.html', '--match-mode', 'fifo']);
assert.equal(o.months, 6);
assert.equal(o.report, 'out.html');
assert.equal(o.html, true, '--report implies --html');
assert.equal(o.matchMode, 'fifo');

// Default range when no time flag is given: 3 months.
assert.equal(parseArgs(['acc']).months, 3);
assert.equal(parseArgs(['acc', '--hours', '48']).months, null, 'explicit --hours wins');
assert.throws(() => parseArgs(['acc', '--month', '0']), /--month/);
assert.throws(() => parseArgs(['acc', '--hours', 'abc']), /--hours/);
assert.throws(() => parseArgs(['acc', '--pair', 'NOPE']), /--pair/);
assert.throws(() => parseArgs(['acc', '--pair']), /--pair: missing value/);
assert.throws(() => parseArgs(['acc', '--report']), /--report: missing value/);
// `--flag=value` spelling works for the new flags too.
assert.deepEqual(parseArgs(['acc', '--pair=IOB.XRP/BTS', '--month=4']).pair, { base: 'IOB.XRP', quote: 'BTS' });
assert.equal(parseArgs(['acc', '--pair=IOB.XRP/BTS', '--month=4']).months, 4);
assert.throws(() => parseArgs(['acc', '--bogus']), /Unknown option/);

// ── Auto-named report path ────────────────────────────────────────────────
assert.equal(reportFileName(parseArgs(['1.2.3', '--month', '2']), '1.2.3', null), 'pnl_1-2-3_2m.html');
assert.equal(
    reportFileName(parseArgs(['1.2.3', '--month', '2', '--pair', 'a/b']), '1.2.3', 'My Bot'),
    'pnl_my-bot_a-b_2m.html',
);
assert.equal(reportFileName(parseArgs(['1.2.3', '--hours', '48']), '1.2.3', null), 'pnl_1-2-3_48h.html');

// ── Pair filter ───────────────────────────────────────────────────────────
function fill(assetA: string, assetB: string, i: number) {
    return {
        time: `2026-01-0${i}T00:00:00Z`,
        blockNum: i,
        opNum: i,
        orderId: `o${i}`,
        accountId: '1.2.3',
        pays: { amount: 100, asset_id: assetA },
        receives: { amount: 200, asset_id: assetB },
        fee: { amount: 0, asset_id: BTS },
        isMaker: true,
        sort: [i],
    };
}

const fills = [fill(XRP, BTS, 1), fill(USDT, BTS, 2), fill(XRP, USDT, 3)];
assert.equal(classifyFills(fills, null, null).trades.length, 3);
const bySymbol = classifyFills(fills, null, { base: 'IOB.XRP', quote: 'BTS' });
assert.equal(bySymbol.trades.length, 1);
assert.equal(classifyFills(fills, null, { base: XRP, quote: BTS }).trades.length, 1, 'filter accepts 1.3.x ids');
assert.equal(classifyFills(fills, null, { base: 'IOB.XRP', quote: 'NOPE' }).trades.length, 0);

// ── HTML rendering ────────────────────────────────────────────────────────
function trade(o: any) {
    return {
        time: o.time,
        orderId: o.orderId,
        direction: o.direction,
        baseAsset: o.baseAsset,
        quoteAsset: o.quoteAsset,
        baseAmount: o.baseAmount,
        quoteAmount: o.quoteAmount,
        price: o.quoteAmount / o.baseAmount,
        isMaker: true,
        sequence: o.sequence,
        marketFeeReal: 0,
        marketFeeAsset: o.baseAsset,
    };
}
const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const trades = [
    trade({ time: new Date(t0).toISOString(), orderId: 'b1', direction: 'buy', baseAsset: XRP, quoteAsset: BTS, baseAmount: 100, quoteAmount: 100, sequence: 1 }),
    trade({ time: new Date(t0 + 86400000).toISOString(), orderId: 's1', direction: 'sell', baseAsset: XRP, quoteAsset: BTS, baseAmount: 100, quoteAmount: 110, sequence: 2 }),
];
const pair = analyzePair(trades, 'sequential');
const metrics = computeMetrics(pair, { startMs: t0, endMs: t0 + 86400000 });

const html = renderPnlReportHtml({
    accountRef: 'safe-ref',
    accountId: '1.2.345678',
    botName: '<script>alert(1)</script>',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-02-01T00:00:00.000Z',
    matchMode: 'sequential',
    pairFilter: 'IOB.XRP/BTS',
    pairs: [{ pair, metrics }],
});
assert.ok(html.startsWith('<!DOCTYPE html>'), 'self-contained document');
assert.ok(html.includes('PnL Report'));
assert.ok(html.includes('IOB.XRP'));
assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'bot name is HTML-escaped');
assert.ok(!html.includes('<script>alert(1)</script>'), 'no unescaped injection');
assert.ok(html.includes('filter: pair IOB.XRP/BTS'), 'pair filter shown in header');
assert.ok(html.includes('Realized lots (1)'));

// Empty pair renders the metrics empty state instead of throwing.
const emptyPair = analyzePair([], 'sequential');
const emptyHtml = renderPnlReportHtml({
    accountRef: '1.2.3',
    accountId: '1.2.3',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-02-01T00:00:00.000Z',
    matchMode: 'sequential',
    pairs: [{ pair: emptyPair, metrics: computeMetrics(emptyPair) }],
});
assert.ok(emptyHtml.includes('No realized lots'), 'empty state present');

// Large magnitudes are compacted to 4 significant figures in the HTML.
const bigPair: any = {
    baseAsset: XRP, quoteAsset: BTS, buys: [], sells: [], realizedPnls: [],
    totalBuyBase: 0, totalSellBase: 0, totalBuyQuote: 19423608.6059, totalSellQuote: 0,
    netPosition: 0, unmatchedSellBase: 0, totalRealizedPnl: 0, totalMarketFees: 0,
    totalBlockchainFees: 0, totalRealizedPnlNet: 0,
};
const bigHtml = renderPnlReportHtml({
    accountRef: '1.2.3', accountId: '1.2.3',
    start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z',
    matchMode: 'sequential',
    pairs: [{ pair: bigPair, metrics: computeMetrics(bigPair) }],
});
assert.ok(bigHtml.includes('19.42M'), 'large volume compacted to 4 sig figs');
assert.ok(!/19,423,608\.\d/.test(bigHtml), 'no raw 8-decimal volume');

// Both fee kinds collapse into ONE card so the left block stays a clean 2x2.
const bothFeePair: any = {
    baseAsset: XRP, quoteAsset: BTS, buys: [], sells: [], realizedPnls: [],
    totalBuyBase: 0, totalSellBase: 0, totalBuyQuote: 0, totalSellQuote: 0,
    netPosition: 0, unmatchedSellBase: 0, totalRealizedPnl: 0,
    totalMarketFees: 5, totalBlockchainFees: 3, totalRealizedPnlNet: 0,
};
const bothFeeHtml = renderPnlReportHtml({
    accountRef: '1.2.3', accountId: '1.2.3',
    start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z',
    matchMode: 'sequential', pairs: [{ pair: bothFeePair, metrics: computeMetrics(bothFeePair) }],
});
assert.ok(bothFeeHtml.includes('>Fees<'), 'combined fee card label');
assert.ok(bothFeeHtml.includes('op -3.000 BTS'), 'op fee shown in the fee card sub-line');
assert.ok(!bothFeeHtml.includes('>Market fees<'), 'no separate market-fee card');
assert.ok(!bothFeeHtml.includes('>Blockchain fees<'), 'no separate blockchain-fee card');

// A zero PnL must not be rendered as a signed "+0".
assert.ok(bothFeeHtml.includes('0 BTS'), 'zero renders plainly');
assert.ok(!bothFeeHtml.includes('+0 BTS'), 'no spurious +0');

// ── File write ────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-report-'));
const outPath = path.join(dir, 'nested', 'report.html');
const written = writePnlReport({
    accountRef: '1.2.3',
    accountId: '1.2.3',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-02-01T00:00:00.000Z',
    matchMode: 'sequential',
    pairs: [{ pair, metrics }],
}, outPath);
assert.equal(written, outPath);
assert.ok(fs.existsSync(outPath), 'report written (parent dir auto-created)');
assert.ok(fs.readFileSync(outPath, 'utf8').includes('PnL Report'));
fs.rmSync(dir, { recursive: true, force: true });

console.log('✓ PnL report tests passed');
