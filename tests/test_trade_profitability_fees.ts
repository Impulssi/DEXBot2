'use strict';

const assert = require('assert');

console.log('Running trade profitability fee tests');

/**
 * Test the market fee model integrated into analyzePair.
 *
 * Verifies that the BitShares market fee (fill_order_operation.fee) is
 * correctly reflected in PnL calculations:
 *
 *   db_market.cpp fill_limit_order:
 *     issuer_fees = pay_market_fees(seller, receives_asset, receives, is_maker)
 *     order_receives = receives - issuer_fees           ← fee deducted from receives
 *     push_applied_operation(..., receives (gross), issuer_fees, ...)
 *
 * For buys  (pays=quote, receives=base): fee is in base  → buy price ↑
 * For sells (pays=base, receives=quote): fee is in quote → sell price ↓
 */

// ─── Helpers ──────────────────────────────────────────────────────────────

const BTS_ID = '1.3.0';
const ASSET_A = '1.3.5589'; // XBTSX.USDT (precision 6)

function t(overrides: Record<string, any> = {}) {
    return {
        time: overrides.time || '2025-01-01T12:00:00Z',
        orderId: overrides.orderId || '1.7.1',
        direction: overrides.direction || 'buy',
        baseAsset: overrides.baseAsset || ASSET_A,
        quoteAsset: overrides.quoteAsset || BTS_ID,
        baseAmount: overrides.baseAmount ?? 10,
        quoteAmount: overrides.quoteAmount ?? 10,
        price: overrides.price ?? 1.0,
        isMaker: overrides.isMaker ?? true,
        sequence: overrides.sequence ?? 1,
        marketFeeReal: overrides.marketFeeReal ?? 0,
        marketFeeAsset: overrides.marketFeeAsset ?? ASSET_A,
    };
}

// Load the module
const { analyzePair, computeMetrics } = require('../analysis/trade_profitability');

// ─── Test: No market fees → PnL unchanged ─────────────────────────────────

function testNoMarketFees() {
    const trades = [
        t({
            direction: 'buy', baseAmount: 10, quoteAmount: 100,
            price: 10, sequence: 1, orderId: '1.7.1',
            marketFeeReal: 0,
        }),
        t({
            direction: 'sell', baseAmount: 10, quoteAmount: 110,
            price: 11, sequence: 2, orderId: '1.7.2',
            marketFeeReal: 0,
        }),
    ];

    const result = analyzePair(trades, 'fifo');

    assert.strictEqual(result.realizedPnls.length, 1, 'should have 1 realized PnL');
    assert.strictEqual(result.totalRealizedPnl, 10, 'gross PnL = (11-10)*10 = 10');
    assert.strictEqual(result.totalMarketFees, 0, 'no market fees');
    assert.strictEqual(result.totalBlockchainFees, 2 * 0.09652, '2 orders × blockchain fee');
    // Without market fees, pnlNet should be gross - blockchain fees
    const expectedNet = 10 - 2 * 0.09652;
    assert.ok(Math.abs(result.totalRealizedPnlNet - expectedNet) < 0.001,
        `net PnL ≈ ${expectedNet.toFixed(4)}, got ${result.totalRealizedPnlNet.toFixed(4)}`);
    assert.strictEqual(result.totalMarketFees, 0, 'market fee total should be 0');
}

// ─── Test: Buy-side market fee only ───────────────────────────────────────

function testBuySideMarketFee() {
    // Buy 10 units @ 10 BTS/unit with 1% market fee on receives (base)
    // pays: 100 BTS, receives (gross): 10 base, fee: 0.1 base (1% of 10)
    // net receives: 9.9 base
    // effective buy price: 100 / 9.9 ≈ 10.10101 BTS/base
    const trades = [
        t({
            direction: 'buy', baseAmount: 10, quoteAmount: 100,
            price: 10, sequence: 1, orderId: '1.7.1',
            marketFeeReal: 0.1, marketFeeAsset: ASSET_A,
        }),
        // Sell at 11 BTS/unit, no fee
        t({
            direction: 'sell', baseAmount: 10, quoteAmount: 110,
            price: 11, sequence: 2, orderId: '1.7.2',
            marketFeeReal: 0,
        }),
    ];

    const result = analyzePair(trades, 'fifo');

    assert.strictEqual(result.realizedPnls.length, 1, 'should have 1 realized PnL');
    // Lot = 10 - 0.1 = 9.9 (net receives). Only 9.9 can be matched.
    // Gross PnL = (11 - 10) * 9.9 = 9.9
    assert.strictEqual(result.totalRealizedPnl, 9.9, 'gross PnL = 9.9');

    // Market fee = 0.1 base × (100 BTS / 9.9 net base) — fully realised on full sale
    const expectedMarketFee = 0.1 * (100 / 9.9);
    assert.ok(Math.abs(result.totalMarketFees - expectedMarketFee) < 0.001,
        `market fee drag ≈ ${expectedMarketFee.toFixed(4)}, got ${result.totalMarketFees.toFixed(4)}`);

    // 0.1 base units were never actually received — they show as unmatched
    assert.ok(Math.abs(result.unmatchedSellBase - 0.1) < 0.0001,
        '~0.1 base unmatched (never received), got ' + result.unmatchedSellBase);

    // Verify marketFeeEntry on the realized PnL
    const r = result.realizedPnls[0];
    assert.ok(r.marketFeeEntry > 0, 'entry market fee should be > 0');
    assert.strictEqual(r.marketFeeExit, 0, 'exit market fee should be 0');
}

// ─── Test: Sell-side market fee only ──────────────────────────────────────

function testSellSideMarketFee() {
    // Buy 10 units @ 10 BTS/unit, no fee
    const trades = [
        t({
            direction: 'buy', baseAmount: 10, quoteAmount: 100,
            price: 10, sequence: 1, orderId: '1.7.1',
            marketFeeReal: 0,
        }),
        // Sell 10 units @ 11 BTS/unit with 1% market fee on receives (BTS = quote)
        // pays: 10 base, receives (gross): 110 BTS, fee: 1.1 BTS (1%)
        // net receives: 108.9 BTS
        t({
            direction: 'sell', baseAmount: 10, quoteAmount: 110,
            price: 11, sequence: 2, orderId: '1.7.2',
            marketFeeReal: 1.1, marketFeeAsset: BTS_ID,
        }),
    ];

    const result = analyzePair(trades, 'fifo');

    assert.strictEqual(result.realizedPnls.length, 1);
    assert.strictEqual(result.totalRealizedPnl, 10, 'gross PnL = (11-10)*10 = 10');

    // Effective sell price = (110 - 1.1) / 10 = 108.9 / 10 = 10.89
    // Market-fee-adjusted PnL = (10.89 - 10) * 10 = 8.9
    // marketFeeDrag = 10 - 8.9 = 1.1
    const expectedMgross = 10 - (10.89 - 10) * 10;
    assert.ok(Math.abs(result.totalMarketFees - expectedMgross) < 0.001,
        `market fee drag ≈ ${expectedMgross.toFixed(4)}, got ${result.totalMarketFees.toFixed(4)}`);

    const r = result.realizedPnls[0];
    assert.strictEqual(r.marketFeeEntry, 0, 'entry market fee should be 0');
    assert.ok(r.marketFeeExit > 0, 'exit market fee should be > 0');
}

// ─── Test: Both-side market fees ──────────────────────────────────────────

function testBothSidesMarketFees() {
    // Buy: 1% market fee on receives (base)
    // Sell: 1% market fee on receives (quote = BTS)
    const grossBuyPrice = 10;
    const grossSellPrice = 11;
    const amount = 10;
    const buyFee = 0.1;   // 1% of 10 base
    const sellFee = 1.1;  // 1% of 110 BTS

    const trades = [
        t({
            direction: 'buy', baseAmount: amount, quoteAmount: amount * grossBuyPrice,
            price: grossBuyPrice, sequence: 1, orderId: '1.7.1',
            marketFeeReal: buyFee, marketFeeAsset: ASSET_A,
        }),
        t({
            direction: 'sell', baseAmount: amount, quoteAmount: amount * grossSellPrice,
            price: grossSellPrice, sequence: 2, orderId: '1.7.2',
            marketFeeReal: sellFee, marketFeeAsset: BTS_ID,
        }),
    ];

    const result = analyzePair(trades, 'fifo');

    assert.strictEqual(result.realizedPnls.length, 1);
    // Net lot = 10 - 0.1 = 9.9, matched = min(10, 9.9) = 9.9
    const netAmount = amount - buyFee;
    const grossPnl = (grossSellPrice - grossBuyPrice) * netAmount;
    assert.strictEqual(result.totalRealizedPnl, grossPnl, 'gross PnL on net lot');

    // Full buy fee realised on full sale; sell fee prorated by net/gross
    const expectedFeeEntry = buyFee * (amount * grossBuyPrice / (amount - buyFee));
    const expectedFeeExit = sellFee * (netAmount / amount);
    const expectedFees = expectedFeeEntry + expectedFeeExit;

    assert.ok(Math.abs(result.totalMarketFees - expectedFees) < 0.001,
        `market fees ≈ ${expectedFees.toFixed(4)}, got ${result.totalMarketFees.toFixed(4)}`);

    const r = result.realizedPnls[0];
    assert.ok(r.marketFeeEntry > 0, 'entry market fee > 0');
    assert.ok(r.marketFeeExit > 0, 'exit market fee > 0');
}

// ─── Test: Zero-fee asset (BTS itself) ───────────────────────────────────

function testZeroFeeAsset() {
    // If the receives asset charges no market fee, fee should be 0
    const trades = [
        t({
            direction: 'buy', baseAmount: 10, quoteAmount: 100,
            price: 10, sequence: 1, orderId: '1.7.1',
            marketFeeReal: 0, marketFeeAsset: BTS_ID,
        }),
        t({
            direction: 'sell', baseAmount: 10, quoteAmount: 110,
            price: 11, sequence: 2, orderId: '1.7.2',
            marketFeeReal: 0, marketFeeAsset: BTS_ID,
        }),
    ];

    const result = analyzePair(trades, 'fifo');
    assert.strictEqual(result.totalMarketFees, 0, 'no market fees for zero-fee asset');
}

// ─── Test: Partial fill with market fees ──────────────────────────────────

function testPartialFillWithFees() {
    // Buy 10 @ 10, fee=0.1 (1% on base)
    // Sell 5 @ 11, fee=0 (no sell fee)
    const trades = [
        t({
            direction: 'buy', baseAmount: 10, quoteAmount: 100,
            price: 10, sequence: 1, orderId: '1.7.1',
            marketFeeReal: 0.1, marketFeeAsset: ASSET_A,
        }),
        t({
            direction: 'sell', baseAmount: 5, quoteAmount: 55,
            price: 11, sequence: 2, orderId: '1.7.2',
            marketFeeReal: 0,
        }),
    ];

    const result = analyzePair(trades, 'fifo');

    assert.strictEqual(result.realizedPnls.length, 1, 'one matched lot');
    assert.strictEqual(result.realizedPnls[0].amount, 5, 'matched 5 units');
    // marketFeeEntry = feeInQuote_total × (5 / 9.9 net lot)
    const expectedEntryFee = (0.1 * (100 / 9.9)) * (5 / 9.9);
    assert.ok(Math.abs(result.realizedPnls[0].marketFeeEntry - expectedEntryFee) < 0.001,
        `proportional entry fee ≈ ${expectedEntryFee.toFixed(6)}, got ${result.realizedPnls[0].marketFeeEntry.toFixed(6)}`);
    assert.strictEqual(result.realizedPnls[0].marketFeeExit, 0, 'no exit fee');
    assert.strictEqual(result.unmatchedSellBase, 0, 'no unmatched');
    assert.strictEqual(result.netPosition, 4.9, '4.9 units remaining (net of buy fee)');
}

// ─── Test: Multiple fills with fees (FIFO vs Sequential) ──────────────────

function testMultipleFillsFifo() {
    // Buy 5 @ 10 (no fee)
    // Buy 5 @ 10.5, fee=0.05 (1% on base)
    // Sell 8 @ 11 (no fee) — FIFO should consume first lot first
    const trades = [
        t({
            direction: 'buy', baseAmount: 5, quoteAmount: 50,
            price: 10, sequence: 1, orderId: '1.7.1',
            marketFeeReal: 0,
        }),
        t({
            direction: 'buy', baseAmount: 5, quoteAmount: 52.5,
            price: 10.5, sequence: 2, orderId: '1.7.2',
            marketFeeReal: 0.05, marketFeeAsset: ASSET_A,
        }),
        t({
            direction: 'sell', baseAmount: 8, quoteAmount: 88,
            price: 11, sequence: 3, orderId: '1.7.3',
            marketFeeReal: 0,
        }),
    ];

    const resultFifo = analyzePair(trades, 'fifo');
    assert.strictEqual(resultFifo.realizedPnls.length, 2, 'FIFO: 2 matched lots');

    // Lot 1: entry price=10 (no fee), amount=5, PnL = (11-10)*5 = 5
    assert.strictEqual(resultFifo.realizedPnls[0].buyPrice, 10);
    assert.strictEqual(resultFifo.realizedPnls[0].amount, 5);
    assert.strictEqual(resultFifo.realizedPnls[0].marketFeeEntry, 0);

    // Lot 2: gross entry price = 10.5, effective = 52.5 / (5 - 0.05) = 10.606060...
    assert.strictEqual(resultFifo.realizedPnls[1].amount, 3);
    assert.strictEqual(resultFifo.realizedPnls[1].buyPrice, 10.5,
        'lot 2 gross buy price = 10.5');
    // Gross PnL = (11 - 10.5) * 3 = 1.5
    assert.strictEqual(resultFifo.realizedPnls[1].pnl, 1.5,
        'lot 2 gross PnL = 1.5');
    // Market fee entry = 0.05 * (52.5/4.95) * (3/4.95) — denominator is net lot
    const feeEntry2 = 0.05 * (52.5 / (5 - 0.05)) * (3 / (5 - 0.05));
    assert.ok(Math.abs(resultFifo.realizedPnls[1].marketFeeEntry - feeEntry2) < 0.001,
        `lot 2 entry fee ≈ ${feeEntry2.toFixed(6)}, got ${resultFifo.realizedPnls[1].marketFeeEntry.toFixed(6)}`);
    // Net PnL = grossPnl - marketFeeEntry - blockchainFee
    // Blockchain fee: entry uses matched amount (3/3), exit uses matched total (3/8)
    const blkFeeLot2 = 0.09652 * (3 / 3) + 0.09652 * (3 / 8);
    const netPnlLot2 = 1.5 - feeEntry2 - blkFeeLot2;
    assert.ok(Math.abs(resultFifo.realizedPnls[1].pnlNet - netPnlLot2) < 0.001,
        `lot 2 net PnL ≈ ${netPnlLot2.toFixed(6)}, got ${resultFifo.realizedPnls[1].pnlNet.toFixed(6)}`);
    assert.strictEqual(resultFifo.realizedPnls[1].marketFeeExit, 0, 'lot 2 exit fee = 0');
}

// ─── Test: Maker/taker fee distinction ────────────────────────────────────

function testMakerTakerFee() {
    // The fee model uses is_maker to determine fee percentage.
    // The script stores isMaker on the TradeFill but analyzePair
    // treats all fees symmetrically (the fee amount from the chain
    // already reflects the maker/taker percentage).
    //
    // This test verifies that the fee amount from the chain is used
    // directly — maker/taker distinction is already baked in.
    const trades = [
        t({
            direction: 'buy', baseAmount: 10, quoteAmount: 100,
            price: 10, sequence: 1, orderId: '1.7.1',
            isMaker: true,   // maker → lower fee
            marketFeeReal: 0.05, // 0.5% maker fee
            marketFeeAsset: ASSET_A,
        }),
        t({
            direction: 'sell', baseAmount: 10, quoteAmount: 110,
            price: 11, sequence: 2, orderId: '1.7.2',
            isMaker: false,  // taker → higher fee
            marketFeeReal: 2.2, // 2% taker fee
            marketFeeAsset: BTS_ID,
        }),
    ];

    const result = analyzePair(trades, 'fifo');

    // Lot = 10 - 0.05 = 9.95, matched = 9.95
    // Full buy fee realised on full sale
    const expectedFeeEntry = 0.05 * (100 / 9.95);
    const expectedFeeExit = 2.2 * (9.95 / 10);
    const expectedFees = expectedFeeEntry + expectedFeeExit;

    assert.ok(Math.abs(result.totalMarketFees - expectedFees) < 0.01,
        `maker/taker fees ≈ ${expectedFees.toFixed(4)}, got ${result.totalMarketFees.toFixed(4)}`);
}

// ─── Test: no-fee sell fills don't break marketFeeExit calc ────────────────

function testSellWithoutFee() {
    const trades = [
        t({
            direction: 'buy', baseAmount: 5, quoteAmount: 50,
            price: 10, sequence: 1, orderId: '1.7.1',
            marketFeeReal: 0.05, marketFeeAsset: ASSET_A,
        }),
        t({
            direction: 'sell', baseAmount: 5, quoteAmount: 55,
            price: 11, sequence: 2, orderId: '1.7.2',
            marketFeeReal: 0, marketFeeAsset: BTS_ID,
        }),
    ];

    const result = analyzePair(trades, 'fifo');
    assert.strictEqual(result.realizedPnls[0].marketFeeExit, 0,
        'no market fee on exit when sell fee is 0');
    assert.ok(result.realizedPnls[0].marketFeeEntry > 0,
        'entry market fee present');
}

// ─── Drawdown stability (hadStablePeak) ─────────────────────────────────

function testDrawdownStablePeakMonotonic() {
    // 12 all-winning trades → monotonically rising equity,
    // hadStablePeak must be true after 10-trade backstop
    const trades = [];
    for (let i = 0; i < 12; i++) {
        const base = i % 2 === 0 ? 10 : 11;
        trades.push(t({
            direction: 'buy', baseAmount: base, quoteAmount: base * 10,
            price: 10, sequence: i * 2 + 1, orderId: `1.7.${i * 2 + 1}`,
            marketFeeReal: 0,
        }));
        trades.push(t({
            direction: 'sell', baseAmount: base, quoteAmount: base * 11,
            price: 11, sequence: i * 2 + 2, orderId: `1.7.${i * 2 + 2}`,
            marketFeeReal: 0,
        }));
    }
    const pair = analyzePair(trades, 'fifo');
    const m = computeMetrics(pair);
    assert.strictEqual(m.mddHadStablePeak, true,
        `monotonic 12 trades: hadStablePeak should be true, got ${m.mddHadStablePeak}`);
    assert.ok(m.mddPct >= 0,
        `monotonic 12 trades: mddPct should be ≥ 0 (no drawdown), got ${m.mddPct}`);
    assert.strictEqual(m.mddAbsBts, 0,
        `monotonic 12 trades: absolute drawdown should be 0, got ${m.mddAbsBts}`);
}

function testDrawdownStablePeakEarly() {
    // 6 all-winning trades → fewer than MIN_TRADES_FOR_PEAK (10),
    // hadStablePeak should be false, mddPct should be absolute min equity
    const trades = [];
    for (let i = 0; i < 6; i++) {
        const base = i % 2 === 0 ? 10 : 11;
        trades.push(t({
            direction: 'buy', baseAmount: base, quoteAmount: base * 10,
            price: 10, sequence: i * 2 + 1, orderId: `1.7.${i * 2 + 1}`,
            marketFeeReal: 0,
        }));
        trades.push(t({
            direction: 'sell', baseAmount: base, quoteAmount: base * 11,
            price: 11, sequence: i * 2 + 2, orderId: `1.7.${i * 2 + 2}`,
            marketFeeReal: 0,
        }));
    }
    const pair = analyzePair(trades, 'fifo');
    const m = computeMetrics(pair);
    assert.strictEqual(m.mddHadStablePeak, false,
        `early 6 trades: hadStablePeak should be false, got ${m.mddHadStablePeak}`);
    // Min equity should be positive (equity after first profitable trade)
    assert.ok(m.mddPct > 0,
        `early 6 trades: mddPct (absolute min equity) should be > 0, got ${m.mddPct}`);
}

// ─── Window-aware annualisation ───────────────────────────────────────────

/** A winning round-trip (buy @ buyPrice, sell @ sellPrice) timestamped alike. */
function roundTrip(seq: number, timeIso: string, buyPrice: number, sellPrice: number, amount: number) {
    return [
        t({
            direction: 'buy', baseAmount: amount, quoteAmount: amount * buyPrice,
            price: buyPrice, sequence: seq, orderId: `1.7.${seq}`,
            isMaker: true, marketFeeReal: 0, time: timeIso,
        }),
        t({
            direction: 'sell', baseAmount: amount, quoteAmount: amount * sellPrice,
            price: sellPrice, sequence: seq + 1, orderId: `1.7.${seq + 1}`,
            isMaker: true, marketFeeReal: 0, time: timeIso,
        }),
    ];
}

function testWindowAnnualisationDailyBins() {
    // Three winning round-trips on day 1, queried over a 10-day window.
    const trades: any[] = [];
    for (let i = 0; i < 3; i++) {
        trades.push(...roundTrip(i * 2 + 1, `2025-01-01T0${i + 1}:00:00Z`, 10, 11, 10));
    }
    const pair = analyzePair(trades, 'fifo');
    const startMs = Date.parse('2025-01-01T00:00:00Z');
    const endMs = Date.parse('2025-01-11T00:00:00Z'); // exactly 10 days
    const m = computeMetrics(pair, { startMs, endMs });

    assert.strictEqual(m.periodLabel, '1d', '10-day window should bin daily');
    assert.strictEqual(m.periodCount, 10, 'window must be zero-filled to 10 daily periods');
    assert.strictEqual(m.periodSpanDays, 10, 'window span is 10 days');
    assert.ok(Math.abs(m.annualFactor - Math.sqrt(365)) < 1e-9, 'daily annualisation factor');
    assert.ok(Number.isFinite(m.sharpeAnn), 'Sharpe should be finite');
    assert.ok(Number.isFinite(m.sharpeAnnSE), 'Sharpe standard error should be reported');

    // Flat days are included, so the mean must be diluted by the 9 empty days.
    assert.ok(Number.isFinite(m.projectedNetPnlPerDay), 'per-day projection finite');
    const expectedAnn = pair.totalRealizedPnlNet / 10 * 365;
    assert.ok(Math.abs(m.projectedNetPnlAnn - expectedAnn) < 1e-6,
        `annual projection = window net PnL / 10d * 365, got ${m.projectedNetPnlAnn}`);

    // Exact scaling identity: all PnL sits in period 0 with 9 zero-filled
    // periods, so sharpeAnn must equal per-period Sharpe × √365. Guards the
    // annualisation constant and the zero-fill from drifting.
    const net = pair.totalRealizedPnlNet;
    const meanE = net / 10;
    const stdE = Math.sqrt((9 * meanE * meanE + (net - meanE) ** 2) / 9);
    const expectedSharpe = (meanE / stdE) * Math.sqrt(365);
    assert.ok(Math.abs(m.sharpeAnn - expectedSharpe) < 1e-9,
        `sharpeAnn = per-period Sharpe × √365, expected ${expectedSharpe}, got ${m.sharpeAnn}`);

    // No losing periods: Sortino must be ∞ (undefined), never 0.
    assert.strictEqual(m.sortinoAnn, Infinity,
        `no losing periods should give Sortino = Infinity, got ${m.sortinoAnn}`);
}

function testPartialPeriodDropped() {
    const trades = roundTrip(1, '2025-01-01T01:00:00Z', 10, 11, 10);
    const pair = analyzePair(trades, 'fifo');
    const startMs = Date.parse('2025-01-01T00:00:00Z');
    const endMs = startMs + 100 * 3600_000; // 100h → 4 complete daily periods
    const m = computeMetrics(pair, { startMs, endMs });
    assert.strictEqual(m.periodLabel, '1d', '100h window should still bin daily');
    assert.strictEqual(m.periodCount, 4, 'only the 4 complete days are scored');

    // Projection must share the bins' whole-period basis: scored span is 4
    // whole days, not the queried 4.1667d, so a trailing-day fill can never
    // inflate the projection while being absent from Sharpe/Sortino.
    assert.ok(Math.abs(m.scoredSpanDays - 4) < 1e-9,
        `scored span should be 4 whole days, got ${m.scoredSpanDays}`);
    const expectedAnn = pair.totalRealizedPnlNet / 4 * 365;
    assert.ok(Math.abs(m.projectedNetPnlAnn - expectedAnn) < 1e-6,
        `projection over scored days, expected ${expectedAnn}, got ${m.projectedNetPnlAnn}`);
    // Activity shares the same basis: 1 scored lot over 4 whole days.
    assert.ok(Math.abs(m.fillsPerDay - 0.25) < 1e-9,
        `fills/day uses scored span, expected 0.25, got ${m.fillsPerDay}`);
}

function testScoredActivityExcludesTail() {
    // One round-trip inside the scored window (day 1) and one in the trailing
    // partial period (97h in). Every window-derived metric must ignore the
    // tail lot — ratios, projection AND activity rates alike.
    const trades = [
        ...roundTrip(1, '2025-01-01T01:00:00Z', 10, 11, 10),
        ...roundTrip(3, '2025-01-05T01:00:00Z', 10, 12, 10),
    ];
    const pair = analyzePair(trades, 'fifo');
    const startMs = Date.parse('2025-01-01T00:00:00Z');
    const endMs = startMs + 100 * 3600_000; // 4 whole days scored of 4.1667d
    const m = computeMetrics(pair, { startMs, endMs });

    assert.ok(Math.abs(m.scoredSpanDays - 4) < 1e-9, '4 whole days scored');
    // 1 scored lot over 4 scored days — NOT 2 lots over 4 days.
    assert.ok(Math.abs(m.fillsPerDay - 0.25) < 1e-9,
        `activity must exclude the tail lot, expected 0.25 fills/day, got ${m.fillsPerDay}`);
    // Only lot 1's buy+sell quote (100 + 110) is scored → 210 / 4 = 52.5.
    assert.ok(Math.abs(m.avgVolumePerDay - 52.5) < 1e-9,
        `volume must exclude the tail lot, expected 52.5/day, got ${m.avgVolumePerDay}`);
    // Projection likewise excludes the tail lot's PnL.
    const scoredNet = pair.realizedPnls
        .filter(r => Date.parse(r.exitTime) < startMs + 4 * 86400000)
        .reduce((s, r) => s + r.pnlNet, 0);
    assert.ok(Math.abs(m.projectedNetPnlAnn - scoredNet / 4 * 365) < 1e-6,
        `projection uses scored lots only, got ${m.projectedNetPnlAnn}`);
}

function testBoundaryTradeFoldedIntoLastPeriod() {
    // A round-trip exiting exactly at the window end must count toward the
    // last period when the window is an exact bin multiple (ES query is
    // inclusive of `lte`) — not silently vanish from every window metric.
    const trades = roundTrip(1, '2025-01-11T00:00:00Z', 10, 11, 10);
    const pair = analyzePair(trades, 'fifo');
    const startMs = Date.parse('2025-01-01T00:00:00Z');
    const endMs = Date.parse('2025-01-11T00:00:00Z'); // exactly 10 days
    const m = computeMetrics(pair, { startMs, endMs });
    assert.strictEqual(m.periodCount, 10, 'boundary trade must not extend the window');
    assert.ok(Number.isFinite(m.sharpeAnn), 'boundary trade must be binned (finite Sharpe)');
    assert.strictEqual(m.sortinoAnn, Infinity,
        'boundary trade must be binned (winning window → Sortino ∞)');
    const expectedAnn = pair.totalRealizedPnlNet / 10 * 365;
    assert.ok(Math.abs(m.projectedNetPnlAnn - expectedAnn) < 1e-6,
        `boundary trade must feed the projection, expected ${expectedAnn}, got ${m.projectedNetPnlAnn}`);
}

function testUnparseableTimeFillsExcludedEverywhere() {
    // A fill whose timestamp fails to parse has no calendar period, so it is
    // excluded from every window-derived metric — ratios, projection and
    // activity rates alike — keeping one consistent scored basis.
    const trades = [
        ...roundTrip(1, '2025-01-01T01:00:00Z', 10, 11, 10),
        ...roundTrip(3, 'not-a-date', 10, 12, 10),
    ];
    const pair = analyzePair(trades, 'fifo');
    const startMs = Date.parse('2025-01-01T00:00:00Z');
    const endMs = Date.parse('2025-01-11T00:00:00Z'); // exactly 10 days
    const m = computeMetrics(pair, { startMs, endMs });

    // Only the parseable lot counts: 1 / 10 scored days.
    assert.ok(Math.abs(m.fillsPerDay - 0.1) < 1e-9,
        `unparseable-time lot must be excluded, expected 0.1 fills/day, got ${m.fillsPerDay}`);
    // Only the parseable lot's notional: (100 + 110) / 10 = 21.
    assert.ok(Math.abs(m.avgVolumePerDay - 21) < 1e-9,
        `unparseable-time notional must be excluded, expected 21/day, got ${m.avgVolumePerDay}`);
    // Projection uses the same strict basis.
    const scoredNet = pair.realizedPnls
        .filter(r => {
            const t = Date.parse(r.exitTime);
            return Number.isFinite(t) && t >= startMs && t < startMs + 10 * 86400000;
        })
        .reduce((s, r) => s + r.pnlNet, 0);
    assert.ok(Math.abs(m.projectedNetPnlAnn - scoredNet / 10 * 365) < 1e-6,
        `projection must exclude the unbinable lot, got ${m.projectedNetPnlAnn}`);
    assert.ok(Number.isFinite(m.sharpeAnn), 'Sharpe unaffected by the unbinable lot');
}

function testWindowAnnualisationHourlyBins() {
    const trades: any[] = [];
    for (let i = 0; i < 3; i++) {
        trades.push(...roundTrip(i * 2 + 1, `2025-01-01T0${i + 1}:00:00Z`, 10, 11, 10));
    }
    const pair = analyzePair(trades, 'fifo');
    const startMs = Date.parse('2025-01-01T00:00:00Z');
    const endMs = Date.parse('2025-01-01T06:00:00Z'); // 6 hours
    const m = computeMetrics(pair, { startMs, endMs });

    assert.strictEqual(m.periodLabel, '1h', 'short window should bin hourly');
    assert.strictEqual(m.periodCount, 6, '6h window = 6 hourly periods');
    assert.ok(Math.abs(m.annualFactor - Math.sqrt(8760)) < 1e-9, 'hourly annualisation factor');
}

function testSinglePeriodHasNoSharpe() {
    const trades = roundTrip(1, '2025-01-01T01:00:00Z', 10, 11, 10);
    const pair = analyzePair(trades, 'fifo');
    const m = computeMetrics(pair, {
        startMs: Date.parse('2025-01-01T00:00:00Z'),
        endMs: Date.parse('2025-01-01T01:00:00Z'),
    });
    assert.strictEqual(m.periodCount, 1, 'one hourly period in a 1h window');
    assert.ok(Number.isNaN(m.sharpeAnn), 'single period has no dispersion → NaN Sharpe');
    assert.ok(Number.isNaN(m.sharpeAnnSE), 'NaN standard error with a single period');
    assert.ok(Number.isNaN(m.sortinoAnn), 'single period → NaN Sortino (nothing to estimate)');
}

// ─── Main ─────────────────────────────────────────────────────────────────

function main() {
    testNoMarketFees();
    testBuySideMarketFee();
    testSellSideMarketFee();
    testBothSidesMarketFees();
    testZeroFeeAsset();
    testPartialFillWithFees();
    testMultipleFillsFifo();
    testMakerTakerFee();
    testSellWithoutFee();
    testDrawdownStablePeakMonotonic();
    testDrawdownStablePeakEarly();
    testWindowAnnualisationDailyBins();
    testWindowAnnualisationHourlyBins();
    testPartialPeriodDropped();
    testScoredActivityExcludesTail();
    testBoundaryTradeFoldedIntoLastPeriod();
    testUnparseableTimeFillsExcludedEverywhere();
    testSinglePeriodHasNoSharpe();
    console.log('✓ trade profitability fee tests passed');
}

main();
