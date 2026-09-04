'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../modules/paths.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON, writeJSON } = getStorage();
import { parseJsonWithComments } from '../modules/order/utils/system.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { loadMarketProfiles } from './tradingview/tradingview_uplot_chart_generator.js';
import { sanitizeKey } from '../modules/utils/sanitize_key.js';
// Single source of truth for bot keys (named AND unnamed bots) so analysis
// tools resolve the same files production writes.
import { createBotKey } from '../modules/account_orders.js';


const DEFAULT_AMA_KEY = String(MARKET_ADAPTER.DEFAULT_AMA_KEY).toUpperCase();
const BUILTIN_AMAS = MARKET_ADAPTER.AMAS as Record<string, typeof MARKET_ADAPTER.AMAS.AMA1>;
const AMA_KEYWORDS = new Set(['ama', 'ama1', 'ama2', 'ama3', 'ama4']);

function loadBotSettings(filePath = PATHS.PROFILES.BOTS_JSON) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        return readJSON(filePath);
    } catch (_) {
        // The bot editor reads/writes through a comment-tolerant parser, so
        // operator comments may legally exist — fall back before giving up.
        try {
            return parseJsonWithComments(fs.readFileSync(filePath, 'utf8'));
        } catch (_) {
            return null;
        }
    }
}

function computeBotKey(bot: any, index: number) {
    // Delegate to the production key generator (modules/account_orders.ts):
    // named bots → sanitized name; unnamed bots → sanitized asset pair + index.
    // The previous local fallback produced `bot-<idx>-<idx>` keys that could
    // never match what the bot runtime actually wrote to disk.
    return createBotKey(bot, index);
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

/**
 * Locate the source span of the entryIndex-th object literal inside the
 * top-level "bots" array of a (possibly comment-bearing) JSON document.
 * Strings and // + block comments are skipped while scanning, so braces
 * inside them never disturb the balance count. Returns null when the
 * document shape is unexpected — callers fall back to a full rewrite.
 */
function findBotsEntrySpan(raw: string, entryIndex: number): { start: number; end: number } | null {
    const m = /"bots"\s*:\s*\[/.exec(raw);
    if (!m) return null;
    let i = m.index + m[0].length; // just past '['
    const n = raw.length;
    let count = 0;
    const skipWsComments = () => {
        while (i < n) {
            const c = raw[i];
            if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
            if (c === '/' && raw[i + 1] === '/') { while (i < n && raw[i] !== '\n') i++; continue; }
            if (c === '/' && raw[i + 1] === '*') { i += 2; while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i += 2; continue; }
            break;
        }
    };
    const skipString = () => {
        const q = raw[i];
        i++;
        while (i < n) {
            const c = raw[i];
            if (c === '\\') { i += 2; continue; }
            if (c === q) { i++; return; }
            i++;
        }
    };
    // Skip one JSON value starting at raw[i]; false on malformed input.
    const skipValue = (): boolean => {
        skipWsComments();
        if (i >= n) return false;
        const c = raw[i];
        if (c === '"' || c === "'") { skipString(); return true; }
        if (c === '{' || c === '[') {
            const open = c;
            const close = c === '{' ? '}' : ']';
            i++;
            let depth = 1;
            while (i < n && depth > 0) {
                const d = raw[i];
                if (d === '"' || d === "'") { skipString(); continue; }
                if (d === '/' && raw[i + 1] === '/') { while (i < n && raw[i] !== '\n') i++; continue; }
                if (d === '/' && raw[i + 1] === '*') { i += 2; while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i += 2; continue; }
                if (d === open) depth++;
                else if (d === close) depth--;
                i++;
            }
            return depth === 0;
        }
        while (i < n && raw[i] !== ',' && raw[i] !== ']' && raw[i] !== '}') i++;
        return true;
    };
    for (;;) {
        skipWsComments();
        if (i >= n) return null;
        if (raw[i] === ']') return null; // array ended before entryIndex
        if (raw[i] === '{') {
            const start = i;
            if (!skipValue()) return null;
            if (count === entryIndex) return { start, end: i };
            count++;
        } else if (!skipValue()) {
            return null;
        }
        skipWsComments();
        if (i < n && raw[i] === ',') { i++; continue; }
        if (i < n && raw[i] === ']') return null;
        return null; // malformed separator
    }
}

/**
 * Locate the string value of a top-level key inside one bot-entry source
 * span. Unlike a regex, this scan skips over // and block comments as well
 * as string literals, so a key-looking fragment inside a comment (e.g.
 * `// "accountId": "1.2.9999" (old)`) can never be mistaken for the real
 * key. Returns the span of the quoted value (including quotes), or null
 * when the key is absent or its value is not a string.
 */
function findEntryKeyValueSpan(entrySrc: string, key: string): { valueStart: number; valueEnd: number } | null {
    const n = entrySrc.length;
    const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    let i = 0;
    let depth = 0;
    while (i < n) {
        const c = entrySrc[i];
        if (isWs(c)) { i++; continue; }
        if (c === '/' && entrySrc[i + 1] === '/') { while (i < n && entrySrc[i] !== '\n') i++; continue; }
        if (c === '/' && entrySrc[i + 1] === '*') { i += 2; while (i < n && !(entrySrc[i] === '*' && entrySrc[i + 1] === '/')) i++; i += 2; continue; }
        if (c === '{' || c === '[') { depth++; i++; continue; }
        if (c === '}' || c === ']') { depth--; i++; continue; }
        if (c !== '"') { i++; continue; }
        // String literal: read it (honoring backslash escapes).
        let j = i + 1;
        let str = '';
        while (j < n) {
            const d = entrySrc[j];
            if (d === '\\') { str += entrySrc.slice(j, j + 2); j += 2; continue; }
            if (d === '"') break;
            str += d; j++;
        }
        if (j >= n) return null;
        const closingQuote = j;
        if (depth !== 1 || str !== key) { i = closingQuote + 1; continue; }
        // Candidate key at top level: expect `:` then a quoted value.
        let k = closingQuote + 1;
        while (k < n && isWs(entrySrc[k])) k++;
        if (entrySrc[k] !== ':') { i = closingQuote + 1; continue; }
        k++;
        while (k < n && isWs(entrySrc[k])) k++;
        if (entrySrc[k] !== '"') { i = closingQuote + 1; continue; }
        let m = k + 1;
        while (m < n) {
            const e = entrySrc[m];
            if (e === '\\') { m += 2; continue; }
            if (e === '"') return { valueStart: k, valueEnd: m + 1 };
            m++;
        }
        return null;
    }
    return null;
}

/**
 * Byte-preserving accountId update: replaces the value in place, or inserts
 * `"accountId"` right after `"preferredAccount"` keeping the line indent, so
 * comments, key order and formatting elsewhere in the file survive. The
 * patched document is re-parsed (comments allowed) and the value asserted
 * before the atomic tmp+rename write. Returns false on any uncertainty —
 * callers fall back to a full rewrite.
 */
function patchAccountIdInRaw(filePath: string, entryIndex: number, accountId: string): boolean {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        return false;
    }
    const span = findBotsEntrySpan(raw, entryIndex);
    if (!span) return false;
    const entrySrc = raw.slice(span.start, span.end);
    let patchedEntry: string | null = null;
    const idSpan = findEntryKeyValueSpan(entrySrc, 'accountId');
    if (idSpan) {
        patchedEntry = entrySrc.slice(0, idSpan.valueStart)
            + `"${accountId}"`
            + entrySrc.slice(idSpan.valueEnd);
    } else {
        const prefSpan = findEntryKeyValueSpan(entrySrc, 'preferredAccount');
        if (!prefSpan) return false;
        const lineStart = entrySrc.lastIndexOf('\n', prefSpan.valueEnd) + 1;
        const indentMatch = /^[ \t]*/.exec(entrySrc.slice(lineStart));
        const indent = indentMatch ? indentMatch[0] : '  ';
        patchedEntry = entrySrc.slice(0, prefSpan.valueEnd)
            + `,\n${indent}"accountId": "${accountId}"`
            + entrySrc.slice(prefSpan.valueEnd);
    }
    if (!patchedEntry || patchedEntry === entrySrc) return false;
    const patched = raw.slice(0, span.start) + patchedEntry + raw.slice(span.end);
    try {
        const reparsed = parseJsonWithComments(patched);
        const checkEntries = Array.isArray(reparsed?.bots) ? reparsed.bots : [];
        if (checkEntries[entryIndex]?.accountId !== accountId) return false;
    } catch (_) {
        return false;
    }
    const tmpPath = `${filePath}.tmp-persist-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(tmpPath, patched, 'utf8');
        fs.renameSync(tmpPath, filePath);
        return true;
    } catch (_) {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* best-effort cleanup */ }
        return false;
    }
}

/**
 * Persist a resolved account name → ID mapping onto the bot entry in
 * profiles/bots.json (`accountId` next to `preferredAccount`), so analysis
 * tools can skip the chain lookup on subsequent runs. No-op when the stored
 * value already matches. Prefers a byte-preserving textual patch (comments,
 * key order and formatting survive); falls back to a full rewrite using the
 * same atomic writeJSON serialization the bot editor uses. Returns true when
 * the file was updated.
 */
function persistBotAccountId(botKey: any, accountId: string, filePath = PATHS.PROFILES.BOTS_JSON): boolean {
    if (!botKey || !/^1\.2\.\d+$/.test(String(accountId))) return false;
    let settings: any = null;
    try {
        settings = loadBotSettings(filePath);
    } catch (_) {
        return false;
    }
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    const normalizedKey = String(botKey).toLowerCase();
    const index = entries.findIndex((bot: any, i: number) => computeBotKey(bot, i) === normalizedKey);
    if (index < 0 || entries[index]?.accountId === accountId) return false;
    try {
        if (patchAccountIdInRaw(filePath, index, String(accountId))) return true;
    } catch (_) {
        // Fall through to the full rewrite below.
    }
    entries[index].accountId = String(accountId);
    try {
        writeJSON(filePath, settings);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Return the stored chain account ID for a bot key, or null when none is
 * stamped yet. When expectedRef is given, the stored ID is only returned if
 * the entry's current preferredAccount still matches it — a rename must
 * never silently reuse a stale ID.
 */
function getStoredBotAccountId(botKey: any, expectedRef?: string | null, filePath = PATHS.PROFILES.BOTS_JSON): string | null {
    if (!botKey) return null;
    let meta: any = null;
    try {
        meta = loadBotMeta(botKey, filePath);
    } catch (_) {
        return null;
    }
    const stored = meta && /^1\.2\.\d+$/.test(String(meta.accountId ?? '')) ? String(meta.accountId) : null;
    if (!stored) return null;
    if (expectedRef != null && String(meta.preferredAccount ?? '').toLowerCase() !== String(expectedRef).toLowerCase()) return null;
    return stored;
}

/**
 * Find the bot entry whose preferredAccount matches a raw account reference
 * (case-insensitive). Used by tools that accept a bare account name to locate
 * the stored accountId and the persist target. Returns null for 1.2.x input
 * or when no bot claims the name.
 */
function findBotKeyByAccountRef(ref: any, filePath = PATHS.PROFILES.BOTS_JSON): { botKey: string; meta: any } | null {
    if (!ref || /^1\.2\.\d+$/.test(String(ref))) return null;
    let settings: any = null;
    try {
        settings = loadBotSettings(filePath);
    } catch (_) {
        return null;
    }
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    const want = String(ref).toLowerCase();
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry && String(entry.preferredAccount ?? '').toLowerCase() === want) {
            return { botKey: computeBotKey(entry, i), meta: entry };
        }
    }
    return null;
}

function resolveAmaConfig(botKey: any) {
    const botMeta = loadBotMeta(botKey);
    // Unknown bot key: fall back to the global erSmoothPeriod default (same
    // resolution path production uses) instead of forcing 0 — a typo'd
    // --bot-key must not silently research with different ER smoothing.
    if (!botMeta) return { ...MARKET_ADAPTER.AMAS.AMA3, erSmoothPeriod: Number(MARKET_ADAPTER.AMA_ER_SMOOTH_FAST_PERIOD) };

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

export { loadBotSettings, sanitizeKey, computeBotKey, resolveBotKey, candleFileForBot, resolveCandleFile, loadBotMeta, getStoredBotAccountId, findBotKeyByAccountRef, persistBotAccountId, resolveAmaConfig, resolveAmaKey }

