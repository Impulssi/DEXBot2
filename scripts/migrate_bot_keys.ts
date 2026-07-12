'use strict';

/**
 * One-time migration: renames bot state files from the old botKey format
 * (which included a stable id suffix like "xrp-bts-a1b2c3d4") to the new
 * format (just the sanitized name, e.g. "xrp-bts").
 *
 * Run once after upgrading:  tsx scripts/migrate_bot_keys.ts
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('../modules/crypto/sync');
const { PATHS } = require('../modules/paths');
const { readJSON, writeJSON } = require('../modules/utils/fs_utils');

// --- helpers (duplicated from old code, needed to reconstruct old keys) ---

function sanitizeKey(source) {
    if (!source) return 'bot';
    return String(source)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'bot';
}

function _stableBotId(entry) {
    const stable = {
        name: entry.name || '',
        preferredAccount: entry.preferredAccount || '',
        assetA: entry.assetA || entry.assetAId || '',
        assetB: entry.assetB || entry.assetBId || '',
    };
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 8);
}

function oldCreateBotKey(bot, index) {
    const identifier = bot && bot.name
        ? bot.name
        : bot && bot.assetA && bot.assetB
            ? `${bot.assetA}/${bot.assetB}`
            : bot && bot.assetAId && bot.assetBId
                ? `${bot.assetAId}/${bot.assetBId}`
                : `bot-${index}`;
    const baseKey = sanitizeKey(identifier);
    if (bot && bot.id) {
        return `${baseKey}-${sanitizeKey(String(bot.id))}`;
    }
    return `${baseKey}-${index}`;
}

function newBotKey(bot) {
    if (bot && bot.name) {
        return sanitizeKey(bot.name);
    }
    return null; // unnamed — key unchanged
}

// --- migration ---

function migrateFile(oldPath, newPath, label) {
    if (!fs.existsSync(oldPath)) return false;
    if (fs.existsSync(newPath)) {
        console.log(`  SKIP ${label}: target exists at ${path.basename(newPath)}`);
        return false;
    }
    fs.renameSync(oldPath, newPath);
    console.log(`  OK   ${label}: ${path.basename(oldPath)} → ${path.basename(newPath)}`);
    return true;
}

function migrateJsonKeys(filePath, keyMap, description) {
    if (!fs.existsSync(filePath)) return;
    const raw = readJSON(filePath);
    if (!raw) return;
    const updated = rewriteKeys(raw, keyMap);
    if (updated !== raw) {
        writeJSON(filePath, updated);
        console.log(`  OK   ${description}: keys updated in ${path.basename(filePath)}`);
    }
}

function rewriteKeys(obj, keyMap) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        return obj.map((item) => rewriteKeys(item, keyMap));
    }
    const result = {};
    let changed = false;
    for (const [k, v] of Object.entries(obj)) {
        const nk = keyMap[k] || k;
        const nv = rewriteKeys(v, keyMap);
        if (nk !== k || nv !== v) changed = true;
        result[nk] = nv;
    }
    return changed ? result : obj;
}

function buildKeyMap(entries) {
    const map = {};
    for (const [index, entry] of entries.entries()) {
        if (!entry.name) continue;
        const newKey = newBotKey(entry);
        const oldCandidates = computeOldKeys(entry, index);
        for (const oldKey of oldCandidates) {
            if (oldKey !== newKey && !map[oldKey]) {
                map[oldKey] = newKey;
            }
        }
    }
    return map;
}

function computeOldKeys(botEntry, index) {
    const candidates = [];

    // If the entry has a persisted id, compute the id-based old key
    if (botEntry.id) {
        candidates.push(oldCreateBotKey(botEntry, index));
    }

    // Also compute the id ourselves (in case it was never persisted)
    const computedId = _stableBotId(botEntry);
    if (computedId) {
        const withComputedId = `${sanitizeKey(botEntry.name)}-${sanitizeKey(computedId)}`;
        if (!candidates.includes(withComputedId)) {
            candidates.push(withComputedId);
        }
    }

    // Index-based fallback
    const indexKey = `${sanitizeKey(botEntry.name)}-${index}`;
    if (!candidates.includes(indexKey)) {
        candidates.push(indexKey);
    }

    return candidates;
}

function migrateBot(botEntry, index) {
    const newKey = newBotKey(botEntry);
    if (!newKey) {
        console.log(`  SKIP bot[${index}] (unnamed) — key unchanged`);
        return;
    }

    const name = botEntry.name || `bot-${index}`;

    // Compute old keys (both patterns: with persisted id, and index-based fallback)
    const oldCandidates = computeOldKeys(botEntry, index);

    console.log(`\nBot "${name}":`);
    console.log(`  new key: ${newKey}`);
    console.log(`  old key candidates: ${oldCandidates.join(', ')}`);

    // File types to migrate
    const locations = [
        { dir: PATHS.ORDERS_DIR, pattern: (k) => `${k}.json`, label: 'order file' },
        { dir: PATHS.ORDERS_DIR, pattern: (k) => `${k}.dynamicgrid.json`, label: 'dynamic grid' },
        { dir: PATHS.PROFILES_DIR, pattern: (k) => `recalculate.${k}.trigger`, label: 'trigger' },
    ];

    // Migrate known file patterns
    for (const oldKey of oldCandidates) {
        if (oldKey === newKey) continue;
        for (const loc of locations) {
            const oldPath = path.join(loc.dir, loc.pattern(oldKey));
            const newPath = path.join(loc.dir, loc.pattern(newKey));
            migrateFile(oldPath, newPath, loc.label);
        }
    }

    // Migrate candle cache files: market_adapter/data/market_adapter_{oldKey}_*.json
    const dataDir = PATHS.MARKET_ADAPTER.DATA_DIR;
    if (fs.existsSync(dataDir)) {
        for (const oldKey of oldCandidates) {
            if (oldKey === newKey) continue;
            const prefix = `market_adapter_${oldKey}_`;
            const files = fs.readdirSync(dataDir)
                .filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
            for (const file of files) {
                const newFile = file.replace(prefix, `market_adapter_${newKey}_`);
                const oldPath = path.join(dataDir, file);
                const newPath = path.join(dataDir, newFile);
                migrateFile(oldPath, newPath, `candle file "${file}"`);
            }
        }
    }

    // Migrate log files: profiles/logs/{oldKey}.log, {oldKey}-error.log
    const logsDir = PATHS.LOGS_DIR;
    if (fs.existsSync(logsDir)) {
        for (const oldKey of oldCandidates) {
            if (oldKey === newKey) continue;
            for (const suffix of ['.log', '-error.log', '.log.gz', '-error.log.gz']) {
                const oldPath = path.join(logsDir, `${oldKey}${suffix}`);
                const newPath = path.join(logsDir, `${newKey}${suffix}`);
                migrateFile(oldPath, newPath, `log "${suffix}"`);
            }
        }
    }

    // Migrate credit runtime state: profiles/credit_runtime/{oldKey}.json
    const creditDir = PATHS.CREDIT_RUNTIME_DIR;
    if (fs.existsSync(creditDir)) {
        for (const oldKey of oldCandidates) {
            if (oldKey === newKey) continue;
            const oldPath = path.join(creditDir, `${oldKey}.json`);
            const newPath = path.join(creditDir, `${newKey}.json`);
            migrateFile(oldPath, newPath, 'credit state');
        }
    }
}

function main() {
    const botsFile = PATHS.PROFILES.BOTS_JSON;
    if (!fs.existsSync(botsFile)) {
        console.log('No bots.json found — nothing to migrate.');
        return;
    }

    const raw = readJSON(botsFile);
    const entries = Array.isArray(raw?.bots) ? raw.bots : [];
    if (entries.length === 0) {
        console.log('No bot entries found — nothing to migrate.');
        return;
    }

    console.log(`Found ${entries.length} bot entries in ${botsFile}\n`);

    let migratedAny = false;
    for (const [index, entry] of entries.entries()) {
        if (!entry.name) continue;
        migrateBot(entry, index);
        migratedAny = true;
    }

    // Migrate JSON-internal keys (whitelist, market adapter state)
    const keyMap = buildKeyMap(entries);
    if (Object.keys(keyMap).length > 0) {
        console.log('\nMigrating JSON keyed files...');
        migrateJsonKeys(
            PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON(),
            keyMap,
            'whitelist'
        );
        migrateJsonKeys(PATHS.MARKET_ADAPTER.STATE_FILE, keyMap, 'market adapter state (bots keys)');
        migrateJsonKeys(PATHS.MARKET_ADAPTER.CENTERS_FILE, keyMap, 'market adapter centers (bots keys)');
        migratedAny = true;
    }

    console.log('\n---');
    if (migratedAny) {
        console.log('Migration complete. If files were renamed, verify then restart your bots.');
    } else {
        console.log('No migrations needed.');
    }
}

main();
