'use strict';

import { path } from '../../modules/path_api.js';
import { writeJsonAtomic } from './atomic_write.js';
import { acquirePathLockSync, releaseFileLockSync } from './file_lock.js';
import { getStorage } from '../../modules/storage/index.js';
import type { UnknownRecord } from '../../modules/types.js';
const { ensureDir, readJSON } = getStorage();

interface SnapshotMutationResult {
    write?: boolean;
    ok?: boolean;
    snapshot?: unknown;
    [key: string]: unknown;
}

interface UpdateSnapshotOptions {
    lock?: unknown;
}

function readJsonOrNull(filePath: string): unknown {
    try {
        return readJSON(filePath);
    } catch (_) {
        return null;
    }
}

function updateDynamicGridSnapshotSync(
    filePath: string,
    mutator: (previous: unknown) => SnapshotMutationResult | null | undefined,
    options: UpdateSnapshotOptions = {},
) {
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

        writeJsonAtomic(filePath, snapshot as UnknownRecord);
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

export { updateDynamicGridSnapshotSync }

