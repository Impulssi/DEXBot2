'use strict';
/**
 * KIBANA MARKET CANDLES
 *
 * Fetches OHLCV candles from order book fill operations (op_type 4)
 * for any asset pair on BitShares. Unlike kibana_source.ts which handles
 * LP pool swaps (op_type 63), this module handles regular limit order fills.
 *
 * Use case: historical price candles for MPA/BTS markets where the margin
 * trading system needs trend detection input beyond just the current
 * on-chain feed price.
 *
 * Data source:
 *   Kibana: https://kibana.bitshares.dev
 *   Index:  bitshares-*
 *   Operation type: 4 (fill_order)
 *
 * ES field paths for fill_order:
 *   op_object.pays.amount    – integer amount paid
 *   op_object.pays.asset_id  – asset ID paid
 *   op_object.receives.amount     – integer amount received
 *   op_object.receives.asset_id   – asset ID received
 *   op_object.account_id          – whose order was filled
 *   op_object.order_id            – the limit order that filled
 *
 * Output: [[timestamp_ms, open, high, low, close, volume_base], ...]
 * Same OHLCV format as kibana_source.ts for compatibility with candle_utils.
 */


import { fetchKibanaCandles, fetchKibanaClosePrices } from './kibana_candles.js';


const OP_FILL_ORDER = 4;

const FILL_FIELD_MAP = {
  soldAssetField: 'operation_history.op_object.pays.asset_id.keyword',
  receivedAssetField: 'operation_history.op_object.receives.asset_id.keyword',
  soldAmountField: 'operation_history.op_object.pays.amount',
  receivedAmountField: 'operation_history.op_object.receives.amount',
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch bidirectional fill candles for an asset pair.
 *
 * Queries both directions (A→B fills and B→A fills), inverts B→A to
 * unified "B per A" pricing, merges by timestamp.
 *
 * @param {Object} assetA  – { id: '1.3.0', precision: 5, symbol: 'BTS' }
 * @param {Object} assetB  – { id: '1.3.5649', precision: 4, symbol: 'HONEST.USD' }
 * @param {Object} [config]
 * @returns {Promise<Array>} OHLCV candles in B-per-A units
 */
async function getMarketCandles(assetA: any, assetB: any, config: any = {}) {
  return fetchKibanaCandles({
    opType: OP_FILL_ORDER,
    fieldMap: FILL_FIELD_MAP,
    assetA,
    assetB,
    config,
  });
}

/**
 * Close prices only — convenience wrapper for AMA / trend analyzer input.
 *
 * @param {string} assetA – First asset ID
 * @param {string} assetB – Second asset ID
 * @param {Object} [config] – Optional configuration overrides
 * @returns {Promise<Object>} Parsed close price response
 */
async function getMarketClosePrices(assetA: any, assetB: any, config: any = {}) {
  return fetchKibanaClosePrices({
    opType: OP_FILL_ORDER,
    fieldMap: FILL_FIELD_MAP,
    assetA,
    assetB,
    config,
  });
}

export { getMarketCandles, getMarketClosePrices }

