/**
 * modules/order/manual_hold.ts - Manual-cancel hold (user-cancelled slots stay empty)
 *
 * When the operator cancels a live order by hand (exchange UI), the next
 * chain sync must NOT treat the disappearance as a fill (no boundary crawl,
 * no fund/weight churn) and the strategy must NOT refill the slot on the
 * next cycle. Holds are recorded per slot id with the price at cancel time
 * and expire when the market price moves significantly past the slot —
 * a hold must never pin a slot forever if the operator forgets it.
 *
 * Detection lives in sync_engine (a disappearance with no fill record and
 * no recent own-cancel). Suppression lives in the placement pickers
 * (strategy windows, startup activation, reserve edges). Holds persist
 * across crashes (snapshot) so an auto-restart never refills what the
 * operator removed; a graceful shutdown clears them (operator stop =
 * explicit restore), as does `dexbot clear-holds <bot>` via marker file.
 *
 * Move threshold: MANUAL_HOLD_MOVE_MULT * incrementPercent (default 5x).
 * At 1.5% increment a hold releases after a ~7.5% market move past it.
 */

import fs from 'node:fs';
import { loadAmaCenterPrice, loadAmaCenterSnapshot } from './utils/system.js';
import { getErrorMessage } from '../utils/errors.js';
import { wasRecentlyOwnCancelled } from '../chain_orders.js';
import { path } from '../path_api.js';

// How many grid increments of market movement release a hold, measured
// from the held price. Relative to incrementPercent so the rule scales
// with grid density instead of hardcoding a percent.
const MANUAL_HOLD_MOVE_MULT = 5;

function getManualHoldMap(manager: any): Map<string, { price: number; ts: number }> {
    if (!manager) return new Map();
    if (!(manager.manualHolds instanceof Map)) {
        manager.manualHolds = new Map();
    }
    return manager.manualHolds;
}

function resolveManualHoldMovePct(config: any): number {
    const incr = Number(config?.incrementPercent);
    if (Number.isFinite(incr) && incr > 0) {
        return (incr / 100) * MANUAL_HOLD_MOVE_MULT;
    }
    return 0.075;
}

function resolveHoldMarketPrice(manager: any): number | null {
    try {
        const botKey = manager?.config?.botKey;
        const snapshot = botKey ? loadAmaCenterSnapshot(botKey) : null;
        const center = snapshot?.gridCenterPrice ?? (botKey ? loadAmaCenterPrice(botKey) : null);
        const p = Number(center);
        if (Number.isFinite(p) && p > 0) return p;
    } catch (err: any) {
        manager?.logger?.log?.(`[HOLD] Market price unavailable for hold expiry: ${getErrorMessage(err)}`, 'debug');
    }
    return null;
}

function isManualHoldExpired(hold: { price: number; ts: number } | null | undefined, marketPrice: number | null, movePct: number): boolean {
    if (!hold || !Number.isFinite(Number(hold.price)) || Number(hold.price) <= 0) return true;
    if (marketPrice == null || !Number.isFinite(marketPrice) || marketPrice <= 0) return false;
    if (!Number.isFinite(movePct) || movePct <= 0) return false;
    return Math.abs(marketPrice - hold.price) / hold.price > movePct;
}

function recordManualHold(manager: any, slotId: string, price: number): boolean {
    if (!manager || slotId == null || String(slotId).length === 0) return false;
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return false;
    const holds = getManualHoldMap(manager);
    holds.set(String(slotId), { price: p, ts: Date.now() });
    manager?.logger?.log?.(
        `[HOLD] Manual cancel suspected on ${slotId} @${p} — refill suppressed until the market moves significantly past it`,
        'info'
    );
    return true;
}

function clearManualHold(manager: any, slotId: string | null | undefined): boolean {
    if (!manager || slotId == null) return false;
    const holds = getManualHoldMap(manager);
    return holds.delete(String(slotId));
}

function pruneManualHolds(manager: any, marketPrice?: number | null, movePct?: number | null): string[] {
    const holds = getManualHoldMap(manager);
    if (holds.size === 0) return [];
    const mp = marketPrice !== undefined && marketPrice !== null
        ? Number(marketPrice)
        : resolveHoldMarketPrice(manager);
    const pct = movePct !== undefined && movePct !== null
        ? Number(movePct)
        : resolveManualHoldMovePct(manager?.config);
    const dropped: string[] = [];
    for (const [slotId, hold] of holds) {
        if (isManualHoldExpired(hold, Number.isFinite(mp) ? mp : null, pct)) {
            holds.delete(slotId);
            dropped.push(slotId);
        }
    }
    if (dropped.length > 0) {
        manager?.logger?.log?.(
            `[HOLD] Released ${dropped.length} manual hold(s) after significant market move: ${dropped.join(', ')}`,
            'info'
        );
    }
    return dropped;
}

function isSlotHeld(manager: any, slotId: string | null | undefined): boolean {
    if (!manager || slotId == null) return false;
    return getManualHoldMap(manager).has(String(slotId));
}

function clearMarkerPath(profilesDir: string, botKey: string): string | null {
    try {
        if (!profilesDir || !botKey) return null;
        return path.join(profilesDir, `manual-holds.clear.${botKey}`);
    } catch {
        return null;
    }
}

/**
 * Consume an operator "restore" marker (`dexbot clear-holds <bot>`).
 * Clears in-memory holds so held slots refill normally; the marker is
 * deleted whether or not holds existed (one-shot signal). Distinct from
 * recalculate.*.trigger files, which the resync watcher owns.
 *
 * @param {Object} manager - OrderManager
 * @param {string} profilesDir - Profiles directory holding marker files
 * @param {string} botKey - Bot key used in the marker filename
 * @returns {number} Holds cleared (-1 when no marker present)
 */
function consumeClearMarker(manager: any, profilesDir: string, botKey: string): number {
    try {
        const marker = clearMarkerPath(profilesDir, botKey);
        if (!marker || !fs.existsSync(marker)) return -1;
        const holds = getManualHoldMap(manager);
        const n = holds.size;
        holds.clear();
        try { fs.unlinkSync(marker); } catch { /* consumed anyway */ }
        if (n > 0) {
            manager?.logger?.log?.(
                `[HOLD] Cleared ${n} manual-cancel hold(s) via operator marker (grid refills normally)`,
                'info'
            );
        }
        return n;
    } catch {
        return -1;
    }
}

/**
 * Classify why a live order disappeared from chain between syncs.
 *
 * - 'fill': a fill record exists for the order id (real-time event already
 *   processed, or an earlier sync booked it) — existing behavior.
 * - 'own': the bot cancelled it itself moments ago (rotation/replace in
 *   flight) — existing behavior; the counterpart create carries the intent.
 * - 'manual': neither — almost certainly an operator cancel by hand (or an
 *   expiry, which wants the same treatment). Hold the slot instead of
 *   booking a fill.
 *
 * Fail-open: when in doubt (fills being processed right now, lookup
 * errors) returns 'fill' so behavior matches the pre-hold code exactly.
 * A racing fill that lands just after is still safe: the slot was
 * virtualized without orderId, so the late event cannot match it, and the
 * recorded hold releases on the next significant price move anyway.
 *
 * @param {Object} manager - OrderManager
 * @param {Object} slot - Grid slot whose orderId vanished from chain
 * @returns {'fill'|'own'|'manual'}
 */
function classifyDisappearance(manager: any, slot: any): 'fill' | 'own' | 'manual' {
    try {
        const orderId = slot?.orderId != null ? String(slot.orderId) : '';
        if (!orderId) return 'fill';
        // Fills being processed right now: decide nothing, keep old behavior.
        if (Number(manager?._fillBatchInFlight) > 0) return 'fill';
        // Already fill-booked (real-time event or earlier pass)?
        const tracker = (manager as any)?.processedFillTracker;
        if (tracker instanceof Map && tracker.size > 0) {
            const prefix = orderId + ':';
            for (const key of tracker.keys()) {
                if (typeof key === 'string' && key.startsWith(prefix)) return 'fill';
            }
        }
        // The bot's own recent cancel (rotation/replace counterpart in flight)?
        try {
            if (wasRecentlyOwnCancelled(orderId)) return 'own';
        } catch { /* fall through to manual below */ }
        return 'manual';
    } catch {
        return 'fill';
    }
}

function serializeManualHolds(manager: any): Array<{ slotId: string; price: number; ts: number }> {
    const holds = getManualHoldMap(manager);
    const out: Array<{ slotId: string; price: number; ts: number }> = [];
    for (const [slotId, hold] of holds) {
        const price = Number(hold?.price);
        const ts = Number(hold?.ts);
        if (!slotId || !Number.isFinite(price) || price <= 0) continue;
        out.push({ slotId: String(slotId), price, ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now() });
    }
    return out.slice(-500);
}

function restoreManualHolds(manager: any, persisted: any): number {
    if (!manager) return 0;
    const holds = getManualHoldMap(manager);
    let restored = 0;
    const list = Array.isArray(persisted) ? persisted : [];
    for (const e of list) {
        const slotId = e?.slotId != null ? String(e.slotId) : '';
        const price = Number(e?.price);
        const ts = Number(e?.ts);
        if (!slotId || !Number.isFinite(price) || price <= 0) continue;
        // Only restore for slots that still exist: a grid reset/regen with a
        // renamed scheme must never resurrect holds for dead ids.
        try {
            if (manager.orders instanceof Map && !manager.orders.has(slotId)) continue;
        } catch { /* fall through without the existence check */ }
        holds.set(slotId, { price, ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now() });
        restored++;
    }
    return restored;
}

export {
    MANUAL_HOLD_MOVE_MULT,
    getManualHoldMap,
    resolveManualHoldMovePct,
    resolveHoldMarketPrice,
    isManualHoldExpired,
    recordManualHold,
    clearManualHold,
    pruneManualHolds,
    isSlotHeld,
    classifyDisappearance,
    serializeManualHolds,
    restoreManualHolds,
    clearMarkerPath,
    consumeClearMarker,
};
