'use strict';

import { path } from '../../modules/path_api.js';
import { getStorage } from '../../modules/storage/index.js';
import { loadSettingsFile, resolveRawBotEntries } from '../../modules/bot_settings.js';
import { normalizeProfileDir } from './launcher_paths.js';

const storage = getStorage();
const { ensureDir, readJSON, writeJSON } = storage;

function normalizeMode(mode: string | null | undefined) {
  const value = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  return value;
}

/**
 * Launcher mode configuration detector and manager.
 *
 * Modes:
 *   - claw-only: Credential daemon only (no bots configured)
 *   - dexbot-direct: dexbot test (testing/debugging)
 *   - pm2: PM2 production service (monitored, auto-restart)
 *   - unlock: Single-prompt startup (no PM2)
 */

function getConfigPath(options: Record<string, any> = {}) {
  const PROFILES_DIR = normalizeProfileDir(options);
  return path.join(PROFILES_DIR, 'launcher.config.json');
}

/**
 * Load launcher config (or return empty if doesn't exist).
 * @param {Object} [options={}]
 * @returns {Object} { preferredMode, lastUsed, history: [...] }
 */
function loadConfig(options: Record<string, any> = {}) {
  const configPath = getConfigPath(options);

  try {
    if (storage.exists(configPath)) {
      return readJSON(configPath);
    }
  } catch (err: any) {
    // Ignore parse errors, return empty
  }

  return {
    preferredMode: null,
    lastUsed: null,
    history: []
  };
}

/**
 * Save launcher config.
 * @param {Object} config - Config object
 * @param {Object} [options={}]
 */
function saveConfig(config: Record<string, any>, options: Record<string, any> = {}) {
  const configPath = getConfigPath(options);
  const PROFILES_DIR = path.dirname(configPath);

  // Ensure directory exists
  if (!storage.exists(PROFILES_DIR)) {
    ensureDir(PROFILES_DIR);
  }

  writeJSON(configPath, config);
}

/**
 * Detect if active bots are configured.
 * @param {Object} [options={}]
 * @returns {boolean} True if at least one active bot exists
 */
function hasActiveBots(options: Record<string, any> = {}) {
  const BOTS_FILE = path.join(normalizeProfileDir(options), 'bots.json');

  if (!storage.exists(BOTS_FILE)) {
    // No bots.json file yet — user hasn't configured any bots
    return false;
  }

  // Parse errors are NOT treated as "no bots": a corrupt config should surface
  // as a launcher/detection failure instead of silently picking claw-only mode.
  const { config } = loadSettingsFile(BOTS_FILE);
  const entries = resolveRawBotEntries(config);
  return entries.some((b: any) => b.active !== false);
}

/**
 * Get or prompt for launcher mode.
 * If no preference stored, return suggested mode based on bot config.
 * (Actual prompting happens at the claw bridge level via MCP or CLI UI.)
 *
 * @param {Object} [options={}]
 * @returns {Object} { mode, reason, suggested: boolean, choices: [] }
 */
function detectMode(options: Record<string, any> = {}) {
  const config = loadConfig(options);

  // If user has set a preference, use it
  if (config.preferredMode) {
    return {
      mode: normalizeMode(config.preferredMode),
      reason: 'User preference (stored in launcher.config.json)',
      suggested: false,
      choices: []
    };
  }

  // Detect based on bot configuration
  const activeBots = hasActiveBots(options);

  if (!activeBots) {
    return {
      mode: 'claw-only',
      reason: 'No active bots configured in bots.json',
      suggested: true,
      choices: ['claw-only']  // only option
    };
  }

  // Active bots exist — suggest choices to user
  return {
    mode: null,  // needs user input
    reason: 'Active bots found; awaiting user deployment preference',
    suggested: true,
    choices: ['dexbot-direct', 'pm2', 'unlock']
  };
}

/**
 * Set user's preferred mode and persist it.
 * @param {string} mode - One of: claw-only, dexbot-direct, pm2, unlock
 * @param {Object} [options={}]
 * @throws {Error} if mode is invalid
 * @returns {{set: boolean, mode: string, timestamp: string}}
 */
function setPreferredMode(mode: string, options: Record<string, any> = {}) {
  const normalizedMode = normalizeMode(mode);
  const valid = ['claw-only', 'dexbot-direct', 'pm2', 'unlock'];
  if (!valid.includes(normalizedMode)) {
    throw new Error(`Invalid launcher mode: ${mode}. Must be one of: ${valid.join(', ')}`);
  }

  const config = loadConfig(options);
  config.preferredMode = normalizedMode;
  config.lastUsed = new Date().toISOString();

  if (!Array.isArray(config.history)) {
    config.history = [];
  }
  config.history.push({
    mode: normalizedMode,
    timestamp: config.lastUsed
  });

  // Keep history to last 20 entries
  if (config.history.length > 20) {
    config.history = config.history.slice(-20);
  }

  saveConfig(config, options);

  return {
    set: true,
    mode: normalizedMode,
    timestamp: config.lastUsed
  };
}

/**
 * Get mode description for display.
 * @param {string} mode
 * @returns {string} Human-readable description
 */
function describeModeChoice(mode: string) {
  const descriptions: Record<string, string> = {
    'claw-only': 'Start credential daemon only (no bots)',
    'dexbot-direct': 'Run bot directly (foreground, testing/debugging)',
    'pm2': 'Deploy via PM2 (production, persistent, monitored)',
    'unlock': 'Start with single password prompt (no PM2)'
  };
  return descriptions[mode] || mode;
}

export { normalizeMode, detectMode, setPreferredMode, describeModeChoice }

