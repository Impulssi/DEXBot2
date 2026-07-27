
const assert = require('assert');
const AsyncLock = require('../modules/order/async_lock');
const { getErrorMessage } = require('../modules/utils/errors');


async function testLockTimeout() {
    console.log('Running AsyncLock Timeout & Cancellation Tests...');
    const lock = new AsyncLock();

    // 1. Test basic cancellation
    console.log(' - Testing basic cancellation...');
    const cancelToken = { isCancelled: false };
    let executed = false;

    // Simulate lock being held
    lock.acquire(async () => {
        await new Promise(r => setTimeout(r, 100));
    });

    // This one should be cancelled
    const p = lock.acquire(async () => {
        executed = true;
    }, { cancelToken });

    cancelToken.isCancelled = true;
    
    try {
        await p;
        assert.fail('Should have thrown cancellation error');
    } catch (err) {
        assert.strictEqual(getErrorMessage(err), 'Lock acquisition cancelled (timeout)');
    }
    
    // Wait for queue to clear
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(executed, false, 'Callback should not have executed');
    assert.strictEqual(lock.isLocked(), false);

    // 2. Test clearQueue
    console.log(' - Testing clearQueue...');
    lock.acquire(async () => {
        await new Promise(r => setTimeout(r, 100));
    });

    let q1 = false, q2 = false;
    const p1 = lock.acquire(async () => { q1 = true; });
    const p2 = lock.acquire(async () => { q2 = true; });

    assert.strictEqual(lock.getQueueLength(), 2);
    const cleared = lock.clearQueue();
    assert.strictEqual(cleared, 2);
    assert.strictEqual(lock.getQueueLength(), 0);

    // Ensure they were rejected
    await Promise.all([
        p1.catch(e => assert.strictEqual(getErrorMessage(e), 'Lock queue cleared')),
        p2.catch(e => assert.strictEqual(getErrorMessage(e), 'Lock queue cleared'))
    ]);

    // 3. Test immediate cancellation after acquisition (SyncEngine style)
    console.log(' - Testing immediate abortion after acquisition...');
    let abortExecuted = false;
    const abortToken = { isCancelled: false };
    
    // Hold lock
    lock.acquire(async () => {
        await new Promise(r => setTimeout(r, 100));
    });

    const pAbort = lock.acquire(async () => {
        if (abortToken.isCancelled) {
            throw new Error('Aborted');
        }
        abortExecuted = true;
    }, { cancelToken: abortToken });

    // Cancel it while it's in queue
    abortToken.isCancelled = true;

    try {
        await pAbort;
        assert.fail('Should have been aborted');
    } catch (err) {
        // Since we check inside the callback too, it might be the Lock error or our Abort error
        // depending on timing, but in our sequential test it will be the Lock error.
        assert(getErrorMessage(err) === 'Lock acquisition cancelled (timeout)' || getErrorMessage(err) === 'Aborted');
    }
    
    assert.strictEqual(abortExecuted, false);

    console.log('✓ AsyncLock Timeout tests passed!');
}

testLockTimeout().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
