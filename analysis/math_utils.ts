'use strict';

import fs from 'node:fs';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import {
    getCandleClose,
    getCandleTimestamp,
    normalizeCandle,
} from '../market_adapter/candle_utils.js';


/**
 * Math utilities for analysis scripts.
 *
 * Candle accessors are centralized in market_adapter (candle_utils.ts) and
 * re-exported here so analysis tooling shares one logic path with the
 * live adapter and the browser-embedded chart scripts.
 */

function range(min: number, max: number, step: number, decimals: any = 4) {
    const out: number[] = [];
    for (let v = min; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(decimals)));
    return [...new Set(out)];
}

function calcStdDev(arr: any) {
    const mean = arr.reduce((a: any, b: any) => a + b, 0) / arr.length;
    const sqDiffs = arr.reduce((sum: any, v: any) => sum + (v - mean) ** 2, 0);
    return Math.sqrt(sqDiffs / arr.length);
}

/**
 * Parse a candle JSON file with format detection:
 * flat array → {candles: [...]} → {data: [...]}
 */
function loadCandleFile(filePath: any) {
    if (!filePath || !fs.existsSync(filePath)) return { candles: [], meta: null };
    const raw = readJSON(filePath);
    if (Array.isArray(raw)) return { candles: raw, meta: null };
    if (raw && Array.isArray(raw.candles)) return { candles: raw.candles, meta: raw.meta || raw };
    if (raw && Array.isArray(raw.data)) return { candles: raw.data, meta: raw };
    return { candles: [], meta: null };
}

export {
    range,
    calcStdDev,
    getCandleClose,
    getCandleTimestamp,
    normalizeCandle,
    loadCandleFile,
}
