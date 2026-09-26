'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * Shared fixture: write a genuine modern (v2) key vault.
 *
 * Mirrors the exact format modules/chain_keys.ts produces (scrypt-derived
 * vault key + HMAC verifier) so tests exercising vault-gated code paths
 * (CLI start onboarding, unlock) run against realistic data instead of
 * hand-crafted placeholder metadata.
 *
 * Set DEXBOT_VAULT_SCRYPT_N (e.g. '4096') before the first require() of
 * modules/chain_keys so scrypt derivation stays cheap in tests.
 *
 * Returns the vault secret (see chain_keys.createVaultSecret).
 */
function writeModernVault(keysFile, password, accounts = {}) {
    const chainKeys = require('../../modules/chain_keys');
    const { writeJSON } = require('../../modules/storage').getStorage();
    const vaultSalt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const secret = chainKeys.createVaultSecret(chainKeys.deriveVaultKey(password, vaultSalt));
    const data = {
        vaultVersion: 2,
        vaultSalt: vaultSalt.toString('hex'),
        vaultVerifier: '',
        accounts: {},
    };

    data.vaultVerifier = crypto
        .createHmac('sha256', Buffer.from(secret.vaultKeyHex, 'hex'))
        .update('dexbot2:v2:verifier')
        .digest('hex');

    for (const [name, privateKey] of Object.entries(accounts)) {
        data.accounts[name] = {
            encryptedKey: chainKeys.encrypt(privateKey, secret),
        };
    }

    writeJSON(keysFile, data);
    // writeJSON's atomic tmp+rename does not carry a file mode; enforce the
    // 0600 that checkKeysFileSecurity (run at dexbot startup) expects.
    fs.chmodSync(keysFile, 0o600);
    return secret;
}

module.exports = { writeModernVault };
