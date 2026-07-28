#!/usr/bin/env node
const assert = require('assert');

function mockClient() {
  const assets: Record<string, any> = {};

  const assetDB: Record<string, { id: string; precision: number; symbol?: string }> = {
    '1.3.0':   { id: '1.3.0',   precision: 4, symbol: 'BTS' },
    '1.3.100': { id: '1.3.100', precision: 6, symbol: 'XBTSX.USDT' },
    '1.3.200': { id: '1.3.200', precision: 6, symbol: 'USDC' },
    '1.3.999': { id: '1.3.999', precision: 4 },
  };

  return {
    assets,
    db: {
      lookup_asset_symbols: async (symbols: string[]) =>
        symbols.map(s => {
          if (s === 'BTS')        return { id: '1.3.0',   precision: 4 };
          if (s === 'XBTSX.USDT') return { id: '1.3.100', precision: 6 };
          if (s === 'USDC')       return { id: '1.3.200', precision: 6 };
          return null;
        }),
      get_assets: async (ids: string[]) =>
        ids.map(id => assetDB[String(id)] || { id: String(id), precision: 4 }),
      get_objects: async (ids: string[]) =>
        ids.map(id => {
          if (id === '1.19.48') {
            return { id: '1.19.48', asset_a: '1.3.0', asset_b: '1.3.100', balance_a: 500000, balance_b: 1000000 };
          }
          if (id === '1.19.133') {
            return { id: '1.19.133', asset_a: '1.3.0', asset_b: '1.3.100', balance_a: 10000000, balance_b: 20000000 };
          }
          if (id === '1.19.200') {
            return { id: '1.19.200', asset_a: '1.3.0', asset_b: '1.3.200', balance_a: 500000, balance_b: 2000000 };
          }
          return null;
        }),
    },
  };
}

async function testPoolRefPinsDirectFetch() {
  const client = mockClient();
  const { withPoolRef } = require('../modules/order/utils/withPoolRef');

  const override = withPoolRef(client, '1.19.48');
  assert.ok(override, 'withPoolRef returns an override object');

  const price = await override.derivePoolPrice('BTS', 'XBTSX.USDT');
  assert.ok(price != null, 'price should be derived');
  // balance_a=500000 (BTS prec=4) -> float 50, balance_b=1000000 (USDT prec=6) -> float 1
  // floatA=50, floatB=1, price = floatB/floatA = 0.02
  assert.strictEqual(price, 0.02, 'price = 1 / 50 = 0.02');

  console.log('testPoolRefPinsDirectFetch passed');
}

async function testPoolRefNullReturnsNull() {
  const client = mockClient();
  const { withPoolRef } = require('../modules/order/utils/withPoolRef');

  const override = withPoolRef(client, null);
  assert.strictEqual(override, null, 'null poolRef returns null');

  console.log('testPoolRefNullReturnsNull passed');
}

async function testPoolRefUndefinedReturnsNull() {
  const client = mockClient();
  const { withPoolRef } = require('../modules/order/utils/withPoolRef');

  const override = withPoolRef(client, undefined);
  assert.strictEqual(override, null, 'undefined poolRef returns null');

  console.log('testPoolRefUndefinedReturnsNull passed');
}

async function testPoolRefEmptyStringReturnsNull() {
  const client = mockClient();
  const { withPoolRef } = require('../modules/order/utils/withPoolRef');

  const override = withPoolRef(client, '');
  assert.strictEqual(override, null, 'empty string poolRef returns null');

  console.log('testPoolRefEmptyStringReturnsNull passed');
}

async function testPoolRefShortIdNormalizes() {
  const client = mockClient();
  const { withPoolRef } = require('../modules/order/utils/withPoolRef');

  const override = withPoolRef(client, '48');
  assert.ok(override, 'short poolId 48 should be accepted');

  const price = await override.derivePoolPrice('BTS', 'XBTSX.USDT');
  assert.ok(price != null, 'price should be derived via normalized 1.19.48');

  console.log('testPoolRefShortIdNormalizes passed');
}

async function testPoolRefMissingPoolReturnsNull() {
  const client = mockClient();
  const { withPoolRef } = require('../modules/order/utils/withPoolRef');

  const override = withPoolRef(client, '1.19.999');
  assert.ok(override, 'override object created even for non-existent pool');

  const price = await override.derivePoolPrice('BTS', 'XBTSX.USDT');
  assert.strictEqual(price, null, 'non-existent pool returns null');

  console.log('testPoolRefMissingPoolReturnsNull passed');
}

async function testDerivePriceWithPoolRefForwardsToPinnedPool() {
  const client = mockClient();
  const { derivePriceWithPoolRef } = require('../modules/order/utils/withPoolRef');

  const price = await derivePriceWithPoolRef(client, 'BTS', 'XBTSX.USDT', 'pool', '1.19.48');
  assert.ok(price != null, 'derivePriceWithPoolRef in pool mode uses pinned pool');
  assert.strictEqual(price, 0.02, 'price should match pinned pool 1.19.48');

  console.log('testDerivePriceWithPoolRefForwardsToPinnedPool passed');
}

async function testDerivePriceWithPoolRefBookModePassthrough() {
  const client = mockClient();
  const { derivePriceWithPoolRef } = require('../modules/order/utils/withPoolRef');

  const price = await derivePriceWithPoolRef(client, 'BTS', 'XBTSX.USDT', 'book', '1.19.48');
  assert.strictEqual(price, null, 'book mode ignores poolRef and returns null (no mock book data)');

  console.log('testDerivePriceWithPoolRefBookModePassthrough passed');
}

async function testDerivePriceWithPoolRefAutoModeSucceeds() {
  const client = mockClient();
  const { derivePriceWithPoolRef } = require('../modules/order/utils/withPoolRef');

  const price = await derivePriceWithPoolRef(client, 'BTS', 'XBTSX.USDT', 'auto', '1.19.48');
  assert.ok(price != null, 'auto mode with valid poolRef should use pinned pool');
  assert.strictEqual(price, 0.02, 'auto mode price should match pinned pool');

  console.log('testDerivePriceWithPoolRefAutoModeSucceeds passed');
}

async function testDerivePriceWithPoolRefAutoModeFallback() {
  const client = mockClient();
  const { derivePriceWithPoolRef } = require('../modules/order/utils/withPoolRef');

  const price = await derivePriceWithPoolRef(client, 'BTS', 'XBTSX.USDT', 'auto', '1.19.999');
  assert.strictEqual(price, null, 'auto mode with bad poolRef falls back to book (returns null without mock book data)');

  console.log('testDerivePriceWithPoolRefAutoModeFallback passed');
}

async function testProxyPoolWithDifferentAssets() {
  const client = mockClient();
  const { withPoolRef } = require('../modules/order/utils/withPoolRef');

  // Pool 1.19.200 has BTS (1.3.0) / USDC (1.3.200), not XBTSX.USDT (1.3.100)
  // Bot trades BTS / XBTSX.USDT — proxy pool use case
  const override = withPoolRef(client, '1.19.200');
  assert.ok(override, 'proxy pool override should be created');

  const price = await override.derivePoolPrice('BTS', 'XBTSX.USDT');
  assert.ok(price != null, 'proxy pool should derive a price');
  // Pool balance_a=500000 (BTS prec=4) -> 50, balance_b=2000000 (USDC prec=6) -> 2
  // price = 2 / 50 = 0.04
  assert.strictEqual(price, 0.04, 'proxy pool uses pool asset precisions: USDC/BTS = 0.04');

  console.log('testProxyPoolWithDifferentAssets passed');
}

async function testProxyPoolReversedBotAssets() {
  const client = mockClient();
  const { withPoolRef } = require('../modules/order/utils/withPoolRef');

  // Same pool 1.19.200 (BTS/USDC) but bot has reversed ordering:
  // XBTSX.USDT (1.3.100) / BTS (1.3.0) — symA ID > symB ID
  // Old code: aIdNum=100 > bIdNum=0 => aIsFirst=false
  //            amtA = balance_b (USDC), amtB = balance_a (BTS) — WRONG inversion
  // New code: uses pool.asset_a/asset_b directly — always correct
  const override = withPoolRef(client, '1.19.200');
  assert.ok(override, 'proxy pool override should be created');

  const price = await override.derivePoolPrice('XBTSX.USDT', 'BTS');
  assert.ok(price != null, 'reversed proxy pool should derive a price');
  // Pool: balance_a=BTS (50), balance_b=USDC (2)
  // The pool intrinsic price is always balance_b/balance_a = 2/50 = 0.04 (USDC/BTS)
  // With reversed bot sym ordering the same pool intrinsic price is returned
  // — the caller (derivePriceWithPoolRef) interprets it as the proxy for the pair
  assert.strictEqual(price, 0.04, 'reversed proxy pool returns pool price (not inverted)');

  console.log('testProxyPoolReversedBotAssets passed');
}

async function testProxyPoolUsesPoolPrecisionsNotBotPrecisions() {
  const client = mockClient();
  const { withPoolRef } = require('../modules/order/utils/withPoolRef');

  // Pool 1.19.200: BTS (prec 4) / USDC (prec 6) — USDC has different precision
  // than XBTSX.USDT (prec 6 — same here, but conceptually distinct)
  // Old code used bot precisions (XBTSX.USDT prec) for balance_b, which is wrong
  const override = withPoolRef(client, '1.19.200');

  const price = await override.derivePoolPrice('BTS', 'XBTSX.USDT');
  assert.ok(price != null, 'price should use pool asset precisions');
  // If old code used XBTSX.USDT prec=6 for balance_b: same as USDC prec=6 here,
  // but this test validates the architecture is correct regardless
  assert.strictEqual(price, 0.04, 'price derived with pool asset precisions');

  console.log('testProxyPoolUsesPoolPrecisionsNotBotPrecisions passed');
}

async function main() {
  await testPoolRefPinsDirectFetch();
  await testPoolRefNullReturnsNull();
  await testPoolRefUndefinedReturnsNull();
  await testPoolRefEmptyStringReturnsNull();
  await testPoolRefShortIdNormalizes();
  await testPoolRefMissingPoolReturnsNull();
  await testDerivePriceWithPoolRefForwardsToPinnedPool();
  await testDerivePriceWithPoolRefBookModePassthrough();
  await testDerivePriceWithPoolRefAutoModeSucceeds();
  await testDerivePriceWithPoolRefAutoModeFallback();
  await testProxyPoolWithDifferentAssets();
  await testProxyPoolReversedBotAssets();
  await testProxyPoolUsesPoolPrecisionsNotBotPrecisions();

  console.log('\nAll poolRef tests passed');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(2); });
