'use strict';

const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running huber_scale_variants tests');

const { huberConsistencyConstant, huberSlopeCore, createHuberEstimator } = require('../analysis/trend_detection/huber_scale_variants');
const { computeHuberWindowSlopePct } = require('../market_adapter/core/strategies/dynamic_weight_series');

// Geometric ramp — the Huber fit reports the per-bar log rate near-exactly.
function rampSeries(n: number, base: number, perBarPct: number) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(base * Math.pow(1 + perBarPct / 100, i));
    return out;
}

// Deterministic pseudo-noise walk (LCG) so the corrected-scale variants have a
// residual distribution to act on, and the test is reproducible.
function noisySeries(n: number, base: number, seed: number) {
    const out = [];
    let s = seed >>> 0;
    let v = base;
    for (let i = 0; i < n; i++) {
        s = (1664525 * s + 1013904223) >>> 0;
        const r = (s / 4294967296) * 2 - 1;
        v = v * (1 + 0.0003 + r * 0.01);
        out.push(v);
    }
    return out;
}

// The harness's whole reason to exist is that `none` reproduces the production
// estimator byte-for-byte; if this drifts, every scale comparison is invalid.
function testNoneMatchesProductionExactly() {
    for (const lb of [8, 12, 16, 20]) {
        const series = noisySeries(400, 100, 12345 + lb);
        const est = createHuberEstimator('none');
        let checked = 0;
        for (let i = lb; i < series.length; i++) {
            const a = est(series, i, lb);
            const b = computeHuberWindowSlopePct(series, i, lb);
            assert.strictEqual(a, b, `none must equal production (bar ${i}, lb ${lb})`);
            checked++;
        }
        assert.ok(checked > 300, `expected to check many bars, got ${checked}`);
    }
}

function testCorrectedVariantsDifferAndRaiseScale() {
    const series = noisySeries(200, 100, 999);
    const lb = 16;
    let differs = false;
    for (let i = lb; i < series.length; i++) {
        const none = huberSlopeCore(series, i, lb, 'none');
        const df = huberSlopeCore(series, i, lb, 'df');
        const ms = huberSlopeCore(series, i, lb, 'mscale');
        assert.ok(none && df && ms, 'all variants should produce diagnostics');
        assert.ok(Number.isFinite(none!.slopePct) && Number.isFinite(df!.slopePct) && Number.isFinite(ms!.slopePct));
        // df inflates the scale by sqrt(n/(n-2)) > 1
        assert.ok(df!.scale >= none!.scale, `df scale should be >= none at bar ${i}`);
        if (df!.slopePct !== none!.slopePct || ms!.slopePct !== none!.slopePct) differs = true;
    }
    assert.ok(differs, 'corrected variants should change at least one slope reading');
}

function testOutlierFractionInRange() {
    const series = noisySeries(200, 100, 4242);
    for (let i = 16; i < series.length; i++) {
        const d = huberSlopeCore(series, i, 16, 'none');
        assert.ok(d);
        assert.ok(d!.outlierFraction >= 0 && d!.outlierFraction <= 1, `outlier fraction out of range: ${d!.outlierFraction}`);
        assert.ok(d!.scale > 0, 'scale must be positive');
    }
}

// delta_C = E[rho_C(Z)] at the classical 1.345 constant.
function testConsistencyConstant() {
    const d = huberConsistencyConstant(1.345);
    assert.ok(Math.abs(d - 0.9326) < 5e-3, `expected delta_1.345 ~= 0.9326, got ${d}`);
}

function testEstimatorStatsAccumulate() {
    const series = noisySeries(120, 100, 7);
    const est = createHuberEstimator('df');
    let n = 0;
    for (let i = 16; i < series.length; i++) { est(series, i, 16); n++; }
    assert.strictEqual(est.stats.calls, n);
    assert.ok(est.stats.outlierFractionSum >= 0 && est.stats.outlierFractionSum <= n);
    assert.ok(est.stats.scaleSum > 0);
}

function testRejectsUnusableWindow() {
    const est = createHuberEstimator('none');
    assert.strictEqual(est([1, 2, 3], 0, 5), null, 'index < bars must return null');
    assert.strictEqual(est([1, 2, 3], 2, 5), null, 'index >= length must return null');
    assert.strictEqual(huberSlopeCore([1, 2, 3], 2, 0, 'none'), null, 'bars < 1 must return null');
}

async function run() {
    testNoneMatchesProductionExactly();
    testCorrectedVariantsDifferAndRaiseScale();
    testOutlierFractionInRange();
    testConsistencyConstant();
    testEstimatorStatsAccumulate();
    testRejectsUnusableWindow();
    // Keep the ramp helper referenced so a future edit doesn't drop it silently.
    assert.ok(Math.abs(rampSeries(3, 100, 1)[2] - 102.01) < 1e-9);
}

run()
    .then(() => console.log('huber_scale_variants tests passed'))
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });
