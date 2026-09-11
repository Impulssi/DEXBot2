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
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, COW_ACTIONS } = require('../modules/constants');
const {
    resolveReserveCount,
    resolveReserveOrders,
    resolveReserveEdgeAnchorPrice,
    resolveLiveReserveEdgeAnchorPrice,
    reserveEdgeIdSet,
    compareReserveEdge,
    selectReserveEdgeSlots,
    deriveTargetBoundary,
    getActiveOrdersTotal,
    collectRefillSlotIds,
} = require('../modules/order/utils/order');

const { _setFeeCache } = require('../modules/order/utils/math');
const { reconcileGrid, optimizeRebalanceActions } = require('../modules/order/utils/validate');
const { _reconcileStartupSide } = require('../modules/order/grid_reconcile_internal');
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
        const floor = reserveEdgeIdSet(slots, { reserveOrders: { buy: 2, sell: 0 } }, ORDER_TYPES.BUY);
        assert(floor.has('slot-0') && floor.has('slot-1') && floor.size === 2, 'floor: lowest buys');
        const ceil = reserveEdgeIdSet(slots, { reserveOrders: { buy: 0, sell: 1 } }, ORDER_TYPES.SELL);
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
    console.log(' - edge anchors resolve bounds, selectors hold both insurance ends...');
    {
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ minPrice: 80 }, 'buy'), 80, 'numeric minPrice anchors buys');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ maxPrice: 120 }, 'sell'), 120, 'numeric maxPrice anchors sells');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ minPrice: '2x', startPrice: 100 }, 'buy'), 50, 'relative minPrice resolves via startPrice');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ maxPrice: '2x', startPrice: 100 }, 'sell'), 200, 'relative maxPrice resolves via startPrice');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({}, 'buy'), null, 'missing bound leaves legacy rank behavior');
        assert.strictEqual(resolveReserveEdgeAnchorPrice({ minPrice: 'x' }, 'buy'), null, 'garbage bound leaves legacy rank behavior');
        // Stale sub-anchor BUY (price 79 below the 80 anchor): anchored floor
        // picks hold the dip-insurance end instead of the stale rank-lowest slot.
        const stale = [
            { id: 'slot-9', price: 109, type: ORDER_TYPES.SELL },
            { id: 'slot-7', price: 79, type: ORDER_TYPES.BUY },
            { id: 'slot-0', price: 80, type: ORDER_TYPES.BUY },
            { id: 'slot-1', price: 81, type: ORDER_TYPES.BUY },
            { id: 'slot-2', price: 82, type: ORDER_TYPES.BUY },
        ];
        const anchoredFloor = reserveEdgeIdSet(stale, { reserveOrders: { buy: 2, sell: 0 } }, ORDER_TYPES.BUY, 80);
        assert(anchoredFloor.has('slot-0') && anchoredFloor.has('slot-1') && anchoredFloor.size === 2, 'floor ids anchor at/above the threshold');
        const legacyFloor = reserveEdgeIdSet(stale, { reserveOrders: { buy: 2, sell: 0 } }, ORDER_TYPES.BUY);
        assert(legacyFloor.has('slot-7') && legacyFloor.has('slot-0'), 'no anchor keeps legacy rank-lowest');
        const staleAsc = stale.slice().sort((a, b) => a.price - b.price);
        assert.deepStrictEqual(
            selectReserveEdgeSlots(staleAsc, 2, new Set(), 'floor', 80).map((s) => s.id),
            ['slot-0', 'slot-1'],
            'anchored floor selector skips stale sub-anchor slots'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(staleAsc, 2, new Set(), 'floor').map((s) => s.id),
            ['slot-7', 'slot-0'],
            'unanchored floor selector keeps legacy behavior'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(staleAsc, 2, new Set(['slot-0']), 'floor', 80).map((s) => s.id),
            ['slot-1', 'slot-2'],
            'anchored floor selector still skips windowed ids'
        );
        // Stale supra-anchor SELL (price 111 above the 109 anchor): anchored
        // ceiling picks hold the spike-insurance end instead of the stale top.
        const staleSell = [
            { id: 'slot-8', price: 108, type: ORDER_TYPES.SELL },
            { id: 'slot-9', price: 109, type: ORDER_TYPES.SELL },
            { id: 'slot-6', price: 111, type: ORDER_TYPES.SELL },
        ];
        const anchoredCeil = reserveEdgeIdSet(staleSell, { reserveOrders: { buy: 0, sell: 1 } }, ORDER_TYPES.SELL, 109);
        assert(anchoredCeil.has('slot-9') && anchoredCeil.size === 1, 'ceiling ids anchor at/below the threshold');
        const legacyCeil = reserveEdgeIdSet(staleSell, { reserveOrders: { buy: 0, sell: 1 } }, ORDER_TYPES.SELL);
        assert(legacyCeil.has('slot-6'), 'no anchor keeps legacy rank-highest');
        const sellAsc = staleSell.slice().sort((a, b) => a.price - b.price);
        assert.deepStrictEqual(
            selectReserveEdgeSlots(sellAsc, 2, new Set(), 'ceiling', 109).map((s) => s.id),
            ['slot-9', 'slot-8'],
            'anchored ceiling selector skips stale supra-anchor slots'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(sellAsc, 2, new Set(), 'ceiling').map((s) => s.id),
            ['slot-6', 'slot-9'],
            'unanchored ceiling selector keeps legacy behavior'
        );
    }
    console.log(' - compareReserveEdge shared comparator (single source)...');
    {
        const rows = [
            { id: 'sub', price: 79, type: ORDER_TYPES.BUY },
            { id: 'near-in', price: 80, type: ORDER_TYPES.BUY },
            { id: 'far-in', price: 82, type: ORDER_TYPES.BUY },
            { id: 'far-out', price: 78, type: ORDER_TYPES.BUY },
        ];
        const sortedFloor = rows.slice().sort((a, b) => compareReserveEdge(a, b, 'floor', 80));
        assert.deepStrictEqual(
            sortedFloor.map((s) => s.id),
            ['near-in', 'far-in', 'sub', 'far-out'],
            'floor comparator: in-bound nearest first, out-of-bound nearest last'
        );
        const sortedNoAnchor = rows.slice().sort((a, b) => compareReserveEdge(a, b, 'floor', null));
        assert.deepStrictEqual(
            sortedNoAnchor.map((s) => s.id),
            ['far-out', 'sub', 'near-in', 'far-in'],
            'null anchor keeps rank-lowest fallback'
        );
        const sellRows = [
            { id: 'supra', price: 111, type: ORDER_TYPES.SELL },
            { id: 'near-in', price: 109, type: ORDER_TYPES.SELL },
            { id: 'far-in', price: 107, type: ORDER_TYPES.SELL },
            { id: 'far-out', price: 112, type: ORDER_TYPES.SELL },
        ];
        const sortedCeil = sellRows.slice().sort((a, b) => compareReserveEdge(a, b, 'ceiling', 109));
        assert.deepStrictEqual(
            sortedCeil.map((s) => s.id),
            ['near-in', 'far-in', 'supra', 'far-out'],
            'ceiling comparator mirrors floor toward maxPrice'
        );
        const sortedNoAnchorCeil = sellRows.slice().sort((a, b) => compareReserveEdge(a, b, 'ceiling', null));
        assert.deepStrictEqual(
            sortedNoAnchorCeil.map((s) => s.id),
            ['far-out', 'supra', 'near-in', 'far-in'],
            'null anchor keeps rank-highest fallback'
        );
    }


    console.log(' - live edge anchors come from the grid geometry (ladder first)...');
    {
        const levels = [80, 81, 82, 83, 84, 85, 86, 87, 88, 89];
        const poolCfg = { startPrice: 'pool', minPrice: '3x', maxPrice: '3x', reserveOrders: { buy: 2, sell: 1 } };
        const genManager = {
            config: poolCfg,
            _genesis: { priceLevels: levels, startPrice: 84 },
            orders: new Map(),
            boundaryIdx: 4,
            _gapSlots: 2,
        };
        assert.strictEqual(resolveReserveEdgeAnchorPrice(poolCfg, 'buy'), null, 'config-only anchor stays null for pool + relative bounds');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(genManager, 'buy'), 80, 'ladder floor anchors the buy edge');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(genManager, 'sell'), 89, 'ladder ceiling anchors the sell edge');

        // The live ladder beats a divergent/stale configured bound.
        const divergent = { ...genManager, config: { ...poolCfg, minPrice: 120, maxPrice: 200 } };
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(divergent, 'buy'), 80, 'live ladder beats the configured floor');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(divergent, 'sell'), 89, 'live ladder beats the configured ceiling');

        // A leftover slot below the live floor ranks last, so the reserve stays
        // on live-rail slots — the behavior the null config anchor could not
        // deliver.
        const rail = [
            { id: 'slot-x', price: 79, type: ORDER_TYPES.BUY },
            ...levels.slice(0, 5).map((price, i) => ({ id: `slot-${i}`, price, type: ORDER_TYPES.BUY })),
        ].sort((a, b) => a.price - b.price);
        const liveFloorAnchor = resolveLiveReserveEdgeAnchorPrice(genManager, 'buy');
        assert.deepStrictEqual(
            selectReserveEdgeSlots(rail, 2, new Set(), 'floor', liveFloorAnchor).map((s) => s.id),
            ['slot-0', 'slot-1'],
            'live-anchored floor skips the sub-floor leftover'
        );
        assert.deepStrictEqual(
            selectReserveEdgeSlots(rail, 2, new Set(), 'floor', null).map((s) => s.id),
            ['slot-x', 'slot-0'],
            'null anchor keeps the leftover first (legacy)'
        );

        // Tier 2: no genesis -> live in-rail extreme of the master grid.
        // Non-grid shelf/manual ids (e.g. a fork-kept deep-* order below the
        // rail) never drag the anchor: isSlotInRail is fail-open for
        // unparseable ids, so the Tier 2 scan skips them explicitly
        // (issue #27 follow-up) and the live rail floor wins.
        assert.strictEqual(
            resolveLiveReserveEdgeAnchorPrice({
                config: poolCfg,
                _genesis: null,
                orders: new Map(rail.map((s) => [s.id, { ...s }])),
                boundaryIdx: 4,
                _gapSlots: 2,
            }, 'buy'),
            80,
            'no genesis falls back to the live in-rail extreme (shelf ids skipped)'
        );

        // Tier 3/4: nothing to read -> config bound, then legacy null.
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice({ config: poolCfg }, 'buy'), null, 'no geometry + unresolvable config keeps legacy rank');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice({ config: { minPrice: 80, startPrice: 'pool' } }, 'buy'), 80, 'no geometry falls back to the config bound');
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(null, 'buy'), null, 'missing manager keeps legacy rank');
    }

    console.log(' - no-crawl classification follows the live edge anchor...');
    {
        const slots = [
            { id: 'slot-7', price: 79, type: ORDER_TYPES.BUY },
            { id: 'slot-0', price: 80, type: ORDER_TYPES.BUY },
            { id: 'slot-1', price: 81, type: ORDER_TYPES.BUY },
            { id: 'slot-2', price: 82, type: ORDER_TYPES.BUY },
        ];
        const cfg = { startPrice: 'pool', minPrice: '3x', maxPrice: '3x', reserveOrders: { buy: 2, sell: 0 } };
        const configAnchored = reserveEdgeIdSet(slots, cfg, ORDER_TYPES.BUY);
        const liveAnchored = reserveEdgeIdSet(slots, cfg, ORDER_TYPES.BUY, 80);
        assert(configAnchored && configAnchored.has('slot-7'), 'unresolved config anchor classifies the leftover as a reserve');
        assert(liveAnchored && liveAnchored.has('slot-0') && liveAnchored.has('slot-1') && !liveAnchored.has('slot-7'), 'live anchor keeps classification inside the live rail');
    }

    console.log(' - shelf/manual ids are never reserves (issue #27 follow-up)...');
    {
        // Fork-kept shelf orders below the rail (non-slot-N ids, live on-chain)
        // must not be counted as the reserve edge in any anchor outcome:
        // otherwise the deficit can never appear while the shelf is live and
        // the targeted-sync reserve reason stays silent.
        const shelfSlots = [
            { id: 'deep-1', price: 70, type: ORDER_TYPES.BUY },
            { id: 'deep-0', price: 71, type: ORDER_TYPES.BUY },
            { id: 'slot-0', price: 80, type: ORDER_TYPES.BUY },
            { id: 'slot-1', price: 81, type: ORDER_TYPES.BUY },
            { id: 'slot-2', price: 82, type: ORDER_TYPES.BUY },
        ];
        const shelfCfg = { reserveOrders: { buy: 2, sell: 0 } };
        const rankFallback = reserveEdgeIdSet(shelfSlots, shelfCfg, ORDER_TYPES.BUY);
        assert(rankFallback && rankFallback.has('slot-0') && rankFallback.has('slot-1') && rankFallback.size === 2, 'rank fallback skips shelf ids');
        const anchored = reserveEdgeIdSet(shelfSlots, shelfCfg, ORDER_TYPES.BUY, 80);
        assert(anchored && anchored.has('slot-0') && anchored.has('slot-1') && anchored.size === 2, 'finite anchor skips shelf ids');
        // Shelf-only grid: empty edge set, so the deficit (0/2) can fire.
        const shelfOnly = reserveEdgeIdSet(shelfSlots.slice(0, 2), shelfCfg, ORDER_TYPES.BUY, 80);
        assert(shelfOnly && shelfOnly.size === 0, 'no rail slots means no live reserves');
        // Tier 2 anchor scan skips shelf ids even though isSlotInRail is
        // fail-open for unparseable ids: the live rail floor wins.
        const shelfManager = {
            config: { startPrice: 'pool', minPrice: '3x', maxPrice: '3x' },
            _genesis: null,
            orders: new Map(shelfSlots.map((s) => [s.id, { ...s }])),
            boundaryIdx: 4,
            _gapSlots: 2,
        };
        assert.strictEqual(resolveLiveReserveEdgeAnchorPrice(shelfManager, 'buy'), 80, 'shelf ids never drag the live anchor');
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

    console.log(' - live edge anchors drive no-crawl classification...');
    {
        const allSlots = [
            { id: 'slot-7', price: 50, type: ORDER_TYPES.BUY },      // stray below the live floor (idx 0)
            ...Array.from({ length: 5 }, (_, i) => ({ id: `slot-${i}`, price: 80 + i, type: ORDER_TYPES.BUY })), // idx 1..5
            { id: 'gap-0', price: 85, type: ORDER_TYPES.SPREAD },
            { id: 'gap-1', price: 86, type: ORDER_TYPES.SPREAD },
            { id: 'slot-8', price: 90, type: ORDER_TYPES.SELL },     // idx 8
            { id: 'slot-9', price: 91, type: ORDER_TYPES.SELL },
        ];
        const cfg = {
            startPrice: 'pool', minPrice: '3x', maxPrice: '3x',
            activeOrders: { buy: 2, sell: 1 },
            reserveOrders: { buy: 2, sell: 0 },
        };
        const strayFill = [{ id: 'slot-7', type: ORDER_TYPES.BUY }];
        const liveAnchors = { buy: 80, sell: 91 };
        assert.strictEqual(
            deriveTargetBoundary(strayFill, 5, allSlots, cfg, 2, null).boundaryIdx, 5,
            'without live anchors the stray is classified as a reserve and holds the boundary'
        );
        assert.strictEqual(
            deriveTargetBoundary(strayFill, 5, allSlots, cfg, 2, null, null, liveAnchors).boundaryIdx, 4,
            'with live anchors the stray is ordinary market movement and crawls'
        );
        assert.strictEqual(
            deriveTargetBoundary([{ id: 'slot-0', type: ORDER_TYPES.BUY }], 5, allSlots, cfg, 2, null, null, liveAnchors).boundaryIdx, 5,
            'real live-floor reserve fills still never crawl'
        );
    }

    console.log(' - reserve activation uses stored sizes only (no re-derivation)...');
    {
        const makeMgr = async (size: number, type: string, liveReserveIds: string[] = []) => {
            const mgr = new OrderManager({
                market: 'TEST/BTS', assetA: 'TEST', assetB: 'BTS',
                startPrice: 100, incrementPercent: 1, targetSpreadPercent: 0,
                activeOrders: { buy: 3, sell: 2 }, weightDistribution: { sell: 0.5, buy: 0.5 },
                reserveOrders: { buy: 2, sell: 1 },
            });
            mgr.logger.level = 'silent';
            mgr.assets = {
                assetA: { id: '1.3.0', precision: 8, symbol: 'TEST' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'BTS' },
            };
            await mgr.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
            await mgr.resetFunds();
            mgr._gapSlots = 0;
            mgr.boundaryIdx = 9;
            mgr.pauseFundRecalc();
            for (let i = 0; i < 14; i++) {
                const live = liveReserveIds.includes(`slot-${i}`);
                await mgr._updateOrder({
                    id: `slot-${i}`,
                    type: live ? ORDER_TYPES.BUY : type,
                    price: 80 + i,
                    size: live ? 100 : size,
                    state: live ? ORDER_STATES.ACTIVE : ORDER_STATES.VIRTUAL,
                    orderId: live ? `1.7.${900 + i}` : null,
                });
            }
            await mgr.resumeFundRecalc();
            return mgr;
        };
        const planBuy = async (mgr: any) => {
            const plannedCreates: any[] = [];
            await _reconcileStartupSide({
                orderType: ORDER_TYPES.BUY, targetCount: 5,
                chainSideOrders: [], unmatchedSideOrders: [],
                manager: mgr, chainOrders: {}, account: 'acct', privateKey: 'pk',
                dryRun: true, plannedCreates, plannedUpdates: [], plannedCancels: [], planOnly: true,
            });
            return plannedCreates.map((c: any) => ({ id: c.gridOrder?.id, size: Number(c.gridOrder?.size) }));
        };

        // Steady state: the edge reserves are planned with the size the grid
        // already carries — never a locally re-derived one.
        const sizedPlan = await planBuy(await makeMgr(100, ORDER_TYPES.BUY));
        const sizedEdge = sizedPlan.filter((p) => p.id === 'slot-0' || p.id === 'slot-1');
        assert.strictEqual(sizedEdge.length, 2, 'sized reserves planned at the live edge');
        assert.deepStrictEqual(sizedEdge.map((p) => p.size), [100, 100], 'reserve size is the stored size, untouched');

        // Unsized edge (fresh grid / virtualized slot): nothing is invented. The
        // reserve share of the deficit is held back for the edge instead of being
        // filled with middle window slots, so the target-grid sizing pipeline
        // creates them at the edge directly (no place-then-rotate churn).
        const unsizedPlan = await planBuy(await makeMgr(0, ORDER_TYPES.SPREAD));
        const unsizedIds = unsizedPlan.map((p) => p.id);
        assert(!unsizedIds.includes('slot-0') && !unsizedIds.includes('slot-1'), 'unsized reserves are not activated');
        assert.deepStrictEqual(unsizedIds, ['slot-9', 'slot-8', 'slot-7'], 'window only, closest-to-market first');
        assert.strictEqual(unsizedPlan.length, 3, 'reserve share of the deficit held back for the edge');

        // Live reserves on-chain + empty window: the deficit is window-only, so
        // nothing is held back (a live reserve is already matchedOnGrid and must
        // not shrink the window plan).
        const livePlan = await planBuy(await makeMgr(0, ORDER_TYPES.SPREAD, ['slot-0', 'slot-1']));
        assert.deepStrictEqual(
            livePlan.map((p) => p.id), ['slot-9', 'slot-8', 'slot-7'],
            'live reserves do not shrink the window plan'
        );

        // Reconcile placement agrees with reserve classification: a kept
        // virtual non-grid shelf (non-slot-N id below the rail, e.g.
        // fork-injected deep-*) is never activated as a reserve, in both
        // the anchored case (gated live-edge anchor keeps it out-of-bound
        // and ranks it last) and the rank-fallback case (slot-N gate in
        // _pickEdgeReserveSlots, since isSlotInRail is fail-open for
        // unparseable ids) — issue #27 follow-up.
        const shelfMgr = await makeMgr(100, ORDER_TYPES.BUY);
        await shelfMgr._updateOrder({
            id: 'deep-a', type: ORDER_TYPES.BUY, price: 70,
            size: 100, state: ORDER_STATES.VIRTUAL, orderId: null,
        });
        const shelfPlanIds = (await planBuy(shelfMgr)).map((p) => p.id);
        assert(!shelfPlanIds.includes('deep-a'), 'non-slot-N shelf never activated as a reserve');
        assert(shelfPlanIds.includes('slot-0') && shelfPlanIds.includes('slot-1'), 'rail edge reserves still placed');
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

    console.log(' - refill wire excludes reserve CREATEs (boundary hold)...');
    {
        const slots: any[] = [];
        for (let i = 0; i < 14; i++) {
            slots.push({ id: `slot-${i}`, type: i < 10 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL, price: 80 + i });
        }
        const actions = [
            { type: COW_ACTIONS.CREATE, id: 'slot-0' },
            { type: COW_ACTIONS.CREATE, id: 'slot-1' },
            { type: COW_ACTIONS.CREATE, id: 'slot-8' },
            { type: COW_ACTIONS.CREATE, id: 'slot-13' },
            { type: COW_ACTIONS.UPDATE, id: 'slot-9', newGridId: 'slot-2' },
        ];
        const cfg = { reserveOrders: { buy: 2, sell: 1 } };
        const anchors = { buy: 80, sell: 93 };
        const wire = collectRefillSlotIds(actions, { config: cfg, slots, edgeAnchors: anchors });
        assert.deepStrictEqual(wire, ['slot-8'],
            'floor/ceiling reserve CREATEs are not refills; the window CREATE stays');
        assert.deepStrictEqual(
            collectRefillSlotIds(actions, { config: cfg, slots: new Map(slots.map((s) => [s.id, s])), edgeAnchors: anchors }),
            ['slot-8'],
            'Map slots (the plan path passes manager.orders) classify like the array form'
        );
        const plainWire = ['slot-0', 'slot-1', 'slot-8', 'slot-13'];
        assert.deepStrictEqual(
            collectRefillSlotIds(actions, { config: { reserveOrders: { buy: 0, sell: 0 } }, slots }),
            plainWire,
            'disabled reserves keep the plain CREATE wire'
        );
        assert.deepStrictEqual(
            collectRefillSlotIds(actions, {}),
            plainWire,
            'no classification context (legacy callers) must not drop ids'
        );
        assert.deepStrictEqual(
            collectRefillSlotIds([{ type: COW_ACTIONS.CANCEL, id: 'slot-3' }, { type: COW_ACTIONS.CREATE }], {}),
            [],
            'cancel/malformed actions never enter the wire'
        );
    }

    console.log(' - COW plan path: reserve CREATEs never enter the refill wire...');
    {
        const mgr: any = new OrderManager({
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
        const funds = { ...mgr.funds, allocatedBuy: 10000, allocatedSell: 100 };
        const { targetGrid, boundaryIdx } = strategy.calculateTargetGrid({
            frozenMasterGrid: mgr.orders,
            config: mgr.config,
            accountAssets: mgr.assets,
            funds,
            fills: [],
            currentBoundaryIdx: mgr.boundaryIdx,
        });
        const reconciled = reconcileGrid(mgr.orders, targetGrid, boundaryIdx, {
            logger: () => {},
            dustThresholdPercent: 0,
            assets: mgr.assets,
            gapSlots: mgr._gapSlots,
        });
        const optimized = optimizeRebalanceActions(reconciled.actions, mgr.orders, {
            assets: mgr.assets,
            boundaryIdx,
            gapSlots: mgr._gapSlots,
        });
        const edgeAnchors = {
            buy: resolveLiveReserveEdgeAnchorPrice(mgr, 'buy'),
            sell: resolveLiveReserveEdgeAnchorPrice(mgr, 'sell'),
        };
        const createIds = optimized
            .filter((a: any) => a?.type === COW_ACTIONS.CREATE && typeof a?.id === 'string')
            .map((a: any) => a.id);
        const wire = collectRefillSlotIds(optimized, { config: mgr.config, slots: mgr.orders, edgeAnchors });

        assert(createIds.includes('slot-0') && createIds.includes('slot-1') && createIds.includes('slot-13'),
            `fixture must plan the reserve edges as CREATEs (got ${createIds.join(', ')})`);
        assert(!wire.includes('slot-0') && !wire.includes('slot-1') && !wire.includes('slot-13'),
            `reserve CREATEs must never justify a boundary hold (wire: ${wire.join(', ')})`);
        assert(wire.includes('slot-7') && wire.includes('slot-10'),
            `window hole CREATEs stay in the wire (wire: ${wire.join(', ')})`);
    }

    console.log('✓ Reserve orders tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
