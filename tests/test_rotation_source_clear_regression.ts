const assert = require('assert');
const DEXBot = require('../modules/dexbot_class').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { initializeFeeCache } = require('../modules/order/utils/system');

const bsModule = require('../modules/bitshares_client');
if (typeof bsModule.setSuppressConnectionLog === 'function') {
    bsModule.setSuppressConnectionLog(true);
}

async function run() {
    console.log('Running rotation source clear regression test...');

    const mockBitShares = {
        db: {
            getGlobalProperties: async () => ({
                parameters: {
                    current_fees: {
                        parameters: [
                            [1, { fee: 100000 }],
                            [2, { fee: 10000 }],
                            [77, { fee: 1000 }]
                        ]
                    }
                }
            })
        }
    };
    await initializeFeeCache(['BTS'], mockBitShares);

    const sourceId = 'slot-94';
    const destId = 'slot-97';
    const orderId = '1.7.424242';

    const sourceOrder = {
        id: sourceId,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.ACTIVE,
        price: 1315.6,
        size: 82.90,
        orderId
    };

    const destOrderCommitted = {
        id: destId,
        type: ORDER_TYPES.BUY,
        state: ORDER_STATES.VIRTUAL,
        price: 1336.8,
        size: 83.90,
        orderId: null
    };

    const manager = {
        logger: { log: () => {} },
        orders: new Map([
            [sourceId, { ...sourceOrder }],
            [destId, { ...destOrderCommitted }]
        ]),
        accountant: {
            updateOptimisticFreeBalance: async () => true
        },
        applyGridUpdateBatch: async (updates) => {
            for (const order of updates) {
                manager.orders.set(order.id, { ...order });
            }
            return true;
        },
        synchronizeWithChain: async () => ({ newOrders: [], ordersNeedingCorrection: [] })
    };

    const fakeBot = Object.create(DEXBot.prototype);
    fakeBot.manager = manager;

    await DEXBot.prototype._processBatchResults.call(
        fakeBot,
        { operation_results: [[1, orderId]] },
        [{
            kind: 'rotation',
            rotation: {
                oldOrder: { ...sourceOrder },
                newGridId: destId,
                newPrice: destOrderCommitted.price,
                newSize: destOrderCommitted.size,
                type: ORDER_TYPES.BUY
            },
            finalInts: {
                sell: '123',
                receive: '456',
                sellAssetId: '1.3.0',
                receiveAssetId: '1.3.5537'
            }
        }]
    );

    const sourceAfter = manager.orders.get(sourceId);
    const destAfter = manager.orders.get(destId);

    assert(sourceAfter, 'Source slot must remain in grid');
    assert(destAfter, 'Destination slot must remain in grid');

    assert.strictEqual(sourceAfter.state, ORDER_STATES.VIRTUAL, 'Rotation source slot must be VIRTUAL after rotation');
    assert.strictEqual(sourceAfter.orderId, null, 'Rotation source slot must clear orderId after rotation');

    assert.strictEqual(destAfter.state, ORDER_STATES.ACTIVE, 'Rotation destination slot must be ACTIVE after rotation');
    assert.strictEqual(destAfter.orderId, orderId, 'Rotation destination slot must keep rotated orderId');

    console.log('✓ rotation source clear regression test passed');
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('✗ rotation source clear regression test failed');
        console.error(err);
        process.exit(1);
    });
