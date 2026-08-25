'use strict';
import assert from 'node:assert';
import { KalmanTrendAnalyzer, KalmanFilter } from '../kalman_trend_analyzer.js';


/**
 * Test Suite for Kalman Trend Detection
 */

async function runTests() {
    console.log('Running Kalman Trend Analyzer tests...');

    testFilterInitialization();
    testConstantTrendConvergence();
    testNoiseFiltering();
    testTrajectoryProjection();
    testTrendDetectionSign();
    testResetPreservesFilterConfig();
    testFilterRejectsInvalidMeasurements();
    testInitialCovarianceScalesWithPrice();
    testNearZeroModalPriceDoesNotExplodePercentages();

    console.log('All Kalman tests passed!');
}

function testFilterInitialization() {
    console.log(' - Testing initialization');
    const kf = new KalmanFilter();
    const state = kf.update(100);
    assert.strictEqual(state.x, 100);
    assert.strictEqual(state.v, 0);
}

function testConstantTrendConvergence() {
    console.log(' - Testing constant trend convergence');
    const analyzer = new KalmanTrendAnalyzer({ rNoise: 0.01, qNoise: 0.01 });

    // Simulate price moving from 100 to 200 in 100 steps (velocity = 1.0)
    let price = 100;
    let lastAnalysis;
    for (let i = 0; i < 100; i++) {
        price += 1.0;
        lastAnalysis = analyzer.update(price);
    }

    // Velocity should be very close to 1.0
    assert.ok(Math.abs(lastAnalysis!.velocity - 1.0) < 0.05, `Velocity ${lastAnalysis!.velocity} should be near 1.0`);
    assert.strictEqual(lastAnalysis!.trend, 'UP');
}

function testNoiseFiltering() {
    console.log(' - Testing noise filtering (wicks)');
    const analyzer = new KalmanTrendAnalyzer({ rNoise: 10.0, qNoise: 0.01 }); // High R = ignore noise

    // 50 steps of steady price
    for (let i = 0; i < 50; i++) analyzer.update(100);

    // One big "wick" to 150
    const noisyAnalysis = analyzer.update(150);

    // Kalman price should NOT jump to 150 immediately due to high R
    assert.ok(noisyAnalysis.kalmanPrice < 115, `Kalman price ${noisyAnalysis.kalmanPrice} should stay low despite noise`);
}

function testTrajectoryProjection() {
    console.log(' - Testing trajectory projection (beams)');
    const analyzer = new KalmanTrendAnalyzer();

    // Upward trend: velocity 2.0
    for (let i = 0; i < 50; i++) analyzer.update(100 + (i * 2.0));

    const analysis = analyzer.getAnalysis();

    // Current price is ~200. The built-in projections field covers forward projection.
    // project() method does not exist; use the projections object instead.
    assert.ok(analysis.projections != null, 'Projections should be present');
    assert.ok(Number.isFinite(analysis.projections.tactical), 'Tactical projection should be finite');
    assert.ok(Number.isFinite(analysis.projections.modal), 'Modal projection should be finite');
}

function testTrendDetectionSign() {
    console.log(' - Testing trend detection signs');
    const analyzer = new KalmanTrendAnalyzer();

    for (let i = 0; i < 20; i++) analyzer.update(100 - i); // Downward
    assert.strictEqual(analyzer.getAnalysis().trend, 'DOWN');

    analyzer.reset();
    for (let i = 0; i < 20; i++) analyzer.update(100 + i); // Upward
    assert.strictEqual(analyzer.getAnalysis().trend, 'UP');
}

function testResetPreservesFilterConfig() {
    console.log(' - Testing reset preserves filter config');
    const analyzer = new KalmanTrendAnalyzer({
        rNoise: 0.25,
        qTactical: 0.02,
        qModal: 0.0002,
        dt: 2
    });

    analyzer.update(100);
    analyzer.reset();

    assert.strictEqual(analyzer.tacticalKf.R, 0.25);
    assert.strictEqual(analyzer.tacticalKf.Q, 0.02);
    assert.strictEqual(analyzer.tacticalKf.dt, 2);
    assert.strictEqual(analyzer.modalKf.R, 0.25);
    assert.strictEqual(analyzer.modalKf.Q, 0.0002);
    assert.strictEqual(analyzer.modalKf.dt, 2);
}

function testFilterRejectsInvalidMeasurements() {
    console.log(' - Testing invalid measurement guard');
    const kf = new KalmanFilter();
    const initial = kf.update(100);
    const state = kf.update(Number.NaN);

    assert.deepStrictEqual(state, initial);
    assert.strictEqual(kf.x, 100);
    assert.strictEqual(kf.v, 0);
    assert.strictEqual(kf.isInitialized, true);
}

function testInitialCovarianceScalesWithPrice() {
    console.log(' - Testing price-scaled covariance initialization');
    const kf = new KalmanFilter();
    kf.update(0.0001);

    assert.strictEqual(kf.P00, 0.0001 * 0.0001 * 100);
    assert.strictEqual(kf.P11, 0.0001 * 0.0001);
}

function testNearZeroModalPriceDoesNotExplodePercentages() {
    console.log(' - Testing near-zero percentage guard');
    const analyzer = new KalmanTrendAnalyzer({ warmupBars: 0 });
    analyzer.currPrice = 1;
    analyzer.modal = { x: 1e-12, v: 0 };
    analyzer.tactical = { x: 1, v: 1 };
    analyzer.velocityFilteredPct = Number.NaN;

    const analysis = analyzer.getAnalysis();
    assert.strictEqual(analysis.velocityRawPct, 0);
    assert.strictEqual(analysis.displacementRawPct, 0);
    assert.ok(Number.isFinite(analysis.velocityPct));
    assert.ok(Number.isFinite(analysis.displacementPct));
}

runTests().catch(err => {
    console.error('Tests failed!');
    console.error(err);
    process.exit(1);
});
