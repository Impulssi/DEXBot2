/**
 * tests/test_grid_robustness.ts
 *
 * Regression tests for grid robustness-by-construction:
 *
 *   1. Duplicate price levels in the windowed rails are repaired by
 *      calculateTargetGrid instead of thrown (production incident:
 *      902.08089 x2 / 894.01113 x3 after a 15-sell burst).
 *   2. UPDATE-NOT-CANCEL: the straggler is RE-PRICED to a unique adjacent
 *      ladder level and kept ACTIVE (the change propagates to the chain as a
 *      price-correction UPDATE), instead of being virtualized (which would be
 *      cancelled as surplus).
 *   3. Non-monotonic rails are repaired in place (offender re-priced).
 *   4. BAND-EXCLUSION strands buys at/above the highest filled SELL price
 *      during a multi-fill sell sweep (asymmetric pre-burst behavior).
 */

const assert = require('assert');
const StrategyEngine = require('../modules/order/strategy').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { calculateGapSlots } = require('../modules/order/grid');
const { reconcileGrid, projectTargetToWorkingGrid } = require('../modules/order/utils/validate');
const { buildDelta, correctOrderPriceOnChain } = require('../modules/order/utils/order');

const gapSlots = calculateGapSlots(1, 2, {});

function mkSlot(id, price, type, overrides = {}) {
    return {
        id, price, type,
        state: ORDER_STATES.VIRTUAL,
        size: 100,
        orderId: null,
        ...overrides
    };
}

function makeManager(slots, configOverrides = {}) {
    const orders = new Map(slots.map((s) => [s.id, { ...s }]));
    const logs: string[] = [];
    const manager: any = {
        orders,
        logs,
        config: {
            incrementPercent: 1,
            targetSpreadPercent: 2,
            activeOrders: { buy: 5, sell: 5 },
            weightDistribution: { buy: 0.5, sell: 0.5 },
            gridLimits: {},
            ...configOverrides
        },
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'XRP' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' }
        },
        funds: {
            available: { buy: 100000, sell: 100000 },
            virtual: { buy: 0, sell: 0 },
            allocatedBuy: 100000,
            allocatedSell: 100000
        },
        accountTotals: { buyFree: 100000, sellFree: 100000 },
        boundaryIdx: null,
        _gapSlots: gapSlots,
        _marketAnchor: null,
        logger: { level: 'debug', log: (msg) => logs.push(String(msg)) },
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        recalculateFunds: async () => {},
        _updateOrder(order) { this.orders.set(order.id, { ...order }); }
    };
    return manager;
}

function activeOfType(targetGrid, type) {
    return [...targetGrid.entries()]
        .map(([, o]) => o)
        .filter((o) => o.type === type && o.state !== ORDER_STATES.VIRTUAL);
}

function assertUniqueMonotonic(slots, side, ascending) {
    const prices = slots.map((o) => o.price);
    assert.strictEqual(prices.length, new Set(prices).size, `${side} prices must be unique (${JSON.stringify(prices)})`);
    for (let i = 1; i < prices.length; i++) {
        assert.ok(
            ascending ? prices[i] > prices[i - 1] : prices[i] < prices[i - 1],
            `${side} rail must ${ascending ? 'ascend' : 'descend'} (${prices[i - 1]} -> ${prices[i]})`
        );
    }
}

async function run() {
    console.log('Running grid robustness tests...');

    // ── Case 1: duplicate buy price levels are re-priced (not thrown) ─────
    {
        // Reconstruct the incident: after a sell burst the rotation left
        // THREE buy slots at price 894.01113 and TWO at 902.08089, plus a
        // proper descending rail. calculateTargetGrid must repair the rail so
        // the active window contains one order per price level — and, per the
        // UPDATE-NOT-CANCEL directive, the stragglers stay ACTIVE at re-priced
        // levels instead of being virtualized/cancelled.
        const buys = [
            mkSlot('b-0', 890.0, ORDER_TYPES.BUY),
            mkSlot('b-1', 894.01113, ORDER_TYPES.BUY),
            mkSlot('b-2', 894.01113, ORDER_TYPES.BUY),
            mkSlot('b-3', 894.01113, ORDER_TYPES.BUY),
            mkSlot('b-4', 900.0, ORDER_TYPES.BUY),
            mkSlot('b-5', 902.08089, ORDER_TYPES.BUY),
            mkSlot('b-6', 902.08089, ORDER_TYPES.BUY),
            mkSlot('b-7', 906.0, ORDER_TYPES.BUY)
        ];
        const sells = [
            mkSlot('s-0', 910.0, ORDER_TYPES.SELL),
            mkSlot('s-1', 915.0, ORDER_TYPES.SELL),
            mkSlot('s-2', 920.0, ORDER_TYPES.SELL),
            mkSlot('s-3', 925.0, ORDER_TYPES.SELL),
            mkSlot('s-4', 930.0, ORDER_TYPES.SELL)
        ];
        const manager = makeManager([...buys, ...sells], { activeOrders: { buy: 8, sell: 5 } });
        const strategy = new StrategyEngine(manager);

        const fills = [mkSlot('f-1', 902.08089, ORDER_TYPES.SELL, { orderId: '1.7.1' })];
        const { targetGrid } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills,
            currentBoundaryIdx: 3
        });

        const activeBuys = activeOfType(targetGrid, ORDER_TYPES.BUY);
        assertUniqueMonotonic(activeBuys, 'buy', false);

        // UPDATE-NOT-CANCEL: the duplicate stragglers (b-2, b-3 @894.01113)
        // must remain ACTIVE at unique re-priced levels BELOW the kept slot —
        // virtualizing them would drop them from the window (-> surplus
        // cancel); re-pricing keeps them on-chain via a price-correction UPDATE.
        const byId = new Map([...targetGrid.entries()].map(([, o]) => [o.id, o]));
        const stragglerIds = ['b-2', 'b-3'];
        const keptPrice = Number(byId.get('b-1').price);
        assert.strictEqual(Number(byId.get('b-1').price), 894.01113, 'first duplicate keeps its price');
        for (const id of stragglerIds) {
            const o = byId.get(id);
            assert.ok(o, `${id} present in target grid`);
            assert.strictEqual(o.state, ORDER_STATES.ACTIVE, `${id} (straggler) must stay ACTIVE, not virtualized`);
            assert.ok(Number(o.price) < keptPrice, `${id} re-priced below the kept level (got ${o.price})`);
        }
        assert.notStrictEqual(Number(byId.get('b-2').price), Number(byId.get('b-3').price), 're-priced stragglers must not collide');
        assert.ok(
            manager.logs.some((l) => l.includes('[GRID-DEDUPE]') && l.includes('Re-priced')),
            're-priced stragglers should be logged as [GRID-DEDUPE]'
        );
        assert.ok(true, 'duplicate prices repaired instead of throwing');
    }

    // ── Case 2: duplicate sell price levels are re-priced ────────────────
    {
        const buys = [
            mkSlot('b-0', 850.0, ORDER_TYPES.BUY),
            mkSlot('b-1', 855.0, ORDER_TYPES.BUY),
            mkSlot('b-2', 860.0, ORDER_TYPES.BUY)
        ];
        const sells = [
            mkSlot('s-0', 900.08089, ORDER_TYPES.SELL),
            mkSlot('s-1', 900.08089, ORDER_TYPES.SELL),
            mkSlot('s-2', 905.0, ORDER_TYPES.SELL),
            mkSlot('s-3', 910.0, ORDER_TYPES.SELL)
        ];
        const manager = makeManager([...buys, ...sells], { activeOrders: { buy: 3, sell: 4 } });
        const strategy = new StrategyEngine(manager);

        const { targetGrid } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills: [mkSlot('f-1', 900.08089, ORDER_TYPES.BUY, { orderId: '1.7.2' })],
            currentBoundaryIdx: 2
        });

        const activeSells = activeOfType(targetGrid, ORDER_TYPES.SELL);
        assertUniqueMonotonic(activeSells, 'sell', true);
        // No throw, no duplicate price levels survive in the active window.
        // (Duplicate-priced pairs whose slots straddle the spread band are
        // handled by window discipline; the rail must still be strictly
        // unique + monotonic.)
        const prices = activeSells.map((o) => o.price);
        assert.strictEqual(prices.length, new Set(prices).size, `active sell window must contain unique price levels (got ${JSON.stringify(prices)})`);
    }

    // ── Case 3: degenerate rail repaired in place (no throw), re-price logged ──
    {
        const buys = [
            mkSlot('b-0', 900.0, ORDER_TYPES.BUY),
            mkSlot('b-1', 910.0, ORDER_TYPES.BUY),
            mkSlot('b-2', 900.0, ORDER_TYPES.BUY),  // duplicate of b-0
            mkSlot('b-3', 870.0, ORDER_TYPES.BUY),
            mkSlot('b-4', 885.0, ORDER_TYPES.BUY)
        ];
        const sells = [
            mkSlot('s-0', 920.0, ORDER_TYPES.SELL),
            mkSlot('s-1', 925.0, ORDER_TYPES.SELL)
        ];
        const manager = makeManager([...buys, ...sells], { activeOrders: { buy: 5, sell: 2 } });
        const strategy = new StrategyEngine(manager);

        const { targetGrid } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills: [],
            currentBoundaryIdx: 5
        });

        const activeBuys = activeOfType(targetGrid, ORDER_TYPES.BUY);
        assertUniqueMonotonic(activeBuys, 'buy', false);
        assert.ok(
            manager.logs.some((l) => l.includes('[GRID-DEDUPE]')),
            'duplicate price collapse should be logged'
        );
        // b-2 (duplicate of b-0 at 900) is re-priced DOWN to 900*0.99 = 891
        // and stays ACTIVE.
        const b2 = [...targetGrid.entries()].map(([, o]) => o).find((o) => o.id === 'b-2');
        assert.ok(b2, 'b-2 slot present in target grid');
        assert.strictEqual(b2.state, ORDER_STATES.ACTIVE, 're-priced straggler must stay ACTIVE (UPDATE not cancel)');
        assert.ok(
            Math.abs(Number(b2.price) - 900 * 0.99) < 1e-6,
            `re-priced straggler should land one ladder step down (b-2 price=${b2.price})`
        );
    }

    // ── Case 4: BAND-EXCLUSION strands buys at/above highest filled SELL ──
    {
        const buys = [
            mkSlot('b-0', 894.01113, ORDER_TYPES.BUY),
            mkSlot('b-1', 902.08089, ORDER_TYPES.BUY),
            mkSlot('b-2', 910.0, ORDER_TYPES.BUY),
            mkSlot('b-3', 860.0, ORDER_TYPES.BUY)
        ];
        const sells = [
            mkSlot('s-0', 920.0, ORDER_TYPES.SELL),
            mkSlot('s-1', 925.0, ORDER_TYPES.SELL)
        ];
        const manager = makeManager([...buys, ...sells], { activeOrders: { buy: 4, sell: 2 } });
        const strategy = new StrategyEngine(manager);

        // All-sell burst: 15 sells swept through 894->902. burst-global band
        // must strand buys at/above the highest filled sell (902.08089).
        manager._burstSweptMaxSell = 902.08089;
        manager._burstSweptSellCount = 15;

        const fills = [];
        for (let i = 0; i < 15; i++) {
            fills.push(mkSlot(`f-${i}`, 880 + i, ORDER_TYPES.SELL, { orderId: `1.7.${i}` }));
        }
        const { targetGrid } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills,
            currentBoundaryIdx: 2
        });

        const activeBuys = activeOfType(targetGrid, ORDER_TYPES.BUY);
        for (const o of activeBuys) {
            assert.ok(
                Number(o.price) <= 902.08089,
                `active buy ${o.id}@${o.price} must not sit above the highest filled sell 902.08089`
            );
        }
    }

    // ── Case 5: re-priced straggler propagates to the chain as an UPDATE ──
    {
        // Full pipeline for a live duplicate-price level:
        //   target (strategy re-prices) → reconcile (no CANCEL) →
        //   project to working grid (orderId + size preserved, price changed) →
        //   COW commit delta (update action emitted despite ordersEqual) →
        //   sync-style price correction (updateOrder on the chain).
        const live = (id, price, type) => mkSlot(id, price, type, { state: ORDER_STATES.ACTIVE, orderId: '1.7.' + id });
        const buys = [
            live('b-0', 890.0, ORDER_TYPES.BUY),
            live('b-1', 894.01113, ORDER_TYPES.BUY),
            live('b-2', 894.01113, ORDER_TYPES.BUY),
            live('b-3', 894.01113, ORDER_TYPES.BUY),
            live('b-4', 900.0, ORDER_TYPES.BUY)
        ];
        const sells = [live('s-0', 910.0, ORDER_TYPES.SELL)];
        const manager = makeManager([...buys, ...sells], { activeOrders: { buy: 5, sell: 1 } });
        const strategy = new StrategyEngine(manager);

        const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills: [],
            currentBoundaryIdx: 4
        });

        // (1) Reconcile: the re-priced stragglers must generate NO actions
        // (no CANCEL, no size churn).
        const rec = reconcileGrid(manager.orders, targetGrid, boundaryIdx, { logger: () => {} });
        for (const id of ['b-2', 'b-3']) {
            assert.ok(
                !rec.actions.some((a) => a.id === id),
                `reconcile must emit no action for re-priced straggler ${id}`
            );
        }

        // (2) Project to working grid: new price lands, orderId + on-chain
        // size preserved, state stays ACTIVE.
        const working = new Map();
        for (const [id, o] of manager.orders) working.set(id, { ...o });
        projectTargetToWorkingGrid(working, targetGrid, { actions: rec.actions });
        for (const id of ['b-2', 'b-3']) {
            const w = working.get(id);
            assert.ok(w, `${id} present in working grid`);
            assert.strictEqual(w.state, ORDER_STATES.ACTIVE, `${id} stays ACTIVE in working grid`);
            assert.strictEqual(w.orderId, '1.7.' + id, `${id} keeps its on-chain orderId`);
            assert.ok(Number(w.price) < 894.01113, `${id} working-grid price re-priced down (got ${w.price})`);
            assert.strictEqual(Number(w.size), 100, `${id} on-chain size preserved`);
        }

        // (3) COW commit-time delta: with the real relative price tolerance
        // (incrementPercent/1000, see manager._getCowComparePrecisions) the
        // re-priced delta must STILL emit an update (10x margin vs the 1%
        // ladder step — a pathological tolerance can never suppress it).
        const delta = buildDelta(manager.orders, working, {
            precisions: {
                buyPrecision: manager.assets.assetB.precision,
                sellPrecision: manager.assets.assetA.precision,
                priceRelativeTolerance: 1 / 1000
            }
        });
        const upd = delta.filter((d) => d.type === 'update' && (d.id === 'b-2' || d.id === 'b-3'));
        assert.strictEqual(upd.length, 2, `commit delta must emit update for both re-priced stragglers (got ${JSON.stringify(delta.map((d) => `${d.type}:${d.id}`))})`);
        for (const u of upd) {
            assert.strictEqual(u.orderId, '1.7.' + u.id, `delta update carries the on-chain orderId`);
            assert.ok(Number(u.order.price) < 894.01113, `delta update carries the re-priced price (${u.order.price})`);
        }

        // (4) Sync-style chain correction: the price mismatch is corrected as
        // an in-place limit_order_update, not a cancel+recreate.
        const calls = [];
        const accountOrders = {
            updateOrder: async (_acc, _key, orderId, args) => { calls.push({ orderId, args }); return {}; },
            cancelOrder: async () => {}
        };
        const correction = upd[0];
        const gridOrder = correction.order;
        manager.ordersNeedingPriceCorrection = [{
            chainOrderId: correction.orderId,
            expectedPrice: Number(gridOrder.price),
            size: 100,
            type: gridOrder.type,
            gridOrder
        }];
        const res = await correctOrderPriceOnChain(
            manager, { ...manager.ordersNeedingPriceCorrection[0] },
            'account-name', 'private-key', accountOrders
        );
        assert.strictEqual(res.success, true, `price correction succeeds (got ${JSON.stringify(res)})`);
        assert.strictEqual(calls.length, 1, `exactly one updateOrder broadcast`);
        assert.strictEqual(calls[0].orderId, correction.orderId, `broadcast targets the straggler orderId`);
        // BUY: minToReceive = size / expectedPrice (the re-priced level).
        assert.ok(
            Math.abs(calls[0].args.minToReceive - 100 / Number(gridOrder.price)) < 1e-6,
            `updateOrder minToReceive derived from re-priced price (got ${calls[0].args.minToReceive})`
        );
        assert.strictEqual(calls[0].args.amountToSell, 100, `updateOrder preserves the order size`);
        assert.ok(
            manager.logs.some((l) => l.includes('[GRID-DEDUPE]') && l.includes('Re-priced')),
            'strategy logged the re-price'
        );
    }

    // ── Case 6: geometry-faithful slot-N ids — in-rail dups re-priced, ──
    // out-of-rail dups surplus
    {
        // slot-N ids let isSlotInRail filter by index (boundary=4, gap=2:
        // buy rail = idx<=4). slot-1 is an IN-rail duplicate of slot-0 (both
        // idx<=4) so it is re-priced; slot-6 shares no price but sits at
        // idx 6 > 4, so despite being typed BUY by position it falls OUT of
        // the rail and must be surplus (VIRTUAL), never re-priced/placed.
        const slots = [
            mkSlot('slot-0', 810.0, ORDER_TYPES.BUY),
            mkSlot('slot-1', 810.0, ORDER_TYPES.BUY),
            mkSlot('slot-6', 815.0, ORDER_TYPES.BUY),
            mkSlot('slot-2', 820.0, ORDER_TYPES.BUY),
            mkSlot('slot-3', 830.0, ORDER_TYPES.BUY),
            mkSlot('slot-7', 920.0, ORDER_TYPES.SELL),
            mkSlot('slot-8', 930.0, ORDER_TYPES.SELL)
        ];
        const manager = makeManager(slots, { activeOrders: { buy: 5, sell: 2 } });
        const strategy = new StrategyEngine(manager);

        const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
            frozenMasterGrid: manager.orders,
            config: manager.config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills: [],
            currentBoundaryIdx: 4
        });

        assert.strictEqual(boundaryIdx, 4, `no fills -> boundary stays at input (got ${boundaryIdx})`);
        const byId = new Map([...targetGrid.entries()].map(([, o]) => [o.id, o]));

        // In-rail duplicate: slot-1 re-priced to 810*0.99 = 801.9, ACTIVE.
        assert.strictEqual(byId.get('slot-0').state, ORDER_STATES.ACTIVE, 'slot-0 keeps price and stays active');
        assert.strictEqual(byId.get('slot-1').state, ORDER_STATES.ACTIVE, 'in-rail dup slot-1 stays ACTIVE (re-priced)');
        assert.ok(
            Math.abs(Number(byId.get('slot-1').price) - 810 * 0.99) < 1e-6,
            `slot-1 re-priced one ladder step down (got ${byId.get('slot-1').price})`
        );
        // Out-of-rail dup: slot-6 (idx 6 > boundary 4) is surplus, NOT re-priced.
        assert.strictEqual(byId.get('slot-6').state, ORDER_STATES.VIRTUAL, 'out-of-rail slot-6 is surplus (VIRTUAL)');
        assert.strictEqual(Number(byId.get('slot-6').price), 815, 'out-of-rail slot-6 keeps its price (not re-priced)');

        const activeBuys = activeOfType(targetGrid, ORDER_TYPES.BUY);
        assertUniqueMonotonic(activeBuys, 'buy', false);
        assert.ok(
            manager.logs.some((l) => l.includes('[GRID-DEDUPE]') && l.includes('slot-1')),
            're-price logged for the in-rail straggler'
        );
    }

    console.log('✓ All grid robustness tests passed');
}

run().catch((err) => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});