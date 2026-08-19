
import getEcc from './bitshares-native/crypto/ecc_selector.js';
import { NATIVE_CLIENT } from './constants.js';
import Logger from './order/logger.js';
import { getErrorMessage } from './utils/errors.js';
'use strict';

const ecc = getEcc();

const DEFAULT_ADDRESS_PREFIX = NATIVE_CLIENT.CHAIN.ADDRESS_PREFIX;
const logger = new Logger('authority-resolver');

/**
 * Resolve a signing key for an account by walking on-chain authority structures.
 *
 * LIMITATION: Only handles cases where a SINGLE authority entry (key_auth or
 * account_auth) meets the full weight_threshold. BitShares supports combining
 * multiple entries to cross the threshold (multi-signature), but that requires
 * multiple signatures per transaction and is outside this module's scope.
 *
 * Tries in order:
 *   1. Direct key lookup via tryGetKey(accountName)
 *   2. account_auths — other accounts referenced in the active authority
 *      (recursive, max depth=2). Each entry's weight must individually ≥ threshold.
 *   3. key_auths — match stored private keys against required public keys.
 *      Each entry's weight must individually ≥ threshold.
 *
 * If no single entry meets the threshold, the error message explicitly states
 * that multi-signature requirements cannot be satisfied.
 *
 * @param {string} accountName - Target account to sign for
 * @param {object} chainClient - Native chain client with db.get_full_accounts, optional getConfig
 * @param {function} tryGetKey - async (name: string) => string|null — returns private key WIF or null
 * @param {function} listNames - () => string[] — returns all stored account names (for key_auths matching)
 * @param {number} [depth=0] - Internal recursion depth
 * @param {Map<string,string>} [pubKeyCache] - Per-call cache for derived public keys (internal)
 * @returns {Promise<string>} Private key WIF string
 */
async function resolvePrivateKey(
    accountName: any,
    chainClient: any,
    tryGetKey: any,
    listNames: any,
    depth: any = 0,
    pubKeyCache: any = new Map()
) {
    if (depth > 2) {
        throw new Error(
            `Authority chain exceeds max resolution depth (2) for account '${accountName}'`
        );
    }

    // Step 1: Try direct key lookup
    const directKey = await tryGetKey(accountName);
    if (directKey) return directKey;

    logger.debug(`No direct key for '${accountName}', fetching authority from chain (depth=${depth})`);

    // Step 2: Fetch account from chain
    let full;
    try {
        full = await chainClient.db.get_full_accounts([accountName], false);
    } catch (e: any) {
        throw new Error(
            `Failed to fetch account '${accountName}' from chain: ${getErrorMessage(e)}`
        );
    }

    if (!full || !full[0] || !full[0][1] || !full[0][1].account) {
        throw new Error(`Account '${accountName}' not found on chain`);
    }

    const account = full[0][1].account;
    const active = account.active;

    if (!active || typeof active.weight_threshold === 'undefined') {
        throw new Error(`Account '${accountName}' has no active authority`);
    }

    const threshold = Number(active.weight_threshold);
    if (threshold <= 0) {
        throw new Error(
            `Account '${accountName}' has invalid authority threshold: ${threshold}`
        );
    }

    // Step 3: Check account_auths — referenced accounts may have keys in vault
    const accountAuths = normalizeAuthMap(active.account_auths);
    for (const [accountId, weight] of accountAuths) {
        if (weight < threshold) {
            logger.debug(`  account_auth entry ${accountId}:${weight} < threshold ${threshold}, skipping`);
            continue;
        }

        let refName;
        try {
            refName = await resolveAccountIdToName(chainClient, accountId);
        } catch (e: any) {
            logger.debug(`  account_auth entry ${accountId}: name resolution failed — ${getErrorMessage(e)}`);
            continue;
        }

        try {
            logger.debug(`  account_auth: '${accountName}' → resolving via '${refName}'`);
            return await resolvePrivateKey(refName, chainClient, tryGetKey, listNames, depth + 1, pubKeyCache);
        } catch (e: any) {
            logger.debug(`  account_auth: '${refName}' resolution failed — ${getErrorMessage(e)}`);
            continue;
        }
    }

    // Step 4: Check key_auths — match stored keys against required public keys
    const keyAuths = normalizeAuthMap(active.key_auths);
    if (keyAuths.length > 0) {
        const prefix = getAddressPrefix(chainClient);
        const storedKeys = await collectAllStoredKeys(tryGetKey, listNames);

        if (storedKeys.length > 0) {
            for (const [targetPubKey, weight] of keyAuths) {
                if (weight < threshold) {
                    logger.debug(`  key_auth entry ${targetPubKey.substring(0, 12)}:${weight} < threshold ${threshold}, skipping`);
                    continue;
                }

                const match = matchKeyByPublicKey(targetPubKey, storedKeys, prefix, pubKeyCache);
                if (match) {
                    logger.debug(`  key_auth: matched ${targetPubKey.substring(0, 12)}…`);
                    return match;
                }
            }
        } else {
            logger.debug('  key_auth: no stored keys available to match');
        }
    }

    // Step 5: Nothing worked — build informative error
    const storedNames = (typeof listNames === 'function' ? listNames() : []).join(', ');
    const authSummary = buildAuthSummary(active);
    const maxWeight = findMaxWeight(active);
    const multiSigHint = maxWeight > 0 && maxWeight < threshold
        ? `  Multi-signature: highest single entry weight (${maxWeight}) < threshold (${threshold}). This bot requires ONE stored key that individually meets the threshold.`
        : '';
    throw new Error(
        `No signing key found for account '${accountName}'.\n` +
        `  Authority: ${authSummary}\n` +
        `  Stored keys for: ${storedNames || '(none)'}\n` +
        (multiSigHint ? `${multiSigHint}\n` : '') +
        (depth === 0
            ? '  The account may require multi-signature or external signers not in this keyring.'
            : `  (resolved via ${depth} level(s) of account_auths)`)
    );
}

/**
 * Normalize account_auths / key_auths from either array or object format.
 */
function normalizeAuthMap(auth: any) {
    if (!auth) return [];
    if (Array.isArray(auth)) return auth;
    return Object.entries(auth);
}

/**
 * Resolve account ID (1.2.x) to account name via chain.
 */
async function resolveAccountIdToName(chainClient: any, accountId: any) {
    if (!/^1\.2\./.test(String(accountId))) return String(accountId);

    const full = await chainClient.db.get_full_accounts([accountId], false);
    if (full && full[0] && full[0][1] && full[0][1].account && full[0][1].account.name) {
        return full[0][1].account.name;
    }
    throw new Error(`Could not resolve account ID '${accountId}' to name`);
}

/**
 * Get address prefix from chain config, falling back to default.
 */
function getAddressPrefix(chainClient: any) {
    try {
        const config = typeof chainClient.getConfig === 'function'
            ? chainClient.getConfig()
            : null;
        if (config && config.addressPrefix) return config.addressPrefix;
    } catch (e: any) {
        logger.warn(`getAddressPrefix: failed to read chain config: ${getErrorMessage(e)}`);
    }
    return DEFAULT_ADDRESS_PREFIX;
}

/**
 * Collect all stored keys by calling tryGetKey for every known account name.
 */
async function collectAllStoredKeys(tryGetKey: any, listNames: any) {
    const names = typeof listNames === 'function' ? listNames() : [];
    const results: { name: any; wif: any; }[] = [];
    for (const name of names) {
        const wif = await tryGetKey(name);
        if (wif) results.push({ name, wif });
    }
    return results;
}

/**
 * Match a stored private key against a target public key string.
 * Uses the per-call pubKeyCache to avoid re-deriving public keys.
 */
function matchKeyByPublicKey(targetPubKey: any, storedKeys: any, prefix: any, pubKeyCache: any) {
    for (const { wif } of storedKeys) {
        try {
            let pubKeyStr = pubKeyCache.get(wif);
            if (!pubKeyStr) {
                const { privateKey } = ecc.wifDecode(wif);
                const pubKeyBuf = ecc.privateKeyToPublicKey(privateKey);
                pubKeyStr = ecc.publicKeyToString(pubKeyBuf, prefix);
                pubKeyCache.set(wif, pubKeyStr);
            }
            if (pubKeyStr === targetPubKey) return wif;
        } catch (e) {
            continue;
        }
    }
    return null;
}

/**
 * Build a human-readable summary of an authority object.
 */
function buildAuthSummary(auth: any) {
    const parts: string[] = [];
    parts.push(`threshold=${auth.weight_threshold}`);

    const keyAuths = normalizeAuthMap(auth.key_auths);
    if (keyAuths.length > 0) {
        parts.push(`keys=[${keyAuths.map(([k, w]: any) => `${k.substring(0, 12)}…:${w}`).join(', ')}]`);
    }

    const accountAuths = normalizeAuthMap(auth.account_auths);
    if (accountAuths.length > 0) {
        parts.push(`accounts=[${accountAuths.map(([id, w]: any) => `${id}:${w}`).join(', ')}]`);
    }

    return parts.join(' ');
}

/**
 * Find the highest single weight across all authority entries.
 */
function findMaxWeight(auth: any) {
    let max = 0;
    for (const [, weight] of normalizeAuthMap(auth.key_auths)) {
        if (weight > max) max = weight;
    }
    for (const [, weight] of normalizeAuthMap(auth.account_auths)) {
        if (weight > max) max = weight;
    }
    return max;
}

export { resolvePrivateKey, resolveAccountIdToName }

