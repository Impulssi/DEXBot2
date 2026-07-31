const assert = require('assert');
const mathUtils = require('../modules/order/utils/math');
const { applyGridDivergenceCorrections } = require('../modules/order/utils/system');
const { updateGridFromBlockchainSnapshot } = require('../modules/order/grid');

// Mock derivePrice to simulate market movement
mathUtils.derivePrice = async () => 150; 

// Mock lookupAsset to avoid blockchain connection
mathUtils.lookupAsset = async (_BitShares, sym) => {
    if (sym === 'BASE') return { id: '1.3.1', symbol: 'BASE', precision: 5 };
    if (sym === 'QUOTE') return { id: '1.3.2', symbol: 'QUOTE', precision: 5 };
    return null;
};

// Also mock derivePoolPrice just in case, although derivePrice is the one called directly now
mathUtils.derivePoolPrice = async () => 150; 

const { OrderManager } = require('../modules/order/manager');

const { ORDER_TYPES, ORDER_STATES } = require('../modules/constants');

async function testUnanchoredSpreadCorrection() {
    console.log('Running test: Unanchored Spread Correction');

    const mgr = new OrderManager({
        assetA: 'BASE', assetB: 'QUOTE', startPrice: 100,
        // Keep bot caps aligned with scenario totals so available funds match expectations.
        botFunds: { buy: 10000, sell: 100 }, activeOrders: { buy: 2, sell: 2 },
        incrementPercent: 1, targetSpreadPercent: 1
    });

    mgr.assets = {
        assetA: { id: '1.3.1', symbol: 'BASE', precision: 5 },
        assetB: { id: '1.3.2', symbol: 'QUOTE', precision: 5 }
    };

    // The grid is seeded manually below, so _gapSlots stays at the constructor
    // default (0). Production grids set it during generation. syncBoundaryToFunds
    // clamps the fund-driven boundary to the spread gap between typed BUY/SELL
    // slots — with gapSlots 0 that gap is empty and the boundary freezes after
    // the first correction. Set the production-like geometry explicitly.
    mgr._gapSlots = 2;

    // 1. Initial setup around 100
    console.log('  Scenario 1: Initial setup at 100');
    for(let i=0; i<20; i++) {
        const price = 90 + i; // Prices from 90 to 110
        await mgr._updateOrder({ id: `slot-${i}`, price, state: ORDER_STATES.VIRTUAL, size: 0 });
    }
     // Center at 100 (splitIdx should be around 10)
     mgr.boundaryIdx = 8; // BUY slots 0-8 (up to 98), SPREAD 9-10 (99-100), SELL 11+ (101+)
     
     await mgr.setAccountTotals({
         buy: 10000, sell: 100, // Ratio ~100:1 favoring BUY
         buyFree: 10000, sellFree: 100
     });
     await mgr.recalculateFunds();

    // 2. Set outOfSpread > 0
    mgr.outOfSpread = 2;
    mgr._gridSidesUpdated = new Set([ORDER_TYPES.BUY, ORDER_TYPES.SELL]);
    console.log(`  Initial boundaryIdx: ${mgr.boundaryIdx} (centered at 100)`);

    // 3. Run applyGridDivergenceCorrections
    console.log('  Scenario 2: Correcting spread with BUY-heavy inventory');

    // Mirror production behavior: successful batch execution commits the working grid.
    const mockUpdateFn = async (cowResult) => {
        await mgr._commitWorkingGrid(cowResult.workingGrid, cowResult.workingIndexes, cowResult.workingBoundary);
        return { executed: true };
    };

    // Mock accountOrders with storeMasterGrid to avoid errors during persistence
    const mockAccountOrders = { storeMasterGrid: async () => {} };

    await applyGridDivergenceCorrections(mgr, mockAccountOrders, 'bot-key', mockUpdateFn, updateGridFromBlockchainSnapshot);

    // With 10000 BUY power vs ~100 SELL power, the buyValueRatio is ~0.5 (if price=100).
    // Wait, let's check the math:
    // ValBuy = 10000. ValSell = 100 * 100 = 10000.
    // Ratio = 10000 / 20000 = 0.5. Boundary stays at 50%.
    
     // Let's make it 100% BUY to see clear movement.
     await mgr.setAccountTotals({ buy: 10000, sell: 0, buyFree: 10000, sellFree: 0 });
     await mgr.recalculateFunds();
     mgr.outOfSpread = 2;
     mgr._gridSidesUpdated = new Set([ORDER_TYPES.BUY]);
     await applyGridDivergenceCorrections(mgr, mockAccountOrders, 'bot-key', mockUpdateFn, updateGridFromBlockchainSnapshot);

    console.log(`  Updated boundaryIdx (100% BUY): ${mgr.boundaryIdx}`);
    
    // Total slots = 20. Gap = 2 (nominal). Available = 18.
    // 100% BUY means targetBuySlots = 18. NewBoundary = 17.
    assert(mgr.boundaryIdx > 15, `Boundary should have moved to the top because of 100% BUY funds, but is ${mgr.boundaryIdx}`);
    
    console.log('  ✓ Boundary moved based on fund distribution, not price anchoring');

    console.log('✓ Unanchored Spread Correction test PASSED\n');
}

testUnanchoredSpreadCorrection().catch(err => {
    console.error('Test FAILED:', err);
    process.exit(1);
});
