#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { createSource } = require('../price_sources');
const { generateHTML, loadMarketProfiles } = require('./tradingview_uplot_chart_generator');
const { MARKET_ADAPTER } = require('../../modules/constants');
const { loadCandleFile } = require('../math_utils');
const { ensureDir } = require('../../modules/utils/fs_utils');
const { toIntervalLabel } = require('../../market_adapter/interval_utils');
const { loadBotSettings, sanitizeKey, computeBotKey, resolveBotKey, resolveCandleFile, candleFileForBot } = require('../bot_key_utils');

const { PATHS } = require('../../modules/paths');
const INTERVAL_LABEL = MARKET_ADAPTER.RUNTIME_DEFAULTS.intervalLabel;
const DEFAULT_CHART_DIR = PATHS.ANALYSIS.CHARTS_DIR;
const DEFAULT_CHART_FILE = path.join(DEFAULT_CHART_DIR, 'tradingview_chart.html');
const DEFAULT_AMA = MARKET_ADAPTER.AMAS.AMA3;
const DEFAULT_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;

function parseArgs() {
    const args = process.argv.slice(2);
    const config: {
        source: { type: string; config: { filePath: any; botKey?: any; assetA?: any; assetB?: any } };
        chartFile: string;
        title: string | null;
        priceScale: string;
        smaPeriod: number;
        amaErPeriod: number;
        amaFastPeriod: number;
        amaSlowPeriod: number;
        smaEnabled: boolean;
        amaEnabled: boolean;
        vwapEnabled: boolean;
        vwapBars: number;
        quiet: boolean;
    } = {
        source: { type: 'json', config: { filePath: null as any } },
        chartFile: DEFAULT_CHART_FILE,
        title: null,
        priceScale: 'log',
        smaPeriod: 500,
        amaErPeriod: DEFAULT_AMA.erPeriod,
        amaFastPeriod: DEFAULT_AMA.fastPeriod,
        amaSlowPeriod: DEFAULT_AMA.slowPeriod,
        smaEnabled: false,
        amaEnabled: true,
        vwapEnabled: false,
        vwapBars: 500,
        quiet: false,
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
        else if (arg === '--quiet') config.quiet = true;
    }

    return config;
}

function loadJsonMeta(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return { meta: null, candles: null };
    return loadCandleFile(filePath);
}

function loadBotMeta(botKey, filePath = DEFAULT_BOTS_FILE) {
    const settings = loadBotSettings(filePath);
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    if (!botKey) return null;
    const normalizedKey = String(botKey).toLowerCase();
    const exact = entries.find((bot, index) => {
      return computeBotKey(bot, index) === normalizedKey;
    });
    if (exact) return exact;
    const loose = entries.find((bot) => sanitizeKey(bot?.name) === normalizedKey.replace(/-\d+$/, ''));
    return loose || null;
}

function inferTitle(meta, fallback) {
    const pool = meta?.pool ? `Pool ${String(meta.pool).replace(/^1\.19\./, '')}` : null;
    const a = meta?.assetA?.symbol || meta?.assetA?.id || null;
    const b = meta?.assetB?.symbol || meta?.assetB?.id || null;
    const pair = a && b ? `${a}/${b}` : fallback;
    const label = pool || pair;
    const interval = Number(meta?.intervalSeconds) > 0 ? toIntervalLabel(meta.intervalSeconds) : '1h';
    return `${label} · ${interval} · TradingView`;
}

function resolveMarketAdapterCandleFile(botKey) {
    if (!botKey) throw new Error('--bot-key is required when using --source market_adapter');
    const cached = resolveCandleFile(botKey, INTERVAL_LABEL);
    if (cached) return cached;
    throw new Error(`Market adapter candle file not found for bot '${botKey}': ${candleFileForBot(botKey, INTERVAL_LABEL)}`);
}

async function main() {
    try {
        const config = parseArgs();
        if (config.source.type === 'json' && !config.source.config.filePath) {
            throw new Error('--file <path-to-candles.json> is required (or use --source market_adapter)');
        }
        const srcConfig = config.source.config;
        const isMarketAdapterSource = config.source.type === 'market_adapter';
        if (isMarketAdapterSource) {
            const candleFile = resolveMarketAdapterCandleFile(srcConfig.botKey);
            srcConfig.filePath = candleFile;
            const botMeta = loadBotMeta(srcConfig.botKey);
            if (botMeta && !srcConfig.assetA && !srcConfig.assetB) {
                srcConfig.assetA = botMeta.assetA;
                srcConfig.assetB = botMeta.assetB;
            }
            config.source.type = 'json';
        }

        const source = createSource(config.source.type, srcConfig);
        if (!config.quiet) console.log(`[TradingView] Loading candles from ${source.name}...`);

        const candles = await source.fetchCandles();
        if (!Array.isArray(candles) || candles.length === 0) {
            throw new Error('No candles returned from source');
        }

        const rawJson = config.source.type === 'json' ? loadJsonMeta(srcConfig.filePath) : { meta: null, candles: null };
        const botMeta = isMarketAdapterSource ? loadBotMeta(srcConfig.botKey) : null;
        const jsonMeta = rawJson.meta || (botMeta ? {
            assetA: { symbol: botMeta.assetA },
            assetB: { symbol: botMeta.assetB },
            intervalSeconds: 3600,
        } : null);
        const title = config.title || inferTitle(jsonMeta, path.basename(srcConfig.filePath || 'tradingview'));
        const marketProfiles = loadMarketProfiles();
        const selectedProfile = botMeta && marketProfiles?.profiles
            ? marketProfiles.profiles.find((entry) => String(entry.assetA) === String(botMeta.assetA) && String(entry.assetB) === String(botMeta.assetB) && Number(entry.intervalSeconds) === 3600)
            : null;
        const profileAma = selectedProfile?.amas?.[selectedProfile.defaultAma] || null;
        const botAma = (botMeta?.ama && typeof botMeta.ama === 'object') ? botMeta.ama : null;
        const selectedAma = botAma || profileAma;
        const hasAmaGridPrice = botMeta?.gridPrice && String(botMeta.gridPrice).toLowerCase().startsWith('ama');
        const amaEnabled = hasAmaGridPrice ? config.amaEnabled : false;

        const html = generateHTML({
            candles,
            meta: jsonMeta || {
                assetA: { symbol: 'Asset A' },
                assetB: { symbol: 'Asset B' },
            },
            smaPeriod: config.smaPeriod,
            amaDefaults: selectedAma ? {
                erPeriod: botAma?.erPeriod || selectedAma.erPeriod,
                fastPeriod: botAma?.fastPeriod || selectedAma.fastPeriod,
                slowPeriod: botAma?.slowPeriod || selectedAma.slowPeriod,
            } : {
                erPeriod: config.amaErPeriod,
                fastPeriod: config.amaFastPeriod,
                slowPeriod: config.amaSlowPeriod,
            },
            smaEnabled: config.smaEnabled,
            amaEnabled,
            vwapEnabled: config.vwapEnabled,
            vwapBars: config.vwapBars,
            priceScale: config.priceScale === 'linear' ? 'linear' : 'log',
            defaultTimeframe: '1h',
            marketAdapter: MARKET_ADAPTER,
            marketProfiles,
        }, title);

        const chartDir = path.dirname(config.chartFile);
        if (!fs.existsSync(chartDir)) ensureDir(chartDir);
        fs.writeFileSync(config.chartFile, html, 'utf8');

        if (!config.quiet) console.log(`[TradingView] ✓ Chart saved to ${config.chartFile}`);
    } catch (err) {
        console.error(`[TradingView] Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

export = {
    main,
    parseArgs,
    loadJsonMeta,
    loadBotSettings,
    loadBotMeta,
    inferTitle,
};
