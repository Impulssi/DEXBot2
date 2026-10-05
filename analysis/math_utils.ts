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

function range(min: number, max: number, step: number, decimals: number = 4) {
    const out: number[] = [];
    for (let v = min; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(decimals)));
    return [...new Set(out)];
}

function calcStdDev(arr: number[]) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sqDiffs = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0);
    return Math.sqrt(sqDiffs / arr.length);
}

/**
 * Parse a candle JSON file with format detection:
 * flat array → {candles: [...]} → {data: [...]}
 */
export interface CandleFile {
    candles: Record<string, unknown>[];
    meta: Record<string, unknown> | null;
}

function loadCandleFile(filePath: string): CandleFile {
    if (!filePath || !fs.existsSync(filePath)) return { candles: [], meta: null };
    const raw = readJSON(filePath);
    if (Array.isArray(raw)) return { candles: raw as Record<string, unknown>[], meta: null };
    const r = raw as { candles?: Record<string, unknown>[]; data?: Record<string, unknown>[]; meta?: Record<string, unknown> } | null;
    if (r && Array.isArray(r.candles)) return { candles: r.candles, meta: r.meta || (r as Record<string, unknown>) };
    if (r && Array.isArray(r.data)) return { candles: r.data, meta: r as Record<string, unknown> };
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
