'use strict';

/**
 * modules/logger.ts - Node Logger (sourced from order/logger)
 *
 * Node-only Logger hub. Re-exports modules/order/logger. For browser bundles,
 * use a console-only shim from modules/env or a separate browser entrypoint.
 *
 * Usage:
 *   // Bot operation logging (console only)
 *   const Logger = require('./modules/logger');
 *   const logger = new Logger('MyComponent');
 *   logger.info('Starting bot');
 *
 *   // Market adapter / dryrun logging (to separate file)
 *   const logger = new Logger('MarketAdapter', { logFile: './logs/market_adapter.log' });
 *   logger.info('Processing bot');
 *
 *   // Quiet mode (for tests)
 *   const logger = new Logger('Test', { quiet: true });
 *
 * Constructor Options:
 *   - category: {string} Logger prefix (e.g., 'DEXBot', 'MarketAdapter')
 *   - quiet: {boolean} Suppress console output (default false)
 *   - logFile: {string} Path to optional log file (appends output)
 *   - level: {string} Log level: 'debug', 'info', 'warn', 'error' (default 'info')
 *   - configOverride: {Object} Override LOGGING_CONFIG from constants
 *   - correlationId: {string} Optional correlation ID for request tracing
 */

module.exports = require('./order/logger');
