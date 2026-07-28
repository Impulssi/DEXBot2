#!/usr/bin/env node
const assert = require('assert');

function mockClient() {
  const assets: Record<string, any> = {};
  return {
    assets,
    db: {
      lookup_asset_symbols: async (symbols: string[]) =>
        symbols.map(s => {
          const cached = assets[s];
          if (cached?.id && cached?.precision != null) return cached;
          return s === 'BTS'
            ? { id: '1.3.0', precision: 4 }
            : s === 'XBTSX.USDT'
            ? { id: '1.3.100', precision: 6 }
            : { id: '1.3.999', precision: 4 };
        }),
      get_assets: async (ids: string[]) =>
        ids.map(id => ({ id: String(id), precision: 4 })),
      get_objects: async (ids: string[]) =>
        ids.map(id => {
          if (id === '1.19.48') {
            return { id: '1.19.48', asset_a: '1.3.0', asset_b: '1.3.100', balance_a: 500000, balance_b: 1000000 };
          }
          if (id === '1.19.133') {
            return { id: '1.19.133', asset_a: '1.3.0', asset_b: '1.3.100', balance_a: 10000000, balance_b: 20000000 };
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

  console.log('\nAll poolRef tests passed');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(2); });
