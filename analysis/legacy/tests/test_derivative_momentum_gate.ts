const assert = require('assert');

const { DerivativeAnalyzer } = require('../derivative_analyzer');

function createAnalyzer() {
    return new DerivativeAnalyzer({
        slowSmaPeriod: 500,
        fastSmaPeriod: 100,
        macdFastPeriod: 48,
        macdSlowPeriod: 104,
        macdSignalPeriod: 36,
        macdMinHist: 0.02,
        rsiPeriod: 96,
        rsiOverboughtLevel: 90,
        rsiOversoldLevel: 10,
        rsiBullThreshold: 60,
        rsiBearThreshold: 40,
        trendFilterEnabled: true,
        trendFilterMinBars: 3,
        momentumGateEnabled: true,
        momentumGateMinBars: 3,
        momentumGateRsiZone: 35,
        priceRegimeGateEnabled: false,
    });
}

function seedUptrendReversal(analyzer) {
    analyzer.prevSma = 100;
    analyzer.currSma = 101;
    analyzer.prevFastSma = 110;
    analyzer.currFastSma = 111;
    analyzer.prevRawSmaTrend = 'UP';
    analyzer.barsInSmaTrend = 3;
    analyzer.prevRawFastSmaTrend = 'UP';
    analyzer.barsInFastSmaTrend = 3;
    analyzer.currMacd = { macd: -0.08, signal: -0.03, histogram: -0.05 };
    analyzer.currRsi = 30;
}

function testMomentumGateRestoresSuppressedBear() {
    const analyzer = createAnalyzer();
    seedUptrendReversal(analyzer);
    analyzer.barsInMacdDivergence = 3;
    analyzer.barsInRsiDivergence = 3;

    assert.strictEqual(
        analyzer._applyTrendFilter('BEAR'),
        'BEAR_WEAK',
        'momentum gate should restore a trend-filter-suppressed BEAR as BEAR_WEAK'
    );
}

function testMomentumGateStaysNeutralWithoutConfirmedDivergence() {
    const analyzer = createAnalyzer();
    seedUptrendReversal(analyzer);
    analyzer.barsInMacdDivergence = 2;
    analyzer.barsInRsiDivergence = 3;

    assert.strictEqual(
        analyzer._applyTrendFilter('BEAR'),
        'NEUTRAL',
        'suppressed BEAR should stay NEUTRAL until both divergence counters are confirmed'
    );
}

function main() {
    console.log('Running test: derivative momentum gate');
    testMomentumGateRestoresSuppressedBear();
    testMomentumGateStaysNeutralWithoutConfirmedDivergence();
    console.log('✓ derivative momentum gate PASSED');
}

main();
