const assert = require('assert');
const { MarketAdapterService } = require('../market_adapter/core/market_adapter_service');

console.log('Running market adapter precision guard tests');

let persistedSnapshotPrice: any = null;
let persistedAmaPrice: any = null;

const service = new MarketAdapterService({
    resolveBotContext: async () => ({
        assetA: { id: '1.3.1', precision: 4, symbol: 'A' },
        assetB: { id: '1.3.0', precision: 5, symbol: 'B' },
    }),
    resolveAmaForBot: () => ({ enabled: true, erPeriod: 10, fastPeriod: 2, slowPeriod: 30 }),
    candleFileForBot: () => '/tmp/test_candles.json',
    loadJson: () => null,
    saveJson: () => {},
    calculateBotThreshold: () => 0.1,
    computeCandleStaleness: () => ({ staleData: false }),
    withRetries: async (fn) => fn(),
    kibanaSource: {
        getLpCandlesForPool: async () => {
            const price = 1.23456789123;
            const candles = [];
            const baseTs = 1700000000000;
            for (let i = 0; i < 200; i++) {
                candles.push([baseTs + i * 3600000, price, price, price, price, 1]);
            }
            return candles;
        },
    },
    fetchNativeTradesSince: async () => ({ trades: [] }),
    mergeCandles: (a, b) => [...a, ...b],
    pruneCandles: (c) => c,
    buildAmaRecord: () => [],
    writeGridResetTrigger: () => '/tmp/trigger',
    writeBotDynamicGrid: (key, price, options) => {
        persistedSnapshotPrice = price;
        persistedAmaPrice = options.amaCenterPrice;
    },
    isBotDynamicWeightWhitelisted: () => false,
    root: '/tmp',
    path: require('path'),
});

const bot = { botKey: 'test-bot', gridPrice: 'ama', assetA: 'A', assetB: 'B' };
const state = { bots: {} };
const cfg = { intervalSeconds: 3600, maxStaleHours: 6 };

service.processBot(bot, state, cfg, new Map(), {}).then((result) => {
    if (!result.ok) {
        throw new Error(`processBot failed: ${result.error || result.reason || JSON.stringify(result)}`);
    }

    const botState = state.bots['test-bot'];
    if (!botState) {
        console.log('Result:', result);
        console.log('State:', state);
        throw new Error('botState was not populated in state.bots');
    }

    assert.ok(Number.isFinite(botState.centerPrice) && botState.centerPrice > 0,
        'centerPrice should be a finite positive number');
    assert.ok(Number.isFinite(botState.amaCenterPrice) && botState.amaCenterPrice > 0,
        'amaCenterPrice should be a finite positive number');

    assert.ok(Number.isFinite(persistedSnapshotPrice) && persistedSnapshotPrice > 0,
        'persisted snapshot price should be a finite positive number');
    assert.ok(Number.isFinite(persistedAmaPrice) && persistedAmaPrice > 0,
        'persisted amaCenterPrice should be a finite positive number');

    console.log('All precision guard tests passed');
    process.exit(0);
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
