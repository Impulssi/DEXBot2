/**
 * modules/chain_keys.ts - Authentication and Key Management
 *
 * Secure storage and management of BitShares private keys.
 * Provides authentication, key storage, and transaction signing capabilities.
 *
 * Features:
 * - Master password authentication with derived vault-key verification
 * - AES-256-GCM encryption with random salt and IV
 * - Private key retrieval for transaction signing
 * - Interactive CLI for key management (add/modify/remove)
 * - Daemon readiness checking
 *
 * Storage: profiles/keys.json (gitignored, never committed)
 *
 * Supported key formats:
 * - WIF (Wallet Import Format): 51-52 character Base58Check encoded
 * - PVT_K1_* style keys used by some Graphene chains
 * - Raw 64-character hexadecimal private keys
 *
 * Security: Master password never stored; only a derived vault key is kept in memory.
 * All newly written private keys use the v2 vault format.
 *
 * ===============================================================================
 * EXPORTS (13 functions + 1 error class)
 * ===============================================================================
 *
 * AUTHENTICATION (1 function)
 *   1. authenticate() - Authenticate and return a derived vault secret (async)
 *      Prompts user for password, verifies vault metadata
 *      Throws MasterPasswordError on failure
 *
 * KEY MANAGEMENT (3 functions)
 *   2. getPrivateKey(accountName, vaultSecret) - Get private key for account
 *      Returns decrypted private key string
 *      Throws Error if account not found
 *
 *   3. main() - Interactive CLI for key management (async)
 *      Add/modify/remove keys from storage
 *      Re-encrypts entire key store
 *
 *   4. validatePrivateKey(key) - Validate private key format
 *
 * CRYPTO HELPERS (7 functions)
 *   5. encrypt(text, secret) - AES-256-GCM encryption
 *   6. decrypt(encryptedHex, secret) - AES-256-GCM decryption
 *   7. deriveVaultKey(password, vaultSalt) - Derive the session vault key
 *   8. deriveSessionSecret(vaultSecret, sessionSalt) - Derive a session-only signing key
 *   9. loadAccounts() - Load accounts from keys.json
 *  10. saveAccounts(data) - Save accounts to keys.json
 *  11. createVaultSecret(...) - Build a serializable derived secret object
 *
 * DAEMON (5 functions)
 *  10. isDaemonReady() - Check if credential daemon is ready
 *  11. isDaemonResponsive() - Check if daemon is responsive
 *  12. waitForDaemon(timeoutMs) - Wait for daemon to become ready (async)
 *  13. probeAccountInDaemon(accountName) - Probe daemon for account (async)
 *  14. pingDaemon(accountName) - Lightweight daemon health check (async)
 *
 * ERROR HANDLING (1 error class)
 *  14. MasterPasswordError - Thrown when authentication fails
 *
 * ===============================================================================
 *
 * KEY STORAGE STRUCTURE (profiles/keys.json):
 * {
 *   "vaultVersion": 2,
 *   "vaultSalt": "hex-salt",
 *   "vaultVerifier": "hex-hmac",
 *   "accounts": {
 *     "accountName": "v2:recordSalt:iv:authTag:ciphertext"
 *   }
 * }
 *
 * ENCRYPTION PROCESS:
 * 1. Generate random vault salt (16 bytes) and derive a vault key with scrypt
 * 2. Derive a per-record key from the vault key with HKDF and a record salt
 * 3. Encrypt private key with AES-256-GCM and a 12-byte IV
 * 4. Store: v2:recordSalt:iv:authTag:ciphertext
 *
 * ===============================================================================
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { path } from './path_api.js';
import { readInput, readPassword, sleep } from './order/utils/system.js';
import { TIMING, CREDENTIAL_PROMPTS } from './constants.js';
import { PATHS } from './paths.js';

import { getStorage } from './storage/index.js';
import { sendSocketJsonRequest } from './socket_json_client.js';
import { resolvePrivateKey as resolveAuthKey } from './authority_resolver.js';
import { Config } from './config.js';
import * as base58check from './utils/base58check.js';
import {
    randomBytes,
    hkdfSync,
    scryptSync,
    createHmac,
    timingSafeEqual,
    createCipheriv,
    createDecipheriv,
} from './crypto/sync.js';

let _net: any;
function getNet(): any {
    if (_net === undefined) {
        try {
            _net = require('net');
        } catch {
            _net = null;
        }
    }
    if (!_net) {
        throw new Error('Unix socket IPC not available in this environment');
    }
    return _net;
}
import {
    getCredentialReadyFilePath,
    getCredentialSocketPath,
    assertPrivatePathSecurity,
} from './credential_runtime.js';
import { getErrorMessage } from './utils/errors.js';
import { hasProcess } from './env.js';
const storage = getStorage();
const { ensureDir } = storage;

const VAULT_VERSION = 2;
const VAULT_SALT_BYTES = 16;
const VAULT_RECORD_SALT_BYTES = 16;
const VAULT_IV_BYTES = 12;
const VAULT_KEY_BYTES = 32;
// Test-only override: allow tests to lower the scrypt cost so they don't burn
// ~0.5-1s of CPU per derivation with the production N=2^17. Production keeps the
// strong default; only DEXBOT_VAULT_SCRYPT_N (or a small N) lowers it.
const _vaultScryptNOverride = (() => {
    try {
        if (!hasProcess()) return undefined;
        const raw = process.env?.DEXBOT_VAULT_SCRYPT_N;
        if (!raw) return undefined;
        const n = Number(raw);
        return Number.isInteger(n) && n >= 2 && n <= 2 ** 20 ? n : undefined;
    } catch {
        return undefined;
    }
})();
const VAULT_SCRYPT_PARAMS = Object.freeze({
    N: _vaultScryptNOverride ?? 2 ** 17,
    r: 8,
    p: 1,
    // 128 * N * r bytes plus headroom for Node/OpenSSL overhead.
    maxmem: 256 * 1024 * 1024,
});
const VAULT_RECORD_INFO = Buffer.from('dexbot2:v2:record-key', 'utf8');
const VAULT_SESSION_INFO = Buffer.from('dexbot2:v2:session-key', 'utf8');
const VAULT_VERIFIER_LABEL = 'dexbot2:v2:verifier';
const VAULT_SECRET_KIND = 'dexbot-vault-secret';
const VAULT_SESSION_SECRET_KIND = 'dexbot-session-secret';
const VAULT_DAEMON_SIGNING_TOKEN_KIND = 'dexbot-daemon-signing-token';


// Profiles key file (ignored) only
const PROFILES_KEYS_FILE = Config.DEXBOT_KEYS_FILE
    ? path.resolve(Config.DEXBOT_KEYS_FILE)
    : PATHS.PROFILES.KEYS_JSON();

/**
 * Ensures that the profiles/keys directory exists.
 * @private
 */
function ensureProfilesKeysDirectory() {
    const dir = path.dirname(PROFILES_KEYS_FILE);
    ensureDir(dir);
}

function toBuffer(value: any, encoding: BufferEncoding = 'hex') {
    if (Buffer.isBuffer(value)) {
        return Buffer.from(value);
    }
    if (typeof value === 'string' && value.length > 0) {
        return Buffer.from(value, encoding);
    }
    return null;
}

function isVaultSecret(value: any) {
    return !!(value && typeof value === 'object' && value.kind === VAULT_SECRET_KIND);
}

function resolveVaultKey(secret: any) {
    if (!secret) return null;
    if (Buffer.isBuffer(secret)) {
        return Buffer.from(secret);
    }
    if (isVaultSecret(secret) && typeof secret.vaultKeyHex === 'string') {
        return toBuffer(secret.vaultKeyHex);
    }
    if (typeof secret === 'object' && typeof secret.vaultKeyHex === 'string') {
        return toBuffer(secret.vaultKeyHex);
    }
    if (typeof secret === 'object' && Buffer.isBuffer(secret.vaultKey)) {
        return Buffer.from(secret.vaultKey);
    }
    return null;
}

function createVaultSecret(vaultKey: any, extra: Record<string, any> = {}) {
    const keyBuffer = resolveVaultKey(vaultKey);
    if (!keyBuffer) {
        throw new Error('Vault secret requires a derived key');
    }
    return {
        kind: VAULT_SECRET_KIND,
        version: extra.version || VAULT_VERSION,
        vaultKeyHex: keyBuffer.toString('hex'),
    };
}

function createSessionSecret(vaultKey: any, sessionSalt: any = randomBytes(VAULT_SALT_BYTES)) {
    const keyBuffer = resolveVaultKey(vaultKey);
    const saltBuffer = toBuffer(sessionSalt);
    if (!keyBuffer || !saltBuffer) {
        throw new Error('Vault secret and session salt are required');
    }

    const sessionKey = Buffer.from(
        hkdfSync('sha256', keyBuffer, saltBuffer, VAULT_SESSION_INFO, VAULT_KEY_BYTES)
    );

    return {
        kind: VAULT_SESSION_SECRET_KIND,
        version: VAULT_VERSION,
        sessionSaltHex: saltBuffer.toString('hex'),
        vaultKeyHex: sessionKey.toString('hex'),
    };
}

function createDaemonSigningToken(accountName: string, options: Record<string, any> = {}) {
    if (!accountName || typeof accountName !== 'string') {
        throw new Error('accountName is required for daemon signing');
    }

    return {
        kind: VAULT_DAEMON_SIGNING_TOKEN_KIND,
        accountName,
        socketPath: options.socketPath || getCredentialSocketPath(options),
        sessionId: options.sessionId || null,
        botHmacSecret: options.botHmacSecret || null,
    };
}

function isDaemonSigningToken(value: any) {
    return !!(value && typeof value === 'object' && value.kind === VAULT_DAEMON_SIGNING_TOKEN_KIND && typeof value.accountName === 'string');
}

function deriveVaultKey(password: any, vaultSalt: any) {
    const saltBuffer = toBuffer(vaultSalt) || randomBytes(VAULT_SALT_BYTES);
    return scryptSync(password, saltBuffer, VAULT_KEY_BYTES, VAULT_SCRYPT_PARAMS);
}

function deriveRecordKey(vaultKey: any, recordSalt: any) {
    const keyBuffer = resolveVaultKey(vaultKey);
    const saltBuffer = toBuffer(recordSalt);
    if (!keyBuffer || !saltBuffer) {
        throw new Error('Vault key and record salt are required');
    }
    return Buffer.from(hkdfSync('sha256', keyBuffer, saltBuffer, VAULT_RECORD_INFO, VAULT_KEY_BYTES));
}

function createVaultVerifier(vaultKey: any) {
    const keyBuffer = resolveVaultKey(vaultKey);
    if (!keyBuffer) {
        throw new Error('Vault key is required');
    }
    return createHmac('sha256', keyBuffer).update(VAULT_VERIFIER_LABEL).digest('hex');
}

function timingSafeEqualHex(leftHex: any, rightHex: any) {
    if (typeof leftHex !== 'string' || typeof rightHex !== 'string' || leftHex.length !== rightHex.length) {
        return false;
    }
    const left = Buffer.from(leftHex, 'hex');
    const right = Buffer.from(rightHex, 'hex');
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}

function normalizeAccountsData(data: Record<string, any> = {}) {
    const accountsSource = data.accounts && typeof data.accounts === 'object'
        ? data.accounts
        : {};

    return {
        vaultVersion: Number(data.vaultVersion) || 0,
        vaultSalt: typeof data.vaultSalt === 'string' ? data.vaultSalt : '',
        vaultVerifier: typeof data.vaultVerifier === 'string' ? data.vaultVerifier : '',
        accounts: accountsSource,
    };
}

function hasModernVault(accountsData: any) {
    return !!(
        accountsData
        && accountsData.vaultVersion === VAULT_VERSION
        && typeof accountsData.vaultSalt === 'string'
        && accountsData.vaultSalt.length > 0
        && typeof accountsData.vaultVerifier === 'string'
        && accountsData.vaultVerifier.length > 0
    );
}

function deriveModernSecretFromPassword(password: any, accountsData: any) {
    if (!hasModernVault(accountsData)) {
        throw new Error('Vault metadata missing');
    }
    const vaultSalt = toBuffer(accountsData.vaultSalt);
    const vaultKey = deriveVaultKey(password, vaultSalt);
    return createVaultSecret(vaultKey);
}

function verifyModernPassword(password: any, accountsData: any) {
    if (!hasModernVault(accountsData)) {
        return false;
    }
    const secret = deriveModernSecretFromPassword(password, accountsData);
    return timingSafeEqualHex(createVaultVerifier(secret), accountsData.vaultVerifier);
}

/**
 * Encrypt text using the v2 AES-256-GCM vault format.
 * @param {string} text - Plain text to encrypt
 * @param {Object|Buffer} secret - Derived vault secret
 * @returns {string} Encrypted data as hex string
 */
function encrypt(text: any, secret: any) {
    const vaultKey = resolveVaultKey(secret);
    if (!vaultKey) {
        throw new Error('A derived vault secret is required to encrypt v2 key data');
    }

    const salt = randomBytes(VAULT_RECORD_SALT_BYTES);
    const key = deriveRecordKey(vaultKey, salt);
    const iv = randomBytes(VAULT_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return 'v2:' + salt.toString('hex') + ':' + iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt text encrypted with the encrypt() function.
 * @param {string} encrypted - Colon-separated encrypted data
 * @param {Object|Buffer} secret - Derived vault secret
 * @returns {string} Decrypted plain text
 * @throws {Error} If decryption fails (wrong password or corrupted data)
 */
function decrypt(encrypted: any, secret: any) {
    const parts = String(encrypted || '').split(':');
    if (parts.length !== 5 || parts[0] !== 'v2') {
        throw new Error('Unsupported encrypted payload version');
    }

    const salt = toBuffer(parts[1]);
    const iv = toBuffer(parts[2]);
    const authTag = toBuffer(parts[3]);
    const encryptedText = parts[4];
    if (!salt || !iv || !authTag || typeof encryptedText !== 'string') {
        throw new Error('Invalid encrypted payload');
    }

    const vaultKey = resolveVaultKey(secret);
    if (!vaultKey) {
        throw new Error('A derived vault secret is required to decrypt v2 key data');
    }
    const key = deriveRecordKey(vaultKey, salt);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}


/**
 * Validate a private key format.
 * Supports WIF (Base58Check), PVT_K1_* style, and 64-char hex.
 * @param {string} key - Private key to validate
 * @returns {Object} { valid: boolean, reason?: string }
 */
function validatePrivateKey(key: any) {
    if (!key || typeof key !== 'string') return { valid: false, reason: 'Empty key' };
    const k = key.trim();

    // Strict WIF validation using base58check decode (verifies checksum & structure)
    try {
        // Base58Check decode throws if checksum or characters are invalid.
        const payload = base58check.decode(k);
        // WIFs for Bitcoin-style keys use 0x80 version byte and payload lengths 33 or 34
        // Uncompressed WIF payload: [0x80 | 32-byte privkey]
        // Compressed WIF payload: [0x80 | 32-byte privkey | 0x01]
        if (payload && payload.length >= 33) {
            // version is first byte
            const version = payload[0];
            if (version === 0x80) {
                // valid WIF format
                // payload length 33 (no compression byte) => uncompressed, 34 => compressed
                if (payload.length === 33 || payload.length === 34) {
                    return { valid: true };
                }
            }
        }
    } catch (err: any) {
        // Not a valid base58check WIF; continue to other formats
    }

    // PVT-style private key used by some Graphene-based chains (e.g. PVT_K1_<data>)
    // Strip prefix and base58check-decode to verify checksum and payload length.
    // This catches typos before the key is encrypted to disk.
    if (/^PVT_(?:K1_)?[A-Za-z0-9_-]+$/.test(k)) {
        try {
            const stripped = k.replace(/^PVT_(?:K1_)?/, '');
            const payload = base58check.decode(stripped);
            if (payload && payload.length === 32) {
                return { valid: true };
            }
            // Graphene PVT_K1_ keys are 32 bytes of key material
            return { valid: false, reason: `PVT_K1_ key decoded to ${payload.length} bytes, expected 32` };
        } catch (err: any) {
            return { valid: false, reason: `PVT_K1_ key has invalid base58check encoding: ${getErrorMessage(err)}` };
        }
    }

    // Hex private key (64 hex chars) - accept optionally
    if (/^[0-9a-fA-F]{64}$/.test(k)) {
        return { valid: true };
    }

    return { valid: false, reason: 'Unrecognized key format' };
}

/**
 * Load stored accounts from profiles/keys.json.
 * Returns empty structure if file doesn't exist or is corrupted.
 * @returns {Object} { vaultVersion: number, vaultSalt: string, vaultVerifier: string, accounts: Object }
 */
function loadAccounts() {
    try {
        return normalizeAccountsData(storage.readJSON(PROFILES_KEYS_FILE));
    } catch (error: any) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
            console.error('Error loading accounts file, resetting to default:', getErrorMessage(error));
        }
        return normalizeAccountsData();
    }
}

function setupModernVault(accountsData: any, password: any) {
    const vaultSalt = randomBytes(VAULT_SALT_BYTES);
    const vaultKey = deriveVaultKey(password, vaultSalt);
    accountsData.vaultVersion = VAULT_VERSION;
    accountsData.vaultSalt = vaultSalt.toString('hex');
    accountsData.vaultVerifier = createVaultVerifier(vaultKey);
    return createVaultSecret(vaultKey);
}

/**
 * Check that the keys file has restrictive permissions (0o600) and is owned by
 * the current user.  Returns silently if the file doesn't exist yet (it will be
 * created correctly by saveAccounts).
 *
 * Fails closed on any violation (world-readable mode, symlink, wrong owner).
 * Should be called early in every entry point that may read or write keys.json.
 */
function checkKeysFileSecurity() {
    if (!storage.exists(PROFILES_KEYS_FILE)) return;
    assertPrivatePathSecurity(PROFILES_KEYS_FILE, { expectedType: 'file', requiredMode: 0o600 });
}

/**
 * Unlock the key vault with a master password.
 * Uses modern scrypt v2 vault format with HMAC verification.
 * @param {string} password - Master password
 * @param {import('./types.js').KeysFile} [accountsData=loadAccounts()] - Accounts data object
 * @returns {import('./types.js').VaultSecret} Derived vault secret
 * @throws {MasterPasswordError} If password is incorrect
 * @throws {Error} If vault format is unsupported
 */
function unlockWithPassword(password: any, accountsData: any = loadAccounts()) {
    if (!hasModernVault(accountsData)) {
        if (Object.keys(accountsData.accounts || {}).length > 0) {
            throw new Error('Unsupported key vault format. Recreate profiles/keys.json with the current key manager.');
        }
        throw new Error('No master password set. Please run modules/chain_keys.ts first.');
    }

    if (!verifyModernPassword(password, accountsData)) {
        throw new MasterPasswordError('Incorrect master password.');
    }
    return deriveModernSecretFromPassword(password, accountsData);
}

function verifyCurrentPassword(password: any, accountsData: any) {
    return hasModernVault(accountsData) && verifyModernPassword(password, accountsData);
}

class MasterPasswordError extends Error {
    static code = 'MASTER_PASSWORD_FAILED';
    code: string;
    constructor(message: string) {
        super(message);
        this.name = 'MasterPasswordError';
        this.code = MasterPasswordError.code;
    }
}

/**
 * Check if an error is a master password authentication failure.
 * @param {Error} err - Error to check
 * @returns {boolean} True if the error indicates a master password failure
 */
function isMasterPasswordFailure(err: any) {
    return !!(err && (err instanceof MasterPasswordError || err.code === MasterPasswordError.code));
}

const MASTER_PASSWORD_MAX_ATTEMPTS = CREDENTIAL_PROMPTS.MAX_MASTER_PASSWORD_ATTEMPTS;
let masterPasswordAttempts = 0;

/**
 * Prompts the user for the master password with retry tracking.
 * @returns {Promise<string>} The entered password.
 * @throws {MasterPasswordError} If max attempts are reached.
 * @private
 */
async function _promptPassword() {
    if (masterPasswordAttempts >= MASTER_PASSWORD_MAX_ATTEMPTS) {
        throw new MasterPasswordError(`Incorrect master password after ${MASTER_PASSWORD_MAX_ATTEMPTS} attempts.`);
    }
    masterPasswordAttempts += 1;
    // Use readPassword instead of readlineSync to support Delete key and consistent masking
    return await readPassword('Enter master password: ');
}

/**
 * Authenticate and return a derived vault secret.
 * Prompts user interactively with limited retry attempts.
 * @returns {Promise<Object>} The verified vault secret
 * @throws {Error} If no master password is set
 * @throws {MasterPasswordError} If max attempts exceeded
 */
async function authenticate() {
    const accountsData = loadAccounts();
    try {
        while (true) {
            // Enforce the attempt limit at the top of the loop as well as inside
            // _promptPassword. _promptPassword also checks the limit so that
            // any other future caller (or a refactor that removes the check
            // here) cannot accidentally produce an infinite prompt loop. This
            // explicit check is the authoritative exit path.
            if (masterPasswordAttempts >= MASTER_PASSWORD_MAX_ATTEMPTS) {
                throw new MasterPasswordError(`Incorrect master password after ${MASTER_PASSWORD_MAX_ATTEMPTS} attempts.`);
            }
            const enteredPassword = await _promptPassword();
            try {
                const secret = unlockWithPassword(enteredPassword, accountsData);
                masterPasswordAttempts = 0;
                return secret;
            } catch (error: any) {
                if (!(error instanceof MasterPasswordError)) {
                    throw error;
                }
            }

            console.log('Master password not correct. Please try again.');
        }
    } catch (err: any) {
        if (err instanceof MasterPasswordError) {
            masterPasswordAttempts = 0;
        }
        throw err;
    }
}

/**
 * Retrieve and decrypt a stored private key.
 * @param {string} accountName - Name of the account
 * @param {Object|Buffer} vaultSecret - Derived vault secret
 * @returns {string} Decrypted private key
 * @throws {Error} If account not found
 */
function getPrivateKey(accountName: any, vaultSecret: any) {
    const accountsData = loadAccounts();
    const account = accountsData.accounts[accountName];
    if (!account) {
        throw new Error(`Account '${accountName}' not found.`);
    }

    return decrypt(account.encryptedKey, vaultSecret);
}

/**
 * Resolve a signing key for an account, following on-chain authority structures
 * (account_auths, key_auths) when no direct key is stored.
 *
 * @param {string} accountName - Target account to sign for
 * @param {Object|Buffer} vaultSecret - Derived vault secret
 * @param {object} chainClient - Native chain client with db.get_full_accounts
 * @returns {Promise<string>} Private key WIF string
 * @throws {Error} If no key can be found through direct lookup or authority resolution
 */
async function resolvePrivateKey(accountName: any, vaultSecret: any, chainClient: any) {
    const pubKeyCache = new Map();

    const tryGetKey = async (name: any) => {
        try {
            return getPrivateKey(name, vaultSecret);
        } catch (e) {
            return null;
        }
    };

    const listNames = () => {
        try {
            const data = loadAccounts();
            return data && data.accounts ? Object.keys(data.accounts) : [];
        } catch (e) {
            return [];
        }
    };

    return resolveAuthKey(accountName, chainClient, tryGetKey, listNames, 0, pubKeyCache);
}
/**
 * Display stored account names to console.
 * @param {Object} accounts - Accounts object from loadAccounts()
 * @returns {Array<string>} Array of account names
 */
function listKeyNames(accounts: any) {
    if (!accounts || Object.keys(accounts).length === 0) {
        console.log('  (no accounts stored yet)');
        return [];
    }
    console.log('Stored keys:');
    return Object.keys(accounts).map((name: any, index: any) => {
        console.log(`  ${index + 1}. ${name}`);
        return name;
    });
}

/**
 * Prompts the user to select an account name from the stored keys.
 * @param {Object} accounts - The accounts object.
 * @param {string} promptText - The prompt message to display.
 * @returns {Promise<string|null>} The selected account name, or null/ESC.
 */
async function selectKeyName(accounts: any, promptText: any) {
    const names = Object.keys(accounts);
    if (!names.length) {
        console.log('No accounts available to select.');
        return null;
    }
    names.forEach((name: any, index: any) => console.log(`  ${index + 1}. ${name}`));
    const raw = (await readInput(`${promptText} [1-${names.length}]: `)).trim();
    if (raw === '\x1b') return '\x1b';

    const idx = Number(raw) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= names.length) {
        if (raw !== '') console.log('Invalid selection.');
        return null;
    }
    return names[idx];
}

/**
 * Interactively changes the master password and re-encrypts all stored keys.
 * @param {Object} accountsData - The loaded accounts data object.
 * @param {Object|Buffer|null} currentSecret - The current derived secret.
 * @returns {Promise<Object|Buffer|null>} The new vault secret, or the old one if failed/cancelled.
 */
async function changeMasterPassword(accountsData: any, currentSecret: any) {
    if (!hasModernVault(accountsData)) {
        console.log('No master password is set yet.');
        return currentSecret;
    }

    const oldPassword = await readPassword('Enter current master password: ');
    if (oldPassword === '\x1b') return currentSecret;

    if (!verifyCurrentPassword(oldPassword, accountsData)) {
        console.log('Incorrect master password!');
        return currentSecret;
    }

    const oldSecret = deriveModernSecretFromPassword(oldPassword, accountsData);

    const newPassword = await readPassword('Enter new master password:     ');
    if (newPassword === '\x1b') return currentSecret;

    const confirmPassword = await readPassword('Confirm new master password:   ');
    if (confirmPassword === '\x1b') return currentSecret;

    if (newPassword !== confirmPassword) {
        console.log('Passwords do not match!');
        return currentSecret;
    }
    if (!newPassword) {
        console.log('New master password cannot be empty.');
        return currentSecret;
    }

    const decryptedKeys: Record<string, string> = {};
    try {
        for (const [name, account] of Object.entries(accountsData.accounts)) {
            decryptedKeys[name] = decrypt((account as any).encryptedKey, oldSecret);
        }
    } catch (error: any) {
        // Clear any partially-decrypted keys before returning
        for (const key of Object.keys(decryptedKeys)) delete decryptedKeys[key];
        console.log('Failed to decrypt stored keys with the current master password:', getErrorMessage(error));
        return currentSecret;
    }

    const newSecret = setupModernVault(accountsData, newPassword);
    for (const [name, account] of Object.entries(accountsData.accounts)) {
        (account as any).encryptedKey = encrypt(decryptedKeys[name], newSecret);
        delete decryptedKeys[name];
    }
    // V8 strings are immutable and cannot be zeroed; deleting the references
    // allows GC to collect them.  The real protection is that the window
    // between decrypt and re-encrypt is now minimized to the loop body.
    saveAccounts(accountsData);
    console.log('Master password updated successfully.');
    return newSecret;
}

/**
 * Save accounts data to profiles/keys.json atomically with restrictive permissions.
 * Writes to a temp file in the same directory, fsyncs, then renames over the target.
 * The file is always created with mode 0o600 so that even if the calling process
 * inherited a permissive umask (e.g. 0o022), the key material is never world-readable.
 *
 * @param {Object} data - Accounts data to save
 */
function saveAccounts(data: any) {
    // Always save sensitive data to the live path (ignored by git)
    ensureProfilesKeysDirectory();

    const serialized = {
        vaultVersion: data && Number(data.vaultVersion) ? Number(data.vaultVersion) : 0,
        vaultSalt: data && typeof data.vaultSalt === 'string' ? data.vaultSalt : '',
        vaultVerifier: data && typeof data.vaultVerifier === 'string' ? data.vaultVerifier : '',
        accounts: data && data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
    };

    if (!serialized.vaultSalt) {
        delete serialized.vaultSalt;
    }
    if (!serialized.vaultVerifier) {
        delete serialized.vaultVerifier;
    }
    if (!hasModernVault(serialized)) {
        delete (serialized as any).vaultVersion;
    }

    // Atomic write via unified StorageAdapter: tmp file with 0o600 + fsync,
    // then rename over target.
    storage.writeJSON(PROFILES_KEYS_FILE, serialized, { mode: 0o600, fsync: true });
}

/**
 * Launch the interactive key management CLI.
 * Provides menu for: add/modify/remove keys, test decryption,
 * change master password.
 */
async function main() {
    console.log('Chain Key Manager');
    console.log('========================');

    let accountsData = loadAccounts();
    let vaultSecret: { kind: string; version: any; vaultKeyHex: string; } | null = null;

    // Check if master password is set
    if (!hasModernVault(accountsData)) {
        console.log('No master password set. Please set one:');
        const password1 = await readPassword('Enter master password:   ');
        const password2 = await readPassword('Confirm master password: ');
        if (password1 !== password2) {
            console.log('Passwords do not match!');
            return;
        }
        vaultSecret = setupModernVault(accountsData, password1);
        saveAccounts(accountsData);
        console.log('Master password set successfully.');
    } else {
        try {
            vaultSecret = await authenticate();
            accountsData = loadAccounts();
            console.log('Authenticated successfully.');
        } catch (err: any) {
            if (err instanceof MasterPasswordError) {
                console.log(getErrorMessage(err));
                return;
            }
            throw err;
        }
    }

     while (true) {
         console.log('\nMenu:');
         console.log('1. Add key');
         console.log('2. Modify key');
         console.log('3. Remove key');
         console.log('4. List keys');
         console.log('5. Test decryption');
         console.log('6. Change master password');
         console.log('7. Exit (or press Enter)');

         const choiceRaw = await readInput('Choose an option: ');
         console.log('');

         if (choiceRaw === '\x1b' || choiceRaw.trim() === '') {
             console.log('Keymanager closed!');
             break;
         }

         const choice = choiceRaw.trim();

        if (choice === '1') {
            const accountNameRaw = await readInput('Enter account name: ');
            if (accountNameRaw === '\x1b') continue;
            const accountName = accountNameRaw.trim();
            if (!accountName) {
                continue;
            }

            const privateKeyRaw = await readPassword('Enter private key:  ');
            if (privateKeyRaw === '\x1b') continue;

            const privateKey = privateKeyRaw.replace(/\s+/g, '');

            const validation = validatePrivateKey(privateKey);
            if (!validation.valid) {
                console.log(`Invalid private key: ${validation.reason}`);
                console.log('Accepted formats: WIF (51/52 chars), PVT_* keys, or 64-hex');
                continue;
            }

            const encryptedKey = encrypt(privateKey, vaultSecret);

            accountsData.accounts[accountName] = { encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' added successfully.`);
        } else if (choice === '2') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to modify');
            if (accountName === '\x1b' || !accountName) continue;
            
            const privateKeyRaw = await readPassword('Enter private key:   ');
            if (privateKeyRaw === '\x1b') continue;
            
            const privateKey = privateKeyRaw.replace(/\s+/g, '');

            const validation = validatePrivateKey(privateKey);
            if (!validation.valid) {
                console.log(`Invalid private key: ${validation.reason}`);
                console.log('Accepted formats: WIF (51/52 chars), PVT_* keys, or 64-hex');
                continue;
            }

            const encryptedKey = encrypt(privateKey, vaultSecret);
            accountsData.accounts[accountName] = { ...accountsData.accounts[accountName], encryptedKey };
            saveAccounts(accountsData);
            console.log(`Account '${accountName}' updated successfully.`);
        } else if (choice === '3') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to remove');
            if (accountName === '\x1b' || !accountName) continue;
            
            const confirm = (await readInput(`Remove '${accountName}'? (y/n): `)).trim().toLowerCase();
            if (confirm === '\x1b') continue;

            if (confirm === 'y') {
                delete accountsData.accounts[accountName];
                saveAccounts(accountsData);
                console.log(`Account '${accountName}' removed successfully.`);
            } else {
                console.log('Cancelled.');
            }
        } else if (choice === '4') {
            listKeyNames(accountsData.accounts);
        } else if (choice === '5') {
            const accountName = await selectKeyName(accountsData.accounts, 'Select key to test');
            if (accountName === '\x1b' || !accountName) continue;
            
            try {
                const decryptedKey = decrypt(accountsData.accounts[accountName].encryptedKey, vaultSecret);
                console.log(`First 5 characters: ${decryptedKey.substring(0, 5)}`);
            } catch (error: any) {
                console.log('Decryption failed - wrong master password or corrupted data');
            }
        } else if (choice === '6') {
            vaultSecret = await changeMasterPassword(accountsData, vaultSecret);
        } else if (choice === '7') {
            console.log('Keymanager closed!');
            break;
        } else {
            console.log('Invalid choice.');
        }
    }
}

/**
 * Check if dexbot-cred daemon is ready and responsive
 * @param {Object} [options={}] - Optional socket/ready-file path overrides
 * @returns {boolean} True if daemon socket is responsive
 */
function isDaemonReady(options: any = {}) {
    try {
        return storage.exists(getCredentialReadyFilePath(options)) && storage.exists(getCredentialSocketPath(options));
    } catch {
        return false;
    }
}

/**
 * Check if dexbot-cred daemon is actually responsive by opening a socket
 * connection and waiting for any reply. This catches stale socket/ready
 * files left behind by a crashed daemon.
 * @param {Object} options - Optional socket/ready-file path overrides
 * @param {number} timeout - Probe timeout in milliseconds (default 2000)
 * @returns {Promise<boolean>} True if the daemon accepts connections and replies
 */
function isDaemonResponsive(options: any = {}, timeout: any = 2000) {
    return new Promise((resolve: any) => {
        if (!isDaemonReady(options)) {
            return resolve(false);
        }

        let net;
        try {
            net = getNet();
        } catch {
            return resolve(false);
        }
        const socketPath = getCredentialSocketPath(options);
        const socket = net.createConnection(socketPath);
        let settled = false;
        let responseBuffer = '';

        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve(false);
            }
        }, timeout);

        socket.on('connect', () => {
            // Send a minimal request that forces the daemon to reply.
            // Missing fields trigger an error response, which is enough
            // to prove the daemon is alive and processing.
            socket.write('{}\n');
        });

        socket.on('data', (data: any) => {
            responseBuffer += data.toString();
            if (!settled && responseBuffer.trim().length > 0) {
                settled = true;
                clearTimeout(timer);
                socket.end();
                resolve(true);
            }
        });

        socket.on('error', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        });

        socket.on('end', () => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(false);
            }
        });
    });
}

/**
 * Wait for dexbot-cred daemon to be ready
 * @param {number} maxWaitMs - Maximum time to wait in milliseconds (default 60000)
 * @param {Object} [options] - Optional socket/ready-file path overrides
 * @returns {Promise<void>} Resolves when daemon is ready
 * @throws {Error} If daemon doesn't start within timeout
 */
async function waitForDaemon(maxWaitMs: any = TIMING.DAEMON_STARTUP_TIMEOUT_MS, options: any = {}) {
    const startTime = Date.now();
    const checkInterval = TIMING.CHECK_INTERVAL_MS; // Check every 100ms

    while (Date.now() - startTime < maxWaitMs) {
        if (isDaemonReady(options)) {
            return;
        }
        await sleep(checkInterval);
    }

    throw new Error(`Daemon did not start within ${maxWaitMs}ms`);
}

/**
 * Send a single-line JSON request to the credential daemon and return
 * the parsed response via extractResult.
 * @param {string} requestType - The "type" field sent to the daemon
 * @param {string} accountName - Account name included in the request
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @param {Object} options - Optional socket path overrides
 * @param {string} label - Human label for error messages (e.g. 'request', 'ping', 'probe')
 * @param {function} extractResult - Callback: (response) => resolved value; throw to reject
 * @returns {Promise<*>} Resolved value from extractResult
 */
function sendDaemonRequest(requestType: any, accountName: any, timeout: any = TIMING.DAEMON_PING_TIMEOUT_MS, options: any = {}, label: any = 'request', extractResult: ((response: any) => any) | null = null) {
    return sendSocketJsonRequest({
        socketPath: getCredentialSocketPath(options),
        timeoutMs: timeout,
        writePayload: (socket: any) => {
            socket.write(JSON.stringify({ type: requestType, accountName }) + '\n');
        },
        buildError: (kind: any, detail: any) => {
            switch (kind) {
                case 'timeout':
                    return new Error(`Daemon ${label} timeout`);
                case 'connection':
                    return new Error(`Daemon connection failed: ${getErrorMessage(detail)}`);
                case 'invalid':
                    return new Error(`Invalid daemon ${label} response`);
                default:
                    return new Error(`Daemon ${label} closed connection unexpectedly`);
            }
        },
        handleResponse: (parsed: any, resolve: any, reject: any) => {
            try {
                if (extractResult) {
                    resolve(extractResult(parsed));
                } else if (parsed.success) {
                    resolve(parsed);
                } else {
                    reject(new Error(parsed.error || `Daemon ${label} failed`));
                }
            } catch (handlerErr: any) {
                reject(handlerErr);
            }
        },
    });
}

/**
 * Lightweight daemon health check.  Does NOT create a session or write
 * an audit log entry — used by the credential daemon watchdog and
 * pre-write probes where only liveness matters.
 * @param {string} accountName - Ignored for ping; included for API consistency
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @param {Object} options - Optional socket path overrides
 * @returns {Promise<boolean>} Resolves with true if daemon responds
 */
function pingDaemon(accountName: any, timeout: any = TIMING.DAEMON_PING_TIMEOUT_MS, options: any = {}) {
    return sendDaemonRequest('ping', accountName, timeout, options, 'ping', (response: any) => {
        if (response.success && response.pong) return true;
        throw new Error(response.error || 'Daemon ping failed');
    });
}

/**
 * Verifies the account exists in the daemon's session cache.
 * @param {string} accountName - Name of the account to probe
 * @param {number} timeout - Timeout in milliseconds (default 5000)
 * @param {Object} options - Optional socket path overrides
 * @returns {Promise<string|null>} Resolves with sessionId if account is available, rejects otherwise
 */
function probeAccountInDaemon(accountName: any, timeout: any = TIMING.DAEMON_PING_TIMEOUT_MS, options: any = {}) {
    return sendDaemonRequest('probe-account', accountName, timeout, options, 'probe', (response: any) => {
        if (response.success) return response.sessionId || null;
        throw new Error(response.error || 'Daemon probe failed');
    });
}

export { validatePrivateKey, loadAccounts, saveAccounts, checkKeysFileSecurity, encrypt, decrypt, deriveVaultKey, createDaemonSigningToken, createSessionSecret, createVaultSecret, isVaultSecret, isDaemonSigningToken, unlockWithPassword, main, authenticate, getPrivateKey, resolvePrivateKey, isMasterPasswordFailure, MasterPasswordError, isDaemonReady, isDaemonResponsive, waitForDaemon, probeAccountInDaemon, pingDaemon }
