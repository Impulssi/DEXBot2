
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
    // No code root found above the profile dir (e.g. a home config like
    // ~/.config/dexbot2/profiles). Spawn from the code location actually
    // running this launcher instead of guessing an unrelated ancestor.
    return DEFAULT_ROOT;
  }
  return DEFAULT_ROOT;
}

function normalizeProfileDir(options: Record<string, any> = {}) {
  if (options.profileRoot) {
    return path.resolve(options.profileRoot);
  }
  // Follow the runtime-resolved profiles dir so the launcher config
  // (launcher.config.json) lives with the rest of user state — including the
  // home default for fresh checkouts / global npm installs.
  return PATHS.PROFILES_DIR;
}

function resolveRuntimeScript(root: string, ...segments: string[]) {
  const sourcePath = path.join(root, ...segments);
  if (storage.exists(sourcePath)) {
    return sourcePath;
  }
  return path.join(root, BUILD_DIR, ...segments);
}

export { normalizeRoot, normalizeProfileDir, resolveRuntimeScript }

