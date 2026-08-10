const assert = require('assert');

const MaintenanceRuntime = require('../modules/dexbot_maintenance_runtime');
const AsyncLock = require('../modules/order/async_lock').default;

// dryRun=true short-circuits the sync impl before any chain read, so these
// tests exercise the self-guarding wrapper / dust deferral without a live
// BitShares connection (loading dexbot_maintenance_runtime connects only when
// a chain read is actually invoked).
function makeBot(lock) {
    return {
        accountId: '1.2.345',
        config: { dryRun: true },
        manager: {
            _fillProcessingLock: lock,
            synchronizeWithChain: async () => ({ filledOrders: [], unmatchedChainOrders: [] }),
            checkGridHealth: async () => ({ buyDustOrders: [], sellDustOrders: [] }),
        },
        _refreshDynamicWeightDistribution: () => {},
        _processFillsWithBatching: async () => ({ aborted: false }),
        _cancelDustOrders: async () => ({ cancelledCount: 0, batchResult: null }),
        _log: () => {},
        _warn: () => {},
    };
}

const DRY_RUN_RESULT = { syncResult: null, aborted: false, hasUnmatched: 0, openOrders: null };

async function runTests() {
    console.log('Running lock-bypass guard tests...');

    console.log(' - syncOpenOrdersAndProcessFills serializes an unlocked caller through the fill lock...');
    {
        const lock = new AsyncLock();
        let acquireCount = 0;
        const origAcquire = lock.acquire.bind(lock);
        lock.acquire = ((cb, opts) => { acquireCount++; return origAcquire(cb, opts); });

        const bot = makeBot(lock);
        const result = await MaintenanceRuntime.syncOpenOrdersAndProcessFills(bot, 'test-unlocked');
        assert.strictEqual(acquireCount, 1, 'unlocked caller must be serialized through the fill lock');
        assert.deepStrictEqual(result, DRY_RUN_RESULT, 'sync should complete with the dry-run short-circuit');
    }

    console.log(' - syncOpenOrdersAndProcessFills is re-entrant (no double acquisition)...');
    {
        const lock = new AsyncLock();
        let acquireCount = 0;
        const origAcquire = lock.acquire.bind(lock);
        lock.acquire = ((cb, opts) => { acquireCount++; return origAcquire(cb, opts); });

        const bot = makeBot(lock);
        await lock.acquire(async () => {
            await MaintenanceRuntime.syncOpenOrdersAndProcessFills(bot, 'test-reentrant');
        });
        assert.strictEqual(acquireCount, 1, 'caller already inside the fill lock must not re-acquire');
    }

    console.log(' - runDustHealthCheck defers (does not bypass) when the fill lock is unavailable...');
    {
        const bot = makeBot(undefined);
        let cancelCalls = 0;
        const warns = [];
        bot.manager.checkGridHealth = async () => ({ buyDustOrders: [{ id: 'dust-1', orderId: '1.7.9001' }], sellDustOrders: [] });
        bot._cancelDustOrders = async () => { cancelCalls++; return { cancelledCount: 1, batchResult: null }; };
        bot._warn = (m) => warns.push(String(m));

        await MaintenanceRuntime.runDustHealthCheck(bot);
        assert.strictEqual(cancelCalls, 0, 'dust cancel must be deferred, not run without the fill lock');
        assert.ok(
            warns.some((w) => w.includes('[DUST]') && w.includes('deferring')),
            `deferral must be logged: ${JSON.stringify(warns)}`
        );
    }

    console.log(' - runDustHealthCheck cancels dust normally when the fill lock is available...');
    {
        const lock = { acquire: async (fn) => fn() };
        const bot = makeBot(lock);
        let cancelCalls = 0;
        bot.manager.checkGridHealth = async () => ({ buyDustOrders: [{ id: 'dust-1', orderId: '1.7.9001' }], sellDustOrders: [] });
        bot._cancelDustOrders = async () => { cancelCalls++; return { cancelledCount: 1, batchResult: null }; };

        await MaintenanceRuntime.runDustHealthCheck(bot);
        assert.strictEqual(cancelCalls, 1, 'dust cancel must run when the fill lock is available');
    }

    console.log('\n✓ Lock-bypass guard tests passed!');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
