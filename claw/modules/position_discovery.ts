/**
 * Position Discovery
 *
 * Scans an account's on-chain call orders (debt positions) and returns
 * normalized position objects that feed into the health assessor.
 *
 * This module discovers positions from the chain — it does not depend on
 * PositionManager state files. It sees what actually exists on-chain.
 */


import { roundTo } from '../../modules/order/utils/math.js';
'use strict';

import { getAsset, getBackingAsset, getBitassetData, getFullAccount } from './chain_queries.js';
import { computeCallOrderAmounts } from './mpa_utils.js';

/**
 * Normalize a raw call order into a position object compatible with
 * assessPosition() from position_health.ts.
 *
 * @param {Object} callOrder    – Raw call_order from get_full_accounts
 * @param {Object} mpaAsset     – Resolved MPA asset object
 * @param {Object} backingAsset – Resolved backing asset object
 * @param {Object} bitassetData – Resolved bitasset data object
 * @returns {Object} Normalized position
 */
function normalizeCallOrder(callOrder: any, mpaAsset: any, backingAsset: any, bitassetData: any) {
  const amounts = computeCallOrderAmounts(callOrder, mpaAsset, backingAsset, bitassetData);

  return {
    id: callOrder.id,
    borrower: callOrder.borrower,
    status: 'debt_open',
    market: `${mpaAsset.symbol}/${backingAsset.symbol}`,
    mpaSymbol: mpaAsset.symbol,
    backingSymbol: backingAsset.symbol,
    onChain: {
      callOrderId: callOrder.id,
      collateralAmount: amounts.collateralAmount,
      collateralRatio: amounts.collateralRatio,
      debtAmount: amounts.debtAmount,
      debtValueInBts: amounts.debtValueInBts,
      btsPerMpa: amounts.btsPerMpa,
      feedPublicationTime: bitassetData?.current_feed_publication_time || null,
    },
  };
}

/**
 * Discover all debt positions for an account by scanning its call orders.
 *
 * @param {string} accountName – BitShares account name or ID
 * @returns {Promise<Array>} Array of normalized position objects
 */
async function discoverPositions(accountName: string) {
  const fullAccount = await getFullAccount(accountName);
  if (!fullAccount) throw new Error(`Account not found: ${accountName}`);

  const callOrders = Array.isArray(fullAccount.call_orders) ? fullAccount.call_orders : [];
  if (callOrders.length === 0) return [] as any[];

  // Collect unique debt asset IDs
  const debtAssetIds = [...new Set(
    callOrders.map((co: any) => co?.call_price?.quote?.asset_id).filter(Boolean)
  )];

  // Resolve every debt asset's MPA/backing/bitasset triple in parallel.
  const assetCache = new Map();
  const bitassetCache = new Map();

  await Promise.all(debtAssetIds.map(async (assetId) => {
    const [mpaAsset, backingAsset, bitassetData] = await Promise.all([
      getAsset(assetId).catch(() => null),
      getBackingAsset(assetId).catch(() => null),
      getBitassetData(assetId).catch(() => null)
    ]);

    if (mpaAsset) assetCache.set(assetId, mpaAsset);
    if (backingAsset) assetCache.set(`backing:${assetId}`, backingAsset);
    if (bitassetData) bitassetCache.set(assetId, bitassetData);
  }));

  // Normalize each call order
  const positions: any[] = [];
  for (const callOrder of callOrders) {
    const debtAssetId = callOrder?.call_price?.quote?.asset_id;
    if (!debtAssetId) continue;

    const mpaAsset = assetCache.get(debtAssetId);
    const backingAsset = assetCache.get(`backing:${debtAssetId}`);
    const bitassetData = bitassetCache.get(debtAssetId);
    if (!mpaAsset || !backingAsset || !bitassetData) continue;

    positions.push(normalizeCallOrder(callOrder, mpaAsset, backingAsset, bitassetData));
  }

  return positions;
}

/**
 * Discover positions and return a summary suitable for quick inspection.
 *
 * @param {string} accountName – BitShares account name or ID
 * @returns {Promise<Object>} { account, positionCount, discoveredAt, positions: [...summary] }
 */
async function discoverPositionsSummary(accountName: string) {
  const positions = await discoverPositions(accountName);
  return {
    account: accountName,
    positionCount: positions.length,
    discoveredAt: new Date().toISOString(),
    positions: positions.map(p => ({
      id: p.id,
      market: p.market,
      debt: p.onChain.debtAmount,
      collateral: p.onChain.collateralAmount,
      cr: p.onChain.collateralRatio ? roundTo(p.onChain.collateralRatio, 1000) : null,
      btsPerMpa: p.onChain.btsPerMpa ? roundTo(p.onChain.btsPerMpa, 10000) : null,
    })),
  };
}

export { discoverPositions, discoverPositionsSummary, normalizeCallOrder }

