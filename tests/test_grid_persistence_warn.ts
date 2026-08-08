/**
 * Validation-failure warning regression test
 *
 * Background: modules/dexbot_class.ts:_executeBatchIfNeeded has a `warn`
 * branch that fires when the no-action COW path's persistGrid() returns
 * a validation failure. The original guard was
 *
 *     persistResult.skipped === false && persistResult.isValid === false
 *
 * but persistGrid() never sets `skipped: false` (it only sets `skipped: true`
 * for the suspended path, and omits it entirely on success / validation
 * failure). So `skipped === false` was always `undefined === false === false`,
 * and the warn branch was dead code.
 *
 * The fix: `persistResult.skipped !== true && persistResult.isValid === false`.
 *
 * This test pins the new behaviour: a validation-failure return from
 * persistGrid() must trigger the warning log.
 */

const assert = require('assert');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');
const { getErrorMessage } = require('../modules/utils/errors');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const DEXBot = require('../modules/dexbot_class').default;
const { hasExecutableActions } = require('../modules/order/utils/validate');

let testsComplete = false;
process.on('unhandledRejection', (reason) => {
    if (testsComplete) return;
    console.error('Test failed:', reason);
    process.exit(1);
});

function createFixture() {
    const bot = new DEXBot({
        botKey: 'test_validation_warn',
        dryRun: false,
        startPrice: 1,
        assetA: 'BTS',
        assetB: 'USD',
        incrementPercent: 0.5
    });

    const logs = [];
    const manager = {
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
        },
        orders: Object.freeze(new Map()),
        logger: {
            log: (msg, level) => logs.push({ msg, level }),
            logFundsStatus: () => {}
        },
        _clearWorkingGridRef: () => {},
        _updateOrder: async () => true,
        persistGrid: async () => ({ isValid: true }),
        applyGridUpdateBatch: async () => {}
    };
    bot.manager = manager;
    bot.account = 'test-account';
    bot.privateKey = 'test-private-key';

    return { bot, manager, logs };
}

async function testValidationFailureTriggersWarning() {
    console.log('\n[WARN-001] validation-failure from persistGrid triggers the warn log...');
    const { bot, manager, logs } = createFixture();

    // Stub persistGrid to return a validation-failure result. Note:
    // there is NO `skipped` field on this object — the production code
    // path returns { isValid: false, reason } without setting skipped.
    manager.persistGrid = async () => ({
        isValid: false,
        reason: 'simulated corruption'
    });

    // Empty actions → no-action COW path. The function should:
    //   1. Call _clearWorkingGridRef.
    //   2. Call persistGrid (no args).
    //   3. WARN because validation rejected the state.
    const rebalanceResult = { actions: [], stateUpdates: [] };
    assert.strictEqual(hasExecutableActions(rebalanceResult), false,
        'Empty actions should yield hasExecutableActions=false');

    const result = await bot._executeBatchIfNeeded(rebalanceResult, 'test-no-action');

    assert.strictEqual(result?.skippedNoActions, true,
        'Should report skippedNoActions');

    const warnings = logs.filter(l => l.level === 'warn');
    assert.ok(warnings.length >= 1, `Should have at least one warning, got ${warnings.length}`);
    const matchingWarn = warnings.find(w =>
        w.msg.includes('Master grid persistence validation failed')
        && w.msg.includes('test-no-action')
        && w.msg.includes('simulated corruption')
    );
    assert.ok(matchingWarn, `Should have the validation-failure warning. Got: ${JSON.stringify(warnings)}`);
    console.log('   ✓ Validation-failure from persistGrid triggers warn log with context label + reason');
}

async function testSuspendedDoesNotTriggerWarning() {
    console.log('\n[WARN-002] suspended persistGrid does NOT trigger the warn log...');
    const { bot, manager, logs } = createFixture();

    // Stub persistGrid to return the suspended shape. Note: skipped: true,
    // isValid: true. The production code path should NOT warn in this
    // case — suspension is handled by the persistence gate elsewhere.
    manager.persistGrid = async () => ({
        isValid: true,
        skipped: true,
        suspended: true,
        reason: 'simulated suspension'
    });

    const rebalanceResult = { actions: [], stateUpdates: [] };
    const result = await bot._executeBatchIfNeeded(rebalanceResult, 'test-suspended');
    assert.strictEqual(result?.skippedNoActions, true);

    const warnings = logs.filter(l => l.level === 'warn');
    assert.strictEqual(warnings.length, 0,
        `Suspended path should not warn. Got: ${JSON.stringify(warnings)}`);
    console.log('   ✓ Suspended persistGrid: zero warn logs');
}

async function testSuccessDoesNotTriggerWarning() {
    console.log('\n[WARN-003] successful persistGrid does NOT trigger the warn log...');
    const { bot, manager, logs } = createFixture();

    manager.persistGrid = async () => ({ isValid: true });

    const rebalanceResult = { actions: [], stateUpdates: [] };
    const result = await bot._executeBatchIfNeeded(rebalanceResult, 'test-success');
    assert.strictEqual(result?.skippedNoActions, true);

    const warnings = logs.filter(l => l.level === 'warn');
    assert.strictEqual(warnings.length, 0,
        `Successful persistGrid should not warn. Got: ${JSON.stringify(warnings)}`);
    console.log('   ✓ Successful persistGrid: zero warn logs');
}

async function testApplyRecoverableUpdatesReturnsCount() {
    console.log('\n[WARN-004] _applyRecoverableGridUpdates returns the actual count applied...');
    const { bot, manager } = createFixture();
    const updates = [
        { id: 'u1', size: 1 }, { id: 'u2', size: 1 }, { id: 'u3', size: 1 }
    ];
    manager.applyGridUpdateBatch = async () => {};
    manager.persistGrid = async () => ({ isValid: true });

    const applied = await bot._applyRecoverableGridUpdates(updates, 'test-batch');
    assert.strictEqual(applied, 3,
        'applyGridUpdateBatch path should return the number of updates supplied');

    // Fallback path: no applyGridUpdateBatch, only _updateOrder available.
    delete manager.applyGridUpdateBatch;
    let updateCount = 0;
    manager._updateOrder = async () => { updateCount++; return true; };

    const appliedFallback = await bot._applyRecoverableGridUpdates(updates, 'test-fallback');
    assert.strictEqual(appliedFallback, 3,
        'Fallback _updateOrder path should return the actual number applied');
    assert.strictEqual(updateCount, 3);

    // Edge case: missing _updateOrder. The fallback short-circuits with
    // applied=0, so the function must NOT lie by returning updates.length.
    delete manager._updateOrder;
    const appliedNone = await bot._applyRecoverableGridUpdates(updates, 'test-no-update');
    assert.strictEqual(appliedNone, 0,
        'Missing _updateOrder must yield 0, not updates.length');
    console.log('   ✓ applyGridUpdateBatch: 3, fallback _updateOrder: 3, missing _updateOrder: 0');
}

(async () => {
    try {
        await testValidationFailureTriggersWarning();
        await testSuspendedDoesNotTriggerWarning();
        await testSuccessDoesNotTriggerWarning();
        await testApplyRecoverableUpdatesReturnsCount();

        testsComplete = true;
        console.log('\n✓ All validation-failure warning tests passed!\n');
        process.exit(0);
    } catch (e) {
        console.error('\n✗ Test failed:', getErrorMessage(e));
        console.error((e as any).stack);
        process.exit(1);
    }
})();
