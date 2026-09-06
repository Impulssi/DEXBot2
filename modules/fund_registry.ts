
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { getStorage } from './storage/index.js';
import { PATHS } from './paths.js';
import AsyncLock from './order/async_lock.js';
const storage = getStorage();
const { readJSON, writeJSON } = storage;

const REGISTRY_FILE = PATHS.PROFILES.FUND_REGISTRY_JSON;

const _lock = new AsyncLock();
let _registry: any = null;
let _registryMtimeMs: number | null = null;

function _statMtimeMs(filePath: string): number | null {
    try {
        const fs = require('node:fs');
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return null;
    }
}

/**
 * Parse a percentage value (number, percentage string, or numeric string) to a decimal.
 * Lazy-required from math.ts to avoid a circular module dependency.
 * @param {*} value
 * @returns {number}
 */
function _parsePercentage(value: any) {
    return require('./order/utils/math').toDecimal(value);
}

function _loadRegistry(): any {
    if (_registry !== null) {
        const mtime = _statMtimeMs(REGISTRY_FILE);
        if (mtime !== null && mtime !== _registryMtimeMs) {
            _registry = null;
        }
    }
    if (_registry !== null) return _registry;
    try {
        if (storage.exists(REGISTRY_FILE)) {
            _registry = readJSON(REGISTRY_FILE);
        } else {
            _registry = {};
        }
    } catch (err: any) {
        console.error(
            `[fund_registry] Failed to load ${REGISTRY_FILE} (${err?.message || err}); ` +
            `resetting to an empty registry — previously registered bot allocations are unavailable ` +
            `and will be overwritten on the next save. Restore the file from backup before restarting other bots.`
        );
        _registry = {};
    }
    _registryMtimeMs = _statMtimeMs(REGISTRY_FILE);
    return _registry;
}

function _saveRegistry(): void {
    writeJSON(REGISTRY_FILE, _registry);
    _registryMtimeMs = _statMtimeMs(REGISTRY_FILE);
}

function _ensureAccount(registry: any, account: string): any {
    if (!registry[account]) {
        registry[account] = {
            totalAllocatedPct: { buy: 0, sell: 0 },
            totalAllocatedCollateralPct: {},
            bots: {}
        };
    } else {
        if (!registry[account].totalAllocatedCollateralPct) {
            registry[account].totalAllocatedCollateralPct = {};
        }
    }
    return registry[account];
}

/**
 * Register a bot's allocation on an account for a given side.
 * Called during bot startup.
 * @param {string} account - Blockchain account name (e.g., '1.2.x')
 * @param {string} botName - Bot identifier (e.g., 'AAA-BBB' or botKey)
 * @param {'buy'|'sell'} side - Trade side
 * @param {number|string} percentage - Percentage value (e.g., 1.0 or '100%')
 */
async function registerAllocation(account: string, botName: string, side: 'buy' | 'sell', percentage: any): Promise<void> {
    return _lock.acquire(async () => {
        const registry = _loadRegistry();
        const acc = _ensureAccount(registry, account);
        if (!acc.bots[botName]) {
            acc.bots[botName] = {};
        }
        const existingPct = acc.bots[botName][side];
        if (existingPct !== undefined) {
            acc.totalAllocatedPct[side] = Math.max(0, (acc.totalAllocatedPct[side] || 0) - _parsePercentage(existingPct));
        }
        acc.bots[botName][side] = percentage;
        acc.totalAllocatedPct[side] = (acc.totalAllocatedPct[side] || 0) + _parsePercentage(percentage);
        _saveRegistry();
    });
}

/**
 * Register a credit bot's collateral allocation on an account for a given collateral asset.
 * Called during bot startup for bots with debtPolicy.lending entries.
 * @param {string} account - Blockchain account name (e.g., '1.2.x')
 * @param {string} botName - Bot identifier (e.g., 'Credit-BTS-USDT-a1b2c3d4')
 * @param {string} collateralAssetId - Canonical collateral asset ID (e.g., '1.3.0')
 * @param {number|string} percentage - Percentage value (e.g., 1.0 or '100%')
 */
async function registerCollateralAllocation(account: string, botName: string, collateralAssetId: string, percentage: any): Promise<void> {
    return _lock.acquire(async () => {
        const registry = _loadRegistry();
        const acc = _ensureAccount(registry, account);
        if (!acc.bots[botName]) {
            acc.bots[botName] = {};
        }
        if (!acc.bots[botName].collateral) {
            acc.bots[botName].collateral = {};
        }
        const existingPct = acc.bots[botName].collateral[collateralAssetId];
        if (existingPct !== undefined) {
            const prevDecimal = _parsePercentage(existingPct);
            acc.totalAllocatedCollateralPct[collateralAssetId] = Math.max(0, (acc.totalAllocatedCollateralPct[collateralAssetId] || 0) - prevDecimal);
        }
        acc.bots[botName].collateral[collateralAssetId] = percentage;
        acc.totalAllocatedCollateralPct[collateralAssetId] = (acc.totalAllocatedCollateralPct[collateralAssetId] || 0) + _parsePercentage(percentage);
        _saveRegistry();
    });
}

/**
 * Get the effective collateral allocation for a credit bot on a given account/collateral asset.
 * Returns chainTotal * (myPercent / sum(allPercentages)).
 * Synchronous — operates on in-memory cache.
 * Returns null if no registry entry exists (caller falls back to direct balance resolution).
 *
 * @param {string} account - Blockchain account name
 * @param {string} botName - Bot identifier
 * @param {string} collateralAssetId - Canonical collateral asset ID
 * @param {number} chainTotal - Total chain balance for this collateral asset
 * @returns {number|null} Effective allocation, or null if not registered
 */
function getEffectiveCollateralAllocationSync(account: string, botName: string, collateralAssetId: string, chainTotal: number): number | null {
    const registry = _loadRegistry();
    const acc = registry[account];
    if (!acc || !acc.bots || !acc.bots[botName] || !acc.bots[botName].collateral || acc.bots[botName].collateral[collateralAssetId] === undefined) return null;
    const myPct = _parsePercentage(acc.bots[botName].collateral[collateralAssetId]);
    const totalPct = acc.totalAllocatedCollateralPct[collateralAssetId] || 0;
    if (totalPct <= 0 || myPct <= 0) return null;
    return chainTotal * (myPct / totalPct);
}

/**
 * Get the effective allocation for a bot on a given account side.
 * Returns chainTotal * (myPercent / sum(allPercentages)).
 * Synchronous — operates on in-memory cache.
 * Returns null if no registry entry exists (caller falls back to resolveConfigValue).
 *
 * @param {string} account - Blockchain account name
 * @param {string} botName - Bot identifier
 * @param {'buy'|'sell'} side - Trade side
 * @param {number} chainTotal - Total chain balance for this side
 * @returns {number|null} Effective allocation, or null if not registered
 */
function getEffectiveAllocationSync(account: string, botName: string, side: 'buy' | 'sell', chainTotal: number): number | null {
    const registry = _loadRegistry();
    const acc = registry[account];
    if (!acc || !acc.bots || !acc.bots[botName] || !acc.bots[botName][side]) return null;
    const myPct = _parsePercentage(acc.bots[botName][side]);
    const totalPct = acc.totalAllocatedPct[side] || 0;
    if (totalPct <= 0 || myPct <= 0) return null;
    return chainTotal * (myPct / totalPct);
}

/**
 * Get the total allocated percentage for an account side.
 * @param {string} account - Blockchain account name
 * @param {'buy'|'sell'} side - Trade side
 * @returns {number} Sum of percentages across all bots on this account side
 */
function getTotalAllocatedPct(account: string, side: 'buy' | 'sell'): number {
    const registry = _loadRegistry();
    const acc = registry[account];
    if (!acc) return 0;
    return acc.totalAllocatedPct[side] || 0;
}

/**
 * Get the raw percentage string for a bot's allocation on a side.
 * @param {string} account - Blockchain account name
 * @param {string} botName - Bot identifier
 * @param {'buy'|'sell'} side - Trade side
 * @returns {number|null} The parsed percentage value, or null if not registered
 */
function getBotAllocationPct(account: string, botName: string, side: 'buy' | 'sell'): number | null {
    const registry = _loadRegistry();
    const acc = registry[account];
    if (!acc || !acc.bots || !acc.bots[botName]) return null;
    const raw = acc.bots[botName][side];
    if (raw === undefined) return null;
    return _parsePercentage(raw);
}

/**
 * Release all allocations for a bot on an account.
 * Called during bot shutdown.
 * @param {string} account - Blockchain account name
 * @param {string} botName - Bot identifier
 */
async function releaseAllocation(account: string, botName: string): Promise<void> {
    return _lock.acquire(async () => {
        const registry = _loadRegistry();
        const acc = registry[account];
        if (!acc || !acc.bots[botName]) return;
        for (const side of Object.keys(acc.bots[botName])) {
            if (side === 'collateral') {
                // Clean up collateral asset entries separately
                const collEntry = acc.bots[botName].collateral;
                if (collEntry && typeof collEntry === 'object') {
                    for (const assetId of Object.keys(collEntry)) {
                        const pct = _parsePercentage(collEntry[assetId]);
                        if (acc.totalAllocatedCollateralPct) {
                            acc.totalAllocatedCollateralPct[assetId] = Math.max(0, (acc.totalAllocatedCollateralPct[assetId] || 0) - pct);
                        }
                    }
                }
            } else {
                const pct = _parsePercentage(acc.bots[botName][side]);
                acc.totalAllocatedPct[side] = Math.max(0, (acc.totalAllocatedPct[side] || 0) - pct);
            }
        }
        delete acc.bots[botName];
        if (Object.keys(acc.bots).length === 0) {
            delete registry[account];
        }
        _saveRegistry();
    });
}

/**
 * Get names of all registered bots on an account.
 * @param {string} account - Blockchain account name
 * @returns {string[]} List of bot names
 */
function getRegisteredBots(account: string): string[] {
    const registry = _loadRegistry();
    const acc = registry[account];
    if (!acc) return [];
    return Object.keys(acc.bots);
}

/**
 * Check if multiple bots share the same account.
 * @param {string} account - Blockchain account name
 * @returns {boolean} True if more than one bot is registered on this account
 */
function isSharedAccount(account: string): boolean {
    return getRegisteredBots(account).length > 1;
}

/**
 * Reset the registry file (for testing/setup).
 */
function resetRegistry(): void {
    _registry = {};
    _saveRegistry();
}

export { registerAllocation, registerCollateralAllocation, releaseAllocation, getEffectiveAllocationSync, getEffectiveCollateralAllocationSync, getTotalAllocatedPct, getBotAllocationPct, getRegisteredBots, isSharedAccount, resetRegistry }

