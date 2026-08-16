'use strict';

/**
 * Re-export shim — canonical implementation lives in
 * market_adapter/core/signals/kalman_velocity_smoothing.ts.
 */
export { buildKalmanVelocitySeries, computeAbsolutePercentileThreshold, resolveKalmanVelocitySmoothingConfig, smoothKalmanVelocityPoint, KALMAN_VELOCITY_DEFAULTS } from '../../market_adapter/core/signals/kalman_velocity_smoothing.js';
