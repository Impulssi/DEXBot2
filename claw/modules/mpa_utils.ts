'use strict';

import { getAsset, getBackingAsset } from './chain_queries.js';
import { loadDexbotOrderUtils } from './dexbot_bridge.js';

const CORE_SYMBOL = 'BTS';

async function requireBtsBackedMpa(mpaSymbolOrId: any, hint?: string) {
  const mpaAsset = await getAsset(mpaSymbolOrId);
  if (!mpaAsset) {
    throw new Error(`Asset not found: ${mpaSymbolOrId}`);
  }
  if (!mpaAsset.bitasset_data_id) {
    throw new Error(`${mpaSymbolOrId} is not a market-issued asset`);
  }

  const backingAsset = await getBackingAsset(mpaAsset.id);
  if (!backingAsset) {
    throw new Error(`Could not resolve backing asset for ${mpaSymbolOrId}`);
  }
  if (backingAsset.symbol !== CORE_SYMBOL) {
    const hintSuffix = hint ? `; ${hint}` : '';
    throw new Error(`${mpaAsset.symbol || mpaSymbolOrId} is backed by ${backingAsset.symbol}, not ${CORE_SYMBOL}${hintSuffix}`);
  }

  return {
    backingAsset,
    mpaAsset
  };
}

function getBlockchainToFloat() {
  return loadDexbotOrderUtils().blockchainToFloat;
}

/**
 * Compute BTS-per-MPA from a settlement price object.
 * Canonical implementation shared by position discovery, position manager,
 * and the feed price source.
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
 * Compute the normalized debt/collateral figures for a raw call order.
 * Canonical implementation shared by position discovery and the position
 * manager so both surfaces report identical amounts and ratios.
 */
function computeCallOrderAmounts(callOrder: any, mpaAsset: any, backingAsset: any, bitassetData: any) {
  const blockchainToFloat = getBlockchainToFloat();
  const debtAmount = blockchainToFloat(callOrder.debt, mpaAsset.precision);
  const collateralAmount = blockchainToFloat(callOrder.collateral, backingAsset.precision);
  const btsPerMpa = computeBtsPerMpa(bitassetData?.current_feed?.settlement_price, mpaAsset, backingAsset);
  const debtValueInBts = debtAmount && btsPerMpa ? debtAmount * btsPerMpa : 0;
  const collateralRatio = debtValueInBts > 0 ? collateralAmount / debtValueInBts : null;

  return {
    btsPerMpa,
    collateralAmount: collateralAmount || 0,
    collateralRatio,
    debtAmount: debtAmount || 0,
    debtValueInBts
  };
}

export { CORE_SYMBOL, computeBtsPerMpa, computeCallOrderAmounts, getBlockchainToFloat, requireBtsBackedMpa }

