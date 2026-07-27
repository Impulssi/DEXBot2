'use strict';

function resolveMaxAsymmetryFactor(primaryValue: any, secondaryValue: any, defaultValue: any) {
    if (Number.isFinite(primaryValue)) return Number(primaryValue);
    if (Number.isFinite(secondaryValue)) return Number(secondaryValue);
    return Number.isFinite(defaultValue) ? Number(defaultValue) : null;
}

function computeAsymmetricBoundsMetrics({
    centerPrice,
    minPrice,
    maxPrice,
    trend,
    slopeOffset,
    maxSlopeOffset,
    maxAsymmetryFactor,
}: any) {
    const gp = Number(centerPrice);
    const minP = Number(minPrice);
    const maxP = Number(maxPrice);
    const slope = Number(slopeOffset);
    const maxSlope = Number(maxSlopeOffset);
    const maxAsym = Number(maxAsymmetryFactor);

    if (!Number.isFinite(slope) || !Number.isFinite(maxSlope) || maxSlope <= 0
            || !Number.isFinite(maxAsym) || maxAsym <= 0
            || (trend !== 'UP' && trend !== 'DOWN')) {
        return {
            rawAsymmetryFactor: null,
            appliedAsymmetryFactor: null,
            maxAsymmetryFactor: Number.isFinite(maxAsym) ? maxAsym : null,
        };
    }

    const slopeAbs = Math.min(Math.abs(slope) / maxSlope, 1);
    const rawAsymmetryFactor = slopeAbs * maxAsym;

    if (!Number.isFinite(gp) || gp <= 0) {
        return {
            rawAsymmetryFactor,
            appliedAsymmetryFactor: rawAsymmetryFactor,
            maxAsymmetryFactor: maxAsym,
        };
    }

    if (!Number.isFinite(minP) || !Number.isFinite(maxP) || minP <= 0 || maxP <= 0) {
        return {
            rawAsymmetryFactor,
            appliedAsymmetryFactor: rawAsymmetryFactor,
            maxAsymmetryFactor: maxAsym,
        };
    }

    const baseMinDiv = gp / minP;
    const baseMaxMult = maxP / gp;
    const maxSafeAsymmetryFactor = trend === 'DOWN'
        ? (baseMaxMult > 1 ? 1 - (1 / baseMaxMult) : 0)
        : (baseMinDiv > 1 ? 1 - (1 / baseMinDiv) : 0);

    return {
        rawAsymmetryFactor,
        appliedAsymmetryFactor: Math.min(rawAsymmetryFactor, maxSafeAsymmetryFactor),
        maxAsymmetryFactor: maxAsym,
    };
}

function applyAsymmetricBounds(params: any) {
    const metrics = computeAsymmetricBoundsMetrics(params);
    const gp = Number(params?.centerPrice);
    const minP = Number(params?.minPrice);
    const maxP = Number(params?.maxPrice);
    const trend = params?.trend;

    let resolvedMinPrice = minP;
    let resolvedMaxPrice = maxP;

    if (Number.isFinite(gp) && gp > 0
            && Number.isFinite(minP) && minP > 0
            && Number.isFinite(maxP) && maxP > 0
            && Number.isFinite(metrics.appliedAsymmetryFactor)
            && (trend === 'UP' || trend === 'DOWN')) {
        const baseMinDiv = gp / minP;
        const baseMaxMult = maxP / gp;
        const asymmetry = metrics.appliedAsymmetryFactor as number;

        if (trend === 'DOWN') {
            resolvedMinPrice = gp / (baseMinDiv * (1 + asymmetry));
            resolvedMaxPrice = gp * (baseMaxMult * (1 - asymmetry));
        } else {
            resolvedMinPrice = gp / (baseMinDiv * (1 - asymmetry));
            resolvedMaxPrice = gp * (baseMaxMult * (1 + asymmetry));
        }
    }

    return {
        ...metrics,
        resolvedMinPrice,
        resolvedMaxPrice,
    };
}

export { resolveMaxAsymmetryFactor, computeAsymmetricBoundsMetrics, applyAsymmetricBounds }

