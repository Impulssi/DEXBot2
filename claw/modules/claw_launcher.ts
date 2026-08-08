
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { getStorage } from '../../modules/storage/index.js';
import { path } from '../../modules/path_api.js';
import { PATHS, getRecalculateTriggerFile } from '../../modules/paths.js';
import { loadSettingsFile, resolveRawBotEntries, saveSettingsFile, normalizeBotEntries } from '../../modules/bot_settings.js';
import { normalizeMode, detectMode, setPreferredMode, describeModeChoice } from './launcher_mode_detector.js';
import { normalizeRoot, resolveRuntimeScript } from './launcher_paths.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
'use strict';

const storage = getStorage();

let _chainKeys: any;
function getChainKeys(): any {
    if (_chainKeys === undefined) {
        try {
            _chainKeys = require('../../modules/chain_keys');
        } catch {
            _chainKeys = null;
        }
    }
    if (!_chainKeys) {
        throw new Error('chain_keys module not available in this environment');
    }
    return _chainKeys;
}

let _spawn: any;
function getSpawn(): any {
    if (_spawn === undefined) {
        try {
            _spawn = require('child_process').spawn;
        } catch {
            _spawn = null;
        }
    }
    if (!_spawn) {
        throw new Error('child_process.spawn not available in this environment');
    }
    return _spawn;
}

let _pm2: any;
function getPM2Module(): any {
    if (_pm2 === undefined) {
        try {
            _pm2 = require('../../pm2');
        } catch {
            _pm2 = null;
        }
    }
    if (!_pm2) {
        throw new Error('pm2 module not available in this environment');
    }
    return _pm2;
}

/**
 * Start a bot directly (background, spawned as detached child process).
 * Returns immediately with PID and command info.
 * @param {string|null} botName - Bot name or null for default
 * @param {Object} [options={}] - Options including profileRoot
 * @returns {Promise<Object>} { started: true, botName, pid, command }
 */
async function launcherStart(botName: string | null, options: Record<string, any> = {}) {
  const ROOT = normalizeRoot(options);
  const dexbotPath = resolveRuntimeScript(ROOT, 'dexbot.js');

  const args = ['test'];
  if (botName) {
    args.push(botName);
  }

  const child = getSpawn()('node', [dexbotPath, ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT
  });

  child.unref();

  return {
    started: true,
    botName: botName || 'default',
    pid: child.pid,
    command: botName ? `dexbot test ${botName}` : 'dexbot test',
  };
}

/**
 * Dry-run a bot (no broadcast).
 * @param {string|null} botName - Bot name or null for default
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { started: true, botName, pid, command, dryRun: true }
 */
async function launcherDrystart(botName: string | null, options: Record<string, any> = {}) {
  const ROOT = normalizeRoot(options);
  const dexbotPath = resolveRuntimeScript(ROOT, 'dexbot.js');

  const args = ['drystart'];
  if (botName) {
    args.push(botName);
  }

  const child = getSpawn()('node', [dexbotPath, ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT
  });

  child.unref();

  return {
    started: true,
    botName: botName || 'default',
    pid: child.pid,
    command: botName ? `dexbot drystart ${botName}` : 'dexbot drystart',
    dryRun: true,
  };
}

/**
 * Reset a bot grid (writes trigger file).
 * @param {string|null} botName - Bot name or null for all active
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { reset: true, targets: [...] }
 */
async function launcherReset(botName: string | null, options: Record<string, any> = {}) {
  const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;

  const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
  const entries = normalizeBotEntries(resolveRawBotEntries(config));

  const targets = botName ? entries.filter((b: any) => b.name === botName) : entries.filter((b: any) => b.active);

  if (botName && targets.length === 0) {
    throw new Error(`Bot '${botName}' not found in profiles/bots.json`);
  }

  const triggered: Array<Record<string, any>> = [];

  for (const bot of targets) {
    try {
      const triggerFile = getRecalculateTriggerFile(bot.botKey);
      storage.writeFile(triggerFile, new Date().toISOString());
      triggered.push({
        botName: bot.name,
        triggerFile: path.basename(triggerFile),
      });
    } catch (err: any) {
      throw new Error(`Failed to write trigger for '${bot.name}': ${getErrorMessage(err)}`);
    }
  }

  return {
    reset: true,
    targets: triggered,
  };
}

/**
 * Disable a bot in config.
 * @param {string|null} botName - Bot name or null for all
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { disabled: true, targets: [...] } or { disabled: false, reason: '...' }
 */
async function launcherDisable(botName: string | null, options: Record<string, any> = {}) {
  const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;

  const { config, filePath } = loadSettingsFile(PROFILES_BOTS_FILE);
  const entries = resolveRawBotEntries(config);

  if (!botName) {
    // Disable all
    let updated = false;
    entries.forEach((entry: any) => {
      if (entry.active !== false) {
        entry.active = false;
        updated = true;
      }
    });

    if (!updated) {
      return { disabled: false, reason: 'No active bots to disable' };
    }

    saveSettingsFile(config, filePath);
    return {
      disabled: true,
      targets: entries.map((b: any) => ({ botName: b.name, active: false })),
    };
  }

  const match = entries.find((b: any) => b.name === botName);
  if (!match) {
    throw new Error(`Bot '${botName}' not found in profiles/bots.json`);
  }

  if (match.active === false) {
    return { disabled: false, reason: `Bot '${botName}' is already inactive` };
  }

  match.active = false;
  saveSettingsFile(config, filePath);

  return {
    disabled: true,
    targets: [{ botName: botName, active: false }],
  };
}

/**
 * Start bots via PM2 (production-grade, managed).
 * Requires credential daemon to already be running.
 * @param {string|null} botName - Bot name or null for all active
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { started: true, targets: [{ botName, pm2: true }] }
 */
async function launcherPm2Start(botName: string | null, options: Record<string, any> = {}) {
  const ROOT = normalizeRoot(options);
  const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;

  // Validate bot configuration first (better error message)
  const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
  const entries = normalizeBotEntries(resolveRawBotEntries(config));

  const targets = botName ? entries.filter((b: any) => b.name === botName) : entries.filter((b: any) => b.active);

  if (botName && targets.length === 0) {
    throw new Error(`Bot '${botName}' not found or not active in profiles/bots.json`);
  }

  // Then check if daemon is ready
  if (!(await getChainKeys().isDaemonResponsive())) {
    throw new Error(
      'Credential daemon is not running. Start it first with: dexbot pm2 claw-only'
    );
  }

  // Generate ecosystem config and get apps array
  getPM2Module().generateEcosystemConfig({ clawOnly: false, exitOnError: false });
  const apps = getPM2Module().buildEcosystemApps({ clawOnly: false });

  // Filter apps if specific bot requested
  let appsToStart = apps;
  if (botName) {
    appsToStart = apps.filter((app: any) => app.name === botName);
    if (appsToStart.length === 0) {
      throw new Error(`No PM2 app found for bot '${botName}'`);
    }
  }

  // Start via pm2 without bootstrap (daemon already running)
  await getPM2Module().startManagedRuntimePM2({ apps: appsToStart });

  return {
    started: true,
    targets: targets.map((b: any) => ({ botName: b.name, pm2: true })),
  };
}

/**
 * Stop bot processes via PM2.
 * @param {string} target - Bot name or 'all'
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { stopped: true, target }
 */
async function launcherPm2Stop(target: string, options: Record<string, any> = {}) {
  await getPM2Module().stopPM2Processes(target || 'all');
  return {
    stopped: true,
    target: target || 'all',
  };
}

/**
 * Delete bot processes from PM2.
 * @param {string} target - Bot name or 'all'
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { deleted: true, target }
 */
async function launcherPm2Delete(target: string, options: Record<string, any> = {}) {
  await getPM2Module().deletePM2Processes(target || 'all');
  return {
    deleted: true,
    target: target || 'all',
  };
}

/**
 * Restart bot processes via PM2.
 * @param {string} target - Bot name or 'all'
 * @param {Object} [options={}] - Options
 * @returns {Promise<Object>} { restarted: true, target }
 */
async function launcherPm2Restart(target: string, options: Record<string, any> = {}) {
  await getPM2Module().restartPM2Processes(target || 'all');
  return {
    restarted: true,
    target: target || 'all',
  };
}

/**
 * Unified launcher command: auto-detects deployment mode and runs accordingly.
 *
 * Flow:
 *   1. Detect mode (stored preference, or suggest based on bot config)
 *   2. If user needs to choose, return choices for MCP/CLI to handle
 *   3. If mode is known, delegate to appropriate implementation
 *   4. Store choice if user provided deploymentMode override
 *
 * @param {string|null} botName - Bot name or null for default/all
 * @param {Object} [options={}] - Options
 * @param {string} [options.deploymentMode] - Override mode: dexbot-direct, pm2, unlock, claw-only
 * @param {boolean} [options.setPreference] - If true, save deploymentMode as preferred
 * @param {string} [options.profileRoot] - Optional profile root
 * @returns {Promise<Object>}
 *   Delegated modes: { started: true, mode?, botName?, pid?, command?, targets?, message?, warning? }
 *   Mode present in claw-only / unlock; absent in dexbot-direct / pm2.
 *   No-mode: { needsChoice: true, reason, choices: [{ mode, description }], message }
 */
async function launcherRun(botName: string | null, options: Record<string, any> = {}) {
  const detection = detectMode(options);
  const deploymentMode = options.deploymentMode ? normalizeMode(options.deploymentMode) : null;

  // User is overriding the mode
  if (options.deploymentMode) {
    const validModes = ['dexbot-direct', 'pm2', 'unlock', 'claw-only'];
    if (!validModes.includes(deploymentMode)) {
      throw new Error(`Invalid deploymentMode: ${options.deploymentMode}. Must be one of: ${validModes.join(', ')}`);
    }

    // Note if botName is provided for claw-only mode (will be ignored)
    const clawOnlyWarning = (deploymentMode === 'claw-only' && botName)
      ? `botName '${botName}' is ignored in claw-only mode (daemon does not target specific bots)`
      : null;

    // Save as preference if requested
    if (options.setPreference) {
      setPreferredMode(deploymentMode, options);
    }

    // Delegate to appropriate implementation
    const result = await (async (): Promise<Record<string, any>> => {
      switch (deploymentMode) {
        case 'dexbot-direct':
          return launcherStart(botName, options);
        case 'pm2':
          return launcherPm2Start(botName, options);
        case 'unlock':
          return launcherUnlockStart(botName, options);
        case 'claw-only':
          return launcherClawOnly(options);
        default:
          return {};
      }
    })();
    if (clawOnlyWarning) result.warning = clawOnlyWarning;
    return result;
  }

  // Mode is known from stored preference
  if (detection.mode) {
    switch (detection.mode) {
      case 'dexbot-direct':
        return launcherStart(botName, options);
      case 'pm2':
        return launcherPm2Start(botName, options);
      case 'unlock':
        return launcherUnlockStart(botName, options);
      case 'claw-only':
        return launcherClawOnly(options);
    }
  }

  // No mode set and user hasn't chosen — ask them
  return {
    needsChoice: true,
    reason: detection.reason,
    choices: detection.choices.map((mode: string) => ({
      mode,
      description: describeModeChoice(mode)
    })),
    message: 'Please choose a deployment mode for launcher-run. Provide it in the next call as deploymentMode parameter and set setPreference:true to save your choice.'
  };
}

/**
 * Start credential daemon only (claw-only mode).
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
async function launcherClawOnly(options: Record<string, any> = {}) {
  const ROOT = normalizeRoot(options);
  const pm2ScriptPath = resolveRuntimeScript(ROOT, 'pm2.js');

  const child = getSpawn()('node', [pm2ScriptPath, 'claw-only'], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT
  });

  child.unref();

  return {
    started: true,
    mode: 'claw-only',
    message: 'Credential daemon started in background (PM2 managed)',
    pid: child.pid,
    command: 'dexbot pm2 claw-only'
  };
}

/**
 * Start via unlock (single password prompt, no PM2).
 * @param {string|null} botName - Bot name or null for default
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
async function launcherUnlockStart(botName: string | null, options: Record<string, any> = {}) {
  const ROOT = normalizeRoot(options);
  const unlockPath = resolveRuntimeScript(ROOT, 'unlock.js');

  const args = [];
  if (botName) {
    args.push(botName);
  }

  const child = getSpawn()('node', [unlockPath, ...args], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT
  });

  child.unref();

  return {
    started: true,
    mode: 'unlock',
    botName: botName || 'default',
    pid: child.pid,
    command: botName ? `dexbot unlock ${botName}` : 'dexbot unlock',
    message: 'Bots started via unlock (single password prompt, no PM2)'
  };
}

export { launcherRun, launcherStart, launcherDrystart, launcherReset, launcherDisable, launcherPm2Start, launcherPm2Stop, launcherPm2Delete, launcherPm2Restart, launcherClawOnly, launcherUnlockStart }

