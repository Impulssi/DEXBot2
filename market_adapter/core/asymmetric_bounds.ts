'use strict';

function resolveMaxAsymmetryFactor(primaryValue: any, secondaryValue: any, defaultValue: any) {
    if (Number.isFinite(primaryValue)) return Number(primaryValue);
    if (Number.isFinite(secondaryValue)) return Number(secondaryValue);
    return Number.isFinite(defaultValue) ? Number(defaultValue) : null;
}

/**
 * Base grid-range ratios relative to the center price. Shared by the metrics
 * (safe-asymmetry cap) and the bounds application math so both stay consistent:
 *   baseMinDiv = gp / minP  → DOWN-side safe factor is 1 − 1/baseMinDiv
 *   baseMaxMult = maxP / gp → UP-side   safe factor is 1 − 1/baseMaxMult
 */
function resolveBaseBounds(centerPrice: any, minPrice: any, maxPrice: any) {
    const gp = Number(centerPrice);
    const minP = Number(minPrice);
    const maxP = Number(maxPrice);
    if (!Number.isFinite(gp) || gp <= 0
            || !Number.isFinite(minP) || minP <= 0
            || !Number.isFinite(maxP) || maxP <= 0) {
        return null;
    }
    return { gp, baseMinDiv: gp / minP, baseMaxMult: maxP / gp };
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

    const baseBounds = resolveBaseBounds(centerPrice, minPrice, maxPrice);
    if (!baseBounds) {
        return {
            rawAsymmetryFactor,
            appliedAsymmetryFactor: rawAsymmetryFactor,
            maxAsymmetryFactor: maxAsym,
        };
    }

    const { baseMinDiv, baseMaxMult } = baseBounds;
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
    const trend = params?.trend;

    let resolvedMinPrice = Number(params?.minPrice);
    let resolvedMaxPrice = Number(params?.maxPrice);

    if (Number.isFinite(metrics.appliedAsymmetryFactor)
            && (trend === 'UP' || trend === 'DOWN')) {
        const baseBounds = resolveBaseBounds(params?.centerPrice, params?.minPrice, params?.maxPrice);
        if (baseBounds) {
            const { gp, baseMinDiv, baseMaxMult } = baseBounds;
            const asymmetry = metrics.appliedAsymmetryFactor as number;

            if (trend === 'DOWN') {
                resolvedMinPrice = gp / (baseMinDiv * (1 + asymmetry));
                resolvedMaxPrice = gp * (baseMaxMult * (1 - asymmetry));
            } else {
                resolvedMinPrice = gp / (baseMinDiv * (1 - asymmetry));
                resolvedMaxPrice = gp * (baseMaxMult * (1 + asymmetry));
            }
        }
    }

    return {
        ...metrics,
        resolvedMinPrice,
        resolvedMaxPrice,
    };
}

export { resolveMaxAsymmetryFactor, computeAsymmetricBoundsMetrics, applyAsymmetricBounds }

