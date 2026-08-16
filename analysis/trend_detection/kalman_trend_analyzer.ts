'use strict';

/**
 * Re-export shim — canonical implementation lives in
 * market_adapter/core/signals/kalman_trend_analyzer.ts so production, analysis
 * tooling, and tests all resolve to one shared module.
 */
export { KalmanTrendAnalyzer, KalmanFilter } from '../../market_adapter/core/signals/kalman_trend_analyzer.js';
export type { TrendAnalysis } from '../../market_adapter/core/signals/kalman_trend_analyzer.js';
