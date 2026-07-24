/**
 * modules/order/utils/system.ts - System and I/O Utilities
 * 
 * Price derivation, persistence, grid correction, and UI/interactive utilities.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (23 exported functions)
 * ===============================================================================
 *
 * SECTION 1: PRICE DERIVATION (8 functions)
 *   - lookupAsset(BitShares, symbol) - Lookup asset metadata from blockchain
 *   - deriveMarketPrice(BitShares, symA, symB) - Derive price from order book
 *   - derivePoolPrice(BitShares, symA, symB) - Derive price from liquidity pool
 *   - derivePrice(BitShares, symA, symB, mode) - Derive price with fallback chain
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
 * SECTION 4: GRID UTILITIES (1 function)
 *   - syncBoundaryToFunds(manager) - Sync boundary position to available funds
 *
 * SECTION 5: UI & INTERACTIVE UTILITIES (5 functions)
 *   - ensureProfilesDirectory(profilesDir) - Ensure profiles directory exists
 *   - sleep(ms) - Pause execution for specified duration
 *   - readInput(prompt, options) - Read user input from stdin
 *   - readPassword(prompt) - Read password with masked echo
 *   - withRetry(fn, options) - Execute async function with exponential backoff
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

const { path } = require('../../path_api');
const { getStorage } = require('../../storage');
const storage = getStorage();
const { API_LIMITS, TIMING, ORDER_TYPES, ORDER_STATES, COW_ACTIONS, FEE_PARAMETERS, BTS_PRECISION, PIPELINE_TIMING } = require('../../constants');
const { PATHS } = require('../../paths');
const Format = require('../format');
const { toFiniteNumber, isValidNumber } = Format;
const MathUtils = require('./math');
const OrderUtils = require('./order');
const Logger = require('../../logger');
const { runtime } = require('../../runtime');
const { ensureDir, readJSON } = require('../../utils/fs_utils');
const systemLogger = new Logger('System');

function _debugLogAndNull(method, symA, symB) {
    return (err) => {
        // debug level: underlying derivePoolPrice/deriveMarketPrice already log at warn
        systemLogger.debug(`derivePrice(${method}) for ${symA}/${symB}: ${err.message}`);
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
const lookupAsset = async (BitShares: any, s: string): Promise<any> => {
    if (!BitShares) return null;
    let cached = null;
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
            systemLogger.debug(`lookupAsset: method failed for ${s}: ${e.message}`);
        }
    }

    throw new Error(`CRITICAL: Cannot fetch asset precision for '${s}'`);
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
const deriveMarketPrice = async (BitShares: any, symA: string, symB: string): Promise<number | null> => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        const baseId = aMeta.id;
        const quoteId = bMeta.id;
        let mid = null;

        if (typeof BitShares.db?.get_order_book === 'function') {
            try {
                const ob = await BitShares.db.get_order_book(baseId, quoteId, API_LIMITS.ORDERBOOK_DEPTH);
                const bestBid = isValidNumber(ob.bids?.[0]?.price) ? toFiniteNumber(ob.bids[0].price) : null;
                const bestAsk = isValidNumber(ob.asks?.[0]?.price) ? toFiniteNumber(ob.asks[0].price) : null;
                if (bestBid !== null && bestAsk !== null) mid = (bestBid + bestAsk) / 2;
            } catch (e: any) {
                systemLogger.debug(`deriveMarketPrice: get_order_book failed for ${symA}/${symB}: ${e.message}`);
            }
        }

        if (mid === null && typeof BitShares.db?.get_ticker === 'function') {
            try {
                const t = await BitShares.db.get_ticker(baseId, quoteId);
                mid = isValidNumber(t?.latest) ? toFiniteNumber(t.latest) : (isValidNumber(t?.latest_price) ? toFiniteNumber(t.latest_price) : null);
            } catch (err: any) {
                systemLogger.debug(`deriveMarketPrice: get_ticker failed for ${symA}/${symB}: ${err.message}`);
            }
        }

        // Return B/A orientation to match market price format
        const finalPrice = (mid !== null && mid !== 0) ? 1 / mid : null;
        if (finalPrice) {
            systemLogger.info(`deriveMarketPrice: ${symA}/${symB} rawMid=${mid?.toFixed(8)} -> finalPrice(B/A)=${finalPrice.toFixed(8)}`);
        }
        return finalPrice;
    } catch (err: any) {
        systemLogger.warn(`deriveMarketPrice failed for ${symA}/${symB}: ${err.message}`);
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
const derivePoolPrice = async (BitShares: any, symA: string, symB: string): Promise<number | null> => {
    try {
        const [aMeta, bMeta] = await Promise.all([
            lookupAsset(BitShares, symA),
            lookupAsset(BitShares, symB)
        ]);
        if (!aMeta?.id || !bMeta?.id) return null;

        let chosen = null;
        const cacheKey = [aMeta.id, bMeta.id].sort().join(':');
        const cachedPoolId = poolIdCache.get(cacheKey);

        if (typeof BitShares.db?.get_liquidity_pools_by_both_assets === 'function') {
            try {
                const pools = await BitShares.db.get_liquidity_pools_by_both_assets(aMeta.id, bMeta.id);
                if (Array.isArray(pools) && pools.length > 0) {
                    const valid = pools.filter(p => p?.id);
                    if (valid.length) {
                        chosen = valid.sort((a, b) => {
                            const getBal = p => toFiniteNumber(String(p.asset_a) === String(aMeta.id) ? p.balance_a : p.balance_b);
                            return getBal(b) - getBal(a);
                        })[0];
                        if (chosen) poolIdCache.set(cacheKey, chosen.id);
                    }
                }
            } catch (e: any) {
                systemLogger.debug(`derivePoolPrice: get_liquidity_pools_by_both_assets failed: ${e.message}`);
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
                    const PAGE_SIZE = 100;
                    const allMatches = [];

                    while (true) {
                        const pools = await listFn(PAGE_SIZE, startId);
                        if (!pools || pools.length === 0) break;

                        // BitShares list_liquidity_pools is inclusive of startId.
                        // Skip the first pool in subsequent pages to avoid duplicate processing.
                        const effectivePools = (startId === '1.19.0') ? pools : pools.slice(1);
                        if (effectivePools.length === 0) break;

                        const matches = effectivePools.filter(p => {
                            const ids = (p.asset_ids || [p.asset_a, p.asset_b]).map(String);
                            return ids.includes(String(aMeta.id)) && ids.includes(String(bMeta.id));
                        });

                        if (matches.length) {
                            allMatches.push(...matches);
                        }

                        if (pools.length < PAGE_SIZE) {
                            break;
                        } else {
                            startId = pools[pools.length - 1].id;
                        }
                    }

                    if (allMatches.length) {
                        // Select pool with highest balance for our assetA
                        chosen = allMatches.sort((a, b) => {
                            const getBal = p => toFiniteNumber(String(p.asset_a) === String(aMeta.id) ? p.balance_a : p.balance_b);
                            return getBal(b) - getBal(a);
                        })[0];
                        poolIdCache.set(cacheKey, chosen.id);
                    }
                } catch (e: any) {
                    systemLogger.warn(`derivePoolPrice: pool pagination failed: ${e.message || e}`);
                }
            }
        }

        if (!chosen) return null;

        if (!chosen.reserves && !isValidNumber(chosen.balance_a) && typeof BitShares.db?.get_objects === 'function') {
            try {
                const [full] = await BitShares.db.get_objects([chosen.id]);
                if (full) chosen = full;
            } catch (e: any) {
                systemLogger.debug(`derivePoolPrice: get_objects failed for pool ${chosen.id}: ${e.message}`);
            }
        }

        let amtA = null, amtB = null;
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
            const resA = chosen.reserves.find(r => String(r.asset_id) === String(aMeta.id));
            const resB = chosen.reserves.find(r => String(r.asset_id) === String(bMeta.id));
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
        systemLogger.warn(`derivePoolPrice failed for ${symA}/${symB}: ${err.message}`);
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
const derivePrice = async (BitShares: any, symA: string, symB: string, mode: string = 'auto'): Promise<number | null> => {
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
    let poolP = null;
    poolP = await derivePoolPrice(BitShares, symA, symB).catch(_debugLogAndNull('auto/pool', symA, symB));
    if (poolP > 0) return poolP;

    const m = await deriveMarketPrice(BitShares, symA, symB).catch(_debugLogAndNull('auto/book', symA, symB));
    if (m > 0) return m;

    systemLogger.debug(`derivePrice: all methods failed for ${symA}/${symB}`);
    return null;
};

/**
 * Resolve a liquidity pool from a share asset reference.
 * Looks up the share asset, then queries the blockchain for associated pools.
 *
 * @param {Object} BitShares - BitShares client instance
 * @param {string} shareAssetRef - Share asset symbol or reference
 * @returns {Promise<Object|null>} Object with {shareAsset, pool} or null if not found
 */
async function resolveLiquidityPoolByShareAsset(BitShares: any, shareAssetRef: string): Promise<any> {
    if (!BitShares?.db || typeof BitShares.db.get_liquidity_pools_by_share_asset !== 'function') {
        return null;
    }

    const shareAsset = await lookupAsset(BitShares, shareAssetRef).catch((e) => {
        systemLogger.debug(`resolveLiquidityPoolByShareAsset: lookupAsset failed for ${shareAssetRef}: ${e.message}`);
        return null;
    });
    if (!shareAsset?.id) {
        return null;
    }

    const response = await BitShares.db.get_liquidity_pools_by_share_asset([shareAsset.id], false, false).catch((e) => {
        systemLogger.debug(`resolveLiquidityPoolByShareAsset: get_liquidity_pools_by_share_asset failed for ${shareAssetRef}: ${e.message}`);
        return null;
    });
    if (!Array.isArray(response)) {
        return null;
    }

    const pool = response.find((entry) => entry && (entry.id || entry.pool?.id)) || null;
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
        : await lookupAsset(BitShares, assetRef).catch((e) => {
            systemLogger.debug(`getAssetCurrentSupply: lookupAsset failed for ${assetRef}: ${e.message}`);
            return null;
        });
    if (!asset) {
        return null;
    }

    const directSupply = toFiniteNumber(asset.current_supply?.amount ?? asset.current_supply, null);
    if (Number.isFinite(directSupply) && directSupply >= 0) {
        return directSupply;
    }

    const dynamicId = asset.dynamic_asset_data_id || asset.dynamicDataId || asset.dynamic_data_id || null;
    if (!dynamicId || typeof BitShares?.db?.get_objects !== 'function') {
        return null;
    }

    const objects = await BitShares.db.get_objects([dynamicId]).catch((e) => {
        systemLogger.debug(`getAssetCurrentSupply: get_objects failed for ${dynamicId}: ${e.message}`);
        return null;
    });
    const dynamicData = Array.isArray(objects) ? objects[0] : null;
    const supply = toFiniteNumber(
        dynamicData?.current_supply?.amount
        ?? dynamicData?.current_supply?.value
        ?? dynamicData?.current_supply,
        null
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
 * @returns {Promise<number|null>} Value per share in denomination asset, or null
 */
async function deriveLiquidityPoolTokenValue(BitShares: any, shareAssetRef: string, denominationAssetRef: string, mode: string = 'auto'): Promise<number | null> {
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

        const priceA = String(assetA.id) === String(denominationAsset.id)
            ? 1
            : await derivePrice(BitShares, assetA.id, denominationAsset.id, mode).catch((e) => {
                systemLogger.debug(`deriveLiquidityPoolTokenValue: derivePrice failed for ${assetA.id}/${denominationAsset.id}: ${e.message}`);
                return null;
            });
        const priceB = String(assetB.id) === String(denominationAsset.id)
            ? 1
            : await derivePrice(BitShares, assetB.id, denominationAsset.id, mode).catch((e) => {
                systemLogger.debug(`deriveLiquidityPoolTokenValue: derivePrice failed for ${assetB.id}/${denominationAsset.id}: ${e.message}`);
                return null;
            });

        if (!isValidNumber(priceA) || !isValidNumber(priceB) || priceA <= 0 || priceB <= 0) {
            return null;
        }

        const supplyFloat = MathUtils.blockchainToFloat(supply, shareAsset.precision);
        if (!isValidNumber(supplyFloat) || supplyFloat <= 0) {
            return null;
        }

        const totalValue = reserveA * priceA + reserveB * priceB;
        const valuePerShare = totalValue / supplyFloat;
        return isValidNumber(valuePerShare) && valuePerShare > 0 ? valuePerShare : null;
    } catch (err: any) {
        systemLogger.debug(`deriveLiquidityPoolTokenValue failed for ${shareAssetRef}/${denominationAssetRef}: ${err.message}`);
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
 * @param {string} botKey - Bot key (e.g. "iob-xrp-bts-0")
 * @returns {Object|null} Snapshot with center and optional dynamicWeights fields, or null if invalid
 */
function loadAmaCenterSnapshot(botKey: string): any {
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
 * @param {string} botKey - Bot key (e.g. "iob-xrp-bts-0")
 * @returns {number|null} Grid center price in B/A format, or null if file absent/invalid
 */
function loadAmaCenterPrice(botKey: string): number | null {
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
        if (storage.exists(filePath)) {
            const diskCache = storage.readJSON(filePath);
            if (diskCache && typeof diskCache === 'object') {
                systemLogger.debug(`_loadFeeCacheFromDisk: loaded fee cache (${Object.keys(diskCache).length} assets)`);
                return diskCache;
            }
        }
    } catch (e: any) {
        systemLogger.debug(`_loadFeeCacheFromDisk: ${e.message}`);
    }
    return {};
}

/**
 * Persist fee cache to disk for recovery across restarts.
 * @param {Record<string, any>} cache - Fee cache to persist
 */
function _saveFeeCacheToDisk(cache: Record<string, any>): void {
    try {
        storage.writeJSON(PATHS.PROFILES.FEE_CACHE_JSON, cache);
    } catch (e: any) {
        systemLogger.debug(`_saveFeeCacheToDisk: ${e.message}`);
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
async function initializeFeeCache(botsConfig: any[], BitShares: any): Promise<Record<string, any>> {
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
                    const findFee = (opCode) => {
                        const param = currentFees.find(p => p[0] === opCode);
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
                        FEE_PARAMETERS.MAKER_REFUND_PERCENT * 10000
                    );
                    cache.BTS = {
                        limitOrderCreate: findFee(1),
                        limitOrderCancel: findFee(2),
                        limitOrderUpdate: findFee(77),
                        makerFeeDiscountPercent: Math.max(0, makerFeeDiscountRaw) / 10000
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
                        `initializeFeeCache: attempt ${attempt}/${maxAttempts} failed for ${assetSymbol}: ${error.message}. Retrying in ${delay}ms...`
                    );
                    await sleep(delay);
                }
            }
        }

        if (lastError) {
            const hasDiskFallback = cache[assetSymbol] !== undefined;
            systemLogger.warn(
                `initializeFeeCache: all ${maxAttempts} attempts failed for ${assetSymbol}: ${lastError.message}` +
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
async function persistGridSnapshot(manager: any, accountOrders: any, snapshotOrders?: any[], recentFillKeys?: Record<string, number>): Promise<boolean> {
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
        await accountOrders.storeMasterGrid(
            orders,
            manager.funds.btsFeesOwed,
            manager.boundaryIdx,
            manager.assets || null,
            {
                persistedAt: new Date().toISOString(),
                config: debugConfig,
                accountTotals: manager.accountTotals || null,
                btsBalance: btsBalance
            },
            fillKeys
        );
        return true;
    } catch (e: any) {
        return false;
    }
}

/**
 * Retry grid persistence if previous attempt failed.
 * Clears persistence warning flag if successful.
 * 
 * @param {Object} manager - OrderManager instance
 * @returns {Promise<boolean>} True if persisted successfully or no warning, false on error
 */
async function retryPersistenceIfNeeded(manager: any): Promise<boolean> {
    if (!manager || !manager._persistenceWarning) return true;
    try {
        const result = typeof manager.persistGrid === 'function' ? await manager.persistGrid() : true;
        const success = result === true || (result && !result.skipped && result.isValid !== false);
        if (success) delete manager._persistenceWarning;
        return success;
    } catch (e: any) {
        systemLogger.warn(`retryPersistenceIfNeeded failed: ${e.message}`);
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
 * @returns {Promise<void>}
 */
async function applyGridDivergenceCorrections(manager: any, accountOrders: any, botKey: string, updateOrdersOnChainBatchFn: Function): Promise<void> {
    if (!manager._gridLock) return;
    const { calculateGapSlots, updateGridFromBlockchainSnapshot } = require('../grid');
    const { WorkingGrid } = require('../working_grid');
    const { hasActionForOrder, removeActionsForOrder } = require('./validate');

    // Phase 1: Pre-lock grid resizing using COW
    // This calculates new sizes from blockchain state but DOES NOT modify master.
    // pendingBoundaryIdx carries any fund-driven boundary shift through the COW
    // pipeline so that manager.boundaryIdx is only updated atomically inside
    // _commitWorkingGrid — never before the slot types are consistent.
    let resizeCowResult = null;
    let pendingBoundaryIdx = manager.boundaryIdx;
    if (manager._gridSidesUpdated && manager._gridSidesUpdated.size > 0) {
        const hasBuy = manager._gridSidesUpdated.has(ORDER_TYPES.BUY);
        const hasSell = manager._gridSidesUpdated.has(ORDER_TYPES.SELL);
        let resizeOrderType = hasBuy && hasSell
            ? 'both'
            : hasBuy
                ? ORDER_TYPES.BUY
                : ORDER_TYPES.SELL;

        // If out-of-spread correction moves boundary, recompute both sides.
        // Store the new index in pendingBoundaryIdx — do NOT touch manager.boundaryIdx
        // here; updateGridFromBlockchainSnapshot will re-assign slot types in the
        // WorkingGrid and _commitWorkingGrid will update manager.boundaryIdx atomically.
        const boundarySync = syncBoundaryToFunds(manager);
        if (manager.outOfSpread > 0 && boundarySync.changed) {
            pendingBoundaryIdx = boundarySync.newIdx;
            resizeOrderType = 'both';
            manager._gridSidesUpdated.add(ORDER_TYPES.BUY);
            manager._gridSidesUpdated.add(ORDER_TYPES.SELL);
        }

        try {
            resizeCowResult = await updateGridFromBlockchainSnapshot(manager, resizeOrderType, true, pendingBoundaryIdx);
        } catch (err: any) {
            manager.logger?.log?.(`[DIVERGENCE-COW] Grid resize failed: ${err.message}`, 'error');
            manager._gridSidesUpdated.clear();
            return;
        }
    }

    // Phase 2: Create working grid for divergence corrections
    // Use the resize working grid as starting point if available
    let cowResult = null;
    await manager._gridLock.acquire(async () => {
        if (!manager._gridSidesUpdated || manager._gridSidesUpdated.size === 0) return;

        // Start from resize result if available, otherwise create fresh working grid
        const workingGrid = resizeCowResult?.workingGrid 
            ? resizeCowResult.workingGrid 
            : new WorkingGrid(manager.orders, { baseVersion: manager._gridVersion });
        
        const actions = resizeCowResult?.actions ? [...resizeCowResult.actions] : [];

        for (const orderType of manager._gridSidesUpdated) {
            const sideName = orderType === ORDER_TYPES.BUY ? 'buy' : 'sell';
            const sidePrecision = MathUtils.getPrecisionByOrderType(manager.assets, orderType);
            
            // Get current on-chain orders for this side (from master, not working)
            const currentOnChainOrders = (Array.from(manager.orders.values()) as any[])
                .filter(o => o.type === orderType && OrderUtils.isOrderPlaced(o));

            // Get all slots for this side from working grid
            const allSideSlots = (Array.from(workingGrid.values()) as any[])
                .filter(o => o.type === orderType)
                .sort((a, b) => sideName === 'buy' ? b.price - a.price : a.price - b.price);

            // Calculate target count
            const baseTargetCount = (manager.config.activeOrders && Number.isFinite(manager.config.activeOrders[sideName]))
                ? Math.max(1, manager.config.activeOrders[sideName])
                : currentOnChainOrders.length;
            const targetCount = baseTargetCount;
            
            // Determine desired slots (closest to market)
            const desiredSlots = allSideSlots.slice(0, targetCount);
            const desiredSlotIds = new Set(desiredSlots.map(s => s.id));
            const onChainBySlotId = new Map(currentOnChainOrders.map(o => [o.id, o]));

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
                    workingGrid.set(onChainOrder.id, OrderUtils.convertToSpreadPlaceholder(current));
                    continue;
                }

                // Phase 1 already queued committed size updates. Avoid duplicate UPDATEs.
                const hasQueuedUpdate = hasActionForOrder(actions, COW_ACTIONS.UPDATE, onChainOrder);
                const hasQueuedCancel = hasActionForOrder(actions, COW_ACTIONS.CANCEL, onChainOrder);

                if (hasQueuedUpdate || hasQueuedCancel) {
                    continue;
                }

                const newSize = toFiniteNumber(slot.size);
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
            for (const slot of desiredSlots) {
                const hasCreate = hasActionForOrder(actions, COW_ACTIONS.CREATE, slot);
                if (!onChainBySlotId.has(slot.id) && slot.size > 0 && !hasCreate) {
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

        // Build COW result with all actions
        if (actions.length > 0) {
            cowResult = {
                actions,
                workingGrid,
                workingIndexes: workingGrid.getIndexes(),
                workingBoundary: pendingBoundaryIdx,
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
            let result = null;

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
                manager.outOfSpread = 0;
                manager._gridSidesUpdated.clear();
                // Grid already persisted via _commitWorkingGrid in updateOrdersOnChainBatch
            } else {
                manager.logger.log(`[DIVERGENCE-COW] Divergence corrections not executed (working grid discarded)`, 'warn');
                manager._gridSidesUpdated.clear();
            }
        } catch (err: any) {
            manager.logger.log(`[DIVERGENCE-COW] Error executing divergence corrections: ${err.message}`, 'error');
            manager._gridSidesUpdated.clear();
        }
    } else {
        // No actions needed or aborted
        manager._gridSidesUpdated.clear();
    }
}

// ================================================================================
// SECTION 4: GRID UTILITIES
// ================================================================================

/**
 * Synchronize grid boundary position based on available funds.
 *
 * Computes a fund-driven boundary index and clamps it to the gap between the
 * highest on-chain BUY slot and the lowest on-chain SELL slot.  The boundary
 * may therefore only shift within the existing spread — it can never jump over
 * a committed order on either side.
 *
 * A shift is only produced when the fund ratio is asymmetric enough that the
 * clamped result differs from the current boundaryIdx.  Balanced available
 * funds yield a mid-range result that, after clamping, equals the current
 * boundary and produces no change.
 *
 * No master-grid mutation is performed here; the caller is responsible for
 * updating manager.boundaryIdx and triggering the subsequent COW resize.
 *
 * @param {Object} manager - OrderManager instance
 * @returns {{ changed: boolean, newIdx?: number }}
 */
function syncBoundaryToFunds(manager: any): { changed: boolean; newIdx?: number } {
    const availA = (manager.funds?.available?.sell || 0);
    const availB = (manager.funds?.available?.buy || 0);
    const allSlots = (Array.from(manager.orders.values()) as any[]).sort((a, b) => a.price - b.price);
    const { calculateGapSlots } = require('../grid');
    const gapSlots = calculateGapSlots(manager.config.incrementPercent, manager.config.targetSpreadPercent, manager.config.gridLimits);

    // Determine the index range permitted by master-grid slot assignments.
    // Both virtual and active orders count: the boundary must stay strictly
    // between the highest BUY slot and the lowest SELL slot so it never
    // crosses an existing order regardless of whether it is on-chain.
    let maxBuyIdx  = -1;
    let minSellIdx = allSlots.length;
    for (let i = 0; i < allSlots.length; i++) {
        const slot = allSlots[i];
        if (slot.type === ORDER_TYPES.BUY  && i > maxBuyIdx)  maxBuyIdx  = i;
        if (slot.type === ORDER_TYPES.SELL && i < minSellIdx) minSellIdx = i;
    }

    // Build clamp bounds from whichever sides have typed slots.
    // If a side has no typed slots there is nothing to protect on that side,
    // so the boundary is free to move to the corresponding edge of the grid.
    const lowerBound = maxBuyIdx  >= 0                ? maxBuyIdx  + 1          : 0;
    const upperBound = minSellIdx < allSlots.length   ? minSellIdx - 1          : allSlots.length - 1;

    // Bounds are contradictory — typed slots leave no gap to shift into.
    if (lowerBound > upperBound) {
        return { changed: false };
    }

    let newIdx = OrderUtils.calculateFundDrivenBoundary(allSlots, availA, availB, manager.config.startPrice, gapSlots);

    // Clamp to the permitted range.
    newIdx = Math.max(lowerBound, Math.min(newIdx, upperBound));

    if (newIdx !== manager.boundaryIdx) {
        return { changed: true, newIdx };
    }
    return { changed: false };
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
function ensureProfilesDirectory(profilesDir: string): boolean {
    if (!storage.exists(profilesDir)) { ensureDir(profilesDir); return true; }
    return false;
}

/**
 * Pause execution for a specified duration.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
 * @returns {Promise<string>} Trimmed user input
 */
function readInput(prompt: string, options: { hideEchoBack?: boolean; mask?: string } = {}): Promise<string> {
    return new Promise((resolve) => {
        const stdin = runtime.stdin!; const stdout = runtime.stdout;
        const ESC_SEQUENCE_TIMEOUT_MS = 150;
        let input = '';
        let cursorPos = 0;
        let escBuf = '';
        let escTimer = null;
        stdout.write(prompt);
        const isRaw = stdin.isRaw; if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume(); stdin.setEncoding('utf8');

        function redraw() {
            const shouldMask = options.hideEchoBack || typeof options.mask === 'string';
            const maskChar = options.mask || '*';
            const display = shouldMask ? maskChar.repeat(input.length) : input;
            stdout.write('\r\x1b[K' + prompt + display);
            if (cursorPos < input.length) {
                stdout.write('\x1b[' + (input.length - cursorPos) + 'D');
            }
        }

        function handleSequence(seq) {
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

        function handleChar(ch) {
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

        const onData = (chunk) => {
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
        const cleanup = () => { clearTimeout(escTimer); escBuf = ''; stdin.removeListener('data', onData); if (stdin.isTTY) stdin.setRawMode(isRaw); };
        stdin.on('data', onData);
    });
}

/**
 * Read password input from user with masked echo.
 * 
 * @param {string} prompt - Prompt text to display
 * @returns {Promise<string>} User-entered password
 */
async function readPassword(prompt: string): Promise<string> { return readInput(prompt, { mask: '*', hideEchoBack: false }); }

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
async function withRetry<T>(fn: () => Promise<T>, options: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; logger?: { log?: Function } | null; operationName?: string } = {}): Promise<T> {
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
function resolveAccountRef(manager: any, account: string): string | null {
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
function deepFreeze(obj: any): any {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    Object.getOwnPropertyNames(obj).forEach(prop => {
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
function cloneMap<K, V>(map: Map<K, V>): Map<K, V> {
    return new Map(map);
}

/**
 * Parses JSON content that may contain comments (/* or //).
 * Strips block comments then line comments before parsing.
 * @param {string} raw - The raw string content with possible comments.
 * @returns {Object} The parsed JSON object.
 */
function parseJsonWithComments(raw: string): any {
    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
    return JSON.parse(stripped);
}

export = {
    lookupAsset,
    deriveMarketPrice,
    derivePoolPrice,
    derivePrice,
    resolveLiquidityPoolByShareAsset,
    deriveLiquidityPoolTokenValue,
    loadAmaCenterPrice,
    loadAmaCenterSnapshot,
    initializeFeeCache,
    persistGridSnapshot,
    retryPersistenceIfNeeded,
    applyGridDivergenceCorrections,
    syncBoundaryToFunds,
    ensureProfilesDirectory,
    sleep,
    readInput,
    readPassword,
    withRetry,
    resolveAccountRef,
    deepFreeze,
    cloneMap,
    ensureDir,
    parseJsonWithComments
};
