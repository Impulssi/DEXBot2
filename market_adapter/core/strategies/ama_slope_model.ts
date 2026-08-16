
import { clamp } from '../../../modules/order/utils/math.js';
import { MARKET_ADAPTER } from '../../../modules/constants.js';
import { roundTo } from '../../../modules/utils/math_utils.js';
import {
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
} from '../config_normalizers.js';
import { computeVolatilityShift } from './volatility_shift.js';
// Canonical AMA slope % lives in dynamic_weight_series.ts (self-contained so the
// chart generators can embed its exact source); re-exported here for compat.
import { computeAverageAmaSlopePct } from './dynamic_weight_series.js';



const _DEFAULT_AMA_KEY = MARKET_ADAPTER.DEFAULT_AMA_KEY as keyof typeof MARKET_ADAPTER.AMAS;
const DEFAULT_ER_PERIOD = MARKET_ADAPTER.AMAS[_DEFAULT_AMA_KEY].erPeriod;

/**
 * Compute AMA slope and volatility offsets from the AMA series.
 *
 * Two independent additive factors:
 *   slopeOffset (asymmetric): AMA slope magnitude → trend direction
 *   symmetricDelta (symmetric): ATR/price ratio → noise level
 *
 * @param {number[]} amaValues           Full AMA series (output of calculateAMA)
 * @param {number}   weightVariance      ATR(period) / amaPrice  (0 = no volatility)
 * @param {Object}   [opts]              Market-reading tuning — no offset bounds here
 * @param {number}   [opts.lookbackBars=MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS]  Bars to look back for slope
 * @param {number}   [opts.maxSlopePct=MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT]  Average per-bar slope % that saturates slopeOffset
 * @param {number}   [opts.neutralZonePct=MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT]  Dead-band around zero average slope
 * @param {number}   [opts.volatilityExponent=1.0]      Exponent for ATR-based penalty
 * @param {number}   [opts.volatilityScaleX=10.0]       Scale factor penalty (10.0 = normal start)
 * @param {number}   [opts.volatilityThreshold=0.1]      Minimum |symmetricDelta| before penalty applies
 * @param {number}   [opts.erPeriod=DEFAULT_ER_PERIOD]  AMA warm-up bars to skip in isReady guard
 * @param {number}   [opts.slowPeriod=DEFAULT_SLOW_PERIOD]  AMA slow period used for warm-up guard
 * @param {number}   [opts.fastPeriod=DEFAULT_FAST_PERIOD]  AMA fast period used for warm-up guard
 * @param {number}   [opts.maxSlopeOffset=MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP]  Per-bot cap on buy/sell asymmetry offset
 * @param {number}   [opts.maxVolatilityOffset=MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP]  Per-bot cap on volatility shift
 * @param {number}   [opts.clipPercentile=0]             Percentile clip on slope (0=off, 10=clip top 10%)
 * @param {number}   [opts.clipThreshold]                Pre-computed clip threshold from slope history
 * @returns {{ slopeOffset, rawSlopeOffset, symmetricDelta, slopePct, clippedSlopePct, confidence, trend, isReady }}
 */
function computeAmaSlopeWeights(amaValues: any, weightVariance: any, opts: any = {}) {
    const lookbackBars = Number.isFinite(opts.lookbackBars) && opts.lookbackBars >= 0
        ? Math.ceil(opts.lookbackBars)
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS;
    const maxSlopePct = opts.maxSlopePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT;
    const neutralZonePct = opts.neutralZonePct ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT;
    const volatilityExponent = opts.volatilityExponent ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const volatilityScaleX = opts.volatilityScaleX ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;
    const volatilityThreshold = normalizeVolatilityThreshold(opts.volatilityThreshold);
    const erPeriod = Number.isFinite(opts.erPeriod) && opts.erPeriod > 0
        ? Math.ceil(opts.erPeriod)
        : DEFAULT_ER_PERIOD;
    const maxSlopeOffset = opts.maxSlopeOffset ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_ASYMMETRIC_OFFSET_CLAMP;
    const maxVolatilityOffset = normalizeMaxVolatilityOffset(opts.maxVolatilityOffset);
    const clipThreshold = opts.clipThreshold ?? Infinity;
    const hasDirectionalOffset = Number.isFinite(maxSlopeOffset) && maxSlopeOffset > 0;
    const safeWeightVariance = Number.isFinite(weightVariance) && weightVariance > 0 ? weightVariance : 0;
    const safeVolatilityExponent = Number.isFinite(volatilityExponent) && volatilityExponent >= 0
        ? volatilityExponent
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_EXPONENT;
    const safeVolatilityScaleX = Number.isFinite(volatilityScaleX) && volatilityScaleX >= 0
        ? volatilityScaleX
        : MARKET_ADAPTER.DYNAMIC_WEIGHT_VOLATILITY_SCALE_X_DEFAULT;

    const notReady = {
        isReady: false,
        slopeOffset: 0,
        symmetricDelta: 0,
        slopePct: 0,
        clippedSlopePct: 0,
        confidence: 0,
        trend: 'NEUTRAL',
    };

    // 1. Guard: need ER window + lookback + current bar for valid slope.
    if (!Array.isArray(amaValues) || amaValues.length < erPeriod + lookbackBars + 1) {
        return notReady;
    }

    const N = amaValues.length;
    const last = amaValues[N - 1];
    const past = amaValues[N - 1 - lookbackBars];

    if (!Number.isFinite(last) || !Number.isFinite(past) || past === 0) {
        return notReady;
    }

    // 2. Average slope percent per bar over the lookback window. This keeps
    // lookback as a smoothing/lag knob instead of adding gain in sustained trends.
    const slopePct = computeAverageAmaSlopePct(last, past, lookbackBars);
    if (!Number.isFinite(slopePct)) {
        return notReady;
    }

    // 2b. Percentile clip — symmetric clip on slope magnitude
    const clippedSlopePct = Math.max(-(clipThreshold as number), Math.min((clipThreshold as number), slopePct as number));

    // 3. Slope offset (asymmetric) — based on clipped slope
    let slopeOffset;
    let trend;
    if (Math.abs(clippedSlopePct) <= neutralZonePct) {
        slopeOffset = 0;
        trend = 'NEUTRAL';
    } else {
        slopeOffset = clamp(clippedSlopePct / maxSlopePct, -1, 1) * maxSlopeOffset;
        trend = clippedSlopePct > 0 ? 'UP' : 'DOWN';
    }

    // 4. Confidence derived from slope offset magnitude (0–100)
    const roundedSlopeOffset = roundTo(slopeOffset, 100);
    const confidence = hasDirectionalOffset
        ? Math.round((Math.abs(slopeOffset) / maxSlopeOffset) * 100)
        : 0;

    // 5. Volatility penalty — symmetric downward shift from ATR/price ratio.
    //    Canonical implementation shared with the volatility research tool and
    //    the browser-embedded chart scripts (see strategies/volatility_shift.ts).
    const shift = computeVolatilityShift(safeWeightVariance, {
        exponent: safeVolatilityExponent,
        scaleX: safeVolatilityScaleX,
        threshold: volatilityThreshold,
        clampValue: maxVolatilityOffset,
    });

    const roundedSymmetricDelta = (roundTo(shift.symmetricDelta, 100)) || 0;

    return {
        slopeOffset: roundedSlopeOffset,
        rawSlopeOffset: slopeOffset,
        symmetricDelta: roundedSymmetricDelta,
        slopePct,
        clippedSlopePct,
        confidence,
        trend,
        isReady: true,
    };
}

export { computeAmaSlopeWeights, computeAverageAmaSlopePct }

