const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

console.log('Running AsyncLock no-ALS fallback mutual-exclusion tests...');

// The no-ALS fallback runs when AsyncLocalStorage is unavailable (browser
// bundle shim). It MUST preserve mutual exclusion: a concurrent caller while
// the lock is held must QUEUE, not auto-run. The old fallback treated every
// concurrent caller as re-entrant (`_holding` alone) and ran it immediately —
// silently allowing two critical sections to interleave. Only a call made
// synchronously inside the holder's own callback prologue is re-entrant now.
//
// Each test runs in a spawned child so the escape-hatch env var
// (DEXBOT_DISABLE_ASYNC_LOCAL_STORAGE=1) is present before the module loads,
// and the same script is re-run with ALS enabled as a control.

const root = path.resolve(__dirname, '..');

const childScript = `
const AsyncLock = require(${JSON.stringify(path.join(root, 'modules/order/async_lock'))}).default;
const assert = require('assert');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

(async () => {
    // 1. A concurrent caller arriving while the holder is suspended at an
    //    await must queue (mutual exclusion), never auto-run.
    {
        const lock = new AsyncLock();
        const gate = deferred();
        const aEntered = deferred();
        let concurrentStarted = false;
        let aExited = false;

        const pA = lock.acquire(async () => {
            aEntered.resolve();
            await gate.promise;
            aExited = true;
        });
        await aEntered.promise;
        assert.strictEqual(lock.isLocked(), true, 'A must hold the lock');

        const pConcurrent = lock.acquire(async () => { concurrentStarted = true; });
        await new Promise(r => setTimeout(r, 20));
        assert.strictEqual(concurrentStarted, false, 'concurrent caller must queue, not run immediately');
        assert.strictEqual(lock.getQueueLength(), 1, 'concurrent caller must be queued');

        gate.resolve();
        await pA;
        await pConcurrent;
        assert.strictEqual(aExited, true, 'A must complete before the queued caller runs');
        assert.strictEqual(concurrentStarted, true, 'queued caller must run after A settles');
        assert.strictEqual(lock.isLocked(), false, 'lock must be free after both settle');
    }

    // 2. isReentrant() must report false for a concurrent caller so callers
    //    that skip acquisition based on it fall back to a queueing acquire.
    {
        const lock = new AsyncLock();
        const gate = deferred();
        const aEntered = deferred();
        const pA = lock.acquire(async () => { aEntered.resolve(); await gate.promise; });
        await aEntered.promise;
        const outer = lock.acquire(async () => {});
        assert.strictEqual(lock.isReentrant(), false, 'concurrent caller must not report re-entrant');
        gate.resolve();
        await pA;
        await outer;
        assert.strictEqual(lock.isLocked(), false, 'lock must be free');
    }

    // 3. A synchronous nested acquire from within the holder's own callback
    //    prologue stays re-entrant (runs directly, no queue, no deadlock).
    {
        const lock = new AsyncLock();
        let nestedRan = false;
        await lock.acquire(async () => {
            await lock.acquire(async () => { nestedRan = true; });
        });
        assert.strictEqual(nestedRan, true, 'synchronous nested acquire must run directly');
        assert.strictEqual(lock.isLocked(), false, 'lock must be free after nested completes');
    }

    // 4. Normal acquire/release still works.
    {
        const lock = new AsyncLock();
        const result = await lock.acquire(async () => 'ok');
        assert.strictEqual(result, 'ok', 'normal acquire must return callback result');
        assert.strictEqual(lock.isLocked(), false, 'lock must be free after normal release');
    }

    console.log('NO-ALS-FALLBACK-CHILD-OK');
})().catch(err => { console.error(err); process.exit(1); });
`;

function runChild(disableAls) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-als-'));
    const tmpFile = path.join(tmpDir, 'child.cjs');
    fs.writeFileSync(tmpFile, childScript);
    try {
        const env = { ...process.env };
        if (disableAls) env.DEXBOT_DISABLE_ASYNC_LOCAL_STORAGE = '1';
        return spawnSync(process.execPath, ['--import', 'tsx', tmpFile], {
            cwd: root,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf-8',
            timeout: 30000,
        });
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

function assertChildOk(run, label) {
    const out = `${run.stdout || ''}\n${run.stderr || ''}`;
    assert.strictEqual(run.status, 0, `${label} child should pass, got status ${run.status}\n${out}`);
    assert.ok(out.includes('NO-ALS-FALLBACK-CHILD-OK'), `${label} child should reach the success marker\n${out}`);
}

async function runTests() {
    console.log(' - Child with ALS disabled (DEXBOT_DISABLE_ASYNC_LOCAL_STORAGE=1)...');
    assertChildOk(runChild(true), 'no-ALS');

    console.log(' - Control child with ALS enabled...');
    assertChildOk(runChild(false), 'ALS');

    console.log('\n✓ AsyncLock no-ALS fallback tests passed!');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
