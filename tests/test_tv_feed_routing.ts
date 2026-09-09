const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('Running tv feed routing tests');

const {
    parseArgs,
    resolveMpaBacking,
    pickFeedContext,
    activateFeedIfCovered,
    feedAgeMs,
    feedName,
    FEED_STALE_WARN_AGE_MS,
} = require('../scripts/tv');

const BTS = { id: '1.3.0', precision: 5, symbol: 'BTS' };
const MPA = { id: '1.3.5649', precision: 4, symbol: 'HONEST.USD' };
const EUR = { id: '1.3.6315', precision: 4, symbol: 'HONEST.EUR' };
const OTHER = { id: '1.3.1', precision: 4, symbol: 'OTHER' };

const HOUR_MS = 3600 * 1000;
const NOW = Date.now();

function stubClient({ assets, bitassets, backing }) {
    return {
        BitShares: {
            db: {
                lookup_asset_symbols: async (syms) => syms.map((s) => assets[s] || null),
                get_objects: async (ids) => ids.map((id) => bitassets[id] || null),
                get_assets: async (ids) => ids.map((id) => backing[id] || null),
            },
        },
    };
}

function mpaSetup({ feedAgeHours = 1, prediction = false } = {}) {
    const feedTime = new Date(NOW - feedAgeHours * HOUR_MS).toISOString().replace('.000Z', '');
    return stubClient({
        assets: {
            'HONEST.USD': { id: MPA.id, precision: MPA.precision, symbol: MPA.symbol, bitasset_data_id: '2.4.294' },
            BTS: { id: BTS.id, precision: BTS.precision, symbol: BTS.symbol },
        },
        bitassets: {
            '2.4.294': {
                options: { short_backing_asset: BTS.id, is_prediction_market: prediction },
                current_feed_publication_time: feedTime,
            },
        },
        backing: { [BTS.id]: { id: BTS.id, precision: BTS.precision, symbol: BTS.symbol } },
    });
}

function crossSetup({ eurBackingId = BTS.id, eurPrediction = false } = {}) {
    const feedTime = new Date(NOW - HOUR_MS).toISOString().replace('.000Z', '');
    const backingAssets = { [BTS.id]: { id: BTS.id, precision: BTS.precision, symbol: BTS.symbol } };
    if (eurBackingId !== BTS.id) {
        backingAssets[eurBackingId] = { id: eurBackingId, precision: 4, symbol: 'CNY' };
    }
    return stubClient({
        assets: {
            'HONEST.USD': { id: MPA.id, precision: MPA.precision, symbol: MPA.symbol, bitasset_data_id: '2.4.294' },
            'HONEST.EUR': { id: EUR.id, precision: EUR.precision, symbol: EUR.symbol, bitasset_data_id: '2.4.300' },
            BTS: { id: BTS.id, precision: BTS.precision, symbol: BTS.symbol },
        },
        bitassets: {
            '2.4.294': {
                options: { short_backing_asset: BTS.id, is_prediction_market: false },
                current_feed_publication_time: feedTime,
            },
            '2.4.300': {
                options: { short_backing_asset: eurBackingId, is_prediction_market: eurPrediction },
                current_feed_publication_time: feedTime,
            },
        },
        backing: backingAssets,
    });
}

function uiaSetup() {
    return stubClient({
        assets: {
            'HONEST.MONEY': { id: '1.3.6301', precision: 8, symbol: 'HONEST.MONEY' },
            BTS: { id: BTS.id, precision: BTS.precision, symbol: BTS.symbol },
        },
        bitassets: {},
        backing: {},
    });
}
async function testUiaNeverRoutesToFeed() {
    const client = uiaSetup();
    assert.strictEqual(await resolveMpaBacking('HONEST.MONEY', client), null);
    assert.strictEqual(
        await pickFeedContext('BTS', 'HONEST.MONEY', 'auto', client),
        null
    );
    await assert.rejects(
        pickFeedContext('BTS', 'HONEST.MONEY', 'feed', client),
        /requires an MPA pair/i
    );
}

async function testAutoNeverRoutesToFeed() {
    const client = mpaSetup({ feedAgeHours: 1 });
    assert.strictEqual(
        await activateFeedIfCovered('BTS', 'HONEST.USD', BTS, MPA, 'auto', client),
        null,
        'auto charts market candles even for a fresh MPA feed'
    );
    assert.strictEqual(await pickFeedContext('BTS', 'HONEST.USD', 'auto', client), null);
}

async function testExplicitFeedOptsIn() {
    const client = mpaSetup({ feedAgeHours: 1 });
    const ctx = await resolveMpaBacking('HONEST.USD', client);
    assert.strictEqual(ctx.isPredictionMarket, false);
    assert.strictEqual(ctx.mpa.id, MPA.id);
    assert.strictEqual(ctx.backing.id, BTS.id);

    const active = await activateFeedIfCovered('BTS', 'HONEST.USD', BTS, MPA, 'feed', client);
    assert.ok(active, 'explicit --feed should activate a fresh MPA feed');
    assert.strictEqual(active.kind, 'single');
    assert.strictEqual(active.legs[0].mpa.symbol, 'HONEST.USD');
}

async function testStaleFeedWarnsButProceedsWhenExplicit() {
    const client = mpaSetup({ feedAgeHours: 24 * 30 });
    assert.strictEqual(
        await activateFeedIfCovered('BTS', 'HONEST.USD', BTS, MPA, 'auto', client),
        null
    );
    const forced = await activateFeedIfCovered('BTS', 'HONEST.USD', BTS, MPA, 'feed', client);
    assert.ok(forced, 'explicit --feed charts even a stale feed');
}
async function testMissingFeedTimeWarnsButProceedsWhenExplicit() {
    const client = mpaSetup({ feedAgeHours: 1 });
    client.BitShares.db.get_objects = async () => [
        { options: { short_backing_asset: BTS.id }, current_feed_publication_time: null },
    ];
    assert.strictEqual(await activateFeedIfCovered('BTS', 'HONEST.USD', BTS, MPA, 'auto', client), null);
    const forced = await activateFeedIfCovered('BTS', 'HONEST.USD', BTS, MPA, 'feed', client);
    assert.ok(forced, 'explicit --feed charts even with unknown feed age');
}

async function testPredictionMarketNeverChartsFeed() {
    const client = mpaSetup({ feedAgeHours: 1, prediction: true });
    const ctx = await resolveMpaBacking('HONEST.USD', client);
    assert.strictEqual(ctx.isPredictionMarket, true);
    assert.strictEqual(await pickFeedContext('BTS', 'HONEST.USD', 'auto', client), null);
    await assert.rejects(
        pickFeedContext('BTS', 'HONEST.USD', 'feed', client),
        /prediction-market/i
    );
}

async function testNonFeedSourcesSkipChainDetection() {
    let lookups = 0;
    const client = mpaSetup({ feedAgeHours: 1 });
    const db = client.BitShares.db;
    db.lookup_asset_symbols = async (...args) => {
        lookups++;
        return [{ id: MPA.id, precision: MPA.precision, symbol: MPA.symbol, bitasset_data_id: '2.4.294' }];
    };
    assert.strictEqual(await pickFeedContext('BTS', 'HONEST.USD', 'auto', client), null);
    assert.strictEqual(await pickFeedContext('BTS', 'HONEST.USD', 'pool', client), null);
    assert.strictEqual(await pickFeedContext('BTS', 'HONEST.USD', 'book', client), null);
    assert.strictEqual(lookups, 0, 'non-feed sources must not touch the chain for MPA detection');
}

async function testFeedOnlyCoversBackingPair() {
    const client = mpaSetup({ feedAgeHours: 1 });
    const auto = await activateFeedIfCovered('HONEST.USD', 'OTHER', MPA, OTHER, 'auto', client);
    assert.strictEqual(auto, null);
    await assert.rejects(
        activateFeedIfCovered('HONEST.USD', 'OTHER', MPA, OTHER, 'feed', client),
        /cannot price/i
    );
}

async function testCrossActivatesForMpaMpa() {
    const client = crossSetup();
    const ctx = await activateFeedIfCovered('HONEST.USD', 'HONEST.EUR', MPA, EUR, 'feed', client);
    assert.ok(ctx, 'two MPAs sharing a backing asset should cross');
    assert.strictEqual(ctx.kind, 'cross');
    assert.strictEqual(ctx.legs.length, 2);
    assert.strictEqual(feedName(ctx), 'HONEST.USD/HONEST.EUR');
    assert.strictEqual(await activateFeedIfCovered('HONEST.USD', 'HONEST.EUR', MPA, EUR, 'auto', client), null);
}

async function testCrossRequiresSharedBacking() {
    const client = crossSetup({ eurBackingId: '1.3.113' });
    await assert.rejects(
        activateFeedIfCovered('HONEST.USD', 'HONEST.EUR', MPA, EUR, 'feed', client),
        /different backing/i
    );
}

async function testCrossRejectsPredictionLeg() {
    const client = crossSetup({ eurPrediction: true });
    await assert.rejects(
        activateFeedIfCovered('HONEST.USD', 'HONEST.EUR', MPA, EUR, 'feed', client),
        /prediction-market/i
    );
}

async function testCrossRequiresBothMpasInPair() {
    const client = crossSetup();
    await assert.rejects(
        activateFeedIfCovered('HONEST.USD', 'HONEST.EUR', MPA, BTS, 'feed', client),
        /covers HONEST\.USD\/HONEST\.EUR only/i
    );
}

function testFeedAgeMs() {
    assert.strictEqual(FEED_STALE_WARN_AGE_MS, 7 * 24 * 3600 * 1000);
    const fresh = feedAgeMs({ feedPublicationTime: new Date(NOW - HOUR_MS).toISOString() }, NOW);
    assert.ok(fresh !== null && fresh <= HOUR_MS + 1000 && fresh >= 0);
    assert.strictEqual(feedAgeMs({ feedPublicationTime: null }, NOW), null);
    assert.strictEqual(feedAgeMs({ feedPublicationTime: 'not-a-time' }, NOW), null);
}

function testParseArgsSourceFlags() {
    assert.strictEqual(parseArgs(['BTS/HONEST.USD']).source, 'auto');
    assert.strictEqual(parseArgs(['BTS/HONEST.USD', '--feed']).source, 'feed');
    assert.strictEqual(parseArgs(['BTS/HONEST.USD', '--pool']).source, 'pool');
    assert.strictEqual(parseArgs(['BTS/HONEST.USD', '--book']).source, 'book');
    assert.strictEqual(parseArgs(['BTS/HONEST.USD', '--orderbook']).source, 'book');
    assert.strictEqual(parseArgs(['BTS/HONEST.USD', '--feed', '--feed']).source, 'feed');
    assert.throws(() => parseArgs(['BTS/HONEST.USD', '--feed', '--pool']), /Conflicting source flags/);
    assert.throws(() => parseArgs(['BTS/HONEST.USD', '--book', '--feed']), /Conflicting source flags/);
    assert.throws(() => parseArgs(['BTS/HONEST.USD', '--source', 'feed']), /Unknown flag/);
}

async function run() {
    await testUiaNeverRoutesToFeed();
    await testAutoNeverRoutesToFeed();
    await testExplicitFeedOptsIn();
    await testStaleFeedWarnsButProceedsWhenExplicit();
    await testMissingFeedTimeWarnsButProceedsWhenExplicit();
    await testPredictionMarketNeverChartsFeed();
    await testNonFeedSourcesSkipChainDetection();
    await testFeedOnlyCoversBackingPair();
    await testCrossActivatesForMpaMpa();
    await testCrossRequiresSharedBacking();
    await testCrossRejectsPredictionLeg();
    await testCrossRequiresBothMpasInPair();
    testParseArgsSourceFlags();
    testFeedAgeMs();
}

run()
    .then(() => {
        console.log('tv feed routing tests passed');
    })
    .catch((err) => {
        console.error(getErrorMessage(err));
        process.exit(1);
    });
