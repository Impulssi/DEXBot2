/**
 * Average True Range (ATR) Service
 * Computes market volatility for symmetrical weight shifts.
 */

import { normalizeAtrPeriod } from '../../config_normalizers';
'use strict';


/**
 * Calculates ATR from candles (High, Low, Close).
 * @param {Array} candles - Array of [timestamp, open, high, low, close, volume]
 * @param {number} period - ATR period
 * @returns {number} Average True Range value
 */
function calculateATR(candles: any, period = 14) {
  const safePeriod = normalizeAtrPeriod(period);
  if (!Array.isArray(candles)) return Number.NaN;
  if (candles.length < safePeriod + 1) return 0;

  let tr: number[] = [];
  let prevClose: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const high = Number(candles[i]?.[2]);
    const low = Number(candles[i]?.[3]);
    const close = Number(candles[i]?.[4]);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      // Break the ATR chain across missing/invalid rows so a single bad candle
      // does not synthesize a multi-bar gap into the next valid true range.
      prevClose = null;
      continue;
    }
    if (prevClose != null) {
      tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    prevClose = close;
  }

  if (tr.length === 0) return Number.NaN;
  if (tr.length < safePeriod) return 0;

  let atr = tr.slice(0, safePeriod).reduce((a, b) => a + b, 0) / safePeriod;
  for (let i = safePeriod; i < tr.length; i++) {
    atr = (atr * (safePeriod - 1) + tr[i]) / safePeriod;
  }
  return atr;
}

export { calculateATR }

