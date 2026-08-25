'use strict';

const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// Compiled ESM namespaces are frozen and require.cache injection cannot
// intercept static imports, so mock the native client module through the
// loader-hook harness before the adapter is loaded.
esmMockEntry();

async function main() {
    const nativePath = require.resolve('../modules/bitshares-native/index');
    let connectArg = null;
    let disconnectCalls = 0;

    defineEsmMockAbs(nativePath, ['createReadOnlyClient'], {
        createReadOnlyClient: () => ({
            connect: async (nodes) => {
                connectArg = Array.isArray(nodes) ? nodes.slice() : nodes;
            },
            disconnect: () => {
                disconnectCalls += 1;
            },
            db: async () => null,
            history: async () => null,
            getNodeUrl: () => null,
            isConnected: () => false,
            setNodes: () => {},
            getNodes: () => [],
        }),
    });

    process.env.DEXBOT_NATIVE_CHAIN = '1';

    try {
        const adapter = require('../market_adapter/utils/adapter_client');
        const testNodes = ['wss://node-a.example/ws', 'wss://node-b.example/ws'];

        await adapter.connectClient(testNodes);
        assert.deepStrictEqual(connectArg, testNodes, 'native adapter should forward the caller node list to the read-only client');

        adapter.disconnectClient();
        assert.strictEqual(disconnectCalls, 1, 'disconnect should propagate to the native read-only client');

        console.log('adapter client native tests passed');
    } finally {
        delete process.env.DEXBOT_NATIVE_CHAIN;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
