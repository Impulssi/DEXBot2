'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
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

// Shared fixture helper (also used by the CLI start-onboarding tests).
const { writeModernVault } = require('./helpers/vault_fixture');

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

async function testKeySetupDetection() {
    const chainKeys = requireChainKeys();

    assert.strictEqual(chainKeys.hasKeySetup(), false, 'a missing/empty keys file should require key setup');
    assert.strictEqual(
        chainKeys.hasKeySetup({ vaultVersion: 2, accounts: { alice: { encryptedKey: 'key' } } }),
        false,
        'account records without password metadata should not count as key setup'
    );
    assert.strictEqual(
        chainKeys.hasKeySetup({ vaultVersion: 2, vaultSalt: '00', vaultVerifier: '00', accounts: {} }),
        false,
        'a cancelled key setup with only password metadata should require key setup'
    );
    assert.strictEqual(
        chainKeys.hasKeySetup({
            vaultVersion: 2,
            vaultSalt: '00',
            vaultVerifier: '00',
            accounts: { alice: { encryptedKey: 'v2:not-valid' } },
        }),
        false,
        'malformed account records should not count as key setup'
    );

    writeModernVault(keysFile(), 'modern-password', { alice: 'a'.repeat(64) });
    assert.strictEqual(chainKeys.hasKeySetup(), true, 'a modern password-protected vault should count as configured');
}

function testOnboardingUrlResolution() {
    const chainKeys = requireChainKeys();
    const { UPDATER } = require('../modules/constants');
    const localHref = 'file:///shipped/docs/BITSHARES_ONBOARDING.md';

    assert.strictEqual(
        chainKeys.resolveOnboardingUrl(true, localHref),
        localHref,
        'a shipped onboarding document should be linked locally'
    );

    const remote = chainKeys.resolveOnboardingUrl(false, localHref);
    assert.notStrictEqual(remote, localHref, 'a missing local document should fall back to the hosted URL');
    assert.ok(
        remote.startsWith(UPDATER.REPOSITORY_URL.replace(/\.git$/, '')),
        'the hosted fallback should be derived from the canonical repository URL in constants'
    );
    assert.ok(
        remote.endsWith('/docs/BITSHARES_ONBOARDING.md'),
        'the hosted fallback should point at the onboarding document'
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

async function captureConsoleLogs(run) {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.map(String).join(' '));
    try {
        await run();
    } finally {
        console.log = originalLog;
    }
    return logs.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
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
    const logs = await captureConsoleLogs(() => chainKeys.main());
    assert.ok(
        !logs.some((line) => line.includes('New to DEXBot2 and BitShares?')),
        'the onboarding notice should not be shown when the vault already has an account'
    );

    const persisted = requireStorage().readJSON(keysFile());
    assert.strictEqual(persisted.vaultVersion, 2, 'interactive session should keep modern vault metadata');
    assert.ok(persisted.accounts.alice.encryptedKey.startsWith('v2:'), 'existing records should stay in v2 format');
    assert.ok(persisted.accounts.bob.encryptedKey.startsWith('v2:'), 'new records should use v2 encryption');

    const secret = chainKeys.unlockWithPassword(password);
    assert.strictEqual(chainKeys.getPrivateKey('alice', secret), initialPrivateKey, 'existing keys should remain decryptable');
    assert.strictEqual(chainKeys.getPrivateKey('bob', secret), addedPrivateKey, 'new keys should remain decryptable');
    assert.ok(prompts.includes('Enter account name: '), 'test should drive the add-key flow after authentication');
}

async function testExistingPasswordWithNoAccountOpensKeyManager() {
    const password = 'modern-password';
    writeModernVault(keysFile(), password);

    const prompts = installPromptMocks({
        readInputResponses: ['7'],
        readPasswordResponses: [password],
    });

    const chainKeys = requireChainKeys();
    const logs = await captureConsoleLogs(() => chainKeys.main());

    assert.strictEqual(
        prompts.filter((prompt) => prompt === 'Enter master password: ').length,
        1,
        'an existing password should be authenticated once when the vault has no account entries'
    );
    assert.ok(
        !prompts.includes('Confirm master password: '),
        'an existing master password should not be reset when starting key setup'
    );
    const { PATHS } = require('../modules/paths');
    const expectedUrl = pathToFileURL(path.join(PATHS.PROJECT_ROOT, 'docs', 'BITSHARES_ONBOARDING.md')).href;
    assert.ok(
        logs.includes(`New to DEXBot2 and BitShares? Check out:\n${expectedUrl}`),
        'an authenticated empty vault should show the local onboarding link'
    );
}

async function testFirstPasswordWithNoAccountShowsOnboardingLink() {
    const password = 'first-password';
    installPromptMocks({
        readInputResponses: ['7'],
        readPasswordResponses: [password, password],
    });

    const chainKeys = requireChainKeys();
    const logs = await captureConsoleLogs(() => chainKeys.main());
    const { PATHS } = require('../modules/paths');
    const expectedUrl = pathToFileURL(path.join(PATHS.PROJECT_ROOT, 'docs', 'BITSHARES_ONBOARDING.md')).href;

    assert.ok(
        logs.some((line) => line.includes('No master password set. Please set one:')),
        'the initial password prompt should remain unchanged'
    );
    assert.ok(
        logs.includes(`New to DEXBot2 and BitShares? Check out:\n${expectedUrl}`),
        'first-time setup should show the bright-yellow onboarding link for the installed local document'
    );
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
        await testKeySetupDetection();
        testOnboardingUrlResolution();
        await testUnlockWithPasswordOnModernVault();
    },
    interactive_session_persists_modern_state: async () => {
        await testInteractiveSessionPersistsModernState();
    },
    existing_password_without_account: async () => {
        await testExistingPasswordWithNoAccountOpensKeyManager();
    },
    first_password_without_account: async () => {
        await testFirstPasswordWithNoAccountShowsOnboardingLink();
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
