const assert = require('assert');

const { parseChainOrder } = require('../modules/order/utils/order');
const { ORDER_TYPES } = require('../modules/constants');

function makeAssets(assetAId, assetBId, precA, precB) {
    return {
        assetA: { id: assetAId, symbol: 'TESTA', precision: precA },
        assetB: { id: assetBId, symbol: 'TESTB', precision: precB },
    };
}

function makeOrder(id, baseAssetId, quoteAssetId, forSale, baseAmount, quoteAmount) {
    return {
        id,
        sell_price: {
            base: { asset_id: baseAssetId, amount: baseAmount },
            quote: { asset_id: quoteAssetId, amount: quoteAmount },
        },
        for_sale: forSale,
    };
}

async function test() {
    console.log('Testing Lightweight Sync Chain-Order Pair Filter...');

    const assets = makeAssets('1.3.1', '1.3.2', 5, 5);

    // Matching orders: 3 sells (TESTA->TESTB) + 2 buys (TESTB->TESTA)
    const matchingSells = [
        makeOrder('1.7.1', '1.3.1', '1.3.2', 100_00000, 100_00000, 200_00000),
        makeOrder('1.7.2', '1.3.1', '1.3.2', 200_00000, 200_00000, 400_00000),
        makeOrder('1.7.3', '1.3.1', '1.3.2', 50_00000,  50_00000,  100_00000),
    ];
    const matchingBuys = [
        makeOrder('1.7.4', '1.3.2', '1.3.1', 300_00000, 300_00000, 150_00000),
        makeOrder('1.7.5', '1.3.2', '1.3.1', 100_00000, 100_00000, 50_00000),
    ];
    const matchingOrders = [...matchingSells, ...matchingBuys];

    // Other-pair orders: 100 random asset IDs
    const otherPairOrders = [];
    for (let i = 0; i < 100; i++) {
        otherPairOrders.push(
            makeOrder(`1.7.${100 + i}`, '1.3.99', '1.3.98', 1000, 1000, 1000)
        );
    }

    const allOrders = [...matchingOrders, ...otherPairOrders];

    // Simulate the lightweight sync filter
    const filteredCount = allOrders.filter(o => parseChainOrder(o, assets) !== null).length;

    assert.strictEqual(filteredCount, 5,
        `Expected 5 matching orders, got ${filteredCount}`);

    // Verify types are correct
    const sellMatches = matchingSells.filter(o => {
        const p = parseChainOrder(o, assets);
        return p && p.type === ORDER_TYPES.SELL;
    });
    assert.strictEqual(sellMatches.length, 3,
        `Expected 3 SELL matches, got ${sellMatches.length}`);

    const buyMatches = matchingBuys.filter(o => {
        const p = parseChainOrder(o, assets);
        return p && p.type === ORDER_TYPES.BUY;
    });
    assert.strictEqual(buyMatches.length, 2,
        `Expected 2 BUY matches, got ${buyMatches.length}`);

    // Verify no other-pair orders slip through
    const otherMatches = otherPairOrders.filter(o => parseChainOrder(o, assets) !== null);
    assert.strictEqual(otherMatches.length, 0,
        `Expected 0 other-pair matches, got ${otherMatches.length}`);

    console.log('  ✓ 5 matching orders filtered from 105 total (100 other-pair excluded)');
    console.log('  ✓ SELL/BUY type classification correct');
    console.log('  ✓ No other-pair orders leak through');
    console.log('✓ Lightweight sync chain-order pair filter test passed');
}

test()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('✗ Lightweight sync chain-order pair filter test failed');
        console.error(err);
        process.exit(1);
    });
