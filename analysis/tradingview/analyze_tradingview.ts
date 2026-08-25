#!/usr/bin/env node
'use strict';


import fs from 'node:fs';
import path from 'node:path';
import { generateHTML } from './tradingview_uplot_chart_generator.js';
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { loadCandleFile } from '../math_utils.js';
import { getErrorMessage } from '../../modules/utils/errors.js';
import { toIntervalLabel } from '../../market_adapter/interval_utils.js';
import { loadBotMeta } from '../bot_key_utils.js';
import { resolveSource, listAvailableBots } from '../resolve_source.js';
import { writeChartFile } from '../chart_utils.js';
import { PATHS } from '../../modules/paths.js';


const DEFAULT_CHART_DIR = PATHS.ANALYSIS.CHARTS_DIR;
const DEFAULT_CHART_FILE = path.join(DEFAULT_CHART_DIR, 'tradingview_chart.html');
const DEFAULT_AMA = MARKET_ADAPTER.AMAS.AMA3;
const AMA_KEYWORDS = new Set(['ama', 'ama1', 'ama2', 'ama3', 'ama4']);

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: { filePath: any; botKey?: any } };
        chartFile: string;
        title: string | null;
        priceScale: string;
        smaPeriod: number;
        amaErPeriod: number | undefined;
        amaFastPeriod: number | undefined;
        amaSlowPeriod: number | undefined;
        smaEnabled: boolean;
        amaEnabled: boolean;
        vwapEnabled: boolean;
        vwapBars: number;
        quiet: boolean;
        listBots: boolean;
    } = {
        source: { type: 'market_adapter', config: { botKey: '', filePath: undefined as any } },
        chartFile: DEFAULT_CHART_FILE,
        title: null,
        priceScale: 'log',
        smaPeriod: 500,
        amaErPeriod: undefined,
        amaFastPeriod: undefined,
        amaSlowPeriod: undefined,
        smaEnabled: false,
        amaEnabled: true,
        vwapEnabled: false,
        vwapBars: 500,
        quiet: false,
        listBots: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--source') config.source.type = String(args[++i] || 'json');
        else if (arg === '--file') {
            config.source.type = 'json';
            config.source.config.filePath = args[++i];
        }
        else if (arg === '--bot-key') config.source.config.botKey = args[++i];
        else if (arg === '--chart') config.chartFile = args[++i];
        else if (arg === '--title') config.title = args[++i];
        else if (arg === '--price-scale' || arg === '--scale') config.priceScale = String(args[++i] || 'log');
        else if (arg === '--sma-period') config.smaPeriod = Math.max(1, parseInt(args[++i], 10) || 500);
        else if (arg === '--ama-er-period') config.amaErPeriod = Math.max(1, parseInt(args[++i], 10) || DEFAULT_AMA.erPeriod);
        else if (arg === '--ama-fast-period') config.amaFastPeriod = Math.max(0.1, parseFloat(args[++i]) || DEFAULT_AMA.fastPeriod);
        else if (arg === '--ama-slow-period') config.amaSlowPeriod = Math.max(0.1, parseFloat(args[++i]) || DEFAULT_AMA.slowPeriod);
        else if (arg === '--no-sma') config.smaEnabled = false;
        else if (arg === '--no-ama') config.amaEnabled = false;
        else if (arg === '--no-vwap') config.vwapEnabled = false;
        else if (arg === '--vwap-bars') config.vwapBars = Math.max(24, parseInt(args[++i], 10) || 500);
        else if (arg === '--list-bots') config.listBots = true;
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

function loadJsonMeta(filePath: any) {
    if (!filePath || !fs.existsSync(filePath)) return { meta: null, candles: null };
    return loadCandleFile(filePath);
}

function inferTitle(meta: any, fallback: string) {
    const pool = meta?.pool ? `Pool ${String(meta.pool).replace(/^1\.19\./, '')}` : null;
    const a = meta?.assetA?.symbol || meta?.assetA?.id || null;
    const b = meta?.assetB?.symbol || meta?.assetB?.id || null;
    const pair = a && b ? `${a}/${b}` : fallback;
    const label = pool || pair;
    const interval = Number(meta?.intervalSeconds) > 0 ? toIntervalLabel(meta.intervalSeconds) : '1h';
    return `${label} · ${interval} · TradingView`;
}

async function main() {
    try {
        const config = parseArgs();

        if (config.listBots) {
            listAvailableBots();
            return;
        }

        const { source, botKey, amaConfig } = resolveSource({ ...config.source.config, type: config.source.type }, { quiet: config.quiet });
        if (!config.quiet) console.log(`[TradingView] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const isJsonSource = config.source.type === 'json';
        const filePath = config.source.config.filePath;
        const rawJson = isJsonSource ? loadJsonMeta(filePath) : { meta: null, candles: null };
        const botMeta = botKey ? loadBotMeta(botKey) : null;
        const jsonMeta = rawJson.meta || (botMeta ? {
            assetA: { symbol: botMeta.assetA },
            assetB: { symbol: botMeta.assetB },
            intervalSeconds: 3600,
        } : null);
        const title = config.title || inferTitle(jsonMeta, path.basename(filePath || 'tradingview'));
        const hasAmaGridPrice = AMA_KEYWORDS.has(String(botMeta?.gridPrice || '').trim().toLowerCase());
        const amaEnabled = hasAmaGridPrice ? config.amaEnabled : false;

        const html = generateHTML({
            candles,
            meta: jsonMeta || {
                assetA: { symbol: 'Asset A' },
                assetB: { symbol: 'Asset B' },
            },
            smaPeriod: config.smaPeriod,
            amaDefaults: {
                erPeriod: config.amaErPeriod ?? amaConfig.erPeriod,
                fastPeriod: config.amaFastPeriod ?? amaConfig.fastPeriod,
                slowPeriod: config.amaSlowPeriod ?? amaConfig.slowPeriod,
            },
            smaEnabled: config.smaEnabled,
            amaEnabled,
            vwapEnabled: config.vwapEnabled,
            vwapBars: config.vwapBars,
            priceScale: config.priceScale === 'linear' ? 'linear' : 'log',
            defaultTimeframe: '1h',
            marketAdapter: MARKET_ADAPTER,
        }, title);

        writeChartFile(config.chartFile, html);

        if (!config.quiet) console.log(`[TradingView] ✓ Chart saved to ${config.chartFile}`);
    } catch (err: any) {
        console.error(`[TradingView] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });

export { main, parseArgs, loadJsonMeta, inferTitle }
