
import { getStorage } from './storage/index.js';
import { readBotsFileSync } from './bots_file_lock.js';
import { parseJsonWithComments } from './order/utils/system.js';
import { createBotKey } from './account_orders.js';
import { seedBotEntry } from './bot_defaults.js';
import { isSameBotName } from './utils/sanitize_key.js';
import { isPositiveNumber, isPositiveNumberOrPercent, toDecimal } from './order/utils/math.js';
import { resolveMinCollateralIncreaseThreshold } from './cr_planner.js';
import { getErrorMessage } from './utils/errors.js';
import { canonicalizeBotAssetSymbols } from './utils/asset_symbols.js';
import type { UnknownRecord } from './types.js';
import { isUnknownRecord } from './types.js';
const storage = getStorage();
const { writeJSON } = storage;

/** A single `debtPolicy.lending[]` entry (loosely typed: validated at runtime). */
export interface BotLendingEntry extends UnknownRecord {
    asset?: unknown;
    collateralAsset?: unknown;
    type?: unknown;
}

/** `debtPolicy` block of a bot entry. */
export interface BotDebtPolicy extends UnknownRecord {
    lending?: BotLendingEntry[];
    maxCollateralAmount?: unknown;
}

/** A loosely-typed bot entry as read from bots.json / user input. */
export interface BotEntry extends UnknownRecord {
    name?: string;
    active?: boolean;
    creditOnly?: boolean;
    assetA?: string;
    assetB?: string;
    botKey?: string;
    botIndex?: number;
    preferredAccount?: string;
    activeOrders?: UnknownRecord;
    reserveOrders?: number | UnknownRecord;
    botFunds?: { buy?: unknown; sell?: unknown };
    debtPolicy?: BotDebtPolicy;
}

/** The top-level bots.json document. */
export interface BotSettingsFile extends UnknownRecord {
    bots?: BotEntry[];
}

function loadSettingsFile(filePath: string, { silent = false, exitOnError = true }: { silent?: boolean; exitOnError?: boolean } = {}): { config: BotSettingsFile; filePath: string } {
    if (!storage.exists(filePath)) {
        if (!silent) {
            console.error(`${filePath} not found. Run: dexbot bot`);
        }
        return { config: {}, filePath };
    }

    try {
        const { config } = readBotsFileSync(filePath, parseJsonWithComments);
        return { config, filePath };
    } catch (err) {
        console.error('Failed to parse bot settings from', filePath);
        console.error('Error:', getErrorMessage(err));
        console.error('Please fix the JSON syntax and try again.');
        if (exitOnError) {
            throw err;
        }
        return { config: {}, filePath };
    }
}

function saveSettingsFile(config: UnknownRecord, filePath: string): void {
    try {
        writeJSON(filePath, config);
    } catch (err) {
        console.error('Failed to save bot settings to', filePath, '-', getErrorMessage(err));
        throw err;
    }
}

function resolveRawBotEntries(settings: unknown): BotEntry[] {
    if (!isUnknownRecord(settings)) return [];
    if (Array.isArray(settings.bots)) return settings.bots as BotEntry[];
    if (Object.keys(settings).length > 0) return [settings as BotEntry];
    return [];
}

function normalizeBotEntry(entry: BotEntry, index: number = 0): BotEntry {
    // active default + raw passthrough live in modules/bot_defaults.ts
    // (shared with the claw copy — one semantics for both).
    const normalized = seedBotEntry(entry);
    // Asset symbols are canonical UPPERCASE on BitShares. A hand-edited
    // lowercase "assetA": "tokena" is accepted by the chain without error but
    // breaks every strict symbol comparison downstream (e.g. the core-asset
    // side check that reads `assetA === 'CORE'`,
    // getBtsSide, fee/pool cache keys), so canonicalize at this single read
    // funnel — which key names hold a symbol is defined once, in
    // modules/utils/asset_symbols.canonicalizeBotAssetSymbols, shared with
    // analysis/bot_key_utils.loadBotMeta. botKey is unaffected: createBotKey
    // runs the pair through sanitizeKey, which is case-insensitive.
    const out: BotEntry = canonicalizeBotAssetSymbols({ ...normalized, botIndex: index });
    out.botKey = createBotKey(out, index);
    return out;
}

function normalizeBotEntries(rawEntries: unknown[]): BotEntry[] {
    return rawEntries.map((entry, index) => normalizeBotEntry(entry as BotEntry, index));
}

function selectBotEntry(settings: unknown, botName: string): BotEntry | null {
    const entries = resolveRawBotEntries(settings);
    if (!botName) return null;
    return entries.find((b) => b && isSameBotName(b.name, botName)) || null;
}

function selectActiveBotEntries(settings: unknown): BotEntry[] {
    return resolveRawBotEntries(settings).filter((entry) => entry && entry.active !== false);
}



function validateBotEntry(b: BotEntry, i: number, src: string): string | null {
    const problems: string[] = [];
    const isCreditOnly = b.creditOnly === true;
    const required = isCreditOnly ? [] : ['assetA', 'assetB', 'activeOrders', 'botFunds'];
    for (const k of required) {
        if (!(k in b)) problems.push(`missing '${k}'`);
    }

    if ('activeOrders' in b) {
        if (typeof b.activeOrders !== 'object' || b.activeOrders === null) problems.push("'activeOrders' must be an object");
        else {
            if (!('buy' in b.activeOrders)) problems.push("activeOrders missing 'buy'");
            if (!('sell' in b.activeOrders)) problems.push("activeOrders missing 'sell'");
        }
    }

    // Buy-window behavior (optional; defaults apply when absent)
    if ('buyFloorUSDT' in b && b.buyFloorUSDT !== null && b.buyFloorUSDT !== undefined) {
        const v = Number(b.buyFloorUSDT);
        if (!Number.isFinite(v) || v < 0) problems.push("'buyFloorUSDT' must be a non-negative number (quote currency, 0 = off)");
    }
    if ('buyDelayMinutes' in b && b.buyDelayMinutes !== null && b.buyDelayMinutes !== undefined) {
        const v = Number(b.buyDelayMinutes);
        if (!Number.isFinite(v) || v < 0 || v > 10080) problems.push("'buyDelayMinutes' must be a number 0-10080 (0 = off)");
    }
    if ('buyWindowMode' in b && b.buyWindowMode !== null && b.buyWindowMode !== undefined) {
        const v = String(b.buyWindowMode).trim().toLowerCase();
        if (v !== 'low' && v !== 'closest') problems.push("'buyWindowMode' must be 'low' or 'closest'");
    }
    if ('buyDeepCount' in b && b.buyDeepCount !== null && b.buyDeepCount !== undefined) {
        const v = Number(b.buyDeepCount);
        if (!Number.isInteger(v) || v < 0 || v > 12) problems.push("'buyDeepCount' must be an integer 0-12 (0 = off)");
    }
    if ('buyDeepSizes' in b && b.buyDeepSizes !== null && b.buyDeepSizes !== undefined && !(typeof b.buyDeepSizes === 'string' && b.buyDeepSizes.trim() === '')) {
        const parts = Array.isArray(b.buyDeepSizes) ? b.buyDeepSizes : String(b.buyDeepSizes).split(',');
        if (!Array.isArray(b.buyDeepSizes) && typeof b.buyDeepSizes !== 'string') {
            problems.push("'buyDeepSizes' must be an array of numbers or a comma-separated string");
        } else if (parts.length > 12) {
            problems.push("'buyDeepSizes' must have at most 12 entries (top-first: deep-0, deep-1, ...)");
        } else {
            for (const p of parts) {
                const v = Number(typeof p === 'string' ? p.trim() : p);
                if (!(Number.isFinite(v) && v >= 0)) {
                    problems.push("'buyDeepSizes' entries must be non-negative numbers (0 = curve size for that level)");
                    break;
                }
            }
        }
    }
    if ('reserveOrders' in b && b.reserveOrders !== undefined && b.reserveOrders !== null) {
        if (typeof b.reserveOrders === 'number') {
            // Legacy numeric form migrates at read time (resolveReserveCount):
            // { buy: n, sell: 0 }. Accept it here so a hand-edited bots.json
            // that bypassed the editor is not rejected for a form the runtime
            // still understands.
            if (!Number.isInteger(b.reserveOrders) || b.reserveOrders < 0) problems.push("'reserveOrders' numeric form must be a non-negative integer");
        } else if (typeof b.reserveOrders !== 'object' || Array.isArray(b.reserveOrders)) {
            problems.push("'reserveOrders' must be an object {buy, sell}");
        } else {
            for (const side of ['buy', 'sell'] as const) {
                const reserveOrders = b.reserveOrders as UnknownRecord;
                const v = reserveOrders[side];
                if (v !== undefined && (!Number.isInteger(Number(v)) || Number(v) < 0)) problems.push(`'reserveOrders.${side}' must be a non-negative integer`);
            }
        }
    }

    if ('botFunds' in b) {
        if (typeof b.botFunds !== 'object' || b.botFunds === null) problems.push("'botFunds' must be an object");
        else {
            if (!('buy' in b.botFunds)) problems.push("botFunds missing 'buy'");
            if (!('sell' in b.botFunds)) problems.push("botFunds missing 'sell'");
        }
    }

    if ('debtPolicy' in b) {
        if (typeof b.debtPolicy !== 'object' || b.debtPolicy === null) {
            problems.push("'debtPolicy' must be an object");
        } else {
            const dp = b.debtPolicy;

            if (!Array.isArray(dp.lending) || dp.lending.length === 0) {
                problems.push("debtPolicy.lending must be a non-empty array");
            } else {
                dp.lending.forEach((item: BotLendingEntry, idx: number) => {
                    if (typeof item !== 'object' || item === null) {
                        problems.push(`debtPolicy.lending[${idx}] must be an object`);
                        return;
                    }
                    if (!item.collateralAsset || typeof item.collateralAsset !== 'string') {
                        problems.push(`debtPolicy.lending[${idx}].collateralAsset must be a non-empty string`);
                    }
                    if (!item.asset || typeof item.asset !== 'string') {
                        problems.push(`debtPolicy.lending[${idx}].asset must be a non-empty string`);
                    }
                    if (!['mpa', 'creditOffer'].includes(String(item.type))) {
                        problems.push(`debtPolicy.lending[${idx}].type must be 'mpa' or 'creditOffer'`);
                    }

                    // outputWeight: canonical field (deprecated 'ratio' alias removed)
                    if ('ratio' in item) {
                        problems.push(`debtPolicy.lending[${idx}].ratio is no longer supported; use outputWeight instead`);
                    }

                    if ('outputWeight' in item) {
                        const weightVal = item.outputWeight;
                        if (typeof weightVal !== 'number' || !Number.isFinite(weightVal) || weightVal < 0) {
                            problems.push(`debtPolicy.lending[${idx}].outputWeight must be a non-negative number`);
                        }
                    }

                    // maxBorrowAmount: optional, must be a fixed positive number (no percentage)
                    if ('maxBorrowAmount' in item) {
                        if (!isPositiveNumber(item.maxBorrowAmount)) {
                            problems.push(`debtPolicy.lending[${idx}].maxBorrowAmount must be a positive number (fixed amount, not percentage)`);
                        }
                    }

                    // maxBorrowAmountPerOperation: optional, must be a fixed positive number
                    if ('maxBorrowAmountPerOperation' in item) {
                        if (!isPositiveNumber(item.maxBorrowAmountPerOperation)) {
                            problems.push(`debtPolicy.lending[${idx}].maxBorrowAmountPerOperation must be a positive number`);
                        }
                    }

                    // maxCollateralAmount: optional, positive number or percentage
                    if ('maxCollateralAmount' in item && !isPositiveNumberOrPercent(item.maxCollateralAmount)) {
                        problems.push(`debtPolicy.lending[${idx}].maxCollateralAmount must be a positive number or percentage`);
                    }

                    if ('minCollateralIncreaseThreshold' in item) {
                        const referenceAmount = typeof item.minCollateralIncreaseThreshold === 'string' && item.minCollateralIncreaseThreshold.trim().endsWith('%')
                            ? 1
                            : null;
                        if (resolveMinCollateralIncreaseThreshold(item.minCollateralIncreaseThreshold, referenceAmount) === null) {
                            problems.push(`debtPolicy.lending[${idx}].minCollateralIncreaseThreshold must be a non-negative number or percentage`);
                        }
                    }

                    if (item.type === 'mpa') {
                        // MPA-specific validation (maxCollateralRatio is optional for MPA)
                        if ('targetCollateralRatio' in item) {
                            const tcr = Number(item.targetCollateralRatio);
                            if (!Number.isFinite(tcr) || tcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].targetCollateralRatio must be a positive number`);
                            }
                        }
                        if ('minCollateralRatio' in item) {
                            const mcr = Number(item.minCollateralRatio);
                            if (!Number.isFinite(mcr) || mcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].minCollateralRatio must be a positive number`);
                            }
                        }
                        if ('maxCollateralRatio' in item) {
                            const mxcr = Number(item.maxCollateralRatio);
                            if (!Number.isFinite(mxcr) || mxcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].maxCollateralRatio must be a positive number`);
                            }
                        }
                        if ('minCollateralRatio' in item && 'maxCollateralRatio' in item) {
                            const mcr = Number(item.minCollateralRatio);
                            const mxcr = Number(item.maxCollateralRatio);
                            if (Number.isFinite(mcr) && Number.isFinite(mxcr) && mcr > mxcr) {
                                problems.push(`debtPolicy.lending[${idx}].minCollateralRatio (${mcr}) cannot exceed maxCollateralRatio (${mxcr})`);
                            }
                        }
                        if ('debtOnly' in item && typeof item.debtOnly !== 'boolean') {
                            problems.push(`debtPolicy.lending[${idx}].debtOnly must be a boolean`);
                        }
                    } else if (item.type === 'creditOffer') {
                        // Credit offer-specific validation (maxCollateralRatio is required)
                        if (!('maxCollateralRatio' in item)) {
                            problems.push(`debtPolicy.lending[${idx}].maxCollateralRatio is required for creditOffer`);
                        } else {
                            const mxcr = Number(item.maxCollateralRatio);
                            if (!Number.isFinite(mxcr) || mxcr <= 0) {
                                problems.push(`debtPolicy.lending[${idx}].maxCollateralRatio must be a positive number`);
                            }
                        }
                        if ('maxFeeRatePerDay' in item) {
                            const fr = Number(item.maxFeeRatePerDay);
                            if (!Number.isFinite(fr) || fr < 0) {
                                problems.push(`debtPolicy.lending[${idx}].maxFeeRatePerDay must be a non-negative number`);
                            }
                        }
                        if ('autoRepay' in item) {
                            const ar = Number(item.autoRepay);
                            if (![0, 1, 2].includes(ar)) {
                                problems.push(`debtPolicy.lending[${idx}].autoRepay must be 0, 1, or 2`);
                            }
                        }
                        if ('renewOnly' in item && typeof item.renewOnly !== 'boolean') {
                            problems.push(`debtPolicy.lending[${idx}].renewOnly must be a boolean`);
                        }
                        if ('allowedOfferIds' in item) {
                            if (!Array.isArray(item.allowedOfferIds)) {
                                problems.push(`debtPolicy.lending[${idx}].allowedOfferIds must be an array`);
                            }
                        }
                        if ('disallowedDealIds' in item) {
                            if (!Array.isArray(item.disallowedDealIds)) {
                                problems.push(`debtPolicy.lending[${idx}].disallowedDealIds must be an array`);
                            }
                        }
                    }
                });
            }

            // Global maxCollateralAmount: optional, caps total collateral across all lending items
            if ('maxCollateralAmount' in dp && !isPositiveNumberOrPercent(dp.maxCollateralAmount)) {
                problems.push("debtPolicy.maxCollateralAmount must be a positive number or percentage");
            }
        }
    }

    if (problems.length) {
        const name = b.name || `<unnamed-${i}>`;
        return `Bot[${i}] '${name}' (${src}) -> ${problems.join('; ')}`;
    }
    return null;
}

function collectValidationIssues(entries: BotEntry[], sourceName: string): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    entries.forEach((entry, index) => {
        const issue = validateBotEntry(entry, index, sourceName);
        if (issue) {
            if (entry.active) errors.push(issue);
            else warnings.push(issue);
        }
        // Grid capacity check: activeOrders vs Range/Incr (issue #19)
        // Per-side estimation mirrors createOrderGrid geometry:
        //   levels on each side grow geometrically from the center,
        //   gap slots are split around the boundary.
        if (entry.active && entry.activeOrders && entry.incrementPercent && entry.targetSpreadPercent) {
            try {
                const incr = Number(entry.incrementPercent);
                const spread = Number(entry.targetSpreadPercent);
                const buy = Number(entry.activeOrders.buy || 0);
                const sell = Number(entry.activeOrders.sell || 0);
                if (Number.isFinite(incr) && incr > 0 && Number.isFinite(spread) && spread >= 0 && Number.isFinite(buy) && Number.isFinite(sell)) {
                    const parseFactor = (v: any): number | null => {
                        if (typeof v === 'string' && v.trim().toLowerCase().endsWith('x')) {
                            const n = parseFloat(v);
                            return Number.isFinite(n) && n > 0 ? n : null;
                        }
                        const n = Number(v);
                        return Number.isFinite(n) && n > 0 ? n : null;
                    };
                    const isXFactor = (v: any) => typeof v === 'string' && String(v).trim().toLowerCase().endsWith('x');
                    const minF = parseFactor(entry.minPrice);
                    const maxF = parseFactor(entry.maxPrice);
                    const minIsX = isXFactor(entry.minPrice);
                    const maxIsX = isXFactor(entry.maxPrice);
                    if (minF !== null && maxF !== null) {
                        const step = 1 + incr / 100;
                        const gapSlots = Math.max(2, Math.ceil(Math.log(1 + spread / 100) / Math.log(step)) - 1);
                        // Buy side spans from center down to minPrice:
                        //   x-factor min "1.15x" -> distance log(1.15)
                        //   absolute min -> distance log(center/min); approximate center
                        //   by geometric mean of bounds (ratio-based, no price needed).
                        let buyDistance: number | null = null;
                        let sellDistance: number | null = null;
                        if (minIsX && maxIsX) {
                            buyDistance = Math.log(minF);
                            sellDistance = Math.log(maxF);
                        } else if (!minIsX && !maxIsX) {
                            const center = Math.sqrt(minF * maxF);
                            buyDistance = Math.log(center / minF);
                            sellDistance = Math.log(maxF / center);
                        }
                        if (buyDistance !== null && sellDistance !== null && buyDistance > 0 && sellDistance > 0) {
                            const buyCapacity = Math.floor(buyDistance / Math.log(step)) - Math.floor(gapSlots / 2) - 1;
                            const sellCapacity = Math.floor(sellDistance / Math.log(step)) - Math.ceil(gapSlots / 2) - 1;
                            const name = entry.name || `<unnamed-${index}>`;
                            if (sell > sellCapacity) {
                                warnings.push(
                                    `Bot[${index}] '${name}' (${sourceName}): activeOrders sell:${sell} exceeds grid capacity — Range [${entry.minPrice}-${entry.maxPrice}] with Incr ${incr}% fits ~${Math.max(0, sellCapacity)} sell orders. ` +
                                    `After reset the surplus silently stays unfilled (e.g. S:27 showed Active 22/27, Slots 23 sell). ` +
                                    `Widen maxPrice, lower Incr, or reduce activeOrders.sell.`
                                );
                            }
                            if (buy > buyCapacity) {
                                warnings.push(
                                    `Bot[${index}] '${name}' (${sourceName}): activeOrders buy:${buy} exceeds grid capacity — Range [${entry.minPrice}-${entry.maxPrice}] with Incr ${incr}% fits ~${Math.max(0, buyCapacity)} buy orders. ` +
                                    `After reset the surplus silently stays unfilled. ` +
                                    `Widen minPrice, lower Incr, or reduce activeOrders.buy.`
                                );
                            }
                        }
                    }
                }
            } catch {}
        }
    });

    // Cross-bot validation: check for duplicate botKeys (sanitized names)
    for (const duplicateIssue of findDuplicateBotKeyIssues(entries)) {
        errors.push(duplicateIssue);
    }

    // Cross-bot validation: check if botFunds percentages sum > 100% per account
    const accountFunds: Record<string, { buy: number; sell: number; botNames: string[] }> = {};
    for (const entry of entries) {
        const account = entry.preferredAccount;
        if (!entry.active || !account || !entry.botFunds) continue;
        if (!accountFunds[account]) {
            accountFunds[account] = { buy: 0, sell: 0, botNames: [] };
        }
        const acc = accountFunds[account];
        acc.buy += toDecimal(entry.botFunds.buy);
        acc.sell += toDecimal(entry.botFunds.sell);
        acc.botNames.push(entry.name || entry.botKey || `bot-${entries.indexOf(entry)}`);
    }
    for (const [account, funds] of Object.entries(accountFunds)) {
        if (funds.botNames.length > 1) {
            if (funds.buy > 1) {
                warnings.push(
                    `[SHARED ACCOUNT] '${account}': bots [${funds.botNames.join(', ')}] allocate ` +
                    `${(funds.buy * 100).toFixed(0)}% of BUY funds (>100%). ` +
                    `Each bot will receive a proportional share (myPct / totalPct × chainBalance).`
                );
            }
            if (funds.sell > 1) {
                warnings.push(
                    `[SHARED ACCOUNT] '${account}': bots [${funds.botNames.join(', ')}] allocate ` +
                    `${(funds.sell * 100).toFixed(0)}% of SELL funds (>100%). ` +
                    `Each bot will receive a proportional share (myPct / totalPct × chainBalance).`
                );
            }
        }
    }

    return { errors, warnings };
}

function findDuplicateBotKeyIssues(entries: BotEntry[]): string[] {
    const seenKeys = new Map<string, number>();
    const duplicates: string[] = [];
    entries.forEach((entry, index) => {
        if (!entry.name) return;
        const key = createBotKey(entry, index);
        const existing = seenKeys.get(key);
        if (existing !== undefined) {
            duplicates.push(
                `Bot[${existing}] '${entries[existing].name}' and Bot[${index}] '${entry.name}' ` +
                `both produce botKey '${key}' — bot names must be unique.`
            );
        } else {
            seenKeys.set(key, index);
        }
    });
    return duplicates;
}

function assertNoDuplicateBotKeys(entries: BotEntry[], sourceName: string): void {
    const duplicates = findDuplicateBotKeyIssues(entries);
    if (duplicates.length > 0) {
        throw new Error(`Duplicate bot name(s) in ${sourceName}:\n${duplicates.map((e) => `  - ${e}`).join('\n')}`);
    }
}

export { assertNoDuplicateBotKeys, collectValidationIssues, loadSettingsFile, normalizeBotEntry, normalizeBotEntries, resolveRawBotEntries, saveSettingsFile, selectActiveBotEntries, selectBotEntry, validateBotEntry }

