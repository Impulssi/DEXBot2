const assert = require('assert');
const AsyncLock = require('../modules/order/async_lock');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function runTests() {
    console.log('Running AsyncLock Force-Release Regression Tests...');

    // Test 1: Stale callback must not steal lock from a new acquirer
    console.log(' - Stale callback must not release lock held by new acquirer...');
    {
        const lock = new AsyncLock();
        const aGate = deferred();
        const aRunning = deferred();
        let aCompleted = false;
        let bCompleted = false;
        let bSeqAfterA = false;

        const pA = lock.acquire(async () => {
            aRunning.resolve();
            await aGate.promise;
            aCompleted = true;
        });

        // Wait for A to enter its callback (lock is held)
        await aRunning.promise;
        assert.strictEqual(lock.isLocked(), true, 'A must hold lock');

        // Force-release while A is in-flight
        lock.forceRelease();
        assert.strictEqual(lock.isLocked(), false, 'Lock must be free after forceRelease');

        // B acquires immediately (lock was force-released)
        const bGate = deferred();
        const pB = lock.acquire(async () => {
            // B is running, A's stale callback hasn't resolved yet
            bSeqAfterA = aCompleted; // should be false
            await bGate.promise;
            bCompleted = true;
        });

        assert.strictEqual(lock.isLocked(), true, 'B must hold lock');

        // Now resolve A's stale callback — it should NOT touch _locked
        aGate.resolve();
        await pA;

        // A's stale callback completed — B must still hold the lock
        assert.strictEqual(lock.isLocked(), true, 'Lock must still be held by B after stale A completes');
        assert.strictEqual(aCompleted, true, 'A must have completed');
        assert.strictEqual(bSeqAfterA, false, 'B must have started before A completed');

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
    console.log(' - Re-entrant acquire executes directly...');
    {
        const lock = new AsyncLock();
        const gate = deferred();

        const pA = lock.acquire(async () => {
            await gate.promise;
        });

        // Wait for A to acquire
        await new Promise(r => setTimeout(r, 10));
        assert.strictEqual(lock.isLocked(), true);

        // With re-entrant lock, nested acquire runs the callback directly
        let qExecuted = false;
        const pQ = lock.acquire(async () => {
            qExecuted = true;
        });

        assert.strictEqual(qExecuted, true, 'Re-entrant acquire must execute callback directly');
        assert.strictEqual(lock.getQueueLength(), 0, 'Queue must be empty (re-entrant)');
        assert.strictEqual(lock.isLocked(), true, 'Lock must still be held by A');

        // Let A finish naturally
        gate.resolve();
        await pA;
        assert.strictEqual(lock.isLocked(), false, 'Lock must be free after A resolves');
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

    // Test 6: forceRelease resets lock for new acquirer; stale callback is ignored
    console.log(' - forceRelease rejects stale callback via generation guard...');
    {
        const lock = new AsyncLock();
        const gate = deferred();

        // A acquires the lock and suspends
        const pA = lock.acquire(async () => {
            await gate.promise;
        });

        await new Promise(r => setTimeout(r, 10));
        assert.strictEqual(lock.isLocked(), true, 'A must hold lock');

        // forceRelease while A is still running — increments generation,
        // resets _locked, clears queue (re-entrant path prevents queueing,
        // but generation guard protects stale finally).
        lock.forceRelease();
        assert.strictEqual(lock.isLocked(), false, 'Lock must be free after forceRelease');

        // B acquires and completes normally (lock is reusable)
        let result = await lock.acquire(async () => 99);
        assert.strictEqual(result, 99, 'New acquire after forceRelease must succeed');
        assert.strictEqual(lock.isLocked(), false, 'Lock free after B completes');

        // Let A's stale callback finish — generation mismatch means its
        // finally block skips _locked = false. Verify the lock is still free.
        gate.resolve();
        await pA;
        assert.strictEqual(lock.isLocked(), false, 'Lock still free after stale A completes');

        // Lock still usable after stale callback settles
        result = await lock.acquire(async () => 42);
        assert.strictEqual(result, 42, 'Lock usable after stale callback settles');
    }

    console.log('\n✓ AsyncLock Force-Release tests passed!');
}

runTests().catch(err => {
    console.error('AsyncLock Force-Release tests failed:', err.message);
    process.exit(1);
});
