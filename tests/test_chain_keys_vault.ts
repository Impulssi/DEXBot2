'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Env must be set before any require(): Config snapshots process.env at load
// and chain_keys resolves PROFILES_KEYS_FILE from Config at module load.
// Redirecting the keys file keeps every scenario off the developer's real
// profiles/keys.json vault.
process.env.DEXBOT_VAULT_SCRYPT_N = '4096';
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-chain-keys-'));
process.env.DEXBOT_KEYS_FILE = path.join(TEMP_DIR, 'keys.json');

const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');

console.log('Running chain_keys vault tests');

function requireChainKeys() {
    return require('../modules/chain_keys');
}

function requireStorage() {
    return require('../modules/storage').getStorage();
}

function writeModernVault(keysFile, password, accounts = {}) {
    const chainKeys = requireChainKeys();
    const { writeJSON } = requireStorage();
    const vaultSalt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const secret = chainKeys.createVaultSecret(chainKeys.deriveVaultKey(password, vaultSalt));
    const data = {
        vaultVersion: 2,
        vaultSalt: vaultSalt.toString('hex'),
        vaultVerifier: '',
        accounts: {},
    };

    data.vaultVerifier = require('crypto')
        .createHmac('sha256', Buffer.from(secret.vaultKeyHex, 'hex'))
        .update('dexbot2:v2:verifier')
        .digest('hex');

    for (const [name, privateKey] of Object.entries(accounts)) {
        data.accounts[name] = {
            encryptedKey: chainKeys.encrypt(privateKey, secret),
        };
    }

    writeJSON(keysFile, data);
    return secret;
}

function keysFile() {
    return process.env.DEXBOT_KEYS_FILE;
}

function testDerivedVaultRoundtrip() {
    const chainKeys = requireChainKeys();
    const password = 'correct horse battery staple';
    const vaultSalt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const vaultKey1 = chainKeys.deriveVaultKey(password, vaultSalt);
    const vaultKey2 = chainKeys.deriveVaultKey(password, vaultSalt);

    assert.strictEqual(vaultKey1.length, 32, 'derived vault key should be 32 bytes');
    assert.strictEqual(vaultKey1.toString('hex'), vaultKey2.toString('hex'), 'scrypt derivation should be deterministic for the same password and salt');

    const secret = chainKeys.createVaultSecret(vaultKey1);
    assert.strictEqual(chainKeys.isVaultSecret(secret), true, 'derived secret should be recognized');
    assert.strictEqual(typeof secret.vaultKeyHex, 'string', 'secret should carry a hex-encoded vault key');

    const ciphertext = chainKeys.encrypt('5K-example-private-key', secret);
    assert.ok(ciphertext.startsWith('v2:'), 'vault encryption should emit a versioned payload');
    assert.strictEqual(
        chainKeys.decrypt(ciphertext, secret),
        '5K-example-private-key',
        'vault secret should decrypt its own ciphertext'
    );

    const sessionSaltA = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex');
    const sessionSaltB = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const sessionSecretA = chainKeys.createSessionSecret(secret, sessionSaltA);
    const sessionSecretB = chainKeys.createSessionSecret(secret, sessionSaltB);

    assert.strictEqual(sessionSecretA.kind, 'dexbot-session-secret', 'session secret should be tagged as session-only');
    assert.strictEqual(sessionSecretA.sessionSaltHex, sessionSaltA.toString('hex'), 'session secret should expose the salt used for derivation');
    assert.notStrictEqual(sessionSecretA.vaultKeyHex, secret.vaultKeyHex, 'session secret should not reuse the master-derived vault key');
    assert.notStrictEqual(sessionSecretA.vaultKeyHex, sessionSecretB.vaultKeyHex, 'different session salts should produce different session keys');

    const sessionCiphertext = chainKeys.encrypt('5K-session-private-key', sessionSecretA);
    assert.strictEqual(
        chainKeys.decrypt(sessionCiphertext, sessionSecretA),
        '5K-session-private-key',
        'session secret should encrypt and decrypt its own ciphertext'
    );
}

function testLegacyPayloadRejected() {
    const chainKeys = requireChainKeys();
    assert.throws(
        () => chainKeys.decrypt('abcd:abcd:abcd:abcd', { kind: 'dexbot-vault-secret', vaultKeyHex: '00' }),
        /Unsupported encrypted payload version/,
        'legacy ciphertext format should be rejected'
    );
}

function testLegacyVaultRejected() {
    const chainKeys = requireChainKeys();
    assert.throws(
        () => chainKeys.unlockWithPassword('any-password', { accounts: { alice: { encryptedKey: 'x:x:x:x' } } }),
        /Unsupported key vault format/,
        'legacy vault without v2 metadata should be rejected'
    );
}

async function testUnlockWithPasswordOnModernVault() {
    writeModernVault(keysFile(), 'modern-password', { alice: 'a'.repeat(64) });
    const chainKeys = requireChainKeys();

    // unlockWithPassword defaults to loadAccounts(), which reads the env-directed
    // temp keys file — no stdin interaction involved.
    const secret = chainKeys.unlockWithPassword('modern-password');

    assert.strictEqual(
        chainKeys.getPrivateKey('alice', secret),
        'a'.repeat(64),
        'raw password unlock helper should return a usable derived secret'
    );
}

// Interactive scenarios prompt through modules/order/utils/system; compiled
// ESM namespaces are frozen, so stub them via the loader-hook harness. Each
// stage runs in its own child with its own response script.
function installPromptMocks({ readInputResponses, readPasswordResponses }) {
    const prompts = [];
    defineEsmMockAbs(require.resolve('../modules/order/utils/system'), ['readInput', 'readPassword', 'sleep'], {
        readInput: async (prompt) => {
            prompts.push(prompt);
            return readInputResponses.shift() ?? '';
        },
        readPassword: async (prompt) => {
            prompts.push(prompt);
            return readPasswordResponses.shift() ?? '';
        },
        sleep: async () => {},
    });
    return prompts;
}

async function testInteractiveSessionPersistsModernState() {
    const password = 'modern-password';
    const initialPrivateKey = 'b'.repeat(64);
    const addedPrivateKey = 'a'.repeat(64);
    writeModernVault(keysFile(), password, { alice: initialPrivateKey });

    const readInputResponses = ['1', 'bob', ''];
    const readPasswordResponses = [password, addedPrivateKey];
    const prompts = installPromptMocks({ readInputResponses, readPasswordResponses });

    const chainKeys = requireChainKeys();
    await chainKeys.main();

    const persisted = requireStorage().readJSON(keysFile());
    assert.strictEqual(persisted.vaultVersion, 2, 'interactive session should keep modern vault metadata');
    assert.ok(persisted.accounts.alice.encryptedKey.startsWith('v2:'), 'existing records should stay in v2 format');
    assert.ok(persisted.accounts.bob.encryptedKey.startsWith('v2:'), 'new records should use v2 encryption');

    const secret = chainKeys.unlockWithPassword(password);
    assert.strictEqual(chainKeys.getPrivateKey('alice', secret), initialPrivateKey, 'existing keys should remain decryptable');
    assert.strictEqual(chainKeys.getPrivateKey('bob', secret), addedPrivateKey, 'new keys should remain decryptable');
    assert.ok(prompts.includes('Enter account name: '), 'test should drive the add-key flow after authentication');
}

async function testChangePasswordRequiresCurrentPasswordPrompt() {
    const password = 'modern-password';
    const privateKey = 'c'.repeat(64);
    writeModernVault(keysFile(), password, { alice: privateKey });

    const readInputResponses = ['6', ''];
    const readPasswordResponses = [password, 'wrong-current-password', 'new-password', 'new-password'];
    const prompts = installPromptMocks({ readInputResponses, readPasswordResponses });

    const chainKeys = requireChainKeys();
    await chainKeys.main();

    assert.strictEqual(
        prompts.filter((prompt) => prompt === 'Enter current master password: ').length,
        1,
        'changing the master password should always require the current password'
    );

    const secret = chainKeys.unlockWithPassword(password);
    assert.strictEqual(
        chainKeys.getPrivateKey('alice', secret),
        privateKey,
        'failed password change should leave the stored key readable with the original password'
    );
}

const STAGES = {
    pure_and_unlock: async () => {
        testDerivedVaultRoundtrip();
        testLegacyPayloadRejected();
        testLegacyVaultRejected();
        await testUnlockWithPasswordOnModernVault();
    },
    interactive_session_persists_modern_state: async () => {
        await testInteractiveSessionPersistsModernState();
    },
    change_password_requires_current_password_prompt: async () => {
        await testChangePasswordRequiresCurrentPasswordPrompt();
    },
};

try {
    runEsmMockStages(Object.keys(STAGES), (stage) => STAGES[stage]());
} finally {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}
