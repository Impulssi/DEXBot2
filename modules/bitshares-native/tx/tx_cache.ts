
import { NATIVE_CLIENT } from '../../constants';
import { LRUCache } from '../lru_cache';
import Logger from '../../logger';
import { hasTxBuilderFeeCacheTtlSet, getTxBuilderFeeCacheTtl } from '../../config';
'use strict';

const txCacheLogger = new Logger('TxCache');

const { TX_BUILDER } = NATIVE_CLIENT;

// Resolve fee cache TTL: env override > constants default
function _resolveFeeCacheTtl(): number {
    try {
        if (hasTxBuilderFeeCacheTtlSet()) {
            const v = getTxBuilderFeeCacheTtl();
            if (typeof v === 'number' && v > 0) return v;
        }
    } catch (err: any) {
        txCacheLogger.warn(`Failed to load TX_BUILDER_FEE_CACHE_TTL_MS config, using default: ${err?.message || err}`);
    }
    return TX_BUILDER.FEE_CACHE_TTL_MS;
}

let _feeCache: any = null;

function _ensureFeeCache(): any {
    if (!_feeCache) {
        _feeCache = new LRUCache(1000, _resolveFeeCacheTtl());
    }
    return _feeCache;
}

/**
 * Build a fee cache key from serialized operations and the fee asset ID.
 * Includes the full op data to avoid stale fees when the same op type
 * has different parameters (e.g. different amounts or extensions).
 */
function buildFeeCacheKey(opList: Array<[number, any]>, feeAssetId: string): string {
    const parts: string[] = [];
    for (const [typeId, params] of opList) {
        parts.push(`${typeId}:${JSON.stringify(params)}`);
    }
    return parts.join('|') + ':' + feeAssetId;
}

function getFees(cacheKey: string): any[] | undefined {
    const cache = _ensureFeeCache();
    const value: any = cache.get(cacheKey);
    if (!value) return undefined;
    return value;
}

function setFees(cacheKey: string, fees: any[]): void {
    const cache = _ensureFeeCache();
    cache.set(cacheKey, fees);
}

/**
 * Peek at cached fees without expiry-based deletion.
 * Returns the fee array even if stale (expired), or undefined if absent.
 * Useful as a fallback when a chain re-fetch fails.
 */
function peekFees(cacheKey: string): any[] | undefined {
    const cache = _ensureFeeCache();
    const stale = cache.getStale(cacheKey);
    return stale ? stale.value : undefined;
}

function invalidateFees(): void {
    if (_feeCache) _feeCache.clear();
}

export { buildFeeCacheKey, getFees, setFees, peekFees, invalidateFees }

