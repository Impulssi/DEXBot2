'use strict';

/**
 * Canonical AMA grid-price detection.
 *
 * Single source of truth shared by:
 *   - market_adapter/core/market_adapter_service.ts (browser-safe cycle logic)
 *   - modules/dexbot_maintenance_runtime.ts (Node-only maintenance runtime)
 *     and its consumers (pm2.ts, launcher/*, unlock.ts)
 *
 * Intentionally import-free so it stays safe for browser bundles and
 * fn.toString() embedding.
 */

/**
 * Check if a bot configuration uses an AMA grid price source.
 * @param {Object} bot - Bot configuration object
 * @returns {boolean} True if gridPrice starts with 'ama' (ama, ama1..ama4)
 */
function usesAmaGridPrice(bot: any) {
    const gridPrice = String(bot?.gridPrice || '').trim().toLowerCase();
    return /^ama(?:[1-4])?$/.test(gridPrice);
}

export { usesAmaGridPrice };
