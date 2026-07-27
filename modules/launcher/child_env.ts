// ── Intentionally uses process.env directly, NOT Config ───────────
// This module forwards env vars to child processes at spawn time
// (runtime read, not startup snapshot).  Config reads once at import
// and would miss vars mutated after startup.  The list also includes
// system vars (PATH, HOME, TMPDIR) that are outside Config's scope.
// ──────────────────────────────────────────────────────────────────

const SAFE_CHILD_ENV_KEYS = [
    'AMA_SIGNAL_RUNNER_FIXTURE_JSON',
    'APPDATA',
    'BITSHARES_ACCOUNT',
    'BOT_NAME',
    'CALC_CYCLES',
    'CALC_DELAY_MS',
    'COLORTERM',
    'COMSPEC',
    'DEXBOT_CRED_RUNTIME_DIR',
    'DEXBOT_ISOLATED_CHILD',
    'DEXBOT_ISOLATED_FOREGROUND',
    'DEXBOT_LAUNCH_MODE',
    'DEXBOT_PROFILE_ROOT',
    'DEXBOT_MANAGED_CRED_PID',
    'DEXBOT_SUPERVISOR_SOCKET',
    'DEXBOT2_ROOT',
    'FORCE_COLOR',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'LOCALAPPDATA',
    'LOGNAME',
    'NODE',
    'NODE_ENV',
    'NODE_PATH',
    'NO_COLOR',
    'NVM_BIN',
    'NVM_DIR',
    'NVM_INC',
    'NUMBER_OF_PROCESSORS',
    'OPEN_ORDERS_SYNC_LOOP_MS',
    'TX_BUILDER_FEE_CACHE_TTL_MS',
    'PATH',
    'PATHEXT',
    'PM2_HOME',
    'PREFERRED_ACCOUNT',
    'PWD',
    'SHELL',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TERM',
    'TMP',
    'TMPDIR',
    'TZ',
    'USER',
    'USERNAME',
    'USERPROFILE',
    'LIVE_BOT_NAME',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_RUNTIME_DIR',
];

function buildScopedChildEnv({ extra = {} }: { extra?: Record<string, string> } = {}): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const key of SAFE_CHILD_ENV_KEYS) {
        if (process.env[key] !== undefined) {
            env[key] = process.env[key];
        }
    }
    return { ...env, ...extra };
}

export { SAFE_CHILD_ENV_KEYS, buildScopedChildEnv }

