const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AccountOrders, createBotKey } = require('../modules/account_orders');
const { OrderManager, utils } = require('../modules/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function main() {
  const botConfig = { name: 'My Bot', assetA: 'ASSET.A', assetB: 'ASSET.B', active: true, botIndex: 0 };
  const botKey = createBotKey(botConfig, 0);
  const db = new AccountOrders({ botKey });

  await db.syncMeta(botConfig);

  const orders = [
    { id: '1', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL, size: 1, orderId: '' },
    { id: '2', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 2, orderId: '1.7.1' },
    { id: '3', type: ORDER_TYPES.BUY, state: ORDER_STATES.VIRTUAL, size: 5, orderId: '' },
    { id: '4', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 3, orderId: '1.7.2' },
    { id: '5', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.VIRTUAL, size: 10, orderId: '' }
  ];

  await db.storeMasterGrid(orders);

  const res = db.getAssetBalances();
  assert(res, 'Expected non-null result');
  assert.strictEqual(res.assetA.virtual, 1, 'SELL virtual should be 1');
  assert.strictEqual(res.assetA.active, 2, 'SELL active should be 2');
  assert.strictEqual(res.assetB.virtual, 5, 'BUY virtual should be 5');
  assert.strictEqual(res.assetB.active, 3, 'BUY active should be 3');
  assert.strictEqual(res.meta.name, 'My Bot');

  const debugBotKey = createBotKey({ name: 'Debug Bot' }, 0);
  const tempOrdersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot2-indexdb-'));
  try {
    const debugDb = new AccountOrders({
      botKey: debugBotKey,
      profilesPath: path.join(tempOrdersDir, `${debugBotKey}.json`)
    });
    const manager = new OrderManager({
      name: 'Debug Bot',
      botKey: debugBotKey,
      assetA: 'ASSET.A',
      assetB: 'ASSET.B',
      privateKey: 'should-not-persist',
      botHmacSecret: 'should-not-persist'
    });
    manager.accountOrders = debugDb;
    manager.assets = {
      assetA: { symbol: 'ASSET.A', precision: 5 },
      assetB: { symbol: 'ASSET.B', precision: 5 }
    };
    manager.accountTotals = { buy: 10, sell: 20, buyFree: 8, sellFree: 18 };
    manager._lastGridPricingContext = {
      gridPrice: 1.1,
      configuredMinPrice: '2x',
      configuredMaxPrice: '2x',
      rangeScalingFactor: 0.1
    };
    manager.funds.btsFeesOwed = 0.01;

    await utils.persistGridSnapshot(manager, debugDb);

    const debugEntry = debugDb._loadData();
    assert(debugEntry.debugInputs, 'Expected debug input snapshot to persist');
    assert.strictEqual(debugEntry.debugInputs.config.assetA, 'ASSET.A');
    assert.strictEqual(debugEntry.debugInputs.config.gridPrice, 1.1);
    assert.strictEqual(debugEntry.debugInputs.config.configuredMinPrice, '2x');
    assert.strictEqual(debugEntry.debugInputs.config.configuredMaxPrice, '2x');
    assert.strictEqual(debugEntry.debugInputs.config.rangeScalingFactor, 0.1);
    assert.strictEqual(debugEntry.debugInputs.accountTotals.buyFree, 8);
    assert.strictEqual(debugEntry.debugInputs.pricing, undefined);
    assert.strictEqual(debugEntry.debugInputs.assets, undefined);
    assert.strictEqual(debugEntry.debugInputs.boundaryIdx, undefined);
    assert.strictEqual(debugEntry.debugInputs.orderCount, undefined);
    assert.strictEqual(debugEntry.debugInputs.botKey, undefined);
    assert.strictEqual(debugEntry.debugInputs.runtimeState, undefined);
    assert.strictEqual(debugEntry.debugInputs.config.privateKey, '[REDACTED]');
    assert.strictEqual(debugEntry.debugInputs.config.botHmacSecret, '[REDACTED]');
  } finally {
    fs.rmSync(tempOrdersDir, { recursive: true, force: true });
  }

  // Dust persistence tests removed — dust is cancelled immediately, no maps/timers.
  console.log('AccountOrders getAssetBalances tests passed');
  process.exit(0);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(2);
});
