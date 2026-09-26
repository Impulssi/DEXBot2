'use strict';

const assert = require('assert');

const {
    resolveMaxAsymmetryFactor,
    computeAsymmetricBoundsMetrics,
    applyAsymmetricBounds,
} = require('../market_adapter/core/asymmetric_bounds');

console.log('Running asymmetric bounds tests');

function testResolveMaxAsymmetryFactorPrefersConfiguredOrder() {
    assert.strictEqual(resolveMaxAsymmetryFactor(0.2, 0.3, 0.4), 0.2);
    assert.strictEqual(resolveMaxAsymmetryFactor(null, 0.3, 0.4), 0.3);
    assert.strictEqual(resolveMaxAsymmetryFactor(null, null, 0.4), 0.4);
}

function testComputeAsymmetricBoundsMetricsClampToSafeBounds() {
    const metrics = computeAsymmetricBoundsMetrics({
        centerPrice: 100,
        minPrice: 50,
        maxPrice: 110,
        trend: 'DOWN',
        slopeOffset: 0.5,
        maxSlopeOffset: 0.5,
        maxAsymmetryFactor: 0.35,
    });

    assert.strictEqual(metrics.rawAsymmetryFactor, 0.35, 'raw asymmetry should reflect the full configured cap');
    assert.ok(Math.abs(metrics.appliedAsymmetryFactor - (1.1 - 1)) < 1e-12,
        'applied asymmetry should be clamped to the log-symmetric safe bound (baseMaxMult - 1)');
    assert.strictEqual(metrics.maxAsymmetryFactor, 0.35, 'resolved maxAsymmetryFactor should be preserved');
}

function testApplyAsymmetricBoundsUsesAppliedClamp() {
    const result = applyAsymmetricBounds({
        centerPrice: 100,
        minPrice: 50,
        maxPrice: 110,
        trend: 'DOWN',
        slopeOffset: 0.5,
        maxSlopeOffset: 0.5,
        maxAsymmetryFactor: 0.35,
    });

    assert.ok(Math.abs(result.resolvedMinPrice - (50 / 1.1)) < 1e-12,
        'downtrend should shift the min bound down by the clamped 1/(1+a) factor');
    assert.ok(Math.abs(result.resolvedMaxPrice - 100) < 1e-12,
        'downtrend should shift the max bound exactly to center when the safe clamp is hit');
}

testResolveMaxAsymmetryFactorPrefersConfiguredOrder();
testComputeAsymmetricBoundsMetricsClampToSafeBounds();
testApplyAsymmetricBoundsUsesAppliedClamp();

console.log('asymmetric bounds tests passed');
