'use strict';

const assert = require('assert');

const { formatAmount, hasLending } = require('../scripts/analyze-credit');

function testFormatAmount() {
  assert.strictEqual(formatAmount(0), '0');
  assert.strictEqual(formatAmount(194395), '194.4K');
  assert.strictEqual(formatAmount(1000), '1K');
  assert.strictEqual(formatAmount(1500000), '1.5M');
  assert.strictEqual(formatAmount(10.389), '10.39');
  assert.strictEqual(formatAmount(NaN), 'N/A');
}

function testHasLending() {
  assert.strictEqual(hasLending(null), false);
  assert.strictEqual(hasLending({}), false);
  assert.strictEqual(hasLending({ debtPolicy: {} }), false);
  assert.strictEqual(hasLending({ debtPolicy: { lending: [] } }), false);
  assert.strictEqual(hasLending({ debtPolicy: { lending: [{ asset: 'BTS' }] } }), true);
}

function main() {
  testFormatAmount();
  testHasLending();
  console.log('analyze-credit helper tests passed');
}

main();
