'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Config } = require('../modules/config');

const { ensureDir, writeJSON } = require('../modules/utils/fs_utils');
const ORDERS_DIR = path.join(__dirname, '..', 'profiles', 'orders');
const ANALYZER_PATH = path.resolve(__dirname, '..', 'scripts', 'analyze-orders.ts');
const WHITELIST_MODULE_PATH = path.resolve(__dirname, '..', 'modules', 'market_adapter_whitelist.ts');
const TEST_WHITELIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-analyze-whitelist-'));
const TEST_WHITELIST_PATH = path.join(TEST_WHITELIST_DIR, 'market_adapter_whitelist.json');

function loadAnalyzer() {
  delete require.cache[ANALYZER_PATH];
  // tsx is registered as a Node loader by the test runner; require() then
  // transpiles the .ts file on the fly.
  return require(ANALYZER_PATH);
}

function stripColorCodes(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, '');
}

function writeSnapshot(botKey, payload) {
  const filePath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
  ensureDir(path.dirname(filePath));
  writeJSON(filePath, payload);
  return filePath;
}

function removeSnapshot(botKey) {
  const filePath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function withWhitelist(entries, fn) {
  const originalEnv = process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE;
  const originalConfigWhitelist = Config.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE;
  writeJSON(TEST_WHITELIST_PATH, { whitelist: entries });
  process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = TEST_WHITELIST_PATH;
  Config.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = TEST_WHITELIST_PATH;
  delete require.cache[WHITELIST_MODULE_PATH];
  delete require.cache[ANALYZER_PATH];
  try {
    return fn();
  } finally {
    if (originalEnv === undefined) {
      delete process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE;
    } else {
      process.env.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = originalEnv;
    }
    Config.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE = originalConfigWhitelist;
    if (fs.existsSync(TEST_WHITELIST_PATH)) {
      fs.unlinkSync(TEST_WHITELIST_PATH);
    }
    delete require.cache[WHITELIST_MODULE_PATH];
    delete require.cache[ANALYZER_PATH];
  }
}

function testSnapshotStalenessMatchesTwoMarketAdapterCycles() {
  const { DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS } = loadAnalyzer();
  const { MARKET_ADAPTER } = require('../modules/constants');
  const expected = 2 * MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds * 1000;
  assert.strictEqual(
    DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS,
    expected,
    `staleness window should be 2 * pollSeconds * 1000 (expected ${expected} ms, got ${DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS} ms)`,
  );
}

function testIsAmaGridPrice() {
  const { isAmaGridPrice } = loadAnalyzer();
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'ama' }), true, 'ama should match');
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'AMA' }), true, 'uppercase should match');
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'ama2' }), true, 'ama2 should match');
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'ama4' }), true, 'ama4 should match');
  assert.strictEqual(isAmaGridPrice({ gridPrice: '  ama  ' }), true, 'whitespace tolerated');
  assert.strictEqual(isAmaGridPrice({ gridPrice: 'fixed' }), false, 'fixed is not AMA');
  assert.strictEqual(isAmaGridPrice({ gridPrice: '' }), false, 'empty is not AMA');
  assert.strictEqual(isAmaGridPrice({ gridPrice: null }), false, 'null is not AMA');
  assert.strictEqual(isAmaGridPrice({}), false, 'missing gridPrice is not AMA');
  assert.strictEqual(isAmaGridPrice(null), false, 'null config is not AMA');
}

function testBuildDynamicWeightInfoRecentSnapshot() {
  const botKey = `dw-recent-${Date.now()}`;
  // Updated 1 second ago - definitely recent.
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    centerPrice: 100,
    dynamicWeights: {
      effectiveWeights: { sell: 0.55, buy: 0.45 },
      baseWeights: { sell: 0.5, buy: 0.5 },
      trend: 'UP',
      isReady: true,
      finalOffset: 0.05,
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(info, 'expected info for recent snapshot');
    assert.strictEqual(info.live.buy, 0.45, 'live buy should match effectiveWeights.buy');
    assert.strictEqual(info.live.sell, 0.55, 'live sell should match effectiveWeights.sell');
    assert.strictEqual(info.base.buy, 0.5, 'base buy should match snapshot baseWeights');
    assert.strictEqual(info.base.sell, 0.5, 'base sell should match snapshot baseWeights');
    assert.strictEqual(info.isRecent, true, 'snapshot is recent');
    assert.strictEqual(info.isReady, true);
    assert.strictEqual(info.trend, 'UP');
    assert.strictEqual(info.finalOffset, 0.05);
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoStaleSnapshot() {
  const botKey = `dw-stale-${Date.now()}`;
  // Updated 3 hours ago - past the 2-cycle freshness window (2h default).
  const updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    centerPrice: 100,
    dynamicWeights: {
      effectiveWeights: { sell: 0.7, buy: 0.3 },
      baseWeights: { sell: 0.5, buy: 0.5 },
      trend: 'DOWN',
      isReady: true,
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(info, 'snapshot is read even when stale');
    assert.strictEqual(info.isRecent, false, 'snapshot is NOT recent');
    assert.strictEqual(info.live.sell, 0.7);
    assert.strictEqual(info.live.buy, 0.3);
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoNonAmaBot() {
  const { buildDynamicWeightInfo } = loadAnalyzer();
  const botKey = `dw-nonama-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      effectiveWeights: { sell: 0.6, buy: 0.4 },
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const info = buildDynamicWeightInfo(botKey, { gridPrice: 'fixed', weightDistribution: { buy: 0.5, sell: 0.5 } });
    assert.strictEqual(info, null, 'non-AMA bots should skip dynamic weight lookup');
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoMissingSnapshot() {
  const { buildDynamicWeightInfo } = loadAnalyzer();
  const info = buildDynamicWeightInfo('does-not-exist-bot', { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
  assert.strictEqual(info, null, 'no snapshot should yield null info');
}

function testBuildDynamicWeightInfoFallsBackToConfigBase() {
  const botKey = `dw-fallback-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      effectiveWeights: { sell: 0.55, buy: 0.45 },
      // No baseWeights - we should fall back to config.weightDistribution.
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.4, sell: 0.6 } });
    });
    assert.ok(info, 'expected info when baseWeights missing but config provides baseline');
    assert.strictEqual(info.base.buy, 0.4, 'base buy should fall back to config');
    assert.strictEqual(info.base.sell, 0.6, 'base sell should fall back to config');
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoRejectsMissingEffectiveWeights() {
  const botKey = `dw-noeff-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      // No effectiveWeights: adapter status is still useful, but live weights are not.
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const info = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(info, 'missing effectiveWeights should still expose adapter snapshot status');
    assert.strictEqual(info.live, null, 'missing effectiveWeights should not expose live weights');
    assert.strictEqual(info.isRecent, true, 'fresh snapshot remains fresh without effectiveWeights');
  } finally {
    removeSnapshot(botKey);
  }
}

function testBuildDynamicWeightInfoRequiresAmaWhitelistForSnapshotStatus() {
  const botKey = `dw-not-whitelisted-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    amaCenterPrice: 101,
    dynamicWeights: {
      effectiveWeights: { sell: 0.55, buy: 0.45 },
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const amaOnlyInfo = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.ok(amaOnlyInfo, 'AMA-only whitelist should expose adapter snapshot status');
    assert.strictEqual(amaOnlyInfo.live, null, 'AMA-only whitelist should not enable dynamic weight display');
    assert.strictEqual(amaOnlyInfo.amaCenterPrice, 101, 'AMA center should be available for AMA-only bots');

    const dynamicOnlyInfo = withWhitelist({
      [botKey]: { ama: false, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo } = loadAnalyzer();
      return buildDynamicWeightInfo(botKey, { gridPrice: 'ama', weightDistribution: { buy: 0.5, sell: 0.5 } });
    });
    assert.strictEqual(dynamicOnlyInfo, null, 'dynamicWeight-only whitelist should not expose adapter data');
  } finally {
    removeSnapshot(botKey);
  }
}

function testFormatWeightLineAmaWithoutDynamicWhitelistStaysWhite() {
  const botKey = `dw-white-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      effectiveWeights: { sell: 0.7, buy: 0.3 },
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const line = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo, formatWeightLine } = loadAnalyzer();
      const dynamicWeight = buildDynamicWeightInfo(botKey, {
        gridPrice: 'ama',
        weightDistribution: { buy: 0.5, sell: 0.5 },
      });
      return formatWeightLine({ buy: 0.5, sell: 0.5 }, dynamicWeight);
    });
    assert.ok(line, 'expected static weight line');
    const stripped = stripColorCodes(line);
    assert.ok(stripped.includes('0.50 buy'), 'buy static value should be displayed');
    assert.ok(stripped.includes('0.50 sell'), 'sell static value should be displayed');
    assert.ok(!stripped.includes('0.70'), 'live sell value should not be displayed');
    assert.ok(!stripped.includes('0.30'), 'live buy value should not be displayed');
    assert.ok(!stripped.includes('(adapter offline)'), 'offline alert should not render without dynamic whitelist');
    assert.ok(!line.includes('\x1b[91m0.50'), 'static buy/sell values should not be red');
    assert.ok(!line.includes('\x1b[92m0.50'), 'static buy/sell values should not be green');
    assert.ok(!line.includes('\x1b[38;5;246m0.50'), 'static buy/sell values should not be grey');
  } finally {
    removeSnapshot(botKey);
  }
}

function testFormatWeightLineStaleAmaWithoutDynamicWhitelistShowsOffline() {
  const botKey = `dw-ama-stale-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    amaCenterPrice: 101,
    dynamicWeights: {
      effectiveWeights: { sell: 0.7, buy: 0.3 },
      baseWeights: { sell: 0.5, buy: 0.5 },
    },
  });

  try {
    const line = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: false },
    }, () => {
      const { buildDynamicWeightInfo, formatWeightLine } = loadAnalyzer();
      const dynamicWeight = buildDynamicWeightInfo(botKey, {
        gridPrice: 'ama',
        weightDistribution: { buy: 0.5, sell: 0.5 },
      });
      return formatWeightLine({ buy: 0.5, sell: 0.5 }, dynamicWeight);
    });
    const stripped = stripColorCodes(line);
    assert.ok(stripped.includes('(adapter offline)'), 'stale AMA-only snapshot should show adapter offline alert');
    assert.ok(!stripped.includes('0.70'), 'dynamicWeight-disabled live sell value should not be displayed');
    assert.ok(!stripped.includes('0.30'), 'dynamicWeight-disabled live buy value should not be displayed');
    assert.ok(!line.includes('\x1b[38;5;246m0.50'), 'AMA-only stale static weights should not be grey');
  } finally {
    removeSnapshot(botKey);
  }
}

function testFormatWeightLineStaticOnly() {
  const { formatWeightLine } = loadAnalyzer();
  const line = formatWeightLine({ buy: 0.5, sell: 0.5 }, null);
  assert.ok(line, 'expected a line when static weights are present');
  assert.ok(line.includes('0.50'), 'static value should be normalized to two decimals');
  assert.ok(line.startsWith('   Weight:'), 'line should use the Weight: prefix');
  const stripped = stripColorCodes(line);
  // No live values: stripped should not contain the " (<static>)" envelope.
  assert.ok(!stripped.includes('('), 'static-only line should not include the live envelope');
}

function testFormatWeightLineBuyHigherIsRed() {
  const { formatWeightLine } = loadAnalyzer();
  // live buy (0.6) > live sell (0.4): the side with the higher live weight
  // is the "losing" side (red); the lower is the "winning" side (green).
  const line = formatWeightLine(
    { buy: 0.5, sell: 0.5 },
    { isRecent: true, live: { buy: 0.6, sell: 0.4 } }
  );
  assert.ok(line, 'expected a line when live weights are recent');
  const stripped = stripColorCodes(line);
  assert.ok(stripped.includes('0.60 buy'), 'expected buy side live value');
  assert.ok(stripped.includes('0.40 sell'), 'expected sell side live value');
  assert.ok(!stripped.includes('(0.50)'), 'live line should not repeat static baseline in parentheses');
  // Buy is higher -> red; sell is lower -> green.
  assert.ok(line.includes('\x1b[91m'), 'red color must be applied to the higher live value (buy)');
  assert.ok(line.includes('\x1b[92m'), 'green color must be applied to the lower live value (sell)');
  // The first color in the line should be red (buy losing), then green (sell winning).
  const redIdx = line.indexOf('\x1b[91m');
  const greenIdx = line.indexOf('\x1b[92m');
  assert.ok(redIdx < greenIdx, 'red (losing/buy) must appear before green (winning/sell)');
  // Reset codes must follow the colored segments.
  assert.ok(line.includes('\x1b[0m'), 'color segments must be terminated with a reset');
}

function testFormatWeightLineSellHigherIsRed() {
  const { formatWeightLine } = loadAnalyzer();
  // live sell (0.6) > live buy (0.4): sell is the higher live weight -> red,
  // buy is the lower live weight -> green.
  const line = formatWeightLine(
    { buy: 0.5, sell: 0.5 },
    { isRecent: true, live: { buy: 0.4, sell: 0.6 } }
  );
  assert.ok(line, 'expected a line');
  const stripped = stripColorCodes(line);
  assert.ok(stripped.includes('0.40 buy'), 'expected buy side live value');
  assert.ok(stripped.includes('0.60 sell'), 'expected sell side live value');
  assert.ok(!stripped.includes('(0.50)'), 'live line should not repeat static baseline in parentheses');
  // Sell is higher -> red (losing); buy is lower -> green (winning).
  assert.ok(line.includes('\x1b[91m'), 'red color must be present for the higher live value (sell)');
  assert.ok(line.includes('\x1b[92m'), 'green color must be present for the lower live value (buy)');
  const redIdx = line.indexOf('\x1b[91m');
  const greenIdx = line.indexOf('\x1b[92m');
  assert.ok(greenIdx < redIdx, 'green (winning/buy) must appear before red (losing/sell)');
}

function testFormatWeightLineLiveEqualBothGrey() {
  const { formatWeightLine } = loadAnalyzer();
  // Live values are equal - neither side is higher or lower - both are grey.
  const line = formatWeightLine(
    { buy: 0.5, sell: 0.5 },
    { isRecent: true, live: { buy: 0.5, sell: 0.5 } }
  );
  assert.ok(line, 'expected a line');
  // No red or green colors should be used for the live values. The side labels
  // remain green/red, so assert against the numeric segments specifically.
  assert.ok(!line.includes('\x1b[92m0.50'), 'no green numeric value when live weights are equal');
  assert.ok(!line.includes('\x1b[91m0.50'), 'no red numeric value when live weights are equal');
  const stripped = stripColorCodes(line);
  assert.ok(stripped.includes('0.50 buy'), 'equal live buy value should still be displayed');
  assert.ok(stripped.includes('0.50 sell'), 'equal live sell value should still be displayed');
  assert.ok(!stripped.includes('(0.50)'), 'equal live line should not repeat static baseline in parentheses');
}

function testFormatWeightLineLiveStaleFallsBackToStatic() {
  const { formatWeightLine } = loadAnalyzer();
  // Stale snapshot: live data is present but isRecent is false -> static only
  // plus a red "(adapter offline)" alert.
  const line = formatWeightLine(
    { buy: 0.5, sell: 0.5 },
    { isRecent: false, live: { buy: 0.7, sell: 0.3 }, dynamicWeightEnabled: true }
  );
  assert.ok(line, 'expected a line');
  const stripped = stripColorCodes(line);
  assert.ok(!stripped.includes('0.70'), 'stale live value should not be displayed');
  assert.ok(stripped.includes('0.50'), 'static value should be displayed');
  assert.ok(stripped.includes('(adapter offline)'), 'stale snapshot should show adapter offline alert');
  assert.ok(line.includes('\x1b[91m'), 'alert should be rendered in red');
  assert.ok(line.includes('\x1b[38;5;246m'), 'static values should be grey');
}

function testFormatWeightLineMissingSnapshotHasNoAlert() {
  const { formatWeightLine } = loadAnalyzer();
  // No snapshot at all: dynamicWeight is null. We render static only, with no
  // "(adapter offline)" alert (we have no signal that the adapter is offline
  // versus that the bot has not yet been processed for the first time).
  const line = formatWeightLine({ buy: 0.5, sell: 0.5 }, null);
  assert.ok(line, 'expected a line');
  const stripped = stripColorCodes(line);
  assert.ok(!stripped.includes('(adapter offline)'),
    'missing snapshot should NOT show the adapter offline alert');
  assert.ok(stripped.includes('0.50'), 'static value should be displayed');
}

function testFormatWeightLineNullWeights() {
  const { formatWeightLine } = loadAnalyzer();
  assert.strictEqual(formatWeightLine(null, null), null, 'null weightDistribution should yield null');
  assert.strictEqual(formatWeightLine(undefined, null), null, 'undefined weightDistribution should yield null');
  assert.strictEqual(formatWeightLine({ buy: 'invalid', sell: 'invalid' }, null), null,
    'non-numeric weightDistribution should yield null');
}

function testAnalyzeOrderIncludesDynamicWeightForAma() {
  const botKey = `dw-analyze-${Date.now()}`;
  const updatedAt = new Date(Date.now() - 1000).toISOString();
  writeSnapshot(botKey, {
    updatedAt,
    dynamicWeights: {
      effectiveWeights: { sell: 0.55, buy: 0.45 },
      baseWeights: { sell: 0.5, buy: 0.5 },
      isReady: true,
      trend: 'UP',
      finalOffset: 0.05,
    },
  });

  try {
    const botData = {
      meta: { assetA: 'XRP', assetB: 'BTS', updatedAt: new Date().toISOString() },
      boundaryIdx: 0,
      grid: [
        { type: 'buy', state: 'active', orderId: 'a', price: 100, size: 1 },
        { type: 'sell', state: 'active', orderId: 'b', price: 110, size: 1 },
      ],
    };
    const config = {
      gridPrice: 'ama',
      targetSpreadPercent: 1.5,
      incrementPercent: 0.5,
      activeOrders: { buy: 1, sell: 1 },
      botFunds: { buy: 1, sell: 1 },
      weightDistribution: { buy: 0.5, sell: 0.5 },
    };
    const analysis = withWhitelist({
      [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false },
    }, () => {
      const { analyzeOrder } = loadAnalyzer();
      return analyzeOrder(botData, config, botKey);
    });
    assert.ok(analysis.dynamicWeight, 'analyzeOrder should attach dynamicWeight for AMA bots');
    assert.strictEqual(analysis.dynamicWeight.live.buy, 0.45);
    assert.strictEqual(analysis.dynamicWeight.isRecent, true);
  } finally {
    removeSnapshot(botKey);
  }
}

function testAnalyzeOrderOmitsDynamicWeightForNonAma() {
  const { analyzeOrder } = loadAnalyzer();
  const botData = {
    meta: { assetA: 'XRP', assetB: 'BTS', updatedAt: new Date().toISOString() },
    boundaryIdx: 0,
    grid: [
      { type: 'buy', state: 'active', orderId: 'a', price: 100, size: 1 },
      { type: 'sell', state: 'active', orderId: 'b', price: 110, size: 1 },
    ],
  };
  const config = {
    gridPrice: 'fixed',
    targetSpreadPercent: 1.5,
    incrementPercent: 0.5,
    activeOrders: { buy: 1, sell: 1 },
    weightDistribution: { buy: 0.5, sell: 0.5 },
  };
  const analysis = analyzeOrder(botData, config, 'does-not-exist');
  assert.strictEqual(analysis.dynamicWeight, null, 'non-AMA bot should have null dynamicWeight');
}

function testResolveAmaKey() {
  const { resolveAmaKey } = loadAnalyzer();
  assert.strictEqual(resolveAmaKey({ gridPrice: 'ama' }), 'AMA3', 'ama resolves to AMA3 (default)');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'AMA' }), 'AMA3', 'uppercase ama resolves to AMA3');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'ama2' }), 'AMA2', 'ama2 resolves to AMA2');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'ama4' }), 'AMA4', 'ama4 resolves to AMA4');
  assert.strictEqual(resolveAmaKey({ gridPrice: '  ama3  ' }), 'AMA3', 'whitespace tolerated');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'pool' }), null, 'pool is not AMA');
  assert.strictEqual(resolveAmaKey({ gridPrice: 'book' }), null, 'book is not AMA');
  assert.strictEqual(resolveAmaKey({ gridPrice: '' }), null, 'empty is not AMA');
  assert.strictEqual(resolveAmaKey({ gridPrice: null }), null, 'null is not AMA');
  assert.strictEqual(resolveAmaKey({}), null, 'missing gridPrice is not AMA');
  assert.strictEqual(resolveAmaKey(null), null, 'null config returns null');
}

function makeMockAnalysis(overrides) {
  return {
    pair: 'TEST/TEST',
    botName: 'test-bot',
    lastUpdated: new Date(),
    hasConfig: true,
    spread: { real: 2, target: 2, diff: 0, pass: true },
    increment: { avg: 0.5, target: 0.5, min: 0.49, max: 0.51, pass: true },
    slots: { buy: 10, sell: 10, spread: 0, activeBuy: 5, virtualBuy: 5, activeSell: 5, virtualSell: 5, partialBuy: 0, partialSell: 0 },
    gridMinPrice: 90,
    gridMaxPrice: 110,
    marketPrice: null,
    activeOrdersTarget: { buy: 10, sell: 10 },
    weightDistribution: { buy: 0.5, sell: 0.5 },
    gridPriceLabel: null,
    gridPriceValue: null,
    gridPriceStale: false,
    dynamicWeight: null,
    asymmetricBounds: null,
    distribution: {
      slots: { buyPercent: 50, sellPercent: 50 },
      funds: { buyPercent: 50, sellPercent: 50 },
      match: { buyDiff: 0, sellDiff: 0 },
    },
    funds: { buy: { bts: 100, xrp: 0.5 }, sell: { xrp: 100, bts: 20000 } },
    slotData: { buy: [], sell: [] },
    ...overrides,
  };
}

function testFormatAnalysisGridPriceLine() {
  const { formatAnalysis } = loadAnalyzer();

  // Grid mode: numeric gridPrice -> emits Grid: line
  const mockGrid = makeMockAnalysis({
    gridPriceLabel: 'Grid',
    gridPriceValue: 100,
    marketPrice: 105,
  });
  const gridLine = formatAnalysis(mockGrid);
  const strippedGrid = stripColorCodes(gridLine);
  assert.ok(strippedGrid.includes('Grid: 100.00'), 'numeric gridPrice should emit Grid: line');
  assert.ok(strippedGrid.includes('(+5.0%)'), 'grid price diff should be shown');

  // AMA mode with recent snapshot -> emits AMA3: line
  const mockAma = makeMockAnalysis({
    gridPriceLabel: 'AMA3',
    gridPriceValue: 100,
    marketPrice: 90,
  });
  const amaLine = formatAnalysis(mockAma);
  const strippedAma = stripColorCodes(amaLine);
  assert.ok(strippedAma.includes('AMA3: 100.00'), 'AMA mode should emit AMA3: line');
  assert.ok(strippedAma.includes('(-10.0%)'), 'AMA price diff should be shown');

  // Pool/book/startPrice mode -> no grid price line
  const mockNull = makeMockAnalysis({
    gridPriceLabel: null,
    gridPriceValue: null,
    marketPrice: 100,
  });
  const nullLine = formatAnalysis(mockNull);
  const strippedNull = stripColorCodes(nullLine);
  assert.ok(!/\bAMA[1-4]?:/.test(strippedNull), 'no AMA<N>: line without AMA label');
  assert.ok(!/\bGrid:/.test(strippedNull), 'no Grid: line without Grid label');
}

function testFormatAnalysisGridPriceStale() {
  const analyzer = loadAnalyzer();
  const { formatAnalysis, colors } = analyzer;

  // Stale snapshot -> price rendered in grey
  const mockStale = makeMockAnalysis({
    gridPriceLabel: 'AMA2',
    gridPriceValue: 200,
    gridPriceStale: true,
    marketPrice: 210,
  });
  const staleLine = formatAnalysis(mockStale);
  const mStale = staleLine.match(/\n {5}AMA2:/);
  const afterStaleAma = mStale ? staleLine.slice(mStale.index! + 1, mStale.index! + 1 + 30) : '';
  assert.ok(afterStaleAma.includes(colors.gray), 'stale AMA price should be grey');
  assert.ok(stripColorCodes(staleLine).includes('AMA2: 200.00'), 'stale line still shows label and price');

  // Recent snapshot -> price NOT grey (only the AMA3: line segment)
  const mockRecent = makeMockAnalysis({
    gridPriceLabel: 'AMA3',
    gridPriceValue: 100,
    gridPriceStale: false,
    marketPrice: 105,
  });
  const recentLine = formatAnalysis(mockRecent);
  const mRecent = recentLine.match(/\n {5}AMA3:/);
  const afterRecentAma = mRecent ? recentLine.slice(mRecent.index! + 1, mRecent.index! + 1 + 30) : '';
  assert.ok(!afterRecentAma.includes(colors.gray), 'recent AMA price should NOT be grey');
  assert.ok(stripColorCodes(recentLine).includes('AMA3: 100.00'), 'recent line shows label and price');
}

async function main() {
  testResolveAmaKey();
  testFormatAnalysisGridPriceLine();
  testFormatAnalysisGridPriceStale();
  testIsAmaGridPrice();
  testSnapshotStalenessMatchesTwoMarketAdapterCycles();
  testBuildDynamicWeightInfoRecentSnapshot();
  testBuildDynamicWeightInfoStaleSnapshot();
  testBuildDynamicWeightInfoNonAmaBot();
  testBuildDynamicWeightInfoMissingSnapshot();
  testBuildDynamicWeightInfoFallsBackToConfigBase();
  testBuildDynamicWeightInfoRejectsMissingEffectiveWeights();
  testBuildDynamicWeightInfoRequiresAmaWhitelistForSnapshotStatus();
  testFormatWeightLineAmaWithoutDynamicWhitelistStaysWhite();
  testFormatWeightLineStaleAmaWithoutDynamicWhitelistShowsOffline();
  testFormatWeightLineStaticOnly();
  testFormatWeightLineBuyHigherIsRed();
  testFormatWeightLineSellHigherIsRed();
  testFormatWeightLineLiveEqualBothGrey();
  testFormatWeightLineLiveStaleFallsBackToStatic();
  testFormatWeightLineMissingSnapshotHasNoAlert();
  testFormatWeightLineNullWeights();
  testAnalyzeOrderIncludesDynamicWeightForAma();
  testAnalyzeOrderOmitsDynamicWeightForNonAma();
  console.log('analyze-orders dynamic weight tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
