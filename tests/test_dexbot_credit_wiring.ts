'use strict';

const assert = require('assert');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running dexbot credit wiring test');

const bitsharesClientPath = path.resolve(__dirname, '../modules/bitshares_client.ts');
const chainOrdersPath = path.resolve(__dirname, '../modules/chain_orders.ts');
const maintenanceRuntimePath = path.resolve(__dirname, '../modules/dexbot_maintenance_runtime.ts');
const creditRuntimePath = path.resolve(__dirname, '../modules/credit_runtime.ts');
const dexbotClassPath = path.resolve(__dirname, '../modules/dexbot_class.ts');

function installStubs(calls) {
  const originalBitshares = setCachedModule(bitsharesClientPath, {
    BitShares: { db: { call: async () => [] }, subscribe() {} },
    waitForConnected: async () => {},
    createAccountClient: () => ({}),
    setSuppressConnectionLog() {},
    getNodeManager: () => null,
    getNodeStats: () => null,
    getNodeSummary: () => null,
    _internal: { connected: true },
  });

  const originalChainOrders = setCachedModule(chainOrdersPath, {
    listenForFills: async () => async () => {},
    readOpenOrders: async () => [],
    resolveAccountId: async () => '1.2.3',
    resolveAccountName: async () => 'alice',
    executeBatch: async () => ({ tx_id: 'noop' }),
  });

  const originalMaintenance = setCachedModule(maintenanceRuntimePath, {
    performPeriodicGridChecks: async function () {
      calls.push('grid-maintenance');
      return 'grid-ok';
    },
    setupBlockchainFetchInterval: () => {},
    stopBlockchainFetchInterval: () => {},
    executeMaintenanceLogic: async () => {},
    cancelDustOrders: async () => ({ cancelledCount: 0, batchResult: null }),
    clearDustMaintenanceTimer: () => {},
    scheduleDustMaintenanceCheck: () => {},
    seedDustTimersFromPartialUpdates: async () => {},
    runGridMaintenance: async () => {},
  });

  class FakeCreditRuntime {
    [key: string]: any;
    constructor(bot) {
      this.bot = bot;
      this.loadStateCalls = 0;
      this.runMaintenanceCalls = [];
      this.runCreditWatchdogCalls = 0;
    }

    async loadState() {
      this.loadStateCalls += 1;
    }

    async runMaintenance(context) {
      this.runMaintenanceCalls.push(context);
      calls.push(`credit-${context}`);
      return { context };
    }

    async runCreditWatchdog() {
      this.runCreditWatchdogCalls += 1;
      calls.push('credit-watchdog');
      return { mpa: null, credit: null };
    }
  }

  const originalCreditRuntime = setCachedModule(creditRuntimePath, FakeCreditRuntime);

  return () => {
    restoreCachedModule(bitsharesClientPath, originalBitshares);
    restoreCachedModule(chainOrdersPath, originalChainOrders);
    restoreCachedModule(maintenanceRuntimePath, originalMaintenance);
    restoreCachedModule(creditRuntimePath, originalCreditRuntime);
    delete require.cache[dexbotClassPath];
  };
}

async function main() {
  const calls = [];
  const restore = installStubs(calls);
  let bot;
  try {
    delete require.cache[dexbotClassPath];
    const DEXBot = require('../modules/dexbot_class').default;

    bot = new DEXBot({
      name: 'credit-bot',
      active: true,
      dryRun: false,
      preferredAccount: 'alice',
      assetA: 'BTS',
      assetB: 'HONEST.USD',
      startPrice: 'pool',
      minPrice: '3x',
      maxPrice: '3x',
      incrementPercent: 0.5,
      debtPolicy: {
        lending: [{
          asset: 'HONEST.USD',
          collateralAsset: 'BTS',
          type: 'mpa',
          maxBorrowAmount: 1000,
          maxCollateralAmount: 10000,
          minCollateralRatio: 2,
          maxCollateralRatio: 2.5,
        }],
      },
    }, { logPrefix: '[test]' });

    const runtime = bot._getCreditRuntime();
    assert(runtime, 'credit runtime should be created when supported debtPolicy.lending exists');

    await bot._setupCreditRuntime();
    assert.strictEqual(runtime.loadStateCalls, 1, 'startup wiring should load runtime state');

    await bot._runCreditRuntimeMaintenance('startup');
    assert.deepStrictEqual(runtime.runMaintenanceCalls, ['startup'], 'startup should run credit maintenance once');

    const result = await bot._performPeriodicGridChecks();
    assert.strictEqual(result, 'grid-ok', 'periodic maintenance should preserve grid result');
    assert.deepStrictEqual(calls, ['credit-startup', 'grid-maintenance'], 'periodic grid checks should not touch credit runtime');
    assert.deepStrictEqual(runtime.runMaintenanceCalls, ['startup'], 'credit runMaintenance should not be called from periodic grid checks');

    bot._setupCreditWatchdogInterval();
    assert.ok(bot._creditWatchdogInterval, 'credit watchdog interval should be created');
    assert.strictEqual(runtime.runCreditWatchdogCalls, 0, 'watchdog should not fire immediately');

    const legacyBot = new DEXBot({
      name: 'legacy-credit-bot',
      active: true,
      dryRun: false,
      preferredAccount: 'alice',
      assetA: 'BTS',
      assetB: 'HONEST.USD',
      startPrice: 'pool',
      minPrice: '3x',
      maxPrice: '3x',
      incrementPercent: 0.5,
      debtPolicy: { mpa: { targetCollateralRatio: 2 } },
    }, { logPrefix: '[test-legacy]' });
    assert.strictEqual(legacyBot._getCreditRuntime(), null, 'legacy flat debtPolicy should not create a no-op credit runtime');
  } finally {
    bot._stopCreditWatchdogInterval();
    restore();
  }

  console.log('dexbot credit wiring test passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
