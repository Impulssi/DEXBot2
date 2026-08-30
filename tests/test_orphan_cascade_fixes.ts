/**
 * tests/test_orphan_cascade_fixes.ts
 *
 * Regression tests for the orphan-cascade fixes (A–E), layered on the
 * P0–P3 broadcast-gate work:
 *
 *   Fix A — anchor poisoning guard: fill prices resolved from stale slot
 *           state must not poison the MarketAnchor (lastFillPrice / range)
 *           nor the burst boundary correction / placement guard
 *           (deriveAnchorBounds + resolveFillPrice bounds + outlier
 *           telemetry counters).
 *   Fix B — price sanity gate: checkPlacementPriceSanity rejects planned
 *           prices >5% off the anchor-derived market reference
 *           (deriveMarketReferencePrice).
 *   Fix C — suspect empty-read guard: an empty open-orders read while the
 *           grid holds placed orders is refused (phantom protection) until
 *           SYNC_SUSPECT_EMPTY_READ_LIMIT consecutive empties confirm.
 *   Fix D — by-id adoption retry/backoff: adoptPlacedBatchFromChain retries
 *           a lagging by-id read instead of deferring on first failure.
 *   Fix E — unknown-fill adoption-before-credit: processSweepOrphanFill
 *           defers crediting when the unknown order is live on-chain inside
 *           the grid price range; credits only gone/foreign/read-failure.
 */
const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

// Compiled ESM namespaces are frozen and require.cache injection cannot
// intercept static ESM imports, so chain_orders is replaced via loader hooks
// (same technique as test_fill_replay_guards / test_cow_ops_per_broadcast).
// Swappable functions resolve per-test overrides at CALL time: assignments
// mutate the override map through the Proxy while consumers' captured
// named-export bindings stay valid.
esmMockEntry();

function makeSwappableModule(defaults: Record<string, any>) {
    const overrides = new Map<string, any>();
    const resolved = (key: string) => (overrides.has(key) ? overrides.get(key) : defaults[key]);
    const target: Record<string, any> = {};
    for (const key of Object.keys(defaults)) {
        target[key] = typeof defaults[key] === 'function'
            ? (...args: any[]) => resolved(key)(...args)
            : defaults[key];
    }
    return new Proxy(target, {
        set(_t: any, prop: string | symbol, value: any) {
            const key = String(prop);
            if (target[key] === value) {
                overrides.delete(key);
            } else {
                overrides.set(key, value);
            }
            return true;
        },
    });
}

const { BroadcastUncertainError } = require('../modules/dexbot_credential_client');

const chainOrders = makeSwappableModule({
    BroadcastUncertainError,
    selectAccount: async () => {},
    setPreferredAccount: async () => {},
    resolveAccountId: async () => null,
    resolveAccountName: async () => null,
    readOpenOrders: async () => [],
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    readSingleOrder: async () => null,
    batchReadOrders: async () => new Map(),
    listenForFills: async () => () => {},
    updateOrder: async () => { throw new Error('updateOrder not configured for this test'); },
    createOrder: async () => { throw new Error('createOrder not configured for this test'); },
    cancelOrder: async () => { throw new Error('cancelOrder not configured for this test'); },
    getOnChainAssetBalances: async () => ({}),
    getFillProcessingMode: async () => 'history',
    buildUpdateOrderOp: async () => { throw new Error('buildUpdateOrderOp not configured for this test'); },
    buildCreateOrderOp: async () => { throw new Error('buildCreateOrderOp not configured for this test'); },
    buildCancelOrderOp: async () => ({ op_name: 'limit_order_cancel', op_data: {} }),
    buildLiquidityPoolExchangeOp: async () => { throw new Error('buildLiquidityPoolExchangeOp not configured for this test'); },
    executeBatch: async () => ({ success: true, operation_results: [] }),
    findOverReducingUpdateOpError: async () => null,
    wasRecentlyOwnCancelled: () => false,
    recordOwnCancel: () => {},
    broadcastTxWithClassification: async () => ({}),
});
defineEsmMockAbs(require.resolve('../modules/chain_orders'), [
    'selectAccount', 'setPreferredAccount', 'resolveAccountId', 'resolveAccountName',
    'readOpenOrders', 'readOpenOrdersWithMeta', 'readOpenOrdersWithMetaSafe', 'readOpenOrdersGuarded',
    'readSingleOrder', 'batchReadOrders', 'listenForFills', 'updateOrder', 'createOrder', 'cancelOrder',
    'getOnChainAssetBalances', 'getFillProcessingMode', 'buildUpdateOrderOp', 'buildCreateOrderOp',
    'buildCancelOrderOp', 'buildLiquidityPoolExchangeOp', 'executeBatch',
    'findOverReducingUpdateOpError', 'wasRecentlyOwnCancelled', 'recordOwnCancel',
    'BroadcastUncertainError', 'broadcastTxWithClassification'
], chainOrders);

const { OrderManager } = require('../modules/order/index').default;
const { ORDER_TYPES, ORDER_STATES, ORDER_PLACEMENT, TIMING } = require('../modules/constants');

const mathUtils = require('../modules/order/utils/math');
mathUtils._setFeeCache({
    BTS: {
        limitOrderCreate: { bts: 0.1 },
        limitOrderCancel: { bts: 0.05 },
        limitOrderUpdate: { bts: 0.05 },
        makerFeeDiscountPercent: 0.25,
    },
    TEST: {
        chargesMarketFees: false,
        marketFee: { percent: 0 },
    },
});

const {
    createEmptyMarketAnchor,
    seedMarketAnchorFromBook,
    updateMarketAnchorFromFills,
    deriveAnchorBounds,
    isPriceWithinBounds,
    resolveFillPrice,
    computePriceAnchoredBoundaryTarget,
    deriveTargetBoundary,
    deriveMarketReferencePrice,
    isPriceWithinMarketTolerance,
    checkPlacementPriceSanity,
} = require('../modules/order/utils/order');
const { adoptPlacedBatchFromChain } = require('../modules/dexbot_cow_runtime');
const { processSweepOrphanFill } = require('../modules/dexbot_fill_runtime');

function silentLogger() {
    return { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
}

function makeFill(p: any) {
    const f: any = { op: [0, { order_id: p.orderId }], block_num: p.block_num, id: p.id, type: p.type, price: p.price };
    return f;
}

async function run() {
    console.log('Running orphan-cascade fixes (A–E) regression tests...');

    // ════════════════════════════════════════════════════════════════
    // FIX A — anchor poisoning guard
    // ════════════════════════════════════════════════════════════════
    {
        // deriveAnchorBounds: both-sided, single-sided, invalid factor
        const bounds = deriveAnchorBounds({ minFilledBuyPrice: 0.303, maxFilledSellPrice: 0.3416 }, 2);
        assert.deepStrictEqual(
            [bounds.low.toFixed(4), bounds.high.toFixed(4)],
            ['0.1515', '0.6832'],
            'both-sided bounds = range expanded by factor'
        );
        const lowOnly = deriveAnchorBounds({ minFilledBuyPrice: 0.3, maxFilledSellPrice: null }, 2);
        assert.strictEqual(lowOnly.low.toFixed(4), '0.1500', 'low-only bound derived');
        assert.strictEqual(lowOnly.high, Infinity, 'low-only high is open');
        assert.strictEqual(deriveAnchorBounds(null, 2), null, 'null anchor → no bounds');
        assert.strictEqual(deriveAnchorBounds({ minFilledBuyPrice: 0.3 }, 1), null, 'factor <= 1 → no bounds (unguarded)');

        // isPriceWithinBounds
        assert.strictEqual(isPriceWithinBounds(3.08, bounds), false, '3.08 outside [0.15, 0.68]');
        assert.strictEqual(isPriceWithinBounds(0.35, bounds), true, '0.35 inside bounds');
        assert.strictEqual(isPriceWithinBounds(0.35, null), true, 'null bounds → unguarded');
        assert.strictEqual(isPriceWithinBounds(NaN, bounds), false, 'NaN rejected by bounds');
    }

    {
        // Poisoning replay: seeded anchor [0.303, 0.3045]; a burst of
        // fills whose prices resolve from stale far slots (3.05–3.35) must
        // be rejected — lastFillPrice stays null, range unchanged, outlier
        // counters increment, dedupe keys stay unclaimed.
        const anchor: any = seedMarketAnchorFromBook([
            { price: 0.30303524530881715, type: ORDER_TYPES.BUY },
            { price: 0.30455803977240953, type: ORDER_TYPES.SELL },
        ]);
        assert.ok(anchor, 'seeded from book');

        const slots = new Map([
            ['slot-542', { id: 'slot-542', price: 3.05, type: ORDER_TYPES.BUY }],
            ['slot-544', { id: 'slot-544', price: 3.081335615313846, type: ORDER_TYPES.BUY }],
            ['slot-561', { id: 'slot-561', price: 3.35, type: ORDER_TYPES.BUY }],
        ]);
        // Fills as the manager normalizes them after slot-price binding
        // (fill.price = stale slot price — the direct path is the poisoned one).
        // The last fill carries no price and matches a slot id, covering the
        // slot-price fallback path of resolveFillPrice.
        const poisonedFills = [
            makeFill({ block_num: 100, id: 'p1', type: ORDER_TYPES.BUY, orderId: 'slot-561', price: 3.35 }),
            makeFill({ block_num: 101, id: 'p2', type: ORDER_TYPES.BUY, orderId: 'slot-544', price: 3.081335615313846 }),
            { op: [0, { order_id: 'slot-542' }], block_num: 102, id: 'slot-542', type: ORDER_TYPES.BUY },
        ];
        const out = updateMarketAnchorFromFills(anchor, poisonedFills, slots, {});
        assert.strictEqual(out.lastFillPrice, null, 'poisoned fills do not set lastFillPrice');
        assert.strictEqual(out.fillCount, 0, 'poisoned fills do not count');
        assert.strictEqual(out.maxFilledSellPrice, 0.30455803977240953, 'range max unchanged');
        assert.strictEqual(out.minFilledBuyPrice, 0.30303524530881715, 'range min unchanged');
        assert.strictEqual(out.rejectedOutlierFills, 3, 'outlier counter tracks all 3 rejections');
        assert.strictEqual(out.lastRejectedOutlier.price, 3.05, 'lastRejectedOutlier carries the implausible price');
        assert.strictEqual(out._seenKeys.size, 0, 'dedupe keys NOT consumed by rejected fills');

        // A legitimate in-range fill still applies.
        const legit = makeFill({ block_num: 110, id: 'l1', type: ORDER_TYPES.BUY, orderId: 'slot-ok', price: 0.3025 });
        updateMarketAnchorFromFills(out, [legit], slots, {});
        assert.strictEqual(out.lastFillPrice, 0.3025, 'legitimate in-range fill applies');
        assert.strictEqual(out.fillCount, 1, 'legitimate fill counts');

        // Legitimate range extension within factor still widens the range.
        const extend = makeFill({ block_num: 120, id: 'l2', type: ORDER_TYPES.SELL, orderId: 'slot-ok2', price: 0.6 });
        updateMarketAnchorFromFills(out, [extend], slots, {});
        assert.strictEqual(out.maxFilledSellPrice, 0.6, 'in-factor range extension applied (0.6 < 0.6832)');
    }

    {
        // Cold anchor (no range): guard inactive — fill applies (documented
        // cold-start behavior; the startup book-seed establishes the range).
        const cold: any = createEmptyMarketAnchor();
        updateMarketAnchorFromFills(cold, [makeFill({ block_num: 1, id: 'c1', type: ORDER_TYPES.BUY, orderId: 'slot-x', price: 3.08 })], new Map(), {});
        assert.strictEqual(cold.lastFillPrice, 3.08, 'cold anchor without range accepts the first fill (no reference)');
    }

    {
        // Poisoned range write prevented: a poisoned SELL fill at 3.08 must
        // not widen maxFilledSellPrice (which would drag projectAnchorToGrid
        // to the far rail).
        const anchor: any = seedMarketAnchorFromBook([
            { price: 0.303, type: ORDER_TYPES.BUY },
            { price: 0.3045, type: ORDER_TYPES.SELL },
        ]);
        updateMarketAnchorFromFills(anchor, [makeFill({ block_num: 5, id: 'ps', type: ORDER_TYPES.SELL, orderId: 'slot-s', price: 3.08 })], new Map(), {});
        assert.strictEqual(anchor.maxFilledSellPrice, 0.3045, 'poisoned SELL fill does not widen the range');
    }

    {
        // resolveFillPrice with bounds
        const slotById = new Map([['s1', { id: 's1', price: 3.08 }]]);
        const bounds = deriveAnchorBounds({ minFilledBuyPrice: 0.303, maxFilledSellPrice: 0.3045 }, 2);
        assert.strictEqual(resolveFillPrice({ id: 's1' }, slotById, bounds), null, 'slot-price fallback rejected when implausible');
        assert.strictEqual(resolveFillPrice({ id: 's1' }, slotById, null), 3.08, 'unguarded resolve still works');
        assert.strictEqual(
            resolveFillPrice({ price: 0.30 }, null, bounds),
            0.30,
            'plausible direct price passes bounds'
        );
    }

    {
        // Burst boundary correction: poisoned fills must not drag the
        // correction bound to the far rail (a 10x-off fill drags the bound
        // from slot ~28 to the 3.x rail).
        const allSlots: any[] = [];
        for (let i = 0; i <= 60; i++) allSlots.push({ id: `slot-${i}`, price: 0.3 * Math.pow(1.005, i - 30) });
        // Add far-rail slots at 3.x (stale grid rail).
        allSlots.push({ id: 'slot-far', price: 3.35 });
        // Fill shape as the manager normalizes it: id = slot id (slot-price fallback path).
        const poisonedFills = [
            makeFill({ block_num: 1, id: 'slot-far', type: ORDER_TYPES.SELL, orderId: 'slot-far' }),
        ];
        const noGuard = computePriceAnchoredBoundaryTarget(poisonedFills, allSlots, 3, null);
        assert.ok(noGuard && noGuard.boundIdx > 50, 'unguarded correction reaches far rail (documents the poison)');
        const guarded = computePriceAnchoredBoundaryTarget(
            poisonedFills,
            allSlots,
            3,
            deriveAnchorBounds({ minFilledBuyPrice: 0.303, maxFilledSellPrice: 0.3045 }, 2)
        );
        assert.strictEqual(guarded, null, 'guarded correction ignores implausible fills (null → count-based shift)');

        // Mixed burst: plausible + poisoned → bound from plausible subset.
        const plausibleSlot = allSlots.find((s: any) => s.price >= 0.31 && s.price <= 0.34);
        assert.ok(plausibleSlot, 'a plausible slot exists in the grid');
        const mixed = [
            makeFill({ block_num: 1, id: 'slot-far', type: ORDER_TYPES.SELL, orderId: 'slot-far' }),
            makeFill({ block_num: 2, id: plausibleSlot.id, type: ORDER_TYPES.SELL, orderId: plausibleSlot.id }),
        ];
        const mixedGuarded = computePriceAnchoredBoundaryTarget(
            mixed,
            allSlots,
            3,
            deriveAnchorBounds({ minFilledBuyPrice: 0.303, maxFilledSellPrice: 0.3045 }, 2)
        );
        assert.ok(mixedGuarded && mixedGuarded.boundIdx < 50, 'mixed burst bound comes from the plausible fill only');

        // deriveTargetBoundary threads bounds on the per-call path.
        const threadOut = deriveTargetBoundary(
            mixed, 20, allSlots,
            { activeOrders: { sell: 5, buy: 5 }, startPrice: 0.32 },
            3, null, undefined,
            deriveAnchorBounds({ minFilledBuyPrice: 0.303, maxFilledSellPrice: 0.3045 }, 2)
        );
        assert.ok(threadOut.boundaryIdx < 50, 'deriveTargetBoundary keeps boundary near the plausible range');
    }

    // ════════════════════════════════════════════════════════════════
    // FIX B — price sanity gate (5%)
    // ════════════════════════════════════════════════════════════════
    {
        assert.strictEqual(ORDER_PLACEMENT.MAX_PRICE_DEVIATION, 0.05, 'MAX_PRICE_DEVIATION defaults to 5%');

        const anchor = { minFilledBuyPrice: 0.303, maxFilledSellPrice: 0.3416 };
        const ref = deriveMarketReferencePrice(anchor);
        assert.ok(Math.abs(ref - (0.303 + 0.3416) / 2) < 1e-9, 'reference = range mid');
        assert.strictEqual(deriveMarketReferencePrice(null), null, 'no anchor → no reference');
        assert.strictEqual(deriveMarketReferencePrice({ minFilledBuyPrice: 0.3, maxFilledSellPrice: null }), 0.3, 'single-sided reference');

        const bad = checkPlacementPriceSanity(3.35, anchor);
        assert.strictEqual(bad.ok, false, '3.35 vs ref ≈0.322 → rejected');
        assert.ok(bad.deviation > 9, 'deviation ≈ 940%');
        const good = checkPlacementPriceSanity(0.31, anchor);
        assert.strictEqual(good.ok, true, '0.31 vs ref 0.3223 ≈ -3.8% → allowed');
        assert.strictEqual(isPriceWithinMarketTolerance(0.3395, ref, 0.05), false, 'tolerance math: 5.3% > 5% → reject');
        assert.strictEqual(isPriceWithinMarketTolerance(0.338, ref, 0.05), true, '4.9% ≤ 5% → allow');

        const noRef = checkPlacementPriceSanity(3.35, null);
        assert.strictEqual(noRef.ok, true, 'no reference → gate inactive (cannot judge)');
        assert.strictEqual(noRef.reason, 'no-reference', 'reason explains gate inactivity');

        const invalid = checkPlacementPriceSanity(NaN, anchor);
        assert.strictEqual(invalid.ok, true, 'invalid planned price → allowed (never fire on bad metadata)');

        // Far-rail slot prices: every one is rejected by the gate.
        for (const p of [3.05, 3.081335615313846, 3.35]) {
            assert.strictEqual(checkPlacementPriceSanity(p, anchor).ok, false, `slot price ${p} rejected by gate`);
        }
    }

    // ════════════════════════════════════════════════════════════════
    // FIX C — suspect empty-read guard (OrderManager harness)
    // ════════════════════════════════════════════════════════════════
    {
        const mgr: any = new OrderManager({ market: 'XRP/BTS', assetA: 'XRP', assetB: 'BTS' });
        mgr.assets = {
            assetA: { symbol: 'XRP', id: '1.3.5537', precision: 4 },
            assetB: { symbol: 'BTS', id: '1.3.0', precision: 5 },
        };
        mgr.logger = silentLogger();
        await mgr.setAccountTotals({ buy: 100000, sell: 1000, buyFree: 100000, sellFree: 1000 });
        await mgr._updateOrder({
            id: 'slot-10',
            state: ORDER_STATES.ACTIVE,
            type: ORDER_TYPES.BUY,
            size: 10,
            price: 0.30,
            orderId: '1.7.900001',
        });

        const limit = Math.max(1, Number(TIMING.SYNC_SUSPECT_EMPTY_READ_LIMIT) || 3);
        for (let i = 1; i <= limit - 1; i++) {
            const r = await mgr.sync._doSyncFromOpenOrders([], {});
            assert.strictEqual(r.filledOrders.length, 0, `empty-read refusal ${i}: no fills processed`);
            assert.strictEqual(mgr.orders.get('slot-10').orderId, '1.7.900001', `empty-read refusal ${i}: slot untouched (no phantom virtualization)`);
            assert.strictEqual(mgr._suspectEmptyReads.count, i, `empty-read refusal ${i}: suspect counter incremented`);
        }

        // limit-th consecutive empty → accepted → phantom cleanup runs.
        const rFinal = await mgr.sync._doSyncFromOpenOrders([], {});
        assert.strictEqual(mgr._suspectEmptyReads.count, 0, 'counter resets after confirmed empty');
        assert.strictEqual(rFinal.filledOrders.length, 1, 'confirmed empty read reports the vanished order as filled');
        const slot = mgr.orders.get('slot-10');
        assert.ok(
            slot.orderId == null && slot.state === ORDER_STATES.VIRTUAL,
            'confirmed empty read reconciles the account (phantom cleaned to VIRTUAL placeholder)'
        );

        // Non-empty read resets the counter.
        mgr._suspectEmptyReads = { count: 2, firstAt: Date.now() };
        const liveOrder = {
            id: '1.7.900002',
            sell_price: {
                base: { amount: 30000000, asset_id: '1.3.0' },
                quote: { amount: 1000000, asset_id: '1.3.5537' },
            },
            for_sale: '30000000',
        };
        await mgr.sync._doSyncFromOpenOrders([liveOrder], {});
        assert.strictEqual(mgr._suspectEmptyReads.count, 0, 'non-empty read resets the suspect counter');
    }

    // ════════════════════════════════════════════════════════════════
    // FIX D — by-id adoption retry/backoff
    // ════════════════════════════════════════════════════════════════
    {
        const makeBot = () => {
            const adopted: any[] = [];
            return {
                accountId: '1.2.999',
                manager: {
                    grid: [{ id: 'slot-1', orderId: '1.7.100' }],
                    logger: silentLogger(),
                    syncFromOpenOrders: async (orders: any[]) => { adopted.push(orders); },
                },
                _adopted: adopted,
            };
        };

        const placedResults = { operation_results: [[0, '1.7.999']] };
        const placedContexts = [{ kind: 'create', id: 'slot-1', order: { id: 'slot-1' } }];

        // (a) lagging read (fresh CREATE absent) twice, then caught up → adopted
        {
            const bot = makeBot();
            let attempts = 0;
            chainOrders.batchReadOrders = async () => {
                attempts++;
                const m = new Map();
                m.set('1.7.100', { id: '1.7.100', sell_price: { base: { amount: 1, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.5537' } } });
                if (attempts < 3) m.set('1.7.999', null); // lagging node
                else m.set('1.7.999', { id: '1.7.999', sell_price: { base: { amount: 1, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.5537' } } });
                return m;
            };
            const ok = await adoptPlacedBatchFromChain(bot, chainOrders, '[TEST]', { placedResults, placedContexts });
            assert.strictEqual(ok, true, 'retry-then-caught-up: adoption succeeds');
            assert.strictEqual(attempts, 3, 'by-id read retried until the fresh CREATE appears');
            assert.strictEqual(bot._adopted.length, 1, 'master synced from the caught-up by-id read');
        }

        // (b) persistent lagging read → defer (false), protection kept
        {
            const bot = makeBot();
            let attempts = 0;
            chainOrders.batchReadOrders = async () => {
                attempts++;
                const m = new Map();
                m.set('1.7.100', { id: '1.7.100' });
                m.set('1.7.999', null);
                return m;
            };
            const ok = await adoptPlacedBatchFromChain(bot, chainOrders, '[TEST]', { placedResults, placedContexts });
            assert.strictEqual(ok, false, 'persistent lagging read still defers (protection kept)');
            assert.strictEqual(attempts, 3, 'defer happens only after all retry attempts');
            assert.strictEqual(bot._adopted.length, 0, 'no partial adoption on defer');
        }

        // (c) read throws then succeeds → adopted
        {
            const bot = makeBot();
            let attempts = 0;
            chainOrders.batchReadOrders = async () => {
                attempts++;
                if (attempts === 1) throw new Error('connection lost');
                const m = new Map();
                m.set('1.7.100', { id: '1.7.100' });
                m.set('1.7.999', { id: '1.7.999' });
                return m;
            };
            const ok = await adoptPlacedBatchFromChain(bot, chainOrders, '[TEST]', { placedResults, placedContexts });
            assert.strictEqual(ok, true, 'read failure then success: adoption succeeds');
            assert.strictEqual(attempts, 2, 'read failure consumed one retry');
        }
    }

    // ════════════════════════════════════════════════════════════════
    // FIX E — unknown-fill adoption-before-credit
    // ════════════════════════════════════════════════════════════════
    {
        const makeBot = () => {
            const credited: any[] = [];
            const processedFillKeys = new Set<string>();
            return {
                manager: {
                    assets: {
                        assetA: { symbol: 'XRP', id: '1.3.5537', precision: 4 },
                        assetB: { symbol: 'BTS', id: '1.3.0', precision: 5 },
                    },
                    orders: new Map([
                        ['slot-1', { id: 'slot-1', price: 0.29 }],
                        ['slot-2', { id: 'slot-2', price: 0.31 }],
                    ]),
                    logger: silentLogger(),
                },
                _recentlyQueuedFills: new Map(),
                _buildOrphanFillFallbackKey: () => null,
                _isNewFillKey: (key: any, set: any) => {
                    if (!key) return true;
                    if (set.has(key)) return false;
                    set.add(key);
                    return true;
                },
                _applyReplaySafeOrphanFillAccounting: async () => {
                    credited.push(true);
                    return { status: 'applied' };
                },
                _credited: credited,
                _processedFillKeys: processedFillKeys,
            };
        };

        const fill = { block_num: 500, id: '1.11.1', op: [4, { order_id: '1.7.575' }] };
        const fillOp = fill.op[1];
        const opts = { context: 'TEST', label: 'TEST' };

        // (a) live order, in-market, inside grid range → defer, no credit
        {
            const bot = makeBot();
            chainOrders.batchReadOrders = async () => {
                const m = new Map();
                // 30 BTS / 100 XRP → parseChainOrder price (30/100)/10 = 0.30 (inside [0.29, 0.31]×1.25)
                m.set('1.7.575', { id: '1.7.575', sell_price: { base: { amount: 3000000, asset_id: '1.3.0' }, quote: { amount: 1000000, asset_id: '1.3.5537' } } });
                return m;
            };
            const res = await processSweepOrphanFill(bot, fill, fillOp, bot._processedFillKeys, opts);
            assert.strictEqual(res, true, 'live in-range order: deferred (caller triggers adoption sync)');
            assert.strictEqual(bot._credited.length, 0, 'live in-range order: proceeds NOT credited');
            assert.strictEqual(bot._processedFillKeys.size, 0, 'dedupe key released for post-adoption reprocessing');
        }

        // (b) live order, foreign market → credit (legacy path)
        {
            const bot = makeBot();
            chainOrders.batchReadOrders = async () => {
                const m = new Map();
                m.set('1.7.575', { id: '1.7.575', sell_price: { base: { amount: 1, asset_id: '1.3.999' }, quote: { amount: 1, asset_id: '1.3.888' } } });
                return m;
            };
            const res = await processSweepOrphanFill(bot, fill, fillOp, bot._processedFillKeys, opts);
            assert.strictEqual(res, false, 'foreign-market order: credited (not deferred)');
            assert.strictEqual(bot._credited.length, 1, 'foreign-market order: credited via orphan path');
        }

        // (c) live order far outside grid price range → credit
        {
            const bot = makeBot();
            chainOrders.batchReadOrders = async () => {
                const m = new Map();
                // 300 BTS / 100 XRP → parseChainOrder price 3.0 (outside [0.29, 0.31]×1.25)
                m.set('1.7.575', { id: '1.7.575', sell_price: { base: { amount: 30000000, asset_id: '1.3.0' }, quote: { amount: 1000000, asset_id: '1.3.5537' } } });
                return m;
            };
            const res = await processSweepOrphanFill(bot, fill, fillOp, bot._processedFillKeys, opts);
            assert.strictEqual(res, false, 'far-out-of-range order: credited (not ours to adopt)');
            assert.strictEqual(bot._credited.length, 1, 'far-out-of-range order: credited via orphan path');
        }

        // (d) order gone from chain (fully filled) → credit
        {
            const bot = makeBot();
            chainOrders.batchReadOrders = async () => {
                const m = new Map();
                m.set('1.7.575', null);
                return m;
            };
            const res = await processSweepOrphanFill(bot, fill, fillOp, bot._processedFillKeys, opts);
            assert.strictEqual(res, false, 'gone order: credited');
            assert.strictEqual(bot._credited.length, 1, 'gone order: credited via orphan path');
        }

        // (e) by-id read failure → credit (safe fallback)
        {
            const bot = makeBot();
            chainOrders.batchReadOrders = async () => { throw new Error('node down'); };
            const res = await processSweepOrphanFill(bot, fill, fillOp, bot._processedFillKeys, opts);
            assert.strictEqual(res, false, 'read failure: credited (fallback)');
            assert.strictEqual(bot._credited.length, 1, 'read failure: credited via orphan path');
        }
    }

    // ════════════════════════════════════════════════════════════════
    // P0 HARDENING — broadcast watchdog window restarts per holder
    // ════════════════════════════════════════════════════════════════
    {
        const mgr: any = new OrderManager({ market: 'XRP/BTS', assetA: 'XRP', assetB: 'BTS' });
        mgr.logger = silentLogger();

        // Holder A started 110s ago; holder B joins now. The 120s stale
        // window must restart from B's increment — measuring from A's start
        // would hard-reset while B is still legitimately active.
        mgr.startBroadcasting();
        mgr._broadcastingStartedAt = Date.now() - 110000;
        mgr.startBroadcasting();
        assert.ok(mgr._broadcastingStartedAt >= Date.now() - 50, 'watchdog window restarted by the new holder (not just 0→1)');
        assert.strictEqual(mgr._broadcastingFlag, 2, 'refcount tracks both holders');
        mgr._clearStaleBroadcastFlag();
        assert.strictEqual(mgr._broadcastingFlag, 2, 'fresh holder not prematurely cleared by the watchdog');

        // A genuinely stale window still hard-resets...
        mgr._broadcastingStartedAt = Date.now() - 121000;
        mgr._clearStaleBroadcastFlag();
        assert.strictEqual(mgr._broadcastingFlag, 0, 'stale window hard-resets the flag');
        assert.strictEqual(mgr._broadcastingStartedAt, 0, 'hard-reset zeroes the timestamp');

        // ...and stopBroadcasting below zero stays guarded.
        mgr.stopBroadcasting();
        assert.strictEqual(mgr._broadcastingFlag, 0, 'stopBroadcasting on a zero flag cannot go negative');
    }

    console.log('✓ All orphan-cascade fixes (A–E) regression tests passed');
}

run().catch(err => {
    console.error('✗ Test failed');
    console.error(err);
    process.exit(1);
});
