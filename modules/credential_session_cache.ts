

import * as chainKeys from './chain_keys';
interface SessionAccount {
    encryptedKey: string;
}

interface AccountsData {
    accounts?: Record<string, SessionAccount>;
}

interface BuildSessionCacheOptions {
    chainKeys?: typeof chainKeys;
    onDecryptError?: (accountName: string, err: Error) => void;
}

interface CacheSessionKeyOptions {
    chainKeys?: typeof chainKeys;
}

interface LoadDaemonKeyOptions {
    chainKeys?: typeof chainKeys;
    chainClient?: any;
}

interface SessionState {
    vaultSecret?: string;
    sessionSecret?: string;
    sessionAccountKeys?: Map<string, string>;
}

function buildSessionAccountCache(accountsData: AccountsData, masterSecret: string, options: BuildSessionCacheOptions = {}) {
    const chainKeysImpl = options.chainKeys || chainKeys;
    const accounts: Record<string, SessionAccount> =
        accountsData && accountsData.accounts && typeof accountsData.accounts === 'object'
            ? accountsData.accounts
            : {};
    const derivedSessionSecret = chainKeysImpl.createSessionSecret(masterSecret);
    const cache = new Map();

    for (const [accountName, account] of Object.entries(accounts)) {
        if (!account || typeof account.encryptedKey !== 'string') {
            continue;
        }

        try {
            const privateKey = chainKeysImpl.decrypt(account.encryptedKey, masterSecret);
            cache.set(accountName, chainKeysImpl.encrypt(privateKey, derivedSessionSecret));
        } catch (err: any) {
            if (typeof options.onDecryptError === 'function') {
                options.onDecryptError(accountName, err);
            }
        }
    }

    return {
        cache,
        sessionSecret: derivedSessionSecret,
    };
}

function cacheSessionPrivateKey(accountName: string, privateKey: string, sessionState: SessionState, options: CacheSessionKeyOptions = {}) {
    const chainKeysImpl = options.chainKeys || chainKeys;
    const sessionAccountKeys = sessionState && sessionState.sessionAccountKeys;
    const sessionSecret = sessionState && sessionState.sessionSecret;

    if (
        !accountName ||
        typeof privateKey !== 'string' ||
        !sessionAccountKeys ||
        typeof sessionAccountKeys.set !== 'function' ||
        !sessionSecret
    ) {
        return;
    }

    sessionAccountKeys.set(accountName, chainKeysImpl.encrypt(privateKey, sessionSecret));
}

async function loadDaemonPrivateKey(accountName: string, sessionState: SessionState, options: LoadDaemonKeyOptions = {}) {
    const chainKeysImpl = options.chainKeys || chainKeys;
    const currentVaultSecret = sessionState && sessionState.vaultSecret;
    const sessionAccountKeys = sessionState && sessionState.sessionAccountKeys;
    const currentSessionSecret = sessionState && sessionState.sessionSecret;

    if (!accountName) {
        throw new Error('accountName is required');
    }

    // Vault path is primary: always re-derives from disk so that key rotation and
    // newly added accounts are visible without a daemon restart. Each successful
    // lookup also refreshes the session cache entry so that if the vault secret is
    // ever cleared the session cache still covers all recently used accounts.
    // The session cache (built at startup by buildSessionAccountCache) covers
    // accounts that have never been requested during the current session — ensuring
    // every known account is available even if the vault becomes unavailable before
    // the first request for that account arrives.
    if (currentVaultSecret) {
        try {
            const privateKey = chainKeysImpl.getPrivateKey(accountName, currentVaultSecret);
            cacheSessionPrivateKey(accountName, privateKey, sessionState, { chainKeys: chainKeysImpl });
            return privateKey;
        } catch (err: any) {
            // Authority resolution fallback: when no direct key is stored for this
            // account, try walking on-chain account_auths / key_auths.
            if (options.chainClient && typeof chainKeysImpl.resolvePrivateKey === 'function') {
                try {
                    const privateKey = await chainKeysImpl.resolvePrivateKey(
                        accountName,
                        currentVaultSecret,
                        options.chainClient
                    );
                    cacheSessionPrivateKey(accountName, privateKey, sessionState, { chainKeys: chainKeysImpl });
                    return privateKey;
                } catch (resolutionErr: any) {
                    if (sessionAccountKeys && typeof sessionAccountKeys.delete === 'function') {
                        sessionAccountKeys.delete(accountName);
                    }
                    const combined = new Error(
                        `No signing key for '${accountName}'.\n` +
                        `  Vault lookup: ${err.message}\n` +
                        `  Authority resolution: ${resolutionErr.message}`
                    );
                    combined.cause = resolutionErr;
                    throw combined;
                }
            }
            if (sessionAccountKeys && typeof sessionAccountKeys.delete === 'function') {
                sessionAccountKeys.delete(accountName);
            }
            throw err;
        }
    }

    if (!currentSessionSecret) {
        throw new Error('Session secret unavailable');
    }

    const sessionEncryptedKey = sessionAccountKeys && typeof sessionAccountKeys.get === 'function'
        ? sessionAccountKeys.get(accountName)
        : null;
    if (!sessionEncryptedKey) {
        throw new Error(`Account '${accountName}' not found.`);
    }

    return chainKeysImpl.decrypt(sessionEncryptedKey, currentSessionSecret);
}

export { buildSessionAccountCache, cacheSessionPrivateKey, loadDaemonPrivateKey }

