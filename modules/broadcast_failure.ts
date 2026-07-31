/**
 * modules/broadcast_failure.ts - Broadcast failure classification
 *
 * Decides whether a failed credential-daemon broadcast may be retried without
 * risking duplicate on-chain orders. The cardinal rule: a transaction may
 * only be re-signed when it PROVABLY never reached the chain. Anything that
 * could have been transmitted is 'uncertain' and must be deferred to the
 * bot's verify-before-retry machinery (COW retry verification, startup
 * adoption) instead of being re-broadcast.
 *
 * Mirrors the failure modes produced by modules/bitshares-native/transport.ts
 * call() and the signing client (modules/bitshares-native/signing_client.ts).
 */
'use strict';

export type BroadcastFailureClass = 'retryable' | 'uncertain' | 'definite';

/**
 * Classify a broadcast-phase failure.
 *
 * 'retryable' — the transaction provably never reached the chain: pre-send
 *               failures in transport.call() (WebSocket not open, frame send
 *               errors) and connect-sweep failures.
 * 'uncertain' — the transaction may have landed (RPC timeout, connection
 *               dropped while the response was pending, unknown errors).
 *               Must NOT be re-signed, or the order is duplicated on chain.
 * 'definite'  — the chain rejected the transaction (numeric JSON-RPC error,
 *               e.g. 10 = insufficient balance) or the transaction could not
 *               be built: nothing landed and retrying the identical ops
 *               cannot change the outcome.
 *
 * @param {any} err - The thrown error (code + message).
 * @returns {BroadcastFailureClass}
 */
export function classifyBroadcastFailure(err: any): BroadcastFailureClass {
    if (!err) return 'definite';
    const code = String(err.code || '');
    if (code === 'CONNECTION_ERROR') {
        const msg = String(err.message || '');
        // Pre-send rejections in transport.call() — the RPC frame was never
        // written to the socket, so no transaction was transmitted.
        if (msg === 'WebSocket not open' || msg.startsWith('Failed to send') || msg === 'No servers provided') {
            return 'retryable';
        }
        // 'Connection closed' while a response was pending: the request WAS
        // written to the socket — the transaction may have landed.
        return 'uncertain';
    }
    if (code === 'ALL_NODES_FAILED') return 'retryable'; // connect sweep only
    if (code === 'RPC_TIMEOUT') return 'uncertain';
    // Graphene JSON-RPC error codes are integers — the node processed and
    // REJECTED the transaction, so it definitively did not land.
    if (/^\d+$/.test(code)) return 'definite';
    if (code === 'BROADCAST_ERROR' || code === 'CHAIN_CONFIG_ERROR') return 'definite';
    // Local transaction build/sign failures (modules/bitshares-native/tx/builder.ts
    // and signing_client.ts): the transaction was never transmitted, so the
    // broadcast provably did not leave the machine. Classifying these as
    // 'uncertain' would fire onNodeFailed and blacklist a healthy node for
    // BLACKLIST_COOLDOWN_MS over a broadcast that never reached the wire.
    // 'retryable' here means safe to retry on another node (nothing landed).
    if (code === 'TX_TOO_LARGE') return 'retryable';
    const msg = String(err.message || '');
    if (
        /^Failed to fetch required fees/.test(msg)
        || /^Failed to fetch reference block/.test(msg)
        || /^Invalid chain id for transaction signing/.test(msg)
        || msg === 'Operation must have op_name and op_data'
        || /^Max operations per tx/.test(msg)
        || msg === 'Broadcast API does not support transaction broadcast'
        || msg === 'Signing client has been disposed'
        || msg === 'chainClient is required'
        || msg === 'accountName is required'
        || msg === 'privateKey is required'
    ) {
        return 'retryable';
    }
    // Anything else during the broadcast phase — conservative: uncertain.
    return 'uncertain';
}

export default classifyBroadcastFailure;
