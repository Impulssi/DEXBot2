
import { blockchainToFloat } from '../../modules/order/utils/math';
'use strict';

/**
 * Native BitShares market history parsing utilities.
 *
 * Converts raw bucket_objects / get_market_history responses into
 * normalized OHLCV candles. Handles both the compact array format and
 * the raw object format with key.base / key.quote / open_base / etc.
 */


function parseNativeMarketHistoryTimestamp(entry: any) {
    const candidates = [
        entry?.key?.open,
        entry?.key?.time,
        entry?.key?.timestamp,
        entry?.key?.date,
        entry?.open_time,
        entry?.time,
        entry?.timestamp,
        entry?.block_time,
    ];

    for (const candidate of candidates) {
        if (candidate == null) continue;
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            if (candidate >= 1000000000 && candidate <= 9999999999) return candidate * 1000;
            return candidate;
        }
        let candidateStr = String(candidate);
        if (/^\d{10}$/.test(candidateStr)) return Number(candidateStr) * 1000;
        const match = candidateStr.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
        if (match) {
            const [_, y, m, d, hh, mm, ss] = match.map(Number);
            return Date.UTC(y, m - 1, d, hh, mm, ss);
        }
        const ts = Date.parse(candidateStr);
        if (Number.isFinite(ts)) return ts;
    }

    return null;
}

function resolvePairOrientation(keyBase: any, keyQuote: any, assetA: any, assetB: any) {
    const baseIsAssetA = keyBase === String(assetA?.id) && keyQuote === String(assetB?.id);
    const baseIsAssetB = keyBase === String(assetB?.id) && keyQuote === String(assetA?.id);
    if (!baseIsAssetA && !baseIsAssetB) return null;
    const basePrecision = baseIsAssetA ? assetA?.precision : assetB?.precision;
    const quotePrecision = baseIsAssetA ? assetB?.precision : assetA?.precision;
    return { baseIsAssetA, baseIsAssetB, basePrecision, quotePrecision };
}

function resolveNativeMarketHistoryRatio(entry: any, field: any, assetA: any, assetB: any) {
    const keyBase = String(entry?.key?.base || '');
    const keyQuote = String(entry?.key?.quote || '');
    const orientation = resolvePairOrientation(keyBase, keyQuote, assetA, assetB);
    if (!orientation) return Number.NaN;

    const { baseIsAssetA, basePrecision, quotePrecision } = orientation;
    const baseField = entry?.[`${field}_base`];
    const quoteField = entry?.[`${field}_quote`];
    const numericField = Number(entry?.[field]);
    if (Number.isFinite(numericField)) return numericField;

    if (Number.isFinite(Number(baseField)) && Number.isFinite(Number(quoteField)) && Number(baseField) > 0) {
        const base = blockchainToFloat(baseField, basePrecision);
        const quote = blockchainToFloat(quoteField, quotePrecision);
        if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= 0 || quote <= 0) {
            return Number.NaN;
        }
        return baseIsAssetA ? quote / base : base / quote;
    }

    const nested = entry?.[field];
    if (nested && typeof nested === 'object') {
        const base = Number(nested.base ?? nested.amount_base ?? nested.base_amount ?? nested.amount);
        const quote = Number(nested.quote ?? nested.amount_quote ?? nested.quote_amount ?? nested.value);
        if (!Number.isFinite(base) || !Number.isFinite(quote) || base <= 0 || quote <= 0) {
            return Number.NaN;
        }
        return baseIsAssetA ? quote / base : base / quote;
    }

    return Number.NaN;
}

function resolveNativeMarketHistoryVolume(entry: any, field: any, assetA: any, assetB: any) {
    const keyBase = String(entry?.key?.base || '');
    const keyQuote = String(entry?.key?.quote || '');
    const orientation = resolvePairOrientation(keyBase, keyQuote, assetA, assetB);
    if (!orientation) return Number.NaN;

    const { basePrecision } = orientation;

    const direct = Number(entry?.[field]);
    if (Number.isFinite(direct)) {
        return blockchainToFloat(direct, basePrecision);
    }

    const nested = entry?.[field];
    if (nested && typeof nested === 'object') {
        const amount = Number(nested.amount ?? nested.value ?? nested.base ?? nested.quote);
        if (Number.isFinite(amount)) {
            return blockchainToFloat(amount, basePrecision);
        }
    }

    return Number.NaN;
}

function normalizeNativeMarketHistoryCandles(history: any, assetA: any, assetB: any, _intervalSeconds: any) {
    const source = Array.isArray(history)
        ? history
        : Array.isArray(history?.buckets)
            ? history.buckets
            : Array.isArray(history?.history)
                ? history.history
                : Array.isArray(history?.result)
                    ? history.result
                    : [];

    if (!Array.isArray(source) || source.length === 0) return [];

    if (Array.isArray(source[0])) {
        return source
            .filter((c) => Array.isArray(c) && Number.isFinite(c[0]))
            .map((c) => {
                let ts = Number(c[0]);
                if (ts >= 1000000000 && ts <= 9999999999) ts *= 1000;
                const open = Number(c[1]);
                const high = Number(c[2]);
                const low = Number(c[3]);
                const close = Number(c[4]);
                const volume = Number(c[5]);
                if (![ts, open, high, low, close].every(Number.isFinite)) return null;
                return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
            })
            .filter((c: any) => c !== null)
            .sort((a: any, b: any) => a[0] - b[0]);
    }

    const candles: any[] = [];
    for (const entry of source) {
        if (!entry || typeof entry !== 'object') continue;
        const tsMs = parseNativeMarketHistoryTimestamp(entry);
        if (!Number.isFinite(tsMs)) continue;

        const keyBase = String(entry?.key?.base || '');
        const keyQuote = String(entry?.key?.quote || '');
        const orientation = resolvePairOrientation(keyBase, keyQuote, assetA, assetB);
        if (!orientation) continue;

        const { baseIsAssetA, basePrecision, quotePrecision } = orientation;
        const baseVolume = Number(entry?.base_volume);
        const quoteVolume = Number(entry?.quote_volume);

        const open = resolveNativeMarketHistoryRatio(entry, 'open', assetA, assetB);
        const resolvedHigh = resolveNativeMarketHistoryRatio(entry, 'high', assetA, assetB);
        const resolvedLow = resolveNativeMarketHistoryRatio(entry, 'low', assetA, assetB);
        const high = Math.max(resolvedHigh, resolvedLow);
        const low = Math.min(resolvedHigh, resolvedLow);
        const close = resolveNativeMarketHistoryRatio(entry, 'close', assetA, assetB);

        if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) {
            continue;
        }

        const volume = baseIsAssetA
            ? (Number.isFinite(baseVolume) ? blockchainToFloat(baseVolume, basePrecision) : Number.isFinite(quoteVolume) && Number.isFinite(close) && close > 0 ? blockchainToFloat(quoteVolume, quotePrecision) / close : 0)
            : (Number.isFinite(quoteVolume) ? blockchainToFloat(quoteVolume, quotePrecision) : Number.isFinite(baseVolume) && Number.isFinite(close) && close > 0 ? blockchainToFloat(baseVolume, basePrecision) / close : 0);

        candles.push([tsMs, open, high, low, close, Number.isFinite(volume) ? volume : 0]);
    }

    return (candles as any[]).sort((a: any, b: any) => a[0] - b[0]);
}

export { parseNativeMarketHistoryTimestamp, resolvePairOrientation, resolveNativeMarketHistoryRatio, resolveNativeMarketHistoryVolume, normalizeNativeMarketHistoryCandles }

