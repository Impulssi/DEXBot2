/**
 * modules/account_bots.ts - Bot Configuration Management
 *
 * Interactive CLI helper for editing bot profiles in profiles/bots.json.
 * Manages multi-bot configuration and metadata.
 *
 * ===============================================================================
 * EXPORTS (5 functions)
 * ===============================================================================
 *
 * MAIN ENTRY POINT:
 *   main() - Interactive CLI for bot configuration management
 *     Lists bots, allows add/edit/delete/activate operations
 *     Loads and saves profiles/bots.json
 *
 *   normalizeBotDraft(base) - Normalize a bot configuration draft
 *     Applies defaults and validation to raw bot config entries
 *
 *   parseJsonWithComments(raw) - Parse JSON with comment stripping
 *     (re-exported from ./order/utils/system.js)
 *
 *   parseCronToDelta(cronString) - Parse a cron expression to { days, time }
 *   deltaToCron(days, time) - Convert { days, time } back to a cron expression
 *
 * INTERNAL HELPERS (not exported):
 *   ask* prompt family (askString, askNumberWithBounds, askIntegerInRange,
 *   askNumberOrMultiplier, askNumberOrPercentage, askAsset, askAssetB,
 *   askStartPrice, askGridPriceMode, askPoolRef, askTargetSpreadPercent,
 *   askMaxPrice, askWeightDistribution, askWeightDistributionNoLegend,
 *   askLogLevel, askUpdaterBranch, askCronSchedule, askBoolean),
 *   loadBotsConfig, saveBotsConfig, listBots, selectBotIndex,
 *   loadGeneralSettings, saveGeneralSettings, isMultiplierString,
 *   colorPriceRangeValue, colorMultiplierInput,
 *   isPercentageString, colorPercentageInput,
 *   normalizePercentageInput, promptBotData, promptGeneralSettings
 *
 * ===============================================================================
 *
 * BOT CONFIGURATION (profiles/bots.json):
 * {
 *   "bots": [
 *     {
 *       "name": "BTS/USD",
 *       "preferredAccount": "my-account",
 *       "assetA": "BTS",
 *       "assetB": "USD",
 *       "active": true,
 *       "dryRun": false,
 *       "startPrice": "pool",      // Price for order alignment: "pool", "book", or numeric
 *       "gridPrice": null,         // Reference price for x-factor bounds (3 options):
 *                                  //   "pool" / "book" = live pair price reference
 *                                  //   "ama"/"ama1".."ama4" = market adapter writes a center snapshot to
 *                                  //              profiles/orders/<botKey>.dynamicgrid.json; grid reads the effective center on reset
 *                                  //   <number> = fixed numeric reference
 *                                  //   null     = use startPrice
 *       "minPrice": "2x",
 *       "maxPrice": "2x",
 *       "incrementPercent": 0.5,
 *       "targetSpreadPercent": 2,
 *       "weightDistribution": { "sell": 1, "buy": 1 },
 *       "botFunds": { "sell": "100%", "buy": "100%" },
 *       "activeOrders": { "sell": 20, "buy": 20 },
 *       "debtPolicy": "ignore",       // Debt policy: "ignore", "warn", or "block"
 *       "min_BTS_value": 0,           // Minimum BTS value threshold for operations
 *     }
 *   ]
 * }
 *
 * GLOBAL SETTINGS CONFIGURATION (profiles/general.settings.json):
 * {
 *   "MARKET_ADAPTER": {
 *     "AMA_DELTA_THRESHOLD_PERCENT": 2  // % change in AMA center price triggers grid reset
 *   },
 *   "GRID_LIMITS": {
 *     "GRID_COMPARISON": {
 *       "RMS_PERCENTAGE": 14.3  // RMS divergence threshold triggers grid reset (set to 0 to disable)
 *     }
 *   }
 * }
 *
 * ===============================================================================
 */


import { path } from './path_api.js';
import { getStorage } from './storage/index.js';
import { ensureProfilesDirectory, readInput } from './order/utils/system.js';
import { DEFAULT_CONFIG, GRID_LIMITS, TIMING, LOG_LEVEL, UPDATER, MARKET_ADAPTER, NODE_MANAGEMENT, FILL_PROCESSING, PIPELINE_TIMING, CREDENTIAL_PROMPTS, MAINTENANCE, COW_PERFORMANCE, INCREMENT_BOUNDS, FEE_PARAMETERS, API_LIMITS, LOGGING_CONFIG, NATIVE_CLIENT, LAUNCHER } from './constants.js';
import { PATHS } from './paths.js';
import { SETTINGS_FILE, readGeneralSettings, writeGeneralSettings } from './general_settings.js';
import { parseJsonWithComments } from './order/utils/system.js';
import { assertNoDuplicateBotKeys, loadSettingsFile } from './bot_settings.js';
import { mergeSettings } from './settings_merge.js';
import { getErrorMessage } from './utils/errors.js';
const storage = getStorage();
const { writeJSON } = storage;


const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const PROFILES_DIR = PATHS.PROFILES_DIR;

/**
 * Loads the bots configuration from profiles/bots.json.
 * @returns {Object} An object containing the config and the file path.
 */
function loadBotsConfig() {
    const { config, filePath } = loadSettingsFile(BOTS_FILE, { silent: true, exitOnError: false });
    if (!config || typeof config !== 'object') return { config: { bots: [] }, filePath };
    if (!Array.isArray(config.bots)) config.bots = [];
    return { config, filePath };
}

/**
 * Saves the bots configuration to the specified file path.
 * @param {Object} config - The configuration object to save.
 * @param {string} filePath - The path to the file.
 * @throws {Error} If saving fails.
 */
function saveBotsConfig(config: any, filePath: string): void {
    try {
        ensureProfilesDirectory(PROFILES_DIR);
        const entries = Array.isArray(config?.bots) ? config.bots : Array.isArray(config) ? config : [];
        if (entries.length >= 2) assertNoDuplicateBotKeys(entries, 'account_bots');
        writeJSON(filePath, config);
    } catch (err: any) {
        console.error('Failed to save bots configuration:', getErrorMessage(err));
        throw err;
    }
}

/**
 * Loads general settings from profiles/general.settings.json.
 * Delegates all merge logic to mergeSettings() in settings_merge.ts,
 * which handles per-section strategies, NODES⇄NODE_MANAGEMENT mapping,
 * and passthrough of unmapped NODES sub-keys.
 * @returns {Object} The loaded settings or default settings if the file doesn't exist.
 */
function loadGeneralSettings() {
    const defaults = {
        LOG_LEVEL: LOG_LEVEL,
        GRID_LIMITS: { ...GRID_LIMITS },
        TIMING: { ...TIMING },
        UPDATER: { ...UPDATER },
        MARKET_ADAPTER: { ...MARKET_ADAPTER },
        NODE_MANAGEMENT: { ...NODE_MANAGEMENT },
        DEFAULT_CONFIG: { ...DEFAULT_CONFIG },
        FILL_PROCESSING: { ...FILL_PROCESSING },
        PIPELINE_TIMING: { ...PIPELINE_TIMING },
        CREDENTIAL_PROMPTS: { ...CREDENTIAL_PROMPTS },
        MAINTENANCE: { ...MAINTENANCE },
        COW_PERFORMANCE: { ...COW_PERFORMANCE },
        INCREMENT_BOUNDS: { ...INCREMENT_BOUNDS },
        FEE_PARAMETERS: { ...FEE_PARAMETERS },
        API_LIMITS: { ...API_LIMITS },
        LOGGING_CONFIG: { ...LOGGING_CONFIG },
        NATIVE_CLIENT: { ...NATIVE_CLIENT },
        LAUNCHER: { ...LAUNCHER },
    };

    const settings = readGeneralSettings({
        fallback: null,
        onError: (err: any) => {
            console.error('Failed to load general settings:', getErrorMessage(err));
        }
    });

    const merged = mergeSettings(settings, defaults);

    // MARKET_ADAPTER validation for AMA_DELTA_THRESHOLD_PERCENT
    const configuredDeltaPercent = Number(merged.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT);
    const effectiveDeltaPercent = Number.isFinite(configuredDeltaPercent) && configuredDeltaPercent > 0
        ? configuredDeltaPercent
        : MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT;
    merged.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT = effectiveDeltaPercent;

    return merged;
}

/**
 * Saves general settings to profiles/general.settings.json.
 * @param {Object} settings - The settings object to save.
 */
function saveGeneralSettings(settings: any): void {
    try {
        writeGeneralSettings(settings);
        console.log(`\n✓ General settings saved to ${path.basename(SETTINGS_FILE)}`);
    } catch (err: any) {
        console.error('Failed to save general settings:', getErrorMessage(err));
    }
}

/**
 * Lists the configured bots to the console.
 * @param {Array<Object>} bots - The list of bot configuration objects.
 */
function listBots(bots: any[]): void {
    if (!bots.length) {
        console.log('  (no bot entries defined yet)');
        return;
    }
    bots.forEach((bot: any, index: number) => {
        const name = bot.name || `<unnamed-${index + 1}>`;
        const inactiveSuffix = bot.active === false ? ' [inactive]' : '';
        const dryRunSuffix = bot.dryRun ? ' (dryRun)' : '';
        console.log(`  ${index + 1}: ${name}${inactiveSuffix}${dryRunSuffix} ${bot.assetA || '?'} / ${bot.assetB || '?'}`);
    });
}

/**
 * Prompts the user to select a bot from the list.
 * @param {Array<Object>} bots - The list of bots.
 * @param {string} promptMessage - The message to display.
 * @returns {Promise<number|string|null>} The selected index, '\x1b' if ESC, or null if invalid.
 */
async function selectBotIndex(bots: any[], promptMessage: string): Promise<any> {
    if (!bots.length) return null;
    listBots(bots);
    const raw = (await readInput(`${promptMessage} [1-${bots.length}]: `)).trim();
    if (raw === '\x1b') return '\x1b';
    const idx = Number(raw);
    if (Number.isNaN(idx) || idx < 1 || idx > bots.length) {
        if (raw !== '') console.log('Invalid selection.');
        return null;
    }
    return idx - 1;
}

/**
 * Prompts the user for a string input.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The user input or default value.
 */
async function askString(promptText: string, defaultValue?: any): Promise<any> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const answer = await readInput(`${promptText}${suffix}: `);
    if (answer === '\x1b') return '\x1b';
    if (!answer) return defaultValue;
    return answer.trim();
}

/**
 * Prompts the user for a required string input.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askRequiredString(promptText: string, defaultValue?: any): Promise<any> {
    while (true) {
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        if (value && value.trim()) return value.trim();
        console.log('This field is required.');
    }
}

/**
 * Prompts the user for a cron schedule using interval and time.
 * @param {string} promptText - The prompt text to display.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askCronSchedule(_promptText: string, defaultValue: string): Promise<any> {
    const current = parseCronToDelta(defaultValue);

    // Interval Prompt
    const days = await askNumberWithBounds('  Interval (days)', current.days, 1, 31);
    if (days === '\x1b') return '\x1b';

    // Time Prompt
    let time = current.time;
    while (true) {
        const rawTime = await askString('  Time (HH:mm)', current.time);
        if (rawTime === '\x1b') return '\x1b';
        if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(rawTime)) {
            time = rawTime;
            break;
        }
        console.log('  Invalid time format. Use HH:mm (24h)');
    }

    return deltaToCron(days, time);
}

/**
 * Prompts the user for a branch and validates it.
 * @param {string} promptText - The prompt text to display.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askUpdaterBranch(promptText: string, defaultValue: string): Promise<any> {
    const validBranches = ['main', 'dev', 'test', 'auto'];
    while (true) {
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        const lowered = value.toLowerCase().trim();
        if (validBranches.includes(lowered)) return lowered;
        console.log(`Invalid branch. Please choose from: ${validBranches.join(', ')}`);
    }
}

/**
 * Prompts the user for a log level and validates it.
 * @param {string} promptText - The prompt text to display.
 * @param {string} defaultValue - The default value to use if input is empty.
 * @returns {Promise<string>} The user input.
 */
async function askLogLevel(promptText: string, defaultValue: string): Promise<any> {
    const validLevels = ['debug', 'info', 'warn', 'error'];
    while (true) {
        console.log(`Available levels: ${validLevels.join(', ')}`);
        const value = await askString(promptText, defaultValue);
        if (value === '\x1b') return '\x1b';
        const lowered = value.toLowerCase().trim();
        if (validLevels.includes(lowered)) return lowered;
        console.log(`Invalid log level. Please choose from: ${validLevels.join(', ')}`);
    }
}

/**
 * Prompts the user for an asset symbol.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The asset symbol in uppercase.
 */
async function askAsset(promptText: string, defaultValue?: any): Promise<any> {
    while (true) {
        const displayDefault = defaultValue ? String(defaultValue).toUpperCase() : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        const answer = await readInput(`${promptText}${suffix}: `);
        if (answer === '\x1b') return '\x1b';

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        return answer.toUpperCase().trim();
    }
}

/**
 * Prompts the user for Asset B, ensuring it's different from Asset A.
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @param {string} assetA - The symbol of Asset A.
 * @returns {Promise<string>} The asset symbol in uppercase.
 */
async function askAssetB(promptText: string, defaultValue?: any, assetA?: string): Promise<any> {
    while (true) {
        const displayDefault = defaultValue ? String(defaultValue).toUpperCase() : undefined;
        const suffix = displayDefault !== undefined && displayDefault !== null ? ` [${displayDefault}]` : '';

        const answer = await readInput(`${promptText}${suffix}: `);
        if (answer === '\x1b') return '\x1b';

        if (!answer) {
            if (displayDefault) return displayDefault;
            console.log('Asset name is required.');
            continue;
        }

        const assetB = answer.toUpperCase().trim();

        // Validate that Asset B is different from Asset A
        if (assetB === assetA) {
            console.log(`Invalid: Asset B cannot be the same as Asset A (${assetA})`);
            continue;
        }

        return assetB;
    }
}

/**
 * Prompts the user for a weight distribution value with a legend.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askWeightDistribution(promptText: string, defaultValue?: any): Promise<any> {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    console.log('  \x1b[38;5;45m-1=SuperValley\x1b[0m ←→ \x1b[38;5;39m0=Valley\x1b[0m ←→ \x1b[38;5;250m0.5=Neutral\x1b[0m ←→ \x1b[38;5;208m1=Mountain\x1b[0m ←→ \x1b[38;5;196m2=SuperMountain\x1b[0m');
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askWeightDistribution(promptText, defaultValue);
    }
    if (parsed < MIN_WEIGHT || parsed > MAX_WEIGHT) {
        console.log(`Weight distribution must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
        return askWeightDistribution(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for a weight distribution value without a legend.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askWeightDistributionNoLegend(promptText: string, defaultValue?: any): Promise<any> {
    const MIN_WEIGHT = -1;
    const MAX_WEIGHT = 2;
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askWeightDistributionNoLegend(promptText, defaultValue);
    }
    if (parsed < MIN_WEIGHT || parsed > MAX_WEIGHT) {
        console.log(`Weight distribution must be between ${MIN_WEIGHT} and ${MAX_WEIGHT}.`);
        return askWeightDistributionNoLegend(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Checks if a value is a multiplier string (e.g. "3x").
 * @param {*} value - The value to check.
 * @returns {boolean} True if it's a multiplier string.
 */
function isMultiplierString(value: any): boolean {
    return typeof value === 'string' && /^[-￿]*[0-9]+(?:\.[0-9]+)?x[-￿]*$/i.test(value);
}

/**
 * Colors a price value string for display: green when it is a relative
 * multiplier ("1.55x"), red when it is a fixed price (no relative scaling).
 * Used for live input feedback: turns green the moment the "x" is typed.
 * @param {string} value - The value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorMultiplierInput(value: string): string {
    if (isMultiplierString(value)) return `\x1b[92m${value}\x1b[0m`;
    return `\x1b[38;5;160m${value}\x1b[0m`;
}

/**
 * Checks if a value is a percentage string (e.g. "50%").
 * @param {*} value - The value to check.
 * @returns {boolean} True if it's a percentage string.
 */
function isPercentageString(value: any): boolean {
    return typeof value === 'string' && /^[-+]?[0-9]+(?:\.[0-9]+)?%$/.test(value.trim());
}

/**
 * Colors a funds value string for display: green when it is a relative
 * percentage ("100%"), red when it is a fixed amount (no relative scaling).
 * Used for live input feedback: turns green the moment the "%" is typed.
 * @param {string} value - The value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorPercentageInput(value: any): string {
    if (isPercentageString(value)) return `\x1b[92m${value}\x1b[0m`;
    return `\x1b[38;5;160m${value}\x1b[0m`;
}

/**
 * Colors a price range value for display: green when it is a relative
 * multiplier ("1.55x"), red when it is a fixed price (no relative scaling).
 * @param {*} value - The value to color.
 * @returns {string} ANSI-colored value string.
 */
function colorPriceRangeValue(value: any): string {
    return colorMultiplierInput(String(value));
}

/**
 * Converts a cron string to a readable format (days delta and time).
 * Only supports simple daily/multi-day patterns like "0 0 * /N * *".
 * @param {string} cron
 * @returns {Object} { days, time }
 */
function parseCronToDelta(cron: string): { days: number; time: string } {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return { days: 1, time: '00:00' };

    const min = parts[0].padStart(2, '0');
    const hour = parts[1].padStart(2, '0');
    let days = 1;

    if (parts[2].startsWith('*/')) {
        days = parseInt(parts[2].substring(2)) || 1;
    } else if (parts[2] === '*') {
        days = 1;
    }

    return { days, time: `${hour}:${min}` };
}

/**
 * Converts days delta and time to a cron string.
 * @param {number} days
 * @param {string} time - format "HH:mm"
 * @returns {string} cron string
 */
function deltaToCron(days: number, time: string): string {
    const [hour, min] = time.split(':').map((s: string) => parseInt(s));
    const dayPart = days > 1 ? `*/${days}` : '*';
    return `${min} ${hour} ${dayPart} * *`;
}

/**
 * Prompts the user for a number within specified bounds.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @param {number} minVal - The minimum allowed value.
 * @param {number} maxVal - The maximum allowed value.
 * @returns {Promise<number|string>} The numeric value or '\x1b' if ESC.
 */
async function askNumberWithBounds(promptText: string, defaultValue?: any, minVal: number = 0, maxVal: number = 100): Promise<any> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    // Validate bounds
    if (parsed < minVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be >= ${minVal}`);
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    if (parsed > maxVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be <= ${maxVal}`);
        return askNumberWithBounds(promptText, defaultValue, minVal, maxVal);
    }
    return parsed;
}

/**
 * Prompts the user for the target spread percentage.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @param {number} incrementPercent - The grid increment percentage.
 * @param {number} minSpreadFactor - The minimum spread factor from GRID_LIMITS.
 * @returns {Promise<number|string>} The spread percentage or '\x1b' if ESC.
 */
async function askTargetSpreadPercent(promptText: string, defaultValue?: any, incrementPercent: number = 0, minSpreadFactor: number = GRID_LIMITS.MIN_SPREAD_FACTOR): Promise<any> {
    const safeIncrement = Number.isFinite(incrementPercent) ? incrementPercent : 0;
    const safeMinSpreadFactor = Number.isFinite(minSpreadFactor) ? minSpreadFactor : GRID_LIMITS.MIN_SPREAD_FACTOR;
    const minRequired = safeIncrement * safeMinSpreadFactor;
    const minRequiredLabel = minRequired.toFixed(6);
    const effectiveDefault = Number.isFinite(defaultValue) ? Math.max(defaultValue, minRequired) : defaultValue;
    const suffix = effectiveDefault !== undefined && effectiveDefault !== null ? ` [${effectiveDefault.toFixed(2)}]` : '';
    const raw = (await readInput(`${promptText} (>= ${minRequiredLabel})${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return effectiveDefault;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    // Validate that number is finite (not Infinity, -Infinity, or NaN)
    if (!Number.isFinite(parsed)) {
        console.log('Please enter a valid finite number.');
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    // Validate >= minSpreadFactor x incrementPercent (with floating point precision handling)
    if (parsed + Number.EPSILON < minRequired) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be >= ${safeMinSpreadFactor}x incrementPercent (${minRequiredLabel})`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    // Validate no negative
    if (parsed < 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Cannot be negative`);
        return askTargetSpreadPercent(promptText, defaultValue, incrementPercent, minSpreadFactor);
    }
    return parsed;
}

/**
 * Prompts the user for an integer within a range.
 * @param {string} promptText - The prompt text to display.
 * @param {number} [defaultValue] - The default value to use if input is empty.
 * @param {number} minVal - The minimum allowed value.
 * @param {number} maxVal - The maximum allowed value.
 * @returns {Promise<number|string>} The integer or '\x1b' if ESC.
 */
async function askIntegerInRange(promptText: string, defaultValue?: any, minVal: number = 0, maxVal: number = 100): Promise<any> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `)).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number.');
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    // Validate that number is integer (not float)
    if (!Number.isInteger(parsed)) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be an integer (no decimals)`);
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    // Validate bounds
    if (parsed < minVal || parsed > maxVal) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be between ${minVal} and ${maxVal}`);
        return askIntegerInRange(promptText, defaultValue, minVal, maxVal);
    }
    return parsed;
}

/**
 * Prompts the user for a numeric value or a multiplier.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askNumberOrMultiplier(promptText: string, defaultValue?: any): Promise<any> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${colorPriceRangeValue(defaultValue)}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `, { colorize: (input) => colorMultiplierInput(input) })).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
            return askNumberOrMultiplier(promptText, defaultValue);
        }
        return trimmed;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or multiplier (e.g. 5x).');
        return askNumberOrMultiplier(promptText, defaultValue);
    }
    // Validate that number is > 0 (for price inputs)
    if (parsed <= 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)`);
        return askNumberOrMultiplier(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for the maximum price, ensuring it's greater than minimum price.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @param {number|string} minPrice - The minimum price.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askMaxPrice(promptText: string, defaultValue?: any, minPrice?: any): Promise<any> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${colorPriceRangeValue(defaultValue)}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `, { colorize: (input) => colorMultiplierInput(input) })).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    if (isMultiplierString(raw)) {
        const trimmed = raw.trim();
        const multiplier = parseFloat(trimmed);
        if (multiplier <= 0) {
            console.log(`Invalid ${promptText}: "${trimmed}". Multiplier must be > 0. No "0x" or negative values`);
            return askMaxPrice(promptText, defaultValue, minPrice);
        }
        return trimmed;
    }
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or multiplier (e.g. 5x).');
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    // Validate that number is > 0 (for price inputs)
    if (parsed <= 0) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > 0 (positive number)`);
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    // Validate that maxPrice > minPrice
    const minPriceValue = typeof minPrice === 'string' ? parseFloat(minPrice) : minPrice;
    if (parsed <= minPriceValue) {
        console.log(`Invalid ${promptText}: ${parsed}. Must be > minPrice (${minPriceValue})`);
        return askMaxPrice(promptText, defaultValue, minPrice);
    }
    return parsed;
}

/**
 * Normalizes a percentage string input.
 * @param {string} value - The input string.
 * @returns {string|null} The normalized percentage string or null if invalid.
 */
function normalizePercentageInput(value: string): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.endsWith('%')) return null;
    const numeric = Number(trimmed.slice(0, -1).trim());
    if (Number.isNaN(numeric)) return null;
    return `${numeric}%`;
}

/**
 * Prompts the user for a numeric value or a percentage.
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The value or '\x1b' if ESC.
 */
async function askNumberOrPercentage(promptText: string, defaultValue?: any): Promise<any> {
    const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${colorPercentageInput(defaultValue)}]` : '';
    const raw = (await readInput(`${promptText}${suffix}: `, { colorize: (input) => colorPercentageInput(input) })).trim();
    if (raw === '\x1b') return '\x1b';
    if (raw === '') return defaultValue;
    const percent = normalizePercentageInput(raw);
    if (percent !== null) return percent;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
        console.log('Please enter a valid number or percentage (e.g. 100, 50%).');
        return askNumberOrPercentage(promptText, defaultValue);
    }
    return parsed;
}

/**
 * Prompts the user for a boolean value (Y/n).
 * @param {string} promptText - The prompt text to display.
 * @param {boolean} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<boolean|string>} The boolean value or '\x1b' if ESC.
 */
async function askBoolean(promptText: string, defaultValue?: any): Promise<any> {
    const label = defaultValue ? 'Y/n' : 'y/N';
    const raw = (await readInput(`${promptText} (${label}): `)).trim().toLowerCase();
    if (raw === '\x1b') return '\x1b';
    if (!raw) return !!defaultValue;
    return raw.startsWith('y');
}

/**
 * Prompts the user for the start price (numeric or "pool"/"book").
 * @param {string} promptText - The prompt text to display.
 * @param {number|string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<number|string>} The start price or '\x1b' if ESC.
 */
async function askStartPrice(promptText: string, defaultValue?: any): Promise<any> {
    while (true) {
        const suffix = defaultValue !== undefined && defaultValue !== null ? ` [${defaultValue}]` : '';
        const raw = (await readInput(`${promptText}${suffix}: `)).trim();

        if (raw === '\x1b') return '\x1b';

        if (!raw) {
            if (defaultValue !== undefined && defaultValue !== null) {
                return defaultValue;
            }
            return undefined;
        }

        const lower = raw.toLowerCase();
        if (lower === 'pool') return lower;
        if (lower === 'book') return 'book';

        // Accept numeric values (including decimals)
        const num = Number(raw);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
            return num;
        }

        console.log('Please enter "pool", "book", or a numeric value.');
    }
}

/**
 * Prompts the user for an optional pool ID to pin price derivation.
 * Enter a pool ID (e.g. 48 or 1.19.48) to set/change the pin, or enter
 * "none" / "clear" to remove it. Blank input keeps the current value.
 * @param {string} promptText - The prompt text to display.
 * @param {string|null|undefined} [currentValue] - The current poolRef value.
 * @returns {Promise<string|null|symbol>} Pool ID, null (cleared), or '\x1b' on ESC.
 */
async function askPoolRef(promptText: string, currentValue?: string | null | undefined): Promise<any> {
    while (true) {
        const suffix = currentValue ? ` [${currentValue}]` : ' [none]';
        const raw = (await readInput(`${promptText}${suffix} (none to clear): `)).trim();
        if (raw === '\x1b') return '\x1b';
        if (!raw) return currentValue || null;

        const lower = raw.toLowerCase();
        if (lower === 'none' || lower === 'clear' || lower === 'off' || lower === 'no') {
            return null;
        }

        const normalized = raw.startsWith('1.19.') ? raw : `1.19.${raw}`;
        const parts = normalized.split('.');
        if (parts.length === 3 && parts[0] === '1' && parts[1] === '19' && /^\d+$/.test(parts[2])) {
            return normalized;
        }
        console.log('Invalid — enter a pool number (e.g. 48), full ID (e.g. 1.19.48), or "none" to clear.');
    }
}

/**
 * Prompts the user for the grid price mode (pool, book, ama, numeric, or startprice).
 * @param {string} promptText - The prompt text to display.
 * @param {string} [defaultValue] - The default value to use if input is empty.
 * @returns {Promise<string>} The grid price mode or '\x1b' if ESC.
 */
async function askGridPriceMode(promptText: string, defaultValue?: any): Promise<any> {
    while (true) {
        const shownDefault = defaultValue === null || defaultValue === undefined ? 'startPrice' : defaultValue;
        const raw = (await readInput(`${promptText} [${shownDefault}]: `)).trim();
        if (raw === '\x1b') return '\x1b';
        if (!raw) return defaultValue === undefined ? null : defaultValue;

        const lower = raw.toLowerCase();
        if (lower === 'none' || lower === 'null' || lower === 'start' || lower === 'startprice') return null;
        if (lower === 'pool') return lower;
        if (lower === 'book') return 'book';
        if (/^ama(?:[1-4])?$/.test(lower)) return lower;

        const num = Number(raw);
        if (Number.isFinite(num) && num > 0) return num;

        console.log('Please enter: pool, book, ama, ama1..ama4, a positive number, or none/startprice.');
    }
}

/**
 * Normalizes a bot draft for editing or saving.
 * Preserves existing fields and strips unsupported runtime-managed fields.
 * @param {Object} [base={}] - The initial bot data to edit.
 * @returns {Object} A normalized bot draft.
 */
function normalizeBotDraft(base = {}) {
    const data = JSON.parse(JSON.stringify(base));

    if (!data.weightDistribution) data.weightDistribution = { ...DEFAULT_CONFIG.weightDistribution };
    if (!data.botFunds) data.botFunds = { ...DEFAULT_CONFIG.botFunds };
    if (!data.activeOrders) data.activeOrders = { ...DEFAULT_CONFIG.activeOrders };

    if (data.active === undefined) data.active = DEFAULT_CONFIG.active;
    if (data.dryRun === undefined) data.dryRun = DEFAULT_CONFIG.dryRun;
    if (data.minPrice === undefined) data.minPrice = DEFAULT_CONFIG.minPrice;
    if (data.maxPrice === undefined) data.maxPrice = DEFAULT_CONFIG.maxPrice;
    if (data.incrementPercent === undefined) data.incrementPercent = DEFAULT_CONFIG.incrementPercent;
    if (data.targetSpreadPercent === undefined) data.targetSpreadPercent = DEFAULT_CONFIG.targetSpreadPercent;
    if (data.startPrice === undefined) data.startPrice = data.startPrice || DEFAULT_CONFIG.startPrice || 'pool';
    if (data.gridPrice === undefined) data.gridPrice = null;
    delete data.gridPriceOffsetPct;
    delete data.gridPriceOffsetClampToBounds;
    return data;
}

/**
 * Interactive menu to edit bot data.
 * @param {Object} [base={}] - The initial bot data to edit.
 * @returns {Promise<Object|null>} The edited bot data or null if cancelled.
 */
async function promptBotData(base = {}) {
    const data = normalizeBotDraft(base);

    let finished = false;
    let cancelled = false;
    let showMenu = true;

    while (!finished) {
        if (showMenu) {
             console.log('\n\x1b[1m--- Bot Editor: ' + (data.name || 'New Bot') + ' ---\x1b[0m');
             console.log(`\x1b[1;33m1) Pair:\x1b[0m       \x1b[1;31m${data.assetA || '?'} / ${data.assetB || '?'} \x1b[0m`);
             console.log(`\x1b[1;33m2) Identity:\x1b[0m   \x1b[38;5;208mName:\x1b[0m ${data.name || '?'} , \x1b[38;5;208mAccount:\x1b[0m ${data.preferredAccount || '?'} , \x1b[38;5;208mActive:\x1b[0m ${data.active}, \x1b[38;5;208mDryRun:\x1b[0m ${data.dryRun}`);
             console.log(`\x1b[1;33m3) Price:\x1b[0m      \x1b[38;5;208mRange:\x1b[0m [${colorPriceRangeValue(data.minPrice)} - ${colorPriceRangeValue(data.maxPrice)}], \x1b[38;5;208mStart:\x1b[0m ${data.startPrice}, \x1b[38;5;208mPool:\x1b[0m ${data.poolRef || 'none'}, \x1b[38;5;208mGridPrice:\x1b[0m ${data.gridPrice === null ? 'startPrice' : data.gridPrice}`);
             console.log(`\x1b[1;33m4) Grid:\x1b[0m       \x1b[38;5;208mWeights:\x1b[0m (S:${data.weightDistribution.sell}, B:${data.weightDistribution.buy}), \x1b[38;5;208mIncr:\x1b[0m ${data.incrementPercent}%, \x1b[38;5;208mSpread:\x1b[0m ${data.targetSpreadPercent}%`);
             console.log(`\x1b[1;33m5) Funding:\x1b[0m    \x1b[38;5;208mSell:\x1b[0m ${colorPercentageInput(data.botFunds.sell)}, \x1b[38;5;208mBuy:\x1b[0m ${colorPercentageInput(data.botFunds.buy)} | \x1b[38;5;208mOrders:\x1b[0m (S:${data.activeOrders.sell}, B:${data.activeOrders.buy})`);
             console.log('--------------------------------------------------');
             console.log('\x1b[1;32mS) Save & Exit\x1b[0m');
             console.log('\x1b[97mC) Cancel (Discard changes)\x1b[0m');
            showMenu = false;
        }

        const choice = (await readInput('Select section to edit or action: ', {
            validate: (input: string) => ['1', '2', '3', '4', '5', 's', 'c'].includes(input.toLowerCase())
        })).trim().toLowerCase();

        if (choice === '\x1b') {
            finished = true;
            cancelled = true;
            break;
        }

        switch (choice) {
            case '1':
                const assetA = await askAsset('Asset A for selling', data.assetA);
                if (assetA === '\x1b') break;
                const assetB = await askAssetB('Asset B for buying', data.assetB, assetA);
                if (assetB === '\x1b') break;
                data.assetA = assetA;
                data.assetB = assetB;
                showMenu = true;
                break;
            case '2':
                const name = await askRequiredString('Bot name', data.name);
                if (name === '\x1b') break;
                const prefAcc = await askRequiredString('Preferred account', data.preferredAccount);
                if (prefAcc === '\x1b') break;
                const active = await askBoolean('Active', data.active);
                if (active === '\x1b') break;
                const dryRun = await askBoolean('Dry run', data.dryRun);
                if (dryRun === '\x1b') break;
                data.name = name;
                data.preferredAccount = prefAcc;
                data.active = active;
                data.dryRun = dryRun;
                showMenu = true;
                break;
            case '3':
                const minP = await askNumberOrMultiplier('minPrice', data.minPrice);
                if (minP === '\x1b') break;
                const maxP = await askMaxPrice('maxPrice', data.maxPrice, minP);
                if (maxP === '\x1b') break;
                const startP = await askStartPrice('startPrice (pool, book or A/B)', data.startPrice);
                if (startP === '\x1b') break;
                const poolR = await askPoolRef('poolRef (pinned pool ID for pool price)', data.poolRef);
                if (poolR === '\x1b') break;
                const gp = await askGridPriceMode('gridPrice (pool/book/ama/number/none)', data.gridPrice);
                if (gp === '\x1b') break;
                data.minPrice = minP;
                data.maxPrice = maxP;
                data.startPrice = startP;
                data.poolRef = poolR || undefined;
                data.gridPrice = gp;
                showMenu = true;
                break;
            case '4':
                const wSell = await askWeightDistribution('Weight distribution (sell)', data.weightDistribution.sell);
                if (wSell === '\x1b') break;
                const wBuy = await askWeightDistributionNoLegend('Weight distribution (buy)', data.weightDistribution.buy);
                if (wBuy === '\x1b') break;
                const incrP = await askNumberWithBounds('incrementPercent', data.incrementPercent, INCREMENT_BOUNDS.MIN_PERCENT, INCREMENT_BOUNDS.MAX_PERCENT);
                if (incrP === '\x1b') break;
                const defaultSpread = data.targetSpreadPercent || incrP * 4;

                // Use current general settings for the validation limit
                const currentSettings = loadGeneralSettings();
                const targetS = await askTargetSpreadPercent('targetSpread %', defaultSpread, incrP, currentSettings.GRID_LIMITS.MIN_SPREAD_FACTOR);

                if (targetS === '\x1b') break;
                data.weightDistribution.sell = wSell;
                data.weightDistribution.buy = wBuy;
                data.incrementPercent = incrP;
                data.targetSpreadPercent = targetS;
                showMenu = true;
                break;
            case '5':
                const fSell = await askNumberOrPercentage('botFunds sell amount', data.botFunds.sell);
                if (fSell === '\x1b') break;
                const fBuy = await askNumberOrPercentage('botFunds buy amount', data.botFunds.buy);
                if (fBuy === '\x1b') break;
                const oSell = await askIntegerInRange('activeOrders sell count', data.activeOrders.sell, 1, 100);
                if (oSell === '\x1b') break;
                const oBuy = await askIntegerInRange('activeOrders buy count', data.activeOrders.buy, 1, 100);
                if (oBuy === '\x1b') break;
                data.botFunds.sell = fSell;
                data.botFunds.buy = fBuy;
                data.activeOrders.sell = oSell;
                data.activeOrders.buy = oBuy;
                showMenu = true;
                break;
            case 's':
                // Final basic validation before saving
                if (!data.name || !data.assetA || !data.assetB || !data.preferredAccount) {
                    console.log('\x1b[38;5;160mError: Name, Pair, and Account are required before saving.\x1b[0m');
                    break;
                }
                {
                    const currentSettings = loadGeneralSettings();
                    const spreadFactor = Number.isFinite(currentSettings.GRID_LIMITS.MIN_SPREAD_FACTOR)
                        ? currentSettings.GRID_LIMITS.MIN_SPREAD_FACTOR
                        : GRID_LIMITS.MIN_SPREAD_FACTOR;
                    const minRequiredSpread = data.incrementPercent * spreadFactor;
                    if (data.targetSpreadPercent + Number.EPSILON < minRequiredSpread) {
                        console.log(`\x1b[38;5;160mError: targetSpreadPercent (${data.targetSpreadPercent}) must be >= ${spreadFactor}x incrementPercent (${minRequiredSpread.toFixed(6)}).\x1b[0m`);
                        break;
                    }
                }
                finished = true;
                break;
            case 'c':
                finished = true;
                cancelled = true;
                break;
            default:
                // Invalid choice - just ignore and prompt again without redisplaying menu
        }
    }

    if (cancelled) return null;

    // Return the final data structure, preserving ALL fields from the normalized
    // draft (deep-copy of base + defaults, minus stripped runtime-managed fields).
    // A fixed whitelist here would silently drop custom overrides (logging, timing,
    // feeParams, gridLimits, poolRef, etc.) when the caller replaces the bot entry.
    return { ...data };
}

/**
 * Interactive menu to edit general settings.
 * @returns {Promise<void>}
 */
async function promptGeneralSettings() {
    const settings = loadGeneralSettings();
    let finished = false;

     while (!finished) {
          console.log('\x1b[1m--- General Settings (Global) ---\x1b[0m');
          console.log(`\x1b[1;33m1) Grid Health:\x1b[0m   \x1b[38;5;208mRatio:\x1b[0m ${settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE}%, \x1b[38;5;208mRMS:\x1b[0m ${settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE}%, \x1b[38;5;208mAMA Delta:\x1b[0m ${settings.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT}%`);
          console.log(`\x1b[1;33m2) Order Recovery:\x1b[0m \x1b[38;5;208mDust Threshold:\x1b[0m ${settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE}%`);
          const nodeCount = (settings.NODES.list || []).length;
          const hcIntervalMin = ((settings.NODES.healthCheck?.intervalMs || NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS) / 60000).toFixed(0);
          const prefNodeDisplay = settings.NODES.selection?.preferredNode || 'none';
          console.log(`\x1b[1;33m3) Node Config:\x1b[0m \x1b[38;5;208mNodes:\x1b[0m ${nodeCount}, \x1b[38;5;208mHealthChk:\x1b[0m ${hcIntervalMin}min, \x1b[38;5;208mPrefNode:\x1b[0m ${prefNodeDisplay}`);
          console.log(`\x1b[1;33m4) Log lvl:\x1b[0m      \x1b[38;5;208m${settings.LOG_LEVEL}\x1b[0m (debug, info, warn, error)`);
          const updaterStatus = settings.UPDATER.ACTIVE ? `\x1b[92mON\x1b[0m` : `\x1b[38;5;160mOFF\x1b[0m`;
          const currentSched = parseCronToDelta(settings.UPDATER.SCHEDULE || "0 0 * * *");
          console.log(`\x1b[1;33m5) Updater:\x1b[0m      [${updaterStatus}] \x1b[38;5;208mBranch:\x1b[0m ${settings.UPDATER.BRANCH}, \x1b[38;5;208mInterval:\x1b[0m ${currentSched.days}d, \x1b[38;5;208mTime:\x1b[0m ${currentSched.time}`);
          console.log('--------------------------------------------------');
          console.log('\x1b[1;32mS) Save & Exit\x1b[0m');
          console.log('\x1b[97mC) Cancel (Discard changes)\x1b[0m');

         const choice = (await readInput('Select section to edit or action: ', {
              validate: (input: string) => ['1', '2', '3', '4', '5', 's', 'c'].includes(input)
         })).trim().toLowerCase();

        if (choice === '\x1b') {
            finished = true;
            break;
        }

        switch (choice) {
            case '1':
                const gRegen = await askNumberWithBounds('Grid Ratio Regeneration %', settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE, 0.1, 50);
                if (gRegen === '\x1b') break;
                const rms = await askNumberWithBounds('RMS Divergence Threshold %', settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE, 1, 100);
                if (rms === '\x1b') break;
                const amaDelta = await askNumberWithBounds('AMA Delta Threshold %', settings.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT, 0.1, 50.0);
                if (amaDelta === '\x1b') break;
                settings.GRID_LIMITS.GRID_REGENERATION_PERCENTAGE = gRegen;
                settings.GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE = rms;
                settings.MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT = amaDelta;
                break;
            case '2':
                const dust = await askNumberWithBounds('Partial Dust Threshold %', settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE, 0.1, 50);
                if (dust === '\x1b') break;
                settings.GRID_LIMITS.PARTIAL_DUST_THRESHOLD_PERCENTAGE = dust;
                break;
            case '3':
                settings.NODES.enabled = true;
                {
                    const currentList = settings.NODES.list && settings.NODES.list.length > 0
                        ? settings.NODES.list
                        : NODE_MANAGEMENT.DEFAULT_NODES;
                    let nodeList = [...currentList];
                    let editorCancelled = false;

                    while (true) {
                        console.log('\x1b[1m  === Node List Editor ===\x1b[0m');
                        nodeList.forEach((node, i) => {
                            console.log(`  \x1b[38;5;208m${i + 1})\x1b[0m ${node}`);
                        });
                        console.log('  \x1b[1;32mA) Add node\x1b[0m');
                        console.log('  \x1b[1;31mR) Remove node\x1b[0m');
                        console.log('  \x1b[1;33mD) Done\x1b[0m');

                        const nodeChoice = (await readInput('  Choice: ')).trim().toLowerCase();
                        if (nodeChoice === '\x1b') {
                            editorCancelled = true;
                            break;
                        }

                        if (nodeChoice === 'a') {
                            const newNode = await askString('  Enter node URL');
                            if (newNode === '\x1b') continue;
                            if (newNode && newNode.trim()) {
                                nodeList.push(newNode.trim());
                                console.log(`  \x1b[92mAdded.\x1b[0m Count: ${nodeList.length}`);
                            }
                        } else if (nodeChoice === 'r') {
                            if (nodeList.length <= 1) {
                                console.log('  \x1b[33mNeed at least one node. Add another first.\x1b[0m');
                                continue;
                            }
                            const removeIdx = await askIntegerInRange('  Enter node number to remove', 1, 1, nodeList.length);
                            if (removeIdx === '\x1b') continue;
                            const removed = nodeList.splice(removeIdx - 1, 1)[0];
                            console.log(`  \x1b[92mRemoved:\x1b[0m ${removed}`);
                        } else if (nodeChoice === 'd') {
                            settings.NODES.list = nodeList;
                            break;
                        }
                    }

                    if (editorCancelled) break;
                }

                const hcInterval = await askIntegerInRange('Health Check Interval (min)', (settings.NODES.healthCheck?.intervalMs || NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS) / 60000, 1, 43200);
                if (hcInterval === '\x1b') break;
                if (!settings.NODES.healthCheck) settings.NODES.healthCheck = {};
                settings.NODES.healthCheck.intervalMs = hcInterval * 60000;

                const prefNode = await askString('Preferred Node URL (leave empty for automatic selection)', settings.NODES.selection?.preferredNode || '');
                if (prefNode === '\x1b') break;
                if (!settings.NODES.selection) settings.NODES.selection = {};
                settings.NODES.selection.preferredNode = prefNode.trim() || null;
                break;
            case '4':
                const newLevel = await askLogLevel('Enter log level', settings.LOG_LEVEL);
                if (newLevel === '\x1b') break;
                settings.LOG_LEVEL = newLevel;
                break;
            case '5':
                const upActive = await askBoolean('Enable Automated Updater', settings.UPDATER.ACTIVE !== false);
                if (upActive === '\x1b') break;
                settings.UPDATER.ACTIVE = upActive;

                 console.log('  \x1b[38;5;250mBranch:\x1b[0m \x1b[92mmain\x1b[0m, \x1b[38;5;208mdev\x1b[0m, \x1b[38;5;160mtest\x1b[0m, or \x1b[38;5;39mauto\x1b[0m (detected current)');
                const branch = await askUpdaterBranch('Branch', settings.UPDATER.BRANCH);
                if (branch === '\x1b') break;

                const schedule = await askCronSchedule('Schedule', settings.UPDATER.SCHEDULE);
                if (schedule === '\x1b') break;

                settings.UPDATER.BRANCH = branch;

                settings.UPDATER.SCHEDULE = schedule;
                break;
            case 's':
                saveGeneralSettings(settings);
                finished = true;
                break;
            case 'c':
                finished = true;
                break;
            default:
                console.log('Invalid choice.');
        }
    }
}

/**
 * Entry point exposing a menu-driven interface for creating, modifying, and reviewing bots.
 * @returns {Promise<void>}
 */
async function main() {
    console.log('dexbot bot — bots.json configurator (writes profiles/bots.json)');
    const { config, filePath } = loadBotsConfig();
    let exit = false;
     while (!exit) {
         console.log('\nActions:');
         console.log('  1) New bot');
         console.log('  2) Modify bot');
         console.log('  3) Delete bot');
         console.log('  4) Copy bot');
         console.log('  5) List bots');
         console.log('  6) General settings');
         console.log('  7) Exit (or press Enter)');
         const selection = (await readInput('Choose an action [1-7]: ')).trim();
         console.log('');

         if (selection === '\x1b' || selection === '7' || selection === '') {
             exit = true;
             continue;
         }

        switch (selection) {
            case '1': {
                while (true) {
                    try {
                        const entry = await promptBotData();
                        if (!entry) break;
                        config.bots.push(entry);
                        saveBotsConfig(config, filePath);
                        console.log(`\nAdded bot '${entry.name}' to ${path.basename(filePath)}.`);
                    } catch (err: any) {
                        console.log(`\n❌ Invalid input: ${getErrorMessage(err)}\n`);
                        break;
                    }
                }
                break;
            }
            case '2': {
                while (true) {
                    const idx = await selectBotIndex(config.bots, 'modify or leave (Enter/Esc)');
                    if (idx === null || idx === '\x1b') break;
                    try {
                        const entry = await promptBotData(config.bots[idx]);
                        if (entry) {
                            config.bots[idx] = entry;
                            saveBotsConfig(config, filePath);
                            console.log(`saved settings '${entry.name}' in ${path.basename(filePath)}.\n`);
                        }
                    } catch (err: any) {
                        console.log(`\n❌ Invalid input: ${getErrorMessage(err)}\n`);
                    }
                }
                break;
            }
            case '3': {
                while (true) {
                    const idx = await selectBotIndex(config.bots, 'delete or leave (Enter/Esc)');
                    if (idx === null || idx === '\x1b') break;
                    const placeholderName = config.bots[idx].name || `<unnamed-${idx + 1}>`;
                    const confirm = await askBoolean(`Delete '${placeholderName}'?`, false);
                    if (confirm === '\x1b') break;
                    if (confirm) {
                        const removed = config.bots.splice(idx, 1)[0];
                        saveBotsConfig(config, filePath);
                        console.log(`Removed bot '${removed.name || placeholderName}' from ${path.basename(filePath)}.\n`);
                    } else {
                        console.log('\nDeletion cancelled.');
                    }
                }
                break;
            }
            case '4': {
                while (true) {
                    const idx = await selectBotIndex(config.bots, 'copy or leave (Enter/Esc)');
                    if (idx === null || idx === '\x1b') break;
                    try {
                        const entry = await promptBotData(config.bots[idx]);
                        if (entry) {
                            config.bots.splice(idx + 1, 0, entry);
                            saveBotsConfig(config, filePath);
                            console.log(`Copied bot '${entry.name}' into ${path.basename(filePath)}.\n`);
                        }
                    } catch (err: any) {
                        console.log(`\n❌ Invalid input: ${getErrorMessage(err)}\n`);
                    }
                }
                break;
            }
            case '5':
                listBots(config.bots);
                break;
            case '6':
                await promptGeneralSettings();
                break;
            case '7':
                exit = true;
                break;
            default:
                console.log('Unknown selection.');
        }
    }
    console.log('Botmanager closed!');
}

export { main, normalizeBotDraft, parseJsonWithComments, parseCronToDelta, deltaToCron }

