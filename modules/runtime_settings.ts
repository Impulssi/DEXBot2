import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { deepMerge } from './settings_merge.js';

import {
    GRID_LIMITS, FEE_PARAMETERS, INCREMENT_BOUNDS, TIMING,
    LOG_LEVEL, LOGGING_CONFIG, FILL_PROCESSING,
    PIPELINE_TIMING, API_LIMITS, COW_PERFORMANCE,
} from './constants.js';

function _toScreamingCase(key: string): string {
    return key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
}

function _normalizeKeys(obj: any): any {
    if (Array.isArray(obj) || obj === null || typeof obj !== 'object') return obj;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
        out[_toScreamingCase(k)] = _normalizeKeys(v);
    }
    return out;
}

function _deepMerge(target: any, source: any): any {
    return deepMerge(target, _normalizeKeys(source));
}

export interface BotRuntimeSettings {
    gridLimits: Record<string, any>;
    feeParams: Record<string, any>;
    incrementBounds: Record<string, any>;
    timing: Record<string, any>;
    fillProcessing: Record<string, any>;
    cowPerformance: Record<string, any>;
    pipelineTiming: Record<string, any>;
    apiLimits: Record<string, any>;
    logging: {
        level: string;
        config: Record<string, any>;
    };
}

export const RUNTIME_SETTINGS_KEYS: readonly string[] = [
    'gridLimits', 'feeParams', 'incrementBounds', 'timing',
    'fillProcessing', 'cowPerformance', 'pipelineTiming', 'apiLimits', 'logging',
];

export function resolveBotRuntimeSettings(botConfig: Record<string, any>): BotRuntimeSettings {
    const result: BotRuntimeSettings = {
        gridLimits: { ...GRID_LIMITS, GRID_COMPARISON: { ...GRID_LIMITS.GRID_COMPARISON } },
        feeParams: { ...FEE_PARAMETERS },
        incrementBounds: { ...INCREMENT_BOUNDS },
        timing: { ...TIMING },
        fillProcessing: { ...FILL_PROCESSING },
        cowPerformance: { ...COW_PERFORMANCE },
        pipelineTiming: { ...PIPELINE_TIMING },
        apiLimits: { ...API_LIMITS },
        logging: {
            level: LOG_LEVEL,
            config: JSON.parse(JSON.stringify(LOGGING_CONFIG)),
        },
    };

    const marketOverrides = _resolveMarketOverrides(botConfig);
    if (marketOverrides) {
        if (marketOverrides.gridLimits) result.gridLimits = _deepMerge(result.gridLimits, marketOverrides.gridLimits);
        if (marketOverrides.feeParams) result.feeParams = _deepMerge(result.feeParams, marketOverrides.feeParams);
        if (marketOverrides.incrementBounds) result.incrementBounds = _deepMerge(result.incrementBounds, marketOverrides.incrementBounds);
        if (marketOverrides.timing) result.timing = _deepMerge(result.timing, marketOverrides.timing);
        if (marketOverrides.fillProcessing) result.fillProcessing = _deepMerge(result.fillProcessing, marketOverrides.fillProcessing);
        if (marketOverrides.cowPerformance) result.cowPerformance = _deepMerge(result.cowPerformance, marketOverrides.cowPerformance);
        if (marketOverrides.pipelineTiming) result.pipelineTiming = _deepMerge(result.pipelineTiming, marketOverrides.pipelineTiming);
        if (marketOverrides.apiLimits) result.apiLimits = _deepMerge(result.apiLimits, marketOverrides.apiLimits);
        if (marketOverrides.poolSlippageTolerance !== undefined) result.feeParams.POOL_SLIPPAGE_TOLERANCE = marketOverrides.poolSlippageTolerance;
    }

    if (botConfig.gridLimits) result.gridLimits = _deepMerge(result.gridLimits, botConfig.gridLimits);
    if (botConfig.feeParams) result.feeParams = _deepMerge(result.feeParams, botConfig.feeParams);
    if (botConfig.incrementBounds) result.incrementBounds = _deepMerge(result.incrementBounds, botConfig.incrementBounds);
    if (botConfig.timing) result.timing = _deepMerge(result.timing, botConfig.timing);
    if (botConfig.fillProcessing) result.fillProcessing = _deepMerge(result.fillProcessing, botConfig.fillProcessing);
    if (botConfig.cowPerformance) result.cowPerformance = _deepMerge(result.cowPerformance, botConfig.cowPerformance);
    if (botConfig.pipelineTiming) result.pipelineTiming = _deepMerge(result.pipelineTiming, botConfig.pipelineTiming);
    if (botConfig.apiLimits) result.apiLimits = _deepMerge(result.apiLimits, botConfig.apiLimits);
    if (botConfig.logging) {
        if (botConfig.logging.level) result.logging.level = botConfig.logging.level;
        if (botConfig.logging.config) result.logging.config = _deepMerge(result.logging.config, botConfig.logging.config);
    }

    return result;
}

function _resolveMarketOverrides(botConfig: Record<string, any>): Record<string, any> | null {
    try {
        const marketAdapter = require('../market_adapter/market_adapter');
        const settings = (typeof marketAdapter.loadMarketAdapterSettings === 'function')
            ? marketAdapter.loadMarketAdapterSettings()
            : null;
        if (!settings) return null;

        const overrides: Record<string, any> = {};

        if (settings.globals) {
            if (settings.globals.runtimeGridLimits) overrides.gridLimits = { ...settings.globals.runtimeGridLimits };
            if (settings.globals.runtimeFeeParams) overrides.feeParams = { ...settings.globals.runtimeFeeParams };
            if (settings.globals.runtimeTiming) overrides.timing = { ...settings.globals.runtimeTiming };
            if (settings.globals.runtimeIncrementBounds) overrides.incrementBounds = { ...settings.globals.runtimeIncrementBounds };
            if (settings.globals.runtimeFillProcessing) overrides.fillProcessing = { ...settings.globals.runtimeFillProcessing };
            if (settings.globals.runtimeCowPerformance) overrides.cowPerformance = { ...settings.globals.runtimeCowPerformance };
            if (settings.globals.runtimePipelineTiming) overrides.pipelineTiming = { ...settings.globals.runtimePipelineTiming };
            if (settings.globals.runtimeApiLimits) overrides.apiLimits = { ...settings.globals.runtimeApiLimits };
            if (settings.globals.runtimePoolSlippageTolerance !== undefined) overrides.poolSlippageTolerance = settings.globals.runtimePoolSlippageTolerance;
        }

        if (Array.isArray(settings.pairs) && typeof marketAdapter.findPairForBot === 'function') {
            const pair = marketAdapter.findPairForBot(botConfig, settings.pairs);
            if (pair) {
                if (pair.marketGridLimits) overrides.gridLimits = _deepMerge(overrides.gridLimits || {}, pair.marketGridLimits);
                if (pair.marketFeeParams) overrides.feeParams = _deepMerge(overrides.feeParams || {}, pair.marketFeeParams);
                if (pair.marketTiming) overrides.timing = _deepMerge(overrides.timing || {}, pair.marketTiming);
                if (pair.marketIncrementBounds) overrides.incrementBounds = _deepMerge(overrides.incrementBounds || {}, pair.marketIncrementBounds);
                if (pair.marketFillProcessing) overrides.fillProcessing = _deepMerge(overrides.fillProcessing || {}, pair.marketFillProcessing);
                if (pair.marketCowPerformance) overrides.cowPerformance = _deepMerge(overrides.cowPerformance || {}, pair.marketCowPerformance);
                if (pair.marketPipelineTiming) overrides.pipelineTiming = _deepMerge(overrides.pipelineTiming || {}, pair.marketPipelineTiming);
                if (pair.marketApiLimits) overrides.apiLimits = _deepMerge(overrides.apiLimits || {}, pair.marketApiLimits);
                if (pair.marketPoolSlippageTolerance !== undefined) overrides.poolSlippageTolerance = pair.marketPoolSlippageTolerance;

                if (pair.botOverrides && pair.botOverrides[botConfig.name]) {
                    const bo = pair.botOverrides[botConfig.name];
                    if (bo.botGridLimits) overrides.gridLimits = _deepMerge(overrides.gridLimits || {}, bo.botGridLimits);
                    if (bo.botFeeParams) overrides.feeParams = _deepMerge(overrides.feeParams || {}, bo.botFeeParams);
                    if (bo.botTiming) overrides.timing = _deepMerge(overrides.timing || {}, bo.botTiming);
                    if (bo.botIncrementBounds) overrides.incrementBounds = _deepMerge(overrides.incrementBounds || {}, bo.botIncrementBounds);
                    if (bo.botFillProcessing) overrides.fillProcessing = _deepMerge(overrides.fillProcessing || {}, bo.botFillProcessing);
                    if (bo.botCowPerformance) overrides.cowPerformance = _deepMerge(overrides.cowPerformance || {}, bo.botCowPerformance);
                    if (bo.botPipelineTiming) overrides.pipelineTiming = _deepMerge(overrides.pipelineTiming || {}, bo.botPipelineTiming);
                    if (bo.botApiLimits) overrides.apiLimits = _deepMerge(overrides.apiLimits || {}, bo.botApiLimits);
                    if (bo.botPoolSlippageTolerance !== undefined) overrides.poolSlippageTolerance = bo.botPoolSlippageTolerance;
                }
            }
        }

        if (Object.keys(overrides).length === 0) return null;
        return overrides;
    } catch (_: any) {
        return null;
    }
}
