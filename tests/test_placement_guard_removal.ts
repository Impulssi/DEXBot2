/**
 * tests/test_placement_guard_removal.ts
 *
 * Regression test for the removal of the placement guard (introduced in
 * 2bc1efe3, removed after a production self-trade incident).
 *
 * Incident pattern: a SELL fill at the top of the sell rail left stale
 * plan state; the guard then flipped spread-band slots with live master
 * sells to BUY while keeping their (stale, above-market) slot prices. The
 * flipped buys kept the sell prices, instantly self-crossed our own
 * opposite rail during chunked broadcasts, and the per-batch extremes made
 * large COW plans flip-flop on batch-local extremes. The guard's invariant
 * is unenforceable from fill data alone and is now enforced where it
 * belongs:
 * - geometry (price-anchored boundary correction) keeps rails outside the
 *   traded band,
 * - the COW-layer crossing guard (findCrossedOrder) stops any order from
 *   re-pricing across a live opposite-side order not yet cancelled.
 *
 * Discriminator: after removal, a spread-band slot holding a live master
 * order must never be re-typed to the opposite side at the same price
 * (it stays SELL via the spread guard, or goes VIRTUAL via window
 * discipline). Under the old guard it was flipped to BUY.
 */
const assert = require('assert');
const StrategyModule = require('../modules/order/strategy').default;
const StrategyEngine = StrategyModule.default || StrategyModule.StrategyEngine || StrategyModule;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const START_PRICE = 100;
const INC = 1; // percent
const slotPrice = (i) => START_PRICE * Math.pow(1 + INC / 100, i);

function buildSlots(count = 41) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        slots.push({
            id: `slot-${i}`,
            price: slotPrice(i),
            type: null,
            state: ORDER_STATES.VIRTUAL,
            size: 0,
            orderId: null,
            committedSide: null
        });
    }
    return slots;
}

function createManager(slots) {
    return {
        _gapSlots: 2,
        _boundaryShiftBudget: null,
        orders: new Map(slots.map(s => [s.id, { ...s }])),
        config: {
            startPrice: START_PRICE,
            incrementPercent: INC,
            targetSpreadPercent: 2,
            gridLimits: { PARTIAL_DUST_THRESHOLD_PERCENTAGE: 5 },
            activeOrders: { buy: 10, sell: 10 },
            weightDistribution: { buy: 0.5, sell: 0.5 },
            feeParams: { BTS_RESERVATION_MULTIPLIER: 1.2 },
            min_BTS_value: 0,
            assetA: 'TEST',
            assetB: 'QUOTE'
        },
        assets: {
            assetA: { id: '1.3.0', precision: 6, symbol: 'TEST' },
            assetB: { id: '1.3.1', precision: 6, symbol: 'QUOTE' }
        },
        logger: { log: () => {} }
    };
}

async function run() {
    console.log('Running placement-guard removal regression test...');

    const funds = {
        allocatedBuy: 5000,
        allocatedSell: 500,
        chainFreeBuy: 5000,
        chainFreeSell: 500,
        btsBalance: { free: 100 }
    };

    // ---- Scenario A: SELL fill at the top of the sell rail ----
    // Master: buys slots 0-9 live, sells slots 20-29 live,
    // boundary 17 (gap 2 -> sellStart 20). Generic price shape.
    const slots = buildSlots();
    for (let i = 0; i <= 9; i++) {
        const s = slots.find(x => x.id === `slot-${i}`);
        s.type = ORDER_TYPES.BUY;
        s.state = ORDER_STATES.ACTIVE;
        s.size = 0.06;
        s.orderId = `1.7.80${i}`;
    }
    for (let i = 20; i <= 29; i++) {
        const s = slots.find(x => x.id === `slot-${i}`);
        s.type = ORDER_TYPES.SELL;
        s.state = ORDER_STATES.ACTIVE;
        s.size = 0.06;
        s.orderId = `1.7.90${i}`;
    }

    const manager = createManager(slots);
    const strategy = new StrategyEngine(manager);

    // Edge fill: sell slot-29 filled -> boundary 29 - 2 = 27,
    // sellStart 30, spread band 28-29 (both hold live master sells).
    const fills = [{
        id: 'slot-29',
        type: ORDER_TYPES.SELL,
        orderId: '1.7.9029',
        price: slotPrice(29),
        size: 0.06,
        isPartial: false
    }];

    const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
        frozenMasterGrid: manager.orders,
        config: manager.config,
        accountAssets: manager.assets,
        funds,
        fills,
        currentBoundaryIdx: 17
    });

    assert.strictEqual(boundaryIdx, 27, `boundary must crawl to 27 after the edge fill, got ${boundaryIdx}`);

    // THE discriminator: spread-band slots 28-29 hold live master sells and
    // must NOT be re-typed BUY at the same price (the old guard's flip-flop
    // artifact). Spread guard keeps them SELL; window discipline may make
    // them VIRTUAL — both are sane. BUY is not.
    for (const id of ['slot-28', 'slot-29']) {
        const t = targetGrid.get(id);
        assert(t, `target must contain ${id}`);
        assert.notStrictEqual(
            t.type,
            ORDER_TYPES.BUY,
            `${id} (spread band, live master sell) must not be flipped to BUY at price ${slotPrice(28).toFixed(2)}/${slotPrice(29).toFixed(2)}; got type=${t.type} state=${t.state}`
        );
    }
    console.log('  - spread-band slots with live master sells are not re-typed BUY');

    // End-state non-crossing sanity: every target ACTIVE BUY must price
    // strictly below every target ACTIVE SELL (complement rotation moves
    // across the spread; a target whose book self-crosses is corrupt).
    const activeBuys = [];
    const activeSells = [];
    for (const [, s] of targetGrid) {
        if (s.state !== ORDER_STATES.ACTIVE) continue;
        if (s.type === ORDER_TYPES.BUY) activeBuys.push(Number(s.price));
        else if (s.type === ORDER_TYPES.SELL) activeSells.push(Number(s.price));
    }
    if (activeBuys.length > 0 && activeSells.length > 0) {
        const maxBuy = Math.max(...activeBuys);
        const minSell = Math.min(...activeSells);
        assert(
            maxBuy < minSell,
            `target book must not self-cross: max ACTIVE BUY ${maxBuy} >= min ACTIVE SELL ${minSell}`
        );
    }
    console.log('  - target end-state book does not self-cross');

    // ---- Scenario B: normal two-sell crawl stays sane (no opposite-rail
    // artifacts on the regular path) ----
    const slots2 = buildSlots();
    for (let i = 0; i <= 9; i++) {
        const s = slots2.find(x => x.id === `slot-${i}`);
        s.type = ORDER_TYPES.BUY;
        s.state = ORDER_STATES.ACTIVE;
        s.size = 0.06;
        s.orderId = `1.7.80${i}`;
    }
    for (let i = 20; i <= 29; i++) {
        const s = slots2.find(x => x.id === `slot-${i}`);
        s.type = ORDER_TYPES.SELL;
        s.state = ORDER_STATES.ACTIVE;
        s.size = 0.06;
        s.orderId = `1.7.90${i}`;
    }
    const manager2 = createManager(slots2);
    const strategy2 = new StrategyEngine(manager2);
    const fills2 = [
        { id: 'slot-20', type: ORDER_TYPES.SELL, orderId: '1.7.9020', price: slotPrice(20), size: 0.06, isPartial: false },
        { id: 'slot-21', type: ORDER_TYPES.SELL, orderId: '1.7.9021', price: slotPrice(21), size: 0.06, isPartial: false }
    ];
    const result2 = strategy2.calculateTargetGrid({
        frozenMasterGrid: manager2.orders,
        config: manager2.config,
        accountAssets: manager2.assets,
        funds,
        fills: fills2,
        currentBoundaryIdx: 17
    });
    assert.strictEqual(result2.boundaryIdx, 19, `normal crawl boundary must be 19, got ${result2.boundaryIdx}`);
    for (const [, s] of result2.targetGrid) {
        if (s.type === ORDER_TYPES.BUY && s.state === ORDER_STATES.ACTIVE) {
            assert(
                Number(s.price) < slotPrice(20),
                `normal crawl: no ACTIVE BUY may sit at or above the consumed sell band (slot ${s.id} @ ${s.price})`
            );
        }
    }
    console.log('  - normal sell-side crawl keeps buys below the consumed band');

    console.log('PASS test_placement_guard_removal');
}

run().catch(err => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});
