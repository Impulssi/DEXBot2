/**
 * Position Health Assessment
 *
 * Evaluates collateral ratio zones and trend alignment for open positions.
 * Consumes position state from PositionManager and trend signals from
 * TrendAnalyzer to produce actionable health assessments.
 */


import { CR_ZONES } from '../../modules/constants.js';
import { roundToDecimals } from '../../modules/utils/math_utils.js';
'use strict';


const DEFAULT_PRICE_RANGE_RATIO = 3.0;

/**
 * Classify a collateral ratio into a zone.
 *
 * @param {number|null} cr – Collateral ratio (e.g. 2.1)
 * @returns {Object} { zone, label, status, cr }
 */
function classifyCrZone(cr: any) {
  if (!Number.isFinite(cr) || cr <= 0) {
    return { zone: 'unknown', label: 'unknown', status: 'no_data', cr: null };
  }
  if (cr >= CR_ZONES.RED_HIGH) {
    return { zone: 'red_high', label: 'red_high', status: 'over_collateralized', cr };
  }
  if (cr >= CR_ZONES.RED_LOW) {
    return { zone: 'green', label: 'green', status: 'safe', cr };
  }
  return { zone: 'red_low', label: 'red_low', status: 'not_acceptable', cr };
}

/**
 * Check if a position's direction is aligned with a trend signal.
 *
 * @param {string} positionSide – 'short' or 'long'
 * @param {string} trend        – 'UP', 'DOWN', or 'NEUTRAL'
 * @returns {string} 'aligned' | 'opposed' | 'neutral'
 */
function checkTrendAlignment(positionSide: string, trend: string) {
  if (trend === 'NEUTRAL') return 'neutral';
  if (positionSide === 'short' && trend === 'DOWN') return 'aligned';
  if (positionSide === 'short' && trend === 'UP') return 'opposed';
  if (positionSide === 'long' && trend === 'UP') return 'aligned';
  if (positionSide === 'long' && trend === 'DOWN') return 'opposed';
  return 'neutral';
}

/**
 * Assess the health of a position.
 *
 * @param {Object} position      – Position object from PositionManager
 * @param {Object} [trendSignal] – Optional { trend, confidence, premium } from a trend analyzer
 * @returns {Object} Health assessment
 */
function assessPosition(position: any, trendSignal: Record<string, any> | null = null) {
  const cr = position?.onChain?.collateralRatio ?? null;
  const crZone = classifyCrZone(cr);
  const status = position?.status || 'unknown';
  const hasDebt = (position?.onChain?.debtAmount || 0) > 0;

  const assessment: Record<string, any> = {
    positionId: position?.id || null,
    status,
    hasDebt,
    collateral: {
      ratio: cr,
      zone: crZone.zone,
      zoneStatus: crZone.status,
    },
    actions: [],
  };

  // CR zone actions — only red zones (over/under collateralized) trigger action
  if (hasDebt) {
    if (crZone.zone === 'red_low') {
      assessment.actions.push({
        priority: 'immediate',
        action: 'reduce_debt',
        reason: `CR below ${CR_ZONES.RED_LOW} — reduce debt to restore CR (layer 1)`,
      });
      assessment.actions.push({
        priority: 'fallback',
        action: 'add_collateral',
        reason: `CR below ${CR_ZONES.RED_LOW} — add collateral if debt reduction insufficient (layer 2)`,
      });
    } else if (crZone.zone === 'red_high') {
      assessment.actions.push({
        priority: 'immediate',
        action: 'increase_debt',
        reason: `CR above ${CR_ZONES.RED_HIGH} — increase debt to put capital to work (layer 1)`,
      });
      assessment.actions.push({
        priority: 'fallback',
        action: 'withdraw_collateral',
        reason: `CR above ${CR_ZONES.RED_HIGH} — withdraw collateral if debt increase insufficient (layer 2)`,
      });
    }
  }

  // Trend alignment (only for positions with debt = short positions)
  if (trendSignal && hasDebt) {
    const alignment = checkTrendAlignment('short', trendSignal.trend);
    assessment.trend = {
      signal: trendSignal.trend,
      confidence: trendSignal.confidence || 0,
      alignment,
      premium: trendSignal.premium || null,
    };

    if (alignment === 'opposed' && trendSignal.confidence >= 50) {
      assessment.actions.push({
        priority: 'evaluate',
        action: 'review_direction',
        reason: `Position opposed to ${trendSignal.trend} trend (confidence ${trendSignal.confidence}%)`,
      });
    }
  }

  return assessment;
}

/**
 * Assess all positions from a PositionManager state.
 *
 * @param {Array}  positions     – Array of position objects
 * @param {Object} [trendSignal] – Optional trend signal to apply to all
 * @returns {Array} Array of health assessments
 */
function assessAllPositions(positions: any[], trendSignal: Record<string, any> | null = null) {
  return (positions || []).map((p) => assessPosition(p, trendSignal));
}

/**
 * Parse a ratio value from a string (e.g. "3x") or numeric price ratio.
 * Returns null if the value cannot be parsed.
 */
function parseRatioValue(value: any, referencePrice: any, mode: string) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)x$/i);
    if (match) {
      const ratio = Number(match[1]);
      return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
    }
  }

  const numeric = Number(value);
  const reference = Number(referencePrice);
  if (!Number.isFinite(numeric) || numeric <= 0 || !Number.isFinite(reference) || reference <= 0) {
    return null;
  }
  return mode === 'min' ? reference / numeric : numeric / reference;
}

/**
 * Format a numeric ratio as a human-readable multiplier string (e.g. 3.00x).
 */
function formatRatioAsMultiplier(ratio: any) {
  const rounded = roundToDecimals(ratio, 2);
  return `${rounded}x`;
}

/**
 * Classify a price range ratio into a descriptive category.
 * Categories: very_competitive (< 2), competitive (2–3), conservative (3–3.25), very_conservative (> 3.25).
 */
function classifyPriceRangeRatio(ratio: any) {
  const numeric = Number(ratio);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 'unknown';
  }
  if (numeric < 2) {
    return 'very_competitive';
  }
  if (numeric < 3) {
    return 'competitive';
  }
  if (numeric <= 3.25) {
    return 'conservative';
  }
  return 'very_conservative';
}

/**
 * Resolve the current price range ratio from bot config, with optional override via options.currentPriceRangeRatio.
 * Returns the symmetric/asymmetric ratio along with min and max components.
 */
function resolveCurrentPriceRangeRatio(botConfig: Record<string, any> = {}, referencePrice: any, options: Record<string, any> = {}) {
  const forced = Number(options.currentPriceRangeRatio);
  if (Number.isFinite(forced) && forced > 0) {
    return {
      isSymmetric: true,
      maxRatio: forced,
      minRatio: forced,
      ratio: forced
    };
  }

  const minRatio = parseRatioValue(botConfig.minPrice, referencePrice, 'min');
  const maxRatio = parseRatioValue(botConfig.maxPrice, referencePrice, 'max');
  const ratioCandidates: number[] = [minRatio, maxRatio].filter((value: any): value is number => Number.isFinite(value) && value > 0);
  const ratio = ratioCandidates.length > 0 ? Math.max(...ratioCandidates) : DEFAULT_PRICE_RANGE_RATIO;

  return {
    isSymmetric: Number.isFinite(minRatio) && Number.isFinite(maxRatio) && Math.abs((minRatio || 0) - (maxRatio || 0)) < 0.05,
    maxRatio: maxRatio ?? null,
    minRatio: minRatio ?? null,
    ratio
  };
}

/**
 * Compute a recommended price range ratio plan based on observed historical price action.
 * Compares the current ratio against observed min/max prices and returns a recommended
 * ratio with headroom and touch-expansion factors.
 */
function computePriceRangeRatioPlan(botConfig: Record<string, any> = {}, options: Record<string, any> = {}) {
  const referencePrice = Number(options.referencePrice);
  const current = resolveCurrentPriceRangeRatio(botConfig, referencePrice, options);
  const rangeContext = options.rangeContext && typeof options.rangeContext === 'object' ? options.rangeContext : {};
  const observedMinPrice = Number(rangeContext.observedMinPrice);
  const observedMaxPrice = Number(rangeContext.observedMaxPrice);
  const touchCount = Math.max(0, Number(rangeContext.boundTouchCount || 0));
  const headroomFactor = Number.isFinite(Number(options.priceRangeHeadroomFactor))
    ? Math.max(1, Number(options.priceRangeHeadroomFactor))
    : 1.1;
  const touchExpansionFactor = 1 + Math.min(touchCount, 5) * 0.025;
  const minRatio = Number.isFinite(Number(options.minPriceRangeRatio))
    ? Math.max(1.05, Number(options.minPriceRangeRatio))
    : 1.25;
  const maxRatio = Number.isFinite(Number(options.maxPriceRangeRatio))
    ? Math.max(minRatio, Number(options.maxPriceRangeRatio))
    : 6.0;
  const minRangeRatioDelta = Number.isFinite(Number(options.minRangeRatioDelta))
    ? Math.max(0, Number(options.minRangeRatioDelta))
    : 0.25;

  let observedRatio: number | null = null;
  if (
    Number.isFinite(referencePrice) &&
    referencePrice > 0 &&
    Number.isFinite(observedMinPrice) &&
    observedMinPrice > 0 &&
    Number.isFinite(observedMaxPrice) &&
    observedMaxPrice > 0
  ) {
    observedRatio = Math.max(referencePrice / observedMinPrice, observedMaxPrice / referencePrice);
  }

  const recommendedRatio = observedRatio !== null && Number.isFinite(observedRatio)
    ? Math.min(maxRatio, Math.max(minRatio, observedRatio * headroomFactor * touchExpansionFactor))
    : current.ratio;
  const roundedRecommendedRatio = roundToDecimals(recommendedRatio, 2);
  const ratioDelta = roundToDecimals(roundedRecommendedRatio - current.ratio, 2);
  const shouldUpdate = Math.abs(ratioDelta) >= minRangeRatioDelta;
  let reason = 'keep_existing_range_ratio';
  if (!Number.isFinite(observedRatio)) {
    reason = 'insufficient_range_history';
  } else if (ratioDelta > 0) {
    reason = 'historical_range_requires_wider_bounds';
  } else if (ratioDelta < 0) {
    reason = 'historical_range_supports_tighter_bounds';
  }

  return {
    classification: classifyPriceRangeRatio(roundedRecommendedRatio),
    currentClassification: classifyPriceRangeRatio(current.ratio),
    currentRatio: roundToDecimals(current.ratio, 2),
    isSymmetric: current.isSymmetric,
    observedRatio: observedRatio !== null && Number.isFinite(observedRatio) ? roundToDecimals(observedRatio, 2) : null,
    ratioDelta,
    reason,
    recommendedRatio: roundedRecommendedRatio,
    referencePrice: Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : null,
    shouldUpdate,
    touchCount
  };
}

/**
 * Compute trend weight from confidence and trend direction.
 *
 * @param {string} trend       – 'UP', 'DOWN', or 'NEUTRAL'
 * @param {number} confidence  – 0–100
 * @returns {number} Weight multiplier (0.2 – 1.0)
 */
function trendWeight(trend: string, confidence: any) {
  if (trend === 'NEUTRAL') return 0.4;
  const c = Number(confidence) || 0;
  if (c >= 80) return 1.0;
  if (c >= 60) return 0.7;
  if (c >= 40) return 0.4;
  return 0.2;
}

/**
 * Compute CR weight from the current collateral ratio zone.
 *
 * @param {string} zone – CR zone label from classifyCrZone
 * @returns {number} Weight multiplier (0.0 – 1.5)
 */
function crWeight(zone: string) {
  switch (zone) {
    case 'red_high': return 1.5;
    case 'green':    return 1.0;
    case 'red_low':  return 0.0;
    default:         return 1.0;
  }
}

/**
 * Compute directional order-weight bias from trend direction and confidence.
 * Positive bias means front-load that side; negative means flatten that side.
 *
 * @param {string} [trend='NEUTRAL']      – 'UP', 'DOWN', or 'NEUTRAL'
 * @param {number} [confidence=0] – 0–100
 * @returns {{ profile: string, buyBias: number, sellBias: number, strength: number }}
 */
function computeOrderWeightBias(trend = 'NEUTRAL', confidence = 0) {
  if (trend === 'NEUTRAL') {
    return {
      profile: 'balanced',
      buyBias: 0,
      sellBias: 0,
      strength: 0
    };
  }

  const strength = trendWeight(trend, confidence);
  if (trend === 'DOWN') {
    return {
      profile: 'mountain_valley',
      buyBias: strength,
      sellBias: -strength,
      strength
    };
  }

  if (trend === 'UP') {
    return {
      profile: 'mountain_valley',
      buyBias: -strength,
      sellBias: strength,
      strength
    };
  }

  return {
    profile: 'balanced',
    buyBias: 0,
    sellBias: 0,
    strength: 0
  };
}

export { CR_ZONES, assessAllPositions, assessPosition, checkTrendAlignment, classifyCrZone, classifyPriceRangeRatio, computePriceRangeRatioPlan, computeOrderWeightBias, crWeight, trendWeight }

