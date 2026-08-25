'use strict';

import path from 'node:path';
import { PATHS } from '../modules/paths.js';
import { MARKET_ADAPTER } from '../modules/constants.js';
import { createSource } from './price_sources.js';
import { resolveCandleFile, resolveAmaConfig, resolveAmaKey, loadBotSettings, computeBotKey } from './bot_key_utils.js';
import { findLatestLpData } from '../market_adapter/utils/data_discovery.js';

const INTERVAL_LABEL = MARKET_ADAPTER.RUNTIME_DEFAULTS.intervalLabel;

interface SourceConfig {
    type?: string;
    botKey?: string;
    filePath?: string;
    stateDir?: string;
}

interface SourceResolution {
    source: ReturnType<typeof createSource>;
    botKey?: string;
    amaConfig: { erPeriod: number; fastPeriod: number; slowPeriod: number; erSmoothPeriod: number };
    amaKey: string;
}

function listAvailableBots(): void {
    const settings = loadBotSettings();
    if (!settings?.bots?.length) {
        console.log('No bots found in profiles/bots.json');
        return;
    }
    console.log('Available bot keys:');
    settings.bots.forEach((bot: any, i: number) => {
        const key = computeBotKey(bot, i);
        console.log(`  ${key}  (name: ${bot.name})`);
    });
}

function resolveSource(config: SourceConfig, options: { quiet?: boolean } = {}): SourceResolution {
    const { quiet = false } = options;

    if (config.type === 'market_adapter') {
        if (!config.botKey) {
            throw new Error("No --bot-key provided. Use --list-bots to see available keys, or --file to specify a data file directly.");
        }

        const candleFile = resolveCandleFile(config.botKey, INTERVAL_LABEL);
        if (candleFile) {
            if (!quiet) console.log(`[Source] Resolved bot '${config.botKey}' → ${path.basename(candleFile)}`);
            const source = createSource('json', { filePath: candleFile });
            return {
                source,
                botKey: config.botKey,
                amaConfig: resolveAmaConfig(config.botKey),
                amaKey: resolveAmaKey(config.botKey),
            };
        }

        if (!quiet) console.log(`[Source] No candle cache for '${config.botKey}', using centers file`);
        const stateDir = config.stateDir || PATHS.MARKET_ADAPTER.STATE_DIR;
        const source = createSource('market_adapter', { botKey: config.botKey, stateDir });
        return {
            source,
            botKey: config.botKey,
            amaConfig: resolveAmaConfig(config.botKey),
            amaKey: resolveAmaKey(config.botKey),
        };
    }

    if (config.type === 'json') {
        let filePath = config.filePath;
        if (!filePath) {
            const autoFile = findLatestLpData();
            if (autoFile) {
                filePath = autoFile;
                if (!quiet) console.log(`[Source] Auto-discovered LP data: ${autoFile}`);
            } else {
                throw new Error('No --file provided and no LP data auto-discovered in market_adapter/data/lp');
            }
        }
        const source = createSource('json', { filePath: filePath! });
        return { source, amaConfig: resolveAmaConfig(''), amaKey: 'AMA3' };
    }

    throw new Error(`[Source] Unknown source type: ${config.type}. Use 'market_adapter' or 'json'.`);
}

export { resolveSource, listAvailableBots }
export type { SourceConfig, SourceResolution }
