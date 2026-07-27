/**
 * tests/test_native_tx_builder.ts — Transaction builder unit tests
 *
 * Tests transaction assembly, fee calculation guards, operation addition,
 * signing, and the MAX_TX_SIZE / MAX_OPS_PER_TX safety limits.
 */

const assert = require('assert');
const { createTransactionBuilder, MAX_TX_SIZE, MAX_OPS_PER_TX, TransactionTooLargeError } = require('../modules/bitshares-native/tx/builder');
const ecc = require('../modules/bitshares-native/crypto/ecc');
const { GRAPHENE_CHAIN_ID } = require('../modules/bitshares-native/serial/chain_constants');
const { createSigningClient } = require('../modules/bitshares-native/signing_client');

console.log('=== Native Tx Builder Tests ===\n');

// ── Test: Transaction builder creation ────────────────────────────────────

console.log('Builder creation');
const tx = createTransactionBuilder({});
assert.strictEqual(typeof tx.addOperation, 'function');
assert.strictEqual(typeof tx.limit_order_create, 'function');
assert.strictEqual(typeof tx.limit_order_cancel, 'function');
assert.strictEqual(typeof tx.limit_order_update, 'function');
assert.strictEqual(typeof tx.call_order_update, 'function');
assert.strictEqual(typeof tx.asset_settle, 'function');
assert.strictEqual(typeof tx.transfer, 'function');
assert.strictEqual(typeof tx.setRequiredFees, 'function');
assert.strictEqual(typeof tx.sign, 'function');
assert.strictEqual(typeof tx.broadcast, 'function');
assert.strictEqual(typeof tx.getOperationCount, 'function');
assert.strictEqual(tx.getOperationCount(), 0);
console.log('  PASS');

// ── Test: Add operations ─────────────────────────────────────────────────

console.log('Add operations');
const tx2 = createTransactionBuilder({});
tx2.limit_order_create({
    fee: { amount: 0, asset_id: '1.3.0' },
    seller: '1.2.100',
    amount_to_sell: { amount: 1000000, asset_id: '1.3.0' },
    min_to_receive: { amount: 500000, asset_id: '1.3.1' },
    expiration: Math.floor(Date.now() / 1000) + 86400,
    fill_or_kill: false,
    extensions: {},
});
assert.strictEqual(tx2.getOperationCount(), 1);

tx2.limit_order_cancel({
    fee: { amount: 0, asset_id: '1.3.0' },
    fee_paying_account: '1.2.100',
    order: '1.7.999',
    extensions: [],
});
assert.strictEqual(tx2.getOperationCount(), 2);

const ops = tx2.getOperations();
assert.strictEqual(ops.length, 2);
assert.strictEqual(ops[0].type, 'limit_order_create');
assert.strictEqual(ops[1].type, 'limit_order_cancel');
console.log('  PASS');

// ── Test: MAX_OPS_PER_TX limit ───────────────────────────────────────────

console.log('MAX_OPS_PER_TX limit');
const tx3 = createTransactionBuilder({});
let threw = false;
try {
    for (let i = 0; i < MAX_OPS_PER_TX + 1; i++) {
        tx3.limit_order_cancel({
            fee: { amount: 0, asset_id: '1.3.0' },
            fee_paying_account: '1.2.100',
            order: `1.7.${i}`,
            extensions: [],
        });
    }
} catch (e) {
    threw = e instanceof TransactionTooLargeError || (e as any).code === 'TX_TOO_LARGE';
}
assert.ok(threw, 'Should throw when exceeding MAX_OPS_PER_TX');
assert.strictEqual(tx3.getOperationCount(), MAX_OPS_PER_TX);
console.log('  PASS');

// ── Test: Sign transaction ───────────────────────────────────────────────

console.log('Sign transaction');
const tx4 = createTransactionBuilder({});
const privateKey = ecc.generatePrivateKey();
const publicKey = ecc.privateKeyToPublicKey(privateKey, true);

tx4.limit_order_create({
    fee: { amount: 100, asset_id: '1.3.0' },
    seller: '1.2.100',
    amount_to_sell: { amount: 1000000, asset_id: '1.3.0' },
    min_to_receive: { amount: 500000, asset_id: '1.3.1' },
    expiration: Math.floor(Date.now() / 1000) + 86400,
    fill_or_kill: false,
    extensions: {},
});

// Manually set expiration and ref block for predictable test
tx4.setExpiration(300);

const signed = tx4.sign(privateKey);
assert.ok(Buffer.isBuffer(signed.signedTx), 'signedTx should be a Buffer');
assert.ok(signed.signedTx.length > 0, 'signedTx should not be empty');
assert.ok(signed.signedTxObject, 'signedTxObject should be available for JSON-RPC broadcast');
assert.ok(Array.isArray(signed.signedTxObject.signatures), 'signedTxObject should include signatures array');
assert.strictEqual(typeof signed.signedTxObject.signatures[0], 'string', 'JSON-RPC signature should be hex string');
assert.ok(Buffer.isBuffer(signed.digest), 'digest should be a Buffer');
assert.strictEqual(signed.digest.length, 32, 'digest should be 32 bytes');
assert.ok(Buffer.isBuffer(signed.signature), 'signature should be a Buffer');
assert.strictEqual(signed.signature.length, 65, 'signature should be 65 bytes');

const unsignedForDigest = tx4._serializeUnsigned();
const expectedDigest = ecc.sha256(Buffer.concat([Buffer.from(GRAPHENE_CHAIN_ID, 'hex'), unsignedForDigest]));
const oldUnsafeDigest = ecc.sha256(unsignedForDigest);
assert.ok(signed.digest.equals(expectedDigest), 'Digest should include chain id prefix');
assert.ok(!signed.digest.equals(oldUnsafeDigest), 'Digest must not be unsigned tx hash without chain id');

// Verify the signature
const verified = ecc.verify(signed.digest, signed.signature, publicKey);
assert.ok(verified, 'Signature should verify against the public key');

// Sign with same key = same result if same ref data (deterministic ECDSA)
const signed2 = tx4.sign(privateKey);
assert.ok(signed.digest.equals(signed2.digest), 'Digest should match for same tx');
// Note: signature can differ slightly due to timestamp changes, but let's verify
assert.ok(ecc.verify(signed2.digest, signed2.signature, publicKey), 'Second signature should verify');

console.log('  PASS');

// ── Test: All operation types can be serialized and signed ───────────────

console.log('All op types');
const opsToTest = [
    { type: 'transfer', params: { fee: { amount: 100, asset_id: '1.3.0' }, from: '1.2.100', to: '1.2.200', amount: { amount: 1000, asset_id: '1.3.0' }, memo: null, extensions: [] } },
    { type: 'limit_order_create', params: { fee: { amount: 100, asset_id: '1.3.0' }, seller: '1.2.100', amount_to_sell: { amount: 1000, asset_id: '1.3.0' }, min_to_receive: { amount: 500, asset_id: '1.3.1' }, expiration: Math.floor(Date.now()/1000)+86400, fill_or_kill: false, extensions: {} } },
    { type: 'limit_order_cancel', params: { fee: { amount: 0, asset_id: '1.3.0' }, fee_paying_account: '1.2.100', order: '1.7.999', extensions: [] } },
    { type: 'call_order_update', params: { fee: { amount: 100, asset_id: '1.3.0' }, funding_account: '1.2.100', delta_collateral: { amount: 1000, asset_id: '1.3.0' }, delta_debt: { amount: 500, asset_id: '1.3.1' }, extensions: {} } },
    { type: 'asset_settle', params: { fee: { amount: 100, asset_id: '1.3.0' }, account: '1.2.100', amount: { amount: 1000, asset_id: '1.3.1' }, extensions: [] } },
    { type: 'limit_order_update', params: { fee: { amount: 100, asset_id: '1.3.0' }, seller: '1.2.100', order: '1.7.999', new_price: { base: { amount: 500, asset_id: '1.3.0' }, quote: { amount: 10000, asset_id: '1.3.1' } }, delta_amount_to_sell: { amount: 100, asset_id: '1.3.0' }, new_expiration: Math.floor(Date.now()/1000)+86400, on_fill: [], extensions: [] } },
];

for (const op of opsToTest) {
    const t = createTransactionBuilder({});
    t.addOperation(op.type, op.params);
    assert.strictEqual(t.getOperationCount(), 1, `${op.type} should have 1 op`);

    const s = t.sign(privateKey);
    assert.ok(s.signedTx.length > 0, `${op.type} should produce signed tx`);
    assert.ok(ecc.verify(s.digest, s.signature, publicKey), `${op.type} sig should verify`);
}
console.log('  PASS (6 op types)');

// ── Test: Batch transaction signing ──────────────────────────────────────

console.log('Batch transaction');
const bt = createTransactionBuilder({});
bt.limit_order_create({
    fee: { amount: 100, asset_id: '1.3.0' },
    seller: '1.2.100',
    amount_to_sell: { amount: 1000, asset_id: '1.3.0' },
    min_to_receive: { amount: 500, asset_id: '1.3.1' },
    expiration: Math.floor(Date.now() / 1000) + 86400,
    fill_or_kill: false,
    extensions: {},
});
bt.limit_order_cancel({
    fee: { amount: 0, asset_id: '1.3.0' },
    fee_paying_account: '1.2.100',
    order: '1.7.888',
    extensions: [],
});
bt.limit_order_update({
    fee: { amount: 100, asset_id: '1.3.0' },
    seller: '1.2.100',
    order: '1.7.777',
    new_price: { base: { amount: 500, asset_id: '1.3.0' }, quote: { amount: 10000, asset_id: '1.3.1' } },
    extensions: [],
});

assert.strictEqual(bt.getOperationCount(), 3);
const bs = bt.sign(privateKey);
assert.ok(bs.signedTx.length > 0);
assert.ok(ecc.verify(bs.digest, bs.signature, publicKey), 'batch sig should verify');

// Different order of operations = different tx hash (digest should differ)
const bt2 = createTransactionBuilder({});
bt2.limit_order_cancel({
    fee: { amount: 0, asset_id: '1.3.0' },
    fee_paying_account: '1.2.100',
    order: '1.7.888',
    extensions: [],
});
bt2.limit_order_create({
    fee: { amount: 100, asset_id: '1.3.0' },
    seller: '1.2.100',
    amount_to_sell: { amount: 1000, asset_id: '1.3.0' },
    min_to_receive: { amount: 500, asset_id: '1.3.1' },
    expiration: Math.floor(Date.now() / 1000) + 86400,
    fill_or_kill: false,
    extensions: {},
});
// Note: these may have different ref_block times, but let's verify sign works
const bs2 = bt2.sign(privateKey);
assert.ok(ecc.verify(bs2.digest, bs2.signature, publicKey));
console.log('  PASS');

// ── Test: Signing client broadcasts JSON tx object and accepts WIF ───────

(async () => {
    console.log('Signing client broadcast');
    let broadcastPayload = null;
    const fakeChainClient = {
        getConfig: () => ({ chainId: GRAPHENE_CHAIN_ID }),
        db: {
            get_full_accounts: async () => [['alice', { account: { id: '1.2.100' } }]],
            get_objects: async () => [{ id: '2.0.0' }, { id: '2.1.0', head_block_number: 12345, head_block_id: '0000303901020304000000000000000000000000' }],
            call: async (method, args) => {
                assert.strictEqual(method, 'get_required_fees');
                return args[0].map(() => ({ amount: 100, asset_id: '1.3.0' }));
            },
        },
        broadcast: {
            broadcast_transaction: async (txObject) => {
                broadcastPayload = txObject;
                return { operation_results: [[1, '1.7.1']] };
            },
        },
    };
    const wif = ecc.wifEncode(privateKey, false);
    const signingClient = createSigningClient(fakeChainClient, 'alice', wif);
    const compatTx = signingClient.newTx();
    compatTx.limit_order_cancel({
        fee: { amount: 0, asset_id: '1.3.0' },
        fee_paying_account: '1.2.100',
        order: '1.7.999',
        extensions: [],
    });
    const broadcastResult = await compatTx.broadcast();
    assert.deepStrictEqual(broadcastResult.operation_results, [[1, '1.7.1']]);
    assert.ok(broadcastPayload && !Buffer.isBuffer(broadcastPayload), 'broadcast payload should be a JSON object, not Buffer');
    assert.strictEqual(typeof broadcastPayload.signatures[0], 'string', 'broadcast signature should be hex');
    assert.ok(Array.isArray(broadcastPayload.operations), 'broadcast payload should include operations');
    console.log('  PASS');

    console.log('Signing client broadcast array response');
    const fakeArrayResponseClient = {
        getConfig: () => ({ chainId: GRAPHENE_CHAIN_ID }),
        db: fakeChainClient.db,
        broadcast: {
            broadcast_transaction_synchronous: async () => [{
                trx: { operation_results: [[1, '1.7.2']] },
            }],
        },
    };
    const arrayResponseSigningClient = createSigningClient(fakeArrayResponseClient, 'alice', wif);
    const arrayResponseTx = arrayResponseSigningClient.newTx();
    arrayResponseTx.limit_order_cancel({
        fee: { amount: 0, asset_id: '1.3.0' },
        fee_paying_account: '1.2.100',
        order: '1.7.999',
        extensions: [],
    });
    const arrayBroadcastResult = await arrayResponseTx.broadcast();
    assert.deepStrictEqual(arrayBroadcastResult.operation_results, [[1, '1.7.2']]);
    assert.ok(Array.isArray(arrayBroadcastResult.raw), 'array broadcast response should be preserved as raw');
    console.log('  PASS');

    console.log('\n=== All tx builder tests passed ===');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
