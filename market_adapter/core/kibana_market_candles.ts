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

'use strict';

const { DEFAULT_CONFIG: BASE_CONFIG } = require('./kibana_client');
const { toIntervalLabel } = require('../interval_utils');
const { fetchKibanaCandles, fetchKibanaClosePrices } = require('./kibana_candles');

const OP_FILL_ORDER = 4;

const DEFAULT_CONFIG = {
  ...BASE_CONFIG,
  intervalSeconds: 3600,   // 1h candles
  lookbackHours:   500,    // ~20 days
  consolidateByTimestamp: true,
};

const FILL_FIELD_MAP = {
  soldAssetField: 'operation_history.op_object.pays.asset_id.keyword',
  receivedAssetField: 'operation_history.op_object.receives.asset_id.keyword',
  soldAmountField: 'operation_history.op_object.pays.amount',
  receivedAmountField: 'operation_history.op_object.receives.amount',
};

// ─── Query Builders ──────────────────────────────────────────────────────────

/**
 * Build ES query for fill_order aggregation in one direction.
 *
 * Filters fills where pays.asset_id = soldAssetId, aggregates by time bucket:
 *   sum_sold     = Σ pays.amount
 *   sum_received = Σ receives.amount
 *
 * VWAP per bucket = sum_received / sum_sold (precision-adjusted externally).
 *
 * @param {string}      soldAssetId    – e.g. '1.3.0' (BTS)
 * @param {string}      receivedAssetId – e.g. '1.3.5649' (HONEST.USD)
 * @param {number}      lookbackHours
 * @param {number}      intervalSeconds
 * @param {Object|null} timeRange      – { gte, lte } ISO strings
 * @returns {Object} ES query object
 */
function buildFillCandleQuery(soldAssetId, receivedAssetId, lookbackHours, intervalSeconds, timeRange = null) {
  const rangeValue = timeRange
    ? { gte: timeRange.gte, lte: timeRange.lte }
    : { gte: `now-${lookbackHours}h`, lte: 'now' };

  return {
    size: 0,
    query: {
      bool: {
        filter: [
          { term:  { operation_type: OP_FILL_ORDER } },
          { term:  { 'operation_history.op_object.pays.asset_id.keyword': soldAssetId } },
          { term:  { 'operation_history.op_object.receives.asset_id.keyword': receivedAssetId } },
          { range: { 'block_data.block_time': rangeValue } },
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
        aggs: {
          sum_sold: {
            sum: { field: 'operation_history.op_object.pays.amount' },
          },
          sum_received: {
            sum: { field: 'operation_history.op_object.receives.amount' },
          },
        },
      },
    },
  };
}

// ─── Bucket → Candle ─────────────────────────────────────────────────────────

function bucketsToCandles(buckets, soldPrecision, receivedPrecision) {
  const soldScale = Math.pow(10, soldPrecision);
  const recvScale = Math.pow(10, receivedPrecision);

  return buckets
    .filter((b) => b.sum_sold.value > 0 && b.sum_received.value > 0)
    .map((b) => {
      const soldAmt = b.sum_sold.value / soldScale;
      const recvAmt = b.sum_received.value / recvScale;
      const vwap = recvAmt / soldAmt;
      return [b.key, vwap, vwap, vwap, vwap, soldAmt];
    });
}

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
async function getMarketCandles(assetA, assetB, config = {}) {
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
async function getMarketClosePrices(assetA, assetB, config = {}) {
  return fetchKibanaClosePrices({
    opType: OP_FILL_ORDER,
    fieldMap: FILL_FIELD_MAP,
    assetA,
    assetB,
    config,
  });
}

/**
 * Fetch candles for an MPA/BTS market using symbol strings.
 * Resolves asset objects internally using chain queries if available,
 * or accepts pre-resolved asset objects.
 *
 * @param {Object} baseAsset   – { id, precision, symbol } for BTS
 * @param {Object} quoteAsset  – { id, precision, symbol } for the MPA
 * @param {Object} [config]
 * @returns {Promise<Array>} OHLCV candles (quote-per-base, e.g. HONEST.USD per BTS)
 */
async function getMpaCandles(baseAsset, quoteAsset, config = {}) {
  return getMarketCandles(baseAsset, quoteAsset, config);
}

export = {
  // Primary API
  getMarketCandles,
  getMarketClosePrices,
  getMpaCandles,

  // Low-level (testing / custom queries)
  buildFillCandleQuery,
  bucketsToCandles,
};
