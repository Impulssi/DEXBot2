/**
 * modules/order/export.ts - Trade Export Module
 *
 * Trading history extraction and CSV export engine.
 * Parses PM2 log files to extract trading fills and exports to standardized format.
 *
 * Usage:
 *   const exporter = require('./order/export');
 *   const result = await exporter.exportBotTrades(botKey, botConfig, outputDir);
 *
 * Output Format:
 * - CSV: Trades in standardized format (unix, price, amount, side, fee_asset, fee_amount, order_id)
 * - JSON: Sanitized bot settings (excludes private keys)
 *
 * ===============================================================================
 * TABLE OF CONTENTS (4 exported functions + 3 internal helpers)
 * ===============================================================================
 *
 * PUBLIC EXPORTS (4 functions)
 *   1. exportBotTrades(botKey, botConfig, outputDir) - Main export function (async)
 *      Orchestrates trade extraction and writing CSV/JSON exports
 *      Returns: { success, trades_exported, csv_path, settings_path, output_dir, timestamp }
 *
 *   2. parseLogFile(logFilePath) - Parse PM2 log file to extract trades (async)
 *      Reads line-by-line, extracts FILL entries, links with fee information
 *      Returns: Array of trade objects with { timestamp, side, amount, price, proceeds, fee_asset, fee_amount }
 *
 *   3. writeTradesCSV(trades, outputPath) - Write trades to CSV file (async)
 *      Generates standardized CSV with proper escaping and formatting
 *      Returns: { success, count } or { success: false, error }
 *
 *   4. writeSettingsJSON(botConfig, botName, outputPath) - Write sanitized bot settings (async)
 *      Exports bot parameters and configuration (excludes private keys)
 *      Returns: { success } or { success: false, error }
 *
 * INTERNAL HELPERS (3 functions)
 *   5. parseFillLine(line) - Parse fill entry from log line
 *      Expected format: [TIMESTAMP] [DEBUG] [FILL] side fill: size=X, price=Y, proceeds=Z
 *      Returns: { timestamp, side, amount, price, proceeds } or null
 *
 *   6. parseFeeLine(line) - Parse fee information from log line
 *      Expected format: [TIMESTAMP] [INFO] [FEES] N maker fills @ FEE ASSET = TOTAL
 *      Returns: { count, fee_per_fill, fee_asset, total_fee } or null
 *
 *   7. linkFillWithFee(fills, fees) - Match and link most recent fill with fee
 *      Checks timestamp proximity (within 5 seconds) to associate fill with fee
 *      Modifies fills array in-place
 *
 * ===============================================================================
 *
 * LOG FORMAT PATTERNS:
 * Fill line: [2026-01-15T15:29:06.185Z] [DEBUG] [FILL] sell fill: size=0.0316, price=1791.30065898866, proceeds=56.60510082 BTS
 * Fee line:  [2026-01-15T15:29:06.185Z] [INFO] [FEES] BTS fees calculated: 1 maker fills @ 0.04826000 BTS = 0.04826000 BTS
 *
 * CSV HEADER:
 * unix, price, amount, side, fee_asset, fee_amount, order_id
 *
 * ===============================================================================
 */


import { getStorage } from '../storage';
import { getNodeRequire } from '../env';
import { path } from '../path_api';
import * as Format from './format';
import { TIMING, DEFAULT_CONFIG } from '../constants';
import { PATHS } from '../paths';
import Logger from '../logger';
import { getErrorMessage } from '../utils/errors';
const _require = getNodeRequire();
const storage = getStorage();
let _readline: any;
function getReadline() {
    if (!_readline && _require) _readline = _require('readline');
    return _readline;
}
const exportLogger = new Logger('Export');

/**
 * Parse a fill line from PM2 log file
 * Expected format: [2026-01-15T15:29:06.185Z] [DEBUG] [FILL] sell fill: size=0.0316, price=1791.30065898866, proceeds=56.60510082 BTS
 * @param {string} line - Raw log line
 * @returns {Object|null} Parsed fill object or null on no match
 */
interface FillEntry {
    timestamp: number;
    side: any;
    amount: number;
    price: number;
    proceeds: number;
    fee_asset: string;
    fee_amount: number;
    order_id?: string;
}

interface FeeEntry {
    count: number;
    fee_per_fill: number;
    fee_asset: any;
    total_fee: number;
    timestamp: number;
}

function parseFillLine(line: string): FillEntry | null {
    const fillMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\].*\[FILL\]\s+(\w+)\s+fill:\s+size=([\d.]+),\s+price=([\d.]+),\s+proceeds=([\d.]+)/);

    if (!fillMatch) return null;

    return {
        timestamp: new Date(fillMatch[1]).getTime() / 1000,  // Unix timestamp in seconds
        side: fillMatch[2],                                   // 'buy' or 'sell'
        amount: parseFloat(fillMatch[3]),                     // Size in base asset
        price: parseFloat(fillMatch[4]),                      // Execution price
        proceeds: parseFloat(fillMatch[5]),                    // Proceeds/cost
        fee_asset: 'BTS',
        fee_amount: 0
    };
}

/**
 * Parse fee information from log line
 * Expected format: [2026-01-15T15:29:06.185Z] [INFO] [FEES] BTS fees calculated: 1 maker fills @ 0.04826000 BTS = 0.04826000 BTS
 * @param {string} line - Raw log line
 * @returns {Object|null} Parsed fee object or null on no match
 */
function parseFeeLine(line: string): FeeEntry | null {
    const feeMatch = line.match(/\[FEES\].*?(\d+)\s+maker\s+fills\s+@\s+([\d.]+)\s+(\w+)\s*=\s*([\d.]+)\s+\w+/);

    if (!feeMatch) return null;

    return {
        count: parseInt(feeMatch[1]),
        fee_per_fill: parseFloat(feeMatch[2]),
        fee_asset: feeMatch[3],
        total_fee: parseFloat(feeMatch[4]),
        timestamp: 0
    };
}

/**
 * Link fill with its corresponding fee information
 * @param {Array} fills - Array of parsed fill objects
 * @param {Array} fees - Array of parsed fee objects
 * @returns {void}
 */
function linkFillWithFee(fills: any, fees: any) {
    // Match most recent fill with most recent fee
    if (fills.length > 0 && fees.length > 0) {
        const lastFill = fills[fills.length - 1];
        const lastFee = fees[fees.length - 1];

        // Only link if they're close in time (within 5 seconds)
        if (Math.abs(lastFill.timestamp - lastFee.timestamp) < 5) {
            lastFill.fee_asset = lastFee.fee_asset;
            lastFill.fee_amount = lastFee.total_fee;
        }
    }
}

/**
 * Parse PM2 log file to extract trades
 * @param {string} logFilePath - Path to PM2 log file
 * @returns {Promise<Array>} Array of trade objects
 */
async function parseLogFile(logFilePath: any) {
    const fills: any[] = [];
    const fees: any[] = [];

    try {
        const fileStream = storage.createReadStream(logFilePath);
        const rl = getReadline().createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            // Parse fill lines
            const fill = parseFillLine(line);
            if (fill) {
                fill.fee_asset = 'BTS';  // Default, will be overwritten if found
                fill.fee_amount = 0;
                fills.push(fill);
                continue;
            }

            // Parse fee lines
            const fee = parseFeeLine(line);
            if (fee) {
                fee.timestamp = Date.now() / TIMING.MILLISECONDS_PER_SECOND;  // Approximate timestamp (seconds)
                fees.push(fee);
                linkFillWithFee(fills, fees);
                continue;
            }
        }

        // Link any remaining fills with fees
        for (const fill of fills) {
            if (fill.fee_amount === 0 && fees.length > 0) {
                const relevantFee = fees.find((f: any) => Math.abs(f.timestamp - fill.timestamp) < 5);
                if (relevantFee) {
                    fill.fee_asset = relevantFee.fee_asset;
                    fill.fee_amount = relevantFee.total_fee;
                }
            }
        }

        return fills;
    } catch (err: any) {
        exportLogger.error(`Failed to parse log file ${logFilePath}: ${getErrorMessage(err)}`);
        return [];
    }
}

/**
 * Write trades to CSV file in QTradeX format
 * @param {Array} trades - Array of trade objects
 * @param {string} outputPath - Path to output CSV file
 * @returns {Promise<Object>} { success: boolean, count: number } or { success: false, error: string }
 */
async function writeTradesCSV(trades: any, outputPath: any) {
    try {
        // CSV header
        const headers = ['unix', 'price', 'amount', 'side', 'fee_asset', 'fee_amount', 'order_id'];

        // CSV rows
        const rows = trades.map((trade: any) => [
            trade.timestamp.toFixed(1),
            Format.formatPrice(trade.price),
            Format.formatAmount8(trade.amount),
            trade.side,
            trade.fee_asset || 'BTS',
            Format.formatAmount8(trade.fee_amount || 0),
            trade.order_id || ''
        ]);

        // Combine and write
        const csv = [headers, ...rows]
            .map((row: any) => row.map((val: any) => {
                // Escape quotes and wrap in quotes if contains comma
                if (typeof val === 'string' && val.includes(',')) {
                    return `"${val.replace(/"/g, '""')}"`;
                }
                return val;
            }).join(','))
            .join('\n');

        storage.writeFile(outputPath, csv + '\n', 'utf8');
        exportLogger.info(`✓ Exported ${trades.length} trades to ${outputPath}`);

        return { success: true, count: trades.length };
    } catch (err: any) {
        exportLogger.error(`Failed to write CSV: ${getErrorMessage(err)}`);
        return { success: false, error: getErrorMessage(err) };
    }
}

/**
 * Write sanitized bot settings to JSON file
 * Excludes private keys and sensitive data
 * @param {Object} botConfig - Bot configuration object
 * @param {string} botName - Bot name
 * @param {string} outputPath - Path to output JSON file
 * @returns {Promise<Object>} Write result { success, count } or { success: false, error }
 */
async function writeSettingsJSON(botConfig: any, botName: any, outputPath: any) {
    try {
        const sanitized = {
            bot_name: botName,
            strategy: botConfig.strategy || 'grid_trading',
            market: botConfig.market || `${botConfig.assetA}/${botConfig.assetB}`,
            parameters: {
                start_price: botConfig.startPrice || DEFAULT_CONFIG.startPrice,
                min_price: botConfig.minPrice || DEFAULT_CONFIG.minPrice,
                max_price: botConfig.maxPrice || DEFAULT_CONFIG.maxPrice,
                increment_percent: botConfig.incrementPercent || DEFAULT_CONFIG.incrementPercent,
                target_spread_percent: botConfig.targetSpreadPercent || DEFAULT_CONFIG.targetSpreadPercent,
                active_orders: botConfig.activeOrders || DEFAULT_CONFIG.activeOrders,
                bot_funds: botConfig.botFunds || DEFAULT_CONFIG.botFunds,
                weight_distribution: botConfig.weightDistribution || DEFAULT_CONFIG.weightDistribution,
                dry_run: botConfig.dryRun || false,
                active: botConfig.active !== false
            },
            assets: {
                base: botConfig.assetA,
                quote: botConfig.assetB
            },
            exported_at: new Date().toISOString()
        };

        storage.writeFile(outputPath, JSON.stringify(sanitized, null, 2) + '\n', 'utf8');
        exportLogger.info(`✓ Exported settings to ${outputPath}`);

        return { success: true };
    } catch (err: any) {
        exportLogger.error(`Failed to write settings JSON: ${getErrorMessage(err)}`);
        return { success: false, error: getErrorMessage(err) };
    }
}

/**
 * Export bot trades from PM2 log file to CSV
 * @param {string} botKey - Bot identifier (e.g., 'xrp-bts-0')
 * @param {Object} botConfig - Bot configuration object
 * @param {string} outputDir - Output directory for exports (default: './exports')
 * @returns {Promise<Object>} Export result status
 */
async function exportBotTrades(botKey: any, botConfig: any, outputDir: any = './exports') {
    try {
        // Ensure output directory exists
        storage.ensureDir(outputDir);

        // Find log file (PM2 format: {botKey}-error.log or {botKey}.log)
        const logsDir = PATHS.LOGS_DIR;
        let logFilePath: string | null = null;

        try {
            const logFiles = storage.readdir(logsDir);
            const matchingLog = logFiles.find((f: any) =>
                f.includes(botKey) && f.endsWith('.log') && !f.includes('error')
            );

            if (matchingLog) {
                logFilePath = path.join(logsDir, matchingLog);
            }
        } catch (err: any) {
            exportLogger.warn(`Could not read logs directory: ${getErrorMessage(err)}`);
        }

        // Parse trades from log file
        const trades = logFilePath ? await parseLogFile(logFilePath) : [];

        if (trades.length === 0) {
            exportLogger.warn(`No trades found in log file for ${botKey}`);
        }

        // Write trades CSV
        const csvPath = path.join(outputDir, `${botKey}_trades.csv`);
        const csvResult = await writeTradesCSV(trades, csvPath);

        // Write settings JSON
        const settingsPath = path.join(outputDir, `${botKey}_settings.json`);
        const settingsResult = await writeSettingsJSON(botConfig, botKey, settingsPath);

        return {
            success: csvResult.success && settingsResult.success,
            trades_exported: trades.length,
            csv_path: csvPath,
            settings_path: settingsPath,
            output_dir: outputDir,
            timestamp: new Date().toISOString()
        };
    } catch (err: any) {
        exportLogger.error(`Export failed for ${botKey}: ${getErrorMessage(err)}`);
        return {
            success: false,
            error: getErrorMessage(err),
            bot_key: botKey
        };
    }
}

export { exportBotTrades, parseLogFile, writeTradesCSV, writeSettingsJSON }

