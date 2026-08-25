/**
 * tests/test_fee_cache_twentix.ts
 *
 * Test script demonstrating fee caching for TWENTIX specifically
 * Shows how the fee cache system handles assets with both market fees and taker fees
 *
 * Usage:
 *   npx node dist/tests/test_fee_cache_twentix.js
 */

const { BitShares } = require('../modules/bitshares_client');
const { initializeFeeCache } = require('../modules/order/utils/system');
const { getAssetFees } = require('../modules/order/utils/math');
const { getErrorMessage } = require('../modules/utils/errors');

async function main() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('FEE CACHE TEST: TWENTIX');
        console.log('='.repeat(80));

        // Connect to BitShares
        console.log('\nConnecting to BitShares blockchain...');
        await BitShares.connect();
        console.log('✓ Connected to BitShares');

        // Initialize cache with a custom bot config that includes TWENTIX
        console.log('\nInitializing fee cache with TWENTIX...');
        const botsConfig = [
            {
                assetA: 'TWENTIX',
                assetB: 'BTS'
            }
        ];

        await initializeFeeCache(botsConfig, BitShares);
        console.log('✓ Fee cache initialized');

        // Test getAssetFees with different amounts
        console.log('\n' + '-'.repeat(80));
        console.log('TWENTIX MAKER FEE CALCULATION');
        console.log('-'.repeat(80));

        const testAmounts = [100, 1000, 5000, 10000];

        for (const amount of testAmounts) {
            const feeObj = getAssetFees('TWENTIX', amount);
            // getAssetFees returns an object with netProceeds, feeAmount, feePercent
            const netProceeds = feeObj.netProceeds;
            const feeAmount = feeObj.feeAmount;
            console.log(`getAssetFees('TWENTIX', ${amount}): fee=${feeAmount.toFixed(8)}, net=${netProceeds.toFixed(8)} TWENTIX`);
        }

        // Test BTS blockchain fees
        console.log('\n' + '-'.repeat(80));
        console.log('BTS BLOCKCHAIN MAKER FEE');
        console.log('-'.repeat(80));

        const btsFees = getAssetFees('BTS');
        console.log(`\ngetAssetFees('BTS'):`);
        console.log(`  total: ${btsFees.total.toFixed(8)} BTS`);
        console.log(`  createFee: ${btsFees.createFee.toFixed(8)} BTS`);

        console.log('\n' + '='.repeat(80) + '\n');
        process.exit(0);

    } catch (error) {
        console.error('Error:', getErrorMessage(error));
        process.exit(1);
    } finally {
        if (BitShares.ws && BitShares.ws.isConnected) {
            BitShares.disconnect();
        }
    }
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
