'use strict';

import { fillCandleGaps, tradesToCandles } from '../candle_utils.js';
import { kibanaSearch, DEFAULT_CONFIG as BASE_CONFIG } from './kibana_client.js';
import { isTransientNetworkError, sleepMs } from '../../modules/utils/errors.js';

const DEFAULT_CONFIG = {
    ...BASE_CONFIG,
    intervalSeconds: 3600,
    lookbackHours: 500,
    fillGapsToRequestedRange: true,
    // Runaway guard for search_after pagination: a stuck cursor (same
    // search_after repeating) would otherwise page forever. 500 pages x
    // 2000 docs = 1M trade documents, well above any legit pool/pair
    // backfill; override via config for deeper scans.
    kibanaMaxPages: 500,
    // The Kibana console proxy resets connections when a single page streams
    // too much data (observed with full _source payloads around ~8k documents).
    // 2000-document pages with a restricted _source stay well inside the limit.
    kibanaPageSize: 2000,
    kibanaPageRetries: 4,
    kibanaRetryDelayMs: 1000,
};

function sourceField(field: any) {
    return String(field || '').replace(/\.keyword$/, '');
}

/**
 * Fixed _source fields needed by hitToTrade / hitSequence regardless of the
 * caller's field map (timestamps, ordering and sequence candidates).
 */
const SOURCE_EXTRA_FIELDS = [
    'block_data.block_time',
    'operation_id_num',
    'account_history.operation_id',
    'account_history.sequence',
];

/**
 * Derive the minimal _source projection from a field map.
 *
 * The Kibana proxy aborts responses once a page grows too large, and the full
 * operation documents (account_history, operation_history with every op field)
 * are heavy. Fetching only the branches the field map actually reads keeps
 * each page small and the transfer fast.
 *
 * @param {Object} fieldMap - { soldAssetField, receivedAssetField, ..., operationIdField }
 * @returns {Array<string>} distinct _source paths
 */
function sourceFieldsForFieldMap(fieldMap: any) {
    const prefixes = new Set<string>();
    for (const key of [
        'soldAssetField',
        'receivedAssetField',
        'soldAmountField',
        'receivedAmountField',
        'poolField',
        'operationIdField',
    ]) {
        const path = sourceField(fieldMap?.[key]);
        if (!path) continue;
        const parts = path.split('.').filter(Boolean);
        if (parts.length <= 1) {
            prefixes.add(path);
            continue;
        }
        // Keep the containing object branch (strip the trailing leaf such as
        // asset_id / amount / keyword), capped at a depth that still covers
        // the nested op/result objects used by the known field maps.
        prefixes.add(parts.slice(0, Math.min(parts.length - 1, 3)).join('.'));
    }
    for (const extra of SOURCE_EXTRA_FIELDS) prefixes.add(extra);
    return [...prefixes];
}

function buildDirectionalDocumentQuery({ opType, soldAssetField, receivedAssetField, poolField, soldAssetId, receivedAssetId, lookbackHours, poolId, timeRange, size, searchAfter, sourceFields }: { opType: any; soldAssetField: any; receivedAssetField: any; poolField: any; soldAssetId: any; receivedAssetId: any; lookbackHours: any; poolId: any; timeRange: any; size: any; searchAfter?: any; sourceFields?: any }) {
    const rangeValue = timeRange
        ? { gte: timeRange.gte, lte: timeRange.lte }
        : { gte: `now-${lookbackHours}h`, lte: 'now' };

    const filters = [
        { term: { [soldAssetField]: soldAssetId } },
        { term: { operation_type: opType } },
        { range: { 'block_data.block_time': rangeValue } },
    ];

    if (receivedAssetId && receivedAssetField) {
        filters.push({ term: { [receivedAssetField]: receivedAssetId } });
    }

    if (poolId && poolField) {
        filters.push({ term: { [poolField]: poolId } });
    }

    const query: any = {
        size,
        track_total_hits: false,
        _source: Array.isArray(sourceFields) && sourceFields.length > 0 ? sourceFields : true,
        query: { bool: { filter: filters } },
        sort: [
            { 'block_data.block_time': { order: 'asc' } },
            { operation_id_num: { order: 'asc' } },
        ],
    };

    if (Array.isArray(searchAfter)) query.search_after = searchAfter;
    return query;
}

function getByPath(obj: any, path: any) {
    const parts = sourceField(path).split('.').filter(Boolean);
    let cur = obj;
    for (const part of parts) {
        if (cur == null) return undefined;
        cur = cur[part];
    }
    return cur;
}

function numericAmount(value: any) {
    if (Array.isArray(value)) {
        const first = value.find((entry: any) => entry && entry.amount != null);
        return numericAmount(first);
    }
    if (value && typeof value === 'object' && value.amount != null) return Number(value.amount);
    return Number(value);
}

function amountForAsset(source: any, amountField: any, assetId: any) {
    const direct = getByPath(source, amountField);
    if (!Array.isArray(direct)) {
        const n = numericAmount(direct);
        if (Number.isFinite(n)) return n;
    }

    const arrayPath = sourceField(amountField).replace(/\.amount$/, '');
    const entries = getByPath(source, arrayPath);
    if (Array.isArray(entries)) {
        const matched = entries.find((entry: any) => String(entry?.asset_id || '') === String(assetId || ''));
        const n = numericAmount(matched || entries[0]);
        if (Number.isFinite(n)) return n;
    }

    return Number.NaN;
}

function parseOperationIdOrder(value: any) {
    const raw = String(value || '');
    const m = raw.match(/(\d+)$/);
    return m ? Number(m[1]) : Number.NaN;
}

function hitSortKey(hit: any) {
    const sort = Array.isArray(hit?.sort) ? hit.sort : [];
    return sort.map((v: any) => String(v)).join('|') || String(hit?._id || '');
}

function hitSequence(source: any, operationIdField: any) {
    const candidates = [
        getByPath(source, 'operation_id_num'),
        getByPath(source, 'account_history.operation_id'),
        getByPath(source, operationIdField),
        getByPath(source, 'account_history.sequence'),
    ];

    for (const value of candidates) {
        const n = typeof value === 'number' ? value : parseOperationIdOrder(value);
        if (Number.isFinite(n)) return n;
    }
    return Number.NaN;
}

function hitToTrade(hit: any, { soldAsset, receivedAsset, soldAmountField, receivedAmountField, operationIdField = 'account_history.operation_id' }: any) {
    const source = hit?._source || {};
    const rawTime = String(getByPath(source, 'block_data.block_time') || '');
    const tsMs = Date.parse(rawTime.endsWith('Z') ? rawTime : `${rawTime}Z`);
    if (!Number.isFinite(tsMs)) return null;

    const soldAmount = amountForAsset(source, soldAmountField, soldAsset.id);
    const receivedAmount = amountForAsset(source, receivedAmountField, receivedAsset.id);
    if (!Number.isFinite(soldAmount) || soldAmount <= 0 || !Number.isFinite(receivedAmount) || receivedAmount <= 0) {
        return null;
    }

    return {
        tsMs,
        sequence: hitSequence(source, operationIdField),
        kibanaSortKey: hitSortKey(hit),
        sell: {
            amount: soldAmount,
            asset_id: soldAsset.id,
        },
        received: {
            amount: receivedAmount,
            asset_id: receivedAsset.id,
        },
    };
}

async function fetchDirectionalTradeDocs({ search, cfg, opType, fieldMap, soldAsset, receivedAsset, lookbackHours, poolId, timeRange, onPage, direction }: any) {
    const size = Math.min(Math.max(1, Number(cfg.kibanaPageSize) || DEFAULT_CONFIG.kibanaPageSize), 10000);
    const retriesRaw = Number(cfg.kibanaPageRetries);
    // kibanaPageRetries is the total number of attempts per page (not retries
    // after the first failure).
    const retries = Number.isFinite(retriesRaw) && retriesRaw >= 1 ? Math.floor(retriesRaw) : DEFAULT_CONFIG.kibanaPageRetries;
    const delayRaw = Number(cfg.kibanaRetryDelayMs);
    const retryDelayMs = Number.isFinite(delayRaw) && delayRaw >= 0 ? delayRaw : DEFAULT_CONFIG.kibanaRetryDelayMs;
    const sourceFields = sourceFieldsForFieldMap(fieldMap);
    const maxPagesRaw = Number(cfg.kibanaMaxPages);
    const maxPages = Number.isFinite(maxPagesRaw) && maxPagesRaw >= 1 ? Math.floor(maxPagesRaw) : DEFAULT_CONFIG.kibanaMaxPages;
    const directionLabel = direction || `${soldAsset?.symbol || soldAsset?.id || '?'}→${receivedAsset?.symbol || receivedAsset?.id || '?'}`;
    const reportPage = (info: any) => {
        const cb = typeof onPage === 'function' ? onPage : (typeof cfg?.onPage === 'function' ? cfg.onPage : null);
        if (cb) {
            try { cb({ direction: directionLabel, ...info }); } catch (_) { /* progress must never fail the fetch */ }
        }
    };
    const trades: any[] = [];
    let searchAfter: any = null;
    let page = 0;
    let droppedTotal = 0;

    while (true) {
        page += 1;
        if (page > maxPages) {
            throw new Error(
                `Kibana pagination exceeded kibanaMaxPages=${maxPages} for ${directionLabel} ` +
                `(op ${opType}) — stuck search_after cursor or range too deep for one fetch. ` +
                `Narrow the timeRange or raise kibanaMaxPages.`
            );
        }
        const pageStartMs = Date.now();
        const query = buildDirectionalDocumentQuery({
            opType,
            soldAssetField: fieldMap.soldAssetField,
            receivedAssetField: fieldMap.receivedAssetField,
            poolField: fieldMap.poolField,
            soldAssetId: soldAsset.id,
            receivedAssetId: receivedAsset.id,
            lookbackHours,
            poolId,
            timeRange,
            size,
            searchAfter,
            sourceFields,
        });

        // The Kibana proxy intermittently resets connections mid-transfer.
        // A failed page is safe to retry: search_after pagination is
        // stateless on the server, so replaying the same page yields the
        // same documents.
        let result: any = null;
        let lastErr: any = null;
        let attempts = 0;
        // The page loop owns the retry budget here, so the client-level
        // retry is disabled for these calls (avoids page budget x client
        // budget stacking). One-shot queries via kibanaSearch keep it.
        const pageCfg = { ...cfg, kibanaSearchRetries: 1 };
        for (let attempt = 1; attempt <= retries; attempt++) {
            attempts = attempt;
            try {
                result = await search(pageCfg, query);
                lastErr = null;
                break;
            } catch (err: any) {
                lastErr = err;
                if (attempt >= retries || !isTransientNetworkError(err)) throw err;
                reportPage({ page, event: 'retry', attempt, error: String(err?.message || err || 'unknown') });
                if (retryDelayMs > 0) await sleepMs(retryDelayMs * attempt);
            }
        }
        if (lastErr) throw lastErr;
        const hits = result?.hits?.hits || [];
        let droppedPage = 0;
        if (!Array.isArray(hits) || hits.length === 0) {
            reportPage({ page, event: 'page', hits: 0, dropped: 0, attempts, elapsedMs: Date.now() - pageStartMs, done: true });
            break;
        }

        for (const hit of hits) {
            const trade = hitToTrade(hit, {
                soldAsset,
                receivedAsset,
                soldAmountField: fieldMap.soldAmountField,
                receivedAmountField: fieldMap.receivedAmountField,
                operationIdField: fieldMap.operationIdField,
            });
            if (trade) trades.push(trade);
            else droppedPage += 1;
        }
        droppedTotal += droppedPage;
        reportPage({ page, event: 'page', hits: Array.isArray(hits) ? hits.length : 0, dropped: droppedPage, attempts, elapsedMs: Date.now() - pageStartMs, done: hits.length < size });

        if (hits.length < size) break;
        const lastSort = hits[hits.length - 1]?.sort;
        if (!Array.isArray(lastSort)) {
            throw new Error('Kibana document pagination requires sort values on hits');
        }
        searchAfter = lastSort;
    }

    // Dropped documents (unparseable timestamp or non-positive amounts) are
    // skipped, not fatal — but a large drop count means the field map no
    // longer matches the index mapping, so say so on the terminal.
    if (droppedTotal > 0) {
        console.warn(
            `[kibana] ${directionLabel}: skipped ${droppedTotal} unparseable document(s) ` +
            `across ${page} page(s) (op ${opType}) — kept ${trades.length} trade(s)`
        );
    }

    return trades;
}

function resolveRequestedFillRange(cfg: any, nowMs: any = Date.now()) {
    const bucketMs = Number(cfg.intervalSeconds) * 1000;
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) return { startTs: null, endTs: null };

    if (cfg.timeRange) {
        const gteMs = Date.parse(String(cfg.timeRange.gte || ''));
        const lteMs = Date.parse(String(cfg.timeRange.lte || ''));
        return {
            startTs: Number.isFinite(gteMs) ? Math.floor(gteMs / bucketMs) * bucketMs : null,
            endTs: Number.isFinite(lteMs) ? Math.floor(lteMs / bucketMs) * bucketMs : null,
        };
    }

    const lookbackHours = Number(cfg.lookbackHours);
    return {
        startTs: Number.isFinite(lookbackHours) && lookbackHours > 0
            ? Math.floor((nowMs - (lookbackHours * 3600 * 1000)) / bucketMs) * bucketMs
            : null,
        endTs: Math.floor(nowMs / bucketMs) * bucketMs,
    };
}

/**
 * Bidirectional trade-document fetch → OHLCV candles in B-per-A units.
 *
 * Robustness notes:
 * - Either swap direction may fail alone (transient proxy reset after all
 *   page retries): the surviving direction's trades are kept and a warning
 *   is logged; only a both-directions failure throws. A partial result also
 *   emits a guarded `onPage({ event: 'partial', ... })` so cached fetchers
 *   can withhold the window from disk (partial gap-fills must never claim
 *   full-window coverage, or the failed direction would never be re-queried).
 * - Gap-fill convention (see fillCandleGaps): zero-volume candles are
 *   synthesized carries of the last close. Close-only callers lose the
 *   filled-vs-real distinction — keep the volume column when it matters.
 */
async function fetchKibanaCandles({ opType, fieldMap, assetA, assetB, config = {}, poolId = null }: any) {
    const cfg: any = { ...DEFAULT_CONFIG, ...config };
    const search = typeof cfg.kibanaSearch === 'function' ? cfg.kibanaSearch : kibanaSearch;

    const dirAtoB = `${assetA?.symbol || assetA?.id || '?'}→${assetB?.symbol || assetB?.id || '?'}`;
    const dirBtoA = `${assetB?.symbol || assetB?.id || '?'}→${assetA?.symbol || assetA?.id || '?'}`;

    // One direction failing (transient proxy reset after all page retries)
    // must not discard the other direction's trades — sparse pairs often
    // have data on one side only. Both failing still throws.
    const [resAtoB, resBtoA] = await Promise.allSettled([
        fetchDirectionalTradeDocs({
            search,
            cfg,
            opType,
            fieldMap,
            soldAsset: assetA,
            receivedAsset: assetB,
            lookbackHours: cfg.lookbackHours,
            poolId,
            timeRange: cfg.timeRange ?? null,
            onPage: cfg.onPage,
            direction: dirAtoB,
        }),
        fetchDirectionalTradeDocs({
            search,
            cfg,
            opType,
            fieldMap,
            soldAsset: assetB,
            receivedAsset: assetA,
            lookbackHours: cfg.lookbackHours,
            poolId,
            timeRange: cfg.timeRange ?? null,
            onPage: cfg.onPage,
            direction: dirBtoA,
        }),
    ]);

    let tradesAtoB: any[] = [];
    let tradesBtoA: any[] = [];
    const failures: string[] = [];
    if (resAtoB.status === 'fulfilled') tradesAtoB = resAtoB.value;
    else failures.push(`${dirAtoB}: ${resAtoB.reason?.message || resAtoB.reason}`);
    if (resBtoA.status === 'fulfilled') tradesBtoA = resBtoA.value;
    else failures.push(`${dirBtoA}: ${resBtoA.reason?.message || resBtoA.reason}`);
    if (failures.length === 2) {
        throw new Error(`Kibana fetch failed in both directions (op ${opType}): ${failures.join(' | ')}`);
    }
    if (failures.length === 1) {
        console.warn(`[kibana] partial fetch (op ${opType}) — one direction failed, continuing with the other: ${failures[0]}`);
        // Progress must never fail the fetch (same convention as reportPage).
        try {
            if (typeof cfg?.onPage === 'function') {
                cfg.onPage({ event: 'partial', opType, poolId, failures });
            }
        } catch (_) { /* ignored */ }
    }

    const allTrades = [...tradesAtoB, ...tradesBtoA].sort((a: any, b: any) => {
        const tsDelta = a.tsMs - b.tsMs;
        if (tsDelta !== 0) return tsDelta;
        const aSeq = Number(a.sequence);
        const bSeq = Number(b.sequence);
        if (Number.isFinite(aSeq) && Number.isFinite(bSeq) && aSeq !== bSeq) return aSeq - bSeq;
        return String(a.kibanaSortKey || '').localeCompare(String(b.kibanaSortKey || ''));
    });

    const consolidated = tradesToCandles(allTrades, assetA, assetB, cfg.intervalSeconds);

    if (cfg.fillGaps === false) {
        return consolidated;
    }

    if (cfg.fillGapsToRequestedRange === false) {
        return fillCandleGaps(consolidated, cfg.intervalSeconds);
    }

    const { startTs, endTs } = resolveRequestedFillRange(cfg);
    return fillCandleGaps(consolidated, cfg.intervalSeconds, startTs, endTs);
}

async function fetchKibanaClosePrices(params: any) {
    const candles = await fetchKibanaCandles(params);
    return candles.map(([, , , , close]: any) => close);
}

export { buildDirectionalDocumentQuery, resolveRequestedFillRange, fetchKibanaCandles, fetchKibanaClosePrices, sourceFieldsForFieldMap, DEFAULT_CONFIG }

