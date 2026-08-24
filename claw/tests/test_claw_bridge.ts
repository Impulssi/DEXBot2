'use strict';

const assert = require('assert');

function clearModule(modulePath: string) {
  delete require.cache[modulePath];
}

function registerMock(modulePath: string, exports: any) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  } as any;
}

function createBridgeHarness() {
  const bridgePath = require.resolve('../modules/claw_bridge');
  const infraPath = require.resolve('../modules/claw_infra');
  const chainActionsPath = require.resolve('../modules/chain_actions');
  const memuBridgePath = require.resolve('../modules/memu_bridge');
  const shortStrategyPath = require.resolve('../modules/short_mpa_strategy');

  const calls = {
    createClawInfrastructure: [] as any[],
    chainActions: {
      adjustMpaCollateral: [] as any[],
      borrowMpa: [] as any[],
      buildUpdateLimitOrderOperation: [] as any[],
      cancelLimitOrder: [] as any[],
      createLimitOrder: [] as any[],
      executeBatch: [] as any[],
      getMpaPosition: [] as any[],
      getOpenOrders: [] as any[],
      repayMpaDebt: [] as any[],
      settleMpa: [] as any[],
      updateLimitOrder: [] as any[]
    },
    shortStrategy: {
      buildCloseShortPlan: [] as any[],
      buildOpenShortPlan: [] as any[],
      buildTakeProfitPlan: [] as any[],
      closeShortOnBts: [] as any[],
      openShortOnBts: [] as any[],
      placeTakeProfitBuyOrderOnBts: [] as any[]
    },
    profiles: {
      getBotSettings: [] as any[],
      previewBotSettingsUpdate: [] as any[],
      applyBotSettingsPatch: [] as any[]
    },
    memu: [] as any[]
  };

  const bridgeRuntime = {
    accountName: 'runtime-account',
    nested: { value: 1 },
    name: 'bridge-runtime'
  };

  registerMock(infraPath, {
    createClawInfrastructure: (options: any) => {
      calls.createClawInfrastructure.push(options);
      return {
        honest: {
          buildContext: async (options: any) => ({
            source: 'honest-context',
            options
          }),
          resolvePairContext: async (assetA: any, assetB: any, options: any) => ({
            assetA,
            assetB,
            options,
            source: 'honest-pair'
          }),
          resolvePairPrice: async (assetA: any, assetB: any, options: any) => ({
            assetA,
            assetB,
            options,
            source: 'honest-price'
          })
        },
        market: {
          readAccountSnapshot: async (accountName: any) => ({
            accountName,
            source: 'account-snapshot'
          }),
          readMarketSnapshot: async (baseSymbol: any, quoteSymbol: any, limit: any) => ({
            baseSymbol,
            limit,
            quoteSymbol,
            source: 'market-snapshot'
          })
        },
        profiles: {
          getClawProfileContext: async (ref: any, options: any) => ({
            options,
            ref,
            selectedBot: { botId: ref, source: 'profile-context' }
          }),
          getBotSettings: async (ref: any, forceReload: any) => {
            calls.profiles.getBotSettings.push({ forceReload, ref });
            return {
              forceReload,
              ref,
              source: 'bot-settings'
            };
          },
          previewBotSettingsUpdate: async (ref: any, patch: any, options: any) => {
            calls.profiles.previewBotSettingsUpdate.push({ options, patch, ref });
            return {
              options,
              patch,
              ref,
              source: 'bot-settings-preview'
            };
          },
          applyBotSettingsPatch: async (ref: any, patch: any, options: any) => {
            calls.profiles.applyBotSettingsPatch.push({ options, patch, ref });
            return {
              options,
              patch,
              ref,
              source: 'bot-settings-apply',
              updatedBot: { botKey: ref, ...patch }
            };
          }
        },
        runtime: {
          ...bridgeRuntime,
          ...(options.runtime || {}),
          name: options.runtime?.name || bridgeRuntime.name
        }
      };
    }
  });

  const stubbedChainAction = (name: string) => async (options: any) => {
    calls.chainActions[name as keyof typeof calls.chainActions].push(options);
    return {
      options,
      source: name
    };
  };

  registerMock(chainActionsPath, {
    adjustMpaCollateral: stubbedChainAction('adjustMpaCollateral'),
    borrowMpa: stubbedChainAction('borrowMpa'),
    buildUpdateLimitOrderOperation: async (options: any) => {
      calls.chainActions.buildUpdateLimitOrderOperation.push(options);
      return {
        op: {
          options,
          source: 'buildUpdateLimitOrderOperation'
        },
        source: 'buildUpdateLimitOrderOperation'
      };
    },
    cancelLimitOrder: stubbedChainAction('cancelLimitOrder'),
    createLimitOrder: stubbedChainAction('createLimitOrder'),
    executeBatch: stubbedChainAction('executeBatch'),
    getMpaPosition: async (accountNameOrId: any, mpaAsset: any) => {
      calls.chainActions.getMpaPosition.push({ accountNameOrId, mpaAsset });
      return {
        accountNameOrId,
        mpaAsset,
        source: 'mpa-position'
      };
    },
    getOpenOrders: async (accountNameOrId: any) => {
      calls.chainActions.getOpenOrders.push(accountNameOrId);
      return {
        accountNameOrId,
        source: 'open-orders'
      };
    },
    repayMpaDebt: stubbedChainAction('repayMpaDebt'),
    settleMpa: stubbedChainAction('settleMpa'),
    updateLimitOrder: stubbedChainAction('updateLimitOrder')
  });

  registerMock(shortStrategyPath, {
    buildCloseShortPlan: async (options: any) => {
      calls.shortStrategy.buildCloseShortPlan.push(options);
      return {
        options,
        source: 'buildCloseShortPlan'
      };
    },
    buildOpenShortPlan: async (options: any) => {
      calls.shortStrategy.buildOpenShortPlan.push(options);
      return {
        options,
        source: 'buildOpenShortPlan'
      };
    },
    buildTakeProfitPlan: async (options: any) => {
      calls.shortStrategy.buildTakeProfitPlan.push(options);
      return {
        options,
        source: 'buildTakeProfitPlan'
      };
    },
    closeShortOnBts: async (options: any) => {
      calls.shortStrategy.closeShortOnBts.push(options);
      return {
        options,
        source: 'closeShortOnBts'
      };
    },
    openShortOnBts: async (options: any) => {
      calls.shortStrategy.openShortOnBts.push(options);
      return {
        options,
        source: 'openShortOnBts'
      };
    },
    placeTakeProfitBuyOrderOnBts: async (options: any) => {
      calls.shortStrategy.placeTakeProfitBuyOrderOnBts.push(options);
      return {
        options,
        source: 'placeTakeProfitBuyOrderOnBts'
      };
    }
  });

  // Snapshot the real validator before the mock replaces the module: claw
  // bridge delegates memu-* argument validation to it.
  const realMemuBridge = require(memuBridgePath);
  registerMock(memuBridgePath, {
    describeMemuBridge: (options: any) => ({
      options,
      runtime: 'memu',
      source: 'describeMemuBridge'
    }),
    runMemuCommand: async (command: any, options: any) => {
      calls.memu.push({ command, options });
      return {
        command,
        options,
        source: 'memu'
      };
    },
    validateMemuCommandArgs: realMemuBridge.validateMemuCommandArgs
  });

  clearModule(bridgePath);
  const bridge = require('../modules/claw_bridge');

  return {
    bridge,
    calls,
    cleanup() {
      clearModule(bridgePath);
      clearModule(chainActionsPath);
      clearModule(infraPath);
      clearModule(memuBridgePath);
      clearModule(shortStrategyPath);
    }
  };
}

async function testCreateClawBridgeSanitizesPrivateKey() {
  console.log('  createClawBridge sanitizes options...');

  const { bridge, calls, cleanup } = createBridgeHarness();

  try {
    bridge.createClawBridge({
      privateKey: 'secret',
      runtimeName: 'openclaw'
    });

    assert.strictEqual(calls.createClawInfrastructure.length, 1);
    assert.strictEqual(calls.createClawInfrastructure[0].privateKey, undefined);
    assert.strictEqual(calls.createClawInfrastructure[0].runtime.name, 'openclaw');
    assert.strictEqual(calls.createClawInfrastructure[0].runtimeName, 'openclaw');
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

async function testRunClawCommandDispatchMatrix() {
  console.log('  runClawCommand dispatch matrix...');

  const { bridge, calls, cleanup } = createBridgeHarness();

  try {
    const manifest = await bridge.runClawCommand('manifest', {
      runtimeName: 'openclaw'
    });
    assert.strictEqual(manifest.compatibility.name, 'OpenClaw');
    assert.ok(Array.isArray(manifest.commands));

    const runtime = await bridge.runClawCommand('runtime', {});
    assert.strictEqual(runtime.name, 'claw-bridge');
    assert.strictEqual(runtime.nested.value, 1);
    runtime.nested.value = 99;
    assert.strictEqual(calls.createClawInfrastructure[0].runtime.name, 'claw-bridge');

    const profileContext = await bridge.runClawCommand('profile-context', {
      botId: 'bot-123',
      marker: 'profile'
    });
    assert.strictEqual(calls.createClawInfrastructure[1].runtime.name, 'claw-bridge');
    assert.strictEqual(profileContext.ref, 'bot-123');
    assert.strictEqual(profileContext.selectedBot.botId, 'bot-123');

    const marketSnapshot = await bridge.runClawCommand('market-snapshot', {
      limit: '12',
      pair: 'HONEST.USD / BTS'
    });
    assert.strictEqual(marketSnapshot.baseSymbol, 'HONEST.USD');
    assert.strictEqual(marketSnapshot.quoteSymbol, 'BTS');
    assert.strictEqual(marketSnapshot.limit, 12);

    const accountSnapshot = await bridge.runClawCommand('account-snapshot', {
      accountRef: 'alice'
    });
    assert.strictEqual(accountSnapshot.accountName, 'alice');

    const openOrders = await bridge.runClawCommand('open-orders', {});
    assert.strictEqual(openOrders.accountNameOrId, 'runtime-account');

    const botSettings = await bridge.runClawCommand('bot-settings', {
      botRef: 'alpha'
    });
    assert.strictEqual(botSettings.source, 'bot-settings');
    assert.strictEqual(botSettings.ref, 'alpha');
    assert.strictEqual(botSettings.forceReload, false);

    const botSettingsPreview = await bridge.runClawCommand('bot-settings-preview', {
      botRef: 'alpha',
      patch: { incrementPercent: 0.4, weightDistribution: { buy: 0.4 } }
    });
    assert.strictEqual(botSettingsPreview.source, 'bot-settings-preview');
    assert.strictEqual(botSettingsPreview.ref, 'alpha');
    assert.strictEqual(botSettingsPreview.patch.incrementPercent, 0.4);
    assert.strictEqual(botSettingsPreview.patch.weightDistribution.buy, 0.4);

    const botSettingsApply = await bridge.runClawCommand('bot-settings-apply', {
      botRef: 'alpha',
      patch: { incrementPercent: 0.3 }
    });
    assert.strictEqual(botSettingsApply.source, 'bot-settings-apply');
    assert.strictEqual(botSettingsApply.updatedBot.incrementPercent, 0.3);
    assert.strictEqual(calls.profiles.applyBotSettingsPatch.length, 1);

    const honestContext = await bridge.runClawCommand('honest-context', {
      batchSize: '8',
      discoverPairs: ['HONEST.USD/BTS']
    });
    assert.strictEqual(honestContext.options.batchSize, 8);
    assert.deepStrictEqual(honestContext.options.discoverPairs, ['HONEST.USD/BTS']);

    const honestPair = await bridge.runClawCommand('honest-pair', {
      pair: 'HONEST.USD / BTS'
    });
    assert.strictEqual(honestPair.assetA, 'HONEST.USD');
    assert.strictEqual(honestPair.assetB, 'BTS');

    const honestPrice = await bridge.runClawCommand('honest-price', {
      pair: 'HONEST.USD / BTS'
    });
    assert.strictEqual(honestPrice.assetA, 'HONEST.USD');
    assert.strictEqual(honestPrice.assetB, 'BTS');

    const createLimitOrder = await bridge.runClawCommand('create-limit-order', {
      amountToSell: 1,
      minToReceive: 2,
      receiveAsset: 'BTS',
      sellAsset: 'HONEST.USD'
    });
    assert.strictEqual(createLimitOrder.source, 'createLimitOrder');
    assert.strictEqual(calls.chainActions.createLimitOrder[0].accountName, 'runtime-account');

    const cancelLimitOrder = await bridge.runClawCommand('cancel-limit-order', {
      orderId: '1.7.77'
    });
    assert.strictEqual(cancelLimitOrder.source, 'cancelLimitOrder');
    assert.strictEqual(calls.chainActions.cancelLimitOrder[0].accountName, 'runtime-account');

    const buildUpdateLimitOrderOp = await bridge.runClawCommand('build-update-limit-order-op', {
      orderId: '1.7.77'
    });
    assert.strictEqual(buildUpdateLimitOrderOp.source, 'buildUpdateLimitOrderOperation');
    assert.strictEqual(calls.chainActions.buildUpdateLimitOrderOperation[0].accountName, 'runtime-account');

    const updateLimitOrder = await bridge.runClawCommand('update-limit-order', {
      orderId: '1.7.77'
    });
    assert.strictEqual(updateLimitOrder.source, 'updateLimitOrder');
    assert.strictEqual(calls.chainActions.updateLimitOrder[0].accountName, 'runtime-account');

    const executeBatch = await bridge.runClawCommand('execute-batch', {
      operations: [{ op_name: 'noop' }]
    });
    assert.strictEqual(executeBatch.source, 'executeBatch');
    assert.strictEqual(calls.chainActions.executeBatch[0].accountName, 'runtime-account');

    const borrowMpa = await bridge.runClawCommand('borrow-mpa', {
      collateralDelta: 5,
      debtDelta: 2,
      mpaAsset: 'HONEST.USD'
    });
    assert.strictEqual(borrowMpa.source, 'borrowMpa');
    assert.strictEqual(calls.chainActions.borrowMpa[0].accountName, 'runtime-account');

    const repayMpa = await bridge.runClawCommand('repay-mpa', {
      amountToRepay: 2,
      mpaAsset: 'HONEST.USD'
    });
    assert.strictEqual(repayMpa.source, 'repayMpaDebt');
    assert.strictEqual(calls.chainActions.repayMpaDebt[0].accountName, 'runtime-account');

    const adjustMpaCollateral = await bridge.runClawCommand('adjust-mpa-collateral', {
      collateralDelta: 3,
      mpaAsset: 'HONEST.USD'
    });
    assert.strictEqual(adjustMpaCollateral.source, 'adjustMpaCollateral');
    assert.strictEqual(calls.chainActions.adjustMpaCollateral[0].accountName, 'runtime-account');

    const settleMpa = await bridge.runClawCommand('settle-mpa', {
      amount: 4,
      mpaAsset: 'HONEST.USD'
    });
    assert.strictEqual(settleMpa.source, 'settleMpa');
    assert.strictEqual(calls.chainActions.settleMpa[0].accountName, 'runtime-account');

    const openShortBts = await bridge.runClawCommand('open-short-bts', {
      accountName: 'alice',
      debtAmount: 5
    });
    assert.strictEqual(openShortBts.source, 'openShortOnBts');
    assert.strictEqual(calls.shortStrategy.openShortOnBts[0].accountName, 'alice');

    const takeProfitBts = await bridge.runClawCommand('take-profit-bts', {
      accountName: 'alice',
      amountToCover: 5
    });
    assert.strictEqual(takeProfitBts.source, 'placeTakeProfitBuyOrderOnBts');
    assert.strictEqual(calls.shortStrategy.placeTakeProfitBuyOrderOnBts[0].accountName, 'alice');

    const closeShortBts = await bridge.runClawCommand('close-short-bts', {
      accountName: 'alice',
      amountToRepay: 5
    });
    assert.strictEqual(closeShortBts.source, 'closeShortOnBts');
    assert.strictEqual(calls.shortStrategy.closeShortOnBts[0].accountName, 'alice');

    const buildOpenShortPlan = await bridge.runClawCommand('build-open-short-plan', {
      accountName: 'alice',
      debtAmount: 5
    });
    assert.strictEqual(buildOpenShortPlan.source, 'buildOpenShortPlan');
    assert.strictEqual(calls.shortStrategy.buildOpenShortPlan[0].accountName, 'alice');

    const buildTakeProfitPlan = await bridge.runClawCommand('build-take-profit-plan', {
      accountName: 'alice',
      amountToCover: 5
    });
    assert.strictEqual(buildTakeProfitPlan.source, 'buildTakeProfitPlan');
    assert.strictEqual(calls.shortStrategy.buildTakeProfitPlan[0].accountName, 'alice');

    const buildCloseShortPlan = await bridge.runClawCommand('build-close-short-plan', {
      accountName: 'alice',
      amountToRepay: 5
    });
    assert.strictEqual(buildCloseShortPlan.source, 'buildCloseShortPlan');
    assert.strictEqual(calls.shortStrategy.buildCloseShortPlan[0].accountName, 'alice');

    const mpaPosition = await bridge.runClawCommand('mpa-position', {
      accountRef: 'alice',
      mpaAsset: 'HONEST.USD'
    });
    assert.strictEqual(mpaPosition.source, 'mpa-position');
    assert.strictEqual(calls.chainActions.getMpaPosition[0].accountNameOrId, 'alice');

    const memuCreateItem = await bridge.runClawCommand('memu-create-item', {
      categoryName: 'preferences',
      summary: 'Prefers 2% spacing'
    });
    assert.strictEqual(memuCreateItem.source, 'memu');
    assert.strictEqual(memuCreateItem.command, 'create-item');
    assert.strictEqual(calls.memu[0].options.categoryName, 'preferences');

    const memuClear = await bridge.runClawCommand('memu-clear', {
      where: { user_id: 'trader-123' }
    });
    assert.strictEqual(memuClear.command, 'clear');
    assert.deepStrictEqual(calls.memu[1].options.where, { user_id: 'trader-123' });

    const memuStatus = await bridge.runClawCommand('memu-status', {
      where: { user_id: 'trader-123' }
    });
    assert.strictEqual(memuStatus.command, 'status');
    assert.deepStrictEqual(calls.memu[2].options.where, { user_id: 'trader-123' });

    await assert.rejects(
      () => bridge.runClawCommand('memu-create-item', {
        summary: 'missing category'
      }),
      /create-item requires categoryId or categoryName, plus summary/
    );

    await assert.rejects(
      () => bridge.runClawCommand('unsupported-command', {}),
      /Unsupported Claw command: unsupported-command/
    );
    await assert.rejects(
      () => bridge.runClawCommand('dynamic-weight-policy', {}),
      /Unsupported Claw command: dynamic-weight-policy/
    );
    await assert.rejects(
      () => bridge.runClawCommand('dynamic-weight-preview', {
        botId: 'bot-123',
        patch: { weightDistribution: { buy: 0.4 } }
      }),
      /Unsupported Claw command: dynamic-weight-preview/
    );
    await assert.rejects(
      () => bridge.runClawCommand('dynamic-weight-apply', {
        botId: 'bot-123',
        patch: { weightDistribution: { buy: 0.4 } }
      }),
      /Unsupported Claw command: dynamic-weight-apply/
    );
  } finally {
    cleanup();
  }

  console.log('    PASS');
}

async function main() {
  await testCreateClawBridgeSanitizesPrivateKey();
  await testRunClawCommandDispatchMatrix();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
