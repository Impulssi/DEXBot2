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
    const amaReadyBar = Math.max(lookbackBars, Math.ceil(amaErPeriod) + lookbackBars);
    const amaOffsets = new Array(n).fill(0);
    const kalmanOffsets = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
        if (i < amaReadyBar) continue;
        const last = amaValues[i];
        const past = amaValues[i - lookbackBars];
        const sp = computeAverageAmaSlopePct(last, past, lookbackBars);
        if (sp == null) continue;
        const csp = Math.max(-amaClipThreshold, Math.min(amaClipThreshold, sp));
        if (Math.abs(csp) < neutralZonePct) continue;
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

export { computeDynamicWeightSeries, computeAverageAmaSlopePct, echoLatchSeries, roundToN }
