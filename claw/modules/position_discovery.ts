/**
 * Position Discovery
 *
 * Scans an account's on-chain call orders (debt positions) and returns
 * normalized position objects that feed into the health assessor.
 *
 * This module discovers positions from the chain — it does not depend on
 * PositionManager state files. It sees what actually exists on-chain.
 */


import { loadDexbotOrderUtils } from './dexbot_bridge';
import { roundTo } from '../../modules/utils/math_utils';
'use strict';

import { getAsset, getBackingAsset, getBitassetData, getFullAccount } from './chain_queries.js';

function getBlockchainToFloat() {
  return loadDexbotOrderUtils().blockchainToFloat;
}

/**
 * Compute BTS-per-MPA from settlement price.
 */
function computeBtsPerMpa(settlementPrice: any, mpaAsset: any, backingAsset: any) {
  const base = settlementPrice?.base;
  const quote = settlementPrice?.quote;
  if (!base || !quote) return null;

  const blockchainToFloat = getBlockchainToFloat();
  const baseAmount = blockchainToFloat(
    base.amount,
    base.asset_id === mpaAsset.id ? mpaAsset.precision : backingAsset.precision
  );
  const quoteAmount = blockchainToFloat(
    quote.amount,
    quote.asset_id === mpaAsset.id ? mpaAsset.precision : backingAsset.precision
  );
  if (!baseAmount || !quoteAmount) return null;

  if (base.asset_id === backingAsset.id && quote.asset_id === mpaAsset.id) {
    return baseAmount / quoteAmount;
  }
  if (base.asset_id === mpaAsset.id && quote.asset_id === backingAsset.id) {
    return quoteAmount / baseAmount;
  }
  return null;
}

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
  const blockchainToFloat = getBlockchainToFloat();
  const debtAmount = blockchainToFloat(callOrder.debt, mpaAsset.precision);
  const collateralAmount = blockchainToFloat(callOrder.collateral, backingAsset.precision);
  const settlement = bitassetData?.current_feed?.settlement_price;
  const btsPerMpa = computeBtsPerMpa(settlement, mpaAsset, backingAsset);
  const debtValueInBts = debtAmount && btsPerMpa ? debtAmount * btsPerMpa : 0;
  const collateralRatio = debtValueInBts > 0 ? collateralAmount / debtValueInBts : null;

  return {
    id: callOrder.id,
    borrower: callOrder.borrower,
    status: 'debt_open',
    market: `${mpaAsset.symbol}/${backingAsset.symbol}`,
    mpaSymbol: mpaAsset.symbol,
    backingSymbol: backingAsset.symbol,
    onChain: {
      callOrderId: callOrder.id,
      collateralAmount: collateralAmount || 0,
      collateralRatio,
      debtAmount: debtAmount || 0,
      debtValueInBts,
      btsPerMpa,
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

  // Resolve all assets in parallel
  const assetCache = new Map();
  const bitassetCache = new Map();

  for (const assetId of debtAssetIds) {
    const mpaAsset = await getAsset(assetId);
    if (!mpaAsset) continue;
    assetCache.set(assetId, mpaAsset);

    const backingAsset = await getBackingAsset(assetId);
    if (backingAsset) assetCache.set(`backing:${assetId}`, backingAsset);

    const bitassetData = await getBitassetData(assetId);
    if (bitassetData) bitassetCache.set(assetId, bitassetData);
  }

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

