'use strict';

import { path } from '../../modules/path_api.js';
import { getStorage } from '../../modules/storage/index.js';
import { PATHS } from '../../modules/paths.js';

const storage = getStorage();

function findLatestLpData(options: any = {}) {
    const dataDir = options.dataDir ? path.resolve(options.dataDir) : PATHS.MARKET_ADAPTER.LP_DATA_DIR;
    const out: any[] = [];

    if (!storage.exists(dataDir)) return null;
    const stack: string[] = [dataDir];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let names: string[] = [];
        try {
            names = storage.readdir(dir);
        } catch (_: any) {
            // Directory vanished or is unreadable — skip it instead of
            // aborting the whole scan.
            continue;
        }
        for (const name of names) {
            const full = path.join(dir, name);
            let stat: any = null;
            try {
                stat = storage.stat(full);
            } catch (_: any) {
                // Dangling symlink or race-deleted entry — skip the entry.
                continue;
            }
            if (stat.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!stat.isFile() || !name.endsWith('.json')) continue;
            if (!name.startsWith('lp_pool_')) continue;
            out.push({ path: full, mtime: stat.mtimeMs });
        }
    }

    out.sort((a, b) => b.mtime - a.mtime);
    return out.length > 0 ? out[0].path : null;
}

export { findLatestLpData }

