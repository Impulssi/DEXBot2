'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { MARKET_ADAPTER } = require('../modules/constants');
const { computeAmaSlopeWeights } = require('../market_adapter/core/strategies/ama_slope_model');
const { calculateATR, computeATRSeries } = require('../market_adapter/core/strategies/atr/calculator');
const { computeVolatilityShift } = require('../market_adapter/core/strategies/volatility_shift');
const { KalmanTrendAnalyzer } = require('../analysis/trend_detection/kalman_trend_analyzer');
const { computeRegimeMultiplier } = require('../market_adapter/core/strategies/regime_gate');
const { generateHTML } = require('../analysis/trend_detection/dynamic_weight_chart_generator');
const { generateHTML: generateVolatilityHTML } = require('../analysis/trend_detection/volatility_chart_generator');

console.log('Running market adapter signal gate tests');

function testAmaSlopeWarmupUsesSlowPeriod() {
    const erPeriod = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].erPeriod;
    const slowPeriod = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].slowPeriod;
    const fastPeriod = MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY].fastPeriod;
    const lookbackBars = MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const minBars = erPeriod + lookbackBars + 1;

    const shortSeries = new Array(minBars - 1).fill(100);
    const shortResult = computeAmaSlopeWeights(shortSeries, 0, {
        erPeriod,
        slowPeriod,
        fastPeriod,
        lookbackBars,
    });
    assert.strictEqual(shortResult.isReady, false, 'AMA slope should not be ready before minBars');

    const readySeries = new Array(minBars).fill(100);
    readySeries[minBars - 1] = 101;
    const readyResult = computeAmaSlopeWeights(readySeries, 0, {
        erPeriod,
        slowPeriod,
        fastPeriod,
        lookbackBars,
    });
    assert.strictEqual(readyResult.isReady, true, 'AMA slope should be ready at minBars');
}

function testAtrRejectsInvalidCandles() {
    const candles = [];
    for (let i = 0; i < 20; i++) {
        candles.push([i + 1, 1, 2 + (i * 0.01), 1, 1 + (i * 0.01), 10]);
    }
    candles[8] = [9, 1, Number.NaN, 1, 1.08, 10];

    const atr = calculateATR(candles, 3);
    assert.ok(Number.isFinite(atr), 'ATR should skip isolated invalid candles instead of disabling volatility');
    assert.ok(atr > 0, 'ATR should remain positive when enough valid candles are present');
}

function testAtrInvalidCandleBreaksTrueRangeChain() {
    const candles = [
        [1, 0, 101, 99, 100, 10],
        [2, 0, 101, 99, 100, 10],
        [3, 0, 101, 99, 100, 10],
        [4, 0, Number.NaN, Number.NaN, Number.NaN, 10],
        [5, 0, 201, 199, 200, 10],
        [6, 0, 201, 199, 200, 10],
        [7, 0, 201, 199, 200, 10],
    ];

    const atr = calculateATR(candles, 2);
    assert.strictEqual(atr, 2, 'ATR should restart after an invalid candle instead of carrying forward a stale close');
}

function testAtrSupportsObjectCandles() {
    const objectCandles = [
        { timestamp: 1, open: 100, high: 102, low: 98, close: 101 },
        { timestamp: 2, open: 101, high: 103, low: 99, close: 102 },
        { timestamp: 3, open: 102, high: 104, low: 100, close: 103 },
        { timestamp: 4, open: 103, high: 105, low: 101, close: 104 },
    ];
    const arrayCandles = objectCandles.map((c, i) => [c.timestamp, c.open, c.high, c.low, c.close, 0]);

    const expected = computeATRSeries(arrayCandles, 2);
    const actual = computeATRSeries(objectCandles, 2);
    assert.deepStrictEqual(actual, expected, 'ATR series should treat object candles the same as array rows');
    assert.ok(actual.some((v) => v > 0), 'ATR series should produce values for object candles');

    const atr = calculateATR(objectCandles, 2);
    assert.ok(Number.isFinite(atr) && atr > 0, 'calculateATR should accept object candles');

    // The browser-embedded copy runs the exact same function source and must
    // accept the object-shaped payload the research tool feeds it.
    const html = generateVolatilityHTML({
        allResults: objectCandles.map((c) => ({
            timestamp: c.timestamp,
            price: c.close,
            ama3Price: c.close,
            weightVariance: 0,
        })),
        candles: objectCandles,
        atrPeriod: 2,
    }, 'ATR Volatility Test');
    const embedded = evalVolatilitySharedFunctions(html);
    assert.deepStrictEqual(
        embedded.computeATRSeries(objectCandles, 2),
        expected,
        'embedded chart ATR should match the canonical module for object candles'
    );
}

function testAtrAllInvalidCandlesReturnNaN() {
    const invalidCandles = [];
    for (let i = 0; i < 10; i++) {
        invalidCandles.push([i + 1, 1, Number.NaN, Number.NaN, Number.NaN, 10]);
    }
    const atr = calculateATR(invalidCandles, 3);
    assert.ok(Number.isNaN(atr), 'ATR should be NaN when no valid true ranges exist so callers can disable the penalty');

    // Fewer than two valid consecutive rows yields no true range → NaN, not 0.
    const singleValid = [
        [1, 0, 101, 99, 100, 10],
        [2, 0, Number.NaN, Number.NaN, Number.NaN, 10],
        [3, 0, Number.NaN, Number.NaN, Number.NaN, 10],
        [4, 0, Number.NaN, Number.NaN, Number.NaN, 10],
    ];
    assert.ok(
        Number.isNaN(calculateATR(singleValid, 3)),
        'ATR should be NaN when fewer than two valid consecutive rows exist'
    );

    // Too few rows for the period is still a warmup 0, not NaN.
    assert.strictEqual(calculateATR([[1, 0, 101, 99, 100, 10], [2, 0, 101, 99, 100, 10]], 14), 0,
        'insufficient rows for the period should remain a warmup 0');
}

function testAtrSeriesExposesValidRangeCount() {
    const candles = [
        [1, 0, 101, 99, 100, 10],
        [2, 0, 102, 98, 101, 10],
        [3, 0, 103, 97, 102, 10],
        [4, 0, Number.NaN, Number.NaN, Number.NaN, 10],
        [5, 0, 202, 198, 200, 10],
        [6, 0, 203, 197, 201, 10],
    ];

    const stats: any = {};
    const series = computeATRSeries(candles, 3, stats);
    assert.strictEqual(stats.validRanges, 3, 'stats.validRanges should count only consecutive valid true ranges (chain breaks across the invalid candle)');
    assert.strictEqual(series.length, candles.length, 'series length should still match input rows');

    // calculateATR uses the same path: mixed valid/invalid input stays finite.
    assert.ok(Number.isFinite(calculateATR(candles, 3)), 'calculateATR should remain finite when some valid ranges exist');

    // Embedded chart copy must accept the optional stats arg without changing behavior.
    const html = generateVolatilityHTML({
        allResults: candles.map((c, i) => ({
            timestamp: i + 1,
            price: c[4],
            ama3Price: c[4],
            weightVariance: 0,
        })),
        candles,
        atrPeriod: 3,
    }, 'ATR Stats Test');
    const embedded = evalVolatilitySharedFunctions(html);
    const embeddedStats: any = {};
    assert.deepStrictEqual(
        embedded.computeATRSeries(candles, 3, embeddedStats),
        series,
        'embedded chart ATR should match the canonical module when called with the stats out-param'
    );
    assert.strictEqual(embeddedStats.validRanges, 3, 'embedded chart ATR should populate the same stats out-param');

    // A trailing invalid row must not collapse the ATR to 0: the final value is
    // the last computed running ATR over the valid ranges, not the last series slot.
    const trailingInvalid = candles.concat([[7, 0, Number.NaN, Number.NaN, Number.NaN, 10]]);
    const trailingStats: any = {};
    const trailingSeries = computeATRSeries(trailingInvalid, 3, trailingStats);
    assert.strictEqual(trailingSeries[trailingSeries.length - 1], 0, 'invalid trailing row should be 0 in the series');
    assert.strictEqual(trailingStats.validRanges, 3, 'trailing invalid row should not add a valid range');
    assert.ok(
        Number.isFinite(trailingStats.atr) && trailingStats.atr > 0,
        'stats.atr should hold the last computed ATR despite the trailing invalid row'
    );
    assert.ok(
        Number.isFinite(calculateATR(trailingInvalid, 3)) && calculateATR(trailingInvalid, 3) > 0,
        'calculateATR should return the last computed ATR even when the final row is invalid'
    );
}

function testKalmanWarmupIsConfigurable() {
    const analyzer = new KalmanTrendAnalyzer({ warmupBars: 5 });
    for (let i = 0; i < 5; i++) {
        const result = analyzer.update(100 + i);
        assert.strictEqual(result.isReady, false, 'Kalman analyzer should still be warming up at the configured boundary');
    }
    const ready = analyzer.update(105);
    assert.strictEqual(ready.isReady, true, 'Kalman analyzer should become ready after the configured warmup');
}

function testRegimeMultiplierReturnsSeries() {
    const closes = [];
    for (let i = 0; i < 400; i++) closes.push(100 + i * 0.1);
    const result = computeRegimeMultiplier(closes, { regimeSensitivity: 1 });
    assert.ok(Array.isArray(result.series), 'regime multiplier should expose the per-bar series');
    assert.strictEqual(result.series.length, closes.length, 'regime multiplier series should match the input length');
    assert.ok(Number.isFinite(result.multiplier), 'final regime multiplier should remain finite');
}

function extractHtmlPayload(html) {
    const match = html.match(/<script id="payload" type="application\/json">(.*?)<\/script>/s);
    assert.ok(match, 'generated HTML should include an embedded JSON payload');
    return JSON.parse(match[1]);
}

function testDynamicWeightChartUsesErPlusLookbackWarmup() {
    const html = generateHTML({
        allResults: [
            { timestamp: '2026-01-01T00:00:00Z', price: 100, ama3Price: 100, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T01:00:00Z', price: 101, ama3Price: 101, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T02:00:00Z', price: 102, ama3Price: 102, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T03:00:00Z', price: 103, ama3Price: 103, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T04:00:00Z', price: 104, ama3Price: 104, amaSlopePct: 999, velocityPct: null, displacementPct: null, isReady: false, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T05:00:00Z', price: 105, ama3Price: 105, amaSlopePct: 1, velocityPct: null, displacementPct: null, isReady: true, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T06:00:00Z', price: 106, ama3Price: 106, amaSlopePct: 2, velocityPct: null, displacementPct: null, isReady: true, signal: 'NEUTRAL' },
        ],
        amaConfig: { erPeriod: 1, slowPeriod: 1 },
        amaWeightConfig: { lookbackBars: 1 },
    }, 'Dynamic Weight Test');

    const payload = extractHtmlPayload(html);
    assert.strictEqual(payload.amaSlowPeriod, 1, 'chart payload should still expose the AMA slow period');
    assert.strictEqual(payload.amaWarmupBars, 5, 'chart payload should expose the full AMA warmup window');
    assert.strictEqual(payload.amaSlopeReadyBars, 2, 'chart payload should expose the ER-plus-lookback readiness gate');
    assert.strictEqual(payload.amaPercentiles[100], 999, 'AMA clip percentiles should start once ER-plus-lookback bars are available');
    assert.match(html, /data\.amaErPeriod/, 'interactive chart should use the AMA ER period in its readiness gate');
    assert.match(html, /const amaReadyBar = Math\.max\(lb, amaErWarmup \+ lb\);/, 'interactive clip-threshold recompute should start at ER-plus-lookback readiness');
}

function testDynamicWeightChartKeepsGainLinearAtEnd() {
    const html = generateHTML({
        allResults: [
            { timestamp: '2026-01-01T00:00:00Z', price: 100, ama3Price: 100, amaSlopePct: 0.4, velocityPct: 0.2, displacementPct: 0.1, isReady: true, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T01:00:00Z', price: 101, ama3Price: 101, amaSlopePct: 0.5, velocityPct: 0.25, displacementPct: 0.15, isReady: true, signal: 'NEUTRAL' },
        ],
        gain: 0.8,
        minOutputThreshold: 0.12,
    }, 'Dynamic Weight Test');

    // The interactive chart must embed the canonical per-bar pipeline rather
    // than a hand-copied implementation.
    assert.match(
        html,
        /function computeDynamicWeightSeries\(/,
        'chart should embed the canonical dynamic weight pipeline'
    );

    const embedded = evalEmbeddedSharedFunctions(html);

    // Kalman-only fixture: alpha = 0 so only the Kalman channel contributes.
    const gain = 1.75;
    const minOutputThreshold = 0.05;
    const offsetClamp = 0.5;
    const inputs = {
        amaValues: [100, 100, 100, 100, 100],
        kalmanVelocityPct: [null, null, 0.2, 0.2, 0.2],
        kalmanDisplacementPct: [null, null, 0.02, 0.02, 0.02],
        kalmanIsReady: [false, false, true, true, true],
        regimeMultipliers: [1.0, 1.0, 1.0, 1.0, 1.0],
        lookbackBars: 1,
        amaErPeriod: 1,
        amaClipThreshold: Infinity,
        kalClipThreshold: Infinity,
        neutralZonePct: 0,
        amaMaxSlopePct: 0.085,
        kalmanMaxSlopePct: 0.8,
        offsetClamp,
        dispScaleMinPct: 1.0,
        alpha: 0,
        dw: 0.7,
        gain,
        minOutputThreshold,
        signalConfirmBars: 0,
        clampFinalOutput: false,
    };
    const res = embedded.computeDynamicWeightSeries(inputs);

    assert.strictEqual(res.combinedOffSeries[0], 0, 'pre-warmup bars should stay flat');
    assert.ok(res.combinedOffSeries[2] !== 0, 'fixture should exercise a non-zero latched output');
    assert.ok(Math.abs(res.gatedOffSeries[2]) >= minOutputThreshold, 'dead-band should be decided in pre-gain space');

    // Gain applied only as a final linear scale factor: combined = round(gated * gain, 3).
    for (let i = 0; i < inputs.amaValues.length; i++) {
        const expected = Math.round(res.gatedOffSeries[i] * gain * 1000) / 1000;
        assert.strictEqual(res.combinedOffSeries[i], expected, `gain should stay linear at the end (bar ${i})`);
    }

    // Chart output is NOT clamped by the runtime output clamp (clampFinalOutput false),
    // so a saturated AMA channel can push the combined output past the clamp.
    const saturated = embedded.computeDynamicWeightSeries({
        ...inputs,
        alpha: 1,
        kalmanVelocityPct: inputs.amaValues.map(() => null),
        kalmanDisplacementPct: inputs.amaValues.map(() => null),
        kalmanIsReady: inputs.amaValues.map(() => false),
        amaValues: [100, 100, 101, 102, 103],
        gain: 1.0,
        minOutputThreshold: 0,
    });
    assert.ok(
        saturated.combinedOffSeries.some((value) => Math.abs(value) > offsetClamp),
        'chart should allow the blended shape to exceed the runtime clamp before gain'
    );
}

function testDynamicWeightChartShowsOutputClampGuide() {
    const html = generateHTML({
        allResults: [
            { timestamp: '2026-01-01T00:00:00Z', price: 100, ama3Price: 100, amaSlopePct: 0.4, velocityPct: 0.2, displacementPct: 0.1, isReady: true, signal: 'NEUTRAL' },
            { timestamp: '2026-01-01T01:00:00Z', price: 101, ama3Price: 101, amaSlopePct: 0.5, velocityPct: 0.25, displacementPct: 0.15, isReady: true, signal: 'NEUTRAL' },
        ],
        gain: 0.8,
    }, 'Dynamic Weight Test');

    assert.match(html, /const OUTPUT_CLAMP = data\.outputClamp \?\? 0\.5;/,
        'bottom output panel should resolve the clamp from payload data or the runtime default');
    assert.match(html, /makeClampPairHooks\('ow', OUTPUT_CLAMP\)/,
        'bottom output panel should draw both clamp guide lines');
    assert.match(html, /makeClampLineHook\(scaleKey, -clampValue, 'clamp -' \+ clampValue\.toFixed\(2\)\)/,
        'bottom output panel should include the mirrored negative clamp guide');
    assert.match(html, /const OUTPUT_CLAMP = data\.outputClamp \?\? 0\.5;[\s\S]*function recalcInputs\(\)/,
        'output clamp constant should be declared before recalcInputs uses it');
}

function testLiveServiceMatchesChartGainStructure() {
    const serviceSource = fs.readFileSync(
        path.join(__dirname, '..', 'market_adapter', 'core', 'market_adapter_service.ts'),
        'utf8'
    );

    assert.match(
        serviceSource,
        /computeDynamicWeightSeries\(\{/,
        'live service should delegate the per-bar series to the shared dynamic weight pipeline'
    );
    assert.match(
        serviceSource,
        /const hasDirectionalOffset = mo > 0;/,
        'live service should disable the directional branch when maxSlopeOffset is zero'
    );
    assert.match(
        serviceSource,
        /const useAmaBlend = hasDirectionalOffset && alpha !== 0;/,
        'live service should short-circuit the AMA branch when alpha is zero or directional offset is disabled'
    );
    assert.match(
        serviceSource,
        /const useKalmanBlend = hasDirectionalOffset && alpha !== 1;/,
        'live service should short-circuit the Kalman branch when alpha is one'
    );
    assert.match(
        serviceSource,
        /const finalPreGainOff = echoedGatedOffSeries\[echoedGatedOffSeries\.length - 1\] \?\? rawFinalPreGainOff;/,
        'live service should evaluate the threshold against the confirmed pre-gain state'
    );
    assert.match(
        serviceSource,
        /const belowMinOutputThreshold = Math\.abs\(finalPreGainOff\) < outputThreshold;/,
        'live service should keep thresholding aligned with the latched output state'
    );

    // The gain / dead-band / clamp semantics that used to live inline in the
    // service are now canonical in the shared per-bar pipeline module.
    const seriesSource = fs.readFileSync(
        path.join(__dirname, '..', 'market_adapter', 'core', 'strategies', 'dynamic_weight_series.ts'),
        'utf8'
    );
    assert.match(
        seriesSource,
        /const channelNorm = Math\.max\(Math\.abs\(offsetClamp\), 1e-9\);/,
        'shared pipeline should normalize the blended channels by the runtime offset clamp'
    );
    assert.match(
        seriesSource,
        /const gatedOff = Math\.abs\(regimeAdjusted\) < minOutputThreshold \? 0 : regimeAdjusted;/,
        'shared pipeline should make the dead-band decision in pre-gain space so gain does not reshape the signal'
    );
    assert.match(
        seriesSource,
        /const applied = clampFinalOutput\s*\?\s*Math\.max\(-offsetClamp, Math\.min\(offsetClamp, gatedOff \* gain\)\)\s*:\s*\(gatedOff \* gain\);/,
        'shared pipeline should apply gain as the final linear scale factor before the runtime clamp'
    );
}

function extractEmbeddedSharedFunctions(html) {
    const startMarker = '/* EMBEDDED_FUNCS_START */';
    const endMarker = '/* EMBEDDED_FUNCS_END */';
    const start = html.indexOf(startMarker);
    const end = html.indexOf(endMarker);
    assert.ok(start >= 0 && end > start, 'generated HTML should embed the shared functions between markers');
    return html.slice(start + startMarker.length, end);
}

function evalEmbeddedSharedFunctions(html) {
    const block = extractEmbeddedSharedFunctions(html);
    const f = new Function(block + '\nreturn { computeDynamicWeightSeries, echoLatchSeries, computeAverageAmaSlopePct, bilinearInterpolate, buildKalmanVelocitySeries };');
    return f();
}

function evalVolatilitySharedFunctions(html) {
    const block = extractEmbeddedSharedFunctions(html);
    const f = new Function(block + '\nreturn { computeATRSeries, computeVolatilityShift };');
    return f();
}

function testVolatilityChartEmbedsCanonicalFunctions() {
    const html = generateVolatilityHTML({
        allResults: [
            { timestamp: '2026-01-01T00:00:00Z', price: 100, ama3Price: 100, weightVariance: 0.02 },
            { timestamp: '2026-01-01T01:00:00Z', price: 101, ama3Price: 101, weightVariance: 0.02 },
        ],
        atrPeriod: 14,
        volatilityExponent: 1.0,
        volatilityScaleX: 10.0,
        volatilityThreshold: 0.1,
        volatilityClamp: 0.5,
    }, 'ATR Volatility Test');

    assert.match(html, /function computeATRSeries\(/, 'volatility chart should embed the canonical ATR series');
    assert.match(html, /function computeVolatilityShift\(/, 'volatility chart should embed the canonical volatility shift');

    const embedded = evalVolatilitySharedFunctions(html);

    // Embedded shift must match the canonical Node module on a non-trivial input.
    const variance = 0.04;
    const opts = { exponent: 1.0, scaleX: 10.0, threshold: 0.1, clampValue: 0.5, minWeight: -1, maxWeight: 2 };
    assert.deepStrictEqual(
        embedded.computeVolatilityShift(variance, opts),
        computeVolatilityShift(variance, opts),
        'embedded volatility shift should match the canonical module'
    );
}

function testEmbeddableDefaultsMirrorMarketAdapterConstants() {
    const { bilinearInterpolate } = require('../market_adapter/core/strategies/regime_interp');
    const { computeVolatilityShift } = require('../market_adapter/core/strategies/volatility_shift');
    const { KALMAN_VELOCITY_DEFAULTS } = require('../market_adapter/core/signals/kalman_velocity_smoothing');

    // bilinearInterpolate inline defaults must mirror MARKET_ADAPTER constants so
    // the browser-embedded copy stays aligned with the live regime gate.
    const defaultMult = bilinearInterpolate(0.62, 0.8, null);
    const explicitMult = bilinearInterpolate(0.62, 0.8, MARKET_ADAPTER.REGIME_TABLE, {
        hurstZoneBand: MARKET_ADAPTER.HURST_ZONE_BAND,
        peNodes: MARKET_ADAPTER.PE_NODES,
    });
    assert.strictEqual(defaultMult, explicitMult, 'bilinearInterpolate inline defaults should mirror MARKET_ADAPTER constants');

    // computeVolatilityShift inline defaults must mirror MARKET_ADAPTER constants.
    // Compare the FULL result (effectiveWeight / buyW / sellW included) so a drift
    // in any mirrored default fails loudly, not just symmetricDelta.
    const defaultShift = computeVolatilityShift(0.04);
    const explicitShift = computeVolatilityShift(0.04, {
        exponent: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT,
        scaleX: MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT,
        threshold: MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD,
        clampValue: MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP,
        minWeight: MARKET_ADAPTER.DYNAMIC_WEIGHT_MIN_WEIGHT,
        maxWeight: MARKET_ADAPTER.DYNAMIC_WEIGHT_MAX_WEIGHT,
    });
    assert.deepStrictEqual(
        defaultShift,
        explicitShift,
        'computeVolatilityShift inline defaults should mirror MARKET_ADAPTER constants'
    );

    // Kalman velocity smoothing Node defaults must mirror MARKET_ADAPTER constants.
    assert.strictEqual(
        KALMAN_VELOCITY_DEFAULTS.kalmanSmoothPct,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT,
        'kalman smoothing default should mirror MARKET_ADAPTER'
    );
    assert.strictEqual(
        KALMAN_VELOCITY_DEFAULTS.smoothingBudget,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTHING_BUDGET,
        'kalman smoothing budget should mirror MARKET_ADAPTER'
    );
}

function main() {
    testAmaSlopeWarmupUsesSlowPeriod();
    testAtrRejectsInvalidCandles();
    testAtrInvalidCandleBreaksTrueRangeChain();
    testAtrSupportsObjectCandles();
    testAtrAllInvalidCandlesReturnNaN();
    testAtrSeriesExposesValidRangeCount();
    testKalmanWarmupIsConfigurable();
    testRegimeMultiplierReturnsSeries();
    testDynamicWeightChartUsesErPlusLookbackWarmup();
    testDynamicWeightChartKeepsGainLinearAtEnd();
    testDynamicWeightChartShowsOutputClampGuide();
    testVolatilityChartEmbedsCanonicalFunctions();
    testLiveServiceMatchesChartGainStructure();
    testEmbeddableDefaultsMirrorMarketAdapterConstants();
    console.log('market adapter signal gate tests passed');
}

main();
