'use strict';

function formatLogNumber(value: any, digits = 2) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function formatAdaptiveLogNumber(value: any, coarseDigits = 2, fineDigits = 4, fineThreshold = 0.1) {
    if (!Number.isFinite(value)) return 'n/a';
    return Math.abs(Number(value)) < fineThreshold
        ? Number(value).toFixed(fineDigits)
        : Number(value).toFixed(coarseDigits);
}

function formatLogPercent(value: any, digits = 2) {
    return Number.isFinite(value) ? `${Number(value).toFixed(digits)}%` : 'n/a';
}

function formatLogPair(first: any, second: any, digits = 2) {
    return `${formatLogNumber(first, digits)}/${formatLogNumber(second, digits)}`;
}

function formatAmaTuple(ama: any) {
    if (!ama) return 'n/a';
    const erSmoothPeriod = Number.isFinite(Number(ama.erSmoothPeriod)) ? Number(ama.erSmoothPeriod) : 0;
    return `${formatLogNumber(ama.erPeriod, 0)}/${formatLogNumber(ama.fastPeriod, 1)}/${formatLogNumber(ama.slowPeriod, 1)}/es${formatLogNumber(erSmoothPeriod, 0)}`;
}

function formatAsymmetryFactor(value: any, digits = 1) {
    return Number.isFinite(value) ? `${(Number(value) * 100).toFixed(digits)}%` : 'n/a';
}

function buildWeightSummary(weights: any) {
    return weights ? ` weights(sell/buy)=${formatLogPair(weights.sell, weights.buy, 2)}` : '';
}

function buildDynamicWeightInputsLog(meta: any, amaConfig: any) {
    return [
        `ama=${formatAmaTuple(amaConfig)}`,
        `base=${formatLogPair(meta?.staticSell, meta?.staticBuy, 2)}`,
        `clamp=${formatLogPair(meta?.maxSlopeOffset, meta?.maxVolatilityOffset, 2)}`,
        `atr=${formatLogNumber(meta?.atrPeriod, 0)}`,
        `confirm=${Number.isFinite(meta?.signalConfirmBars) ? Math.round(meta.signalConfirmBars) : 'n/a'}`,
    ].join(' | ');
}

function buildDynamicWeightTuningLog(meta: any) {
    return [
        `slopeMax=${formatAdaptiveLogNumber(meta?.amaSlope?.maxSlopePct, 2, 4)}`,
        `kalmanMax=${formatLogNumber(meta?.kalmanSlope?.maxSlopePct, 2)}`,
        `alpha=${formatLogNumber(meta?.alpha, 2)}`,
        `dw=${formatLogNumber(meta?.dw, 2)}`,
        `gain=${formatLogNumber(meta?.gain, 2)}`,
        `vol(thr/exp/x)=${formatLogNumber(meta?.volatilityThreshold, 2)}/${formatLogNumber(meta?.volatilityExponent, 2)}/${formatLogNumber(meta?.volatilityScaleX, 2)}`,
        `clip=${formatLogPercent(meta?.clipPercentile, 0)}`,
        `nz=${formatAdaptiveLogNumber(meta?.neutralZonePct, 2, 4)}`,
        `minOut=${formatLogNumber(meta?.minOutputThreshold, 2)}`,
        `reg(sens/abs)=${formatLogNumber(meta?.regimeSensitivity, 2)}/${formatLogNumber(meta?.absoluteThreshold, 2)}`,
        `kalman(sm/disp/th/span)=${formatLogNumber(meta?.kalmanSmoothPct, 2)}/${formatLogNumber(meta?.kalmanDispScaleMult, 2)}/${formatLogNumber(meta?.kalmanDispThresholdMult, 2)}/${formatLogNumber(meta?.kalmanSmoothSpanPct, 2)}`,
    ].join(' | ');
}

function buildAsymmetricBoundsLog(meta: any) {
    return `raw=${formatAsymmetryFactor(meta?.rawAsymmetryFactor, 2)}, applied=${formatAsymmetryFactor(meta?.appliedAsymmetryFactor, 2)}, maxAsym=${formatAsymmetryFactor(meta?.maxAsymmetryFactor, 0)}`;
}

function buildStartupDefaultsLog(defaultAma: any, defaultConfig: any, marketAdapterCfg: any) {
    return `  defaults: ama=${formatAmaTuple(defaultAma)} | `
        + `weightFallback=${formatLogPair(defaultConfig?.weightDistribution?.sell, defaultConfig?.weightDistribution?.buy, 2)} | `
        + `dynamicBase=explicit-only | `
        + `clamp=${formatLogPair(marketAdapterCfg?.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP, marketAdapterCfg?.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP, 2)} | `
        + `asymCap=${formatAsymmetryFactor(marketAdapterCfg?.ASYMMETRIC_BOUNDS_MAX_ASYMMETRY_FACTOR, 0)}`;
}

export { formatLogPercent, buildWeightSummary, buildDynamicWeightInputsLog, buildDynamicWeightTuningLog, buildAsymmetricBoundsLog, buildStartupDefaultsLog }

