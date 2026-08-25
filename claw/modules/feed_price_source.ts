'use strict';
/**
 * Feed Price Source
 *
 * Fetches the on-chain settlement feed price for an MPA and provides it
 * in a form the trend analyzer can consume.
 *
 * Also fetches a market price (mid-price from order book) to pair with
 * the feed for a complete trend analyzer update.
 */


import { getAsset, getBackingAsset, getBitassetData, dbCall } from './chain_queries.js';
import { computeBtsPerMpa } from './mpa_utils.js';
import { roundTo } from '../../modules/order/utils/math.js';


/**
 * Extract BTS-per-MPA from the settlement price object.
 * Re-exported alias of the canonical computeBtsPerMpa in mpa_utils.
 */
const parseBtsPerMpa = computeBtsPerMpa;

/**
 * Fetch the current feed price for an MPA.
 *
 * @param {string} mpaSymbol – e.g. 'HONEST.USD'
 * @returns {Object} { feedPrice, mpaSymbol, mpaAssetId, backingSymbol, publicationTime }
 *   feedPrice is in BTS-per-MPA units.
 */
async function fetchFeedPrice(mpaSymbol: string) {
  const mpaAsset = await getAsset(mpaSymbol);
  if (!mpaAsset) throw new Error(`Asset not found: ${mpaSymbol}`);

  const backingAsset = await getBackingAsset(mpaSymbol);
  if (!backingAsset) throw new Error(`Backing asset not found for: ${mpaSymbol}`);

  const bitassetData = await getBitassetData(mpaSymbol);
  if (!bitassetData) throw new Error(`Not an MPA: ${mpaSymbol}`);

  const settlement = bitassetData?.current_feed?.settlement_price;
  const feedPrice = parseBtsPerMpa(settlement, mpaAsset, backingAsset);

  return {
    feedPrice,
    mpaSymbol: mpaAsset.symbol,
    mpaAssetId: mpaAsset.id,
    backingSymbol: backingAsset.symbol,
    publicationTime: bitassetData?.current_feed_publication_time || null,
  };
}

/**
 * Fetch the mid-price from the order book for a market pair.
 *
 * @param {string} baseSymbol  – e.g. 'BTS'
 * @param {string} quoteSymbol – e.g. 'HONEST.USD'
 * @param {number} [depth=1]   – Order book depth to fetch
 * @returns {number|null} Mid-price (average of best bid and best ask) in base-per-quote,
 *          or null if no orders exist.
 */
async function fetchMidPrice(baseSymbol: string, quoteSymbol: string, depth: number = 1) {
  const baseAsset = await getAsset(baseSymbol);
  const quoteAsset = await getAsset(quoteSymbol);
  if (!baseAsset || !quoteAsset) return null;

  const orderBook = await dbCall('get_order_book', [baseAsset.symbol, quoteAsset.symbol, depth]);
  if (!orderBook) return null;

  const bestBid = orderBook?.bids?.[0]?.price;
  const bestAsk = orderBook?.asks?.[0]?.price;

  if (!Number.isFinite(Number(bestBid)) || !Number.isFinite(Number(bestAsk))) return null;

  return (Number(bestBid) + Number(bestAsk)) / 2;
}

/**
 * Fetch both feed price and market mid-price for a trend analyzer update.
 *
 * @param {string} mpaSymbol – e.g. 'HONEST.USD'
 * @returns {Object} { marketPrice, feedPrice, premium, mpaSymbol, publicationTime }
 *   Both prices in BTS-per-MPA units.
 *   premium = ((market - feed) / feed) * 100
 */
async function fetchTrendInput(mpaSymbol: string) {
  const feedData = await fetchFeedPrice(mpaSymbol);
  const marketPrice = await fetchMidPrice('BTS', mpaSymbol);

  let premium: number | null = null;
  if (marketPrice != null && feedData.feedPrice != null && Number.isFinite(marketPrice) && Number.isFinite(feedData.feedPrice) && feedData.feedPrice > 0) {
    premium = ((marketPrice - feedData.feedPrice) / feedData.feedPrice) * 100;
  }

  return {
    marketPrice,
    feedPrice: feedData.feedPrice,
    premium: premium !== null ? roundTo(premium, 10000) : null,
    mpaSymbol: feedData.mpaSymbol,
    publicationTime: feedData.publicationTime,
  };
}

export { fetchFeedPrice, fetchMidPrice, fetchTrendInput, parseBtsPerMpa }

