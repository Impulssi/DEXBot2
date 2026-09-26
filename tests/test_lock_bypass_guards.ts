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
        bot._warn = (m?: any) => { warns.push(String(m)); };

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

    console.log(' - shouldDeferMaintenanceForBroadcast: live region defers, stale flag does not...');
    {
        const shouldDefer = MaintenanceRuntime.shouldDeferMaintenanceForBroadcast;
        const { TIMING } = require('../modules/constants');

        assert.strictEqual(
            shouldDefer({ manager: { isBroadcastingActive: () => false } }),
            false,
            'idle manager must not defer'
        );
        assert.strictEqual(shouldDefer(null), false, 'missing bot must fail open');

        // Live region (recent start) → defer so the tick does not queue on the
        // fill lock behind a long broadcast/placement region.
        assert.strictEqual(
            shouldDefer({ manager: { isBroadcastingActive: () => true, _broadcastingStartedAt: Date.now() - 1000 } }),
            true,
            'live region must defer'
        );

        // Leaked/stale flag (start older than the watchdog) → do NOT defer:
        // executeMaintenanceLogic must run _clearStaleBroadcastFlag, or a
        // leaked flag would defer every tick forever.
        const staleMs = Number(TIMING.BROADCAST_STALE_CLEAR_MS);
        assert.strictEqual(
            shouldDefer({ manager: { isBroadcastingActive: () => true, _broadcastingStartedAt: Date.now() - staleMs - 1000 } }),
            false,
            'stale flag must NOT defer (watchdog must run)'
        );

        assert.strictEqual(
            shouldDefer({ manager: { isBroadcastingActive: () => true } }),
            false,
            'missing region timestamp must fail open'
        );
    }

    console.log(' - broadcast defer constants: single stale authority + ordering invariant...');
    {
        const { TIMING } = require('../modules/constants');
        const staleClear = Number(TIMING.BROADCAST_STALE_CLEAR_MS);
        const margin = Number(TIMING.BROADCAST_DEFER_SAFETY_MARGIN_MS);
        const deferMax = Number(TIMING.FILL_BROADCAST_DEFER_MAX_MS);
        assert.ok(staleClear > 0 && margin > 0, 'stale-clear and margin must be positive');
        assert.ok(deferMax > staleClear, 'fill deferral bound must outlast the stale watchdog');
        assert.ok(deferMax >= staleClear + margin, 'fill deferral bound must include the safety margin');
    }

    console.log(' - checkGridLockHoldDuration: warns on an over-long hold, silent below...');
    {
        const check = MaintenanceRuntime.checkGridLockHoldDuration;
        assert.strictEqual(check(null), 0, 'missing bot must be safe');

        let warns = [];
        const shortBot = {
            _warn: (m?: any) => { warns.push(String(m)); },
            manager: { _gridLock: { heldForMs: () => 10 } },
        };
        assert.strictEqual(check(shortBot), 10, 'returns the observed hold');
        assert.strictEqual(warns.length, 0, 'short hold must not warn');

        warns = [];
        const longBot = {
            _warn: (m?: any) => { warns.push(String(m)); },
            manager: { _gridLock: { heldForMs: () => 60000 } },
        };
        assert.strictEqual(check(longBot), 60000, 'returns the observed long hold');
        assert.strictEqual(warns.length, 1, 'long hold must warn once');
        assert.ok(warns[0].includes('[GRID-LOCK]'), 'warn must be tagged');
        check(longBot);
        assert.strictEqual(warns.length, 1, 'repeat call within the rate limit must not warn again');
    }

    console.log('\n✓ Lock-bypass guard tests passed!');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
