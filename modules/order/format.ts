/**
 * modules/order/format.ts - Numeric formatting utilities
 *
 * Centralized formatting utilities for consistent decimal precision display across logs and output.
 * All functions return strings formatted to specified decimal places.
 *
 * ===============================================================================
 * DECIMAL PRECISION STANDARDS
 * ===============================================================================
 *
 * Asset Amounts:                8 decimals  - blockchain native precision
 * Prices:                       6-8 decimals - price precision varies by pair
 * Percentages:                  1-4 decimals - display precision
 * Ratios/Metrics:               2-5 decimals - context dependent
 * Time/Performance (ms, %):     1-2 decimals - readable metrics
 *
 * ===============================================================================
 * TABLE OF CONTENTS (17 exported functions)
 * ===============================================================================
 *
 * SECTION 1: ASSET FORMATTING (4 functions)
 *   1. formatAmount8(value) - Format to 8 decimals (blockchain standard)
 *   2. formatAmount(value, decimals) - Format with custom decimal places
 *   3. formatAmountByPrecision(value, precision) - Format using chain precision
 *   4. formatSizeByOrderType(value, orderType, assets) - Format order size by BUY/SELL asset precision
 *
 * SECTION 2: PRICE FORMATTING (3 functions)
 *   6. formatPrice(value) - Format to 8 decimals (maximum precision)
 *   7. formatPrice6(value) - Format to 6 decimals
 *   8. formatPrice4(value) - Format to 4 decimals (simplified display)
 *
 * SECTION 3: PERCENTAGE FORMATTING (3 functions)
 *   9. formatPercent2(value) - Format to 2 decimals (spread %, ratios)
 *   10. formatPercent(value, decimals) - Format with custom decimal places
 *
 * SECTION 4: RATIO/METRIC FORMATTING (3 functions)
 *   11. formatRatio(value, decimals) - Format ratios with custom decimals (default 5)
 *   13. formatMetric2(value) - Format to 2 decimals (timing, performance)
 *   14. formatMetric5(value) - Format to 5 decimals (detailed metrics)
 *
 * SECTION 5: HELPER UTILITIES (4 functions)
 *   15. isValidNumber(value) - Check if value is defined and finite
 *   16. isNumeric(val) - Check if value is a number or parseable numeric string
 *   17. toFiniteNumber(value, defaultValue) - Convert to finite number with fallback
 *   18. safeFormat(value, decimals, fallback) - Safely format with fallback
 *
 * ===============================================================================
 */

// ===============================================================================
// SECTION 1: ASSET FORMATTING
// ===============================================================================

/**
 * Format asset amounts to 8 decimal places (blockchain standard)
 * Used for: Asset amounts, order sizes
 *
 * @param {number} value - The value to format
 * @returns {string} Formatted value to 8 decimals
 */
function formatAmount8(value: number): string {
	return safeFormat(value, 8);
}

/**
 * Format asset amounts with custom decimal places
 *
 * @param {number} value - The value to format
 * @param {number} [decimals=8] - Number of decimal places (default 8)
 * @returns {string} Formatted value
 */
function formatAmount(value: number, decimals: number = 8): string {
	return safeFormat(value, decimals);
}

/**
 * Format asset amount using an explicit blockchain precision.
 * Throws if precision is invalid — no silent fallback.
 *
 * @param {number} value - The value to format
 * @param {number} precision - Asset precision to apply
 * @returns {string} Formatted value
 */
function formatAmountByPrecision(value: number, precision: number | undefined): string {
	if (precision === undefined || !Number.isInteger(precision) || precision < 0) {
		throw new Error(`Invalid precision for formatAmountByPrecision: ${precision}`);
	}
	return safeFormat(value, precision);
}

/**
 * Format an order size using market-side precision.
 * BUY size is in assetB units, SELL size is in assetA units.
 * Throws if precision is unavailable — no silent fallback.
 *
 * @param {number} value - The value to format
 * @param {string} orderType - Order side ('buy' or 'sell')
 * @param {Object} assets - Asset metadata with assetA/assetB precision
 * @returns {string} Formatted value
 */
function formatSizeByOrderType(value: number, orderType: string, assets: { assetA?: { precision?: number }; assetB?: { precision?: number } }): string {
	const side = String(orderType || '').toLowerCase();
	const buyPrecision = assets?.assetB?.precision;
	const sellPrecision = assets?.assetA?.precision;
	const precision = side === 'buy' ? buyPrecision : side === 'sell' ? sellPrecision : undefined;
	return formatAmountByPrecision(value, precision);
}

/**
 * Format an amount with strict precision validation.
 * Returns 'N/A' if value or precision is invalid.
 * 
 * @param {*} value - Value to format
 * @param {number} precision - Decimal precision
 * @returns {string} Formatted amount or 'N/A'
 */
// ===============================================================================
// SECTION 2: PRICE FORMATTING
// ===============================================================================

/**
 * Format prices to 8 decimal places (maximum precision)
 * Used for: order prices, market prices
 *
 * @param {number} value - The price to format
 * @returns {string} Formatted price to 8 decimals
 */
function formatPrice(value: number): string {
	return safeFormat(value, 8);
}

function formatPrice6(value: number): string {
	return safeFormat(value, 6);
}

function formatPrice4(value: number): string {
	return safeFormat(value, 4);
}

// ===============================================================================
// SECTION 3: PERCENTAGE FORMATTING
// ===============================================================================

/**
 * Format percentages to 2 decimal places
 * Used for: spread %, ratios, simple percentages
 *
 * @param {number} value - The percentage value (0-100 or decimal 0-1)
 * @returns {string} Formatted percentage to 2 decimals
 */
function formatPercent2(value: number): string {
	return safeFormat(value, 2);
}

function formatPercent(value: number, decimals: number = 2): string {
	return safeFormat(value, decimals);
}

// ===============================================================================
// SECTION 4: RATIO/METRIC FORMATTING
// ===============================================================================

/**
 * Format ratios with custom decimal places
 *
 * @param {number} value - The ratio value
 * @param {number} [decimals=5] - Number of decimal places (default 5)
 * @returns {string} Formatted ratio
 */
function formatRatio(value: number, decimals: number = 5): string {
	return safeFormat(value, decimals);
}

function formatMetric2(value: number): string {
	return safeFormat(value, 2);
}

function formatMetric5(value: number): string {
	return safeFormat(value, 5);
}

// ===============================================================================
// SECTION 5: HELPER UTILITIES
// ===============================================================================

/**
 * Check if a value is defined and represents a finite number.
 * @param {*} value - Value to check
 * @returns {boolean} True if value is defined and finite
 */
function isValidNumber(value: any): boolean {
	return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function isNumeric(val: any): boolean {
	return typeof val === 'number' || (typeof val === 'string' && val.trim() !== '' && !Number.isNaN(Number(val)));
}

/**
 * Safely convert a value to a finite number.
 *
 * IMPORTANT: passing `undefined` as defaultValue triggers the TS default of 0.
 * Pass `null` explicitly to get `null` back for non-finite values.
 */
function toFiniteNumber(value: any, defaultValue: number = 0): number {
	const num = Number(value);
	return Number.isFinite(num) ? num : defaultValue;
}

/**
 * Safely format a numeric value with specified decimals and fallback.
 *
 * @param {*} value - The value to format
 * @param {number} decimals - Number of decimal places
 * @param {string} [fallback='N/A'] - Fallback value if format fails
 * @returns {string} Formatted value or fallback string
 */
function safeFormat(value: any, decimals: number, fallback: string = 'N/A'): string {
	try {
		if (!isValidNumber(value)) {
			return fallback;
		}
		return Number(value).toFixed(decimals);
	} catch (e: any) {
		return fallback;
	}
}

// ===============================================================================
// EXPORTS
// ===============================================================================

export { formatAmount8, formatAmount, formatAmountByPrecision, formatSizeByOrderType, formatPrice, formatPrice6, formatPrice4, formatPercent2, formatPercent, formatRatio, formatMetric2, formatMetric5, isValidNumber, isNumeric, toFiniteNumber, safeFormat }

