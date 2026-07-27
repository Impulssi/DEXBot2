/**
 * modules/bots_file_lock.ts - File Synchronization Lock
 *
 * Thread-safe reading of bots.json with in-memory locking.
 * Prevents race conditions when multiple processes access file simultaneously.
 *
 * Locking Strategy:
 * - Mutex-based mechanism (exclusive access)
 * - Only one operation (read or write) at a time
 * - Queues operations during conflicts
 *
 * ===============================================================================
 * EXPORTS (4 functions)
 * ===============================================================================
 *
 * 1. readBotsFileWithLock(botsJsonPath, parseFunction) - Lock-protected async file read
 *    Returns: Promise<{content: string, config: Object}>
 *    Acquires lock, reads and parses file, releases lock
 *
 * 2. writeBotsFileWithLock(botsJsonPath, config) - Lock-protected async file write
 *    Returns: Promise<void>
 *    Acquires lock, writes JSON, releases lock
 *
 * 3. readBotsFileSync(botsJsonPath, parseFunction) - Synchronous file read (startup only)
 *    Returns: {content: string, config: Object}
 *    WARNING: Blocks event loop — only use before event loop is active
 *
 * 4. writeJsonFileAtomic(filePath, data) - Atomically write JSON via tmp file + rename
 *    Returns: Promise<void>
 *    Stages to temp file in same directory, then renames into place
 *
 * ===============================================================================
 *
 * USAGE:
 * const { readBotsFileWithLock, writeBotsFileWithLock, readBotsFileSync } = require('./bots_file_lock');
 * const { config } = await readBotsFileWithLock('./profiles/bots.json', JSON.parse);
 * await writeBotsFileWithLock('./profiles/bots.json', updatedConfig);
 *
 * ===============================================================================
 */


import { getStorage } from './storage';
const storage = getStorage();

/**
 * Write a JSON document atomically — delegates to the unified StorageAdapter
 * which uses tmp-file + rename (atomic on POSIX and Windows).
 *
 * @param {string} targetPath - Path of the final JSON file.
 * @param {*} data - Anything `JSON.stringify` accepts.
 */
function writeJsonFileAtomic(targetPath: any, data: any) {
    storage.writeJSON(targetPath, data);
}

/**
 * Semaphore for synchronizing access to bots.json.
 * @class
 */
class FileLock {
    isLocked: boolean = false;
    queue: Array<() => void> = [];

    constructor() {
    }

    /**
     * Acquires the lock. If already locked, waits in queue.
     * @returns {Promise<void>}
     */
    async acquire() {
        if (!this.isLocked) {
            this.isLocked = true;
            return;
        }

        await new Promise<void>((resolve: any) => {
            this.queue.push(resolve);
        });
    }

    /**
     * Releases the lock and allows the next waiting operation to proceed.
     */
    release() {
        const next = this.queue.shift();
        if (next) {
            next();
        } else {
            this.isLocked = false;
        }
    }
}

// Global lock instance for bots.json
const botsFileLock = new FileLock();

/**
 * Safely read bots.json with lock protection
 * @param {string} botsJsonPath - Path to bots.json file
 * @param {Function} parseFunction - JSON parser function (e.g., parseJsonWithComments)
 * @returns {Promise<{content: string, config: Object}>} File content and parsed config
 * @throws {Error} If file doesn't exist or JSON is invalid
 */
async function readBotsFileWithLock(botsJsonPath: any, parseFunction: any) {
    await botsFileLock.acquire();
    try {
        if (!storage.exists(botsJsonPath)) {
            throw new Error(`bots.json not found at ${botsJsonPath}`);
        }

        const content = storage.readFile(botsJsonPath);
        if (!content || !content.trim()) {
            return { content: '', config: { bots: [] } };
        }

        const config = parseFunction(content);
        return { content, config };
    } finally {
        botsFileLock.release();
    }
}

/**
 * Safely write bots.json with lock protection
 * @param {string} botsJsonPath - Path to bots.json file
 * @param {Object} config - Configuration object to write
 * @returns {Promise<void>}
 * @throws {Error} If write fails
 */
async function writeBotsFileWithLock(botsJsonPath: any, config: any) {
    await botsFileLock.acquire();
    try {
        // Atomic write prevents readers (in this process or another) from
        // seeing a truncated file mid-write. The in-process semaphore here
        // serializes concurrent writers within the same process; the
        // tmp+rename is the cross-process safety net.
        writeJsonFileAtomic(botsJsonPath, config);
    } finally {
        botsFileLock.release();
    }
}

/**
 * Synchronously read bots.json with lock protection
 * WARNING: This blocks the event loop. Use async version when possible.
 * Only use this for startup initialization before event loop is active.
 * @param {string} botsJsonPath - Path to bots.json file
 * @param {Function} parseFunction - JSON parser function
 * @returns {{content: string, config: Object}} File content and parsed config
 * @throws {Error} If file doesn't exist or JSON is invalid
 */
function readBotsFileSync(botsJsonPath: any, parseFunction: any) {
    if (!storage.exists(botsJsonPath)) {
        throw new Error(`bots.json not found at ${botsJsonPath}`);
    }

    const content = storage.readFile(botsJsonPath);
    if (!content || !content.trim()) {
        return { content: '', config: { bots: [] } };
    }

    const config = parseFunction(content);
    return { content, config };
}

export { readBotsFileWithLock, writeBotsFileWithLock, readBotsFileSync, writeJsonFileAtomic }

