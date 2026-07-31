/**
 * tests/test_broadcast_failure.ts - Broadcast failure classification tests
 *
 * Verifies the retry-safety decision table used by the credential daemon's
 * broadcastWithDeadline: only provably-untransmitted failures are retryable;
 * anything that may have reached the chain is uncertain (never re-signed);
 * node rejections and build errors are definite (no landing, no retry).
 */
'use strict';

const assert = require('assert');
const { classifyBroadcastFailure } = require('../modules/broadcast_failure');

async function main() {
    console.log('Running broadcast-failure classification tests...');

    // ── retryable: provably pre-transmit ────────────────────────────────
    assert.strictEqual(
        classifyBroadcastFailure({ code: 'CONNECTION_ERROR', message: 'WebSocket not open' }),
        'retryable',
        'WebSocket not open (pre-send) must be retryable'
    );
    assert.strictEqual(
        classifyBroadcastFailure({ code: 'CONNECTION_ERROR', message: 'Failed to send: socket hang up' }),
        'retryable',
        'frame send failure (pre-send) must be retryable'
    );
    assert.strictEqual(
        classifyBroadcastFailure({ code: 'CONNECTION_ERROR', message: 'No servers provided' }),
        'retryable',
        'empty node list must be retryable'
    );
    assert.strictEqual(
        classifyBroadcastFailure({ code: 'ALL_NODES_FAILED', message: 'All nodes unreachable: a; b' }),
        'retryable',
        'connect sweep failure must be retryable'
    );

    // ── uncertain: may have landed — never re-sign ──────────────────────
    assert.strictEqual(
        classifyBroadcastFailure({ code: 'CONNECTION_ERROR', message: 'Connection closed' }),
        'uncertain',
        'connection dropped with a response pending must be uncertain'
    );
    assert.strictEqual(
        classifyBroadcastFailure({ code: 'RPC_TIMEOUT', message: 'RPC timeout 15000ms for broadcast_transaction_synchronous' }),
        'uncertain',
        'RPC timeout (request was sent) must be uncertain'
    );
    assert.strictEqual(
        classifyBroadcastFailure({ code: 'UNKNOWN_NEW_CODE', message: 'something new' }),
        'uncertain',
        'unknown broadcast-phase errors must be treated conservatively as uncertain'
    );
    assert.strictEqual(
        classifyBroadcastFailure({ message: 'no code' }),
        'uncertain',
        'errors without a code must be uncertain'
    );

    // ── definite: node rejected or tx could not be built ────────────────
    assert.strictEqual(
        classifyBroadcastFailure({ code: 10, message: 'Insufficient Balance' }),
        'definite',
        'numeric JSON-RPC code (node rejection) must be definite'
    );
    assert.strictEqual(
        classifyBroadcastFailure({ code: '10', message: 'Insufficient Balance' }),
        'definite',
        'numeric string JSON-RPC code must be definite'
    );
    assert.strictEqual(
        classifyBroadcastFailure({ code: 'BROADCAST_ERROR', message: 'unable to parse operation' }),
        'definite',
        'tx build errors must be definite'
    );
    assert.strictEqual(
        classifyBroadcastFailure({ code: 'CHAIN_CONFIG_ERROR', message: 'chain id mismatch' }),
        'definite',
        'chain config errors must be definite'
    );
    assert.strictEqual(classifyBroadcastFailure(null), 'definite', 'null error must be definite');
    assert.strictEqual(classifyBroadcastFailure(undefined), 'definite', 'undefined error must be definite');

    console.log('All broadcast-failure classification tests passed.');
    process.exit(0);
}

main().catch((err: any) => {
    console.error('Test failed:', err);
    process.exit(2);
});
