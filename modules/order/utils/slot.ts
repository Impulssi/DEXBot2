/**
 * modules/order/utils/slot.ts - Single source of truth for slot-N parsing
 * Browser-safe, no Node deps.
 * Extracted per GRID_PRICE_SLOT_DETERMINISM_PLAN §2.1 to unify duplicate
 * parsers in math.ts:1611 and order.ts:915 and make fail-closed explicit.
 */

export function parseSlotIndex(id: any): number | null {
    if (typeof id !== 'string') return null;
    const match = /^slot-(\d+)$/.exec(id);
    if (!match) return null;
    const idx = parseInt(match[1], 10);
    return Number.isFinite(idx) ? idx : null;
}
