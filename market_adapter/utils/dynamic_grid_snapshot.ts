
import { path } from '../../modules/path_api.js';
import { writeJsonAtomic } from './atomic_write.js';
import { acquirePathLockSync, releaseFileLockSync } from './file_lock.js';
import { getStorage } from '../../modules/storage/index.js';
const { ensureDir, readJSON } = getStorage();
'use strict';


function readJsonOrNull(filePath: any) {
    try {
        return readJSON(filePath);
    } catch (_: any) {
        return null;
    }
}

function writeJsonAtomicSync(filePath: any, payload: any) {
    writeJsonAtomic(filePath, payload);
}

function updateDynamicGridSnapshotSync(filePath: any, mutator: any, options: any = {}) {
    if (typeof mutator !== 'function') {
        throw new TypeError('updateDynamicGridSnapshotSync requires a mutator function');
    }

    ensureDir(path.dirname(filePath));
    const lock = acquirePathLockSync(filePath, options.lock || {});
    try {
        const previous = readJsonOrNull(filePath);
        const result = mutator(previous);
        if (!result || result.write === false) {
            return {
                ok: result?.ok !== false,
                written: false,
                previous,
                snapshot: previous,
            };
        }

        const snapshot = result.snapshot || result;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
            return {
                ok: false,
                written: false,
                previous,
                snapshot: previous,
            };
        }

        writeJsonAtomicSync(filePath, snapshot);
        return {
            ok: true,
            written: true,
            previous,
            snapshot,
        };
    } finally {
        releaseFileLockSync(lock);
    }
}

export { readJsonOrNull, writeJsonAtomicSync, updateDynamicGridSnapshotSync }

