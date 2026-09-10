/**
 * tests/test_reserve_orders.ts
 *
 * Reserve ladder (edge-pinned fat-finger insurance): extra live orders resting
 * at the grid edges, outside activeOrders window accounting, no boundary crawl.
 * Buys pin at the floor, sells at the ceiling.
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG } = require('../modules/constants');
const {
    resolveReserveCount,
    resolveReserveOrders,
    resolveReserveFloorIds,
    resolveReserveCeilIds,
    selectReserveEdgeSlots,
    deriveTargetBoundary,
    getActiveOrdersTotal,
} = require('../modules/order/utils/order');

const { _setFeeCache } = require('../modules/order/utils/math');
_setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderUpdate: { bts: 0.001 },
        limitOrderCancel: { bts: 0 }
    }
});

async function runTests() {
    console.log('Running Reserve Orders Tests...');

    console.log(' - resolveReserveCount clamps per-side config...');
    {
        assert.strictEqual(resolveReserveCount({}, 'buy'), 0, 'missing disables');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { buy: 3 } }, 'buy'), 3, 'buy passes');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { buy: 3 } }, 'sell'), 0, 'sell defaults 0');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { sell: 2.9 } }, 'sell'), 0, 'non-integer disables (matches validation)');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { buy: -1 } }, 'buy'), 0, 'negative disables');
        assert.strictEqual(resolveReserveCount({ reserveOrders: { buy: 'x' } }, 'buy'), 0, 'garbage disables');
        assert.strictEqual(resolveReserveOrders({ reserveOrders: { buy: 2, sell: 1 } }), 3, 'total sums sides');
        assert.deepStrictEqual(DEFAULT_CONFIG.reserveOrders, { buy: 0, sell: 0 }, 'default off');
    }

    console.log(' - edge id sets anchor floor/ceiling...');
    {
        const slots = [
            { id: 'slot-9', price: 109, type: ORDER_TYPES.SELL },
            { id: 'slot-8', price: 108, type: ORDER_TYPES.SELL },
            { id: 'slot-0', price: 80, type: ORDER_TYPES.BUY },
            { id: 'slot-1', price: 81, type: ORDER_TYPES.BUY },
            { id: 'slot-2', price: 82, type: ORDER_TYPES.BUY },
        ];
        const floor = resolveReserveFloorIds(slots, 2);
        assert(floor.has('slot-0') && floor.has('slot-1') && floor.size === 2, 'floor: lowest buys');
        const ceil = resolveReserveCeilIds(slots, 1);
        assert(ceil.has('slot-9') && ceil.size === 1, 'ceiling: highest sells');
        const asc = slots.slice().sort((a, b) => a.price - b.price);
        assert.deepStrictEqual(
            selectReserveEdgeSlots(asc, 2, new Set(['slot-0']), 'floor').map((s) => s.id),
            ['slot-1', 'slot-2'],
            'selector skips windowed, floor first'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(asc, 1, new Set(), 'ceiling').map((s) => s.id),
            ['slot-9'],
            'selector takes ceiling last'
        );
    }

    console.log(' - getActiveOrdersTotal includes both sides...');
    {
        assert.strictEqual(
            getActiveOrdersTotal({ activeOrders: { buy: 5, sell: 5 }, reserveOrders: { buy: 2, sell: 1 } }),
            13,
            'buy+sell+reserves'
        );
        assert.strictEqual(
            getActiveOrdersTotal({ activeOrders: { buy: 5, sell: 5 } }),
            10,
            'no reserve unchanged'
        );
    }

    console.log(' - reserve fills never crawl the boundary...');
    {
        const allSlots = [];
        for (let i = 0; i < 10; i++) {
            allSlots.push({ id: `slot-${i}`, price: 80 + i, type: i < 8 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL });
        }
        const cfg = {
            startPrice: 100,
            activeOrders: { buy: 3, sell: 3 },
            reserveOrders: { buy: 2, sell: 1 },
        };
        const floorFill = [{ id: 'slot-0', type: ORDER_TYPES.BUY }];
        const ceilFill = [{ id: 'slot-9', type: ORDER_TYPES.SELL }];
        const midBuy = [{ id: 'slot-5', type: ORDER_TYPES.BUY }];
        const midSell = [{ id: 'slot-8', type: ORDER_TYPES.SELL }];
        assert.strictEqual(
            deriveTargetBoundary(floorFill, 5, allSlots, cfg, 2, null).boundaryIdx, 5,
            'floor buy fill holds'
        );
        assert.strictEqual(
            deriveTargetBoundary(ceilFill, 5, allSlots, cfg, 2, null).boundaryIdx, 5,
            'ceiling sell fill holds'
        );
        assert.strictEqual(
            deriveTargetBoundary(midBuy, 5, allSlots, cfg, 2, null).boundaryIdx, 4,
            'window buy fill crawls down'
        );
        assert.strictEqual(
            deriveTargetBoundary(midSell, 5, allSlots, cfg, 2, null).boundaryIdx, 6,
            'window sell fill crawls up'
        );
    }

    console.log(' - target grid unions window + edges (middle stays VIRTUAL)...');
    {
        const mgr = new OrderManager({
            market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
            startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
            activeOrders: { buy: 3, sell: 2 }, weightDistribution: { sell: 0.5, buy: 0.5 },
            reserveOrders: { buy: 2, sell: 1 },
        });
        mgr.logger.level = 'silent';
        mgr.assets = { assetA: { id: '1.3.0', precision: 8 }, assetB: { id: '1.3.1', precision: 5 } };
        await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
        await mgr.resetFunds();
        mgr._gapSlots = 0;
        mgr.boundaryIdx = 9;
        mgr.pauseFundRecalc();
        for (let i = 0; i < 14; i++) {
            await mgr._updateOrder({
                id: `slot-${i}`, type: i < 10 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
                price: 80 + i, size: 100, state: ORDER_STATES.VIRTUAL,
            });
        }
        await mgr.resumeFundRecalc();

        const StrategyEngine = require('../modules/order/strategy').default;
        const strategy = new StrategyEngine(mgr);
        // Funded snapshot: strategy budgets off allocated funds, and an empty
        // harness manager allocates nothing on its own.
        const funds = { ...mgr.funds, allocatedBuy: 10000, allocatedSell: 100 };
        const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
            frozenMasterGrid: mgr.orders,
            config: mgr.config,
            accountAssets: mgr.assets,
            funds,
            fills: [],
            currentBoundaryIdx: mgr.boundaryIdx,
        });
        assert.strictEqual(boundaryIdx, 9, 'no fills, boundary holds');
        const activeBuys = [...targetGrid.values()].filter(
            (o) => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.ACTIVE
        );
        const activeSells = [...targetGrid.values()].filter(
            (o) => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.ACTIVE
        );
        assert.strictEqual(activeBuys.length, 5, 'buy window 3 + floor 2 live');
        assert.strictEqual(activeSells.length, 3, 'sell window 2 + ceiling 1 live');
        const buyIds = new Set(activeBuys.map((o) => o.id));
        assert(buyIds.has('slot-0') && buyIds.has('slot-1'), 'floor pinned live');
        const sellIds = new Set(activeSells.map((o) => o.id));
        assert(sellIds.has('slot-13'), 'ceiling pinned live');
        const mid = targetGrid.get('slot-5');
        assert(mid && mid.state === ORDER_STATES.VIRTUAL, 'middle stays VIRTUAL');

        // Same grid, reserves off: windows only.
        const plain = strategy.calculateTargetGrid({
            frozenMasterGrid: mgr.orders,
            config: { ...mgr.config, reserveOrders: { buy: 0, sell: 0 } },
            accountAssets: mgr.assets,
            funds,
            fills: [],
            currentBoundaryIdx: mgr.boundaryIdx,
        });
        const plainBuys = [...plain.targetGrid.values()].filter(
            (o) => o.type === ORDER_TYPES.BUY && o.state === ORDER_STATES.ACTIVE
        );
        const plainSells = [...plain.targetGrid.values()].filter(
            (o) => o.type === ORDER_TYPES.SELL && o.state === ORDER_STATES.ACTIVE
        );
        assert.strictEqual(plainBuys.length, 3, 'no reserve means buy window only');
        assert.strictEqual(plainSells.length, 2, 'no reserve means sell window only');
    }

    console.log('✓ Reserve orders tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
