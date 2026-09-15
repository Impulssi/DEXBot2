/**
 * Startup-reconcile + last-fill-guard logging hygiene tests.
 *
 * Covers two log-quality defects found in review:
 *
 *  GPI-LOG-001: a rejected startup update reports its GRID-PRICE-INVARIANT
 *     warning EXACTLY ONCE. This is asserted because the obvious
 *     implementation of the sequential fallback prepares the same plan twice
 *     (once in the pre-filter, once in `_executeStartupSingleUpdate`), which
 *     would double-log if the pre-filter ever stopped discarding rejected
 *     plans. The pre-filter discarding them is what keeps the count at one,
 *     so that is the property this test pins.
 *
 *  F4 (GPI-LOG-002): `runLastFillGuardCheck` warned on every off-ladder pivot,
 *     and it runs once per guarded action, so a persistently off-ladder
 *     `_lastFilledPrice` (exactly the corruption case) emitted one warn per
 *     action per batch on top of the batch summary that already reports
 *     pivotOffGrid=true. Now reported once per distinct pivot value per batch.
 *
 * Both tests assert the defect is gone, and both FAIL if the dedup is reverted.
 */

const assert = require('assert');
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

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
            if (target[key] === value) { overrides.delete(key); } else { overrides.set(key, value); }
            return true;
        },
    });
}

const { BroadcastUncertainError } = require('../modules/dexbot_credential_client');

// chain_orders is an ESM namespace (frozen), so build/execute are replaced via
// loader hooks rather than direct assignment.
const chainOrders = makeSwappableModule({
    BroadcastUncertainError,
    selectAccount: async () => {}, setPreferredAccount: async () => {},
    resolveAccountId: async () => null, resolveAccountName: async () => null,
    readOpenOrders: async () => [],
    readOpenOrdersWithMeta: async () => ({ orders: [], truncated: false }),
    readOpenOrdersWithMetaSafe: async () => ({ orders: [], truncated: false }),
    readOpenOrdersGuarded: async () => [],
    readSingleOrder: async () => null, batchReadOrders: async () => [],
    listenForFills: async () => () => {},
    updateOrder: async () => { throw new Error('updateOrder not configured'); },
    createOrder: async () => { throw new Error('createOrder not configured'); },
    cancelOrder: async () => { throw new Error('cancelOrder not configured'); },
    getOnChainAssetBalances: async () => ({}),
    getFillProcessingMode: async () => 'history',
    buildUpdateOrderOp: async () => { throw new Error('buildUpdateOrderOp not configured'); },
    buildCreateOrderOp: async () => ({ op: [1, {}], finalInts: { sellAmount: 1, receiveAmount: 1 } }),
    buildCancelOrderOp: async () => { throw new Error('buildCancelOrderOp not configured'); },
    buildLiquidityPoolExchangeOp: async () => { throw new Error('buildLiquidityPoolExchangeOp not configured'); },
    executeBatch: async () => ({ success: true, operation_results: [] }),
    findOverReducingUpdateOpError: async () => null,
    wasRecentlyOwnCancelled: () => false, recordOwnCancel: () => {},
    broadcastTxWithClassification: async () => ({})
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

const {
    _executeStartupSequentialUpdateFallback,
} = require('../modules/order/grid_reconcile_internal');
const { buildGenesisFromPriceLevels } = require('../modules/order/utils/math');
const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

const LEVELS = [95, 100, 105, 110, 115];

function makeGenesis() {
    return buildGenesisFromPriceLevels(LEVELS[2], 5, 0, LEVELS);
}

/**
 * GPI-LOG-001 — one rejected startup update must warn ONCE.
 *
 * The plan's target slot carries an off-grid price, so
 * `_prepareStartupUpdatePlan` rejects it via reportGridPriceInvariant and
 * returns null. The warning must appear exactly once.
 */
async function testLOG001_RejectedStartupUpdateWarnsOnce() {
    console.log('\n[GPI-LOG-001] a rejected startup update warns exactly once...');
    const genesis = makeGenesis();
    const warnings: string[] = [];

    const manager: any = {
        _genesis: genesis,
        assets: {
            assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
            assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
        },
        orders: new Map([
            // slot-4's genesis level is 115; 130 is off-grid, so preparation
            // rejects this plan.
            ['slot-4', {
                // Unmapped slot (orderId '') so preparation proceeds past the
                // "already mapped" early-returns and reaches the invariant check.
                id: 'slot-4', type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL,
                price: 130, size: 10, orderId: ''
            }]
        ]),
        logger: {
            log: (msg: any, level?: any) => {
                if (level === 'warn' || level === undefined) warnings.push(String(msg));
            }
        }
    };

    const chainOrders = {
        updateOrder: async () => ({ success: true })
    };

    const updatePlans = [{
        chainOrderId: '1.7.500',
        gridOrder: {
            id: 'slot-4', type: ORDER_TYPES.SELL, price: 130, size: 10, orderId: ''
        },
        chainOrderObj: {
            id: '1.7.500', for_sale: 10, sell_price: { base: { amount: 1, asset_id: '1.3.0' }, quote: { amount: 1, asset_id: '1.3.1' } }
        }
    }];

    const result = await _executeStartupSequentialUpdateFallback({
        updatePlans,
        chainOrders,
        account: 'acct',
        privateKey: 'pk',
        manager,
        dryRun: false
    });

    const invariantWarns = warnings.filter(w => w.includes('[GRID-PRICE-INVARIANT]') && w.includes('RECONCILE-UPDATE'));
    assert.strictEqual(result.executed, 0, 'a rejected plan must not execute');
    assert.ok(invariantWarns.length >= 1,
        'the rejection must be reported (otherwise this test proves nothing)');
    assert.strictEqual(invariantWarns.length, 1,
        `a rejected startup update must warn exactly ONCE, got ${invariantWarns.length}:\n` + invariantWarns.join('\n'));
    console.log('✓ GPI-LOG-001 passed');
}

/**
 * GPI-LOG-002 — the off-ladder pivot warn is emitted once per batch, not once
 * per guarded action.
 *
 * `runLastFillGuardCheck` is module-private, so this drives the REAL guard
 * through `updateOrdersOnChainBatchCOW` with two CREATE actions in one batch
 * that both hit the guard with the same off-ladder pivot, and counts the
 * warning lines. Before the fix this warned twice; the batch summary already
 * reports pivotOffGrid=true separately.
 *
 * This deliberately does NOT re-implement the dedup rule: asserting a copy of
 * the logic would pass even with the fix reverted.
 */
async function testLOG002_OffLadderPivotWarnsOncePerBatch() {
    console.log('\n[GPI-LOG-002] the off-ladder pivot warns once per batch, not per action...');
    const genesis = makeGenesis();
    const pivotWarns: string[] = [];
    const allLogs: string[] = [];

    const bot: any = {
        _currentCycleId: 42,
        dryRun: false,
        account: 'acct',
        privateKey: 'pk',
        config: { incrementPercent: 5 },
        _markGridActivity: () => {},
        _incomingFillQueue: [],
        _scheduleFillConsumerRestart: () => {},
        manager: {
            _genesis: genesis,
            _gridVersion: 0,
            boundaryIdx: 0,
            _gapSlots: 0,
            assets: {
                assetA: { id: '1.3.0', precision: 8, symbol: 'BTS' },
                assetB: { id: '1.3.1', precision: 5, symbol: 'USD' }
            },
            orders: new Map(),
            config: { incrementPercent: 5 },
            // Off-ladder raw pivot: 112 is not a ladder level (snaps to 110).
            _lastFilledPrice: 122,
            _lastFilledType: ORDER_TYPES.BUY,
            logger: {
                log: (msg: any) => {
                    if (String(msg).includes('[LAST-FILL-GUARD] Pivot')) pivotWarns.push(String(msg));
                    allLogs.push(String(msg));
                },
                logFundsStatus: () => {}
            },
            lockOrders: () => {}, unlockOrders: () => {},
            _setRebalanceState: () => {}, _resetRebalanceStateToDepth: () => {},
            startBroadcasting: () => {}, stopBroadcasting: () => {},
            pauseFundRecalc: () => {}, resumeFundRecalc: async () => {},
            _commitWorkingGrid: async () => true,
            persistGrid: async () => {}, _clearWorkingGridRef: () => {},
            getChainFundsSnapshot: () => ({ chainFreeSell: 1e9, chainFreeBuy: 1e9 }),
            accountant: { updateOptimisticFreeBalance: async () => {} },
            applyGridUpdateBatch: async () => {},
            synchronizeWithChain: async () => {}
        }
    };

    // The batch entrypoint is a DEXBot prototype method; borrow it rather than
    // reimplementing the batch, so this exercises the real guard path.
    const DEXBot = require('../modules/dexbot_class').default;
    bot._updateOrdersOnChainBatchCOW = DEXBot.prototype._updateOrdersOnChainBatchCOW;

    const { WorkingGrid } = require('../modules/order/working_grid');
    const { COW_ACTIONS } = require('../modules/constants');
    const workingGrid = new WorkingGrid(bot.manager.orders, { baseVersion: 0 });

    // Two CREATE actions, both judged against the same pivot. The off-ladder
    // warning fires when the pivot cannot be snapped to a level at all
    // (onGrid.idx == null), so the raw pivot must be outside the snap tolerance.
    const actions = ['slot-1', 'slot-2'].map((id, i) => {
        const price = LEVELS[i];
        workingGrid.set(id, {
            id, type: ORDER_TYPES.SELL, state: ORDER_STATES.VIRTUAL,
            price, size: 10, orderId: ''
        });
        return {
            type: COW_ACTIONS.CREATE,
            id,
            order: { id, type: ORDER_TYPES.SELL, price, size: 10, state: ORDER_STATES.VIRTUAL, orderId: '' }
        };
    });

    const origExecute = chainOrders.executeBatch;
    const origBuild = chainOrders.buildCreateOrderOp;
    let built = 0;
    chainOrders.executeBatch = async () => ({ success: true, operation_results: [] });
    chainOrders.buildCreateOrderOp = async () => {
        built += 1;
        return {
            op: [1, { amount_to_sell: { amount: 1, asset_id: '1.3.0' } }],
            finalInts: { sellAmount: 1, receiveAmount: 1 }
        };
    };
    try {
        await bot._updateOrdersOnChainBatchCOW({
            workingGrid,
            workingIndexes: workingGrid.getIndexes(),
            workingBoundary: 0,
            actions
        });
    } finally {
        chainOrders.executeBatch = origExecute;
        chainOrders.buildCreateOrderOp = origBuild;
    }

    if (pivotWarns.length === 0) { console.error('LOGS:\n' + allLogs.join('\n')); }
    assert.ok(pivotWarns.length >= 1, 'the off-ladder pivot must be reported at least once');
    assert.strictEqual(pivotWarns.length, 1,
        `the off-ladder pivot must warn ONCE for the batch, got ${pivotWarns.length}`);

    // The per-action off-ladder COUNT must appear on the batch summary. The
    // summary's batch-level `pivotOffGrid=true` flag only says the pivot was
    // off-grid; the count says how many guarded probes used an unsnapped pivot,
    // which is the quantity that grows during the ratchet this guard catches.
    const summary = allLogs.find(l => l.includes('[LAST-FILL-GUARD] mode='));
    assert.ok(summary, 'the batch must emit a LAST-FILL-GUARD summary line');
    assert.ok(String(summary).includes('pivotOffGrid='),
        `the summary must report the per-action off-ladder count, got: ${summary}`);
    assert.ok(/pivotOffGrid=[0-9]+/.test(String(summary)),
        `the counter must be numeric, not the bare flag, got: ${summary}`);
    console.log('✓ GPI-LOG-002 passed');
}

async function runAllTests() {
    console.log('=== Startup/Guard Logging Hygiene Tests ===\n');
    await testLOG001_RejectedStartupUpdateWarnsOnce();
    await testLOG002_OffLadderPivotWarnsOncePerBatch();
    console.log('\n=== All logging hygiene tests passed! ===');
}

runAllTests().catch((e: any) => { console.error(e); process.exit(1); });
