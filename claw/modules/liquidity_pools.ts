

import * as client from './bitshares_client';
import { getDexbot2Root, loadDexbotOrderSystemUtils, requireDexbot2Module } from './dexbot_bridge';
function getDexbotSystem() {
  return loadDexbotOrderSystemUtils();
}

function derivePoolPrice(assetA: any, assetB: any) {
  return getDexbotSystem().derivePoolPrice(client.BitShares, assetA, assetB);
}

function derivePrice(assetA: any, assetB: any, mode: any) {
  return getDexbotSystem().derivePrice(client.BitShares, assetA, assetB, mode);
}

function createDexbotPoolHelper() {
  const system = getDexbotSystem();
  return {
    cloneMap: system.cloneMap,
    derivePoolPrice: (assetA: any, assetB: any) => system.derivePoolPrice(client.BitShares, assetA, assetB),
    derivePrice: (assetA: any, assetB: any, mode: any) => system.derivePrice(client.BitShares, assetA, assetB, mode),
    deepFreeze: system.deepFreeze,
    loadAmaCenterSnapshot: system.loadAmaCenterSnapshot,
    loadAmaCenterPrice: system.loadAmaCenterPrice,
    lookupAsset: system.lookupAsset
  };
}

export { derivePoolPrice, derivePrice, createDexbotPoolHelper, getDexbot2Root, requireDexbot2Module }

