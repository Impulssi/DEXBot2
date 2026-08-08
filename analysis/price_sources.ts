
import fs from 'node:fs';
import path from 'node:path';
import { fillCandleGaps } from '../market_adapter/candle_utils.js';
import { getCandleClose, getCandleTimestamp, loadCandleFile } from './math_utils.js';
import { PATHS } from '../modules/paths.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import { getErrorMessage } from '../modules/utils/errors.js';
'use strict';

/**
 * Price Source Abstraction
 *
 * Unified interface for fetching market prices from multiple sources:
 * - JSON candle files
 * - Market adapter state
 *
 * Each source returns: { marketPrice, timestamp }
 */


interface JsonFileConfig {
    filePath: string;
}

class JsonFileSource {
    filePath: string;
    name: string;

    constructor(config: JsonFileConfig) {
        this.filePath = config.filePath;
        this.name = `json:${path.basename(this.filePath)}`;
        if (!fs.existsSync(this.filePath)) {
            throw new Error(`[JsonFileSource] File not found: ${this.filePath}`);
        }
    }

    async fetchCandles(): Promise<any[]> {
        try {
            const { candles, meta } = loadCandleFile(this.filePath);
            if (!Array.isArray(candles) || candles.length === 0) {
                throw new Error('Expected JSON array or object with .candles or .data property');
            }

            const intervalSeconds = meta?.intervalSeconds || 3600;
            const lookbackHours = meta?.lookbackHours;

            if (lookbackHours && candles.length > 0) {
                const nowMs = new Date(meta.fetchedAt || Date.now()).getTime();
                const startTs = nowMs - (lookbackHours * 3600 * 1000);
                return fillCandleGaps(candles, intervalSeconds, startTs, nowMs);
            }

            return candles;
        } catch (err: any) {
            throw new Error(`[JsonFileSource] Failed to read ${this.filePath}: ${getErrorMessage(err)}`);
        }
    }

    extractMarketPrice(candle: any): { marketPrice: any; timestamp: any } {
        return { marketPrice: getCandleClose(candle), timestamp: getCandleTimestamp(candle) };
    }
}

interface MarketAdapterConfig {
    stateDir?: string;
    botKey: string;
}

class MarketAdapterSource {
    stateDir: string;
    botKey: string;
    name: string;

    constructor(config: MarketAdapterConfig) {
        this.stateDir = config.stateDir || PATHS.MARKET_ADAPTER.STATE_DIR;
        this.botKey = config.botKey;
        this.name = `market_adapter:${this.botKey}`;
    }

    async fetchCandles(): Promise<any[]> {
        const centersFile = path.join(this.stateDir, 'market_adapter_centers.json');
        if (!fs.existsSync(centersFile)) {
            throw new Error(`[MarketAdapterSource] Centers file not found: ${centersFile}`);
        }

        try {
            const data = readJSON(centersFile);

            let botData = data[this.botKey];
            if (!botData && data.bots && data.bots[this.botKey]) {
                botData = data.bots[this.botKey];
            }

            if (!botData) {
                throw new Error(`Bot '${this.botKey}' not found in centers file`);
            }

            return botData.history?.map((entry: any) => ({
                timestamp: entry.timestamp,
                open: entry.center,
                high: entry.center,
                low: entry.center,
                close: entry.center,
                volume: 0,
            })) || [];
        } catch (err: any) {
            throw new Error(`[MarketAdapterSource] Failed to read: ${getErrorMessage(err)}`);
        }
    }

    extractMarketPrice(candle: any): { marketPrice: any; timestamp: any } {
        return { marketPrice: candle.close, timestamp: candle.timestamp };
    }
}

function createSource(type: string, config: JsonFileConfig | MarketAdapterConfig): JsonFileSource | MarketAdapterSource {
    switch (type.toLowerCase()) {
        case 'json':
            return new JsonFileSource(config as JsonFileConfig);
        case 'market_adapter':
            return new MarketAdapterSource(config as MarketAdapterConfig);
        default:
            throw new Error(`[PriceSource] Unknown type: ${type}`);
    }
}

export { createSource }

