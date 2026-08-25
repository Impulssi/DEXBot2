'use strict';


import { MARKET_ADAPTER } from '../../../modules/constants.js';

/**
 * Kalman velocity smoothing — canonical implementation shared by the live
 * market adapter service, analysis research charts, and the browser-embedded
 * chart scripts (injected via fn.toString()).
 *
 * The public functions below are intentionally self-contained (no module
 * imports referenced inside function bodies) so the chart generators can embed
 * their exact source into generated HTML and keep every consumer on one logic
 * path. Node-side defaults resolve from MARKET_ADAPTER constants; embedded
 * browser callers pass explicit config values from the chart payload.
 */

const KALMAN_VELOCITY_DEFAULTS = {
    kalmanSmoothPct: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT,
    kalmanDispScaleMult: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT,
    kalmanDispThresholdMult: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT,
    kalmanSmoothSpanPct: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT,
    smoothingBudget: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTHING_BUDGET,
    smoothingFloor: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTHING_FLOOR,
};

interface KalmanVelocityConfig {
    kalmanSmoothPct?: number;
    kalmanDispScaleMult?: number;
    kalmanDispThresholdMult?: number;
    kalmanSmoothSpanPct?: number;
    smoothingBudget?: number;
    smoothingFloor?: number;
}

interface KalmanHistoryPoint {
    velocityPct?: number | null;
    displacementPct?: number | null;
}

function resolveKalmanVelocitySmoothingConfig(config: KalmanVelocityConfig = {}, defaults: Partial<KalmanVelocityConfig> = {}) {
    const blend = Math.max(0, Math.min(200, config.kalmanSmoothPct ?? defaults.kalmanSmoothPct ?? 100)) / 100;
    const dispScale = Math.max(1.0, Math.min(3.0, config.kalmanDispScaleMult ?? defaults.kalmanDispScaleMult ?? 1.8));
    const dispThreshold = Math.max(0.25, Math.min(3.0, config.kalmanDispThresholdMult ?? defaults.kalmanDispThresholdMult ?? 1.5));
    const spanPct = Math.max(20, Math.min(200, config.kalmanSmoothSpanPct ?? defaults.kalmanSmoothSpanPct ?? 100));
    const smoothingBudget = Number.isFinite(config.smoothingBudget)
        ? config.smoothingBudget as number
        : (Number.isFinite(defaults.smoothingBudget) ? defaults.smoothingBudget as number : 0.60);
    const smoothingFloor = Number.isFinite(config.smoothingFloor)
        ? config.smoothingFloor as number
        : (Number.isFinite(defaults.smoothingFloor) ? defaults.smoothingFloor as number : 0);

    return {
        blend,
        dispScale,
        dispThreshold,
        smoothingFloor,
        smoothingBudget,
        smoothingSpan: smoothingBudget * spanPct / 100,
    };
}

function smoothKalmanVelocityPoint(rawVelocityPct: number | null | undefined, displacementPct: number | null | undefined, prevAdaptiveVelocity: number | null | undefined, config: KalmanVelocityConfig = {}, defaults: Partial<KalmanVelocityConfig> = {}) {
    if (rawVelocityPct == null || displacementPct == null) {
        return {
            adaptiveVelocityPct: null,
            smoothedVelocityPct: null,
            trendConfidence: null,
            smoothingAlpha: null,
        };
    }

    const resolved = resolveKalmanVelocitySmoothingConfig(config, defaults);
    const trendConfidence = Math.max(0, Math.min(1, Math.abs(displacementPct) / (resolved.dispScale * resolved.dispThreshold)));
    const smoothingAlpha = Math.min(
        resolved.smoothingBudget,
        resolved.smoothingFloor + (resolved.smoothingSpan * trendConfidence)
    );
    const adaptiveVelocityPct = prevAdaptiveVelocity == null
        ? rawVelocityPct
        : (smoothingAlpha * rawVelocityPct) + ((1 - smoothingAlpha) * prevAdaptiveVelocity);
    const smoothedVelocityPct = resolved.blend === 0
        ? rawVelocityPct
        : (rawVelocityPct + ((adaptiveVelocityPct - rawVelocityPct) * resolved.blend));

    return {
        adaptiveVelocityPct,
        smoothedVelocityPct,
        trendConfidence,
        smoothingAlpha,
    };
}

function buildKalmanVelocitySeries(kalmanHistory: KalmanHistoryPoint[] | null | undefined, config: KalmanVelocityConfig = {}, defaults: Partial<KalmanVelocityConfig> = {}) {
    if (!Array.isArray(kalmanHistory) || kalmanHistory.length === 0) return [];

    const resolved = resolveKalmanVelocitySmoothingConfig(config, defaults);
    if (resolved.blend === 0) {
        const rawSeries = new Array(kalmanHistory.length).fill(null);
        for (let i = 0; i < kalmanHistory.length; i++) {
            const point = kalmanHistory[i];
            const rawVelocityPct = point?.velocityPct ?? null;
            const displacementPct = point?.displacementPct ?? null;
            rawSeries[i] = rawVelocityPct == null || displacementPct == null ? null : rawVelocityPct;
        }
        return rawSeries;
    }

    const series: (number | null)[] = new Array(kalmanHistory.length).fill(null);
    let prevAdaptiveVelocity: number | null = null;

    for (let i = 0; i < kalmanHistory.length; i++) {
        const point = kalmanHistory[i];
        const result = smoothKalmanVelocityPoint(
            point?.velocityPct ?? null,
            point?.displacementPct ?? null,
            prevAdaptiveVelocity,
            config,
            defaults
        );
        series[i] = result.smoothedVelocityPct;
        prevAdaptiveVelocity = result.adaptiveVelocityPct ?? null;
    }

    return series;
}

function computeAbsolutePercentileThreshold(series: (number | null | undefined)[], clipPercentile: number, fallback = Infinity) {
    if (!(clipPercentile > 0)) return fallback;

    const magnitudes: number[] = [];
    for (const value of series || []) {
        if (value != null && Number.isFinite(value)) magnitudes.push(Math.abs(value));
    }
    if (magnitudes.length === 0) return fallback;

    magnitudes.sort((a, b) => a - b);
    // Clamp both the percentile and the resulting index: a misconfigured
    // clipPercentile above 100 would otherwise produce a negative index
    // (undefined threshold -> NaN propagation into offsets).
    const pct = Math.min(clipPercentile, 100);
    const idx = Math.max(0, Math.min(
        Math.floor((100 - pct) / 100 * magnitudes.length),
        magnitudes.length - 1
    ));
    return magnitudes[idx];
}

export { buildKalmanVelocitySeries, computeAbsolutePercentileThreshold, resolveKalmanVelocitySmoothingConfig, smoothKalmanVelocityPoint, KALMAN_VELOCITY_DEFAULTS }
