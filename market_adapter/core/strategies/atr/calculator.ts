/**
 * Average True Range (ATR) Service
 * Computes market volatility for symmetrical weight shifts.
 *
 * computeATRSeries is the canonical series implementation — it is shared by the
 * live market adapter (via calculateATR), analysis tooling (re-exported through
 * analysis/math_utils.ts), and the browser-embedded chart scripts (injected via
 * fn.toString()). calculateATR is a thin single-value wrapper that preserves the
 * production edge-case guards on top of the same series.
 */

import { normalizeAtrPeriod } from '../../config_normalizers.js';
'use strict';


/**
 * ATR series over candles (High, Low, Close).
 *
 * Chain-breaking semantics: an invalid row resets the previous-close reference so
 * a single bad candle never synthesizes a multi-bar gap into the next true range.
 * Positions before `period` valid true ranges resolve to 0 (insufficient data).
 *
 * Candles may be rows ([timestamp, open, high, low, close, volume]) or objects
 * ({ open, high, low, close, ... }); the getter logic is inlined so the function
 * stays self-contained and can be injected into generated HTML verbatim.
 *
 * @param {Array}   candles - Array of candle rows or candle objects
 * @param {number}  period  - ATR period
 * @param {Object}  [stats] - Optional mutable object; when provided, the number of
 *                 valid true ranges computed is written to `stats.validRanges`
 *                 and the final running ATR value to `stats.atr` (useful for
 *                 callers that need to distinguish "no valid data" from "warmup 0"
 *                 without re-scanning the input, or to read the last computed ATR
 *                 even when the final row is missing/invalid).
 * @returns {number[]} Per-candle ATR values (0 during warmup / across breaks)
 */
function computeATRSeries(candles: any, period = 14, stats: any = null) {
    const atrs: number[] = [];
    if (!Array.isArray(candles)) return atrs;

    const safePeriod = Math.max(1, Math.round(period));
    let trSum = 0;
    let trCount = 0;
    let prevClose: number | null = null;
    let atrVal = 0;

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const high = Array.isArray(c) ? Number(c?.[2]) : Number(c?.high);
        const low = Array.isArray(c) ? Number(c?.[3]) : Number(c?.low);
        const close = Array.isArray(c) ? Number(c?.[4]) : Number(c?.close);
        if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
            // Break the ATR chain across missing/invalid rows so a single bad
            // candle does not synthesize a multi-bar gap into the next valid true range.
            prevClose = null;
            atrs.push(0);
            continue;
        }
        if (prevClose != null) {
            const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
            trCount++;
            if (trCount <= safePeriod) {
                trSum += tr;
                atrVal = trSum / trCount;
            } else {
                atrVal = (atrVal * (safePeriod - 1) + tr) / safePeriod;
            }
        }
        prevClose = close;
        atrs.push(trCount < safePeriod ? 0 : atrVal);
    }

    if (stats && typeof stats === 'object') {
        stats.validRanges = trCount;
        stats.atr = atrVal;
    }

    return atrs;
}

/**
 * Calculates ATR from candles (High, Low, Close).
 *
 * Edge-case guards preserved on top of the shared series: all-invalid input
 * yields NaN (so callers can detect a failed ATR and disable the volatility
 * penalty) rather than a silent 0; fewer valid true ranges than the period
 * remains a warmup 0. The final ATR is the last computed running value, so a
 * trailing missing/invalid candle does not collapse a valid ATR to 0.
 *
 * @param {Array} candles - Array of candle rows or candle objects
 * @param {number} period - ATR period
 * @returns {number} Average True Range value
 */
function calculateATR(candles: any, period = 14) {
    const safePeriod = normalizeAtrPeriod(period);
    if (!Array.isArray(candles)) return Number.NaN;
    if (candles.length < safePeriod + 1) return 0;

    const stats: any = {};
    const series = computeATRSeries(candles, safePeriod, stats);
    if (series.length === 0) return Number.NaN;

    // No valid true ranges at all (all rows missing/invalid) → NaN, not 0.
    if (stats.validRanges === 0) return Number.NaN;
    // Fewer valid true ranges than the period → warmup 0.
    if (stats.validRanges < safePeriod) return 0;

    return Number.isFinite(stats.atr) ? stats.atr : 0;
}

export { calculateATR, computeATRSeries }
