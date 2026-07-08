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

function t(overrides = {}) {
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
const { analyzePair } = require('../analysis/trade_profitability');

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
    // Gross PnL = (11 - 10) * 10 = 10 (using gross prices)
    assert.strictEqual(result.totalRealizedPnl, 10, 'gross PnL = 10');

    // Effective buy price = 100 / (10 - 0.1) = 100 / 9.9 ≈ 10.10101
    // Market-fee-adjusted PnL = (11 - 10.10101) * 10 ≈ 8.9899
    // marketFeeDrag = 10 - 8.9899 = 1.0101
    const expectedMarketFee = 10 - (11 - 100 / 9.9) * 10;
    assert.ok(Math.abs(result.totalMarketFees - expectedMarketFee) < 0.001,
        `market fee drag ≈ ${expectedMarketFee.toFixed(4)}, got ${result.totalMarketFees.toFixed(4)}`);

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
    // Gross PnL
    const grossPnl = (grossSellPrice - grossBuyPrice) * amount;
    assert.strictEqual(result.totalRealizedPnl, grossPnl, 'gross PnL');

    // Effective buy price = 100 / (10 - 0.1) = 100 / 9.9 ≈ 10.101010...
    const effBuy = (amount * grossBuyPrice) / (amount - buyFee);
    // Effective sell price = (110 - 1.1) / 10 = 10.89
    const effSell = (amount * grossSellPrice - sellFee) / amount;
    // Adjusted PnL = (10.89 - 10.10101) * 10 = 7.89899...
    const adjPnl = (effSell - effBuy) * amount;
    // Market fee drag = grossPnl - adjPnl
    const expectedFees = grossPnl - adjPnl;

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
    // marketFeeEntry should be proportional: feeBaseShare = 0.1 * (5/10) = 0.05
    // feeInQuote = 0.05 * (100 / 9.9) ≈ 0.50505...
    const expectedEntryFee = 0.05 * (100 / 9.9);
    assert.ok(Math.abs(result.realizedPnls[0].marketFeeEntry - expectedEntryFee) < 0.001,
        `proportional entry fee ≈ ${expectedEntryFee.toFixed(6)}, got ${result.realizedPnls[0].marketFeeEntry.toFixed(6)}`);
    assert.strictEqual(result.realizedPnls[0].marketFeeExit, 0, 'no exit fee');
    assert.strictEqual(result.unmatchedSellBase, 0, 'no unmatched');
    assert.strictEqual(result.netPosition, 5, '5 units remaining in inventory');
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
    const effBuy2 = 52.5 / (5 - 0.05);
    assert.strictEqual(resultFifo.realizedPnls[1].amount, 3);
    assert.strictEqual(resultFifo.realizedPnls[1].buyPrice, 10.5,
        'lot 2 gross buy price = 10.5');
    // Gross PnL = (11 - 10.5) * 3 = 1.5
    assert.strictEqual(resultFifo.realizedPnls[1].pnl, 1.5,
        'lot 2 gross PnL = 1.5');
    // Market fee entry = 0.05 * (3/5) * (52.5 / 4.95) ≈ 0.31818
    const feeEntry2 = 0.05 * (3 / 5) * effBuy2;
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

    // Maker fee on buy: 0.05 base → effective buy price = 100 / (10-0.05)
    const effBuy = 100 / (10 - 0.05);
    // Taker fee on sell: 2.2 BTS → effective sell price = (110-2.2)/10 = 10.78
    const effSell = (110 - 2.2) / 10;
    const adjPnl = (effSell - effBuy) * 10;
    const expectedFees = 10 - adjPnl;

    assert.ok(Math.abs(result.totalMarketFees - expectedFees) < 0.001,
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
    console.log('✓ trade profitability fee tests passed');
}

main();
