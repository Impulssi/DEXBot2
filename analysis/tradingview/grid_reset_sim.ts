'use strict';

/**
 * Grid-reset simulation for the TradingView exporter.
 *
 * Replays the market adapter's two grid-recentering triggers over the chart's
 * AMA series, exactly as `market_adapter/core/market_adapter_service.ts`
 * decides them per cycle (see docs/GRID_RECALCULATION.md §3 and §4):
 *
 *   A — AMA price delta (`market_adapter_delta_threshold`): the accepted
 *       center ratchets only when the AMA moves
 *       `|AMA − gridCenterPrice| / gridCenterPrice × 100 >= deltaThresholdPercent`
 *       (`deltaThresholdPercent` in the resolved adapter cfg).
 *
 *   B — AMA slope delta (`market_adapter_ama_slope_delta_threshold`): gated
 *       behind the per-bot `asymmetricBounds` whitelist, fires when
 *       `|slopePct − gridRangeScalingAmaSlope.slopePct| >= amaSlopeThresholdPercent`
 *       (per-bar %, see `buildAmaSlopeResetDetails`).
 *
 * Ratchet semantics (both triggers): on a reset the accepted center moves to
 * the current AMA **and** the accepted slope baseline is re-seeded to the
 * current slope — the `advanceTriggeredBotState` chain in the service. The
 * price trigger is evaluated first and the slope trigger only runs when no
 * price trigger fired in the same bar, matching the service's if/if-else
 * ordering. This is the same model the OHLC backtest uses
 * (analysis/bot_fitting/backtest_bot_fitting.ts, `simulateForParams`).
 *
 * Deliberate scope limits (the chart replays the *decision*, not the runtime):
 *   - one evaluation per 1h bar, no staleness/gap/candle-count suppression
 *     gates (fresh closed candles are the norm in a candle file);
 *   - the accepted center is the value the grid would be built around, so the
 *     simulated range band is frozen between resets and re-tilts from the
 *     accepted slope at every reset;
 *   - the band is a faithful replay of the grid-build *bounds pipeline*
 *     (applyAsymmetricBounds → applyNarrowingSideGuard), but the narrowing
 *     guard is centered on the accepted AMA center rather than the live
 *     market/start price the runtime uses; the gap is bounded by the reset
 *     threshold and only shifts the tightening side by its slot floor;
 *   - RMS divergence, available-funds resizes and manual triggers are not
 *     simulated (out of scope for a candle chart).
 *
 * The functions below are embedded verbatim into the generated HTML via
 * `embedFunctionSources`, so they may only reference module imports that are
 * embedded alongside them (`computeAverageAmaSlopePct`,
 * `createAmaSlopeClipTracker`, `percentileFromSorted`, `clamp`).
 */

import {
    computeAverageAmaSlopePct,
    createAmaSlopeClipTracker,
} from '../../market_adapter/core/strategies/dynamic_weight_series.js';
import { clamp } from '../../modules/order/utils/math.js';


// Reset reason codes. NONE = the accepted center is carried over unchanged
// (this is the vast majority of bars); the other three are the runtime's
// trigger reasons from docs/GRID_RECALCULATION.md.
const GRID_RESET_NONE = 0;
const GRID_RESET_BOOTSTRAP = 1;
const GRID_RESET_PRICE = 2;
const GRID_RESET_SLOPE = 3;

// Prefixed helpers: these run inside the generated page, where every embedded
// function shares one scope with the chart's own code.
function gridSimPositiveNumber(value: any, fallback: any) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function gridSimNonNegativeInt(value: any, fallback: any) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : fallback;
}

/**
 * Average AMA slope in %/bar plus the trend/offset the grid build would use
 * for that bar, mirroring `computeAmaSlopeWeights` steps 2b–3 (percentile clip
 * → neutral zone → trend → slopeOffset). The delta trigger itself compares the
 * UNCLIPPED `slopePct`; the clipped value only feeds the range tilt.
 */
function gridSimSlopeSignal(slopePct: any, clipThreshold: any, cfg: any) {
    const maxSlopePct = gridSimPositiveNumber(cfg?.maxSlopePct, 0.09);
    const neutralZonePct = Number.isFinite(Number(cfg?.neutralZonePct)) ? Number(cfg.neutralZonePct) : 0;
    const maxSlopeOffset = gridSimPositiveNumber(cfg?.maxSlopeOffset, 0.5);
    // null/undefined/NaN all mean "no slope this bar" (computeAmaSlopeWeights'
    // notReady path), never a real 0 %/bar slope.
    if (slopePct == null || !Number.isFinite(Number(slopePct))) {
        return { slopePct: null, clippedSlopePct: null, trend: null, slopeOffset: 0 };
    }
    const slope = Number(slopePct);
    const bound = Number.isFinite(Number(clipThreshold)) ? Number(clipThreshold) : Infinity;
    const clipped = Math.max(-bound, Math.min(bound, slope));
    // Inclusive boundary (<=) matches ama_slope_model so an exact-zero slope
    // stays NEUTRAL instead of flipping to DOWN.
    if (Math.abs(clipped) <= neutralZonePct) {
        return { slopePct: slope, clippedSlopePct: clipped, trend: null, slopeOffset: 0 };
    }
    const trend = clipped > 0 ? 'UP' : 'DOWN';
    return {
        slopePct: slope,
        clippedSlopePct: clipped,
        trend,
        slopeOffset: clamp(clipped / maxSlopePct, -1, 1) * maxSlopeOffset,
    };
}

/**
 * Replay the two market-adapter grid-recentering triggers over `amaSeries`
 * (the chart's 1h AMA series, already in display orientation).
 *
 * @param {Array<number|null>} amaSeries
 * @param {Object} cfg  Resolved sim config (see resolveGridResetSimConfig):
 *   priceDeltaThresholdPercent, slopeDeltaThresholdPercent, slopeEnabled,
 *   erPeriod, warmupBars, lookbackBars, maxSlopePct, neutralZonePct,
 *   maxSlopeOffset, clipPercentile, clampMin, clampMax.
 * @returns per-bar series (same length as `amaSeries`) + `events` + `stats`.
 */
function simulateGridResetSeries(amaSeries: any, cfg: any) {
    const n = Array.isArray(amaSeries) ? amaSeries.length : 0;
    const priceThreshold = Number(cfg?.priceDeltaThresholdPercent);
    const priceTriggerArmed = Number.isFinite(priceThreshold) && priceThreshold > 0;
    const slopeThreshold = Number(cfg?.slopeDeltaThresholdPercent);
    // Trigger B is double-gated in production: the asymmetricBounds whitelist
    // AND a usable threshold (explicit per-bar % or the maxSlopePct factor).
    const slopeTriggerArmed = cfg?.slopeEnabled === true
        && Number.isFinite(slopeThreshold)
        && slopeThreshold > 0;
    const erPeriod = gridSimNonNegativeInt(cfg?.erPeriod, 1);
    const lookbackBars = gridSimNonNegativeInt(cfg?.lookbackBars, 0);
    const warmupBars = gridSimNonNegativeInt(cfg?.warmupBars, 0);
    const clipPercentile = Number(cfg?.clipPercentile);
    const clampMinValue = Number(cfg?.clampMin);
    const clampMaxValue = Number(cfg?.clampMax);
    // Mirrors clampGridPriceToBounds: only absolute bot bounds pin the center,
    // and each side binds independently (a mixed absolute/"Nx" config clamps
    // only on the absolute side).
    const hasClampMin = Number.isFinite(clampMinValue) && clampMinValue > 0;
    const hasClampMax = Number.isFinite(clampMaxValue) && clampMaxValue > 0;
    const hasClamp = hasClampMin || hasClampMax;

    const center = new Array(n).fill(null);
    const reason = new Array(n).fill(GRID_RESET_NONE);
    const driftPct = new Array(n).fill(null);
    const slopePctSeries = new Array(n).fill(null);
    const slopeDeltaPct = new Array(n).fill(null);
    const acceptedSlopePct = new Array(n).fill(null);
    const acceptedSlopeOffset = new Array(n).fill(null);
    const acceptedTrend = new Array(n).fill(null);
    const events: any[] = [];

    if (n === 0) {
        return {
            center,
            reason,
            driftPct,
            slopePct: slopePctSeries,
            slopeDeltaPct,
            acceptedSlopePct,
            acceptedSlopeOffset,
            acceptedTrend,
            events,
            stats: {
                bars: 0,
                resets: 0,
                resetsTotal: 0,
                priceResets: 0,
                slopeResets: 0,
                bootstrapIndex: null,
                lastResetIndex: null,
                barsSinceLastReset: 0,
                avgBarsBetweenResets: null,
                warmupBars,
                priceDeltaThresholdPercent: priceTriggerArmed ? priceThreshold : null,
                slopeDeltaThresholdPercent: slopeTriggerArmed ? slopeThreshold : null,
                slopeTriggerArmed,
            },
        };
    }

    const clipTracker = createAmaSlopeClipTracker(erPeriod, lookbackBars, clipPercentile);
    const readyBars = erPeriod + lookbackBars;
    let acceptedCenter: number | null = null;
    let acceptedSlope: number | null = null;
    let acceptedOffset = 0;
    let acceptedDir: string | null = null;
    let lastResetIndex: number | null = null;
    let resetCount = 0;
    let priceResets = 0;
    let slopeResets = 0;

    for (let i = 0; i < n; i++) {
        const ama = Number(amaSeries[i]);
        const hasAma = Number.isFinite(ama) && ama > 0;
        // Feed the clip tracker every bar (non-finite values keep their slot,
        // exactly like the batch threshold). The chart's AMA is computed over
        // the full candle file, so a growing-prefix percentile is the clip
        // analogue of that full-history series; the production adapter instead
        // recomputes the percentile each cycle over its retained warmup window.
        // Either way the trigger compares the UNCLIPPED slope, so this affects
        // only the range tilt, never reset timing.
        const clipThreshold = clipTracker.push(hasAma ? ama : NaN);
        let slopePct: number | null = null;
        if (i >= readyBars) {
            const past = Number(amaSeries[i - lookbackBars]);
            if (hasAma && Number.isFinite(past) && past !== 0) {
                const s = computeAverageAmaSlopePct(ama, past, lookbackBars);
                if (Number.isFinite(s)) slopePct = s;
            }
        }
        slopePctSeries[i] = slopePct;

        // Bars before AMA warmup carry no accepted state (the adapter keeps
        // only post-warmup candles, so it has no center to drift from yet).
        if (!hasAma || i < warmupBars) {
            // A bar without a usable AMA cannot trigger anything, but the
            // accepted state still carries over — otherwise the step line and
            // the band would show a hole at every non-finite bar.
            if (acceptedCenter != null) {
                center[i] = acceptedCenter;
                acceptedSlopePct[i] = acceptedSlope;
                acceptedSlopeOffset[i] = acceptedOffset;
                acceptedTrend[i] = acceptedDir;
            }
            continue;
        }

        const signal = gridSimSlopeSignal(slopePct, clipThreshold, cfg);
        // The runtime measures drift against the CLAMPED current center
        // (`clampGridPriceToBounds`), not the raw AMA. With absolute bot bounds
        // this pins the center at the bound, so drift collapses to zero instead
        // of growing without limit — and the grid does not re-reset every bar
        // while the AMA sits outside the configured range.
        const currentCenter = hasClamp
            ? Math.min(hasClampMax ? clampMaxValue : Infinity, Math.max(hasClampMin ? clampMinValue : -Infinity, ama))
            : ama;
        if (acceptedCenter != null) {
            driftPct[i] = Math.abs((currentCenter - acceptedCenter) / acceptedCenter) * 100;
            if (slopePct != null && acceptedSlope != null) {
                slopeDeltaPct[i] = Math.abs(slopePct - acceptedSlope);
            }
        }

        let fired = GRID_RESET_NONE;
        if (acceptedCenter == null) {
            // No accepted center yet = the adapter's initial AMA snapshot
            // (`market_adapter_bootstrap`): accept, persist, and trigger once.
            fired = GRID_RESET_BOOTSTRAP;
        } else if (priceTriggerArmed && driftPct[i] >= priceThreshold) {
            fired = GRID_RESET_PRICE;
        } else if (slopeTriggerArmed && slopeDeltaPct[i] != null && slopeDeltaPct[i] >= slopeThreshold) {
            fired = GRID_RESET_SLOPE;
        }

        if (fired !== GRID_RESET_NONE) {
            const previousCenter = acceptedCenter;
            acceptedCenter = currentCenter;
            // Re-seed the accepted slope on EVERY reset (price and slope alike),
            // mirroring advanceTriggeredBotState's `amaSlope || previous` chain.
            if (signal.slopePct != null) {
                acceptedSlope = signal.slopePct;
                acceptedOffset = signal.slopeOffset;
                acceptedDir = signal.trend;
            }
            reason[i] = fired;
            resetCount++;
            if (fired === GRID_RESET_PRICE) priceResets++;
            if (fired === GRID_RESET_SLOPE) slopeResets++;
            events.push({
                index: i,
                reason: fired,
                center: acceptedCenter,
                previousCenter,
                deltaPct: driftPct[i],
                slopePct: signal.slopePct,
                slopeDeltaPct: slopeDeltaPct[i],
                acceptedSlopePct: acceptedSlope,
                acceptedSlopeOffset: acceptedOffset,
                acceptedTrend: acceptedDir,
            });
            lastResetIndex = i;
        }

        center[i] = acceptedCenter;
        acceptedSlopePct[i] = acceptedSlope;
        acceptedSlopeOffset[i] = acceptedOffset;
        acceptedTrend[i] = acceptedDir;
    }

    const resetIndices = events.map((e: any) => e.index);
    const gaps: number[] = [];
    for (let k = 1; k < resetIndices.length; k++) gaps.push(resetIndices[k] - resetIndices[k - 1]);

    return {
        center,
        reason,
        driftPct,
        slopePct: slopePctSeries,
        slopeDeltaPct,
        acceptedSlopePct,
        acceptedSlopeOffset,
        acceptedTrend,
        events,
        stats: {
            bars: n,
            // The bootstrap is not a delta reset: report resets without it so
            // "how often does this grid recenter" stays honest.
            resets: resetCount - (events.length > 0 ? 1 : 0),
            resetsTotal: resetCount,
            priceResets,
            slopeResets,
            bootstrapIndex: resetIndices.length > 0 ? resetIndices[0] : null,
            lastResetIndex,
            barsSinceLastReset: lastResetIndex == null ? null : (n - 1 - lastResetIndex),
            avgBarsBetweenResets: gaps.length > 0 ? (gaps.reduce((a: any, b: any) => a + b, 0) / gaps.length) : null,
            warmupBars,
            priceDeltaThresholdPercent: priceTriggerArmed ? priceThreshold : null,
            slopeDeltaThresholdPercent: slopeTriggerArmed ? slopeThreshold : null,
            slopeTriggerArmed,
        },
    };
}

export {
    simulateGridResetSeries,
    gridSimSlopeSignal,
    gridSimPositiveNumber,
    gridSimNonNegativeInt,
    GRID_RESET_NONE,
    GRID_RESET_BOOTSTRAP,
    GRID_RESET_PRICE,
    GRID_RESET_SLOPE,
}
