/**
 * tests/test_grid_logic.ts
 * 
 * Ported from tests/unit/grid.test.js
 * Comprehensive unit tests for grid.js - Order grid generation and sizing
 * Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { PATHS } = require('../modules/paths');;
const fs = require('fs');
const path = require('path');
const { calculateGapSlots, _getSizingContext, createOrderGrid, initializeGrid, checkAndUpdateGridIfNeeded, hasAnyDust } = require('../modules/order/grid');
const { ORDER_TYPES, ORDER_STATES, DEFAULT_CONFIG, GRID_LIMITS, BUILD_DIR } = require('../modules/constants');
const { OrderManager } = require('../modules/order/manager');
const { allocateFundsByWeights, getSingleDustThreshold } = require('../modules/order/utils/math');
const { shouldFlagOutOfSpread, assignGridRoles } = require('../modules/order/utils/order');
const { whitelistFile, resetMarketAdapterWhitelistCache } = require('../modules/market_adapter_whitelist');
const { ensureDir, unlink: safeUnlink, writeJSON } = require('../modules/storage').getStorage();
const _resetBothWhitelistCaches = () => {
    resetMarketAdapterWhitelistCache();
};
const gridModulePath = require.resolve('../modules/order/grid');
const managerModulePath = require.resolve('../modules/order/manager');

async function runTests() {
    console.log('Running Grid Logic Tests...');

    console.log(' - Testing createOrderGrid() Basic Structure...');
    {
        const config = { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 1, targetSpreadPercent: 2 };
        const { orders, initialSpreadCount } = createOrderGrid(config);

        assert(orders !== undefined);
        assert(Array.isArray(orders));
        assert(orders.length > 0);

        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);
        const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
        const spreadOrders = orders.filter(o => o.type === ORDER_TYPES.SPREAD);

        assert(buyOrders.length > 0);
        assert(sellOrders.length > 0);
        assert(spreadOrders.length > 0);
        assert.strictEqual(spreadOrders.length, initialSpreadCount.buy + initialSpreadCount.sell);
    }

    console.log(' - Testing Price Orientation...');
    {
        const config = { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 2, targetSpreadPercent: 4 };
        const { orders } = createOrderGrid(config);

        orders.forEach(o => {
            if (o.type === ORDER_TYPES.BUY) assert(o.price <= config.startPrice);
            if (o.type === ORDER_TYPES.SELL) assert(o.price >= config.startPrice);
            assert.strictEqual(o.state, ORDER_STATES.VIRTUAL);
        });
    }

    console.log(' - Testing Price Bounds...');
    {
        const config = { startPrice: 100, minPrice: 40, maxPrice: 160, incrementPercent: 5, targetSpreadPercent: 10 };
        const { orders } = createOrderGrid(config);

        orders.forEach(o => {
            if (o.type === ORDER_TYPES.BUY) {
                assert(o.price >= config.minPrice);
                assert(o.price <= config.startPrice);
            } else if (o.type === ORDER_TYPES.SELL) {
                assert(o.price >= config.startPrice);
                assert(o.price <= config.maxPrice);
            }
        });
    }

    console.log(' - Testing Increment Percent Validation...');
    {
        const invalidConfigs = [
            { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 0, targetSpreadPercent: 2 },
            { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 100, targetSpreadPercent: 2 },
            { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: -5, targetSpreadPercent: 2 }
        ];

        invalidConfigs.forEach(cfg => {
            assert.throws(() => createOrderGrid(cfg));
        });
    }

    console.log(' - Testing calculateGapSlots fallback uses DEFAULT_CONFIG.incrementPercent...');
    {
        const originalIncrement = DEFAULT_CONFIG.incrementPercent;
        try {
            DEFAULT_CONFIG.incrementPercent = 0.8;

            const gap = calculateGapSlots(undefined, 0);

            const step = 1 + (DEFAULT_CONFIG.incrementPercent / 100);
            const minSpreadPercent = DEFAULT_CONFIG.incrementPercent * GRID_LIMITS.MIN_SPREAD_FACTOR;
            const requiredSteps = Math.ceil(Math.log(1 + (minSpreadPercent / 100)) / Math.log(step));
            const expected = Math.max(GRID_LIMITS.MIN_SPREAD_ORDERS, requiredSteps - 1);

            assert.strictEqual(gap, expected, 'Gap slots should use DEFAULT_CONFIG.incrementPercent as fallback');
        } finally {
            DEFAULT_CONFIG.incrementPercent = originalIncrement;
        }
    }

    console.log(' - Testing minPrice validation and empty-grid protection...');
    {
        assert.throws(
            () => createOrderGrid({ startPrice: 100, minPrice: 0, maxPrice: 200, incrementPercent: 1, targetSpreadPercent: 2 }),
            /minPrice.*positive/i
        );

        assert.throws(
            () => createOrderGrid({ startPrice: 100, minPrice: 99.9, maxPrice: 100.1, incrementPercent: 1, targetSpreadPercent: 2 }),
            /produced no price levels/i
        );

        assert.throws(
            () => createOrderGrid({ startPrice: 100, minPrice: 99, maxPrice: 101, incrementPercent: 1, targetSpreadPercent: 2 }),
            /imbalanced rail/i
        );
    }

    console.log(' - Testing Geometric Progression...');
    {
        const config = { startPrice: 100, minPrice: 50, maxPrice: 200, incrementPercent: 1, targetSpreadPercent: 2 };
        const { orders } = createOrderGrid(config);

        const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY).sort((a, b) => a.price - b.price);
        if (buyOrders.length > 1) {
            for (let i = 0; i < buyOrders.length - 1; i++) {
                const ratio = buyOrders[i + 1].price / buyOrders[i].price;
                // Ratio should be approx 1 + incrementPercent/100
                assert(Math.abs(ratio - 1.01) < 0.05);
            }
        }
    }

    console.log(' - Testing BUY dust threshold orientation consistency...');
    {
        const manager = new OrderManager({
            assetA: 'TESTA',
            assetB: 'TESTB',
            startPrice: 104,
            incrementPercent: 5,
            weightDistribution: { buy: 1, sell: 1 },
            botFunds: { buy: '100%', sell: '100%' },
            activeOrders: { buy: 6, sell: 6 }
        });

        manager.assets = {
            assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
            assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
        };
        await manager.setAccountTotals({ buy: 300, sell: 300, buyFree: 300, sellFree: 300 });

        const buyPrices = [98, 99, 100, 101, 102, 103];
        for (const price of buyPrices) {
            const i = buyPrices.indexOf(price);
            await manager._updateOrder({
                id: `b${i}`,
                type: ORDER_TYPES.BUY,
                state: ORDER_STATES.VIRTUAL,
                size: 1,
                price
            });
        }

        const partialId = 'b5';
        const sideSlots = Array.from(manager.orders.values())
            .filter(o => (o as any).type === ORDER_TYPES.BUY)
            .sort((a, b) => (a as any).price - (b as any).price);
        const ctx = await _getSizingContext(manager, 'buy');
        const idealSizes = allocateFundsByWeights(
            ctx.budget,
            sideSlots.length,
            manager.config.weightDistribution.buy,
            manager.config.incrementPercent / 100,
            true,
            0,
            ctx.precision
        );
        const partialIdx = sideSlots.findIndex(s => (s as any).id === partialId);
        const threshold = getSingleDustThreshold(idealSizes[partialIdx]);
        const partialSize = threshold * 0.95;

        await manager._updateOrder({
            ...manager.orders.get(partialId),
            state: ORDER_STATES.PARTIAL,
            size: partialSize,
            orderId: '1.7.555'
        });

        const partial = manager.orders.get(partialId);
        assert.strictEqual(await hasAnyDust(manager, [partial], 'buy'), true, 'BUY dust detection should match market-oriented geometric sizing');
    }

    console.log(' - Testing regeneration trigger uses cache and available funds...');
    {
        const mockManager = {
            config: {
                assetA: 'USD',
                assetB: 'EUR',
                activeOrders: { buy: 10, sell: 10 },
                gridLimits: { GRID_REGENERATION_PERCENTAGE: 3 }
            },
            funds: {
                total: { grid: { buy: 100, sell: 100 } },
                virtual: { buy: 0, sell: 0 },
                btsFeesOwed: 0
            },
            accountTotals: {
                buyFree: 4,
                sellFree: 0
            },
            _gridSidesUpdated: new Set(),
            getChainFundsSnapshot() {
                return {
                    allocatedBuy: 100,
                    allocatedSell: 100,
                    chainTotalBuy: 100,
                    chainTotalSell: 100
                };
            }
        };

        // checkAndUpdateGridIfNeeded uses calculateAvailableFundsValue internally
        // For this mock to work, we set up buyFree = 4 (>= 3% of 100 grid = 3)
        const above = checkAndUpdateGridIfNeeded(mockManager);
        assert.strictEqual(above.buyUpdated, true, 'Available funds above threshold (4%) should trigger buy-side update');

        mockManager.accountTotals.buyFree = 2;
        const below = checkAndUpdateGridIfNeeded(mockManager);
        assert.strictEqual(below.buyUpdated, false, 'Available funds below threshold (<2%) should not trigger update');
    }

    console.log(' - Testing initializeGrid with case-insensitive AMA mode and out-of-bounds startPrice...');
    {
        const botKey = `test-grid-ama-${process.pid}-case`;
        const ordersDir = PATHS.ORDERS_DIR;
        const amaFile = path.join(ordersDir, `${botKey}.dynamicgrid.json`);

        ensureDir(ordersDir);
        writeJSON(amaFile, { centerPrice: 1000, updatedAt: new Date().toISOString() });

        try {
            delete require.cache[gridModulePath];
            delete require.cache[managerModulePath];
            const FreshGrid = require('../modules/order/grid');
            const { OrderManager: FreshOrderManager } = require('../modules/order/manager');
            const manager = new FreshOrderManager({
                assetA: 'TESTA',
                assetB: 'TESTB',
                botKey,
                startPrice: 100,
                gridPrice: 'AMA',
                minPrice: '2x',
                maxPrice: '2x',
                incrementPercent: 1,
                targetSpreadPercent: 2,
                weightDistribution: { buy: 0.5, sell: 0.5 },
                botFunds: { buy: '100%', sell: '100%' },
                activeOrders: { buy: 6, sell: 6 }
            });

            manager.assets = {
                assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
                assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
            };
            await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });

            await FreshGrid.initializeGrid(manager);

            assert(manager.orders.size > 0, 'initializeGrid should succeed even when configured startPrice is outside resolved bounds');
            assert(manager.config.minPrice > 400 && manager.config.minPrice < 600, 'minPrice should be resolved from AMA center in case-insensitive mode');
            assert(manager.config.maxPrice > 1800 && manager.config.maxPrice < 2200, 'maxPrice should be resolved from AMA center in case-insensitive mode');
        } finally {
            safeUnlink(amaFile)
        }
    }

    console.log(' - Testing AMA gridPrice uses the persisted center price...');
    {
        const botKey = `test-grid-ama-center-${process.pid}`;
        const ordersDir = PATHS.ORDERS_DIR;
        const amaFile = path.join(ordersDir, `${botKey}.dynamicgrid.json`);
        const originalWhitelist = fs.existsSync(whitelistFile())
            ? fs.readFileSync(whitelistFile(), 'utf8')
            : null;

        ensureDir(ordersDir);
        writeJSON(whitelistFile(), {
            whitelist: {
                [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: true }
            }
        });
        _resetBothWhitelistCaches();
        writeJSON(amaFile, {
            centerPrice: 1100,
            amaCenterPrice: 1000,
            dynamicWeights: {
                trend: 'UP',
                slopeOffset: 0.1,
                maxSlopeOffset: 0.5,
                maxAsymmetryFactor: 0.35
            },
            updatedAt: new Date().toISOString(),
        });

        try {
            delete require.cache[gridModulePath];
            delete require.cache[managerModulePath];
            const FreshGrid = require('../modules/order/grid');
            const { OrderManager: FreshOrderManager } = require('../modules/order/manager');
            const manager = new FreshOrderManager({
                assetA: 'TESTA',
                assetB: 'TESTB',
                botKey,
                startPrice: 100,
                gridPrice: 'ama',
                minPrice: '2x',
                maxPrice: '2x',
                incrementPercent: 1,
                targetSpreadPercent: 2,
                weightDistribution: { buy: 0.5, sell: 0.5 },
                botFunds: { buy: '100%', sell: '100%' },
                activeOrders: { buy: 6, sell: 6 }
            });

            manager.assets = {
                assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
                assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
            };
            await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });

            await FreshGrid.initializeGrid(manager);

            assert(manager.orders.size > 0, 'initializeGrid should succeed with AMA gridPrice');
            assert.strictEqual(manager._lastGridPricingContext.gridPrice, 1100, 'debug pricing should expose the resolved grid price once');
            assert.strictEqual(manager._lastGridPricingContext.weightDistribution, undefined, 'debug pricing should not duplicate weights from config');
            assert.strictEqual(manager._lastGridPricingContext.gridPriceInput, undefined, 'debug pricing should not duplicate grid price inputs');
            assert.strictEqual(manager._lastGridPricingContext.exactAmaPrice, undefined, 'debug pricing should not duplicate AMA-specific price diagnostics');
            assert.strictEqual(manager._lastGridPricingContext.staticMinPrice, undefined, 'debug pricing should not persist pre-scaling range diagnostics');
            assert.strictEqual(manager._lastGridPricingContext.staticMaxPrice, undefined, 'debug pricing should not persist pre-scaling range diagnostics');
            assert.strictEqual(manager._lastGridPricingContext.resolvedMinPrice, undefined, 'debug pricing should not duplicate resolved min from config');
            assert.strictEqual(manager._lastGridPricingContext.resolvedMaxPrice, undefined, 'debug pricing should not duplicate resolved max from config');
            assert(Math.abs(manager._lastGridPricingContext.rangeScalingFactor - 0.07) < 1e-12, 'debug pricing should expose the applied range-scaling factor');
            assert.strictEqual(manager._lastGridPricingContext.rangeScaling, undefined, 'debug pricing should avoid duplicating nested range-scaling diagnostics');
            assert.strictEqual(manager._lastGridPricingContext.amaSnapshot, undefined, 'debug pricing should not persist market adapter diagnostics');
            assert(Math.abs(manager.config.minPrice - 591.3978494623656) < 1e-9, 'AMA gridPrice should use the persisted center price plus range scaling');
            assert.strictEqual(manager.config.maxPrice, 2354, 'AMA gridPrice should use the persisted center price plus range scaling');
        } finally {
            safeUnlink(amaFile)
            if (originalWhitelist == null) {
                safeUnlink(whitelistFile())
            } else {
                fs.writeFileSync(whitelistFile(), originalWhitelist, 'utf8');
            }
            _resetBothWhitelistCaches();
        }
    }

    console.log(' - Testing AMA gridPrice keeps the persisted center while offsetting market placement price...');
    {
        const botKey = `test-grid-ama-offset-${process.pid}`;
        const ordersDir = PATHS.ORDERS_DIR;
        const amaFile = path.join(ordersDir, `${botKey}.dynamicgrid.json`);
        const originalWhitelist = fs.existsSync(whitelistFile())
            ? fs.readFileSync(whitelistFile(), 'utf8')
            : null;

        ensureDir(ordersDir);
        writeJSON(whitelistFile(), {
            whitelist: {
                [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: true }
            }
        });
        _resetBothWhitelistCaches();
        writeJSON(amaFile, {
            gridCenterPrice: 1000,
            centerPrice: 1000,
            amaCenterPrice: 1000,
            gridPriceOffsetPct: 0.8,
            updatedAt: new Date().toISOString(),
        });

        try {
            delete require.cache[gridModulePath];
            delete require.cache[managerModulePath];
            const FreshGrid = require('../modules/order/grid');
            const { OrderManager: FreshOrderManager } = require('../modules/order/manager');
            const manager = new FreshOrderManager({
                assetA: 'TESTA',
                assetB: 'TESTB',
                botKey,
                startPrice: 100,
                gridPrice: 'ama',
                minPrice: '2x',
                maxPrice: '2x',
                incrementPercent: 1,
                targetSpreadPercent: 2,
                weightDistribution: { buy: 0.5, sell: 0.5 },
                botFunds: { buy: '100%', sell: '100%' },
                activeOrders: { buy: 6, sell: 6 }
            });

            manager.assets = {
                assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
                assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
            };
            await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });

            await FreshGrid.initializeGrid(manager);

            assert(manager.orders.size > 0, 'initializeGrid should succeed with an offset AMA snapshot');
            assert.strictEqual(manager._lastGridPricingContext.gridPriceOffsetPct, 0.8, 'debug pricing should expose the persisted spread offset');
            assert(Math.abs(manager._lastGridPricingContext.gridPrice - 1000) < 1e-9, 'AMA gridPrice should remain anchored to the persisted center price');
            assert(Math.abs(manager._lastGridPricingContext.offsetAdjustedStartPrice - 100.8) < 1e-9, 'AMA spread offset should adjust only the market placement price before bounds fallback');
            assert(Math.abs(manager._lastGridPricingContext.startPrice - 1000) < 1e-9, 'if the adjusted market price is still out of bounds, rebuild should continue to fall back to the AMA grid center');
        } finally {
            safeUnlink(amaFile)
            if (originalWhitelist == null) {
                safeUnlink(whitelistFile())
            } else {
                fs.writeFileSync(whitelistFile(), originalWhitelist, 'utf8');
            }
            _resetBothWhitelistCaches();
        }
    }

    console.log(' - Testing initializeGrid applies asymmetric bounds from root-level data without dynamicWeights...');
    {
        const botKey = `test-grid-root-bounds-${process.pid}`;
        const ordersDir = PATHS.ORDERS_DIR;
        const amaFile = path.join(ordersDir, `${botKey}.dynamicgrid.json`);
        const originalWhitelist = fs.existsSync(whitelistFile())
            ? fs.readFileSync(whitelistFile(), 'utf8')
            : null;

        ensureDir(ordersDir);
        writeJSON(whitelistFile(), {
            whitelist: {
                [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: true }
            }
        });
        _resetBothWhitelistCaches();
        // Snapshot has root-level asymmetricBounds but no dynamicWeights.
        // With trend=UP, buy side widens and sell side narrows.
        writeJSON(amaFile, {
            centerPrice: 1000,
            amaCenterPrice: 1000,
            asymmetricBounds: {
                rawAsymmetryFactor: 0.08,
                appliedAsymmetryFactor: 0.08,
                trend: 'UP',
            },
            updatedAt: new Date().toISOString(),
        });

        try {
            delete require.cache[gridModulePath];
            delete require.cache[managerModulePath];
            const FreshGrid = require('../modules/order/grid');
            const { OrderManager: FreshOrderManager } = require('../modules/order/manager');
            const manager = new FreshOrderManager({
                assetA: 'TESTA',
                assetB: 'TESTB',
                botKey,
                startPrice: 100,
                gridPrice: 'ama',
                minPrice: '2x',
                maxPrice: '2x',
                incrementPercent: 1,
                targetSpreadPercent: 2,
                weightDistribution: { buy: 0.5, sell: 0.5 },
                botFunds: { buy: '100%', sell: '100%' },
                activeOrders: { buy: 6, sell: 6 }
            });

            manager.assets = {
                assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
                assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
            };
            await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });

            await FreshGrid.initializeGrid(manager);

            // With trend=UP and appliedAsymmetryFactor=0.08:
            //   center=1000, minP=1000/2=500, maxP=1000*2=2000
            //   resolvedMinP = 1000 / ((1000/500) * (1 - 0.08)) = 1000 / (2 * 0.92) = 543.478...
            //   resolvedMaxP = 1000 * ((2000/1000) * (1 + 0.08)) = 1000 * (2 * 1.08) = 2160
            assert(manager.orders.size > 0, 'initializeGrid should succeed with root-level asymmetricBounds');
            assert(Math.abs(manager.config.minPrice - 543.4782608695652) < 1e-9,
                'minPrice should be widened (UP trend) from root-level asymmetricBounds');
            assert(Math.abs(manager.config.maxPrice - 2160) < 1e-9,
                'maxPrice should be narrowed (UP trend) from root-level asymmetricBounds');
            assert(Math.abs(manager._lastGridPricingContext.rangeScalingFactor - 0.08) < 1e-12,
                'debug pricing should expose the root-level range-scaling factor');
        } finally {
            safeUnlink(amaFile)
            if (originalWhitelist == null) {
                safeUnlink(whitelistFile())
            } else {
                fs.writeFileSync(whitelistFile(), originalWhitelist, 'utf8');
            }
            _resetBothWhitelistCaches();
        }
    }

    console.log(' - Testing root-level asymmetricBounds clamp against rebuild geometry...');
    {
        const botKey = `test-grid-root-bounds-clamp-${process.pid}`;
        const ordersDir = PATHS.ORDERS_DIR;
        const amaFile = path.join(ordersDir, `${botKey}.dynamicgrid.json`);
        const originalWhitelist = fs.existsSync(whitelistFile())
            ? fs.readFileSync(whitelistFile(), 'utf8')
            : null;

        ensureDir(ordersDir);
        writeJSON(whitelistFile(), {
            whitelist: {
                [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: true }
            }
        });
        _resetBothWhitelistCaches();
        // Persisted factor exceeds the geometric safe limit of the rebuild
        // geometry: DOWN trend with maxPrice '2x' caps the applied factor at
        // 1 - 1/2 = 0.5. The canonical applyAsymmetricBounds path must clamp
        // it instead of applying the raw persisted 0.6 to both sides.
        writeJSON(amaFile, {
            centerPrice: 1000,
            amaCenterPrice: 1000,
            asymmetricBounds: {
                rawAsymmetryFactor: 0.6,
                appliedAsymmetryFactor: 0.6,
                trend: 'DOWN',
            },
            updatedAt: new Date().toISOString(),
        });

        try {
            delete require.cache[gridModulePath];
            delete require.cache[managerModulePath];
            const FreshGrid = require('../modules/order/grid');
            const { OrderManager: FreshOrderManager } = require('../modules/order/manager');
            const manager = new FreshOrderManager({
                assetA: 'TESTA',
                assetB: 'TESTB',
                botKey,
                startPrice: 100,
                gridPrice: 'ama',
                minPrice: '2x',
                maxPrice: '2x',
                incrementPercent: 1,
                targetSpreadPercent: 2,
                weightDistribution: { buy: 0.5, sell: 0.5 },
                botFunds: { buy: '100%', sell: '100%' },
                activeOrders: { buy: 6, sell: 6 }
            });

            manager.assets = {
                assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
                assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
            };
            await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });

            await FreshGrid.initializeGrid(manager);

            // Clamped factor 0.5 widens min to 1000 / (2 * (1 + 0.5)) = 333.33...
            // (the old inline copy applied 0.6 and produced 312.5).
            assert(manager.orders.size > 0, 'initializeGrid should succeed with over-limit root-level factor');
            assert(Math.abs(manager._lastGridPricingContext.rangeScalingFactor - 0.5) < 1e-12,
                'root-level range-scaling factor should be clamped by the canonical safe limit');
            assert(Math.abs(manager.config.minPrice - 333.3333333333333) < 1e-9,
                'widened side should scale with the clamped factor, not the persisted over-limit value');
            assert(manager.config.maxPrice >= 1000,
                'tightened side must stay at or above the grid center after the narrowing-side guard');
        } finally {
            safeUnlink(amaFile)
            if (originalWhitelist == null) {
                safeUnlink(whitelistFile())
            } else {
                fs.writeFileSync(whitelistFile(), originalWhitelist, 'utf8');
            }
            _resetBothWhitelistCaches();
        }
    }

    console.log(' - Testing narrowing-side guard keeps a minimum number of order slots...');
    {
        const botKey = `test-grid-min-slots-${process.pid}`;
        const ordersDir = PATHS.ORDERS_DIR;
        const amaFile = path.join(ordersDir, `${botKey}.dynamicgrid.json`);
        const originalWhitelist = fs.existsSync(whitelistFile())
            ? fs.readFileSync(whitelistFile(), 'utf8')
            : null;

        ensureDir(ordersDir);
        writeJSON(whitelistFile(), {
            whitelist: {
                [botKey]: { ama: true, dynamicWeight: false, asymmetricBounds: true }
            }
        });
        _resetBothWhitelistCaches();
        // DOWN trend: the upper bound tightens toward center. With a near upper
        // bound (1.5x) the old model collapses max to 1050, below the 10-level
        // floor (1.01^10 * 1000 ≈ 1104.62). The guard must hold max above it.
        writeJSON(amaFile, {
            centerPrice: 1000,
            amaCenterPrice: 1000,
            asymmetricBounds: {
                rawAsymmetryFactor: 0.3,
                appliedAsymmetryFactor: 0.3,
                trend: 'DOWN',
            },
            updatedAt: new Date().toISOString(),
        });

        try {
            delete require.cache[gridModulePath];
            delete require.cache[managerModulePath];
            const FreshGrid = require('../modules/order/grid');
            const { OrderManager: FreshOrderManager } = require('../modules/order/manager');
            const manager = new FreshOrderManager({
                assetA: 'TESTA',
                assetB: 'TESTB',
                botKey,
                startPrice: 100,
                gridPrice: 'ama',
                minPrice: '2x',
                maxPrice: '1.5x',
                incrementPercent: 1,
                targetSpreadPercent: 2,
                weightDistribution: { buy: 0.5, sell: 0.5 },
                botFunds: { buy: '100%', sell: '100%' },
                activeOrders: { buy: 6, sell: 6 }
            });

            manager.assets = {
                assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
                assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
            };
            await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });

            await FreshGrid.initializeGrid(manager);

            // minPrice widened DOWN: 1000 / (2 * (1 + 0.3)) = 384.615
            assert(manager.orders.size > 0, 'initializeGrid should succeed with the narrowing-side guard');
            assert(Math.abs(manager.config.minPrice - 384.6153846153846) < 1e-9,
                'minPrice should be widened (DOWN) by the asymmetric bounds');
            assert(Math.abs(manager.config.maxPrice - 1104.6221254112045) < 1e-9,
                'maxPrice should be held at the minimum-slots floor, not collapsed to 1050');
        } finally {
            safeUnlink(amaFile)
            if (originalWhitelist == null) {
                safeUnlink(whitelistFile())
            } else {
                fs.writeFileSync(whitelistFile(), originalWhitelist, 'utf8');
            }
            _resetBothWhitelistCaches();
        }
    }

    console.log(' - Testing AMA gridPrice ignores spread offset without grid range scaling whitelist...');
    {
        const botKey = `test-grid-ama-offset-disabled-${process.pid}`;
        const ordersDir = PATHS.ORDERS_DIR;
        const amaFile = path.join(ordersDir, `${botKey}.dynamicgrid.json`);
        const originalWhitelist = fs.existsSync(whitelistFile())
            ? fs.readFileSync(whitelistFile(), 'utf8')
            : null;

        ensureDir(ordersDir);
        writeJSON(whitelistFile(), {
            whitelist: {
                [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: false }
            }
        });
        _resetBothWhitelistCaches();
        writeJSON(amaFile, {
            gridCenterPrice: 1000,
            centerPrice: 1000,
            amaCenterPrice: 1000,
            gridPriceOffsetPct: 0.8,
            dynamicWeights: {
                isReady: true,
                trend: 'UP',
                slopeOffset: 0.1,
                maxSlopeOffset: 1,
            },
            updatedAt: new Date().toISOString(),
        });

        try {
            delete require.cache[gridModulePath];
            delete require.cache[managerModulePath];
            const FreshGrid = require('../modules/order/grid');
            const { OrderManager: FreshOrderManager } = require('../modules/order/manager');
            const manager = new FreshOrderManager({
                assetA: 'TESTA',
                assetB: 'TESTB',
                botKey,
                startPrice: 100,
                gridPrice: 'ama',
                minPrice: '2x',
                maxPrice: '2x',
                incrementPercent: 1,
                targetSpreadPercent: 2,
                weightDistribution: { buy: 0.5, sell: 0.5 },
                botFunds: { buy: '100%', sell: '100%' },
                activeOrders: { buy: 6, sell: 6 }
            });

            manager.assets = {
                assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
                assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
            };
            await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });

            await FreshGrid.initializeGrid(manager);

            assert(manager.orders.size > 0, 'initializeGrid should succeed with spread offset disabled');
            assert.strictEqual(manager._lastGridPricingContext.gridPriceOffsetPct, 0, 'debug pricing should hide ignored spread offset');
            assert(Math.abs(manager._lastGridPricingContext.gridPrice - 1000) < 1e-9, 'AMA gridPrice should ignore spread offset unless grid range scaling is whitelisted');
            assert(Math.abs(manager._lastGridPricingContext.startPrice - 1000) < 1e-9, 'without the whitelist the rebuild should still fall back to the raw AMA center');
            assert.strictEqual(manager._lastGridPricingContext.rangeScalingFactor, null, 'range scaling should also be disabled by the same whitelist flag');
        } finally {
            safeUnlink(amaFile)
            if (originalWhitelist == null) {
                safeUnlink(whitelistFile())
            } else {
                fs.writeFileSync(whitelistFile(), originalWhitelist, 'utf8');
            }
            _resetBothWhitelistCaches();
        }
    }

    console.log(' - Testing pool gridPrice ignores the persisted AMA spread offset...');
    {
        const botKey = `test-grid-pool-no-offset-${process.pid}`;
        const ordersDir = PATHS.ORDERS_DIR;
        const amaFile = path.join(ordersDir, `${botKey}.dynamicgrid.json`);
        const originalWhitelist = fs.existsSync(whitelistFile())
            ? fs.readFileSync(whitelistFile(), 'utf8')
            : null;
        const systemModule = require('../modules/order/utils/system');

        ensureDir(ordersDir);
        writeJSON(whitelistFile(), {
            whitelist: {
                [botKey]: { ama: true, dynamicWeight: true, asymmetricBounds: true }
            }
        });
        _resetBothWhitelistCaches();
        writeJSON(amaFile, {
            gridCenterPrice: 1000,
            centerPrice: 1000,
            amaCenterPrice: 1000,
            gridPriceOffsetPct: 0.8,
            updatedAt: new Date().toISOString(),
        });

        try {
            // Compiled ESM exports cannot be monkey-patched; use the test
            // hook to make pool derivation fail fast so the startPrice
            // fallback path runs offline.
            systemModule.setDerivePriceTestHook(async () => null);
            const GridFresh = require('../modules/order/grid');

            const manager = new OrderManager({
                assetA: 'TESTA',
                assetB: 'TESTB',
                botKey,
                startPrice: 100,
                gridPrice: 'pool',
                priceMode: 'pool',
                minPrice: '2x',
                maxPrice: '2x',
                incrementPercent: 1,
                targetSpreadPercent: 2,
                weightDistribution: { buy: 0.5, sell: 0.5 },
                botFunds: { buy: '100%', sell: '100%' },
                activeOrders: { buy: 6, sell: 6 }
            });

            manager.assets = {
                assetA: { id: '1.3.1', symbol: 'TESTA', precision: 5 },
                assetB: { id: '1.3.2', symbol: 'TESTB', precision: 5 }
            };
            await manager.setAccountTotals({ buy: 5000, sell: 5000, buyFree: 5000, sellFree: 5000 });

            await GridFresh.initializeGrid(manager);

            assert(manager.orders.size > 0, 'initializeGrid should succeed with a pool gridPrice');
            assert.strictEqual(manager._lastGridPricingContext.gridPriceOffsetPct, 0, 'pool gridPrice should not carry an AMA spread offset in debug context');
            assert(Math.abs(manager._lastGridPricingContext.gridPrice - 100) < 1e-9, 'pool gridPrice fallback should use configured startPrice (100)');
            assert(Math.abs(manager._lastGridPricingContext.startPrice - 100) < 1e-9, 'pool gridPrice fallback should use configured startPrice (100)');
        } finally {
            systemModule.setDerivePriceTestHook(null);
            safeUnlink(amaFile)
            if (originalWhitelist == null) {
                safeUnlink(whitelistFile())
            } else {
                fs.writeFileSync(whitelistFile(), originalWhitelist, 'utf8');
            }
            _resetBothWhitelistCaches();
        }
    }

    console.log(' - Testing shouldFlagOutOfSpread with toleranceSteps = 0.5...');
    {
        // Test case: 1.6% target spread, 0.4% increment, toleranceSteps = 0.5
        // Expected: in spread up to ~1.8%, out of spread above 1.8%
        const targetSpread = 1.6;
        const increment = 0.4;
        const toleranceSteps = 0.5;
        const buyCount = 5;
        const sellCount = 5;

        // At exactly target spread: should be in spread
        let result = shouldFlagOutOfSpread(1.6, targetSpread, toleranceSteps, buyCount, sellCount, increment);
        assert.strictEqual(result, 0, 'At target spread (1.6%), should be in spread');

        // At limit spread (target + 0.5*increment = 1.6 + 0.2 = 1.8): should be in spread
        result = shouldFlagOutOfSpread(1.8, targetSpread, toleranceSteps, buyCount, sellCount, increment);
        assert.strictEqual(result, 0, 'At limit spread (1.8%), should be in spread');

        // Slightly above limit: should be out of spread with 1 slot
        result = shouldFlagOutOfSpread(1.9, targetSpread, toleranceSteps, buyCount, sellCount, increment);
        assert.strictEqual(result, 1, 'Above limit (1.9%), should flag 1 slot excess');

        // Further above limit: should still be 1 slot (capped by Math.max(1, ceil))
        result = shouldFlagOutOfSpread(2.0, targetSpread, toleranceSteps, buyCount, sellCount, increment);
        assert.strictEqual(result, 1, 'At 2.0%, should still flag 1 slot (capped)');

        // Much further above: should be 2 slots
        result = shouldFlagOutOfSpread(2.5, targetSpread, toleranceSteps, buyCount, sellCount, increment);
        assert.strictEqual(result, 2, 'At 2.5%, should flag 2 slots');

        // Edge case: empty side should return nominal gap slot count (not 0)
        result = shouldFlagOutOfSpread(2.0, targetSpread, toleranceSteps, 0, 5, increment);
        assert.strictEqual(result, 4, 'With empty buy side, should return nominal gap slot count');
    }

    console.log(' - Testing on-chain→SPREAD guard in assignGridRoles...');
    {
        const ORDER_TYPES_G = ORDER_TYPES;
        const ORDER_STATES_G = ORDER_STATES;

        // Build a price-sorted rail: boundary=2, gap=2 → buyEndIdx=2, sellStartIdx=5.
        // Indices 3-4 are the SPREAD band.
        const slots = [
            { id: 's0', type: ORDER_TYPES_G.BUY, price: 90, state: ORDER_STATES_G.ACTIVE, orderId: 'oid0' },
            { id: 's1', type: ORDER_TYPES_G.BUY, price: 93, state: ORDER_STATES_G.ACTIVE, orderId: 'oid1' },
            { id: 's2', type: ORDER_TYPES_G.BUY, price: 96, state: ORDER_STATES_G.ACTIVE, orderId: 'oid2' },
            { id: 's3', type: ORDER_TYPES_G.SPREAD, price: 99, state: ORDER_STATES_G.VIRTUAL, orderId: null },
            { id: 's4', type: ORDER_TYPES_G.SPREAD, price: 102, state: ORDER_STATES_G.VIRTUAL, orderId: null },
            { id: 's5', type: ORDER_TYPES_G.SELL, price: 105, state: ORDER_STATES_G.ACTIVE, orderId: 'oid5' },
            { id: 's6', type: ORDER_TYPES_G.SELL, price: 108, state: ORDER_STATES_G.ACTIVE, orderId: 'oid6' }
        ];

        // Case 1: assignOnChain=false (default) — on-chain slots never retyped.
        let result = assignGridRoles(slots, 2, 2, ORDER_TYPES_G, ORDER_STATES_G);
        assert.strictEqual(result[0].type, ORDER_TYPES_G.BUY, 'on-chain buy keeps type without assignOnChain');
        assert.strictEqual(result[5].type, ORDER_TYPES_G.SELL, 'on-chain sell keeps type without assignOnChain');

        // Case 2: assignOnChain=true with boundary shift left (boundary=0, gap=2)
        // → buyEndIdx=0, sellStartIdx=3. Indices 1-2 (on-chain BUY) now fall in the
        // SPREAD band. Guard must keep them BUY, never SPREAD. Indices 3+ are SELL
        // zone — empty VIRTUAL slots (s3, s4) are re-typed SELL by geometry so
        // strategy can allocate budget and activate them on the correct rail.
        result = assignGridRoles(slots, 0, 2, ORDER_TYPES_G, ORDER_STATES_G, { assignOnChain: true });
        assert.strictEqual(result[1].type, ORDER_TYPES_G.BUY, 'on-chain slot in gap keeps BUY rail type');
        assert.strictEqual(result[2].type, ORDER_TYPES_G.BUY, 'on-chain slot in gap keeps BUY rail type');
        // Empty VIRTUAL slots re-typed by geometry when assignOnChain is true.
        assert.strictEqual(result[3].type, ORDER_TYPES_G.SELL, 'empty VIRTUAL slot re-typed to SELL by geometry');
        assert.strictEqual(result[4].type, ORDER_TYPES_G.SELL, 'empty VIRTUAL slot re-typed to SELL by geometry');
        // On-chain SELLs beyond sellStart keep SELL.
        assert.strictEqual(result[5].type, ORDER_TYPES_G.SELL, 'on-chain sell beyond sellStart stays SELL');
        assert.strictEqual(result[6].type, ORDER_TYPES_G.SELL, 'on-chain sell beyond sellStart stays SELL');

        // Case 3: ghost order (PARTIAL + size 0 + orderId) in gap band — also guarded.
        // boundary=0, gap=2 → buyEndIdx=0, sellStartIdx=3; gap band = indices 1-2.
        const ghostSlots = [
            { id: 'g0', type: ORDER_TYPES_G.BUY, price: 90, state: ORDER_STATES_G.ACTIVE, orderId: 'goid0' },
            { id: 'g1', type: ORDER_TYPES_G.SELL, price: 100, state: ORDER_STATES_G.PARTIAL, size: 0, orderId: 'goid1' },
            { id: 'g2', type: ORDER_TYPES_G.SELL, price: 103, state: ORDER_STATES_G.ACTIVE, orderId: 'goid2' }
        ];
        result = assignGridRoles(ghostSlots, 0, 2, ORDER_TYPES_G, ORDER_STATES_G, { assignOnChain: true });
        assert.strictEqual(result[1].type, ORDER_TYPES_G.SELL, 'ghost order in gap keeps SELL rail type');

        // Case 4: empty VIRTUAL slot (size 0, no orderId) with assignOnChain=true
        // is re-typed by geometry — strategy needs BUY/SELL types to allocate
        // budget and activate slots on the correct rail.
        const fillSlots = [
            { id: 'f0', type: ORDER_TYPES_G.SPREAD, price: 100, state: ORDER_STATES_G.VIRTUAL, size: 0, orderId: null },
            { id: 'f1', type: ORDER_TYPES_G.SPREAD, price: 103, state: ORDER_STATES_G.VIRTUAL, size: 0, orderId: null }
        ];
        // boundary=0, gap=0 → buyEndIdx=0, sellStartIdx=1. Geometry assigns
        // index 0 to BUY, index 1 to SELL.
        result = assignGridRoles(fillSlots, 0, 0, ORDER_TYPES_G, ORDER_STATES_G, { assignOnChain: true });
        assert.strictEqual(result[0].type, ORDER_TYPES_G.BUY, 'empty VIRTUAL slot re-typed to BUY by geometry');
        assert.strictEqual(result[1].type, ORDER_TYPES_G.SELL, 'empty VIRTUAL slot re-typed to SELL by geometry');

        // Case 5: empty VIRTUAL slot with stale type — assignOnChain=true means
        // geometry re-types by position regardless of stored type.
        const staleSlots = [
            { id: 'st0', type: ORDER_TYPES_G.BUY, price: 100, state: ORDER_STATES_G.VIRTUAL, size: 0, orderId: null },
            { id: 'st1', type: ORDER_TYPES_G.SELL, price: 103, state: ORDER_STATES_G.VIRTUAL, size: 0, orderId: null }
        ];
        result = assignGridRoles(staleSlots, 0, 0, ORDER_TYPES_G, ORDER_STATES_G, { assignOnChain: true });
        assert.strictEqual(result[0].type, ORDER_TYPES_G.BUY, 'stale BUY empty slot re-typed to BUY by geometry');
        assert.strictEqual(result[1].type, ORDER_TYPES_G.SELL, 'stale SELL empty slot re-typed to SELL by geometry');
    }

    console.log('✓ Grid logic tests passed!');
    process.exit(0);
}

runTests().catch(err => {
    console.error('✗ Tests failed!');
    console.error(err);
    process.exit(1);
});
