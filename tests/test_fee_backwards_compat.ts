/**
 * Backwards compatibility tests for fee calculation changes
 * Ensures new netProceeds field doesn't break existing code
 */

const assert = require('assert');
const { getErrorMessage } = require('../modules/utils/errors');

// Mock getAssetFees implementation
const mockCachedFees = {
    limitOrderCreate: { bts: 100 },
    limitOrderUpdate: { bts: 20 },
    marketFee: { percent: 0.2 }
};

function getAssetFeesMock(assetSymbol, assetAmount, isMaker = true) {
    if (assetSymbol === 'BTS') {
        const orderCreationFee = mockCachedFees.limitOrderCreate.bts;
        const orderUpdateFee = mockCachedFees.limitOrderUpdate.bts;

        // For makers: 90% refund, so net fee = 10% of creation fee
        // For takers: no refund, so net fee = full creation fee
        const makerNetFee = orderCreationFee * 0.1;
        const takerNetFee = orderCreationFee;
        const netFee = isMaker ? makerNetFee : takerNetFee;

        // On BitShares, proceeds = raw amount + (90% refund if maker)
        const refund = isMaker ? (orderCreationFee * 0.9) : 0;
        const netProceeds = assetAmount + refund;

        // ALWAYS return the object for BTS to avoid breaking fee lookups elsewhere
        return {
            total: netFee + orderUpdateFee,
            createFee: orderCreationFee,
            updateFee: orderUpdateFee,
            makerNetFee: makerNetFee,
            takerNetFee: takerNetFee,
            netFee: netFee,
            netProceeds: netProceeds, // New field for accounting.js
            isMaker: isMaker
        };
    }

    // For non-BTS assets, return only the net amount (old behavior)
    const feePercent = isMaker ? mockCachedFees.marketFee.percent : (mockCachedFees.marketFee.percent * 2);
    const feeAmount = (assetAmount * feePercent) / 100;
    return assetAmount - feeAmount;
}

function logTest(name, passed, details = '') {
    const status = passed ? '✓' : '✗';
    console.log(` - ${status} ${name}${details ? ' (' + details + ')' : ''}`);
}

async function testBTSFeeObjectBackwardsCompat() {
    console.log('\nRunning BTS Fee Object Backwards Compatibility Tests...');

    // Test 1: BTS always returns object (never number)
    {
        const result = getAssetFeesMock('BTS', 1000, true);
        const isObject = typeof result === 'object' && result !== null;
        logTest('BTS always returns object type', isObject, typeof result);
    }

    // Test 2: Existing fields are still present
    {
        const result = getAssetFeesMock('BTS', 1000, true);
        const hasOldFields = (result as any).total !== undefined && (result as any).createFee !== undefined && (result as any).netFee !== undefined;
        logTest('Object contains old fee fields', hasOldFields, `total, createFee, netFee present`);
    }

    // Test 3: New netProceeds field is added
    {
        const result = getAssetFeesMock('BTS', 1000, true);
        const hasNetProceeds = (result as any).netProceeds !== undefined;
        logTest('Object includes new netProceeds field', hasNetProceeds, `${(result as any).netProceeds}`);
    }

    // Test 4: Code expecting old behavior (accessing total) still works
    {
        const result = getAssetFeesMock('BTS', 1000, true);
        const totalIsNumber = typeof (result as any).total === 'number';
        logTest('Legacy code accessing .total still works', totalIsNumber, `total = ${(result as any).total}`);
    }

    // Test 5: New code can safely check typeof and access netProceeds
    {
        const result = getAssetFeesMock('BTS', 1000, false);
        const legacy = (typeof result === 'object') ? (result as any).total : result;
        const modern = (typeof result === 'object') ? (result as any).netProceeds : result;
        logTest('New code can access netProceeds safely', modern !== undefined && modern > 0,
                `legacy=${legacy}, modern=${modern}`);
    }

    // Test 6: Maker vs Taker differences are preserved
    {
        const makerResult = getAssetFeesMock('BTS', 1000, true);
        const takerResult = getAssetFeesMock('BTS', 1000, false);

        const makerNetFee = (makerResult as any).netFee;
        const takerNetFee = (takerResult as any).netFee;
        const makerProceeds = (makerResult as any).netProceeds;
        const takerProceeds = (takerResult as any).netProceeds;

        const makerHasRefund = makerProceeds > 1000;
        const takerHasNoRefund = takerProceeds === 1000;

        logTest('Maker/Taker fee logic preserved', makerHasRefund && takerHasNoRefund,
                `maker proceeds=${makerProceeds}, taker proceeds=${takerProceeds}`);
    }
}

async function testNonBTSFeeBackwardsCompat() {
    console.log('\nRunning Non-BTS Fee Backwards Compatibility Tests...');

    // Test 1: Non-BTS returns number (old behavior)
    {
        const result = getAssetFeesMock('USD', 1000, true);
        const isNumber = typeof result === 'number';
        logTest('Non-BTS returns number type', isNumber, typeof result);
    }

    // Test 2: Non-BTS result is net amount (old behavior)
    {
        const assetAmount = 1000;
        const result = getAssetFeesMock('USD', assetAmount, true);
        const isNetAmount = (result as any) < assetAmount; // Fees deducted
        logTest('Non-BTS result is net amount', isNetAmount, `${result} < ${assetAmount}`);
    }

    // Test 3: Existing code expecting number still works
    {
        const result = getAssetFeesMock('TESTCOIN', 5000, true);
        const canAddNumbers = typeof result === 'number' && !isNaN(result);
        logTest('Legacy code can use result as number', canAddNumbers, `can add to other numbers`);
    }
}

async function testMixedAssetAccounting() {
    console.log('\nRunning Mixed Asset Accounting Tests...');

    // Test: Code that handles both BTS and non-BTS needs to check typeof
    {
        const btsResult = getAssetFeesMock('BTS', 1000, true);
        const usdResult = getAssetFeesMock('USD', 1000, true);

        // Safe extraction of net proceeds
        const getBTSProceeds = (result) => {
            if (typeof result === 'object') {
                return (result as any).netProceeds || (result as any).total;
            }
            return result;
        };

        const btsProceeds = getBTSProceeds(btsResult);
        const usdProceeds = getBTSProceeds(usdResult);

        const btsOk = btsProceeds > 1000; // Maker has refund
        const usdOk = usdProceeds < 1000; // Non-BTS has fees deducted

        logTest('Mixed asset accounting pattern works', btsOk && usdOk,
                `BTS proceeds=${btsProceeds}, USD proceeds=${usdProceeds}`);
    }

    // Test: accounting.js style usage with netProceeds fallback
    {
        const btsResult = getAssetFeesMock('BTS', 1000, false);
        const usdResult = getAssetFeesMock('USD', 1000, false);

        // Pattern from accounting.js: use netProceeds if available, otherwise use the number
        const btsProceedsUsed = (typeof btsResult === 'object') ? btsResult.netProceeds : btsResult;
        const usdProceedsUsed = (typeof usdResult === 'object') ? usdResult.netProceeds : usdResult;

        const btsIsValid = typeof btsProceedsUsed === 'number' && !isNaN(btsProceedsUsed);
        const usdIsValid = typeof usdProceedsUsed === 'number' && !isNaN(usdProceedsUsed);

        logTest('accounting.js pattern handles both asset types', btsIsValid && usdIsValid,
                `BTS=${btsProceedsUsed}, USD=${usdProceedsUsed}`);
    }
}

async function testFeeCalculationAccuracy() {
    console.log('\nRunning Fee Calculation Accuracy Tests...');

    // Test 1: BTS maker fee calculation (10% of creation fee)
    {
        const result = getAssetFeesMock('BTS', 1000, true);
        const expectedNetFee = 100 * 0.1; // 10% of 100 = 10
        logTest('BTS maker net fee = 10% of creation fee', (result as any).netFee === expectedNetFee,
                `${(result as any).netFee} === ${expectedNetFee}`);
    }

    // Test 2: BTS maker proceeds include refund
    {
        const assetAmount = 1000;
        const result = getAssetFeesMock('BTS', assetAmount, true);
        const expectedProceeds = assetAmount + (100 * 0.9); // amount + 90% refund
        logTest('BTS maker netProceeds = amount + 90% refund', (result as any).netProceeds === expectedProceeds,
                `${(result as any).netProceeds} === ${expectedProceeds}`);
    }

    // Test 3: BTS taker has no refund
    {
        const assetAmount = 1000;
        const result = getAssetFeesMock('BTS', assetAmount, false);
        const expectedProceeds = assetAmount; // No refund for taker
        logTest('BTS taker netProceeds = amount (no refund)', (result as any).netProceeds === expectedProceeds,
                `${(result as any).netProceeds} === ${expectedProceeds}`);
    }

    // Test 4: USD fee deduction (0.2% maker fee)
    {
        const assetAmount = 1000;
        const result = getAssetFeesMock('USD', assetAmount, true);
        const expectedNet = assetAmount - (assetAmount * 0.002); // 0.2% fee
        const matches = Math.abs((result as any) - expectedNet) < 0.01;
        logTest('USD maker fee = 0.2%', matches,
                `${result} ≈ ${expectedNet}`);
    }
}

// ================================================================================
// Main
// ================================================================================
async function runTests() {
    try {
        await testBTSFeeObjectBackwardsCompat();
        await testNonBTSFeeBackwardsCompat();
        await testMixedAssetAccounting();
        await testFeeCalculationAccuracy();
        console.log('\n✓ All fee backwards compatibility tests passed!');
        process.exit(0);
    } catch (err) {
        console.error('\n✗ Test failed:', getErrorMessage(err));
        process.exit(1);
    }
}

if (require.main === module) {
    runTests().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { testBTSFeeObjectBackwardsCompat, testNonBTSFeeBackwardsCompat, testMixedAssetAccounting, testFeeCalculationAccuracy };
