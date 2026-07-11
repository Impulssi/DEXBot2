'use strict';

const { resolveBotRuntimeSettings } = require('../modules/runtime_settings');
const {
    GRID_LIMITS, FEE_PARAMETERS, INCREMENT_BOUNDS, TIMING,
    LOG_LEVEL, LOGGING_CONFIG,
} = require('../modules/constants');

const assert = require('assert');

{
    const rs = resolveBotRuntimeSettings({ name: 'test-bot', assetA: 'BTS', assetB: 'USD' });

    assert.ok(rs.gridLimits, 'gridLimits should be present');
    assert.strictEqual(rs.gridLimits.MIN_SPREAD_FACTOR, GRID_LIMITS.MIN_SPREAD_FACTOR);
    assert.ok(rs.gridLimits.GRID_COMPARISON, 'GRID_COMPARISON should be present');
    assert.strictEqual(rs.gridLimits.GRID_COMPARISON.RMS_PERCENTAGE, GRID_LIMITS.GRID_COMPARISON.RMS_PERCENTAGE);

    assert.ok(rs.feeParams, 'feeParams should be present');
    assert.strictEqual(rs.feeParams.BTS_RESERVATION_MULTIPLIER, FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER);
    assert.strictEqual(rs.feeParams.POOL_SLIPPAGE_TOLERANCE, FEE_PARAMETERS.POOL_SLIPPAGE_TOLERANCE);

    assert.ok(rs.timing, 'timing should be present');
    assert.strictEqual(rs.timing.BTS_ACQUIRE_COOLDOWN_MIN, TIMING.BTS_ACQUIRE_COOLDOWN_MIN);
    assert.strictEqual(rs.timing.OPEN_ORDERS_SYNC_LOOP_ENABLED, TIMING.OPEN_ORDERS_SYNC_LOOP_ENABLED);

    assert.ok(rs.incrementBounds, 'incrementBounds should be present');
    assert.strictEqual(rs.incrementBounds.MIN_PERCENT, INCREMENT_BOUNDS.MIN_PERCENT);

    assert.ok(rs.logging, 'logging should be present');
    assert.strictEqual(rs.logging.level, LOG_LEVEL);
    assert.ok(rs.logging.config, 'logging.config should be present');
}

{
    const rs = resolveBotRuntimeSettings({
        name: 'test-bot',
        assetA: 'BTS', assetB: 'USD',
        gridLimits: { minSpreadFactor: 4.5, gridRegenerationPercentage: 7 },
        feeParams: { btsReservationMultiplier: 10, poolSlippageTolerance: 0.05 },
        timing: { openOrdersSyncLoopEnabled: true, btsAcquireCooldownMin: 30 },
        incrementBounds: { minPercent: 0.005, maxPercent: 15 },
        logging: { level: 'debug' },
    });

    assert.strictEqual(rs.gridLimits.MIN_SPREAD_FACTOR, 4.5, 'camelCase minSpreadFactor → MIN_SPREAD_FACTOR');
    assert.strictEqual(rs.gridLimits.GRID_REGENERATION_PERCENTAGE, 7, 'camelCase gridRegenerationPercentage → GRID_REGENERATION_PERCENTAGE');

    assert.strictEqual(rs.feeParams.BTS_RESERVATION_MULTIPLIER, 10, 'camelCase btsReservationMultiplier → BTS_RESERVATION_MULTIPLIER');
    assert.strictEqual(rs.feeParams.POOL_SLIPPAGE_TOLERANCE, 0.05);

    assert.strictEqual(rs.timing.OPEN_ORDERS_SYNC_LOOP_ENABLED, true, 'camelCase openOrdersSyncLoopEnabled → OPEN_ORDERS_SYNC_LOOP_ENABLED');
    assert.strictEqual(rs.timing.BTS_ACQUIRE_COOLDOWN_MIN, 30, 'camelCase btsAcquireCooldownMin → BTS_ACQUIRE_COOLDOWN_MIN');

    assert.strictEqual(rs.incrementBounds.MIN_PERCENT, 0.005);
    assert.strictEqual(rs.incrementBounds.MAX_PERCENT, 15);

    assert.strictEqual(rs.logging.level, 'debug');

    assert.strictEqual(rs.gridLimits.MIN_ORDER_SIZE_FACTOR, GRID_LIMITS.MIN_ORDER_SIZE_FACTOR, 'un-overridden keys keep global defaults');
    assert.strictEqual(rs.feeParams.BTS_FALLBACK_FEE, FEE_PARAMETERS.BTS_FALLBACK_FEE, 'un-overridden fee keys keep global defaults');
    assert.strictEqual(rs.timing.SYNC_DELAY_MS, TIMING.SYNC_DELAY_MS, 'un-overridden timing keys keep global defaults');
}

{
    const rs = resolveBotRuntimeSettings({
        name: 'test-bot',
        assetA: 'BTS', assetB: 'USD',
        gridLimits: { gridComparison: { rmsPercentage: 25 } },
        feeParams: { grapheneFeeRateDenom: 500000, grapheneCollateralRatioDenom: 2000 },
    });

    assert.strictEqual(rs.gridLimits.GRID_COMPARISON.RMS_PERCENTAGE, 25, 'nested camelCase gridComparison.rmsPercentage → GRID_COMPARISON.RMS_PERCENTAGE');
    assert.strictEqual(rs.feeParams.GRAPHENE_FEE_RATE_DENOM, 500000, 'camelCase grapheneFeeRateDenom → GRAPHENE_FEE_RATE_DENOM');
    assert.strictEqual(rs.feeParams.GRAPHENE_COLLATERAL_RATIO_DENOM, 2000, 'camelCase grapheneCollateralRatioDenom → GRAPHENE_COLLATERAL_RATIO_DENOM');

    assert.strictEqual(rs.feeParams.DEFAULT_MAX_FEE_RATE_PER_DAY, FEE_PARAMETERS.DEFAULT_MAX_FEE_RATE_PER_DAY, 'un-overridden key keeps default');
}

{
    const bogus = resolveBotRuntimeSettings({ name: undefined, assetA: 'BTS', assetB: 'USD' });
    assert.strictEqual(bogus.gridLimits.MIN_SPREAD_FACTOR, GRID_LIMITS.MIN_SPREAD_FACTOR, 'works with minimal config');
    assert.strictEqual(bogus.logging.level, LOG_LEVEL);
}

{
    const rs = resolveBotRuntimeSettings({
        name: 'test-bot',
        assetA: 'BTS', assetB: 'USD',
        feeParams: { defaultMaxFeeRatePerDay: 0.001 },
    });
    assert.strictEqual(rs.feeParams.DEFAULT_MAX_FEE_RATE_PER_DAY, 0.001, 'camelCase defaultMaxFeeRatePerDay → DEFAULT_MAX_FEE_RATE_PER_DAY');
}

console.log('runtime_settings tests passed');
