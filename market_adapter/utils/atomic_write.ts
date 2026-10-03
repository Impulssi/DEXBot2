'use strict';

import { getStorage } from '../../modules/storage/index.js';
import type { UnknownRecord } from '../../modules/types.js';

const storage = getStorage();

interface AtomicWriteOptions {
    mode?: number;
    fsync?: boolean;
    tmpPrefix?: string;
    flag?: 'w' | 'wx';
}

/**
 * Write JSON atomically via the unified StorageAdapter.
 */
function writeJsonAtomic(targetPath: string, data: UnknownRecord, options: AtomicWriteOptions = {}): void {
    storage.writeJSON(targetPath, data, options);
}

export { writeJsonAtomic }
