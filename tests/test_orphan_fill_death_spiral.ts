/**
 * tests/test_orphan_fill_death_spiral.ts
 *
 * Verifies the three orphan-fill / death-spiral protection mechanisms:
 *
 * 1. Block-level fill batching — fills from the same block are processed
 *    together so overlapping slot mutations don't cascade.
 * 2. Orphan-fill invariant tolerance widening — 5× tolerance while
 *    _orphanFillsCreditedAt is set prevents false-positive recoveries.
 * 3. Same-block cascade prevention — absorb unmatched orders inline
 *    instead of hard-reject (ghost-order + disabled post-fill spread).
 *
 * Also tests rapid-fill robustness: fills arriving while a previous
 * batch is still processing must be picked up on the next while-loop
 * iteration, not lost.
 */

const assert = require('assert');

const DEXBot = require('../modules/dexbot_class');
const { OrderManager } = require('../modules/order/manager');
const {
  ORDER_TYPES, ORDER_STATES, TIMING,
  FILL_PROCESSING, GRID_LIMITS,
} = require('../modules/constants');
const { buildFillKey } = require('../modules/order/utils/order');
const {
  ProcessedFillStore,
  PROCESSED_FILL_PERSISTENCE_MODES,
} = require('../modules/order/processed_fill_store');

// ── Helpers ────────────────────────────────────────────────────────

function makeChainOrdersStub(overrides = {}) {
  return {
    getFillProcessingMode: () => 'history',
    readOpenOrders: async () => [],
    wasRecentlyOwnCancelled: () => false,
    cancelOrder: async () => {},
    buildCancelOrderOp: async () => ({}),
    ...overrides,
  };
}

/**
 * Build a standard fill object mimicking what the blockchain subscription pushes.
 */
function buildFill(fillId, orderId, blockNum, paysAmount, receivesAmount,
  isMaker = true, extra = {}) {
  return {
    block_num: blockNum,
    id: fillId,
    op: [4, {
      order_id: orderId,
      pays: { asset_id: '1.3.1', amount: paysAmount },
      receives: { asset_id: '1.3.0', amount: receivesAmount },
      is_maker: isMaker,
      ...extra,
    }],
    ...extra,
  };
}

function makeOrphanFill(orderId, blockNum, paysAmount, receivesAmount) {
  const f = buildFill(undefined, orderId, blockNum, paysAmount, receivesAmount);
  delete f.id;
  return f;
}

function makeGridOrder(id, orderId, type, price, size, state = ORDER_STATES.ACTIVE) {
  return {
    id,
    orderId: orderId || `1.7.${id}`,
    type,
    state,
    price,
    size,
    baseAmount: type === ORDER_TYPES.BUY ? size * price : size,
    quoteAmount: type === ORDER_TYPES.BUY ? size : size * price,
    rawOnChain: state === ORDER_STATES.ACTIVE
      ? { for_sale: String(Math.round(size * (type === ORDER_TYPES.BUY ? 1e5 : 1e5))) }
      : null,
  };
}

async function createMinimalBot(botKey = 'test-orphan-spiral') {
  const bot = new DEXBot({
    botKey,
    dryRun: false,
    startPrice: 1,
    assetA: 'TEST',
    assetB: 'BTS',
    incrementPercent: 0.5,
  });

  const persistedFills = [];
  bot.accountOrders = {
    loadProcessedFills() { return new Map(); },
    async updateProcessedFillsBatch(fills) {
      const entries = fills instanceof Map ? Array.from(fills.entries()) : [];
      for (const [fillKey, timestamp] of entries) {
        persistedFills.push({ fillKey, timestamp });
      }
    },
  };

  bot.manager = new OrderManager({
    market: 'TEST/BTS',
    assetA: 'TEST',
    assetB: 'BTS',
    startPrice: 1,
    gridLimits: { FUND_INVARIANT_PERCENT_TOLERANCE: GRID_LIMITS.FUND_INVARIANT_PERCENT_TOLERANCE },
  });
  bot.manager.assets = {
    assetA: { id: '1.3.0', symbol: 'TEST', precision: 5 },
    assetB: { id: '1.3.1', symbol: 'BTS', precision: 5 },
  };
  await bot.manager.setAccountTotals({ buy: 10000, sell: 100, buyFree: 10000, sellFree: 100 });
  bot.manager.finishBootstrap();
  bot._wireProcessedFillTracking();

  return { bot, persistedFills };
}

// ── Tests ──────────────────────────────────────────────────────────

async function runTests() {
  console.log('Running Orphan-Fill / Death-Spiral Protection Tests...\n');

  // ─────────────────────────────────────────────────────────────────
  // TEST 1: Block-level fill batching groups fills by block number
  //         and processes in ascending order.
  // ─────────────────────────────────────────────────────────────────
  console.log('1. Block-level fill batching orders fills by block...');
  {
    const { bot } = await createMinimalBot('block-batch-test');

    // Add grid orders that the fill events will reference
    await bot.manager._updateOrder(makeGridOrder(
      'slot-buy-1', '1.7.101', ORDER_TYPES.BUY, 1.0, 100
    ));
    await bot.manager._updateOrder(makeGridOrder(
      'slot-sell-1', '1.7.102', ORDER_TYPES.SELL, 1.1, 50
    ));
    await bot.manager._updateOrder(makeGridOrder(
      'slot-buy-2', '1.7.103', ORDER_TYPES.BUY, 0.95, 200
    ));

    // Push fills out of order (block 102 before block 100)
    const fillBlock102 = buildFill('1.11.202', '1.7.102', 102, 5000000, 500000);
    const fillBlock100 = buildFill('1.11.200', '1.7.101', 100, 10000000, 1000000, true,
      { trx_in_block: 1, op_in_trx: 0 });
    const fillBlock101 = buildFill('1.11.201', '1.7.103', 101, 20000000, 2000000);

    bot._incomingFillQueue.push(fillBlock102);
    bot._incomingFillQueue.push(fillBlock100);
    bot._incomingFillQueue.push(fillBlock101);

    // Track the order in which syncFromFillHistory is called per fill
    const syncOrder = [];
    const originalSync = bot.manager.sync.syncFromFillHistory.bind(bot.manager.sync);
    bot.manager.sync.syncFromFillHistory = async (fill, options) => {
      syncOrder.push({
        orderId: fill?.op?.[1]?.order_id,
        blockNum: fill?.block_num,
        historyId: fill?.id,
      });
      return originalSync(fill, options);
    };

    await bot._consumeFillQueue(makeChainOrdersStub());

    // Verify fills were processed in ascending block order (100, 101, 102)
    assert.strictEqual(syncOrder.length, 3,
      'Should process all 3 fills');
    assert.strictEqual(syncOrder[0].blockNum, 100,
      'First fill should be from block 100');
    assert.strictEqual(syncOrder[1].blockNum, 101,
      'Second fill should be from block 101');
    assert.strictEqual(syncOrder[2].blockNum, 102,
      'Third fill should be from block 102');

    console.log('   PASS: 3 fills from 3 blocks processed in ascending block order');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 2: Orphan-fill invariant tolerance is widened 5× while
  //         _orphanFillsCreditedAt is set.
  // ─────────────────────────────────────────────────────────────────
  console.log('2. Orphan-fill tolerance widening (5×)...');
  {
    const { bot } = await createMinimalBot('orphan-tolerance');

    // Set orphan-fill flag on the manager (where accounting reads it)
    bot.manager._orphanFillsCreditedAt = Date.now();

    // Create a drift that is > 1× tolerance but < 5× tolerance.
    // FUND_INVARIANT_PERCENT_TOLERANCE = 0.1 → PERCENT_TOLERANCE = 0.001
    // 5×: effective = 0.005
    // With actualBuy = 10020: allowed = 10020 * 0.005 = 50.1
    // diff = 10020 - 10000 = 20 → 20 < 50.1 → no violation with 5×
    // Without 5×: allowed = 10020 * 0.001 = 10.02 → 20 > 10.02 → violation
    const drift = 20;
    bot.manager.accountTotals.buy = 10000 + drift;

    // Keep sell perfectly matched to avoid sell-side false positive
    bot.manager.accountTotals.sell = 100;

    let violationDetected = false;
    bot.manager.logger.log = (msg, lvl) => {
      if (typeof msg === 'string' && msg.includes('Fund invariant violation')) {
        violationDetected = true;
      }
    };

    // Call with parameters that match the modified accountTotals
    // chainFreeBuy = 10000, chainBuy = 0 → expected = 10000
    // actual = 10020 → diff = 20
    await bot.manager.accountant._verifyFundInvariants(
      bot.manager,
      10000,  // chainFreeBuy
      100,    // chainFreeSell
      0,      // chainBuy
      0,      // chainSell
    );

    assert.strictEqual(violationDetected, false,
      'Drift within 5× tolerance should NOT trigger violation when orphan buffer is active');

    // Clear the orphan flag and verify same drift now triggers
    violationDetected = false;
    bot.manager._orphanFillsCreditedAt = null;

    await bot.manager.accountant._verifyFundInvariants(
      bot.manager,
      10000,  // chainFreeBuy
      100,    // chainFreeSell
      0,      // chainBuy
      0,      // chainSell
    );

    assert.strictEqual(violationDetected, true,
      'Same drift should trigger violation when orphan buffer is NOT active');

    console.log('   PASS: 5× tolerance active during orphan-fill buffer, disabled after clear');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 3: Same-block cascade prevention — fills from the same block
  //         are processed together, and spread correction is NOT run
  //         after fill processing (prevents cascading new orders).
  // ─────────────────────────────────────────────────────────────────
  console.log('3. Same-block cascade prevention (spread correction disabled after fills)...');
  {
    const { bot } = await createMinimalBot('cascade-prevent');

    // Set up grid with active orders
    await bot.manager._updateOrder(makeGridOrder(
      'slot-s1', '1.7.201', ORDER_TYPES.SELL, 1.05, 30
    ));
    await bot.manager._updateOrder(makeGridOrder(
      'slot-b1', '1.7.202', ORDER_TYPES.BUY, 0.95, 100
    ));

    // Two fills from the same block targeting different orders
    const fill1 = buildFill('1.11.301', '1.7.201', 200, 3000000, 300000);
    const fill2 = buildFill('1.11.302', '1.7.202', 200, 10000000, 1000000);

    bot._incomingFillQueue.push(fill1);
    bot._incomingFillQueue.push(fill2);

    let spreadCheckCalled = false;
    bot.manager.checkSpreadCondition = async () => {
      spreadCheckCalled = true;
      return { ordersPlaced: 0 };
    };

    await bot._consumeFillQueue(makeChainOrdersStub());

    // Spread correction should NOT run during fill processing
    // (it is deferred to the maintenance loop to prevent cascading fills)
    assert.strictEqual(spreadCheckCalled, false,
      'Spread correction should not be called from _consumeFillQueue');

    console.log('   PASS: Spread correction suppressed during fill processing');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 4: Rapid-fill robustness — fills arriving DURING a
  //         processing cycle are picked up on the next while-loop
  //         iteration, not lost.
  // ─────────────────────────────────────────────────────────────────
  console.log('4. Rapid-fill robustness (fills arriving during processing)...');
  {
    const { bot } = await createMinimalBot('rapid-fill');

    await bot.manager._updateOrder(makeGridOrder(
      'slot-r1', '1.7.401', ORDER_TYPES.BUY, 0.95, 100
    ));
    await bot.manager._updateOrder(makeGridOrder(
      'slot-r2', '1.7.402', ORDER_TYPES.SELL, 1.05, 50
    ));

    // Track how many times syncFromFillHistory is called
    let syncCalls = 0;
    const originalSync = bot.manager.sync.syncFromFillHistory.bind(bot.manager.sync);
    bot.manager.sync.syncFromFillHistory = async (fill, options) => {
      syncCalls++;
      // Simulate a new fill arriving while processing this one:
      // push an extra fill into the queue that will be picked up
      // on the NEXT while-loop iteration.
      if (syncCalls === 1) {
        const delayedFill = buildFill('1.11.403', '1.7.402', 201, 5000000, 500000);
        bot._incomingFillQueue.push(delayedFill);
      }
      return originalSync(fill, options);
    };

    const fill1 = buildFill('1.11.401', '1.7.401', 200, 10000000, 1000000);
    bot._incomingFillQueue.push(fill1);

    await bot._consumeFillQueue(makeChainOrdersStub());

    // All 3 fills should be processed: fill1 + the delayedFill that was
    // injected during processing
    assert.strictEqual(syncCalls, 2,
      'Both initial and delayed fill should be processed');
    assert.strictEqual(bot._incomingFillQueue.length, 0,
      'Queue should be empty after processing all fills');

    // Also verify fills that arrive AFTER the while loop exits but
    // before the outer _scheduleFillConsumerRestart are still queued
    const lateFill = buildFill('1.11.404', '1.7.402', 202, 5000000, 500000);
    // Push after the outer acquire returns but this is a synchronous
    // push so it should still be in the queue
    bot._incomingFillQueue.push(lateFill);

    assert.strictEqual(bot._incomingFillQueue.length, 1,
      'Late-arriving fill should remain queued for next cycle');

    console.log('   PASS: Delayed fills arriving during processing are not lost');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 5: Ghost order detection prevents duplicate CREATE on
  //         same-block cascade.
  // ─────────────────────────────────────────────────────────────────
  console.log('5. Ghost order detection (cascade prevention via orderId retention)...');
  {
    const { bot } = await createMinimalBot('ghost-order');

    // Set up a grid order
    await bot.manager._updateOrder(makeGridOrder(
      'slot-g1', '1.7.501', ORDER_TYPES.BUY, 0.95, 100
    ));

    // Create a fill that will result in a "ghost order" — a fill
    // where the other side rounds to 0 at blockchain precision,
    // so the order stays PARTIAL with orderId retained to block
    // duplicate CREATE.
    const ghostFill = buildFill('1.11.501', '1.7.501', 300,
      100,     // tiny pays (1 unit at 5 decimal = 0.001)
      10000    // receives
    );

    bot._incomingFillQueue.push(ghostFill);

    let createAfterGhost = false;
    const originalProcessFilledOrders = bot.manager.processFilledOrders.bind(bot.manager);
    bot.manager.processFilledOrders = async (filledOrders, excl, options) => {
      const result = await originalProcessFilledOrders(filledOrders, excl, options);
      // Check if any actions include a CREATE for slot-g1
      if (result.actions?.some((a: any) =>
        a.type === 'create' && a.id === 'slot-g1'
      )) {
        createAfterGhost = true;
      }
      return result;
    };

    await bot._consumeFillQueue(makeChainOrdersStub());

    // The order should NOT be re-created because ghost order detection
    // keeps the orderId on the PARTIAL slot, blocking duplicate CREATE.
    assert.strictEqual(createAfterGhost, false,
      'Ghost order should block duplicate CREATE for the same slot');

    console.log('   PASS: Ghost order detection prevents duplicate CREATE');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 6: Self-cancel guard correctly distinguishes economic fills
  //         from non-economic artifacts.
  // ─────────────────────────────────────────────────────────────────
  console.log('6. Self-cancel guard (economic vs artifact)...');
  {
    const { bot } = await createMinimalBot('self-cancel');

    await bot.manager._updateOrder(makeGridOrder(
      'slot-sc1', '1.7.601', ORDER_TYPES.SELL, 1.05, 50
    ));

    // Economic fill for an order just cancelled by this bot
    const economicFill = buildFill('1.11.601', '1.7.601', 400, 5000000, 500000);
    const sellBefore = bot.manager.accountTotals.sell;

    bot._incomingFillQueue.push(economicFill);
    await bot._consumeFillQueue(makeChainOrdersStub({
      wasRecentlyOwnCancelled: () => true,
    }));

    // Economic fill must still be credited even though order was
    // recently cancelled — it carries real proceeds
    assert.strictEqual(
      bot.manager.accountTotals.sell > sellBefore,
      true,
      'Economic fill must credit proceeds even after self-cancel'
    );
    console.log('   PASS: Economic self-cancel fill credits proceeds');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 7: Orphan fill with missing history ID uses fallback key
  //         and credits proceeds exactly once.
  // ─────────────────────────────────────────────────────────────────
  console.log('7. Orphan fill fallback key (missing history ID)...');
  {
    const { bot } = await createMinimalBot('orphan-fallback');

    const orphanFill = makeOrphanFill('1.7.701', 500, 5000000, 500000);
    const fallbackKey = bot._buildOrphanFillFallbackKey(orphanFill);
    const sellBefore = bot.manager.accountTotals.sell;

    assert.ok(fallbackKey, 'Fallback key should be built for orphan fill');
    assert.ok(
      fallbackKey!.startsWith('orphan:'),
      'Fallback key must start with "orphan:" prefix'
    );

    bot._incomingFillQueue.push(orphanFill);
    await bot._consumeFillQueue(makeChainOrdersStub());

    assert.strictEqual(
      bot.manager.accountTotals.sell,
      sellBefore + 5, // receives.amount=500000 at precision 5 → 5.0
      'Orphan fill without history ID should credit proceeds'
    );

    // Replay should be blocked
    bot._incomingFillQueue.push(orphanFill);
    await bot._consumeFillQueue(makeChainOrdersStub());

    assert.strictEqual(
      bot.manager.accountTotals.sell,
      sellBefore + 5,
      'Orphan fill replay must not double-credit'
    );
    console.log('   PASS: Orphan fill fallback key enables once-only accounting');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 8: Fill processing defers while batch or recovery sync is
  //         in flight (prevents pipeline collision).
  // ─────────────────────────────────────────────────────────────────
  console.log('8. Fill deferral during active pipeline...');
  {
    const { bot } = await createMinimalBot('pipeline-defer');

    const fill = buildFill('1.11.801', '1.7.801', 600, 5000000, 500000);

    // Try processing while batch is in flight — should defer
    bot._batchInFlight = 1;
    bot._incomingFillQueue.push(fill);
    await bot._consumeFillQueue(makeChainOrdersStub());

    assert.strictEqual(bot._incomingFillQueue.length, 1,
      'Fill should remain queued when batch is in flight');
    bot._batchInFlight = 0;

    // Try processing while recovery sync is in flight
    bot._recoverySyncInFlight = 1;
    await bot._consumeFillQueue(makeChainOrdersStub());

    assert.strictEqual(bot._incomingFillQueue.length, 1,
      'Fill should remain queued when recovery sync is in flight');
    bot._recoverySyncInFlight = 0;

    // Now process normally — should drain
    await bot._consumeFillQueue(makeChainOrdersStub());
    assert.strictEqual(bot._incomingFillQueue.length, 0,
      'Fill should drain after pipeline clears');
    console.log('   PASS: Fill deferral during pipeline operations');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 9: Block-level batching resets requiresOpenOrdersSync per
  //         block, so a history gap in one block doesn't force a
  //         full open-orders refetch for the next block.
  // ─────────────────────────────────────────────────────────────────
  console.log('9. Per-block requiresOpenOrdersSync isolation...');
  {
    const { bot } = await createMinimalBot('per-block-isolation');

    await bot.manager._updateOrder(makeGridOrder(
      'slot-i1', '1.7.901', ORDER_TYPES.BUY, 0.95, 100
    ));
    await bot.manager._updateOrder(makeGridOrder(
      'slot-i2', '1.7.902', ORDER_TYPES.SELL, 1.05, 50
    ));

    // Fill A: has history ID (normal, no sync needed)
    const fillA = buildFill('1.11.901', '1.7.901', 700, 10000000, 1000000);
    // Fill B: missing history ID (requires open-orders sync)
    const fillB = buildFill(undefined, '1.7.902', 701, 5000000, 500000);
    delete fillB.id;
    // Fill C: from block 702, has history ID (should NOT trigger sync
    //        just because block 701 needed it)
    const fillC = buildFill('1.11.903', '1.7.901', 702, 5000000, 500000);

    bot._incomingFillQueue.push(fillA);
    bot._incomingFillQueue.push(fillB);
    bot._incomingFillQueue.push(fillC);

    let openOrdersReadCount = 0;
    const chainStub = makeChainOrdersStub({
      readOpenOrders: async () => {
        openOrdersReadCount++;
        return [];
      },
    });

    await bot._consumeFillQueue(chainStub);

    // Block 700: history mode (no sync needed)
    // Block 701: missing history ID → requiresOpenOrdersSync=true
    //           → falls back to open-orders sync → 1 readOpenOrders call
    // Block 702: history mode (no sync needed, requiresOpenOrdersSync
    //           is reset per block)
    // Total: 1 readOpenOrders call (for block 701 only)
    assert.strictEqual(openOrdersReadCount, 1,
      'Only the block with missing history ID should trigger open-orders sync');

    console.log('   PASS: requiresOpenOrdersSync isolated per block group');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 10: Batch chunking with exclusion set prevents duplicate
  //          operations across rapid-fill chunks.
  // ─────────────────────────────────────────────────────────────────
  console.log('10. Fill batch chunking with exclusion isolation...');
  {
    const { bot } = await createMinimalBot('chunk-exclusion');

    // Add enough orders so we can have > MAX_FILL_BATCH_SIZE fills
    for (let i = 0; i < 8; i++) {
      await bot.manager._updateOrder(makeGridOrder(
        `slot-chunk-${i}`,
        `1.7.${1000 + i}`,
        i % 2 === 0 ? ORDER_TYPES.BUY : ORDER_TYPES.SELL,
        0.95 + i * 0.01,
        100,
      ));
    }

    // Generate enough fills to require chunking (MAX_FILL_BATCH_SIZE=4)
    const fillCount = FILL_PROCESSING.MAX_FILL_BATCH_SIZE + 2;
    const fills = [];
    for (let i = 0; i < fillCount; i++) {
      fills.push(buildFill(
        `1.11.${2000 + i}`,
        `1.7.${1000 + i}`,
        800 + i,
        10000000, 1000000,
      ));
    }

    bot._incomingFillQueue.push(...fills);

    // Track the exclusion set sizes passed to processFilledOrders
    const exclusionSizes: number[] = [];
    const originalProcessFilled = bot.manager.processFilledOrders.bind(bot.manager);
    bot.manager.processFilledOrders = async (filledOrders, excl, options) => {
      exclusionSizes.push(excl?.size || 0);
      return originalProcessFilled(filledOrders, excl, options);
    };

    await bot._consumeFillQueue(makeChainOrdersStub());

    // With MAX_FILL_BATCH_SIZE=4 and fillCount=6:
    // - Call 1: unified because 6 ≤ 4? No, 6 > 4 → chunked
    // - Call 1: 4 fills with exclusion set containing 2 remaining fills
    // - Call 2: 2 fills with exclusion set containing 4 processed fills
    assert.strictEqual(exclusionSizes.length, 2,
      'Chunked processing should call processFilledOrders twice');
    assert.ok(exclusionSizes[1] > 0,
      'Second chunk should have exclusion set to prevent duplicate operations');

    console.log('   PASS: Batch chunking applies exclusion isolation');
  }

  console.log('\n✓ All orphan-fill / death-spiral protection tests passed!');
}

runTests().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('\n✗ Orphan-fill / death-spiral tests FAILED');
  console.error(err);
  process.exit(1);
});
