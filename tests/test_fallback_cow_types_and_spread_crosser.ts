/**
 * Test for failed COW commit retry signaling and SPREAD→BUY crosser
 * handling in applyGridDivergenceCorrections.
 *
 * These tests drive applyGridDivergenceCorrections with a fund-ratio
 * boundary shift and verify:
 *   1. After a failed commit, master is NOT patched (types stay stale),
 *      and the function returns { committed: false, boundaryChanged: true }
 *      so the caller can schedule a retry.
 *   2. A SPREAD slot with an on-chain order that the boundary shift
 *      reclassifies to BUY is correctly attributed to the BUY side and
 *      does NOT produce a spurious CREATE.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { applyGridDivergenceCorrections } = require('../modules/order/utils/system');
const { ORDER_STATES, ORDER_TYPES, COW_ACTIONS } = require('../modules/constants');

/**
 * Set up a 10-slot grid with boundaryIdx=3, gapSlots=2.
 *   slots 0-3: BUY  (prices 95-98)
 *   slots 4-5: SPREAD (prices 99-100)
 *   slots 6-9: SELL (prices 101-104)
 *
 * Places on-chain BUY orders at slots 0,1,2.
 * Then patches slot-4 directly (bypasses SPREAD→ACTIVE invariant)
 * to simulate an on-chain order that was placed as BUY/SELL before a
 * boundary shift reclassified the slot as SPREAD.
 *
 * fund.available is set directly to produce a deterministic boundary.
 * With sell=30, buy=5700, price=100:
 *   valA = 30*100 = 3000, valB = 5700, totalVal = 8700
 *   valB/totalVal = 5700/8700 ≈ 0.655
 *   targetBuySlots = round(8 * 0.655) = round(5.24) = 5
 *   newBoundary = 5-1 = 4
 *   clamp: lower=4 (maxBuyIdx from stale types), upper=6 (minSellIdx-1 from stale types)
 *   4 is in range → boundary shifts from 3 to 4.
 *
 * @param {number} [sellFunds=30]
 * @param {number} [buyFunds=5700]
 */
async function createBoundaryShiftFixture(sellFunds = 30, buyFunds = 5700) {
    const manager = new OrderManager({
        assetA: 'TESTA',
        assetB: 'TESTB',
        startPrice: 100,
        incrementPercent: 1,
        targetSpreadPercent: 2,
        activeOrders: { buy: 5, sell: 2 },
        botFunds: { buy: 10000, sell: 5000 },
    });

    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 },
    };

    manager.boundaryIdx = 3;
    manager.outOfSpread = 1;
    manager._gridVersion = 1;

    for (let i = 0; i < 10; i++) {
        const type = i <= 3 ? ORDER_TYPES.BUY : (i <= 5 ? ORDER_TYPES.SPREAD : ORDER_TYPES.SELL);
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 95 + i,
            type,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
        });
    }

    // Place on-chain BUY orders at slots 0,1,2
    await manager._updateOrder({ id: 'slot-0', price: 95,  type: ORDER_TYPES.BUY,    state: ORDER_STATES.ACTIVE, size: 100, orderId: 'chain-0' });
    await manager._updateOrder({ id: 'slot-1', price: 96,  type: ORDER_TYPES.BUY,    state: ORDER_STATES.ACTIVE, size: 100, orderId: 'chain-1' });
    await manager._updateOrder({ id: 'slot-2', price: 97,  type: ORDER_TYPES.BUY,    state: ORDER_STATES.ACTIVE, size: 100, orderId: 'chain-2' });

    // slot-4 (SPREAD) — must be patched directly because OrderManager rejects
    // moving a SPREAD slot to ACTIVE.  In a real bot this state arises when a
    // boundary shift reclassifies a previously-placed BUY/SELL slot as SPREAD.
    // We patch the frozen master map to inject the orderId and state.
    const patched = new Map(manager.orders);
    patched.set('slot-4', Object.freeze({
        id: 'slot-4',
        price: 99,
        type: ORDER_TYPES.SPREAD,
        state: ORDER_STATES.ACTIVE,
        size: 100,
        orderId: 'chain-4',
        rawOnChain: { for_sale: 100 },
    }));
    // Rebuild indexes by hand since we bypassed _updateOrder
    const byState: Record<string, Set<string>> = {
        [ORDER_STATES.VIRTUAL]: new Set(),
        [ORDER_STATES.ACTIVE]: new Set(),
        [ORDER_STATES.PARTIAL]: new Set(),
    };
    const byType: Record<string, Set<string>> = {
        [ORDER_TYPES.BUY]: new Set(),
        [ORDER_TYPES.SELL]: new Set(),
        [ORDER_TYPES.SPREAD]: new Set(),
    };
    for (const [, o] of patched) {
        if (byState[o.state]) byState[o.state].add(o.id);
        if (byType[o.type]) byType[o.type].add(o.id);
    }
    manager.orders = Object.freeze(patched);
    manager._ordersByState = byState;
    manager._ordersByType = byType;

    // Set funds directly so syncBoundaryToFunds has deterministic values
    // regardless of accounting internals.
    manager.funds = {
        available: { sell: sellFunds, buy: buyFunds },
        total: {},
        locked: { sell: 0, buy: 0 },
        virtual: { sell: 0, buy: 0 },
        committed: { grid: { sell: 0, buy: 0 }, chain: { sell: 0, buy: 0 } },
        btsFeesReservation: 0,
    };
    await manager.setAccountTotals({ buy: buyFunds, sell: sellFunds, buyFree: buyFunds, sellFree: sellFunds });

    manager._gridSidesUpdated = new Set([ORDER_TYPES.BUY, ORDER_TYPES.SELL]);

    return manager;
}

async function testFailedCommitSignalsRetry() {
    console.log('\n=== Test 1: Failed commit returns { committed: false, boundaryChanged: true } ===\n');

    const manager = await createBoundaryShiftFixture();

    // Pre-assert: master has stale SPREAD type for slot-4 (will NOT be patched)
    assert(manager.orders.get('slot-4').type === ORDER_TYPES.SPREAD,
        'Pre-condition: slot-4 is SPREAD in master');
    assert(manager.orders.get('slot-4').orderId === 'chain-4',
        'Pre-condition: slot-4 has orderId');
    const preBoundary = manager.boundaryIdx;

    let capturedCowResult: any = null;
    const mockUpdateFn = async (cowResult: any) => {
        capturedCowResult = cowResult;
        return { executed: false };  // Commit failure
    };
    const mockAccountOrders = { storeMasterGrid: async () => {} };

    let result = await applyGridDivergenceCorrections(manager, mockAccountOrders, 'bot-key', mockUpdateFn);

    // Assert 1: function returned the correct signal
    assert(result, 'Should return a result object');
    assert(result.committed === false, `committed should be false, got ${result.committed}`);
    assert(result.boundaryChanged === true, `boundaryChanged should be true, got ${result.boundaryChanged}`);

    // Assert 2: master is NOT patched — types remain stale, and boundaryIdx
    // is NOT eagerly written (syncBoundaryToFunds is a pure computation; writes
    // only happen inside _commitWorkingGrid via _setBoundary).
    assert(manager.boundaryIdx === preBoundary,
        `boundary should NOT have changed (stays ${preBoundary}), got ${manager.boundaryIdx}`);
    const slot4 = manager.orders.get('slot-4');
    assert(slot4.type === ORDER_TYPES.SPREAD,
        `slot-4 should remain SPREAD (master not patched), got ${slot4.type}`);

    // Assert 3: slot-0,1,2 (BUY) unchanged
    assert(manager.orders.get('slot-0').type === ORDER_TYPES.BUY, 'slot-0 still BUY');
    assert(manager.orders.get('slot-1').type === ORDER_TYPES.BUY, 'slot-1 still BUY');
    assert(manager.orders.get('slot-2').type === ORDER_TYPES.BUY, 'slot-2 still BUY');

    // Assert 4: orderIds preserved (nothing touched them)
    assert(manager.orders.get('slot-0').orderId === 'chain-0', 'slot-0 orderId preserved');
    assert(manager.orders.get('slot-4').orderId === 'chain-4', 'slot-4 orderId preserved');

    // Assert 5: sizes unchanged
    assert(manager.orders.get('slot-4').size === 100, 'slot-4 size unchanged');
    assert(manager.orders.get('slot-0').size === 100, 'slot-0 size unchanged');

    console.log('  ✓ returned { committed: false, boundaryChanged: true }');
    console.log('  ✓ boundary unchanged:', manager.boundaryIdx, '(stays', preBoundary + ')');
    console.log('  ✓ slot-4 type:', slot4.type, '(stale, not patched)');
    console.log('  ✓ orderIds and sizes untouched\n');
}

async function testSpreadBuyCrosserNoSpuriousCreate() {
    console.log('=== Test 2: SPREAD→BUY crosser does not produce spurious CREATE ===\n');

    const manager = await createBoundaryShiftFixture();
    manager._gridVersion = 2;

    let capturedCowResult: any = null;
    const mockUpdateFn = async (cowResult: any) => {
        capturedCowResult = cowResult;
        return { executed: true };  // Success
    };

    await applyGridDivergenceCorrections(manager, { storeMasterGrid: async () => {} }, 'bot-key', mockUpdateFn);

    assert(capturedCowResult, 'Should have COW result');
    assert(Array.isArray(capturedCowResult.actions), 'Should have actions');

    // Verify no CREATE for slot-4 (the SPREAD→BUY crosser)
    const createsForSlot4 = capturedCowResult.actions.filter(
        (a: any) => a.type === COW_ACTIONS.CREATE && a.id === 'slot-4'
    );
    assert.strictEqual(createsForSlot4.length, 0,
        `slot-4 should NOT have a CREATE (${createsForSlot4.length} found)`);

    // Verify slot-4 is in working grid with correct type (BUY, not SPREAD)
    const wSlot4 = capturedCowResult.workingGrid.get('slot-4');
    assert(wSlot4, 'slot-4 should be in working grid');
    assert(wSlot4.type === ORDER_TYPES.BUY,
        `slot-4 should be BUY in working grid, got ${wSlot4.type}`);

    // Verify slot-4 actions are UPDATE or CANCEL (not CREATE)
    const slot4Actions = capturedCowResult.actions.filter(
        (a: any) => (a.id === 'slot-4' || a.newGridId === 'slot-4')
    );
    for (const action of slot4Actions) {
        assert(action.type !== COW_ACTIONS.CREATE,
            `slot-4 action should not be CREATE, got ${action.type}`);
    }

    const updateForSlot4 = capturedCowResult.actions.filter(
        (a: any) => a.type === COW_ACTIONS.UPDATE && (a.id === 'slot-4' || a.newGridId === 'slot-4')
    );
    const cancelForSlot4 = capturedCowResult.actions.filter(
        (a: any) => a.type === COW_ACTIONS.CANCEL && a.id === 'slot-4'
    );

    // Use working-grid type for diagnostic (master still has stale SPREAD
    // type because the commit was not executed — intentionally, the retry
    // approach leaves master untouched until the next attempt).
    const wgCrosserType = capturedCowResult.workingGrid.get('slot-4')?.type;
    console.log('  ✓ slot-4 in working grid as', wgCrosserType);
    console.log('  ✓ slot-4 CREATE actions:', createsForSlot4.length);
    console.log('  ✓ slot-4 UPDATE actions:', updateForSlot4.length);
    console.log('  ✓ slot-4 CANCEL actions:', cancelForSlot4.length);

    // Verify no duplicate CREATE IDs across all actions
    const allCreates = capturedCowResult.actions.filter((a: any) => a.type === COW_ACTIONS.CREATE);
    const createIds = allCreates.map((a: any) => a.id);
    const uniqueCreateIds = new Set(createIds);
    assert.strictEqual(createIds.length, uniqueCreateIds.size,
        `No duplicate CREATE IDs: ${createIds.length} total, ${uniqueCreateIds.size} unique`);

    // slot-4 was handled as an existing on-chain order (working grid reflects
    // the post-shift BUY type), not queued as a spurious CREATE.
    assert.strictEqual(createsForSlot4.length, 0);

    console.log('  ✓ No duplicate CREATEs across all slots');
    console.log('  ✓ SPREAD→BUY crosser correctly handled\n');
}

async function main() {
    await testFailedCommitSignalsRetry();
    await testSpreadBuyCrosserNoSpuriousCreate();
    console.log('✓ All commit-retry-signal and SPREAD→BUY crosser tests PASSED!\n');
}

if (require.main === module) {
    main().catch(err => {
        console.error('Test FAILED:', err);
        process.exit(1);
    });
}

module.exports = { testFailedCommitSignalsRetry, testSpreadBuyCrosserNoSpuriousCreate };
