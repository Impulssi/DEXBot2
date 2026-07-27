/**
 * scripts/runner.ts - Grid Calculation Runner
 *
 * Standalone order grid calculation utility for testing and debugging.
 * Provides command-line tools for grid verification without placing orders.
 *
 * NOTE: Requires a live BitShares connection — initializeGrid() performs
 * on-chain asset metadata lookups and price derivation. Not offline-capable.
 *
 * Features:
 * - Load bot configuration from profiles/bots.json
 * - Derive market price from pool or market (via initializeGrid)
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
 *    Validates config, initializes OrderManager and Grid (price derivation handled
 *    internally by initializeGrid), runs configurable cycles with optional delays
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
 *   node -e "require('./scripts/runner').runOrderManagerCalculation()"
 *   tsx scripts/runner.ts
 *
 * With env vars:
 *   CALC_CYCLES=5 CALC_DELAY_MS=1000 node -e "require('./scripts/runner').runOrderManagerCalculation()"
 *   CALC_CYCLES=5 CALC_DELAY_MS=1000 tsx scripts/runner.ts
 *
 * From code:
 *   const { runOrderManagerCalculation } = require('./scripts/runner');
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


/**
 * Run a standalone order grid calculation for testing.
 * Loads bot config, initializes grid, and simulates sync cycles.
 * Price derivation is handled internally by initializeGrid.
 * @returns {Promise<void>}
 * @throws {Error} If config invalid, BitShares unavailable, or grid init fails
 */

import { OrderManager } from '../modules/order/manager';
import { PATHS } from '../modules/paths';
import { initializeGrid } from '../modules/order/grid';
import { readBotsFileSync } from '../modules/bots_file_lock';
import { Config } from '../modules/config';
import { parseJsonWithComments, sleep } from '../modules/order/utils/system';
async function runOrderManagerCalculation() {
    const cfgFile = PATHS.PROFILES.BOTS_JSON;
    let botConfig: any = {};

    try {
        const { config } = readBotsFileSync(cfgFile, parseJsonWithComments);
        const bots = config.bots || [];

        const envName = Config.LIVE_BOT_NAME || Config.BOT_NAME;
        let chosenBot: any = null;
        if (envName) chosenBot = bots.find((b: any) => String(b.name).toLowerCase() === String(envName).toLowerCase());
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

    const manager = new OrderManager(botConfig);

    try {
        await initializeGrid(manager);
    } catch (err: any) {
        console.error('Grid initialization failed — ensure BitShares nodes are reachable and asset symbols are valid:', err.message);
        throw err;
    }

    const cycles = Config.CALC_CYCLES;
    const delayMs = Config.CALC_DELAY_MS;

    for (let cycle = 1; cycle <= cycles; cycle++) {
        manager.logger.log(`\n----- Cycle ${cycle}/${cycles} -----`, 'info');
        await manager.syncFromOpenOrders([], {});
        manager.logger && manager.logger.displayStatus && manager.logger.displayStatus(manager);
        if (cycle < cycles) await sleep(delayMs);
    }
}

export { runOrderManagerCalculation }

