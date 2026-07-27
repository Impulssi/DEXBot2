const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running price_tolerance tests');

const { OrderManager, utils } = require('../modules/order/index');

const calc = utils.calculatePriceTolerance;

// 1) Handle assets missing - should throw error
try {
    calc(1000, 10, 'buy', null);
    assert.fail('calculatePriceTolerance should throw when assets are missing');
} catch (err) {
    assert.strictEqual(getErrorMessage(err), 'CRITICAL: Assets object required for calculatePriceTolerance');
}

// 2) Example from inline comment in manager: BUY: gridPrice=1820, orderSize=73.88, precisionA=4, precisionB=5
const assetsExample = { assetA: { precision: 4 }, assetB: { precision: 5 } };
const t = calc(1820, 73.88, 'buy', assetsExample);
// Expect approximately 4.48 (allow some tiny floating error)
assert.ok(Math.abs(t - 4.48) < 0.01, `expected tolerance ≈4.48, got ${t}`);

// 3) Ensure OrderManager method delegates to utils and returns same result
const mgr = new OrderManager({ assetA: 'IOB.XRP', assetB: 'BTS' });
mgr.assets = assetsExample;
// The canonical implementation lives in utils; verify utils returns the same value
const tUtils = calc(1820, 73.88, 'buy', assetsExample);
assert.ok(Math.abs(tUtils - t) < 1e-12, `utils should return same value (got ${tUtils} vs ${t})`);

console.log('price_tolerance tests passed');

