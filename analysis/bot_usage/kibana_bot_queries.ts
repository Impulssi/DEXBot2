/**
 * KIBANA BOT QUERIES
 *
 * Elasticsearch query builders for analyzing DEXBot / DEXBot2 order activity
 * on the BitShares blockchain via the public Kibana instance.
 *
 * Data source:
 *   https://kibana.bitshares.dev / bitshares-* index
 *   Time field: block_data.block_time
 *
 * BitShares operation types used here:
 *   1 = limit_order_create  (field: op_object.seller)
 *   2 = limit_order_cancel  (field: op_object.fee_paying_account)
 *   4 = fill_order          (field: op_object.account_id)
 *
 * Relevant ES field paths:
 *   limit_order_create:
 *     op_object.seller                    — account that placed the order
 *     op_object.amount_to_sell.amount     — integer sell amount
 *     op_object.amount_to_sell.asset_id   — sell asset ID (e.g. '1.3.0' = BTS)
 *     op_object.min_to_receive.amount     — integer min-receive (= limit price numerator)
 *     op_object.min_to_receive.asset_id   — receive asset ID
 *     op_object.expiration                — ISO datetime
 *
 *   fill_order:
 *     op_object.account_id                — whose order was filled
 *     op_object.pays.amount / .asset_id   — what was paid
 *     op_object.receives.amount / .asset_id — what was received
 *     op_object.order_id                  — the limit order that filled
 *
 *   limit_order_cancel:
 *     op_object.fee_paying_account        — account that cancelled
 *     op_object.order                     — the order ID cancelled
 */


import { toIntervalLabel } from '../../market_adapter/interval_utils.js';
import { kibanaSearch, DEFAULT_CONFIG as BASE_CONFIG } from '../../market_adapter/core/kibana_client.js';
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_LIMIT_ORDER_CREATE = 1;
const OP_LIMIT_ORDER_CANCEL = 2;
const OP_FILL_ORDER         = 4;

const DEFAULT_CONFIG = {
    ...BASE_CONFIG,
    timeout: 25000,
};

// ─── Aggregation query builders (size:0, for counts & timelines) ───────────────

/**
 * Time-bucketed count of limit_order_create ops for an account.
 * Optionally filtered to orders selling a specific asset.
 */
function buildOrderCreateQuery(accountId, lookbackHours, intervalSeconds = 3600, sellAssetId = null) {
    const filters = [
        { term:  { operation_type: OP_LIMIT_ORDER_CREATE } },
        { term:  { 'operation_history.op_object.seller.keyword': accountId } },
        { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
    ];
    if (sellAssetId) {
        filters.push({ term: { 'operation_history.op_object.amount_to_sell.asset_id.keyword': sellAssetId } } as any);
    }
    return {
        size: 0,
        query: { bool: { filter: filters } },
        aggs: {
            by_time: {
                date_histogram: {
                    field:          'block_data.block_time',
                    fixed_interval: toIntervalLabel(intervalSeconds),
                    min_doc_count:  1,
                },
            },
            total: { value_count: { field: 'operation_type' } },
        },
    };
}

/**
 * Time-bucketed count of fill_order ops for an account.
 * Optionally filtered to fills where account pays a specific asset.
 */
function buildFillOrderQuery(accountId, lookbackHours, intervalSeconds = 3600, paysAssetId = null) {
    const filters = [
        { term:  { operation_type: OP_FILL_ORDER } },
        { term:  { 'operation_history.op_object.account_id.keyword': accountId } },
        { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
    ];
    if (paysAssetId) {
        filters.push({ term: { 'operation_history.op_object.pays.asset_id.keyword': paysAssetId } } as any);
    }
    return {
        size: 0,
        query: { bool: { filter: filters } },
        aggs: {
            by_time: {
                date_histogram: {
                    field:          'block_data.block_time',
                    fixed_interval: toIntervalLabel(intervalSeconds),
                    min_doc_count:  1,
                },
            },
            total: { value_count: { field: 'operation_type' } },
        },
    };
}

/**
 * Time-bucketed count of limit_order_cancel ops for an account.
 */
function buildOrderCancelQuery(accountId, lookbackHours, intervalSeconds = 3600) {
    return {
        size: 0,
        query: {
            bool: {
                filter: [
                    { term:  { operation_type: OP_LIMIT_ORDER_CANCEL } },
                    { term:  { 'operation_history.op_object.fee_paying_account.keyword': accountId } },
                    { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
                ],
            },
        },
        aggs: {
            by_time: {
                date_histogram: {
                    field:          'block_data.block_time',
                    fixed_interval: toIntervalLabel(intervalSeconds),
                    min_doc_count:  1,
                },
            },
            total: { value_count: { field: 'operation_type' } },
        },
    };
}

/**
 * Daily activity breakdown by operation type for an account.
 * Merges creates (by seller), fills (by account_id), cancels (by fee_paying_account)
 * into one aggregation using a filter per op type.
 */
function buildDailyActivityQuery(accountId, lookbackHours) {
    return {
        size: 0,
        query: {
            bool: {
                filter: [
                    { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
                ],
            },
        },
        aggs: {
            creates: {
                filter: {
                    bool: {
                        filter: [
                            { term: { operation_type: OP_LIMIT_ORDER_CREATE } },
                            { term: { 'operation_history.op_object.seller.keyword': accountId } },
                        ],
                    },
                },
                aggs: {
                    by_day: {
                        date_histogram: { field: 'block_data.block_time', fixed_interval: '1d', min_doc_count: 1 },
                    },
                },
            },
            fills: {
                filter: {
                    bool: {
                        filter: [
                            { term: { operation_type: OP_FILL_ORDER } },
                            { term: { 'operation_history.op_object.account_id.keyword': accountId } },
                        ],
                    },
                },
                aggs: {
                    by_day: {
                        date_histogram: { field: 'block_data.block_time', fixed_interval: '1d', min_doc_count: 1 },
                    },
                },
            },
            cancels: {
                filter: {
                    bool: {
                        filter: [
                            { term: { operation_type: OP_LIMIT_ORDER_CANCEL } },
                            { term: { 'operation_history.op_object.fee_paying_account.keyword': accountId } },
                        ],
                    },
                },
                aggs: {
                    by_day: {
                        date_histogram: { field: 'block_data.block_time', fixed_interval: '1d', min_doc_count: 1 },
                    },
                },
            },
        },
    };
}

// ─── Raw document query builders (size>0, for price/grid analysis) ────────────

/**
 * Fetch raw limit_order_create documents for grid spacing analysis.
 * Returns the price-relevant fields plus timestamps.
 *
 * @param {string}  accountId
 * @param {number}  lookbackHours
 * @param {string}  [sellAssetId]   - optional: filter to one sell-side asset
 * @param {number}  [maxResults]
 * @returns {Object} Elasticsearch query object
 */
function buildOrderPriceQuery(accountId, lookbackHours, sellAssetId = null, maxResults = 1000) {
    const filters = [
        { term:  { operation_type: OP_LIMIT_ORDER_CREATE } },
        { term:  { 'operation_history.op_object.seller.keyword': accountId } },
        { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
    ];
    if (sellAssetId) {
        filters.push({ term: { 'operation_history.op_object.amount_to_sell.asset_id.keyword': sellAssetId } } as any);
    }
    return {
        size: maxResults,
        _source: [
            'block_data.block_time',
            'operation_history.op_object.amount_to_sell',
            'operation_history.op_object.min_to_receive',
            'operation_history.op_object.expiration',
        ],
        query: { bool: { filter: filters } },
        sort:  [{ 'block_data.block_time': { order: 'desc' } }],
    };
}

/**
 * Fetch raw fill_order documents for fill-price analysis.
 *
 * @param {string}  accountId
 * @param {number}  lookbackHours
 * @param {string}  [paysAssetId]
 * @param {number}  [maxResults]
 * @returns {Object} Elasticsearch query object
 */
function buildFillPriceQuery(accountId, lookbackHours, paysAssetId = null, maxResults = 500) {
    const filters = [
        { term:  { operation_type: OP_FILL_ORDER } },
        { term:  { 'operation_history.op_object.account_id.keyword': accountId } },
        { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
    ];
    if (paysAssetId) {
        filters.push({ term: { 'operation_history.op_object.pays.asset_id.keyword': paysAssetId } } as any);
    }
    return {
        size: maxResults,
        _source: [
            'block_data.block_time',
            'operation_history.op_object.pays',
            'operation_history.op_object.receives',
            'operation_history.op_object.order_id',
        ],
        query: { bool: { filter: filters } },
        sort:  [{ 'block_data.block_time': { order: 'desc' } }],
    };
}

/**
 * Discover which asset pairs an account trades by aggregating the sell asset IDs.
 * Returns top asset IDs by order count.
 */
function buildAssetDiscoveryQuery(accountId, lookbackHours) {
    return {
        size: 0,
        query: {
            bool: {
                filter: [
                    { term:  { operation_type: OP_LIMIT_ORDER_CREATE } },
                    { term:  { 'operation_history.op_object.seller.keyword': accountId } },
                    { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
                ],
            },
        },
        aggs: {
            sell_assets: {
                terms: {
                    field: 'operation_history.op_object.amount_to_sell.asset_id.keyword',
                    size:  10,
                },
            },
            recv_assets: {
                terms: {
                    field: 'operation_history.op_object.min_to_receive.asset_id.keyword',
                    size:  10,
                },
            },
        },
    };
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function fetchOrderCreate(accountId, lookbackHours, config = {}, sellAssetId = null, intervalSeconds = 3600) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    return kibanaSearch(cfg, buildOrderCreateQuery(accountId, lookbackHours, intervalSeconds, sellAssetId));
}

async function fetchFillOrder(accountId, lookbackHours, config = {}, paysAssetId = null, intervalSeconds = 3600) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    return kibanaSearch(cfg, buildFillOrderQuery(accountId, lookbackHours, intervalSeconds, paysAssetId));
}

async function fetchOrderCancel(accountId, lookbackHours, config = {}, intervalSeconds = 3600) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    return kibanaSearch(cfg, buildOrderCancelQuery(accountId, lookbackHours, intervalSeconds));
}

async function fetchOrderPrices(accountId, lookbackHours, config = {}, sellAssetId = null, maxResults = 1000) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    return kibanaSearch(cfg, buildOrderPriceQuery(accountId, lookbackHours, sellAssetId, maxResults));
}

async function fetchFillPrices(accountId, lookbackHours, config = {}, paysAssetId = null, maxResults = 500) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    return kibanaSearch(cfg, buildFillPriceQuery(accountId, lookbackHours, paysAssetId, maxResults));
}

async function fetchDailyActivity(accountId, lookbackHours, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    return kibanaSearch(cfg, buildDailyActivityQuery(accountId, lookbackHours));
}

async function fetchAssetDiscovery(accountId, lookbackHours, config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    return kibanaSearch(cfg, buildAssetDiscoveryQuery(accountId, lookbackHours));
}

// ─── Discovery query builders ─────────────────────────────────────────────────

/**
 * Top N accounts by limit_order_create count (seller field).
 * Use this to discover the most active order-placing accounts.
 */
function buildTopSellerAccountsQuery(lookbackHours, topN = 100, minCreates = 10) {
    return {
        size: 0,
        query: {
            bool: {
                filter: [
                    { term:  { operation_type: OP_LIMIT_ORDER_CREATE } },
                    { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
                ],
            },
        },
        aggs: {
            by_account: {
                terms: {
                    field:          'operation_history.op_object.seller.keyword',
                    size:           topN,
                    min_doc_count:  minCreates,
                    order:          { _count: 'desc' },
                },
            },
        },
    };
}

/**
 * Top N accounts by limit_order_cancel count (fee_paying_account field).
 */
function buildTopCancellerAccountsQuery(lookbackHours, topN = 100, minCancels = 5) {
    return {
        size: 0,
        query: {
            bool: {
                filter: [
                    { term:  { operation_type: OP_LIMIT_ORDER_CANCEL } },
                    { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
                ],
            },
        },
        aggs: {
            by_account: {
                terms: {
                    field:         'operation_history.op_object.fee_paying_account.keyword',
                    size:          topN,
                    min_doc_count: minCancels,
                    order:         { _count: 'desc' },
                },
            },
        },
    };
}

/**
 * Top N accounts by fill_order count (account_id field).
 */
function buildTopFilledAccountsQuery(lookbackHours, topN = 100, minFills = 3) {
    return {
        size: 0,
        query: {
            bool: {
                filter: [
                    { term:  { operation_type: OP_FILL_ORDER } },
                    { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
                ],
            },
        },
        aggs: {
            by_account: {
                terms: {
                    field:         'operation_history.op_object.account_id.keyword',
                    size:          topN,
                    min_doc_count: minFills,
                    order:         { _count: 'desc' },
                },
            },
        },
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { OP_LIMIT_ORDER_CREATE, OP_LIMIT_ORDER_CANCEL, OP_FILL_ORDER, DEFAULT_CONFIG, kibanaSearch, buildOrderCreateQuery, buildFillOrderQuery, buildOrderCancelQuery, buildDailyActivityQuery, buildAssetDiscoveryQuery, buildOrderPriceQuery, buildFillPriceQuery, fetchOrderCreate, fetchFillOrder, fetchOrderCancel, fetchOrderPrices, fetchFillPrices, fetchDailyActivity, fetchAssetDiscovery, buildTopSellerAccountsQuery, buildTopCancellerAccountsQuery, buildTopFilledAccountsQuery }

