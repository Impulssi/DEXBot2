const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Lower scrypt cost for tests — chain_keys.ts reads this at module load, so it
// must be set before the require() below (config caching trap).
process.env.DEXBOT_VAULT_SCRYPT_N = '4096';
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');
const { Config } = require('../modules/config');

console.log('Running chain_keys vault tests');

const chainKeys = require('../modules/chain_keys');
const { readJSON, writeJSON } = require('../modules/storage').getStorage();

function writeModernVault(keysFile, password, accounts = {}) {
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



async function withTempKeysFile(runTest) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-chain-keys-'));
    const keysFile = path.join(tempDir, 'keys.json');
    const originalKeysFile = process.env.DEXBOT_KEYS_FILE;
    const originalConfigKeysFile = Config.DEXBOT_KEYS_FILE;

    process.env.DEXBOT_KEYS_FILE = keysFile;
    Config.DEXBOT_KEYS_FILE = keysFile;

    try {
        await runTest(keysFile);
    } finally {
        if (typeof originalKeysFile === 'string') {
            process.env.DEXBOT_KEYS_FILE = originalKeysFile;
        } else {
            delete process.env.DEXBOT_KEYS_FILE;
        }
        Config.DEXBOT_KEYS_FILE = originalConfigKeysFile;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function loadIsolatedChainKeys({ readInput, readPassword }) {
    const chainKeysPath = require.resolve('../modules/chain_keys');
    const systemPath = require.resolve('../modules/order/utils/system');
    const originalChainKeys = require.cache[chainKeysPath];
    const originalSystem = setCachedModule(systemPath, {
        readInput,
        readPassword,
    });

    delete require.cache[chainKeysPath];

    try {
        const isolatedChainKeys = require('../modules/chain_keys');
        return {
            chainKeys: isolatedChainKeys,
            restore() {
                restoreCachedModule(chainKeysPath, originalChainKeys);
                restoreCachedModule(systemPath, originalSystem);
            },
        };
    } catch (error) {
        restoreCachedModule(chainKeysPath, originalChainKeys);
        restoreCachedModule(systemPath, originalSystem);
        throw error;
    }
}

function testDerivedVaultRoundtrip() {
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
    assert.throws(
        () => chainKeys.decrypt('abcd:abcd:abcd:abcd', { kind: 'dexbot-vault-secret', vaultKeyHex: '00' }),
        /Legacy encrypted data requires migration before decrypt/,
        'legacy ciphertext format should be rejected'
    );
}

function testLegacyVaultRejected() {
    assert.throws(
        () => chainKeys.unlockWithPassword('any-password', { accounts: { alice: { encryptedKey: 'x:x:x:x' } } }),
        /Unsupported key vault format/,
        'legacy vault without v2 metadata should be rejected'
    );
}



async function testUnlockWithPasswordOnModernVault() {
    await withTempKeysFile(async (keysFile) => {
        writeModernVault(keysFile, 'modern-password', { alice: 'a'.repeat(64) });
        const { chainKeys: isolatedChainKeys, restore } = loadIsolatedChainKeys({
            readInput: async () => '',
            readPassword: async () => '',
        });

        try {
            const secret = isolatedChainKeys.unlockWithPassword('modern-password');

            assert.strictEqual(
                isolatedChainKeys.getPrivateKey('alice', secret),
                'a'.repeat(64),
                'raw password unlock helper should return a usable derived secret'
            );
        } finally {
            restore();
        }
    });
}

async function testInteractiveSessionPersistsModernState() {
    await withTempKeysFile(async (keysFile) => {
        const password = 'modern-password';
        const initialPrivateKey = 'b'.repeat(64);
        const addedPrivateKey = 'a'.repeat(64);
        writeModernVault(keysFile, password, { alice: initialPrivateKey });

        const readInputResponses = ['1', 'bob', ''];
        const readPasswordResponses = [password, addedPrivateKey];
        const prompts = [];
        const { chainKeys: isolatedChainKeys, restore } = loadIsolatedChainKeys({
            readInput: async (prompt) => {
                prompts.push(prompt);
                return readInputResponses.shift() ?? '';
            },
            readPassword: async (prompt) => {
                prompts.push(prompt);
                return readPasswordResponses.shift() ?? '';
            },
        });

        try {
            await isolatedChainKeys.main();

            const persisted = readJSON(keysFile);
            assert.strictEqual(persisted.vaultVersion, 2, 'interactive session should keep modern vault metadata');
            assert.ok(persisted.accounts.alice.encryptedKey.startsWith('v2:'), 'existing records should stay in v2 format');
            assert.ok(persisted.accounts.bob.encryptedKey.startsWith('v2:'), 'new records should use v2 encryption');

            const secret = isolatedChainKeys.unlockWithPassword(password);
            assert.strictEqual(isolatedChainKeys.getPrivateKey('alice', secret), initialPrivateKey, 'existing keys should remain decryptable');
            assert.strictEqual(isolatedChainKeys.getPrivateKey('bob', secret), addedPrivateKey, 'new keys should remain decryptable');
            assert.ok(prompts.includes('Enter account name: '), 'test should drive the add-key flow after authentication');
        } finally {
            restore();
        }
    });
}

async function testChangePasswordRequiresCurrentPasswordPrompt() {
    await withTempKeysFile(async (keysFile) => {
        const password = 'modern-password';
        const privateKey = 'c'.repeat(64);
        writeModernVault(keysFile, password, { alice: privateKey });

        const readInputResponses = ['6', ''];
        const readPasswordResponses = [password, 'wrong-current-password', 'new-password', 'new-password'];
        const prompts = [];
        const { chainKeys: isolatedChainKeys, restore } = loadIsolatedChainKeys({
            readInput: async (prompt) => {
                prompts.push(prompt);
                return readInputResponses.shift() ?? '';
            },
            readPassword: async (prompt) => {
                prompts.push(prompt);
                return readPasswordResponses.shift() ?? '';
            },
        });

        try {
            await isolatedChainKeys.main();

            assert.strictEqual(
                prompts.filter((prompt) => prompt === 'Enter current master password: ').length,
                1,
                'changing the master password should always require the current password'
            );

            const secret = isolatedChainKeys.unlockWithPassword(password);
            assert.strictEqual(
                isolatedChainKeys.getPrivateKey('alice', secret),
                privateKey,
                'failed password change should leave the stored key readable with the original password'
            );
        } finally {
            restore();
        }
    });
}

testDerivedVaultRoundtrip();
testLegacyPayloadRejected();
testLegacyVaultRejected();
Promise.resolve()
    .then(testUnlockWithPasswordOnModernVault)
    .then(testInteractiveSessionPersistsModernState)
    .then(testChangePasswordRequiresCurrentPasswordPrompt)
    .then(() => {
        console.log('chain_keys vault tests passed');
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
