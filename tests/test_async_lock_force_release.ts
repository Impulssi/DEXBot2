const assert = require('assert');
const AsyncLock = require('../modules/order/async_lock').default;
const { getErrorMessage } = require('../modules/utils/errors');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function runTests() {
    console.log('Running AsyncLock Force-Release Regression Tests...');

    // Test 1: Stale callback must not release lock held by new acquirer
    // With the fix: forceRelease defers _locked=false to stale callback's
    // finally block, preventing concurrent execution. B must queue until
    // A finishes.
    console.log(' - Stale callback must not release lock held by new acquirer...');
    {
        const lock = new AsyncLock();
        const aGate = deferred();
        const aRunning = deferred();
        let aCompleted = false;
        let bCompleted = false;
        let bStarted = false;

        const pA = lock.acquire(async () => {
            aRunning.resolve();
            await aGate.promise;
            aCompleted = true;
        });

        // Wait for A to enter its callback (lock is held)
        await aRunning.promise;
        assert.strictEqual(lock.isLocked(), true, 'A must hold lock');

        // Force-release while A is in-flight — _locked stays true,
        // _orphaned is set so A's finally releases when done.
        lock.forceRelease();
        assert.strictEqual(lock.isLocked(), true, 'Lock stays locked while stale callback runs');

        // B tries to acquire — must queue because _locked is still true
        const bGate = deferred();
        const pB = lock.acquire(async () => {
            bStarted = true;
            // A's stale callback has not completed yet since aGate hasn't resolved
            // (B is still queued at this point)
            await bGate.promise;
            bCompleted = true;
        });

        // B must still be queued (not started)
        await new Promise(r => setTimeout(r, 5));
        assert.strictEqual(bStarted, false, 'B must be queued, not running');
        assert.strictEqual(lock.isLocked(), true, 'Lock still held by A');

        // Now resolve A's stale callback — when A finishes, its finally
        // detects _orphaned and releases _locked, allowing B to start
        aGate.resolve();
        await pA;
        assert.strictEqual(aCompleted, true, 'A must have completed');

        // A has finished and released lock — B should now be executing
        await new Promise(r => setTimeout(r, 5));
        assert.strictEqual(bStarted, true, 'B must have started after A completed');
        assert.strictEqual(lock.isLocked(), true, 'B must hold lock');

        // Now let B finish
        bGate.resolve();
        await pB;

        assert.strictEqual(bCompleted, true, 'B must have completed');
        assert.strictEqual(lock.isLocked(), false, 'Lock must be free after B completes');
    }

    // Test 2: Normal path (no forceRelease) must still work
    console.log(' - Normal acquire/release cycle still works...');
    {
        const lock = new AsyncLock();
        let result = await lock.acquire(async () => 'ok');
        assert.strictEqual(result, 'ok', 'Normal acquire must return callback result');
        assert.strictEqual(lock.isLocked(), false, 'Lock must be free after normal release');
    }

    // Test 3: forceRelease with nothing running (idempotent)
    console.log(' - forceRelease on idle lock is safe...');
    {
        const lock = new AsyncLock();
        assert.strictEqual(lock.isLocked(), false);
        const count = lock.forceRelease();
        assert.strictEqual(count, 0, 'Nothing queued');
        assert.strictEqual(lock.isLocked(), false);

        // Lock still usable after idle forceRelease
        let result = await lock.acquire(async () => 42);
        assert.strictEqual(result, 42);
    }

    // Test 4: re-entrant acquire executes directly (no queue)
    // Requires calling acquire() from inside the lock's callback (same ALS context).
    // Concurrent callers from a different async context should queue.
    console.log(' - Re-entrant acquire executes directly...');
    {
        const lock = new AsyncLock();
        const gate = deferred();
        const nestedDone = deferred();

        let qExecuted = false;

        const pA = lock.acquire(async () => {
            // Inside the lock's ALS context — this IS re-entrant
            await lock.acquire(async () => {
                qExecuted = true;
            });
            nestedDone.resolve();
            await gate.promise;
        });

        // Wait for nested acquire to complete
        await nestedDone.promise;
        assert.strictEqual(qExecuted, true, 'Re-entrant acquire must execute callback directly');
        assert.strictEqual(lock.getQueueLength(), 0, 'Queue must be empty (re-entrant)');
        assert.strictEqual(lock.isLocked(), true, 'Lock must still be held by A');

        // A concurrent caller from a different async context must queue
        let outsideExecuted = false;
        const pOutside = lock.acquire(async () => {
            outsideExecuted = true;
        });
        assert.strictEqual(outsideExecuted, false, 'Outside acquire must queue');
        assert.strictEqual(lock.getQueueLength(), 1, 'Queue must have 1 waiter');

        // Let A finish naturally
        gate.resolve();
        await pA;
        assert.strictEqual(lock.isLocked(), false, 'Lock must be free after A resolves');

        // Outside waiter should now have executed
        await pOutside;
        assert.strictEqual(outsideExecuted, true, 'Outside acquire must execute after A finishes');
        assert.strictEqual(lock.isLocked(), false, 'Lock must be free after outside completes');
    }

    // Test 5: Multiple forceRelease calls in sequence
    console.log(' - Multiple forceRelease calls...');
    {
        const lock = new AsyncLock();

        // forceRelease on idle lock twice
        lock.forceRelease();
        lock.forceRelease();
        assert.strictEqual(lock.isLocked(), false);

        let result = await lock.acquire(async () => 'works');
        assert.strictEqual(result, 'works');
    }

    // Test 6: forceRelease while callback executing — must defer lock release
    // to stale callback's finally block to prevent concurrent execution.
    console.log(' - forceRelease defers _locked while callback is running...');
    {
        const lock = new AsyncLock();
        const gate = deferred();

        // A acquires the lock and suspends
        const pA = lock.acquire(async () => {
            await gate.promise;
        });

        await new Promise(r => setTimeout(r, 10));
        assert.strictEqual(lock.isLocked(), true, 'A must hold lock');

        // forceRelease while A is still running. Since _holding is true,
        // _locked stays set (_orphaned = true) to prevent concurrent execution.
        lock.forceRelease();
        assert.strictEqual(lock.isLocked(), true, 'Lock stays locked while stale callback runs');

        // B tries to acquire — must queue (lock still held by A)
        let bDone = false;
        const pB = lock.acquire(async () => {
            bDone = true;
            return 99;
        });
        await new Promise(r => setTimeout(r, 5));
        assert.strictEqual(bDone, false, 'B must be queued, not running');

        // Let A's stale callback finish — its finally detects _orphaned,
        // releases _locked, and processes the queue (starting B).
        gate.resolve();
        await pA;
        await new Promise(r => setTimeout(r, 5));
        assert.strictEqual(lock.isLocked(), false, 'Lock free after stale callback settles');

        // B should have run and completed
        const bResult = await pB;
        assert.strictEqual(bResult, 99, 'B completes after A settles');
        assert.strictEqual(bDone, true, 'B must have run');
        assert.strictEqual(lock.isLocked(), false, 'Lock free after B completes');

        // Lock still usable after stale callback settles
        const result = await lock.acquire(async () => 42);
        assert.strictEqual(result, 42, 'Lock usable after stale callback settles');
    }

    // Test 7: Nested multi-lock re-entrancy
    // With Set<symbol> in ALS: outer lock identity is preserved across
    // a nested acquire of a different lock. Without the fix, the inner
    // lock's _lockCtx.run overwrites the store and isReentrant() for
    // the outer lock returns false.
    console.log(' - Nested multi-lock re-entrancy (A in B)...');
    {
        const lockA = new AsyncLock();
        const lockB = new AsyncLock();

        await lockA.acquire(async () => {
            await lockB.acquire(async () => {
                assert.strictEqual(lockA.isReentrant(), true,
                    'lockA must be re-entrant inside lockB (same async context)');
                assert.strictEqual(lockB.isReentrant(), true,
                    'lockB must be re-entrant inside itself');
            });
            assert.strictEqual(lockA.isReentrant(), true,
                'lockA must be re-entrant after lockB returns');
        });
    }
    // Test 8: Triple nesting (A→B→C) with middle lock released
    console.log(' - Triple-nested re-entrancy (A→B→C)...');
    {
        const lockA = new AsyncLock();
        const lockB = new AsyncLock();
        const lockC = new AsyncLock();

        await lockA.acquire(async () => {
            await lockB.acquire(async () => {
                await lockC.acquire(async () => {
                    assert.strictEqual(lockA.isReentrant(), true,
                        'lockA re-entrant in C');
                    assert.strictEqual(lockB.isReentrant(), true,
                        'lockB re-entrant in C');
                    assert.strictEqual(lockC.isReentrant(), true,
                        'lockC re-entrant in itself');
                });
                assert.strictEqual(lockA.isReentrant(), true,
                    'lockA re-entrant after C returns');
                assert.strictEqual(lockB.isReentrant(), true,
                    'lockB re-entrant after C returns');
            });
            assert.strictEqual(lockA.isReentrant(), true,
                'lockA re-entrant after B returns');
        });
    }

    console.log('\n✓ AsyncLock Force-Release tests passed!');
}

runTests().catch(err => {
    console.error('AsyncLock Force-Release tests failed:', getErrorMessage(err));
    process.exit(1);
});
