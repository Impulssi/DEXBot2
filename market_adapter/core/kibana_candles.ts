'use strict';

import { fillCandleGaps, tradesToCandles } from '../candle_utils.js';
import { kibanaSearch, DEFAULT_CONFIG as BASE_CONFIG } from './kibana_client.js';

const DEFAULT_CONFIG = {
    ...BASE_CONFIG,
    intervalSeconds: 3600,
    lookbackHours: 500,
    consolidateByTimestamp: true,
    fillGapsToRequestedRange: true,
    kibanaPageSize: 10000,
};

function sourceField(field: any) {
    return String(field || '').replace(/\.keyword$/, '');
}

function buildDirectionalDocumentQuery({ opType, soldAssetField, receivedAssetField, poolField, soldAssetId, receivedAssetId, lookbackHours, poolId, timeRange, size, searchAfter }: { opType: any; soldAssetField: any; receivedAssetField: any; poolField: any; soldAssetId: any; receivedAssetId: any; lookbackHours: any; poolId: any; timeRange: any; size: any; searchAfter?: any }) {
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

    const query = {
        size,
        track_total_hits: false,
        _source: true,
        query: { bool: { filter: filters } },
        sort: [
            { 'block_data.block_time': { order: 'asc' } },
            { operation_id_num: { order: 'asc' } },
        ],
    };

    if (Array.isArray(searchAfter)) (query as any).search_after = searchAfter;
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

async function fetchDirectionalTradeDocs({ search, cfg, opType, fieldMap, soldAsset, receivedAsset, lookbackHours, poolId, timeRange }: any) {
    const size = Math.min(Math.max(1, Number(cfg.kibanaPageSize) || 10000), 10000);
    const trades: any[] = [];
    let searchAfter: any = null;

    while (true) {
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
        });

        const result = await search(cfg, query);
        const hits = result?.hits?.hits || [];
        if (!Array.isArray(hits) || hits.length === 0) break;

        for (const hit of hits) {
            const trade = hitToTrade(hit, {
                soldAsset,
                receivedAsset,
                soldAmountField: fieldMap.soldAmountField,
                receivedAmountField: fieldMap.receivedAmountField,
                operationIdField: fieldMap.operationIdField,
            });
            if (trade) trades.push(trade);
        }

        if (hits.length < size) break;
        const lastSort = hits[hits.length - 1]?.sort;
        if (!Array.isArray(lastSort)) {
            throw new Error('Kibana document pagination requires sort values on hits');
        }
        searchAfter = lastSort;
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

async function fetchKibanaCandles({ opType, fieldMap, assetA, assetB, config = {}, poolId = null }: any) {
    const cfg: any = { ...DEFAULT_CONFIG, ...config };
    const search = typeof cfg.kibanaSearch === 'function' ? cfg.kibanaSearch : kibanaSearch;

    const [tradesAtoB, tradesBtoA] = await Promise.all([
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
        }),
    ]);

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

export { buildDirectionalDocumentQuery, resolveRequestedFillRange, fetchKibanaCandles, fetchKibanaClosePrices, DEFAULT_CONFIG }

