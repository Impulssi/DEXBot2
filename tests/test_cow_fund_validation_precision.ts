const assert = require('assert');

const { validateWorkingGridFunds } = require('../modules/order/utils/validate');
const { WorkingGrid } = require('../modules/order/working_grid');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const PRECISIONS = { buyPrecision: 5, sellPrecision: 4 };

function createWorkingGridWithSingleSell(size) {
    const master = new Map([
        ['slot-1', {
            id: 'slot-1',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size,
            orderId: '1.7.1'
        }]
    ]);
    return new WorkingGrid(master, { baseVersion: 1 });
}

async function testAllowsTinyFloatNoise() {
    const workingGrid = createWorkingGridWithSingleSell(5.0867);

    const result = validateWorkingGridFunds(workingGrid, {
        allocatedBuy: 0,
        allocatedSell: 5.0866999999999996
    }, PRECISIONS);

    assert.strictEqual(result.isValid, true, 'one-ulp float noise should not fail fund validation');
}

async function testRejectsRealPrecisionShortfall() {
    const workingGrid = createWorkingGridWithSingleSell(5.0867);

    const result = validateWorkingGridFunds(workingGrid, {
        allocatedBuy: 0,
        allocatedSell: 5.0866
    }, PRECISIONS);

    assert.strictEqual(result.isValid, false, 'actual shortfall at precision should fail fund validation');
    assert(result.reason && result.reason.includes('Fund shortfall'), 'reason should mention fund shortfall');
}

async function run() {
    console.log('Running COW fund validation precision tests...');
    await testAllowsTinyFloatNoise();
    await testRejectsRealPrecisionShortfall();
    console.log('✓ COW fund validation precision tests passed');
}

run().catch((err) => {
    console.error('✗ COW fund validation precision tests failed');
    console.error(err);
    process.exit(1);
});
