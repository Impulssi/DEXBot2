
import { path } from '../../modules/path_api.js';
import { getStorage } from '../../modules/storage/index.js';
import { BUILD_DIR } from '../../modules/constants.js';
import { PATHS } from '../../modules/paths.js';
'use strict';

const storage = getStorage();

function isDexbot2Root(candidate: string) {
  return !!candidate && (
    storage.exists(path.join(candidate, BUILD_DIR, 'dexbot.js')) ||
    storage.exists(path.join(candidate, 'dexbot.js')) ||
    storage.exists(path.join(candidate, 'dexbot.ts'))
  );
}

function findDexbot2Root(startDir?: string) {
  let candidate = path.resolve(startDir || PATHS.PROJECT_ROOT || '');
  for (let i = 0; i < 8; i++) {
    if (isDexbot2Root(candidate)) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      break;
    }
    candidate = parent;
  }
  return path.resolve(startDir || PATHS.PROJECT_ROOT || '');
}

const DEFAULT_ROOT = findDexbot2Root(PATHS.PROJECT_ROOT);

function normalizeRoot(options: Record<string, any> = {}) {
  if (options.profileRoot) {
    const resolved = path.resolve(options.profileRoot);
    let candidate = path.dirname(resolved);
    for (let i = 0; i < 3; i++) {
      if (isDexbot2Root(candidate)) {
        return candidate;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
    // Fall back to one level up (original behavior)
    return path.dirname(resolved);
  }
  return DEFAULT_ROOT;
}

function normalizeProfileDir(options: Record<string, any> = {}) {
  if (options.profileRoot) {
    return path.resolve(options.profileRoot);
  }
  return path.join(DEFAULT_ROOT, 'profiles');
}

function resolveRuntimeScript(root: string, ...segments: string[]) {
  const sourcePath = path.join(root, ...segments);
  if (storage.exists(sourcePath)) {
    return sourcePath;
  }
  return path.join(root, BUILD_DIR, ...segments);
}

export { normalizeRoot, normalizeProfileDir, resolveRuntimeScript }

