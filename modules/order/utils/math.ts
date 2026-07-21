/**
 * modules/order/utils/math.ts - Mathematical and Numeric Utilities
 * 
 * Pure numeric calculations, blockchain conversions, fee math, and fund allocation.
 *
 * ===============================================================================
 * TABLE OF CONTENTS (42 exported functions)
 * ===============================================================================
 *
 * SECTION 1: PARSING & VALIDATION (4 functions)
 *   - isExplicitZeroAllocation(value) - Check if value is explicitly zero
 *   - isPercentageString(v) - Check if value is percentage string
 *   - parsePercentageString(v) - Parse percentage string to decimal
 *   - resolveRelativePrice(value, startPrice, mode) - Resolve relative price values
 *
 * SECTION 2: FUND CALCULATIONS (4 functions)
 *   - computeChainFundTotals(accountTotals, committedChain) - Compute total funds
 *   - calculateAvailableFundsValue(side, accountTotals, funds, ...) - Calculate available funds
 *   - calculateSpreadFromOrders(activeBuys, activeSells) - Calculate spread percentage
 *   - resolveConfigValue(value, total) - Resolve percentage or absolute config value
 *
 * SECTION 3: BLOCKCHAIN CONVERSIONS (5 functions)
 *   - blockchainToFloat(intValue, precision) - Convert blockchain int to float
 *   - floatToBlockchainInt(floatValue, precision) - Convert float to blockchain int
 *   - quantizeFloat(value, precision) - Round float to blockchain precision
 *   - normalizeInt(value, precision) - Normalize int within precision bounds
 *   - hasValidAccountTotals(accountTotals, checkFree) - Validate account totals structure
 *
 * SECTION 4: PRECISION & FORMATTING UTILITIES (8 functions)
 *   - roundTo(value, factor) - Round to a factor
 *   - fixedTo(value, decimals) - Format to fixed decimal string
 *   - roundToDecimals(value, decimals) - Round to N decimal places
 *   - getPrecision(assets, orderType) - Get precision for order type
 *   - getPrecisionByOrderType(assets, orderType) - Alias for getPrecision
 *   - getPrecisionForSide(assets, side) - Get precision by side (buy/sell)
 *   - getPrecisionsForManager(manager) - Get both asset precisions
 *   - getPrecisionSlack(precision) - Calculate tolerance for precision
 *
 * SECTION 5: ORDER SIZE VALIDATION (7 functions)
 *   - calculatePriceTolerance(price, size, type, assets) - Calculate price match tolerance
 *   - validateOrderAmountsWithinLimits(amountToSell, minToReceive) - Validate order limits
 *   - getMinOrderSize(assets, type) - Get minimum order size for type
 *   - getDustThresholdFactor() - Get dust threshold multiplier
 *   - getSingleDustThreshold(idealSize, dustThresholdPercent) - Get single dust threshold
 *   - getDoubleDustThreshold(idealSize, dustThresholdPercent) - Get double dust threshold
 *   - getMinAbsoluteOrderSize(orderType, assets, minFactor) - Get minimum absolute order size
 *   - validateOrderSize(manager, size, type, context) - Validate order size against minimums
 *
 * SECTION 6: FEE CALCULATIONS (2 functions + 2 internal)
 *   - getAssetFees(assetSymbol, assetAmount, isMaker) - Get fee info for asset
 *   - _setFeeCache(cache) - Set internal fee cache (internal)
 *   - _getFeeCache() - Get internal fee cache (internal)
 *
 * SECTION 7: FUND ALLOCATION (6 functions)
 *   - allocateFundsByWeights(available, targetCount) - Allocate funds by weight
 *   - cloneWeightDistribution(weightDistribution, base) - Clone weight distribution safely
 *   - calculateOrderSizes(manager, orderType) - Calculate order sizes for placement
 *   - calculateRotationOrderSizes(manager, orderType, fillAmount) - Calculate rotation sizes
 *   - calculateGridSideDivergenceMetric(manager, orderType, threshold) - Calculate divergence
 *   - clamp(value, min, max) - Clamp a value between min and max bounds
 *
 * SECTION 8: FEE DEDUCTION (3 functions)
 *   - calculateOrderCreationFees(count, btsFeeData) - Calculate total creation fees
 *   - deductOrderFeesFromFunds(available, count, btsFeeData, btsSide) - Deduct fees from funds
 *   - calculateSwapInAmount(targetReceive, poolReserveOut, poolReserveIn) - AMM swap math
 *
 * SECTION 9: GRID UTILITIES (1 function)
 *   - calculateGapSlots(incrementPercent, targetSpreadPercent) - Calculate gap slots count
 *
 * ===============================================================================
 */

const { ORDER_TYPES, FEE_PARAMETERS, DEFAULT_CONFIG, BTS_PRECISION, GRID_LIMITS } = require('../../constants');
const Format = require('../format');
const { isValidNumber, toFiniteNumber, isNumeric } = Format;
const Logger = require('../../logger');
const mathLogger = new Logger('Math');
const fundRegistry = require('../../fund_registry');

const MAX_INT64 = 9223372036854775807;
const MIN_INT64 = -9223372036854775808;

// ================================================================================
// SECTION 1: PARSING & VALIDATION
// ================================================================================

/**
 * Check if a value is explicitly set to zero (number 0, string "0", or "0%").
 * Used to distinguish between "not set" and "explicitly disabled".
 * 
 * @param {*} value - Value to check
 * @returns {boolean} True if value is explicitly zero
 */
function isExplicitZeroAllocation(value) {
    if (typeof value === 'number') return value === 0;
    if (typeof value !== 'string') return false;

    const trimmed = value.trim();
    if (trimmed === '') return false;

    if (trimmed.endsWith('%')) {
        const percent = parseFloat(trimmed.slice(0, -1));
        return Number.isFinite(percent) && percent === 0;
    }

    const numeric = parseFloat(trimmed);
    return Number.isFinite(numeric) && numeric === 0;
}

/**
 * Check if a value is a percentage string (ends with '%').
 * 
 * @param {*} v - Value to test
 * @returns {boolean} True if v is a string ending with '%'
 */
function isPercentageString(v) {
    return typeof v === 'string' && v.trim().endsWith('%');
}

/**
 * Check if a value is a positive number.
 *
 * @param {*} value - Value to test
 * @returns {boolean} True if the value is a finite number greater than 0
 */
function isPositiveNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0;
}

/**
 * Check if a value is a positive number or a positive percentage string.
 *
 * @param {*} value - Value to test
 * @returns {boolean} True if the value is a positive number or a percentage string like "25%"
 */
function isPositiveNumberOrPercent(value) {
    if (isPositiveNumber(value)) return true;
    if (!isPercentageString(value)) return false;
    const percent = parseFloat(value.trim().slice(0, -1));
    return Number.isFinite(percent) && percent > 0;
}

/**
 * Check if a value is a positive integer.
 *
 * @param {*} value - Value to test
 * @returns {boolean} True if the value is an integer greater than 0
 */
function isPositiveInt(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Parse a percentage string to decimal form.
 * Extracts numeric value before '%' and divides by 100.
 * 
 * @param {string} v - Percentage string (e.g., "50%")
 * @returns {number|null} Decimal form (e.g., 0.5) or null if invalid
 */
function parsePercentageString(v) {
    if (!isPercentageString(v)) return null;
    const num = parseFloat(v.trim().slice(0, -1));
    return Number.isNaN(num) ? null : num / 100.0;
}

/**
 * Convert a value (number, percentage string, or numeric string) to its
 * decimal form. Unlike parsePercentageString which only handles '%' strings,
 * this also accepts bare numbers and numeric strings.
 * @param {*} value - Number (100 = 100), "100%" (= 1.0), or "100" (= 100)
 * @returns {number} Decimal value, 0 if unparseable
 */
function toDecimal(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.endsWith('%')) {
            const n = parseFloat(trimmed);
            return Number.isNaN(n) ? 0 : n / 100;
        }
        const n = parseFloat(trimmed);
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

/**
 * Resolve a relative price expression (multiplier format) to absolute price.
 * Supports expressions like "3x" to mean 3 times the reference price.
 * 
 * @param {*} value - Value to resolve (e.g., "3x" or "0.5x")
 * @param {number} startPrice - Reference price for multiplier calculation
 * @param {string} [mode='min'] - "min" divides (price/multiplier), "max" multiplies (price*multiplier)
 * @returns {number|null} Resolved price or null if value is not a relative expression
 */
function resolveRelativePrice(value, startPrice, mode = 'min') {
    if (typeof value === 'string') {
        if (/^[\s]*[0-9]+(?:\.[0-9]+)?x[\s]*$/i.test(value)) {
            const multiplier = parseFloat(value.trim().toLowerCase().slice(0, -1));
            if (!Number.isNaN(multiplier) && Number.isFinite(startPrice) && multiplier !== 0) {
                return mode === 'min' ? startPrice / multiplier : startPrice * multiplier;
            }
        }
    }
    return null;
}

// ================================================================================
// SECTION 2: FUND CALCULATIONS
// ================================================================================

/**
 * Calculate chain fund totals from account balances and committed orders.
 * Reconciles free/locked balances with committed capital to produce fund summary.
 * 
 * @param {Object} accountTotals - Account balance snapshot with buyFree, sellFree, buy, sell properties
 * @param {Object} committedChain - Committed capital with buy and sell properties
 * @returns {Object} Summary object with chainFreeBuy, chainFreeSell, committedChainBuy, 
 *                   committedChainSell, freePlusLockedBuy, freePlusLockedSell, chainTotalBuy, chainTotalSell
 */
function computeChainFundTotals(accountTotals, committedChain) {
    const chainFreeBuy = toFiniteNumber(accountTotals?.buyFree);
    const chainFreeSell = toFiniteNumber(accountTotals?.sellFree);
    const committedChainBuy = toFiniteNumber(committedChain?.buy);
    const committedChainSell = toFiniteNumber(committedChain?.sell);

    const freePlusLockedBuy = chainFreeBuy + committedChainBuy;
    const freePlusLockedSell = chainFreeSell + committedChainSell;

    const chainTotalBuy = isValidNumber(accountTotals?.buy)
        ? Math.max(Number(accountTotals.buy), freePlusLockedBuy)
        : freePlusLockedBuy;
    const chainTotalSell = isValidNumber(accountTotals?.sell)
        ? Math.max(Number(accountTotals.sell), freePlusLockedSell)
        : freePlusLockedSell;

    return {
        chainFreeBuy,
        chainFreeSell,
        committedChainBuy,
        committedChainSell,
        freePlusLockedBuy,
        freePlusLockedSell,
        chainTotalBuy,
        chainTotalSell
    };
}

// ================================================================================
// SECTION 2A: PRECISION QUANTIZATION
// ================================================================================

/**
 * Quantize a float value by round-tripping through blockchain integer representation.
 * Converts float → blockchain int (satoshi-level precision) → float.
 * Eliminates floating-point accumulation errors.
 *
 * @param {number} value - Float value to quantize
 * @param {number} precision - Asset precision (satoshis)
 * @returns {number} Quantized float value
 */
function quantizeFloat(value, precision) {
    return blockchainToFloat(floatToBlockchainInt(value, precision), precision);
}

/**
 * Normalize an integer value by round-tripping through float representation.
 * Converts int → float (readable format) → blockchain int.
 * Ensures the integer aligns with precision boundaries.
 * Used for precision-aware comparisons.
 *
 * @param {number} value - Integer value to normalize
 * @param {number} precision - Asset precision (satoshis)
 * @returns {number} Normalized integer value
 */
function normalizeInt(value, precision) {
    return floatToBlockchainInt(blockchainToFloat(value, precision), precision);
}

/**
 * Fee cache local to math.js for getAssetFees.
 * Will be populated by system.js::initializeFeeCache.
 */
let feeCache = {};

/**
 * @private Set the fee cache (called by system.js::initializeFeeCache).
 *
 * @param {Object} cache - Fee cache object keyed by asset symbol
 * @returns {void}
 */
function _setFeeCache(cache) { feeCache = cache; }

/**
 * Get fee information for an asset.

 * Returns fee structure or net proceeds calculation if asset amount provided.
 * 
 * @param {string} assetSymbol - Asset symbol (e.g., "BTS", "USD")
 * @param {number} [assetAmount=null] - Asset amount to calculate net proceeds
 * @param {boolean} [isMaker=true] - Whether this is a maker or taker (affects BTS fees)
 * @returns {Object} Fee structure with create/update/net fees or net proceeds if amount provided
 * @throws {Error} If fees not cached (call initializeFeeCache first)
 */
function getAssetFees(assetSymbol, assetAmount = null, isMaker = true) {
    const cachedFees = feeCache[assetSymbol];
    if (!cachedFees) {
        throw new Error(`Fees not cached for ${assetSymbol}. Call initializeFeeCache first.`);
    }

    if (assetSymbol === 'BTS') {
        const orderCreationFee = cachedFees.limitOrderCreate.bts;
        const orderUpdateFee = cachedFees.limitOrderUpdate.bts;
        const orderCancelFee = cachedFees.limitOrderCancel?.bts || 0;
        const makerFeeDiscountPercent = Number.isFinite(Number(cachedFees.makerFeeDiscountPercent))
            ? Math.max(0, Number(cachedFees.makerFeeDiscountPercent))
            : FEE_PARAMETERS.MAKER_REFUND_PERCENT;
        const makerNetFee = orderCreationFee * FEE_PARAMETERS.MAKER_FEE_PERCENT;
        const takerNetFee = orderCreationFee * FEE_PARAMETERS.TAKER_FEE_PERCENT;
        const netFee = isMaker ? makerNetFee : takerNetFee;

        if (assetAmount !== null && assetAmount !== undefined) {
            const amount = Number(assetAmount);
            const refund = isMaker ? (orderCreationFee * makerFeeDiscountPercent) : 0;
            const netProceeds = amount + refund;
            return {
                netProceeds: netProceeds,
                total: netProceeds,
                refund: refund,
                isMaker: isMaker
            };
        }

        return {
            total: netFee + orderUpdateFee,
            createFee: orderCreationFee,
            updateFee: orderUpdateFee,
            cancelFee: orderCancelFee,
            makerFeeDiscountPercent,
            makerNetFee: makerNetFee,
            takerNetFee: takerNetFee,
            netFee: netFee,
            isMaker: isMaker
        };
    }

    const chargesMarketFees = cachedFees.chargesMarketFees === true;
    const feePercent = chargesMarketFees && isMaker
        ? (cachedFees.marketFee?.percent || 0)
        : chargesMarketFees
            ? (cachedFees.takerFee?.percent || cachedFees.marketFee?.percent || 0)
            : 0;

    if (assetAmount !== null && assetAmount !== undefined) {
        const amount = Number(assetAmount);
        const maxMarketFee = Number.isFinite(Number(cachedFees.maxMarketFee?.float))
            ? Math.max(0, Number(cachedFees.maxMarketFee.float))
            : Infinity;
        const feeAmount = Math.min((amount * feePercent) / 100, maxMarketFee);
        const netProceeds = amount - feeAmount;
        return {
            netProceeds: netProceeds,
            total: netProceeds,
            feeAmount: feeAmount,
            feePercent: feePercent,
            isMaker: isMaker
        };
    }

    return {
        marketFee: cachedFees.marketFee?.percent || 0,
        takerFee: cachedFees.takerFee?.percent || 0,
        percent: feePercent
    };
}

/**
 * Calculate available funds for a specific side (buy or sell).
 * Deducts virtual reservations, BTS fees owed, and BTS fee reservation from chain-free balance.
 * 
 * @param {string} side - Trading side: "buy" or "sell"
 * @param {Object} accountTotals - Account balance snapshot
 * @param {Object} funds - Fund allocation object with virtual, btsFeesOwed properties
 * @param {string} assetA - First asset symbol
 * @param {string} assetB - Second asset symbol
 * @param {Object} [activeOrders=null] - Active order counts {buy, sell} for BTS reservation calculation
 * @returns {number} Available funds for the side (0 if side invalid or insufficient funds)
 */
function calculateAvailableFundsValue(side, accountTotals, funds, assetA, assetB, activeOrders = null, configMinBtsValue = null, feeParams = null) {
    if (side !== 'buy' && side !== 'sell') return 0;

    const chainFree = toFiniteNumber(side === 'buy' ? accountTotals?.buyFree : accountTotals?.sellFree);
    const virtualReservation = toFiniteNumber(side === 'buy' ? funds.virtual?.buy : funds.virtual?.sell);
    const btsFeesOwed = toFiniteNumber(funds.btsFeesOwed);
    const btsSide = (assetA === 'BTS') ? 'sell' : (assetB === 'BTS') ? 'buy' : null;

    const btsReservationMultiplier = feeParams?.BTS_RESERVATION_MULTIPLIER ?? FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER;

    let btsFeesReservation = 0;
    if (btsSide === side && activeOrders) {
        const targetBuy = Math.max(0, toFiniteNumber(activeOrders?.buy, 1));
        const targetSell = Math.max(0, toFiniteNumber(activeOrders?.sell, 1));
        const totalTargetOrders = targetBuy + targetSell;
        btsFeesReservation = calculateOrderCreationFees(assetA, assetB, totalTargetOrders, btsReservationMultiplier);
    }

    const currentFeesOwed = (btsSide === side) ? btsFeesOwed : 0;

    // Non-BTS pair: reserve proportional share for BTS fee budget
    if (!btsSide && activeOrders && funds?.btsBalance != null) {
        const targetBuy = Math.max(0, toFiniteNumber(activeOrders?.buy, 1));
        const targetSell = Math.max(0, toFiniteNumber(activeOrders?.sell, 1));
        const totalTargetOrders = targetBuy + targetSell;
        const formulaBudget = calculateOrderCreationFees(assetA, assetB, totalTargetOrders, btsReservationMultiplier);
        const effectiveMin = (configMinBtsValue > 0) ? configMinBtsValue : formulaBudget;
        const btsFree = toFiniteNumber(funds?.btsBalance?.free, 0);
        const btsDeficit = Math.max(0, effectiveMin - btsFree);
        if (btsDeficit > 0) {
            const totalFree = toFiniteNumber(accountTotals?.buyFree, 0)
                            + toFiniteNumber(accountTotals?.sellFree, 0);
            if (totalFree > 0) {
                const sideFree = toFiniteNumber(side === 'buy' ? accountTotals?.buyFree : accountTotals?.sellFree, 0);
                const share = sideFree / totalFree;
                return Math.max(0, chainFree - virtualReservation - btsDeficit * share);
            }
        }
    }

    return Math.max(0, chainFree - virtualReservation - currentFeesOwed - btsFeesReservation);
}

/**
 * Find the best (highest) buy price and best (lowest) sell price from active orders.
 *
 * @param {Array<Object>} activeBuys - Active buy orders with price property
 * @param {Array<Object>} activeSells - Active sell orders with price property
 * @returns {{bestBuy: number|null, bestSell: number|null}} Best prices or null if no orders
 */
function getGridBestPrices(activeBuys, activeSells) {
    const bestBuy  = activeBuys.length  > 0 ? Math.max(...activeBuys.map(o => o.price))  : null;
    const bestSell = activeSells.length > 0 ? Math.min(...activeSells.map(o => o.price)) : null;
    return { bestBuy, bestSell };
}

/**
 * Calculate bid-ask spread percentage from active buy and sell orders.
 * Spread = (bestSell / bestBuy - 1) * 100 (percentage).
 *
 * @param {Array<Object>} activeBuys - Active buy orders with price property
 * @param {Array<Object>} activeSells - Active sell orders with price property
 * @returns {number} Spread percentage or 0 if insufficient data
 */
function calculateSpreadFromOrders(activeBuys, activeSells) {
    const { bestBuy, bestSell } = getGridBestPrices(activeBuys, activeSells);
    if (bestBuy === null || bestSell === null || bestBuy === 0) return 0;
    return ((bestSell / bestBuy) - 1) * 100;
}

/**
 * Resolve a config value to a numeric amount.
 * Interprets percentage strings, numeric strings, or direct numbers.
 * 
 * @param {*} value - Value to resolve (string, number, or percentage)
 * @param {number} total - Total amount for percentage calculations
 * @returns {number} Resolved numeric value or 0 if uninterpretable
 */
function resolveConfigValue(value, total) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const p = parsePercentageString(value);
        if (p !== null) {
            if (total === null || total === undefined) return 0;
            return total * p;
        }
        const n = parseFloat(value);
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

/**
 * Resolve a config value to a numeric amount, accounting for shared-account
 * fund registry. If the bot has a registry entry, returns the proportional
 * share of chainTotal. Falls back to standard resolveConfigValue if the
 * registry has no entry for this bot (single-bot accounts or unregistered).
 *
 * @param {*} value - Value to resolve (string, number, or percentage)
 * @param {number} chainTotal - Total chain balance for this side
 * @param {string} account - Blockchain account name
 * @param {string} botName - Bot identifier
 * @param {'buy'|'sell'} side - Trade side
 * @returns {number} Resolved numeric value or 0 if uninterpretable
 */
function resolveConfigValueWithRegistry(value, chainTotal, account, botName, side) {
    const effective = fundRegistry.getEffectiveAllocationSync(account, botName, side, chainTotal);
    if (effective !== null) return effective;
    return resolveConfigValue(value, chainTotal);
}

/**
 * Check if account totals contain valid buy/sell balance data.
 * 
 * @param {Object} accountTotals - Account total balances object
 * @param {boolean} [checkFree=true] - Check free balances if true, else check total balances
 * @returns {boolean} True if both buy and sell values are valid finite numbers
 */
function hasValidAccountTotals(accountTotals, checkFree = true) {
    if (!accountTotals) return false;
    const buyKey = checkFree ? 'buyFree' : 'buy';
    const sellKey = checkFree ? 'sellFree' : 'sell';
    return isValidNumber(accountTotals[buyKey]) && isValidNumber(accountTotals[sellKey]);
}

// ================================================================================
// SECTION 3: BLOCKCHAIN CONVERSIONS & PRECISION
// ================================================================================

/**
 * Convert blockchain integer to float using asset precision.
 * Divides by 10^precision to convert satoshi-level units to human-readable float.
 * Formula: float = blockchain_int / (10^precision)
 *
 * @param {number} intValue - Integer value from blockchain (satoshi units)
 * @param {number} precision - Asset precision level (exponent: 5, 8, 4, etc)
 * @returns {number} Float representation in human-readable units
 * @throws {Error} If precision is invalid
 */
function blockchainToFloat(intValue, precision) {
    if (!isValidNumber(precision)) {
        throw new Error(`Invalid precision for blockchainToFloat: ${precision}`);
    }
    return toFiniteNumber(intValue) / Math.pow(10, Number(precision));
}

/**
 * Convert float to blockchain integer using asset precision.
 * Multiplies by 10^precision and rounds to satoshi-level units.
 * Clamps to MAX_INT64/MIN_INT64 to prevent overflow.
 * Formula: blockchain_int = round(float * (10^precision))
 *
 * Round-trip (float → int → float) eliminates floating-point accumulation errors.
 * Overflow protection: Blockchain integers must fit in signed 64-bit range.
 *
 * @param {number} floatValue - Float value to convert (human-readable units)
 * @param {number} precision - Asset precision level (exponent: 5, 8, 4, etc)
 * @returns {number} Blockchain integer representation (satoshi units)
 * @throws {Error} If precision is invalid
 */
function floatToBlockchainInt(floatValue, precision) {
    if (!isValidNumber(precision)) {
        throw new Error(`Invalid precision for floatToBlockchainInt: ${precision}`);
    }
    const p = Number(precision);
    const v = toFiniteNumber(floatValue);
    const scaled = Math.round(v * Math.pow(10, p));

    if (scaled > MAX_INT64 || scaled < MIN_INT64) {
        mathLogger.warn(`Overflow detected: ${floatValue} with precision ${p} resulted in ${scaled}. Clamping to safe limits.`);
        return scaled > 0 ? MAX_INT64 : MIN_INT64;
    }

    return scaled;
}

/**
 * Get asset precision for a specific order type (BUY or SELL).
 * BUY orders size in assetB, SELL orders size in assetA.
 * 
 * @param {Object} assets - Asset metadata with assetA and assetB
 * @param {string} orderType - Order type (ORDER_TYPES.BUY or ORDER_TYPES.SELL)
 * @returns {number} Asset precision
 * @throws {Error} If precision missing for the required asset
 */
function getPrecisionByOrderType(assets, orderType) {
    const asset = orderType === ORDER_TYPES.SELL ? assets?.assetA : assets?.assetB;
    const side = orderType === ORDER_TYPES.SELL ? 'SELL' : 'BUY';

    if (typeof asset?.precision !== 'number') {
        const errorMsg = `CRITICAL: Asset precision missing for ${side} orders. Asset: ${asset?.symbol || '(unknown)'}. Cannot determine blockchain precision.`;
        mathLogger.error(`${errorMsg}`);
        throw new Error(errorMsg);
    }

    return asset.precision;
}

/**
 * Get asset precision for a specific trading side.
 * 
 * @param {Object} assets - Asset metadata with assetA and assetB
 * @param {string} side - Side ("buy" or "sell")
 * @returns {number} Asset precision for the side
 * @throws {Error} If precision missing
 */
function getPrecisionForSide(assets, side) {
    const asset = side === 'buy' ? assets?.assetB : assets?.assetA;
    const sideUpper = side === 'buy' ? 'BUY' : 'SELL';

    if (typeof asset?.precision !== 'number') {
        const errorMsg = `CRITICAL: Asset precision missing for ${sideUpper} side. Asset: ${asset?.symbol || '(unknown)'}. Cannot determine blockchain precision.`;
        mathLogger.error(`${errorMsg}`);
        throw new Error(errorMsg);
    }

    return asset.precision;
}

/**
 * Get asset precisions for both assetA and assetB.
 * 
 * @param {Object} assets - Asset metadata with assetA and assetB
 * @returns {Object} Object with A and B precision properties
 * @throws {Error} If precision missing for either asset
 */
function getPrecisionsForManager(assets) {
    if (typeof assets?.assetA?.precision !== 'number') {
        const errorMsg = `CRITICAL: Asset precision missing for assetA (${assets?.assetA?.symbol || '(unknown)'}). Cannot determine blockchain precision.`;
        mathLogger.error(`${errorMsg}`);
        throw new Error(errorMsg);
    }

    if (typeof assets?.assetB?.precision !== 'number') {
        const errorMsg = `CRITICAL: Asset precision missing for assetB (${assets?.assetB?.symbol || '(unknown)'}). Cannot determine blockchain precision.`;
        mathLogger.error(`${errorMsg}`);
        throw new Error(errorMsg);
    }

    return {
        A: assets.assetA.precision,
        B: assets.assetB.precision
    };
}

/**
 * Calculate precision slack (rounding tolerance) for a given precision level.
 * Used for safe comparison of blockchain values that may differ by rounding.
 * 
 * @param {number} precision - Asset precision level
 * @param {number} [factor=2] - Multiplier for slack (default 2)
 * @returns {number} Tolerance value (e.g., 2 * 10^-8 for 8-decimal precision)
 */
function getPrecisionSlack(precision, factor = 2) {
    return factor * Math.pow(10, -precision);
}

/**
 * Unified precision lookup for assets.
 * 
 * @param {Object} assets - Assets object with assetA and assetB
 * @param {Object} [options={}] - Lookup options { type, side, proceeds }
 * @returns {number} Asset precision
 */
function getPrecision(assets: any, { type, side, proceeds = false }: { type?: string; side?: string; proceeds?: boolean } = {}) {
    if (!assets) throw new Error("Assets object required for precision lookup");
    
    // Determine target side: side param priority, then type param
    let isSellSide;
    if (side) isSellSide = (side === 'sell');
    else if (type) isSellSide = (type === ORDER_TYPES.SELL);
    else throw new Error("Either 'type' or 'side' must be provided for getPrecision");

    // Proceeds logic: SELL (assetA) results in assetB proceeds; BUY (assetB) results in assetA
    const targetIsAssetA = proceeds ? !isSellSide : isSellSide;
    const asset = targetIsAssetA ? assets.assetA : assets.assetB;
    
    if (typeof asset?.precision !== 'number') {
        const label = targetIsAssetA ? 'assetA' : 'assetB';
        throw new Error(`CRITICAL: Precision missing for ${label} (${asset?.symbol || 'unknown'}).`);
    }
    return asset.precision;
}

// ================================================================================
// SECTION 4: PRICE OPERATIONS (PART 1 - Tolerance)
// ================================================================================

/**
 * Calculate price tolerance for order matching on-chain.
 * Accounts for precision limits of both assets to determine acceptable price deviation.
 * Used when matching grid orders to blockchain orders.
 *
 * NOTE on the orderSize parameter: larger sizes produce tighter (more precise)
 * tolerance values. When using this function for duplicate-price-level
 * detection, always pass Math.max(sizeA, sizeB) as orderSize — a tiny dust
 * order would inflate the tolerance window and falsely match distant prices.
 * 
 * @param {number} gridPrice - Grid order price
 * @param {number} orderSize - Order size on primary side (larger = tighter tolerance)
 * @param {string} orderType - Order type ("buy" or "sell")
 * @param {Object} [assets=null] - Asset metadata with precision (required)
 * @returns {number|null} Price tolerance value or null if invalid inputs
 * @throws {Error} If assets missing or precisions invalid
 */
function calculatePriceTolerance(gridPrice, orderSize, orderType, assets = null) {
    if (!isValidNumber(gridPrice) || !isValidNumber(orderSize)) return null;
    if (!assets) throw new Error("CRITICAL: Assets object required for calculatePriceTolerance");

    const precisionA = assets.assetA?.precision;
    const precisionB = assets.assetB?.precision;

    if (typeof precisionA !== 'number' || typeof precisionB !== 'number') {
        throw new Error(`CRITICAL: Missing precision for price tolerance (A=${precisionA}, B=${precisionB})`);
    }

    if (!orderSize || orderSize <= 0) return null;

    // Minimum amount in blockchain satoshis that the chain will accept for an order.
    // Uses GRID_LIMITS.MIN_ORDER_SIZE_FACTOR (same constant as getMinOrderSize).

    let orderSizeA, orderSizeB;
    if (orderType === 'sell' || orderType === 'SELL' || orderType === 'Sell') {
        orderSizeA = orderSize;
        orderSizeB = orderSize * gridPrice;
    } else {
        orderSizeB = orderSize;
        orderSizeA = orderSize / gridPrice;
    }

    const minOrderSats = GRID_LIMITS.MIN_ORDER_SIZE_FACTOR;
    const satsA = Math.max(orderSizeA * Math.pow(10, precisionA), minOrderSats);
    const satsB = Math.max(orderSizeB * Math.pow(10, precisionB), minOrderSats);

    const termA = 1 / satsA;
    const termB = 1 / satsB;
    const tolerance = (termA + termB) * gridPrice;
    const maxTolerance = Math.max(gridPrice * GRID_LIMITS.PRICE_TOLERANCE_MAX_PERCENT, GRID_LIMITS.PRICE_TOLERANCE_MIN_ABSOLUTE);
    return Math.min(tolerance, maxTolerance);
}

/**
 * Validate order amounts are within blockchain limits (0 < INT64_MAX).
 * Converts floats to blockchain integers and checks they fit in signed 64-bit integers.
 * 
 * @param {number} amountToSell - Amount to sell (float)
 * @param {number} minToReceive - Minimum amount to receive (float)
 * @param {number} sellPrecision - Precision of sell asset
 * @param {number} receivePrecision - Precision of receive asset
 * @returns {boolean} True if both amounts are valid and within limits
 */
function validateOrderAmountsWithinLimits(amountToSell, minToReceive, sellPrecision, receivePrecision) {
    const sellPrecFloat = Math.pow(10, toFiniteNumber(sellPrecision));
    const receivePrecFloat = Math.pow(10, toFiniteNumber(receivePrecision));

    const sellInt = Math.round(toFiniteNumber(amountToSell) * sellPrecFloat);
    const receiveInt = Math.round(toFiniteNumber(minToReceive) * receivePrecFloat);

    const withinLimits = sellInt <= MAX_INT64 && receiveInt <= MAX_INT64 && sellInt > 0 && receiveInt > 0;

    if (!withinLimits) {
        mathLogger.warn(`Order amounts exceed safe limits or are invalid. Sell: ${amountToSell} = ${sellInt}, Receive: ${minToReceive} = ${receiveInt}. Max allowed: ${MAX_INT64}`);
    }

    return withinLimits;
}

// ================================================================================
// SECTION 5: DUST THRESHOLD & SIZE VALIDATION
// ================================================================================

/**
 * Calculate minimum absolute order size for an order type.
 * Returns factor * 10^-precision (e.g., 50 * 10^-8 for 8-decimal asset).
 * 
 * @param {string} orderType - Order type (BUY or SELL)
 * @param {Object} assets - Asset metadata with assetA and assetB precisions
 * @param {number} [factor=50] - Minimum size factor (default 50)
 * @returns {number} Minimum order size in asset units
 * @throws {Error} If precision cannot be determined
 */
function getMinOrderSize(orderType, assets, factor = 50) {
    const f = Number(factor);
    if (!f || !Number.isFinite(f) || f <= 0) return 0;

    let precision = null;
    if (assets) {
        if ((orderType === ORDER_TYPES.SELL) && assets.assetA) precision = assets.assetA.precision;
        else if ((orderType === ORDER_TYPES.BUY) && assets.assetB) precision = assets.assetB.precision;
    }

    if (typeof precision !== 'number') {
        throw new Error(`CRITICAL: Cannot determine minimum order size for ${orderType} - missing precision`);
    }

    return Number(f) * Math.pow(10, -precision);
}

/**
 * Calculate dust threshold factor as decimal fraction.
 * 
 * @param {number} [dustThresholdPercent=5] - Dust threshold percentage (default 5%)
 * @returns {number} Dust factor (e.g., 0.05 for 5%)
 */
function getDustThresholdFactor(dustThresholdPercent = 5) {
    return dustThresholdPercent / 100;
}

/**
 * Calculate single dust threshold for an ideal order size.
 * Returns idealSize * (dustThresholdPercent / 100).
 * 
 * @param {number} idealSize - Ideal/reference order size
 * @param {number} [dustThresholdPercent=5] - Threshold percentage (default 5%)
 * @returns {number} Single dust threshold (0 if idealSize invalid)
 */
function getSingleDustThreshold(idealSize, dustThresholdPercent = 5) {
    if (!idealSize || idealSize <= 0) return 0;
    return idealSize * getDustThresholdFactor(dustThresholdPercent);
}

/**
 * Calculate double dust threshold for an ideal order size.
 * Returns idealSize * (dustThresholdPercent / 100) * 2.
 * Used to filter very small orders that would be uneconomical.
 * 
 * @param {number} idealSize - Ideal/reference order size
 * @param {number} [dustThresholdPercent=5] - Threshold percentage (default 5%)
 * @returns {number} Double dust threshold (0 if idealSize invalid)
 */
function getDoubleDustThreshold(idealSize, dustThresholdPercent = 5) {
    if (!idealSize || idealSize <= 0) return 0;
    return idealSize * getDustThresholdFactor(dustThresholdPercent) * 2;
}

/**
 * Calculate minimum absolute order size (wrapper for getMinOrderSize with default factor).
 * 
 * @param {string} orderType - Order type (BUY or SELL)
 * @param {Object} assets - Asset metadata
 * @param {number} [minFactor=50] - Minimum size factor (default 50)
 * @returns {number} Minimum order size in asset units
 */
function getMinAbsoluteOrderSize(orderType, assets, minFactor = 50) {
    return getMinOrderSize(orderType, assets, minFactor);
}

/**
 * Validate an order size against minimum absolute and dust thresholds.
 * Returns detailed validation result with reasons if invalid.
 * 
 * @param {number} orderSize - Order size to validate
 * @param {string} orderType - Order type (BUY or SELL)
 * @param {Object} assets - Asset metadata with precisions
 * @param {number} [minFactor=50] - Minimum size factor (default 50)
 * @param {number} [idealSize=null] - Ideal size for dust calculations
 * @param {number} [dustThresholdPercent=5] - Dust threshold percentage (default 5%)
 * @returns {Object} Validation result {isValid, reason, minAbsoluteSize, minDustSize}
 */
function validateOrderSize(orderSize, orderType, assets, minFactor = 50, idealSize = null, dustThresholdPercent = 5) {
     const orderSizeFloat = toFiniteNumber(orderSize);
     const minAbsoluteSize = getMinAbsoluteOrderSize(orderType, assets, minFactor);
     
     let precision = null;
     if (assets) {
         if ((orderType === ORDER_TYPES.SELL) && assets.assetA) precision = assets.assetA.precision;
         else if ((orderType === ORDER_TYPES.BUY) && assets.assetB) precision = assets.assetB.precision;
     }
      const displayPrecision = precision;
     
     if (orderSizeFloat < minAbsoluteSize) {
         return { isValid: false, reason: `Order size (${Format.formatAmountByPrecision(orderSizeFloat, displayPrecision)}) below absolute minimum (${Format.formatAmountByPrecision(minAbsoluteSize, displayPrecision)})`, minAbsoluteSize, minDustSize: null };
     }

     if (idealSize !== null && idealSize !== undefined && idealSize > 0) {
         const minDustSize = getDoubleDustThreshold(idealSize, dustThresholdPercent);
         if (orderSizeFloat < minDustSize) {
             return { isValid: false, reason: `Order size (${Format.formatAmountByPrecision(orderSizeFloat, displayPrecision)}) below double-dust threshold (${Format.formatAmountByPrecision(minDustSize, displayPrecision)})`, minAbsoluteSize, minDustSize };
         }
     }

     if (typeof precision === 'number') {
         if (floatToBlockchainInt(orderSizeFloat, precision) <= 0) {
             return { isValid: false, reason: `Order size (${orderSizeFloat}) rounds to 0 on blockchain`, minAbsoluteSize, minDustSize: idealSize ? getDoubleDustThreshold(idealSize, dustThresholdPercent) : null };
         }
     }

     return { isValid: true, reason: null, minAbsoluteSize, minDustSize: idealSize ? getDoubleDustThreshold(idealSize, dustThresholdPercent) : null };
}

// ================================================================================
// SECTION 9: ORDER SIZING & ALLOCATION
// ================================================================================

/**
 * Allocate total funds across n orders using exponential weight distribution.
 * Optionally enforces precision quantization to match blockchain constraints.
 * If precision provided, adjusts the largest order to compensate for rounding errors.
 * 
 * @param {number} totalFunds - Total funds to allocate
 * @param {number} n - Number of orders to create allocations for
 * @param {number} weight - Weight factor (0-1) controlling distribution steepness
 * @param {number} incrementFactor - Increment factor (typically 0.01 for 1% grid spacing)
 * @param {boolean} [reverse=false] - If true, allocate larger sizes to higher indices
 * @param {number} [minSize=0] - Minimum size for each allocation (currently unused, for future validation)
 * @param {number} [precision=null] - Asset precision; if provided, quantize to blockchain integers
 * @returns {Array<number>} Array of n allocation sizes
 */
function allocateFundsByWeights(totalFunds, n, weight, incrementFactor, reverse = false, minSize = 0, precision = null) {
    if (n <= 0) return [];
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(n).fill(0);

    const base = 1 - incrementFactor;
    const rawWeights = new Array(n);
    for (let i = 0; i < n; i++) {
        const idx = reverse ? (n - 1 - i) : i;
        rawWeights[i] = Math.pow(base, idx * weight);
    }

    const sizes = new Array(n).fill(0);
    const totalWeight = rawWeights.reduce((s, w) => s + w, 0) || 1;

    if (precision !== null && precision !== undefined) {
        const totalUnits = floatToBlockchainInt(totalFunds, precision);
        let unitsSummary = 0;
        const units = new Array(n);

        for (let i = 0; i < n; i++) {
            units[i] = Math.round((rawWeights[i] / totalWeight) * totalUnits);
            unitsSummary += units[i];
        }

        const diff = totalUnits - unitsSummary;
        if (diff !== 0 && n > 0) {
            let largestIdx = 0;
            for (let j = 1; j < n; j++) if (units[j] > units[largestIdx]) largestIdx = j;
            const adjusted = units[largestIdx] + diff;
            if (adjusted < 0) {
                mathLogger.warn(`allocateFundsByWeights: rounding diff ${diff} exceeds largest slot ${units[largestIdx]}; total allocation will be less than target ${totalUnits}`);
            }
            units[largestIdx] = Math.max(0, adjusted);
        }
        for (let i = 0; i < n; i++) sizes[i] = blockchainToFloat(units[i], precision);
    } else {
        for (let i = 0; i < n; i++) sizes[i] = (rawWeights[i] / totalWeight) * totalFunds;
    }

    return sizes;
}

/**
 * Calculate order sizes for a list of orders using weighted fund allocation.
 * Allocates buy and sell funds separately using weight distribution from config.
 * Preserves order sequence while adding size property to each order.
 * 
 * @param {Array<Object>} orders - Array of order objects with type property
 * @param {Object} config - Configuration with incrementPercent and weightDistribution
 * @param {number} sellFunds - Total funds available for SELL orders
 * @param {number} buyFunds - Total funds available for BUY orders
 * @param {number} [minSellSize=0] - Minimum size for sell allocations
 * @param {number} [minBuySize=0] - Minimum size for buy allocations
 * @param {number} [precisionA=null] - Precision for assetA (SELL asset)
 * @param {number} [precisionB=null] - Precision for assetB (BUY asset)
 * @returns {Array<Object>} Orders array with size property added to each
 */
function calculateOrderSizes(orders, config, sellFunds, buyFunds, minSellSize = 0, minBuySize = 0, precisionA = null, precisionB = null) {
    const { incrementPercent, weightDistribution: { sell: sellWeight, buy: buyWeight } } = config;
    const incrementFactor = incrementPercent / 100;

    const sellOrders = orders.filter(o => o.type === ORDER_TYPES.SELL);
    const buyOrders = orders.filter(o => o.type === ORDER_TYPES.BUY);

    const sellSizes = allocateFundsByWeights(sellFunds, sellOrders.length, sellWeight, incrementFactor, false, minSellSize, precisionA);
    const buySizes = allocateFundsByWeights(buyFunds, buyOrders.length, buyWeight, incrementFactor, true, minBuySize, precisionB);

    const sellState = { sizes: sellSizes, index: 0 };
    const buyState = { sizes: buySizes, index: 0 };

    return orders.map(order => {
        let size = 0;
        if (order.type === ORDER_TYPES.SELL) {
            if (sellState.index >= sellState.sizes.length) throw new Error(`calculateOrderSizes: sell index ${sellState.index} out of bounds (len=${sellState.sizes.length})`);
            size = sellState.sizes[sellState.index++];
        } else if (order.type === ORDER_TYPES.BUY) {
            if (buyState.index >= buyState.sizes.length) throw new Error(`calculateOrderSizes: buy index ${buyState.index} out of bounds (len=${buyState.sizes.length})`);
            size = buyState.sizes[buyState.index++];
        }
        return { ...order, size };
    });
}

/**
 * Calculate order sizes for rotation operations.
 * Combines available funds with existing grid allocation for sizing.
 * Used during order refreshes when rotating orders to new positions.
 * 
 * @param {number} availableFunds - Free funds not yet allocated
 * @param {number} totalGridAllocation - Sum of all existing grid order sizes
 * @param {number} orderCount - Number of orders to size
 * @param {string} orderType - Order type (BUY or SELL)
 * @param {Object} config - Configuration with incrementPercent and weightDistribution
 * @param {number} [minSize=0] - Minimum size for each allocation
 * @param {number} [precision=null] - Asset precision for quantization
 * @returns {Array<number>} Array of order sizes
 */
function calculateRotationOrderSizes(availableFunds, totalGridAllocation, orderCount, orderType, config, minSize = 0, precision = null) {
    if (orderCount <= 0) return [];
    const totalFunds = availableFunds + totalGridAllocation;
    if (!Number.isFinite(totalFunds) || totalFunds <= 0) return new Array(orderCount).fill(0);

    const { incrementPercent, weightDistribution } = config;
    const incrementFactor = incrementPercent / 100;
    const weight = (orderType === ORDER_TYPES.SELL) ? weightDistribution.sell : weightDistribution.buy;
    const reverse = (orderType === ORDER_TYPES.BUY);

    return allocateFundsByWeights(totalFunds, orderCount, weight, incrementFactor, reverse, minSize, precision);
}

/**
 * Calculate RMS (Root Mean Square) divergence between calculated and persisted grids.
 * Measures how much the current grid differs from the calculated ideal.
 * Used to determine if grid recalculation is needed.
 *
 * RMS quadratically penalizes large errors and unmatched orders (treated as 100% error).
 * Default 14.3% RMS threshold allows ~3.2% average error concentrated in few orders.
 * See README GRID RECALCULATION section for threshold interpretation table.
 *
 * @param {Array<Object>} calculatedOrders - Ideal/calculated order grid
 * @param {Array<Object>} persistedOrders - Current/persisted order grid
 * @param {string} [sideName='unknown'] - Side name for logging (buy/sell)
 * @returns {number} RMS divergence metric (0 = perfect match, higher = more divergence)
 */
function calculateGridSideDivergenceMetric(calculatedOrders, persistedOrders, sideName = 'unknown') {
    if (!Array.isArray(calculatedOrders) || !Array.isArray(persistedOrders)) return 0;
    if (calculatedOrders.length === 0 && persistedOrders.length === 0) return 0;

    const persistedMap = new Map(persistedOrders.filter(o => o.id).map(o => [o.id, o]));
    let sumSquaredDiff = 0;
    let matchCount = 0;
    let unmatchedCount = 0;

    for (const calcOrder of calculatedOrders) {
        const persOrder = persistedMap.get(calcOrder.id);
        if (persOrder) {
            const currentSize = toFiniteNumber(persOrder.size);
            const idealSize = toFiniteNumber(calcOrder.size);
            if (idealSize > 0) {
                const relativeDiff = (currentSize - idealSize) / idealSize;
                sumSquaredDiff += relativeDiff * relativeDiff;
                matchCount++;
            } else if (currentSize > 0) {
                sumSquaredDiff += 1.0;
                matchCount++;
            } else {
                matchCount++;
            }
        } else {
            sumSquaredDiff += 1.0;
            unmatchedCount++;
        }
    }

    for (const persOrder of persistedOrders) {
        if (!calculatedOrders.some(c => c.id === persOrder.id)) {
            sumSquaredDiff += 1.0;
            unmatchedCount++;
        }
    }

    const totalOrders = matchCount + unmatchedCount;
    return totalOrders > 0 ? Math.sqrt(sumSquaredDiff / totalOrders) : 0;
}

// ================================================================================
// SECTION 10: VALIDATION HELPERS
// ================================================================================

/**
 * Calculate estimated BTS order creation fees for a number of orders.
 * Works for all pairs — returns the BTS fee budget needed for order operations.
 * 
 * @param {string} assetA - First asset symbol
 * @param {string} assetB - Second asset symbol (unused in calculation, kept for signature compat)
 * @param {number} totalOrders - Number of orders to create
 * @param {number} [feeMultiplier=BTS_RESERVATION_MULTIPLIER] - Multiplier for reservation (typically 5x)
 * @returns {number} Total fee amount (fallback BTS_FALLBACK_FEE if fee lookup fails; warning logged)
 */
function calculateOrderCreationFees(assetA, assetB, totalOrders, feeMultiplier = FEE_PARAMETERS.BTS_RESERVATION_MULTIPLIER) {
    try {
        if (totalOrders > 0) {
            const btsFeeData = getAssetFees('BTS');
            return btsFeeData.createFee * totalOrders * feeMultiplier;
        }
    } catch (err: any) {
        mathLogger.warn(`calculateOrderCreationFees: fee cache unavailable for ${assetA}/${assetB}: ${err.message}. Using fallback fee.`);
        return FEE_PARAMETERS.BTS_FALLBACK_FEE;
    }
    return 0;
}

/**
 * Deduct order fees from available buy/sell funds.
 * If BTS is the buy asset, deducts from buyFunds; if sell asset, deducts from sellFunds.
 * 
 * @param {number} buyFunds - Available buy-side funds
 * @param {number} sellFunds - Available sell-side funds
 * @param {number} fees - Fee amount to deduct
 * @param {Object} config - Configuration with assetA and assetB
 * @param {Object} [logger=null] - Optional logger for logging deductions
 * @returns {Object} Updated funds object {buyFunds, sellFunds}
 */
function deductOrderFeesFromFunds(buyFunds, sellFunds, fees, config, logger = null) {
    let finalBuy = buyFunds;
    let finalSell = sellFunds;
    if (fees > 0) {
        if (config?.assetB === 'BTS') {
            finalBuy = Math.max(0, buyFunds - fees);
            logger?.log?.(`Reduced available BTS (buy) funds by ${Format.formatAmount8(fees)}`, 'info');
        } else if (config?.assetA === 'BTS') {
            finalSell = Math.max(0, sellFunds - fees);
            logger?.log?.(`Reduced available BTS (sell) funds by ${Format.formatAmount8(fees)}`, 'info');
        }
    }
    return { buyFunds: finalBuy, sellFunds: finalSell };
}

/**
 * Calculate how much input asset to swap into a constant-product AMM pool
 * to receive a target amount of output asset.
 *
 * Formula: k = reserveIn * reserveOut
 *          newReserveOut = reserveOut - targetReceive
 *          newReserveIn = k / newReserveOut
 *          sellAmount = newReserveIn - reserveIn
 *
 * Caps swap at 50% of pool reserves to prevent extreme slippage.
 *
 * @param {number} targetReceive - Desired amount of output asset
 * @param {number} poolReserveOut - Pool reserve of output asset
 * @param {number} poolReserveIn - Pool reserve of input asset
 * @returns {number} Amount of input asset to sell
 */
function calculateSwapInAmount(targetReceive, poolReserveOut, poolReserveIn) {
    if (targetReceive <= 0 || poolReserveOut <= 0 || poolReserveIn <= 0) return 0;
    let effectiveTarget = targetReceive;
    if (effectiveTarget >= poolReserveOut * 0.5) {
        effectiveTarget = poolReserveOut * 0.5;
    }
    const k = poolReserveIn * poolReserveOut;
    const newReserveOut = poolReserveOut - effectiveTarget;
    if (newReserveOut <= 0) return 0;
    const newReserveIn = k / newReserveOut;
    return newReserveIn - poolReserveIn;
}

/**
 * Calculate the spread gap size (number of empty slots between BUY and SELL rails).
 * Used by both grid creation and strategy rebalancing to keep spread math consistent.
 *
 * @param {number} incrementPercent - Grid increment percentage
 * @param {number} targetSpreadPercent - Target spread percentage
 * @param {Object} GRID_LIMITS - Grid limits constants (optional, uses defaults)
 * @returns {number} Number of gap slots
 */
function calculateGapSlots(incrementPercent: any, targetSpreadPercent: any, gridLimits: { MIN_SPREAD_FACTOR?: number; MIN_SPREAD_ORDERS?: number } = {}) {
    const DEFAULT_INCREMENT = Number(DEFAULT_CONFIG.incrementPercent);
    const MIN_SPREAD_FACTOR = gridLimits.MIN_SPREAD_FACTOR ?? GRID_LIMITS.MIN_SPREAD_FACTOR;
    const MIN_SPREAD_ORDERS = gridLimits.MIN_SPREAD_ORDERS ?? GRID_LIMITS.MIN_SPREAD_ORDERS;

    const safeIncrement = (Number.isFinite(incrementPercent) && incrementPercent > 0) ? incrementPercent : DEFAULT_INCREMENT;
    const step = 1 + (safeIncrement / 100);
    const minSpreadPercent = safeIncrement * MIN_SPREAD_FACTOR;
    const effectiveTargetSpread = Math.max(targetSpreadPercent || 0, minSpreadPercent);
    const requiredSteps = Math.ceil(Math.log(1 + (effectiveTargetSpread / 100)) / Math.log(step));
    return Math.max(MIN_SPREAD_ORDERS, requiredSteps - 1);
}

export = {
    calculateGapSlots,
    isPercentageString,
    isPositiveNumber,
    isPositiveNumberOrPercent,
    isPositiveInt,
    parsePercentageString,
    toDecimal,
    resolveRelativePrice,
    isExplicitZeroAllocation,
    getPrecision,
    computeChainFundTotals,
    calculateAvailableFundsValue,
    getGridBestPrices,
    calculateSpreadFromOrders,
    resolveConfigValue,
    resolveConfigValueWithRegistry,
    hasValidAccountTotals,
    blockchainToFloat,
    floatToBlockchainInt,
    quantizeFloat,
    normalizeInt,
    getPrecisionByOrderType,
    getPrecisionForSide,
    getPrecisionsForManager,
    getPrecisionSlack,
    calculatePriceTolerance,
    validateOrderAmountsWithinLimits,
    getMinOrderSize,
    getDustThresholdFactor,
    getSingleDustThreshold,
    getDoubleDustThreshold,
    getMinAbsoluteOrderSize,
    validateOrderSize,
    getAssetFees,
    allocateFundsByWeights,
    calculateOrderSizes,
    calculateRotationOrderSizes,
    calculateGridSideDivergenceMetric,
    calculateOrderCreationFees,
    deductOrderFeesFromFunds,
    calculateSwapInAmount,
    _setFeeCache,
    cloneWeightDistribution,
    clamp,
    roundTo,
    fixedTo,
    roundToDecimals
};

/**
 * Round a value to a given factor.
 * @param {number} value - Value to round
 * @param {number} factor - Rounding factor (e.g. 100 for 2 decimals)
 * @returns {number}
 */
function roundTo(value: number, factor: number): number {
    if (!Number.isFinite(value)) return NaN;
    return Math.round(value * factor) / factor;
}

/**
 * Format a number to a fixed number of decimal places.
 * @param {number|string} value - Value to format
 * @param {number} decimals - Number of decimal places
 * @returns {string}
 */
function fixedTo(value: number | string, decimals: number): string {
    return Number(value).toFixed(decimals);
}

/**
 * Round a value to a given number of decimal places.
 * @param {number} value - Value to round
 * @param {number} decimals - Number of decimal places
 * @returns {number}
 */
function roundToDecimals(value: number, decimals: number): number {
    if (!Number.isFinite(value)) return NaN;
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}

/**
 * Clamp a value between min and max bounds.
 * @param {number} value - The value to clamp
 * @param {number} min - Lower bound
 * @param {number} max - Upper bound
 * @returns {number}
 */
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Safely clone a weight distribution object.
 * Validates numeric sell/buy values and falls back to a base object if provided.
 * Returns null if neither primary nor base yields valid numbers.
 *
 * @param {Object|null} weightDistribution - Primary weights (e.g. { sell, buy })
 * @param {Object|null} base - Fallback weights if primary is missing/invalid
 * @returns {{sell:number,buy:number}|null}
 */
function cloneWeightDistribution(weightDistribution, base = null) {
    const source = (weightDistribution && typeof weightDistribution === 'object')
        ? weightDistribution
        : (base && typeof base === 'object' ? base : null);
    if (!source) return null;

    const sell = Number(source.sell);
    const buy = Number(source.buy);
    if (!Number.isFinite(sell) || !Number.isFinite(buy)) return null;

    return { sell, buy };
}
