#!/usr/bin/env node

/**
 * DEXBot Order Analysis Script
 *
 * Analyzes all order files in profiles/orders/ sorted by modified date.
 * Provides compact terminal output checking:
 * - Real spread vs. target spread (including double-sided status)
 * - Increment value % geometric consistency between grid slots
 * - Total funds of AssetA and AssetB in the grid
 * - Grid slot distribution (% near center) vs grid composition
 *
 * Usage: tsx scripts/analyze-orders.ts
 */

const fs = require('fs');
const path = require('path');
const { formatPrice6 } = require('../modules/order/format');
const { resolveConfiguredPriceBound } = require('../modules/order/utils/order');
const { ORDER_TYPES, ORDER_STATES, MARKET_ADAPTER } = require('../modules/constants');
const { PATHS } = require('../modules/paths');
const { getWhitelistFlags } = require('../modules/market_adapter_whitelist');
const { readJSON } = require('../modules/utils/fs_utils');

const ORDERS_DIR = PATHS.ORDERS_DIR;
const BOTS_CONFIG = PATHS.PROFILES.BOTS_JSON;

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  buy: '\x1b[92m',    // green
  sell: '\x1b[91m',   // light red
  buyDark: '\x1b[38;5;28m',  // even darker green
  sellDark: '\x1b[31m', // dark red
  spread: '\x1b[93m', // yellow
  cyan: '\x1b[38;5;87m',   // bright cyan
  gray: '\x1b[38;5;246m'    // medium grey (lighter than bright black)
};

// Partial block characters for weight visualization (0-8 eighths height)
const partialBlocks = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// Maximum age (ms) for a dynamic grid snapshot to be considered "recently available".
// The market adapter writes a fresh snapshot on every cycle; a gap larger than this
// typically means the adapter is stopped or stuck for that bot. We allow up to two
// full cycles of drift (one missed cycle + slack for slow processing) before falling
// back to the static-only display, so the live colors track the actual adapter
// cadence rather than a hand-tuned timeout.
const DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS = 2 * MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds * 1000;

// Tolerance (absolute weight delta) for treating the two live weights as equal
// when picking a color. Half a percentage point avoids noisy green/red flicker
// when the dynamic weight sits exactly on the static baseline.
const DYNAMIC_WEIGHT_EPSILON = 0.005;

// Bar width configuration (single source of truth)
const BAR_WIDTH = 51;
// Header width: prefix width (11 chars for "   Slots:  ") + bar width
const HEADER_WIDTH = 11 + BAR_WIDTH;

/**
 * Utility Functions
 * Helper functions for file I/O, formatting, and data retrieval
 */

function sanitizeKey(source) {
  if (!source) return 'bot';
  return String(source)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bot';
}

function createBotKey(bot, index) {
  const identifier = bot && bot.name
    ? bot.name
    : bot && bot.assetA && bot.assetB
      ? `${bot.assetA}/${bot.assetB}`
      : bot && bot.assetAId && bot.assetBId
        ? `${bot.assetAId}/${bot.assetBId}`
        : `bot-${index}`;
  const baseKey = sanitizeKey(identifier);
  if (bot && bot.id) {
    return `${baseKey}-${sanitizeKey(String(bot.id))}`;
  }
  return `${baseKey}-${index}`;
}

function hasOrderGrid(data) {
  return Boolean(
    data && typeof data === 'object' && !Array.isArray(data) &&
    data.meta && typeof data.meta === 'object' &&
    Array.isArray(data.grid)
  );
}

/**
 * isAmaGridPrice: Detect bots whose grid price follows the AMA (Kaufman) stream.
 *
 * Mirrors the predicate used in market_adapter.ts / unlock.ts / pm2.ts so the
 * analyzer only attempts to load a dynamic grid snapshot for AMA bots. Non-AMA
 * bots never have a meaningful dynamic grid file.
 */
function isAmaGridPrice(config) {
  if (!config || typeof config !== 'object') return false;
  const gridPrice = typeof config.gridPrice === 'string' ? config.gridPrice.trim().toLowerCase() : '';
  return /^ama(?:[1-4])?$/.test(gridPrice);
}

function readDynamicGridSnapshot(botKey) {
  if (!botKey) return null;
  try {
    const filePath = path.join(ORDERS_DIR, `${botKey}.dynamicgrid.json`);
    if (!fs.existsSync(filePath)) return null;
    const data = readJSON(filePath);
    return data && typeof data === 'object' ? data : null;
  } catch (e) {
    return null;
  }
}

/**
 * computeAsymmetricBoundsPrices: Mirror of applyAsymmetricBounds logic.
 * Computes the resolved min/max prices after grid range scaling adjustment.
 */
function computeAsymmetricBoundsPrices(centerPrice, minPrice, maxPrice, trend, appliedAsymmetryFactor) {
  if (!Number.isFinite(centerPrice) || centerPrice <= 0
    || !Number.isFinite(minPrice) || minPrice <= 0
    || !Number.isFinite(maxPrice) || maxPrice <= 0
    || !Number.isFinite(appliedAsymmetryFactor)
    || (trend !== 'UP' && trend !== 'DOWN')) {
    return null;
  }
  const baseMinDiv = centerPrice / minPrice;
  const baseMaxMult = maxPrice / centerPrice;
  let resolvedMinPrice, resolvedMaxPrice;
  if (trend === 'DOWN') {
    resolvedMinPrice = centerPrice / (baseMinDiv * (1 + appliedAsymmetryFactor));
    resolvedMaxPrice = centerPrice * (baseMaxMult * (1 - appliedAsymmetryFactor));
  } else {
    resolvedMinPrice = centerPrice / (baseMinDiv * (1 - appliedAsymmetryFactor));
    resolvedMaxPrice = centerPrice * (baseMaxMult * (1 + appliedAsymmetryFactor));
  }
  return { resolvedMinPrice, resolvedMaxPrice };
}

/**
 * buildDynamicWeightInfo: Extract a display-ready market-adapter payload.
 *
 * Reads the latest AMA dynamic-grid snapshot for AMA-whitelisted bots. Dynamic
 * weight values are attached only when the bot is also dynamic-weight
 * whitelisted and the snapshot contains effective weights. AMA center and
 * freshness status remain available for AMA-only bots.
 */
function buildDynamicWeightInfo(botKey, config) {
  if (!isAmaGridPrice(config)) return null;
  // Derive the correct key from config.id when available.
  // The market adapter (modules/account_orders.ts createBotKey) produces
  // ID-based keys (e.g. "h-bts-5b0be9af") while the order file still stores
  // legacy index-based keys ("h-bts-1") internally — and the whitelist file
  // also uses the canonical ID-based key.
  const lookupKey = (config && config.id)
    ? `${sanitizeKey(config.name)}-${sanitizeKey(String(config.id))}`
    : botKey;
  const whitelistFlags = getWhitelistFlags(lookupKey);
  if (whitelistFlags.ama !== true) return null;
  const snapshot = readDynamicGridSnapshot(lookupKey);
  if (!snapshot) return null;
  const dw = snapshot.dynamicWeights && typeof snapshot.dynamicWeights === 'object'
    ? snapshot.dynamicWeights
    : null;
  const hasDynamicWeightData = whitelistFlags.dynamicWeight === true
    && dw
    && dw.effectiveWeights
    && typeof dw.effectiveWeights === 'object';
  let live = null;
  let base = null;
  if (hasDynamicWeightData) {
    const effBuy = Number(dw.effectiveWeights.buy);
    const effSell = Number(dw.effectiveWeights.sell);
    if (Number.isFinite(effBuy) && Number.isFinite(effSell)) {
      const baseFromSnapshot = dw.baseWeights && typeof dw.baseWeights === 'object' ? dw.baseWeights : null;
      const baseBuy = baseFromSnapshot && Number.isFinite(Number(baseFromSnapshot.buy))
        ? Number(baseFromSnapshot.buy)
        : (config.weightDistribution && Number.isFinite(Number(config.weightDistribution.buy))
            ? Number(config.weightDistribution.buy)
            : null);
      const baseSell = baseFromSnapshot && Number.isFinite(Number(baseFromSnapshot.sell))
        ? Number(baseFromSnapshot.sell)
        : (config.weightDistribution && Number.isFinite(Number(config.weightDistribution.sell))
            ? Number(config.weightDistribution.sell)
            : null);
      if (Number.isFinite(baseBuy) && Number.isFinite(baseSell)) {
        live = { buy: effBuy, sell: effSell };
        base = { buy: baseBuy, sell: baseSell };
      }
    }
  }
  const updatedAtMs = Date.parse(String(snapshot.updatedAt || ''));
  const isRecent = Number.isFinite(updatedAtMs)
    && (Date.now() - updatedAtMs) <= DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS;
  const amaCenterPrice = Number.isFinite(Number(snapshot.amaCenterPrice))
    ? Number(snapshot.amaCenterPrice)
    : (Number.isFinite(Number(snapshot.gridCenterPrice)) ? Number(snapshot.gridCenterPrice) : null);
  const rawAsymmetryFactor = dw && Number.isFinite(Number(dw.rawAsymmetryFactor))
    ? Number(dw.rawAsymmetryFactor)
    : null;
  const appliedAsymmetryFactor = dw && Number.isFinite(Number(dw.appliedAsymmetryFactor))
    ? Number(dw.appliedAsymmetryFactor)
    : null;
  const maxAsymmetryFactor = dw && Number.isFinite(Number(dw.maxAsymmetryFactor))
    ? Number(dw.maxAsymmetryFactor)
    : null;
  return {
    live,
    base,
    dynamicWeightEnabled: whitelistFlags.dynamicWeight === true,
    isReady: dw ? dw.isReady === true : false,
    trend: dw && typeof dw.trend === 'string' ? dw.trend : null,
    finalOffset: dw && Number.isFinite(Number(dw.finalOffset)) ? Number(dw.finalOffset) : null,
    amaCenterPrice,
    centerPrice: Number.isFinite(Number(snapshot.centerPrice)) ? Number(snapshot.centerPrice) : null,
    isRecent,
    updatedAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs) : null,
    rawAsymmetryFactor,
    appliedAsymmetryFactor,
    maxAsymmetryFactor,
  };
}

function isRealGridOrder(order) {
  if (!order || typeof order !== 'object') return false;
  const hasRealState = order.state === ORDER_STATES.ACTIVE || order.state === ORDER_STATES.PARTIAL;
  const hasRealType = order.type === ORDER_TYPES.BUY || order.type === ORDER_TYPES.SELL;
  const hasOrderId = typeof order.orderId === 'string' && order.orderId.trim().length > 0;
  return hasRealState
    && hasRealType
    && hasOrderId
    && Number(order.price) > 0
    && Number(order.size) > 0;
}

function getRealGridOrders(botData) {
  return Array.isArray(botData?.grid) ? botData.grid.filter(isRealGridOrder) : [];
}

/**
 * getModifiedTime: Get file modification timestamp
 * Used to sort order files by most recently updated
 * @param {string} filePath - Path to file
 * @returns {Date} Modification time
 */
function getModifiedTime(filePath) {
  return fs.statSync(filePath).mtime;
}

/**
 * formatPercent: Convert decimal to percentage string
 * Example: 0.05 -> "5.00%"
 * @param {number} value - Decimal value (0-1)
 * @returns {string} Formatted percentage with 2 decimal places
 */
function formatPercent(value) {
  return (value * 100).toFixed(2) + '%';
}

/**
 * formatCurrency: Format a number to 5 significant digits without K/M abbreviation.
 * Very small values (< 0.01) use 6 decimal places via formatPrice6.
 * @param {number} value - Numeric value to format
 * @returns {string} Formatted currency/quantity string
 */
function formatCurrency(value) {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 0.1) {
    if (abs >= 0.001) return formatCurrency(value * 1000) + 'm';
    if (abs >= 0.000001) return formatCurrency(value * 1000000) + 'μ';
    if (abs >= 1e-9) return formatCurrency(value * 1e9) + 'n';
    return formatPrice6(value);
  }
  let intDigits = Math.floor(Math.log10(abs)) + 1;
  if (abs < 1) intDigits = 1;
  if (intDigits >= 5) return String(Math.round(value));
  return value.toFixed(5 - intDigits);
}

/**
 * formatFundsValue: Format a fund amount with compact notation (K/M for ≥1000)
 * and up to 5 significant figures, trimming uninformative trailing zeros.
 * Examples:
 *   194395   -> "194.4K"
 *   10000    -> "10K"
 *   1000     -> "1K"
 *   332.33   -> "332.33"
 *   10.389   -> "10.389"
 *   1500000  -> "1.5M"
 * @param {number} value
 * @returns {string}
 */
function formatFundsValue(value) {
  if (value === 0) return '0';
  const absValue = Math.abs(value);

  let quotient;
  let suffix = '';
  if (absValue >= 1000000) {
    quotient = value / 1000000;
    suffix = 'M';
  } else if (absValue >= 1000) {
    quotient = value / 1000;
    suffix = 'K';
  } else {
    quotient = value;
  }

  const absQ = Math.abs(quotient);
  const intDigits = Math.floor(Math.log10(Math.max(absQ, 1e-10))) + 1;
  let formatted;
  if (intDigits >= 5) {
    formatted = String(Math.round(quotient));
  } else {
    const decimalPlaces = Math.max(0, 5 - intDigits);
    formatted = quotient.toFixed(decimalPlaces);
    formatted = formatted.replace(/(\.[0-9]*?)0+$/, '$1').replace(/\.$/, '');
  }

  return formatted + suffix;
}

/**
 * stripColorCodes: Remove ANSI color codes from a string
 * @param {string} str - String that may contain color codes
 * @returns {string} String without color codes
 */
function stripColorCodes(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * padStringCentered: Pad a string to a target visual width, accounting for color codes
 * Centers the string within the specified width with padding
 * @param {string} str - String that may contain color codes
 * @param {number} width - Target visual width
 * @returns {string} Padded string with original colors preserved
 */
function padStringCentered(str, width) {
  const visualLen = stripColorCodes(str).length;
  const totalPad = Math.max(0, width - visualLen);
  const padLeft = Math.ceil(totalPad / 2);
  const padRight = Math.floor(totalPad / 2);
  return ' '.repeat(padLeft) + str + ' '.repeat(padRight);
}

// Load bot configurations
const botsConfig = readJSON(BOTS_CONFIG).bots;

function getConfiguredBotConfig(botKey, botData) {
  const meta = botData?.meta || {};
  return botsConfig.find((bot, index) => {
    if (!bot) return false;
    return createBotKey(bot, index) === botKey || (meta.name && bot.name === meta.name);
  }) || null;
}

function getOrderFileCandidate(fileName) {
  const filePath = path.join(ORDERS_DIR, fileName);
  if (!fileName.endsWith('.json')) {
    return { include: false, reason: 'not a JSON file', report: false };
  }
  if (fileName.endsWith('.dynamicgrid.json')) {
    return { include: false, reason: 'dynamic grid snapshot', report: false };
  }

  let data;
  try {
    data = readJSON(filePath);
  } catch (error) {
    return { include: false, reason: `invalid JSON: ${error.message}`, report: true, name: fileName };
  }

  if (!hasOrderGrid(data)) {
    return { include: false, reason: 'not a persisted order grid', report: true, name: fileName };
  }

  // Derive botKey from the file name: profiles/orders/<botKey>.json
  const botKey = fileName.replace(/\.json$/, '');
  const botData = data;

  const config = getConfiguredBotConfig(botKey, botData);
  if (!config) {
    return { include: false, reason: 'no matching bot config', report: true, name: fileName };
  }

  const realOrders = getRealGridOrders(botData);
  if (realOrders.length === 0) {
    return { include: false, reason: 'no real on-chain orders', report: true, name: fileName };
  }

  return { include: true, name: fileName, path: filePath, botKey, config };
}

// Get all order files sorted by modified date
function getOrderFiles() {
  const candidates = fs.readdirSync(ORDERS_DIR).map(getOrderFileCandidate);
  const files = candidates
    .filter(candidate => candidate.include)
    .map(f => ({
      ...f,
      mtime: getModifiedTime(f.path)
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return {
    files,
    skippedCandidates: candidates.filter(candidate => !candidate.include && candidate.report)
  };
}

/**
 * analyzeOrder: Comprehensive analysis of a single bot's order grid
 *
 * Examines all aspects of grid health:
 * - Spread: Gap between best buy and best sell vs. target
 * - Increment: Consistency of price steps between grid slots
 * - Funds: Total funds allocated to each side
 * - Distribution: Comparison of slot count vs. fund allocation
 * - Double-sided mode: Whether sides are intentionally unbalanced
 *
 * Terminology:
 * - boundaryIdx: Index of best buy slot (highest buy price)
 * - Slots > boundaryIdx are sells
 * - Slots < boundaryIdx are buys at boundary position
 * - Spread slots are outside normal grid (rare)
 *
 * @param {Object} botData - Order data with grid array and metadata
 * @param {Object} config - Bot configuration (optional) for comparison
 * @param {string} [botKey] - Bot key used to locate the dynamic grid snapshot
 * @returns {Object} Analysis result with spread, increment, funds, distribution
 */
function analyzeOrder(botData, config, botKey) {
  const meta = botData.meta;
  const grid = botData.grid;

  // Extract asset pair: prioritize assets object from order data, fall back to meta
  let assetA = meta.assetA;
  let assetB = meta.assetB;

  // If metadata is null/missing, get from assets object in order file
  if (!assetA && botData.assets && botData.assets.assetA) {
    assetA = botData.assets.assetA.symbol;
  }
  if (!assetB && botData.assets && botData.assets.assetB) {
    assetB = botData.assets.assetB.symbol;
  }

  /**
   * Grid Slot Separation
   * The grid contains buy slots (prices below market), sell slots (above market),
   * and optional spread slots. Separation enables independent analysis.
   */
  const boundaryIdx = botData.boundaryIdx;
  const buySlots = grid.filter((s, i) => i <= boundaryIdx && s.type === ORDER_TYPES.BUY);
  const sellSlots = grid.filter((s, i) => i > boundaryIdx && s.type === ORDER_TYPES.SELL);
  const spreadSlots = grid.filter(s => s.type === ORDER_TYPES.SPREAD);

  const activeBuySlots = buySlots.filter(s => s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL);
  const virtualBuySlots = buySlots.filter(s => s.state === ORDER_STATES.VIRTUAL);
  const activeSellSlots = sellSlots.filter(s => s.state === ORDER_STATES.ACTIVE || s.state === ORDER_STATES.PARTIAL);
  const virtualSellSlots = sellSlots.filter(s => s.state === ORDER_STATES.VIRTUAL);

  /**
   * Best Prices Identification
   * bestBuySlot: Highest buy price (at boundary, closest to market)
   * bestSellSlot: Lowest sell price (first sell after boundary, closest to market)
   * The spread between these is the "real" spread of the grid
   */
  const bestBuySlot = grid[boundaryIdx];
  const bestSellSlot = grid.slice(boundaryIdx + 1).find(s => s.type === ORDER_TYPES.SELL);

  /**
   * Real Spread Calculation
   * Formula: (bestSellPrice - bestBuyPrice) / bestBuyPrice
   * This is the actual gap in the market, measured as percentage from buy price
   * Example: buy=100, sell=105 -> spread = 5%
   */
  const realSpread = bestBuySlot && bestSellSlot
    ? ((bestSellSlot.price - bestBuySlot.price) / bestBuySlot.price)
    : 0;

  let spreadDiff, targetSpread, incrementCheck;

  /**
   * Config-based Comparisons
   * If bot has configuration, compare actual to target values
   * Otherwise, just report actual values
   */
  if (config) {
    // Config exists - calculate variance from target
    targetSpread = config.targetSpreadPercent / 100;

    spreadDiff = realSpread - targetSpread;
    incrementCheck = checkGeometricIncrement(grid, config.incrementPercent / 100);
  } else {
    // No config - report actual values only
    targetSpread = null;
    spreadDiff = null;
    incrementCheck = checkGeometricIncrement(grid, null);
  }

  // Calculate total funds committed to buy and sell sides
  const gridFunds = calculateGridFunds(buySlots, sellSlots, bestBuySlot, bestSellSlot);
  const activeGridFunds = calculateGridFunds(activeBuySlots, activeSellSlots, bestBuySlot, bestSellSlot);
  const virtualGridFunds = calculateGridFunds(virtualBuySlots, virtualSellSlots, bestBuySlot, bestSellSlot);

  // Analyze how funds are distributed across slots
  const distribution = analyzeDistribution(buySlots, sellSlots, bestBuySlot, bestSellSlot);

  // Calculate grid extremes and market price
  const gridMinPrice = grid.length > 0 ? Math.min(...grid.map(s => s.price)) : null;
  const gridMaxPrice = grid.length > 0 ? Math.max(...grid.map(s => s.price)) : null;
  const marketPrice = bestBuySlot && bestSellSlot
    ? (bestBuySlot.price + bestSellSlot.price) / 2
    : null;

  /**
   * Return comprehensive analysis object
   * Includes all metrics needed for health check output
   */
  const _dynamicWeight = buildDynamicWeightInfo(botKey, config);
  const _ab = computeGridRangeScalingDisplay(config, _dynamicWeight);
  return {
    pair: `${assetA}/${assetB}`,
    lastUpdated: new Date(meta.updatedAt || botData.lastUpdated),
    gridMinPrice: gridMinPrice,
    marketPrice: marketPrice,
    gridMaxPrice: gridMaxPrice,
    hasConfig: !!config,
    // Spread metrics
    spread: {
      real: realSpread,
      target: targetSpread,
      diff: spreadDiff,
      // Pass if within 0.1% of target (or null if no config to compare)
      pass: config ? Math.abs(spreadDiff) < 0.001 : null
    },
    // Increment consistency metrics
    increment: incrementCheck,
    // Fund allocation breakdown
    funds: gridFunds,
    activeFunds: activeGridFunds,
    virtualFunds: virtualGridFunds,
    // Slot vs fund distribution analysis
    distribution: distribution,
    // Slot counts for structure overview
    slots: {
      buy: buySlots.length,
      sell: sellSlots.length,
      spread: spreadSlots.length,
      activeBuy: activeBuySlots.length,
      virtualBuy: virtualBuySlots.length,
      activeSell: activeSellSlots.length,
      virtualSell: virtualSellSlots.length,
      partialBuy: buySlots.filter(s => s.state === ORDER_STATES.PARTIAL).length,
      partialSell: sellSlots.filter(s => s.state === ORDER_STATES.PARTIAL).length
    },
    // Slot data for weight visualization
    slotData: {
      buy: buySlots,
      sell: sellSlots
    },
    // Target active orders from config
    activeOrdersTarget: config ? config.activeOrders : null,
    // Bot fund allocation settings from config
    botFunds: config ? config.botFunds : null,
    // Weight distribution from config
    weightDistribution: config ? config.weightDistribution : null,
    // Latest dynamic weight payload from the market adapter (AMA bots only).
    // Null when the bot is not AMA, or when no fresh snapshot is available.
    dynamicWeight: _dynamicWeight,
    // Grid range scaling (asymmetric bounds) display data, null if not applicable.
    asymmetricBounds: _ab,
  };
}

/**
 * computeGridRangeScalingDisplay: Compute resolved prices from grid range scaling.
 * Returns null when the bot is not whitelisted or data is incomplete.
 */
function computeGridRangeScalingDisplay(config, dynamicWeight) {
  if (!dynamicWeight || dynamicWeight.amaCenterPrice == null) {
    return null;
  }
  const centerPrice = dynamicWeight.amaCenterPrice;
  let minPrice, maxPrice;
  try {
    minPrice = resolveConfiguredPriceBound(config && config.minPrice, undefined, centerPrice, 'min');
    maxPrice = resolveConfiguredPriceBound(config && config.maxPrice, undefined, centerPrice, 'max');
  } catch (_) {
    return null;
  }
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) return null;

  const hasAsym = Number.isFinite(dynamicWeight.appliedAsymmetryFactor)
    && (dynamicWeight.trend === 'UP' || dynamicWeight.trend === 'DOWN');

  let resolvedMinPrice = minPrice;
  let resolvedMaxPrice = maxPrice;
  if (hasAsym) {
    const prices = computeAsymmetricBoundsPrices(
      centerPrice, minPrice, maxPrice,
      dynamicWeight.trend, dynamicWeight.appliedAsymmetryFactor
    );
    if (prices) {
      resolvedMinPrice = prices.resolvedMinPrice;
      resolvedMaxPrice = prices.resolvedMaxPrice;
    }
  }

  return {
    resolvedMinPrice,
    resolvedMaxPrice,
    configuredMinPrice: minPrice,
    configuredMaxPrice: maxPrice,
    appliedAsymmetryFactor: hasAsym ? dynamicWeight.appliedAsymmetryFactor : 0,
    rawAsymmetryFactor: hasAsym ? dynamicWeight.rawAsymmetryFactor : 0,
    isRecent: dynamicWeight.isRecent,
  };
}

/**
 * checkGeometricIncrement: Verify grid uses consistent geometric price progression
 *
 * A proper grid should have constant percentage increments between slots.
 * This function checks if increments are consistent (low standard deviation).
 *
 * Geometric increment formula:
 * increment = (nextPrice - currentPrice) / currentPrice
 * This is a percentage change from one slot to the next.
 *
 * Example with 2% increment:
 * - Slot 1: 100
 * - Slot 2: 102 (increment = 0.02 or 2%)
 * - Slot 3: 104.04 (increment = 0.02 or 2%)
 *
 * Metrics:
 * - avg: Average increment across all slots
 * - stdDev: Standard deviation (should be < 0.1% for good grids)
 * - pass: True if avg matches target and is consistent (for grids with config)
 *
 * @param {Array} grid - All grid slots
 * @param {number} targetIncrement - Target increment ratio (e.g., 0.02 for 2%)
 * @returns {Object} Increment analysis with avg, target, stdDev, consistency
 */
function checkGeometricIncrement(grid, targetIncrement) {
  // Filter out spread slots (only analyze regular buy/sell slots)
  const slots = grid.filter(s => s.type !== 'spread');

  // Need at least 2 slots to calculate increment
  if (slots.length < 2) {
    return { pass: null, avgIncrement: 0, consistent: true, target: targetIncrement };
  }

  /**
   * Calculate increment for each consecutive pair of slots
   * Increment = percentage change from previous to current price
   */
  const increments = [];
  for (let i = 1; i < slots.length; i++) {
    const prevPrice = slots[i - 1].price;
    const currPrice = slots[i].price;
    // Relative price change as decimal (0.02 = 2%)
    const increment = (currPrice - prevPrice) / prevPrice;
    increments.push(increment);
  }

  /**
   * Statistical Analysis
   * Average: Mean of all increments
   * Standard deviation: Measure of variability (lower = more consistent)
   */
  const avgIncrement = increments.reduce((a, b) => a + b) / increments.length;

  // Calculate standard deviation (measure of consistency)
  const stdDev = Math.sqrt(
    increments.reduce((sum, inc) => sum + Math.pow(inc - avgIncrement, 2), 0) / increments.length
  );

  return {
    avg: avgIncrement,                    // Actual average increment
    target: targetIncrement,              // Expected increment from config
    // Difference from target (null if no config)
    diff: targetIncrement ? avgIncrement - targetIncrement : null,
    stdDev: stdDev,                       // Consistency metric
    // Grid is "consistent" if std dev < 0.1%
    consistent: stdDev < 0.001,
    // Pass if matches target AND is consistent (null if no config)
    pass: targetIncrement ? (Math.abs(avgIncrement - targetIncrement) < 0.0001 && stdDev < 0.001) : null
  };
}

/**
 * calculateGridFunds: Calculate total funds in buy and sell sides
 *
 * Currency Note:
 * - Buy slot sizes: Measured in AssetB (quote currency, e.g., BTS)
 *   Each buy slot uses quote currency to purchase base currency
 * - Sell slot sizes: Measured in AssetA (base currency, e.g., XRP)
 *   Each sell slot holds base currency ready to sell
 *
 * Conversion logic:
 * - BTS fund in buy side represents potential XRP purchase: totalBTS / marketPrice
 * - XRP fund in sell side converts to BTS equivalent: totalXRP * marketPrice
 * - Uses market price (midpoint between best buy and best sell) for accurate valuation
 *
 * @param {Array} buySlots - Buy order slots
 * @param {Array} sellSlots - Sell order slots
 * @param {Object} bestBuySlot - Best (highest) buy price slot
 * @param {Object} bestSellSlot - Best (lowest) sell price slot
 * @returns {Object} Fund breakdown {buy: {bts, xrp}, sell: {xrp, bts}}
 */
function calculateGridFunds(buySlots, sellSlots, bestBuySlot, bestSellSlot) {
  /**
   * Direct Fund Aggregation
   * Sum all slot sizes on each side
   * Buy slots: Total BTS committed
   * Sell slots: Total XRP (or base currency) available
   */
  const totalBTS = buySlots.reduce((sum, s) => sum + s.size, 0);
  const totalXRP = sellSlots.reduce((sum, s) => sum + s.size, 0);

  /**
   * Market Price Calculation
   * Use the midpoint between best buy and best sell prices
   * This represents the fair market price for fund valuation
   */
  const marketPrice = bestBuySlot && bestSellSlot
    ? (bestBuySlot.price + bestSellSlot.price) / 2
    : 1;

  // How much XRP the buy-side BTS could purchase (at market price)
  const totalXRPFromBuy = totalBTS / marketPrice;
  // How much BTS the sell-side XRP could generate (at market price)
  const totalBTSFromSell = totalXRP * marketPrice;

  return {
    // Buy side: funds dedicated to purchasing base currency
    buy: {
      bts: totalBTS,            // Direct BTS allocation
      xrp: totalXRPFromBuy      // Equivalent XRP buying power
    },
    // Sell side: funds available to sell base currency
    sell: {
      xrp: totalXRP,            // Direct XRP holdings
      bts: totalBTSFromSell     // Equivalent BTS revenue potential
    }
  };
}

/**
 * getDeltaColor: Return color code based on delta percentage value
 * Under 10%: green, 10-20%: yellow, over 20%: red
 * @param {number} deltaValue - The delta percentage value
 * @returns {string} Color code
 */
function getDeltaColor(deltaValue) {
  if (deltaValue < 10) return colors.buy;      // green
  if (deltaValue <= 20) return colors.spread;  // yellow
  return colors.sell;                          // red
}

/**
 * createDistributionBar: Create a horizontal bar chart showing BUY/SELL/spread distribution
 * Differentiates between active (dark) and virtual (light) slots
 * @param {Object} counts - Object containing activeBuy, virtualBuy, activeSell, virtualSell, spread
 * @returns {{bar: string, buyWidth: number}} Colored bar visualization
 */
function createDistributionBar(counts) {
  const barWidth = BAR_WIDTH; // total width in characters
  const total = counts.activeBuy + counts.virtualBuy + counts.spread + counts.activeSell + counts.virtualSell;

  if (total === 0) return { bar: ' '.repeat(barWidth), buyWidth: 0 };

  // Calculate widths proportionally
  let activeBuyWidth = Math.round((counts.activeBuy / total) * barWidth);
  let virtualBuyWidth = Math.round((counts.virtualBuy / total) * barWidth);
  let spreadWidth = Math.round((counts.spread / total) * barWidth);
  let activeSellWidth = Math.round((counts.activeSell / total) * barWidth);
  let virtualSellWidth = Math.round((counts.virtualSell / total) * barWidth);

  // Ensure spread is visible if it exists
  if (counts.spread > 0 && spreadWidth === 0) {
    spreadWidth = 1;
    // Borrow from largest other section
    const widths = [
      { name: 'activeBuy', val: activeBuyWidth },
      { name: 'virtualBuy', val: virtualBuyWidth },
      { name: 'activeSell', val: activeSellWidth },
      { name: 'virtualSell', val: virtualSellWidth }
    ].sort((a, b) => b.val - a.val);
    if (widths[0].val > 0) {
      if (widths[0].name === 'activeBuy') activeBuyWidth--;
      else if (widths[0].name === 'virtualBuy') virtualBuyWidth--;
      else if (widths[0].name === 'activeSell') activeSellWidth--;
      else if (widths[0].name === 'virtualSell') virtualSellWidth--;
    }
  }

  // Adjust to ensure total is exactly barWidth
  const sum = activeBuyWidth + virtualBuyWidth + spreadWidth + activeSellWidth + virtualSellWidth;
  if (sum !== barWidth) {
    let diff = barWidth - sum;
    const sections = [
      { name: 'activeBuyWidth', get: () => activeBuyWidth, set: v => { activeBuyWidth = v; } },
      { name: 'virtualBuyWidth', get: () => virtualBuyWidth, set: v => { virtualBuyWidth = v; } },
      { name: 'spreadWidth', get: () => spreadWidth, set: v => { spreadWidth = v; } },
      { name: 'activeSellWidth', get: () => activeSellWidth, set: v => { activeSellWidth = v; } },
      { name: 'virtualSellWidth', get: () => virtualSellWidth, set: v => { virtualSellWidth = v; } }
    ];

    while (diff > 0) {
      const target = sections
        .slice()
        .sort((a, b) => b.get() - a.get())[0];
      target.set(target.get() + 1);
      diff--;
    }

    while (diff < 0) {
      const target = sections
        .filter(section => section.get() > 0)
        .sort((a, b) => b.get() - a.get())[0];
      if (!target) break;
      target.set(target.get() - 1);
      diff++;
    }
  }

  const buyBar = colors.buy + '█'.repeat(virtualBuyWidth) + colors.buyDark + '█'.repeat(activeBuyWidth) + colors.reset;
  const spreadBar = '\x1b[97m' + '█'.repeat(spreadWidth) + colors.reset; // white
  const sellBar = colors.sellDark + '█'.repeat(activeSellWidth) + colors.sell + '█'.repeat(virtualSellWidth) + colors.reset;

  return { bar: `${buyBar}${spreadBar}${sellBar}`, buyWidth: activeBuyWidth + virtualBuyWidth };
}

/**
 * createWeightFactorBar: Visualize capital distribution using actual order sizes
 *
 * Shows how capital is distributed across BUY and SELL orders using arithmetic averages.
 * Buy funds measured in quote currency, sell funds in base currency - converts to common basis.
 * Each side scales independently: highest order on each side = 100% (█)
 * Character width is proportional to fund amount on each side (not 50/50 split).
 * Full block (█) = maximum average capital on that side
 * Partial blocks (▁-▇) = progressively lower average capital
 *
 * @param {Array} buyOrders - Buy orders with size property (in quote currency)
 * @param {Array} sellOrders - Sell orders with size property (in base currency)
 * @param {number} barWidth - Target width in characters (default: BAR_WIDTH=51)
 * @param {number} marketPrice - Market price for currency conversion (sell to quote basis)
 * @returns {string} Colored weight visualization with independent scaling
 */
function createWeightFactorBar(buyOrders, sellOrders, barWidth = BAR_WIDTH, marketPrice = 1) {
  if ((!buyOrders || buyOrders.length === 0) && (!sellOrders || sellOrders.length === 0)) {
    return '(no orders)';
  }

  // Calculate total fund weight on each side using arithmetic sum
  const buyTotalSize = (buyOrders || []).reduce((sum, o) => sum + (o.size || 0), 0);
  const sellTotalSize = (sellOrders || []).reduce((sum, o) => sum + (o.size || 0), 0);

  // Convert sell side to quote currency equivalent for accurate ratio calculation
  // Buy side is in quote currency, sell side is in base currency
  // Using market price to convert: sell_base * market_price = sell_quote_equivalent
  const sellTotalInQuote = sellTotalSize * marketPrice;
  const totalFunds = buyTotalSize + sellTotalInQuote;

  // Allocate widths proportionally based on fund ratios (in common currency basis)
  // This ensures character length reflects the actual fund distribution
  let buyWidth, sellWidth;
  if (totalFunds > 0) {
    buyWidth = Math.round((buyTotalSize / totalFunds) * barWidth);
    sellWidth = barWidth - buyWidth;
  } else {
    // Fallback to 50/50 if no funds
    buyWidth = Math.floor(barWidth / 2);
    sellWidth = barWidth - buyWidth;
  }

  // Create buy side with independent scaling (max on buy side = 100%)
  const buyBar = createWeightSide(buyOrders, colors.buyDark, colors.buy, buyWidth);

  // Create sell side with independent scaling (max on sell side = 100%)
  const sellBar = createWeightSide(sellOrders, colors.sellDark, colors.sell, sellWidth);

  return `${buyBar}${sellBar}`;
}

/**
 * Helper: Create weight visualization for one side with independent scaling
 * Distributes orders evenly across bar width, ensuring all bars are filled
 * @param {Array} orders - Orders on this side
 * @param {string} activeColor - Color for active orders
 * @param {string} virtualColor - Color for virtual orders
 * @param {number} sideWidth - Width allocated to this side
 */
function createWeightSide(orders, activeColor, virtualColor, sideWidth) {
  if (!orders || orders.length === 0 || sideWidth === 0) {
    return virtualColor + ' '.repeat(sideWidth) + colors.reset;
  }

  // Get sizes and find max for THIS SIDE only (independent scaling)
  const sizes = orders.map(o => o.size || 0);
  const maxSize = Math.max(...sizes);

  if (maxSize === 0) {
    return virtualColor + '░'.repeat(sideWidth) + colors.reset;
  }

  const compressedWeights = [];

  // Distribute orders evenly across all bar positions
  // Each bar maps to a position in the orders array
  for (let barIdx = 0; barIdx < sideWidth; barIdx++) {
    // Map bar position to order range
    // This ensures even distribution even if orders < sideWidth
    const startPos = (barIdx * orders.length) / sideWidth;
    const endPos = ((barIdx + 1) * orders.length) / sideWidth;

    // Get all orders that fall within this bar's range
    const startIdx = Math.floor(startPos);
    const endIdx = Math.ceil(endPos);
    const groupOrders = orders.slice(startIdx, endIdx);

    if (groupOrders.length === 0) {
      // Fallback: if no orders in range, find nearest order
      const nearestIdx = Math.round(startPos);
      groupOrders.push(orders[Math.min(nearestIdx, orders.length - 1)]);
    }

    const groupSizes = groupOrders.map(o => o.size || 0);
    // Calculate arithmetic average of sizes in this group
    const avgSize = groupSizes.reduce((a, b) => a + b, 0) / groupSizes.length;

    // Normalize to max on THIS SIDE (1-8, minimum 1 for visibility)
    const ratio = avgSize / maxSize;
    const blockHeight = Math.max(1, Math.round(ratio * 8));

    // ACTIVE and PARTIAL slots are both real on-chain orders in this analysis.
    const hasLiveOrder = groupOrders.some(o => o.state === ORDER_STATES.ACTIVE || o.state === ORDER_STATES.PARTIAL);
    const color = hasLiveOrder ? activeColor : virtualColor;

    compressedWeights.push(color + partialBlocks[blockHeight] + colors.reset);
  }

  return compressedWeights.join('');
}

/**
 * analyzeDistribution: Compare slot distribution vs fund distribution
 *
 * Identifies imbalances between:
 * - Slot distribution: How many buy vs sell slots exist
 * - Fund distribution: How much funds are allocated to buy vs sell
 *
 * These should ideally match:
 * - If 50% slots are buy, ~50% of funds should be on buy side
 * - Deviation suggests intentional weighting or uneven fees
 *
 * Example:
 * - 100 total slots: 40 buy + 60 sell = 40% buy slots
 * - Funds: 6000 BTS buy + 4000 BTS sell equivalent = 60% buy funds
 * - Delta buy: |40% - 60%| = 20% (funds weight more toward buy)
 *
 * @param {Array} buySlots - Buy order slots
 * @param {Array} sellSlots - Sell order slots
 * @param {Object} bestBuySlot - Best buy price (used for market price calculation)
 * @param {Object} bestSellSlot - Best sell price (used for market price calculation)
 * @returns {Object} Distribution analysis with slot%, fund%, and deltas
 */
function analyzeDistribution(buySlots, sellSlots, bestBuySlot, bestSellSlot) {
  /**
   * Slot Distribution
   * Simple count: what percentage of total slots are buy vs sell
   */
  const totalSlots = buySlots.length + sellSlots.length;
  const buySlotPercent = totalSlots > 0 ? (buySlots.length / totalSlots) * 100 : 0;
  const sellSlotPercent = totalSlots > 0 ? (sellSlots.length / totalSlots) * 100 : 0;

  /**
   * Fund Distribution
   * Calculate total funds on each side, convert to common currency basis
   * This shows if sides have equal capital or if one is prioritized
   */
  const totalBuyFunds = buySlots.reduce((sum, s) => sum + s.size, 0);
  const totalSellFunds = sellSlots.reduce((sum, s) => sum + s.size, 0);

  /**
   * Currency Conversion for Comparison
   * Buy side funds: Measured in AssetB (quote)
   * Sell side funds: Measured in AssetA (base)
   * Convert both to common basis using market price (midpoint between best buy/sell)
   */
  const marketPrice = bestBuySlot && bestSellSlot
    ? (bestBuySlot.price + bestSellSlot.price) / 2
    : 1;

  // Convert sell-side funds (XRP) to quote currency equivalent (BTS)
  // This allows apples-to-apples fund comparison using market price
  const sellFundsInBTS = totalSellFunds * marketPrice;
  const totalFunds = totalBuyFunds + sellFundsInBTS;

  /**
   * Fund Percentage
   * What % of total funds are allocated to buy vs sell
   */
  const buyFundPercent = totalFunds > 0 ? (totalBuyFunds / totalFunds) * 100 : 0;
  const sellFundPercent = totalFunds > 0 ? (sellFundsInBTS / totalFunds) * 100 : 0;

  return {
    // Slot-level breakdown
    slots: {
      buy: buySlots.length,
      sell: sellSlots.length,
      buyPercent: buySlotPercent,
      sellPercent: sellSlotPercent
    },
    // Fund-level breakdown (in common currency)
    funds: {
      buyPercent: buyFundPercent,
      sellPercent: sellFundPercent
    },
    // Delta: difference between slot% and fund% (shows imbalance)
    // If match is 0, slots and funds are perfectly balanced
    // If match is high, one side is over/under-weighted in funds
    match: {
      buyDiff: buyFundPercent - buySlotPercent,
      sellDiff: sellFundPercent - sellSlotPercent
    }
  };
}

/**
 * getRawWeightValues: Extract raw buy/sell value strings for column alignment,
 * without any color codes or formatting artifacts.
 *
 * Mirrors the display-mode logic of formatWeightLine but returns plain strings.
 *
 * @param {Object|null} weightDistribution
 * @param {Object|null} dynamicWeight
 * @returns {{ buy: string, sell: string } | null}
 */
function getRawWeightValues(weightDistribution, dynamicWeight) {
  if (!weightDistribution) return null;
  const staticBuy = Number(weightDistribution.buy);
  const staticSell = Number(weightDistribution.sell);
  if (!Number.isFinite(staticBuy) || !Number.isFinite(staticSell)) return null;

  if (dynamicWeight && dynamicWeight.isRecent === false) {
    return { buy: staticBuy.toFixed(2), sell: staticSell.toFixed(2) };
  }

  const useLive = !!(dynamicWeight
    && dynamicWeight.isRecent
    && dynamicWeight.live
    && Number.isFinite(Number(dynamicWeight.live.buy))
    && Number.isFinite(Number(dynamicWeight.live.sell)));

  if (!useLive) {
    return { buy: staticBuy.toFixed(2), sell: staticSell.toFixed(2) };
  }

  const liveBuy = Number(dynamicWeight.live.buy);
  const liveSell = Number(dynamicWeight.live.sell);
  return {
    buy: liveBuy.toFixed(2),
    sell: liveSell.toFixed(2)
  };
}

/**
 * formatWeightLine: Render the "Weight:" line, optionally with live dynamic values.
 *
 * Has three display modes:
 * 1. No dynamic snapshot at all (static-only) — e.g. legacy bots
 * 2. Stale snapshot — static values grayed only when dynamic weights are enabled
 * 3. Live snapshot — live values colored by delta
 *
 * When maxBuyWidth/maxSellWidth are provided, the value portion in each column
 * is right-padded so it aligns with the widest value across the Active/Weight/Funds block.
 *
 * @param {Object|null} weightDistribution - Static weight config from bots.json
 * @param {Object|null} dynamicWeight - Live weight snapshot from dynamic grid
 * @param {number} [maxBuyWidth] - Target width for buy-side values (for column alignment)
 * @param {number} [maxSellWidth] - Target width for sell-side values (for column alignment)
 * @returns {string|null} Formatted weight line or null if no valid data
 */
function formatWeightLine(weightDistribution, dynamicWeight, maxBuyWidth, maxSellWidth) {
  if (!weightDistribution) return null;
  const staticBuy = Number(weightDistribution.buy);
  const staticSell = Number(weightDistribution.sell);
  if (!Number.isFinite(staticBuy) || !Number.isFinite(staticSell)) return null;

  // Stale snapshot: snapshot file exists but updatedAt is older than the
  // freshness window. Surface a red "(adapter offline)" alert so the operator
  // knows the live envelope is being withheld, not just absent.
  if (dynamicWeight && dynamicWeight.isRecent === false) {
    const buyVal = staticBuy.toFixed(2);
    const sellVal = staticSell.toFixed(2);
    const alertStr = `${colors.sell}(adapter offline)${colors.reset}`;
    const valueColor = dynamicWeight.dynamicWeightEnabled === true ? colors.gray : '';
    const valueReset = valueColor ? colors.reset : '';
    return `   Weight: ${valueColor}${maxBuyWidth ? buyVal.padEnd(maxBuyWidth) : buyVal}${valueReset} ${colors.buy}buy${colors.reset} | ${valueColor}${maxSellWidth ? sellVal.padEnd(maxSellWidth) : sellVal}${valueReset} ${colors.sell}sell${colors.reset} ${alertStr}`;
  }

  const useLive = !!(dynamicWeight
    && dynamicWeight.isRecent
    && dynamicWeight.live
    && Number.isFinite(Number(dynamicWeight.live.buy))
    && Number.isFinite(Number(dynamicWeight.live.sell)));

  if (!useLive) {
    const buyVal = staticBuy.toFixed(2);
    const sellVal = staticSell.toFixed(2);
    return `   Weight: ${maxBuyWidth ? buyVal.padEnd(maxBuyWidth) : buyVal} ${colors.buy}buy${colors.reset} | ${maxSellWidth ? sellVal.padEnd(maxSellWidth) : sellVal} ${colors.sell}sell${colors.reset}`;
  }

  const liveBuy = Number(dynamicWeight.live.buy);
  const liveSell = Number(dynamicWeight.live.sell);
  // Compare the two live weights, not their deltas: the side with the larger
  // live weight is the one the bot is leaning on most heavily (the "losing"
  // side for that asset). When the two live weights are equal, no side is
  // being favored, so both fall back to white (default terminal color).
  const liveDelta = liveBuy - liveSell;
  let buyColor;
  let sellColor;
  if (Math.abs(liveDelta) <= DYNAMIC_WEIGHT_EPSILON) {
    buyColor = '';
    sellColor = '';
  } else if (liveDelta > 0) {
    // Buy is higher -> losing side (red); sell is lower -> winning side (green)
    buyColor = colors.sell;
    sellColor = colors.buy;
  } else {
    // Buy is lower -> winning side (green); sell is higher -> losing side (red)
    buyColor = colors.buy;
    sellColor = colors.sell;
  }

  const liveBuyStr = `${buyColor}${liveBuy.toFixed(2)}${colors.reset}`;
  const liveSellStr = `${sellColor}${liveSell.toFixed(2)}${colors.reset}`;
  const buyValVisual = liveBuy.toFixed(2);
  const sellValVisual = liveSell.toFixed(2);
  const coloredBuyVal = liveBuyStr;
  const coloredSellVal = liveSellStr;
  const paddedBuyVal = maxBuyWidth ? coloredBuyVal + ' '.repeat(Math.max(0, maxBuyWidth - buyValVisual.length)) : coloredBuyVal;
  const paddedSellVal = maxSellWidth ? coloredSellVal + ' '.repeat(Math.max(0, maxSellWidth - sellValVisual.length)) : coloredSellVal;

  return `   Weight: ${paddedBuyVal} ${colors.buy}buy${colors.reset} | ${paddedSellVal} ${colors.sell}sell${colors.reset}`;
}

/**
 * formatAnalysis: Format analysis results into readable console output
 *
 * Creates a compact, emoji-enriched display of all analysis metrics.
 * Each line is designed to fit in typical terminal width.
 *
 * Output layout:
 * 📊 PAIR
 *    Updated: [timestamp]
 *    [warnings if applicable]
 *    Spread: [status] [real]% (target: [target]%) [direction][delta]
 *    Increment: [status] [avg]% (target: [target]%) [direction][delta] σ=[stddev]
 *    Slots: [buy] buy + [spread] spread + [sell] sell
 *    Grid: BUY [amount] QUOTE ≈ [amount] BASE
 *           SELL [amount] BASE ≈ [amount] QUOTE
 *    Dist: BUY slots [%] vs funds [%] (Δ[diff]%) | SELL slots [%] vs funds [%] (Δ[diff]%)
 *
 * Symbols:
 * ✓ = passes threshold
 * ✗ = exceeds threshold (needs attention)
 * ↓ = value is lower than target
 * ↑ = value is higher than target
 * σ = standard deviation (consistency)
 * Δ = delta (difference)
 *
 * @param {Object} analysis - Analysis result object from analyzeOrder()
 * @returns {string} Formatted multi-line output ready for console.log
 */
function formatAnalysis(analysis) {
  const lines = [];

  // Header: Trading pair name
  lines.push(`\n${colors.cyan}📊 ${analysis.pair}${colors.reset}`);
  lines.push(`   Update: ${analysis.lastUpdated.toLocaleString()}`);
  lines.push(``);

  // Warning: No config available for comparison
  if (!analysis.hasConfig) {
    lines.push(`   ${colors.gray}⚠️  No config found - showing grid data only${colors.reset}`);
  }

  /**
   * Spread Analysis
   * Shows: actual spread vs target spread
   * Status: ✓ if within 0.1% of target, ✗ if not
   * Direction: ↑ if above target, ↓ if below target
   */
  if (analysis.hasConfig) {
    lines.push(
      `   Spread:${formatPercent(analysis.spread.real).padStart(6)} (${formatPercent(analysis.spread.target)}) | Incr.:${formatPercent(analysis.increment.avg).padStart(6)} (${formatPercent(analysis.increment.target)})`
    );
  } else {
    lines.push(`   Spread:${formatPercent(analysis.spread.real).padStart(6)} | Incr.:${formatPercent(analysis.increment.avg).padStart(6)}`);
  }

  // Active orders comparison
  if (analysis.hasConfig && analysis.activeOrdersTarget) {
    const buyTarget = analysis.activeOrdersTarget.buy;
    const sellTarget = analysis.activeOrdersTarget.sell;
    const buyActual = analysis.slots.activeBuy;
    const sellActual = analysis.slots.activeSell;

    // Collect raw buy/sell values across Active, Weight, Funds for column alignment
    const rawWeightVals = getRawWeightValues(analysis.weightDistribution, analysis.dynamicWeight);
    const buyValues: string[] = [`${buyActual}/${buyTarget}`];
    const sellValues: string[] = [`${sellActual}/${sellTarget}`];
    if (rawWeightVals) {
      buyValues.push(rawWeightVals.buy);
      sellValues.push(rawWeightVals.sell);
    }
    if (analysis.botFunds) {
      buyValues.push(analysis.botFunds.buy);
      sellValues.push(analysis.botFunds.sell);
    }
    const maxBuyWidth = Math.max(...buyValues.map(v => stripColorCodes(v).length));
    const maxSellWidth = Math.max(...sellValues.map(v => stripColorCodes(v).length));

    lines.push(`   Active: ${(buyActual + '/' + buyTarget).padEnd(maxBuyWidth)} ${colors.buy}buy${colors.reset} | ${(sellActual + '/' + sellTarget).padEnd(maxSellWidth)} ${colors.sell}sell${colors.reset}`);
    lines.push(``);
    const weightLine = formatWeightLine(analysis.weightDistribution, analysis.dynamicWeight, maxBuyWidth, maxSellWidth);
    if (weightLine) {
      lines.push(weightLine);
    }
    if (analysis.botFunds) {
      lines.push(`    Funds: ${analysis.botFunds.buy.padEnd(maxBuyWidth)} ${colors.buy}buy${colors.reset} | ${analysis.botFunds.sell.padEnd(maxSellWidth)} ${colors.sell}sell${colors.reset}`);
    }
    if (analysis.dynamicWeight && analysis.dynamicWeight.amaCenterPrice != null) {
      const dw = analysis.dynamicWeight;
      const amaColor = dw.isRecent ? '' : colors.gray;
      const rawPrice = Number(dw.amaCenterPrice);
      const amaPrice = rawPrice === 0 ? '0'
        : (Math.abs(rawPrice) >= 1e5 ? String(Math.round(rawPrice))
        : rawPrice.toPrecision(5));

      let diffStr = '';
      if (analysis.marketPrice != null && rawPrice !== 0) {
        const diff = (analysis.marketPrice - rawPrice) / rawPrice;
        const diffColor = diff > 0 ? colors.buy : diff < 0 ? colors.sell : '';
        const sign = diff > 0 ? '+' : '';
        diffStr = ` ${diffColor}(${sign}${Math.round(diff * 100)}%)${colors.reset}`;
      }

      lines.push(`      AMA: ${amaColor}${amaPrice}${colors.reset}${diffStr}`);
    }
    if (analysis.asymmetricBounds) {
      const ab = analysis.asymmetricBounds;
      const minStr = formatCurrency(ab.resolvedMinPrice);
      const maxStr = formatCurrency(ab.resolvedMaxPrice);
      const pctStr = ab.appliedAsymmetryFactor !== 0
        ? ` ${colors.gray}(${(ab.appliedAsymmetryFactor * 100).toFixed(2)}%)${colors.reset}`
        : '';
      lines.push(`   Bounds: ${colors.buy}${minStr}${colors.reset} - ${colors.sell}${maxStr}${colors.reset}${pctStr}`);
    }
    lines.push(``);
  }

  // Calculate bar positioning based on slot distribution
  const totalSlots = analysis.slots.buy + analysis.slots.sell + analysis.slots.spread;
  const buyBarWidth = totalSlots > 0 ? Math.floor((analysis.slots.buy / totalSlots) * BAR_WIDTH) : 0;
  const spreadBarWidth = analysis.slots.spread > 0 ? Math.max(1, Math.floor((analysis.slots.spread / totalSlots) * BAR_WIDTH)) : 0;
  const sellBarWidth = BAR_WIDTH - buyBarWidth - spreadBarWidth;

  // Create formatted labels for three-column layout
  const buyLabel = `${analysis.slots.buy} buy`;
  const spreadLabel = `${analysis.slots.spread} spread`;
  const sellLabel = `${analysis.slots.sell} sell`;

  // Price Range - formatted with three-column alignment
  const buyPrice = analysis.gridMinPrice ? `${colors.buy}${formatCurrency(analysis.gridMinPrice)}${colors.reset}` : 'N/A';
  const midPrice = analysis.marketPrice ? formatCurrency(analysis.marketPrice) : 'N/A';
  const sellPrice = analysis.gridMaxPrice ? `${colors.sell}${formatCurrency(analysis.gridMaxPrice)}${colors.reset}` : 'N/A';

  const pricePrefix = `    Price: `;
  const slotsPrefix = `    Slots: `;

  // Get visual lengths (without color codes)
  const buyPriceVisualLen = stripColorCodes(buyPrice).length;
  const midPriceVisualLen = stripColorCodes(midPrice).length;
  const sellPriceVisualLen = stripColorCodes(sellPrice).length;
  const buyLabelVisualLen = buyLabel.length;
  const spreadLabelVisualLen = spreadLabel.length;
  const sellLabelVisualLen = sellLabel.length;

  // Calculate positions where items should end to align with bar sections
  const barStart = 0;
  const buySection = barStart + buyBarWidth;
  const spreadSection = buySection + spreadBarWidth;
  const barEnd = spreadSection + sellBarWidth;

  // Position items right-aligned at section boundaries, with minimum 1 space gap
  // Buy item: right-align to buySection
  const buyPriceSpacing1 = Math.max(1, buySection - buyPriceVisualLen);
  // Spread item: positioned to center in spread zone
  const spreadMid = buySection + spreadBarWidth / 2;
  const midPriceSpacing1 = Math.max(1, Math.round(spreadMid - midPriceVisualLen / 2) - buyPriceVisualLen);
  // Sell item: right-align to barEnd
  const sellPriceSpacing2 = Math.max(1, barEnd - sellPriceVisualLen - buyPriceVisualLen - midPriceVisualLen - midPriceSpacing1);

  lines.push(
    `${pricePrefix}${buyPrice}${' '.repeat(midPriceSpacing1)}${midPrice}${' '.repeat(Math.max(1, sellPriceSpacing2))}${sellPrice}`
  );

  // Same logic for slots line
  const buyLabelSpacing1 = Math.max(1, buySection - buyLabelVisualLen);
  const spreadMidLabel = buySection + spreadBarWidth / 2;
  const spreadLabelSpacing1 = Math.max(1, Math.round(spreadMidLabel - spreadLabelVisualLen / 2) - buyLabelVisualLen);
  const sellLabelSpacing2 = Math.max(1, barEnd - sellLabelVisualLen - buyLabelVisualLen - spreadLabelVisualLen - spreadLabelSpacing1);

  lines.push(
    `${slotsPrefix}${colors.buy}${buyLabel}${colors.reset}${' '.repeat(spreadLabelSpacing1)}${spreadLabel}${' '.repeat(Math.max(1, sellLabelSpacing2))}${colors.sell}${sellLabel}${colors.reset}`
  );

  /**
   * Fund Allocation Breakdown
   * Shows funds in each currency (quote for buy, base for sell)
   * Also shows cross-currency equivalent for comparison
   * Example: BUY 1000 BTS ≈ 50 XRP (at avg buy price)
   */
  const [assetASymbol, assetBSymbol] = analysis.pair.split('/');

  // Fallback for null symbols (shouldn't happen after fix, but added for safety)
  const aSymbol = assetASymbol || 'BASE';
  const bSymbol = assetBSymbol || 'QUOTE';

  /**
   * Distribution Analysis
   * Compares slot count % with fund allocation %
   * Shows if one side is over/under-weighted relative to slot count
   * Δ (delta) = difference between slot % and fund %
   *   Δ 0% = perfectly balanced (slots match funds)
   *   Δ 20% = significant imbalance (e.g., 40% slots but 60% funds)
   */
  const buySlotPct = analysis.distribution.slots.buyPercent.toFixed(1);
  const buyFundPct = analysis.distribution.funds.buyPercent.toFixed(1);
  const sellSlotPct = analysis.distribution.slots.sellPercent.toFixed(1);
  const sellFundPct = analysis.distribution.funds.sellPercent.toFixed(1);
  const buyMatch = analysis.distribution.match.buyDiff.toFixed(1);
  const sellMatch = analysis.distribution.match.sellDiff.toFixed(1);

  // Calculate spread slot percentage (totalSlots already calculated above)
  const spreadSlotPct = totalSlots > 0 ? ((analysis.slots.spread / totalSlots) * 100).toFixed(1) : '0.0';
  // Recalculate buy/sell percentages to include spread in total
  const buySlotPctWithSpread = totalSlots > 0 ? ((analysis.slots.buy / totalSlots) * 100).toFixed(1) : '0.0';
  const sellSlotPctWithSpread = totalSlots > 0 ? ((analysis.slots.sell / totalSlots) * 100).toFixed(1) : '0.0';

  const { bar: slotDistBar, buyWidth: slotDistBuyWidth } = createDistributionBar({
    activeBuy: analysis.slots.activeBuy,
    virtualBuy: analysis.slots.virtualBuy,
    spread: analysis.slots.spread,
    activeSell: analysis.slots.activeSell,
    virtualSell: analysis.slots.virtualSell
  });

  // Weight factor visualization (funds distribution across all orders)
  const weightBar = createWeightFactorBar(
    analysis.slotData?.buy,
    analysis.slotData?.sell,
    BAR_WIDTH,
    analysis.marketPrice || 1
  );

  lines.push(
    `           ${slotDistBar}`
  );

  // Position delta indicator directly under the spread slot character
  const buyDiffVal = analysis.distribution.match.buyDiff;
  const signedMatch = (buyDiffVal > 0 ? '+' : '') + buyDiffVal.toFixed(1);
  const deltaStr = `Δ ${signedMatch}%`;
  const spreadStart = 11 + slotDistBuyWidth; // Position where spread character starts (11 = prefix length)
  lines.push(
    `${' '.repeat(spreadStart)}${deltaStr}`
  );

  lines.push(
    `    Funds: ${weightBar}`
  );

  // Funds breakdown: BUY on left, SELL on right (right-aligned within its column)
  const buyValueStr = `${formatFundsValue(analysis.funds.buy.bts)} ${bSymbol}`;
  const sellValueStr = `${formatFundsValue(analysis.funds.sell.xrp)} ${aSymbol}`;
  const buyEquivStr = `≈ ${formatFundsValue(analysis.funds.buy.xrp)} ${aSymbol}`;
  const sellEquivStr = `≈ ${formatFundsValue(analysis.funds.sell.bts)} ${bSymbol}`;

  // Right column width is the maximum of sell value or sell equivalent
  const rightColWidth = Math.max(sellValueStr.length, sellEquivStr.length);

  // Right-align both sell strings within the right column width
  const sellValueRight = ' '.repeat(Math.max(0, rightColWidth - sellValueStr.length)) + sellValueStr;
  const sellEquivRight = ' '.repeat(Math.max(0, rightColWidth - sellEquivStr.length)) + sellEquivStr;

  // Build prefix strings and calculate their lengths
  const prefix1 = `           `;
  const prefix2 = `           `;
  const prefix1Len = prefix1.length;
  const prefix2Len = prefix2.length;

  // Calculate spacing to match the Slots line width (prefix + bar width)
  // This ensures funds breakdown lines align with the visual bar width
  const barLinePrefix = `    Funds: `;
  const targetWidth = barLinePrefix.length + BAR_WIDTH;

  // Spacing for each line: targetWidth - line prefix - buyValue - sellColumn
  const spacing1 = Math.max(2, targetWidth - prefix1Len - buyValueStr.length - rightColWidth);
  const spacing2 = Math.max(2, targetWidth - prefix2Len - buyEquivStr.length - rightColWidth);

  lines.push(`${prefix1}${colors.buy}${buyValueStr}${colors.reset}${' '.repeat(spacing1)}${colors.sell}${sellValueRight}${colors.reset}`);
  lines.push(`${prefix2}${buyEquivStr}${' '.repeat(spacing2)}${sellEquivRight}`);

  // Align pipe separators across all lines so every | sits at the same column
  let maxPipePos = 0;
  const pipeLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const pipeIdx = lines[i].indexOf('|');
    if (pipeIdx !== -1) {
      pipeLines.push(i);
      const visualLen = stripColorCodes(lines[i].substring(0, pipeIdx)).length;
      if (visualLen > maxPipePos) maxPipePos = visualLen;
    }
  }
  for (const idx of pipeLines) {
    const pipeIdx = lines[idx].indexOf('|');
    const visualLen = stripColorCodes(lines[idx].substring(0, pipeIdx)).length;
    if (visualLen < maxPipePos) {
      lines[idx] = lines[idx].substring(0, pipeIdx) + ' '.repeat(maxPipePos - visualLen) + lines[idx].substring(pipeIdx);
    }
  }

  return lines.join('\n');
}

/**
 * main: Entry point - analyze all order files and display results
 *
 * Flow:
 * 1. Get all order files from profiles/orders/ (sorted by modified date)
 * 2. For each file:
 *    - Parse order data JSON
 *    - Look up bot configuration from profiles/bots.json
 *    - Perform comprehensive analysis
 *    - Format and display results
 * 3. Handle errors gracefully (skip bad files, continue)
 * 4. Print summary statistics
 *
 * Error handling:
 * - Invalid JSON: Catch and skip file with error message
 * - Missing config: Display grid data only (no target comparisons)
 * - Empty orders directory: Display message and exit
 *
 * Output order: Files sorted by modification time (most recent first)
 * makes it easy to see which bots were most recently updated
 */
function main() {
  // Header
  console.log(`\n${colors.cyan}🔍 Order Analysis${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(HEADER_WIDTH)}${colors.reset}`);

  // Get all order files sorted by modification time (newest first)
  const { files, skippedCandidates } = getOrderFiles();

  // Handle fully empty directory case. If files were skipped, report why below.
  if (files.length === 0 && skippedCandidates.length === 0) {
    console.log('No order files found in profiles/orders/');
    process.exit(0);
  }

  // Counters for summary statistics
  let analyzed = 0;
  let skipped = 0;

  /**
   * Process each order file
   * Try-catch ensures one bad file doesn't stop analysis of others
   */
  files.forEach((file, index) => {
    try {
      // Parse order file JSON
      const orderData = readJSON(file.path);
      // Per-bot file: data is the bot's entry directly (no bots wrapper)
      if (!orderData || !orderData.meta || !Array.isArray(orderData.grid)) {
        throw new Error('Not a persisted order grid');
      }
      const botKey = file.botKey;
      const botData = orderData;

      // Candidate validation already required a configured bot entry.
      const config = file.config || getConfiguredBotConfig(botKey, botData);
      if (!config) {
        throw new Error(`Missing configured bot entry for ${botKey}`);
      }

      // Analyze the order grid (botKey is used to load the dynamic grid snapshot)
      const analysis = analyzeOrder(botData, config, botKey);
      // Display formatted results
      let output = formatAnalysis(analysis);
      // Remove leading newline from first pair to avoid blank line after header
      if (index === 0) {
        output = output.replace(/^\n/, '');
        console.log(output);
        console.log('');  // Extra blank line after first batch
      } else {
        console.log(output);
      }
      analyzed++;

    } catch (error) {
      // Log error but continue processing other files
      console.error(`\n❌ Error processing ${file.name}: ${error.message}`);
      skipped++;
    }
  });

  if (skippedCandidates.length > 0) {
    console.log('');
    console.log(`${colors.cyan}${'='.repeat(HEADER_WIDTH)}${colors.reset}`);
    skippedCandidates.forEach(candidate => {
      console.log(`${colors.gray}Skipped ${candidate.name}: ${candidate.reason}${colors.reset}`);
      skipped++;
    });
  }

  // Summary line
  console.log(`${colors.cyan}${'='.repeat(HEADER_WIDTH)}${colors.reset}`);
  console.log(`${colors.cyan}Summary: ${analyzed} analyzed, ${skipped} skipped${colors.reset}\n`);
}

// Execute analysis only when invoked as a script. When required from a test we
// expose the helpers below without triggering the analyzer side effects.
if (require.main === module) {
  main();
}

module.exports = {
  isAmaGridPrice,
  readDynamicGridSnapshot,
  buildDynamicWeightInfo,
  formatWeightLine,
  getRawWeightValues,
  analyzeOrder,
  formatAnalysis,
  DYNAMIC_GRID_SNAPSHOT_MAX_AGE_MS,
  DYNAMIC_WEIGHT_EPSILON,
};
