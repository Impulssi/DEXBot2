
import fs from 'node:fs';
import { loadSettingsFile, resolveRawBotEntries, normalizeBotEntries } from '../modules/bot_settings';
import { PATHS } from '../modules/paths';
import { readJSON } from '../modules/utils/fs_utils';
import { getErrorMessage } from '../modules/utils/errors';
'use strict';


const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const WHITELIST_FILE = PATHS.PROFILES.MARKET_ADAPTER_WHITELIST_JSON();

function loadNormalizedBots() {
    const { config } = loadSettingsFile(BOTS_FILE);
    const raw = resolveRawBotEntries(config);
    const normalized = normalizeBotEntries(raw);
    return normalized;
}

function isAmaGridPrice(value: any) {
    if (typeof value !== 'string') return false;
    return /^ama(?:[1-4])?$/i.test(value.trim());
}

function parseOptions(argv: string[]) {
    const dynamicWeightEnabled = argv.includes('--dynamic-weight=true') || argv.includes('--dynamic-weight') || argv.includes('--with-dynamic-weight');
    const dynamicWeightDisabled = argv.includes('--dynamic-weight=false') || argv.includes('--no-dynamic-weight');
    const asymmetricBoundsDisabled = argv.includes('--asymmetric-bounds=false') || argv.includes('--no-asymmetric-bounds');
    const pruneEnabled = argv.includes('--prune');

    return {
        dynamicWeight: dynamicWeightEnabled && !dynamicWeightDisabled,
        asymmetricBounds: !asymmetricBoundsDisabled,
        prune: pruneEnabled,
    };
}

function loadExistingWhitelist() {
    if (!fs.existsSync(WHITELIST_FILE)) return {};

    let json;
    try {
        json = readJSON(WHITELIST_FILE);
    } catch (err: any) {
        process.stderr.write(`Warning: ignoring malformed ${WHITELIST_FILE}: ${getErrorMessage(err)}\n`);
        return {};
    }
    const raw = json?.whitelist;
    const entries: any = {};

    if (Array.isArray(raw)) {
        for (const botKey of raw) {
            if (botKey) entries[String(botKey)] = { ama: true, dynamicWeight: true, asymmetricBounds: true };
        }
    } else if (raw && typeof raw === 'object') {
        for (const [botKey, entry] of Object.entries(raw)) {
            entries[String(botKey)] = entry;
        }
    }

    return entries;
}

function buildWhitelist(bots: any, existingWhitelist: any = {}, options = parseOptions(process.argv)) {
    const entries = new Map<string, any>();

    for (const [botKey, entry] of Object.entries(existingWhitelist || {})) {
        entries.set(String(botKey), entry);
    }

    if (options.prune) {
        const configuredKeys = new Set<string>();
        for (const bot of bots) {
            const botKey = bot.botKey;
            if (botKey) configuredKeys.add(String(botKey));
        }
        for (const key of entries.keys()) {
            if (!configuredKeys.has(key)) {
                process.stderr.write(`prune: removed stale whitelist entry '${key}'\n`);
                entries.delete(key);
            }
        }
    }

    for (const bot of bots) {
        const botKey = bot.botKey;
        if (!botKey || !isAmaGridPrice(bot?.gridPrice)) continue;
        const key = String(botKey);
        if (!entries.has(key)) {
            entries.set(key, {
                ama: true,
                dynamicWeight: options.dynamicWeight,
                asymmetricBounds: options.asymmetricBounds,
            });
        }
    }

    return {
        whitelist: Object.fromEntries([...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    };
}

function main() {
    const bots = loadNormalizedBots();
    const existingWhitelist = loadExistingWhitelist();
    const whitelist = buildWhitelist(bots, existingWhitelist, parseOptions(process.argv));
    const output = JSON.stringify(whitelist, null, 2) + '\n';

    fs.writeFileSync(WHITELIST_FILE, output, 'utf8');
    const botCount = Object.keys(whitelist.whitelist).length;
    process.stdout.write(`Wrote ${WHITELIST_FILE} with ${botCount} ${botCount === 1 ? 'bot' : 'bots'}\n`);
}

if (require.main === module) {
    main();
}

export { isAmaGridPrice, parseOptions, loadExistingWhitelist, buildWhitelist }

