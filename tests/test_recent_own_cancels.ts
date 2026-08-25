const assert = require('assert');

const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');
// Compiled ESM namespaces are frozen: the bitshares_client transport is
// mocked via loader hooks so the real chain_orders.executeBatch flow runs
// against a controllable signing client.
esmMockEntry();

let createAccountClientImpl: any = () => { throw new Error('createAccountClient not configured for this test'); };
defineEsmMockAbs(require.resolve('../modules/bitshares_client'), [
    'BitShares', 'createAccountClient', 'waitForConnected', 'getConnectionStatus',
    'disconnectClient', 'reconnectForCycle', 'setSuppressConnectionLog', 'onReconnect',
    'withTimeout', '_assessFailover', 'getNodeManager', 'getNodeStats', 'getNodeSummary',
    'getConnectionError', '_internal'
], {
    BitShares: { subscribe() {} },
    createAccountClient: (...args: any[]) => createAccountClientImpl(...args),
    waitForConnected: async () => {},
    getConnectionStatus: () => ({ connected: true }),
    disconnectClient: async () => {},
    reconnectForCycle: async () => {},
    setSuppressConnectionLog() {},
    onReconnect: () => () => {},
    withTimeout: (p: any) => p,
    _assessFailover: () => null,
    getNodeManager: () => null,
    getNodeStats: () => null,
    getNodeSummary: () => null,
    getConnectionError: () => null,
    _internal: { connected: true },
});

const chainOrders = require('../modules/chain_orders');
const { NATIVE_CLIENT } = require('../modules/constants');
const { setKeyStore, resetKeyStore } = require('../modules/key_store');

const TTL_MS = NATIVE_CLIENT.ORDER_EVENTS.RECENT_OWN_CANCEL_TTL_MS;
const MAX_ENTRIES = NATIVE_CLIENT.ORDER_EVENTS.RECENT_OWN_CANCEL_MAX_ENTRIES;

function uniqueId(label) {
    return `test-recent-own-cancel-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function withStubbedClock(fixedTime, fn) {
    const realNow = Date.now;
    Date.now = () => fixedTime;
    try {
        return fn();
    } finally {
        Date.now = realNow;
    }
}

async function runTests() {
    console.log('Running Recent Own Cancel Correlation Tests...');

    console.log(' - Basic record/check round-trip...');
    {
        const orderId = uniqueId('basic');
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(orderId),
            false,
            'Empty buffer: order should not be present'
        );
        chainOrders.recordOwnCancel(orderId);
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(orderId),
            true,
            'After recordOwnCancel: order should be present'
        );
    }

    console.log(' - Key normalization across input types (string/number)...');
    {
        const numericId = 9001;
        chainOrders.recordOwnCancel(numericId);
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(numericId),
            true,
            'Numeric id should match numeric id'
        );
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled('9001'),
            true,
            'String form of same numeric id should match (String() normalization)'
        );
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(9001),
            true,
            'Numeric id with same value should match'
        );
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled('9002'),
            false,
            'Different id should not match'
        );
    }

    console.log(' - TTL expiry: entry past TTL is dropped on next check...');
    {
        const orderId = uniqueId('ttl');
        const baseTime = Date.now();
        withStubbedClock(baseTime, () => {
            chainOrders.recordOwnCancel(orderId);
        });
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(orderId),
            true,
            'Immediately after record: entry present'
        );
        withStubbedClock(baseTime + TTL_MS - 100, () => {
            assert.strictEqual(
                chainOrders.wasRecentlyOwnCancelled(orderId),
                true,
                'Just before TTL: entry still present'
            );
        });
        withStubbedClock(baseTime + TTL_MS + 1, () => {
            assert.strictEqual(
                chainOrders.wasRecentlyOwnCancelled(orderId),
                false,
                'Just past TTL: entry expired'
            );
        });
    }

    console.log(' - Empty/null/undefined orderId is safely ignored...');
    {
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(null),
            false,
            'null orderId is not in buffer'
        );
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(undefined),
            false,
            'undefined orderId is not in buffer'
        );
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(''),
            false,
            'empty string orderId is not in buffer'
        );
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(0),
            false,
            'zero orderId is not in buffer'
        );
        chainOrders.recordOwnCancel(null);
        chainOrders.recordOwnCancel(undefined);
        chainOrders.recordOwnCancel('');
        assert.strictEqual(
            chainOrders.wasRecentlyOwnCancelled(null),
            false,
            'null still not in buffer after recordOwnCancel(null)'
        );
    }

    console.log(' - Lazy GC: expired entries are dropped when buffer grows past max...');
    {
        const realNow = Date.now;
        const baseTime = realNow();
        const oldPrefix = uniqueId('gc-old');
        const newId = uniqueId('gc-new');

        try {
            Date.now = () => baseTime;
            for (let i = 0; i < MAX_ENTRIES + 5; i++) {
                chainOrders.recordOwnCancel(`${oldPrefix}-${i}`);
            }

            Date.now = () => baseTime + TTL_MS + 1000;
            chainOrders.recordOwnCancel(newId);

            assert.strictEqual(
                chainOrders.wasRecentlyOwnCancelled(newId),
                true,
                'New entry recorded after clock advance must be present'
            );
            assert.strictEqual(
                chainOrders.wasRecentlyOwnCancelled(`${oldPrefix}-0`),
                false,
                'Old entry 0 must have been GC\'d (expired)'
            );
            assert.strictEqual(
                chainOrders.wasRecentlyOwnCancelled(`${oldPrefix}-${MAX_ENTRIES - 1}`),
                false,
                'Last old entry must have been GC\'d (expired)'
            );
        } finally {
            Date.now = realNow;
        }
    }

    console.log(' - executeBatch records cancel ops after successful broadcast...');
    {
        const realNow = Date.now;
        const baseTime = realNow();
        const batchOrderId = uniqueId('batch-cancel');

        const txBroadcasted = { count: 0 };
        const txOps = { last: null };
        createAccountClientImpl = () => ({
            initPromise: Promise.resolve(),
            newTx: () => {
                const tx = {
                    limit_order_cancel: (opData) => { txOps.last = opData; },
                };
                (tx as any).broadcast = async () => {
                    txBroadcasted.count += 1;
                    return [[1, '1.7.0']];
                };
                return tx;
            }
        });

        try {
            Date.now = () => baseTime;
            await chainOrders.executeBatch('test-account', 'test-key', [{
                op_name: 'limit_order_cancel',
                op_data: { order: batchOrderId, fee: { amount: 0, asset_id: '1.3.0' } }
            }]);

            assert.strictEqual(txBroadcasted.count, 1, 'Transaction should have been broadcast once');
            assert.strictEqual(txOps.last && txOps.last.order, batchOrderId, 'Cancel op data should have been passed to tx builder');
            assert.strictEqual(
                chainOrders.wasRecentlyOwnCancelled(batchOrderId),
                true,
                'Batch cancel op must be recorded in recent-own-cancel buffer after successful broadcast'
            );

            withStubbedClock(baseTime + TTL_MS + 1, () => {
                assert.strictEqual(
                    chainOrders.wasRecentlyOwnCancelled(batchOrderId),
                    false,
                    'Batch cancel entry should expire after TTL'
                );
            });
        } finally {
            createAccountClientImpl = () => { throw new Error('createAccountClient not configured for this test'); };
            Date.now = realNow;
        }
    }

    console.log(' - executeBatch failure does not poison the buffer...');
    {
        const realNow = Date.now;
        const baseTime = realNow();
        const failedOrderId = uniqueId('batch-fail');

        createAccountClientImpl = () => ({
            initPromise: Promise.resolve(),
            newTx: () => {
                const tx = {
                    limit_order_cancel: () => {},
                };
                (tx as any).broadcast = async () => {
                    throw new Error('simulated broadcast failure');
                };
                return tx;
            }
        });

        try {
            Date.now = () => baseTime;
            let threw = false;
            try {
                await chainOrders.executeBatch('test-account', 'test-key', [{
                    op_name: 'limit_order_cancel',
                    op_data: { order: failedOrderId, fee: { amount: 0, asset_id: '1.3.0' } }
                }]);
            } catch (err) {
                threw = true;
            }
            assert.strictEqual(threw, true, 'executeBatch failure should propagate');

            assert.strictEqual(
                chainOrders.wasRecentlyOwnCancelled(failedOrderId),
                false,
                'Failed batch must NOT record own-cancel (no broadcast happened)'
            );
        } finally {
            createAccountClientImpl = () => { throw new Error('createAccountClient not configured for this test'); };
            Date.now = realNow;
        }
    }

    console.log(' - executeBatch daemon path records cancel ops after successful broadcast...');
    {
        const realNow = Date.now;
        const baseTime = realNow();
        const daemonOrderId = uniqueId('daemon-batch-cancel');

        const calls = { count: 0, operations: null, options: null };
        setKeyStore({
            isDaemonSigningKey: () => true,
            executeOperations: async (_accountName, operations, signingKey, _options) => {
                calls.count += 1;
                calls.operations = operations;
                calls.options = { socketPath: signingKey.socketPath };
                return {
                    success: true,
                    raw: { ok: true },
                    operation_results: [[2, true]]
                };
            }
        });

        try {
            Date.now = () => baseTime;
            const result = await chainOrders.executeBatch('test-account', {
                kind: 'dexbot-daemon-signing-token',
                accountName: 'test-account',
                socketPath: '/tmp/test-dexbot-cred.sock',
                sessionId: 'session-1',
                botHmacSecret: 'secret-1'
            }, [{
                op_name: 'limit_order_cancel',
                op_data: { order: daemonOrderId, fee: { amount: 0, asset_id: '1.3.0' } }
            }]);

            assert.strictEqual(calls.count, 1, 'Credential daemon should be called once');
            assert.strictEqual(calls.operations[0].op_data.order, daemonOrderId, 'Cancel op should be sent to daemon');
            assert.strictEqual(calls.options.socketPath, '/tmp/test-dexbot-cred.sock', 'Daemon socket path should be passed through');
            assert.deepStrictEqual(result.operation_results, [[2, true]], 'Daemon operation results should be returned');
            assert.strictEqual(
                chainOrders.wasRecentlyOwnCancelled(daemonOrderId),
                true,
                'Daemon batch cancel op must be recorded in recent-own-cancel buffer after successful broadcast'
            );

            withStubbedClock(baseTime + TTL_MS + 1, () => {
                assert.strictEqual(
                    chainOrders.wasRecentlyOwnCancelled(daemonOrderId),
                    false,
                    'Daemon batch cancel entry should expire after TTL'
                );
            });
        } finally {
            resetKeyStore();
            Date.now = realNow;
        }
    }

    console.log(' - executeBatch daemon failure does not poison the buffer...');
    {
        const realNow = Date.now;
        const baseTime = realNow();
        const failedDaemonOrderId = uniqueId('daemon-batch-fail');

        setKeyStore({
            isDaemonSigningKey: () => true,
            executeOperations: async () => {
                throw new Error('simulated daemon broadcast failure');
            }
        });

        try {
            Date.now = () => baseTime;
            let threw = false;
            try {
                await chainOrders.executeBatch('test-account', {
                    kind: 'dexbot-daemon-signing-token',
                    accountName: 'test-account',
                    socketPath: '/tmp/test-dexbot-cred.sock'
                }, [{
                    op_name: 'limit_order_cancel',
                    op_data: { order: failedDaemonOrderId, fee: { amount: 0, asset_id: '1.3.0' } }
                }]);
            } catch (err) {
                threw = true;
            }

            assert.strictEqual(threw, true, 'Daemon executeBatch failure should propagate');
            assert.strictEqual(
                chainOrders.wasRecentlyOwnCancelled(failedDaemonOrderId),
                false,
                'Failed daemon batch must NOT record own-cancel'
            );
        } finally {
            resetKeyStore();
            Date.now = realNow;
        }
    }

    console.log('\u2713 Recent own cancel correlation tests passed!');
}

runTests().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('\u2717 Recent own cancel correlation tests failed');
    console.error(err);
    process.exit(1);
});
