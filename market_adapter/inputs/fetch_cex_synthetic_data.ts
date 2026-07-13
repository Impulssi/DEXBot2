#!/usr/bin/env node
'use strict';

/**
 * Probe public CEX APIs for XRP/USDT and XAUT/USDT, then synthesize XRP/XAUT
 * candles from the two USDT legs.
 *
 * This is intended as a seed generator for brand-new market_adapter files.
 * It does not rely on TradingView or Kibana.
 */
const { path } = require('../../modules/path_api');
const { getStorage } = require('../../modules/storage');
const storage = getStorage();
const { fillCandleGaps } = require('../candle_utils');
const { writeJsonAtomic } = require('../utils/atomic_write');
const { parseJsonWithComments } = require('../../modules/order/utils/system');
const { createBotKey } = require('../../modules/account_orders');
const { PATHS } = require('../../modules/paths');
const PROJECT_ROOT = PATHS.PROJECT_ROOT;
const { MARKET_ADAPTER } = require('../../modules/constants');
const { getAmaWarmupBars } = require('../core/strategies/ama');
const {
    DEFAULTS: MARKET_ADAPTER_DEFAULTS,
    resolveAmaForBot,
    resolveBotCfg,
} = require('../market_adapter');

const DEFAULT_INTERVAL = '1h';
const DEFAULT_LIMIT = 1000;
const DEFAULT_BASE = 'XRP';
const DEFAULT_QUOTE = 'XAUT';
const DEFAULT_COMMON_QUOTE = 'USDT';
const DEFAULT_BOOTSTRAP_LOOKBACK_HOURS = 720;
const DEFAULT_BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const DEFAULT_EXCHANGES = [
    'bybit',
    'htx',
    'mexc',
];

function upper(value) {
    return String(value || '').trim().toUpperCase();
}

function lower(value) {
    return String(value || '').trim().toLowerCase();
}

function parseInterval(raw) {
    const value = String(raw || DEFAULT_INTERVAL).trim().toLowerCase();
    const map = {
        '1m': { seconds: 60, label: '1m' },
        '5m': { seconds: 300, label: '5m' },
        '15m': { seconds: 900, label: '15m' },
        '30m': { seconds: 1800, label: '30m' },
        '1h': { seconds: 3600, label: '1h' },
        '4h': { seconds: 14400, label: '4h' },
        '6h': { seconds: 21600, label: '6h' },
        '12h': { seconds: 43200, label: '12h' },
        '1d': { seconds: 86400, label: '1d' },
        '1w': { seconds: 604800, label: '1w' },
    };

    if (map[value]) return map[value];
    if (/^\d+$/.test(value)) {
        const minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes <= 0) {
            throw new Error(`Invalid interval: ${raw}`);
        }
        return { seconds: minutes * 60, label: `${minutes}m` };
    }

    throw new Error(`Unsupported interval: ${raw}`);
}

function sanitizePart(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';
}

function sanitizeBotKeyPart(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'bot';
}

function loadBotNameIndex(botsFile) {
    try {
        if (!botsFile || !storage.exists(botsFile)) return [];
        const raw = storage.readFile(botsFile, 'utf8');
        if (!raw.trim()) return [];
        const parsed = parseJsonWithComments(raw);
        const bots = Array.isArray(parsed?.bots) ? parsed.bots : [];
        return bots
            .map((bot, index) => ({ bot, index }))
            .filter(({ bot }) => bot && typeof bot === 'object' && bot.name);
    } catch (_err) {
        return [];
    }
}

function resolveBotEntryFromIdentity(config) {
    const botName = String(config.botName || '').trim();
    if (!botName) return null;

    const botsFile = config.botsFile ? String(config.botsFile) : DEFAULT_BOTS_FILE;
    const entries = loadBotNameIndex(botsFile);
    const match = entries.find(({ bot }) => String(bot.name || '').trim() === botName);
    return match || null;
}

function resolveBotKeyFromIdentity(config) {
    if (config.botKey) return String(config.botKey).trim();

    const match = resolveBotEntryFromIdentity(config);
    if (match) return createBotKey(match.bot, match.index);

    return null;
}

function normalizeCexAssetSymbol(value) {
    const raw = upper(value);
    if (!raw) return raw;
    const knownGatewayPrefixes = [
        'IOB.',
        'XBTSX.',
        'BTWTY.',
        'XBTS.',
        'GDEX.',
        'RUDEX.',
        'BRIDGE.',
        'OPEN.',
        'HONEST.',
    ];
    for (const prefix of knownGatewayPrefixes) {
        if (raw.startsWith(prefix) && raw.length > prefix.length) {
            return raw.slice(prefix.length);
        }
    }
    return raw;
}

function resolveBotContextFromIdentity(config) {
    const match = resolveBotEntryFromIdentity(config);
    if (!match) return null;
    return {
        bot: {
            ...match.bot,
            botKey: createBotKey(match.bot, match.index),
        },
        index: match.index,
    };
}

function normalizeBaseAsset(base, symbol) {
    const rawBase = upper(base);
    const rawSymbol = upper(symbol);
    const goldMatch = rawBase.match(/^GOLD\(([^)]+)\)$/);
    if (goldMatch && goldMatch[1]) {
        return upper(goldMatch[1]);
    }
    if (rawSymbol.includes('XAUT') && rawBase.includes('GOLD')) {
        return 'XAUT';
    }
    return rawBase;
}

function normalizeTimestamp(raw) {
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return null;
    return ts >= 1e12 ? Math.trunc(ts) : Math.trunc(ts * 1000);
}

function computeRequiredCandles(amaConfig = null, cfg = null) {
    const ama = amaConfig || MARKET_ADAPTER.AMAS[MARKET_ADAPTER.DEFAULT_AMA_KEY] || MARKET_ADAPTER.AMAS.AMA3;
    if (!ama) return DEFAULT_BOOTSTRAP_LOOKBACK_HOURS;

    const warmupBars = getAmaWarmupBars(
        ama.erPeriod,
        ama.slowPeriod,
        cfg?.amaSlope?.lookbackBars ?? MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        ama.fastPeriod,
        MARKET_ADAPTER.AMA_ER_SMOOTH_FAST_PERIOD
    );
    const analysisKeepCount = warmupBars + 1;
    return Math.max(DEFAULT_BOOTSTRAP_LOOKBACK_HOURS, analysisKeepCount);
}

function candlesToLookbackHours(candleCount, intervalSeconds) {
    const candles = Number(candleCount);
    const seconds = Number(intervalSeconds);
    if (!Number.isFinite(candles) || candles <= 0) return 0;
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.ceil((candles * seconds) / 3600);
}

function lookbackHoursToCandles(lookbackHours, intervalSeconds) {
    const hours = Number(lookbackHours);
    const seconds = Number(intervalSeconds);
    if (!Number.isFinite(hours) || hours <= 0) return 0;
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.ceil((hours * 3600) / seconds);
}

function measureCandles(candles, intervalSeconds) {
    const rows = Array.isArray(candles) ? candles.filter((row) => Array.isArray(row) && Number.isFinite(row[0])) : [];
    if (rows.length === 0) {
        return {
            count: 0,
            oldestTs: null,
            newestTs: null,
            spanHours: 0,
        };
    }
    const sorted = rows.slice().sort((a, b) => a[0] - b[0]);
    const oldestTs = sorted[0][0];
    const newestTs = sorted[sorted.length - 1][0];
    const intervalMs = Math.max(1, Number(intervalSeconds || 3600)) * 1000;
    return {
        count: sorted.length,
        oldestTs,
        newestTs,
        spanHours: ((newestTs - oldestTs) + intervalMs) / 3600000,
    };
}

async function fetchJson(url, { headers = {}, timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: {
                'accept': 'application/json',
                'user-agent': 'Mozilla/5.0',
                ...headers,
            },
            signal: controller.signal,
        });
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (_err) {
            json = null;
        }
        return { ok: res.ok, status: res.status, statusText: res.statusText, json, text };
    } finally {
        clearTimeout(timer);
    }
}

function marketRow(base, quote, id, extra = {}) {
    return {
        base: upper(base),
        quote: upper(quote),
        id: String(id),
        ...extra,
    };
}

function extractMarketsFromList(list: any, mapper: (row: any) => any) {
    const rows = Array.isArray(list) ? list : [];
    return rows.map(mapper).filter((row: any) => row && row.id && row.base && row.quote);
}

const EXCHANGES = {
    binance: {
        name: 'Binance',
        formatInterval: (interval) => interval,
        marketsUrl: 'https://api.binance.com/api/v3/exchangeInfo',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }) => {
            const url = new URL('https://api.binance.com/api/v3/klines');
            url.searchParams.set('symbol', id);
            url.searchParams.set('interval', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('startTime', String(Math.max(0, Math.trunc(sinceMs))));
            if (untilMs != null) url.searchParams.set('endTime', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json) => extractMarketsFromList(json?.symbols, (row) => marketRow(
            row.baseAsset,
            row.quoteAsset,
            row.symbol,
            { status: row.status }
        )),
        parseCandles: (json) => {
            const rows = Array.isArray(json) ? json : [];
            return rows
                .map((row) => {
                    if (!Array.isArray(row) || row.length < 6) return null;
                    const ts = normalizeTimestamp(row[0]);
                    const open = Number(row[1]);
                    const high = Number(row[2]);
                    const low = Number(row[3]);
                    const close = Number(row[4]);
                    const volume = Number(row[5]);
                    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
        },
    },
    bybit: {
        name: 'Bybit',
        formatInterval: (interval) => {
            const map = {
                '1m': '1',
                '5m': '5',
                '15m': '15',
                '30m': '30',
                '1h': '60',
                '4h': '240',
                '6h': '360',
                '12h': '720',
                '1d': 'D',
                '1w': 'W',
            };
            return map[lower(interval)] || interval;
        },
        marketsUrl: 'https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }) => {
            const url = new URL('https://api.bybit.com/v5/market/kline');
            url.searchParams.set('category', 'spot');
            url.searchParams.set('symbol', id);
            url.searchParams.set('interval', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('start', String(Math.max(0, Math.trunc(sinceMs))));
            if (untilMs != null) url.searchParams.set('end', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json) => extractMarketsFromList(json?.result?.list, (row) => marketRow(
            row.baseCoin,
            row.quoteCoin,
            row.symbol,
            { status: row.status }
        )),
        parseCandles: (json) => {
            const rows = Array.isArray(json?.result?.list) ? json.result.list : [];
            return rows
                .map((row) => {
                    if (!Array.isArray(row) || row.length < 6) return null;
                    const ts = normalizeTimestamp(row[0]);
                    const open = Number(row[1]);
                    const high = Number(row[2]);
                    const low = Number(row[3]);
                    const close = Number(row[4]);
                    const volume = Number(row[5]);
                    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
        },
    },
    gate: {
        name: 'Gate',
        formatInterval: (interval) => interval,
        marketsUrl: 'https://api.gateio.ws/api/v4/spot/currency_pairs',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }) => {
            const url = new URL('https://api.gateio.ws/api/v4/spot/candlesticks');
            url.searchParams.set('currency_pair', id);
            url.searchParams.set('interval', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('from', String(Math.max(0, Math.trunc(sinceMs / 1000))));
            if (untilMs != null) url.searchParams.set('to', String(Math.max(0, Math.trunc(untilMs / 1000))));
            return url.toString();
        },
        parseMarkets: (json) => extractMarketsFromList(json, (row) => marketRow(
            row.base,
            row.quote,
            row.id,
            { tradeStatus: row.trade_status }
        )),
        parseCandles: (json) => {
            const rows = Array.isArray(json) ? json : [];
            return rows
                .map((row) => {
                    if (!Array.isArray(row) || row.length < 7) return null;
                    const ts = normalizeTimestamp(row[0]);
                    const close = Number(row[2]);
                    const high = Number(row[3]);
                    const low = Number(row[4]);
                    const open = Number(row[5]);
                    const volume = Number(row[6]);
                    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
        },
    },
    bitget: {
        name: 'Bitget',
        formatInterval: (interval) => {
            const map = {
                '1m': '1m',
                '5m': '5m',
                '15m': '15m',
                '30m': '30m',
                '1h': '1h',
                '4h': '4h',
                '6h': '6h',
                '12h': '12h',
                '1d': '1d',
                '1w': '1w',
            };
            return map[lower(interval)] || interval;
        },
        marketsUrl: 'https://api.bitget.com/api/v2/spot/public/symbols',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }) => {
            const url = new URL('https://api.bitget.com/api/v2/spot/market/candles');
            url.searchParams.set('symbol', id);
            url.searchParams.set('granularity', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('startTime', String(Math.max(0, Math.trunc(sinceMs))));
            if (untilMs != null) url.searchParams.set('endTime', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json) => extractMarketsFromList(json?.data, (row) => marketRow(
            row.baseCoin,
            row.quoteCoin,
            row.symbol,
            { status: row.status }
        )),
        parseCandles: (json) => {
            const rows = Array.isArray(json?.data) ? json.data : [];
            return rows
                .map((row) => {
                    if (!Array.isArray(row) || row.length < 6) return null;
                    const ts = normalizeTimestamp(row[0]);
                    const open = Number(row[1]);
                    const high = Number(row[2]);
                    const low = Number(row[3]);
                    const close = Number(row[4]);
                    const volume = Number(row[5]);
                    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
        },
    },
    kucoin: {
        name: 'KuCoin',
        formatInterval: (interval) => {
            const map = {
                '1m': '1min',
                '5m': '5min',
                '15m': '15min',
                '30m': '30min',
                '1h': '1hour',
                '4h': '4hour',
                '6h': '6hour',
                '12h': '12hour',
                '1d': '1day',
                '1w': '1week',
            };
            return map[lower(interval)] || interval;
        },
        marketsUrl: 'https://api.kucoin.com/api/v2/symbols',
        candlesUrl: ({ id, interval, intervalSeconds, limit, sinceMs, untilMs }) => {
            const url = new URL('https://api.kucoin.com/api/v1/market/candles');
            url.searchParams.set('symbol', id);
            url.searchParams.set('type', interval);
            if (sinceMs != null) url.searchParams.set('startAt', String(Math.max(0, Math.trunc(sinceMs / 1000))));
            if (untilMs != null) url.searchParams.set('endAt', String(Math.max(0, Math.trunc(untilMs / 1000))));
            return url.toString();
        },
        parseMarkets: (json) => extractMarketsFromList(json?.data, (row) => marketRow(
            row.baseCurrency,
            row.quoteCurrency,
            row.symbol,
            { enableTrading: row.enableTrading }
        )),
        parseCandles: (json) => {
            const rows = Array.isArray(json?.data) ? json.data : [];
            return rows
                .map((row) => {
                    if (!Array.isArray(row) || row.length < 6) return null;
                    const ts = normalizeTimestamp(row[0]);
                    const open = Number(row[1]);
                    const close = Number(row[2]);
                    const high = Number(row[3]);
                    const low = Number(row[4]);
                    const volume = Number(row[5]);
                    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
        },
    },
    htx: {
        name: 'HTX',
        formatInterval: (interval) => {
            const map = {
                '1m': '1min',
                '5m': '5min',
                '15m': '15min',
                '30m': '30min',
                '1h': '60min',
                '4h': '4hour',
                '6h': '6hour',
                '12h': '12hour',
                '1d': '1day',
                '1w': '1week',
            };
            return map[lower(interval)] || interval;
        },
        marketsUrl: 'https://api.htx.com/v1/common/symbols',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }) => {
            const url = new URL('https://api.htx.com/market/history/candles');
            url.searchParams.set('symbol', id);
            url.searchParams.set('period', interval);
            url.searchParams.set('size', String(limit));
            if (sinceMs != null) url.searchParams.set('from', String(Math.max(0, Math.trunc(sinceMs / 1000))));
            if (untilMs != null) url.searchParams.set('to', String(Math.max(0, Math.trunc(untilMs / 1000))));
            return url.toString();
        },
        parseMarkets: (json) => extractMarketsFromList(json?.data || json, (row) => {
            const base = row.baseCurrency || row['base-currency'] || row.base_currency;
            const quote = row.quoteCurrency || row['quote-currency'] || row.quote_currency;
            const id = row.symbol || row['symbol'];
            return marketRow(base, quote, id, { state: row.state });
        }),
        parseCandles: (json) => {
            const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
            return rows
                .map((row) => {
                    if (Array.isArray(row)) {
                        if (row.length < 6) return null;
                        const ts = normalizeTimestamp(row[0]);
                        const open = Number(row[1]);
                        const close = Number(row[2]);
                        const high = Number(row[3]);
                        const low = Number(row[4]);
                        const volume = Number(row[5]);
                        if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                        return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                    }
                    if (!row || typeof row !== 'object') return null;
                    const ts = normalizeTimestamp(row.id ?? row.timestamp ?? row.time);
                    const open = Number(row.open);
                    const high = Number(row.high);
                    const low = Number(row.low);
                    const close = Number(row.close);
                    const volume = Number(row.amount ?? row.vol ?? row.volume ?? 0);
                    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
        },
    },
    kraken: {
        name: 'Kraken',
        formatInterval: (interval) => {
            const map = {
                '1m': '1',
                '5m': '5',
                '15m': '15',
                '30m': '30',
                '1h': '60',
                '4h': '240',
                '1d': '1440',
                '1w': '10080',
            };
            return map[lower(interval)] || interval;
        },
        marketsUrl: 'https://api.kraken.com/0/public/AssetPairs',
        candlesUrl: ({ id, interval, intervalSeconds, limit, sinceMs, untilMs }) => {
            const url = new URL('https://api.kraken.com/0/public/OHLC');
            url.searchParams.set('pair', id);
            url.searchParams.set('interval', interval);
            const since = sinceMs != null ? Math.max(0, Math.floor(sinceMs / 1000) - Math.max(1, Math.floor(Number(intervalSeconds || 3600)))) : Math.max(0, Math.floor(Date.now() / 1000) - Math.floor((Number(limit) || DEFAULT_LIMIT) * Number(intervalSeconds || 3600)));
            url.searchParams.set('since', String(since));
            return url.toString();
        },
        parseMarkets: (json: any) => {
            const entries = Object.entries(json?.result || {});
            return entries.map(([key, row]: [string, any]) => {
                const ws = String(row.wsname || '').toUpperCase();
                const [baseFromWs, quoteFromWs] = ws.includes('/') ? ws.split('/') : [null, null];
                const base = baseFromWs || upper(row.base);
                const quote = quoteFromWs || upper(row.quote);
                const id = row.altname || key;
                return marketRow(base, quote, id, { wsname: row.wsname });
            }).filter((row: any) => row.id && row.base && row.quote);
        },
        parseCandles: (json) => {
            const result = json?.result || {};
            const pairKey = Object.keys(result).find((key) => key !== 'last');
            const rows = Array.isArray(result[pairKey]) ? result[pairKey] : [];
            return rows
                .map((row) => {
                    if (!Array.isArray(row) || row.length < 7) return null;
                    const ts = normalizeTimestamp(Number(row[0]) * 1000);
                    const open = Number(row[1]);
                    const high = Number(row[2]);
                    const low = Number(row[3]);
                    const close = Number(row[4]);
                    const volume = Number(row[6]);
                    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
        },
    },
    okx: {
        name: 'OKX',
        formatInterval: (interval) => {
            const map = {
                '1m': '1m',
                '5m': '5m',
                '15m': '15m',
                '30m': '30m',
                '1h': '1H',
                '4h': '4H',
                '6h': '6H',
                '12h': '12H',
                '1d': '1D',
                '1w': '1W',
            };
            return map[lower(interval)] || interval;
        },
        marketsUrl: 'https://www.okx.com/api/v5/public/instruments?instType=SPOT',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }) => {
            const url = new URL('https://www.okx.com/api/v5/market/candles');
            url.searchParams.set('instId', id);
            url.searchParams.set('bar', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('before', String(Math.max(0, Math.trunc(sinceMs - 1))));
            if (untilMs != null) url.searchParams.set('after', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json) => extractMarketsFromList(json?.data, (row) => marketRow(
            row.baseCcy,
            row.quoteCcy,
            row.instId,
            { state: row.state }
        )),
        parseCandles: (json) => {
            const rows = Array.isArray(json?.data) ? json.data : [];
            return rows
                .map((row) => {
                    if (!Array.isArray(row) || row.length < 6) return null;
                    const ts = normalizeTimestamp(row[0]);
                    const open = Number(row[1]);
                    const high = Number(row[2]);
                    const low = Number(row[3]);
                    const close = Number(row[4]);
                    const volume = Number(row[5]);
                    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
        },
    },
    mexc: {
        name: 'MEXC',
        formatInterval: (interval) => {
            const map = {
                '1m': '1m',
                '5m': '5m',
                '15m': '15m',
                '30m': '30m',
                '1h': '60m',
                '4h': '4h',
                '1d': '1d',
                '1w': '1w',
            };
            return map[lower(interval)] || interval;
        },
        marketsUrl: 'https://api.mexc.com/api/v3/exchangeInfo',
        candlesUrl: ({ id, interval, limit, sinceMs, untilMs }) => {
            const url = new URL('https://api.mexc.com/api/v3/klines');
            url.searchParams.set('symbol', id);
            url.searchParams.set('interval', interval);
            url.searchParams.set('limit', String(limit));
            if (sinceMs != null) url.searchParams.set('startTime', String(Math.max(0, Math.trunc(sinceMs))));
            if (untilMs != null) url.searchParams.set('endTime', String(Math.max(0, Math.trunc(untilMs))));
            return url.toString();
        },
        parseMarkets: (json) => extractMarketsFromList(json?.symbols, (row) => marketRow(
            normalizeBaseAsset(row.baseAsset, row.symbol),
            row.quoteAsset,
            row.symbol,
            { status: row.status }
        )),
        parseCandles: (json) => {
            const rows = Array.isArray(json) ? json : [];
            return rows
                .map((row) => {
                    if (!Array.isArray(row) || row.length < 6) return null;
                    const ts = normalizeTimestamp(row[0]);
                    const open = Number(row[1]);
                    const high = Number(row[2]);
                    const low = Number(row[3]);
                    const close = Number(row[4]);
                    const volume = Number(row[5]);
                    if (!Number.isFinite(ts) || ![open, high, low, close].every(Number.isFinite)) return null;
                    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
                })
                .filter(Boolean)
                .sort((a, b) => a[0] - b[0]);
        },
    },
};

function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        exchange: 'auto',
        interval: DEFAULT_INTERVAL,
        limit: DEFAULT_LIMIT,
        lookbackHours: null,
        botName: null,
        botIndex: null,
        botsFile: DEFAULT_BOTS_FILE,
        base: DEFAULT_BASE,
        quote: DEFAULT_QUOTE,
        commonQuote: DEFAULT_COMMON_QUOTE,
        botKey: null,
        out: null,
        checkOnly: false,
        quiet: false,
        baseProvided: false,
        quoteProvided: false,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        switch (arg) {
            case '--exchange':
                config.exchange = next;
                i++;
                break;
            case '--interval':
                config.interval = next;
                i++;
                break;
            case '--limit':
                config.limit = Number(next);
                i++;
                break;
            case '--lookback-hours':
            case '--lookbackHours':
                config.lookbackHours = Number(next);
                i++;
                break;
            case '--base':
            case '--base-asset':
                config.base = next;
                config.baseProvided = true;
                i++;
                break;
            case '--quote':
            case '--quote-asset':
                config.quote = next;
                config.quoteProvided = true;
                i++;
                break;
            case '--common-quote':
            case '--commonQuote':
                config.commonQuote = next;
                i++;
                break;
            case '--bot-key':
                config.botKey = next;
                i++;
                break;
            case '--bot-name':
                config.botName = next;
                i++;
                break;
            case '--bots-file':
                config.botsFile = next;
                i++;
                break;
            case '--out':
                config.out = next;
                i++;
                break;
            case '--check':
            case '--check-only':
                config.checkOnly = true;
                break;
            case '--quiet':
                config.quiet = true;
                break;
            case '--help':
            case '-h':
                config.help = true;
                break;
        }
    }

    return config;
}

function applyBotDerivedConfig(config) {
    const botContext = resolveBotContextFromIdentity(config);
    if (!botContext) {
        if (config.botName) {
            throw new Error(`Could not resolve bot name "${config.botName}" in ${config.botsFile || DEFAULT_BOTS_FILE}`);
        }
        return { config, botContext: null, botCfg: null, botAma: null };
    }

    const next = { ...config };
    if (!next.baseProvided && botContext.bot.assetA) {
        next.base = normalizeCexAssetSymbol(botContext.bot.assetA);
    }
    if (!next.quoteProvided && botContext.bot.assetB) {
        next.quote = normalizeCexAssetSymbol(botContext.bot.assetB);
    }

    const baseCfg = MARKET_ADAPTER_DEFAULTS || {
        amaSlope: {
            lookbackBars: MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        },
    };
    const botCfg = typeof resolveBotCfg === 'function'
        ? resolveBotCfg(botContext.bot, baseCfg)
        : baseCfg;
    const botAma = typeof resolveAmaForBot === 'function'
        ? resolveAmaForBot(botContext.bot, null, botCfg)
        : null;

    return { config: next, botContext, botCfg, botAma };
}

function printHelp() {
    console.log(`Usage:
  tsx market_adapter/inputs/fetch_cex_synthetic_data.ts [options]

Options:
  --exchange <name|auto>   Exchange to use or comma-separated preference list
  --interval <label>       Candle interval, default ${DEFAULT_INTERVAL}
  --limit <n>              Number of candles to fetch from each leg, default ${DEFAULT_LIMIT}
  --lookback-hours <n>     Probe depth in hours; default is the adapter seed requirement
  --base <asset>           Base asset, default ${DEFAULT_BASE}
  --quote <asset>          Synthetic quote asset, default ${DEFAULT_QUOTE}
  --common-quote <asset>   Common quote asset, default ${DEFAULT_COMMON_QUOTE}
  --bot-key <key>          Default output becomes market_adapter/data/market_adapter_<key>_<interval>.json
  --bot-name <name>        Resolve the output key from profiles/bots.json by bot name
  --bots-file <path>       Alternate bots.json file for resolving --bot-name
  --out <file>             Write to an explicit path
  --check-only             Probe markets and candle endpoints without writing output
  --quiet                  Suppress the summary table
`);
}

function normalizeExchangeList(raw) {
    const list = String(raw || 'auto')
        .split(',')
        .map((item) => lower(item))
        .filter(Boolean);
    if (list.length === 0 || (list.length === 1 && list[0] === 'auto')) {
        return DEFAULT_EXCHANGES.slice();
    }
    return list;
}

function findMarketId(markets, base, quote) {
    const targetBase = upper(base);
    const targetQuote = upper(quote);
    const market = markets.find((row) => upper(row.base) === targetBase && upper(row.quote) === targetQuote);
    return market || null;
}

function buildSyntheticCandle(left, right) {
    const open = left[1] / right[1];
    const close = left[4] / right[4];
    const high = Math.max(left[2] / right[3], open, close);
    const low = Math.min(left[3] / right[2], open, close);
    const volume = Number(left[5] || 0);
    return [left[0], open, high, low, close, Number.isFinite(volume) ? volume : 0];
}

function synthesizeCrossCandles(leftCandles: any[], rightCandles: any[]) {
    const leftMap = new Map<number, any[]>(leftCandles.map((row: any) => [row[0], row]));
    const rightMap = new Map<number, any[]>(rightCandles.map((row: any) => [row[0], row]));
    const timestamps = Array.from(leftMap.keys()).filter((ts: number) => rightMap.has(ts)).sort((a: number, b: number) => a - b);
    return timestamps.map((ts) => buildSyntheticCandle(leftMap.get(ts), rightMap.get(ts)));
}

function chooseOutputPath(config, intervalLabel) {
    if (config.out) return config.out;
    const botKey = resolveBotKeyFromIdentity(config);
    if (!botKey) {
        if (config.botName) {
            throw new Error(`Could not resolve bot name "${config.botName}" in ${config.botsFile || DEFAULT_BOTS_FILE}`);
        }
        throw new Error('Provide --bot-key or --out when generating candles');
    }
    return path.join(PROJECT_ROOT, 'market_adapter', 'data', `market_adapter_${botKey}_${intervalLabel}.json`);
}

function dedupeCandles(candles) {
    const map = new Map();
    for (const candle of Array.isArray(candles) ? candles : []) {
        if (!Array.isArray(candle) || !Number.isFinite(candle[0])) continue;
        map.set(candle[0], candle);
    }
    return [...map.values()].sort((a, b) => a[0] - b[0]);
}

async function fetchHistoricalCandles(def, marketId, interval, intervalSeconds, lookbackHours, pageLimit) {
    const apiInterval = def.formatInterval ? def.formatInterval(interval) : interval;
    const intervalMs = Math.max(1, Number(intervalSeconds || 3600)) * 1000;
    const endMs = Math.floor(Date.now() / intervalMs) * intervalMs;
    const lookbackMs = Math.max(1, Number(lookbackHours || DEFAULT_BOOTSTRAP_LOOKBACK_HOURS)) * 3600 * 1000;
    const startMs = Math.max(0, endMs - lookbackMs);
    const maxIterations = Math.ceil(lookbackMs / Math.max(intervalMs, pageLimit * intervalMs * 0.8)) + 8;
    let cursor = startMs;
    let collected = [];

    for (let i = 0; i < maxIterations && cursor <= endMs; i++) {
        const pageEnd = Math.min(endMs, cursor + intervalMs * Math.max(1, pageLimit - 1));
        const res = await fetchJson(def.candlesUrl({
            id: marketId,
            interval: apiInterval,
            intervalSeconds,
            limit: pageLimit,
            sinceMs: cursor,
            untilMs: pageEnd,
        }));
        if (!res.ok || !res.json) {
            console.warn(`[CEX] ${def.name}: HTTP ${res.status} ${res.statusText} at cursor=${cursor} — skipping page`);
            break;
        }

        const page = def.parseCandles(res.json);
        if (!Array.isArray(page) || page.length === 0) {
            break;
        }
        collected = collected.concat(page);

        const lastTs = page[page.length - 1][0];
        if (!Number.isFinite(lastTs) || lastTs <= cursor) {
            break;
        }

        cursor = lastTs + intervalMs;
        if (cursor > endMs) {
            break;
        }

        if (i < maxIterations - 1) {
            await new Promise(r => setTimeout(r, MARKET_ADAPTER.CEX_API_DELAY_MS));
        }
    }

    return dedupeCandles(collected);
}

async function probeExchange(exchangeId, base, quote, commonQuote, interval, intervalSeconds, requiredCandles, probeLookbackHours, pageLimit) {
    const def = EXCHANGES[exchangeId];
    if (!def) {
        return { exchangeId, error: `Unknown exchange: ${exchangeId}` };
    }

    try {
        const marketsRes = await fetchJson(def.marketsUrl);
        if (!marketsRes.ok || !marketsRes.json) {
            return {
                exchangeId,
                name: def.name,
                error: `markets HTTP ${marketsRes.status} ${marketsRes.statusText}`.trim(),
            };
        }

        const markets = def.parseMarkets(marketsRes.json);
        const xrpCommon = findMarketId(markets, base, commonQuote);
        const xautCommon = findMarketId(markets, quote, commonQuote);
        const nativeCross = findMarketId(markets, base, quote);

        const result: {
            exchangeId: any;
            name: any;
            markets: any;
            xrpCommon: any;
            xautCommon: any;
            nativeCross: any;
            xrpCandles: any[];
            xautCandles: any[];
            nativeCrossCandles: any[];
            requiredCandles: any;
            probeLookbackHours: any;
            probeCandles: number;
            hasUsableTimeframe?: boolean;
            lookbackSatisfied?: boolean;
            xrpRange?: { count: number; oldestTs: any; newestTs: any; spanHours: number } | null;
            xautRange?: { count: number; oldestTs: any; newestTs: any; spanHours: number } | null;
            availableCandles?: number;
            availableLookbackHours?: number;
        } = {
            exchangeId,
            name: def.name,
            markets,
            xrpCommon,
            xautCommon,
            nativeCross,
            xrpCandles: [],
            xautCandles: [],
            nativeCrossCandles: [],
            requiredCandles,
            probeLookbackHours,
            probeCandles: lookbackHoursToCandles(probeLookbackHours, intervalSeconds),
        };
        if (xrpCommon && xautCommon) {
            result.xrpCandles = await fetchHistoricalCandles(def, xrpCommon.id, interval, intervalSeconds, probeLookbackHours, pageLimit);
            result.xautCandles = await fetchHistoricalCandles(def, xautCommon.id, interval, intervalSeconds, probeLookbackHours, pageLimit);
            result.hasUsableTimeframe = result.xrpCandles.length > 0 && result.xautCandles.length > 0;
            result.lookbackSatisfied = result.xrpCandles.length >= result.requiredCandles
                && result.xautCandles.length >= result.requiredCandles;
            result.xrpRange = measureCandles(result.xrpCandles, intervalSeconds);
            result.xautRange = measureCandles(result.xautCandles, intervalSeconds);
            result.availableCandles = Math.min(result.xrpRange.count, result.xautRange.count);
            result.availableLookbackHours = Math.min(result.xrpRange.spanHours, result.xautRange.spanHours);
        }

        if (nativeCross) {
            const sampleLimit = Math.min(3, Math.max(1, Number(pageLimit) || DEFAULT_LIMIT));
            const nativeCandlesRes = await fetchJson(def.candlesUrl({
                id: nativeCross.id,
                interval: def.formatInterval ? def.formatInterval(interval) : interval,
                intervalSeconds,
                limit: sampleLimit,
            }));
            if (nativeCandlesRes.ok && nativeCandlesRes.json) {
                result.nativeCrossCandles = def.parseCandles(nativeCandlesRes.json);
            }
        }

        return result;
    } catch (err) {
        return {
            exchangeId,
            name: def.name,
            error: err.message,
        };
    }
}

function pickBestExchange(probes, preferredExchangeIds) {
    const preferred = (preferredExchangeIds || []).map((id) => lower(id));
    const ranked = rankProbes(probes, preferred, true);
    return ranked[0] || null;
}

function rankProbes(probes, preferredExchangeIds, onlyUsable = false) {
    const preferred = (preferredExchangeIds || []).map((id) => lower(id));
    return probes
        .filter((probe) => probe && !probe.error && probe.xrpCommon && probe.xautCommon && probe.hasUsableTimeframe)
        .map((probe) => ({
            ...probe,
            score: Math.min(probe.xrpRange?.count || 0, probe.xautRange?.count || 0),
            depthScore: Math.min(probe.xrpRange?.spanHours || 0, probe.xautRange?.spanHours || 0),
            preferredRank: preferred.length > 0 ? preferred.indexOf(lower(probe.exchangeId)) : -1,
            usable: Boolean(probe.lookbackSatisfied),
        }))
        .filter((probe) => (onlyUsable ? probe.usable : true))
        .sort((a, b) => {
            if (a.usable !== b.usable) return a.usable ? -1 : 1;
            if (b.depthScore !== a.depthScore) return b.depthScore - a.depthScore;
            if (b.score !== a.score) return b.score - a.score;
            if (a.preferredRank >= 0 && b.preferredRank >= 0 && a.preferredRank !== b.preferredRank) {
                return a.preferredRank - b.preferredRank;
            }
            if (a.preferredRank >= 0 && b.preferredRank < 0) return -1;
            if (a.preferredRank < 0 && b.preferredRank >= 0) return 1;
            return a.exchangeId.localeCompare(b.exchangeId);
        });
}

function printSummary(probes, base, quote, commonQuote) {
    const rows = probes.map((probe, index) => {
        const xrp = probe.xrpCommon ? `yes (${probe.xrpCommon.id})` : 'no';
        const xaut = probe.xautCommon ? `yes (${probe.xautCommon.id})` : 'no';
        const cross = probe.nativeCross ? `yes (${probe.nativeCross.id})` : 'no';
        const candleState = probe.error
            ? `error: ${probe.error}`
            : `${probe.xrpRange?.count || 0}/${probe.xautRange?.count || 0} candles`;
        const usable = (!probe.error && probe.xrpCommon && probe.xautCommon && probe.lookbackSatisfied) ? 'yes' : 'no';
        const depth = probe.error
            ? '-'
            : `${(probe.availableLookbackHours || 0).toFixed(1)}h`;
        return {
            rank: index + 1,
            exchange: probe.exchangeId,
            name: probe.name || probe.exchangeId,
            xrp,
            xaut,
            cross,
            usable,
            required: `${probe.requiredCandles || '?'} candles`,
            observed: depth,
            lookback: probe.lookbackSatisfied ? 'ok' : `need ${probe.requiredCandles || '?'} candles`,
            candles: candleState,
        };
    });

    console.table(rows);
    console.log(`Target: ${upper(base)}/${upper(quote)} from ${upper(base)}/${upper(commonQuote)} and ${upper(quote)}/${upper(commonQuote)}`);
}

async function main() {
    const parsedConfig = parseArgs();
    const {
        config,
        botContext,
        botCfg,
        botAma,
    } = applyBotDerivedConfig(parsedConfig);
    if (config.help) {
        printHelp();
        return;
    }

    const { seconds: intervalSeconds, label: intervalLabel } = parseInterval(config.interval);
    const requiredCandles = computeRequiredCandles(botAma, botCfg);
    const probeLookbackHours = Number.isFinite(Number(config.lookbackHours)) && Number(config.lookbackHours) > 0
        ? Number(config.lookbackHours)
        : candlesToLookbackHours(requiredCandles, intervalSeconds);
    const pageLimit = Number.isFinite(Number(config.limit)) && Number(config.limit) > 0
        ? Math.min(DEFAULT_LIMIT, Math.trunc(Number(config.limit)))
        : DEFAULT_LIMIT;
    const preferredExchangeIds = normalizeExchangeList(config.exchange);

    const probes = [];
    for (const exchangeId of preferredExchangeIds) {
        if (!EXCHANGES[exchangeId]) continue;
        probes.push(await probeExchange(exchangeId, config.base, config.quote, config.commonQuote, config.interval, intervalSeconds, requiredCandles, probeLookbackHours, pageLimit));
    }

    const rankedProbes = rankProbes(probes, preferredExchangeIds, false);
    if (!config.quiet) {
        printSummary(rankedProbes, config.base, config.quote, config.commonQuote);
    }

    if (config.checkOnly) {
        return;
    }

    const forcedExchange = lower(config.exchange) !== 'auto' && preferredExchangeIds.length === 1
        ? preferredExchangeIds[0]
        : null;
    const selected = forcedExchange
        ? rankedProbes.find((probe) => probe.exchangeId === forcedExchange && probe.lookbackSatisfied)
        : pickBestExchange(probes, preferredExchangeIds);

    if (!selected) {
        throw new Error('No exchange found that exposes both leg markets and enough lookback depth');
    }

    const def = EXCHANGES[selected.exchangeId];
    const xrpMarket = selected.xrpCommon;
    const xautMarket = selected.xautCommon;
    const xrpCandles = selected.xrpCandles;
    const xautCandles = selected.xautCandles;

    if (xrpCandles.length === 0 || xautCandles.length === 0) {
        throw new Error(`Selected exchange ${selected.exchangeId} returned no candles for one of the legs`);
    }

    const synthetic = synthesizeCrossCandles(xrpCandles, xautCandles);
    if (synthetic.length === 0) {
        throw new Error(`Selected exchange ${selected.exchangeId} produced no overlapping synthetic candles`);
    }
    const firstTs = synthetic[0][0];
    const lastTs = synthetic[synthetic.length - 1][0];
    const filled = fillCandleGaps(
        synthetic,
        intervalSeconds,
        firstTs,
        lastTs,
        { baselinePrice: synthetic[0][4] }
    );
    if (filled.length < selected.requiredCandles) {
        throw new Error(`Selected exchange ${selected.exchangeId} produced only ${filled.length} synthetic candles; need at least ${selected.requiredCandles}`);
    }

    const outPath = chooseOutputPath(config, intervalLabel);
    const payload = {
        meta: {
            source: 'cex-synthetic',
            exchange: selected.exchangeId,
            exchangeName: def.name,
            baseAsset: upper(config.base),
            quoteAsset: upper(config.quote),
            commonQuote: upper(config.commonQuote),
            sourcePairs: {
                baseLeg: `${upper(config.base)}/${upper(config.commonQuote)}`,
                quoteLeg: `${upper(config.quote)}/${upper(config.commonQuote)}`,
            },
            interval: intervalLabel,
            intervalSeconds,
            requiredCandles,
            amaConfigSource: botAma && botContext ? 'bot-effective' : 'default',
            amaConfig: botAma ? {
                erPeriod: botAma.erPeriod,
                fastPeriod: botAma.fastPeriod,
                slowPeriod: botAma.slowPeriod,
                erSmoothPeriod: botAma.erSmoothPeriod ?? null,
            } : null,
            bot: botContext ? {
                name: botContext.bot.name || null,
                botKey: botContext.bot.botKey || null,
                assetA: botContext.bot.assetA || null,
                assetB: botContext.bot.assetB || null,
            } : null,
            probeLookbackHours,
            requiredSeedCandles: selected.requiredCandles,
            observedCandles: selected.availableCandles,
            observedLookbackHours: Number(selected.availableLookbackHours?.toFixed?.(2) || 0),
            pageLimit,
            volumeBasis: upper(config.base),
            format: '[timestamp_ms, open, high, low, close, volume]',
            fetchedAt: new Date().toISOString(),
        },
        candles: filled,
    };

    writeJsonAtomic(outPath, payload);
    if (!config.quiet) {
        console.log(`Wrote ${filled.length} synthetic candles to ${outPath}`);
        console.log(`Source: ${selected.exchangeId} (${def.name})`);
        console.log(`Legs: ${xrpMarket.id} and ${xautMarket.id}`);
        console.log(`Output pair: ${upper(config.base)}/${upper(config.quote)}`);
    }
}

main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
});
