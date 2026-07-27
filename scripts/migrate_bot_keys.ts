
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from '../modules/crypto/sync';
import { PATHS } from '../modules/paths';
import { readJSON, writeJSON } from '../modules/utils/fs_utils';
'use strict';

/**
 * Migration: renames bot state files from the old botKey format
 * (which included a stable id suffix like "xrp-bts-a1b2c3d4") to the new
 * format (just the sanitized name, e.g. "xrp-bts").
 *
 * Auto-runs on every bot startup (dexbot.ts, bot.ts, unlock.ts).
 * Manual:  tsx scripts/migrate_bot_keys.ts
 */


// --- helpers (duplicated from old code, needed to reconstruct old keys) ---

function sanitizeKey(source: string | null | undefined): string {
    if (!source) return 'bot';
    return String(source)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'bot';
}

function _stableBotId(entry: Record<string, any>) {
    const stable = {
        name: entry.name || '',
        preferredAccount: entry.preferredAccount || '',
        assetA: entry.assetA || entry.assetAId || '',
        assetB: entry.assetB || entry.assetBId || '',
    };
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 8);
}

function oldCreateBotKey(bot: Record<string, any> | null | undefined, index: number): string {
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

function newBotKey(bot: Record<string, any> | null | undefined): string | null {
    if (bot && bot.name) {
        return sanitizeKey(bot.name);
    }
    return null; // unnamed — key unchanged
}

// --- migration ---

function migrateJsonKeys(filePath: string, keyMap: Record<string, string>, description: string, silent = false): boolean {
    if (!fs.existsSync(filePath)) return false;
    const raw = readJSON(filePath);
    if (!raw) return false;
    const updated = rewriteKeys(raw, keyMap);
    if (updated !== raw) {
        writeJSON(filePath, updated);
        if (!silent) console.log(`  OK   ${description}: keys updated in ${path.basename(filePath)}`);
        return true;
    }
    return false;
}

function rewriteKeys(obj: any, keyMap: Record<string, string>): any {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        return obj.map((item: any) => rewriteKeys(item, keyMap));
    }
    const result: Record<string, any> = {};
    let changed = false;
    for (const [k, v] of Object.entries(obj)) {
        const nk = keyMap[k] || k;
        const nv = rewriteKeys(v, keyMap);
        if (nk !== k || nv !== v) changed = true;
        result[nk] = nv;
    }
    return changed ? result : obj;
}

function buildKeyMap(entries: any[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [index, entry] of entries.entries()) {
        if (!entry.name) continue;
        const newKey = newBotKey(entry);
        const oldCandidates = computeOldKeys(entry, index);
        for (const oldKey of oldCandidates) {
            if (oldKey !== newKey && !map[oldKey]) {
                map[oldKey] = newKey!;
            }
        }
    }
    return map;
}

function computeOldKeys(botEntry: Record<string, any>, index: number): string[] {
    const candidates: string[] = [];

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



function runMigration(): string[] | null {
    const botsFile = PATHS.PROFILES.BOTS_JSON;
    if (!fs.existsSync(botsFile)) return null;

    const raw = readJSON(botsFile);
    const entries = Array.isArray(raw?.bots) ? raw.bots : [];
    if (entries.length === 0) return null;

    const migrated: string[] = [];
    const keyMap = buildKeyMap(entries);
    if (Object.keys(keyMap).length === 0) return null;

    for (const [index, entry] of entries.entries()) {
        if (!entry.name) continue;
        const newKey = newBotKey(entry);
        if (!newKey) continue;
        const oldCandidates = computeOldKeys(entry, index);
        let renamed = false;
        for (const oldKey of oldCandidates) {
            if (oldKey === newKey) continue;
            const locations: { dir: string; pattern: (k: string) => string; label: string }[] = [
                { dir: PATHS.ORDERS_DIR, pattern: (k: string) => `${k}.json`, label: 'order file' },
                { dir: PATHS.ORDERS_DIR, pattern: (k: string) => `${k}.dynamicgrid.json`, label: 'dynamic grid' },
                { dir: PATHS.PROFILES_DIR, pattern: (k: string) => `recalculate.${k}.trigger`, label: 'trigger' },
            ];
            for (const loc of locations) {
                const oldPath = path.join(loc.dir, loc.pattern(oldKey));
                const newPath = path.join(loc.dir, loc.pattern(newKey));
                if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
                    fs.renameSync(oldPath, newPath);
                    renamed = true;
                }
            }
            const dataDir = PATHS.MARKET_ADAPTER.DATA_DIR;
            if (fs.existsSync(dataDir)) {
                const prefix = `market_adapter_${oldKey}_`;
                const files = fs.readdirSync(dataDir).filter((f: string) => f.startsWith(prefix) && f.endsWith('.json'));
                for (const file of files) {
                    const newFile = file.replace(prefix, `market_adapter_${newKey}_`);
                    const oldPath = path.join(dataDir, file);
                    const newPath = path.join(dataDir, newFile);
                    if (!fs.existsSync(newPath)) {
                        fs.renameSync(oldPath, newPath);
                        renamed = true;
                    }
                }
            }
            const logsDir = PATHS.LOGS_DIR;
            if (fs.existsSync(logsDir)) {
                for (const suffix of ['.log', '-error.log', '.log.gz', '-error.log.gz']) {
                    const oldPath = path.join(logsDir, `${oldKey}${suffix}`);
                    const newPath = path.join(logsDir, `${newKey}${suffix}`);
                    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
                        fs.renameSync(oldPath, newPath);
                        renamed = true;
                    }
                }
            }
            const creditDir = PATHS.CREDIT_RUNTIME_DIR;
            if (fs.existsSync(creditDir)) {
                const oldPath = path.join(creditDir, `${oldKey}.json`);
                const newPath = path.join(creditDir, `${newKey}.json`);
                if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
                    fs.renameSync(oldPath, newPath);
                    renamed = true;
                }
            }
        }
        if (renamed) migrated.push(entry.name);
    }

    // Migrate JSON-internal keys (whitelist, market adapter state)
    let jsonMigrated = false;
    if (migrateJsonKeys(PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON(), keyMap, 'whitelist', true)) jsonMigrated = true;
    if (migrateJsonKeys(PATHS.MARKET_ADAPTER.STATE_FILE, keyMap, 'market adapter state (bots keys)', true)) jsonMigrated = true;
    if (migrateJsonKeys(PATHS.MARKET_ADAPTER.CENTERS_FILE, keyMap, 'market adapter centers (bots keys)', true)) jsonMigrated = true;

    if (jsonMigrated && migrated.length === 0) migrated.push('(json-keys)');
    return migrated.length > 0 ? migrated : null;
}

if (require.main === module) {
    const result = runMigration();
    if (result) {
        console.log(`Migrated files for bots: ${result.join(', ')}`);
        console.log('Migration complete. If files were renamed, verify then restart your bots.');
    } else {
        console.log('No migrations needed.');
    }
}

export { runMigration }

