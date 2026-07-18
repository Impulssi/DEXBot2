const { path } = require('./path_api');
const { Config } = require('./config');
const { hasProcess } = require('./env');
const { isDistRuntime } = require('./utils/build_dir');

const MODULE_DIR = hasProcess() ? path.dirname(__dirname) : '';
const PROJECT_ROOT = (hasProcess() && isDistRuntime(MODULE_DIR))
    ? path.dirname(MODULE_DIR)
    : MODULE_DIR;

function resolveProfilesDir(): string {
    if (Config.DEXBOT_PROFILE_ROOT) {
        return Config.DEXBOT_PROFILE_ROOT;
    }
    if (Config.DEXBOT2_ROOT) {
        return path.join(Config.DEXBOT2_ROOT, 'profiles');
    }
    return path.join(PROJECT_ROOT, 'profiles');
}

const PROFILES_DIR = resolveProfilesDir();

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
    ECOSYSTEM_CONFIG_JS: path.join(PROFILES_DIR, 'ecosystem.config.js'),
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

  MARKET_ADAPTER: {
    DIR: path.join(PROJECT_ROOT, 'market_adapter'),
    DATA_DIR: path.join(PROJECT_ROOT, 'market_adapter', 'data'),
    LP_DATA_DIR: path.join(PROJECT_ROOT, 'market_adapter', 'data', 'lp'),
    STATE_DIR: path.join(PROJECT_ROOT, 'market_adapter', 'state'),
    STATE_FILE: path.join(PROJECT_ROOT, 'market_adapter', 'state', 'market_adapter_state.json'),
    CENTERS_FILE: path.join(PROJECT_ROOT, 'market_adapter', 'state', 'market_adapter_centers.json'),
    LOCK_FILE: path.join(PROJECT_ROOT, 'market_adapter', 'state', 'market_adapter.lock'),
  },

  CLAW: {
    DIR: path.join(PROJECT_ROOT, 'claw'),
    DATA_DIR: path.join(PROJECT_ROOT, 'claw', 'data'),
    STATE_DIR: path.join(PROJECT_ROOT, 'claw', 'data', 'state'),
    POSITIONS_FILE: path.join(PROJECT_ROOT, 'claw', 'data', 'positions.json'),
    WATCHER_HEALTH_FILE: path.join(PROJECT_ROOT, 'claw', 'data', 'watcher-health.json'),
    MEMU_DIR: path.join(PROJECT_ROOT, 'claw', 'data', 'memu'),
    MEMU_RUNNER_SCRIPT: path.join(PROJECT_ROOT, 'claw', 'scripts', 'memu_runner.py'),
  },

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

export = { PATHS, getNodeBlacklistFile, getNodeHealthCacheFile, getRecalculateTriggerFile };
