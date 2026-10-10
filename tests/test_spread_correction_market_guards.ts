/**
 * tests/test_spread_correction_market_guards.ts
 *
 * Spread-correction market guards (P3/P4):
 *
 * Production incident (a live market-pair bot, 2026-10-10): after a
 * stop/start the grid regenerated cold (0 active sells, spread 23.22 vs
 * 5.35 target) and spread correction placed 9 fresh sells under a flat
 * market. They filled within seconds (0.00131529 x2, 0.00131974) while 27
 * gap-skipped chain sells stayed live but unmatched.
 *
 *   P3 (market-crossing): a SELL at/below the market reference (or BUY
 *   at/above it) fills instantly instead of resting — never place one.
 *   Reference is the AMA center snapshot; absent reference disables the
 *   guard (fail-open).
 *
 *   P4 (live-unmatched): never stack a fresh order where a live unmatched
 *   chain order already rests at the same price level. Stale/absent lists
 *   disable the guard (fail-open).
 */

// Hermetic profiles dir FIRST (config-caching trap): the AMA snapshot the
// P3 guard reads must come from a tmp dir, never live profiles. The harness
// spawns each test file in its own process, so this cannot leak sideways.
const fs = require('fs');
const os = require('os');
const testPath = require('path');
const testTmpProfiles = fs.mkdtempSync(testPath.join(os.tmpdir(), 'dexbot-spread-guard-'));
process.env.DEXBOT_PROFILE_ROOT = testTmpProfiles;

const assert = require('assert');
const { OrderManager } = require('../modules/order/manager');
const { grid: Grid } = require('../modules/order').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const BOT_KEY = 'spread-guard-test';

function writeAmaSnapshot(center: number) {
    const ordersDir = testPath.join(testTmpProfiles, 'orders');
    fs.mkdirSync(ordersDir, { recursive: true });
    fs.writeFileSync(
        testPath.join(ordersDir, `${BOT_KEY}.dynamicgrid.json`),
        JSON.stringify({ gridCenterPrice: center, updatedAt: new Date().toISOString() }),
        'utf8'
    );
}

function clearAmaSnapshot() {
    try {
        fs.unlinkSync(testPath.join(testTmpProfiles, 'orders', `${BOT_KEY}.dynamicgrid.json`));
    } catch { /* absent */ }
}

const price = (i: number): number => 100 + i;

function newManager() {
    const manager = new OrderManager({
        assetA: 'BASE',
        assetB: 'QUOTE',
        startPrice: 115,
        botFunds: { buy: 0, sell: 50000 },
        activeOrders: { buy: 4, sell: 4 },
        incrementPercent: 0.5,
        targetSpreadPercent: 1.5
    });
    (manager as any).config.botKey = BOT_KEY;
    return manager;
}

/**
 * Geometry: buys live [4..9] flush against boundary 9 (no band promotion),
 * gap 10-11, sells 12-29 with live window [20..24]. Correction SELL must
 * consider slot-19 (window-adjacent, price 119).
 */
async function buildSellGeometry(manager: any) {
    manager.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };
    manager.config.weightDistribution = { buy: 0.5, sell: 0.5 };
    const live = (i: number) => (i >= 4 && i <= 9) || (i >= 20 && i <= 24);
    for (let i = 0; i <= 29; i++) {
        const type = i <= 9 ? ORDER_TYPES.BUY : (i >= 12 ? ORDER_TYPES.SELL : ORDER_TYPES.SPREAD);
        const isLive = live(i);
        await manager._updateOrder({
            id: `slot-${i}`,
            price: price(i),
            type,
            state: isLive ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
            size: isLive ? 100 : 0,
            orderId: isLive ? `1.7.${600000 + i}` : ''
        });
    }
    manager.boundaryIdx = 9;
    manager._gapSlots = 2;
    await manager.setAccountTotals({ buy: 0, sell: 50000, buyFree: 0, sellFree: 50000 });
    await manager.recalculateFunds();
}

async function testSellBelowMarketBlocked() {
    console.log('Running test: SELL below market reference is blocked');
    writeAmaSnapshot(120); // slot-19 @119 sits under the reference
    const logs: string[] = [];
    const manager = newManager();
    await buildSellGeometry(manager);
    manager.logger = { log: (m: string) => logs.push(String(m)) } as any;

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);
    assert(
        !placed.some((id: string) => {
            const slot = manager.orders.get(id);
            return slot && Number(slot.price) <= 120;
        }),
        `No placed sell may sit at/below the 120 reference; got ${JSON.stringify(placed)}`
    );
    assert(
        logs.some((m) => m.includes('crossing the market reference')),
        `Block must be logged as market-reference crossing; got:\n${logs.join('\n')}`
    );
    console.log('  ✓ under-market sells blocked and named');
}

async function testSellAboveMarketStillPlaces() {
    console.log('Running test: SELL above market reference still places (control)');
    writeAmaSnapshot(100); // every candidate sits above the reference
    const manager = newManager();
    await buildSellGeometry(manager);

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);
    assert(
        placed.length > 0,
        'With the reference below every candidate the guard must stay open'
    );
    console.log(`  ✓ control places normally (${JSON.stringify(placed)})`);
}

async function testNoSnapshotStaysOpen() {
    console.log('Running test: missing AMA snapshot keeps the guard open (fail-open)');
    clearAmaSnapshot();
    const manager = newManager();
    await buildSellGeometry(manager);

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    assert(
        correction.ordersToPlace.length > 0,
        'Without a market reference the guard must not block anything'
    );
    console.log('  ✓ fail-open without snapshot');
}

async function testUnmatchedLevelBlocked() {
    console.log('Running test: fresh sell blocked where a live unmatched order rests');
    writeAmaSnapshot(100); // guard open ref-wise; P4 must do the blocking
    const manager = newManager();
    await buildSellGeometry(manager);
    // A live unmatched chain sell rests exactly at the selected slot's
    // level (slot-12 @112 in this geometry).
    (manager as any)._lastUnmatchedChainOrders = [
        { chainOrderId: '1.7.999001', type: 'sell', price: 112, size: 50 }
    ];
    (manager as any)._lastUnmatchedChainOrdersAt = Date.now();
    const logs: string[] = [];
    manager.logger = { log: (m: string) => logs.push(String(m)) } as any;

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);
    assert(
        !placed.includes('slot-12'),
        `slot-12 duplicates the live unmatched level and must be skipped; got ${JSON.stringify(placed)}`
    );
    assert(
        logs.some((m) => m.includes('already covered by live unmatched chain orders')),
        `Skip must be logged as unmatched coverage; got:\n${logs.join('\n')}`
    );
    console.log('  ✓ duplicate level skipped and named');
}

async function testStaleUnmatchedStaysOpen() {
    console.log('Running test: stale unmatched list keeps the guard open (fail-open)');
    writeAmaSnapshot(100);
    const manager = newManager();
    await buildSellGeometry(manager);
    (manager as any)._lastUnmatchedChainOrders = [
        { chainOrderId: '1.7.999001', type: 'sell', price: 112, size: 50 }
    ];
    (manager as any)._lastUnmatchedChainOrdersAt = Date.now() - 20 * 60 * 1000; // 20 min old
    const baseline = newManager();
    await buildSellGeometry(baseline);

    const correction = await Grid.prepareSpreadCorrectionOrders(manager, ORDER_TYPES.SELL, 1);
    const placed = correction.ordersToPlace.map((o: any) => o.id);
    assert(
        placed.includes('slot-12'),
        `Stale unmatched entries must not block; got ${JSON.stringify(placed)}`
    );
    console.log('  ✓ fail-open on stale list');
}

(async () => {
    try {
        await testSellBelowMarketBlocked();
        await testSellAboveMarketStillPlaces();
        await testNoSnapshotStaysOpen();
        await testUnmatchedLevelBlocked();
        await testStaleUnmatchedStaysOpen();
        console.log('PASS test_spread_correction_market_guards');
    } finally {
        fs.rmSync(testTmpProfiles, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    try { fs.rmSync(testTmpProfiles, { recursive: true, force: true }); } catch {}
    process.exit(1);
});
