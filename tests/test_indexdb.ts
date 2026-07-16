const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AccountOrders, createBotKey } = require('../modules/account_orders');
const { OrderManager, utils } = require('../modules/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testDustPersistence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot2-dust-'));
  try {
    const dustBotKey = createBotKey({ name: 'Dust Bot' }, 0);
    const dustDb = new AccountOrders({
      botKey: dustBotKey,
      profilesPath: path.join(tempDir, `${dustBotKey}.json`)
    });

    assert.strictEqual(dustDb.loadDustSince(), null, 'Fresh file should have no dustSince');
    assert.strictEqual(dustDb.loadDustRetryCount(), null, 'Fresh file should have no dustRetryCount');

    const orders = [
      { id: 'd1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 1, orderId: '1.7.10' },
      { id: 'd2', type: ORDER_TYPES.BUY, state: ORDER_STATES.ACTIVE, size: 2, orderId: '1.7.11' },
    ];

    const dustSince = { '1.7.10': 1000, '1.7.11': 2000 };
    const dustRetryCount = { '1.7.10': 3 };
    await dustDb.storeMasterGrid(orders, null, null, null, null, dustSince, dustRetryCount);

    let loadedSince = dustDb.loadDustSince(true);
    assert.deepStrictEqual(loadedSince, dustSince, 'loadDustSince should return persisted data');
    let loadedRetries = dustDb.loadDustRetryCount(true);
    assert.deepStrictEqual(loadedRetries, dustRetryCount, 'loadDustRetryCount should return persisted data');

    await dustDb.storeMasterGrid(orders, null, null, null, null, {}, {});
    loadedSince = dustDb.loadDustSince(true);
    assert.strictEqual(loadedSince, null, 'Empty dustSince should be deleted from file');
    loadedRetries = dustDb.loadDustRetryCount(true);
    assert.strictEqual(loadedRetries, null, 'Empty dustRetryCount should be deleted from file');

    const rawData = dustDb._loadData();
    assert.strictEqual(rawData.dustSince, undefined, 'dustSince key should not exist in file after deletion');
    assert.strictEqual(rawData.dustRetryCount, undefined, 'dustRetryCount key should not exist in file after deletion');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('  ✓ Dust persistence (storeMasterGrid)');
}

async function testDustPersistenceViaPersistGrid() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot2-dustsnap-'));
  try {
    const dustBotKey = createBotKey({ name: 'Dust Snap Bot' }, 0);
    const dustDb = new AccountOrders({
      botKey: dustBotKey,
      profilesPath: path.join(tempDir, `${dustBotKey}.json`)
    });
    const manager = new OrderManager({
      name: 'Dust Snap Bot',
      botKey: dustBotKey,
      assetA: 'ASSET.A',
      assetB: 'ASSET.B',
    });
    manager.accountOrders = dustDb;
    manager.funds.btsFeesOwed = 0;

    manager._dustSinceMap = new Map([['1.7.20', 5000], ['1.7.21', 6000]]);
    manager._dustRetryCount = new Map([['1.7.20', 1]]);

    const dustSincePlain = Object.fromEntries(manager._dustSinceMap);
    const dustRetryPlain = Object.fromEntries(manager._dustRetryCount);
    const testOrders = [
      { id: 'ds1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, size: 1, orderId: '1.7.20' },
    ];
    await dustDb.storeMasterGrid(testOrders, null, null, null, null, dustSincePlain, dustRetryPlain);
    const loadedSince = dustDb.loadDustSince(true);
    assert.deepStrictEqual(loadedSince, dustSincePlain, 'DustSince should survive via persistGridSnapshot path');
    const loadedRetries = dustDb.loadDustRetryCount(true);
    assert.deepStrictEqual(loadedRetries, dustRetryPlain, 'DustRetryCount should survive via persistGridSnapshot path');
    manager._lastGridPricingContext = {
      gridPrice: 1.0,
      configuredMinPrice: '2x',
      configuredMaxPrice: '2x',
      rangeScalingFactor: 0.1
    };
    manager.assets = {
      assetA: { symbol: 'ASSET.A', precision: 5 },
      assetB: { symbol: 'ASSET.B', precision: 5 }
    };
    manager.accountTotals = { buy: 10, sell: 20, buyFree: 8, sellFree: 18 };
    manager.boundaryIdx = 0;

    await dustDb.storeMasterGrid(testOrders, null, null, null, null, dustSincePlain, dustRetryPlain);
    assert.ok(dustDb.loadDustSince(true), 'Dust seeded before fallback test');

    await utils.persistGridSnapshot(manager, dustDb, testOrders);

    const postSnapshotSince = dustDb.loadDustSince(true);
    assert.deepStrictEqual(postSnapshotSince, dustSincePlain,
      'persistGridSnapshot without extras should NOT wipe dust (fallback)');

    const postSnapshotRetries = dustDb.loadDustRetryCount(true);
    assert.deepStrictEqual(postSnapshotRetries, dustRetryPlain,
      'persistGridSnapshot without extras should NOT wipe dustRetryCount (fallback)');

    manager._dustSinceMap = new Map();
    manager._dustRetryCount = new Map();
    await utils.persistGridSnapshot(manager, dustDb, testOrders);
    assert.strictEqual(dustDb.loadDustSince(true), null,
      'Empty _dustSinceMap should delete dustSince via persistGridSnapshot');
    assert.strictEqual(dustDb.loadDustRetryCount(true), null,
      'Empty _dustRetryCount should delete dustRetryCount via persistGridSnapshot');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('  ✓ Dust persistence via persistGridSnapshot fallback');
}

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

  await testDustPersistence();
  await testDustPersistenceViaPersistGrid();
  console.log('AccountOrders getAssetBalances tests passed');
  process.exit(0);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(2);
});
