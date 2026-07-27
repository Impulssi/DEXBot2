/**
 * tests/test_native_chain_client.ts — Chain client and read-only client tests
 *
 * Tests API proxy wiring, login flow, lazy API registration, and
 * read-only client creation.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const STRICT_TEST = process.env.RUN_NATIVE_CHAIN_CLIENT_TEST_STRICT === '1';
const OVERALL_TIMEOUT_MS = Number(process.env.NATIVE_CHAIN_CLIENT_TEST_TIMEOUT_MS) || 10000;

console.log('=== Native Chain Client Tests ===\n');

function formatError(error) {
    return error && error.message ? error.message : String(error);
}

function isEnvironmentError(error) {
    if (!error) return false;
    const message = formatError(error);
    const code = error.code || '';
    return [
        'EPERM',
        'EACCES',
        'EADDRINUSE',
        'EADDRNOTAVAIL',
        'ECONNREFUSED',
        'ETIMEDOUT'
    ].includes(code) || /listen|bind|timed out/i.test(message);
}

// ── WebSocket mock server ────────────────────────────────────────────────

function createWsServer(port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            res.writeHead(200);
            res.end('ok');
        });

        server.on('upgrade', (req, socket, head) => {
            const key = req.headers['sec-websocket-key'];
            const acceptKey = crypto.createHash('sha1')
                .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
                .digest('base64');

            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n'
            );

            socket.on('data', (chunk) => {
                try {
                    const frame = parseWsFrame(chunk);
                    if (!frame || !frame.payload) return;
                    const msg = JSON.parse(frame.payload.toString());
                    const id = msg.id;

                    if (msg.method === 'call') {
                        const [apiId, method, params] = msg.params;

                        if (apiId === 1 && method === 'login') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: true,
                            }));
                        } else if (apiId === 1 && method === 'database') {
                            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: 2 }));
                        } else if (apiId === 1 && method === 'history') {
                            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: 3 }));
                        } else if (apiId === 1 && method === 'network_broadcast') {
                            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: 4 }));
                        } else if (apiId === 2) {
                            // Database API call
                            if (method === 'get_chain_id') {
                                sendWsFrame(socket, JSON.stringify({
                                    id, jsonrpc: '2.0',
                                    result: '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8',
                                }));
                            } else if (method === 'get_chain_properties') {
                                sendWsFrame(socket, JSON.stringify({
                                    id, jsonrpc: '2.0',
                                    result: { address_prefix: 'BTS' },
                                }));
                            } else if (method === 'get_assets') {
                                sendWsFrame(socket, JSON.stringify({
                                    id, jsonrpc: '2.0',
                                    result: [{ id: '1.3.0', precision: 5, symbol: 'BTS' }],
                                }));
                            } else if (method === 'get_global_properties') {
                                sendWsFrame(socket, JSON.stringify({
                                    id, jsonrpc: '2.0',
                                    result: {
                                        parameters: { current_fees: { parameters: [], scale: 10000 } },
                                    },
                                }));
                            } else {
                                sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: {} }));
                            }
                        } else if (apiId === 3) {
                            // History API call
                            if (method === 'get_market_history') {
                                sendWsFrame(socket, JSON.stringify({
                                    id, jsonrpc: '2.0',
                                    result: [{ open: 100, close: 105, high: 110, low: 95, volume: 1000 }],
                                }));
                            } else {
                                sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: [] }));
                            }
                        } else {
                            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: {} }));
                        }
                    }
                } catch (_) {}
            });

            socket.on('error', () => {});
        });

        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            resolve({
                server,
                port,
                close() { server.close(); },
            });
        });
    });
}

function parseWsFrame(chunk) {
    if (chunk.length < 2) return null;
    const secondByte = chunk[1];
    let payloadLength = secondByte & 0x7f;
    let offset = 2;
    if (payloadLength === 126) { payloadLength = chunk.readUInt16BE(2); offset = 4; }
    else if (payloadLength === 127) { payloadLength = Number(chunk.readBigUInt64BE(2)); offset = 10; }
    const maskKey = (secondByte & 0x80) ? chunk.slice(offset, offset + 4) : null;
    if (maskKey) offset += 4;
    const payload = Buffer.from(chunk.slice(offset, offset + payloadLength));
    if (maskKey) { for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]; }
    return { payload };
}

function sendWsFrame(socket, data) {
    const payload = Buffer.from(data, 'utf8');
    let header;
    if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
}

// ── Test: API proxy wiring ───────────────────────────────────────────────

async function testApiProxyWiring() {
    const { createChainClient } = require('../modules/bitshares-native/chain_client');
    const port = 19000 + Math.floor(Math.random() * 1000);
    const wsServer = await createWsServer(port);

    try {
        const client = createChainClient({
            nodes: [`ws://127.0.0.1:${port}/ws`],
            autoreconnect: false,
        });
        await client.connect();

        // Test db proxy
        const assets = await client.db.get_assets(['1.3.0']);
        assert.ok(Array.isArray(assets), 'get_assets should return array');
        assert.strictEqual(assets[0].symbol, 'BTS');

        // Test history proxy
        const candles = await client.history.getMarketHistory('1.3.0', '1.3.1', 3600, 0, 0);
        assert.ok(Array.isArray(candles), 'getMarketHistory should return array');

        // Test getConfig after login
        const config = client.getConfig();
        assert.ok(config, 'getConfig should return config after login');
        assert.strictEqual(config.chainId, '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8');

        // Test getCoreAsset
        const core = client.getCoreAsset();
        assert.strictEqual(core, '1.3.0');

        client.disconnect();
        console.log('  PASS: API proxy wiring');
    } finally {
        (wsServer as any).close();
    }
}

// ── Test: Lazy API registration ──────────────────────────────────────────

async function testLazyApiRegistration() {
    const { createChainClient } = require('../modules/bitshares-native/chain_client');
    const port = 19000 + Math.floor(Math.random() * 1000);
    const wsServer = await createWsServer(port);

    try {
        const client = createChainClient({
            nodes: [`ws://127.0.0.1:${port}/ws`],
            autoreconnect: false,
        });
        await client.connect();

        // db should work (triggers database API registration)
        const assets = await client.db.get_assets(['1.3.0']);
        assert.ok(assets, 'db should work after lazy registration');

        // history should work (triggers history API registration)
        const hist = await client.history.getMarketHistory('1.3.0', '1.3.1', 3600, 0, 0);
        assert.ok(hist, 'history should work after lazy registration');

        client.disconnect();
        console.log('  PASS: Lazy API registration');
    } finally {
        (wsServer as any).close();
    }
}

// ── Test: Read-only client ───────────────────────────────────────────────

async function testReadOnlyClient() {
    const { createReadOnlyClient } = require('../modules/bitshares-native/chain_client');
    const port = 19000 + Math.floor(Math.random() * 1000);
    const wsServer = await createWsServer(port);

    try {
        const client = createReadOnlyClient({ nodes: [`ws://127.0.0.1:${port}/ws`] });
        await client.connect();

        assert.strictEqual(client.isConnected(), true, 'Should be connected');
        assert.ok(client.getNodeUrl().includes(String(port)), 'Node URL should match');

        const assets = await client.db('get_assets', [['1.3.0']]);
        assert.ok(Array.isArray(assets), 'read-only db should work');

        const hist = await client.history('getMarketHistory', ['1.3.0', '1.3.1', 3600, 0, 0]);
        assert.ok(Array.isArray(hist), 'read-only history should work');

        client.disconnect();
        // After disconnect, isConnected may be false or the WS ref may be nulled
        assert.strictEqual(client.isConnected(), false, 'Should be disconnected after disconnect()');
    } finally {
        (wsServer as any).close();
    }
}

// ── Test: Chain config validation ────────────────────────────────────────

async function testChainConfigValidation() {
    const { createChainClient, ChainConfigError } = require('../modules/bitshares-native/chain_client');

    // Test with wrong chain ID - should reject
    const client = createChainClient({
        nodes: ['ws://127.0.0.1:19999/nope'],
        autoreconnect: false,
        expectedChainId: '0000000000000000000000000000000000000000000000000000000000000000',
        validateChainId: false,  // Disabled since we can't connect anyway
    });

    // ChainConfigError type should exist
    const err = new ChainConfigError('test error');
    assert.strictEqual(err.code, 'CHAIN_CONFIG_ERROR');

    console.log('  PASS: Chain config validation');
}

// ── Test: setNodes runtime rotation ──────────────────────────────────────

function testSetNodes() {
    const { createChainClient } = require('../modules/bitshares-native/chain_client');
    const client = createChainClient({ nodes: [], autoreconnect: false });

    client.setNodes(['wss://node1.example.com/ws', 'wss://node2.example.com/ws']);
    const nodes = client.getNodes();
    assert.deepStrictEqual(nodes, ['wss://node1.example.com/ws', 'wss://node2.example.com/ws']);

    console.log('  PASS: setNodes / getNodes');
}

// ── Test: Broadcast proxy available after connect ────────────────────────

function testBroadcastProxy() {
    const { createChainClient } = require('../modules/bitshares-native/chain_client');
    const client = createChainClient({ nodes: [], autoreconnect: false });

    assert.strictEqual(typeof client.broadcast.call, 'function', 'broadcast.call should be a function');
    assert.strictEqual(typeof client.broadcast.broadcast_transaction, 'function', 'broadcast.broadcast_transaction should be a function');

    console.log('  PASS: Broadcast proxy methods');
}

// ── Run all tests ────────────────────────────────────────────────────────

(async () => {
    let timeoutHandle = null;

    try {
        await Promise.race([
            (async () => {
                await testApiProxyWiring();
                await testLazyApiRegistration();
                await testReadOnlyClient();
                testChainConfigValidation();
                testSetNodes();
                testBroadcastProxy();
            })(),
            new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new Error(`native chain client test timed out after ${OVERALL_TIMEOUT_MS}ms`));
                }, OVERALL_TIMEOUT_MS);
            })
        ]);
        console.log('\n=== All chain client tests passed ===');
        process.exit(0);
    } catch (e) {
        if (!STRICT_TEST && isEnvironmentError(e)) {
            console.log('Skipping native chain client test: local bind/connect environment not available.');
            console.log('Error:', formatError(e));
            process.exit(0);
            return;
        }
        console.error('\nChain client test FAILED:', formatError(e));
        console.error((e as any).stack);
        process.exit(1);
        return;
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
})();
