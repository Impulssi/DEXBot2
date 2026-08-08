const assert = require('assert');
const ecc = require('../modules/bitshares-native/crypto/ecc');
const { resolvePrivateKey, resolveAccountIdToName } = require('../modules/authority_resolver');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running authority resolver tests');

/**
 * Create a mock chain client with configurable get_full_accounts responses.
 */
function createMockChain(accounts: Record<string, any>) {
    const fullAccounts = new Map();

    for (const [key, acct] of Object.entries(accounts)) {
        const accountId = acct.id || `1.2.${Object.keys(accounts).indexOf(key) + 100}`;
        fullAccounts.set(key, {
            account: {
                id: accountId,
                name: key,
                active: acct.active || { weight_threshold: 1, account_auths: [], key_auths: [] },
                owner: acct.owner || { weight_threshold: 1, account_auths: [], key_auths: [] },
            },
        });
        fullAccounts.set(accountId, {
            account: {
                id: accountId,
                name: key,
                active: acct.active || { weight_threshold: 1, account_auths: [], key_auths: [] },
                owner: acct.owner || { weight_threshold: 1, account_auths: [], key_auths: [] },
            },
        });
    }

    return {
        db: {
            get_full_accounts: async (refs, _subscribe) => {
                const results = [];
                for (const ref of refs) {
                    const match = fullAccounts.get(ref);
                    if (match) {
                        results.push([ref, match]);
                    } else {
                        results.push([ref, null]);
                    }
                }
                return results;
            },
        },
    };
}

async function testDirectKeyLookup() {
    const chain = createMockChain({
        alice: { active: { weight_threshold: 1, account_auths: [], key_auths: [] } },
    });

    const key = await resolvePrivateKey('alice', chain, async (name) => {
        return name === 'alice' ? 'alice-private-key' : null;
    }, () => ['alice']);
    assert.strictEqual(key, 'alice-private-key', 'direct lookup should return key without chain call');
    console.log('  ✓ direct key lookup returns immediately');
}

async function testAccountAuthsResolution() {
    const chain = createMockChain({
        company: { active: { weight_threshold: 1, account_auths: [['1.2.101', 1]], key_auths: [] } },
        alice: { active: { weight_threshold: 1, account_auths: [], key_auths: [] } },
    });

    const key = await resolvePrivateKey('company', chain, async (name) => {
        return name === 'alice' ? 'alice-key' : null;
    }, () => ['alice']);
    assert.strictEqual(key, 'alice-key', 'should resolve through account_auths');
    console.log('  ✓ account_auths: resolves through one level');
}

async function testAccountAuthsTwoLevels() {
    const chain = createMockChain({
        parent: { active: { weight_threshold: 1, account_auths: [['1.2.101', 1]], key_auths: [] } },
        child: { active: { weight_threshold: 1, account_auths: [['1.2.102', 1]], key_auths: [] } },
        alice: { active: { weight_threshold: 1, account_auths: [], key_auths: [] } },
    });

    const key = await resolvePrivateKey('parent', chain, async (name) => {
        return name === 'alice' ? 'alice-key' : null;
    }, () => ['alice']);
    assert.strictEqual(key, 'alice-key', 'should resolve through two levels of account_auths');
    console.log('  ✓ account_auths: resolves through two levels');
}

async function testAccountAuthsSkipsBelowThreshold() {
    const chain = createMockChain({
        company: { active: { weight_threshold: 3, account_auths: [['1.2.101', 1], ['1.2.102', 3]], key_auths: [] } },
        alice: { active: { weight_threshold: 1, account_auths: [], key_auths: [] } },
        bob: { active: { weight_threshold: 1, account_auths: [], key_auths: [] } },
    });

    const key = await resolvePrivateKey('company', chain, async (name) => {
        return name === 'bob' ? 'bob-key' : null;
    }, () => ['alice', 'bob']);
    assert.strictEqual(key, 'bob-key', 'should skip alice (weight 1 < threshold 3), find bob (weight 3)');
    console.log('  ✓ account_auths: skips entries below threshold, uses entry above');
}

async function testKeyAuthsResolution() {
    const testPrivKey = ecc.wifEncode(ecc.generatePrivateKey());
    const testPubKey = ecc.publicKeyToString(ecc.privateKeyToPublicKey(ecc.wifDecode(testPrivKey).privateKey));

    const chain = createMockChain({
        account: { active: { weight_threshold: 1, account_auths: [], key_auths: [[testPubKey, 1]] } },
    });

    const key = await resolvePrivateKey('account', chain, async (name) => {
        return name === 'keystore' ? testPrivKey : null;
    }, () => ['keystore']);
    assert.strictEqual(key, testPrivKey, 'should match stored key against key_auths');
    console.log('  ✓ key_auths: matches stored key by derived public key');
}

async function testThrowsWhenNoKey() {
    const chain = createMockChain({
        isolated: { active: { weight_threshold: 1, account_auths: [], key_auths: [] } },
    });

    try {
        await resolvePrivateKey('isolated', chain, async () => null, () => []);
        assert.fail('should have thrown');
    } catch (e) {
        assert.ok(getErrorMessage(e).includes('No signing key found'), 'error should mention no key found');
        assert.ok(getErrorMessage(e).includes('isolated'), 'error should mention account name');
    }
    console.log('  ✓ throws informative error when no key found');
}

async function testThrowsAtDepthLimit() {
    // IDs: l1=1.2.100, l2=1.2.101, l3=1.2.102, l4=1.2.103
    // l4's key is at depth 3 which exceeds the 2-level bound
    const chain = createMockChain({
        l1: { active: { weight_threshold: 1, account_auths: [['1.2.101', 1]], key_auths: [] } },
        l2: { active: { weight_threshold: 1, account_auths: [['1.2.102', 1]], key_auths: [] } },
        l3: { active: { weight_threshold: 1, account_auths: [['1.2.103', 1]], key_auths: [] } },
        l4: { active: { weight_threshold: 1, account_auths: [], key_auths: [] } },
    });

    try {
        await resolvePrivateKey('l1', chain, async (name) => {
            return name === 'l4' ? 'l4-key' : null;
        }, () => ['l4']);
        assert.fail('should have thrown — depth limit prevents reaching l4');
    } catch (e) {
        assert.ok(
            getErrorMessage(e).includes('No signing key found'),
            `expected resolution-failure error, got: ${getErrorMessage(e)}`
        );
    }
    console.log('  ✓ depth limit prevents resolution beyond 2 levels');
}

async function testAccountAuthsInsufficientWeightHint() {
    const chain = createMockChain({
        multisig: { active: { weight_threshold: 3, account_auths: [['1.2.101', 2], ['1.2.102', 2]], key_auths: [] } },
        alice: {},
        bob: {},
    });

    try {
        await resolvePrivateKey('multisig', chain, async (name) => {
            return name === 'alice' ? 'alice-key' : name === 'bob' ? 'bob-key' : null;
        }, () => ['alice', 'bob']);
        assert.fail('should have thrown');
    } catch (e) {
        assert.ok(
            getErrorMessage(e).includes('Multi-signature'),
            `expected multi-sig hint, got: ${getErrorMessage(e)}`
        );
    }
    console.log('  ✓ multi-sig hint in error when no single entry meets threshold');
}

(async () => {
    await testDirectKeyLookup();
    await testAccountAuthsResolution();
    await testAccountAuthsTwoLevels();
    await testAccountAuthsSkipsBelowThreshold();
    await testKeyAuthsResolution();
    await testThrowsWhenNoKey();
    await testThrowsAtDepthLimit();
    await testAccountAuthsInsufficientWeightHint();
    console.log('All authority resolver tests passed');
    process.exit(0);
})().catch((err) => {
    console.error('TEST FAILED:', getErrorMessage(err));
    process.exit(1);
});
