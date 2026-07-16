'use strict';

const { getStorage } = require('../../modules/storage');
const storage = getStorage();

/**
 * Write JSON atomically via the unified StorageAdapter.
 */
function writeJsonAtomic(targetPath, data, options = {}) {
    storage.writeJSON(targetPath, data, options);
}

export = {
    writeJsonAtomic,
};
