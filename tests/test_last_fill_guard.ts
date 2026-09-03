/**
 * LAST-FILL-GUARD unit tests — pivot ± halfIncrement (replaces tolerance).
 * Last fill at x with increment i (half=i/2): BUY must be < x*(1-half/100), SELL > x*(1+half/100)
 * e.g. x=1000 i=0.5% => BUY < 997.5, SELL > 1002.5
 * Cold (null pivot/type) => disabled.
 */
const assert = require('assert');
const { isLastFillGuardBlocked } = require('../modules/dexbot_cow_runtime');
const { ORDER_TYPES } = require('../modules/constants');

const INC = 0.5; // default grid increment
const HALF = INC / 2; // 0.25

function buyThreshold(pivot: number, inc: number = INC) { return pivot * (1 - inc/2/100); }
function sellThreshold(pivot: number, inc: number = INC) { return pivot * (1 + inc/2/100); }

async function testColdStartDisabled() {
    console.log('\n[LFG-1] cold start (null) => disabled');
    assert.strictEqual(isLastFillGuardBlocked(1000, 1, ORDER_TYPES.BUY, null, ORDER_TYPES.BUY, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(1000, 1, ORDER_TYPES.SELL, null, ORDER_TYPES.SELL, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(1000, 1, ORDER_TYPES.BUY, 1000, null, INC).blocked, false, 'null type => disabled');
    assert.strictEqual(isLastFillGuardBlocked(1000, 1, ORDER_TYPES.BUY, undefined, ORDER_TYPES.BUY, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(1000, 1, ORDER_TYPES.SELL, NaN, ORDER_TYPES.SELL, INC).blocked, false);
    console.log('✓ LFG-1 passed');
}

async function testBuyAfterBuyHalfIncrement() {
    console.log('\n[LFG-2] BUY after BUY with halfIncrement 0.25%: BUY > 997.5 blocked, SELL < 1002.5 blocked');
    const lastPrice = 1000;
    const lastType = ORDER_TYPES.BUY;
    const bThr = buyThreshold(lastPrice); // 997.5
    const sThr = sellThreshold(lastPrice); // 1002.5
    // BUY exactly at threshold passes, just above blocks
    assert.strictEqual(isLastFillGuardBlocked(bThr, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, false, `BUY ${bThr} at threshold should pass`);
    assert.strictEqual(isLastFillGuardBlocked(bThr + 0.01, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, true, `BUY ${bThr+0.01} > thr should block`);
    assert.strictEqual(isLastFillGuardBlocked(990, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, false, 'BUY 990 < 997.5 should pass');
    assert.strictEqual(isLastFillGuardBlocked(999, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, true, 'BUY 999 (>997.5) should now block — stricter than old pivot');
    // SELL after BUY must be higher
    assert.strictEqual(isLastFillGuardBlocked(900, 1, ORDER_TYPES.SELL, lastPrice, lastType, INC).blocked, true, 'SELL 900 < 1002.5 after BUY should block');
    assert.strictEqual(isLastFillGuardBlocked(sThr, 1, ORDER_TYPES.SELL, lastPrice, lastType, INC).blocked, false, `SELL ${sThr} at threshold should pass`);
    assert.strictEqual(isLastFillGuardBlocked(sThr - 0.01, 1, ORDER_TYPES.SELL, lastPrice, lastType, INC).blocked, true, `SELL ${sThr-0.01} < thr should block`);
    assert.strictEqual(isLastFillGuardBlocked(1100, 1, ORDER_TYPES.SELL, lastPrice, lastType, INC).blocked, false, 'SELL 1100 > 1002.5 should pass');
    // Reported SELL 1013 > 1001 should PASS with halfInc (sellThr ~1003.5), old tol case now stricter but still passes because well above half
    assert.strictEqual(isLastFillGuardBlocked(1013.153043, 1, ORDER_TYPES.SELL, 1001.081341, ORDER_TYPES.BUY, INC).blocked, false, 'SELL 1013 > 1001*(1+0.25%) should PASS');
    assert.strictEqual(isLastFillGuardBlocked(1002, 1, ORDER_TYPES.SELL, 1001.081341, ORDER_TYPES.BUY, INC).blocked, true, 'SELL 1002 < 1003.58 should block with halfInc');
    console.log('✓ LFG-2 passed');
}

async function testSellAfterSellHalfIncrement() {
    console.log('\n[LFG-3] SELL after SELL: same thresholds (BUY < 997.5, SELL > 1002.5)');
    const lastPrice = 1000;
    const lastType = ORDER_TYPES.SELL;
    const bThr = buyThreshold(lastPrice);
    const sThr = sellThreshold(lastPrice);
    assert.strictEqual(isLastFillGuardBlocked(sThr, 1, ORDER_TYPES.SELL, lastPrice, lastType, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(sThr - 0.01, 1, ORDER_TYPES.SELL, lastPrice, lastType, INC).blocked, true);
    assert.strictEqual(isLastFillGuardBlocked(1005, 1, ORDER_TYPES.SELL, lastPrice, lastType, INC).blocked, false, 'SELL 1005 > 1002.5 should pass');
    // BUY after SELL
    assert.strictEqual(isLastFillGuardBlocked(bThr, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, false, `BUY ${bThr} at threshold should pass`);
    assert.strictEqual(isLastFillGuardBlocked(bThr + 0.01, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, true);
    assert.strictEqual(isLastFillGuardBlocked(900, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(1100, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, true, 'BUY 1100 > 997.5 should block');
    console.log('✓ LFG-3 passed');
}

async function testReportedCaseHalfIncrement() {
    console.log('\n[LFG-4] reported case with halfInc: pivot 995.083863 => BUY thr ~992.596, SELL thr ~997.571');
    const lastPrice = 995.083863;
    const lastType = ORDER_TYPES.BUY;
    const bThr = buyThreshold(lastPrice);
    const sThr = sellThreshold(lastPrice);
    assert.strictEqual(isLastFillGuardBlocked(bThr, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(bThr + 0.01, 1, ORDER_TYPES.BUY, lastPrice, lastType, INC).blocked, true);
    assert.strictEqual(isLastFillGuardBlocked(sThr, 1, ORDER_TYPES.SELL, lastPrice, lastType, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(sThr - 0.01, 1, ORDER_TYPES.SELL, lastPrice, lastType, INC).blocked, true);
    // BUY after SELL
    const laterPrice = 1010;
    const laterType = ORDER_TYPES.SELL;
    const bThr2 = buyThreshold(laterPrice);
    assert.strictEqual(isLastFillGuardBlocked(1004.089103, 1, ORDER_TYPES.BUY, laterPrice, laterType, INC).blocked, false, `BUY 1004 < ${bThr2} after SELL should pass`);
    assert.strictEqual(isLastFillGuardBlocked(1008, 1, ORDER_TYPES.BUY, laterPrice, laterType, INC).blocked, true, `BUY 1008 > ${bThr2} after SELL should block`);
    assert.strictEqual(isLastFillGuardBlocked(990, 1, ORDER_TYPES.BUY, laterPrice, laterType, INC).blocked, false, 'BUY 990 < thr after SELL should pass');
    assert.strictEqual(isLastFillGuardBlocked(1015, 1, ORDER_TYPES.BUY, laterPrice, laterType, INC).blocked, true);
    console.log('✓ LFG-4 passed');
}

async function testMostRecentWins() {
    console.log('\n[LFG-5] most recent fill wins: pivot is most recent fill');
    const pivotSell = 1010;
    const typeSell = ORDER_TYPES.SELL;
    const bThrSell = buyThreshold(pivotSell);
    const sThrSell = sellThreshold(pivotSell);
    assert.strictEqual(isLastFillGuardBlocked(990, 1, ORDER_TYPES.BUY, pivotSell, typeSell, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(bThrSell, 1, ORDER_TYPES.BUY, pivotSell, typeSell, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(bThrSell + 0.01, 1, ORDER_TYPES.BUY, pivotSell, typeSell, INC).blocked, true);
    assert.strictEqual(isLastFillGuardBlocked(sThrSell - 0.01, 1, ORDER_TYPES.SELL, pivotSell, typeSell, INC).blocked, true);
    assert.strictEqual(isLastFillGuardBlocked(sThrSell, 1, ORDER_TYPES.SELL, pivotSell, typeSell, INC).blocked, false);
    const pivotBuy = 980;
    const typeBuy = ORDER_TYPES.BUY;
    const bThrBuy = buyThreshold(pivotBuy);
    const sThrBuy = sellThreshold(pivotBuy);
    assert.strictEqual(isLastFillGuardBlocked(bThrBuy, 1, ORDER_TYPES.BUY, pivotBuy, typeBuy, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(bThrBuy + 0.01, 1, ORDER_TYPES.BUY, pivotBuy, typeBuy, INC).blocked, true);
    assert.strictEqual(isLastFillGuardBlocked(900, 1, ORDER_TYPES.SELL, pivotBuy, typeBuy, INC).blocked, true);
    assert.strictEqual(isLastFillGuardBlocked(sThrBuy, 1, ORDER_TYPES.SELL, pivotBuy, typeBuy, INC).blocked, false);
    assert.strictEqual(isLastFillGuardBlocked(1100, 1, ORDER_TYPES.SELL, pivotBuy, typeBuy, INC).blocked, false);
    console.log('✓ LFG-5 passed');
}

async function testHalfIncrementParam() {
    console.log('\n[LFG-6] increment param controls threshold (0.5% half=0.25% vs 2% half=1%)');
    const pivot = 1000;
    // inc 2% => half 1% => bThr 990, sThr 1010
    assert.strictEqual(isLastFillGuardBlocked(995, 1, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY, 2).blocked, true, 'BUY 995 > 990 (2% inc) should block');
    assert.strictEqual(isLastFillGuardBlocked(985, 1, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY, 2).blocked, false, 'BUY 985 < 990 should pass');
    assert.strictEqual(isLastFillGuardBlocked(1005, 1, ORDER_TYPES.SELL, pivot, ORDER_TYPES.SELL, 2).blocked, true, 'SELL 1005 < 1010 should block');
    assert.strictEqual(isLastFillGuardBlocked(1015, 1, ORDER_TYPES.SELL, pivot, ORDER_TYPES.SELL, 2).blocked, false, 'SELL 1015 > 1010 should pass');
    // inc 0.1% => half 0.05% => bThr 999.5, sThr 1000.5 (very tight)
    assert.strictEqual(isLastFillGuardBlocked(999.6, 1, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY, 0.1).blocked, true);
    assert.strictEqual(isLastFillGuardBlocked(999.4, 1, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY, 0.1).blocked, false);
    // backward compat: assets object fallback uses default INC
    const assets = { assetA: { precision: 5 }, assetB: { precision: 5 } };
    assert.strictEqual(isLastFillGuardBlocked(999, 1, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY, assets).blocked, true, 'assets fallback should use default halfInc');
    assert.strictEqual(isLastFillGuardBlocked(990, 1, ORDER_TYPES.BUY, pivot, ORDER_TYPES.BUY, assets).blocked, false);
    console.log('✓ LFG-6 passed');
}

async function testSpreadBypassNote() {
    console.log('\n[LFG-7] spread-correction bypass — helper blocks, cowResult.origin skips it');
    const lastPrice = 1010;
    const bThr = buyThreshold(lastPrice);
    const sThr = sellThreshold(lastPrice);
    assert.strictEqual(isLastFillGuardBlocked(sThr - 1, 10, ORDER_TYPES.SELL, lastPrice, ORDER_TYPES.SELL, INC).blocked, true, 'helper blocks sell below thr');
    assert.strictEqual(isLastFillGuardBlocked(bThr - 1, 10, ORDER_TYPES.BUY, lastPrice, ORDER_TYPES.SELL, INC).blocked, false, `BUY ${bThr-1} < thr should PASS`);
    assert.strictEqual(isLastFillGuardBlocked(bThr + 1, 10, ORDER_TYPES.BUY, lastPrice, ORDER_TYPES.SELL, INC).blocked, true, `BUY ${bThr+1} > thr should block`);
    const { buildCowResultFromPlan } = require('../modules/dexbot_cow_runtime');
    const mockBot = { manager: { orders: new Map(), _gridVersion: 0, boundaryIdx: 0 } , config: {} };
    const plan = { ordersToPlace: [{ id: 'slot-135', type: ORDER_TYPES.SELL, price: sThr - 1, size: 10 }], origin: 'spread-correction' };
    const cow = buildCowResultFromPlan(mockBot as any, plan as any);
    assert.strictEqual((cow as any).origin, 'spread-correction', 'origin must propagate for bypass');
    console.log('✓ LFG-7 passed');
}

async function main() {
    await testColdStartDisabled();
    await testBuyAfterBuyHalfIncrement();
    await testSellAfterSellHalfIncrement();
    await testReportedCaseHalfIncrement();
    await testMostRecentWins();
    await testHalfIncrementParam();
    await testSpreadBypassNote();
    console.log('\nAll LAST-FILL-GUARD tests passed.');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('LAST-FILL-GUARD test failed:', err);
        process.exit(1);
    });
}

module.exports = { main };
