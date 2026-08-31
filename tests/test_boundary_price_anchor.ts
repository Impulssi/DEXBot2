const assert = require('assert');
const {
    deriveTargetBoundary,
    computePriceAnchoredBoundaryTarget
} = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Build a 30-slot grid, 1 slot spacing, prices 100..129.
 * Types are irrelevant for boundary math (only price matters) but the
 * placement-guard test uses SELL on the top rail and BUY on the bottom.
 */
function buildSlots(count = 30) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        const type = i < 12
            ? ORDER_TYPES.BUY
            : (i < 14 ? ORDER_TYPES.SPREAD : ORDER_TYPES.SELL);
        slots.push({
            id: `slot-${i}`,
            price: 100 + i,
            type,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: null
        });
    }
    return slots;
}

function buildConfig() {
    return {
        startPrice: 113,
        activeOrders: { buy: 20, sell: 20 },
        incrementPercent: 1,
        targetSpreadPercent: 2,
        gridLimits: {}
    };
}

function sellFill(id, price, extra = {}) {
    return { id, type: ORDER_TYPES.SELL, price, isPartial: false, ...extra };
}

function buyFill(id, price, extra = {}) {
    return { id, type: ORDER_TYPES.BUY, price, isPartial: false, ...extra };
}

// ── tests ───────────────────────────────────────────────────────────────

async function run() {
    console.log('Running price-anchored boundary tests...');

    const allSlots = buildSlots();
    const config = buildConfig();
    const gapSlots = 2;

    // 1. Pure SELL burst: price-anchored correction lifts the boundary to
    //    the traded range even though the count crawl is capped.
    {
        const fills = [];
        for (let i = 0; i < 14; i++) fills.push(sellFill(`slot-${16 + i}`, 116 + i));
        // Highest fill price = 129 (slot-29) -> up bound = 29 - gapSlots(2) = 27;
        // legacy count cap from boundary 13 would stop at 23.
        const anchor = computePriceAnchoredBoundaryTarget(fills, allSlots, gapSlots);
        assert.deepStrictEqual(anchor, { direction: 'up', boundIdx: 27 }, 'anchor should bind to the highest fill slot');
        const { boundaryIdx } = deriveTargetBoundary(fills, 13, allSlots, config, gapSlots, 20, anchor);
        assert.strictEqual(boundaryIdx, 27, 'boundary should reach the price-implied bound');
        assert.ok(boundaryIdx > 13 + 10, 'boundary must move further than the legacy half-window cap');
    }

    // 2. Cross-chunk consumption: each chunk steps toward the global bound,
    //    bounded by remaining budget; total reaches the bound.
    {
        const fills = [];
        for (let i = 0; i < 14; i++) fills.push(sellFill(`slot-${16 + i}`, 116 + i));
        const anchor = computePriceAnchoredBoundaryTarget(fills, allSlots, gapSlots);
        let current = 13;
        let budget = 20;
        for (let c = 0; c < 4; c++) {
            const chunk = fills.slice(c * 4, c * 4 + 4);
            const r = deriveTargetBoundary(chunk, current, allSlots, config, gapSlots, budget, anchor);
            current = r.boundaryIdx;
            budget = r.remainingBudget;
        }
        assert.strictEqual(current, 27, 'all chunks combined must reach the price-implied bound');
    }

    // 3. Mixed burst (buys low + sells high): count crawl nets +4 but the
    //    price correction carries the boundary the rest of the way.
    {
        const fills = [
            buyFill('slot-2', 102),
            buyFill('slot-3', 103),
            sellFill('slot-14', 114),
            sellFill('slot-15', 115),
            sellFill('slot-16', 116),
            sellFill('slot-17', 117),
            sellFill('slot-18', 118),
            sellFill('slot-19', 119)
        ];
        const current = 11;
        const anchor = computePriceAnchoredBoundaryTarget(fills, allSlots, gapSlots);
        assert.ok(anchor != null && anchor.direction === 'up', 'mixed burst with trailing sell corrects upward');
        const { boundaryIdx } = deriveTargetBoundary(fills, current, allSlots, config, gapSlots, 20, anchor);
        assert.strictEqual(boundaryIdx, anchor.boundIdx, 'boundary must reach the price-implied bound');
        assert.ok(boundaryIdx > current, 'mixed burst with dominant up-sweep must move boundary up');
    }

    // 4. Truly price-less fills (unknown id, no price) fall back to the
    //    count-based shift with the conservative half-window cap. Fills
    //    without a price but with a resolvable slot id DO produce an anchor.
    {
        const fills = [];
        for (let i = 0; i < 14; i++) fills.push({ id: `orphan-${i}`, type: ORDER_TYPES.SELL, isPartial: false });
        const anchor = computePriceAnchoredBoundaryTarget(fills, allSlots, gapSlots);
        assert.strictEqual(anchor, null, 'unresolvable fills must not produce an anchor');
        const { boundaryIdx } = deriveTargetBoundary(fills, 12, allSlots, config, gapSlots, null, null);
        assert.strictEqual(boundaryIdx, 12 + 10, 'count fallback caps at half-window (10)');

        const slotIdFills = [];
        for (let i = 0; i < 14; i++) slotIdFills.push({ id: `slot-${16 + i}`, type: ORDER_TYPES.SELL, isPartial: false });
        const anchor2 = computePriceAnchoredBoundaryTarget(slotIdFills, allSlots, gapSlots);
        assert.ok(anchor2 != null && anchor2.direction === 'up', 'slot-id lookup must resolve fill prices');
    }

    // 5. Partials without delayed-rotation are ignored by both paths.
    {
        const fills = [sellFill('slot-20', 120, { isPartial: true })];
        const anchor = computePriceAnchoredBoundaryTarget(fills, allSlots, gapSlots);
        assert.strictEqual(anchor, null, 'partial-only burst must not produce an anchor');
        const { boundaryIdx } = deriveTargetBoundary(fills, 13, allSlots, config, gapSlots, null, null);
        assert.strictEqual(boundaryIdx, 13, 'partial-only burst must not shift the boundary');
    }

    // 6. Down-sweep: boundary follows the lowest fill price down.
    {
        const fills = [];
        for (let i = 0; i < 6; i++) fills.push(buyFill(`slot-${10 - i}`, 110 - i));
        const current = 13;
        const anchor = computePriceAnchoredBoundaryTarget(fills, allSlots, gapSlots);
        assert.ok(anchor != null && anchor.direction === 'down', 'down-sweep must produce a downward anchor');
        const { boundaryIdx } = deriveTargetBoundary(fills, current, allSlots, config, gapSlots, 20, anchor);
        assert.strictEqual(boundaryIdx, anchor.boundIdx, 'boundary must reach the downward bound');
        assert.ok(boundaryIdx < current, 'down-sweep must move the boundary down');
    }

    // 7. Window guard: re-planning with a stale boundary must not leave
    //    sell slots at/below the last filled sell price typed as SELL.
    {
        const StrategyEngine = require('../modules/order/strategy').default;
        const logs = [];
        const manager = {
            orders: new Map(allSlots.map(s => [s.id, { ...s }])),
            config,
            assets: {
                assetA: { id: '1.3.0', precision: 6, symbol: 'XRP' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' }
            },
            funds: {
                available: { buy: 100000, sell: 100000 },
                virtual: { buy: 0, sell: 0 },
                allocatedBuy: 100000,
                allocatedSell: 100000
            },
            accountTotals: { buyFree: 100000, sellFree: 100000 },
            boundaryIdx: 13,
            _gapSlots: gapSlots,
            // Simulate the incident: budget starved, boundary cannot move,
            // so only the placement guard prevents toxic sells.
            _boundaryShiftBudget: 0,
            _boundaryTarget: null,
            logger: { level: 'debug', log: (msg) => logs.push(String(msg)) },
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            recalculateFunds: async () => {},
            _updateOrder(order) { this.orders.set(order.id, { ...order }); }
        };
        const strategy = new StrategyEngine(manager);

        // Burst of sells swept through slot-24 (price 124) but the boundary
        // is stale at 13 — the swept-band exclusion virtualizes the sells
        // at 114..124 (reconcile cancels them) and the window re-forms
        // above the band.
        const fills = [];
        for (let i = 0; i < 12; i++) fills.push(sellFill(`slot-${13 + i}`, 113 + i));

        const params = {
            frozenMasterGrid: manager.orders,
            config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills,
            currentBoundaryIdx: 13
        };
        const { targetGrid } = strategy.calculateTargetGrid(params);

        for (const [, order] of targetGrid.entries()) {
            // VIRTUAL sell-typed slots inside the swept band are the desired
            // exclusion outcome (window-eligible=False, reconcile cancels
            // any stranded live order). Only LIVE-target sells are toxic.
            if (order.type === ORDER_TYPES.SELL && order.state !== ORDER_STATES.VIRTUAL) {
                assert.ok(
                    order.price > 124,
                    `no live sell may remain at/below the highest fill price 124 (got ${order.price})`
                );
            }
            if (order.type === ORDER_TYPES.BUY) {
                assert.ok(
                    order.price < 125,
                    `no buy may sit at/above the swept-through level 125 (got ${order.price})`
                );
            }
        }
        assert.ok(
            logs.some(l => l.includes('[BAND-EXCLUSION]')),
            'swept-band exclusion should log when it virtualizes slots'
        );
    }

    // 8. Window guard, down-sweep mirror: buy slots at/above the lowest
    //    filled buy price must rotate to SELL.
    {
        const StrategyEngine = require('../modules/order/strategy').default;
        const manager = {
            orders: new Map(allSlots.map(s => [s.id, { ...s }])),
            config,
            assets: {
                assetA: { id: '1.3.0', precision: 6, symbol: 'XRP' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' }
            },
            funds: {
                available: { buy: 100000, sell: 100000 },
                virtual: { buy: 0, sell: 0 },
                allocatedBuy: 100000,
                allocatedSell: 100000
            },
            accountTotals: { buyFree: 100000, sellFree: 100000 },
            boundaryIdx: 13,
            _gapSlots: gapSlots,
            _boundaryShiftBudget: 20,
            _boundaryTarget: null,
            logger: { level: 'debug', log: () => {} },
            pauseFundRecalc: () => {},
            resumeFundRecalc: async () => {},
            recalculateFunds: async () => {},
            _updateOrder(order) { this.orders.set(order.id, { ...order }); }
        };
        const strategy = new StrategyEngine(manager);

        // Buy fills swept down through slot-9 (price 109); stale boundary 13.
        const fills = [
            buyFill('slot-10', 110),
            buyFill('slot-9', 109)
        ];
        const params = {
            frozenMasterGrid: manager.orders,
            config,
            accountAssets: manager.assets,
            funds: manager.funds,
            fills,
            currentBoundaryIdx: 13
        };
        const { targetGrid } = strategy.calculateTargetGrid(params);

        for (const [, order] of targetGrid.entries()) {
            // VIRTUAL buy-typed slots inside the swept band are the desired
            // exclusion outcome; only LIVE-target buys are toxic.
            if (order.type === ORDER_TYPES.BUY && order.state !== ORDER_STATES.VIRTUAL) {
                assert.ok(
                    order.price <= 109,
                    `no live buy may remain above the lowest filled buy price 109 (got ${order.price})`
                );
            }
        }
    }

    console.log('✓ All price-anchored boundary tests passed');
}

run().catch(err => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});
