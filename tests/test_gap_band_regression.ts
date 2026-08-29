const assert = require('assert');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');
const { OrderManager } = require('../modules/order/manager');
const SyncEngine = require('../modules/order/sync_engine').default;
const { isSlotInRail } = require('../modules/order/utils/math');
const DexbotStateRecovery = require('../modules/dexbot_state_recovery');

// ── helpers ──────────────────────────────────────────────────────────────
const SLOT_PRICES = [1.00, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.10, 1.11];

function slotGrid(boundary, gapSlots = 2, count = 12) {
    const slots = [];
    for (let i = 0; i < count; i++) {
        const sellStart = boundary + gapSlots + 1;
        let type;
        if (i <= boundary) type = ORDER_TYPES.BUY;
        else if (i >= sellStart) type = ORDER_TYPES.SELL;
        else type = ORDER_TYPES.SPREAD;
        slots.push({
            id: `slot-${i}`,
            price: SLOT_PRICES[i],
            type,
            state: type === ORDER_TYPES.SPREAD ? ORDER_STATES.VIRTUAL : ORDER_STATES.VIRTUAL,
            size: type === ORDER_TYPES.SPREAD ? 0 : 10,
            orderId: '',
        });
    }
    return slots;
}

function createPlacedManager(boundary, gapSlots = 2) {
    // targetSpread 1.0 with increment 0.5 => gapSlots 2 (matches test slotGrid gap)
    const mgr = new OrderManager({
        incrementPercent: 0.5,
        targetSpreadPercent: 1.0,
        gridLimits: { MIN_SPREAD_ORDERS: 2, FUND_INVARIANT_PERCENT_TOLERANCE: 0.1 },
        activeOrders: { buy: 3, sell: 3 },
        assetA: 'XRP', assetB: 'BTS',
    });
    mgr.assets = { assetA: { id: '1.3.1', precision: 5, symbol: 'XRP' }, assetB: { id: '1.3.0', precision: 5, symbol: 'BTS' } };
    return mgr;
}

// ── P1 Test A: same-batch cancel when boundary strands a live order ─────
async function testP1_SameBatchCancelStrands() {
    console.log('\nRunning test P1-A: boundary advance strands placed BUY -> cancel in same COW batch');
    const mgr = createPlacedManager(5, 2);
    // initialize grid at boundary 5, gap 2 => buy 0-5, gap 6-7, sell 8-11
    const grid = require('../modules/order/grid');
    await grid.loadGrid(mgr, slotGrid(5, 2), 5);
    // Place BUY at slot-5 (highest buy rail) as ACTIVE — this will be stranded when boundary crawls left to 4
    const buySlotRaw = Array.from(mgr.orders.values()).find((o: any) => o.id === 'slot-5');
    assert.ok(buySlotRaw, 'slot-5 exists');
    const buySlot: any = buySlotRaw;
    await mgr._applyOrderUpdate({ ...buySlot, state: ORDER_STATES.ACTIVE, orderId: '1.7.900', size: 10 }, 'test-place', { skipAccounting: true });
    // Also place other rail orders to satisfy active counts (include slot-2 so no hole remains to rotate stranded 5 into)
    for (const id of ['slot-4', 'slot-3', 'slot-2', 'slot-8', 'slot-9', 'slot-10']) {
        const s: any = mgr.orders.get(id);
        if (s) await mgr._applyOrderUpdate({ ...s, state: ORDER_STATES.ACTIVE, orderId: `1.7.${id}`, size: 10 }, 'test-place', { skipAccounting: true });
    }
    // verify buy at 5 is on buy rail before crawl
    assert.strictEqual(mgr.boundaryIdx, 5);
    assert.ok(isSlotInRail(5, 2, ORDER_TYPES.BUY, { id: 'slot-5' }), 'slot-5 on buy rail before crawl');

    // Mock strategy to force boundary crawl left to 4 without triggering guard rotation
    // (guard rotates only on fill price thresholds; by mocking we strand slot-5 cleanly)
    const origCalc = (mgr.strategy as any).calculateTargetGrid.bind(mgr.strategy);
    (mgr.strategy as any).calculateTargetGrid = (params: any) => {
        const res = origCalc(params);
        // force boundary 4, keep same targetGrid but ensure slot-5 is VIRTUAL (outside window)
        // Re-derive targetGrid for boundary 4 to expose the strand
        // Simplest: rebuild targetGrid for boundary 4 and let COW injection detect the gap
        const gapSlots = 2;
        const newBoundary = 4;
        // Build new targetGrid that virtualizes slot-5 (gap 5-6, sellStart 7)
        const allSlots = Array.from(mgr.orders.values()).sort((a: any, b: any) => a.price - b.price);
        const targetGrid = new Map();
        for (const s of allSlots as any[]) {
            const idx = parseInt(String(s.id).split('-')[1], 10);
            const inGap = idx > newBoundary && idx < newBoundary + gapSlots + 1;
            if (inGap && s.id === 'slot-5') {
                targetGrid.set(s.id, { ...s, state: ORDER_STATES.VIRTUAL, size: 0 });
            } else {
                // keep original res target for other slots
                const orig = res.targetGrid.get(s.id);
                if (orig) targetGrid.set(s.id, orig);
                else targetGrid.set(s.id, { ...s, state: ORDER_STATES.VIRTUAL, size: 0 });
            }
        }
        return { targetGrid, boundaryIdx: newBoundary };
    };
    const fills: any[] = [];
    const result = await mgr.performSafeRebalance(fills, new Set());
    // restore
    (mgr.strategy as any).calculateTargetGrid = origCalc;
    assert.ok(result && !result.aborted, 'rebalance produced result');
    const newBoundary = result.workingBoundary;
    console.log(`  boundary ${mgr.boundaryIdx} -> ${newBoundary}`);
    assert.strictEqual(newBoundary, 4, 'boundary should be forced to 4');
    const hasGapCancel = result.actions.some((a: any) => String(a.orderId) === '1.7.900' && (a.type === 'cancel' || a.type === 'update'));
    assert.ok(hasGapCancel, 'P1 must emit gap-band-stranding CANCEL/UPDATE for slot-5 in same COW batch (rotation or cancel)');

    // Commit and verify no placed order remains inside gap after P1 cancel
    const committed = await mgr._commitWorkingGrid(result.workingGrid, result.workingIndexes, result.workingBoundary, { result });
    assert.strictEqual(committed, true, 'commit succeeds');
    const sellStart = 7; // boundary 4 gap2 => 7
    const stranded = Array.from(mgr.orders.values()).filter((o: any) => o.orderId && (() => {
        const m = /^slot-(\d+)$/.exec(o.id);
        if (!m) return false;
        const idx = parseInt(m[1], 10);
        return idx > newBoundary && idx < sellStart;
    })());
    assert.strictEqual(stranded.length, 0, 'no placed order remains inside gap band after P1 cancel');
    console.log('  PASS: P1 same-batch cancel emitted and gap clean');
}

// ── P1 belt-and-braces: post-commit detector queues cancelOnly ──────────
async function testP1_PostCommitDetectorQueuesCancel() {
    console.log('\nRunning test P1-B: post-commit gap detector queues cancelOnly');
    const mgr = createPlacedManager(6, 2);
    const grid = require('../modules/order/grid');
    await grid.loadGrid(mgr, slotGrid(6, 2), 6);
    // Manually place an orphan inside gap band 7-8 after commit
    const gapSlotId = 'slot-7';
    const gapSlot: any = mgr.orders.get(gapSlotId);
    // Force it to be placed despite being spread zone (simulate bug)
    await mgr._applyOrderUpdate({ ...gapSlot, type: ORDER_TYPES.SELL, state: ORDER_STATES.ACTIVE, orderId: '1.7.777', size: 10 }, 'test-orphan', { skipAccounting: true });
    mgr.ordersNeedingPriceCorrection = [];
    mgr._recoveryState = { ...mgr._recoveryState, structuralResyncRequested: false };
    mgr._assertGapBandIntactPostCommit();
    assert.ok(mgr._recoveryState.structuralResyncRequested, 'detector still flags resync');
    const queued = mgr.ordersNeedingPriceCorrection.find((q: any) => q.chainOrderId === '1.7.777' && q.cancelOnly === true);
    assert.ok(queued, 'detector must queue cancelOnly for stranded order');
    assert.strictEqual(queued.reason, 'gap-band-stranding-post-commit');
    console.log('  PASS: post-commit detector queues cancelOnly');
}

// ── P2: sync_engine gap-band orphan sweep ───────────────────────────────
async function testP2_SyncEngineGapSweep() {
    console.log('\nRunning test P2-A: sync_engine sweeps gap-band orphan -> cancelOnly');
    const mgr = createPlacedManager(5, 2);
    const grid = require('../modules/order/grid');
    await grid.loadGrid(mgr, slotGrid(5, 2), 5);
    // Place some rails so gap is 6-7, sellStart 8
    // Seller orphan at price exactly slot-6 gap price (1.06) with no duplicate rail
    const sync = new SyncEngine(mgr);
    mgr.ordersNeedingPriceCorrection = [];
    // No duplicate price level: ensure no active sell at gap price
    const chainOrders = [
        // orphan sell inside gap band at 1.06 (slot-6 price)
        {
            id: '1.7.600',
            sell_price: { base: { amount: 1000000, asset_id: '1.3.1' }, quote: { amount: Math.round(1.06 * 1000000), asset_id: '1.3.0' } },
            for_sale: 1000000,
        },
    ];
    const result = await sync.syncFromOpenOrders(chainOrders, { skipAccounting: true });
    const gapQueued = mgr.ordersNeedingPriceCorrection.find((q: any) => q.chainOrderId === '1.7.600' && q.cancelOnly === true);
    assert.ok(gapQueued, 'gap-band orphan must be queued cancelOnly via sync_engine');
    const gapUnmatched = result.unmatchedChainOrders.find((u: any) => u.chainOrderId === '1.7.600' && u.reason === 'gap-band-orphan');
    assert.ok(gapUnmatched, 'unmatched reason must be gap-band-orphan');
    console.log('  PASS: sync_engine gap sweep queued cancel');
}

// ── P2: grid_reconcile gap sweep ────────────────────────────────────────
async function testP2_GridReconcileGapSweep() {
    console.log('\nRunning test P2-B: grid_reconcile sweep — smoke (P3 re-derives, orphan adopted)');
    const mgr = createPlacedManager(5, 2);
    const grid = require('../modules/order/grid');
    await grid.loadGrid(mgr, slotGrid(5, 2), 5);
    mgr.ordersNeedingPriceCorrection = [];
    const { reconcileGridOrders } = require('../modules/order/grid_reconcile');
    // Single chain order inside gap at 1.06 (slot-6). With boundary 5 the P3
    // evidence gate sees LIVE_SELL_BELOW_SELL_START and re-derives boundary
    // 5→3, so the orphan lands on the corrected sell rail and is legitimately
    // adopted. This path is smoke-only: it asserts no crash and no stray
    // gap-band-stranding, while the cancelOnly sweep is covered by P2-B-tight
    // (anchor-contradiction) and P2-A (sync-engine).
    const chainOpenOrders = [
        {
            id: '1.7.601',
            sell_price: { base: { amount: 1000000, asset_id: '1.3.1' }, quote: { amount: Math.round(1.06 * 1000000), asset_id: '1.3.0' } },
            for_sale: 1000000,
        },
    ];
    const chainOrdersStub: any = {
        cancelOrder: async () => { throw new Error('should not cancel — orphan adopted after P3 re-derivation'); },
        createOrder: async () => [],
        readOpenOrders: async () => chainOpenOrders,
        buildUpdateOrderOp: async () => ({ op: { op_name: 'x', op_data: {} } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        updateOrder: async () => {},
        wasRecentlyOwnCancelled: () => false,
    };
    await reconcileGridOrders({
        manager: mgr,
        config: { activeOrders: { buy: 2, sell: 2 } },
        account: '1.2.999',
        privateKey: '5K...',
        chainOrders: chainOrdersStub,
        chainOpenOrders,
    });
    // After P3 re-derivation, boundary must be 3 and no GAP-ORPHAN cancel queued
    assert.strictEqual(mgr.boundaryIdx, 3, 'P3 should re-derive boundary 5→3 for single gap orphan');
    console.log('  PASS: grid_reconcile P3 re-derivation consumed gap orphan without spurious cancel');
}

async function testP2_GridReconcileGapSweepAnchorContradiction() {
    console.log('\nRunning test P2-B-tight: grid_reconcile sweep fires when P3 defers (anchor contradicts)');
    const mgr = createPlacedManager(5, 2);
    const grid = require('../modules/order/grid');
    await grid.loadGrid(mgr, slotGrid(5, 2), 5);
    mgr.ordersNeedingPriceCorrection = [];
    // Anchor that projects far from feasible window so P3 defers (ANCHOR_CONTRADICTS_CORRECTION).
    // allSlots 0..11, gap 2, orphan SELL at 1.06 (idx 6) => feasible [0,3]. Anchor projecting
    // to 9 (maxSell+minBuy at 1.11) drifts 6 slots > maxAnchorDrift 3 => P3 suggestedBoundary null,
    // placements deferred, gap 6-7 retained, sweep must cancel orphan.
    (mgr as any)._marketAnchor = {
        maxFilledSellPrice: 1.11,
        minFilledBuyPrice: 1.11,
        lastFillPrice: 1.11,
        lastFillSide: 'sell',
        updatedAt: Date.now(),
        _seenKeys: new Set(),
    };
    const { reconcileGridOrders } = require('../modules/order/grid_reconcile');
    const chainOpenOrders = [
        {
            id: '1.7.602',
            sell_price: { base: { amount: 1000000, asset_id: '1.3.1' }, quote: { amount: Math.round(1.06 * 1000000), asset_id: '1.3.0' } },
            for_sale: 1000000,
        },
    ];
    const cancelled: string[] = [];
    const chainOrdersStub: any = {
        cancelOrder: async (_acc: any, _key: any, orderId: any) => { cancelled.push(String(orderId)); },
        createOrder: async () => [],
        readOpenOrders: async () => chainOpenOrders,
        buildUpdateOrderOp: async () => ({ op: { op_name: 'x', op_data: {} } }),
        executeBatch: async () => ({ success: true, operation_results: [] }),
        updateOrder: async () => {},
        wasRecentlyOwnCancelled: () => false,
    };
    await reconcileGridOrders({
        manager: mgr,
        config: { activeOrders: { buy: 2, sell: 2 } },
        account: '1.2.999',
        privateKey: '5K...',
        chainOrders: chainOrdersStub,
        chainOpenOrders,
    });
    // Boundary must stay 5 (P3 deferred), and gap orphan must have been cancelled
    assert.strictEqual(mgr.boundaryIdx, 5, 'P3 deferred via anchor contradiction should keep boundary 5');
    assert.ok(cancelled.includes('1.7.602'), 'P2 reconcile sweep must cancel gap orphan 1.7.602 when P3 defers');
    console.log('  PASS: grid_reconcile gap sweep cancelled orphan when P3 deferred');
}

// ── P4: snapshot-reject discards boundary ───────────────────────────────
async function testP4_RejectDiscardsBoundary() {
    console.log('\nRunning test P4: snapshot-reject discards boundary');
    const fakeBot: any = {
        accountOrders: {
            clearGrid: async () => { fakeBot.cleared = true; },
        },
        manager: {
            checkFundDriftAfterFills: () => ({ isValid: false, driftSell: 10, driftBuy: 2036 }),
            boundaryIdx: 131,
            _restoreBoundary: (v: any) => { fakeBot.manager.boundaryIdx = v; },
            logger: { log: () => {} },
        },
        _warn: () => {},
        cleared: false,
    };
    const rejected = await DexbotStateRecovery.rejectCorruptedGridSnapshot(fakeBot, 'recovery');
    assert.strictEqual(rejected, true, 'reject must return true on drift');
    assert.strictEqual(fakeBot.cleared, true, 'clearGrid called');
    assert.strictEqual(fakeBot.manager.boundaryIdx, null, 'in-memory boundary must be cleared to null after reject (P4)');
    console.log('  PASS: boundary discarded together with snapshot');
    // Also check AccountOrders.clearGrid wipes boundaryIdx
    const { AccountOrders } = require('../modules/account_orders');
    const tmp = require('node:os').tmpdir();
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(tmp, 'dexbot-test-'));
    const ao = new AccountOrders({ botKey: 'p4test', ordersDir: dir });
    await ao.storeMasterGrid([{ id: 'slot-0', type: 'buy', state: 'virtual', price: 1, size: 0, orderId: '' }], 0, 77, null, null, null);
    assert.strictEqual(ao.loadBoundaryIdx(), 77, 'boundary persisted');
    await ao.clearGrid();
    assert.strictEqual(ao.loadBoundaryIdx(), null, 'clearGrid must wipe persisted boundaryIdx (P4 file-level)');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  PASS: persisted boundaryIdx wiped on clearGrid');
}

// ── P5: structural resync skip/defer logging and max-defer force ────────
async function testP5_StructuralResyncLoggingAndForce() {
    console.log('\nRunning test P5: structural resync logging + max-defer force');
    const { wireStructuralGridResyncRequest } = require('../modules/dexbot_maintenance_runtime');
    const bot: any = {
        manager: {},
        _shuttingDown: false,
        _batchInFlight: 0,
        _recoverySyncInFlight: 0,
        _structuralGridResyncRunning: 0,
        _structuralGridResyncTimer: null,
        _warn: (msg: string) => { bot.warns.push(msg); },
        managerLogger: [],
        _recoverFromPersistedGrid: async () => ({ success: false }),
        requestGridReset: async () => true,
    };
    bot.manager._recoveryState = { structuralResyncRequested: false };
    bot.manager.requestStructuralGridResync = undefined;
    bot.warns = [];
    wireStructuralGridResyncRequest(bot);
    assert.ok(typeof bot.manager.requestStructuralGridResync === 'function', 'wired');

    const r1 = await bot.manager.requestStructuralGridResync('first', {});
    assert.ok(r1.scheduled, 'first schedules');
    // second while timer pending must log skip
    bot.warns = [];
    const r2 = await bot.manager.requestStructuralGridResync('second', {});
    assert.ok(r2.skipped, 'second skipped');
    assert.ok(bot.warns.some((m: string) => m.includes('already scheduled') || m.includes('already running')), 'skip must be logged');

    // Now test max-defer force: set batchInFlight and let timer fire
    // Fast-forward by faking deferStartedAt far in past so next run forces
    bot._batchInFlight = 1;
    bot._structuralGridResyncDeferStartedAt = Date.now() - 40000; // 40s ago, cap 30s
    bot.warns = [];
    // The pending timer from r1 is still set to runStructuralResync in 0ms; wait a tick
    await new Promise(res => setTimeout(res, 50));
    // After max-defer, it should have logged forcing and attempted recovery despite batchInFlight
    assert.ok(bot.warns.some((m: string) => m.includes('max-defer') && m.includes('forcing')), 'max-defer must force and log');
    // cleanup timer
    if (bot._structuralGridResyncTimer) clearTimeout(bot._structuralGridResyncTimer);
    console.log('  PASS: skip/defer logging and max-defer force work');
}

async function runAll() {
    await testP1_SameBatchCancelStrands();
    await testP1_PostCommitDetectorQueuesCancel();
    await testP2_SyncEngineGapSweep();
    await testP2_GridReconcileGapSweep();
    await testP2_GridReconcileGapSweepAnchorContradiction();
    await testP4_RejectDiscardsBoundary();
    await testP5_StructuralResyncLoggingAndForce();
    console.log('\nAll gap-band P1-P5 regression tests passed');
}

runAll().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
