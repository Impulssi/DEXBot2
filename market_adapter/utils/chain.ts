'use strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);


import { API_LIMITS } from '../../modules/constants.js';

let _bitsharesClient: any = null;

function getBitsharesClient() {
    // lazy require to avoid circular dependencies at module load time
    if (!_bitsharesClient) {
        _bitsharesClient = require('./adapter_client');
    }
    return _bitsharesClient;
}

function setBitsharesClientForTests(client: any) {
    _bitsharesClient = client;
}

async function resolveAsset(symbol: any, bitsharesClient: any = null) {
    if (!symbol || typeof symbol !== 'string') {
        throw new Error(`Cannot resolve asset: invalid or missing symbol "${symbol}"`);
    }
    const client = bitsharesClient || getBitsharesClient();
    const results = await client.BitShares.db.lookup_asset_symbols([symbol]);
    const asset = results?.[0];
    if (!asset?.id || typeof asset.precision !== 'number') {
        throw new Error(`Cannot resolve asset "${symbol}": lookup failed`);
    }
    return { id: asset.id, precision: asset.precision, symbol };
}

async function findPoolByAssets(assetAId: any, assetBId: any, options: any = {}) {
    const client = options.bitsharesClient || getBitsharesClient();
    const { BitShares } = client;
    const sortBy = options.sortBy || 'totalBalance'; // 'totalBalance' or 'assetABalance'

    if (typeof BitShares.db?.get_liquidity_pools_by_both_assets === 'function') {
        try {
            const pools = await BitShares.db.get_liquidity_pools_by_both_assets(assetAId, assetBId);
            if (Array.isArray(pools) && pools.length > 0) {
                const valid = pools.filter(p => p?.id);
                if (valid.length) {
                    const idAStr = String(assetAId);
                    if (sortBy === 'assetABalance') {
                        return valid.sort((a, b) => {
                            const bal = (p: any) => {
                                const value = String(p.asset_a ?? p.asset_ids?.[0] ?? '') === idAStr
                                    ? Number(p.balance_a)
                                    : String(p.asset_b ?? p.asset_ids?.[1] ?? '') === idAStr
                                        ? Number(p.balance_b)
                                        : Number.NEGATIVE_INFINITY;
                                return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
                            };
                            return bal(b) - bal(a);
                        })[0];
                    }
                    return valid.sort((x, y) => {
                        const bal = (p: any) => Number(p.balance_a ?? 0) + Number(p.balance_b ?? 0);
                        return bal(y) - bal(x);
                    })[0];
                }
            }
        } catch (_: any) {
            console.warn(`[chain] get_liquidity_pools_by_both_assets failed for ${assetAId}/${assetBId}`);
        }
    }

    const listFn = BitShares.db?.list_liquidity_pools ?? BitShares.db?.get_liquidity_pools;
    if (typeof listFn === 'function') {
        let startId = '1.19.0';
        const page = API_LIMITS.POOL_BATCH_SIZE;
        const a = String(assetAId);
        const b = String(assetBId);

        let scannedBatches = 0;
        while (true) {
            if (scannedBatches++ >= API_LIMITS.MAX_POOL_SCAN_BATCHES) break;
            const pools = await listFn(page, startId);
            if (!Array.isArray(pools) || pools.length === 0) break;

            const effective = startId === '1.19.0' ? pools : pools.slice(1);
            const matches = effective.filter((p) => {
                const ids = (p.asset_ids ?? [p.asset_a, p.asset_b]).map(String);
                return ids.includes(a) && ids.includes(b);
            });
            if (matches.length > 0) {
                if (sortBy === 'assetABalance') {
                    const idAStr = String(assetAId);
                    return matches.sort((a: any, b: any) => {
                        const bal = (p: any) => {
                            const assetA = String(p.asset_a ?? p.asset_ids?.[0] ?? '');
                            const assetB = String(p.asset_b ?? p.asset_ids?.[1] ?? '');
                            const value = assetA === idAStr
                                ? Number(p.balance_a)
                                : assetB === idAStr
                                    ? Number(p.balance_b)
                                    : Number.NEGATIVE_INFINITY;
                            return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
                        };
                        return bal(b) - bal(a);
                    })[0];
                }
                return matches.sort((x: any, y: any) => {
                    const bal = (p: any) => Number(p.balance_a ?? 0) + Number(p.balance_b ?? 0);
                    return bal(y) - bal(x);
                })[0];
            }

            if (pools.length < page) break;
            startId = pools[pools.length - 1].id;
        }
    }

    throw new Error(`No liquidity pool found for ${assetAId}/${assetBId}`);
}

function normalizeAssetSymbol(value: any) {
    return String(value || '').trim().toUpperCase();
}

function isExactPair(a: any, b: any, targetA: any, targetB: any) {
    const na = normalizeAssetSymbol(a);
    const nb = normalizeAssetSymbol(b);
    const nta = normalizeAssetSymbol(targetA);
    const ntb = normalizeAssetSymbol(targetB);
    return na === nta && nb === ntb;
}

function isSamePair(a: any, b: any, targetA: any, targetB: any) {
    return isExactPair(a, b, targetA, targetB) || isExactPair(a, b, targetB, targetA);
}

function isExactPairIds(aId: any, bId: any, targetAId: any, targetBId: any) {
    const sa = String(aId || '');
    const sb = String(bId || '');
    const sta = String(targetAId || '');
    const stb = String(targetBId || '');
    return sa === sta && sb === stb;
}

function isSamePairIds(aId: any, bId: any, targetAId: any, targetBId: any) {
    return isExactPairIds(aId, bId, targetAId, targetBId) || isExactPairIds(aId, bId, targetBId, targetAId);
}

function normalizeMarketSource(raw: any) {
    const value = String(raw || '').trim().toLowerCase();
    if (value === 'pool') return 'pool';
    if (value === 'book') return 'book';
    return null;
}

function hasNumericStartPrice(raw: any) {
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
}

function resolveMarketSourceForBot(bot: any) {
    if (hasNumericStartPrice(bot?.startPrice)) return null;
    return normalizeMarketSource(bot?.startPrice) || 'pool';
}

function normalizePoolId(id: any) {
    if (id == null) return null;
    const s = String(id).trim();
    return s.startsWith('1.19.') ? s : `1.19.${s}`;
}

async function resolveBotContext(bot: any) {
    if (!bot.assetAId && !bot.assetA) {
        throw new Error(`Bot "${bot.botKey}" config is missing assetA symbol or ID`);
    }
    if (!bot.assetBId && !bot.assetB) {
        throw new Error(`Bot "${bot.botKey}" config is missing assetB symbol or ID`);
    }

    const assetA = bot.assetAId && Number.isFinite(bot.assetAPrecision)
        ? { id: bot.assetAId, precision: bot.assetAPrecision, symbol: bot.assetA }
        : await resolveAsset(bot.assetA);

    const assetB = bot.assetBId && Number.isFinite(bot.assetBPrecision)
        ? { id: bot.assetBId, precision: bot.assetBPrecision, symbol: bot.assetB }
        : await resolveAsset(bot.assetB);

    if (hasNumericStartPrice(bot.startPrice)) {
        return {
            assetA,
            assetB,
            poolId: null,
            marketSource: null,
        };
    }

    const marketSource = normalizeMarketSource(bot.startPrice) || 'pool';

    let poolId: string | null = null;
    if (marketSource === 'pool') {
        poolId = bot.poolId
            ? normalizePoolId(bot.poolId)
            : normalizePoolId((await findPoolByAssets(assetA.id, assetB.id)).id);
    }

    return { assetA, assetB, poolId, marketSource };
}

export { resolveAsset, findPoolByAssets, normalizeAssetSymbol, normalizeMarketSource, normalizePoolId, hasNumericStartPrice, resolveMarketSourceForBot, resolveBotContext, isExactPair, isSamePair, isExactPairIds, isSamePairIds, getBitsharesClient, setBitsharesClientForTests }

