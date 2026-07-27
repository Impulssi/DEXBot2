/**
 * tests/test_transport_connect_noop.ts — Verifies the connect() no-op path.
 *
 * Background: market_adapter re-issues connectClient() every hour on a cycle
 * boundary. The transport's connect() used to call disconnect()+tryConnect()
 * each time, causing the bot transport to flip open/closed. The fix detects
 * "already connected to a node in the requested list" and returns early.
 *
 * This test stubs globalThis.WebSocket to a controllable mock, drives a real
 * transport through a successful connect, then re-issues connect() and asserts
 * that no new WebSocket instance is created.
 */

'use strict';

const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

class StubWebSocket {
    [key: string]: any;
    static instances = [];
    static reset() { StubWebSocket.instances = []; }

    constructor(url) {
        this.url = url;
        this.readyState = 0; // CONNECTING
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        this.closed = false;
        StubWebSocket.instances.push(this);
        // Fire onopen on next tick to mirror real WebSocket behavior.
        setImmediate(() => {
            if (this.closed) return;
            this.readyState = 1; // OPEN
            if (this.onopen) this.onopen({});
        });
    }

    send() {}
    close() {
        this.closed = true;
        this.readyState = 3; // CLOSED
    }
    emitClose(evt = {}) {
        this.closed = true;
        this.readyState = 3; // CLOSED
        if (this.onclose) this.onclose(evt);
    }
}

// Install the stub before requiring the transport module — it captures
// WebSocketConstructor at module load time.
globalThis.WebSocket = StubWebSocket as any;
const { createTransport } = require('../modules/bitshares-native/transport');

console.log('=== Transport Connect No-Op Tests ===\n');

(async () => {
    StubWebSocket.reset();

    console.log(' - Testing connect() returns early when already connected to a node in the requested list...');
    {
        const transport = createTransport({ keepAliveIntervalMs: 60_000 });
        const nodeA = 'ws://test-node-a/ws';

        await transport.connect([nodeA]);
        const instancesAfterFirst = StubWebSocket.instances.length;
        assert.strictEqual(transport.isConnected(), true, 'should be connected after first connect');
        assert.strictEqual(transport.getNodeUrl(), nodeA, 'should be on nodeA');
        assert.strictEqual(instancesAfterFirst, 1, 'first connect should create exactly one WebSocket instance');

        // Re-issue connect with the same node — should be a no-op.
        await transport.connect([nodeA]);
        const instancesAfterSecond = StubWebSocket.instances.length;
        assert.strictEqual(instancesAfterSecond, 1, 'second connect to same node should NOT create a new WebSocket');
        assert.strictEqual(transport.isConnected(), true, 'transport should still be connected');
        assert.strictEqual(transport.getNodeUrl(), nodeA, 'transport should still be on nodeA');

        transport.disconnect();
    }

    console.log(' - Testing connect() with [nodeA, nodeB] no-ops when already on nodeA (nodeA is in list)...');
    {
        StubWebSocket.reset();
        const transport = createTransport({ keepAliveIntervalMs: 60_000 });
        const nodeA = 'ws://test-node-a-2/ws';
        const nodeB = 'ws://test-node-b-2/ws';

        await transport.connect([nodeA]);
        assert.strictEqual(StubWebSocket.instances.length, 1, 'first connect creates one instance');

        // Re-issue with both nodes in the list. The transport is already on
        // nodeA, and nodeA is in the new list — should be a no-op.
        await transport.connect([nodeA, nodeB]);
        assert.strictEqual(StubWebSocket.instances.length, 1, 'connect to a list containing the active node should be a no-op');
        assert.strictEqual(transport.getNodeUrl(), nodeA, 'should still be on nodeA');

        transport.disconnect();
    }

    console.log(' - Testing connect() DOES create a new WebSocket when the active node is not in the new list...');
    {
        StubWebSocket.reset();
        const transport = createTransport({ keepAliveIntervalMs: 60_000 });
        const nodeA = 'ws://test-node-a-3/ws';
        const nodeB = 'ws://test-node-b-3/ws';

        await transport.connect([nodeA]);
        assert.strictEqual(StubWebSocket.instances.length, 1, 'first connect creates one instance');
        assert.strictEqual(transport.getNodeUrl(), nodeA);

        // Re-issue with a list that does NOT contain nodeA. The no-op check
        // should fail, and the transport should disconnect and reconnect to
        // nodeB.
        await transport.connect([nodeB]);
        const totalInstances = StubWebSocket.instances.length;
        assert.ok(totalInstances >= 2, `connect to a list missing the active node should create a new instance (got ${totalInstances})`);
        assert.strictEqual(transport.getNodeUrl(), nodeB, 'should be on nodeB after the reissue');

        transport.disconnect();
    }

    console.log(' - Testing connect() throws when node list is empty even if already connected...');
    {
        StubWebSocket.reset();
        const transport = createTransport({ keepAliveIntervalMs: 60_000 });
        const nodeA = 'ws://test-node-a-4/ws';
        await transport.connect([nodeA]);

        let threw = false;
        try {
            await transport.connect([]);
        } catch (e) {
            threw = (e as any).code === 'CONNECTION_ERROR' && /No servers provided/.test(getErrorMessage(e));
        }
        assert.ok(threw, 'empty node list should throw ConnectionError');
        assert.strictEqual(StubWebSocket.instances.length, 1, 'empty-list throw should not create a new WebSocket');
        assert.strictEqual(transport.isConnected(), true, 'existing connection should be preserved when the empty-list call throws');

        transport.disconnect();
    }

    console.log(' - Testing a new socket close is not suppressed by a recent old socket close...');
    {
        StubWebSocket.reset();
        const statusChanges = [];
        const transport = createTransport({
            keepAliveIntervalMs: 60_000,
            onStatusChange: (status, nodeUrl) => statusChanges.push([status, nodeUrl]),
        });
        const nodeA = 'ws://test-node-a-5/ws';
        const nodeB = 'ws://test-node-b-5/ws';

        await transport.connect([nodeA]);
        const firstSocket = StubWebSocket.instances[0];
        firstSocket.emitClose({ code: 1006, wasClean: false, reason: 'first close' });
        assert.strictEqual(transport.isConnected(), false, 'first active socket close should mark transport disconnected');

        await transport.connect([nodeB]);
        const secondSocket = StubWebSocket.instances[1];
        assert.strictEqual(transport.isConnected(), true, 'transport should reconnect to nodeB');
        secondSocket.emitClose({ code: 1006, wasClean: false, reason: 'second close' });

        assert.strictEqual(transport.isConnected(), false, 'second active socket close should not be debounced by first close');
        const closedOnNodeB = statusChanges.some(([status, nodeUrl]) => status === 'closed' && nodeUrl === nodeB);
        assert.strictEqual(closedOnNodeB, true, 'new socket close should emit a closed status for nodeB');
    }

    console.log('\n=== All transport connect no-op tests passed ===');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
