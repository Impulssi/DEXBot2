/**
 * modules/order/runner.ts - Grid Calculation Runner
 *
 * Standalone order grid calculation utility for testing and debugging.
 * Provides command-line tools for grid verification without placing orders.
 *
 * Features:
 * - Load bot configuration from profiles/bots.json
 * - Derive market price from pool or market
 * - Create and display order grid
 * - Simulate multiple calculation cycles
 * - Validate grid structure and fund calculations
 *
 * Useful for:
 * - Verifying configuration produces expected grid
 * - Testing price derivation from pool/market sources
 * - Debugging order sizing and fund allocation
 * - Validating fund calculations (available, virtual, committed)
 * - Testing grid synchronization logic
 *
 * ===============================================================================
 * EXPORTS (1 function)
 * ===============================================================================
 *
 * 1. runOrderManagerCalculation() - Main calculation runner (async)
 *    Loads bot config, derives market price, initializes grid, runs calculation cycles
 *    Validates config, derives startPrice, initializes OrderManager and Grid
 *    Runs configurable cycles with optional delays
 *    Displays grid status and metrics after each cycle
 *
 *    Environment variables:
 *    - LIVE_BOT_NAME or BOT_NAME: Bot to use (defaults to first bot)
 *    - CALC_CYCLES: Number of calculation cycles (default: 3)
 *    - CALC_DELAY_MS: Delay between cycles (default: 500ms)
 *
 * ===============================================================================
 *
 * USAGE:
 * Command line:
 *   node -e "require('./runner').runOrderManagerCalculation()"
 *
 * With env vars:
 *   CALC_CYCLES=5 CALC_DELAY_MS=1000 node -e "require('./runner').runOrderManagerCalculation()"
 *
 * From code:
 *   const { runOrderManagerCalculation } = require('./runner');
 *   await runOrderManagerCalculation();
 *
 * ===============================================================================
 *
 * Fund model overview (see manager.ts for full details):
 * - available = max(0, chainFree - virtual - applicableBtsFeesOwed - btsFeesReservation)
 * - virtual = sum of VIRTUAL orders and ACTIVE orders without orderId (reserved, not yet on-chain)
 * - committed.grid = total sum of all grid order sizes (active + partial + virtual)
 * - committed.chain = sum of ACTIVE or PARTIAL orders that have an orderId on-chain
 *
 * ===============================================================================
 */

const { path } = require('../path_api');
const { OrderManager } = require('./manager');
const { PATHS } = require('../paths');
const { initializeGrid } = require('./grid');
const { readBotsFileSync } = require('../bots_file_lock');
const { Config } = require('../config');
const { parseJsonWithComments, sleep } = require('./utils/system');
const { derivePrice } = require('./utils/system');
const { isNumeric } = require('./format');

/**
 * Run a standalone order grid calculation for testing.
 * Loads bot config, derives market price, creates grid, and simulates cycles.
 * @returns {Promise<void>}
 * @throws {Error} If config invalid or startPrice outside bounds
 */
async function runOrderManagerCalculation() {
        const cfgFile = PATHS.PROFILES.BOTS_JSON;
    let botConfig: any = {};

    try {
        const { config } = readBotsFileSync(cfgFile, parseJsonWithComments);
        const bots = config.bots || [];

        const envName = Config.LIVE_BOT_NAME || Config.BOT_NAME;
        let chosenBot = null;
        if (envName) chosenBot = bots.find(b => String(b.name).toLowerCase() === String(envName).toLowerCase());
        if (!chosenBot) chosenBot = bots[0];

        if (!chosenBot) {
            throw new Error('No bots found in profiles/bots.json');
        }

        console.log(`Using bot from settings: ${chosenBot.name || '<unnamed>'}`);
        botConfig = { ...chosenBot };
    } catch (err: any) {
        console.warn('Failed to read bot configuration:', err.message);
        throw err;
    }

    const rawMarketPrice = botConfig.startPrice;

    // Auto-derive price ONLY if not a fixed numeric value
    if (!isNumeric(rawMarketPrice)) {
        try {
            const { BitShares } = require('../bitshares_client');
            const mode = botConfig.priceMode || (rawMarketPrice === 'book' || rawMarketPrice === 'market' ? 'book' : (rawMarketPrice === 'pool' ? 'pool' : 'auto'));

            console.log(`Deriving startPrice using mode: ${mode}...`);
            const derived = await derivePrice(BitShares, botConfig.assetA, botConfig.assetB, mode);

            if (derived) {
                botConfig.startPrice = Number(derived);
                console.log(`✓ Derived startPrice from on-chain: ${botConfig.startPrice}`);
            } else {
                throw new Error(`Failed to derive price using mode "${mode}" and no numeric fallback available.`);
            }
        } catch (err: any) {
            console.error('Price derivation failed:', err.message);
            throw err;
        }
    }

    try {
        const mp = Number(botConfig.startPrice);
        if (!Number.isFinite(mp)) throw new Error('Invalid startPrice (not a number)');
    } catch (err: any) { throw err; }

    const manager = new OrderManager(botConfig);
    await initializeGrid(manager);

    const cycles = Config.CALC_CYCLES;
    const delayMs = Config.CALC_DELAY_MS;

    for (let cycle = 1; cycle <= cycles; cycle++) {
        manager.logger.log(`\n----- Cycle ${cycle}/${cycles} -----`, 'info');
        // Use syncFromOpenOrders([]) to simulate a sync check in the test runner
        await manager.syncFromOpenOrders([]);
        manager.logger && manager.logger.displayStatus && manager.logger.displayStatus(manager);
        if (cycle < cycles) await sleep(delayMs);
    }
}

export = { runOrderManagerCalculation };
