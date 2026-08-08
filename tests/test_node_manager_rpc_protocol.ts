const assert = require('assert');
const path = require('path');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Testing NodeManager WebSocket RPC protocol...\n');

const nodeManagerPath = path.resolve(__dirname, '../modules/node_manager.ts');
const expectedChainId = '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8';
const sentMessages: any[] = [];

class FakeWebSocket {
    [key: string]: any;
    constructor(url) {
        this.url = url;
        this.closed = false;
        process.nextTick(() => {
            if (typeof this.onopen === 'function') this.onopen();
        });
    }

    send(raw) {
        const request = JSON.parse(raw);
        sentMessages.push(request);

        let result;
        const [, method] = request.params || [];
        if (request.method !== 'call') {
            result = null;
        } else if (method === 'login') {
            result = true;
        } else if (method === 'database') {
            result = 2;
        } else if (method === 'get_chain_id') {
            result = expectedChainId;
        } else {
            throw new Error(`Unexpected RPC method: ${method}`);
        }

        process.nextTick(() => {
            if (typeof this.onmessage === 'function') {
                this.onmessage({ data: JSON.stringify({ id: request.id, result }) });
            }
        });
    }

    close() {
        this.closed = true;
    }
}

async function main() {
    const savedWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as any;
    delete require.cache[nodeManagerPath];

    try {
        const NodeManager = require('../modules/node_manager').default;
        const nm = new NodeManager({
            list: ['wss://node.example/ws'],
            healthCheck: {
                timeoutMs: 100,
                maxPingMs: 1000,
                blacklistThreshold: 2,
            },
        });

        const result = await nm.checkNode('wss://node.example/ws');
        assert.strictEqual(result.status, 'healthy');
        assert.strictEqual(sentMessages.length, 3, 'Health check should send login, database, and get_chain_id calls');
        assert.deepStrictEqual(sentMessages.map((msg) => msg.method), ['call', 'call', 'call']);
        assert.deepStrictEqual(sentMessages.map((msg) => msg.params[1]), ['login', 'database', 'get_chain_id']);
        assert.deepStrictEqual(sentMessages[2].params, [2, 'get_chain_id', []]);

        const stats = nm.getStats()[0];
        assert.strictEqual(stats.status, 'healthy');
        assert.strictEqual(stats.failureCount, 0);
        assert.strictEqual(stats.lastErrorMessage, null);
        console.log('✓ NodeManager RPC protocol test passed\n');
    } finally {
        globalThis.WebSocket = savedWebSocket;
        delete require.cache[nodeManagerPath];
    }
}

main().catch((err) => {
    console.error('NodeManager RPC protocol test failed:', getErrorMessage(err));
    process.exitCode = 1;
});
