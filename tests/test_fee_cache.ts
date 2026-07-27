/**
 * tests/test_fee_cache.ts
 *
 * Test script demonstrating the new fee caching functions in utils.js:
 * - initializeFeeCache(botConfigs, btsClient): Loads fees for given bot config assets via BitShares client
 * - getAssetFees(): Returns maker/taker/market fees for a given asset and amount
 *
 * Usage:
 *   tsx tests/test_fee_cache.ts
 */

const { BitShares } = require('../modules/bitshares_client');
const fs = require('fs');
const path = require('path');
const { initializeFeeCache } = require('../modules/order/utils/system');
const { getAssetFees } = require('../modules/order/utils/math');
const Format = require('../modules/order/format');
const { readJSON } = require('../modules/utils/fs_utils');
const { getErrorMessage } = require('../modules/utils/errors');

async function main() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('FEE CACHE SYSTEM TEST');
        console.log('='.repeat(80));

        // Connect to BitShares
        console.log('\nConnecting to BitShares blockchain...');
        await BitShares.connect();
        console.log('✓ Connected to BitShares');

        // Load bot configuration
        console.log('\nLoading bot configuration from profiles/bots.json...');
        const botsJsonPath = path.join(__dirname, '../profiles/bots.json');
        const botsConfig = readJSON(botsJsonPath);

        if (!botsConfig.bots || !Array.isArray(botsConfig.bots)) {
            throw new Error('Invalid bots.json format - missing "bots" array');
        }

        console.log(`✓ Loaded ${botsConfig.bots.length} bot configurations`);

        // Extract unique assets from bot configs
        const assets = new Set(['BTS']);
        for (const bot of botsConfig.bots) {
            if (bot.assetA) assets.add(bot.assetA);
            if (bot.assetB) assets.add(bot.assetB);
        }
        console.log(`✓ Found assets: ${Array.from(assets).join(', ')}`);

        // Initialize the fee cache
        console.log('\nInitializing fee cache...');
        const feeCache = await initializeFeeCache(botsConfig.bots, BitShares);
        console.log('✓ Fee cache initialized');

        // Display cached fees
        console.log('\n' + '-'.repeat(80));
        console.log('CACHED FEE INFORMATION');
        console.log('-'.repeat(80));

        for (const assetSymbol of assets) {
            try {
                // Test getAssetFees to verify fees are cached
                // For BTS: pass null to get fee info object; for others: pass amount to get net proceeds
                const testFee = getAssetFees(assetSymbol, assetSymbol === 'BTS' ? null : 0.01);
                console.log(`\n${assetSymbol}:`);
                if (assetSymbol === 'BTS') {
                    console.log(`  ✓ Fees cached (createFee: ${Format.formatAmount8(testFee.createFee)} BTS)`);
                } else {
                    console.log(`  ✓ Fees cached (test fee: ${Format.formatAmount8(testFee)} ${assetSymbol})`);
                }
            } catch (error) {
                console.log(`\n${assetSymbol}: ⚠ Failed to cache - ${getErrorMessage(error)}`);
            }
        }

        // Test getAssetFees function
        console.log('\n' + '-'.repeat(80));
        console.log('TEST: GET MAKER FEES');
        console.log('-'.repeat(80));

         // Test BTS (blockchain fees)
         console.log('\n--- BTS ---');
         const btsFees = getAssetFees('BTS');
         console.log(`getAssetFees('BTS'):`);
         console.log(`  total: ${Format.formatAmount8(btsFees.total)} BTS`);
         console.log(`  createFee: ${Format.formatAmount8(btsFees.createFee)} BTS`);

         // Test IOB.XRP
         console.log('\n--- IOB.XRP ---');
         const xrpFees = getAssetFees('IOB.XRP', 100);
         console.log(`getAssetFees('IOB.XRP', 100) = ${Format.formatAmount8(xrpFees)} IOB.XRP`);

         // Test HONEST.MONEY
         console.log('\n--- HONEST.MONEY ---');
         const honestMoneyFees = getAssetFees('HONEST.MONEY', 500);
         console.log(`getAssetFees('HONEST.MONEY', 500) = ${Format.formatAmount8(honestMoneyFees)} HONEST.MONEY`);


        console.log('\n' + '='.repeat(80) + '\n');

    } catch (error) {
        console.error('Error:', getErrorMessage(error));
        process.exit(1);
    } finally {
        if (BitShares.ws && BitShares.ws.isConnected) {
            BitShares.disconnect();
        }
    }
    
    process.exit(0);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
