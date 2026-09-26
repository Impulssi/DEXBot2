const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { DerivativeAnalyzer } = require('../derivative_analyzer');
const { createSource } = require('../../price_sources');

function createAnalyzer() {
    return new DerivativeAnalyzer({
        slowSmaPeriod: 500,
        macdFastPeriod: 48,
        macdSlowPeriod: 104,
        macdSignalPeriod: 36,
        macdMinHist: 0.02,
        rsiPeriod: 96,
        rsiOverboughtLevel: 90,
        rsiOversoldLevel: 10,
        rsiBullThreshold: 60,
        rsiBearThreshold: 40,
        interpConfirmBars: 3,
        interpHoldBars: 3,
        trendFilterEnabled: true,
        trendFilterMinBars: 3,
        momentumGateEnabled: true,
        momentumGateMinBars: 3,
        priceRegimeGateEnabled: true,
    });
}

async function testHistoricalBullTrapExit() {
    const dataPath = path.join(__dirname, '..', '..', '..', 'market_adapter', 'data', 'lp', 'iob_xrp_bts', 'lp_pool_133_1h.json');
    if (!fs.existsSync(dataPath)) {
        console.log('  SKIP: historical data file not found (gitignored; not available in CI/clean checkout)');
        console.log(`  expected at: ${dataPath}`);
        return;
    }
    const source = createSource('json', {
        filePath: dataPath,
    });
    const candles = await source.fetchCandles();
    const analyzer = createAnalyzer();
    const bars = new Map();

    for (let i = 0; i < candles.length; i++) {
        const { marketPrice, timestamp } = source.extractMarketPrice(candles[i]);
        const result = analyzer.update(marketPrice, timestamp);
        if (i >= 2767 && i <= 2772) {
            bars.set(i, {
                interpretation: result.interpretation,
                interpretationRaw: result.interpretationRaw,
                timestamp,
            });
        }
    }

    assert.strictEqual(bars.get(2767).interpretation, 'NEUTRAL', 'shallow bull cross should not confirm');
    assert.strictEqual(bars.get(2768).interpretation, 'NEUTRAL', 'shallow bull cross should remain filtered');
    assert.strictEqual(bars.get(2769).interpretation, 'NEUTRAL', 'late shallow bull cross should remain filtered');
    assert.strictEqual(bars.get(2770).interpretationRaw, 'NEUTRAL', 'dump bar should invalidate the raw BULL signal');
    assert.strictEqual(bars.get(2770).interpretation, 'NEUTRAL', 'dump bar should exit directly to NEUTRAL');
}

function testHardInvalidationBypassesHold() {
    const bullAnalyzer = createAnalyzer();
    bullAnalyzer.currInterpretation = 'BULL';
    bullAnalyzer.currMacd = { macd: 0.08, signal: 0.01, histogram: 0.07 };
    bullAnalyzer.currPrice = 99;
    bullAnalyzer.currSma = 100;
    bullAnalyzer._applyWithHysteresis('NEUTRAL');
    assert.strictEqual(bullAnalyzer.currInterpretation, 'NEUTRAL', 'price regime invalidation should bypass BULL hold');

    const bearAnalyzer = createAnalyzer();
    bearAnalyzer.currInterpretation = 'BEAR';
    bearAnalyzer.currMacd = { macd: -0.08, signal: -0.01, histogram: -0.07 };
    bearAnalyzer.currPrice = 101;
    bearAnalyzer.currSma = 100;
    bearAnalyzer._applyWithHysteresis('NEUTRAL');
    assert.strictEqual(bearAnalyzer.currInterpretation, 'NEUTRAL', 'price regime invalidation should bypass BEAR hold');
}

function testMacroDisagreeBypassesBullHold() {
    const analyzer = new DerivativeAnalyzer({
        slowSmaPeriod: 500,
        fastSmaPeriod: 100,
        macdFastPeriod: 48,
        macdSlowPeriod: 104,
        macdSignalPeriod: 36,
        macdMinHist: 0.02,
        interpHoldBars: 3,
        trendFilterEnabled: true,
        trendFilterMinBars: 3,
        priceRegimeGateEnabled: true,
    });

    analyzer.currInterpretation = 'BULL';
    analyzer.currMacd = { macd: 0.3, signal: 0.2, histogram: 0.1 };
    analyzer.currPrice = 105;
    analyzer.currSma = 100;
    analyzer.prevSma = 99;
    analyzer.currFastSma = 101;
    analyzer.prevFastSma = 102;
    analyzer.prevRawSmaTrend = 'UP';
    analyzer.barsInSmaTrend = 3;

    analyzer._applyWithHysteresis('BULL_WEAK');
    assert.strictEqual(analyzer.currInterpretation, 'BULL_WEAK', 'macro disagree invalidation should bypass BULL hold');
}

async function main() {
    console.log('Running test: derivative signal trap regression');
    await testHistoricalBullTrapExit();
    testHardInvalidationBypassesHold();
    testMacroDisagreeBypassesBullHold();
    console.log('✓ derivative signal trap regression PASSED');
}

main().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
