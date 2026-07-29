/**
 * Grid Dirty-Flag Persistence Tests
 *
 * Verifies the end-of-tick safety net that prevents the regression where
 * a partial-only fill batch (no full fills → no COW rebalance → no
 * persistGrid) leaves the in-memory master grid ahead of the on-disk
 * snapshot, so slot-108 size 0.3293 → 0.0001 was lost on restart.
 *
 * The fix is a dirty-flag pattern on OrderManager:
 *   - Every successful _updateOrder() / applyGridUpdateBatch() call
 *     sets `_gridDirtyAt` to the current timestamp.
 *   - The new `flushGridDirty()` method persists the grid iff the
 *     flag is set, then clears it.
 *   - `_processFillsWithBatching` calls `flushGridDirty('end-of-tick')`
 *     in its `finally` block, catching any direct master-grid
 *     mutations that did not reach a known persistGrid() site.
 *
 * These tests cover:
 *   1. _updateOrder() flips isGridDirty to true.
 *   2. applyGridUpdateBatch() flips isGridDirty to true.
 *   3. flushGridDirty() persists iff dirty; idempotent on clean grid.
 *   4. flushGridDirty() honours suspendGridPersistence().
 *   5. flushGridDirty() clears the flag on success.
 *   6. flushGridDirty() keeps the flag set on validation failure
 *      so a later tick can retry.
 *   7. isGridDirty() reports the current state.
 *   8. End-of-tick flush catches the slot-108 partial-fill regression.
 *   9. _markGridDirty() can be called for external mutations.
 */

const assert = require('assert');
const { installBitsharesClientStub } = require('./helpers/bitshares_client_stub');

const bitsharesClientPath = require.resolve('../modules/bitshares_client');
installBitsharesClientStub(bitsharesClientPath);

const { OrderManager } = require('../modules/order/manager');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { getErrorMessage } = require('../modules/utils/errors');

let testsComplete = false;
process.on('unhandledRejection', (reason) => {
    if (testsComplete) return;
    console.error('Test failed:', reason);
    process.exit(1);
});

function createFixture() {
    const manager = new OrderManager({
        assetA: 'BTS',
        assetB: 'USD',
        market: 'BTS/USD',
        accountId: 'test-account'
    });
    const logs = [];
    manager.logger = { log: (msg, level) => logs.push({ msg, level }) };
    manager.assets = {
        assetA: { id: '1.3.0', symbol: 'BTS', precision: 8 },
        assetB: { id: '1.3.121', symbol: 'USD', precision: 5 }
    };
    manager.btsBalance = { free: 1000, total: 1000, locked: 0 };
    // accountTotals must be valid for the real persistGrid's validation
    // gate to pass; otherwise the dirty-flag-clearing path is unreachable
    // in the test fixture.
    manager.accountTotals = { buyFree: 1000, sellFree: 1000, buy: 1000, sell: 1000 };
    // accountOrders is required by persistGridSnapshot; provide a mock
    // that succeeds so the dirty-flag-clearing path is exercised.
    manager.accountOrders = {
        storeMasterGrid: async () => {}
    };

    const master = new Map([
        ['slot-1', {
            id: 'slot-1',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.ACTIVE,
            price: 100,
            size: 10,
            orderId: '1.7.100'
        }],
        ['slot-108', {
            id: 'slot-108',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            price: 1018.96,
            size: 0.3293,
            orderId: '1.7.572952363'
        }]
    ]);
    manager.orders = Object.freeze(master);

    const persistCalls = [];
    // Wrap the real persistGrid so the new dirty-flag-clearing behaviour
    // is exercised end-to-end, and the spy observes each call. Tests that
    // want to simulate a corrupt or suspending persistGrid can replace
    // `manager.persistGrid` themselves.
    const realPersistGrid = manager.persistGrid.bind(manager);
    manager.persistGrid = async (snapshot) => {
        persistCalls.push({
            hasSnapshot: snapshot !== undefined,
            ts: Date.now()
        });
        return await realPersistGrid(snapshot);
    };

    return { manager, logs, persistCalls };
}

async function testDirtyFlagSetOnUpdate() {
    console.log('\n[DIRTY-001] _updateOrder sets isGridDirty=true...');
    const { manager, persistCalls } = createFixture();
    assert.strictEqual(manager.isGridDirty(), false, 'Grid should start clean');

    await manager._updateOrder({
        id: 'slot-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 100,
        size: 5,
        orderId: '1.7.100'
    }, 'handle-fill-partial', { skipAccounting: true });

    assert.strictEqual(manager.isGridDirty(), true, 'Grid should be dirty after _updateOrder');
    assert.strictEqual(persistCalls.length, 0, 'persistGrid should NOT be called by _updateOrder alone');
    console.log('   ✓ Grid dirty after _updateOrder');
}

async function testDirtyFlagSetOnBatch() {
    console.log('\n[DIRTY-002] applyGridUpdateBatch sets isGridDirty=true...');
    const { manager } = createFixture();
    assert.strictEqual(manager.isGridDirty(), false);

    await manager.applyGridUpdateBatch([
        {
            id: 'slot-1',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            price: 100,
            size: 5,
            orderId: '1.7.100'
        },
        {
            id: 'slot-108',
            type: ORDER_TYPES.SELL,
            state: ORDER_STATES.PARTIAL,
            price: 1018.96,
            size: 0.0001,
            orderId: '1.7.572952363'
        }
    ], 'partial-fill-batch', { skipAccounting: true });

    assert.strictEqual(manager.isGridDirty(), true, 'Grid should be dirty after applyGridUpdateBatch');
    console.log('   ✓ Grid dirty after batch update');
}

async function testFlushDirtyPersists() {
    console.log('\n[DIRTY-003] flushGridDirty calls persistGrid when dirty...');
    const { manager, persistCalls } = createFixture();
    await manager._updateOrder({
        id: 'slot-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 100,
        size: 5,
        orderId: '1.7.100'
    }, 'handle-fill-partial', { skipAccounting: true });

    const result = await manager.flushGridDirty('test');
    assert.strictEqual(result?.isValid, true, 'Flush should succeed');
    assert.strictEqual(persistCalls.length, 1, 'persistGrid should be called once');
    assert.strictEqual(manager.isGridDirty(), false, 'Grid should be clean after successful flush');
    console.log(`   ✓ persistGrid called ${persistCalls.length}×, flag cleared`);
}

async function testFlushDirtyNoOpWhenClean() {
    console.log('\n[DIRTY-004] flushGridDirty is a no-op when clean...');
    const { manager, persistCalls } = createFixture();
    assert.strictEqual(manager.isGridDirty(), false);

    const result = await manager.flushGridDirty('test');
    assert.strictEqual(result?.skipped, true, 'Flush should be skipped on clean grid');
    assert.strictEqual(result?.reason, 'not-dirty');
    assert.strictEqual(persistCalls.length, 0, 'persistGrid should NOT be called when clean');
    console.log('   ✓ Clean grid: no persist, skipped=true, reason=not-dirty');
}

async function testPersistGridClearsDirtyFlag() {
    console.log('\n[DIRTY-011] persistGrid clears the dirty flag on successful live-grid persist...');
    const { manager, persistCalls } = createFixture();
    await manager._updateOrder({
        id: 'slot-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 100,
        size: 5,
        orderId: '1.7.100'
    }, 'handle-fill-partial', { skipAccounting: true });
    assert.strictEqual(manager.isGridDirty(), true);

    // Direct persistGrid call (no explicit snapshot) — should clear the
    // dirty flag so a subsequent end-of-tick flushGridDirty() is a no-op.
    const result = await manager.persistGrid();
    assert.strictEqual(result?.isValid, true);
    assert.strictEqual(persistCalls.length, 1);
    assert.strictEqual(manager.isGridDirty(), false,
        'Dirty flag should be cleared after successful live-grid persist');

    // The subsequent end-of-tick flush should be a no-op (no second write).
    const endOfTick = await manager.flushGridDirty('end-of-tick');
    assert.strictEqual(endOfTick?.skipped, true, 'End-of-tick flush should skip when already clean');
    assert.strictEqual(persistCalls.length, 1, 'No second persist should occur');
    console.log('   ✓ persistGrid cleared flag; subsequent flushGridDirty is a no-op (no double-write)');
}

async function testPersistGridWithExplicitSnapshotPreservesDirtyFlag() {
    console.log('\n[DIRTY-012] persistGrid with explicit snapshot does NOT clear the dirty flag...');
    const { manager, persistCalls } = createFixture();
    await manager._updateOrder({
        id: 'slot-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 100,
        size: 5,
        orderId: '1.7.100'
    }, 'handle-fill-partial', { skipAccounting: true });
    assert.strictEqual(manager.isGridDirty(), true);

    // Snapshot-orders persist (e.g. startup storeGrid) writes a
    // caller-supplied grid, not the live grid. The live grid is still
    // dirty, so the flag must remain set.
    const explicitSnapshot = [
        { id: 'snap-1', type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, price: 100, size: 1, orderId: '1.7.999' }
    ];
    const result = await manager.persistGrid(explicitSnapshot);
    assert.strictEqual(result?.isValid, true);
    assert.strictEqual(persistCalls.length, 1);
    assert.strictEqual(persistCalls[0].hasSnapshot, true, 'Snapshot should be passed through');
    assert.strictEqual(manager.isGridDirty(), true,
        'Dirty flag should remain set when an explicit snapshot was persisted');
    console.log('   ✓ Explicit-snapshot persist: live grid dirty flag preserved');
}

async function testFlushDirtyHonoursSuspension() {
    console.log('\n[DIRTY-005] flushGridDirty honours suspendGridPersistence...');
    const { manager, persistCalls } = createFixture();
    await manager._updateOrder({
        id: 'slot-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 100,
        size: 5,
        orderId: '1.7.100'
    }, 'handle-fill-partial', { skipAccounting: true });

    manager.suspendGridPersistence('test-suspension');
    const result = await manager.flushGridDirty('test');
    assert.strictEqual(result?.skipped, true);
    assert.strictEqual(result?.suspended, true);
    assert.strictEqual(persistCalls.length, 0, 'persistGrid should NOT be called while suspended');
    assert.strictEqual(manager.isGridDirty(), true, 'Dirty flag should remain set while suspended');

    manager.resumeGridPersistence('test-resume');
    const retry = await manager.flushGridDirty('test-retry');
    assert.strictEqual(retry?.isValid, true);
    assert.strictEqual(persistCalls.length, 1, 'persistGrid should be called after resume');
    assert.strictEqual(manager.isGridDirty(), false);
    console.log('   ✓ Suspended: skipped, dirty preserved; resumed: persisted, flag cleared');
}

async function testFlushDirtyKeepsFlagOnValidationFailure() {
    console.log('\n[DIRTY-006] flushGridDirty keeps flag set on validation failure...');
    const { manager, persistCalls } = createFixture();
    await manager._updateOrder({
        id: 'slot-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 100,
        size: 5,
        orderId: '1.7.100'
    }, 'handle-fill-partial', { skipAccounting: true });

    // Make persistGrid return an invalid result.
    manager.persistGrid = async () => ({ isValid: false, reason: 'simulated corruption' });
    const result = await manager.flushGridDirty('test');
    assert.strictEqual(result?.isValid, false);
    assert.strictEqual(result?.reason, 'simulated corruption');
    // The replacement stub above intentionally does NOT push to persistCalls,
    // so the original spy array (still bound to the previous persistGrid
    // implementation) stays at length 0. We assert that the new stub was
    // called via the dirty-flag-preserved behaviour below, not via the spy.
    assert.strictEqual(persistCalls.length, 0,
        'persistCalls spy is bound to the original stub, not the corruption stub');
    assert.strictEqual(manager.isGridDirty(), true, 'Dirty flag must remain so a later tick can retry');
    console.log('   ✓ Validation failure: flag preserved, retry possible');
}

async function testIsGridDirtyReportsState() {
    console.log('\n[DIRTY-007] isGridDirty reports current state...');
    const { manager } = createFixture();
    assert.strictEqual(manager.isGridDirty(), false, 'Initial state: clean');
    await manager._updateOrder({
        id: 'slot-1',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 100,
        size: 5,
        orderId: '1.7.100'
    }, 'handle-fill-partial', { skipAccounting: true });
    assert.strictEqual(manager.isGridDirty(), true, 'After mutation: dirty');
    await manager.flushGridDirty('test');
    assert.strictEqual(manager.isGridDirty(), false, 'After flush: clean');
    console.log('   ✓ isGridDirty tracks state through mutation and flush');
}

async function testSlot108RegressionScenario() {
    console.log('\n[DIRTY-008] slot-108 regression: partial-only fill without COW still persists...');
    const { manager, persistCalls } = createFixture();

    // Simulate the exact regression scenario: a partial fill reduces
    // size from 0.3293 to 0.0001, applied directly to the master grid
    // by the sync engine. The COW path produces no actions (no full
    // fills), so without the dirty-flag safety net the size would not
    // be persisted.
    await manager._updateOrder({
        id: 'slot-108',
        type: ORDER_TYPES.SELL,
        state: ORDER_STATES.PARTIAL,
        price: 1018.96,
        size: 0.0001,
        orderId: '1.7.572952363'
    }, 'handle-fill-partial', { skipAccounting: true });

    assert.strictEqual(manager.isGridDirty(), true);
    assert.strictEqual(persistCalls.length, 0, 'No persist yet — dirty only');

    // Simulate end-of-tick flush as DEXBot._processFillsWithBatching does.
    const result = await manager.flushGridDirty('end-of-tick fill processing');
    assert.strictEqual(result?.isValid, true);
    assert.strictEqual(persistCalls.length, 1, 'End-of-tick flush persisted the partial-fill size');
    assert.strictEqual(manager.isGridDirty(), false);

    console.log('   ✓ slot-108 partial-only fill size 0.0001 persisted via end-of-tick flush');
}

async function testMarkGridDirtyPublicMethod() {
    console.log('\n[DIRTY-009] _markGridDirty can be called for external mutations...');
    const { manager } = createFixture();
    assert.strictEqual(manager.isGridDirty(), false);

    manager._markGridDirty();
    assert.strictEqual(manager.isGridDirty(), true);

    manager._clearGridDirty();
    assert.strictEqual(manager.isGridDirty(), false);
    console.log('   ✓ _markGridDirty + _clearGridDirty work for external mutation sites');
}

(async () => {
    try {
        await testDirtyFlagSetOnUpdate();
        await testDirtyFlagSetOnBatch();
        await testFlushDirtyPersists();
        await testFlushDirtyNoOpWhenClean();
        await testPersistGridClearsDirtyFlag();
        await testPersistGridWithExplicitSnapshotPreservesDirtyFlag();
        await testFlushDirtyHonoursSuspension();
        await testFlushDirtyKeepsFlagOnValidationFailure();
        await testIsGridDirtyReportsState();
        await testSlot108RegressionScenario();
        await testMarkGridDirtyPublicMethod();

        testsComplete = true;
        console.log('\n✓ All grid dirty-flag persistence tests passed!\n');
        process.exit(0);
    } catch (e) {
        console.error('\n✗ Test failed:', getErrorMessage(e));
        console.error((e as any).stack);
        process.exit(1);
    }
})();
