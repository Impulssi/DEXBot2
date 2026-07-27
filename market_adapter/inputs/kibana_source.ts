/**
 * KIBANA ELASTICSEARCH SOURCE
 *
 * Fetches liquidity pool price data from the public BitShares Kibana instance.
 *
 * Data source:
 *   Kibana: https://kibana.bitshares.dev
 *   Index:  bitshares-*  (time field: block_data.block_time)
 *
 * LP swap operations (op_type 63 = liquidity_pool_exchange):
 *   Field: operation_history.op_object.pool.keyword          → pool ID  (e.g. '1.19.133')
 *   Field: operation_history.op_object.amount_to_sell        → what went INTO the pool
 *   Field: operation_history.operation_result_object         → actual amounts received (not min)
 *          .data_object.received.amount / .asset_id
 *
 * Price per document = actual_received / sold — both precision-adjusted.
 * We query both swap directions (A→B and B→A), convert both into a unified
 * "B per A" trade stream, then build true OHLC candles from document order.
 *
 * Output: [[timestamp_ms, open, high, low, close, volume_A], ...]
 * Compatible with calculateAMA() close-price input.
 *
 * Auth:
 *   Kibana saved_objects API is open. The search proxy may need an API key.
 *   If you get 401/403: Kibana → Stack Management → API Keys → Create.
 *   Pass via config.apiKey (base64-encoded "id:key").
 */


import { fetchKibanaCandles, fetchKibanaClosePrices } from '../core/kibana_candles';
import { normalizePoolId } from '../utils/chain';
import { kibanaSearch, DEFAULT_CONFIG as BASE_CONFIG } from '../core/kibana_client.js';
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_TYPE_LP = 63;  // liquidity_pool_exchange

// ─── Default Config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
    ...BASE_CONFIG,
    intervalSeconds: 3600,   // bucket size (3600=1h, 14400=4h, 86400=1d)
    lookbackHours:   500,    // how far back (~20 days at 1h)
    consolidateByTimestamp: true,
};

/**
 * Build a discovery query: find the asset IDs that have been sold into a pool.
 * Returns a terms aggregation on amount_to_sell.asset_id — should yield exactly 2 buckets.
 */
function buildDiscoveryQuery(poolId: any, lookbackHours: any) {
    return {
        size: 0,
        query: {
            bool: {
                filter: [
                    { term:  { operation_type: OP_TYPE_LP } },
                    { term:  { 'operation_history.op_object.pool.keyword': poolId } },
                    { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
                ],
            },
        },
        aggs: {
            sold_assets: {
                terms: {
                    field: 'operation_history.op_object.amount_to_sell.asset_id.keyword',
                    size:  5,
                },
            },
        },
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Auto-discover the two asset IDs for a pool by looking at what has been sold
 * into it. Returns an array of asset ID strings, e.g. ['1.3.0', '1.3.3926'].
 *
 * @param {string|number} poolId      - '1.19.133' or just 133
 * @param {Object}        [config]
 * @returns {Promise<string[]>}       - the 2 asset IDs found in this pool
 */
async function discoverPoolAssets(poolId: any, config: any = {}) {
    const cfg      = { ...DEFAULT_CONFIG, ...config };
    const fullId   = normalizePoolId(poolId);
    const query    = buildDiscoveryQuery(fullId, cfg.lookbackHours);
    const result   = await kibanaSearch(cfg, query) as any;
    const buckets  = result.aggregations?.sold_assets?.buckets ?? [];
    return buckets.map((b: any) => b.key);
}

const LP_FIELD_MAP = {
    soldAssetField: 'operation_history.op_object.amount_to_sell.asset_id.keyword',
    receivedAssetField: 'operation_history.op_object.min_to_receive.asset_id.keyword',
    soldAmountField: 'operation_history.op_object.amount_to_sell.amount',
    receivedAmountField: 'operation_history.operation_result_object.data_object.received.amount',
    poolField: 'operation_history.op_object.pool.keyword',
};

/**
 * Fetch bidirectional LP price candles for a specific pool.
 *
 * A→B swaps: price = B_received / A_sold           (B per A)
 * B→A swaps: inverted B_sold / A_received          (also B per A)
 * Both merged and sorted by timestamp.
 *
 * @param {string|number} poolId  - '1.19.133' or 133
 * @param {Object}        assetA  - { id: '1.3.0', precision: 5, symbol: 'BTS' }
 * @param {Object}        assetB  - { id: '1.3.3926', precision: 8, symbol: 'XBTSX.XRP' }
 * @param {Object}        [config]
 * @returns {Promise<Array>}      OHLCV candles
 */
async function getLpCandlesForPool(poolId: any, assetA: any, assetB: any, config: any = {}) {
    const fullId = normalizePoolId(poolId);
    return fetchKibanaCandles({
        opType: OP_TYPE_LP,
        fieldMap: LP_FIELD_MAP,
        assetA,
        assetB,
        config,
        poolId: fullId as any,
    });
}

/**
 * Close prices only — convenience wrapper for AMA input.
 *
 * @param {string|number} poolId
 * @param {Object}        assetA
 * @param {Object}        assetB
 * @param {Object}        [config]
 * @returns {Promise<number[]>}
 */
async function getLpClosePricesForPool(poolId: any, assetA: any, assetB: any, config: any = {}) {
    const fullId = normalizePoolId(poolId);
    return fetchKibanaClosePrices({
        opType: OP_TYPE_LP,
        fieldMap: LP_FIELD_MAP,
        assetA,
        assetB,
        config,
        poolId: fullId,
    });
}

export { discoverPoolAssets, getLpCandlesForPool, getLpClosePricesForPool, kibanaSearch }

