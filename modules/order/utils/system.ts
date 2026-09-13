/**
 * modules/order/utils/system.ts - System and I/O Utilities
 * 
 * Price derivation, persistence, grid correction, and UI/interactive utilities.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (21 exported functions)
 * ===============================================================================
 *
 * SECTION 1: PRICE DERIVATION (10 functions)
 *   - lookupAsset(BitShares, symbol) - Lookup asset metadata from blockchain
 *   - deriveMarketPrice(BitShares, symA, symB) - Derive price from order book
 *   - derivePoolPrice(BitShares, symA, symB) - Derive price from liquidity pool
 *   - derivePrice(BitShares, symA, symB, mode) - Derive price with fallback chain
 *   - derivePriceViaBridges(BitShares, symA, symB, bridges, mode) - Multi-hop price via bridge assets
 *   - derivePriceWithBridges(BitShares, symA, symB, bridges, mode) - Direct price, else bridge hops
 *   - resolveLiquidityPoolByShareAsset(BitShares, shareAsset) - Resolve LP by share asset
 *   - deriveLiquidityPoolTokenValue(BitShares, symA, symB) - Derive LP token value
 *   - loadAmaCenterPrice(manager) - Load AMA center price
 *   - loadAmaCenterSnapshot(manager) - Load AMA center snapshot
 *
 * SECTION 2: FEE MANAGEMENT (1 function)
 *   - initializeFeeCache(botsConfig, BitShares) - Initialize fee cache from blockchain
 *
 * SECTION 3: GRID STATE MANAGEMENT (3 functions)
 *   - persistGridSnapshot(manager, accountOrders) - Persist grid to storage
 *   - retryPersistenceIfNeeded(manager) - Retry persistence if previous failed
 *   - applyGridDivergenceCorrections(manager, ...) - Apply grid divergence corrections
 *
 * SECTION 4: UI & INTERACTIVE UTILITIES (7 functions)
 *   - ensureProfilesDirectory(profilesDir) - Ensure profiles directory exists
 *   - sleep(ms) - Pause execution for specified duration
 *   - readInput(prompt, options) - Read user input from stdin
 *   - readPassword(prompt) - Read password with masked echo
 *   - withRetry(fn, options) - Execute async function with exponential backoff
 *   - withTimeout(promise, timeoutMs, options) - defined in ./timeout
 *   - withBlockchainRetry(fn, label, options) - Blockchain op with timeout + retry + node failover
 *
 * SECTION 6: GENERAL UTILITIES (5 functions)
 *   - resolveAccountRef(manager, account) - Resolve best account reference
 *   - deepFreeze(obj) - Recursively freeze object for immutability
 *   - cloneMap(map) - Create shallow clone of Map
 *   - ensureDir(dirPath) - Ensure directory exists, creating recursively
 *   - parseJsonWithComments(raw) - Parse JSON with comment stripping
 *
 * ===============================================================================
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { path } from '../../path_api.js';
import { getStorage } from '../../storage/index.js';
const storage = getStorage();
import { API_LIMITS, ORDER_TYPES, ORDER_STATES, COW_ACTIONS, FEE_PARAMETERS, BTS_PRECISION, PIPELINE_TIMING, NATIVE_CLIENT } from '../../constants.js';
import { PATHS } from '../../paths.js';
import { toFiniteNumber, isValidNumber } from '../format.js';
import * as MathUtils from './math.js';
import * as OrderUtils from './order.js';
import Logger from '../../order/logger.js';
import { runtime } from '../../runtime.js';
import { getErrorMessage } from '../../utils/errors.js';
import { withTimeout } from './timeout.js';
const { ensureDir, readJSON } = storage;
const systemLogger = new Logger('System');

function _debugLogAndNull(method: any, symA: any, symB: any) {
    return (err: any) => {
        // debug level: underlying derivePoolPrice/deriveMarketPrice already log at warn
        systemLogger.debug(`derivePrice(${method}) for ${symA}/${symB}: ${getErrorMessage(err)}`);
        return null;
    };
}

// ================================================================================
// SECTION 1: PRICE DERIVATION
// ================================================================================

const poolIdCache = new Map();

/**
 * @private Lookup asset by symbol from BitShares blockchain.
 * Tries cached assets first, then falls back to lookup API methods.
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} s - Asset symbol to lookup
 * @returns {Promise<Object>} Asset metadata with id, symbol, precision
 * @throws {Error} If asset cannot be found on blockchain
 */
export const lookupAsset = async (BitShares: any, s: string): Promise<any> => {
    if (!BitShares) return null;
    let cached: any = null;
    if (BitShares?.assets) {
        try {
            cached = await BitShares.assets[s];
        } catch (_: any) {
            systemLogger.debug(`lookupAsset: cache access failed for ${s}`);
        }
    }

    if (cached?.id && typeof cached.precision === 'number') {
        return cached;
    }

    const methods = [
        () => BitShares.db.lookup_asset_symbols([s]),
        () => BitShares.db.get_assets([s])
    ];

    for (const method of methods) {
        try {
            if (typeof method !== 'function') continue;
            const r = await method();
            if (r?.[0]?.id && typeof r[0].precision === 'number') {
                return { ...(cached || {}), ...r[0] };
            }
        } catch (e: any) {
            systemLogger.debug(`lookupAsset: method failed for ${s}: ${getErrorMessage(e)}`);
        }
    }

    throw new Error(`CRITICAL: Cannot fetch asset precision for '${s}'`);
};

/**
 * Resolve a full asset object from an asset reference (object ID like 1.3.x or symbol).
 * Routes object IDs to get_assets and symbols to lookup_asset_symbols, trying
 * camelCase, snake_case, and db.call() forms. Shared by chain_orders, credit_runtime,
 * and credential_policy so asset resolution behavior stays consistent.
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {*} ref - Asset ID (e.g. '1.3.0') or symbol (e.g. 'BTS')
 * @returns {Promise<Object|null>} Asset object or null if unresolvable
 */
export const resolveAssetByRef = async (BitShares: any, ref: any): Promise<any> => {
    if (!BitShares?.db) return null;
    const cacheKey = String(ref);
    const method = /^1\.3\.\d+$/.test(cacheKey) ? 'get_assets' : 'lookup_asset_symbols';
    const camelMethod = method.replace(/_([a-z])/g, (_: any, c: string) => c.toUpperCase());
    try {
        if (typeof BitShares.db[camelMethod] === 'function') {
            const result = await BitShares.db[camelMethod]([cacheKey]);
            return Array.isArray(result) ? result[0] || null : null;
        }
        if (typeof BitShares.db[method] === 'function') {
            const result = await BitShares.db[method]([cacheKey]);
            return Array.isArray(result) ? result[0] || null : null;
        }
        if (typeof BitShares.db.call === 'function') {
            const result = await BitShares.db.call(method, [[cacheKey]]);
            return Array.isArray(result) ? result[0] || null : null;
        }
    } catch (e: any) {
        systemLogger.debug(`resolveAssetByRef failed for ${cacheKey}: ${getErrorMessage(e)}`);
    }
    return null;
};

/**
 * Derive price from BitShares DEX order book.
 * Returns price in B/A format (units of asset B per 1 unit of asset A).
 * Uses best bid and ask from order book, with fallback to ticker.
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol
 * @param {string} symB - Second asset symbol
 * @returns {Promise<number|null>} Derived market price or null if unavailable
 */
export const deriveMarketPrice = async (BitShares: any, symA: string, symB: string): Promise<number | null> => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        const baseId = aMeta.id;
        const quoteId = bMeta.id;
        let mid: number | null = null;

        if (typeof BitShares.db?.get_order_book === 'function') {
            try {
                const ob = await BitShares.db.get_order_book(baseId, quoteId, API_LIMITS.ORDERBOOK_DEPTH);
                const bestBid = isValidNumber(ob.bids?.[0]?.price) ? toFiniteNumber(ob.bids[0].price) : null;
                const bestAsk = isValidNumber(ob.asks?.[0]?.price) ? toFiniteNumber(ob.asks[0].price) : null;
                if (bestBid !== null && bestAsk !== null) mid = (bestBid + bestAsk) / 2;
            } catch (e: any) {
                systemLogger.debug(`deriveMarketPrice: get_order_book failed for ${symA}/${symB}: ${getErrorMessage(e)}`);
            }
        }

        if (mid === null && typeof BitShares.db?.get_ticker === 'function') {
            try {
                const t = await BitShares.db.get_ticker(baseId, quoteId);
                mid = isValidNumber(t?.latest) ? toFiniteNumber(t.latest) : (isValidNumber(t?.latest_price) ? toFiniteNumber(t.latest_price) : null);
            } catch (err: any) {
                systemLogger.debug(`deriveMarketPrice: get_ticker failed for ${symA}/${symB}: ${getErrorMessage(err)}`);
            }
        }

        // Return B/A orientation to match market price format
        const finalPrice = (mid !== null && mid !== 0) ? 1 / mid : null;
        if (finalPrice) {
            systemLogger.info(`deriveMarketPrice: ${symA}/${symB} rawMid=${mid?.toFixed(8)} -> finalPrice(B/A)=${finalPrice.toFixed(8)}`);
        }
        return finalPrice;
    } catch (err: any) {
        systemLogger.warn(`deriveMarketPrice failed for ${symA}/${symB}: ${getErrorMessage(err)}`);
        return null;
    }
};

/**
 * Derive price from BitShares Liquidity Pool (AMM).
 * Returns price in B/A format (units of asset B per 1 unit of asset A).
 * Handles internal BitShares ID-based asset ordering (asset_a/asset_b).
 * 
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol
 * @param {string} symB - Second asset symbol
 * @returns {Promise<number|null>} Derived pool price or null if unavailable
 */
export const derivePoolPrice = async (BitShares: any, symA: string, symB: string): Promise<number | null> => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        let chosen: any = null;
        const cacheKey = [aMeta.id, bMeta.id].sort().join(':');
        const cachedPoolId = poolIdCache.get(cacheKey);

        if (typeof BitShares.db?.get_liquidity_pools_by_both_assets === 'function') {
            try {
                const pools = await BitShares.db.get_liquidity_pools_by_both_assets(aMeta.id, bMeta.id);
                if (Array.isArray(pools) && pools.length > 0) {
                    const valid = pools.filter((p: any) => p?.id);
                    if (valid.length) {
                        chosen = valid.sort((a: any, b: any) => {
                            const getBal = (p: any) => toFiniteNumber(String(p.asset_a) === String(aMeta.id) ? p.balance_a : p.balance_b);
                            return getBal(b) - getBal(a);
                        })[0];
                        if (chosen) poolIdCache.set(cacheKey, chosen.id);
                    }
                }
            } catch (e: any) {
                systemLogger.debug(`derivePoolPrice: get_liquidity_pools_by_both_assets failed: ${getErrorMessage(e)}`);
            }
        }

        if (!chosen && cachedPoolId && typeof BitShares.db?.get_objects === 'function') {
            try {
                const [pool] = await BitShares.db.get_objects([cachedPoolId]);
                if (pool) chosen = pool;
            } catch (e: any) {
                poolIdCache.delete(cacheKey);
            }
        }

        if (!chosen) {
            const listFn = BitShares.db?.list_liquidity_pools || BitShares.db?.get_liquidity_pools;
            if (typeof listFn === 'function') {
                try {
                    let startId = '1.19.0';
                    const pageSize = API_LIMITS.POOL_BATCH_SIZE;
                    const allMatches: any[] = [];

                    let scannedBatches = 0;
                    while (true) {
                        if (scannedBatches++ >= API_LIMITS.MAX_POOL_SCAN_BATCHES) break;
                        const pools = await listFn(pageSize, startId);
                        if (!pools || pools.length === 0) break;

                        // BitShares list_liquidity_pools is inclusive of startId.
                        // Skip the first pool in subsequent pages to avoid duplicate processing.
                        const effectivePools = (startId === '1.19.0') ? pools : pools.slice(1);
                        if (effectivePools.length === 0) break;

                        const matches = effectivePools.filter((p: any) => {
                            const ids = (p.asset_ids || [p.asset_a, p.asset_b]).map(String);
                            return ids.includes(String(aMeta.id)) && ids.includes(String(bMeta.id));
                        });

                        if (matches.length) {
                            allMatches.push(...matches);
                        }

                        if (pools.length < pageSize) {
                            break;
                        } else {
                            startId = pools[pools.length - 1].id;
                        }
                    }

                    if (allMatches.length) {
                        // Select pool with highest balance for our assetA
                        chosen = allMatches.sort((a: any, b: any) => {
                            const getBal = (p: any) => toFiniteNumber(String(p.asset_a) === String(aMeta.id) ? p.balance_a : p.balance_b);
                            return getBal(b) - getBal(a);
                        })[0];
                        poolIdCache.set(cacheKey, chosen.id);
                    }
                } catch (e: any) {
                    systemLogger.warn(`derivePoolPrice: pool pagination failed: ${getErrorMessage(e) || e}`);
                }
            }
        }

        if (!chosen) return null;

        if (!chosen.reserves && !isValidNumber(chosen.balance_a) && typeof BitShares.db?.get_objects === 'function') {
            try {
                const [full] = await BitShares.db.get_objects([chosen.id]);
                if (full) chosen = full;
            } catch (e: any) {
                systemLogger.debug(`derivePoolPrice: get_objects failed for pool ${chosen.id}: ${getErrorMessage(e)}`);
            }
        }

        let amtA: any = null, amtB: any = null;
        if (isValidNumber(chosen.balance_a) && isValidNumber(chosen.balance_b)) {
            // Pools store assets ordered by ID: lower ID is always first (asset_a)
            const aIdNum = toFiniteNumber(String(aMeta.id).split('.')[2]);
            const bIdNum = toFiniteNumber(String(bMeta.id).split('.')[2]);
            const aIsFirst = aIdNum < bIdNum;

            // If config's assetA has lower ID, it's the pool's first asset (asset_a)
            // Otherwise, our assetA corresponds to pool's second asset (asset_b)
            if (aIsFirst) {
                amtA = toFiniteNumber(chosen.balance_a);
                amtB = toFiniteNumber(chosen.balance_b);
            } else {
                amtA = toFiniteNumber(chosen.balance_b);
                amtB = toFiniteNumber(chosen.balance_a);
            }
        } else if (Array.isArray(chosen.reserves)) {
            const resA = chosen.reserves.find((r: any) => String(r.asset_id) === String(aMeta.id));
            const resB = chosen.reserves.find((r: any) => String(r.asset_id) === String(bMeta.id));
            if (resA && resB) {
                amtA = resA.amount;
                amtB = resB.amount;
            }
        }

        if (!isValidNumber(amtA) || !isValidNumber(amtB) || toFiniteNumber(amtB) === 0) return null;

        const floatA = MathUtils.blockchainToFloat(amtA, aMeta.precision);
        const floatB = MathUtils.blockchainToFloat(amtB, bMeta.precision);

        // Return B/A orientation to match market price format
        const finalPrice = floatB > 0 ? floatB / floatA : null;
        if (finalPrice) {
            systemLogger.info(`derivePoolPrice: ${symA}/${symB} pool=${chosen.id} amtA=${amtA}(prec=${aMeta.precision}) amtB=${amtB}(prec=${bMeta.precision}) -> finalPrice(B/A)=${finalPrice.toFixed(8)}`);
        }
        return finalPrice;
    } catch (err: any) {
        systemLogger.warn(`derivePoolPrice failed for ${symA}/${symB}: ${getErrorMessage(err)}`);
        return null;
    }
};

/**
 * Derive price from blockchain using specified mode.
 * Attempts pool or market derivation based on mode, with fallback chain.
 * 
 * @param {Object} BitShares - BitShares client instance
  * @param {string} symA - First asset symbol
  * @param {string} symB - Second asset symbol
  * @param {string} [mode='auto'] - Derivation mode: "pool", "book", or "auto" (pool → book).
  * @returns {Promise<number|null>} Derived price or null if all methods fail
  */
 let _derivePriceTestHook: ((...args: any[]) => any) | null = null;

 /**
  * Test-only seam: compiled ESM exports cannot be monkey-patched, so tests
  * install a hook here to short-circuit price derivation (offline runs).
  */
 export const setDerivePriceTestHook = (fn: ((...args: any[]) => any) | null): void => {
     _derivePriceTestHook = fn;
 };

 export const derivePrice = async (BitShares: any, symA: string, symB: string, mode: string = 'auto'): Promise<number | null> => {
    if (_derivePriceTestHook) return await _derivePriceTestHook(BitShares, symA, symB, mode);
    mode = String(mode).toLowerCase();
    const validModes = new Set(['pool', 'book', 'auto']);

    if (!validModes.has(mode)) {
        systemLogger.debug(`derivePrice: invalid mode "${mode}" for ${symA}/${symB}`);
        return null;
    }

    if (mode === 'pool') {
        return await derivePoolPrice(BitShares, symA, symB).catch(_debugLogAndNull('pool', symA, symB));
    }

    if (mode === 'book') {
        return await deriveMarketPrice(BitShares, symA, symB).catch(_debugLogAndNull('book', symA, symB));
    }

    // mode === 'auto': pool preferred, market fallback
    let poolP: number | null = null;
    poolP = await derivePoolPrice(BitShares, symA, symB).catch(_debugLogAndNull('auto/pool', symA, symB));
    if (poolP != null && poolP > 0) return poolP;

    const m = await deriveMarketPrice(BitShares, symA, symB).catch(_debugLogAndNull('auto/book', symA, symB));
    if (m != null && m > 0) return m;

    systemLogger.debug(`derivePrice: all methods failed for ${symA}/${symB}`);
    return null;
};

/**
 * Default bridge assets for multi-hop price derivation. BTS is the core
 * asset with the deepest markets, so almost every listed asset has a price
 * path against it even when no direct market exists for an exotic pair.
 */
export const DEFAULT_PRICE_BRIDGES = ['BTS'];

function isPositiveRate(value: any): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Derive price via bridge assets only (no direct market attempt).
 * Returns price in B/A format (units of asset B per 1 unit of asset A) as
 * price(A in X) * price(X in B) for the first bridge X with both legs
 * available. Skips bridges equal to either side; identity (A === B) is 1.
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol or ID
 * @param {string} symB - Second asset symbol or ID
 * @param {string[]} [bridges] - Bridge asset symbols/IDs to try in order
 * @param {string} [mode='auto'] - Price derivation mode passed to derivePrice
 * @returns {Promise<{rate:number,path:string}|null>} Rate plus 'bridge:<ref>' path, or null
 */
export async function derivePriceViaBridges(BitShares: any, symA: string, symB: string, bridges: string[] = DEFAULT_PRICE_BRIDGES, mode: string = 'auto'): Promise<{ rate: number; path: string } | null> {
    try {
        if (String(symA) === String(symB)) {
            return { rate: 1, path: 'identity' };
        }
        const list = Array.isArray(bridges) ? bridges : [];
        for (const bridge of list) {
            if (!bridge || String(bridge) === String(symA) || String(bridge) === String(symB)) continue;
            const [legA, legB] = await Promise.all([
                derivePrice(BitShares, symA, bridge, mode).catch(() => null),
                derivePrice(BitShares, bridge, symB, mode).catch(() => null),
            ]);
            if (isPositiveRate(legA) && isPositiveRate(legB)) {
                return { rate: legA * legB, path: `bridge:${bridge}` };
            }
        }
        return null;
    } catch (err: any) {
        systemLogger.debug(`derivePriceViaBridges failed for ${symA}/${symB}: ${getErrorMessage(err)}`);
        return null;
    }
}

/**
 * Derive price with universal fallback: direct pool/book market first, then
 * multi-hop via bridge assets. Unlike derivePrice (null when no direct
 * market exists), this resolves a rate for every pair whose assets each
 * have some market against a shared bridge — the last-resort pricing used
 * for credit collateral conversion when the lending offer lists no price
 * for the collateral (or the pool cannot be valued directly).
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {string} symA - First asset symbol or ID
 * @param {string} symB - Second asset symbol or ID
 * @param {string[]} [bridges] - Bridge asset symbols/IDs to try in order
 * @param {string} [mode='auto'] - Price derivation mode passed to derivePrice
 * @returns {Promise<{rate:number,path:string}|null>} Rate plus 'direct' | 'identity' | 'bridge:<ref>' path, or null
 */
export async function derivePriceWithBridges(BitShares: any, symA: string, symB: string, bridges: string[] = DEFAULT_PRICE_BRIDGES, mode: string = 'auto'): Promise<{ rate: number; path: string } | null> {
    if (String(symA) === String(symB)) {
        return { rate: 1, path: 'identity' };
    }
    const direct = await derivePrice(BitShares, symA, symB, mode).catch(() => null);
    if (isPositiveRate(direct)) {
        return { rate: direct, path: 'direct' };
    }
    return derivePriceViaBridges(BitShares, symA, symB, bridges, mode);
}

/**
 * Resolve a liquidity pool from a share asset reference.
 * Looks up the share asset, then queries the blockchain for associated pools.
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {string} shareAssetRef - Share asset symbol or reference
 * @returns {Promise<Object|null>} Object with {shareAsset, pool} or null if not found
 */
export async function resolveLiquidityPoolByShareAsset(BitShares: any, shareAssetRef: string): Promise<any> {
    if (!BitShares?.db || typeof BitShares.db.get_liquidity_pools_by_share_asset !== 'function') {
        return null;
    }

    const shareAsset = await lookupAsset(BitShares, shareAssetRef).catch((e: any) => {
        systemLogger.debug(`resolveLiquidityPoolByShareAsset: lookupAsset failed for ${shareAssetRef}: ${getErrorMessage(e)}`);
        return null;
    });
    if (!shareAsset?.id) {
        return null;
    }

    const response = await BitShares.db.get_liquidity_pools_by_share_asset([shareAsset.id], false, false).catch((e: any) => {
        systemLogger.debug(`resolveLiquidityPoolByShareAsset: get_liquidity_pools_by_share_asset failed for ${shareAssetRef}: ${getErrorMessage(e)}`);
        return null;
    });
    if (!Array.isArray(response)) {
        return null;
    }

    const pool = response.find((entry: any) => entry && (entry.id || entry.pool?.id)) || null;
    if (!pool) {
        return null;
    }

    return {
        shareAsset,
        pool: pool.pool || pool,
    };
}

async function getAssetCurrentSupply(BitShares: any, assetRef: any): Promise<any> {
    const asset = typeof assetRef === 'object' && assetRef !== null
        ? assetRef
        : await lookupAsset(BitShares, assetRef).catch((e: any) => {
            systemLogger.debug(`getAssetCurrentSupply: lookupAsset failed for ${assetRef}: ${getErrorMessage(e)}`);
            return null;
        });
    if (!asset) {
        return null;
    }

    const hasDirectSupply = asset.current_supply != null;
    const directSupply = hasDirectSupply
        ? toFiniteNumber(asset.current_supply?.amount ?? asset.current_supply, -1)
        : -1;
    if (hasDirectSupply && Number.isFinite(directSupply) && directSupply >= 0) {
        return directSupply;
    }

    const dynamicId = asset.dynamic_asset_data_id || asset.dynamicDataId || asset.dynamic_data_id || null;
    if (!dynamicId || typeof BitShares?.db?.get_objects !== 'function') {
        return null;
    }

    const objects = await BitShares.db.get_objects([dynamicId]).catch((e: any) => {
        systemLogger.debug(`getAssetCurrentSupply: get_objects failed for ${dynamicId}: ${getErrorMessage(e)}`);
        return null;
    });
    const dynamicData = Array.isArray(objects) ? objects[0] : null;
    const supply = toFiniteNumber(
        dynamicData?.current_supply?.amount
        ?? dynamicData?.current_supply?.value
        ?? dynamicData?.current_supply,
        undefined
    );
    return Number.isFinite(supply) && supply >= 0 ? supply : null;
}

/**
 * Derive the value of a liquidity pool share token in a denomination asset.
 * Resolves the pool, fetches reserves and supply, then prices both pool assets
 * against the denomination asset to compute total value per share.
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {string} shareAssetRef - Share asset symbol
 * @param {string} denominationAssetRef - Denomination asset symbol
 * @param {string} [mode='auto'] - Price derivation mode ("pool", "book", or "auto")
 * @param {boolean} [allowBridges=false] - When true, a reserve leg with no
 *   direct market may be priced via bridge assets (see derivePriceViaBridges).
 *   Defaults to false so existing callers keep the previous direct-only
 *   behavior; the credit runtime opts in explicitly.
 * @returns {Promise<number|null>} Value per share in denomination asset, or null
 */
export async function deriveLiquidityPoolTokenValue(BitShares: any, shareAssetRef: string, denominationAssetRef: string, mode: string = 'auto', allowBridges: boolean = false): Promise<number | null> {
    try {
        const [shareAsset, denominationAsset] = await Promise.all([
            lookupAsset(BitShares, shareAssetRef),
            lookupAsset(BitShares, denominationAssetRef),
        ]);

        if (!shareAsset?.id || !denominationAsset?.id) {
            return null;
        }

        const poolInfo = await resolveLiquidityPoolByShareAsset(BitShares, shareAsset.id);
        if (!poolInfo?.pool) {
            return null;
        }

        const [assetA, assetB, supply] = await Promise.all([
            lookupAsset(BitShares, poolInfo.pool.asset_a),
            lookupAsset(BitShares, poolInfo.pool.asset_b),
            getAssetCurrentSupply(BitShares, shareAsset),
        ]);

        if (!assetA?.id || !assetB?.id || !Number.isFinite(supply) || supply <= 0) {
            return null;
        }

        const reserveA = MathUtils.blockchainToFloat(poolInfo.pool.balance_a, assetA.precision);
        const reserveB = MathUtils.blockchainToFloat(poolInfo.pool.balance_b, assetB.precision);
        if (!isValidNumber(reserveA) || !isValidNumber(reserveB)) {
            return null;
        }

        // Each reserve leg is priced directly first, then — only when the
        // caller opts in via allowBridges — via bridge assets (e.g.
        // reserve -> BTS -> denomination). Without the bridge fallback the
        // whole LP valuation fails when a single exotic reserve has no
        // direct market against the denomination asset.
        const priceReserveLeg = async (asset: any): Promise<number | null> => {
            if (String(asset.id) === String(denominationAsset.id)) return 1;
            const direct = await derivePrice(BitShares, asset.id, denominationAsset.id, mode).catch((e: any) => {
                systemLogger.debug(`deriveLiquidityPoolTokenValue: derivePrice failed for ${asset.id}/${denominationAsset.id}: ${getErrorMessage(e)}`);
                return null;
            });
            if (isPositiveRate(direct)) return direct;
            if (!allowBridges) return null;
            const bridged = await derivePriceViaBridges(BitShares, asset.id, denominationAsset.id, DEFAULT_PRICE_BRIDGES, mode).catch(() => null);
            if (bridged && isPositiveRate(bridged.rate)) {
                systemLogger.debug(`deriveLiquidityPoolTokenValue: bridged reserve leg ${asset.id}/${denominationAsset.id} via ${bridged.path}`);
                return bridged.rate;
            }
            return null;
        };

        const priceA = await priceReserveLeg(assetA);
        const priceB = await priceReserveLeg(assetB);

        if (priceA == null || priceB == null || !isValidNumber(priceA) || !isValidNumber(priceB) || priceA <= 0 || priceB <= 0) {
            return null;
        }

        const supplyFloat = MathUtils.blockchainToFloat(supply, shareAsset.precision);
        if (!isValidNumber(supplyFloat) || supplyFloat <= 0) {
            return null;
        }

        const totalValue = reserveA * priceA! + reserveB * priceB!;
        const valuePerShare = totalValue / supplyFloat;
        return isValidNumber(valuePerShare) && valuePerShare > 0 ? valuePerShare : null;
    } catch (err: any) {
        systemLogger.debug(`deriveLiquidityPoolTokenValue failed for ${shareAssetRef}/${denominationAssetRef}: ${getErrorMessage(err)}`);
        return null;
    }
}

/**
 * Load the full dynamic grid snapshot written by market_adapter for a bot.
 * The snapshot is stored atomically at profiles/orders/<botKey>.dynamicgrid.json
 * and is updated every market adapter cycle. It contains the persisted grid
 * center and, for dynamic-weight-whitelisted bots, any computed effective weight offsets.
 * On full grid resets the bot may rewrite gridCenterPrice to the latest AMA baseline, but
 * amaCenterPrice remains the raw AMA output for diagnostics and comparison.
 * The snapshot may also expose AMA slope diagnostics and a gridPriceOffsetPct
 * that downstream grid initialization can apply to the raw center price.
 * Called by initializeGrid() when manager.config.gridPrice uses an AMA keyword,
 * by performGridResync(), and by refreshDynamicWeightDistribution() before every
 * rebalance so new orders use live weights — not only on grid reset.
 * @param {string} botKey - Bot key (e.g. "iob-aaa-bbb-0")
 * @returns {Object|null} Snapshot with center and optional dynamicWeights fields, or null if invalid
 */
export function loadAmaCenterSnapshot(botKey: string): any {
    try {
        const gridPriceFile = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);
        const data = readJSON(gridPriceFile);
        const gridCenterPrice = Number(data?.gridCenterPrice ?? data?.centerPrice);
        const amaCenterPrice = Number(data?.amaCenterPrice);
        if (!Number.isFinite(gridCenterPrice) || gridCenterPrice <= 0) {
            return null;
        }
        return {
            gridCenterPrice,
            centerPrice: gridCenterPrice,
            amaCenterPrice: Number.isFinite(amaCenterPrice) && amaCenterPrice > 0 ? amaCenterPrice : null,
            source: data?.source || null,
            updatedAt: data?.updatedAt || null,
            amaSlopePercentMode: data?.amaSlopePercentMode || null,
            amaSlope: data?.amaSlope ?? null,
            gridRangeScalingAmaSlope: data?.gridRangeScalingAmaSlope ?? null,
            gridPriceOffsetPct: Number.isFinite(Number(data?.gridPriceOffsetPct))
                ? Number(data.gridPriceOffsetPct)
                : null,
            amaSlopeDeltaPercent: Number.isFinite(Number(data?.amaSlopeDeltaPercent))
                ? Number(data.amaSlopeDeltaPercent)
                : null,
            amaSlopeThresholdPercent: Number.isFinite(Number(data?.amaSlopeThresholdPercent))
                ? Number(data.amaSlopeThresholdPercent)
                : null,
            dynamicWeights: data?.dynamicWeights || null,
            asymmetricBounds: data?.asymmetricBounds && typeof data.asymmetricBounds === 'object'
                ? data.asymmetricBounds
                : null,
        };
    } catch (_: any) {
        return null;
    }
}

/**
 * Load the AMA grid center price written by market_adapter for a bot.
 * This is the numeric accessor used by the order engine.
 * @param {string} botKey - Bot key (e.g. "iob-aaa-bbb-0")
 * @returns {number|null} Grid center price in B/A format, or null if file absent/invalid
 */
export function loadAmaCenterPrice(botKey: string): number | null {
    const snapshot = loadAmaCenterSnapshot(botKey);
    return snapshot ? snapshot.gridCenterPrice : null;
}

// ================================================================================
// SECTION 2: FEE MANAGEMENT (INIT)
// ================================================================================

/**
 * Load previously persisted fee cache from disk.
 * @returns {Record<string, any>} Cached fee data or empty object
 */
function _loadFeeCacheFromDisk(): Record<string, any> {
    try {
        const filePath = PATHS.PROFILES.FEE_CACHE_JSON;
        if ((storage as any).exists(filePath)) {
            const diskCache = (storage as any).readJSON(filePath);
            if (diskCache && typeof diskCache === 'object') {
                systemLogger.debug(`_loadFeeCacheFromDisk: loaded fee cache (${Object.keys(diskCache).length} assets)`);
                return diskCache;
            }
        }
    } catch (e: any) {
        systemLogger.debug(`_loadFeeCacheFromDisk: ${getErrorMessage(e)}`);
    }
    return {};
}

/**
 * Persist fee cache to disk for recovery across restarts.
 * @param {Record<string, any>} cache - Fee cache to persist
 */
function _saveFeeCacheToDisk(cache: Record<string, any>): void {
    try {
        (storage as any).writeJSON(PATHS.PROFILES.FEE_CACHE_JSON, cache);
    } catch (e: any) {
        systemLogger.debug(`_saveFeeCacheToDisk: ${getErrorMessage(e)}`);
    }
}

/**
 * Initialize fee cache from blockchain.
 * Fetches BTS operation fees and asset market fees for all unique assets in config.
 * Populates internal fee cache used by math.js::getAssetFees.
 * Falls back to disk-persisted cache if blockchain lookup fails.
 * 
 * @param {Array<Object>} botsConfig - Array of bot configurations
 * @param {Object} BitShares - BitShares client instance
 * @returns {Promise<Object>} Fee cache object keyed by asset symbol
 */
export async function initializeFeeCache(botsConfig: any[], BitShares: any): Promise<Record<string, any>> {
    const uniqueAssets = new Set(['BTS']);
    for (const bot of botsConfig) {
        if (bot.assetA) uniqueAssets.add(bot.assetA);
        if (bot.assetB) uniqueAssets.add(bot.assetB);
    }

    // Seed from disk so previously cached assets survive transient API failures
    const cache: Record<string, any> = _loadFeeCacheFromDisk();

    const maxAttempts = FEE_PARAMETERS.FEE_CACHE_RETRY_ATTEMPTS;
    const baseDelay = FEE_PARAMETERS.FEE_CACHE_RETRY_DELAY_MS;

    for (const assetSymbol of uniqueAssets) {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                if (assetSymbol === 'BTS') {
                    const globalProps = await BitShares.db.getGlobalProperties();
                    const currentFees = globalProps.parameters.current_fees.parameters;
                    const findFee = (opCode: any) => {
                        const param = currentFees.find((p: any) => p[0] === opCode);
                        const fee = param?.[1]?.fee;
                        const feeNum = toFiniteNumber(fee);
                        return {
                            raw: feeNum,
                            satoshis: feeNum,
                            bts: MathUtils.blockchainToFloat(feeNum, BTS_PRECISION)
                        };
                    };
                    const makerFeeDiscountRaw = toFiniteNumber(
                        globalProps?.parameters?.extensions?.maker_fee_discount_percent,
                        FEE_PARAMETERS.MAKER_REFUND_PERCENT * NATIVE_CLIENT.CHAIN.PERCENT_100
                    );
                    cache.BTS = {
                        limitOrderCreate: findFee(NATIVE_CLIENT.OPERATIONS.LIMIT_ORDER_CREATE),
                        limitOrderCancel: findFee(NATIVE_CLIENT.OPERATIONS.LIMIT_ORDER_CANCEL),
                        limitOrderUpdate: findFee(NATIVE_CLIENT.OPERATIONS.LIMIT_ORDER_UPDATE),
                        makerFeeDiscountPercent: Math.max(0, makerFeeDiscountRaw) / NATIVE_CLIENT.CHAIN.PERCENT_100
                    };
                } else {
                    const fullAsset = await lookupAsset(BitShares, assetSymbol);
                    const options = fullAsset.options || {};
                    cache[assetSymbol] = {
                        assetId: fullAsset.id,
                        symbol: assetSymbol,
                        precision: fullAsset.precision,
                        chargesMarketFees: (Number(options.flags || 0) & 0x01) !== 0,
                        marketFee: { percent: (options.market_fee_percent || 0) / 100 },
                        takerFee: options.taker_fee_percent ? { percent: options.taker_fee_percent / 100 } : null,
                        maxMarketFee: {
                            raw: options.max_market_fee || 0,
                            float: MathUtils.blockchainToFloat(options.max_market_fee || 0, fullAsset.precision)
                        }
                    };
                }
                lastError = null;
                break; // success
            } catch (error: any) {
                lastError = error;
                if (attempt < maxAttempts) {
                    const delay = baseDelay * attempt;
                    systemLogger.warn(
                        `initializeFeeCache: attempt ${attempt}/${maxAttempts} failed for ${assetSymbol}: ${getErrorMessage(error)}. Retrying in ${delay}ms...`
                    );
                    await sleep(delay);
                }
            }
        }

        if (lastError) {
            const hasDiskFallback = cache[assetSymbol] !== undefined;
            systemLogger.warn(
                `initializeFeeCache: all ${maxAttempts} attempts failed for ${assetSymbol}: ${getErrorMessage(lastError)}` +
                (hasDiskFallback ? '. Using previously cached value from disk.' : '.')
            );
        }
    }

    MathUtils._setFeeCache(cache);
    _saveFeeCacheToDisk(cache);
    return cache;
}

// ================================================================================
// SECTION 3: GRID STATE MANAGEMENT
// ================================================================================

/**
 * Persist current grid state to storage.
 * Saves all orders, cache funds, fees, boundary index, and asset info.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} accountOrders - AccountOrders data accessor
 * @returns {Promise<boolean>} True if persistence succeeded, false on error
 */
export async function persistGridSnapshot(manager: any, accountOrders: any, snapshotOrders?: any[], recentFillKeys?: Record<string, number>, fundSnapshot?: { btsFeesOwed: number; accountTotals: any }): Promise<boolean> {
    if (!manager || !accountOrders) return false;
    try {
        const orders = Array.isArray(snapshotOrders)
            ? snapshotOrders
            : Array.from(manager.orders.values());
        const pricing = manager._lastGridPricingContext || null;
        let debugConfig = manager.config || null;
        if (debugConfig && pricing) {
            const {
                gridPrice: _gridPrice,
                configuredMinPrice: _configuredMinPrice,
                configuredMaxPrice: _configuredMaxPrice,
                rangeScalingFactor: _rangeScalingFactor,
                ...restConfig
            } = debugConfig;
            debugConfig = {
                gridPrice: pricing.gridPrice,
                configuredMinPrice: pricing.configuredMinPrice,
                configuredMaxPrice: pricing.configuredMaxPrice,
                rangeScalingFactor: pricing.rangeScalingFactor,
                ...restConfig
            };
        }
        const btsBalance = (manager.config?.assetA !== 'BTS' && manager.config?.assetB !== 'BTS')
            ? (manager.btsBalance || { free: 0, total: 0, locked: 0 })
            : null;

        const fillKeys = recentFillKeys || manager._recentFillKeysSnapshot || undefined;
        const btsFeesOwed = fundSnapshot?.btsFeesOwed ?? manager.funds.btsFeesOwed;
        const accountTotals = (fundSnapshot?.accountTotals ?? manager.accountTotals) || null;
        const genesis = (manager as any)._genesis || null;
        // Gap-evacuation streaks (Phase 3 restart resilience): Map -> plain
        // object; empty map persists as cleared so stale ids never resurrect.
        // Non-Map (legacy callers without the field) passes undefined so
        // storeMasterGrid leaves any previously stored streaks untouched.
        const gapEvacStreaks = manager._gapEvacStreaks instanceof Map
            ? Object.fromEntries([...manager._gapEvacStreaks.entries()].filter(([, n]) => Number.isFinite(Number(n)) && Number(n) > 0))
            : undefined;
        // Pending fill crawls (restart resilience): fills whose boundary
        // crawl was recorded but never committed. Plain-array snapshot of
        // manager._pendingFillCrawls, sanitized and length-capped; an empty
        // array persists as cleared so consumed entries never resurrect.
        // Non-array (legacy callers) passes undefined so storeMasterGrid
        // leaves previously stored entries untouched.
        const pendingFillCrawls = Array.isArray((manager as any)._pendingFillCrawls)
            ? (manager as any)._pendingFillCrawls
                .filter((e: any) => e && typeof e.slotId === 'string' && e.slotId.length > 0
                    && (e.side === 'buy' || e.side === 'sell') && Number.isFinite(Number(e.ts)))
                .slice(-500)
                .map((e: any) => ({ slotId: e.slotId, side: e.side, ts: Number(e.ts) }))
            : undefined;
        await accountOrders.storeMasterGrid(
            orders,
            btsFeesOwed,
            manager.boundaryIdx,
            manager.assets || null,
            {
                persistedAt: nowIso(),
                config: debugConfig,
                accountTotals,
                btsBalance
            },
            fillKeys,
            genesis,
            gapEvacStreaks,
            pendingFillCrawls
        );
        return true;
    } catch (e: any) {
        return false;
    }
}

/**
 * Restore persisted gap-evacuation streaks into the manager (Phase 3
 * restart resilience). Entries are pruned to slots that still exist in the
 * loaded grid and to finite positive counts, so a grid reset (or a renamed
 * slot scheme) can never resurrect stale streaks. The queued-once cancel
 * markers (_gapEvacCancelQueued) deliberately stay in-memory: they are only
 * meaningful alongside the in-memory corrections queue, which is empty
 * after a restart.
 *
 * @param {Object} manager - OrderManager instance
 * @param {Object|null} persisted - {slotId: count} from loadGapEvacStreaks
 * @returns {number} Number of streak entries restored
 */
export function restoreGapEvacStreaks(manager: any, persisted: any): number {
    if (!manager) return 0;
    const streaks = new Map();
    if (persisted && typeof persisted === 'object') {
        for (const [id, count] of Object.entries(persisted)) {
            const n = Math.floor(Number(count));
            if (id && Number.isFinite(n) && n > 0
                && manager.orders instanceof Map && manager.orders.has(id)) {
                streaks.set(id, n);
            }
        }
    }
    manager._gapEvacStreaks = streaks;
    return streaks.size;
}

/**
 * Retry grid persistence if previous attempt failed.
 * Clears persistence warning flag if successful.
 *
 * @param {Object} manager - OrderManager instance
 * @returns {Promise<boolean>} True if persisted successfully or no warning, false on error
 */
export async function retryPersistenceIfNeeded(manager: any): Promise<boolean> {
    if (!manager || !manager._persistenceWarning) return true;
    try {
        const result = typeof manager.persistGrid === 'function' ? await manager.persistGrid() : true;
        const success = result === true || (result && !result.skipped && result.isValid !== false);
        if (success) delete manager._persistenceWarning;
        return success;
    } catch (e: any) {
        systemLogger.warn(`retryPersistenceIfNeeded failed: ${getErrorMessage(e)}`);
        return false;
    }
}

/**
 * Apply grid corrections for divergence between calculated and active orders.
 * Uses COW (Copy-on-Write): builds a working grid, plans updates/cancels/creates,
 * executes blockchain operations, and commits working grid only on success.
 *
 * Surplus on-chain orders are cancelled (not resized to zero).
 * Size updates are emitted only for committed ACTIVE/PARTIAL orders.
 * 
 * @param {Object} manager - OrderManager instance
 * @param {Object} accountOrders - AccountOrders data accessor
 * @param {string} botKey - Bot identifier for persistence
 * @param {Function} updateOrdersOnChainBatchFn - Batch update function for blockchain operations
 * @param {Function} updateGridFromBlockchainSnapshotFn - Grid resize function (injected to avoid circular dependency with grid.ts)
 * @returns {Promise<void>}
 */
export async function applyGridDivergenceCorrections(manager: any, accountOrders: any, _botKey: string, updateOrdersOnChainBatchFn: Function, updateGridFromBlockchainSnapshotFn: Function): Promise<{ committed: boolean, reason?: string } | undefined> {
    if (!manager._gridLock) return;
    if (typeof updateGridFromBlockchainSnapshotFn !== 'function') {
        manager.logger?.log?.('[DIVERGENCE-COW] updateGridFromBlockchainSnapshotFn is not a function — aborting', 'error');
        return undefined;
    }
    const { WorkingGrid } = require('../working_grid');
    const { hasActionForOrder, removeActionsForOrder, optimizeRebalanceActions } = require('./validate');

    // Phase 1: Pre-lock grid resizing using COW
    // This calculates new sizes from blockchain state but DOES NOT modify master.
    // The boundary stays pinned to the committed value: fund changes resize
    // orders through the budget allocation below but never shift rails.  The
    // fund-ratio writer was removed — it moved the boundary without guaranteed
    // same-batch refills, so a guard-vetoed refill stranded empty slots past
    // the new boundary (h-bts 91->94) with no repair path.  Remaining writers:
    // fills (deriveTargetBoundary, same-cycle rotations) and spread promotion
    // (shifts only onto slots placed in the same atomic batch).
    let resizeCowResult: any = null;
    const pendingBoundaryIdx = manager.boundaryIdx;
    if (manager._gridSidesUpdated && manager._gridSidesUpdated.size > 0) {
        const hasBuy = manager._gridSidesUpdated.has(ORDER_TYPES.BUY);
        const hasSell = manager._gridSidesUpdated.has(ORDER_TYPES.SELL);
        let resizeOrderType = hasBuy && hasSell
            ? 'both'
            : hasBuy
                ? ORDER_TYPES.BUY
                : ORDER_TYPES.SELL;

        try {
            resizeCowResult = await updateGridFromBlockchainSnapshotFn(manager, resizeOrderType, true, pendingBoundaryIdx);
        } catch (err: any) {
            manager.logger?.log?.(`[DIVERGENCE-COW] Grid resize failed: ${getErrorMessage(err)}`, 'error');
            manager._gridSidesUpdated.clear();
            return undefined;
        }
    }

    // Phase 2: Create working grid for divergence corrections
    // Use the resize working grid as starting point if available
    let cowResult: any = null;
    await manager._gridLock.acquire(async () => {
        if (!manager._gridSidesUpdated || manager._gridSidesUpdated.size === 0) return;

        // Start from resize result if available, otherwise create fresh working grid
        const workingGrid = resizeCowResult?.workingGrid 
            ? resizeCowResult.workingGrid 
            : new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        
        const actions = resizeCowResult?.actions ? [...resizeCowResult.actions] : [];

        // Geometric rail constraint for desired-slot selection.  The gap band
        // is derived from the working boundary (== committed: divergence never
        // shifts it).  Uses the shared MathUtils.isSlotInRail helper (also used
        // by the strategy window and _pickVirtualSlotsToActivate): the SPREAD
        // GUARD keeps gap-band strays typed BUY/SELL (never SPREAD+ACTIVE), so
        // without a geometric filter they are selected as "closest to market"
        // and left inside the gap — collapsing the spread when a fill-driven
        // boundary shift moves into the rail (h-bts: boundary 107->110 left
        // the sell rail parked at 111-130 with the bottom three, 111-113,
        // inside the new spread gap; real spread 0.5% instead of the 2.0%
        // target).
        const workingBoundaryIdx = (pendingBoundaryIdx !== null && pendingBoundaryIdx !== undefined && Number.isFinite(Number(pendingBoundaryIdx)))
            ? Number(pendingBoundaryIdx)
            : manager.boundaryIdx;
        const gapSlots = (manager as any)._genesis?.gapSlots ?? manager._gapSlots ?? MathUtils.calculateGapSlots(
            manager.config?.incrementPercent,
            manager.config?.targetSpreadPercent,
            manager.config?.gridLimits
        );
        const inRailByType = (orderType: any) => (slot: any) =>
            MathUtils.isSlotInRail(workingBoundaryIdx, gapSlots, orderType, slot);

        for (const orderType of manager._gridSidesUpdated) {
            const sideName = orderType === ORDER_TYPES.BUY ? 'buy' : 'sell';
            const sidePrecision = MathUtils.getPrecisionByOrderType(manager.assets, orderType);
            
            // Get current on-chain orders for this side.
            // Filter by WORKING GRID type (not master type) so that slots whose
            // type changed during the boundary shift (e.g. SPREAD→BUY) are correctly
            // attributed to their new side.  Using master types here while the
            // rest of Phase 2 uses working-grid types (allSideSlots, desiredSlots)
            // creates a mismatch: SPREAD→BUY crossers appear as "holes" and get
            // spurious CREATEs queued, causing the COW batch to be rejected by
            // validateCreateTargetSlots and aborting the entire correction cycle.
            const currentOnChainOrders = (Array.from(manager.orders.values()) as any[])
                .filter((o: any) => OrderUtils.isOrderPlaced(o))
                .filter((o: any) => {
                    const wSlot = workingGrid.get(o.id);
                    return wSlot && wSlot.type === orderType;
                });

            // Get all slots for this side from working grid.
            // Exclude gap-band strays by geometry (inRailByType) so the desired
            // window always matches the working boundary's rails.  Otherwise a
            // stray on-chain SELL inside the new spread band (kept typed SELL by
            // the SPREAD GUARD) would be picked as "closest to market" and never
            // relocated, collapsing the spread after a boundary shift.
            // BUY window follows config buyWindowMode (default 'low', mirrors
            // strategy.ts). 'low' sorts lowest-first so desiredSlots = the
            // BOTTOM slots of the rail; 'closest' restores upstream
            // closest-to-market order. With the previous unconditional
            // descending sort the divergence path placed the top buys at
            // -1..-3% under market and they filled immediately.
            const windowLowDiv = orderType !== ORDER_TYPES.BUY || MathUtils.resolveBuyWindowMode(manager.config) !== 'closest';
            const allSideSlots = (Array.from(workingGrid.values()) as any[])
                .filter((o: any) => o.type === orderType)
                .filter(inRailByType(orderType))
                .filter((o: any) => !MathUtils.isDeepShelfId(o?.id))
                .sort((a: any, b: any) => (orderType === ORDER_TYPES.BUY && !windowLowDiv) ? b.price - a.price : a.price - b.price);

            // Calculate target count
            const baseTargetCount = (manager.config.activeOrders && Number.isFinite(manager.config.activeOrders[sideName]))
                ? Math.max(1, manager.config.activeOrders[sideName])
                : currentOnChainOrders.length;
            const targetCount = baseTargetCount;

            // Determine desired slots (closest to market) + edge-pinned reserves.
            // Buys pin at the floor, sells at the ceiling. Reserves rest live
            // without consuming the window: the middle stays undesired and gets
            // cancelled as surplus.
            const windowSlots = allSideSlots.slice(0, targetCount);
            let desiredSlots = windowSlots;
            const reserveCount = OrderUtils.resolveReserveCount(manager.config, sideName);
            if (reserveCount > 0) {
                const asc = allSideSlots.slice().sort((a: any, b: any) => a.price - b.price);
                const edge = sideName === 'sell' ? 'ceiling' : 'floor';
                // Both edges anchor at the live grid's own edge (single source).
                const edgeAnchor = OrderUtils.resolveLiveReserveEdgeAnchorPrice(manager, sideName);
                const edgeSlots = OrderUtils.selectReserveEdgeSlots(
                    asc,
                    reserveCount,
                    new Set(windowSlots.map((s: any) => s.id)),
                    edge,
                    edgeAnchor
                );
                desiredSlots = [...windowSlots, ...edgeSlots];
            }
            const desiredSlotIds = new Set(desiredSlots.map((s: any) => s.id));
            // Deep shelf (dip insurance above the reserve floor): live shelf
            // orders join the desired set so the surplus sweep below never
            // cancels them; virtuals are appended for the CREATE loop with
            // derived sizes (floor + delay guards apply there as usual).
            if (orderType === ORDER_TYPES.BUY) {
                try {
                    const shelfDiv = OrderUtils.ensureDeepShelfEntries(manager.orders, manager);
                    if (shelfDiv.length > 0) {
                        const railAscDiv = (Array.from(workingGrid.values()) as any[])
                            .filter((o: any) => o && o.type === ORDER_TYPES.BUY && !MathUtils.isDeepShelfId(o.id) && Number.isFinite(Number(o.price)))
                            .sort((a: any, b: any) => Number(a.price) - Number(b.price));
                        let budgetBuyDiv = 0;
                        try {
                            const snapDiv = typeof manager.getChainFundsSnapshot === 'function' ? manager.getChainFundsSnapshot() : null;
                            if (snapDiv) budgetBuyDiv = OrderUtils.getSideBudget('buy', snapDiv, manager.config, OrderUtils.getActiveOrdersTotal(manager.config));
                        } catch { budgetBuyDiv = 0; }
                        const deepSizesDiv = OrderUtils.deriveDeepShelfSizes({
                            budgetBuy: budgetBuyDiv,
                            weightBuy: manager.config?.weightDistribution?.buy,
                            incrementPercent: manager.config?.incrementPercent,
                            assets: manager.assets,
                            railSlotsAsc: railAscDiv,
                            deepShelf: shelfDiv,
                        });
                        const deepFinalDiv = OrderUtils.applyDeepManualSizes(manager.config, shelfDiv, deepSizesDiv);
                        for (const d of shelfDiv) {
                            if (!d || desiredSlotIds.has(d.id)) continue;
                            if (d.orderId) {
                                desiredSlots.push(d);
                                desiredSlotIds.add(d.id);
                                continue;
                            }
                            if (d.state !== ORDER_STATES.VIRTUAL) continue;
                            const szDiv = deepFinalDiv.sizes.get(d.id) || 0;
                            if (!(szDiv > 0)) continue;
                            desiredSlots.push({ ...d, size: szDiv, __deepManual: deepFinalDiv.manualIds.has(d.id) });
                            desiredSlotIds.add(d.id);
                        }
                    }
                } catch { /* shelf stays off when funds are unavailable */ }
            }
            const onChainBySlotId = new Map(currentOnChainOrders.map((o: any) => [o.id, o]));

            // Process on-chain orders:
            // - In desired window: keep/update committed size (if not already queued by Phase 1)
            // - Outside desired window: cancel surplus order
            for (const onChainOrder of currentOnChainOrders) {
                // Get current slot from working grid (may have been updated in Phase 1)
                const slot = workingGrid.get(onChainOrder.id);
                const isDesired = desiredSlotIds.has(onChainOrder.id);

                if (!isDesired || !slot || !(toFiniteNumber(slot.size) > 0)) {
                    removeActionsForOrder(actions, COW_ACTIONS.UPDATE, onChainOrder);
                    const hasQueuedCancel = hasActionForOrder(actions, COW_ACTIONS.CANCEL, onChainOrder);

                    if (!hasQueuedCancel) {
                        manager.logger.log(`[DIVERGENCE-COW] Queueing cancel for surplus ${onChainOrder.id} (chain id ${onChainOrder.orderId})`, 'info');
                        actions.push({
                            type: COW_ACTIONS.CANCEL,
                            id: onChainOrder.id,
                            orderId: onChainOrder.orderId
                        });
                    }

                    const current = slot || onChainOrder;
                    // Rail-aware hole (Phase 2): a cancelled in-rail surplus
                    // stays a rail-typed VIRTUAL hole (size preserved for the
                    // rotation pairing downstream); only true gap-band slots
                    // become side-neutral SPREAD.
                    const holeGeoType = OrderUtils.geometryTypeForSlotIndex(
                        OrderUtils.parseSlotIndex
                            ? OrderUtils.parseSlotIndex(current?.id)
                            : null,
                        workingBoundaryIdx,
                        gapSlots
                    );
                    workingGrid.set(
                        onChainOrder.id,
                        (holeGeoType === ORDER_TYPES.BUY || holeGeoType === ORDER_TYPES.SELL)
                            ? OrderUtils.toRailHolePlaceholder(current, holeGeoType)
                            : OrderUtils.convertToSpreadPlaceholder(current)
                    );
                    continue;
                }

                // Phase 1 already queued committed size updates. Avoid duplicate UPDATEs.
                const hasQueuedUpdate = hasActionForOrder(actions, COW_ACTIONS.UPDATE, onChainOrder);
                const hasQueuedCancel = hasActionForOrder(actions, COW_ACTIONS.CANCEL, onChainOrder);

                if (hasQueuedUpdate || hasQueuedCancel) {
                    continue;
                }

                let newSize = toFiniteNumber(slot.size);
                // Deep shelf: manual sizes win over the curve on updates too.
                // Placements apply them at all sites, but the working grid
                // carries curve sizes — without this override any budget
                // change resizes live manual deeps down to curve (and the
                // grid/chain mismatch would re-queue the update every pass,
                // so the manual size is written back to the working slot).
                if (MathUtils.isDeepShelfId(slot.id)) {
                    const manual = MathUtils.resolveBuyDeepSizes(manager.config);
                    const deepIdx = Number(String(slot.id).split('-')[1]);
                    const manualSize = Number.isFinite(deepIdx) ? Number(manual[deepIdx] || 0) : 0;
                    if (manualSize > 0) {
                        newSize = manualSize;
                        try { (slot as any).size = manualSize; } catch { /* queued size still applies */ }
                    }
                }
                const currentSize = toFiniteNumber(onChainOrder.size);
                const sizeChanged = Number.isFinite(sidePrecision)
                    ? MathUtils.floatToBlockchainInt(newSize, sidePrecision) !== MathUtils.floatToBlockchainInt(currentSize, sidePrecision)
                    : newSize !== currentSize;

                if (sizeChanged) {
                    manager.logger.log(`[DIVERGENCE-COW] Queueing size update for ${onChainOrder.id}: ${currentSize} -> ${newSize}`, 'info');
                    actions.push({
                        type: COW_ACTIONS.UPDATE,
                        id: onChainOrder.id,
                        orderId: onChainOrder.orderId,
                        newGridId: onChainOrder.id,
                        newSize,
                        newPrice: slot.price,
                        order: {
                            id: onChainOrder.id,
                            type: onChainOrder.type,
                            price: slot.price,
                            size: newSize
                        }
                    });
                }
            }

            // Process holes: CREATE new orders for empty desired slots
            // BUY guard: skip creates below the floor (config buyFloorUSDT,
            // default 1.0, 0 = off; mirrors strategy.ts) and while the buy
            // delay (config buyDelayMinutes, default 15, 0 = off; deadline)
            // is armed — divergence corrections must not bypass either.
            const buyFloorUsdtDiv = MathUtils.resolveBuyFloorUsdt(manager.config);
            const buyDelayMsDiv = MathUtils.resolveBuyDelayMs(manager.config);
            for (const slot of desiredSlots) {
                const hasCreate = hasActionForOrder(actions, COW_ACTIONS.CREATE, slot);
                if (!onChainBySlotId.has(slot.id) && slot.size > 0 && !hasCreate) {
                    if (orderType === ORDER_TYPES.BUY) {
                        const lastBuyTime = (manager as any)._lastBuyFillTime || 0;
                        const delayActive = buyDelayMsDiv > 0 && lastBuyTime !== 0
                            && (Date.now() - lastBuyTime) < buyDelayMsDiv;
                        if (delayActive) {
                            manager.logger.log(`[DIVERGENCE-COW] Skipping BUY create for ${slot.id} — buy delay active`, 'info');
                            continue;
                        }
                        // BUY size is in quote (USDT) — the size IS the notional.
                        // Manual deep sizes bypass the floor (explicit intent).
                        if (buyFloorUsdtDiv > 0 && !(slot as any).__deepManual && Number(slot.size) < buyFloorUsdtDiv) {
                            manager.logger.log(`[DIVERGENCE-COW] Skipping BUY create for ${slot.id} — size ${Number(slot.size).toFixed(3)} USDT < ${buyFloorUsdtDiv}`, 'info');
                            continue;
                        }
                    }
                    manager.logger.log(`[DIVERGENCE-COW] Queueing new placement for slot ${slot.id}`, 'info');
                    actions.push({
                        type: COW_ACTIONS.CREATE,
                        id: slot.id,
                        order: {
                            id: slot.id,
                            price: slot.price,
                            size: slot.size,
                            type: slot.type
                        }
                    });
                }
            }
        }

        // Convert same-side surplus-CANCEL + hole-CREATE pairs into in-place
        // rotation UPDATEs (reprice the existing order to the hole slot) instead
        // of cancel+recreate. Mirrors the reconcile path (manager.ts:210) and
        // removes churn when a fill-driven boundary shift re-types slots. The COW
        // executor already handles rotation UPDATEs (newGridId + newPrice remap).
        const optimizedActions = optimizeRebalanceActions(actions, manager.orders, {
            logger: (msg: any, level: any) => manager.logger?.log?.(msg, level),
            boundaryIdx: pendingBoundaryIdx,
            gapSlots: manager._gapSlots,
            assets: manager.assets
        });
        if (optimizedActions !== actions) {
            actions.length = 0;
            actions.push(...optimizedActions);
        }
        // Refill-slot wire (boundary-hold): unpairable hole-CREATEs surviving
        // the fold above justify the pending boundary shift. The executor
        // holds the committed boundary when a listed refill is guard-skipped.
        // Reserve-ladder CREATEs are excluded by collectRefillSlotIds — static
        // edge insurance, never a justification for a boundary shift.
        const refillSlotIds = OrderUtils.collectRefillSlotIds(actions, {
            config: manager.config,
            slots: manager.orders,
            edgeAnchors: {
                buy: OrderUtils.resolveLiveReserveEdgeAnchorPrice(manager, 'buy'),
                sell: OrderUtils.resolveLiveReserveEdgeAnchorPrice(manager, 'sell')
            }
        });

        // Build COW result with all actions
        if (actions.length > 0) {
            cowResult = {
                actions,
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: pendingBoundaryIdx,
                refillSlotIds,
                aborted: false
            };
        } else if (resizeCowResult?.hasWorkingChanges) {
            // No on-chain operations required, but working grid changed (typically virtual sizing).
            // Commit locally to keep master in sync with latest sizing context.
            cowResult = {
                actions: [],
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: pendingBoundaryIdx,
                localOnly: true,
                aborted: false
            };
        }
    });

    // Phase 3: Execute corrections via COW batch
    if (cowResult && !cowResult.aborted) {
        try {
            let result: any = null;

            if (cowResult.localOnly) {
                const committed = await manager._commitWorkingGrid(
                    cowResult.workingGrid,
                    cowResult.workingIndexes,
                    cowResult.workingBoundary
                );

                if (committed) {
                    if (typeof manager.persistGrid === 'function') {
                        await manager.persistGrid();
                    } else {
                        await persistGridSnapshot(manager, accountOrders);
                    }
                    result = { executed: true, localOnly: true };
                    manager.logger.log(`[DIVERGENCE-COW] Applied local-only sizing updates (no blockchain ops)`, 'info');
                } else {
                    result = { executed: false, localOnly: true, commitSkipped: true };
                    manager.logger.log(`[DIVERGENCE-COW] Skipped local-only commit (working grid not committed)`, 'warn');
                }
            } else {
                result = await updateOrdersOnChainBatchFn(cowResult);
            }
            
            if (result && result.executed) {
                manager.logger.log(`[DIVERGENCE-COW] Successfully applied divergence corrections`, 'info');
                manager._gridSidesUpdated.clear();
                // NOTE: We do NOT reset manager.outOfSpread here — it's overwritten
                // every tick by checkSpreadCondition (grid.ts:1691).  Resetting it
                // here would be redundant 99% of the time, and would mask a stale-value
                // window between this commit and the next checkSpreadCondition call
                // for any code path that reads outOfSpread in between.  Currently no
                // such path exists, but if one is added, the reader may see a stale
                // count until the next checkSpreadCondition runs.
                // Grid already persisted via _commitWorkingGrid in updateOrdersOnChainBatch
                return { committed: true };
            } else {
                manager.logger.log(`[DIVERGENCE-COW] Divergence corrections not executed (working grid discarded)`, 'warn');
                manager._gridSidesUpdated.clear();
                return { committed: false, reason: result?.reason };
            }
        } catch (err: any) {
            manager.logger.log(`[DIVERGENCE-COW] Error executing divergence corrections: ${getErrorMessage(err)}`, 'error');
            manager._gridSidesUpdated.clear();
            return { committed: false };
        }
    } else {
        // No actions needed or aborted
        manager._gridSidesUpdated.clear();
        return undefined;
    }
}


// ================================================================================
// SECTION 5: UI & INTERACTIVE UTILITIES
// ================================================================================

/**
 * Ensure profiles directory exists, creating if necessary.
 * 
 * @param {string} profilesDir - Path to profiles directory
 * @returns {boolean} True if directory was created, false if it already existed
 */
export function ensureProfilesDirectory(profilesDir: string): boolean {
    if (!(storage as any).exists(profilesDir)) { ensureDir(profilesDir); return true; }
    return false;
}

/**
 * Returns the current date and time in ISO format.
 * @returns {string} ISO timestamp.
 */
export function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Sleep for a duration.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve: any) => setTimeout(resolve, ms));
}

/**
 * Read user input from stdin with optional masking.
 * Handles raw terminal mode for interactive prompts.
 * Supports password masking and backspace handling.
 * 
 * @param {string} prompt - Prompt text to display
 * @param {Object} [options={}] - Input options
 * @param {boolean} [options.hideEchoBack=false] - Hide input echo (for passwords)
 * @param {string} [options.mask=''] - Character to display instead of input
 * @param {Function} [options.colorize] - Live colorizer applied to the typed input on redraw
 * @returns {Promise<string>} Trimmed user input
 */
export function readInput(prompt: string, options: { hideEchoBack?: boolean; mask?: string; validate?: (input: string) => boolean; colorize?: (input: string) => string } = {}): Promise<string> {
    return new Promise((resolve: any) => {
        const stdin = runtime.stdin!; const stdout = runtime.stdout;
        const ESC_SEQUENCE_TIMEOUT_MS = 150;
        let input = '';
        let cursorPos = 0;
        let escBuf = '';
        let escTimer: any = null;
        stdout.write(prompt);
        const isRaw = (stdin as any).isRaw; if (stdin.isTTY) (stdin as any).setRawMode(true);
        stdin.resume(); (stdin as any).setEncoding('utf8');

        function redraw() {
            const shouldMask = options.hideEchoBack || typeof options.mask === 'string';
            const maskChar = options.mask || '*';
            let display = shouldMask ? maskChar.repeat(input.length) : input;
            if (!shouldMask && input.length > 0 && typeof options.colorize === 'function') {
                display = options.colorize(input);
            }
            stdout.write('\r\x1b[K' + prompt + display);
            if (cursorPos < input.length) {
                stdout.write('\x1b[' + (input.length - cursorPos) + 'D');
            }
        }

        function handleSequence(seq: any) {
            // Arrow keys
            if (seq === 'D') { if (cursorPos > 0) { cursorPos--; redraw(); } return true; }
            if (seq === 'C') { if (cursorPos < input.length) { cursorPos++; redraw(); } return true; }
            // Home / End
            if (seq === 'H' || seq === 'OH') { cursorPos = 0; redraw(); return true; }
            if (seq === 'F' || seq === 'OF') { cursorPos = input.length; redraw(); return true; }
            // Delete
            if (seq === '3~') {
                if (cursorPos < input.length) {
                    input = input.slice(0, cursorPos) + input.slice(cursorPos + 1);
                    redraw();
                }
                return true;
            }
            // Insert
            if (seq === '2~') { return true; }
            return false;
        }

        function processEscBuf() {
            escTimer = null;
            const buf = escBuf;
            escBuf = '';
            // Standalone ESC
            if (buf === '\x1b') { cleanup(); stdout.write('\r\x1b[K\n'); return resolve('\x1b'); }
            // CSI sequence: ESC [ <params> <final>
            if (buf.length >= 3 && buf[1] === '[') {
                const seq = buf.substring(2);
                if (handleSequence(seq)) return;
                // Unhandled sequence — ignore
                return;
            }
            // ESC + something else (e.g. Alt+key) — ignore
        }

        function handleChar(ch: any) {
            if (ch === '\r' || ch === '\n' || ch === '\u0004') { cleanup(); stdout.write('\n'); return resolve(input.trim()); }
            if (ch === '\u0003') { cleanup(); stdout.write('\r\x1b[K\n'); runtime.exit(0); }

            // Backspace
            if (ch === '\u007f' || ch === '\u0008') {
                if (cursorPos > 0) {
                    input = input.slice(0, cursorPos - 1) + input.slice(cursorPos);
                    cursorPos--;
                    redraw();
                }
                return;
            }

            // Printable character — insert at cursor
            if (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126) {
                input = input.slice(0, cursorPos) + ch + input.slice(cursorPos);
                cursorPos++;
                redraw();
            }
        }

        const onData = (chunk: any) => {
            const s = String(chunk);
            for (let i = 0; i < s.length; i++) {
                const ch = s[i];

                // Accumulating an escape sequence
                if (escBuf) {
                    escBuf += ch;
                    // CSI: after ESC [, collect up to final byte (@-~)
                    if (escBuf.length === 2 && escBuf[1] === '[') continue;
                    if (escBuf.length > 2 && ch >= '@' && ch <= '~') {
                        clearTimeout(escTimer);
                        processEscBuf();
                    }
                    continue;
                }

                // Start of potential escape sequence
                if (ch === '\x1b') {
                    escBuf = ch;
                    escTimer = setTimeout(processEscBuf, ESC_SEQUENCE_TIMEOUT_MS);
                    continue;
                }

                handleChar(ch);
            }
        };
        const cleanup = () => { clearTimeout(escTimer); escBuf = ''; (stdin as any).removeListener('data', onData); if (stdin.isTTY) (stdin as any).setRawMode(isRaw); };
        stdin.on('data', onData);
    });
}

/**
 * Read password input from user with masked echo.
 * 
 * @param {string} prompt - Prompt text to display
 * @returns {Promise<string>} User-entered password
 */
export async function readPassword(prompt: string): Promise<string> { return readInput(prompt, { mask: '*', hideEchoBack: false }); }

/**
 * Execute async function with exponential backoff retry logic.
 * Retries on failure with increasing delays up to maxDelayMs.
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} [options={}] - Retry options
 * @param {number} [options.maxAttempts=3] - Maximum retry attempts
 * @param {number} [options.baseDelayMs=1000] - Base delay in milliseconds
 * @param {number} [options.maxDelayMs=10000] - Maximum delay in milliseconds
 * @param {Object} [options.logger=null] - Optional logger for retry messages
 * @param {string} [options.operationName='operation'] - Name for log messages
 * @returns {Promise<*>} Result of function execution
 * @throws {Error} If all attempts fail, throws the final error
 */
export async function withRetry<T>(fn: () => Promise<T>, options: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; logger?: { log?: Function } | null; operationName?: string } = {}): Promise<T> {
    const { maxAttempts = PIPELINE_TIMING.RETRY_MAX_ATTEMPTS, baseDelayMs = PIPELINE_TIMING.RETRY_BASE_DELAY_MS, maxDelayMs = PIPELINE_TIMING.RETRY_MAX_DELAY_MS, logger = null, operationName = 'operation' } = options;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            if (attempt === maxAttempts) throw err;
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
            logger?.log?.(`${operationName} attempt ${attempt} failed. Retrying in ${delay}ms...`, 'warn');
            await sleep(delay);
        }
    }
    throw new Error(`${operationName} failed after ${maxAttempts} attempts`);
}

/**
 * Execute a blockchain operation with timeout, retry, and node failover reporting.
 * Reports each failure to NodeManager so the node gets blacklisted after
 * consecutive failures, triggering automatic failover to a healthy node.
 *
 * After exhausting the retry budget, force-blacklists the current node and
 * reconnects to a different healthy node, then makes one final attempt.
 * This prevents the bot from hanging indefinitely on a stuck node.
 *
 * Defaults: 30s timeout, 3 retries (PIPELINE_TIMING.RETRY_MAX_ATTEMPTS), 2s retry delay.
 * All configurable via options.
 *
 * @param fn - Async function wrapping the blockchain operation
 * @param label - Short human-readable label for error messages
 * @param options.logger - Optional logger for retry warnings
 * @param options.timeoutMs - Override timeout per attempt (default 30000)
 * @param options.maxRetries - Override max retry count (default PIPELINE_TIMING.RETRY_MAX_ATTEMPTS)
 * @param options.retryDelayMs - Override delay between retries (default 2000)
 */
export async function withBlockchainRetry<T>(
    fn: () => Promise<T>,
    label: string,
    options?: {
        logger?: { log?: Function } | null;
        timeoutMs?: number;
        maxRetries?: number;
        retryDelayMs?: number;
    }
): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? 30000;
    const maxRetries = options?.maxRetries ?? PIPELINE_TIMING.RETRY_MAX_ATTEMPTS;
    const retryDelayMs = options?.retryDelayMs ?? 2000;
    const logger = options?.logger;
    let lastError: any;

    /** Run fn() with a timeout via shared withTimeout utility. */
    function raceWithTimeout(attemptLabel: string): Promise<T> {
        const p = fn();
        Promise.resolve(p).catch(() => {});
        return withTimeout(p, timeoutMs, { label: `${label} ${attemptLabel}` });
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await raceWithTimeout(`attempt ${attempt}/${maxRetries}`);
        } catch (err: any) {
            lastError = err;

            // Report node failure so NodeManager can blacklist and trigger failover
            try {
                const { getNodeManager } = require('../../bitshares_client');
                const nodeManager = getNodeManager?.();
                const nodeUrl = nodeManager?.getBestNode?.();
                if (nodeUrl && typeof nodeManager.reportNodeFailure === 'function') {
                    nodeManager.reportNodeFailure(nodeUrl, getErrorMessage(err), 'blockchain-op');
                }
            } catch (_: any) { /* reporting errors are non-fatal */ }

            if (attempt < maxRetries) {
                logger?.log?.(
                    `${label} attempt ${attempt}/${maxRetries} failed: ${getErrorMessage(err)}. Retrying in ${retryDelayMs}ms...`,
                    'warn'
                );
                await sleep(retryDelayMs);
            }
        }
    }

    // All retries exhausted — force-switch to a different node and retry once more
    try {
        const { getNodeManager, reconnectForCycle } = require('../../bitshares_client');
        const nodeManager = getNodeManager?.();
        const failedNode = nodeManager?.getBestNode?.();
        if (failedNode && typeof nodeManager.blacklistNode === 'function') {
            nodeManager.blacklistNode(failedNode);
            logger?.log?.(
                `${label}: blacklisted node ${failedNode.substring(0, 40)}... after ${maxRetries} failed attempts. Switching nodes...`,
                'warn'
            );
        }
        const reconnected = await reconnectForCycle(label + ' failover');
        if (reconnected) {
            logger?.log?.(`${label}: reconnected to different node. Retrying operation...`, 'warn');
            return await raceWithTimeout('failover attempt');
        }
    } catch (_: any) { /* failover recovery errors are non-fatal — throw original error */ }

    throw new Error(`${label} failed after ${maxRetries} attempts: ${getErrorMessage(lastError)}`);
}

// ================================================================================
// SECTION 6: GENERAL UTILITIES
// ================================================================================

/**
 * Resolve the best account reference for blockchain reads.
 * Prefer account ID when available, fall back to account name.
 * Used by recovery and startup paths where implicit account context may be unavailable.
 * @param {Object} manager - OrderManager instance (optional)
 * @param {string} account - Account name (optional)
 * @returns {string|null} Resolved account reference or null
 */
export function resolveAccountRef(manager: any, account: string): string | null {
    if (manager && typeof manager.accountId === 'string' && manager.accountId) {
        return manager.accountId;
    }
    if (manager && typeof manager.account === 'string' && manager.account) {
        return manager.account;
    }
    if (typeof account === 'string' && account) {
        return account;
    }
    return null;
}

/**
 * Recursively freezes an object to ensure immutability.
 * @param {Object} obj 
 * @returns {Object}
 */
export function deepFreeze(obj: any): any {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    Object.getOwnPropertyNames(obj).forEach((prop: any) => {
        if (Object.prototype.hasOwnProperty.call(obj, prop) &&
            obj[prop] !== null &&
            (typeof obj[prop] === 'object' || typeof obj[prop] === 'function') &&
            !Object.isFrozen(obj[prop])) {
            deepFreeze(obj[prop]);
        }
    });
    return obj;
}

/**
 * Creates a shallow clone of a Map.
 * @param {Map} map 
 * @returns {Map}
 */
export function cloneMap<K, V>(map: Map<K, V>): Map<K, V> {
    return new Map(map);
}

/**
 * Parses JSON content that may contain comments (/* or //).
 * Strips block comments then line comments before parsing.
 * @param {string} raw - The raw string content with possible comments.
 * @returns {Object} The parsed JSON object.
 */
export function parseJsonWithComments(raw: string): any {
    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
    return JSON.parse(stripped);
}

export { ensureDir };

/**
 * Apply persisted-but-uncommitted fill crawls onto the restored boundary.
 *
 * Fills record a crawl at intake and the derivation consumes it on commit; a
 * refused broadcast, an aborted plan, or a restart in between leaves the crawl
 * owed and the boundary stale, so reconcile would refill the holes same-side.
 * Every grid-load path that restores a persisted boundary must therefore apply
 * the stored records BEFORE it syncs/reconciles — the startup resume path and
 * the recovery reload both go through here, so the two can never drift.
 *
 * Records are relative deltas applied by consumePendingFillCrawls onto a
 * FINITE restored boundary (a null boundary re-anchors absolutely from live
 * fills instead, which subsumes every owed delta). The candidate is validated
 * placed-order-aware; on failure the records are dropped rather than stranding
 * live orders. Best-effort: the caller proceeds with the restored boundary
 * either way.
 *
 * @param {Object} bot - DEXBot (accountOrders + manager required)
 * @param {Object} [options]
 * @param {(message: string, level?: any) => void} [options.log] - Log sink;
 *   defaults to the manager logger (startup passes bot._log)
 * @param {boolean} [options.forceReload=false] - Re-read the store from disk
 *   before applying (recovery reloads already re-read the grid; startup has a
 *   freshly-constructed store)
 * @returns {Promise<{applied: boolean, from?: number, to?: number, count?: number, reason?: string}>}
 */
export async function applyPersistedPendingCrawls(
    bot: any,
    options: { log?: (message: string, level?: any) => void; forceReload?: boolean } = {}
): Promise<{ applied: boolean; from?: number; to?: number; count?: number; reason?: string }> {
    const log = typeof options.log === 'function'
        ? options.log
        : (message: string, level?: any) => {
            try { bot?.manager?.logger?.log?.(message, level); } catch { /* best-effort */ }
        };
    try {
        const load = bot?.accountOrders?.loadPendingFillCrawls;
        const persisted = typeof load === 'function'
            ? (load.call(bot.accountOrders, options.forceReload === true) ?? [])
            : [];
        if (Array.isArray(persisted) && persisted.length > 0 && Array.isArray(bot?.manager?._pendingFillCrawls)) {
            bot.manager._pendingFillCrawls = persisted;
        }
        const result = OrderUtils.consumePendingFillCrawls(bot?.manager);
        if (result?.applied) {
            log(
                `[BOUNDARY] Applied ${result.count} pending fill crawl(s): boundary ${result.from} -> ${result.to}; ` +
                `persisting before reconcile`,
                'warn'
            );
            try { await bot.manager?.persistGrid?.(); } catch { /* best-effort */ }
        } else if (result?.reason && result.reason !== 'nothing-owed'
            && result.reason !== 'no-op' && result.reason !== 'null-boundary') {
            log(`[BOUNDARY] Pending fill crawls dropped (${result.reason})`, 'warn');
        }
        return result ?? { applied: false };
    } catch (err) {
        log(`[BOUNDARY] Pending-crawl application failed (${err}); continuing with restored boundary`, 'warn');
        return { applied: false, reason: 'error' };
    }
}
