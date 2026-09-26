const assert = require('assert');

const { DerivativeAnalyzer } = require('../derivative_analyzer');

function createAnalyzer() {
    return new DerivativeAnalyzer({
        slowSmaPeriod: 500,
        fastSmaPeriod: 100,
        macdFastPeriod: 48,
        macdSlowPeriod: 104,
        macdSignalPeriod: 36,
        interpConfirmBars: 3,
        interpHoldBars: 3,
        trendFilterEnabled: true,
        trendFilterMinBars: 3,
        priceRegimeGateEnabled: true,
    });
}

function advanceEntryBias(analyzer, prevInterpretation, currInterpretation) {
    analyzer._resetEntryBias();
    analyzer.currInterpretation = currInterpretation;

    // Set SMAs so trend alignment matches the current interpretation
    const isBullish = currInterpretation === 'BULL' || currInterpretation === 'BULL_WEAK';
    const isBearish = currInterpretation === 'BEAR' || currInterpretation === 'BEAR_WEAK';

    if (isBullish) {
        analyzer.sma = { values: [1, 2] };
        analyzer.prevSma = 1;
        analyzer.currSma = 2;
        analyzer.fastSma = { values: [1, 2] };
        analyzer.prevFastSma = 1;
        analyzer.currFastSma = 2;
    } else if (isBearish) {
        analyzer.sma = { values: [2, 1] };
        analyzer.prevSma = 2;
        analyzer.currSma = 1;
        analyzer.fastSma = { values: [2, 1] };
        analyzer.prevFastSma = 2;
        analyzer.currFastSma = 1;
    } else {
        // NEUTRAL
        analyzer.sma = { values: [1, 1] };
        analyzer.prevSma = 1;
        analyzer.currSma = 1;
        analyzer.fastSma = { values: [1, 1] };
        analyzer.prevFastSma = 1;
        analyzer.currFastSma = 1;
    }

    analyzer._advanceEntryBias(prevInterpretation);
}

function testBullWeakStartsEarlyLongSetup() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BULL_WEAK');

    assert.strictEqual(analyzer.entryBias, 'EARLY_LONG');
    assert.strictEqual(analyzer.isBullWeakEntry, true);
    assert.strictEqual(analyzer.isBullConfirmation, false);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, false);
    assert.strictEqual(analyzer.isBearConfirmation, false);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
    assert.strictEqual(analyzer.bullEntrySetupActive, true);
    assert.strictEqual(analyzer.bullEntrySetupConfirmed, false);
}

function testBullConfirmsExistingWeakSetup() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BULL_WEAK');
    advanceEntryBias(analyzer, 'BULL_WEAK', 'BULL');

    assert.strictEqual(analyzer.entryBias, 'CONFIRM_LONG');
    assert.strictEqual(analyzer.isBullWeakEntry, false);
    assert.strictEqual(analyzer.isBullConfirmation, true);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, false);
    assert.strictEqual(analyzer.isBearConfirmation, false);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
    assert.strictEqual(analyzer.bullEntrySetupActive, true);
    assert.strictEqual(analyzer.bullEntrySetupConfirmed, true);
}

function testDirectBullWithoutWeakSetup() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BULL');

    // Without a prior BULL_WEAK setup, direct BULL does not produce an entry bias
    assert.strictEqual(analyzer.entryBias, 'NONE');
    assert.strictEqual(analyzer.isBullWeakEntry, false);
    assert.strictEqual(analyzer.isBullConfirmation, false);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, false);
    assert.strictEqual(analyzer.isBearConfirmation, false);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
}

function testBullishSetupClearsOnNeutral() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BULL_WEAK');
    advanceEntryBias(analyzer, 'BULL_WEAK', 'NEUTRAL');

    assert.strictEqual(analyzer.entryBias, 'NONE');
    assert.strictEqual(analyzer.isBullWeakEntry, false);
    assert.strictEqual(analyzer.isBullConfirmation, false);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, false);
    assert.strictEqual(analyzer.isBearConfirmation, false);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
    assert.strictEqual(analyzer.bullEntrySetupActive, false);
    assert.strictEqual(analyzer.bullEntrySetupConfirmed, false);
}

function testBullWeakDoesNotRefireAfterConfirmedBullDowngrade() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BULL_WEAK');
    advanceEntryBias(analyzer, 'BULL_WEAK', 'BULL');
    advanceEntryBias(analyzer, 'BULL', 'BULL_WEAK');

    assert.strictEqual(analyzer.entryBias, 'NONE');
    assert.strictEqual(analyzer.isBullWeakEntry, false);
    assert.strictEqual(analyzer.isBullConfirmation, false);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, false);
    assert.strictEqual(analyzer.isBearConfirmation, false);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
    assert.strictEqual(analyzer.bullEntrySetupActive, true);
    assert.strictEqual(analyzer.bullEntrySetupConfirmed, true);
}

function testBearWeakStartsEarlyShortSetup() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BEAR_WEAK');

    assert.strictEqual(analyzer.entryBias, 'EARLY_SHORT');
    assert.strictEqual(analyzer.isBullWeakEntry, false);
    assert.strictEqual(analyzer.isBullConfirmation, false);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, true);
    assert.strictEqual(analyzer.isBearConfirmation, false);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
    assert.strictEqual(analyzer.bearEntrySetupActive, true);
    assert.strictEqual(analyzer.bearEntrySetupConfirmed, false);
}

function testBearConfirmsExistingWeakSetup() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BEAR_WEAK');
    advanceEntryBias(analyzer, 'BEAR_WEAK', 'BEAR');

    assert.strictEqual(analyzer.entryBias, 'CONFIRM_SHORT');
    assert.strictEqual(analyzer.isBullWeakEntry, false);
    assert.strictEqual(analyzer.isBullConfirmation, false);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, false);
    assert.strictEqual(analyzer.isBearConfirmation, true);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
    assert.strictEqual(analyzer.bearEntrySetupActive, true);
    assert.strictEqual(analyzer.bearEntrySetupConfirmed, true);
}

function testDirectBearWithoutWeakSetup() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BEAR');

    // Without a prior BEAR_WEAK setup, direct BEAR does not produce an entry bias
    assert.strictEqual(analyzer.entryBias, 'NONE');
    assert.strictEqual(analyzer.isBullWeakEntry, false);
    assert.strictEqual(analyzer.isBullConfirmation, false);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, false);
    assert.strictEqual(analyzer.isBearConfirmation, false);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
}

function testBearishSetupClearsOnNeutral() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BEAR_WEAK');
    advanceEntryBias(analyzer, 'BEAR_WEAK', 'NEUTRAL');

    assert.strictEqual(analyzer.entryBias, 'NONE');
    assert.strictEqual(analyzer.isBullWeakEntry, false);
    assert.strictEqual(analyzer.isBullConfirmation, false);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, false);
    assert.strictEqual(analyzer.isBearConfirmation, false);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
    assert.strictEqual(analyzer.bearEntrySetupActive, false);
    assert.strictEqual(analyzer.bearEntrySetupConfirmed, false);
}

function testBearWeakDoesNotRefireAfterConfirmedBearDowngrade() {
    const analyzer = createAnalyzer();
    advanceEntryBias(analyzer, 'NEUTRAL', 'BEAR_WEAK');
    advanceEntryBias(analyzer, 'BEAR_WEAK', 'BEAR');
    advanceEntryBias(analyzer, 'BEAR', 'BEAR_WEAK');

    assert.strictEqual(analyzer.entryBias, 'NONE');
    assert.strictEqual(analyzer.isBullWeakEntry, false);
    assert.strictEqual(analyzer.isBullConfirmation, false);
    assert.strictEqual(analyzer.isLateBullWithoutWeak, false);
    assert.strictEqual(analyzer.isBearWeakEntry, false);
    assert.strictEqual(analyzer.isBearConfirmation, false);
    assert.strictEqual(analyzer.isLateBearWithoutWeak, false);
    assert.strictEqual(analyzer.bearEntrySetupActive, true);
    assert.strictEqual(analyzer.bearEntrySetupConfirmed, true);
}

function main() {
    console.log('Running test: derivative entry bias');
    testBullWeakStartsEarlyLongSetup();
    testBullConfirmsExistingWeakSetup();
    testDirectBullWithoutWeakSetup();
    testBullishSetupClearsOnNeutral();
    testBullWeakDoesNotRefireAfterConfirmedBullDowngrade();
    testBearWeakStartsEarlyShortSetup();
    testBearConfirmsExistingWeakSetup();
    testDirectBearWithoutWeakSetup();
    testBearishSetupClearsOnNeutral();
    testBearWeakDoesNotRefireAfterConfirmedBearDowngrade();
    console.log('✓ derivative entry bias PASSED');
}

main();
