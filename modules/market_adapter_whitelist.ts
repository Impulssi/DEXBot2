
import { PATHS } from './paths';
import { getStorage } from './storage';
import { readJSON } from './utils/fs_utils';
import { getErrorMessage } from './utils/errors';
'use strict';

const storage = getStorage();

const WHITELIST_FILE = PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON();

interface WhitelistFlags {
    ama: boolean;
    dynamicWeight: boolean;
    asymmetricBounds: boolean;
}

let _whitelistCache: Map<string, WhitelistFlags> | false | null = null;

function resetMarketAdapterWhitelistCache(): void {
    _whitelistCache = null;
}

function normalizeEntry(entry: any): WhitelistFlags {
    if (entry === true) {
        return { ama: true, dynamicWeight: true, asymmetricBounds: true };
    }
    if (!entry || typeof entry !== 'object') {
        return { ama: false, dynamicWeight: false, asymmetricBounds: false };
    }
    return {
        ama: entry.ama === true,
        dynamicWeight: entry.dynamicWeight === true,
        asymmetricBounds: entry.asymmetricBounds === true,
    };
}

function loadMarketAdapterWhitelist(): Map<string, WhitelistFlags> | false {
    if (_whitelistCache !== null) return _whitelistCache;
    if (!storage.exists(WHITELIST_FILE)) {
        _whitelistCache = false;
        return _whitelistCache;
    }

    try {
        const json = readJSON(WHITELIST_FILE);
        const raw = json?.whitelist;
        const map = new Map<string, WhitelistFlags>();

        if (Array.isArray(raw)) {
            for (const botKey of raw) {
                map.set(String(botKey), { ama: true, dynamicWeight: true, asymmetricBounds: true });
            }
        } else if (raw && typeof raw === 'object') {
            for (const [botKey, entry] of Object.entries(raw)) {
                map.set(String(botKey), normalizeEntry(entry));
            }
        }

        _whitelistCache = map;
        return _whitelistCache;
    } catch (_: any) {
        console.warn(`[WARN] Failed to parse ${WHITELIST_FILE}: ${getErrorMessage(_)}. All whitelist features disabled.`);
        _whitelistCache = false;
        return _whitelistCache;
    }
}

function getWhitelistFlags(botKey: string): WhitelistFlags {
    const whitelist = loadMarketAdapterWhitelist();
    if (whitelist === false || !botKey) {
        return { ama: false, dynamicWeight: false, asymmetricBounds: false };
    }
    return whitelist.get(String(botKey)) || { ama: false, dynamicWeight: false, asymmetricBounds: false };
}

function isBotWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).ama === true;
}

function isBotDynamicWeightWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).dynamicWeight === true;
}

function isBotAsymmetricBoundsWhitelisted(botKey: string): boolean {
    return getWhitelistFlags(botKey).asymmetricBounds === true;
}

function isBotGridRangeScalingWhitelisted(botKey: string): boolean {
    return isBotAsymmetricBoundsWhitelisted(botKey);
}

export { WHITELIST_FILE, resetMarketAdapterWhitelistCache, getWhitelistFlags, isBotWhitelisted, isBotDynamicWeightWhitelisted, isBotAsymmetricBoundsWhitelisted, isBotGridRangeScalingWhitelisted }

