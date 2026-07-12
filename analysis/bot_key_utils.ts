'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../modules/paths');
const { readJSON } = require('../modules/utils/fs_utils');

function loadBotSettings(filePath = PATHS.PROFILES.BOTS_JSON) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        return readJSON(filePath);
    } catch (_) {
        return null;
    }
}

function sanitizeKey(source) {
    if (!source) return 'bot';
    return String(source).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bot';
}

function computeBotKey(bot, index) {
    if (bot && bot.name) {
        return sanitizeKey(bot.name);
    }
    return `${sanitizeKey(bot?.name || `bot-${index}`)}-${index}`;
}

function resolveBotKey(botName, filePath = PATHS.PROFILES.BOTS_JSON) {
    if (!botName) return null;
    const settings = loadBotSettings(filePath);
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    const sanitized = sanitizeKey(botName);
    const entry = entries.find((b) => sanitizeKey(b.name) === sanitized);
    if (!entry) return null;
    return computeBotKey(entry, entries.indexOf(entry));
}

function candleFileForBot(botKey, intervalLabel, dataDir = PATHS.MARKET_ADAPTER.DATA_DIR) {
    return path.join(dataDir, `market_adapter_${botKey}_${intervalLabel}.json`);
}

function resolveCandleFile(botKey, intervalLabel, dataDir = PATHS.MARKET_ADAPTER.DATA_DIR, botsFile = PATHS.PROFILES.BOTS_JSON) {
    const directPath = candleFileForBot(botKey, intervalLabel, dataDir);
    if (fs.existsSync(directPath)) return directPath;
    const resolved = resolveBotKey(botKey, botsFile);
    if (resolved) {
        const resolvedPath = candleFileForBot(resolved, intervalLabel, dataDir);
        if (fs.existsSync(resolvedPath)) return resolvedPath;
    }
    return null;
}

export = {
    loadBotSettings,
    sanitizeKey,
    computeBotKey,
    resolveBotKey,
    candleFileForBot,
    resolveCandleFile,
};
