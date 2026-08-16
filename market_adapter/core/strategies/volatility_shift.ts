'use strict';

/**
 * Symmetric volatility shift — canonical implementation shared by the AMA slope
 * model, the volatility research tool, and the browser-embedded chart scripts.
 *
 * Signal path (mirrors the live adapter):
 *   rawDelta            = -weightVariance^exponent * scaleX
 *   clampedRawDelta     = clamp(rawDelta, -clampValue, 0)
 *   symmetricDelta      = |clampedRawDelta| < threshold ? 0 : clampedRawDelta
 *   effectiveWeight     = clamp(baselineWeight + symmetricDelta, minWeight, maxWeight)
 *
 * Self-contained on purpose so the chart generators can inject this exact source
 * into generated HTML — do not add imports referenced from the function body.
 */

function computeVolatilityShift(weightVariance: any, opts: any = {}) {
    const {
        exponent = 1.0,
        scaleX = 10.0,
        threshold = 0.1,
        clampValue = 0.5,
        minWeight = -1,
        maxWeight = 2,
        baselineWeight = 0.5,
    } = opts;

    const safeVariance = Number.isFinite(weightVariance) && weightVariance > 0 ? weightVariance : 0;
    const safeExponent = Number.isFinite(exponent) && exponent >= 0 ? exponent : 1.0;
    const safeScaleX = Number.isFinite(scaleX) && scaleX >= 0 ? scaleX : 10.0;
    const safeThreshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : 0.1;
    const safeClamp = Number.isFinite(clampValue) && clampValue >= 0 ? clampValue : 0.5;
    const effectiveExponent = Math.max(0.5, Math.min(1.0, safeExponent));
    const effectiveScaleX = Math.max(1.0, Math.min(100.0, safeScaleX));

    const rawDelta = -Math.pow(safeVariance, effectiveExponent) * effectiveScaleX;
    const clampedRawDelta = Math.max(safeClamp * -1, Math.min(0, rawDelta));
    const symmetricDelta = Math.abs(clampedRawDelta) < safeThreshold ? 0 : clampedRawDelta;
    const effectiveWeight = Math.max(minWeight, Math.min(maxWeight, baselineWeight + symmetricDelta));

    return {
        rawSymmetricDelta: clampedRawDelta,
        symmetricDelta,
        effectiveWeight,
        sellW: effectiveWeight,
        buyW: effectiveWeight,
    };
}

export { computeVolatilityShift }
