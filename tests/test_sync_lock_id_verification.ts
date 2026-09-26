/**
 * tests/test_sync_lock_id_verification.ts
 *
 * Regression test for the sync lock-id re-verification false positive.
 *
 * `_doSyncFromOpenOrders` collects slot ids AND chain order ids into
 * `orderIdsToLock`. It then re-verified each id with `mgr.orders.has(id)`.
 * `mgr.orders` is keyed by SLOT id; chain order ids live in the VALUES
 * (`gridOrder.orderId`). So every placed order's chain id failed the check and
 * was logged as "disappeared between collection and locking; skipping" — ~40
 * false lines per sync (3461 over one production log), which was mistaken for
 * a COW race during a fill-storm investigation.
 *
 * Fix: the re-verification was removed (collection and locking are synchronous,
 * so it was dead code), and the full collected set is locked. Both slot ids
 * and chain ids reach lockOrders.
 *
 *  1. Placed orders log NO "disappeared between collection and locking".
 *  2. The lock set passed to lockOrders contains BOTH the slot id and the
 *     chain order id of every placed order.
 *  3. A slot id with no live chain order still locks only its own key.
 */
const assert = require('assert');
const SyncEngine = require('../modules/order/sync_engine').default;
const AsyncLock = require('../modules/order/async_lock').default;
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const ASSETS = {
    assetA: { id: '1.3.111', precision: 4, symbol: 'BASE' },
    assetB: { id: '1.3.222', precision: 5, symbol: 'QUOTE' },
};

// Build a chain order whose parsed price/size round-trip exactly, so the sync
// detects no mismatch and only the lock-id path is exercised.
function makeChainOrder(id, type, price, size) {
    const isSell = type === ORDER_TYPES.SELL;
    const baseAssetId = isSell ? ASSETS.assetA.id : ASSETS.assetB.id;
    const quoteAssetId = isSell ? ASSETS.assetB.id : ASSETS.assetA.id;
    const basePrecision = isSell ? ASSETS.assetA.precision : ASSETS.assetB.precision;
    const quotePrecision = isSell ? ASSETS.assetB.precision : ASSETS.assetA.precision;
    const forSaleInt = Math.round(size * Math.pow(10, basePrecision));
    const quoteInt = Math.round(size * price * Math.pow(10, quotePrecision));
    return {
        id,
        sell_price: {
            base: { amount: String(forSaleInt), asset_id: baseAssetId },
            quote: { amount: String(quoteInt), asset_id: quoteAssetId },
        },
        for_sale: String(forSaleInt),
    };
}

function liveBuy(id, orderId, price, size) {
    return { id, orderId, type: ORDER_TYPES.BUY, price, size, state: ORDER_STATES.ACTIVE };
}

function makeSyncMgr(ordersList: any[], extra: any = {}) {
    const orders = new Map(ordersList.map((o) => [o.id, { ...o }]));
    const logs = [];
    const locked = [];
    return {
        orders,
        assets: ASSETS,
        config: { startPrice: 1100 },
        logger: { log: (msg, level) => logs.push(`[${level}] ${msg}`) },
        _logEntries: logs,
        _lockedIds: locked,
        _syncLock: new AsyncLock(),
        _fillProcessingLock: new AsyncLock(),
        _gridLock: new AsyncLock(),
        ordersNeedingPriceCorrection: [],
        accountTotalsStale: false,
        pauseFundRecalc: () => {},
        resumeFundRecalc: async () => {},
        lockOrders: (ids: any) => { locked.push([...ids]); },
        unlockOrders: () => {},
        shadowOrderIds: new Map(),
        _applyOrderUpdate: async (order: any) => {
            orders.set(order.id, { ...(orders.get(order.id) || {}), ...order });
            return orders.get(order.id);
        },
        ...extra,
    };
}

async function run() {
    console.log('Running sync lock-id verification tests...');
    const engine = new SyncEngine({ orders: new Map() });

    // ---- 1+2. Placed orders: no false "disappeared" log; both ids locked ----
    {
        const mgr = makeSyncMgr([
            liveBuy('slot-168', '1.7.574492682', 1105.646270, 5298.91383),
            liveBuy('slot-169', '1.7.574492521', 1110.123456, 5100.00000),
        ]);
        (engine as any).manager = mgr;
        const chain = [
            makeChainOrder('1.7.574492682', ORDER_TYPES.BUY, 1105.646270, 5298.91383),
            makeChainOrder('1.7.574492521', ORDER_TYPES.BUY, 1110.123456, 5100.00000),
        ];
        const res = await (engine as any).syncFromOpenOrders(chain);

        assert.strictEqual(res.unmatchedChainOrders.length, 0,
            'all chain orders must match their slots');
        assert(!mgr._logEntries.some((l) => String(l).includes('disappeared between collection')),
            'placed orders must not log "disappeared between collection and locking"');

        const lockedIds = mgr._lockedIds.flat();
        for (const id of ['slot-168', '1.7.574492682', 'slot-169', '1.7.574492521']) {
            assert(lockedIds.includes(id), `lock set must contain ${id}`);
        }
        console.log('  - placed orders lock both slot and chain ids without false "disappeared" logs');
    }

    // ---- 3. Slot without a chain order locks only its own key ----
    {
        const mgr = makeSyncMgr([
            { id: 'slot-5', type: ORDER_TYPES.SPREAD, state: ORDER_STATES.ACTIVE, price: 900, size: 0 },
        ]);
        (engine as any).manager = mgr;
        const res = await (engine as any).syncFromOpenOrders([]);
        void res;
        assert(!mgr._logEntries.some((l) => String(l).includes('disappeared between collection')),
            'virtual slot must not log "disappeared"');
        const lockedIds = mgr._lockedIds.flat();
        assert(lockedIds.includes('slot-5'), 'active slot must be locked by its own id');
        console.log('  - chainless active slot locks only its slot id');
    }

    console.log('PASS test_sync_lock_id_verification');
}

run().catch((err) => {
    console.error('Test failed');
    console.error(err);
    process.exit(1);
});
