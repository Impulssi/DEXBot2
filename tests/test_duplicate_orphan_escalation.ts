/**
 * tests/test_duplicate_orphan_escalation.ts
 *
 * Unit tests for the persistent duplicate-orphan detection escalation and the
 * shared ORDER_GONE error matcher (modules/order/utils/order.ts):
 *
 *   1. isOrderGoneErrorMessage — explicit order-gone phrasings, contextual
 *      "not found" matching, and no false positives on unrelated lookups.
 *   2. recordDuplicateOrphanDetection — first sighting stays info, a repeat
 *      escalates, repeat escalation is rate-limited, and a cleared/resolved
 *      orphan starts fresh.
 */

const assert = require('assert');

const {
    isOrderGoneErrorMessage,
    recordDuplicateOrphanDetection,
    clearDuplicateOrphanDetection,
} = require('../modules/order/utils/order');

async function testIsOrderGoneErrorMessage() {
    console.log('\n - isOrderGoneErrorMessage matches order-gone phrasings...');

    // Explicit order-does-not-exist phrasings.
    assert.strictEqual(isOrderGoneErrorMessage('Order 1.7.123 does not exist'), true);
    assert.strictEqual(isOrderGoneErrorMessage('assert_exception: does not exist the order 1.7.123'), true);
    assert.strictEqual(isOrderGoneErrorMessage('unable to find object 1.7.123'), true);
    assert.strictEqual(isOrderGoneErrorMessage('could not find object 1.7.123'), true);

    // Legacy generic 'not found' fragment (order.ts historical rule).
    assert.strictEqual(isOrderGoneErrorMessage('not found'), true);
    assert.strictEqual(isOrderGoneErrorMessage('limit_order not found'), true);
    assert.strictEqual(isOrderGoneErrorMessage('object 1.7.123 not found'), true);

    // Unrelated failures must NOT match.
    assert.strictEqual(isOrderGoneErrorMessage('connection refused'), false);
    assert.strictEqual(isOrderGoneErrorMessage('RPC timeout'), false);
    assert.strictEqual(isOrderGoneErrorMessage(''), false);
    assert.strictEqual(isOrderGoneErrorMessage(null), false);
    assert.strictEqual(isOrderGoneErrorMessage(undefined), false);

    // orderId-context precision mode (dust/residual-cancel semantics): explicit
    // order-gone phrasings still match, object-missing phrasings require the id,
    // and the bare 'not found' fragment alone is not sufficient.
    assert.strictEqual(isOrderGoneErrorMessage('order does not exist', '1.7.902'), true);
    assert.strictEqual(isOrderGoneErrorMessage('Could not find Object: 1.7.902', '1.7.902'), true);
    assert.strictEqual(isOrderGoneErrorMessage('Unable to find object 1.7.902', '1.7.902'), true);
    assert.strictEqual(isOrderGoneErrorMessage('1.7.902 does not exist', '1.7.902'), true);
    assert.strictEqual(isOrderGoneErrorMessage('not found', '1.7.902'), false,
        'bare "not found" must not match in precision mode without the orderId');
    assert.strictEqual(isOrderGoneErrorMessage('account does not exist', '1.7.902'), false,
        'unrelated account-missing errors must not match');
    assert.strictEqual(isOrderGoneErrorMessage('asset does not exist', '1.7.902'), false,
        'unrelated asset-missing errors must not match');

    console.log('  PASS');
}

async function testEscalationFirstSightingStaysInfo() {
    console.log('\n - First sighting of an orphan stays quiet (no escalation)...');
    const oid = '1.7.ESC-FIRST';
    clearDuplicateOrphanDetection(oid);
    try {
        const first = recordDuplicateOrphanDetection(oid);
        assert.strictEqual(first.count, 1, `first sighting count must be 1, got ${first.count}`);
        assert.strictEqual(first.shouldEscalate, false, 'first sighting must not escalate');
    } finally {
        clearDuplicateOrphanDetection(oid);
    }
    console.log('  PASS');
}

async function testEscalationRepeatedDetectionWarns() {
    console.log('\n - Repeated detection of the same orphan escalates (rate-limited)...');
    const oid = '1.7.ESC-REPEAT';
    clearDuplicateOrphanDetection(oid);
    try {
        const first = recordDuplicateOrphanDetection(oid);
        assert.strictEqual(first.shouldEscalate, false, 'first sighting must not escalate');

        const second = recordDuplicateOrphanDetection(oid);
        assert.strictEqual(second.count, 2, `second sighting count must be 2, got ${second.count}`);
        assert.strictEqual(second.shouldEscalate, true, 'repeated sighting must escalate to warn');

        // Within the warn-rate-limit window the third sighting stays quiet.
        const third = recordDuplicateOrphanDetection(oid);
        assert.strictEqual(third.count, 3, `third sighting count must be 3, got ${third.count}`);
        assert.strictEqual(third.shouldEscalate, false,
            'repeat warns must be rate-limited (no escalation until the window elapses)');
    } finally {
        clearDuplicateOrphanDetection(oid);
    }
    console.log('  PASS');
}

async function testEscalationClearedOnResolve() {
    console.log('\n - Clearing a resolved orphan resets the counter...');
    const oid = '1.7.ESC-CLEAR';
    clearDuplicateOrphanDetection(oid);
    try {
        recordDuplicateOrphanDetection(oid);
        recordDuplicateOrphanDetection(oid);
        clearDuplicateOrphanDetection(oid);
        const fresh = recordDuplicateOrphanDetection(oid);
        assert.strictEqual(fresh.count, 1, 'after clear the next sighting must start fresh');
        assert.strictEqual(fresh.shouldEscalate, false, 'after clear there must be no escalation');
    } finally {
        clearDuplicateOrphanDetection(oid);
    }
    console.log('  PASS');
}

(async () => {
    console.log('\n========== DUPLICATE ORPHAN ESCALATION TESTS ==========');
    await testIsOrderGoneErrorMessage();
    await testEscalationFirstSightingStaysInfo();
    await testEscalationRepeatedDetectionWarns();
    await testEscalationClearedOnResolve();
    console.log('\n✅ Duplicate orphan escalation tests passed!\n');
})().catch((err) => {
    console.error('\n❌ DUPLICATE ORPHAN ESCALATION TEST FAILED:');
    console.error(err);
    process.exit(1);
});
