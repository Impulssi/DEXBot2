
import { roundTo, roundToDecimals } from '../../../modules/order/utils/math.js';
'use strict';

/**
 * Collateral Ratio Recommendation Service
 *
 * Recommends a target collateral ratio based on trend analysis:
 *
 *   UP trend   → lower CR (less defensive — expect price to rise, so collateral
 *                 needs less cushion against margin calls)
 *   DOWN trend → higher CR (more defensive — expect price to fall, risk increases)
 *   NEUTRAL    → midpoint of allowed range
 *
 * Confidence scales the adjustment:
 *   ratio = midpoint + direction × (confidence / 100) × halfRange
 *
 * The output is recommendation only. Execution is owned by the debt runtime
 * and any CR adjustment should trigger a grid rebuild from fresh on-chain state.
 */

/**
 * @param {Object}  trendData           - AMA slope model output ({ trend, confidence, isReady })
 * @param {number}  minRatio            - Floor collateral ratio (e.g. 1.5)
 * @param {number}  maxRatio            - Ceiling collateral ratio (e.g. 2.0)
 * @returns {{ targetRatio: number, action: string, adjustment: number }}
 */
function adjustCollateralRatio(trendData: any, minRatio = 1.5, maxRatio = 2.0) {
    const min = Number.isFinite(minRatio) && minRatio > 0 ? minRatio : 1.5;
    const max = Number.isFinite(maxRatio) && maxRatio > min ? maxRatio : min + 0.5;
    const midpoint = (min + max) / 2;
    const halfRange = (max - min) / 2;

    if (!trendData || !trendData.isReady) {
        return {
            targetRatio: midpoint,
            action: 'HOLD',
            adjustment: 0,
        };
    }

    const confidence = Math.min(100, Math.max(0, Number(trendData.confidence) || 0));
    const scale = (confidence / 100) * halfRange;

    let targetRatio;
    let action;

    switch (trendData.trend) {
        case 'UP':
            // Price rising → less risk → can run with lower collateral
            targetRatio = midpoint - scale;
            action = scale > 0.01 ? 'DECREASE' : 'HOLD';
            break;

        case 'DOWN':
            // Price falling → more risk → increase collateral cushion
            targetRatio = midpoint + scale;
            action = scale > 0.01 ? 'INCREASE' : 'HOLD';
            break;

        default: // NEUTRAL
            targetRatio = midpoint;
            action = 'HOLD';
            break;
    }

    // Clamp to bounds
    targetRatio = Math.max(min, Math.min(max, targetRatio));
    targetRatio = roundTo(targetRatio, 1000);

    return {
        targetRatio,
        action,
        adjustment: roundToDecimals(targetRatio - midpoint, 3),
    };
}

export { adjustCollateralRatio }

