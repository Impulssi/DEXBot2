
import { getStorage } from '../../modules/storage';
'use strict';

const storage = getStorage();

/**
 * Write JSON atomically via the unified StorageAdapter.
 */
function writeJsonAtomic(targetPath: any, data: any, options: any = {}) {
    storage.writeJSON(targetPath, data, options);
}

export { writeJsonAtomic }

