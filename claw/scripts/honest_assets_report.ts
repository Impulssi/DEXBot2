import { getAsset, getBackingAsset, getBitassetData, getCallOrders, getDynamicGlobalProperties, listAssets } from '../modules/chain_queries.js';
import { getHardcodedHonestMoneyBridge } from '../modules/honest_ecosystem.js';
import { getErrorMessage } from '../../modules/utils/errors';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const REFERENCE_SYMBOL = 'HONEST.MONEY';
const DEFAULT_PREFIX = 'HONEST.';

function parseArgs(argv: any) {
  const options = {
    allMpas: false,
    batchSize: DEFAULT_BATCH_SIZE,
    json: false,
    maxPages: DEFAULT_MAX_PAGES,
    prefix: DEFAULT_PREFIX,
    startSymbol: DEFAULT_PREFIX
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--all-mpas') {
      options.allMpas = true;
      options.startSymbol = 'A';
    } else if (arg === '--batch-size' && argv[i + 1]) {
      options.batchSize = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--max-pages' && argv[i + 1]) {
      options.maxPages = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--prefix' && argv[i + 1]) {
      options.prefix = String(argv[i + 1]);
      options.startSymbol = options.prefix;
      i += 1;
    } else if (arg === '--start-symbol' && argv[i + 1]) {
      options.startSymbol = String(argv[i + 1]);
      i += 1;
    }
  }

  return options;
}

function toPositiveInteger(value: any, fallback: any) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isMpa(asset: any) {
  return Boolean(asset && asset.bitasset_data_id);
}

function isHonestAsset(asset: any) {
  return typeof asset?.symbol === 'string' && asset.symbol.startsWith('HONEST.');
}

async function fetchAllAssets({ batchSize, maxPages, startSymbol }: { batchSize: any; maxPages: any; startSymbol: any }) {
  const results = [];
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

    results.push(...pageItems);
    previousLastSymbol = pageItems[pageItems.length - 1].symbol;
    lowerBound = previousLastSymbol;

    if (batch.length < batchSize) {
      break;
    }
  }

  return results;
}

async function fetchAssetsByPrefix({ batchSize, maxPages, prefix, startSymbol }: { batchSize: any; maxPages: any; prefix: any; startSymbol: any }) {
  const results = [];
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

    const matching = [];
    let crossedPrefixBoundary = false;

    for (const item of pageItems) {
      const symbol = item?.symbol || '';
      if (symbol.startsWith(prefix)) {
        matching.push(item);
        continue;
      }

      if (matching.length > 0 || symbol > prefix) {
        crossedPrefixBoundary = true;
        break;
      }
    }

    results.push(...matching);

    const lastItem = pageItems[pageItems.length - 1];
    previousLastSymbol = lastItem?.symbol || previousLastSymbol;
    lowerBound = previousLastSymbol || lowerBound;

    if (crossedPrefixBoundary || batch.length < batchSize) {
      break;
    }
  }

  return results;
}

async function mapWithConcurrency(items: any, concurrency: any, mapper: any) {
  const safeConcurrency = Math.max(1, concurrency);
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(safeConcurrency, items.length || 1) }, worker));
  return results;
}

function computeBasePerQuote(priceObject: any, assetMap: any) {
  const base = priceObject?.base;
  const quote = priceObject?.quote;
  if (!base || !quote) {
    return null;
  }

  const basePrecision = assetMap.get(base.asset_id)?.precision;
  const quotePrecision = assetMap.get(quote.asset_id)?.precision;
  if (!Number.isFinite(basePrecision) || !Number.isFinite(quotePrecision)) {
    return null;
  }

  const baseUnits = Number(base.amount) / (10 ** basePrecision);
  const quoteUnits = Number(quote.amount) / (10 ** quotePrecision);
  if (!Number.isFinite(baseUnits) || !Number.isFinite(quoteUnits) || baseUnits <= 0 || quoteUnits <= 0) {
    return null;
  }

  return baseUnits / quoteUnits;
}

async function getHonestMoneyPerBts(referenceAsset: any, coreAsset: any) {
  const bridge = getHardcodedHonestMoneyBridge();
  const coreSide = [bridge.liquidityPool.reserves[0], bridge.liquidityPool.reserves[1]].find((asset) => asset.symbol === coreAsset.symbol);
  const referenceSide = [bridge.liquidityPool.reserves[0], bridge.liquidityPool.reserves[1]].find((asset) => asset.symbol === referenceAsset.symbol);

  if (!coreSide || !referenceSide) {
    return null;
  }

  const latestHonestMoneyPerBts = referenceSide.amount / coreSide.amount;
  if (!Number.isFinite(latestHonestMoneyPerBts) || latestHonestMoneyPerBts <= 0) {
    return null;
  }

  return {
    liquidityPool: {
      id: bridge.liquidityPool.id,
      poolSymbol: bridge.liquidityPool.poolSymbol,
      reserves: [
        bridge.liquidityPool.reserves[0],
        bridge.liquidityPool.reserves[1]
      ],
      takerFeePercent: bridge.liquidityPool.takerFeePercent,
      withdrawalFeePercent: bridge.liquidityPool.withdrawalFeePercent
    },
    market: `${referenceAsset.symbol}/${coreAsset.symbol}`,
    latestHonestMoneyPerBts,
    source: bridge.source
  };
}

async function getReferenceFeedData(asset: any, referenceAsset: any, coreAsset: any, honestMoneyPerBts: any, assetMap: any) {
  if (asset.id === referenceAsset.id) {
    return {
      latestInHonestMoney: 1,
      market: `${referenceAsset.symbol}/${referenceAsset.symbol}`,
      sourceDirection: 'self',
      sourceType: 'identity'
    };
  }

  if (!isMpa(asset)) {
    return null;
  }

  const bitassetData = await getBitassetData(asset.id).catch(() => null);
  const settlementPrice = bitassetData?.current_feed?.settlement_price;
  const currentFeedTime = bitassetData?.current_feed_publication_time || null;
  if (!settlementPrice || !honestMoneyPerBts?.latestHonestMoneyPerBts) {
    return null;
  }

  const basePerQuote = computeBasePerQuote(settlementPrice, assetMap);
  if (!basePerQuote) {
    return null;
  }

  let assetPerBts = null;
  let btsPerAsset = null;

  if (settlementPrice.base.asset_id === asset.id && settlementPrice.quote.asset_id === coreAsset.id) {
    assetPerBts = basePerQuote;
    btsPerAsset = 1 / basePerQuote;
  } else if (settlementPrice.base.asset_id === coreAsset.id && settlementPrice.quote.asset_id === asset.id) {
    btsPerAsset = basePerQuote;
    assetPerBts = 1 / basePerQuote;
  } else {
    return null;
  }

  return {
    btsPerAsset,
    currentFeedPublicationTime: currentFeedTime,
    latestInHonestMoney: btsPerAsset * honestMoneyPerBts.latestHonestMoneyPerBts,
    market: `${asset.symbol}/BTS -> BTS/${referenceAsset.symbol}`,
    sourceDirection: 'feed-derived',
    sourceType: 'current_feed',
    usedReferenceMarket: honestMoneyPerBts.market
  };
}

async function buildAssetRecord(asset: any, referenceAsset: any, coreAsset: any, honestMoneyPerBts: any, assetMap: any) {
  const backingAsset = isMpa(asset) ? await getBackingAsset(asset.id).catch(() => null) : null;
  const callOrders = isMpa(asset) ? await getCallOrders(asset.id, 20).catch(() => []) : [];
  const referenceMarket = await getReferenceFeedData(asset, referenceAsset, coreAsset, honestMoneyPerBts, assetMap);

  return {
    backingAsset: backingAsset?.symbol || null,
    callOrdersCount: Array.isArray(callOrders) ? callOrders.length : 0,
    id: asset.id,
    issuer: asset.issuer,
    precision: asset.precision,
    referenceMarket,
    symbol: asset.symbol,
    type: isMpa(asset) ? 'MPA' : 'ASSET'
  };
}

function printSummary(report: any) {
  console.log(report.scopeLabel);
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Head block: ${report.chain.headBlockNumber}`);
  console.log(`Reference asset: ${report.referenceAsset.symbol} (${report.referenceAsset.id})`);
  console.log(`HONEST.MONEY/BTS bridge: ${report.honestMoneyPerBts.latestHonestMoneyPerBts} via ${report.honestMoneyPerBts.source}`);
  console.log(`Total assets scanned: ${report.counts.totalAssets}`);
  console.log(`Scoped assets: ${report.counts.scopedAssets}`);
  console.log(`Scoped MPAs: ${report.counts.scopedMpas}`);
  console.log(`MPAs with HONEST.MONEY feed reference: ${report.counts.mpasWithHonestMoneyReference}`);
  console.log('');

  console.log(`${report.scopeLabel} assets`);
  console.table(
    report.scopedAssets.map((asset: any) => ({
      backing: asset.backingAsset || '-',
      callOrders: asset.callOrdersCount,
      id: asset.id,
      priceInHonestMoney: asset.referenceMarket?.latestInHonestMoney ?? '-',
      symbol: asset.symbol,
      type: asset.type
    }))
  );

  console.log('MPA overview');
  console.table(
    report.mpas.map((asset: any) => ({
      backing: asset.backingAsset || '-',
      callOrders: asset.callOrdersCount,
      id: asset.id,
      priceInHonestMoney: asset.referenceMarket?.latestInHonestMoney ?? '-',
      source: asset.referenceMarket?.sourceDirection ?? '-',
      symbol: asset.symbol
    }))
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const batchSize = toPositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
  const maxPages = toPositiveInteger(options.maxPages, DEFAULT_MAX_PAGES);

  const globals = await getDynamicGlobalProperties();
  const coreAsset = await getAsset('BTS');
  const referenceAsset = await getAsset(REFERENCE_SYMBOL);
  if (!referenceAsset || !coreAsset) {
    throw new Error(`Reference asset not found: ${REFERENCE_SYMBOL}`);
  }
  const honestMoneyPerBts = await getHonestMoneyPerBts(referenceAsset, coreAsset);
  if (!honestMoneyPerBts) {
    throw new Error(`Could not resolve BTS/${REFERENCE_SYMBOL} conversion market`);
  }

  const allAssets = options.allMpas
    ? await fetchAllAssets({
        batchSize,
        maxPages,
        startSymbol: options.startSymbol
      })
    : await fetchAssetsByPrefix({
        batchSize,
        maxPages,
        prefix: options.prefix,
        startSymbol: options.startSymbol
      });

  const scopedAssets = options.allMpas
    ? allAssets.filter(isMpa).sort((a, b) => a.symbol.localeCompare(b.symbol))
    : allAssets.filter((asset) => asset?.symbol?.startsWith(options.prefix)).sort((a, b) => a.symbol.localeCompare(b.symbol));
  const mpas = scopedAssets.filter(isMpa);
  const assetMap = new Map([coreAsset, referenceAsset, ...scopedAssets].filter(Boolean).map((asset) => [asset.id, asset]));

  const scopedAssetRecords = await mapWithConcurrency(scopedAssets, 4, async (asset: any) => {
    try {
      return await buildAssetRecord(asset, referenceAsset, coreAsset, honestMoneyPerBts, assetMap);
    } catch (err: any) {
      return {
        backingAsset: null,
        callOrdersCount: 0,
        error: err?.message || String(err),
        id: asset?.id || null,
        issuer: asset?.issuer || null,
        precision: asset?.precision ?? null,
        referenceMarket: null,
        symbol: asset?.symbol || null,
        type: isMpa(asset) ? 'MPA' : 'ASSET'
      };
    }
  });
  const mpaRecords = scopedAssetRecords.filter((asset) => asset.type === 'MPA');

  const report = {
    chain: {
      headBlockNumber: globals?.head_block_number ?? null
    },
    counts: {
      mpasWithHonestMoneyReference: mpaRecords.filter((asset) => asset.referenceMarket?.latestInHonestMoney).length,
      totalAssets: allAssets.length,
      scopedAssets: scopedAssetRecords.length,
      scopedMpas: mpaRecords.length
    },
    generatedAt: new Date().toISOString(),
    mpas: mpaRecords,
    honestMoneyPerBts,
    referenceAsset: {
      id: referenceAsset.id,
      precision: referenceAsset.precision,
      symbol: referenceAsset.symbol,
      type: isMpa(referenceAsset) ? 'MPA' : 'ASSET'
    },
    scopeLabel: options.allMpas ? 'All MPA report' : `${options.prefix} asset report`,
    scopedAssets: scopedAssetRecords
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSummary(report);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(getErrorMessage(err));
    process.exit(1);
  });
export {};
