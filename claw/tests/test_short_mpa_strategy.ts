'use strict';

const assert = require('assert');
const { runEsmMockStages, defineEsmMockAbs } = require('../../tests/helpers/esm_mocks');

// Compiled ESM graphs cannot be mocked via require.cache; the helper installs
// loader hooks (one child process per stage so fresh module instances load).
function clearModule(_modulePath: string) {
  /* no-op under ESM hooks */
}

function registerMock(modulePath: string, exports: any) {
  defineEsmMockAbs(modulePath, Object.keys(exports), exports);
}

function createStrategyHarness() {
  const strategyPath = require.resolve('../modules/short_mpa_strategy');
  const chainActionsPath = require.resolve('../modules/chain_actions');
  const chainQueriesPath = require.resolve('../modules/chain_queries');

  const calls = {
    borrowMpa: [] as any[],
    createLimitOrder: [] as any[],
    getAsset: [] as string[],
    getBackingAsset: [] as string[],
    repayMpaDebt: [] as any[]
  };

  registerMock(chainActionsPath, {
    borrowMpa: async (options: any) => {
      calls.borrowMpa.push(options);
      return {
        options,
        source: 'borrowMpa'
      };
    },
    createLimitOrder: async (options: any) => {
      calls.createLimitOrder.push(options);
      return {
        options,
        source: 'createLimitOrder'
      };
    },
    repayMpaDebt: async (options: any) => {
      calls.repayMpaDebt.push(options);
      return {
        options,
        source: 'repayMpaDebt'
      };
    }
  });

  registerMock(chainQueriesPath, {
    getAsset: async (symbolOrId: string) => {
      calls.getAsset.push(symbolOrId);
      return {
        bitasset_data_id: '2.4.100',
        id: '1.3.100',
        precision: 5,
        symbol: 'HONEST.USD'
      };
    },
    getBackingAsset: async (assetId: string) => {
      calls.getBackingAsset.push(assetId);
      return {
        id: '1.3.0',
        precision: 5,
        symbol: 'BTS'
      };
    }
  });

  clearModule(strategyPath);
  const strategy = require('../modules/short_mpa_strategy');

  return {
    calls,
    cleanup() {
      clearModule(strategyPath);
      clearModule(chainActionsPath);
      clearModule(chainQueriesPath);
    },
    strategy
  };
}

async function testBuildPlans() {
  console.log('  build plan helpers...');

  const { strategy, calls, cleanup } = createStrategyHarness();

  try {
    const openPlan = await strategy.buildOpenShortPlan({
      accountName: 'alice',
      collateralAmount: 250,
      debtAmount: 5,
      mpaAsset: 'HONEST.USD',
      sellPriceInBts: 2,
      targetCollateralRatio: 2.25
    });

    assert.strictEqual(openPlan.action, 'open-short');
    assert.strictEqual(openPlan.market, 'HONEST.USD/BTS');
    assert.strictEqual(openPlan.expectedBtsProceeds, 10);
    assert.strictEqual(openPlan.sellOrder.amountToSell, 5);
    assert.strictEqual(openPlan.sellOrder.minToReceive, 10);
    assert.strictEqual(openPlan.targetCollateralRatio, 2.25);
    assert.deepStrictEqual(calls.getAsset, ['HONEST.USD']);
    assert.deepStrictEqual(calls.getBackingAsset, ['1.3.100']);

    const takeProfitPlan = await strategy.buildTakeProfitPlan({
      amountToCover: 3,
      buyPriceInBts: 4,
      mpaAsset: 'HONEST.USD'
    });

    assert.strictEqual(takeProfitPlan.action, 'place-take-profit');
    assert.strictEqual(takeProfitPlan.market, 'HONEST.USD/BTS');
    assert.strictEqual(takeProfitPlan.maxBtsToSpend, 12);
    assert.strictEqual(takeProfitPlan.rebuyOrder.amountToSell, 12);
    assert.strictEqual(takeProfitPlan.rebuyOrder.minToReceive, 3);

    const closePlan = await strategy.buildCloseShortPlan({
      amountToRepay: 7,
      mpaAsset: 'HONEST.USD'
    });

    assert.strictEqual(closePlan.action, 'close-short');
    assert.strictEqual(closePlan.releaseCollateralDelta, 0);
    assert.strictEqual(closePlan.repayAmount, 7);

    await assert.rejects(
      strategy.buildOpenShortPlan({
        collateralAmount: 1,
        debtAmount: 1,
        mpaAsset: 'HONEST.USD',
        sellPriceInBts: 0
      }),
      /sellPriceInBts must be a positive number/
    );
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

async function testExecutionWrappersForwardPlanValues() {
  console.log('  execution wrappers forward plan values...');

  const { strategy, calls, cleanup } = createStrategyHarness();

  try {
    const openResult = await strategy.openShortOnBts({
      accountName: 'alice',
      collateralAmount: 250,
      debtAmount: 5,
      expiration: '2026-01-01T00:00:00',
      fillOrKill: true,
      mpaAsset: 'HONEST.USD',
      privateKey: 'secret',
      sellPriceInBts: 2,
      targetCollateralRatio: 2.5
    });

    assert.strictEqual(openResult.borrowResult.source, 'borrowMpa');
    assert.strictEqual(openResult.sellOrderResult.source, 'createLimitOrder');
    assert.strictEqual(openResult.plan.action, 'open-short');
    assert.strictEqual(calls.borrowMpa[0].accountName, 'alice');
    assert.strictEqual(calls.borrowMpa[0].privateKey, 'secret');
    assert.strictEqual(calls.borrowMpa[0].collateralDelta, openResult.plan.collateralAmount);
    assert.strictEqual(calls.borrowMpa[0].debtDelta, openResult.plan.debtAmount);
    assert.strictEqual(calls.borrowMpa[0].targetCollateralRatio, 2.5);
    assert.strictEqual(calls.createLimitOrder[0].amountToSell, openResult.plan.sellOrder.amountToSell);
    assert.strictEqual(calls.createLimitOrder[0].minToReceive, openResult.plan.sellOrder.minToReceive);
    assert.strictEqual(calls.createLimitOrder[0].expiration, '2026-01-01T00:00:00');
    assert.strictEqual(calls.createLimitOrder[0].fillOrKill, true);
    assert.strictEqual(calls.createLimitOrder[0].receiveAsset, openResult.plan.sellOrder.receiveAsset);
    assert.strictEqual(calls.createLimitOrder[0].sellAsset, openResult.plan.sellOrder.sellAsset);

    const takeProfitResult = await strategy.placeTakeProfitBuyOrderOnBts({
      accountName: 'alice',
      amountToCover: 3,
      buyPriceInBts: 4,
      expiration: '2026-02-01T00:00:00',
      fillOrKill: false,
      mpaAsset: 'HONEST.USD'
    });

    assert.strictEqual(takeProfitResult.rebuyOrderResult.source, 'createLimitOrder');
    assert.strictEqual(takeProfitResult.plan.action, 'place-take-profit');
    assert.strictEqual(calls.createLimitOrder[1].amountToSell, takeProfitResult.plan.rebuyOrder.amountToSell);
    assert.strictEqual(calls.createLimitOrder[1].minToReceive, takeProfitResult.plan.rebuyOrder.minToReceive);
    assert.strictEqual(calls.createLimitOrder[1].receiveAsset, takeProfitResult.plan.rebuyOrder.receiveAsset);
    assert.strictEqual(calls.createLimitOrder[1].sellAsset, takeProfitResult.plan.rebuyOrder.sellAsset);

    const closeResult = await strategy.closeShortOnBts({
      accountName: 'alice',
      amountToRepay: 7,
      expiration: '2026-03-01T00:00:00',
      mpaAsset: 'HONEST.USD',
      releaseCollateralDelta: 2,
      targetCollateralRatio: 1.8
    });

    assert.strictEqual(closeResult.repayResult.source, 'repayMpaDebt');
    assert.strictEqual(closeResult.plan.action, 'close-short');
    assert.strictEqual(calls.repayMpaDebt[0].accountName, 'alice');
    assert.strictEqual(calls.repayMpaDebt[0].amountToRepay, closeResult.plan.repayAmount);
    assert.strictEqual(calls.repayMpaDebt[0].collateralDelta, -closeResult.plan.releaseCollateralDelta);
    assert.strictEqual(calls.repayMpaDebt[0].targetCollateralRatio, 1.8);
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

runEsmMockStages(
  ['build-plans', 'execution-wrappers-forward-plan-values'],
  async (stage: string) => {
    if (stage === 'build-plans') {
      await testBuildPlans();
      return;
    }
    if (stage === 'execution-wrappers-forward-plan-values') {
      await testExecutionWrappersForwardPlanValues();
      return;
    }
    throw new Error(`Unknown stage: ${stage}`);
  }
);
