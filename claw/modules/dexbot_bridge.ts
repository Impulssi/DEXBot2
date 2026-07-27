
import { path } from '../../modules/path_api';
import { getStorage } from '../../modules/storage';
import { BUILD_DIR } from '../../modules/constants';
import { PATHS } from '../../modules/paths';
import { Config } from '../../modules/config';
const storage = getStorage();

function candidateExists(candidatePath: string) {
  if (storage.exists(candidatePath)) {
    return true;
  }
  if (!path.extname(candidatePath) && storage.exists(`${candidatePath}.js`)) {
    return true;
  }
  if (candidatePath.endsWith('.js') && storage.exists(candidatePath.replace(/\.js$/, '.ts'))) {
    return true;
  }
  return false;
}

function getDexbot2Root() {
  if (Config.DEXBOT2_ROOT) {
    return path.resolve(Config.DEXBOT2_ROOT);
  }

  const repoRoot = PATHS.PROJECT_ROOT;
  if (
    candidateExists(path.join(repoRoot, 'modules', 'order', 'index.js')) ||
    candidateExists(path.join(repoRoot, BUILD_DIR, 'modules', 'order', 'index.js'))
  ) {
    return repoRoot;
  }

  throw new Error('Unable to resolve DEXBot2 root. Set DEXBOT2_ROOT or run from a DEXBot2 checkout.');
}

function resolveDexbot2Path(relativePath: string) {
  const root = getDexbot2Root();
  const normalizedPath = String(relativePath || '');
  const candidates = [path.join(root, normalizedPath)];

  if (normalizedPath.endsWith('.js')) {
    candidates.push(path.join(root, normalizedPath.replace(/\.js$/, '.ts')));
  }

  candidates.push(path.join(root, BUILD_DIR, normalizedPath));

  for (const candidate of candidates) {
    if (candidateExists(candidate)) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1];
}

function requireDexbot2Module(relativePath: string) {
  return require(resolveDexbot2Path(relativePath));
}

function loadDexbotOrderSubsystem() {
  return requireDexbot2Module('modules/order/index.js');
}

function loadDexbotOrderUtils() {
  return loadDexbotOrderSubsystem().utils;
}

function loadDexbotOrderConstants() {
  return loadDexbotOrderSubsystem().constants;
}

function loadDexbotOrderSystemUtils() {
  return requireDexbot2Module('modules/order/utils/system');
}

export { getDexbot2Root, loadDexbotOrderConstants, loadDexbotOrderSubsystem, loadDexbotOrderSystemUtils, loadDexbotOrderUtils, requireDexbot2Module, resolveDexbot2Path }

