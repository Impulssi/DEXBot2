#!/usr/bin/env node

/**
 * Test Script: Market Price Fetching from Order Book
 *
 * This script tests the price derivation functions for XRP/BTS pair.
 * It demonstrates:
 * 1. Direct order book price fetch
 * 2. Pool price fallback
 * 3. Fallback chain behavior
 * 4. Bid/ask spread
 */

if (process.env.RUN_LIVE_BITSHARES_TESTS !== '1') {
    console.log('Skipping live BitShares connection test.');
    console.log('Set RUN_LIVE_BITSHARES_TESTS=1 to run it explicitly.');
    process.exit(0);
}

const { BitShares, waitForConnected } = require('../modules/bitshares_client');
const { getErrorMessage } = require('../modules/utils/errors');
const { derivePrice } = require('../modules/order/utils/system');
const Format = require('../modules/order/format');

// Color codes for console output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[92m',
    blue: '\x1b[96m',
    yellow: '\x1b[93m',
    red: '\x1b[38;5;160m',
    bold: '\x1b[1m'
};

async function testMarketPrice() {
    try {
        console.log(`${colors.bold}${colors.blue}=== Market Price Fetch Test for IOB.XRP/BTS ===${colors.reset}\n`);

        // Wait for BitShares connection
        console.log(`${colors.yellow}Connecting to BitShares API...${colors.reset}`);
        await waitForConnected(15000);
        console.log(`${colors.green}✓ Connected to BitShares${colors.reset}`);

        // Wait for blockchain to fully sync
        console.log(`${colors.yellow}Waiting for blockchain to sync...${colors.reset}`);
        let isReady = false;
        let attempts = 0;
        while (!isReady && attempts < 30) {
            try {
                // Try to fetch a basic asset to verify database is responsive
                await BitShares.db.lookup_asset_symbols(['BTS']);
                isReady = true;
                console.log(`${colors.green}✓ Blockchain fully synchronized${colors.reset}\n`);
            } catch (err) {
                attempts++;
                if (attempts % 5 === 0) {
                    console.log(`  Waiting... (attempt ${attempts}/30)`);
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        if (!isReady) {
            throw new Error('Blockchain did not fully synchronize after 15 seconds');
        }

        const symA = 'IOB.XRP';
        const symB = 'BTS';

        // Test 1: Fetch pool price
        console.log(`${colors.bold}Test 1: Pool Price${colors.reset}`);
        console.log(`Fetching pool price for ${symA}/${symB}...`);
        const startPool = Date.now();
        const poolPrice = await derivePrice(BitShares, symA, symB, 'pool');
        const poolTime = Date.now() - startPool;

        if (poolPrice && poolPrice > 0) {
            console.log(`${colors.green}✓ Pool Price: ${poolPrice.toFixed(8)} BTS per ${symA}${colors.reset}`);
            console.log(`  Response time: ${poolTime}ms\n`);
        } else {
            console.log(`${colors.yellow}✗ Pool price unavailable or zero${colors.reset}\n`);
        }

        // Test 2: Fetch market (order book) price
        console.log(`${colors.bold}Test 2: Market (Order Book) Price${colors.reset}`);
        console.log(`Fetching market price from order book for ${symA}/${symB}...`);
        const startMarket = Date.now();
        const startPrice = await derivePrice(BitShares, symA, symB, 'book');
        const marketTime = Date.now() - startMarket;

        if (startPrice && startPrice > 0) {
            console.log(`${colors.green}✓ Market Price: ${startPrice.toFixed(8)} BTS per ${symA}${colors.reset}`);
            console.log(`  Response time: ${marketTime}ms\n`);
        } else {
            console.log(`${colors.yellow}✗ Market price unavailable or zero${colors.reset}\n`);
        }

         // Test 3: Fetch with auto mode (no cross-fallback)
         console.log(`${colors.bold}Test 3: Auto Mode (Pool preferred, Market fallback only in auto)${colors.reset}`);
         console.log(`Fetching price with auto mode...`);
        const startAuto = Date.now();
        const autoPrice = await derivePrice(BitShares, symA, symB, 'auto');
        const autoTime = Date.now() - startAuto;

        if (autoPrice && autoPrice > 0) {
            console.log(`${colors.green}✓ Auto Price: ${autoPrice.toFixed(8)} BTS per ${symA}${colors.reset}`);
            console.log(`  Response time: ${autoTime}ms\n`);
        } else {
            console.log(`${colors.red}✗ No price available from any source${colors.reset}\n`);
        }

        // Test 4: Raw order book fetch to show bid/ask spread
        console.log(`${colors.bold}Test 4: Detailed Order Book Analysis${colors.reset}`);
        console.log(`Fetching order book for detailed bid/ask analysis...`);

        try {
            // Get asset metadata
            const iobrxpAsset = await BitShares.db.lookup_asset_symbols(['IOB.XRP']);
            const btsAsset = await BitShares.db.lookup_asset_symbols(['BTS']);

            if (iobrxpAsset && iobrxpAsset[0] && btsAsset && btsAsset[0]) {
                const iobrxpId = iobrxpAsset[0].id;
                const btsId = btsAsset[0].id;

                console.log(`  IOB.XRP asset ID: ${iobrxpId}`);
                console.log(`  BTS asset ID: ${btsId}\n`);

                // Fetch order book
                const orderBook = await BitShares.db.get_order_book(iobrxpId, btsId, 5);

                if (orderBook.bids && orderBook.bids.length > 0) {
                    console.log(`${colors.bold}Best Bids (buyers offering):${colors.reset}`);
                    orderBook.bids.forEach((bid, idx) => {
                         const price = Number(bid.price);
                         console.log(`  ${idx + 1}. Price: ${Format.formatPrice(price)} BTS per IOB.XRP | Amount: ${bid.quote.amount} BTS`);
                     });
                    console.log();
                } else {
                    console.log(`${colors.yellow}No bids available${colors.reset}\n`);
                }

                if (orderBook.asks && orderBook.asks.length > 0) {
                    console.log(`${colors.bold}Best Asks (sellers offering):${colors.reset}`);
                    orderBook.asks.forEach((ask, idx) => {
                         const price = Number(ask.price);
                         console.log(`  ${idx + 1}. Price: ${Format.formatPrice(price)} BTS per IOB.XRP | Amount: ${ask.quote.amount} BTS`);
                     });
                    console.log();
                } else {
                    console.log(`${colors.yellow}No asks available${colors.reset}\n`);
                }

                // Calculate spread
                if (orderBook.bids && orderBook.bids.length > 0 && orderBook.asks && orderBook.asks.length > 0) {
                    const bestBid = Number(orderBook.bids[0].price);
                    const bestAsk = Number(orderBook.asks[0].price);
                    const midPrice = (bestBid + bestAsk) / 2;
                    const spreadBps = ((bestAsk - bestBid) / midPrice) * 10000;

                    console.log(`${colors.bold}Spread Analysis:${colors.reset}`);
                     console.log(`  Best Bid: ${Format.formatPrice(bestBid)} BTS per IOB.XRP`);
                     console.log(`  Best Ask: ${Format.formatPrice(bestAsk)} BTS per IOB.XRP`);
                     console.log(`  Mid Price: ${Format.formatPrice(midPrice)} BTS per IOB.XRP`);
                     console.log(`  Spread: ${Format.formatPrice(bestAsk - bestBid)} BTS (${Format.formatMetric2(spreadBps)} bps)\n`);
                }
            }
        } catch (err) {
            console.log(`${colors.yellow}✗ Could not fetch detailed order book: ${getErrorMessage(err)}${colors.reset}\n`);
        }

         // Summary
         console.log(`${colors.bold}${colors.blue}=== Summary ===${colors.reset}`);
         console.log(`Pool Price:      ${poolPrice ? Format.formatPrice(poolPrice) : 'N/A'} (${poolTime}ms)`);
         console.log(`Market Price:    ${startPrice ? Format.formatPrice(startPrice) : 'N/A'} (${marketTime}ms)`);
         console.log(`Auto Fallback:   ${autoPrice ? Format.formatPrice(autoPrice) : 'N/A'} (${autoTime}ms)`);

         if (poolPrice && startPrice) {
             const diff = ((startPrice - poolPrice) / poolPrice) * 100;
             console.log(`\nPrice Difference: ${diff > 0 ? '+' : ''}${Format.formatPercent2(diff)}%`);
         }

        console.log(`\n${colors.green}✓ Test completed successfully${colors.reset}`);

    } catch (err) {
        console.error(`${colors.red}✗ Error: ${getErrorMessage(err)}${colors.reset}`);
        console.error((err as any).stack);
        process.exit(1);
    }
}

// Run the test
testMarketPrice().then(() => {
    console.log('\nExiting...');
    process.exit(0);
}).catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
