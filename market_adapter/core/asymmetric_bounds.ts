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

/**
 * Narrowing-side slot guard: range scaling tightens one bound toward the
 * center. Without a floor this can collapse that side into a near-center
 * sliver holding few or zero active orders. Guarantees at least
 * minScaleSlots price levels remain between the grid center and the
 * tightened bound (in multiples of incrementPercent). The widened side
 * still extends freely. Self-contained (no imports) so chart generators can
 * embed its exact source via fn.toString() instead of a hand copy.
 */
function applyNarrowingSideGuard(params: {
    centerPrice: unknown;
    minPrice: number | null | undefined;
    maxPrice: number | null | undefined;
    trend: unknown;
    incrementPercent: unknown;
    minScaleSlots: unknown;
}): { minPrice: number | null | undefined; maxPrice: number | null | undefined; held: 'min' | 'max' | null } {
    let resolvedMinPrice = params.minPrice;
    let resolvedMaxPrice = params.maxPrice;
    let held: 'min' | 'max' | null = null;
    const gridStartPrice = Number(params.centerPrice);
    const inc = Number(params.incrementPercent);
    const mss = Number.isFinite(Number(params.minScaleSlots)) ? Math.floor(Number(params.minScaleSlots)) : 0;
    if ((params.trend === 'UP' || params.trend === 'DOWN')
            && Number.isFinite(gridStartPrice) && gridStartPrice > 0
            && Number.isFinite(inc) && inc > 0 && mss > 0) {
        const stepMult = 1 + (inc / 100);
        if (params.trend === 'DOWN' && resolvedMaxPrice != null) {
            const keepAbove = gridStartPrice * Math.pow(stepMult, mss);
            if (resolvedMaxPrice < keepAbove) {
                resolvedMaxPrice = keepAbove;
                held = 'max';
            }
        } else if (params.trend === 'UP' && resolvedMinPrice != null) {
            const belowMin = gridStartPrice * Math.pow(1 - (inc / 100), mss);
            if (resolvedMinPrice > belowMin) {
                resolvedMinPrice = belowMin;
                held = 'min';
            }
        }
    }
    return { minPrice: resolvedMinPrice, maxPrice: resolvedMaxPrice, held };
}

export { resolveMaxAsymmetryFactor, computeAsymmetricBoundsMetrics, applyAsymmetricBounds, applyNarrowingSideGuard, resolveBaseBounds }

