'use strict';

import { getAsset, getBackingAsset } from './chain_queries.js';

const CORE_SYMBOL = 'BTS';

async function requireBtsBackedMpa(mpaSymbolOrId: any) {
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
    throw new Error(`${mpaAsset.symbol || mpaSymbolOrId} is backed by ${backingAsset.symbol}, not ${CORE_SYMBOL}`);
  }

  return {
    backingAsset,
    mpaAsset
  };
}

export { CORE_SYMBOL, requireBtsBackedMpa }

