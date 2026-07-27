/** Maintenance runtime - periodic sync loops, grid health checks, rebalance */
const { createHash } = require('./crypto/sync');
const fs = require('fs');
const { path } = require('./path_api');
const { spawn } = require('child_process');
const chainOrders = require('./chain_orders');
const grid = require('./order/grid');
const { ORDER_STATES, ORDER_TYPES, TIMING, BTS_PRECISION, NATIVE_CLIENT } = require('./constants');
const { PATHS } = require('./paths');
const Format = require('./order/format');
const { getStorage } = require('./storage');
const storage = getStorage();
const fundRegistry = require('./fund_registry');

const { BitShares } = require('./bitshares_client');
const { BroadcastUncertainError } = require('./dexbot_credential_client');
const { Config } = require('./config');
function getNodeManager(...args: any) { return require('./bitshares_client').getNodeManager(...args); }
function hasOpenOrdersSyncLoopMsSet(...args: any) { return require('./config').hasOpenOrdersSyncLoopMsSet(...args); }
function getOpenOrdersSyncLoopMs(...args: any) { return require('./config').getOpenOrdersSyncLoopMs(...args); }
function isGridBloated(...args: any) { return grid.isGridBloated(...args); }
function isGridBloatGraceActive(...args: any) { return grid.isGridBloatGraceActive(...args); }
function clearGridBloatFlag(...args: any) { return grid.clearGridBloatFlag(...args); }
function recalculateGrid(...args: any) { return grid.recalculateGrid(...args); }
function buildRuntimeScriptPath(...args: any) { return require('./launcher/runtime_entry').buildRuntimeScriptPath(...args); }
function isDistCodeRoot(...args: any) { return require('./launcher/runtime_entry').isDistCodeRoot(...args); }
function applyGridDivergenceCorrections(...args: any) { return require('./order/utils/system').applyGridDivergenceCorrections(...args); }
function loadAmaCenterSnapshot(...args: any) { return require('./order/utils/system').loadAmaCenterSnapshot(...args); }
function sleep(...args: any) { return require('./order/utils/system').sleep(...args); }
function parseJsonWithComments(...args: any) { return require('./order/utils/system').parseJsonWithComments(...args); }
function isPm2Runtime(...args: any) { return require('./order/logger').isPm2Runtime(...args); }
function getSharedMarketAdapterRuntime(...args: any) { return require('./launcher/market_adapter_runtime').getSharedMarketAdapterRuntime(...args); }
function resetMarketAdapterWhitelistCache(...args: any) { return require('./market_adapter_whitelist').resetMarketAdapterWhitelistCache(...args); }
function isBotDynamicWeightWhitelisted(...args: any) { return require('./market_adapter_whitelist').isBotDynamicWeightWhitelisted(...args); }
function cloneWeightDistribution(...args: any) { return require('./order/utils/math').cloneWeightDistribution(...args); }
function calculateOrderCreationFees(...args: any) { return require('./order/utils/math').calculateOrderCreationFees(...args); }
function calculateSwapInAmount(...args: any) { return require('./order/utils/math').calculateSwapInAmount(...args); }
function floatToBlockchainInt(...args: any) { return require('./order/utils/math').floatToBlockchainInt(...args); }
function blockchainToFloat(...args: any) { return require('./order/utils/math').blockchainToFloat(...args); }
function updateDynamicGridSnapshotSync(...args: any) { return require('../market_adapter/utils/dynamic_grid_snapshot').updateDynamicGridSnapshotSync(...args); }
function reconcileGridOrders(...args: any) { return require('./order/grid_reconcile').reconcileGridOrders(...args); }
function formatUnmatchedChainOrder(...args: any) { return require('./order/utils/order').formatUnmatchedChainOrder(...args); }
function getSideBudget(...args: any) { return require('./order/utils/order').getSideBudget(...args); }
function correctAllPriceMismatches(...args: any) { return require('./order/utils/order').correctAllPriceMismatches(...args); }
function isOrderOnChain(...args: any) { return require('./order/utils/order').isOrderOnChain(...args); }
function parseChainOrder(...args: any) { return require('./order/utils/order').parseChainOrder(...args); }
const { ensureDir, safeUnlink } = require('./utils/fs_utils');
const { getErrorMessage } = require('./utils/errors');

const CODE_ROOT = path.join(__dirname, '..');
const PROFILES_DIR = PATHS.PROFILES_DIR;
const PROFILES_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const LOGS_DIR = PATHS.LOGS_DIR;
const MARKET_ADAPTER_APP_NAME = 'dexbot-adapter';
const MARKET_ADAPTER_SCRIPT = buildRuntimeScriptPath(CODE_ROOT, ['market_adapter', 'market_adapter']);
const MARKET_ADAPTER_ERROR_FILE = path.join(LOGS_DIR, 'dexbot-adapter-error.log');
const MARKET_ADAPTER_OUT_FILE = path.join(LOGS_DIR, 'dexbot-adapter.log');
const MARKET_ADAPTER_TRIGGER_SOURCE = 'market_adapter/market_adapter' + (isDistCodeRoot(CODE_ROOT) ? '.js' : '.ts');
const MANUAL_TRIGGER_METADATA = {
    shouldRefreshCenterPrice: true,
    centerRefreshContext: 'manual grid resync',
    centerRefreshLabel: 'manual grid reset',
    resetSource: 'manual_grid_resync',
};
const MARKET_ADAPTER_TRIGGER_RESETS = Object.freeze({
    market_adapter_bootstrap: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'AMA bootstrap grid resync',
        centerRefreshLabel: 'AMA bootstrap grid reset',
    },
    market_adapter_ama_slope_delta_threshold: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'AMA slope grid resync',
        centerRefreshLabel: 'AMA slope grid reset',
    },
    market_adapter_delta_threshold: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'AMA center grid resync',
        centerRefreshLabel: 'AMA center grid reset',
    },
});
const GRID_RESYNC_REASONS = Object.freeze({
    ...MARKET_ADAPTER_TRIGGER_RESETS,
    manual_grid_resync: MANUAL_TRIGGER_METADATA,
    rms_structural_grid_resync: {
        shouldRefreshCenterPrice: true,
        centerRefreshContext: 'RMS structural grid resync',
        centerRefreshLabel: 'RMS structural grid resync',
    },
});

/**
 * Check if a bot configuration uses an AMA grid price source.
 * @param {Object} bot - Bot configuration object
 * @returns {boolean} True if gridPrice starts with 'ama' (ama, ama1..ama4)
 */
function usesAmaGridPrice(bot: any) {
    const gridPrice = String(bot?.gridPrice || '').trim().toLowerCase();
    return /^ama(?:[1-4])?$/.test(gridPrice);
}

/**
 * Find a bot entry in the bots config snapshot that matches a runtime config.
 * Matches by botKey or name.
 * @param {import('./types').BotsConfigSnapshot} snapshot - Bots configuration snapshot
 * @param {Object} config - Runtime bot configuration
 * @returns {Object|null} Matched bot entry or null
 */
function findSnapshotBotForRuntimeConfig(snapshot: any, config: any) {
    if (!snapshot || !Array.isArray(snapshot.activeBots) || !config) {
        return null;
    }

    const botKey = config.botKey ? String(config.botKey) : null;
    const name = config.name ? String(config.name) : null;
    return snapshot.activeBots.find((bot: any) => {
        if (!bot) return false;
        if (botKey && String(bot.botKey || '') === botKey) return true;
        if (name && String(bot.name || '') === name) return true;
        return false;
    }) || null;
}

/**
 * Check if a runtime bot configuration requires the market adapter.
 * @param {import('./types').BotsConfigSnapshot} snapshot - Bots configuration snapshot
 * @param {Object} config - Runtime bot configuration
 * @returns {boolean} True if the bot uses AMA grid pricing
 */
function runtimeConfigNeedsMarketAdapter(snapshot: any, config: any) {
    const snapshotBot = findSnapshotBotForRuntimeConfig(snapshot, config);
    if (snapshotBot) {
        return usesAmaGridPrice(snapshotBot);
    }
    return usesAmaGridPrice(config);
}

function countLiveGridOrders(manager: any, type: any) {
    if (!manager) return 0;
    const active = manager.getOrdersByTypeAndState?.(type, ORDER_STATES.ACTIVE) || [];
    const partial = manager.getOrdersByTypeAndState?.(type, ORDER_STATES.PARTIAL) || [];
    return active.concat(partial).filter((o: any) => o?.orderId).length;
}

function getTargetActiveOrders(config: any, side: any) {
    const configured = Number(config?.activeOrders?.[side]);
    return Math.max(0, Number.isFinite(configured) ? configured : 1);
}

function _hasBudgetForSide(manager: any, config: any, side: any) {
    try {
        const funds = manager?.getChainFundsSnapshot?.();
        if (!funds) return true;
        const allocated = side === 'buy' ? (funds.allocatedBuy || 0) : (funds.allocatedSell || 0);
        if (allocated <= 0) return false;
        const targetBuy = Math.max(0, config?.activeOrders?.buy ?? 1);
        const targetSell = Math.max(0, config?.activeOrders?.sell ?? 1);
        const totalTarget = targetBuy + targetSell;
        const budget = getSideBudget(side, funds, config, totalTarget);
        return budget > 0;
    } catch { return true; }
}

function getTargetedSyncReason(bot: any) {
    if (!bot.manager || bot.config?.dryRun) return null;

    const targetBuy = getTargetActiveOrders(bot.config, 'buy');
    const targetSell = getTargetActiveOrders(bot.config, 'sell');
    const liveBuy = countLiveGridOrders(bot.manager, ORDER_TYPES.BUY);
    const liveSell = countLiveGridOrders(bot.manager, ORDER_TYPES.SELL);
    const shortfalls: string[] = [];

    if (liveBuy < targetBuy) {
        if (_hasBudgetForSide(bot.manager, bot.config, 'buy')) {
            shortfalls.push(`buy ${liveBuy}/${targetBuy}`);
        }
    }
    if (liveSell < targetSell) {
        if (_hasBudgetForSide(bot.manager, bot.config, 'sell')) {
            shortfalls.push(`sell ${liveSell}/${targetSell}`);
        }
    }

    const drift = bot.manager.checkFundDriftAfterFills?.();
    if (drift && drift.isValid === false) {
        return { reason: `fund drift: ${drift.reason}`, targetBuy, targetSell, liveBuy, liveSell, drift };
    }

    if (shortfalls.length > 0) {
        return { reason: `active order shortfall: ${shortfalls.join(', ')}`, targetBuy, targetSell, liveBuy, liveSell, drift };
    }

    return null;
}

async function maybeRunTargetedDriftReconciliation(bot: any, context: any) {
    const trigger = getTargetedSyncReason(bot);
    if (!trigger) return false;

    const now = Date.now();
    const cooldownMs = Number.isFinite(Number(bot._targetedDriftSyncCooldownMs))
        ? Number(bot._targetedDriftSyncCooldownMs)
        : 60_000;
    const lastSyncAt = Number(bot._lastTargetedDriftSyncAt || 0);
    if (lastSyncAt > 0 && now - lastSyncAt < cooldownMs) {
        bot._log(
            `[TARGETED-SYNC] Deferring ${context} reconciliation for ${Math.ceil((cooldownMs - (now - lastSyncAt)) / TIMING.MILLISECONDS_PER_SECOND)}s: ${trigger.reason}`,
            'debug'
        );
        return false;
    }

    if (!bot.accountId || typeof chainOrders.readOpenOrders !== 'function') {
        bot._warn(`[TARGETED-SYNC] Cannot reconcile ${context}: missing account id or readOpenOrders`);
        return false;
    }

    bot._log(`[TARGETED-SYNC] Fetching open orders during ${context}: ${trigger.reason}`, 'warn');

    try {
        await bot.manager.fetchAccountTotals?.(bot.accountId);
        const { syncResult, openOrders, aborted } = await bot._syncOpenOrdersAndProcessFills(`targeted ${context} reconciliation`);
        if (aborted) {
            bot._warn(`[TARGETED-SYNC] Chain sync failed during ${context}, skipping reconciliation`);
            return false;
        }

        const remaining = getTargetedSyncReason(bot);
        const unmatchedCount = Number(syncResult?.unmatchedChainOrders?.length || 0);
        if (remaining || unmatchedCount > 0) {
            bot._log(
                `[TARGETED-SYNC] Running startup-style reconcile during ${context}: ` +
                `${remaining ? remaining.reason : `${unmatchedCount} unmatched chain order(s)`}`,
                'warn'
            );
            const reconcileResult = await reconcileGridOrders({
                manager: bot.manager,
                config: bot.config,
                account: bot.account,
                privateKey: bot.privateKey,
                chainOrders,
                chainOpenOrders: openOrders,
            });
            await bot._executeBatchIfNeeded(reconcileResult, `targeted ${context} reconcile`);
        }

        // Advance cooldown only after the sync (and optional reconcile) succeeds.
        // Previously this was set before the work, which meant a network blip
        // would lock out the next drift for the full cooldown even though no
        // useful work happened. With post-sync stamping, transient failures
        // retry on the next maintenance tick.
        bot._lastTargetedDriftSyncAt = Date.now();
        await bot.manager.persistGrid?.();
        return true;
    } catch (err: any) {
        bot._warn(`[TARGETED-SYNC] Failed during ${context}: ${getErrorMessage(err)}`);
        return false;
    }
}

/**
 * Load and fingerprint the bots.json configuration file.
 * @returns {import('./types').BotsConfigSnapshot} Snapshot with exists flag, fingerprint, active bots list, and adapter requirement
 */
function loadBotsConfigSnapshot() {
    if (!storage.exists(PROFILES_BOTS_FILE)) {
        return {
            exists: false,
            fingerprint: null,
            activeBots: [],
            needsMarketAdapter: false,
        };
    }

    const raw = storage.readFile(PROFILES_BOTS_FILE);
    if (!raw || !raw.trim()) {
        return {
            exists: false,
            fingerprint: null,
            activeBots: [],
            needsMarketAdapter: false,
        };
    }

    const fingerprint = createHash('sha1').update(raw).digest('hex');
    const parsed = parseJsonWithComments(raw);
    const bots = Array.isArray(parsed?.bots) ? parsed.bots.filter(Boolean) : [];
    const activeBots = bots.filter((bot: any) => bot.active !== false);

    return {
        exists: true,
        fingerprint,
        config: parsed,
        activeBots,
        needsMarketAdapter: activeBots.some(usesAmaGridPrice),
    };
}

/**
 * Parse PM2 jlist command output to extract process names.
 * @param {string} stdout - Raw stdout from pm2 jlist
 * @returns {string[]} Array of process names
 * @throws {Error} If output cannot be parsed
 */
function parsePm2JlistOutput(stdout: any) {
    const output = String(stdout || '').trim();
    if (!output) return [];

    const jsonStart = output.indexOf('[');
    if (jsonStart === -1) {
        throw new Error('pm2 jlist output did not contain JSON');
    }

    const parsed = JSON.parse(output.slice(jsonStart));
    if (!Array.isArray(parsed)) {
        throw new Error('pm2 jlist output was not an array');
    }

    return parsed.map((proc: any) => String(proc?.name || '')).filter(Boolean);
}

/**
 * Run a PM2 CLI command and return stdout/stderr.
 * @param {string[]} args - PM2 command arguments
 * @returns {Promise<{stdout: string, stderr: string}>} Command output
 * @throws {Error} If the command exits with non-zero code
 */
function runPm2Command(args: any): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve: any, reject: any) => {
        const child = spawn('pm2', args, {
            stdio: 'pipe',
            shell: Config.PLATFORM === 'win32',
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: any) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data: any) => {
            stderr += data.toString();
        });

        child.on('close', (code: any) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            reject(new Error(stderr || stdout || `pm2 exited with code ${code}`));
        });

        child.on('error', reject);
    });
}

/**
 * Get list of running PM2 process names.
 * @returns {Promise<string[]>} Array of process names
 */
async function getPm2ProcessNames() {
    const { stdout } = await runPm2Command(['jlist']);
    return parsePm2JlistOutput(stdout);
}

/**
 * Start the market adapter process under PM2.
 * @returns {Promise<void>}
 */
async function startMarketAdapterPm2() {
    if (!storage.exists(LOGS_DIR)) {
        ensureDir(LOGS_DIR);
    }

    const pm2Args = [
        'start',
        MARKET_ADAPTER_SCRIPT,
    ];
    if (!isDistCodeRoot(CODE_ROOT)) {
        pm2Args.push('--node-args', '--import', '--node-args', 'tsx');
    }
    pm2Args.push(
        '--name',
        MARKET_ADAPTER_APP_NAME,
        '--cwd',
        PATHS.PROJECT_ROOT,
        '--output',
        MARKET_ADAPTER_OUT_FILE,
        '--error',
        MARKET_ADAPTER_ERROR_FILE,
        '--max-memory-restart',
        '150M',
        '--log-date-format',
        'YY-MM-DD HH:mm:ss.SSS',
    );
    await runPm2Command(pm2Args);
}

/**
 * Stop and delete the market adapter process from PM2.
 * @returns {Promise<void>}
 */
async function stopMarketAdapterPm2() {
    await runPm2Command(['delete', MARKET_ADAPTER_APP_NAME]);
}

/**
 * Synchronize market adapter state based on periodic config checks.
 * Starts or stops the market adapter based on whether any active bot uses AMA grid pricing.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} [context='periodic'] - Context label for logging
 * @returns {Promise<import('./types').MarketAdapterSyncResult>}
 */
async function syncMarketAdapterOnPeriodicConfigCheck(bot: any, context: any = 'periodic') {
    if (bot._marketAdapterWatchdogInFlight) {
        return { skipped: true, reason: 'in-flight' };
    }

    bot._marketAdapterWatchdogInFlight = true;

    try {
        const snapshot = typeof bot._loadBotsConfigSnapshot === 'function'
            ? await bot._loadBotsConfigSnapshot()
            : loadBotsConfigSnapshot();
        const previousFingerprint = bot._marketAdapterWatchdogFingerprint || null;
        const changed = snapshot.fingerprint !== previousFingerprint;
        bot._marketAdapterWatchdogFingerprint = snapshot.fingerprint;

        if (changed) {
            bot._log(`Detected bots.json changes during ${context}; re-evaluating market adapter requirements.`);
        }

        if (!isPm2Runtime()) {
            const runtime = getSharedMarketAdapterRuntime({ root: PATHS.PROJECT_ROOT });
            const botId = String(bot.config?.botKey || bot.config?.name || bot.config?.preferredAccount || bot.config?.assetA || 'dexbot');
            const botNeedsMarketAdapter = !!snapshot.exists && runtimeConfigNeedsMarketAdapter(snapshot, bot.config);
            const required = !!snapshot.needsMarketAdapter || botNeedsMarketAdapter;
            const result = await runtime.syncBot(botId, botNeedsMarketAdapter);

            if (!snapshot.exists || !required) {
                if (result?.stopped) {
                    bot._log(`Stopped ${MARKET_ADAPTER_APP_NAME} because no AMA grid bots are active.`, 'info');
                }
                return {
                    changed,
                    required: false,
                    running: !!result?.running,
                    started: false,
                    stopped: !!result?.stopped,
                    mode: 'direct',
                };
            }

            if (result?.started) {
                bot._log(`Started ${MARKET_ADAPTER_APP_NAME} because AMA grid pricing is active.`, 'info');
            }

            return {
                changed,
                required,
                running: !!result?.running,
                started: !!result?.started,
                stopped: false,
                mode: 'direct',
            };
        }

        const getPm2ProcessNamesFn = typeof bot._getPm2ProcessNames === 'function'
            ? bot._getPm2ProcessNames.bind(bot)
            : getPm2ProcessNames;
        const startMarketAdapterFn = typeof bot._startMarketAdapterPm2 === 'function'
            ? bot._startMarketAdapterPm2.bind(bot)
            : startMarketAdapterPm2;
        const stopMarketAdapterFn = typeof bot._stopMarketAdapterPm2 === 'function'
            ? bot._stopMarketAdapterPm2.bind(bot)
            : stopMarketAdapterPm2;

        let processNames: string[] = [];
        let pm2QueryFailed = false;
        try {
            processNames = await getPm2ProcessNamesFn();
        } catch (err: any) {
            pm2QueryFailed = true;
            bot._warn(`Could not query PM2 for ${MARKET_ADAPTER_APP_NAME}: ${getErrorMessage(err)}. Using a direct PM2 action.`);
        }

        // Cross-reference config-active bots against actually running PM2 processes
        // so we don't start the adapter for configured AMA bots that aren't running.
        const runningActiveBots = pm2QueryFailed
            ? snapshot.activeBots
            : snapshot.activeBots.filter((b: any) => processNames.includes(b.name));
        const needsAdapterForRunningBots = runningActiveBots.some(usesAmaGridPrice);

        if (!snapshot.exists || !needsAdapterForRunningBots) {
            const shouldStop = pm2QueryFailed || processNames.includes(MARKET_ADAPTER_APP_NAME);
            if (!shouldStop) {
                return {
                    changed,
                    required: false,
                    running: false,
                    started: false,
                    stopped: false,
                    mode: 'pm2',
                };
            }

            await stopMarketAdapterFn();
            bot._log(`Stopped ${MARKET_ADAPTER_APP_NAME} because no AMA grid bots are running.`, 'info');
            return {
                changed,
                required: false,
                running: false,
                started: false,
                stopped: true,
                mode: 'pm2',
            };
        }

        if (processNames.includes(MARKET_ADAPTER_APP_NAME)) {
            return {
                changed,
                required: true,
                running: true,
                started: false,
                stopped: false,
                mode: 'pm2',
            };
        }

        await startMarketAdapterFn();
        bot._log(`Started ${MARKET_ADAPTER_APP_NAME} because AMA grid pricing is active.`, 'info');

        return {
            changed,
            required: true,
            running: false,
            started: true,
            stopped: false,
            mode: 'pm2',
        };
    } catch (err: any) {
        bot._warn(`Market adapter watchdog failed during ${context}: ${getErrorMessage(err)}`);
        return {
            changed: false,
            required: false,
            running: false,
            started: false,
            stopped: false,
            error: getErrorMessage(err),
        };
    } finally {
        bot._marketAdapterWatchdogInFlight = false;
    }
}

/**
 * Refresh the dynamic weight distribution from the AMA center snapshot.
 * Applies live dynamic weights if the bot is whitelisted and weights are ready.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} [context='runtime'] - Context label for logging
 * @returns {import('./types').DynamicWeightRefreshResult}
 */
function refreshDynamicWeightDistribution(bot: any, context: any = 'runtime') {
    const baseWeights = cloneWeightDistribution(
        bot._baseWeightDistribution,
        bot.config?.weightDistribution || bot.manager?.config?.weightDistribution
    );

    if (!bot.config || !bot.manager || !bot.config.botKey || !baseWeights) {
        return {
            applied: false,
            source: 'static',
            weightDistribution: baseWeights,
        };
    }

    const botKey = bot.config.botKey;
    let nextWeights = baseWeights;
    let source = 'static';
    let snapshot: any = null;

    // Re-read the shared whitelist on every refresh so live flag changes apply
    // without requiring a bot restart.
    resetMarketAdapterWhitelistCache();
    if (isBotDynamicWeightWhitelisted(botKey)) {
        snapshot = loadAmaCenterSnapshot(botKey);
        const dw = snapshot?.dynamicWeights;
        const liveWeights = cloneWeightDistribution(dw?.effectiveWeights);
        if (dw?.isReady && liveWeights) {
            const snapshotBase = cloneWeightDistribution(dw?.baseWeights);
            const baseChanged = !snapshotBase
                || snapshotBase.sell !== baseWeights.sell
                || snapshotBase.buy !== baseWeights.buy;
            if (baseChanged) {
                bot._log(
                    `Skipping stale dynamic weights (${context}): ` +
                    `snapshot base (sell=${snapshotBase?.sell}, buy=${snapshotBase?.buy}) ` +
                    `!= config (sell=${baseWeights.sell}, buy=${baseWeights.buy})`,
                    'warn'
                );
            } else {
                nextWeights = liveWeights;
                source = 'dynamic';
            }
        }
    }

    bot.config.weightDistribution = { ...nextWeights };
    if (bot.manager?.config) {
        bot.manager.config.weightDistribution = { ...nextWeights };
    }

    if (source === 'dynamic') {
        bot._log(
            `Applied live dynamic weights (${context}): sell=${nextWeights.sell} buy=${nextWeights.buy}`,
            'info'
        );
    }

    return {
        applied: source === 'dynamic',
        source,
        weightDistribution: nextWeights,
        snapshotUpdatedAt: snapshot?.updatedAt || null,
    };
}

/**
 * Read and parse a trigger file's metadata payload.
 * Determines whether the trigger originated from the market adapter or was manual.
 * @param {string} triggerFile - Path to the trigger file
 * @returns {import('./types').GridResyncMetadata} Parsed trigger metadata
 */
function readTriggerMetadata(triggerFile: any) {
    const manualTriggerMetadata = (payload: any = null) => ({
        ...buildGridResyncMetadata('manual_grid_resync'),
        payload,
    });

    const marketAdapterTriggerMetadata = (payload: any) => {
        const reason = String(payload?.reason || '').trim();
        return {
            ...buildGridResyncMetadata(reason || 'market_adapter_grid_resync'),
            payload,
        };
    };

    try {
        const raw = storage.readFile(triggerFile).trim();
        if (!raw) {
            // An empty trigger is the legacy/manual CLI reset signal.
            return manualTriggerMetadata();
        }

        const payload = JSON.parse(raw);
        const source = String(payload?.source || '').trim();
        return source === MARKET_ADAPTER_TRIGGER_SOURCE
            ? marketAdapterTriggerMetadata(payload)
            : manualTriggerMetadata(payload);
    } catch (_: any) {
        return manualTriggerMetadata();
    }
}

/**
 * Build grid resync metadata from a reason string.
 * Maps known reason strings to structured metadata with refresh flags.
 * @param {string} reason - Resync reason identifier (e.g. 'manual_grid_resync', 'rms_structural_grid_resync')
 * @returns {import('./types').GridResyncMetadata}
 */
function buildGridResyncMetadata(reason: any) {
    const resetSource = String(reason || '').trim() || 'dexbot_grid_resync';
    const defaults = {
        shouldRefreshCenterPrice: false,
        centerRefreshContext: 'grid resync',
        centerRefreshLabel: 'grid resync',
    };
    const marketAdapterUnknown = resetSource === 'market_adapter_grid_resync'
        ? {
            centerRefreshContext: 'market adapter grid resync',
            centerRefreshLabel: 'market adapter grid reset',
        }
        : null;
    return {
        ...defaults,
        ...marketAdapterUnknown,
        ...((GRID_RESYNC_REASONS as Record<string, any>)[resetSource] || {}),
        resetSource,
    };
}

/**
 * Build grid resync options from a reason string or metadata object.
 * @param {string|import('./types').GridResyncMetadata} reasonOrMetadata - Reason string or metadata object
 * @returns {import('./types').GridResyncOptions}
 */
function buildGridResyncOptions(reasonOrMetadata: any) {
    const metadata = typeof reasonOrMetadata === 'string'
        ? buildGridResyncMetadata(reasonOrMetadata)
        : reasonOrMetadata;
    return {
        refreshCenterPrice: !!metadata?.shouldRefreshCenterPrice,
        centerRefreshContext: metadata?.centerRefreshContext,
        centerRefreshLabel: metadata?.centerRefreshLabel,
        resetSource: metadata?.resetSource,
    };
}

/**
 * Promote the AMA center price to the grid center price in the dynamic grid snapshot.
 * Used during grid resets to align the grid center with the latest AMA calculation.
 * @param {string} botKey - Bot identifier key
 * @returns {boolean} True if promotion succeeded
 */
function promoteAmaCenterSnapshotForGridReset(botKey: any) {
    if (!botKey) return false;

    // Full grid resets rebuild from the latest AMA center. The active grid
    // baseline is promoted to that value before recalculation, while the raw
    // AMA output remains intact in amaCenterPrice for diagnostics.
    const snapshotPath = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);
    try {
        const result = updateDynamicGridSnapshotSync(snapshotPath, (snapshot: any) => {
            const amaCenterPrice = Number(snapshot?.amaCenterPrice);
            if (!Number.isFinite(amaCenterPrice) || amaCenterPrice <= 0) {
                return { ok: false, write: false };
            }

            const currentCenterPrice = Number(snapshot?.gridCenterPrice ?? snapshot?.centerPrice);
            if (Number.isFinite(currentCenterPrice) && currentCenterPrice === amaCenterPrice) {
                return { write: false };
            }

            return {
                ...snapshot,
                gridCenterPrice: amaCenterPrice,
                centerPrice: amaCenterPrice,
                updatedAt: new Date().toISOString(),
            };
        });
        return result.ok;
    } catch (_: any) {
        return false;
    }
}

/**
 * Update the grid reset metadata (last reset timestamp and source) in the dynamic grid snapshot.
 * @param {string} botKey - Bot identifier key
 * @param {Object} [options] - Reset metadata options
 * @param {string} [options.resetAt] - ISO timestamp for the reset (defaults to now)
 * @param {string} [options.resetSource] - Source label for the reset (defaults to 'dexbot_grid_resync')
 * @returns {boolean} True if metadata was written
 */
function updateBotGridResetMetadata(botKey: any, options: { resetAt?: string; resetSource?: string } = {}) {
    if (!botKey) return false;

    const resetAt = options.resetAt || new Date().toISOString();
    const resetSource = options.resetSource || 'dexbot_grid_resync';
    const snapshotPath = path.join(PATHS.ORDERS_DIR, `${botKey}.dynamicgrid.json`);

    try {
        const result = updateDynamicGridSnapshotSync(snapshotPath, (snapshot: any) => {
            const gridCenterPrice = Number(snapshot?.gridCenterPrice ?? snapshot?.centerPrice);
            if (!Number.isFinite(gridCenterPrice) || gridCenterPrice <= 0) {
                return { ok: false, write: false };
            }
            return {
                ...snapshot,
                gridCenterPrice,
                centerPrice: gridCenterPrice,
                lastGridResetAt: resetAt,
                lastGridResetSource: resetSource,
                updatedAt: resetAt,
            };
        });
        return result.ok && result.written;
    } catch (_: any) {
        return false;
    }
}

/**
 * Perform a full grid resync: reload config, optionally refresh center price,
 * recalculate the grid, persist, and record reset metadata.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {import('./types').GridResyncOptions} [options] - Grid resync options
 * @returns {Promise<boolean>} True if resync succeeded
 */
function performGridResync(bot: any, options: {
    refreshCenterPrice?: boolean;
    centerRefreshContext?: string;
    centerRefreshLabel?: string;
    resetSource?: string;
} = {}) {
    const self = bot;
    let success = false;
    const refreshCenterPrice = !!options.refreshCenterPrice;
    const centerRefreshContext = options.centerRefreshContext || (refreshCenterPrice ? 'grid reset recenter' : 'grid resync');
    const centerRefreshLabel = options.centerRefreshLabel || (refreshCenterPrice ? 'grid reset' : 'grid resync');
    const resetSource = options.resetSource || (refreshCenterPrice ? 'manual_grid_resync' : 'dexbot_grid_resync');
    const idleDelayMs = getMaintenanceIdleDelayMs(self);
    if (idleDelayMs > 0) {
        self._log(
            `[MAINT-IDLE] Deferring grid resync until bot is idle` +
            ` (next check in ${Math.ceil(idleDelayMs / TIMING.MILLISECONDS_PER_SECOND)}s)`,
            'info'
        );
        scheduleDeferredGridResync(self, options);
        return Promise.resolve(false);
    }

    self.manager.startBootstrap();
    self._log('Grid regeneration triggered. Performing full grid resync...');
    return (async () => {
        try {
            try {
                const content = storage.readFile(PROFILES_BOTS_FILE);
                const allBotsConfig = parseJsonWithComments(content).bots || [];
                const myName = self.config.name;
                const updatedBot = allBotsConfig.find((b: any) => b.name === myName);

                if (updatedBot) {
                    self._log(`Reloaded configuration for bot '${myName}'`);
                    const oldKey = self.config.botKey;
                    const oldIndex = self.config.botIndex;
                    self.config = { ...updatedBot, botKey: oldKey, botIndex: oldIndex };
                    self.manager.config = { ...self.manager.config, ...self.config };
                    self._baseWeightDistribution = cloneWeightDistribution(
                        updatedBot.weightDistribution,
                        self._baseWeightDistribution
                    );
                    refreshDynamicWeightDistribution(self, 'grid resync');
                }
            } catch (e: any) {
                self._warn(`Failed to reload config during resync (using current settings): ${getErrorMessage(e)}`);
            }

            if (refreshCenterPrice) {
                if (promoteAmaCenterSnapshotForGridReset(self.config?.botKey)) {
                    self._log(`Refreshed AMA center snapshot for ${centerRefreshLabel}.`, 'info');
                    refreshDynamicWeightDistribution(self, centerRefreshContext);
                } else {
                    self._warn(`${centerRefreshLabel} requested but AMA center snapshot could not be refreshed.`);
                }
            } else {
                // Config was reloaded above but center price didn't change — still need
                // fresh weights so cancelDustOrders uses live distribution (Issue M).
                refreshDynamicWeightDistribution(self, 'grid resync');
            }

            const readFn = () => chainOrders.readOpenOrders(self.accountId);
            await recalculateGrid(self.manager, {
                readOpenOrdersFn: readFn,
                chainOrders,
                account: self.account,
                privateKey: self.privateKey,
                config: self.config,
            });

            self.manager.funds.btsFeesOwed = 0;
            await self.manager.persistGrid();
            success = true;
            if (updateBotGridResetMetadata(self.config?.botKey, {
                resetAt: new Date().toISOString(),
                resetSource,
            })) {
                self._log('Recorded grid reset metadata for dynamic grid state.', 'info');
            }

            safeUnlink(self.triggerFile);
            self._log('Removed trigger file.');

            // Re-detect and cancel dust immediately after full resync.
            if (!self._shuttingDown) {
                try {
                    const resyncHealth = await self.manager.checkGridHealth(
                        self.updateOrdersOnChainPlan?.bind(self)
                    );
                    await cancelDustOrders(self, {
                        buy: resyncHealth.buyDustOrders,
                        sell: resyncHealth.sellDustOrders,
                    });
                } catch (_dustErr: any) {
                    self._warn(`[DUST] Post-resync dust cancel failed: ${getErrorMessage(_dustErr)}`);
                }
            }

            // Clear unmatched chain orders after a successful rebuild.
            // The recalculateGrid call above runs syncFromOpenOrders which
            // sets _lastUnmatchedChainOrders from the chain perspective.
            // Forcing a clean slate here ensures the COW guard does not
            // hold stale unmatched entries from before the resync.
            if (self.manager) {
                self.manager._lastUnmatchedChainOrders = [];
                self.manager._lastUnmatchedChainOrdersAt = 0;
            }
        } catch (err: any) {
            self._log(`Error during triggered resync: ${getErrorMessage(err)}`, 'error');
        } finally {
            self.manager.finishBootstrap();
        }

        return success;
    })();
}

/**
 * Handle a pending trigger file detected at startup or during runtime.
 * Processes the trigger and performs a grid resync if the trigger file exists.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Promise<boolean>} True if reset was handled successfully
 */
async function handlePendingTriggerReset(bot: any) {
    if (!storage.exists(bot.triggerFile)) {
        return false;
    }

    bot._log('Pending trigger file detected. Processing reset before startup...');
    const triggerInfo = readTriggerMetadata(bot.triggerFile);

    let resetSucceeded = false;
    await bot.manager._fillProcessingLock.acquire(async () => {
        resetSucceeded = await performGridResync(bot, buildGridResyncOptions(triggerInfo));
    });

    if (!resetSucceeded) {
        bot._warn('Pending trigger reset failed. Continuing with normal startup path.');
    }

    return resetSucceeded;
}

/**
 * Set up a file watcher on the profiles directory to detect trigger file creation.
 * When a trigger file appears, debounces and processes the grid resync.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Promise<void>}
 */
async function setupTriggerFileDetection(bot: any) {
    if (bot._triggerWatcher && typeof bot._triggerWatcher.close === 'function') {
        bot._triggerWatcher.close();
        bot._triggerWatcher = null;
    }

    if (bot._triggerDebounceTimer) {
        clearTimeout(bot._triggerDebounceTimer);
        bot._triggerDebounceTimer = null;
    }

    try {
        bot._triggerWatcher = fs.watch(PROFILES_DIR, (eventType: any, filename: any) => {
            try {
                if (bot._shuttingDown) return;

                if (filename === path.basename(bot.triggerFile)) {
                    if ((eventType === 'rename' || eventType === 'change') && storage.exists(bot.triggerFile)) {
                        if (bot._triggerDebounceTimer) clearTimeout(bot._triggerDebounceTimer);
                        bot._triggerDebounceTimer = setTimeout(() => {
                            bot._triggerDebounceTimer = null;
                            // Re-check shutdown: the fs.watch callback checked
                            // _shuttingDown at debounce-schedule time, but the
                            // 200ms delay can outlive the start of shutdown.
                            // Acquiring the fill lock with a torn-down manager
                            // would be a no-op-or-error at best and a use-after-
                            // free at worst.
                            if (bot._shuttingDown || !bot.manager?._fillProcessingLock) return;
                            const triggerInfo = readTriggerMetadata(bot.triggerFile);
                            bot.manager._fillProcessingLock.acquire(async () => {
                                if (bot._shuttingDown) return;
                                const ok = await performGridResync(bot, buildGridResyncOptions(triggerInfo));
                                if (!ok) {
                                    bot._warn('Runtime trigger reset failed; retaining existing grid state.');
                                }
                            }).catch((err: any) => {
                                bot._warn(`Trigger reset lock error: ${getErrorMessage(err)}`);
                                bot.manager._recoveryState = { ...bot.manager._recoveryState, lastFailureAt: Date.now() };
                            });
                        }, 200);
                    }
                }
            } catch (err: any) {
                bot._warn(`fs.watch handler error: ${err && getErrorMessage(err) ? getErrorMessage(err) : err}`);
            }
        });
    } catch (err: any) {
        bot._warn(`Failed to setup file watcher: ${getErrorMessage(err)}`);
    }
}

/**
 * Perform periodic grid health checks (divergence, spread condition, dust detection).
 * Called as part of the periodic blockchain fetch interval.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Promise<void>}
 */
async function performPeriodicGridChecks(bot: any) {
    if (typeof bot._runGridMaintenance === 'function') {
        await bot._runGridMaintenance('periodic');
    } else {
        await runGridMaintenance(bot, 'periodic');
    }
}

/**
 * Check if the continuous open-orders sync loop is enabled.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {boolean} True if the sync loop is enabled in TIMING config
 */
function isOpenOrdersSyncLoopEnabled(bot: any) {
    if (bot.config?.timing?.openOrdersSyncLoopEnabled !== undefined) {
        return !!bot.config.timing.openOrdersSyncLoopEnabled;
    }
    return !!TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED;
}

/**
 * Start the continuous open-orders sync loop.
 * Periodically reads on-chain orders and synchronizes with the grid manager.
 * @param {import('./dexbot_class').DEXBot} bot
 */
function startOpenOrdersSyncLoop(bot: any) {
    if (bot._mainLoopPromise) return;

    const hasEnvLoopDelay = hasOpenOrdersSyncLoopMsSet();
    const loopDelayRaw = getOpenOrdersSyncLoopMs();
    const configuredLoopDelayMs = hasEnvLoopDelay && loopDelayRaw !== undefined ? loopDelayRaw : Number(TIMING.RUN_LOOP_DEFAULT_MS);
    const loopDelayMs = Number.isFinite(configuredLoopDelayMs) && configuredLoopDelayMs > 0
        ? configuredLoopDelayMs
        : Number(TIMING.RUN_LOOP_DEFAULT_MS);

    if (hasEnvLoopDelay && loopDelayMs !== configuredLoopDelayMs) {
        bot._warn(`Invalid OPEN_ORDERS_SYNC_LOOP_MS='${Config._OPEN_ORDERS_SYNC_LOOP_MS_RAW}'. Falling back to default ${TIMING.RUN_LOOP_DEFAULT_MS}ms.`);
    }

    bot._mainLoopActive = true;
    bot._log(`Open-orders sync loop started (every ${loopDelayMs}ms, dryRun=${!!bot.config.dryRun})`);
    const readOpenOrdersFn = chainOrders.readOpenOrders;

    bot._mainLoopPromise = (async () => {
        while (bot._mainLoopActive && !bot._shuttingDown) {
            try {
                if (bot.manager && bot.accountId && !bot.config.dryRun) {
                    if (!bot.manager._fillProcessingLock.isLocked() &&
                        bot.manager._fillProcessingLock.getQueueLength() === 0) {
                        await bot.manager._fillProcessingLock.acquire(async () => {
                            const chainOpenOrders = await readOpenOrdersFn.call(chainOrders, bot.accountId);
                            const syncResult = await bot.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');

                            if (syncResult?.filledOrders && syncResult.filledOrders.length > 0) {
                                bot._log(`Open-orders sync loop: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                                bot._markGridActivity?.('open-orders sync fill');
                                const batchResult = await bot._processFillsWithBatching(
                                    syncResult.filledOrders, new Set(), 'open-orders sync fill rebalance'
                                );
                                if (!batchResult?.aborted) {
                                    await bot.manager.persistGrid();
                                }
                            }
                            // Run grid health / dust detection after every sync tick so
                            // partial-only fills that reduced an order below the dust
                            // threshold (but did not trigger the full-fill gate in the
                            // main processFills path) are caught promptly instead of
                            // waiting up to BLOCKCHAIN_FETCH_INTERVAL_MIN.
                            await performPeriodicGridChecks(bot);
                        });
                    }
                }
            } catch (err: any) {
                bot._warn(`Order manager loop error: ${getErrorMessage(err)}`);
            }

            await sleep(loopDelayMs);
        }
    })().catch((err: any) => {
        bot._warn(`Open-orders sync loop failed: ${err && getErrorMessage(err) ? getErrorMessage(err) : err}`);
    }).finally(() => {
        bot._mainLoopPromise = null;
    });
}

/**
 * Stop the continuous open-orders sync loop.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Promise<void>}
 */
async function stopOpenOrdersSyncLoop(bot: any) {
    bot._mainLoopActive = false;
    if (bot._mainLoopPromise) {
        await bot._mainLoopPromise;
    }
}

/**
 * Set up the periodic blockchain fetch interval.
 * Periodically fetches account totals and syncs open orders from the blockchain.
 * @param {import('./dexbot_class').DEXBot} bot
 */
function setupBlockchainFetchInterval(bot: any) {
    let intervalMin = bot.config?.timing?.BLOCKCHAIN_FETCH_INTERVAL_MIN;

    // Use the per-instance override if set (e.g., from fund registry shared-account detection)
    if (typeof bot._blockchainFetchIntervalMin === 'number' && Number.isFinite(bot._blockchainFetchIntervalMin) && bot._blockchainFetchIntervalMin > 0) {
        intervalMin = bot._blockchainFetchIntervalMin;
    } else if (bot.config?.preferredAccount) {
        // Fallback: check fund registry for shared accounts
        try {
            if (fundRegistry.isSharedAccount(bot.config.preferredAccount)) {
                intervalMin = TIMING.SHARED_ACCOUNT_FETCH_INTERVAL_MIN;
                bot._blockchainFetchIntervalMin = intervalMin;
            }
        } catch (_err: any) {
            bot?._warn?.(`Registry unavailable for shared-account interval check: ${getErrorMessage(_err)}`);
        }
    }

    syncMarketAdapterOnPeriodicConfigCheck(bot, 'startup blockchain fetch setup')
        .catch((err: any) => {
            bot._warn(`Market adapter watchdog failed during startup blockchain fetch setup: ${getErrorMessage(err)}`);
        });

    if (bot._blockchainFetchInterval !== null && bot._blockchainFetchInterval !== undefined) {
        stopBlockchainFetchInterval(bot);
    }

    if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
        bot._log(`Blockchain fetch interval disabled (value: ${intervalMin}). Periodic blockchain updates will not run.`);
        return;
    }

    if (!bot.manager || typeof bot.manager.fetchAccountTotals !== 'function') {
        bot._warn('Cannot start blockchain fetch interval: manager or fetchAccountTotals method missing');
        return;
    }

    if (!bot.accountId) {
        bot._warn('Cannot start blockchain fetch interval: account ID not available');
        return;
    }

    const intervalMs = intervalMin * 60 * TIMING.MILLISECONDS_PER_SECOND;
    bot._blockchainFetchInterval = setInterval(async () => {
        // Skip if shutdown has begun between the previous tick and now:
        // there is no point acquiring _fillProcessingLock or making
        // chain / daemon calls once we are tearing down. The lock would
        // serialize correctly, but we would still do wasted work
        // (syncMarketAdapter, fetchAccountTotals, readOpenOrders)
        // during shutdown.
        if (bot._shuttingDown) return;
        // Guard against overlapping ticks: if the previous tick is still in
        // flight (slow chain / stall), skip rather than queue a second
        // periodic fetch. The fill lock below would still serialize the
        // work, but the second tick would waste a syncMarketAdapter call
        // and a fetchAccountTotals call while waiting.
        if (bot._blockchainFetchInFlight) return;
        bot._blockchainFetchInFlight = true;
        try {
            try {
                await syncMarketAdapterOnPeriodicConfigCheck(bot, 'periodic blockchain fetch');

                await bot.manager._fillProcessingLock.acquire(async () => {
                    if (bot.manager.accountant && typeof bot.manager.accountant.resetRecoveryState === 'function') {
                        bot.manager.accountant.resetRecoveryState();
                    } else {
                        bot.manager._recoveryAttempted = false;
                    }
                    refreshDynamicWeightDistribution(bot, 'periodic blockchain fetch');
                    bot._log(`Fetching blockchain account values (interval: every ${intervalMin}min)`);
                    await bot.manager.fetchAccountTotals(bot.accountId);

                    let chainOpenOrders = [];
                    if (!bot.config.dryRun) {
                        try {
                            chainOpenOrders = await chainOrders.readOpenOrders(bot.accountId);
                            const syncResult = await bot.manager.synchronizeWithChain(chainOpenOrders, 'periodicBlockchainFetch');

                            if (syncResult.filledOrders && syncResult.filledOrders.length > 0) {
                                bot._log(`Periodic sync: ${syncResult.filledOrders.length} grid order(s) found filled on-chain. Triggering rebalance.`, 'info');
                                bot._markGridActivity?.('periodic sync fill rebalance');
                                const batchResult = await bot._processFillsWithBatching(
                                    syncResult.filledOrders, new Set(), 'periodic sync fill rebalance'
                                );
                                if (!batchResult?.aborted) {
                                    await bot.manager.persistGrid();
                                }
                            }

                            if (syncResult.unmatchedChainOrders && syncResult.unmatchedChainOrders.length > 0) {
                                const sample = syncResult.unmatchedChainOrders
                                    .slice(0, 3)
                                    .map(formatUnmatchedChainOrder)
                                    .join(' | ');
                                bot._log(
                                    `Periodic sync: ${syncResult.unmatchedChainOrders.length} chain order(s) not in grid ` +
                                    `(surplus/divergence)${sample ? `: ${sample}` : ''}`,
                                    'warn'
                                );
                            }
                        } catch (err: any) {
                            bot._warn(`Error reading open orders during periodic fetch: ${getErrorMessage(err)}`);
                        }
                    }

                    await performPeriodicGridChecks(bot);
                });
            } catch (err: any) {
                bot._warn(`Error during periodic blockchain fetch: ${err && getErrorMessage(err) ? getErrorMessage(err) : err}`);
            }
        } finally {
            bot._blockchainFetchInFlight = false;
        }
    }, intervalMs);
    if (typeof bot._blockchainFetchInterval.unref === 'function') {
        bot._blockchainFetchInterval.unref();
    }

    bot._log(`Started periodic blockchain fetch interval: every ${intervalMin} minute(s)`);
}

/**
 * Stop the periodic blockchain fetch interval.
 * @param {import('./dexbot_class').DEXBot} bot
 */
function stopBlockchainFetchInterval(bot: any) {
    if (bot._blockchainFetchInterval !== null && bot._blockchainFetchInterval !== undefined) {
        clearInterval(bot._blockchainFetchInterval);
        bot._blockchainFetchInterval = null;
        bot._log('Stopped periodic blockchain fetch interval');
    }
}

/**
 * Release the market adapter runtime for a bot.
 * In PM2 mode this is a no-op; in direct mode it calls the shared runtime's releaseBot.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} botId - Bot identifier
 * @param {string} [context='shutdown'] - Context label for logging
 * @returns {Promise<import('./types').MarketAdapterReleaseResult>}
 */
async function releaseMarketAdapterRuntime(_bot: any, botId: any, context: any = 'shutdown') {
    if (isPm2Runtime()) {
        return { released: false, mode: 'pm2' };
    }

    if (!botId) {
        return { released: false, mode: 'direct', reason: 'missing-bot-id' };
    }

    const runtime = getSharedMarketAdapterRuntime({ root: PATHS.PROJECT_ROOT });
    const result = await runtime.releaseBot(botId);
    return {
        released: true,
        context,
        mode: 'direct',
        ...result,
    };
}

// Dust is cancelled immediately on detection — no timer infrastructure needed.

/**
 * Check if an error message indicates that an order does not exist on the blockchain.
 * @param {string} message - Error message to check
 * @param {string} [orderId] - Optional order ID for context-aware matching
 * @returns {boolean} True if the message indicates a nonexistent order
 */
function isOrderDoesNotExistError(message: any, orderId: any) {
    if (typeof message !== 'string' || message.length === 0) return false;
    const normalized = message.toLowerCase();
    if (/\border\b.*\bdoes not exist\b/i.test(message)) return true;
    if (/\bdoes not exist\b.*\border\b/i.test(message)) return true;
    if (orderId && normalized.includes(String(orderId).toLowerCase())) {
        return /\bdoes not exist\b/i.test(message)
            || /\bcould not find object\b/i.test(message)
            || /\bunable to find object\b/i.test(message)
            || /\bobject\b.*\bnot found\b/i.test(message);
    }
    return false;
}

/**
 * Calculate the remaining idle delay (ms) before grid maintenance can proceed.
 * Waits for fill queue to drain and for recent grid activity to settle.
 * @param {Object} ctx - Bot context with _lastGridActivityAt and _incomingFillQueue
 * @returns {number} Remaining idle delay in ms (0 if bot is idle)
 */
function getMaintenanceIdleDelayMs(ctx: any) {
    const settleDelayMs = Number.isFinite(TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        ? Math.max(0, TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        : 6_000;
    if (settleDelayMs <= 0) return 0;

    if (ctx?._incomingFillQueue?.length > 0) return settleDelayMs;

    const lastActivityAt = Number(ctx?._lastGridActivityAt || 0);
    if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return 0;

    return Math.max(0, settleDelayMs - (Date.now() - lastActivityAt));
}

/**
 * Schedule grid maintenance to run after the bot becomes idle.
 * @param {Object} ctx - Bot context
 * @param {string} context - Context label for logging
 * @param {Object} [options] - Maintenance options forwarded to runGridMaintenance
 */
function scheduleMaintenanceAfterIdle(ctx: any, context: any, options: any = {}) {
    if (!ctx || ctx._shuttingDown || ctx._maintenanceIdleTimer || !ctx.manager?._fillProcessingLock) return;

    const delayMs = getMaintenanceIdleDelayMs(ctx);
    if (!(delayMs > 0)) return;

    const timerOptions = {
        ...(options || {}),
    };

    ctx._maintenanceIdleTimer = setTimeout(() => {
        ctx._maintenanceIdleTimer = null;
        if (ctx._shuttingDown) return;
        ctx._runGridMaintenance(context, timerOptions)
            .catch((err: any) => {
                ctx._warn(`Deferred ${context} grid maintenance failed: ${getErrorMessage(err)}`);
                if (ctx.manager) {
                    ctx.manager._recoveryState = { ...ctx.manager._recoveryState, lastFailureAt: Date.now() };
                }
            });
    }, delayMs);
}

/**
 * Schedule a deferred grid resync after idle delay elapses.
 * @param {Object} ctx - Bot context
 * @param {import('./types').GridResyncOptions} [options] - Grid resync options
 */
function scheduleDeferredGridResync(ctx: any, options: any = {}) {
    if (
        !ctx ||
        ctx._shuttingDown ||
        ctx._deferredGridResyncTimer ||
        !ctx.manager?._fillProcessingLock
    ) {
        return;
    }

    const idleDelayMs = getMaintenanceIdleDelayMs(ctx);
    const triggerFileWasPresent = !!(ctx.triggerFile && storage.exists(ctx.triggerFile));
    const settleDelayMs = Number.isFinite(TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        ? Math.max(0, TIMING.BLOCKCHAIN_SETTLE_DELAY_MS)
        : 6_000;
    const delayMs = idleDelayMs + settleDelayMs;
    if (!(delayMs > 0)) return;

    ctx._deferredGridResyncTimer = setTimeout(() => {
        ctx._deferredGridResyncTimer = null;
        if (ctx._shuttingDown) return;
        if (triggerFileWasPresent && !storage.exists(ctx.triggerFile)) return;

        ctx.manager._fillProcessingLock.acquire(async () => {
            const ok = await ctx._performGridResync(options);
            if (!ok && !ctx._shuttingDown) {
                const curIdleMs = getMaintenanceIdleDelayMs(ctx);
                const reason = curIdleMs > 0
                    ? `idle cooldown (${Math.ceil(curIdleMs / TIMING.MILLISECONDS_PER_SECOND)}s)`
                    : 'grid resync rejected or failed';
                ctx._warn(`Deferred trigger reset blocked: ${reason}; retaining existing grid state.`);
            }
        }).catch((err: any) => {
            ctx._warn(`Deferred trigger reset lock error: ${getErrorMessage(err)}`);
            if (ctx.manager) {
                ctx.manager._recoveryState = { ...ctx.manager._recoveryState, lastFailureAt: Date.now() };
            }
        });
    }, delayMs);
}

/**
 * Execute the core maintenance logic: recalculate funds, check pipeline,
 * refresh dynamic weights, check grid health, cancel dust orders,
 * apply divergence corrections, and fix spread conditions.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} context - Context label for logging (e.g. 'periodic', 'dust-timer')
 * @returns {Promise<void>}
 */
async function executeMaintenanceLogic(bot: any, context: any) {
    // Clear stale broadcast flag first so any downstream gating on
    // isBroadcastingActive() (e.g. recalculateFunds, BTS balance check)
    // sees the freshest state rather than a hung flag.
    bot.manager._clearStaleBroadcastFlag();

    await bot.manager.recalculateFunds();
    await checkBtsBalanceAndAcquire(bot);
    bot.manager.clearStalePipelineOperations();

    // Clear stale divergence flags before the pipeline check to break a self-blocking loop:
    // checkAndUpdateGridIfNeeded / compareGrids may have set _gridSidesUpdated earlier in this
    // tick (or in a previous tick that aborted before corrections ran), and applyGridDivergenceCorrections
    // is the only consumer that clears it. If a prior tick set the flag but never reached the
    // correction path, the flag persists and the next isPipelineEmpty sees it as a blockage,
    // preventing the divergence section from running. Stale flags must be cleared here, BEFORE
    // the pipeline check, so the divergence section can be entered.
    const staleFlags = bot.manager._gridSidesUpdated?.size || 0;
    if (staleFlags > 0) {
        bot.manager._gridSidesUpdated.clear();
        bot._log(
            `[PIPELINE-CLEAR] Cleared ${staleFlags} stale _gridSidesUpdated flag(s) before ${context} pipeline check`,
            'info'
        );
    }

    if (bot._maintenanceCooldownCycles > 0) {
        bot._maintenanceCooldownCycles--;
        bot._log(
            `[MAINT-COOLDOWN] Skipping ${context} maintenance after hard-abort recovery sync (remaining=${bot._maintenanceCooldownCycles})`,
            'warn'
        );
        return;
    }

    // Grid bloat re-check: if a previous loadGrid detected bloat and set
    // _gridBloatDetectedAt, verify the grid is still oversized after a grace
    // period. If it hasn't resolved and no structural resync is in flight,
    // trigger one. This catches bloat that occurred during startup (before
    // requestStructuralGridResync was wired) or bloat that survived a prior
    // resync attempt.
    if (bot.manager._gridBloatDetectedAt && typeof bot.manager.requestStructuralGridResync === 'function') {
        const grace = isGridBloatGraceActive(bot.manager);
        if (!grace.active) {
            const bloatResult = isGridBloated(bot.manager, bot.manager.orders);
            if (bloatResult.bloated) {
                const d = bloatResult.details;
                bot._log(
                    `[GRID-BLOAT] Grid size ${d.gridSize} still exceeds expected maximum ${d.maxAllowed} ` +
                    `after grace period (${grace.graceMs}ms). Triggering structural resync.`,
                    'warn'
                );
                bot.manager.requestStructuralGridResync(
                    'grid-bloat-persistent',
                    { reason: `Grid size ${d.gridSize} still exceeds max ${d.maxAllowed} after grace` }
                ).catch((err: any) => {
                    bot.manager?.logger?.log?.(
                        `[GRID-BLOAT] Structural resync request failed: ${getErrorMessage(err)}`,
                        'error'
                    );
                });
            } else {
                clearGridBloatFlag(bot.manager);
                bot._log('[GRID-BLOAT] Grid size returned to normal. Clearing bloat flag.', 'info');
            }
        }
    }

    // Gap 4: Periodic lightweight consistency check. Fetches open order count
    // from chain and compares to grid active order count. Triggers a targeted
    // sync when significant divergence is detected. Runs at most once per
    // LIGHTWEIGHT_SYNC_CHECK_INTERVAL_MS to limit blockchain query load.
    // Skip if the COW pipeline has active CREATEs in flight to avoid racing
    // with batch broadcasts — transient mismatches are expected during a COW cycle.
    if (
        !bot._batchInFlight &&
        !(bot.manager?._pendingBroadcasts?.size > 0) &&
        (bot._lightweightSyncCheckAt == null || Date.now() - bot._lightweightSyncCheckAt >= TIMING.LIGHTWEIGHT_SYNC_CHECK_INTERVAL_MS)
    ) {
        bot._lightweightSyncCheckAt = Date.now();
        try {
            const chainOpenOrdersResult = await chainOrders.readOpenOrders(bot.accountId);
            const assets = bot.manager?.assets;
            if (!assets) {
                bot._log('[LIGHTWEIGHT-SYNC] Skipped: manager assets not available', 'debug');
            } else {
                const chainOrdersCount = chainOpenOrdersResult.filter((o: any) => parseChainOrder(o, assets) !== null).length;
                const gridActive = Array.from(bot.manager.orders.values()).filter(
                    (o: any) => isOrderOnChain(o)
                ).length;
                const diff = Math.abs(chainOrdersCount - gridActive);
                if (diff > 2) {
                    bot._log(
                        `[LIGHTWEIGHT-SYNC] Order count mismatch: chain=${chainOrdersCount}, grid=${gridActive} ` +
                        `(diff=${diff}). Triggering targeted sync to reconcile.`,
                        'warn'
                    );
                    if (bot.manager?.synchronizeWithChain) {
                        await bot.manager.synchronizeWithChain(chainOpenOrdersResult, 'readOpenOrders');
                    }
                } else if (diff > 0) {
                    bot._log(
                        `[LIGHTWEIGHT-SYNC] Order count mismatch: chain=${chainOrdersCount}, grid=${gridActive} ` +
                        `(diff=${diff}). Minor divergence — expected during normal operation.`,
                        'debug'
                    );
                }
            }
        } catch (e: any) {
            bot._log(`[LIGHTWEIGHT-SYNC] Check failed: ${getErrorMessage(e)}`, 'debug');
        }
    }

    // Process any price corrections queued by prior sync operations before
    // the pipeline gate. Pending corrections block isPipelineEmpty, and no
    // other code path clears them outside of _consumeFillQueue (which only
    // runs when new fills arrive). Without this, a single correction queued
    // during startup or periodic sync can stall the pipeline indefinitely.
    const pendingCorrections = bot.manager.ordersNeedingPriceCorrection?.length || 0;
    if (pendingCorrections > 0) {
        const correctionResult = await correctAllPriceMismatches(
            bot.manager, bot.account, bot.privateKey, chainOrders
        );
        if (correctionResult.failed > 0) {
            bot._warn(`[MAINT] ${correctionResult.failed}/${pendingCorrections} price correction(s) failed`);
        }
    }

    // Dust detection runs before the pipeline gate. Cancellation is immediate
    // (no 30s delay) and stays inside the empty-pipeline branch to avoid racing.
    let healthResult = await bot.manager.checkGridHealth(bot.updateOrdersOnChainPlan.bind(bot));
    if (await bot._abortFlowIfIllegalState(`${context} health check`)) return;

    const pipelineStatus = bot.manager.isPipelineEmpty(bot._getPipelineSignals());
    if (pipelineStatus.isEmpty) {
        const repairedFromChain = await maybeRunTargetedDriftReconciliation(bot, context);
        if (repairedFromChain) {
            const freshHealth = await bot.manager.checkGridHealth(bot.updateOrdersOnChainPlan.bind(bot));
            if (await bot._abortFlowIfIllegalState(`${context} post-reconcile health check`)) return;
            healthResult = freshHealth;
        }

        refreshDynamicWeightDistribution(bot, context);

        const dustCancelResult = await cancelDustOrders(bot, {
            buy: healthResult.buyDustOrders,
            sell: healthResult.sellDustOrders,
        });
        if (dustCancelResult?.batchResult?.aborted) {
            return;
        }

        try {
            const persistedGridData = bot.accountOrders.loadGrid(true) || [];
            const calculatedGrid = Array.from(bot.manager.orders.values());

            const divergence = await grid.monitorDivergence(bot.manager, calculatedGrid, persistedGridData);

            if (divergence.needsUpdate) {
                const hasRmsDivergence = !!(divergence.buy.rms || divergence.sell.rms);
                if (divergence.buy.ratio || divergence.sell.ratio) {
                    bot._log(`Grid update triggered by funds during ${context} (buy: ${divergence.buy.ratio}, sell: ${divergence.sell.ratio})`);
                }
                if (hasRmsDivergence) {
                    bot._log(`Grid update triggered by structural divergence during ${context}: buy=${Format.formatPrice6(divergence.buy.metric)}, sell=${Format.formatPrice6(divergence.sell.metric)}`);
                    let ok;
                    if (typeof bot._performGridResync === 'function') {
                        ok = await bot._performGridResync(buildGridResyncOptions('rms_structural_grid_resync'));
                    } else {
                        ok = await performGridResync(bot, buildGridResyncOptions('rms_structural_grid_resync'));
                    }
                    if (!ok) {
                        bot._warn(`RMS structural divergence full grid resync failed during ${context}; retaining existing grid state.`);
                    }
                    // Clear any ratio flags set by checkAndUpdateGridIfNeeded earlier in this tick,
                    // since the resync already rebuilt the full grid.
                    if (bot.manager._gridSidesUpdated?.size > 0) {
                        bot.manager._gridSidesUpdated.clear();
                    }
                    return;
                }

                try {
                    await applyGridDivergenceCorrections(
                        bot.manager,
                        bot.accountOrders,
                        bot.config.botKey,
                        bot.updateOrdersOnChainBatch.bind(bot)
                    );
                    if (await bot._abortFlowIfIllegalState(`${context} divergence correction`)) return;
                    bot._log(`Grid divergence corrections applied during ${context}`);
                } catch (err: any) {
                    bot._warn(`Error applying divergence corrections during ${context}: ${getErrorMessage(err)}`);
                }
            }
        } catch (err: any) {
            bot._warn(`Error running divergence check during ${context}: ${getErrorMessage(err)}`);
        }

        const spreadResult = await bot.manager.checkSpreadCondition(BitShares, bot.updateOrdersOnChainPlan.bind(bot));
        if (await bot._abortFlowIfIllegalState(`${context} spread check`)) return;
        if (spreadResult && spreadResult.ordersPlaced > 0) {
            bot._log(`✓ Spread correction during ${context}: ${spreadResult.ordersPlaced} order(s) placed`);
            await bot._persistAndRecoverIfNeeded();
        }
    } else {
        const totalDust = (healthResult.buyDustOrders?.length || 0) + (healthResult.sellDustOrders?.length || 0);
        if (totalDust > 0 && bot._lastDeferredDustCount !== totalDust) {
            bot._log(`[MAINT] ${totalDust} dust order(s) deferred — pipeline non-empty (${pipelineStatus.reasons?.join(', ') ?? '(unknown)'})`);
            bot._lastDeferredDustCount = totalDust;
        }
    }
}

/**
 * Cancel a single order, retrying on alternate BitShares nodes when the
 * credential daemon reports BROADCAST_DEADLINE.  The daemon already retries
 * 3× internally against its own node list; if it still hits the deadline
 * the node itself may be unhealthy.  We hand the full healthy-node list
 * (excluding the primary) to the credential client, which cycles through
 * the fallbacks with a 1 s gap and raises the last BroadcastUncertainError
 * only when all nodes are exhausted.
 *
 * The daemon's session is validated early in processRequest (before the
 * broadcast), so a BROADCAST_DEADLINE reply cannot be caused by an expired
 * session — re-using the original signing token is correct.
 *
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {import('./types').Order} order
 * @returns {Promise<*>} Result from chainOrders.cancelOrder
 */
async function cancelOrderWithNodeFallback(bot: any, order: any) {
    try {
        const nodeManager = getNodeManager();
        const nodes = nodeManager?.getHealthyNodes() ?? [];
        const fallbackNodes = nodes.length > 1 ? nodes.slice(1) : undefined;
        return await chainOrders.cancelOrder(
            bot.account, bot.privateKey, order.orderId,
            fallbackNodes
                ? {
                    fallbackNodes,
                    onNodeFailed: (nodeUrl: string) => {
                        nodeManager.reportNodeFailure(nodeUrl, 'BROADCAST_DEADLINE', 'broadcast');
                    },
                }
                : {}
        );
    } catch (err) {
        if (err instanceof BroadcastUncertainError) {
            bot._warn(`[DUST] All nodes exhausted for ${order.id} (${order.orderId})`);
        }
        throw err;
    }
}

/**
 * Cancel dust orders immediately — no delay, no timer, no maps.
 * Each dust order is cancelled on chain and its slot is rotated through
 * the normal synthetic-fill pipeline. Failures are logged and retried on
 * the next detection cycle (next fill batch or 5-min health check).
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {Object} [options] - Dust cancellation options
 * @param {import('./types').Order[]} [options.buy=[]] - Buy-side dust orders
 * @param {import('./types').Order[]} [options.sell=[]] - Sell-side dust orders
 * @returns {Promise<{cancelledCount: number, batchResult: {aborted: boolean}|null}>}
 */
async function cancelDustOrders(bot: any, { buy: buyDust = [], sell: sellDust = [] }: any = {}) {
    const allDust = [...buyDust, ...sellDust];
    if (allDust.length === 0) return { cancelledCount: 0, batchResult: null };

    const syntheticFills: any[] = [];
    for (const order of allDust) {
        if (!order.orderId) continue;
        try {
            const cancelResult = await cancelOrderWithNodeFallback(bot, order);
            try {
                if (cancelResult?.verifiedAfterFailure) {
                    const accountRef = bot.accountId || bot.account;
                    const chainOpenOrders = await chainOrders.readOpenOrders(accountRef);
                    await bot.manager.synchronizeWithChain(chainOpenOrders, 'readOpenOrders');
                } else {
                    await bot.manager.synchronizeWithChain({ orderId: order.orderId, clearSize: true }, 'cancelOrder');
                }
            } catch (refetchErr: any) {
                bot._warn(`[DUST] Cancel succeeded but refetch failed for ${(order as any).id} (${(order as any).orderId}): ${getErrorMessage(refetchErr)}`);
            }
            syntheticFills.push({ ...order, isPartial: true, isDelayedRotationTrigger: true });
            bot._log(`[DUST] Cancelled ${(order as any).id} (${(order as any).orderId}) size=${(order as any).size}`, 'debug');
        } catch (err: any) {
            const errMsg = err?.message || '';
            if (isOrderDoesNotExistError(errMsg, (order as any).orderId)) {
                syntheticFills.push({ ...order, isPartial: true, isDelayedRotationTrigger: true });
                bot._log(`[DUST] Order ${(order as any).id} (${(order as any).orderId}) already gone from chain`, 'debug');
            } else {
                bot._warn(`[DUST] Failed to cancel ${(order as any).id} (${(order as any).orderId}): ${errMsg}`);
            }
        }
    }

    if (syntheticFills.length === 0) return { cancelledCount: 0, batchResult: null };
    const result = await bot._processFillsWithBatching(
        syntheticFills, new Set(), `dust cancel [${syntheticFills.map((o: any) => o.id).join(', ')}]`
    );
    if (!result.aborted) {
        await bot.manager.persistGrid();
    }
    return { cancelledCount: syntheticFills.length, batchResult: { aborted: result.aborted } };
}

/**
 * Run grid maintenance with idle detection and lock acquisition.
 * Checks if the bot is idle before proceeding, and acquires the fill processing lock.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} [context='periodic'] - Context label for logging
 * @param {Object} [options] - Maintenance options
 * @param {boolean} [options.skipIdle=false] - Skip idle delay check
 * @returns {Promise<void>}
 */
async function runGridMaintenance(
    bot: any,
    context: any = 'periodic',
    options: { skipIdle?: boolean } = {}
) {
    const skipIdle = options.skipIdle === true;
    if (!skipIdle) {
        const idleDelayMs = getMaintenanceIdleDelayMs(bot);
        if (idleDelayMs > 0) {
            bot._log(
                `[MAINT-IDLE] Deferring ${context} grid maintenance until ` +
                `${Math.ceil(idleDelayMs / TIMING.MILLISECONDS_PER_SECOND)}s of inactivity has passed`,
                'debug'
            );
            scheduleMaintenanceAfterIdle(bot, context, options);
            return;
        }
    }

    try {
        if (!bot.manager) return;

        const runWithDivergenceLock = async () => {
            // Re-check orders size under the divergence lock to avoid a TOCTOU
            // race with concurrent order mutations. The previous placement
            // (before any lock acquisition) could observe a stale empty
            // grid and silently skip maintenance while fills were in flight.
            if (!bot.manager.orders || bot.manager.orders.size === 0) return;
            await executeMaintenanceLogic(bot, context);
        };

        await bot.manager._fillProcessingLock.acquire(async () => {
            await bot.manager._divergenceLock.acquire(runWithDivergenceLock);
        });
    } catch (err: any) {
        bot._warn(`Error during ${context} grid maintenance: ${getErrorMessage(err)}`);
        throw err;
    }
}

const _lastBtsAcquisitionTimestamps = new Map();

/**
 * Check if the bot's BTS balance is below the minimum threshold and trigger acquisition.
 * Only applies to non-BTS pairs. Uses hysteresis: triggers at 1× min_BTS_value,
 * fills to BTS_ACQUIRE_TARGET_MULTIPLIER × min_BTS_value.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Promise<void>}
 */
async function checkBtsBalanceAndAcquire(bot: any) {
    if (bot.config.dryRun) return;
    if (bot.config.assetA === 'BTS' || bot.config.assetB === 'BTS') return;

    const cooldownMin = bot.config?.timing?.BTS_ACQUIRE_COOLDOWN_MIN;
    const cooldownMs = cooldownMin * 60 * 1000;
    const now = Date.now();

    // Prune every expired entry in the map, not just the current bot's.
    // Otherwise entries for bots that acquired BTS and then stopped calling
    // (removed from bots.json, supervisor restart with a different roster)
    // would persist forever. The map is bounded by the number of unique bot
    // keys that ever acquired BTS, so this O(n) sweep is cheap.
    for (const [key, ts] of _lastBtsAcquisitionTimestamps) {
        if ((now - ts) >= cooldownMs) {
            _lastBtsAcquisitionTimestamps.delete(key);
        }
    }

    const botKey = bot.config.botKey || bot.config.name;
    const lastAcq = _lastBtsAcquisitionTimestamps.get(botKey);
    if (lastAcq && (now - lastAcq) < cooldownMs) return;

    if (!bot.manager || !bot.manager.btsBalance) return;

    const targetBuy = Math.max(0, bot.config.activeOrders?.buy ?? 1);
    const targetSell = Math.max(0, bot.config.activeOrders?.sell ?? 1);
    const totalTarget = targetBuy + targetSell;

    const btsReservationMultiplier = bot.config?.feeParams?.BTS_RESERVATION_MULTIPLIER;
    const minBtsVal = calculateOrderCreationFees(
        bot.config.assetA, bot.config.assetB, totalTarget,
        btsReservationMultiplier
    );
    if (minBtsVal <= 0) return;

    const effectiveMin = (bot.config.min_BTS_value > 0) ? bot.config.min_BTS_value : minBtsVal;
    const btsFree = bot.manager.btsBalance.free || 0;
    const btsAcquireThreshold = bot.config?.feeParams?.BTS_ACQUIRE_THRESHOLD;
    const triggerAt = effectiveMin * btsAcquireThreshold;
    if (btsFree >= triggerAt) return;

    const btsAcquireTargetMultiplier = bot.config?.feeParams?.BTS_ACQUIRE_TARGET_MULTIPLIER;
    const target = effectiveMin * btsAcquireTargetMultiplier;
    const deficit = Math.max(0, target - btsFree);
    bot._log(
        `[BTS-ACQ] BTS balance ${Format.formatAmount8(btsFree)} below threshold ${Format.formatAmount8(triggerAt)}. ` +
        `Acquiring ${Format.formatAmount8(deficit)} BTS (target: ${Format.formatAmount8(target)})`,
        'info'
    );
    _lastBtsAcquisitionTimestamps.set(botKey, Date.now());
    await acquireBts(bot, deficit);
}

/**
 * Acquire BTS by swapping one of the trading pair assets through an AMM pool.
 * Tries both assets for a BTS pool, picks the best (lowest price impact).
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {number} deficit - Amount of BTS needed (float)
 * @returns {Promise<void>}
 */
async function acquireBts(bot: any, deficit: any) {
    if (deficit <= 0) return;
    const { BitShares } = require('./bitshares_client');
    if (!BitShares || !BitShares.db) return;

    const coreAssetId = NATIVE_CLIENT.CHAIN.CORE_ASSET_ID;
    const assets = [
        { id: bot.assets?.assetA?.id, free: bot.manager.accountTotals?.sellFree || 0, precision: bot.assets?.assetA?.precision, symbol: bot.config.assetA },
        { id: bot.assets?.assetB?.id, free: bot.manager.accountTotals?.buyFree || 0, precision: bot.assets?.assetB?.precision, symbol: bot.config.assetB }
    ];

    const candidates: any[] = [];
    for (const asset of assets) {
        if (!asset.id || asset.free <= 0) continue;
        try {
            const pools = await BitShares.db.get_liquidity_pools_by_both_assets(asset.id, coreAssetId);
            const validPools = Array.isArray(pools) ? pools.filter((p: any) => p?.id) : [];
            const poolData = validPools.length
                ? validPools.sort((a: any, b: any) => {
                    const getBtsBal = (p: any) => {
                        const isBts = String(p.asset_a ?? p.asset_ids?.[0] ?? '') === String(coreAssetId);
                        return Number(isBts ? (p.balance_a ?? 0) : (p.balance_b ?? 0));
                    };
                    return getBtsBal(b) - getBtsBal(a);
                })[0]
                : null;
            if (!poolData) continue;

            const isAssetA = String(poolData.asset_a) === String(asset.id) || String(poolData.asset_ids?.[0]) === String(asset.id);
            const assetReserveRaw = isAssetA ? (poolData.balance_a || poolData.reserves?.[0]?.amount) : (poolData.balance_b || poolData.reserves?.[1]?.amount);
            const btsReserveRaw = isAssetA ? (poolData.balance_b || poolData.reserves?.[1]?.amount) : (poolData.balance_a || poolData.reserves?.[0]?.amount);
            if (!assetReserveRaw || !btsReserveRaw) continue;

            const assetReserve = blockchainToFloat(assetReserveRaw, asset.precision);
            const btsReserve = blockchainToFloat(btsReserveRaw, BTS_PRECISION);
            const expectedReceive = Math.min(deficit, btsReserve * 0.5);
            const sellAmount = calculateSwapInAmount(deficit, btsReserve, assetReserve);
            if (sellAmount <= 0 || sellAmount > asset.free) continue;

            candidates.push({ asset, poolId: poolData.id, sellAmount, expectedReceive, priceImpact: sellAmount / assetReserve });
        } catch (e: any) {
            bot._log(`[BTS-ACQ] Pool lookup failed for ${asset?.symbol}: ${getErrorMessage(e)}`, 'debug');
        }
    }

    if (candidates.length === 0) {
        bot._log(`[BTS-ACQ] CRITICAL: No BTS pool with sufficient liquidity for ${bot.config.assetA} or ${bot.config.assetB}`, 'error');
        return;
    }

    candidates.sort((a: any, b: any) => a.priceImpact - b.priceImpact);
    const best = candidates[0];

    const poolSlippageTolerance = bot.config?.feeParams?.POOL_SLIPPAGE_TOLERANCE;
    const minReceive = best.expectedReceive * (1 - poolSlippageTolerance);
    const sellInt = floatToBlockchainInt(best.sellAmount, best.asset.precision);
    const minReceiveInt = floatToBlockchainInt(minReceive, BTS_PRECISION);
    const op = chainOrders.buildLiquidityPoolExchangeOp(bot.accountId, best.poolId, sellInt, best.asset.id, minReceiveInt, coreAssetId);

    try {
        if (bot.privateKey) {
            await chainOrders.executeBatch(bot.account, bot.privateKey, [op]);
        } else {
            bot._log('[BTS-ACQ] CRITICAL: No signing method available', 'error');
            return;
        }
    } catch (err) {
        bot._log(`[BTS-ACQ] Swap broadcast failed: ${getErrorMessage(err)}`, 'error');
        return;
    }

    const orderType = (best.asset.id === bot.assets?.assetA?.id) ? 'sell' : 'buy';
    if (bot.manager.accountant) {
        bot.manager.accountant.adjustTotalBalance(orderType, -best.sellAmount, 'bts-acquisition-swap-sell');
    }
    // Do NOT optimistically bump btsBalance.free/total here. expectedReceive is
    // a pre-swap estimate and may diverge from the actual fill (slippage, fees,
    // partial fills, broadcast/confirm failures). The next periodic
    // fetchAccountTotals() reconciles from chain truth. The bts-acquisition
    // cooldown in checkBtsBalanceAndAcquire prevents immediate re-trigger even
    // if the chain balance is still below the trigger threshold.

    bot._log(`[BTS-ACQ] Acquired ~${Format.formatAmount8(best.expectedReceive)} BTS: sold ${Format.formatAmount8(best.sellAmount)} ${best.asset.symbol} via pool ${best.poolId}`, 'info');
}

/**
 * Run a single dust health check cycle.
 * @param {import('./dexbot_class').DEXBot} bot
 */
async function runDustHealthCheck(bot: any) {
    if (bot._shuttingDown || !bot.manager) return;
    try {
        const health = await bot.manager.checkGridHealth(
            bot.updateOrdersOnChainPlan?.bind(bot)
        );
        const buyDust = health.buyDustOrders || [];
        const sellDust = health.sellDustOrders || [];
        const totalDust = buyDust.length + sellDust.length;
        if (totalDust > 0) {
            bot._log(`[DUST] Health check: ${totalDust} dust order(s) (buy=${buyDust.length}, sell=${sellDust.length})`);
            const lock = bot.manager._fillProcessingLock;
            if (lock && typeof lock.acquire === 'function') {
                await lock.acquire(async () => {
                    await bot._cancelDustOrders({
                        buy: health.buyDustOrders,
                        sell: health.sellDustOrders,
                    });
                }, { timeout: TIMING.DUST_CANCEL_TIMEOUT_MS });
            } else {
                bot._warn('[DUST] Fill lock unavailable — cancelling dust without lock (potential race)');
                await bot._cancelDustOrders({
                    buy: health.buyDustOrders,
                    sell: health.sellDustOrders,
                });
            }
        }
    } catch (err: any) {
        if (err?.message?.includes('Lock acquisition timeout')) {
            bot._warn('[DUST] Lock busy, skipping dust cancel this cycle (retry in 5 min)');
        } else {
            bot._warn(`[DUST] Health check error (retry in 5 min): ${err?.message || err}`);
        }
    }
}

/**
 * Set up the periodic dust health check interval.
 * @param {import('./dexbot_class').DEXBot} bot
 */
function setupDustHealthCheckInterval(bot: any) {
    bot._dustHealthCheckTimer = setInterval(() => {
        runDustHealthCheck(bot);
    }, TIMING.DUST_HEALTH_CHECK_INTERVAL_MS);
    if (typeof bot._dustHealthCheckTimer?.unref === 'function') {
        bot._dustHealthCheckTimer.unref();
    }
}

/**
 * Request a full grid reset from fresh on-chain state.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} [reason='structural change']
 * @param {{refreshCenterPrice?: boolean}} [options={}]
 * @returns {Promise<Object>}
 */
async function requestGridReset(bot: any, reason: any = 'structural change', options: { refreshCenterPrice?: boolean } = {}) {
    if (!bot.manager || typeof bot._performGridResync !== 'function') {
        return { skipped: true, reason: 'grid resync unavailable' };
    }

    const message = reason ? `[CR-RESET] ${reason}` : '[CR-RESET] grid reset requested';
    bot._log(`${message}; rebuilding grid from fresh on-chain state`, 'info');
    const resetOptions = {
        ...options,
        refreshCenterPrice: options.refreshCenterPrice !== false,
    };

    if (!bot.manager._fillProcessingLock || bot.manager._fillProcessingLock.isReentrant()) {
        return performGridResync(bot, resetOptions);
    }

    return bot.manager._fillProcessingLock.acquire(async () => performGridResync(bot, resetOptions));
}

/**
 * Wire the structural grid resync request handler on the manager.
 * @param {import('./dexbot_class').DEXBot} bot
 */
function wireStructuralGridResyncRequest(bot: any) {
    if (!bot.manager || bot.manager.requestStructuralGridResync) return;

    bot.manager.requestStructuralGridResync = async (reason: any = 'structural recovery', details: { unmatchedChainOrders?: any[]; [key: string]: any } = {}) => {
        if (bot._shuttingDown) {
            return { skipped: true, reason: 'shutting down' };
        }

        if (bot._structuralGridResyncRunning || bot._structuralGridResyncTimer) {
            return { skipped: true, reason: 'structural grid resync already scheduled' };
        }

        const unmatchedCount = Array.isArray(details?.unmatchedChainOrders)
            ? details.unmatchedChainOrders.length
            : 0;
        bot._structuralGridResyncTimer = setTimeout(async () => {
            bot._structuralGridResyncTimer = null;
            if (bot._shuttingDown) return;

            bot._structuralGridResyncRunning = true;
            try {
                const persistedResult = await bot._recoverFromPersistedGrid();
                if (persistedResult.success) {
                    if (bot.manager?._recoveryState) {
                        bot.manager._recoveryState = { ...bot.manager._recoveryState, attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0 };
                    }
                    return;
                }

                const suffix = unmatchedCount > 0 ? ` (${unmatchedCount} unmatched chain order(s))` : '';
                    bot._warn(`[RECOVERY] Running structural full grid resync for ${reason}${suffix}`);
                    const resetResult = await bot.requestGridReset('rms_structural_grid_resync', {
                        refreshCenterPrice: true,
                    });
                if (resetResult && bot.manager?._recoveryState) {
                    bot.manager._recoveryState = { ...bot.manager._recoveryState, attemptCount: 0, lastAttemptAt: 0, lastFailureAt: 0 };
                }
            } catch (err: any) {
                bot._warn(`[RECOVERY] Structural full grid resync failed: ${getErrorMessage(err)}`);
            } finally {
                bot._structuralGridResyncRunning = false;
                if (bot.manager?._recoveryState) {
                    bot.manager._recoveryState = { ...bot.manager._recoveryState, structuralResyncRequested: false };
                }
            }
        }, 0);

        return { scheduled: true };
    };
}

/**
 * Get current pipeline signal state for congestion checks.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Object}
 */
function getPipelineSignals(bot: any) {
    bot.manager?._cleanExpiredLocks?.();
    return {
        incomingFillQueueLength: bot._incomingFillQueue.length,
        shadowLocks: bot.manager?.shadowOrderIds?.size || 0,
        batchInFlight: bot._batchInFlight,
        recoveryInFlight: bot._recoverySyncInFlight,
        broadcasting: bot.manager?.isBroadcastingActive?.() || false
    };
}

/**
 * Mark that grid activity occurred (updates idle timer).
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} [reason='activity']
 */
function markGridActivity(bot: any, reason: any = 'activity') {
    bot._lastGridActivityAt = Date.now();
    bot.manager?.logger?.log?.(`[MAINT-IDLE] Activity observed: ${reason}`, 'debug');
}

/**
 * Get current metrics for monitoring and debugging.
 * @param {import('./dexbot_class').DEXBot} bot
 * @returns {Object}
 */
function getMetrics(bot: any) {
    bot.manager?._cleanExpiredLocks?.();
    return {
        ...bot._metrics,
        queueDepth: bot._incomingFillQueue.length,
        fillProcessingLockActive: bot.manager?._fillProcessingLock?.isLocked() || false,
        divergenceLockActive: bot.manager?._divergenceLock?.isLocked() || false,
        shadowLocksActive: bot.manager?.shadowOrderIds?.size || 0,
        recoveryExhaustedAt: bot.manager?._recoveryExhaustedAt || null,
        recentFillsTracked: bot._recentlyProcessedFills.size
    };
}

/**
 * Read open orders from chain, sync with local state, and process any fills found.
 * @param {import('./dexbot_class').DEXBot} bot
 * @param {string} tag - Context label for logging
 * @returns {Promise<Object>}
 */
async function syncOpenOrdersAndProcessFills(bot: any, tag: any) {
    if (!bot.accountId || bot.config?.dryRun) {
        return { syncResult: null, aborted: false, hasUnmatched: 0, openOrders: null };
    }
    try {
        let openOrders = await chainOrders.readOpenOrders(bot.accountId);
        const syncResult = await bot.manager.synchronizeWithChain(
            openOrders,
            'readOpenOrders'
        );
        let aborted = false;
        if (syncResult?.filledOrders?.length > 0) {
            bot._refreshDynamicWeightDistribution(`${tag} sync-fill`);
            bot._log(`[SYNC-CHAIN] ${syncResult.filledOrders.length} filled order(s) found during ${tag}`, 'info');
            const batchResult = await bot._processFillsWithBatching(
                syncResult.filledOrders,
                new Set(),
                `${tag} sync-fill`
            );
            if (!batchResult?.aborted) {
                openOrders = await chainOrders.readOpenOrders(bot.accountId);
                await bot.manager.synchronizeWithChain(openOrders, 'readOpenOrders');
            } else {
                aborted = true;
            }
        }
        const hasUnmatched = syncResult?.unmatchedChainOrders?.length || 0;
        return { syncResult, aborted, hasUnmatched, openOrders };
    } catch (err: any) {
        bot._warn(`[SYNC-CHAIN] Open-orders sync failed during ${tag}: ${getErrorMessage(err)}`);
        return { syncResult: null, aborted: true, hasUnmatched: -1, openOrders: null };
    }
}

export = {
    loadBotsConfigSnapshot,
    refreshDynamicWeightDistribution,
    performGridResync,
    updateBotGridResetMetadata,
    handlePendingTriggerReset,
    setupTriggerFileDetection,
    performPeriodicGridChecks,
    isOpenOrdersSyncLoopEnabled,
    startOpenOrdersSyncLoop,
    stopOpenOrdersSyncLoop,
    setupBlockchainFetchInterval,
    stopBlockchainFetchInterval,
    executeMaintenanceLogic,
    cancelDustOrders,
    isOrderDoesNotExistError,
    runGridMaintenance,
    stopMarketAdapterPm2,
    releaseMarketAdapterRuntime,
    syncMarketAdapterOnPeriodicConfigCheck,
    findSnapshotBotForRuntimeConfig,
    runtimeConfigNeedsMarketAdapter,
    usesAmaGridPrice,
    checkBtsBalanceAndAcquire,
    acquireBts,
    runDustHealthCheck,
    setupDustHealthCheckInterval,
    requestGridReset,
    wireStructuralGridResyncRequest,
    getPipelineSignals,
    markGridActivity,
    getMetrics,
    syncOpenOrdersAndProcessFills,
};
