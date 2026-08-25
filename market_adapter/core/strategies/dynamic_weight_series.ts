'use strict';

/**
 * Dynamic weight per-bar series — canonical implementation shared by the live
 * market adapter service, the research test harness, and the browser-embedded
 * dynamic-weight chart script.
 *
 * Computes the per-bar AMA/Kalman offset channels, the alpha-blended combined
 * series, the pre-gain dead-band gate, the final gain/clamp, and the signal
 * confirmation latch — the exact shape both the live `_computeDynamicWeights`
 * and the interactive research chart render.
 *
 * This module is intentionally fully self-contained (no imports): the chart
 * generator embeds its exact source into generated HTML via fn.toString(), so
 * every consumer runs one logic path. The pure helper computeAverageAmaSlopePct
 * is re-exported by strategies/ama_slope_model.ts so Node callers keep their
 * existing import path.
 */

function computeAverageAmaSlopePct(current: any, past: any, lookbackBars: any) {
    const safeLookbackBars = Number.isFinite(lookbackBars) && lookbackBars > 0
        ? Math.ceil(lookbackBars)
        : 1;
    if (!Number.isFinite(current) || !Number.isFinite(past) || past === 0) {
        return null;
    }
    return ((current - past) / past * 100) / safeLookbackBars;
}

function echoLatchSeries(appliedSeries: any[], preGainSeries: any[], confirmBars: any) {
    const n = Array.isArray(appliedSeries) ? appliedSeries.length : 0;
    const echoedAppliedSeries = new Array(n).fill(0);
    const echoedPreGainSeries = new Array(n).fill(0);

    const safeConfirmBars = Math.max(0, Math.min(5, Math.round(confirmBars)));
    if (safeConfirmBars === 0) {
        for (let i = 0; i < n; i++) {
            echoedAppliedSeries[i] = appliedSeries[i];
            echoedPreGainSeries[i] = preGainSeries?.[i];
        }
        return { echoedAppliedSeries, echoedPreGainSeries };
    }

    let latchedSign = 0;
    let pendingSign = 0;
    let pendingCount = 0;
    let latchedOff = 0;
    let latchedGatedOff = 0;
    for (let i = 0; i < n; i++) {
        const raw = appliedSeries[i];
        const sign = raw > 0 ? 1 : raw < 0 ? -1 : 0;
        if (sign === latchedSign) {
            pendingSign = 0;
            pendingCount = 0;
            latchedOff = raw;
            latchedGatedOff = preGainSeries?.[i];
        } else {
            if (pendingSign !== sign) {
                pendingSign = sign;
                pendingCount = 1;
            } else {
                pendingCount++;
            }
            if (pendingCount >= safeConfirmBars) {
                latchedSign = sign;
                pendingSign = 0;
                pendingCount = 0;
                latchedOff = raw;
                latchedGatedOff = preGainSeries?.[i];
            }
        }
        echoedAppliedSeries[i] = latchedOff;
        echoedPreGainSeries[i] = latchedGatedOff;
    }

    return { echoedAppliedSeries, echoedPreGainSeries };
}

function roundToN(value: any, factor: any) {
    if (!Number.isFinite(value)) return NaN;
    return Math.round(value * factor) / factor;
}

function computeDynamicWeightSeries(inputs: any) {
    const {
        amaValues,
        kalmanVelocityPct,
        kalmanDisplacementPct,
        kalmanIsReady,
        regimeMultipliers,
        lookbackBars,
        amaErPeriod,
        amaClipThreshold,
        kalClipThreshold,
        neutralZonePct,
        amaMaxSlopePct,
        kalmanMaxSlopePct,
        offsetClamp,
        dispScaleMinPct,
        alpha,
        dw,
        gain,
        minOutputThreshold,
        signalConfirmBars,
        clampFinalOutput = true,
    } = inputs;

    const n = Array.isArray(amaValues) ? amaValues.length : 0;
    const channelNorm = Math.max(Math.abs(offsetClamp), 1e-9);
    const amaReadyBar = lookbackBars + Math.max(0, Math.ceil(amaErPeriod));
    const amaOffsets = new Array(n).fill(0);
    const kalmanOffsets = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
        if (i < amaReadyBar) continue;
        const last = amaValues[i];
        const past = amaValues[i - lookbackBars];
        const sp = computeAverageAmaSlopePct(last, past, lookbackBars);
        if (sp == null) continue;
        const csp = Math.max(-amaClipThreshold, Math.min(amaClipThreshold, sp));
        // Inclusive dead-band boundary (matches computeAmaSlopeWeights): a
        // slope exactly at neutralZonePct counts as neutral. With the default
        // neutralZonePct of 0 this also keeps exact-zero slopes out of the
        // offset channel.
        if (Math.abs(csp) <= neutralZonePct) continue;
        amaOffsets[i] = Math.max(-offsetClamp, Math.min(offsetClamp, (csp / amaMaxSlopePct) * offsetClamp));
    }

    for (let i = 0; i < n; i++) {
        const vp = kalmanVelocityPct?.[i];
        const dp = kalmanDisplacementPct?.[i];
        if (!kalmanIsReady?.[i] || vp == null || dp == null) continue;
        const clippedV = Math.max(-kalClipThreshold, Math.min(kalClipThreshold, vp));
        if (Math.abs(clippedV) < neutralZonePct) continue;
        const dispScale = Math.max(1e-6, dispScaleMinPct);
        const dispConf = Math.min(Math.abs(dp) / dispScale, 1.0);
        const momAlign = Math.max(0, (clippedV * dp) / (Math.abs(clippedV) * Math.abs(dp) + 1e-10));
        const composite = clippedV * (1 - dw + dw * dispConf * momAlign);
        kalmanOffsets[i] = Math.max(-offsetClamp, Math.min(offsetClamp, (composite / kalmanMaxSlopePct) * offsetClamp));
    }

    const combinedOffSeries = new Array(n).fill(0);
    const gatedOffSeries = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        const blendedOff = (alpha * (amaOffsets[i] / channelNorm) + (1 - alpha) * (kalmanOffsets[i] / channelNorm));
        const regimeAdjusted = blendedOff * (regimeMultipliers?.[i] ?? 1.0);
        const gatedOff = Math.abs(regimeAdjusted) < minOutputThreshold ? 0 : regimeAdjusted;
        const applied = clampFinalOutput
            ? Math.max(-offsetClamp, Math.min(offsetClamp, gatedOff * gain))
            : (gatedOff * gain);
        gatedOffSeries[i] = gatedOff;
        combinedOffSeries[i] = roundToN(applied, 1000);
    }

    const latched = echoLatchSeries(combinedOffSeries, gatedOffSeries, signalConfirmBars);

    return {
        amaOffsets,
        kalmanOffsets,
        combinedOffSeries,
        gatedOffSeries,
        echoedOffSeries: latched.echoedAppliedSeries,
        echoedGatedOffSeries: latched.echoedPreGainSeries,
    };
}

/**
 * Percentile lookup over an already-sorted ascending array. Returns `Infinity`
 * for an empty pool so callers treat it as "no clipping". Both the percentile
 * and the resulting index are clamped so a misconfigured clipPercentile above
 * 100 cannot select a negative (undefined) entry.
 */
function percentileFromSorted(sorted: number[], clipPercentile: number): number {
    if (!Array.isArray(sorted) || sorted.length === 0) return Infinity;
    const pct = Math.min(clipPercentile, 100);
    const idx = Math.max(0, Math.min(Math.floor((100 - pct) / 100 * sorted.length), sorted.length - 1));
    return sorted[idx];
}

/**
 * Canonical AMA slope clip threshold used to bound `rawSlopeOffset` in
 * `computeAmaSlopeWeights` — one logic path shared by the live market adapter
 * service, the research runners, and the browser-embedded chart script.
 *
 * The threshold is the `(100 - clipPercentile)`-th percentile of
 * `|average AMA slope %|` over the AMA history (skipping the ER + lookback
 * warmup window). Returns `Infinity` when clipping is disabled or there is
 * insufficient history.
 *
 * Embedding note: lives in this import-free module so fn.toString() injection
 * into generated research charts stays valid after transpilation.
 *
 * For per-bar research loops prefer {@link createAmaSlopeClipTracker}, which
 * yields identical thresholds while maintaining a single sorted pool
 * incrementally (O(n) per push for the sorted insertion, O(n²) total) instead
 * of re-deriving and re-sorting the whole slope history each bar.
 *
 * @param amaValues   Full AMA series for the cycle.
 * @param erPeriod    AMA ER period (defines the warmup window with lookbackBars).
 * @param lookbackBars Bars averaged per slope sample.
 * @param clipPercentile Percentile to clip at (e.g. 10 → use 90th pct). 0 disables.
 */
function computeAmaSlopeClipThreshold(
    amaValues: any,
    erPeriod: number,
    lookbackBars: number,
    clipPercentile: number,
): number {
    if (!Number.isFinite(clipPercentile) || clipPercentile <= 0) return Infinity;
    if (!Array.isArray(amaValues)) return Infinity;
    const readyBars = Math.ceil(erPeriod) + lookbackBars;
    if (amaValues.length <= readyBars) return Infinity;

    const slopes: number[] = [];
    for (let i = readyBars; i < amaValues.length; i++) {
        const last = amaValues[i];
        const past = amaValues[i - lookbackBars];
        if (!Number.isFinite(last) || !Number.isFinite(past)) continue;
        const s = computeAverageAmaSlopePct(last, past, lookbackBars);
        if (Number.isFinite(s)) slopes.push(Math.abs(s as number));
    }
    if (slopes.length === 0) return Infinity;

    const sorted = slopes.slice().sort((a, b) => a - b);
    // Clamp both the percentile and index: values above 100 would otherwise
    // produce a negative index (undefined threshold -> NaN clip bounds).
    const pct = Math.min(clipPercentile, 100);
    const idx = Math.max(0, Math.min(Math.floor((100 - pct) / 100 * sorted.length), sorted.length - 1));
    return sorted[idx];
}

/**
 * Incremental equivalent of calling {@link computeAmaSlopeClipThreshold} on
 * every growing prefix of the AMA series. Feed exactly one AMA value per bar
 * via `push`; it returns the same threshold the batch function would return
 * for `amaValues.slice(0, consumed)`, without re-deriving the whole slope pool
 * each call. Maintains one sorted pool with binary-search insertion: O(log n)
 * search + O(n) array shift per push, O(n²) total — a constant-factor win over
 * the batch-per-bar loop's O(n² log n), and the same bound at research scale.
 *
 * Non-finite values keep their position in the sequence (they invalidate only
 * the pairs they belong to), matching the batch function's per-pair guards.
 */
function createAmaSlopeClipTracker(erPeriod: number, lookbackBars: number, clipPercentile: number) {
    const enabled = Number.isFinite(clipPercentile) && clipPercentile > 0;
    const readyBars = Math.ceil(erPeriod) + lookbackBars;
    const buffer: number[] = [];
    const sorted: number[] = [];

    return {
        push(value: number): number {
            buffer.push(value);
            if (!enabled) return Infinity;
            const i = buffer.length - 1;
            if (i >= readyBars) {
                const last = buffer[i];
                const past = buffer[i - lookbackBars];
                if (Number.isFinite(last) && Number.isFinite(past)) {
                    const s = computeAverageAmaSlopePct(last, past, lookbackBars);
                    if (Number.isFinite(s)) {
                        const v = Math.abs(s as number);
                        let lo = 0;
                        let hi = sorted.length;
                        while (lo < hi) {
                            const mid = (lo + hi) >> 1;
                            if (sorted[mid] < v) lo = mid + 1; else hi = mid;
                        }
                        sorted.splice(lo, 0, v);
                    }
                }
            }
            return percentileFromSorted(sorted, clipPercentile);
        },
    };
}

export {
    computeDynamicWeightSeries,
    computeAverageAmaSlopePct,
    echoLatchSeries,
    roundToN,
    computeAmaSlopeClipThreshold,
    createAmaSlopeClipTracker,
}
