import assert from 'node:assert';
import {
    buildKalmanVelocitySeries,
    smoothKalmanVelocityPoint,
} from '../kalman_velocity_smoothing.js';

'use strict';

const baseline = smoothKalmanVelocityPoint(
    0,
    1,
    10,
    {
        kalmanSmoothPct: 100,
        kalmanDispScaleMult: 1.5,
        kalmanDispThresholdMult: 1.5,
        kalmanSmoothSpanPct: 100,
    }
);

const maxed = smoothKalmanVelocityPoint(
    0,
    1,
    10,
    {
        kalmanSmoothPct: 200,
        kalmanDispScaleMult: 1.5,
        kalmanDispThresholdMult: 1.5,
        kalmanSmoothSpanPct: 100,
    }
);

const clamped = smoothKalmanVelocityPoint(
    0,
    1,
    10,
    {
        kalmanSmoothPct: 300,
        kalmanDispScaleMult: 1.5,
        kalmanDispThresholdMult: 1.5,
        kalmanSmoothSpanPct: 100,
    }
);

assert.ok(baseline.smoothedVelocityPct! > 0 && baseline.smoothedVelocityPct! < 10);
assert.strictEqual(clamped.smoothedVelocityPct!, maxed.smoothedVelocityPct!);
assert.ok(clamped.smoothedVelocityPct! > baseline.smoothedVelocityPct!);

const rawSeries = buildKalmanVelocitySeries(
    [
        { velocityPct: 1.25, displacementPct: 0.4 },
        { velocityPct: -0.5, displacementPct: -0.3 },
        { velocityPct: null, displacementPct: 0.1 },
    ],
    {
        kalmanSmoothPct: 0,
        kalmanDispScaleMult: 1.5,
        kalmanDispThresholdMult: 1.5,
        kalmanSmoothSpanPct: 100,
    }
);
assert.deepStrictEqual(rawSeries, [1.25, -0.5, null], 'zero Kalman smoothing should short-circuit to the raw velocity series');

console.log('kalman_velocity_smoothing tests passed');
