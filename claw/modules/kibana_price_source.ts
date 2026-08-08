/**
 * Kibana Price Source
 *
 * Claw-facing module that provides historical price data from Kibana
 * for trend analysis, backtesting, and market evaluation.
 *
 * Two data sources:
 *   - Order book fills (fill_order, op_type 4) → MPA/BTS market candles
 *   - LP pool swaps (liquidity_pool_exchange, op_type 63) → LP price candles
 *
 * This module resolves asset objects from chain and delegates to the
 * market_adapter/core/ modules for the actual Kibana queries.
 */


import { getMarketCandles, getMarketClosePrices } from '../../market_adapter/core/kibana_market_candles.js';
import { getLpCandlesForPool, getLpClosePricesForPool, discoverPoolAssets } from '../../market_adapter/inputs/kibana_source.js';
import { getAsset } from './chain_queries.js';
'use strict';


/**
 * Resolve a symbol or asset ID to a { id, precision, symbol } object.
 */
async function resolveAsset(symbolOrId: string) {
  const asset = await getAsset(symbolOrId);
  if (!asset) throw new Error(`Asset not found: ${symbolOrId}`);
  return { id: asset.id, precision: asset.precision, symbol: asset.symbol };
}

// ─── Order Book Candles (fill_order) ─────────────────────────────────────────

/**
 * Fetch historical OHLCV candles from order book fills for an MPA/BTS market.
 *
 * @param {string} mpaSymbol – e.g. 'HONEST.USD'
 * @param {Object} [config]
 * @param {number} [config.intervalSeconds=3600]  – Candle size (1h default)
 * @param {number} [config.lookbackHours=500]     – How far back
 * @returns {Promise<Array>} OHLCV candles [[ts, o, h, l, c, vol], ...]
 *   Price in BTS-per-MPA units.
 */
async function fetchMarketCandles(mpaSymbol: string, config: Record<string, any> = {}) {
  const btsAsset = await resolveAsset('BTS');
  const mpaAsset = await resolveAsset(mpaSymbol);
  return getMarketCandles(btsAsset, mpaAsset, config);
}

/**
 * Fetch close prices only from order book fills.
 *
 * @param {string} mpaSymbol – e.g. 'HONEST.USD'
 * @param {Object} [config]
 * @returns {Promise<number[]>} Array of close prices (BTS-per-MPA)
 */
async function fetchMarketClosePrices(mpaSymbol: string, config: Record<string, any> = {}) {
  const btsAsset = await resolveAsset('BTS');
  const mpaAsset = await resolveAsset(mpaSymbol);
  return getMarketClosePrices(btsAsset, mpaAsset, config);
}

// ─── LP Pool Candles (liquidity_pool_exchange) ───────────────────────────────

/**
 * Fetch historical OHLCV candles from LP pool swaps.
 *
 * @param {string|number} poolId      – e.g. '1.19.305' or 305
 * @param {string}        assetASymbol – e.g. 'BTS'
 * @param {string}        assetBSymbol – e.g. 'HONEST.MONEY'
 * @param {Object}        [config]
 * @returns {Promise<Array>} OHLCV candles [[ts, o, h, l, c, vol], ...]
 */
async function fetchLpCandles(poolId: any, assetASymbol: string, assetBSymbol: string, config: Record<string, any> = {}) {
  const assetA = await resolveAsset(assetASymbol);
  const assetB = await resolveAsset(assetBSymbol);
  return getLpCandlesForPool(poolId, assetA, assetB, config);
}

/**
 * Fetch close prices only from LP pool swaps.
 *
 * @param {string|number} poolId      – e.g. '1.19.305' or 305
 * @param {string}        assetASymbol – e.g. 'BTS'
 * @param {string}        assetBSymbol – e.g. 'HONEST.MONEY'
 * @param {Object}        [config]
 * @returns {Promise<Object>} LP close prices
 */
async function fetchLpClosePrices(poolId: any, assetASymbol: string, assetBSymbol: string, config: Record<string, any> = {}) {
  const assetA = await resolveAsset(assetASymbol);
  const assetB = await resolveAsset(assetBSymbol);
  return getLpClosePricesForPool(poolId, assetA, assetB, config);
}

/**
 * Discover which asset pair a pool trades.
 *
 * @param {string|number} poolId
 * @param {Object}        [config]
 * @returns {Promise<string[]>} Array of asset IDs in the pool
 */
async function fetchPoolAssets(poolId: any, config: Record<string, any> = {}) {
  return discoverPoolAssets(poolId, config);
}

// ─── Combined: Market + Feed for Trend Analysis ─────────────────────────────

/**
 * Fetch historical market candles and extract close prices for trend analysis.
 *
 * Returns candles with their close prices — suitable for
 * initializing a TrendAnalyzer with historical context before switching
 * to live feed_price_source updates.
 *
 * @param {string} mpaSymbol – e.g. 'HONEST.USD'
 * @param {Object} [config]
 * @returns {Promise<Object>} { candles, closePrices, candleCount, mpaSymbol, intervalSeconds, lookbackHours }
 */
async function fetchTrendHistoryCandles(mpaSymbol: string, config: Record<string, any> = {}) {
  const candles: any = await fetchMarketCandles(mpaSymbol, config);
  const closePrices = candles.map(([, , , , close]: [number, number, number, number, number]) => close);

  return {
    candles,
    closePrices,
    candleCount: candles.length,
    mpaSymbol,
    intervalSeconds: config.intervalSeconds || 3600,
    lookbackHours: config.lookbackHours || 500,
  };
}

export { fetchMarketCandles, fetchMarketClosePrices, fetchLpCandles, fetchLpClosePrices, fetchPoolAssets, fetchTrendHistoryCandles }

