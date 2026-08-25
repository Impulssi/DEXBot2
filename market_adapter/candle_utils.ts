'use strict';

/**
 * Candle field accessors and transforms — canonical implementations shared by
 * the production market adapter and the analysis tooling (via
 * analysis/math_utils.ts). Keeps every consumer on one accessor path.
 */

function getCandleClose(candle: any) {
    if (!candle) return null;
    return Array.isArray(candle) ? candle[4] : candle.close;
}

function getCandleTimestamp(candle: any) {
    if (!candle) return null;
    return Array.isArray(candle) ? candle[0] : candle.timestamp;
}

function normalizeCandle(candle: any) {
    if (!candle) return null;
    if (Array.isArray(candle)) {
        const ts = Number(candle[0]);
        const open = Number(candle[1]);
        const high = Number(candle[2]);
        const low = Number(candle[3]);
        const close = Number(candle[4]);
        const volume = Number(candle[5] ?? 0);
        if (![ts, open, high, low, close].every(Number.isFinite)) return null;
        return { time: Math.floor(ts / 1000), open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
    }

    const ts = Number(candle.timestamp ?? candle.ts ?? candle.time);
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume ?? candle.volumeA ?? 0);
    if (![ts, open, high, low, close].every(Number.isFinite)) return null;
    return { time: Math.floor(ts / 1000), open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

function rawToHuman(rawAmount: any, precision: any) {
    if (precision === undefined || precision === null || !Number.isFinite(Number(precision))) {
        throw new Error(`Invalid precision for rawToHuman: ${precision}`);
    }
    return Number(rawAmount || 0) / Math.pow(10, Number(precision));
}

function tradeToBPerA(trade: any, assetA: any, assetB: any) {
    const sell = trade.sell || {};
    const recv = trade.received || {};
    const sellId = sell.asset_id;
    const recvId = recv.asset_id;

    if (!sellId || !recvId) return null;
    if (sellId === assetA.id && recvId === assetB.id) {
        const a = rawToHuman(sell.amount, assetA.precision);
        const b = rawToHuman(recv.amount, assetB.precision);
        if (a <= 0 || b <= 0) return null;
        return { price: b / a, volumeA: a };
    }
    if (sellId === assetB.id && recvId === assetA.id) {
        const b = rawToHuman(sell.amount, assetB.precision);
        const a = rawToHuman(recv.amount, assetA.precision);
        if (a <= 0 || b <= 0) return null;
        return { price: b / a, volumeA: a };
    }
    return null;
}

function tradesToCandles(trades: any, assetA: any, assetB: any, intervalSeconds = 3600) {
    const bucketMs = intervalSeconds * 1000;
    const sorted = trades.slice().sort((a: any, b: any) => {
        const tsDelta = a.tsMs - b.tsMs;
        if (tsDelta !== 0) return tsDelta;
        const aSeq = Number(a.sequence);
        const bSeq = Number(b.sequence);
        if (Number.isFinite(aSeq) && Number.isFinite(bSeq)) return aSeq - bSeq;
        return 0;
    });
    const map = new Map();

    for (const t of sorted) {
        if (!Number.isFinite(t.tsMs)) continue;
        const converted = tradeToBPerA(t, assetA, assetB);
        if (!converted) continue;

        const key = Math.floor(t.tsMs / bucketMs) * bucketMs;
        const p = converted.price;
        const vA = converted.volumeA;

        const cur = map.get(key);
        if (!cur) {
            map.set(key, { open: p, high: p, low: p, close: p, volumeA: vA });
        } else {
            cur.high = Math.max(cur.high, p);
            cur.low = Math.min(cur.low, p);
            cur.close = p;
            cur.volumeA += vA;
        }
    }

    return [...map.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ts, c]) => [ts, c.open, c.high, c.low, c.close, c.volumeA]);
}

function detectMissingCandleTimestamps(candles: any, intervalSeconds = 3600) {
    const bucketMs = Number(intervalSeconds) * 1000;
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
        return { gapCount: 0, missingTimestamps: [] };
    }

    const sorted = (Array.isArray(candles) ? candles : [])
        .filter((c) => Array.isArray(c) && Number.isFinite(c[0]))
        .slice()
        .sort((a, b) => a[0] - b[0]);

    if (sorted.length === 0) {
        return { gapCount: 0, missingTimestamps: [] };
    }

    const missingTimestamps: any[] = [];

    for (let i = 1; i < sorted.length; i++) {
        const prevTs = sorted[i - 1][0];
        const nextTs = sorted[i][0];
        let expectedTs = prevTs + bucketMs;

        while (nextTs > expectedTs) {
            missingTimestamps.push(expectedTs);
            expectedTs += bucketMs;
        }
    }

    return {
        gapCount: missingTimestamps.length,
        missingTimestamps,
    };
}

/**
 * Fills gaps in a candle series by carrying forward the last known close price.
 * Volume for filled candles is 0.
 *
 * @param {Array}  candles         - [[ts, o, h, l, c, v], ...]
 * @param {number} intervalSeconds - bucket size in seconds
 * @param {number} [startTs]       - optional start timestamp (ms) to stretch to the past
 * @param {number} [endTs]         - optional end timestamp (ms) to stretch to the future
 * @param {Object} [options]       - optional settings
 * @param {number} [options.baselinePrice] - optional price to use for leading gaps before the first candle
 * @returns {Array} Filled candle array with no gaps
 */
function fillCandleGaps(candles: any, intervalSeconds: any, startTs: any = null, endTs: any = null, options: any = {}) {
    const bucketMs = Number(intervalSeconds) * 1000;
    if (!candles || !Array.isArray(candles)) return [];
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) return candles;

    const sorted = candles
        .filter((c) => Array.isArray(c) && Number.isFinite(c[0]))
        .slice()
        .sort((a, b) => a[0] - b[0]);

    if (sorted.length === 0) {
        // If we have no data, we can't really fill unless we have a baseline price.
        if (options.baselinePrice != null && startTs != null && endTs != null) {
            const filled: any[] = [];
            let currentTs = Math.floor(Number(startTs) / bucketMs) * bucketMs;
            const finalTs = Math.floor(Number(endTs) / bucketMs) * bucketMs;
            const p = options.baselinePrice;
            while (currentTs <= finalTs) {
                filled.push([currentTs, p, p, p, p, 0]);
                currentTs += bucketMs;
            }
            return filled;
        }
        return [];
    }

    const filled: any[] = [];

    // Determine absolute timeline range
    const firstKnownTs = sorted[0][0];
    const lastKnownTs = sorted[sorted.length - 1][0];

    let currentTs = startTs != null
        ? Math.floor(Number(startTs) / bucketMs) * bucketMs
        : firstKnownTs;

    const finalTs = endTs != null
        ? Math.floor(Number(endTs) / bucketMs) * bucketMs
        : lastKnownTs;

    let sourceIdx = 0;
    let lastKnownPrice = options.baselinePrice ?? null;

    // Advance sourceIdx to the first candle at or after currentTs
    // and initialize lastKnownPrice if it's still null.
    while (sourceIdx < sorted.length && sorted[sourceIdx][0] < currentTs) {
        lastKnownPrice = sorted[sourceIdx][4];
        sourceIdx++;
    }

    while (currentTs <= finalTs) {
        if (sourceIdx < sorted.length && sorted[sourceIdx][0] === currentTs) {
            lastKnownPrice = sorted[sourceIdx][4];
            filled.push(sorted[sourceIdx]);
            sourceIdx++;
        } else if (lastKnownPrice !== null) {
            // Gap: carry forward lastKnownPrice
            const p = lastKnownPrice;
            // Format: [ts, open, high, low, close, volume]
            filled.push([currentTs, p, p, p, p, 0]);
        } else {
            // Leading gap with no baseline: skip this bucket
        }
        currentTs += bucketMs;
    }

    return filled;
}

/**
 * Detect a stale trailing run of consecutive zero-volume candles with the
 * same close price. Returns the tail range so callers can verify with
 * external sources before committing to a prune.
 *
 * @param {Array}  candles   - [[ts, o, h, l, c, v], ...]
 * @param {number} threshold - min consecutive identical closes to flag
 * @returns {{ sorted: Array, runLength: number, lastClose: number } | null}
 *          null if no stale tail detected; otherwise the sorted array,
 *          the run length, and the tail close price so the caller can
 *          decide whether to slice.
 */
function detectStaleTail(candles: any, threshold: any) {
    if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('detectStaleTail: threshold must be a positive number');
    if (!candles || !Array.isArray(candles) || candles.length === 0) return null;
    const sorted = candles
        .filter((c) => Array.isArray(c) && Number.isFinite(c[0]))
        .slice()
        .sort((a, b) => a[0] - b[0]);

    if (sorted.length < threshold) return null;

    const lastClose = sorted[sorted.length - 1][4];
    if (Number(sorted[sorted.length - 1][5] || 0) !== 0) return null;

    let runLength = 1;
    for (let i = sorted.length - 2; i >= 0; i--) {
        if (sorted[i][4] === lastClose && Number(sorted[i][5] || 0) === 0) {
            runLength++;
        } else {
            break;
        }
    }

    if (runLength < threshold) return null;
    return { sorted, runLength, lastClose };
}

/**
 * Prune trailing candles that appear stale — i.e. zero-volume candles carrying
 * the same close for `threshold` consecutive buckets. This prevents gap-fill
 * (or a previous run) from carrying a frozen price forward indefinitely
 * without deleting real same-price trades.
 *
 * @param {Array}  candles   - [[ts, o, h, l, c, v], ...]
 * @param {number} threshold - min consecutive identical closes to prune
 * @returns {Array} candles with stale tail removed
 */
function pruneStaleTail(candles: any, threshold: any) {
    const detected = detectStaleTail(candles, threshold);
    if (!detected) return candles;
    const { sorted, runLength } = detected;
    const keepCount = sorted.length - runLength;
    return keepCount > 0 ? sorted.slice(0, keepCount) : [];
}

function mergeCandles(a: any, b: any, { onCollision }: any = {}) {
    const map = new Map();
    for (const c of [...(a || []), ...(b || [])]) {
        if (!Array.isArray(c)) continue;
        const ts = c[0];
        if (!map.has(ts)) {
            map.set(ts, c);
        } else if (typeof onCollision === 'function') {
            map.set(ts, onCollision(map.get(ts), c));
        } else {
            map.set(ts, c);
        }
    }
    return [...map.values()].sort((x, y) => x[0] - y[0]);
}

export { getCandleClose, getCandleTimestamp, normalizeCandle, tradesToCandles, detectMissingCandleTimestamps, fillCandleGaps, detectStaleTail, pruneStaleTail, mergeCandles }

