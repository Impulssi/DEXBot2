/**
 * Gap-evacuation streak persistence test suite (Phase 3 restart
 * resilience) — GEP-1..4.
 *
 * Covers: storeMasterGrid sanitization + round-trip, empty-map clearing,
 * restoreGapEvacStreaks pruning to surviving slots, and the
 * persistGridSnapshot Map->object pass-through.
 */

const assert = require('assert');
const fs = require('fs');
const { AccountOrders, createBotKey } = require('../modules/account_orders');
const { persistGridSnapshot, restoreGapEvacStreaks } = require('../modules/order/utils/system');

async function testGEP1_StoreLoadRoundTrip() {
    console.log('\n[GEP-1] storeMasterGrid sanitizes and round-trips streaks...');
    const botKey = createBotKey({ name: 'gap-evac-streak-test' }, 0);
    const accountOrders = new AccountOrders({ botKey });
    await accountOrders.storeMasterGrid(
        [{ id: 'slot-143', type: 'sell', state: 'virtual', price: 100, size: 0, orderId: null }],
        0, 141, null, null, null, null,
        { 'slot-143': 2, 'slot-999': 0, 'bad': -3, '': 7, 'frac': 2.9 }
    );
    const loaded = accountOrders.loadGapEvacStreaks();
    assert.deepStrictEqual(loaded, { 'slot-143': 2, 'frac': 2 },
        'only finite positive counts survive (floored), garbage ids dropped');
    console.log('✓ GEP-1 passed');
}

async function testGEP2_EmptyMapClearsPersistedEntry() {
    console.log('\n[GEP-2] Empty streak map clears the persisted entry...');
    const botKey = createBotKey({ name: 'gap-evac-streak-clear' }, 0);
    const accountOrders = new AccountOrders({ botKey });
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, { 'slot-143': 2 });
    assert.ok(accountOrders.loadGapEvacStreaks(), 'streaks persisted');
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, {});
    assert.strictEqual(accountOrders.loadGapEvacStreaks(), null, 'empty map must clear, not resurrect stale ids');
    // Absent (undefined) parameter leaves stored data untouched.
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null, { 'slot-144': 1 });
    await accountOrders.storeMasterGrid([], 0, null, null, null, null, null);
    assert.deepStrictEqual(accountOrders.loadGapEvacStreaks(), { 'slot-144': 1 },
        'undefined param is a no-op (backward compatible callers)');
    console.log('✓ GEP-2 passed');
}

async function testGEP3_RestorePrunesToSurvivingSlots() {
    console.log('\n[GEP-3] restoreGapEvacStreaks prunes to slots present in the loaded grid...');
    const manager: any = { orders: new Map([['slot-143', { id: 'slot-143' }]]) };
    const restored = restoreGapEvacStreaks(manager, { 'slot-143': 3, 'slot-999': 5, 'gone': -1, 'zero': 0 });
    assert.strictEqual(restored, 1, 'only surviving slots restore');
    assert.ok(manager._gapEvacStreaks instanceof Map);
    assert.strictEqual(manager._gapEvacStreaks.get('slot-143'), 3);
    assert.strictEqual(manager._gapEvacStreaks.size, 1);
    // Null/absent persisted data yields an empty map, never a crash.
    assert.strictEqual(restoreGapEvacStreaks(manager, null), 0);
    assert.strictEqual(restoreGapEvacStreaks(null, { a: 1 }), 0);
    console.log('✓ GEP-3 passed');
}

async function testGEP4_SnapshotPassesManagerStreaksThrough() {
    console.log('\n[GEP-4] persistGridSnapshot forwards manager streaks to storeMasterGrid...');
    let captured: any = null;
    const accountOrders = {
        storeMasterGrid: async (...args: any[]) => { captured = args; },
    };
    const manager = {
        orders: new Map(),
        funds: { btsFeesOwed: 0 },
        accountTotals: null,
        boundaryIdx: 141,
        assets: { assetA: { precision: 5 }, assetB: { precision: 5 } },
        config: null,
        _recentFillKeysSnapshot: null,
        _lastGridPricingContext: null,
        _genesis: null,
        _gapEvacStreaks: new Map([['slot-143', 2]]),
    };
    const ok = await persistGridSnapshot(manager as any, accountOrders as any);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(captured[7], { 'slot-143': 2 }, 'streaks ride the 8th storeMasterGrid param');
    console.log('✓ GEP-4 passed');
}

async function runAllTests() {
    console.log('=== Gap-Evac Streak Persistence Test Suite ===\n');
    try {
        await testGEP1_StoreLoadRoundTrip();
        await testGEP2_EmptyMapClearsPersistedEntry();
        await testGEP3_RestorePrunesToSurvivingSlots();
        await testGEP4_SnapshotPassesManagerStreaksThrough();
        console.log('\n=== All gap-evac streak persistence tests passed! ===');
    } finally {
        // GEP-1/2 write real AccountOrders snapshots under profiles/orders/
        // (gitignored); remove them so test botKeys never linger.
        for (const key of ['gap-evac-streak-test', 'gap-evac-streak-clear']) {
            try { fs.unlinkSync(`profiles/orders/${key}.json`); } catch { /* absent */ }
        }
    }
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });
