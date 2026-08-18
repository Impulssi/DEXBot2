

import fs from 'node:fs';
import { homedir } from 'node:os';
import { path } from './path_api.js';
import { Config } from './config.js';
import { isDistRuntime } from './utils/build_dir.js';
import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);
const MODULE_DIR = path.dirname(__dirname);
const PROJECT_ROOT = isDistRuntime(MODULE_DIR)
    ? path.dirname(MODULE_DIR)
    : MODULE_DIR;

/**
 * True when running from a globally-installed npm package dir
 * (e.g. <prefix>/lib/node_modules/dexbot). User state must never be
 * written inside the package dir — npm reinstalls/updates wipe it and
 * system prefixes may be read-only. Instead default profiles to the
 * user's home directory, mirroring the EACCES respawn in dexbot.ts.
 */
function isGlobalNpmPackageDir(root: string): boolean {
    return root.split(path.sep).includes('node_modules');
}

function resolveProfilesDir(projectRoot = PROJECT_ROOT): string {
    if (Config.DEXBOT_PROFILE_ROOT) {
        return Config.DEXBOT_PROFILE_ROOT;
    }
    if (Config.DEXBOT2_ROOT) {
        return path.join(Config.DEXBOT2_ROOT, 'profiles');
    }
    let defaultDir = path.join(projectRoot, 'profiles');
    if (isGlobalNpmPackageDir(projectRoot)) {
        const home = homedir();
        if (home) {
            defaultDir = path.join(home, '.config', 'dexbot2', 'profiles');
            console.warn(`[paths] Global npm install detected; using ${defaultDir} for profiles (set DEXBOT_PROFILE_ROOT to override)`);
        }
    }
    const cwdProfiles = path.join(process.cwd(), 'profiles');
    if (defaultDir !== cwdProfiles) {
        const defaultBots = path.join(defaultDir, 'bots.json');
        const cwdBots = path.join(cwdProfiles, 'bots.json');
        if (!fs.existsSync(defaultBots) && fs.existsSync(cwdBots)) {
            console.warn(`[paths] Install profiles not found at ${defaultDir}, falling back to cwd: ${cwdProfiles}`);
            return cwdProfiles;
        }
    }
    return defaultDir;
}

const PROFILES_DIR = resolveProfilesDir();

/**
 * Market adapter data/state dirs. A source checkout ships a top-level
 * market_adapter/ dir, so keep existing behavior (state next to the
 * code). A global npm package only ships compiled dist/market_adapter/,
 * so relocate runtime state under the (already relocatable) profiles dir
 * instead of creating it inside the package dir. Env vars override both.
 */
function resolveMarketAdapterDirs(profilesDir = PROFILES_DIR, projectRoot = PROJECT_ROOT) {
    const sourceDir = path.join(projectRoot, 'market_adapter');
    const useSourceLayout = fs.existsSync(sourceDir);
    const dataRoot = Config.DEXBOT_MARKET_ADAPTER_DATA_DIR
        ? path.resolve(Config.DEXBOT_MARKET_ADAPTER_DATA_DIR)
        : useSourceLayout
            ? path.join(sourceDir, 'data')
            : path.join(profilesDir, 'market_adapter', 'data');
    const stateRoot = Config.DEXBOT_MARKET_ADAPTER_STATE_DIR
        ? path.resolve(Config.DEXBOT_MARKET_ADAPTER_STATE_DIR)
        : useSourceLayout
            ? path.join(sourceDir, 'state')
            : path.join(profilesDir, 'market_adapter', 'state');
    return {
        DIR: useSourceLayout ? sourceDir : path.join(profilesDir, 'market_adapter'),
        DATA_DIR: dataRoot,
        LP_DATA_DIR: path.join(dataRoot, 'lp'),
        STATE_DIR: stateRoot,
        STATE_FILE: path.join(stateRoot, 'market_adapter_state.json'),
        CENTERS_FILE: path.join(stateRoot, 'market_adapter_centers.json'),
        LOCK_FILE: path.join(stateRoot, 'market_adapter.lock'),
    };
}

const MARKET_ADAPTER = resolveMarketAdapterDirs(PROFILES_DIR, PROJECT_ROOT);

/**
 * Claw data dirs. claw/ ships in both source checkouts and npm packages,
 * so use the npm-global detection (not dir existence) to pick the layout:
 * source checkouts keep state next to the code, global npm installs
 * relocate runtime data under the (already relocatable) profiles dir so
 * it is not wiped on `npm update -g dexbot` or blocked by a read-only
 * prefix. DEXBOT_CLAW_DATA_DIR overrides the data root.
 */
function resolveClawDirs(profilesDir = PROFILES_DIR, projectRoot = PROJECT_ROOT) {
    const sourceDir = path.join(projectRoot, 'claw');
    const useSourceLayout = !isGlobalNpmPackageDir(projectRoot);
    const dataRoot = Config.DEXBOT_CLAW_DATA_DIR
        ? path.resolve(Config.DEXBOT_CLAW_DATA_DIR)
        : useSourceLayout
            ? path.join(sourceDir, 'data')
            : path.join(profilesDir, 'claw', 'data');
    return {
        DIR: sourceDir,
        DATA_DIR: dataRoot,
        STATE_DIR: path.join(dataRoot, 'state'),
        POSITIONS_FILE: path.join(dataRoot, 'positions.json'),
        WATCHER_HEALTH_FILE: path.join(dataRoot, 'watcher-health.json'),
        MEMU_DIR: path.join(dataRoot, 'memu'),
        MEMU_RUNNER_SCRIPT: path.join(sourceDir, 'scripts', 'memu_runner.py'),
    };
}

const CLAW = resolveClawDirs(PROFILES_DIR, PROJECT_ROOT);

const PATHS = {
  PROJECT_ROOT,

  PROFILES_DIR,
  PROFILES: {
    BOTS_JSON: path.join(PROFILES_DIR, 'bots.json'),
    GENERAL_SETTINGS_JSON: path.join(PROFILES_DIR, 'general.settings.json'),
    MARKET_PROFILES_JSON: path.join(PROFILES_DIR, 'market_profiles.json'),
    MARKET_ADAPTER_SETTINGS_JSON: path.join(PROFILES_DIR, 'market_adapter_settings.json'),
    KEYS_JSON: (): string => Config.DEXBOT_KEYS_FILE || path.join(PROFILES_DIR, 'keys.json'),
    DAEMON_POLICIES_JSON: path.join(PROFILES_DIR, 'daemon-policies.json'),
    FUND_REGISTRY_JSON: path.join(PROFILES_DIR, 'fund_registry.json'),
    NODE_BLACKLIST_JSON: path.join(PROFILES_DIR, 'node_blacklist.json'),
    NODE_HEALTH_CACHE_JSON: path.join(PROFILES_DIR, 'node_health_cache.json'),
    MARKET_ADAPTER_WHITELIST_JSON: (): string =>
      Config.DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE || path.join(PROFILES_DIR, 'market_adapter_whitelist.json'),
    ECOSYSTEM_CONFIG_JS: path.join(PROFILES_DIR, 'ecosystem.config.cjs'),
    SUPERVISOR_SOCK: path.join(PROFILES_DIR, 'supervisor.sock'),
    MONOLITHIC_PID: path.join(PROFILES_DIR, 'monolithic.pid'),
    MONOLITHIC_BOT_PID: path.join(PROFILES_DIR, 'monolithic-bot.pid'),
    MONOLITHIC_BOT_INFO: path.join(PROFILES_DIR, 'monolithic-bot.json'),
    MONOLITHIC_CRED_PID: path.join(PROFILES_DIR, 'monolithic-cred.pid'),
    NATIVE_VALIDATION_DIR: path.join(PROFILES_DIR, 'native_validation'),
    FEE_CACHE_JSON: path.join(PROFILES_DIR, 'fee_cache.json'),
  },

  LOGS_DIR: path.join(PROFILES_DIR, 'logs'),
  ORDERS_DIR: path.join(PROFILES_DIR, 'orders'),
  CREDIT_RUNTIME_DIR: path.join(PROFILES_DIR, 'credit_runtime'),
  CREDENTIAL_RUN_DIR: path.join(PROFILES_DIR, 'run'),

  MARKET_ADAPTER,

  CLAW,

  ANALYSIS: {
    CHARTS_DIR: path.join(PROJECT_ROOT, 'analysis', 'charts'),
  },
};

function getNodeBlacklistFile(stateDir?: string): string {
  return stateDir
    ? path.join(stateDir, 'node_blacklist.json')
    : PATHS.PROFILES.NODE_BLACKLIST_JSON;
}

function getNodeHealthCacheFile(stateDir?: string): string {
  return stateDir
    ? path.join(stateDir, 'node_health_cache.json')
    : PATHS.PROFILES.NODE_HEALTH_CACHE_JSON;
}

function getRecalculateTriggerFile(botKey: string): string {
  return path.join(PATHS.PROFILES_DIR, `recalculate.${botKey}.trigger`);
}

export { PATHS, resolveProfilesDir, resolveMarketAdapterDirs, resolveClawDirs, isGlobalNpmPackageDir, getNodeBlacklistFile, getNodeHealthCacheFile, getRecalculateTriggerFile }

