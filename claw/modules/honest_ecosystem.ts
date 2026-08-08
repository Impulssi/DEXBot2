

import { getAsset, getBackingAsset, getBitassetData, getCallOrders, getObjects, listAssets } from './chain_queries.js';
import { derivePoolPrice } from './liquidity_pools.js';
import { clone } from './utils.js';
const REFERENCE_SYMBOL = 'HONEST.MONEY';
const CORE_SYMBOL = 'BTS';
const DEFAULT_PREFIX = 'HONEST.';
// Fallback HONEST.MONEY/BTS pool values used when the live LP pool query fails.
// Last verified: pool 1.19.305 — refresh by running `npm run report:honest-assets` on a live node.
const HARDCODED_POOL_ID = '1.19.305';
const HARDCODED_HONEST_MONEY_BTS_POOL = {
  assetA: {
    amount: 29854.8782,
    symbol: CORE_SYMBOL
  },
  assetB: {
    amount: 70846.22383703,
    symbol: REFERENCE_SYMBOL
  },
  id: HARDCODED_POOL_ID,
  poolSymbol: 'honest.BTSMONEY',
  takerFeePercent: 0.4,
  withdrawalFeePercent: 0
};


function isMpa(asset: any) {
  return Boolean(asset && asset.bitasset_data_id);
}

function isHonestAsset(asset: any) {
  return typeof asset?.symbol === 'string' && asset.symbol.startsWith(DEFAULT_PREFIX);
}

async function fetchLivePoolReserves(poolId: string = HARDCODED_POOL_ID) {
  try {
    const objects = await getObjects([poolId]);
    const pool = objects && objects[0];
    if (!pool || pool.asset_a == null || pool.asset_b == null) return null;

    const [assetAObj, assetBObj] = await Promise.all([
      getAsset(pool.asset_a),
      getAsset(pool.asset_b)
    ]);

    const precisionA = assetAObj?.precision ?? 0;
    const precisionB = assetBObj?.precision ?? 0;
    const balanceA = Number(pool.balance_a) || 0;
    const balanceB = Number(pool.balance_b) || 0;

    return {
      assetA: {
        amount: precisionA > 0 ? balanceA / Math.pow(10, precisionA) : balanceA,
        symbol: assetAObj?.symbol || CORE_SYMBOL
      },
      assetB: {
        amount: precisionB > 0 ? balanceB / Math.pow(10, precisionB) : balanceB,
        symbol: assetBObj?.symbol || REFERENCE_SYMBOL
      },
      id: poolId,
      poolSymbol: pool.share_asset || HARDCODED_HONEST_MONEY_BTS_POOL.poolSymbol,
      takerFeePercent: pool.taker_fee_percent ?? HARDCODED_HONEST_MONEY_BTS_POOL.takerFeePercent,
      withdrawalFeePercent: pool.withdrawal_fee_percent ?? HARDCODED_HONEST_MONEY_BTS_POOL.withdrawalFeePercent,
      source: 'live-liquidity-pool'
    };
  } catch {
    return null;
  }
}

async function getHonestMoneyBridge() {
  const live = await fetchLivePoolReserves();
  if (live) {
    const core = live.assetA.symbol === CORE_SYMBOL ? live.assetA : live.assetB;
    const honestMoney = live.assetA.symbol === REFERENCE_SYMBOL ? live.assetA : live.assetB;
    const latestHonestMoneyPerBts = Number(core.amount) > 0 ? honestMoney.amount / core.amount : null;
    return { liquidityPool: live, latestHonestMoneyPerBts, market: `${REFERENCE_SYMBOL}/${CORE_SYMBOL}`, source: live.source };
  }
  return getHardcodedHonestMoneyBridge();
}

function getHardcodedHonestMoneyBridge() {
  const core = HARDCODED_HONEST_MONEY_BTS_POOL.assetA;
  const honestMoney = HARDCODED_HONEST_MONEY_BTS_POOL.assetB;
  const latestHonestMoneyPerBts = Number(core.amount) > 0 ? honestMoney.amount / core.amount : null;

  return {
    liquidityPool: {
      id: HARDCODED_HONEST_MONEY_BTS_POOL.id,
      poolSymbol: HARDCODED_HONEST_MONEY_BTS_POOL.poolSymbol,
      reserves: [
        clone(HARDCODED_HONEST_MONEY_BTS_POOL.assetA),
        clone(HARDCODED_HONEST_MONEY_BTS_POOL.assetB)
      ],
      source: 'hardcoded-liquidity-pool',
      takerFeePercent: HARDCODED_HONEST_MONEY_BTS_POOL.takerFeePercent,
      withdrawalFeePercent: HARDCODED_HONEST_MONEY_BTS_POOL.withdrawalFeePercent
    },
    latestHonestMoneyPerBts,
    market: `${REFERENCE_SYMBOL}/${CORE_SYMBOL}`,
    source: 'hardcoded-liquidity-pool'
  };
}

function isHardcodedHonestMoneyBtsPair(assetA: any, assetB: any) {
  const assetASymbol = assetA && typeof assetA === 'object' ? assetA.symbol : assetA;
  const assetBSymbol = assetB && typeof assetB === 'object' ? assetB.symbol : assetB;

  return (
    (assetASymbol === REFERENCE_SYMBOL && assetBSymbol === CORE_SYMBOL) ||
    (assetASymbol === CORE_SYMBOL && assetBSymbol === REFERENCE_SYMBOL)
  );
}

async function resolveHardcodedHonestMoneyPrice(assetA: any, assetB: any) {
  const assetASymbol = assetA && typeof assetA === 'object' ? assetA.symbol : assetA;
  const assetBSymbol = assetB && typeof assetB === 'object' ? assetB.symbol : assetB;

  const bridge = await getHonestMoneyBridge();
  const bridgePrice = bridge.latestHonestMoneyPerBts;

  if (bridgePrice === null || !Number.isFinite(bridgePrice) || bridgePrice <= 0) {
    return null;
  }

  if (assetASymbol === REFERENCE_SYMBOL && assetBSymbol === CORE_SYMBOL) {
    return bridgePrice;
  }

  if (assetASymbol === CORE_SYMBOL && assetBSymbol === REFERENCE_SYMBOL) {
    return 1 / bridgePrice;
  }

  return null;
}

async function resolveHonestPairPrice(assetA: any, assetB: any, options: Record<string, any> = {}) {
  const hardcoded = await resolveHardcodedHonestMoneyPrice(assetA, assetB);
  if (hardcoded !== null) {
    return hardcoded;
  }

  return derivePoolPrice(assetA, assetB, options);
}

async function resolveHonestPairContext(assetA: any, assetB: any, options: Record<string, any> = {}) {
  const pairPrice = await resolveHonestPairPrice(assetA, assetB, options).catch(() => null);
  const assetASymbol = assetA && typeof assetA === 'object' ? assetA.symbol : assetA;
  const assetBSymbol = assetB && typeof assetB === 'object' ? assetB.symbol : assetB;

  if (!isHardcodedHonestMoneyBtsPair(assetA, assetB)) {
    return {
      assetA: {
        symbol: assetASymbol
      },
      assetB: {
        symbol: assetBSymbol
      },
      priceBPerA: pairPrice,
      source: pairPrice === null ? 'unresolved' : 'dexbot2-derivePoolPrice'
    };
  }

  const bridge = await getHonestMoneyBridge();
  const assetAEntry = bridge.liquidityPool.reserves.find((entry) => entry.symbol === assetASymbol) || null;
  const assetBEntry = bridge.liquidityPool.reserves.find((entry) => entry.symbol === assetBSymbol) || null;

  return {
    assetA: {
      id: assetASymbol === CORE_SYMBOL ? '1.3.0' : null,
      precision: null,
      symbol: assetASymbol
    },
    assetB: {
      id: assetBSymbol === CORE_SYMBOL ? '1.3.0' : null,
      precision: null,
      symbol: assetBSymbol
    },
    pool: {
      ...bridge.liquidityPool,
      source: 'hardcoded-liquidity-pool'
    },
    priceBPerA: pairPrice,
    reserveA: assetAEntry ? assetAEntry.amount : null,
    reserveB: assetBEntry ? assetBEntry.amount : null,
    source: 'hardcoded-liquidity-pool'
  };
}

async function loadHonestAssets({ prefix = DEFAULT_PREFIX, batchSize = 100, maxPages = 100, startSymbol = DEFAULT_PREFIX }: Record<string, any> = {}) {
  const all = [];
  let lowerBound = startSymbol;
  let previousLastSymbol = null;

  for (let page = 0; page < maxPages; page += 1) {
    const batch = await listAssets(lowerBound, batchSize);
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    let pageItems = batch.filter(Boolean);
    if (previousLastSymbol && pageItems[0]?.symbol === previousLastSymbol) {
      pageItems = pageItems.slice(1);
    }

    if (pageItems.length === 0) {
      break;
    }

    const matching = pageItems.filter((asset) => isHonestAsset(asset) && asset.symbol.startsWith(prefix));
    all.push(...matching);

    previousLastSymbol = pageItems[pageItems.length - 1].symbol;
    lowerBound = previousLastSymbol;

    if (batch.length < batchSize) {
      break;
    }
  }

  const mpas = [];
  for (const asset of all) {
    if (!isMpa(asset)) {
      continue;
    }

    const backingAsset = await getBackingAsset(asset.id).catch(() => null);
    const callOrders = await getCallOrders(asset.id, 20).catch(() => []);
    const bitassetData = await getBitassetData(asset.id).catch(() => null);
    mpas.push({
      backingAsset: backingAsset ? {
        id: backingAsset.id,
        precision: backingAsset.precision,
        symbol: backingAsset.symbol
      } : null,
      callOrdersCount: Array.isArray(callOrders) ? callOrders.length : 0,
      currentFeedPublicationTime: bitassetData?.current_feed_publication_time || null,
      id: asset.id,
      precision: asset.precision,
      symbol: asset.symbol
    });
  }

  return {
    assets: all,
    mpas
  };
}

async function buildHonestEcosystemContext(options: Record<string, any> = {}) {
  const prefix = options.prefix || DEFAULT_PREFIX;
  const [coreAsset, referenceAsset] = await Promise.all([
    getAsset(CORE_SYMBOL),
    getAsset(REFERENCE_SYMBOL)
  ]);

  if (!coreAsset || !referenceAsset) {
    throw new Error(`Could not resolve ${CORE_SYMBOL} or ${REFERENCE_SYMBOL}`);
  }

  const honestAssets = await loadHonestAssets({
    batchSize: options.batchSize,
    maxPages: options.maxPages,
    prefix,
    startSymbol: options.startSymbol || prefix
  });

  const requestedPairs = Array.isArray(options.discoverPairs) ? options.discoverPairs : [];
  const pairContexts = [];
  for (const pair of requestedPairs) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      continue;
    }

    const context = await resolveHonestPairContext(pair[0], pair[1], options).catch(() => null);
    if (context) {
      pairContexts.push(context);
    }
  }

  return {
    assets: honestAssets.assets.map((asset) => ({
      id: asset.id,
      precision: asset.precision,
      symbol: asset.symbol,
      type: isMpa(asset) ? 'MPA' : 'ASSET'
    })),
    bridge: await getHonestMoneyBridge(),
    pairContexts,
    mpas: honestAssets.mpas,
    referenceAsset: {
      id: referenceAsset.id,
      precision: referenceAsset.precision,
      symbol: referenceAsset.symbol
    },
    scope: {
      prefix
    },
    summary: {
      assetCount: honestAssets.assets.length,
      pairContextCount: pairContexts.length,
      mpaCount: honestAssets.mpas.length
    }
  };
}

function createHonestEcosystemAdapter(options: Record<string, any> = {}) {
  return {
    buildContext: (contextOptions = {}) => buildHonestEcosystemContext({
      ...options,
      ...contextOptions
    }),
    getHardcodedHonestMoneyBridge,
    loadAssets: (assetOptions = {}) => loadHonestAssets({
      ...options,
      ...assetOptions
    }),
    resolvePairContext: (assetA: any, assetB: any, contextOptions = {}) => resolveHonestPairContext(assetA, assetB, {
      ...options,
      ...contextOptions
    }),
    resolvePairPrice: (assetA: any, assetB: any, priceOptions = {}) => resolveHonestPairPrice(assetA, assetB, {
      ...options,
      ...priceOptions
    }),
    resolveHardcodedHonestMoneyPrice
  };
}

export { CORE_SYMBOL, DEFAULT_PREFIX, REFERENCE_SYMBOL, buildHonestEcosystemContext, createHonestEcosystemAdapter, getHardcodedHonestMoneyBridge, loadHonestAssets, isHardcodedHonestMoneyBtsPair, resolveHardcodedHonestMoneyPrice, resolveHonestPairContext, resolveHonestPairPrice }

