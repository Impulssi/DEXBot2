const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createMarketAdapterRuntime, isLockStale } = require('../modules/launcher/market_adapter_runtime');
const { unlink: safeUnlink, writeJSON } = require('../modules/storage').getStorage();

console.log('Running market adapter runtime tests');

function createChild() {
    const handlers: any = {};
    const child = {
        killed: false,
        exitCode: null,
        signalCode: null,
        killCount: 0,
        once(eventName, handler) {
            handlers[eventName] = handler;
        },
        kill() {
            this.killed = true;
            this.exitCode = 0;
            this.killCount += 1;
            this.emitClose(0, null);
        },
        emitClose(code, signal = null) {
            this.exitCode = code;
            this.signalCode = signal;
            if (handlers.close) {
                handlers.close(code, signal);
            }
        },
    };
    return child;
}

async function testStopAndReleaseDoNotSpawn() {
    const spawned = [];
    const runtime = createMarketAdapterRuntime({
        lockFile: '/tmp/dexbot2-test-missing-market-adapter.lock',
        spawnFn: () => {
            const child = createChild();
            spawned.push(child);
            return child;
        },
        buildEnv: () => ({}),
    });

    await runtime.syncBot('ama-bot', true);
    await runtime.syncBot('book-bot', true);
    assert.strictEqual(spawned.length, 1, 'initial required bot should spawn once');

    const stopped = await runtime.syncBot('book-bot', false);
    assert.strictEqual(spawned.length, 1, 'removing one desired bot must not spawn a replacement');
    assert.strictEqual(stopped.running, true, 'adapter should keep running while another desired bot remains');

    spawned[0].killed = true;
    spawned[0].exitCode = 0;

    const releaseResult = await runtime.releaseBot('book-bot');
    assert.strictEqual(spawned.length, 1, 'release must not restart a missing child');
    assert.strictEqual(releaseResult.running, false, 'release should report no owned process when child is gone');
}

async function testSignalExitedChildRestartsOnNextRequiredSync() {
    const spawned = [];
    const runtime = createMarketAdapterRuntime({
        lockFile: '/tmp/dexbot2-test-signal-exited-market-adapter.lock',
        spawnFn: () => {
            const child = createChild();
            spawned.push(child);
            return child;
        },
        buildEnv: () => ({}),
    });

    await runtime.syncBot('ama-bot', true);
    assert.strictEqual(spawned.length, 1, 'first required sync should spawn the adapter');

    spawned[0].emitClose(null, 'SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    const restarted = await runtime.syncBot('ama-bot', true);
    assert.strictEqual(spawned.length, 2, 'signal-exited child should be replaced on the next required sync');
    assert.strictEqual(restarted.started, true, 'required sync should report adapter restart');
    assert.strictEqual(runtime.getStatus().hasOwnedChild, true, 'runtime should track the replacement child as active');
}

async function testStartRemovesConfiguredStaleLock() {
    const lockFile = path.join('/tmp', `dexbot2-market-adapter-runtime-${process.pid}.lock`);
    safeUnlink(lockFile)
    writeJSON(lockFile, { pid: -1 }, { mode: 0o600 });

    const runtime = createMarketAdapterRuntime({
        lockFile,
        spawnFn: () => createChild(),
        buildEnv: () => ({}),
    });

    await runtime.syncBot('ama-bot', true);
    assert.strictEqual(fs.existsSync(lockFile), false, 'start should remove the configured stale lock file');
}

function writeStaleLock(lockFile, pid) {
    safeUnlink(lockFile)
    writeJSON(lockFile, { pid }, { mode: 0o600 });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);
}

async function testLiveAdapterStaleMtimeIsNotRemovable() {
    const lockFile = path.join('/tmp', `dexbot2-market-adapter-runtime-live-adapter-${process.pid}.lock`);
    writeStaleLock(lockFile, 12345);

    assert.strictEqual(
        isLockStale(lockFile, 1000, (pid) => pid === 12345),
        false,
        'live market adapter lock must not be removable solely because mtime is old'
    );
    safeUnlink(lockFile)
}

async function testLiveNonAdapterStaleLockIsRemovable() {
    const lockFile = path.join('/tmp', `dexbot2-market-adapter-runtime-live-non-adapter-${process.pid}.lock`);
    writeStaleLock(lockFile, 12345);

    assert.strictEqual(
        isLockStale(lockFile, 1000, () => false),
        true,
        'live non-adapter lock should be removable'
    );
    safeUnlink(lockFile)
}

async function main() {
    await testStopAndReleaseDoNotSpawn();
    await testSignalExitedChildRestartsOnNextRequiredSync();
    await testStartRemovesConfiguredStaleLock();
    await testLiveAdapterStaleMtimeIsNotRemovable();
    await testLiveNonAdapterStaleLockIsRemovable();
    console.log('market adapter runtime tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
