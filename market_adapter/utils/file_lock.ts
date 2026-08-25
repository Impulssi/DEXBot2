import { getStorage } from '../../modules/storage/index.js';
import { getProcessDiscovery } from '../../modules/process_discovery.js';
import { runtime } from '../../modules/runtime.js';
const storage = getStorage();
const { readJSON, unlink: safeUnlink } = storage;

function _lockOwnerId(): number | string {
    if (runtime.pid > 0) {
        return runtime.pid;
    }
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    return `lock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadLockInfo(lockPath: any) {
    try {
        const parsed = readJSON(lockPath);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_: any) {
        return {};
    }
}

function isLikelyMarketAdapterProcess(pid: any) {
    if (!getProcessDiscovery().isAlive(pid)) return false;
    const cmdline = getProcessDiscovery().readCmdline(pid);
    if (!cmdline) return false;
    return cmdline.includes('node') && /market_adapter\/market_adapter\.(?:js|ts)\b/.test(cmdline);
}

function sleepSync(ms: any) {
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
}

function sleepAsync(ms: any) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function _isLockStaleOrDead(lockPath: any, staleMs: any, now: any, aliveCheck: any) {
    let stat = null;
    try {
        stat = storage.stat(lockPath);
    } catch (_: any) {
        return true;
    }
    if ((now - stat.mtimeMs) > staleMs) return true;
    if (aliveCheck) {
        const info = loadLockInfo(lockPath);
        const pid = Number(info.pid);
        // Non-numeric owner ids (UUID fallback when runtime.pid is unusable)
        // cannot be liveness-checked — treat the holder as alive rather than
        // stealing a lock we cannot verify.
        if (!Number.isInteger(pid) || pid <= 0) return false;
        if (!aliveCheck(pid)) return true;
    }
    return false;
}

/**
 * Shared file-lock primitive.
 *
 * Collapses the previous three lock variants (market-adapter lifecycle lock,
 * per-path short-lived lock, async per-path lock) into one EEXIST / stale-mtime
 * / unlink / retry loop. Behavior is parameterized via opts:
 *
 *   staleMs          - lock age (mtime) after which a lock is considered stale
 *   timeoutMs        - hard deadline; default Infinity (bounded by maxAttempts)
 *   retryMs          - sleep between failed attempts (0 = busy retry)
 *   maxAttempts      - cap on attempts (default Infinity)
 *   contention       - 'throw' | 'wait' when a fresh live lock is found
 *   aliveCheck       - fn(pid) => boolean; when false the lock may be stolen
 *   heartbeatMs      - if > 0, keep the lock mtime fresh on an interval
 *   buildPayload     - fn() => object written into the lock file
 *   alreadyRunningMsg / timeoutMsg - error message string, or fn() => string
 *                      (evaluated lazily at throw time, so e.g. the pid is read
 *                      from the lock file only when contention is actually hit)
 */
function _acquireLockCore(lockPath: any, opts: any = {}) {
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : Infinity;
    const retryMs = Number.isFinite(opts.retryMs) && opts.retryMs > 0 ? opts.retryMs : 0;
    const maxAttempts = Number.isFinite(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : Infinity;
    const contention = opts.contention === 'wait' ? 'wait' : 'throw';
    const aliveCheck = typeof opts.aliveCheck === 'function' ? opts.aliveCheck : null;
    const heartbeatMs = Number.isFinite(opts.heartbeatMs) && opts.heartbeatMs > 0 ? opts.heartbeatMs : 0;
    const buildPayload = typeof opts.buildPayload === 'function'
        ? opts.buildPayload
        : () => ({ pid: _lockOwnerId(), at: Date.now() });
    const resolveRunningMsg = typeof opts.alreadyRunningMsg === 'function'
        ? opts.alreadyRunningMsg
        : () => (opts.alreadyRunningMsg || `already locked: ${lockPath}`);
    const timeoutMsg = opts.timeoutMsg || `Could not acquire lock on ${lockPath} within ${timeoutMs}ms`;

    const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : Infinity;
    let attempts = 0;

    while (attempts < maxAttempts && Date.now() < deadline) {
        let fd: number | null = null;
        try {
            fd = storage.open(lockPath, 'wx');
            storage.write(fd, `${JSON.stringify(buildPayload(), null, 2)}\n`);
            let heartbeat: any = null;
            if (heartbeatMs > 0) {
                heartbeat = setInterval(() => {
                    try {
                        const ts = new Date();
                        storage.utimes(lockPath, ts, ts);
                    } catch (_: any) {}
                }, heartbeatMs);
                if (typeof heartbeat.unref === 'function') heartbeat.unref();
            }
            return { fd, lockPath, heartbeat };
        } catch (err: any) {
            if (fd !== null) {
                try { storage.close(fd); } catch (_: any) {}
            }
            if (err.code !== 'EEXIST') throw err;

            attempts++;
            if (_isLockStaleOrDead(lockPath, staleMs, Date.now(), aliveCheck)) {
                safeUnlink(lockPath);
                if (retryMs > 0) sleepSync(retryMs);
                continue;
            }
            if (contention === 'wait') {
                if (retryMs > 0) sleepSync(retryMs);
                continue;
            }
            throw new Error(resolveRunningMsg());
        }
    }

    throw new Error(timeoutMsg);
}

async function _acquireLockCoreAsync(lockPath: any, opts: any = {}) {
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
    const retryMs = Number.isFinite(opts.retryMs) && opts.retryMs > 0 ? opts.retryMs : 50;
    const aliveCheck = typeof opts.aliveCheck === 'function' ? opts.aliveCheck : null;
    const buildPayload = typeof opts.buildPayload === 'function'
        ? opts.buildPayload
        : () => ({ pid: _lockOwnerId(), at: Date.now() });
    const resolveRunningMsg = typeof opts.alreadyRunningMsg === 'function'
        ? opts.alreadyRunningMsg
        : () => (opts.alreadyRunningMsg || `already locked: ${lockPath}`);
    const timeoutMsg = opts.timeoutMsg || `Could not acquire lock on ${lockPath} within ${timeoutMs}ms`;

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            storage.writeJSON(lockPath, buildPayload(), { flag: 'wx' });
            return () => {
                storage.unlink(lockPath);
            };
        } catch (err: any) {
            if (err.code !== 'EEXIST') throw err;
            if (_isLockStaleOrDead(lockPath, staleMs, Date.now(), aliveCheck)) {
                try {
                    storage.unlink(lockPath);
                    storage.writeJSON(lockPath, buildPayload(), { flag: 'wx' });
                    return () => {
                        storage.unlink(lockPath);
                    };
                } catch {
                    // Another writer beat us — fall through and retry
                }
                await sleepAsync(retryMs);
                continue;
            }
            if (aliveCheck) {
                throw new Error(resolveRunningMsg());
            }
            await sleepAsync(retryMs);
        }
    }

    throw new Error(timeoutMsg);
}

/**
 * Market-adapter lifecycle lock: long stale window + heartbeat + process-aware
 * ownership check, so a live adapter lock is never stolen by a newer process.
 */
function acquireFileLockSync(lockPath: any, opts: any = {}) {
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : (6 * 3600 * 1000);
    return _acquireLockCore(lockPath, {
        staleMs,
        maxAttempts: 2,
        retryMs: 0,
        contention: 'throw',
        heartbeatMs: Math.max(30000, Math.floor(staleMs / 2)),
        aliveCheck: isLikelyMarketAdapterProcess,
        buildPayload: () => ({ pid: _lockOwnerId(), createdAt: new Date().toISOString() }),
        // Evaluated lazily at throw time so the reported pid reflects the lock
        // holder at the moment contention is detected, not the state when this
        // function was first called (loadLockInfo tolerates a missing lock file).
        alreadyRunningMsg: () => `market adapter already running (lock: ${lockPath}, pid: ${loadLockInfo(lockPath).pid})`,
        timeoutMsg: `cannot acquire lock: ${lockPath}`,
    });
}

function releaseFileLockSync(lock: any) {
    if (!lock) return;
    try { if (lock.heartbeat) clearInterval(lock.heartbeat); } catch (_: any) {}
    try { if (typeof lock.fd === 'number') storage.close(lock.fd); } catch (_: any) {}
    if (lock.lockPath) safeUnlink(lock.lockPath)
}

/**
 * Short-lived per-path lock (e.g. dynamic grid snapshots): waits for the holder
 * to release (or for the lock to go stale) up to timeoutMs.
 */
function acquirePathLockSync(filePath: any, opts: any = {}) {
    const lockPath = `${filePath}.lock`;
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
    const retryMs = Number.isFinite(opts.retryMs) && opts.retryMs > 0 ? opts.retryMs : 50;
    const lock = _acquireLockCore(lockPath, {
        staleMs,
        timeoutMs,
        retryMs,
        contention: 'wait',
        buildPayload: () => ({ pid: _lockOwnerId(), at: Date.now() }),
        timeoutMsg: `Could not acquire lock on ${filePath} within ${timeoutMs}ms`,
    });
    return { fd: lock.fd, lockPath: lock.lockPath };
}

async function acquireFileLock(filePath: any, opts: any = {}) {
    const lockPath = `${filePath}.lock`;
    const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : 30000;
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;
    return _acquireLockCoreAsync(lockPath, {
        staleMs,
        timeoutMs,
        contention: 'wait',
        timeoutMsg: `Could not acquire lock on ${filePath} within ${timeoutMs}ms`,
    });
}

export { acquireFileLockSync, releaseFileLockSync, acquirePathLockSync, acquireFileLock };
