const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const cowRuntime = require('../modules/dexbot_cow_runtime');

async function testSpreadBoundaryPromotion() {
    console.log('Running test: Spread Boundary Promotion');

    // Layout: BUY 0-3, gap 4-5, SELL 6-7 (VIRTUAL).
    // After BUY promotion by 2, boundary 3→5, sellStartIdx 6→8 (empty SELL zone).
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 4, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    for (let i = 0; i < 8; i++) {
        const isBuy = i <= 3;
        const isGap = i >= 4 && i <= 5;
        const type = isBuy ? ORDER_TYPES.BUY : isGap ? ORDER_TYPES.SPREAD : ORDER_TYPES.SPREAD;
        const state = isBuy ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
        const size = isBuy ? 10 : 0;
        const orderId = isBuy ? `1.7.${100 + i}` : '';
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type,
            state,
            size,
            orderId
        });
    }
    manager.boundaryIdx = 3;
    manager._gapSlots = 2;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 2);

    assert.strictEqual(correction.ordersToPlace.length, 2, 'Should place both promoted buy slots');
    assert.deepStrictEqual(
        correction.ordersToPlace.map(order => order.id).sort(),
        ['slot-4', 'slot-5'],
        'Should promote the contiguous gap slots above the buy edge'
    );
    assert.strictEqual(correction.boundaryIdx, 5, 'Boundary should move across the placed gap slots');

    const cowResult = cowRuntime.buildCowResultFromPlan(
        { manager: { orders: manager.orders, _gridVersion: 0, boundaryIdx: 3 } },
        correction
    );
    assert.strictEqual(cowResult.workingBoundary, 5, 'COW plan should carry the promoted boundary');
    assert.strictEqual(cowResult.workingGrid.get('slot-4').type, ORDER_TYPES.BUY, 'Promoted slot should be typed BUY in the working grid');

    console.log('  PASS: funded BUY correction promotes the boundary and fills the gap edge');
}

async function testSellSideBoundaryPromotion() {
    console.log('Running test: SELL-side Spread Boundary Promotion');

    // Layout: BUY 0-1 (VIRTUAL), gap 2-3, SELL 4-7.
    // Geometric cap: maxPromotable = buyEndIdx = 1, so only the gap slot
    // closest to the SELL edge (slot-3) is promoted.  Boundary 1→0,
    // sellStartIdx 4→3.  slot-3 (idx 3) lands at sellStartIdx, in-rail.
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 1000, sell: 1000 },
        activeOrders: { buy: 0, sell: 4 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    for (let i = 0; i < 8; i++) {
        const isSell = i >= 4;
        const isGap = i >= 2 && i <= 3;
        const type = isSell ? ORDER_TYPES.SELL : isGap ? ORDER_TYPES.SPREAD : ORDER_TYPES.SPREAD;
        const state = isSell ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
        const size = isSell ? 10 : 0;
        const orderId = isSell ? `1.7.${100 + i}` : '';
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type,
            state,
            size,
            orderId
        });
    }
    manager.boundaryIdx = 1;
    manager._gapSlots = 2;
    await manager.setAccountTotals({ buy: 1000, sell: 1000, buyFree: 1000, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 2);

    assert.strictEqual(correction.ordersToPlace.length, 1, 'Geometric cap allows only 1 promoted slot');
    assert.deepStrictEqual(
        correction.ordersToPlace.map(order => order.id).sort(),
        ['slot-3'],
        'Only the gap slot closest to the SELL edge is promoted'
    );
    assert.strictEqual(correction.boundaryIdx, 0, 'Boundary moves left by 1 (from 1 to 0)');

    const cowResult = cowRuntime.buildCowResultFromPlan(
        { manager: { orders: manager.orders, _gridVersion: 0, boundaryIdx: 1 } },
        correction
    );
    assert.strictEqual(cowResult.workingBoundary, 0, 'COW plan should carry the boundary');
    assert.strictEqual(cowResult.workingGrid.get('slot-3').type, ORDER_TYPES.SELL, 'Promoted slot should be typed SELL in the working grid');

    console.log('  PASS: funded SELL correction respects geometric cap and places 1 slot');
}

async function testPartialPlacementBoundaryPromotion() {
    console.log('Running test: Partial Placement Boundary Promotion');

    // Layout: BUY slots 0-1, gap 2-5, SELL slots 6-7 (VIRTUAL).
    // After BUY promotion by 2 (budget-limited), boundary 1→3, sellStartIdx 6→8.
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 1,
        botFunds: { buy: 100, sell: 1000 },
        activeOrders: { buy: 2, sell: 0 },
        incrementPercent: 1,
        targetSpreadPercent: 1
    });
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    // 8 slots: BUY 0-1, gap 2-5, SELL 6-7 (VIRTUAL — empty opposite edge)
    for (let i = 0; i < 8; i++) {
        const isBuy = i <= 1;
        const isGap = i >= 2 && i <= 5;
        const type = isBuy ? ORDER_TYPES.BUY : isGap ? ORDER_TYPES.SPREAD : ORDER_TYPES.SPREAD;
        const state = isBuy ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL;
        const size = isBuy ? 10 : 0;
        const orderId = isBuy ? `1.7.${100 + i}` : '';
        await manager._updateOrder({
            id: `slot-${i}`,
            price: 1 + i * 0.01,
            type,
            state,
            size,
            orderId
        });
    }
    manager.boundaryIdx = 1;
    manager._gapSlots = 4;

    // botFunds=100 → allocatedBuy=100.  buyFree=40 → available ≈ 20 after
    // committed chain deduction (2 BUY orders × 10 = 20 committed).
    // Each promoted slot at ~10 → fits ~2 but not all 4 gap slots.
    await manager.setAccountTotals({ buy: 100, sell: 1000, buyFree: 40, sellFree: 1000 });
    await manager.recalculateFunds();

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.BUY, 4);

    const placedCount = correction.ordersToPlace.length;
    assert.ok(placedCount >= 1 && placedCount < 4,
        `Should place 1-3 promoted slots (budget-limited), got ${placedCount}`);

    // Boundary must equal original (1) + number of contiguous placed promoted
    // slots — not the full promotion count of 4.
    if (correction.boundaryIdx !== undefined) {
        const moved = correction.boundaryIdx - 1;
        assert.strictEqual(moved, placedCount,
            `Boundary moved ${moved} should equal placed count ${placedCount}`);
        assert.ok(moved < 4,
            `Boundary should not advance past the full 4-slot gap (moved ${moved})`);
    } else {
        assert.fail('boundaryIdx should be set when promoted slots were placed');
    }

    console.log(`  PASS: partial placement boundary moves by placed count (${placedCount} of 4)`);
}

async function runAll() {
    await testSpreadBoundaryPromotion();
    await testSellSideBoundaryPromotion();
    await testPartialPlacementBoundaryPromotion();
    console.log('✓ All spread boundary promotion tests passed');
}

runAll().catch(error => {
    console.error('Test FAILED:', error);
    process.exit(1);
});
