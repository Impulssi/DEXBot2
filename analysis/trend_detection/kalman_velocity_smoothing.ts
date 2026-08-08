
import { clamp } from '../../modules/order/utils/math.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
'use strict';


const KALMAN_SMOOTHING_BUDGET = MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTHING_BUDGET;
const KALMAN_SMOOTHING_FLOOR = MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTHING_FLOOR;

interface KalmanVelocityConfig {
    kalmanSmoothPct?: number;
    kalmanDispScaleMult?: number;
    kalmanDispThresholdMult?: number;
    kalmanSmoothSpanPct?: number;
}

interface KalmanHistoryPoint {
    velocityPct?: number | null;
    displacementPct?: number | null;
}

function resolveKalmanVelocitySmoothingConfig(config: KalmanVelocityConfig = {}) {
    const blend = clamp(
        config.kalmanSmoothPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_PCT_DEFAULT,
        0,
        200
    ) / 100;
    const dispScale = clamp(
        config.kalmanDispScaleMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_SCALE_MULT_DEFAULT,
        1.0,
        3.0
    );
    const dispThreshold = clamp(
        config.kalmanDispThresholdMult ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_DISP_THRESHOLD_MULT_DEFAULT,
        0.25,
        3.0
    );
    const spanPct = clamp(
        config.kalmanSmoothSpanPct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_SMOOTH_SPAN_PCT_DEFAULT,
        20,
        200
    );

    return {
        blend,
        dispScale,
        dispThreshold,
        smoothingFloor: KALMAN_SMOOTHING_FLOOR,
        smoothingBudget: KALMAN_SMOOTHING_BUDGET,
        smoothingSpan: KALMAN_SMOOTHING_BUDGET * spanPct / 100,
    };
}

function smoothKalmanVelocityPoint(rawVelocityPct: number | null | undefined, displacementPct: number | null | undefined, prevAdaptiveVelocity: number | null | undefined, config: KalmanVelocityConfig = {}) {
    if (rawVelocityPct == null || displacementPct == null) {
        return {
            adaptiveVelocityPct: null,
            smoothedVelocityPct: null,
            trendConfidence: null,
            smoothingAlpha: null,
        };
    }

    const resolved = resolveKalmanVelocitySmoothingConfig(config);
    const trendConfidence = clamp(Math.abs(displacementPct) / (resolved.dispScale * resolved.dispThreshold), 0, 1);
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

function buildKalmanVelocitySeries(kalmanHistory: KalmanHistoryPoint[] | null | undefined, config: KalmanVelocityConfig = {}) {
    if (!Array.isArray(kalmanHistory) || kalmanHistory.length === 0) return [];

    const resolved = resolveKalmanVelocitySmoothingConfig(config);
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
            config
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
    const idx = Math.min(
        Math.floor((100 - clipPercentile) / 100 * magnitudes.length),
        magnitudes.length - 1
    );
    return magnitudes[idx];
}

export { buildKalmanVelocitySeries, computeAbsolutePercentileThreshold, resolveKalmanVelocitySmoothingConfig, smoothKalmanVelocityPoint }

