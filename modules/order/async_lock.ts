/**
 * modules/order/async_lock.ts - AsyncLock Engine
 *
 * Distributed mutual exclusion for async operations.
 * Exports a single AsyncLock class that prevents concurrent execution of critical sections.
 *
 * Solves the Time-of-Check vs Time-of-Use (TOCTOU) race condition
 * where checking a flag and setting it are not atomic operations.
 *
 * In JavaScript async code, multiple callbacks can interleave between
 * check and set operations. This lock ensures only one caller can
 * enter a critical section at a time, with fair FIFO queueing.
 *
 * Usage:
 *   const lock = new AsyncLock();
 *
 *   const result = await lock.acquire(async () => {
 *       // Critical section - guaranteed only one execution at a time
 *       // Even if other callers check lock while this runs, they will wait
 *       return someAsyncOperation();
 *   });
 *
 * ===============================================================================
 * TABLE OF CONTENTS - AsyncLock Class (6 methods)
 * ===============================================================================
 *
 * INITIALIZATION (1 method)
 *   1. constructor() - Create new AsyncLock with empty queue and unlocked state
 *
 * LOCK ACQUISITION (1 method)
 *   2. acquire(callback) - Acquire lock and execute callback exclusively (async)
 *      Returns promise that resolves with callback result
 *      Queues request if lock is already held, processes in FIFO order
 *
 * QUEUE PROCESSING (1 method - internal)
 *   3. _processQueue() - Process queued callbacks one at a time (async, internal)
 *      Marks as locked, executes callback, handles errors, unlocks, processes next
 *      Recursive: processes next item after each callback completes
 *
 * STATUS QUERIES (3 methods)
 *   4. isLocked() - Check if lock is currently acquired
 *   5. getQueueLength() - Get number of operations waiting for lock
 *   6. clearQueue() - Reject and discard all pending queued operations
 *      Returns: number of operations that were cleared
 *      Does NOT stop the currently executing operation
 *
 * ===============================================================================
 *
 * RACE CONDITION PREVENTION:
 * Problem: Check-then-act is not atomic in async code:
 *   if (!locked) {
 *       locked = true;  // <-- Another callback can run here!
 *       doWork();
 *   }
 *
 * Solution: FIFO queue with exclusive execution:
 *   1. Queue callback and handlers
 *   2. Set _locked = true (prevents concurrent entry)
 *   3. Execute callback (guaranteed alone)
 *   4. Set _locked = false and process next queued item
 *
 * REENTRANCY WARNING:
 * This lock is NOT reentrant. If a function holding the lock attempts to
 * acquire it again (nested call), it will DEADLOCK as the second request
 * will wait forever in the queue for the first one to release it.
 *
 * CRITICAL INVARIANTS:
 * - _locked = true ONLY if callback is currently executing
 * - At most one callback in "await callback()" at any time
 * - All queued callbacks are guaranteed exclusive access
 * - If _locked = false and queue is empty, no operations pending
 *
 * ===============================================================================
 *
 * @class
 */

interface QueueItem<T = unknown> {
    callback: () => Promise<T>;
    cancelToken?: { isCancelled: boolean };
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
}

interface AsyncLockOptions {
    timeout?: number;
    level?: number;
}

interface AcquireOptions {
    timeout?: number;
    cancelToken?: { isCancelled: boolean };
    level?: number;
}

class AsyncLock {
    private _queue: QueueItem<any>[];
    private _locked: boolean;
    private _defaultTimeout: number | null;
    private _level: number;

    constructor(options: AsyncLockOptions = {}) {
        this._queue = [];
        this._locked = false;
        this._defaultTimeout = options.timeout || null;
        this._level = options.level ?? 0;
    }

    /**
     * Acquire the lock and execute callback exclusively
     * @param {Function} callback - Async function to execute exclusively
     * @param {Object} [options] - Optional settings
     * @param {number} [options.timeout] - Optional timeout in ms for waiting in queue
     * @param {Object} [options.cancelToken] - Optional object with 'isCancelled' property
     * @returns {Promise} Result of callback execution
     */
    async acquire<T>(callback: () => Promise<T>, options: AcquireOptions = {}): Promise<T> {
        const timeout = options.timeout || this._defaultTimeout;
        const cancelToken = options.cancelToken;

        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;

            const item = {
                callback,
                cancelToken,
                resolve: (val: T) => {
                    if (timer) {
                        clearTimeout(timer);
                        timer = undefined;
                    }
                    resolve(val);
                },
                reject: (err: unknown) => {
                    if (timer) {
                        clearTimeout(timer);
                        timer = undefined;
                    }
                    reject(err);
                }
            };

            if (timeout) {
                timer = setTimeout(() => {
                    const index = this._queue.indexOf(item);
                    if (index !== -1) {
                        this._queue.splice(index, 1);
                        item.reject(new Error(`Lock acquisition timeout after ${timeout}ms`));
                    }
                }, timeout);
            }

            this._queue.push(item);
            this._processQueue();
        });
    }

    /**
     * Process queued callbacks one at a time
     * @private
     */
    private async _processQueue(): Promise<void> {
        // If already locked, another call is executing, wait
        if (this._locked || this._queue.length === 0) {
            return;
        }

        // Mark as locked to prevent concurrent processing
        this._locked = true;

        const { callback, resolve, reject, cancelToken } = this._queue.shift();

        // If operation was cancelled while in queue, skip it
        if (cancelToken && cancelToken.isCancelled) {
            this._locked = false;
            reject(new Error('Lock acquisition cancelled (timeout)'));
            // Process next item immediately
            return this._processQueue();
        }

        try {
            // Execute the callback (guaranteed to be alone)
            const result = await callback();
            resolve(result);
        } catch (err: any) {
            reject(err);
        } finally {
            // Unlock and process next item in queue
            this._locked = false;
            this._processQueue();
        }
    }

    /**
     * Check if lock is currently acquired
     * @returns {boolean}
     */
    isLocked(): boolean {
        return this._locked;
    }

    /**
     * Get number of operations waiting for lock
     * @returns {number}
     */
    getQueueLength(): number {
        return this._queue.length;
    }

    /**
     * Clear all pending operations in the queue.
     * Does NOT stop the currently executing operation if it is already locked.
     * @returns {number} Count of cleared items
     */
    clearQueue(): number {
        const count = this._queue.length;
        while (this._queue.length > 0) {
            const { reject } = this._queue.shift();
            reject(new Error('Lock queue cleared'));
        }
        return count;
    }

    /**
     * Force-release the lock and clear all queued operations.
     * Unlike clearQueue() which keeps the lock held, this resets both
     * the locked state AND the queue. Use when an operation has timed out
     * but the underlying callback may still be running — subsequent
     * acquirers will be allowed in while the stale callback eventually
     * completes and finds the lock already free.
     *
     * SCOPE NOTE: forceRelease is currently only wired for _syncLock
     * (see Gap 3 in sync_engine.ts). The same stuck-callback-in-lock
     * scenario applies to _fillProcessingLock, _divergenceLock, and
     * _gridLock. If future issues show permanent lock-hold on those,
     * apply the same forceRelease pattern used in synchronizeWithChain:
     * a grace-period timeout that calls forceRelease if the lock is
     * still held after the callback should have completed.
     * @returns {number} Count of cleared items
     */
    forceRelease(): number {
        const count = this._queue.length;
        while (this._queue.length > 0) {
            const { reject } = this._queue.shift();
            reject(new Error('Lock force-released'));
        }
        this._locked = false;
        return count;
    }
}

export = AsyncLock;
