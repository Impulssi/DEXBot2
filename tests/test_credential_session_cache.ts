const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');
const {
    buildSessionAccountCache,
    loadDaemonPrivateKey,
} = require('../modules/credential_session_cache');

console.log('Running credential session cache tests');

function createChainKeysStub(state) {
    return {
        createSessionSecret: () => ({ kind: 'session-secret', vaultKeyHex: 'session-key' }),
        decrypt: (encryptedKey, secret) => {
            const vaultKeyHex = secret && secret.vaultKeyHex;
            if (vaultKeyHex === 'vault-key') {
                const entry = Object.entries(state.accounts).find(([, value]) => (value as any).encryptedKey === encryptedKey);
                if (!entry) throw new Error(`Unknown encrypted key: ${encryptedKey}`);
                return (entry as any)?.[1]?.privateKey;
            }
            if (vaultKeyHex === 'session-key') {
                return String(encryptedKey).replace(/^session:/, '');
            }
            throw new Error(`Unexpected decrypt secret: ${vaultKeyHex}`);
        },
        encrypt: (privateKey, secret) => {
            const vaultKeyHex = secret && secret.vaultKeyHex;
            if (vaultKeyHex !== 'session-key') {
                throw new Error(`Unexpected encrypt secret: ${vaultKeyHex}`);
            }
            return `session:${privateKey}`;
        },
        getPrivateKey: (accountName) => {
            const account = state.accounts[accountName];
            if (!account) {
                throw new Error(`Account '${accountName}' not found.`);
            }
            return account.privateKey;
        },
    };
}

async function testLiveLookupRefreshesSessionCache() {
    const state = {
        accounts: {
            alice: { encryptedKey: 'vault:alice:v1', privateKey: 'alice-private-v1' },
        },
    };
    const chainKeys = createChainKeysStub(state);
    const vaultSecret = { kind: 'dexbot-vault-secret', vaultKeyHex: 'vault-key' };
    const sessionState = buildSessionAccountCache({
        accounts: {
            alice: { encryptedKey: state.accounts.alice.encryptedKey },
        },
    }, vaultSecret, { chainKeys });

    const daemonState = {
        vaultSecret,
        sessionAccountKeys: sessionState.cache,
        sessionSecret: sessionState.sessionSecret,
    };

    const firstKey = await loadDaemonPrivateKey('alice', daemonState, { chainKeys });
    assert.strictEqual(firstKey, 'alice-private-v1', 'live lookup should read the current vault key');
    assert.strictEqual(
        daemonState.sessionAccountKeys.get('alice'),
        'session:alice-private-v1',
        'live lookup should seed the session cache from the current vault value'
    );

    state.accounts.alice = { encryptedKey: 'vault:alice:v2', privateKey: 'alice-private-v2' };
    const rotatedKey = await loadDaemonPrivateKey('alice', daemonState, { chainKeys });
    assert.strictEqual(rotatedKey, 'alice-private-v2', 'live lookup should see key rotation without daemon restart');
    assert.strictEqual(
        daemonState.sessionAccountKeys.get('alice'),
        'session:alice-private-v2',
        'live lookup should refresh the session cache after key rotation'
    );

    (state.accounts as any).bob = { encryptedKey: 'vault:bob:v1', privateKey: 'bob-private-v1' };
    const addedKey = await loadDaemonPrivateKey('bob', daemonState, { chainKeys });
    assert.strictEqual(addedKey, 'bob-private-v1', 'live lookup should see newly added accounts');
    assert.strictEqual(
        daemonState.sessionAccountKeys.get('bob'),
        'session:bob-private-v1',
        'new accounts should be cached for the session after first lookup'
    );

    delete state.accounts.alice;
    await assert.rejects(
        () => loadDaemonPrivateKey('alice', daemonState, { chainKeys }),
        /Account 'alice' not found\./,
        'removed accounts should stop resolving immediately'
    );
    assert.strictEqual(
        daemonState.sessionAccountKeys.has('alice'),
        false,
        'removed accounts should also be evicted from the session cache'
    );
}

async function testAuthorityResolutionFallback() {
    const state = {
        accounts: {
            alice: { encryptedKey: 'vault:alice:v1', privateKey: 'alice-private-v1' },
        },
    };
    const chainKeys = createChainKeysStub(state);
    const vaultSecret = { kind: 'dexbot-vault-secret', vaultKeyHex: 'vault-key' };
    const sessionState = buildSessionAccountCache({
        accounts: {
            alice: { encryptedKey: state.accounts.alice.encryptedKey },
        },
    }, vaultSecret, { chainKeys });

    const daemonState = {
        vaultSecret,
        sessionAccountKeys: sessionState.cache,
        sessionSecret: sessionState.sessionSecret,
    };

    const mockChainClient = { db: { get_full_accounts: async () => [] } };
    const chainKeysWithResolution = {
        ...chainKeys,
        resolvePrivateKey: async (accountName, _vault, _chain) => {
            if (accountName === 'delegated') return 'delegated-resolved-key';
            throw new Error('No signing key found');
        },
    };

    const key = await loadDaemonPrivateKey('delegated', daemonState, {
        chainKeys: chainKeysWithResolution,
        chainClient: mockChainClient,
    });
    assert.strictEqual(key, 'delegated-resolved-key', 'should return key from authority resolution fallback');
    console.log('  ✓ authority resolution fallback returns resolved key');
}

async function testCombinedErrorWhenBothPathsFail() {
    const state = {
        accounts: {
            alice: { encryptedKey: 'vault:alice:v1', privateKey: 'alice-private-v1' },
        },
    };
    const chainKeys = createChainKeysStub(state);
    const vaultSecret = { kind: 'dexbot-vault-secret', vaultKeyHex: 'vault-key' };
    const sessionState = buildSessionAccountCache({
        accounts: {
            alice: { encryptedKey: state.accounts.alice.encryptedKey },
        },
    }, vaultSecret, { chainKeys });

    const daemonState = {
        vaultSecret,
        sessionAccountKeys: sessionState.cache,
        sessionSecret: sessionState.sessionSecret,
    };

    const mockChainClient = { db: { get_full_accounts: async () => [] } };
    const chainKeysWithResolution = {
        ...chainKeys,
        resolvePrivateKey: async () => {
            throw new Error('Authority resolution: no single entry meets threshold');
        },
    };

    try {
        await loadDaemonPrivateKey('nobody', daemonState, {
            chainKeys: chainKeysWithResolution,
            chainClient: mockChainClient,
        });
        assert.fail('should have thrown');
    } catch (e: any) {
        assert.ok(getErrorMessage(e).includes('Vault lookup'), `error should include vault lookup message, got: ${getErrorMessage(e)}`);
        assert.ok(getErrorMessage(e).includes('Authority resolution'), `error should include authority resolution message, got: ${getErrorMessage(e)}`);
        assert.ok(getErrorMessage(e).includes('nobody'), 'error should mention account name');
    }
    console.log('  ✓ combined error includes both vault and resolution messages');
}

(async () => {
    await testLiveLookupRefreshesSessionCache();
    await testAuthorityResolutionFallback();
    await testCombinedErrorWhenBothPathsFail();
    console.log('credential session cache tests passed');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
