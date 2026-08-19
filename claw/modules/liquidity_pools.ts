

import * as client from './bitshares_client.js';
import { getDexbot2Root, loadDexbotOrderSystemUtils, requireDexbot2Module } from './dexbot_bridge.js';
function getDexbotSystem() {
  return loadDexbotOrderSystemUtils();
}

function derivePoolPrice(assetA: any, assetB: any, poolRef?: string | null | Record<string, any>) {
  const system = getDexbotSystem();
  const resolvedPoolRef = typeof poolRef === 'string' ? poolRef : (poolRef && typeof poolRef.poolRef === 'string' ? poolRef.poolRef : null);
  if (resolvedPoolRef) {
    try {
      const { withPoolRef: wrapWithPoolRef } = requireDexbot2Module('modules/order/utils/withPoolRef') as any;
      const override = wrapWithPoolRef(client.BitShares, resolvedPoolRef);
      if (override) return override.derivePoolPrice(assetA, assetB);
    } catch (e: any) {
      console.warn(`[liquidity-pools] derivePoolPrice with poolRef failed: ${e?.message || e}`);
    }
  }
  return system.derivePoolPrice(client.BitShares, assetA, assetB);
}

function derivePrice(assetA: any, assetB: any, mode: any, poolRef?: string | null) {
  const system = getDexbotSystem();
  if (poolRef) {
    try {
      const { derivePriceWithPoolRef: wrapPriceWithPoolRef } = requireDexbot2Module('modules/order/utils/withPoolRef') as any;
      return wrapPriceWithPoolRef(client.BitShares, assetA, assetB, mode, poolRef);
    } catch (e: any) {
      console.warn(`[liquidity-pools] derivePrice with poolRef failed: ${e?.message || e}`);
    }
  }
  return system.derivePrice(client.BitShares, assetA, assetB, mode);
}

function createDexbotPoolHelper() {
  const system = getDexbotSystem();
  return {
    cloneMap: system.cloneMap,
    derivePoolPrice: (assetA: any, assetB: any, poolRef?: string | null) => derivePoolPrice(assetA, assetB, poolRef),
    derivePrice: (assetA: any, assetB: any, mode: any, poolRef?: string | null) => derivePrice(assetA, assetB, mode, poolRef),
    deepFreeze: system.deepFreeze,
    loadAmaCenterSnapshot: system.loadAmaCenterSnapshot,
    loadAmaCenterPrice: system.loadAmaCenterPrice,
    lookupAsset: system.lookupAsset
  };
}

export { derivePoolPrice, derivePrice, createDexbotPoolHelper, getDexbot2Root, requireDexbot2Module }

