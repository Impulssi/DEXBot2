const assert = require('assert');
const DEXBot = require('../modules/dexbot_class').default;
const mathUtils = require('../modules/order/utils/math');

const bsModule = require('../modules/bitshares_client');
if (typeof bsModule.setSuppressConnectionLog === 'function') {
    bsModule.setSuppressConnectionLog(true);
}

async function run() {
    console.log('Running batch fee schedule regression test...');

    try {
        // Regression guard:
        // - getAssetFees('BTS') returns fee schedule (createFee/updateFee)
        // - getAssetFees('BTS', amount) returns proceeds projection (no createFee/updateFee)
        // _processBatchResults must use the fee schedule variant.
        mathUtils._setFeeCache({
            BTS: {
                limitOrderCreate: { bts: 0.06 },
                limitOrderUpdate: { bts: 0.03 }
            }
        });

        let captured = null;

        const fakeBot = Object.create(DEXBot.prototype);
        fakeBot.manager = {
            logger: { log: () => {} },
            orders: new Map(),
            synchronizeWithChain: async (data, source) => {
                captured = { data, source };
                return { newOrders: [], ordersNeedingCorrection: [] };
            },
            applyGridUpdateBatch: async () => true
        };

        await DEXBot.prototype._processBatchResults.call(
            fakeBot,
            { operation_results: [[1, '1.7.999']] },
            [{ kind: 'create', order: { id: 'slot-1', type: 'buy' } }]
        );

        assert(captured, 'Expected synchronizeWithChain to be called for create result');
        assert.strictEqual(captured.source, 'createOrder', 'Expected createOrder sync source');
        assert.strictEqual(captured.data.fee, 0.06, 'Expected create fee from BTS fee schedule');

        console.log('✓ batch fee schedule regression test passed');
    } finally {
        mathUtils._setFeeCache({});
    }
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('✗ batch fee schedule regression test failed');
        console.error(err);
        process.exit(1);
    });
