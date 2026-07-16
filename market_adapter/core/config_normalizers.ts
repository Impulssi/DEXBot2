'use strict';

const { MARKET_ADAPTER } = require('../../modules/constants');

function normalizeAtrPeriod(period: any, defaultValue = MARKET_ADAPTER.DYNAMIC_WEIGHT_ATR_PERIOD_DEFAULT) {
    const value = Number(period);
    if (!Number.isFinite(value) || value <= 0) return defaultValue;

    const rounded = Math.round(value);
    return Math.max(3, Math.min(30, rounded));
}

function normalizeMaxVolatilityOffset(value: any, defaultValue = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_CLAMP) {
    const numeric = Number(value);
    // Allow 0 to explicitly disable volatility shift
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : defaultValue;
}

function normalizeVolatilityThreshold(value: any, defaultValue = MARKET_ADAPTER.DYNAMIC_WEIGHT_SYMMETRIC_SHIFT_THRESHOLD) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : defaultValue;
}

export = {
    normalizeAtrPeriod,
    normalizeMaxVolatilityOffset,
    normalizeVolatilityThreshold,
};
