#!/usr/bin/env node
'use strict';

/**
 * PRICE ADAPTER (standalone)
 *
 * Purpose:
 * - Runs independently from dexbot runtime
 * - Loads active bots with AMA grid pricing from profiles/bots.json
 * - Uses built-in AMA defaults from constants, optionally overridden by pair-specific
 *   profiles in profiles/market_profiles.json
 * - Bootstraps 1h candles from Kibana once (if local file missing)
 * - Then updates candles from native BitShares API only
 * - Persists candles incrementally, prunes to AMA-required window
 * - Tracks a separate market center price per bot in market_adapter/state
 * - Creates recalculate.<botKey>.trigger when AMA center delta threshold is reached
 *
 * GRID RECALCULATION TRIGGERS (Three Independent Mechanisms):
 * ──────────────────────────────────────────────────────────
 *
 * 1. AMA DELTA THRESHOLD (this file / market adapter)
 *    Triggers when market price moves significantly from last recorded AMA center
 *    ├─ Controlled by: MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT
 *    ├─ Location: profiles/general.settings.json
 *    ├─ Default: 2.5% (grid resets when AMA moves ±2.5%)
 *    ├─ CLI override: --deltaPercent <percent>
 *    └─ Use case: Catch big market moves that require grid repositioning
 *
 * 2. RMS DIVERGENCE CHECK (order/grid.ts / grid engine)
 *    Triggers when calculated grid diverges from blockchain state
 *    ├─ Controlled by: GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE
 *    ├─ Location: profiles/general.settings.json
 *    ├─ Default: 14.3% (balanced tolerance)
 *    ├─ Set to 0 to disable (Issue #5: RMS Divergence Check Disabling)
 *    └─ Use case: Detect order fill/rotation accumulation drift
 *
 * 3. GRID REGENERATION (internal threshold)
 *    Triggers when available funds exceed allocation threshold
 *    ├─ Controlled by: GRID_LIMITS.GRID_REGENERATION_PERCENTAGE
 *    ├─ Default: 3% (regen when free balance ≥ 3% of allocated capital)
 *    └─ Use case: Rebalance and utilize accumulated fill proceeds
 *
 * AMA PROFILE SELECTION (per bot via gridPrice keyword):
 * ───────────────────────────────────────────────────────
 *   gridPrice: "ama"  or "ama3" => default (best backtest score)
 *   gridPrice: "ama1"             => min move, cap 25%
 *   gridPrice: "ama2"             => min move, cap 30%
 *   gridPrice: "ama3"             => min move, cap 35%
 *   gridPrice: "ama4"             => min move, cap 40%
 *
 * No wallet keys/password/auth required (read-only chain + Kibana bootstrap).
 */

const { path } = require('../modules/path_api');
const { getStorage } = require('../modules/storage');
const storage = getStorage();

const { parseJsonWithComments, sleep, ensureDir } = require('../modules/order/utils/system');
const { readGeneralSettings } = require('../modules/general_settings');
const { DEFAULT_CONFIG, MARKET_ADAPTER, NATIVE_CLIENT, API_LIMITS, TIMING } = require('../modules/constants');
const { createBotKey } = require('../modules/account_orders');
const { normalizeBotEntry } = require('../modules/bot_settings');
const { calculateAMA } = require('./core/strategies/ama');
const {
    normalizeAtrPeriod,
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
} = require('./core/config_normalizers');
const {
    resetMarketAdapterWhitelistCache,
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
    isBotAsymmetricBoundsWhitelisted,
    isBotGridRangeScalingWhitelisted,
} = require('../modules/market_adapter_whitelist');
const kibanaSource = require('./inputs/kibana_source');
const kibanaMarketSource = require('./core/kibana_market_candles');
const { tradesToCandles, detectMissingCandleTimestamps, fillCandleGaps, detectStaleTail, pruneStaleTail, mergeCandles } = require('./candle_utils');
const { toIntervalLabel } = require('./interval_utils');
const {
    normalizeAssetSymbol,
    normalizeMarketSource,
    hasNumericStartPrice,
    resolveMarketSourceForBot,
    resolveAsset,
    findPoolByAssets,
    resolveBotContext,
    isExactPair,
    isSamePair,
    isExactPairIds,
    isSamePairIds,
    getBitsharesClient,
    setBitsharesClientForTests,
} = require('./utils/chain');
const { loadMarketProfiles } = require('../analysis/tradingview/tradingview_uplot_chart_generator');
const { writeJsonAtomic } = require('./utils/atomic_write');
const { acquireFileLockSync, releaseFileLockSync } = require('./utils/file_lock');
const { updateDynamicGridSnapshotSync } = require('./utils/dynamic_grid_snapshot');
const {
    normalizeNativeMarketHistoryCandles,
} = require('./utils/native_history');
const {
    formatLogPercent,
    buildWeightSummary,
    buildDynamicWeightInputsLog,
    buildDynamicWeightTuningLog,
    buildAsymmetricBoundsLog,
    buildStartupDefaultsLog,
} = require('./log_format');

const { PATHS, getRecalculateTriggerFile } = require('../modules/paths');
const ROOT = PATHS.PROJECT_ROOT;
const PROFILES_DIR = PATHS.PROFILES_DIR;
const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const DATA_DIR = PATHS.MARKET_ADAPTER.DATA_DIR;
const STATE_DIR = PATHS.MARKET_ADAPTER.STATE_DIR;
const STATE_FILE = PATHS.MARKET_ADAPTER.STATE_FILE;
const CENTER_FILE = PATHS.MARKET_ADAPTER.CENTERS_FILE;
const LOCK_FILE = PATHS.MARKET_ADAPTER.LOCK_FILE;
const MARKET_ADAPTER_SOURCE = typeof __filename !== 'undefined'
    ? path.relative(PATHS.PROJECT_ROOT, __filename).replace(/^dist[\\\/]/, '')
    : 'market_adapter.ts';
const MARKET_PROFILES_FILE = PATHS.PROFILES.MARKET_PROFILES_JSON;
const MARKET_ADAPTER_SETTINGS_FILE = PATHS.PROFILES.MARKET_ADAPTER_SETTINGS_JSON;

const LP_OP_TYPE = NATIVE_CLIENT.OPERATIONS.LIQUIDITY_POOL;
const API_MAX_PAGE = API_LIMITS.LP_API_MAX_PAGE;
const RUNTIME_DEFAULTS = MARKET_ADAPTER.RUNTIME_DEFAULTS;

const DEFAULTS = {
    pollSeconds: RUNTIME_DEFAULTS.pollSeconds,
    deltaThresholdPercent: MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT,
    amaSlopeDeltaThresholdPercent: undefined,
    absoluteThreshold: MARKET_ADAPTER.DYNAMIC_WEIGHT_ABSOLUTE_THRESHOLD_DEFAULT,
    intervalSeconds: RUNTIME_DEFAULTS.intervalSeconds,
    bootstrapLookbackHours: RUNTIME_DEFAULTS.bootstrapLookbackHours,
    nativeBackfillHours: RUNTIME_DEFAULTS.nativeBackfillHours,
    maxStaleHours: RUNTIME_DEFAULTS.maxStaleHours,
    sourceRetries: RUNTIME_DEFAULTS.sourceRetries,
    retryDelayMs: RUNTIME_DEFAULTS.retryDelayMs,
    kibanaRequestTimeoutMs: MARKET_ADAPTER.KIBANA_REQUEST_TIMEOUT_MS,
    metricsJson: false,
    quiet: false,
    dryRun: false,
    whitelistAll: false,
    maxPages: RUNTIME_DEFAULTS.maxPages,
    pageLimit: RUNTIME_DEFAULTS.pageLimit,
    once: false,
    maxNativeGapFillCandles: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    staleTailThreshold: MARKET_ADAPTER.STALE_TAIL_THRESHOLD_CANDLES,
    amaSlope: {
        lookbackBars:     MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        maxSlopePct:      MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_MAX_SLOPE_PCT,
        neutralZonePct:   MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_NEUTRAL_ZONE_PCT,
        deltaThresholdPct: MARKET_ADAPTER.AMA_SLOPE_DELTA_THRESHOLD_PERCENT,
    },
    kalmanSlope: {
        maxSlopePct: MARKET_ADAPTER.DYNAMIC_WEIGHT_KALMAN_MAX_SLOPE_PCT,
    },
    atrPeriod: MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT,
};

// Cycle-scoped caches — reset once per runOnce() so each cycle reads files fresh
// but all bots within that cycle share the same loaded data (N bots → 1 file read).
let _marketAdapterSettingsCache: any = null;

function _resetCycleCache() {
    _marketAdapterSettingsCache = null;
    resetMarketAdapterWhitelistCache();
}

function loadMarketAdapterSettings() {
    if (_marketAdapterSettingsCache !== null) return _marketAdapterSettingsCache;
    if (!storage.exists(MARKET_ADAPTER_SETTINGS_FILE)) return null;
    try {
        _marketAdapterSettingsCache = readJSON(MARKET_ADAPTER_SETTINGS_FILE);
        return _marketAdapterSettingsCache;
    } catch (_: any) {
        console.warn(`[WARN] Failed to parse ${MARKET_ADAPTER_SETTINGS_FILE}: ${_.message}. Using defaults.`);
        _marketAdapterSettingsCache = false;
        return null;
    }
}

function findPairForBot(bot, pairs) {
    if (!Array.isArray(pairs)) return null;
    const botAId = String(bot.assetAId || '');
    const botBId = String(bot.assetBId || '');
    const botA = normalizeAssetSymbol(bot.assetA);
    const botB = normalizeAssetSymbol(bot.assetB);
    let fallbackMatch = null;
    for (const p of pairs) {
        const parts = String(p.key || '').split('|');
        const pAId = parts[0];
        const pBId = parts[1];
        const pA = normalizeAssetSymbol(p.assetASymbol);
        const pB = normalizeAssetSymbol(p.assetBSymbol);

        if (botAId && botBId && pAId && pBId) {
            if (isExactPairIds(botAId, botBId, pAId, pBId)) return p;
            if (!fallbackMatch && isSamePairIds(botAId, botBId, pAId, pBId)) {
                fallbackMatch = p;
                continue;
            }
        }

        if (botA && botB && pA && pB) {
            if (isExactPair(botA, botB, pA, pB)) return p;
            if (!fallbackMatch && isSamePair(botA, botB, pA, pB)) {
                fallbackMatch = p;
            }
        }
    }
    return fallbackMatch;
}

function assignPresent(target, source, keys) {
    for (const key of keys) {
        if (source?.[key] != null) target[key] = source[key];
    }
    return target;
}

function applyAmaSlopeOverrides(target, overrides) {
    if (!overrides || typeof overrides !== 'object') return target;
    target.amaSlope = { ...(target.amaSlope || {}) };
    const previousLookbackBars = target.amaSlope.lookbackBars;
    const explicitMode = normalizeAmaSlopePercentMode(
        overrides.amaSlopePercentMode
        ?? overrides.amaSlopeUnits
        ?? overrides.amaSlope?.percentMode
        ?? overrides.amaSlope?.units
    );
    if (explicitMode) target.amaSlopePercentMode = explicitMode;
    const mode = explicitMode || target.amaSlopePercentMode || AMA_SLOPE_PERCENT_MODE_PER_BAR;

    if (overrides.amaSlopeDeltaThresholdPercent != null) {
        target.amaSlopeDeltaThresholdPercent = convertSlopePercentToPerBar(
            overrides.amaSlopeDeltaThresholdPercent,
            overrides.amaSlope?.lookbackBars ?? previousLookbackBars,
            mode
        );
    }

    if (overrides.amaSlope && typeof overrides.amaSlope === 'object') {
        const {
            percentMode: _percentMode,
            units: _units,
            maxSlopePct,
            neutralZonePct,
            ...amaSlopeRest
        } = overrides.amaSlope;
        target.amaSlope = { ...target.amaSlope, ...amaSlopeRest };
        const lookbackBars = target.amaSlope.lookbackBars ?? previousLookbackBars;
        if (maxSlopePct != null) {
            target.amaSlope.maxSlopePct = convertSlopePercentToPerBar(maxSlopePct, lookbackBars, mode);
        }
        if (neutralZonePct != null) {
            target.amaSlope.neutralZonePct = convertSlopePercentToPerBar(neutralZonePct, lookbackBars, mode);
        }
    }
    return target;
}

function applyKalmanSlopeOverrides(target, overrides) {
    if (!overrides || typeof overrides !== 'object') return target;
    target.kalmanSlope = { ...(target.kalmanSlope || {}) };
    if (overrides.kalmanSlope && typeof overrides.kalmanSlope === 'object') {
        target.kalmanSlope = { ...target.kalmanSlope, ...overrides.kalmanSlope };
    }
    return target;
}

function applyMarketAdapterOverrides(target: any, overrides: any, opts: { includeDefaultAmaKey?: boolean } = {}) {
    if (!overrides || typeof overrides !== 'object') return target;
    if (opts.includeDefaultAmaKey && overrides.defaultAmaKey) target.defaultAmaKey = overrides.defaultAmaKey;
    assignPresent(target, overrides, [
        'deltaThresholdPercent',
        'pollSeconds',
        'bootstrapLookbackHours',
        'nativeBackfillHours',
        'maxStaleHours',
        'sourceRetries',
        'retryDelayMs',
        'kibanaRequestTimeoutMs',
        'maxSlopeOffset',
        'staleTailThreshold',
        'absoluteThreshold',
        'minOutputThreshold',
        'volatilityExponent',
        'volatilityScaleX',
        'clipPercentile',
        'regimeSensitivity',
        'hurstZoneBand',
        'alpha',
        'dw',
        'gain',
        'kalmanSmoothPct',
        'kalmanDispScaleMult',
        'kalmanDispThresholdMult',
        'kalmanSmoothSpanPct',
        'signalConfirmBars',
        'dispScaleMinPct',
        'asymmetricBounds',
    ]);
    if (overrides.maxVolatilityOffset != null) {
        target.maxVolatilityOffset = normalizeMaxVolatilityOffset(overrides.maxVolatilityOffset);
    }
    if (overrides.atrPeriod != null) target.atrPeriod = normalizeAtrPeriod(overrides.atrPeriod);
    if (overrides.volatilityThreshold != null) {
        target.volatilityThreshold = normalizeVolatilityThreshold(overrides.volatilityThreshold);
    }
    if (overrides.peNodes) target.peNodes = overrides.peNodes;
    if (overrides.regimeTable) target.regimeTable = overrides.regimeTable;
    if (overrides.kalman) target.kalman = overrides.kalman;
    applyKalmanSlopeOverrides(target, overrides);
    applyAmaSlopeOverrides(target, overrides);
    return target;
}

function resolveBotCfg(bot, globalCfg) {
    const settings = loadMarketAdapterSettings();
    if (!settings) return globalCfg;

    let merged = {
        ...globalCfg,
        amaSlope: { ...(globalCfg.amaSlope || {}) },
        kalmanSlope: { ...(globalCfg.kalmanSlope || {}) },
        kalman: globalCfg.kalman && typeof globalCfg.kalman === 'object'
            ? { ...globalCfg.kalman }
            : globalCfg.kalman,
    };

    applyMarketAdapterOverrides(merged, settings.globals || {});

    // Pair-level overrides
    const pair = findPairForBot(bot, settings.pairs);
    if (pair?.marketAdapterSettings) {
        applyMarketAdapterOverrides(merged, pair.marketAdapterSettings);
    }

    // Bot-level overrides
    const botOverride = pair?.botOverrides?.[bot.name];
    if (botOverride) {
        applyMarketAdapterOverrides(merged, botOverride, { includeDefaultAmaKey: true });
    }

    return merged;
}

const DEFAULT_AMA_KEY = String(MARKET_ADAPTER.DEFAULT_AMA_KEY).toUpperCase();
const BUILTIN_AMAS = MARKET_ADAPTER.AMAS;
const DEFAULT_AMA = BUILTIN_AMAS[DEFAULT_AMA_KEY] || BUILTIN_AMAS.AMA3 || { erPeriod: 781, fastPeriod: 5.2, slowPeriod: 112.7 };
const AMA_KEYWORDS = new Set(['ama', 'ama1', 'ama2', 'ama3', 'ama4']);
const AMA_PRESET_KEYS = ['AMA1', 'AMA2', 'AMA3', 'AMA4'];

function normalizeAmaPreset(raw) {
    const erPeriod = Number(raw?.erPeriod);
    const fastPeriod = Number(raw?.fastPeriod);
    const slowPeriod = Number(raw?.slowPeriod);
    if (!Number.isFinite(erPeriod) || !Number.isFinite(fastPeriod) || !Number.isFinite(slowPeriod)) return null;
    return { erPeriod, fastPeriod, slowPeriod };
}

function normalizeAmaKey(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!AMA_KEYWORDS.has(s)) return DEFAULT_AMA_KEY;
    if (s === 'ama') return DEFAULT_AMA_KEY;
    return s.toUpperCase();
}

function isAmaKeyword(raw) {
    const s = String(raw || '').trim().toLowerCase();
    return AMA_KEYWORDS.has(s);
}

function usesAmaGridPrice(bot) {
    return isAmaKeyword(bot?.gridPrice);
}

function usesOrderbookMarketSource(bot) {
    return resolveMarketSourceForBot(bot) === 'book';
}

function findAmaProfileForBot(bot, ctx = null) {
    const profiles = loadMarketProfiles()?.profiles || [];
    if (profiles.length === 0) return null;

    const botAssetA = normalizeAssetSymbol(bot?.assetA);
    const botAssetB = normalizeAssetSymbol(bot?.assetB);
    const ctxAssetAId = normalizeAssetSymbol(ctx?.assetA?.id);
    const ctxAssetBId = normalizeAssetSymbol(ctx?.assetB?.id);
    if (!botAssetA && !ctxAssetAId) return null;
    if (!botAssetB && !ctxAssetBId) return null;

    const matches = profiles.map((p) => {
        const pA = p?.assetA;
        const pB = p?.assetB;
        const pAId = p?.assetAId;
        const pBId = p?.assetBId;

        const exactBySymbol = botAssetA && botAssetB && pA && pB && isExactPair(botAssetA, botAssetB, pA, pB);
        const exactById = ctxAssetAId && ctxAssetBId && pAId && pBId
            && isExactPairIds(ctxAssetAId, ctxAssetBId, pAId, pBId);
        const symmetricBySymbol = botAssetA && botAssetB && pA && pB && isSamePair(botAssetA, botAssetB, pA, pB);
        const symmetricById = ctxAssetAId && ctxAssetBId && pAId && pBId
            && isSamePairIds(ctxAssetAId, ctxAssetBId, pAId, pBId);

        const matchRank = (exactById || exactBySymbol)
            ? 2
            : ((symmetricById || symmetricBySymbol) ? 1 : 0);
        return { profile: p, matchRank };
    }).filter((entry) => entry.matchRank > 0);
    if (matches.length === 0) return null;

    const exactMatches = matches.filter((entry) => entry.matchRank === 2);
    const matchedProfiles = (exactMatches.length > 0 ? exactMatches : matches)
        .map((entry) => entry.profile);

    const oneHour = matchedProfiles.filter((p) => Number(p?.intervalSeconds) === RUNTIME_DEFAULTS.intervalSeconds);
    const candidates = oneHour.length > 0 ? oneHour : matchedProfiles;
    return [...candidates].sort((a, b) => {
        const aTs = Date.parse(String(a?.updatedAt || 0)) || 0;
        const bTs = Date.parse(String(b?.updatedAt || 0)) || 0;
        return bTs - aTs;
    })[0] || null;
}

function getAmaPresetForKey(key, profile = null) {
    return normalizeAmaPreset(profile?.amas?.[key]) || normalizeAmaPreset(BUILTIN_AMAS[key]) || null;
}

function normalizeErSmoothPeriod(raw, fallback = 0) {
    const value = Number(raw);
    if (value === 0) return 0;
    if (Number.isFinite(value) && value >= 1) return value;

    const fallbackValue = Number(fallback);
    return Number.isFinite(fallbackValue) && fallbackValue >= 1 ? fallbackValue : 0;
}

function resolveErSmoothPeriodForBot(bot) {
    const raw = (bot && typeof bot.ama === 'object' && bot.ama !== null) ? bot.ama : {};
    const globalErSmoothPeriod = normalizeErSmoothPeriod(MARKET_ADAPTER.AMA_ER_SMOOTH_FAST_PERIOD, 0);
    if (Object.prototype.hasOwnProperty.call(raw, 'erSmoothPeriod')) {
        return normalizeErSmoothPeriod(raw.erSmoothPeriod, globalErSmoothPeriod);
    }
    return globalErSmoothPeriod;
}

function buildAmaComparisonPresets(bot, ctx = null) {
    const profile = findAmaProfileForBot(bot, ctx);
    const erSmoothPeriod = resolveErSmoothPeriodForBot(bot);
    return AMA_PRESET_KEYS
        .map((key) => {
            const preset = getAmaPresetForKey(key, profile);
            if (!preset) return null;
            return {
                name: key,
                erPeriod: preset.erPeriod,
                fastPeriod: preset.fastPeriod,
                slowPeriod: preset.slowPeriod,
                erSmoothPeriod,
            };
        })
        .filter(Boolean);
}

function getAmaFromProfilesForBot(bot, ctx = null, cfg = null) {
    const profile = findAmaProfileForBot(bot, ctx);
    if (!profile) return null;

    const rawGridPrice = String(bot?.gridPrice || '').trim().toLowerCase();
    const overrideDefaultAmaKey = cfg?.defaultAmaKey ? normalizeAmaKey(cfg.defaultAmaKey) : null;
    const requestedKey = rawGridPrice === 'ama'
        ? (overrideDefaultAmaKey || normalizeAmaKey(profile?.defaultAma))
        : (isAmaKeyword(rawGridPrice)
            ? normalizeAmaKey(rawGridPrice)
            : (overrideDefaultAmaKey || normalizeAmaKey(profile?.defaultAma)));
    const selected = normalizeAmaPreset(profile?.amas?.[requestedKey])
        || normalizeAmaPreset(profile?.amas?.[overrideDefaultAmaKey || DEFAULT_AMA_KEY])
        || getAmaPresetForKey(requestedKey)
        || getAmaPresetForKey(overrideDefaultAmaKey || DEFAULT_AMA_KEY);
    if (!selected) return null;

    return {
        enabled: true,
        erPeriod: selected.erPeriod,
        fastPeriod: selected.fastPeriod,
        slowPeriod: selected.slowPeriod,
    };
}

function sleepUntilAlignedBoundary(pollSeconds, referenceNowMs = Date.now(), nowMs = Date.now()) {
    const intervalMs = Math.max(1, Math.floor(Number(pollSeconds) || 0)) * 1000;
    const bufferMs = 1000;
    const targetBoundaryMs = Math.floor(Number(referenceNowMs) / intervalMs) * intervalMs + intervalMs;
    const delayMs = targetBoundaryMs - Number(nowMs) + bufferMs;
    return Math.max(bufferMs, delayMs);
}

function withRetries(fn, attempts, baseDelayMs, label) {
    return (async () => {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try {
                return await fn();
            } catch (err: any) {
                lastErr = err;
                if (i + 1 >= attempts) break;
                const waitMs = Math.max(0, baseDelayMs) * (i + 1);
                if (waitMs > 0) await sleep(waitMs);
            }
        }
        const msg = label ? `${label}: ${lastErr?.message || 'unknown error'}` : (lastErr?.message || 'unknown error');
        throw new Error(msg);
    })();
}

function parseArgs() {
    const args = process.argv.slice(2);
    const cfg = { ...DEFAULTS };
    const provided = {
        deltaThresholdPercent: false,
    };

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const v = args[i + 1];
        switch (a) {
            case '--once':
                cfg.once = true;
                break;
            case '--pollSeconds':
                cfg.pollSeconds = Number(v);
                i++;
                break;
            case '--deltaPercent':
                cfg.deltaThresholdPercent = Number(v);
                provided.deltaThresholdPercent = true;
                i++;
                break;
            case '--gridResetFactor':
                throw new Error('--gridResetFactor is no longer supported; use --deltaPercent <percent>');
            case '--bootstrapHours':
                cfg.bootstrapLookbackHours = Number(v);
                i++;
                break;
            case '--nativeBackfillHours':
                cfg.nativeBackfillHours = Number(v);
                i++;
                break;
            case '--maxStaleHours':
                cfg.maxStaleHours = Number(v);
                i++;
                break;
            case '--sourceRetries':
                cfg.sourceRetries = Number(v);
                i++;
                break;
            case '--retryDelayMs':
                cfg.retryDelayMs = Number(v);
                i++;
                break;
            case '--metricsJson':
                cfg.metricsJson = true;
                break;
            case '--quiet':
                cfg.quiet = true;
                break;
            case '--dryRun':
                cfg.dryRun = true;
                break;
            case '--whitelist-all':
                cfg.whitelistAll = true;
                break;
            case '--maxPages':
                cfg.maxPages = Number(v);
                i++;
                break;
            case '--pageLimit':
                cfg.pageLimit = Number(v);
                i++;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown argument: ${a}`);
        }
    }

    const merged = applyRuntimeDefaultsFromGeneralSettings(cfg, provided);
    return validateConfig(merged);
}

function validateConfig(input) {
    const cfg = { ...DEFAULTS, ...input };

    if (!Number.isFinite(cfg.pollSeconds) || cfg.pollSeconds <= 0) throw new Error('--pollSeconds must be > 0');
    if (!Number.isFinite(cfg.deltaThresholdPercent) || cfg.deltaThresholdPercent <= 0) {
        throw new Error('--deltaPercent must be > 0');
    }
    if (!Number.isFinite(cfg.bootstrapLookbackHours) || cfg.bootstrapLookbackHours <= 0) throw new Error('--bootstrapHours must be > 0');
    if (!Number.isFinite(cfg.nativeBackfillHours) || cfg.nativeBackfillHours <= 0) throw new Error('--nativeBackfillHours must be > 0');
    if (!Number.isFinite(cfg.maxStaleHours) || cfg.maxStaleHours <= 0) throw new Error('--maxStaleHours must be > 0');
    if (!Number.isFinite(cfg.sourceRetries) || cfg.sourceRetries < 1) throw new Error('--sourceRetries must be >= 1');
    if (!Number.isFinite(cfg.retryDelayMs) || cfg.retryDelayMs < 0) throw new Error('--retryDelayMs must be >= 0');
    if (!Number.isFinite(cfg.maxPages) || cfg.maxPages <= 0) throw new Error('--maxPages must be > 0');
    if (!Number.isFinite(cfg.pageLimit) || cfg.pageLimit <= 0) throw new Error('--pageLimit must be > 0');

    cfg.pageLimit = Math.min(API_MAX_PAGE, Math.floor(cfg.pageLimit));
    cfg.maxPages = Math.floor(cfg.maxPages);
    cfg.sourceRetries = Math.floor(cfg.sourceRetries);
    cfg.deltaThresholdPercent = Number(cfg.deltaThresholdPercent);
    cfg.metricsJson = !!cfg.metricsJson;
    cfg.quiet = !!cfg.quiet;
    cfg.dryRun = !!cfg.dryRun;
    return cfg;
}

function resolveDeltaThresholdPercentFromGeneralSettings(settings) {
    const explicit = Number(settings?.MARKET_ADAPTER?.AMA_DELTA_THRESHOLD_PERCENT);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return null;
}

function applyRuntimeDefaultsFromGeneralSettings(cfg: any, provided: { deltaThresholdPercent?: boolean } = {}, settingsOverride?: any) {
    const out = { ...cfg };
    if (!provided?.deltaThresholdPercent) {
        const settings = settingsOverride === undefined
            ? readGeneralSettings({ fallback: null })
            : settingsOverride;
        const fromSettings = resolveDeltaThresholdPercentFromGeneralSettings(settings);
        if (fromSettings != null) {
            out.deltaThresholdPercent = fromSettings;
        }
    }
    return out;
}

const { createPm2AwareLogger } = require('../modules/logger');
const { readJSON } = require('../modules/utils/fs_utils');
const { fixedTo, roundTo } = require('../modules/utils/math_utils');
const marketAdapterLogFile = path.join(PATHS.LOGS_DIR, 'market_adapter.log');
const logger = createPm2AwareLogger('MarketAdapter', { quiet: DEFAULTS.quiet, logFile: marketAdapterLogFile });

function log(cfg, ...args) {
    logger.quiet = !!cfg?.quiet;
    logger.info(...args);
}

function write(cfg, text) {
    logger.quiet = !!cfg?.quiet;
    logger.raw(text);
}

function printHelp() {
    logger.raw('Market adapter (standalone): Kibana bootstrap + native incremental updates\n');
    logger.raw('\n');
    logger.raw('Usage:\n');
    logger.raw(`  node ${MARKET_ADAPTER_SOURCE} [--once] [--pollSeconds ${RUNTIME_DEFAULTS.pollSeconds}]\n`);
    logger.raw('\n');
    logger.raw('Options:\n');
    logger.raw('  --once                 Run one cycle and exit\n');
    logger.raw(`  --pollSeconds <n>      Loop interval seconds (default ${RUNTIME_DEFAULTS.pollSeconds}, wall-clock aligned)\n`);
    logger.raw('  --deltaPercent <n>     Trigger threshold percent (default: general.settings MARKET_ADAPTER.AMA_DELTA_THRESHOLD_PERCENT or 2.5)\n');
    logger.raw(`  --bootstrapHours <n>   Kibana bootstrap lookback hours (default ${RUNTIME_DEFAULTS.bootstrapLookbackHours})\n`);
    logger.raw(`  --nativeBackfillHours  Native incremental lookback hours (default ${RUNTIME_DEFAULTS.nativeBackfillHours})\n`);
    logger.raw(`  --maxStaleHours <n>    Max accepted candle staleness before trigger suppression (default ${RUNTIME_DEFAULTS.maxStaleHours})\n`);
    logger.raw(`  --sourceRetries <n>    Retries for source fetch calls (default ${RUNTIME_DEFAULTS.sourceRetries})\n`);
    logger.raw(`  --retryDelayMs <n>     Base retry delay in milliseconds (default ${RUNTIME_DEFAULTS.retryDelayMs})\n`);
    logger.raw('  --metricsJson          Emit per-cycle metrics as one JSON line\n');
    logger.raw('  --quiet                Suppress per-bot logs (state still written)\n');
    logger.raw('  --dryRun               Enable dry run mode for non-whitelisted bots\n');
    logger.raw('  --whitelist-all        Disable dry run mode for all bots\n');
    logger.raw(`  --maxPages <n>         Max native history pages per cycle (default ${RUNTIME_DEFAULTS.maxPages})\n`);
    logger.raw(`  --pageLimit <n>        Native page size (max ${API_MAX_PAGE}, default ${RUNTIME_DEFAULTS.pageLimit})\n`);
}

function loadActiveBots() {
    if (!storage.exists(BOTS_FILE)) {
        throw new Error(`Bots file not found at ${BOTS_FILE}`);
    }
    const raw = parseJsonWithComments(storage.readFile(BOTS_FILE));
    const bots = Array.isArray(raw?.bots) ? raw.bots : (Array.isArray(raw) ? raw : []);
    return bots
        .map((b, i) => normalizeBotEntry(b, i))
        .filter((b) => b.active);
}

function loadJson(filePath, defaultValue) {
    try {
        if (!storage.exists(filePath)) return defaultValue;
        return readJSON(filePath);
    } catch (_: any) {
        return defaultValue;
    }
}

function saveJson(filePath, data) {
    writeJsonAtomic(filePath, data);
}

function parseChainTimeToMs(timeStr) {
    if (!timeStr) return Number.NaN;
    const s = String(timeStr);
    return Date.parse(s.endsWith('Z') ? s : `${s}Z`);
}

function candleFileForBot(botKey, intervalSeconds = RUNTIME_DEFAULTS.intervalSeconds) {
    const label = intervalSeconds === RUNTIME_DEFAULTS.intervalSeconds
        ? RUNTIME_DEFAULTS.intervalLabel
        : toIntervalLabel(intervalSeconds);
    return path.join(DATA_DIR, `market_adapter_${botKey}_${label}.json`);
}

function calculateBotThreshold(cfg) {
    const value = Number(cfg?.deltaThresholdPercent);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function computeCandleStaleness(lastCandleTs, maxStaleHours) {
    const staleAgeMs = Number.isFinite(lastCandleTs) ? (Date.now() - lastCandleTs) : Number.POSITIVE_INFINITY;
    const staleData = staleAgeMs > (maxStaleHours * 3600 * 1000);
    const staleAgeHours = Number.isFinite(staleAgeMs) ? (staleAgeMs / 3600000) : null;
    return { staleData, staleAgeHours };
}

function resolveAmaForBot(bot, ctx = null, cfg = null) {
    const raw = (bot && typeof bot.ama === 'object' && bot.ama !== null) ? bot.ama : {};
    const erSmoothPeriod = resolveErSmoothPeriodForBot(bot);

    const fromProfiles: any = getAmaFromProfilesForBot(bot, ctx, cfg);
    if (fromProfiles) {
        fromProfiles.erSmoothPeriod = erSmoothPeriod;
        return fromProfiles;
    }

    const amaCfg = {
        erPeriod: Number(raw.erPeriod),
        fastPeriod: Number(raw.fastPeriod),
        slowPeriod: Number(raw.slowPeriod),
        erSmoothPeriod,
        enabled: raw.enabled !== false,
    };

    if (!Number.isInteger(amaCfg.erPeriod) || amaCfg.erPeriod < 1) amaCfg.erPeriod = DEFAULT_AMA.erPeriod;
    if (!Number.isFinite(amaCfg.fastPeriod) || amaCfg.fastPeriod < 1) amaCfg.fastPeriod = DEFAULT_AMA.fastPeriod;
    if (!Number.isInteger(amaCfg.slowPeriod) || amaCfg.slowPeriod < 1) amaCfg.slowPeriod = DEFAULT_AMA.slowPeriod;
    if (amaCfg.fastPeriod > amaCfg.slowPeriod) {
        const t = amaCfg.fastPeriod;
        amaCfg.fastPeriod = amaCfg.slowPeriod;
        amaCfg.slowPeriod = t;
    }
    return amaCfg;
}

function pruneCandles(candles, keepCount) {
    if (!Array.isArray(candles)) return [];
    if (candles.length <= keepCount) return candles;
    return candles.slice(candles.length - keepCount);
}

function calcAmaComparison(candles, bot = null, ctx = null) {
    const closes = (candles || []).map((c) => Number(c?.[4])).filter((v) => Number.isFinite(v) && v > 0);
    const out = [];
    const presets = buildAmaComparisonPresets(bot, ctx);

    for (const p of presets) {
        const minNeeded = p.erPeriod + 1;
        if (closes.length < minNeeded) {
            out.push({ ...p, value: null, ok: false });
            continue;
        }
        const values = calculateAMA(closes, {
            erPeriod: p.erPeriod,
            fastPeriod: p.fastPeriod,
            slowPeriod: p.slowPeriod,
            erSmoothPeriod: p.erSmoothPeriod,
        });
        const value = values[values.length - 1];
        out.push({ ...p, value: Number.isFinite(value) ? value : null, ok: Number.isFinite(value) });
    }

    return out;
}

async function fetchNativeTradesSince(poolId, sinceMs, pageLimit, maxPages) {
    const { BitShares } = getBitsharesClient();
    const trades = [];
    const seenSequences = new Set();
    let pages = 0;
    let startSeq = null;
    let hitOld = false;

    while (pages < maxPages) {
        let page;
        if (startSeq == null) {
            page = await BitShares.history.get_liquidity_pool_history(poolId, null, null, pageLimit, LP_OP_TYPE);
        } else {
            page = await BitShares.history.get_liquidity_pool_history_by_sequence(poolId, startSeq, null, pageLimit, LP_OP_TYPE);
        }

        if (!Array.isArray(page) || page.length === 0) break;

        pages++;

        for (const row of page) {
            const seq = Number(row?.sequence);
            if (Number.isFinite(seq)) {
                if (seenSequences.has(seq)) continue;
                seenSequences.add(seq);
            }

            const tsMs = parseChainTimeToMs(row?.time || row?.op?.block_time);
            if (!Number.isFinite(tsMs)) continue;
            if (tsMs < sinceMs) {
                hitOld = true;
                break;
            }

            const trade = nativeHistoryRowToTrade(row);
            if (!trade) continue;
            trades.push(trade);
        }

        const last = page[page.length - 1];
        const lastSeq = Number(last?.sequence);
        if (!Number.isFinite(lastSeq) || lastSeq <= 1) break;
        if (hitOld) break;
        startSeq = lastSeq - 1;
    }

    return {
        trades,
        pages,
        truncated: pages >= maxPages && !hitOld,
    };
}

function nativeHistoryRowToTrade(row) {
    const tsMs = parseChainTimeToMs(row?.time || row?.op?.block_time);
    if (!Number.isFinite(tsMs)) return null;
    const opPayload = Array.isArray(row?.op?.op) ? row.op.op[1] : null;
    const resultPayload = Array.isArray(row?.op?.result) ? row.op.result[1] : null;
    const received = Array.isArray(resultPayload?.received)
        ? resultPayload.received[0]
        : (resultPayload?.received || null);

    if (!opPayload?.amount_to_sell || !received) return null;

    const sequence = Number(row?.sequence);
    return {
        tsMs,
        sequence: Number.isFinite(sequence) ? sequence : null,
        sell: opPayload.amount_to_sell,
        received,
    };
}

async function fetchNativeTradesUntilOverlap(poolId, overlapSequences, minOverlap, pageLimit, maxPages) {
    const { BitShares } = getBitsharesClient();
    const overlapSet = new Set((Array.isArray(overlapSequences) ? overlapSequences : [])
        .map((v) => String(v))
        .filter((v) => v !== ''));
    const trades = [];
    const seenSequences = new Set();
    let pages = 0;
    let startSeq = null;
    let overlapCount = 0;

    if (overlapSet.size === 0) {
        throw new Error('fetchNativeTradesUntilOverlap requires at least one overlap sequence');
    }

    while (pages < maxPages) {
        const page = startSeq == null
            ? await BitShares.history.get_liquidity_pool_history(poolId, null, null, pageLimit, LP_OP_TYPE)
            : await BitShares.history.get_liquidity_pool_history_by_sequence(poolId, startSeq, null, pageLimit, LP_OP_TYPE);

        if (!Array.isArray(page) || page.length === 0) break;
        pages++;

        for (const row of page) {
            const seq = Number(row?.sequence);
            const seqKey = Number.isFinite(seq) ? String(seq) : null;
            if (seqKey) {
                if (seenSequences.has(seqKey)) continue;
                seenSequences.add(seqKey);
            }

            const trade = nativeHistoryRowToTrade(row);
            if (!trade) continue;
            trades.push(trade);

            if (seqKey && overlapSet.has(seqKey)) {
                overlapCount++;
                if (overlapCount >= minOverlap) {
                    return {
                        trades,
                        pages,
                        overlapCount,
                        reachedOverlap: true,
                    };
                }
            }
        }

        const last = page[page.length - 1];
        const lastSeq = Number(last?.sequence);
        if (!Number.isFinite(lastSeq) || lastSeq <= 1) break;
        startSeq = lastSeq - 1;
    }

    return {
        trades,
        pages,
        overlapCount,
        reachedOverlap: false,
    };
}

async function fetchNativeMarketHistorySince(assetA: any, assetB: any, sinceMs: any, untilMs: any, intervalSeconds: any, options: { fillCandleGaps?: Function } = {}) {
    const { BitShares } = getBitsharesClient();
    if (!BitShares) {
        throw new Error('BitShares client unavailable');
    }

    const startDate = new Date(Number.isFinite(sinceMs) ? sinceMs : Date.now());
    const stopDate = new Date(Number.isFinite(untilMs) ? untilMs : Date.now());
    let history = null;

    if (typeof BitShares.history?.getMarketHistory === 'function') {
        history = await BitShares.history.getMarketHistory(
            assetB.id,
            assetA.id,
            intervalSeconds,
            startDate.toISOString().slice(0, -5),
            stopDate.toISOString().slice(0, -5)
        );
    } else if (typeof BitShares.tradeHistory === 'function') {
        history = await BitShares.tradeHistory(
            assetB.symbol || assetB.id,
            assetA.symbol || assetA.id,
            startDate,
            stopDate,
            intervalSeconds
        );
    } else {
        throw new Error('native market history source unavailable');
    }

    let candles = normalizeNativeMarketHistoryCandles(history, assetA, assetB, intervalSeconds);
    if (candles.length > 0 && typeof options.fillCandleGaps === 'function') {
        candles = options.fillCandleGaps(candles, intervalSeconds);
    }
    return candles;
}

function writeGridResetTrigger(bot, payload) {
    const triggerPath = getRecalculateTriggerFile(bot.botKey);
    const content = {
        createdAt: new Date().toISOString(),
        source: MARKET_ADAPTER_SOURCE,
        botName: bot.name,
        botKey: bot.botKey,
        ...payload,
    };
    writeJsonAtomic(triggerPath, content);
    return triggerPath;
}

const ORDERS_DIR = PATHS.ORDERS_DIR;

/**
 * Atomically write the dynamic grid snapshot for a bot to profiles/orders/<botKey>.dynamicgrid.json.
 * Contains AMA-derived center price and any computed effective weight offsets.
 * The bot reads this snapshot before every rebalance (fills, spread checks, divergence
 * corrections, etc.) — not only on grid reset — so fresh weights are applied to new orders.
 * Uses write-then-rename to prevent partial reads by the dexbot process.
 * @param {string} botKey      - Bot key (e.g. "iob-xrp-bts-0")
 * @param {number} gridCenterPrice - Current persisted grid center price (B/A format)
 * @param {Object} [options]
 * @param {number} [options.amaCenterPrice]   - Raw AMA center price before any downstream handling
 * @param {Object} [options.amaSlope]         - Raw AMA slope snapshot used for grid-scaling diagnostics
 * @param {Object} [options.gridRangeScalingAmaSlope] - Accepted slope baseline used for future slope-trigger comparisons
 * @param {number} [options.amaSlopeDeltaPercent] - Absolute slope delta percentage since the last accepted snapshot
 * @param {number} [options.amaSlopeThresholdPercent] - Trigger threshold used for slope-based recalc decisions
 * @param {number} [options.gridPriceOffsetPct] - Signed grid-center offset percentage derived from AMA slope
 * @param {Object} [options.dynamicWeights]   - Computed weight offsets for live order sizing
 * @param {string} [options.observedLastGridResetAt] - Reset timestamp seen before this adapter write was calculated
 * @returns {boolean} true on success
 */
function writeBotDynamicGrid(botKey: string, gridCenterPrice: number, options: {
    amaCenterPrice?: number;
    amaSlope?: any;
    gridRangeScalingAmaSlope?: any;
    amaSlopeDeltaPercent?: number;
    amaSlopeThresholdPercent?: number;
    gridPriceOffsetPct?: number;
    dynamicWeights?: any;
    observedLastGridResetAt?: string;
} = {}) {
    try {
        const filePath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
        const preserveGridResetMetadata = (target, snapshot) => {
            if (!snapshot?.lastGridResetAt) return target;
            const incomingResetMs = Date.parse(String(snapshot.lastGridResetAt));
            const currentResetMs = Date.parse(String(target.lastGridResetAt || ''));
            const observedResetMs = Date.parse(String(options.observedLastGridResetAt || ''));
            if (Number.isFinite(currentResetMs) && Number.isFinite(incomingResetMs) && currentResetMs > incomingResetMs) {
                return target;
            }
            target.lastGridResetAt = snapshot.lastGridResetAt;
            if (snapshot.lastGridResetSource) {
                target.lastGridResetSource = snapshot.lastGridResetSource;
            }
            const hasObservedResetMarker = Object.prototype.hasOwnProperty.call(options, 'observedLastGridResetAt');
            const snapshotResetIsNewerThanObserved = Number.isFinite(incomingResetMs)
                && hasObservedResetMarker
                && (!Number.isFinite(observedResetMs) || incomingResetMs > observedResetMs);
            if (snapshotResetIsNewerThanObserved) {
                const resetGridCenterPrice = Number(snapshot.gridCenterPrice ?? snapshot.centerPrice);
                if (Number.isFinite(resetGridCenterPrice) && resetGridCenterPrice > 0) {
                    target.gridCenterPrice = resetGridCenterPrice;
                    target.centerPrice = resetGridCenterPrice;
                }
            }
            return target;
        };
        const result = updateDynamicGridSnapshotSync(filePath, (previousSnapshot) => {
            const amaCenterPrice = Number(options.amaCenterPrice);
            const resolvedGridCenterPrice = Number.isFinite(Number(gridCenterPrice))
                ? roundTo(Number(gridCenterPrice), 1e8)
                : null;
            const payload: Record<string, any> = {
                gridCenterPrice: resolvedGridCenterPrice,
                centerPrice: resolvedGridCenterPrice,
                amaCenterPrice: Number.isFinite(amaCenterPrice) && amaCenterPrice > 0 ? amaCenterPrice : resolvedGridCenterPrice,
                amaSlopePercentMode: AMA_SLOPE_PERCENT_MODE_PER_BAR,
                updatedAt: new Date().toISOString(),
                source: MARKET_ADAPTER_SOURCE,
            };
            if (options.amaSlope && typeof options.amaSlope === 'object') {
                payload.amaSlope = options.amaSlope;
            }
            if (options.gridRangeScalingAmaSlope && typeof options.gridRangeScalingAmaSlope === 'object') {
                payload.gridRangeScalingAmaSlope = options.gridRangeScalingAmaSlope;
            }
            if (Number.isFinite(Number(options.gridPriceOffsetPct))) {
                payload.gridPriceOffsetPct = Number(options.gridPriceOffsetPct);
            }
            if (Number.isFinite(Number(options.amaSlopeDeltaPercent))) {
                payload.amaSlopeDeltaPercent = Number(options.amaSlopeDeltaPercent);
            }
            if (Number.isFinite(Number(options.amaSlopeThresholdPercent))) {
                payload.amaSlopeThresholdPercent = Number(options.amaSlopeThresholdPercent);
            }
            preserveGridResetMetadata(payload, previousSnapshot);
            if (options.dynamicWeights && typeof options.dynamicWeights === 'object') {
                payload.dynamicWeights = options.dynamicWeights;
            }
            return payload;
        });
        return result.ok && result.written;
    } catch (err: any) {
        logger.warn(`[writeBotDynamicGrid] Failed to write dynamic grid for ${botKey}: ${err.message}`);
        return false;
    }
}

const {
    MarketAdapterService,
    AMA_SLOPE_PERCENT_MODE_PER_BAR,

    normalizeAmaSlopePercentMode,
    normalizeAmaSlopeLookbackBars,
    convertSlopePercentToPerBar,
} = require("./core/market_adapter_service");
const adapterService = new MarketAdapterService({
    resolveBotContext,
    resolveAmaForBot,
    candleFileForBot,
    loadJson,
    saveJson,
    calculateBotThreshold,
    computeCandleStaleness,
    withRetries,
    kibanaSource,
    kibanaMarketSource,
    fetchNativeMarketHistorySince,
    fetchNativeTradesSince,
    fetchNativeTradesUntilOverlap,
    tradesToCandles,
    detectMissingCandleTimestamps,
    fillCandleGaps,
    detectStaleTail,
    pruneStaleTail,
    mergeCandles,
    pruneCandles,
    calcAmaComparison,
    writeGridResetTrigger,
    writeBotDynamicGrid,
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
    isBotGridRangeScalingWhitelisted,
    logger,
    root: ROOT,
    path,
});

async function processBot(bot, state, cfg, contextCache, hooks = {}) {
    return adapterService.processBot(bot, state, cfg, contextCache, hooks);
}

function writeCenterSnapshot(state: any) {
    const centers: Record<string, any> = {
        updatedAt: new Date().toISOString(),
        bots: {},
    };
    const bots: Record<string, any> = state?.bots || {};
    for (const [botKey, v] of Object.entries(bots)) {
        const gridCenterPrice = v.gridCenterPrice ?? v.centerPrice;
        centers.bots[botKey] = {
            botName: v.botName,
            gridCenterPrice,
            centerPrice: gridCenterPrice,
            amaCenterPrice: v.amaCenterPrice,
            lastGridResetAt: v.lastGridResetAt,
            lastGridResetSource: v.lastGridResetSource,
            lastAmaPrice: v.lastAmaPrice,
            lastDeltaPercent: v.lastDeltaPercent,
            amaSlopeDeltaPercent: v.amaSlopeDeltaPercent,
            amaSlopeThresholdPercent: v.amaSlopeThresholdPercent,
            amaSlopePercentMode: v.amaSlopePercentMode || AMA_SLOPE_PERCENT_MODE_PER_BAR,
            gridRangeScalingAmaSlope: v.gridRangeScalingAmaSlope,
            weights: v.weights,
            effectiveWeights: v.effectiveWeights,
            collateralRecommendation: v.collateralRecommendation ?? null,
            amaSlope: v.amaSlope,
            atr: v.atr
        };
    }
    saveJson(CENTER_FILE, centers);
}

function mergeGridResetMetadataFromDynamicGrid(state: any) {
    if (!state || typeof state !== 'object' || !state.bots || typeof state.bots !== 'object') {
        return state;
    }

    const bots: Record<string, any> = state.bots;
    for (const [botKey, botState] of Object.entries(bots)) {
        if (!botState || typeof botState !== 'object') continue;
        const snapshotPath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
        let snapshot;
        try {
            snapshot = readJSON(snapshotPath);
        } catch (_: any) {
            continue;
        }

        if (!snapshot?.lastGridResetAt) continue;
        const snapshotResetMs = Date.parse(String(snapshot.lastGridResetAt));
        const stateResetMs = Date.parse(String(botState.lastGridResetAt || ''));
        if (Number.isFinite(stateResetMs) && Number.isFinite(snapshotResetMs) && stateResetMs > snapshotResetMs) {
            continue;
        }

        botState.lastGridResetAt = snapshot.lastGridResetAt;
        if (snapshot.lastGridResetSource) {
            botState.lastGridResetSource = snapshot.lastGridResetSource;
        }

        const gridCenterPrice = Number(snapshot.gridCenterPrice ?? snapshot.centerPrice);
        if (Number.isFinite(gridCenterPrice) && gridCenterPrice > 0) {
            botState.gridCenterPrice = gridCenterPrice;
            botState.centerPrice = gridCenterPrice;
        }
    }

    return state;
}

async function runOnce(cfg, state, contextCache) {
    _resetCycleCache(); // reload settings and cached file-backed config once per cycle
    const startedAtMs = Date.now();
    const allBots = loadActiveBots();
    const bots = allBots.filter((bot) => usesAmaGridPrice(bot));
    log(cfg, `Active bots: ${allBots.length} | AMA-grid bots: ${bots.length}`);

    const results = [];

    for (const bot of bots) {
        const isDryRun = cfg.dryRun || (!cfg.whitelistAll && !isBotWhitelisted(bot.botKey));
        write(cfg, `- ${bot.name} (${bot.botKey})${isDryRun ? ' [DRY RUN]' : ''}: `);
        try {
            const botCfg = resolveBotCfg(bot, cfg);
            const r = await processBot(bot, state, botCfg, contextCache, {
                onTrigger: cfg.onTrigger,
                isDryRun,
                forceWhitelistAll: cfg.whitelistAll,
            });
            if (!r.ok) {
                log(cfg, `skip (${r.reason})`);
                results.push({
                    botName: bot.name,
                    botKey: bot.botKey,
                    ok: false,
                    reason: r.reason,
                });
                continue;
            }

            const amaText = Number.isFinite(r.amaPrice) ? r.amaPrice.toFixed(8) : 'n/a';
            const prevCenterText = Number.isFinite(r.previousCenterPrice) ? r.previousCenterPrice.toFixed(8) : 'n/a';
            const deltaText = Number.isFinite(r.deltaPercent) ? `${r.deltaPercent.toFixed(3)}%` : 'n/a';
            const thresholdText = Number.isFinite(r.thresholdPercent) ? `${r.thresholdPercent.toFixed(3)}%` : 'n/a';
            const offText = r.weights?.meta?.finalOffset != null ? ` off=${r.weights.meta.finalOffset.toFixed(3)}` : '';
            const amaOffText = r.amaSlope?.amaSlopeGated != null ? ` (amaOff=${r.amaSlope.amaSlopeGated.toFixed(3)})` : '';
            const regimeText = r.amaSlope?.regimeMultiplier != null ? ` regime=${r.amaSlope.regimeMultiplier.toFixed(2)}` : '';

            const staleText = r.staleData ? ` STALE` : '';
            const patchText = Number.isFinite(r.kibanaGapRepairCount) && r.kibanaGapRepairCount > 0 ? ` KIBANA_PATCH(${r.kibanaGapRepairCount})` : '';
            const backfillText = Number.isFinite(r.kibanaBackfillCount) && r.kibanaBackfillCount > 0 ? ` BACKFILL(${r.kibanaBackfillCount})` : '';
            const gapText = Number.isFinite(r.unresolvedGapCount) && r.unresolvedGapCount > 0 ? ` GAPS(${r.unresolvedGapCount})` : '';
            const trigText = r.triggered ? ` TRIGGERED -> ${r.triggerPath ? path.relative(ROOT, r.triggerPath) : '[suppressed, dry-run]'}` : '';
            const pendingText = r.pendingClosedCandle ? ' WAITING_FOR_CLOSED_CANDLE' : '';
            const weightText = buildWeightSummary(r.weights);
            const trendText = r.amaSlope?.trend ? ` trend=${r.amaSlope.trend}` : '';
            const warmupText = r.triggerSuppressedReason === 'ama_warmup_insufficient'
                ? ` WARMUP_INSUFFICIENT(used=${r.analysisCandleCount}${Number.isFinite(r.analysisKeepCount) ? `/${r.analysisKeepCount}` : ''})`
                : '';
            const isOneHourResult = Number(r.intervalSeconds) === RUNTIME_DEFAULTS.intervalSeconds;
            const closedTsText = isOneHourResult && Number.isFinite(r.lastClosedCandleTs) ? ` closed=${new Date(r.lastClosedCandleTs).toISOString()}` : '';
            const rawTsText = isOneHourResult && Number.isFinite(r.rawLastCandleTs) ? ` rawLast=${new Date(r.rawLastCandleTs).toISOString()}` : '';
            const closeText = isOneHourResult && Number.isFinite(r.lastClosedCandleClose) ? ` close=${r.lastClosedCandleClose.toFixed(8)}` : '';
            const rawCountText = Number.isFinite(r.candleCount)
                ? ` raw=${r.candleCount}${Number.isFinite(r.rawKeepCount) ? `/${r.rawKeepCount}` : ''}`
                : '';
            const usedCountText = Number.isFinite(r.analysisCandleCount)
                ? ` used=${r.analysisCandleCount}${Number.isFinite(r.analysisKeepCount) ? `/${r.analysisKeepCount}` : ''}`
                : '';
            const nativeText = isOneHourResult && Number.isFinite(r.nativePagesFetched) ? ` nativePages=${r.nativePagesFetched}` : '';
            const dynText = isOneHourResult ? ` flags[whitelist=${r.dynamicWeightWhitelisted ? 'yes' : 'no'},base=${r.hasExplicitBaseWeights ? 'yes' : 'no'},ready=${r.dynamicWeightReady ? 'yes' : 'no'},applied=${r.dynamicWeightApplied ? 'yes' : 'no'}${r.dynamicWeightProfile ? `,profile=${r.dynamicWeightProfile}` : ''}${r.gridRangeScalingWhitelisted ? ',range=yes' : ''}]` : '';

            log(cfg, `${r.source},${rawCountText}${usedCountText}${closedTsText}${rawTsText}${closeText}, ama=${amaText} (prevCenter=${prevCenterText}, delta=${deltaText}), threshold=${thresholdText}${offText}${amaOffText}${regimeText}${staleText}${patchText}${backfillText}${gapText}${trigText}${pendingText}${warmupText}${trendText}${weightText}${dynText}${nativeText}`);
            if (r.triggerSuppressedReason === 'waiting_for_new_closed_candle') {
                log(cfg, '  No write pass: the latest 1h candle has not closed yet, so the adapter kept the snapshot unchanged.');
            }
            if (r.triggerSuppressedReason === 'ama_warmup_insufficient') {
                log(cfg, '  No write pass: AMA warmup history is still insufficient for a valid grid-centering write.');
            }
            if (r.triggerSuppressedReason === 'unresolved_candle_gaps') {
                log(cfg, '  No write pass: unresolved candle gaps remain, so the adapter kept the snapshot unchanged.');
            }
            if (r.triggerSuppressedReason === 'fixed_start_price') {
                log(cfg, '  No write pass: numeric startPrice disables market adapter fetch.');
            }
            if (Array.isArray(r.dryRunMessages)) {
                r.dryRunMessages.forEach(msg => log(cfg, `  ${msg}`));
            }
            if (isOneHourResult && r.weights?.meta) {
                const m = r.weights.meta;
                log(cfg, `  Inputs: ${buildDynamicWeightInputsLog(m, r.amaConfig)}`);
                log(cfg, `  Tuning: ${buildDynamicWeightTuningLog(m)}`);
                if (r.gridRangeScalingWhitelisted && m.slopeOffset && m.maxSlopeOffset && m.maxSlopeOffset > 0 && m.trend && m.trend !== 'NEUTRAL') {
                    log(cfg, `  Asymmetric bounds: ${buildAsymmetricBoundsLog(m)}`);
                }
            }
            if (Array.isArray(r.amaComparison) && r.amaComparison.length > 0) {
                const parts = r.amaComparison.map((a) => {
                    const val = Number.isFinite(a.value) ? a.value.toFixed(8) : 'n/a';
                    const erSmoothText = Number.isFinite(Number(a.erSmoothPeriod)) ? `/es${fixedTo(a.erSmoothPeriod, 0)}` : '';
                    return `${a.name}[${a.erPeriod}/${a.fastPeriod}/${a.slowPeriod}${erSmoothText}]=${val}`;
                });
                log(cfg, `  AMA compare: ${parts.join(' | ')}`);
            }
            results.push({
                botName: bot.name,
                botKey: bot.botKey,
                ...r,
            });
        } catch (err: any) {
            log(cfg, `error (${err.message})`);
            results.push({
                botName: bot.name,
                botKey: bot.botKey,
                ok: false,
                reason: err.message,
            });
        }
    }

    state.meta = {
        updatedAt: new Date().toISOString(),
        source: MARKET_ADAPTER_SOURCE,
        defaults: {
            ama: DEFAULT_AMA,
            intervalSeconds: cfg.intervalSeconds,
            deltaThresholdPercent: cfg.deltaThresholdPercent,
            deltaThresholdMode: 'fixed_percent',
        },
    };

    const metrics = {
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        totalActiveBots: allBots.length,
        processedBots: bots.length,
        successBots: results.filter((r) => r.ok).length,
        failedBots: results.filter((r) => !r.ok).length,
        triggeredBots: results.filter((r) => r.ok && r.triggered).length,
        staleBots: results.filter((r) => r.ok && r.staleData).length,
        kibanaPatchedBots: results.filter((r) => r.ok && Number(r.kibanaGapRepairCount) > 0).length,
        kibanaPatchedCandles: results.reduce((sum, r) => sum + (r.ok && Number.isFinite(r.kibanaGapRepairCount) ? r.kibanaGapRepairCount : 0), 0),
        kibanaBackfilledBots: results.filter((r) => r.ok && Number(r.kibanaBackfillCount) > 0).length,
        kibanaBackfilledCandles: results.reduce((sum, r) => sum + (r.ok && Number.isFinite(r.kibanaBackfillCount) ? r.kibanaBackfillCount : 0), 0),
        unresolvedGapBots: results.filter((r) => r.ok && Number(r.unresolvedGapCount) > 0).length,
        unresolvedGapCandles: results.reduce((sum, r) => sum + (r.ok && Number.isFinite(r.unresolvedGapCount) ? r.unresolvedGapCount : 0), 0),
    };
    state.meta.metrics = metrics;

    mergeGridResetMetadataFromDynamicGrid(state);
    saveJson(STATE_FILE, state);
    writeCenterSnapshot(state);
    if (cfg.metricsJson) {
        log(cfg, `METRICS ${JSON.stringify(metrics)}`);
    }
    return { results, metrics };
}

async function runOnceForAma(overrides = {}) {
    const provided = {
        deltaThresholdPercent: Object.prototype.hasOwnProperty.call(overrides, 'deltaThresholdPercent'),
    };
    const cfg = validateConfig({
        ...applyRuntimeDefaultsFromGeneralSettings({
            ...DEFAULTS,
            quiet: true,
        }, provided),
        ...overrides,
        once: true,
    });

    ensureDir(DATA_DIR);
    ensureDir(STATE_DIR);

    const lock = acquireFileLockSync(LOCK_FILE, {
        staleMs: Math.max(2, cfg.pollSeconds) * 1000 * 2,
    });
    try {
        const { connectClient, disconnectClient } = getBitsharesClient();
        await connectClient();
        const state = loadJson(STATE_FILE, { meta: {}, bots: {} });
        const contextCache = new Map();
        const run = await runOnce(cfg, state, contextCache);

        return {
            updatedAt: state?.meta?.updatedAt || new Date().toISOString(),
            ...run,
            state,
        };
    } finally {
        const { disconnectClient } = getBitsharesClient();
        disconnectClient();
        releaseFileLockSync(lock);
    }
}

async function main() {
    const cfg = parseArgs();
    logger.quiet = cfg.quiet;

    ensureDir(DATA_DIR);
    ensureDir(STATE_DIR);

    const lock = acquireFileLockSync(LOCK_FILE, {
        staleMs: Math.max(2, cfg.pollSeconds) * 1000 * 2,
    });

    try {
        log(cfg, '═══════════════════════════════════════');
        log(cfg, ' Market Adapter Hub Settings:');
        log(cfg, `  runtime : poll=${cfg.pollSeconds}s | bootstrap=${cfg.bootstrapLookbackHours}h | native=${cfg.nativeBackfillHours}h | stale=${cfg.maxStaleHours}h`);
        log(cfg, `  fetch   : retries=${cfg.sourceRetries}x${cfg.retryDelayMs}ms | pages=${cfg.maxPages}x${cfg.pageLimit} | delta=${formatLogPercent(cfg.deltaThresholdPercent, 3)} | dryRun=${cfg.dryRun ? 'yes' : 'no'} | quiet=${cfg.quiet ? 'yes' : 'no'} | metrics=${cfg.metricsJson ? 'yes' : 'no'}`);
        log(cfg, buildStartupDefaultsLog(DEFAULT_AMA, DEFAULT_CONFIG, MARKET_ADAPTER));
        log(cfg, '═══════════════════════════════════════');

        if (cfg.once && cfg.dryRun) {
            log(cfg, 'Dry run: config validation + lock acquisition OK (no network, no writes).');
            return 0;
        }

        {
            const maxRetries = 5;
            let lastErr = null;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const { connectClient } = getBitsharesClient();
                    await connectClient();
                    lastErr = null;
                    break;
                } catch (err) {
                    lastErr = err;
                    if (attempt < maxRetries) {
                        const delay = Math.min(1000 * Math.pow(2, attempt - 1), TIMING.RETRY_BACKOFF_CAP_MS);
                        logger.warn(`Connection attempt ${attempt}/${maxRetries} failed: ${err.message}; retrying in ${delay}ms`);
                        await sleep(delay);
                    }
                }
            }
            if (lastErr) {
                logger.error(`Fatal: BitShares connection failed after ${maxRetries} attempts: ${lastErr.message}`);
                return 1;
            }
        }
        log(cfg, 'Connected to BitShares');

        const state = loadJson(STATE_FILE, { meta: {}, bots: {} });
        const contextCache = new Map();

        if (cfg.once) {
            const run = await runOnce(cfg, state, contextCache);
            const allProcessedFailed = run.metrics.processedBots > 0 && run.metrics.successBots === 0;
            return allProcessedFailed ? 1 : 0;
        }

        while (true) {
            const started = Date.now();
            log(cfg, `\n[cycle ${new Date(started).toISOString()}]`);
            
            // Connect for this cycle using the lightweight native read-only client.
            // Tear down after runOnce so the connection never sits idle.
            try {
                const { connectClient } = getBitsharesClient();
                await connectClient();
            } catch (err: any) {
                logger.error(`Connection failed before cycle: ${err.message}`);
                // Fall through and let runOnce attempt to handle its own retries/failures
            }

            await runOnce(cfg, state, contextCache);

            try {
                const { disconnectClient } = getBitsharesClient();
                disconnectClient();
            } catch (_: any) {}

            const sleepMs = sleepUntilAlignedBoundary(cfg.pollSeconds, started, Date.now());
            await sleep(sleepMs);
        }
    } finally {
        releaseFileLockSync(lock);
    }
}

if (require.main === module) {
    main()
        .then((exitCode) => process.exit(Number.isInteger(exitCode) ? exitCode : 0))
        .catch((err) => {
            logger.error(`Fatal: ${err.message}`);
            process.exit(1);
        });
}

export = {
    main,
    runOnceForAma,
    DEFAULT_AMA,
    DEFAULTS,
    calculateBotThreshold,
    calcAmaComparison,
    computeCandleStaleness,
    normalizeMarketSource,
    sleepUntilAlignedBoundary,
    resolveAmaForBot,
    resolveDeltaThresholdPercentFromGeneralSettings,
    applyRuntimeDefaultsFromGeneralSettings,
    resolveBotCfg,
    usesAmaGridPrice,
    usesOrderbookMarketSource,
    isBotWhitelisted,
    isBotDynamicWeightWhitelisted,
    isBotAsymmetricBoundsWhitelisted,
    isBotGridRangeScalingWhitelisted,
    _resetCycleCache,
    writeCenterSnapshot,
    writeBotDynamicGrid,
    writeGridResetTrigger,
    mergeGridResetMetadataFromDynamicGrid,
    normalizeNativeMarketHistoryCandles,
    fetchNativeMarketHistorySince,
    _setBitsharesClientForTests: setBitsharesClientForTests,
};
