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

    // Test 4: forceRelease with queued waiters
    console.log(' - forceRelease clears queued waiters...');
    {
        const lock = new AsyncLock();
        const gate = deferred();

        const pA = lock.acquire(async () => {
            await gate.promise;
        });

        // Wait for A to acquire
        await new Promise(r => setTimeout(r, 10));
        assert.strictEqual(lock.isLocked(), true);

        let qExecuted = false;
        const pQ = lock.acquire(async () => {
            qExecuted = true;
        });

        assert.strictEqual(lock.getQueueLength(), 1);

        const count = lock.forceRelease();
        assert.strictEqual(count, 1, 'Must have cleared 1 queued item');
        assert.strictEqual(lock.getQueueLength(), 0);

        // Queued item must have been rejected
        try {
            await pQ;
            assert.fail('Queued operation must have been rejected');
        } catch (err) {
            assert.strictEqual(err.message, 'Lock force-released');
        }
        assert.strictEqual(qExecuted, false, 'Queued callback must not execute');

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

    console.log('\n✓ AsyncLock Force-Release tests passed!');
}

runTests().catch(err => {
    console.error('AsyncLock Force-Release tests failed:', err.message);
    process.exit(1);
});
