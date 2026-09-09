'use strict';
/**
 * KIBANA FEED SOURCE — MPA settlement-price history
 *
 * Fetches historical price-feed publications (op_type 19, asset_publish_feed)
 * for a Market Pegged Asset and buckets them into OHLCV candles. Unlike
 * kibana_source.ts (LP pool swaps, op_type 63) and kibana_market_candles.ts
 * (order book fills, op_type 4), this module tracks the on-chain feed itself:
 * the settlement_price the chain uses for margin calls, force settlement,
 * and collateral-ratio math.
 *
 * Data source:
 *   Kibana: https://kibana.bitshares.dev
 *   Index:  bitshares-*
 *   Operation type: 19 (asset_publish_feed)
 *
 * ES field paths for asset_publish_feed:
 *   operation_history.op_object.asset_id             – published MPA asset ID
 *   operation_history.op_object.feed.settlement_price.base.amount / .asset_id
 *   operation_history.op_object.feed.settlement_price.quote.amount / .asset_id
 *
 * Output: [[timestamp_ms, open, high, low, close, feed_publish_count], ...]
 * Prices are in backing-per-MPA units by default (e.g. BTS per HONEST.USD),
 * matching the live feed_price_source convention. Use
 * getFeedCandlesForPair() for tv-style B-per-A orientation.
 *
 * Notes:
 * - Every publisher's feed is kept (no publisher filter); each 1h bucket
 *   aggregates all publishes in that hour (open = first, close = last).
 * - Volume is the feed publish count per bucket, NOT traded asset volume.
 */

import { fillCandleGaps } from '../candle_utils.js';
import { resolveRequestedFillRange } from '../core/kibana_candles.js';
import { kibanaSearch, DEFAULT_CONFIG as BASE_CONFIG } from '../core/kibana_client.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_TYPE_FEED = 19; // asset_publish_feed

const FEED_ASSET_ID_FIELD = 'operation_history.op_object.asset_id.keyword';

// Minimal _source projection: timestamp + ordering + the settlement price.
// Amounts sometimes serialize as strings (observed on core_exchange_rate
// siblings), so the whole settlement_price branch is fetched and coerced.
const FEED_SOURCE_FIELDS = [
    'block_data.block_time',
    'operation_id_num',
    'account_history.operation_id',
    'account_history.sequence',
    'operation_history.op_object.asset_id',
    'operation_history.op_object.feed.settlement_price',
];

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: any = {
    ...BASE_CONFIG,
    intervalSeconds: 3600,
    lookbackHours: 500,
    // Same paging discipline as the trade candle sources: the Kibana console
    // proxy resets connections when a single page streams too much data.
    kibanaPageSize: 2000,
    kibanaPageRetries: 4,
    kibanaRetryDelayMs: 1000,
};

function sleep(ms: any) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientPageError(err: any) {
    const msg = String(err?.message || err || '');
    return (
        msg.includes('aborted') ||
        msg.includes('connection reset') ||
        msg.includes('ECONNRESET') ||
        msg.includes('socket hang up') ||
        msg.includes('timed out') ||
        msg.includes('EPIPE')
    );
}

// ─── Price math ───────────────────────────────────────────────────────────────

/**
 * Integer blockchain amount → float. Amounts may arrive as numbers or
 * numeric strings; anything else yields NaN.
 */
function floatAmount(raw: any, precision: any) {
    const n = Number(raw);
    const p = Number(precision);
    if (!Number.isFinite(n) || !Number.isFinite(p) || p < 0) return Number.NaN;
    return n / Math.pow(10, p);
}

/**
 * Backing-per-MPA from a settlement_price { base, quote } object, handling
 * either base/quote orientation. Returns null when the price does not span
 * exactly the mpa/backing pair.
 */
function backingPerMpa(settlement: any, mpaAsset: any, backingAsset: any) {
    const base = settlement?.base;
    const quote = settlement?.quote;
    if (!base || !quote) return null;
    const baseId = String(base.asset_id || '');
    const quoteId = String(quote.asset_id || '');
    const mpaId = String(mpaAsset?.id || '');
    const backingId = String(backingAsset?.id || '');
    if (!baseId || !quoteId || !mpaId || !backingId) return null;
    const ids = new Set([baseId, quoteId]);
    if (!ids.has(mpaId) || !ids.has(backingId)) return null;

    const baseFloat = floatAmount(base.amount, baseId === mpaId ? mpaAsset.precision : backingAsset.precision);
    const quoteFloat = floatAmount(quote.amount, quoteId === mpaId ? mpaAsset.precision : backingAsset.precision);
    if (!Number.isFinite(baseFloat) || !Number.isFinite(quoteFloat) || baseFloat <= 0 || quoteFloat <= 0) return null;

    // backing-per-MPA: divide the backing side by the MPA side.
    if (baseId === backingId && quoteId === mpaId) return baseFloat / quoteFloat;
    if (baseId === mpaId && quoteId === backingId) return quoteFloat / baseFloat;
    return null;
}

function parseFeedTimestamp(source: any) {
    const raw = source?.block_data?.block_time;
    if (raw == null) return null;
    const text = String(raw);
    const tsMs = Date.parse(text.endsWith('Z') ? text : `${text}Z`);
    return Number.isFinite(tsMs) ? tsMs : null;
}

function hitSortKey(hit: any) {
    const sort = Array.isArray(hit?.sort) ? hit.sort : [];
    return sort.map((v: any) => String(v)).join('|') || String(hit?._id || '');
}

function hitSequence(source: any) {
    const candidates = [
        source?.operation_id_num,
        source?.account_history?.operation_id,
        source?.account_history?.sequence,
    ];
    for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const m = String(value || '').match(/(\d+)$/);
        if (m) return Number(m[1]);
    }
    return Number.NaN;
}

/**
 * Kibana hit → { tsMs, price, sequence, kibanaSortKey } in backing-per-MPA,
 * or null when the hit carries no usable settlement price for the pair.
 */
function hitToFeedPrice(hit: any, { mpaAsset, backingAsset }: any) {
    const source = hit?._source || {};
    const tsMs = parseFeedTimestamp(source);
    if (tsMs == null) return null;
    const settlement = source?.operation_history?.op_object?.feed?.settlement_price;
    const price = backingPerMpa(settlement, mpaAsset, backingAsset);
    if (!Number.isFinite(price as number) || (price as number) <= 0) return null;
    return {
        tsMs,
        price: price as number,
        sequence: hitSequence(source),
        kibanaSortKey: hitSortKey(hit),
    };
}

// ─── Query ────────────────────────────────────────────────────────────────────

function buildFeedDocumentQuery({ mpaAssetId, lookbackHours, timeRange, size, searchAfter }: any) {
    const rangeValue = timeRange
        ? { gte: timeRange.gte, lte: timeRange.lte }
        : { gte: `now-${lookbackHours}h`, lte: 'now' };

    const query: any = {
        size,
        track_total_hits: false,
        _source: FEED_SOURCE_FIELDS,
        query: {
            bool: {
                filter: [
                    { term: { operation_type: OP_TYPE_FEED } },
                    { term: { [FEED_ASSET_ID_FIELD]: String(mpaAssetId) } },
                    { range: { 'block_data.block_time': rangeValue } },
                ],
            },
        },
        sort: [
            { 'block_data.block_time': { order: 'asc' } },
            { operation_id_num: { order: 'asc' } },
        ],
    };

    if (Array.isArray(searchAfter)) query.search_after = searchAfter;
    return query;
}

/**
 * All feed price points for the MPA in the requested window, time-ascending.
 */
async function fetchFeedPricePoints({ mpaAsset, backingAsset, config = {} }: any) {
    const cfg: any = { ...DEFAULT_CONFIG, ...config };
    const search = typeof cfg.kibanaSearch === 'function' ? cfg.kibanaSearch : kibanaSearch;
    const size = Math.min(Math.max(1, Number(cfg.kibanaPageSize) || DEFAULT_CONFIG.kibanaPageSize), 10000);
    const retriesRaw = Number(cfg.kibanaPageRetries);
    const retries = Number.isFinite(retriesRaw) && retriesRaw >= 1 ? Math.floor(retriesRaw) : DEFAULT_CONFIG.kibanaPageRetries;
    const delayRaw = Number(cfg.kibanaRetryDelayMs);
    const retryDelayMs = Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : DEFAULT_CONFIG.kibanaRetryDelayMs;

    const points: any[] = [];
    let searchAfter: any = null;

    while (true) {
        const query = buildFeedDocumentQuery({
            mpaAssetId: mpaAsset.id,
            lookbackHours: cfg.lookbackHours,
            timeRange: cfg.timeRange ?? null,
            size,
            searchAfter,
        });

        // A failed page is safe to retry: search_after pagination is
        // stateless on the server, so replaying the same page yields the
        // same documents.
        let result: any = null;
        let lastErr: any = null;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                result = await search(cfg, query);
                lastErr = null;
                break;
            } catch (err: any) {
                lastErr = err;
                if (attempt >= retries || !isTransientPageError(err)) throw err;
                if (retryDelayMs > 0) await sleep(retryDelayMs * attempt);
            }
        }
        if (lastErr) throw lastErr;
        const hits = result?.hits?.hits || [];
        if (!Array.isArray(hits) || hits.length === 0) break;

        for (const hit of hits) {
            const point = hitToFeedPrice(hit, { mpaAsset, backingAsset });
            if (point) points.push(point);
        }

        if (hits.length < size) break;
        const lastSort = hits[hits.length - 1]?.sort;
        if (!Array.isArray(lastSort)) {
            throw new Error('Kibana document pagination requires sort values on hits');
        }
        searchAfter = lastSort;
    }

    points.sort((a: any, b: any) => {
        const tsDelta = a.tsMs - b.tsMs;
        if (tsDelta !== 0) return tsDelta;
        const aSeq = Number(a.sequence);
        const bSeq = Number(b.sequence);
        if (Number.isFinite(aSeq) && Number.isFinite(bSeq) && aSeq !== bSeq) return aSeq - bSeq;
        return String(a.kibanaSortKey || '').localeCompare(String(b.kibanaSortKey || ''));
    });
    return points;
}

// ─── Bucketing ────────────────────────────────────────────────────────────────

/**
 * Price points → OHLC candles per interval bucket.
 * Pure function (no I/O) for unit testing.
 *
 * @param {Array} points – [{ tsMs, price }] time-ascending preferred
 * @param {number} intervalSeconds – bucket size (1h default)
 * @returns {Array} [[timestamp_ms, open, high, low, close, publishCount], ...]
 */
function bucketPricesToCandles(points: any, intervalSeconds = 3600) {
    const bucketMs = Number(intervalSeconds) * 1000;
    if (!Array.isArray(points) || points.length === 0) return [];
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) return [];

    const buckets = new Map();
    for (const point of points || []) {
        const tsMs = Number(point?.tsMs);
        const price = Number(point?.price);
        if (!Number.isFinite(tsMs) || !Number.isFinite(price) || price <= 0) continue;
        const bucketTs = Math.floor(tsMs / bucketMs) * bucketMs;
        let bucket = buckets.get(bucketTs);
        if (!bucket) {
            bucket = { ts: bucketTs, open: price, high: price, low: price, close: price, count: 0, firstTs: tsMs, lastTs: tsMs };
            buckets.set(bucketTs, bucket);
        }
        // Points may arrive unordered; open tracks the earliest timestamp,
        // close the latest, while high/low span the whole bucket.
        if (tsMs < bucket.firstTs) {
            bucket.open = price;
            bucket.firstTs = tsMs;
        }
        if (tsMs >= bucket.lastTs) {
            bucket.close = price;
            bucket.lastTs = tsMs;
        }
        if (price > bucket.high) bucket.high = price;
        if (price < bucket.low) bucket.low = price;
        bucket.count += 1;
    }

    return [...buckets.entries()]
        .sort((a: any, b: any) => a[0] - b[0])
        .map(([, b]: any) => [b.ts, b.open, b.high, b.low, b.close, b.count]);
}

/**
 * Invert candles (1/price, high/low swapped). Pure function for pair
 * orientation when the MPA is the B leg (B-per-A = MPA-per-backing).
 */
function invertCandles(candles: any) {
    return (candles || [])
        .filter((c: any) => Array.isArray(c) && c.slice(1, 5).every((v: any) => Number.isFinite(Number(v)) && Number(v) > 0))
        .map((c: any) => [c[0], 1 / c[4], 1 / c[3], 1 / c[2], 1 / c[1], c[5]]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * OHLC feed candles for an MPA in backing-per-MPA units
 * (e.g. BTS per HONEST.USD).
 *
 * @param {Object} mpaAsset – { id, precision, symbol }
 * @param {Object} backingAsset – { id, precision, symbol }
 * @param {Object} [config] – { intervalSeconds, timeRange | lookbackHours, fillGaps, fillGapsToRequestedRange, kibanaSearch, ... }
 */
async function getFeedCandlesForMpa(mpaAsset: any, backingAsset: any, config: any = {}) {
    const cfg: any = { ...DEFAULT_CONFIG, ...config };
    const points = await fetchFeedPricePoints({ mpaAsset, backingAsset, config: cfg });
    return applyGapFill(bucketPricesToCandles(points, cfg.intervalSeconds), cfg);
}

function applyGapFill(consolidated: any, cfg: any) {
    if (cfg.fillGaps === false) {
        return consolidated;
    }

    if (cfg.fillGapsToRequestedRange === false) {
        return fillCandleGaps(consolidated, cfg.intervalSeconds);
    }

    const { startTs, endTs } = resolveRequestedFillRange(cfg);
    return fillCandleGaps(consolidated, cfg.intervalSeconds, startTs, endTs);
}

/**
 * Cross-rate price points for two MPAs sharing one backing asset.
 *
 * Both feeds are fetched in backing-per-MPA units, then each numerator-side
 * publish is paired with the latest denominator-side publish at or before
 * its timestamp (forward-fill). Ratios are therefore B-per-A directly: the
 * backing leg cancels ((backing/A) / (backing/B) = B/A).
 *
 * Numerator publishes predating the first denominator publish are dropped
 * (no reference price yet). Pure function of two point lists otherwise.
 */
function crossPointsToRatios(numeratorPoints: any, denominatorPoints: any) {
    const ratios: any[] = [];
    let j = 0;
    let lastDenominator: any = null;
    for (const point of numeratorPoints || []) {
        const tsMs = Number(point?.tsMs);
        const price = Number(point?.price);
        if (!Number.isFinite(tsMs) || !Number.isFinite(price) || price <= 0) continue;
        while (j < (denominatorPoints || []).length && Number(denominatorPoints[j]?.tsMs) <= tsMs) {
            lastDenominator = denominatorPoints[j];
            j++;
        }
        const refPrice = Number(lastDenominator?.price);
        if (!Number.isFinite(refPrice) || refPrice <= 0) continue;
        ratios.push({ tsMs, price: price / refPrice });
    }
    return ratios;
}

async function fetchFeedCrossPoints({ mpaA, mpaB, backing, config = {} }: any) {
    if (String(mpaA?.id || '') === String(mpaB?.id || '')) {
        throw new Error('Feed cross requires two distinct MPAs');
    }
    const [pointsA, pointsB] = await Promise.all([
        fetchFeedPricePoints({ mpaAsset: mpaA, backingAsset: backing, config }),
        fetchFeedPricePoints({ mpaAsset: mpaB, backingAsset: backing, config }),
    ]);
    return crossPointsToRatios(pointsA, pointsB);
}

/**
 * Feed candles oriented for a tv pair (B-per-A units).
 *
 * - pair (backing, MPA): B-per-A = MPA-per-backing → inverted feed.
 * - pair (MPA, backing): B-per-A = backing-per-MPA → feed as-is.
 * - any other pair (MPA vs non-backing asset): throws — a single MPA feed
 *   cannot price that pair; use pool/orderbook candles instead, or
 *   getFeedCandlesForMpaCross() when both legs are MPAs.
 */
async function getFeedCandlesForPair(assetA: any, assetB: any, mpaAsset: any, backingAsset: any, config: any = {}) {
    const aId = String(assetA?.id || '');
    const bId = String(assetB?.id || '');
    const mpaId = String(mpaAsset?.id || '');
    const backingId = String(backingAsset?.id || '');

    const candles = await getFeedCandlesForMpa(mpaAsset, backingAsset, config);
    if (aId === backingId && bId === mpaId) return invertCandles(candles);
    if (aId === mpaId && bId === backingId) return candles;
    throw new Error(
        `Feed candles cover ${backingAsset?.symbol || backingId}/${mpaAsset?.symbol || mpaId} only; ` +
        `cannot price ${assetA?.symbol || aId}/${assetB?.symbol || bId} from the feed`
    );
}

/**
 * Cross-rate feed candles for an MPA/MPA pair sharing one backing asset
 * (e.g. HONEST.USD/HONEST.EUR, both BTS-backed), in B-per-A units.
 *
 * Both feeds are queried and the quote of both is calculated per bucket via
 * forward-fill (see crossPointsToRatios). Legs may be passed in either
 * order; orientation follows assetA/assetB.
 *
 * @param {Object} assetA – tv pair leg A { id, precision, symbol }
 * @param {Object} assetB – tv pair leg B { id, precision, symbol }
 * @param {Object} legA – { mpa, backing } for one MPA leg
 * @param {Object} legB – { mpa, backing } for the other MPA leg
 */
async function getFeedCandlesForMpaCross(assetA: any, assetB: any, legA: any, legB: any, config: any = {}) {
    const aId = String(assetA?.id || '');
    const bId = String(assetB?.id || '');
    const mpaAId = String(legA?.mpa?.id || '');
    const mpaBId = String(legB?.mpa?.id || '');
    const backingAId = String(legA?.backing?.id || '');
    const backingBId = String(legB?.backing?.id || '');
    if (!mpaAId || !mpaBId || mpaAId === mpaBId) {
        throw new Error('Feed cross requires two distinct MPA legs');
    }
    if (!backingAId || backingAId !== backingBId) {
        throw new Error(
            `Feed cross requires one shared backing asset, got ${legA?.backing?.symbol || backingAId} vs ${legB?.backing?.symbol || backingBId}`
        );
    }
    // Numerator leg is the A leg so ratios come out as B-per-A directly.
    const flip = aId === mpaBId && bId === mpaAId;
    if (!flip && !(aId === mpaAId && bId === mpaBId)) {
        throw new Error(
            `Feed cross covers ${legA?.mpa?.symbol || mpaAId}/${legB?.mpa?.symbol || mpaBId} only; ` +
            `cannot price ${assetA?.symbol || aId}/${assetB?.symbol || bId} from the feed`
        );
    }
    const cfg: any = { ...DEFAULT_CONFIG, ...config };
    const points = flip
        ? await fetchFeedCrossPoints({ mpaA: legB.mpa, mpaB: legA.mpa, backing: legA.backing, config: cfg })
        : await fetchFeedCrossPoints({ mpaA: legA.mpa, mpaB: legB.mpa, backing: legA.backing, config: cfg });
    return applyGapFill(bucketPricesToCandles(points, cfg.intervalSeconds), cfg);
}

export {
    OP_TYPE_FEED,
    DEFAULT_CONFIG,
    backingPerMpa,
    hitToFeedPrice,
    buildFeedDocumentQuery,
    fetchFeedPricePoints,
    fetchFeedCrossPoints,
    crossPointsToRatios,
    bucketPricesToCandles,
    invertCandles,
    getFeedCandlesForMpa,
    getFeedCandlesForPair,
    getFeedCandlesForMpaCross,
}
