'use strict';

import { getStorage } from '../../modules/storage/index.js';
const { readJSON } = getStorage();
import { normalizeCandle } from '../math_utils.js';

/**
 * Shared utilities for bot-fitting scripts.
 */


function toCandles(arr: any[]) {
    // Canonical accessor transform (market_adapter/candle_utils via math_utils)
    // instead of hand-rolled array indexing.
    return arr
        .map((c: any) => normalizeCandle(c))
        .filter(Boolean)
        .map((c: any) => ({
            timestamp: c.time * 1000,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
        }));
}

function parseListOrRange(spec: any, fallback: any) {
    if (!spec) return fallback;
    if (spec.includes(':')) {
        const [a, b, s] = spec.split(':').map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(s) || s <= 0) return fallback;
        const out: number[] = [];
        for (let v = a; v <= b + 1e-9; v += s) out.push(Number(v.toFixed(4)));
        return out;
    }
    const vals = spec.split(',').map((x: any) => Number(x.trim())).filter(Number.isFinite);
    return vals.length ? vals : fallback;
}

function loadLpData(filePath: string) {
    const json = readJSON(filePath);
    return { candles: toCandles(json.candles ?? json), meta: json.meta ?? null };
}

function fmt(x: number, d = 2) {
    if (!Number.isFinite(x)) return '  n/a';
    return Number(x).toFixed(d);
}

export { parseListOrRange, loadLpData, fmt }

