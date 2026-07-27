
import { readJSON } from './utils/fs_utils';
import { PATHS } from './paths';
import { normalizeBotEntry } from './bot_settings';
import { getErrorMessage } from './utils/errors';
'use strict';


interface ValidationProblem {
    file: string;
    field: string;
    message: string;
    severity: 'error' | 'warn';
}

type ProblemList = ValidationProblem[];

const PROFILE_KNOWN_FIELDS = new Set([
    'key', 'assetA', 'assetB', 'assetAId', 'assetBId',
    'poolId', 'intervalSeconds', 'intervalLabel',
    'defaultAma', 'sourceResultsFile', 'updatedAt', 'amas',
]);

const PROFILE_AMA_KNOWN_FIELDS = new Set([
    'name', 'erPeriod', 'fastPeriod', 'slowPeriod',
]);

const GENERAL_SETTINGS_KNOWN_FIELDS = new Set([
    'LOG_LEVEL', 'NODES', 'GRID_LIMITS', 'TIMING', 'UPDATER',
    'MARKET_ADAPTER', 'DEFAULT_CONFIG', 'FILL_PROCESSING',
    'PIPELINE_TIMING', 'LAUNCHER', 'CREDENTIAL_PROMPTS',
    'NATIVE_CLIENT', 'LOGGING_CONFIG', 'MAINTENANCE',
    'COW_PERFORMANCE', 'INCREMENT_BOUNDS', 'FEE_PARAMETERS',
    'API_LIMITS', 'NODE_MANAGEMENT', 'EXPERT',
]);

const WHITELIST_KNOWN_FLAGS = new Set([
    'ama', 'dynamicWeight', 'asymmetricBounds',
]);

const MA_SETTINGS_KNOWN_FIELDS = new Set([
    'globals', 'pairs',
]);
const MA_PAIR_KNOWN_FIELDS = new Set([
    'key', 'assetASymbol', 'assetBSymbol',
    'marketAdapterSettings', 'botOverrides',
]);

function push(problems: ProblemList, file: string, field: string, message: string, severity: 'error' | 'warn' = 'error') {
    problems.push({ file, field, message, severity });
}

function isPositiveFinite(v: any): boolean {
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function loadJsonFile(filePath: string): { data: any; ok: boolean; error?: string } {
    try {
        const data = readJSON(filePath);
        return { data, ok: true };
    } catch (err: any) {
        if (err?.code === 'ENOENT') return { data: null, ok: true };
        if (err instanceof SyntaxError) return { data: null, ok: true };
        return { data: null, ok: false, error: `${filePath}: ${getErrorMessage(err)}` };
    }
}

// --- market_profiles.json ---
function validateMarketProfiles(data: any, filePath: string, problems: ProblemList) {
    if (!data) return;

    if ('version' in data && typeof data.version !== 'number') {
        push(problems, filePath, 'version', `Must be a number`);
    }

    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    profiles.forEach((p: any, idx: number) => {
        const prefix = `profiles[${idx}]`;
        if (typeof p !== 'object' || p === null) return;

        for (const key of Object.keys(p)) {
            if (!PROFILE_KNOWN_FIELDS.has(key)) {
                push(problems, filePath, `${prefix}.${key}`,
                    `Unrecognized field "${key}"`, 'warn');
            }
        }

        if ('assetA' in p && typeof p.assetA !== 'string') {
            push(problems, filePath, `${prefix}.assetA`, `Must be a string`);
        }
        if ('assetB' in p && typeof p.assetB !== 'string') {
            push(problems, filePath, `${prefix}.assetB`, `Must be a string`);
        }
        if ('defaultAma' in p && typeof p.defaultAma !== 'string') {
            push(problems, filePath, `${prefix}.defaultAma`, `Must be a string`);
        }
        if ('intervalSeconds' in p && !isPositiveFinite(p.intervalSeconds)) {
            push(problems, filePath, `${prefix}.intervalSeconds`, `Must be a positive number`);
        }

        if (p.amas && typeof p.amas === 'object') {
            for (const [amaKey, amaVal] of Object.entries(p.amas)) {
                const ap = `${prefix}.amas.${amaKey}`;
                if (typeof amaVal !== 'object' || amaVal === null) {
                    push(problems, filePath, ap, `Must be an object`);
                    continue;
                }
                for (const k of Object.keys(amaVal as any)) {
                    if (!PROFILE_AMA_KNOWN_FIELDS.has(k)) {
                        push(problems, filePath, `${ap}.${k}`,
                            `Unrecognized field "${k}"`, 'warn');
                    }
                }
                const v = amaVal as any;
                if ('erPeriod' in v && !isPositiveFinite(v.erPeriod)) {
                    push(problems, filePath, `${ap}.erPeriod`, `Must be a positive number`);
                }
                if ('fastPeriod' in v && !isPositiveFinite(v.fastPeriod)) {
                    push(problems, filePath, `${ap}.fastPeriod`, `Must be a positive number`);
                }
                if ('slowPeriod' in v && !isPositiveFinite(v.slowPeriod)) {
                    push(problems, filePath, `${ap}.slowPeriod`, `Must be a positive number`);
                }
            }
        }
    });
}

// --- market_adapter_whitelist.json ---
function validateWhitelist(data: any, filePath: string, problems: ProblemList) {
    if (!data) return;

    const raw = data.whitelist;
    if (raw === undefined) {
        push(problems, filePath, 'whitelist', `Missing required key "whitelist"`);
        return;
    }

    if (Array.isArray(raw)) {
        raw.forEach((entry: any, idx: number) => {
            if (entry !== null && entry !== undefined && typeof entry !== 'string') {
                push(problems, filePath, `whitelist[${idx}]`,
                    `Array entries should be bot key strings, got ${typeof entry}`, 'warn');
            }
        });
        return;
    }

    if (raw && typeof raw === 'object') {
        for (const [botKey, entry] of Object.entries(raw)) {
            const prefix = `whitelist.${botKey}`;
            if (entry === true || entry === false || entry === null || entry === undefined) continue;
            if (typeof entry !== 'object') {
                push(problems, filePath, prefix,
                    `Expected object or boolean, got ${typeof entry}`, 'warn');
                continue;
            }
            for (const k of Object.keys(entry)) {
                if (!WHITELIST_KNOWN_FLAGS.has(k)) {
                    push(problems, filePath, `${prefix}.${k}`,
                        `Unrecognized flag "${k}" — must be one of: ${[...WHITELIST_KNOWN_FLAGS].join(', ')}`, 'warn');
                }
            }
            for (const flag of WHITELIST_KNOWN_FLAGS) {
                if (flag in (entry as any) && typeof (entry as any)[flag] !== 'boolean') {
                    push(problems, filePath, `${prefix}.${flag}`,
                        `Must be a boolean, got ${typeof (entry as any)[flag]}`);
                }
            }
        }
    }
}

// --- market_adapter_settings.json ---
function validateMarketAdapterSettings(data: any, filePath: string, problems: ProblemList) {
    if (!data) return;

    for (const key of Object.keys(data)) {
        if (!MA_SETTINGS_KNOWN_FIELDS.has(key)) {
            push(problems, filePath, key,
                `Unrecognized field "${key}"`, 'warn');
        }
    }

    if ('globals' in data && data.globals !== null) {
        if (typeof data.globals !== 'object') {
            push(problems, filePath, 'globals', `Must be an object`);
        }
    }

    if ('pairs' in data && data.pairs !== null) {
        if (!Array.isArray(data.pairs)) {
            push(problems, filePath, 'pairs', `Must be an array`);
        } else {
            data.pairs.forEach((pair: any, idx: number) => {
                const prefix = `pairs[${idx}]`;
                if (typeof pair !== 'object' || pair === null) return;
                for (const key of Object.keys(pair)) {
                    if (!MA_PAIR_KNOWN_FIELDS.has(key)) {
                        push(problems, filePath, `${prefix}.${key}`,
                            `Unrecognized field "${key}"`, 'warn');
                    }
                }
                if ('key' in pair && typeof pair.key !== 'string') {
                    push(problems, filePath, `${prefix}.key`, `Must be a string`);
                }
                if ('marketAdapterSettings' in pair && pair.marketAdapterSettings !== null
                    && typeof pair.marketAdapterSettings !== 'object') {
                    push(problems, filePath, `${prefix}.marketAdapterSettings`, `Must be an object`);
                }
                if ('botOverrides' in pair && pair.botOverrides !== null
                    && typeof pair.botOverrides !== 'object') {
                    push(problems, filePath, `${prefix}.botOverrides`, `Must be an object`);
                }
            });
        }
    }
}

// --- general.settings.json ---
function validateGeneralSettings(data: any, filePath: string, problems: ProblemList) {
    if (!data) return;

    for (const key of Object.keys(data)) {
        if (!GENERAL_SETTINGS_KNOWN_FIELDS.has(key) && !key.startsWith('_')) {
            push(problems, filePath, key,
                `Unrecognized field "${key}" — may be stale/misspelled, has no effect`, 'warn');
        }
    }

    if ('LOG_LEVEL' in data && data.LOG_LEVEL !== undefined) {
        const valid = ['debug', 'info', 'warn', 'error', 'critical'];
        if (!valid.includes(String(data.LOG_LEVEL).toLowerCase())) {
            push(problems, filePath, 'LOG_LEVEL',
                `Must be one of: ${valid.join(', ')}, got ${JSON.stringify(data.LOG_LEVEL)}`, 'warn');
        }
    }

    if ('MARKET_ADAPTER' in data && data.MARKET_ADAPTER !== null && data.MARKET_ADAPTER !== undefined) {
        if (typeof data.MARKET_ADAPTER !== 'object') {
            push(problems, filePath, 'MARKET_ADAPTER', `Must be an object`);
        }
    }
}

// --- Cross-file consistency ---
function validateCrossFileConsistency(problems: ProblemList) {
    const botKeysInWhitelist = new Set<string>();
    const botKeysInWhitelistEnabledAma = new Set<string>();

    // Load whitelist
    const wlFile = PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON();
    const wlResult = loadJsonFile(wlFile);
    if (wlResult.ok && wlResult.data) {
        const raw = wlResult.data.whitelist;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [botKey, entry] of Object.entries(raw)) {
                botKeysInWhitelist.add(botKey);
                const flags = typeof entry === 'object' && entry !== null ? entry : {};
                if ((flags as any).ama !== false) {
                    botKeysInWhitelistEnabledAma.add(botKey);
                }
            }
        } else if (Array.isArray(raw)) {
            for (const entry of raw) {
                if (entry) {
                    const k = String(entry);
                    botKeysInWhitelist.add(k);
                    botKeysInWhitelistEnabledAma.add(k);
                }
            }
        }
    }

    // Load market_profiles
    const mpFile = PATHS.PROFILES.MARKET_PROFILES_JSON;
    const mpResult = loadJsonFile(mpFile);
    const profiles: any[] = [];
    if (mpResult.ok && mpResult.data) {
        const raw = Array.isArray(mpResult.data.profiles) ? mpResult.data.profiles : [];
        profiles.push(...raw);
    }

    // Load bots.json — match AMA bots against profiles and whitelist
    const botsFile = PATHS.PROFILES.BOTS_JSON;
    const botsResult = loadJsonFile(botsFile);
    const amaBotKeys = new Set<string>();
    if (botsResult.ok && botsResult.data) {
        const bots = Array.isArray(botsResult.data.bots) ? botsResult.data.bots : [];
        bots.forEach((bot: any, idx: number) => {
            if (!bot) return;
            const gp = bot.gridPrice;
            const usesAma = typeof gp === 'string' && /^ama(?:[1-4])?$/i.test(gp.trim());
            if (!usesAma) return;

            const name = bot.name || `unnamed-${idx}`;
            const botKey = normalizeBotEntry(bot, idx).botKey;
            amaBotKeys.add(botKey);

            // Check whitelist: warn if AMA bot has no whitelist entry
            if (botKeysInWhitelist.size > 0 && !botKeysInWhitelistEnabledAma.has(botKey)) {
                push(problems, wlFile, `whitelist`,
                    `Bot "${name}" uses gridPrice: "${gp}" but is not in the AMA whitelist (or ama=false) — market adapter runs in dry-run mode`, 'warn');
            }

            // No market profile check needed: AMA falls back to built-in defaults by design
        });
    }

    // Check whitelist entries that have no corresponding AMA bot in bots.json
    if (amaBotKeys.size > 0) {
        for (const bk of botKeysInWhitelistEnabledAma) {
            if (!amaBotKeys.has(bk)) {
                push(problems, botsFile, `bots`,
                    `Whitelist entry "${bk}" has no corresponding AMA bot in bots.json — stale entry`, 'warn');
            }
        }
    }
}

// --- Main entry ---
function validateAllProfiles(): { errors: ProblemList; warnings: ProblemList } {
    const all: ProblemList = [];

    // general.settings.json
    const gsFile = PATHS.PROFILES.GENERAL_SETTINGS_JSON;
    const gsResult = loadJsonFile(gsFile);
    if (!gsResult.ok) {
        push(all, gsFile, '(root)', `Failed to parse — ${gsResult.error}`);
    } else if (gsResult.data) {
        validateGeneralSettings(gsResult.data, gsFile, all);
    }

    // bots.json — delegate to existing bot_settings.ts validateBotEntry.
    // Only check parse errors here; field-level validation is handled by
    // collectValidationIssues in bot_settings.ts which is already called
    // by runBotInstances (dexbot.ts).
    const botsFile = PATHS.PROFILES.BOTS_JSON;
    const botsResult = loadJsonFile(botsFile);
    if (!botsResult.ok) {
        push(all, botsFile, '(root)', `Failed to parse — ${botsResult.error}`);
    }

    // market_adapter_whitelist.json
    const wlFile = PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON();
    const wlResult = loadJsonFile(wlFile);
    if (!wlResult.ok) {
        push(all, wlFile, '(root)', `Failed to parse — ${wlResult.error}`);
    } else if (wlResult.data) {
        validateWhitelist(wlResult.data, wlFile, all);
    }

    // market_profiles.json
    const mpFile = PATHS.PROFILES.MARKET_PROFILES_JSON;
    const mpResult = loadJsonFile(mpFile);
    if (!mpResult.ok) {
        push(all, mpFile, '(root)', `Failed to parse — ${mpResult.error}`);
    } else if (mpResult.data) {
        validateMarketProfiles(mpResult.data, mpFile, all);
    }

    // market_adapter_settings.json
    const maFile = PATHS.PROFILES.MARKET_ADAPTER_SETTINGS_JSON;
    const maResult = loadJsonFile(maFile);
    if (!maResult.ok) {
        push(all, maFile, '(root)', `Failed to parse — ${maResult.error}`);
    } else if (maResult.data) {
        validateMarketAdapterSettings(maResult.data, maFile, all);
    }

    // Cross-file consistency
    validateCrossFileConsistency(all);

    const errors = all.filter((p) => p.severity === 'error');
    const warnings = all.filter((p) => p.severity === 'warn');
    return { errors, warnings };
}

function printValidationProblems(result: { errors: ProblemList; warnings: ProblemList }): boolean {
    if (result.errors.length === 0 && result.warnings.length === 0) return true;

    if (result.warnings.length > 0) {
        console.warn('\n═══════════════════════════════════════════');
        console.warn('  Profile Configuration Warnings');
        console.warn('═══════════════════════════════════════════');
        for (const w of result.warnings) {
            console.warn(`  * ${w.file}:${w.field}`);
            console.warn(`    ${w.message}`);
        }
        console.warn('');
    }

    if (result.errors.length > 0) {
        console.error('\n═══════════════════════════════════════════');
        console.error('  Profile Configuration ERRORS');
        console.error('═══════════════════════════════════════════');
        for (const e of result.errors) {
            console.error(`  * ${e.file}:${e.field}`);
            console.error(`    ${e.message}`);
        }
        console.error('');
        return false;
    }

    return true;
}

export { validateAllProfiles, printValidationProblems, loadJsonFile, validateMarketProfiles, validateWhitelist, validateMarketAdapterSettings, validateGeneralSettings, validateCrossFileConsistency }

