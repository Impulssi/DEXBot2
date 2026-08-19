#!/usr/bin/env node

/**
 * Debug Script: Test Any Active Trading Pair
 *
 * Finds active trading pairs and shows their order book data
 */

if (process.env.RUN_LIVE_BITSHARES_TESTS !== '1') {
    console.log('Skipping live BitShares connection test.');
    console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
    process.exit(0);
}

const { BitShares, waitForConnected } = require('../modules/bitshares_client');
const { fixedTo } = require('../modules/order/utils/math');
const { getErrorMessage } = require('../modules/utils/errors');

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[92m',
    blue: '\x1b[96m',
    yellow: '\x1b[93m',
    red: '\x1b[38;5;160m',
    bold: '\x1b[1m'
};

async function testAnyPair() {
    try {
        console.log(`${colors.bold}${colors.blue}=== Find Active Trading Pairs ===${colors.reset}\n`);

        console.log(`${colors.yellow}Connecting to BitShares...${colors.reset}`);
        await waitForConnected(15000);

        let isReady = false;
        let attempts = 0;
        while (!isReady && attempts < 30) {
            try {
                await BitShares.db.lookup_asset_symbols(['BTS']);
                isReady = true;
            } catch (err) {
                attempts++;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
        console.log(`${colors.green}✓ Connected and synced${colors.reset}\n`);

        // Get some common assets
        const assetSymbols = ['BTS', 'USD', 'CNY', 'EUR', 'HONEST', 'TWENTIX', 'XRP'];
        console.log(`${colors.bold}Looking up assets: ${assetSymbols.join(', ')}${colors.reset}`);
        const assets = await BitShares.db.lookup_asset_symbols(assetSymbols);

        console.log(`Found ${assets.length} assets:\n`);
        const assetMap: any = {};
        assets.forEach(a => {
            if (a) {
                console.log(`  ${a.symbol}: ${a.id}`);
                assetMap[a.symbol] = a;
            }
        });
        console.log();

        // Test trading pairs
        const pairs = [
            ['BTS', 'USD'],
            ['BTS', 'CNY'],
            ['HONEST', 'BTS'],
            ['USD', 'BTS']
        ];

        for (const [symA, symB] of pairs) {
            const assetA = assetMap[symA];
            const assetB = assetMap[symB];

            if (!assetA || !assetB) {
                console.log(`${colors.yellow}Skipping ${symA}/${symB} - asset not found${colors.reset}`);
                continue;
            }

            console.log(`${colors.bold}Testing ${symA}/${symB} (${assetA.id} / ${assetB.id}):${colors.reset}`);

            try {
                const ob = await BitShares.db.get_order_book(assetA.id, assetB.id, 5);
                console.log(`  Bids: ${ob.bids ? ob.bids.length : 0}`);
                if (ob.bids && ob.bids.length > 0) {
                    console.log(`    Best bid: ${fixedTo(ob.bids[0].price, 8)}`);
                }
                console.log(`  Asks: ${ob.asks ? ob.asks.length : 0}`);
                if (ob.asks && ob.asks.length > 0) {
                    console.log(`    Best ask: ${fixedTo(ob.asks[0].price, 8)}`);
                }

                const ticker = await BitShares.db.get_ticker(assetA.id, assetB.id);
                console.log(`  Ticker latest: ${ticker.latest}`);
                console.log(`  24h volume: ${ticker.base_volume}`);
            } catch (err) {
                console.log(`  ${colors.red}Error: ${getErrorMessage(err)}${colors.reset}`);
            }
            console.log();
        }

    } catch (err) {
        console.error(`${colors.red}Fatal error: ${getErrorMessage(err)}${colors.reset}`);
        process.exit(1);
    }
}

testAnyPair().then(() => {
    console.log('Exiting...');
    process.exit(0);
}).catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
