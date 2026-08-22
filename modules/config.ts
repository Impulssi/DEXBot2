
import path from 'node:path';
import { createRequire } from 'node:module';
import { hasProcess } from './env.js';
import { isDistRuntime } from './utils/build_dir.js';
import { fileURLToPath } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);
const require = createRequire(import.meta.url);
'use strict';

/**
 * Centralized configuration — populated once at module load time from process.env.
 *
 * Production code reads from this object instead of accessing process.env directly.
 * Tests may mutate Config fields directly to override values, then restore originals.
 *
 * Server: one read per var on startup (already happening anyway).
 * Browser: would be populated from URL params, localStorage, etc.
 */


function str(key: string): string | undefined {
    return hasProcess() && process.env[key] !== undefined ? process.env[key] : undefined;
}

function strWithDefault(key: string, defaultValue: string): string {
    return hasProcess() && process.env[key] !== undefined ? String(process.env[key]) : defaultValue;
}

function num(key: string, defaultValue: number): number {
    const val = hasProcess() ? process.env[key] : undefined;
    return val !== undefined ? Number(val) : defaultValue;
}

function bool(key: string): boolean {
    return hasProcess() && process.env[key] === '1';
}

function hasOwn(key: string): boolean {
    return hasProcess() && Object.prototype.hasOwnProperty.call(process.env, key);
}

// Resolve project root — works from source (modules/) and dist (dist/modules/).
const _MODULE_DIR$ = path.dirname(__dirname);
const _PROJECT_ROOT$ = isDistRuntime(_MODULE_DIR$) ? path.dirname(_MODULE_DIR$) : _MODULE_DIR$;

const Config: {
    // ── Bot identity ────────────────────────────────────────────────
    BOT_NAME: string | undefined;
    PREFERRED_ACCOUNT: string | undefined;
    LIVE_BOT_NAME: string | undefined;
    VERSION: string;

    // ── Feature flags ───────────────────────────────────────────────
    DEXBOT_SKIP_PROFILE_VALIDATION: boolean;
    DEXBOT_DISABLE_SUPERVISOR_SOCKET: boolean;
    DEXBOT_ISOLATED_CHILD: boolean;
    DEXBOT_ISOLATED_FOREGROUND: boolean;
    DEXBOT_MONOLITHIC_BG: boolean;
    DEXBOT_UPDATE_SKIP_RELOAD: boolean;
    NO_COLOR: string | undefined;

    // ── Paths ───────────────────────────────────────────────────────
    PM2_HOME: string | undefined;
    DEXBOT_SUPERVISOR_SOCKET: string | undefined;
    DEXBOT_KEYS_FILE: string | undefined;
    DEXBOT_CRED_RUNTIME_DIR: string | undefined;
    XDG_RUNTIME_DIR: string | undefined;
    XDG_CONFIG_HOME: string | undefined;
    DEXBOT_CRED_DAEMON_SOCKET: string | undefined;
    DEXBOT_CRED_DAEMON_READY_FILE: string | undefined;
    DEXBOT_CRED_BOOTSTRAP_PATH_FILE: string | undefined;
    DEXBOT2_ROOT: string | undefined;
    DEXBOT_PROFILE_ROOT: string | undefined;
    DEXBOT_ANALYSIS_DIR: string | undefined;
    DEXBOT_MARKET_ADAPTER_DATA_DIR: string | undefined;
    DEXBOT_MARKET_ADAPTER_STATE_DIR: string | undefined;
    DEXBOT_CLAW_DATA_DIR: string | undefined;

    // ── Credentials / secrets ───────────────────────────────────────
    DEXBOT_MASTER_PASSWORD: string | undefined;
    OPENAI_API_KEY: string | undefined;

    // ── Numeric controls ────────────────────────────────────────────
    /** Raw value of OPEN_ORDERS_SYNC_LOOP_MS (use getOpenOrdersSyncLoopMs() instead). */
    _OPEN_ORDERS_SYNC_LOOP_MS_RAW: string | undefined;
    /** Raw value of TX_BUILDER_FEE_CACHE_TTL_MS (use getTxBuilderFeeCacheTtl() instead). */
    _TX_BUILDER_FEE_CACHE_TTL_MS_RAW: string | undefined;
    CALC_CYCLES: number;
    CALC_DELAY_MS: number;
    DEXBOT_MANAGED_CRED_PID: string | undefined;

    // ── Debug / test helpers ────────────────────────────────────────
    AMA_SIGNAL_RUNNER_FIXTURE_JSON: string | undefined;
    DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE: string | undefined;
    NATIVE_MAINNET_CORPUS_REPORT: string | undefined;
    DEBUG: string | undefined;

    // ── Claw AI agent ───────────────────────────────────────────────
    BITSHARES_ACCOUNT: string | undefined;
    OPENAI_BASE_URL: string;
    OPENAI_CHAT_MODEL: string;
    OPENAI_EMBED_MODEL: string;
    MEMU_DIR: string | undefined;
    MEMU_PYTHON: string;

    // ── PM2 runtime vars (set by PM2, not user-configurable) ────────
    pm_exec_path: string | undefined;
    pm_out_log_path: string | undefined;
    pm_err_log_path: string | undefined;

    // ── Runtime environment (populated at load, safe defaults for browser) ──
    EXEC_PATH: string;
    CWD: string;
    PLATFORM: string;
    ARGS: string[];
} = {
    // ── Bot identity ────────────────────────────────────────────────
    BOT_NAME: str('BOT_NAME'),
    PREFERRED_ACCOUNT: str('PREFERRED_ACCOUNT'),
    LIVE_BOT_NAME: str('LIVE_BOT_NAME'),
    VERSION: hasProcess() ? require(path.join(_PROJECT_ROOT$, 'package.json')).version : '0.0.0',

    // ── Feature flags ───────────────────────────────────────────────
    DEXBOT_SKIP_PROFILE_VALIDATION: bool('DEXBOT_SKIP_PROFILE_VALIDATION'),
    DEXBOT_DISABLE_SUPERVISOR_SOCKET: bool('DEXBOT_DISABLE_SUPERVISOR_SOCKET'),
    DEXBOT_ISOLATED_CHILD: bool('DEXBOT_ISOLATED_CHILD'),
    DEXBOT_ISOLATED_FOREGROUND: bool('DEXBOT_ISOLATED_FOREGROUND'),
    DEXBOT_MONOLITHIC_BG: bool('DEXBOT_MONOLITHIC_BG'),
    DEXBOT_UPDATE_SKIP_RELOAD: bool('DEXBOT_UPDATE_SKIP_RELOAD'),
    NO_COLOR: str('NO_COLOR'),

    // ── Paths ───────────────────────────────────────────────────────
    PM2_HOME: str('PM2_HOME'),
    DEXBOT_SUPERVISOR_SOCKET: str('DEXBOT_SUPERVISOR_SOCKET'),
    DEXBOT_KEYS_FILE: str('DEXBOT_KEYS_FILE'),
    DEXBOT_CRED_RUNTIME_DIR: str('DEXBOT_CRED_RUNTIME_DIR'),
    XDG_RUNTIME_DIR: str('XDG_RUNTIME_DIR'),
    XDG_CONFIG_HOME: str('XDG_CONFIG_HOME'),
    DEXBOT_CRED_DAEMON_SOCKET: str('DEXBOT_CRED_DAEMON_SOCKET'),
    DEXBOT_CRED_DAEMON_READY_FILE: str('DEXBOT_CRED_DAEMON_READY_FILE'),
    DEXBOT_CRED_BOOTSTRAP_PATH_FILE: str('DEXBOT_CRED_BOOTSTRAP_PATH_FILE'),
    DEXBOT2_ROOT: str('DEXBOT2_ROOT'),
    DEXBOT_PROFILE_ROOT: str('DEXBOT_PROFILE_ROOT'),
    DEXBOT_MARKET_ADAPTER_DATA_DIR: str('DEXBOT_MARKET_ADAPTER_DATA_DIR'),
    DEXBOT_MARKET_ADAPTER_STATE_DIR: str('DEXBOT_MARKET_ADAPTER_STATE_DIR'),
    DEXBOT_ANALYSIS_DIR: str('DEXBOT_ANALYSIS_DIR'),
    DEXBOT_CLAW_DATA_DIR: str('DEXBOT_CLAW_DATA_DIR'),

    // ── Credentials / secrets ───────────────────────────────────────
    DEXBOT_MASTER_PASSWORD: str('DEXBOT_MASTER_PASSWORD'),
    OPENAI_API_KEY: str('OPENAI_API_KEY'),

    // ── Numeric controls ────────────────────────────────────────────
    _OPEN_ORDERS_SYNC_LOOP_MS_RAW: str('OPEN_ORDERS_SYNC_LOOP_MS'),
    _TX_BUILDER_FEE_CACHE_TTL_MS_RAW: str('TX_BUILDER_FEE_CACHE_TTL_MS'),
    CALC_CYCLES: num('CALC_CYCLES', 3),
    CALC_DELAY_MS: num('CALC_DELAY_MS', 500),
    DEXBOT_MANAGED_CRED_PID: str('DEXBOT_MANAGED_CRED_PID'),

    // ── Debug / test helpers ────────────────────────────────────────
    AMA_SIGNAL_RUNNER_FIXTURE_JSON: str('AMA_SIGNAL_RUNNER_FIXTURE_JSON'),
    DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE: str('DEXBOT_TEST_MARKET_ADAPTER_WHITELIST_FILE'),
    NATIVE_MAINNET_CORPUS_REPORT: str('NATIVE_MAINNET_CORPUS_REPORT'),
    DEBUG: str('DEBUG'),

    // ── Claw AI agent ───────────────────────────────────────────────
    BITSHARES_ACCOUNT: str('BITSHARES_ACCOUNT'),
    OPENAI_BASE_URL: strWithDefault('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    OPENAI_CHAT_MODEL: strWithDefault('OPENAI_CHAT_MODEL', 'gpt-4o'),
    OPENAI_EMBED_MODEL: strWithDefault('OPENAI_EMBED_MODEL', 'text-embedding-3-small'),
    MEMU_DIR: str('MEMU_DIR'),
    MEMU_PYTHON: strWithDefault('MEMU_PYTHON', 'python3'),

    // ── PM2 runtime vars (set by PM2, not user-configurable) ────────
    pm_exec_path: str('pm_exec_path'),
    pm_out_log_path: str('pm_out_log_path'),
    pm_err_log_path: str('pm_err_log_path'),

    // ── Runtime environment (safe defaults for browser) ──
    EXEC_PATH: hasProcess() ? process.execPath : '',
    CWD: hasProcess() ? process.cwd() : '',
    PLATFORM: hasProcess() ? process.platform : '',
    ARGS: hasProcess() ? process.argv.slice(2) : [],
};

function hasOpenOrdersSyncLoopMsSet(): boolean {
    return hasOwn('OPEN_ORDERS_SYNC_LOOP_MS');
}

function getOpenOrdersSyncLoopMs(): number | undefined {
    return Config._OPEN_ORDERS_SYNC_LOOP_MS_RAW !== undefined
        ? Number(Config._OPEN_ORDERS_SYNC_LOOP_MS_RAW)
        : undefined;
}

function hasTxBuilderFeeCacheTtlSet(): boolean {
    return hasOwn('TX_BUILDER_FEE_CACHE_TTL_MS');
}

function getTxBuilderFeeCacheTtl(): number | undefined {
    return Config._TX_BUILDER_FEE_CACHE_TTL_MS_RAW !== undefined
        ? Number(Config._TX_BUILDER_FEE_CACHE_TTL_MS_RAW)
        : undefined;
}

function setUmask(mode: number): void {
    if (hasProcess()) { process.umask(mode); }
}

export { Config, hasOpenOrdersSyncLoopMsSet, getOpenOrdersSyncLoopMs, hasTxBuilderFeeCacheTtlSet, getTxBuilderFeeCacheTtl, setUmask }

