#!/usr/bin/env node
// node-only entry point — single bot instance launcher (process.argv, process.exit, stdin, child_process)
/**
 * bot.ts - Single Bot Instance Launcher
 *
 * PM2-friendly entry point for single grid trading bot.
 * Standalone launcher executed by PM2 for each configured bot.
 * Handles bot initialization, authentication, and continuous trading loop.
 *
 * ===============================================================================
 * STARTUP SEQUENCE
 * ===============================================================================
 *
 * 1. BOT CONFIGURATION LOADING
 *    - Reads bot settings from profiles/bots.json by bot name (from argv)
 *    - Validates bot exists in configuration
 *    - Reports market pair and account being used
 *    - Loads trading parameters (grid size, spread, order count, etc.)
 *
 * 2. AUTHENTICATION
 *    - First attempts credential daemon (Unix socket) for a session-only signing token
 *    - Falls back to interactive master password prompt if daemon unavailable
 *    - Master password never stored in environment variables
 *    - Legacy path still loads a raw private key into bot memory
 *
 * 3. BOT INITIALIZATION
 *    - Waits for BitShares blockchain connection (30 second timeout)
 *    - Uses pre-decrypted private key for transaction signing
 *    - Resolves account ID from BitShares
 *    - Initializes OrderManager with bot configuration
 *    - Sets up event handlers for fills and blockchain updates
 *
 * 4. GRID INITIALIZATION OR RESUME
 *    - Loads persisted grid snapshot if it exists and matches on-chain orders
 *    - Validates persisted grid against current blockchain state (reconciliation)
 *    - Detects offline fills and updates fund accounting automatically
 *    - Creates fresh grid if no valid persisted state found
 *    - Synchronizes grid state with BitShares blockchain
 *    - Places initial orders to reach target count
 *    - Note: Grid uses Copy-on-Write pattern for safe rebalancing (isolated working copies)
 *
 * 5. TRADING LOOP
 *    - Continuously monitors for fill events via blockchain subscriptions
 *    - Updates order status from chain data
 *    - Processes fills and updates fund accounting
 *    - Regenerates/rebalances grid as needed
 *    - Runs indefinitely (PM2 manages restart/stop/monitoring)
 */

// Restrict default file permissions: files created by this process default to
// 0o600 (owner-only) unless explicitly opened with a wider mode.  Protects
// keys.json and daemon-policies.json from world-readable exposure.
const { setUmask } = require('./modules/config');
setUmask(0o077);

const { getStorage } = require('./modules/storage');
const storage = getStorage();
const { runtime } = require('./modules/runtime');
const { createPm2AwareLogger } = require('./modules/logger');
const DEXBot = require('./modules/dexbot_class');
const { normalizeBotEntry } = require('./modules/dexbot_class');
const { loadSettingsFile, resolveRawBotEntries, selectBotEntry } = require('./modules/bot_settings');
const { setupGracefulShutdown, registerCleanup, unregisterCleanup } = require('./modules/graceful_shutdown');
const chainKeys = require('./modules/chain_keys');
const { getKeyStore } = require('./modules/key_store');
const credentialPolicy = require('./modules/credential_policy');
const { PATHS } = require('./modules/paths');
const { Config } = require('./modules/config');
const { getErrorMessage } = require('./modules/utils/errors');

// Auto-migrate bot state files from old stable-ID key format to sanitized-name format
try {
    const { runMigration } = require('./scripts/migrate_bot_keys');
    runMigration();
} catch (err: any) {
    console.error(`Migration error: ${getErrorMessage(err)}`);
}

// Setup graceful shutdown handlers
setupGracefulShutdown();

// Verify keys file permissions early — refuse to run if keys.json is
// world-readable (would indicate a prior run with a permissive umask).
if (typeof chainKeys.checkKeysFileSecurity === 'function') chainKeys.checkKeysFileSecurity();
// Same migration-aware check for daemon-policies.json.
if (typeof credentialPolicy.checkPolicyFileSecurity === 'function') credentialPolicy.checkPolicyFileSecurity(PATHS.PROFILES.DAEMON_POLICIES_JSON);
const launcherLogger = createPm2AwareLogger('bot.js');

const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;

// Get bot name from args or environment
// Support both direct names (tsx bot.ts botname) and flag format (tsx bot.ts --botname)
// Flag format is used by PM2 for consistency with other CLI tools
let botNameArg = Config.ARGS[0];
if (botNameArg && botNameArg.startsWith('--')) {
    // Strip '--' prefix if present (e.g., --mybot becomes mybot)
    botNameArg = botNameArg.substring(2);
}
const botNameEnv = Config.BOT_NAME || Config.PREFERRED_ACCOUNT;
const botName = botNameArg || botNameEnv;

if (!botName) {
    launcherLogger.error('No bot name provided. Usage: tsx bot.ts <bot-name>');
    launcherLogger.error('Or set BOT_NAME or PREFERRED_ACCOUNT environment variable');
    runtime.exit(1);
}

/**
 * Loads the configuration for a specific bot from profiles/bots.json.
 * @param {string} name - The name of the bot to load.
 * @returns {Object} The bot configuration entry. Exits process on failure.
 */
function loadBotConfig(name: string) {
    if (!storage.exists(PROFILES_BOTS_FILE)) {
        launcherLogger.error('profiles/bots.json not found. Run: dexbot bot');
        runtime.exit(1);
    }

    try {
        const { config } = loadSettingsFile(PROFILES_BOTS_FILE);
        const botEntry = selectBotEntry(config, name);

        // Validate all profile files at startup (skip for PM2 child processes and tests)
        if (!Config.DEXBOT_SKIP_PROFILE_VALIDATION && !Config.PM2_HOME) {
            const { validateAllProfiles, printValidationProblems } = require('./modules/validate_profiles');
            const result = validateAllProfiles();
            const ok = printValidationProblems(result);
            if (!ok) {
                launcherLogger.error('Fix the configuration errors above and restart.');
                runtime.exit(1);
            }
        }

        if (!botEntry) {
            const bots = resolveRawBotEntries(config);
            launcherLogger.error(`Bot '${name}' not found in profiles/bots.json`);
            launcherLogger.error(`Available bots: ${bots.map((b: any) => b.name).join(', ') || 'none'}`);
            runtime.exit(1);
        }

        return botEntry;
    } catch (err: any) {
        launcherLogger.error(`Error loading bot config: ${getErrorMessage(err)}`);
        runtime.exit(1);
    }
}

/**
 * Get signing secret for account from daemon or interactive prompt.
 * Tries daemon first (if running), then falls back to interactive master password prompt.
 * @param {string} accountName - The account name to retrieve key for.
 * @returns {Promise<string|Object>} A raw private key for legacy mode, or a daemon signing token.
 * @throws {Error} If both daemon and interactive authentication fail.
 */
async function getSigningSecretForAccount(accountName: string) {
    const keyStore = getKeyStore();
    const origLog = console.log;
    console.log = (...args: any[]) => {
        const isNoisy = args.some(
            (arg) => typeof arg === 'string' && (arg.includes('bitshares_client') || arg.includes('modules/'))
        );
        if (!isNoisy) {
            origLog.apply(console, args);
        }
    };
    try {
        return await keyStore.resolveSigningKey(accountName);
    } finally {
        console.log = origLog;
    }
}

// Main entry point
(async () => {
    try {
        // Load bot configuration
        const botConfig = loadBotConfig(botName);

         // Load all bots from configuration to prevent pruning other active bots
          const { config: allBotsConfigData } = loadSettingsFile(PROFILES_BOTS_FILE);
          const allBotsConfig = resolveRawBotEntries(allBotsConfigData);
         
         // Find the current bot's index in the unfiltered bots.json array
         const botIndex = allBotsConfig.findIndex((b: any) => b.name === botName);
         if (botIndex === -1) {
             throw new Error(`Bot "${botName}" not found in ${PROFILES_BOTS_FILE}`);
         }

         // Normalize config for current bot with correct index from unfiltered array
         const normalizedConfig = normalizeBotEntry(botConfig, botIndex);

        // Get signing secret from daemon or interactively
        const preferredAccount = normalizedConfig.preferredAccount;
        const signingSecret = await getSigningSecretForAccount(preferredAccount);

         // Create and start bot with log prefix for [bot.js] context
          const bot = new DEXBot(normalizedConfig, { logPrefix: '[bot.js]' });
          const botCleanupName = `Bot: ${botName}`;
          let botCleanupHandler: (() => void) | null = null;
          try {
              // Register bot cleanup on shutdown
              botCleanupHandler = () => bot.shutdown();
              registerCleanup(botCleanupName, botCleanupHandler);

              await bot.startWithPrivateKey(signingSecret);
          } catch (err) {
              // The bot's _runStartupSequence already invoked shutdown() once on
              // the failure path. Remove the registered cleanup so the LIFO
              // cleanup loop in graceful_shutdown.ts does not call shutdown() a
              // second time, and avoid the "double graceful shutdown" log pattern.
              if (botCleanupHandler) {
                  unregisterCleanup(botCleanupHandler);
              }
              // Attempt graceful cleanup before exiting
              try {
                  await bot.shutdown();
              } catch (shutdownErr: any) {
                  launcherLogger.error(`Error during cleanup: ${getErrorMessage(shutdownErr)}`);
              }
              throw err;
          }

     } catch (err: any) {
         launcherLogger.error(`Failed to start bot: ${getErrorMessage(err)}`);
         runtime.exit(1);
     }
})();
export {};
