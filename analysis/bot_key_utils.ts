
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../modules/paths.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import { MARKET_ADAPTER } from '../modules/constants.js';
import { loadMarketProfiles } from './tradingview/tradingview_uplot_chart_generator.js';
'use strict';


const DEFAULT_AMA_KEY = String(MARKET_ADAPTER.DEFAULT_AMA_KEY).toUpperCase();
const BUILTIN_AMAS = MARKET_ADAPTER.AMAS as Record<string, typeof MARKET_ADAPTER.AMAS.AMA1>;
const AMA_KEYWORDS = new Set(['ama', 'ama1', 'ama2', 'ama3', 'ama4']);

function loadBotSettings(filePath = PATHS.PROFILES.BOTS_JSON) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        return readJSON(filePath);
    } catch (_) {
        return null;
    }
}

function sanitizeKey(source: any) {
    if (!source) return 'bot';
    return String(source).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bot';
}

function computeBotKey(bot: any, index: number) {
    if (bot && bot.name) {
        return sanitizeKey(bot.name);
    }
    return `${sanitizeKey(bot?.name || `bot-${index}`)}-${index}`;
}

function resolveBotKey(botName: any, filePath = PATHS.PROFILES.BOTS_JSON) {
    if (!botName) return null;
    const settings = loadBotSettings(filePath);
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    const sanitized = sanitizeKey(botName);
    const entry = entries.find((b: any) => sanitizeKey(b.name) === sanitized);
    if (!entry) return null;
    return computeBotKey(entry, entries.indexOf(entry));
}

function candleFileForBot(botKey: string, intervalLabel: string, dataDir = PATHS.MARKET_ADAPTER.DATA_DIR) {
    return path.join(dataDir, `market_adapter_${botKey}_${intervalLabel}.json`);
}

function resolveCandleFile(botKey: string, intervalLabel: string, dataDir = PATHS.MARKET_ADAPTER.DATA_DIR, botsFile = PATHS.PROFILES.BOTS_JSON) {
    const directPath = candleFileForBot(botKey, intervalLabel, dataDir);
    if (fs.existsSync(directPath)) return directPath;
    const resolved = resolveBotKey(botKey, botsFile);
    if (resolved) {
        const resolvedPath = candleFileForBot(resolved, intervalLabel, dataDir);
        if (fs.existsSync(resolvedPath)) return resolvedPath;
    }
    return null;
}

function loadBotMeta(botKey: any, filePath = PATHS.PROFILES.BOTS_JSON) {
    const settings = loadBotSettings(filePath);
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    if (!botKey) return null;
    const normalizedKey = String(botKey).toLowerCase();
    const exact = entries.find((bot: any, index: number) => computeBotKey(bot, index) === normalizedKey);
    if (exact) return exact;
    const loose = entries.find((bot: any) => sanitizeKey(bot?.name) === normalizedKey.replace(/-\d+$/, ''));
    return loose || null;
}

function resolveAmaConfig(botKey: any) {
    const botMeta = loadBotMeta(botKey);
    if (!botMeta) return { ...MARKET_ADAPTER.AMAS.AMA3, erSmoothPeriod: 0 };

    const rawGridPrice = String(botMeta?.gridPrice || '').trim().toLowerCase();
    const isAmaKeyword = AMA_KEYWORDS.has(rawGridPrice);

    // erSmoothPeriod: bot.ama inline > global default (matches production resolveErSmoothPeriodForBot)
    const botAmaInline = (botMeta?.ama && typeof botMeta.ama === 'object') ? botMeta.ama : null;
    const rawErSmooth = botAmaInline && Object.prototype.hasOwnProperty.call(botAmaInline, 'erSmoothPeriod')
        ? Number(botAmaInline.erSmoothPeriod)
        : Number(MARKET_ADAPTER.AMA_ER_SMOOTH_FAST_PERIOD);
    const erSmoothPeriod = rawErSmooth === 0 ? 0
        : (Number.isFinite(rawErSmooth) && rawErSmooth >= 1 ? rawErSmooth : 0);

    // Priority: inline bot.ama overrides market profile for analysis visibility.
    // Production inverts this (profiles first, inline as fallback — market_adapter.ts:694-730).
    if (botAmaInline) {
        const cfg: any = {
            erPeriod: Number(botAmaInline.erPeriod),
            fastPeriod: Number(botAmaInline.fastPeriod),
            slowPeriod: Number(botAmaInline.slowPeriod),
            erSmoothPeriod,
        };
        if (isAmaKeyword) {
            const key = rawGridPrice === 'ama' ? DEFAULT_AMA_KEY : rawGridPrice.toUpperCase();
            const preset = BUILTIN_AMAS[key];
            if (preset) {
                if (!Number.isFinite(cfg.erPeriod) || cfg.erPeriod < 1) cfg.erPeriod = preset.erPeriod;
                if (!Number.isFinite(cfg.fastPeriod) || cfg.fastPeriod < 1) cfg.fastPeriod = preset.fastPeriod;
                if (!Number.isFinite(cfg.slowPeriod) || cfg.slowPeriod < 1) cfg.slowPeriod = preset.slowPeriod;
            }
        }
        if (!Number.isFinite(cfg.erPeriod) || cfg.erPeriod < 1) cfg.erPeriod = MARKET_ADAPTER.AMAS.AMA3.erPeriod;
        if (!Number.isFinite(cfg.fastPeriod) || cfg.fastPeriod < 1) cfg.fastPeriod = MARKET_ADAPTER.AMAS.AMA3.fastPeriod;
        if (!Number.isFinite(cfg.slowPeriod) || cfg.slowPeriod < 1) cfg.slowPeriod = MARKET_ADAPTER.AMAS.AMA3.slowPeriod;
        if (cfg.fastPeriod > cfg.slowPeriod) {
            const t = cfg.fastPeriod; cfg.fastPeriod = cfg.slowPeriod; cfg.slowPeriod = t;
        }
        return cfg;
    }

    const marketProfiles = loadMarketProfiles();
    const selectedProfile = marketProfiles?.profiles
        ? marketProfiles.profiles.find((entry: any) =>
            String(entry.assetA) === String(botMeta.assetA) &&
            String(entry.assetB) === String(botMeta.assetB) &&
            Number(entry.intervalSeconds) === 3600)
        : null;

    if (selectedProfile?.amas) {
        const fallbackKey = selectedProfile.defaultAma || DEFAULT_AMA_KEY;
        const requestedKey = isAmaKeyword
            ? (rawGridPrice === 'ama' ? fallbackKey : rawGridPrice.toUpperCase())
            : fallbackKey;
        const fromProfile = selectedProfile.amas[requestedKey] || selectedProfile.amas[fallbackKey];
        const fromBuiltin = BUILTIN_AMAS[requestedKey] || BUILTIN_AMAS[fallbackKey];
        const base = fromProfile || fromBuiltin;
        if (base) {
            return { erPeriod: base.erPeriod, fastPeriod: base.fastPeriod, slowPeriod: base.slowPeriod, erSmoothPeriod };
        }
    }

    const key = isAmaKeyword
        ? (rawGridPrice === 'ama' ? DEFAULT_AMA_KEY : rawGridPrice.toUpperCase())
        : DEFAULT_AMA_KEY;
    const builtin = BUILTIN_AMAS[key] || MARKET_ADAPTER.AMAS.AMA3;
    return { erPeriod: builtin.erPeriod, fastPeriod: builtin.fastPeriod, slowPeriod: builtin.slowPeriod, erSmoothPeriod };
}

function resolveAmaKey(botKey: any) {
    const botMeta = loadBotMeta(botKey);
    if (!botMeta) return 'AMA3';
    const rawGridPrice = String(botMeta?.gridPrice || '').trim().toLowerCase();
    if (AMA_KEYWORDS.has(rawGridPrice)) {
        return rawGridPrice === 'ama' ? DEFAULT_AMA_KEY : rawGridPrice.toUpperCase();
    }
    return 'AMA3';
}

export { loadBotSettings, sanitizeKey, computeBotKey, resolveBotKey, candleFileForBot, resolveCandleFile, loadBotMeta, resolveAmaConfig, resolveAmaKey }

