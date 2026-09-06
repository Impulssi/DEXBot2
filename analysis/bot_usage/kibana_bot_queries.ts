'use strict';
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
 *
 *   limit_order_update (op 77, DEXBot2-only — native in-place re-price):
 *     op_object.seller                    — account that updated the order
 *     op_object.order                     — the limit order ID updated
 */


import { kibanaSearch, DEFAULT_CONFIG as BASE_CONFIG } from '../../market_adapter/core/kibana_client.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const OP_LIMIT_ORDER_CREATE = 1;
const OP_LIMIT_ORDER_CANCEL = 2;
const OP_FILL_ORDER         = 4;
// Native in-place order re-price. Only DEXBot2 broadcasts this (COW UPDATE
// actions via buildUpdateOrderOp); DEXBot1 (Python staggered_orders) predates
// it and can only cancel + recreate. Presence of op 77 on an account is the
// DEXBot2 fingerprint; absence means cancel-only (DEXBot1-style).
const OP_LIMIT_ORDER_UPDATE = 77;

const DEFAULT_CONFIG = {
    ...BASE_CONFIG,
    timeout: 25000,
};

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
function buildOrderPriceQuery(accountId: string, lookbackHours: number, sellAssetId: string | null = null, maxResults: number = 1000) {
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

// ─── Discovery query builders ─────────────────────────────────────────────────

/**
 * Top N accounts by limit_order_create count (seller field).
 * Use this to discover the most active order-placing accounts.
 */
function buildTopSellerAccountsQuery(lookbackHours: number, topN: number = 100, minCreates: number = 10) {
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
function buildTopCancellerAccountsQuery(lookbackHours: number, topN: number = 100, minCancels: number = 5) {
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
function buildTopFilledAccountsQuery(lookbackHours: number, topN: number = 100, minFills: number = 3) {
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

/**
 * Top N accounts by limit_order_update count (seller field, op 77).
 * DEXBot2 fingerprint: only DEXBot2 broadcasts native in-place re-prices
 * (COW UPDATE actions). DEXBot1-style bots never emit op 77 — they cancel
 * (op 2) and recreate (op 1) instead.
 */
function buildTopUpdaterAccountsQuery(lookbackHours: number, topN: number = 200, minUpdates: number = 1) {
    return {
        size: 0,
        query: {
            bool: {
                filter: [
                    { term:  { operation_type: OP_LIMIT_ORDER_UPDATE } },
                    { range: { 'block_data.block_time': { gte: `now-${lookbackHours}h`, lte: 'now' } } },
                ],
            },
        },
        aggs: {
            by_account: {
                terms: {
                    field:         'operation_history.op_object.seller.keyword',
                    size:          topN,
                    min_doc_count: minUpdates,
                    order:         { _count: 'desc' },
                },
            },
        },
    };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export { DEFAULT_CONFIG, kibanaSearch, buildOrderPriceQuery, buildTopSellerAccountsQuery, buildTopCancellerAccountsQuery, buildTopFilledAccountsQuery, buildTopUpdaterAccountsQuery, OP_LIMIT_ORDER_UPDATE }

