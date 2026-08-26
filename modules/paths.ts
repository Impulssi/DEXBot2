

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
 * True when running from an npm package dir (e.g. <prefix>/lib/node_modules/
 * dexbot). The package dir must be a DIRECT child of a `node_modules` dir —
 * a substring match would also flag nested paths (e.g. a package living
 * inside another package's tree) as npm installs. User state must never be
 * written inside the package dir — npm reinstalls/updates wipe it and
 * system prefixes may be read-only.
 */
function isGlobalNpmPackageDir(root: string): boolean {
    return path.basename(path.dirname(root)) === 'node_modules';
}

/**
 * Well-known files that mark a profiles dir as populated. Any one suffices —
 * not just bots.json: a claw-only / keys-only user (keys.json, launcher
 * config, settings) must not be treated as "fresh" and silently switched to a
 * different profiles dir, which would orphan their keys/settings/mode.
 */
const PROFILE_STATE_MARKERS = [
    'bots.json',
    'keys.json',
    'general.settings.json',
    'market_profiles.json',
    'market_adapter_settings.json',
    'daemon-policies.json',
    'fund_registry.json',
    'launcher.config.json',
] as const;

function hasProfileState(dir: string): boolean {
    return PROFILE_STATE_MARKERS.some((name) => fs.existsSync(path.join(dir, name)));
}

/** True when a directory tree contains at least one file (any depth). */
function dirHasState(dir: string): boolean {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) return true;
            if (entry.isDirectory() && dirHasState(path.join(dir, entry.name))) return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * User-level config home: XDG_CONFIG_HOME when set (snapshot via Config),
 * else ~/.config. All user state roots derive from this single constant so
 * npm installs, source checkouts, and overrides agree on one location.
 */
const HOME_CONFIG_DIR = path.join(
    Config.XDG_CONFIG_HOME && Config.XDG_CONFIG_HOME.trim()
        ? path.resolve(Config.XDG_CONFIG_HOME)
        : path.join(homedir(), '.config'),
    'dexbot2'
);

/** Default profiles dir under the user config home (~/.config/dexbot2/profiles). */
const HOME_PROFILES_DIR = path.join(HOME_CONFIG_DIR, 'profiles');

/**
 * Resolve the profiles (user state) directory.
 *
 * Priority:
 * 1. DEXBOT_PROFILE_ROOT (explicit override)
 * 2. DEXBOT2_ROOT (legacy env var → <root>/profiles)
 * 3. ~/.config/dexbot2/profiles — the default for ALL installs, so user
 *    state lives outside the repo/package tree, survives re-clones and
 *    `npm update -g`, and is never wiped by package reinstalls. Mirrors
 *    the EACCES respawn fallback in dexbot.ts.
 *
 * Legacy migration: until a home config exists, a source checkout with a
 * populated profiles dir (repo or cwd) keeps its current location so
 * existing state is not abandoned. The repo fallback is skipped for global
 * npm packages — their dir must never hold user state.
 */
function resolveProfilesDir(projectRoot = PROJECT_ROOT): string {
    if (Config.DEXBOT_PROFILE_ROOT) {
        return Config.DEXBOT_PROFILE_ROOT;
    }
    if (Config.DEXBOT2_ROOT) {
        return path.join(Config.DEXBOT2_ROOT, 'profiles');
    }

    const homeDir = HOME_PROFILES_DIR;
    const repoDir = path.join(projectRoot, 'profiles');
    const cwdDir = path.join(process.cwd(), 'profiles');

    // An existing home config is authoritative — the user has migrated.
    if (homeDir && hasProfileState(homeDir)) {
        return homeDir;
    }

    // Legacy migration: keep a populated repo/cwd profiles dir until the
    // user has a home config. Never fall back into a global npm package dir.
    // Keeping the repo's own profiles is expected for source checkouts and is
    // silent; only the cwd fallback warns, since it depends on where the
    // command is invoked from.
    const legacyDirs = isGlobalNpmPackageDir(projectRoot) ? [cwdDir] : [repoDir, cwdDir];
    const legacy = legacyDirs.find((d) => hasProfileState(d));
    if (legacy) {
        // Silent when the resolved dir is the project's own profiles (the
        // expected legacy location for a source checkout). Warn only for a
        // genuine cwd fallback (legacy dir differs from the repo dir), since
        // that depends on where the command is invoked from.
        if (legacy === cwdDir && legacy !== repoDir && homeDir) {
            console.warn(`[paths] No home config at ${homeDir}; falling back to profiles in the current directory: ${cwdDir} (set DEXBOT_PROFILE_ROOT to override)`);
        }
        return legacy;
    }

    // Fresh install → home by default (never the package dir).
    return homeDir || repoDir;
}

const PROFILES_DIR = resolveProfilesDir();

/**
 * Market adapter data/state dirs. State stays next to the code (source
 * layout) only when the profiles dir also resolves to the repo layout —
 * otherwise all user/runtime state follows the resolved profiles dir
 * (home default for fresh checkouts and global npm installs, or a
 * DEXBOT_PROFILE_ROOT override), so a source checkout no longer splits
 * state across the repo and home. Env vars override both.
 */
function resolveMarketAdapterDirs(profilesDir = PROFILES_DIR, projectRoot = PROJECT_ROOT) {
    const sourceDir = path.join(projectRoot, 'market_adapter');
    const useSourceLayout = profilesDir === path.join(projectRoot, 'profiles') && fs.existsSync(sourceDir);
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
 * so pick the layout the same way as market adapter: state stays next to
 * the code only when profiles resolve to the repo layout; otherwise it
 * relocates under the (already relocatable) profiles dir so it is not
 * wiped on `npm update -g dexbot` or blocked by a read-only prefix, and
 * fresh source checkouts keep all state under home. DEXBOT_CLAW_DATA_DIR
 * overrides the data root.
 */
function resolveClawDirs(profilesDir = PROFILES_DIR, projectRoot = PROJECT_ROOT) {
    const sourceDir = path.join(projectRoot, 'claw');
    const useSourceLayout = profilesDir === path.join(projectRoot, 'profiles');
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

/**
 * Analysis research outputs (charts, optimizer/backtest results). Same layout
 * rule as market adapter/claw: outputs stay next to the code only in a source
 * checkout whose profiles also resolve to the repo; otherwise they follow the
 * resolved profiles dir so an npm install never writes generated artifacts
 * into its own (reinstall-wiped, possibly read-only) package tree.
 * DEXBOT_ANALYSIS_DIR overrides the root.
 */
function resolveAnalysisDirs(profilesDir = PROFILES_DIR, projectRoot = PROJECT_ROOT) {
    const sourceDir = path.join(projectRoot, 'analysis');
    const useSourceLayout = profilesDir === path.join(projectRoot, 'profiles') && fs.existsSync(sourceDir);
    const outRoot = Config.DEXBOT_ANALYSIS_DIR
        ? path.resolve(Config.DEXBOT_ANALYSIS_DIR)
        : useSourceLayout
            ? sourceDir
            : path.join(profilesDir, 'analysis');
    return {
        DIR: outRoot,
        CHARTS_DIR: path.join(outRoot, 'charts'),
        RESULTS_DIR: path.join(outRoot, 'results'),
        // Vendored read-only assets always live with the code (repo checkout
        // or npm package), never under the relocated output root.
        ASSETS_DIR: path.join(sourceDir, 'uplot'),
    };
}

const ANALYSIS = resolveAnalysisDirs(PROFILES_DIR, PROJECT_ROOT);

/**
 * Relocation notices: when market-adapter/claw/credit-runtime state no longer
 * resolves to the source layout (home profiles, npm install, or a
 * DEXBOT_PROFILE_ROOT override) but the repo still holds files at the old
 * location, return warnings so users know existing state (e.g. claw positions)
 * is no longer being read and how to migrate. Empty when the old location has
 * no files, when env overrides are set, or in the normal source-layout case.
 * Deterministic given (profilesDir, projectRoot) and the DEXBOT_MARKET_ADAPTER_*
 * / DEXBOT_CLAW_DATA_DIR / DEXBOT_CRED_RUNTIME_DIR overrides read from Config
 * (scrubbed in tests), so it is testable with fake fixtures.
 */
function computeRelocationNotices(profilesDir: string, projectRoot: string): string[] {
    const notices: string[] = [];
    const repoProfiles = path.join(projectRoot, 'profiles');
    const maSourceDir = path.join(projectRoot, 'market_adapter');
    const maRelocated = !(profilesDir === repoProfiles && fs.existsSync(maSourceDir));
    if (maRelocated
        && !Config.DEXBOT_MARKET_ADAPTER_DATA_DIR && !Config.DEXBOT_MARKET_ADAPTER_STATE_DIR
        && (dirHasState(path.join(maSourceDir, 'data')) || dirHasState(path.join(maSourceDir, 'state')))) {
        notices.push(`[paths] Market adapter state exists at ${maSourceDir} but now resolves to ${path.join(profilesDir, 'market_adapter')}; move the data or set DEXBOT_MARKET_ADAPTER_DATA_DIR / DEXBOT_MARKET_ADAPTER_STATE_DIR to migrate`);
    }
    const clawSourceData = path.join(projectRoot, 'claw', 'data');
    if (profilesDir !== repoProfiles
        && !Config.DEXBOT_CLAW_DATA_DIR
        && dirHasState(clawSourceData)) {
        notices.push(`[paths] Claw state exists at ${clawSourceData} but now resolves to ${path.join(profilesDir, 'claw', 'data')}; move the data or set DEXBOT_CLAW_DATA_DIR to migrate`);
    }
    // The old claw credit-runtime adapter double-joined the profiles segment
    // (profileRoot + '/profiles/credit_runtime'), so any state left there is
    // silently orphaned now that the runtime dir resolves under the profiles
    // dir once. Check the resolver-based and repo-based variants and warn if
    // they hold state but the new location does not match.
    if (!Config.DEXBOT_CRED_RUNTIME_DIR) {
        const newCrDir = path.join(profilesDir, 'credit_runtime');
        const orphanCandidates = [
            path.join(profilesDir, 'profiles', 'credit_runtime'),
            path.join(repoProfiles, 'profiles', 'credit_runtime'),
        ];
        for (const candidate of new Set(orphanCandidates)) {
            if (candidate !== newCrDir && dirHasState(candidate)) {
                notices.push(`[paths] Credit runtime state exists at ${candidate} but now resolves to ${newCrDir}; move the data or set DEXBOT_CRED_RUNTIME_DIR to migrate`);
            }
        }
    }
    return notices;
}

for (const notice of computeRelocationNotices(PROFILES_DIR, PROJECT_ROOT)) {
    console.warn(notice);
}

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

  ANALYSIS,
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

export { PATHS, HOME_PROFILES_DIR, resolveProfilesDir, resolveMarketAdapterDirs, resolveClawDirs, resolveAnalysisDirs, isGlobalNpmPackageDir, getNodeBlacklistFile, getNodeHealthCacheFile, getRecalculateTriggerFile, computeRelocationNotices }

