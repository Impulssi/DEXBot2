#!/usr/bin/env node

/**
 * Debug Script: Order Book Fetch Diagnostics
 *
 * Tests both directions of the order book to identify why price fetch is failing
 */

const { BitShares, waitForConnected } = require('../modules/bitshares_client');
const Format = require('../modules/order/format');
const { getErrorMessage } = require('../modules/utils/errors');

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[92m',
    blue: '\x1b[96m',
    yellow: '\x1b[93m',
    red: '\x1b[38;5;160m',
    bold: '\x1b[1m'
};

async function debugOrderBook() {
    try {
        console.log(`${colors.bold}${colors.blue}=== Order Book Debug for XRP/BTS ===${colors.reset}\n`);

        // Wait for connection and sync
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

        // Get asset IDs
        console.log(`${colors.bold}Fetching Asset IDs:${colors.reset}`);
        const xrpAsset = await BitShares.db.lookup_asset_symbols(['XRP']);
        const btsAsset = await BitShares.db.lookup_asset_symbols(['BTS']);

        const xrpId = xrpAsset[0].id;
        const btsId = btsAsset[0].id;

        console.log(`  XRP: ${xrpId}`);
        console.log(`  BTS: ${btsId}\n`);

        // Test 1: XRP as base, BTS as quote
        console.log(`${colors.bold}Test 1: get_order_book(${xrpId}, ${btsId}, 5)${colors.reset}`);
        console.log(`         (XRP as base, BTS as quote - shows BTS/XRP prices)`);
        try {
            const ob1 = await BitShares.db.get_order_book(xrpId, btsId, 5);
            console.log(`  Bids: ${ob1.bids ? ob1.bids.length : 0}`);
             if (ob1.bids && ob1.bids.length > 0) {
                 ob1.bids.forEach((bid, i) => {
                     console.log(`    ${i+1}. Price: ${Format.formatPrice(Number(bid.price))} BTS/XRP`);
                 });
             }
             console.log(`  Asks: ${ob1.asks ? ob1.asks.length : 0}`);
             if (ob1.asks && ob1.asks.length > 0) {
                 ob1.asks.forEach((ask, i) => {
                     console.log(`    ${i+1}. Price: ${Format.formatPrice(Number(ask.price))} BTS/XRP`);
                 });
             }
        } catch (err) {
            console.log(`${colors.red}  Error: ${getErrorMessage(err)}${colors.reset}`);
        }
        console.log();

        // Test 2: BTS as base, XRP as quote
        console.log(`${colors.bold}Test 2: get_order_book(${btsId}, ${xrpId}, 5)${colors.reset}`);
        console.log(`         (BTS as base, XRP as quote - shows XRP/BTS prices)`);
        try {
            const ob2 = await BitShares.db.get_order_book(btsId, xrpId, 5);
            console.log(`  Bids: ${ob2.bids ? ob2.bids.length : 0}`);
             if (ob2.bids && ob2.bids.length > 0) {
                 ob2.bids.forEach((bid, i) => {
                     console.log(`    ${i+1}. Price: ${Format.formatPrice(Number(bid.price))} XRP/BTS`);
                 });
             }
             console.log(`  Asks: ${ob2.asks ? ob2.asks.length : 0}`);
             if (ob2.asks && ob2.asks.length > 0) {
                 ob2.asks.forEach((ask, i) => {
                     console.log(`    ${i+1}. Price: ${Format.formatPrice(Number(ask.price))} XRP/BTS`);
                 });
             }
        } catch (err) {
            console.log(`${colors.red}  Error: ${getErrorMessage(err)}${colors.reset}`);
        }
        console.log();

        // Test 3: Try get_ticker
        console.log(`${colors.bold}Test 3: get_ticker(${xrpId}, ${btsId})${colors.reset}`);
        try {
            const ticker = await BitShares.db.get_ticker(xrpId, btsId);
            console.log(`  Latest price: ${ticker.latest}`);
            console.log(`  Latest price (alt): ${ticker.latest_price}`);
            console.log(`  Full ticker:`, JSON.stringify(ticker, null, 2));
        } catch (err) {
            console.log(`${colors.red}  Error: ${getErrorMessage(err)}${colors.reset}`);
        }
        console.log();

        // Test 4: Try get_ticker reversed
        console.log(`${colors.bold}Test 4: get_ticker(${btsId}, ${xrpId})${colors.reset}`);
        try {
            const ticker = await BitShares.db.get_ticker(btsId, xrpId);
            console.log(`  Latest price: ${ticker.latest}`);
            console.log(`  Latest price (alt): ${ticker.latest_price}`);
            console.log(`  Full ticker:`, JSON.stringify(ticker, null, 2));
        } catch (err) {
            console.log(`${colors.red}  Error: ${getErrorMessage(err)}${colors.reset}`);
        }
        console.log();

        // Test 5: get_limit_orders
        console.log(`${colors.bold}Test 5: get_limit_orders(${xrpId}, ${btsId}, 100)${colors.reset}`);
        try {
            const orders = await BitShares.db.get_limit_orders(xrpId, btsId, 100);
            console.log(`  Found ${orders ? orders.length : 0} limit orders`);
            if (orders && orders.length > 0) {
                orders.slice(0, 3).forEach((order, i) => {
                    console.log(`    ${i+1}. ${JSON.stringify(order.sell_price)}`);
                });
            }
        } catch (err) {
            console.log(`${colors.red}  Error: ${getErrorMessage(err)}${colors.reset}`);
        }
        console.log();

        // Test 6: get_limit_orders reversed
        console.log(`${colors.bold}Test 6: get_limit_orders(${btsId}, ${xrpId}, 100)${colors.reset}`);
        try {
            const orders = await BitShares.db.get_limit_orders(btsId, xrpId, 100);
            console.log(`  Found ${orders ? orders.length : 0} limit orders`);
            if (orders && orders.length > 0) {
                orders.slice(0, 3).forEach((order, i) => {
                    console.log(`    ${i+1}. ${JSON.stringify(order.sell_price)}`);
                });
            }
        } catch (err) {
            console.log(`${colors.red}  Error: ${getErrorMessage(err)}${colors.reset}`);
        }

    } catch (err) {
        console.error(`${colors.red}Fatal error: ${getErrorMessage(err)}${colors.reset}`);
        process.exit(1);
    }
}

debugOrderBook().then(() => {
    console.log('\nExiting...');
    process.exit(0);
}).catch(err => {
    console.error('Failed:', err);
    process.exit(1);
});
