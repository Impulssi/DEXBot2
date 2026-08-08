const assert = require('assert');
const Module = require('module');
const path = require('path');
const { setCachedModule, restoreCachedModule } = require('../../tests/helpers/module_cache_stub');

function clearModule(modulePath) {
  delete require.cache[modulePath];
}

async function testClawBitsharesClientNativePathAndConnection() {
  const clawBitsharesPath = require.resolve('../modules/bitshares_client');

  try {
    clearModule(clawBitsharesPath);
    const clawBitshares = require('../modules/bitshares_client');

    assert.strictEqual(clawBitshares.isConnected(), false, 'initial state should not be connected');
    assert.strictEqual(typeof clawBitshares.BitShares, 'object', 'BitShares proxy should exist');
    assert.strictEqual(typeof clawBitshares.createAccountClient, 'function');
    await assert.rejects(() => clawBitshares.createAccountClient('', 'wif'), /accountName is required/);
    await assert.rejects(() => clawBitshares.createAccountClient('alice', ''), /privateKey is required/);
  } finally {
    clearModule(clawBitsharesPath);
  }
}

async function testClawBitsharesClientWaitForConnectedTriggersNativeConnect() {
  const clawBitsharesPath = require.resolve('../modules/bitshares_client');
  const nativePath = require.resolve('../../modules/bitshares-native');
  let connectCalls = 0;
  let nodes = [];
  let connected = false;

  const originalNativeEntry = setCachedModule(nativePath, {
    createChainClient: ({ onStatusChange }) => ({
      connect: async () => {
        connectCalls += 1;
        connected = true;
        if (typeof onStatusChange === 'function') onStatusChange('connected');
      },
      disconnect: () => {
        connected = false;
        if (typeof onStatusChange === 'function') onStatusChange('closed');
      },
      getStatus: () => connected ? 'connected' : 'closed',
      setNodes: (nextNodes) => { nodes = Array.isArray(nextNodes) ? nextNodes.slice() : []; },
      getNodes: () => nodes.slice(),
      getCoreAsset: () => '1.3.0',
      db: {},
      history: {},
    }),
    createSigningClient: () => ({ client: { initPromise: Promise.resolve(), newTx() {} } }),
  } as any);

  try {
    clearModule(clawBitsharesPath);
    const clawBitshares = require('../modules/bitshares_client');

    await clawBitshares.waitForConnected(200);

    assert.strictEqual(connectCalls, 1, 'waitForConnected should initiate a native connect when idle');
    assert.strictEqual(clawBitshares.isConnected(), true, 'client should report connected after lazy connect');
    assert.ok(Array.isArray(clawBitshares.BitShares.node) && clawBitshares.BitShares.node.length > 0, 'default node list should be populated');
  } finally {
    clearModule(clawBitsharesPath);
    restoreCachedModule(nativePath, originalNativeEntry);
  }
}

function testClawRootExportsAvoidSilentCollisions() {
  const clawIndexPath = require.resolve('..');
  clearModule(clawIndexPath);

  const claw = require('..').default;
  const hermesManifest = claw.describeClawBridge({ runtimeName: 'hermes' });
  const openclawManifest = claw.describeClawBridge({ runtimeName: 'openclaw' });
  const openfangManifest = claw.describeClawBridge({ runtimeName: 'openfang' });
  const nullManifest = claw.describeClawBridge({ runtimeName: 'nullclaw' });
  const manifest = claw.describeClawBridge({ runtimeName: 'zeroclaw' });

  assert.strictEqual(typeof claw.resolveSigningAccountName, 'function');
  assert.strictEqual(claw.resolveSigningAccountName({ accountName: 'alice' }), 'alice');
  assert.strictEqual(typeof claw.resolveAccountName, 'function');
  assert.strictEqual(claw.resolveAccountName('alice') instanceof Promise, true);
  assert.strictEqual(hermesManifest.options.runtimeName, 'hermes');
  assert.strictEqual(hermesManifest.compatibility.name, 'Hermes');
  assert.strictEqual(openclawManifest.options.runtimeName, 'openclaw');
  assert.strictEqual(openclawManifest.compatibility.name, 'OpenClaw');
  assert.strictEqual(openclawManifest.commandExamples.some((example) => example.includes('scripts/claw_bridge.ts')), true);
  assert.strictEqual(openfangManifest.options.runtimeName, 'openfang');
  assert.strictEqual(openfangManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);
  assert.strictEqual(nullManifest.options.runtimeName, 'nullclaw');
  assert.strictEqual(nullManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);
  assert.strictEqual(manifest.options.runtimeName, 'zeroclaw');
  assert.strictEqual(manifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);
}

function testClawCommandInjectsRuntimeNameViaOption() {
  const clawBridgePath = require.resolve('../modules/claw_bridge');
  const clawInfraPath = require.resolve('../modules/claw_infra');

  let capturedOptions = null;
  const originalClawInfra = setCachedModule(clawInfraPath, {
    createClawInfrastructure: (opts) => {
      capturedOptions = opts;
      return {
        runtime: { name: opts.runtime?.name || 'claw-bridge', accountName: null },
        profiles: {},
        market: {}
      };
    }
  } as any);

  clearModule(clawBridgePath);
  const { runClawCommand } = require('../modules/claw_bridge');

  runClawCommand('runtime', { runtimeName: 'openfang' });
  assert.strictEqual(capturedOptions.runtime.name, 'openfang', 'runtimeName option should propagate to runtime.name');

  clearModule(clawBridgePath);
  restoreCachedModule(clawInfraPath, originalClawInfra);
}

function testRuntimeSkillTomlQuotesPayloadPlaceholders() {
  const { buildRuntimeSkillToml } = require('../modules/claw_skill_md');

  const toml = buildRuntimeSkillToml(
    { runtime: 'zeroclaw', displayName: 'ZeroClaw' },
    '/tmp/repo root',
    '/tmp/profile root'
  );

  assert(
    toml.includes("'--payload' '{{payload_json}}'"),
    'generated skill commands must shell-quote payload placeholders'
  );
  assert(
    toml.includes("'--profile-root' '/tmp/profile root'"),
    'generated skill commands must shell-quote profile roots with spaces'
  );
}

function testLiquidityPoolWrapperInjectsSharedBitSharesClient() {
  const bitsharesPath = require.resolve('../modules/bitshares_client');
  const dexbotBridgePath = require.resolve('../modules/dexbot_bridge');
  const liquidityPoolsPath = require.resolve('../modules/liquidity_pools');
  const sharedBitShares = { name: 'shared-bitshares-client' };
  let capturedPoolArgs = null;
  let capturedPriceArgs = null;

  const originalBitshares = setCachedModule(bitsharesPath, { BitShares: sharedBitShares } as any);
  const originalDexbotBridge = setCachedModule(dexbotBridgePath, {
    getDexbot2Root: () => '/tmp',
    loadDexbotOrderSystemUtils: () => ({
      cloneMap: (value) => value,
      deepFreeze: (value) => value,
      derivePoolPrice: (...args) => {
        capturedPoolArgs = args;
        return 'pool-price';
      },
      derivePrice: (...args) => {
        capturedPriceArgs = args;
        return 'derived-price';
      },
      loadAmaCenterPrice: () => null,
      lookupAsset: () => null
    }),
    requireDexbot2Module: () => null
  } as any);
  clearModule(liquidityPoolsPath);

  const liquidityPools = require('../modules/liquidity_pools');

  assert.strictEqual(liquidityPools.derivePoolPrice('HONEST.USD', 'BTS'), 'pool-price');
  assert.deepStrictEqual(
    capturedPoolArgs,
    [sharedBitShares, 'HONEST.USD', 'BTS'],
    'derivePoolPrice wrapper must inject the shared BitShares client'
  );

  assert.strictEqual(liquidityPools.derivePrice('HONEST.USD', 'BTS', 'pool'), 'derived-price');
  assert.deepStrictEqual(
    capturedPriceArgs,
    [sharedBitShares, 'HONEST.USD', 'BTS', 'pool'],
    'derivePrice wrapper must inject the shared BitShares client'
  );

  clearModule(liquidityPoolsPath);
  restoreCachedModule(dexbotBridgePath, originalDexbotBridge);
  restoreCachedModule(bitsharesPath, originalBitshares);
}

async function testDecisionLoopReusesAnalyzerStateForDuplicateMarkets() {
  const decisionLoopPath = require.resolve('../modules/decision_loop');
  const discoveryPath = require.resolve('../modules/position_discovery');
  const healthPath = require.resolve('../modules/position_health');
  const feedPriceSourcePath = require.resolve('../modules/feed_price_source');
  const trendAnalyzerPath = require.resolve('../../analysis/trend_detection/kalman_trend_analyzer');
  let trendFetchCount = 0;

  class FakeTrendAnalyzer {
    [key: string]: any;
    update(marketPrice, feedPrice) {
      this.analysis = {
        confidence: 77,
        isReady: true,
        marketPrice,
        premium: {
          percent: ((marketPrice - feedPrice) / feedPrice) * 100
        },
        trend: 'DOWN'
      };
      return this.analysis;
    }

    getAnalysis() {
      return this.analysis || {
        confidence: 0,
        isReady: false,
        premium: {
          percent: null
        },
        trend: 'NEUTRAL'
      };
    }
  }

  const originalDiscovery = setCachedModule(discoveryPath, {
    discoverPositions: async () => ([
      { id: 'pos-1', market: 'HONEST.USD/BTS', mpaSymbol: 'HONEST.USD', onChain: { debtAmount: 5 } },
      { id: 'pos-2', market: 'HONEST.USD/BTS', mpaSymbol: 'HONEST.USD', onChain: { debtAmount: 3 } }
    ])
  } as any);
  const originalHealth = setCachedModule(healthPath, {
    assessPosition: (position, trendSignal) => ({
      actions: [],
      positionId: position.id,
      trend: trendSignal
    })
  } as any);
  const originalFeedPriceSource = setCachedModule(feedPriceSourcePath, {
    fetchTrendInput: async () => {
      trendFetchCount += 1;
      return {
        feedPrice: 100,
        marketPrice: 95,
        premium: -5
      };
    }
  } as any);
  const originalTrendAnalyzer = setCachedModule(trendAnalyzerPath, { KalmanTrendAnalyzer: FakeTrendAnalyzer } as any);
  clearModule(decisionLoopPath);

  const { evaluate, resetAnalyzers } = require('../modules/decision_loop');
  const result = await evaluate('alice');

  assert.strictEqual(trendFetchCount, 1, 'trend input should be fetched once per market');
  assert.strictEqual(result.positionCount, 2, 'both positions should be evaluated');
  assert.strictEqual(result.positions[0].trend.trend, 'DOWN');
  assert.strictEqual(result.positions[1].trend.trend, 'DOWN');
  assert.strictEqual(result.positions[1].trend.premium, -5, 'reused trend signal should come from cached analyzer state');

  resetAnalyzers();
  clearModule(decisionLoopPath);
  restoreCachedModule(trendAnalyzerPath, originalTrendAnalyzer);
  restoreCachedModule(feedPriceSourcePath, originalFeedPriceSource);
  restoreCachedModule(healthPath, originalHealth);
  restoreCachedModule(discoveryPath, originalDiscovery);
}

async function testDecisionLoopReplacesAnalyzerOnConfigChange() {
  const decisionLoopPath = require.resolve('../modules/decision_loop');
  const discoveryPath = require.resolve('../modules/position_discovery');
  const healthPath = require.resolve('../modules/position_health');
  const feedPriceSourcePath = require.resolve('../modules/feed_price_source');
  const trendAnalyzerPath = require.resolve('../../analysis/trend_detection/kalman_trend_analyzer');
  let constructionCount = 0;

  class ConfigTrackingAnalyzer {
    [key: string]: any;
    constructor(config) {
      constructionCount += 1;
      this.config = config;
    }

    update(marketPrice, feedPrice) {
      return { confidence: 50, isReady: true, trend: 'NEUTRAL' };
    }

    getAnalysis() {
      return { confidence: 50, isReady: true, premium: { percent: 0 }, trend: 'NEUTRAL' };
    }
  }

  const originalDiscovery = setCachedModule(discoveryPath, {
    discoverPositions: async () => ([
      { id: 'pos-1', market: 'HONEST.USD/BTS', mpaSymbol: 'HONEST.USD', onChain: { debtAmount: 5 } }
    ])
  } as any);
  const originalHealth = setCachedModule(healthPath, {
    assessPosition: (position, trendSignal) => ({ actions: [], positionId: position.id, trend: trendSignal })
  } as any);
  const originalFeedPriceSource = setCachedModule(feedPriceSourcePath, {
    fetchTrendInput: async () => ({ feedPrice: 100, marketPrice: 95, premium: -5 })
  } as any);
  const originalTrendAnalyzer = setCachedModule(trendAnalyzerPath, { KalmanTrendAnalyzer: ConfigTrackingAnalyzer } as any);
  clearModule(decisionLoopPath);

  const { evaluate, resetAnalyzers } = require('../modules/decision_loop');

  await evaluate('alice', { analyzerConfig: { kamaPeriod: 10 } });
  assert.strictEqual(constructionCount, 1, 'first evaluate should create one analyzer');

  await evaluate('alice', { analyzerConfig: { kamaPeriod: 10 } });
  assert.strictEqual(constructionCount, 1, 'same config should reuse the cached analyzer');

  await evaluate('alice', { analyzerConfig: { kamaPeriod: 20 } });
  assert.strictEqual(constructionCount, 2, 'changed config should replace the analyzer');

  resetAnalyzers();
  clearModule(decisionLoopPath);
  restoreCachedModule(trendAnalyzerPath, originalTrendAnalyzer);
  restoreCachedModule(feedPriceSourcePath, originalFeedPriceSource);
  restoreCachedModule(healthPath, originalHealth);
  restoreCachedModule(discoveryPath, originalDiscovery);
}

async function testPositionManagerEntryExposesSellPriceInBts() {
  const positionManagerPath = require.resolve('../modules/position_manager');
  const mpaUtilsPath = require.resolve('../modules/mpa_utils');

  const originalMpaUtils = setCachedModule(mpaUtilsPath, {
    requireBtsBackedMpa: async (sym) => ({
      backingAsset: { id: '1.3.0', symbol: 'BTS', precision: 5 },
      mpaAsset: { id: `1.3.${sym.length}`, symbol: sym, precision: 5, bitasset_data_id: '2.4.1' }
    })
  } as any);

  clearModule(positionManagerPath);
  const { PositionManager } = require('../modules/position_manager');

  const savedState: any = {};
  const pm = new PositionManager({
    loadState: async () => savedState.data || { positions: [] },
    saveState: async (state) => { savedState.data = state; }
  });

  const position = await pm.createShortPosition({
    accountName: 'alice',
    mpaAsset: 'HONEST.USD',
    debtAmount: 10,
    collateralAmount: 25000,
    sellPriceInBts: 1000
  });

  assert.strictEqual(position.entry.sellPriceInBts, 1000, 'entry must expose sellPriceInBts for openShort');
  assert.strictEqual(position.entry.priceInBts, 1000, 'entry must also have generic priceInBts from createOrderTracking');

  clearModule(positionManagerPath);
  restoreCachedModule(mpaUtilsPath, originalMpaUtils);
}

function testClawBridgeRespectsRuntimeNameOption() {
  const clawBridgePath = require.resolve('../modules/claw_bridge');
  const clawInfraPath = require.resolve('../modules/claw_infra');

  let capturedOptions = null;
  const originalClawInfra = setCachedModule(clawInfraPath, {
    createClawInfrastructure: (opts) => {
      capturedOptions = opts;
      return {
        runtime: { name: opts.runtime?.name || 'claw-bridge' },
        profiles: {},
        market: {}
      };
    }
  } as any);

  clearModule(clawBridgePath);
  const { createClawBridge } = require('../modules/claw_bridge');

  createClawBridge({ runtimeName: 'openclaw' });
  assert.strictEqual(capturedOptions.runtime.name, 'openclaw', 'runtimeName option should propagate to runtime.name');

  createClawBridge({ runtime: { name: 'picoclaw' } });
  assert.strictEqual(capturedOptions.runtime.name, 'picoclaw', 'runtime.name should still work directly');

  createClawBridge({});
  assert.strictEqual(capturedOptions.runtime.name, 'claw-bridge', 'should fall back to claw-bridge');

  clearModule(clawBridgePath);
  restoreCachedModule(clawInfraPath, originalClawInfra);
}

function testClawBridgeScriptManifestUsesRuntimeSpecificDescriptors() {
  const scriptPath = require.resolve('../scripts/claw_bridge');
  clearModule(scriptPath);

  const { describeRuntimeManifest } = require('../scripts/claw_bridge');

  const hermesManifest = describeRuntimeManifest('hermes', {});
  assert.strictEqual(hermesManifest.compatibility.name, 'Hermes');
  assert.strictEqual(hermesManifest.commandExamples.some((example) => example.includes('scripts/claw_bridge.ts')), true);

  const openclawManifest = describeRuntimeManifest('openclaw', {});
  assert.strictEqual(openclawManifest.compatibility.name, 'OpenClaw');
  assert.strictEqual(openclawManifest.commandExamples.some((example) => example.includes('scripts/claw_bridge.ts')), true);

  const openfangManifest = describeRuntimeManifest('openfang', {});
  assert.strictEqual(openfangManifest.compatibility.name, 'OpenFang');
  assert.strictEqual(openfangManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);

  const nanoclawManifest = describeRuntimeManifest('nanoclaw', {});
  assert.strictEqual(nanoclawManifest.compatibility.name, 'NanoClaw');
  assert.strictEqual(nanoclawManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);

  const nullclawManifest = describeRuntimeManifest('nullclaw', {});
  assert.strictEqual(nullclawManifest.compatibility.name, 'NullClaw');
  assert.strictEqual(nullclawManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);

  const zeroclawManifest = describeRuntimeManifest('zeroclaw', {});
  assert.strictEqual(zeroclawManifest.compatibility.name, 'ZeroClaw');
  assert.strictEqual(zeroclawManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);

  const genericManifest = describeRuntimeManifest(null, {});
  assert.strictEqual(genericManifest.compatibility.name, 'Claw');
  assert.strictEqual(genericManifest.commandExamples.some((example) => example.includes('scripts/claw_bridge.ts')), true);

  const payloadSelectedManifest = describeRuntimeManifest(null, { runtimeName: 'openfang' });
  assert.strictEqual(payloadSelectedManifest.compatibility.name, 'OpenFang');
  assert.strictEqual(payloadSelectedManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);

  const normalizedPayloadManifest = describeRuntimeManifest(null, { runtimeName: ' OpenFang ' });
  assert.strictEqual(normalizedPayloadManifest.compatibility.name, 'OpenFang');
  assert.strictEqual(normalizedPayloadManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);

  const hermesPayloadManifest = describeRuntimeManifest(null, { runtimeName: ' Hermes ' });
  assert.strictEqual(hermesPayloadManifest.compatibility.name, 'Hermes');
  assert.strictEqual(hermesPayloadManifest.commandExamples.some((example) => example.includes('scripts/claw_bridge.ts')), true);

  clearModule(scriptPath);
}

async function testRuntimeCommandManifestUsesRuntimeSpecificDescriptors() {
  const { runClawCommand } = require('../modules/claw_bridge');

  const hermesManifest = await runClawCommand('manifest', { runtimeName: 'hermes' });
  assert.strictEqual(hermesManifest.compatibility.name, 'Hermes');
  assert.strictEqual(hermesManifest.options.runtimeName, 'hermes');
  assert.ok(hermesManifest.compatibility.trustModel.includes('Hermes'));

  const openfangManifest = await runClawCommand('manifest', { runtimeName: 'openfang' });
  assert.strictEqual(openfangManifest.compatibility.name, 'OpenFang');
  assert.strictEqual(openfangManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);

  const nanoclawManifest = await runClawCommand('manifest', { runtimeName: 'nanoclaw' });
  assert.strictEqual(nanoclawManifest.compatibility.name, 'NanoClaw');
  assert.strictEqual(nanoclawManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);

  const nullclawManifest = await runClawCommand('manifest', { runtimeName: 'nullclaw' });
  assert.strictEqual(nullclawManifest.compatibility.name, 'NullClaw');
  assert.strictEqual(nullclawManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);

  const zeroclawManifest = await runClawCommand('manifest', { runtimeName: 'zeroclaw' });
  assert.strictEqual(zeroclawManifest.compatibility.name, 'ZeroClaw');
  assert.strictEqual(zeroclawManifest.commandExamples.some((example) => example.includes('claw_bridge.ts')), true);
}

function testAccountOrdersBotKeyFallsBackToAssetIds() {
  const { createBotKey } = require('../../modules/account_orders');

  const idOnlyBot = { assetAId: '1.3.1', assetBId: '1.3.0' };
  const key = createBotKey(idOnlyBot, 0);
  assert.ok(key.includes('1-3-1'), `account_orders botKey should derive from assetAId, got: ${key}`);
  assert.ok(key.includes('1-3-0'), `account_orders botKey should include assetBId, got: ${key}`);

  // Symbol fields still take precedence
  const symBot = { assetA: 'IOB.XRP', assetB: 'BTS', assetAId: '1.3.1', assetBId: '1.3.0' };
  const symKey = createBotKey(symBot, 0);
  assert.ok(symKey.includes('iob'), `symbol-based key should take precedence, got: ${symKey}`);
  assert.ok(!symKey.includes('1-3-1'), `symbol key should not include asset ID, got: ${symKey}`);

  // Aligns with claw's createBotKey
  const clawProfiles = require('../modules/dexbot_profiles');
  const clawKey = clawProfiles.createBotKey(idOnlyBot, 0);
  assert.strictEqual(key, clawKey, `account_orders and claw botKey must match for same input, got: ${key} vs ${clawKey}`);
}



function testBuildQueryScopesAnyPoolByReceivedAsset() {
  const { buildDirectionalDocumentQuery } = require('../../market_adapter/core/kibana_candles');
  const fieldMap = {
    soldAssetField: 'operation_history.op_object.amount_to_sell.asset_id.keyword',
    receivedAssetField: 'operation_history.op_object.min_to_receive.asset_id.keyword',
    poolField: 'operation_history.op_object.pool.keyword'
  };

  // With poolId: no received asset filter needed
  const poolScoped = buildDirectionalDocumentQuery({
    opType: 63,
    ...fieldMap,
    soldAssetId: '1.3.0',
    receivedAssetId: null,
    lookbackHours: 100,
    poolId: '1.19.133',
    size: 10000
  });
  const poolFilters = poolScoped.query.bool.filter;
  assert.ok(
    poolFilters.some((f) => f.term?.['operation_history.op_object.pool.keyword'] === '1.19.133'),
    'pool-scoped query should filter by pool'
  );
  assert.ok(
    !poolFilters.some((f) => f.term?.['operation_history.op_object.min_to_receive.asset_id.keyword']),
    'pool-scoped query should not add receivedAssetId filter'
  );

  // Without poolId but with receivedAssetId: must scope by counterpart
  const pairScoped = buildDirectionalDocumentQuery({
    opType: 63,
    ...fieldMap,
    soldAssetId: '1.3.0',
    receivedAssetId: '1.3.1',
    lookbackHours: 100,
    poolId: null,
    size: 10000
  });
  const pairFilters = pairScoped.query.bool.filter;
  assert.ok(
    !pairFilters.some((f) => f.term?.['operation_history.op_object.pool.keyword']),
    'any-pool query should not have pool filter'
  );
  assert.ok(
    pairFilters.some((f) => f.term?.['operation_history.op_object.min_to_receive.asset_id.keyword'] === '1.3.1'),
    'any-pool query should filter by received asset ID'
  );
}

function testClawDefaultDataPathsStayInsideClawFolder() {
  const clawDataDir = path.join(__dirname, '..', 'data');
  const clawStateDir = path.join(clawDataDir, 'state');
  const clawInfra = require('../modules/claw_infra');
  const { DEFAULT_STATE_PATH } = require('../modules/position_manager');
  const { DEFAULT_HEALTH_PATH } = require('../modules/position_manager_watch');

  assert.strictEqual(DEFAULT_STATE_PATH, path.join(clawDataDir, 'positions.json'));
  assert.strictEqual(DEFAULT_HEALTH_PATH, path.join(clawDataDir, 'watcher-health.json'));

  const runtime = clawInfra.createRuntimeContext();
  assert.strictEqual(runtime.dataDir, clawDataDir);
  assert.strictEqual(runtime.stateDir, clawStateDir);

  const stateStore = clawInfra.createStateStore();
  assert.strictEqual(stateStore.filePath, path.join(clawStateDir, 'claw-state.json'));
}

async function main() {
  await testClawBitsharesClientNativePathAndConnection();
  await testClawBitsharesClientWaitForConnectedTriggersNativeConnect();
  testClawRootExportsAvoidSilentCollisions();
  testRuntimeSkillTomlQuotesPayloadPlaceholders();
  testLiquidityPoolWrapperInjectsSharedBitSharesClient();
  await testDecisionLoopReusesAnalyzerStateForDuplicateMarkets();
  await testDecisionLoopReplacesAnalyzerOnConfigChange();
  await testPositionManagerEntryExposesSellPriceInBts();
  testClawBridgeRespectsRuntimeNameOption();
  testClawBridgeScriptManifestUsesRuntimeSpecificDescriptors();
  await testRuntimeCommandManifestUsesRuntimeSpecificDescriptors();
  testClawCommandInjectsRuntimeNameViaOption();
  testAccountOrdersBotKeyFallsBackToAssetIds();
  testBuildQueryScopesAnyPoolByReceivedAsset();
  testClawDefaultDataPathsStayInsideClawFolder();
  console.log('claw regression tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
