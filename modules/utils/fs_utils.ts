/**
 * Backward-compatibility re-exports from the unified StorageAdapter.
 *
 * All new code should import directly from `modules/storage`:
 *   const storage = require('../storage').getStorage();
 *   storage.readJSON(...) / storage.writeJSON(...) / storage.exists(...)
 */



import { getStorage } from '../storage';
const storage: any = getStorage();

function readJSON<T = any>(filePath: string): T {
    return storage.readJSON(filePath);
}

function writeJSON(filePath: string, data: any, options?: { mode?: number }): void {
    storage.writeJSON(filePath, data, options);
}

function ensureDir(dirPath: string, options?: { mode?: number }): void {
    storage.ensureDir(dirPath, options);
}

function safeUnlink(filePath: string): void {
    storage.unlink(filePath);
}

function exists(filePath: string): boolean {
    return storage.exists(filePath);
}

export { readJSON, writeJSON, ensureDir, safeUnlink, exists }

