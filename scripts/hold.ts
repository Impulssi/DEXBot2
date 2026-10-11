#!/usr/bin/env node
'use strict';
/**
 * Usage:
 *   dexbot hold <bot> <slot> [slot...]
 *
 * Records manual-cancel holds for a bot's slots so they stay empty instead
 * of refilling — deterministically, without waiting for a sync cycle to
 * notice a vanished order (a strategy refill can win that race and the
 * disappearance-detected hold then never forms):
 * - running bot picks the marker up on its next 1min poll tick (no restart);
 *   the slot price anchors to its current grid price
 * - stopped bot has the holds appended to its snapshot field directly
 *   (slot price read from the persisted grid), so the next boot holds
 *
 * Holds release on significant market moves past the slot
 * (MANUAL_HOLD_MOVE_MULT * incrementPercent) or via `dexbot clear-holds`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBotSettings, computeBotKey } from '../analysis/bot_key_utils.js';
import { isSameBotName } from '../modules/utils/sanitize_key.js';
import { PATHS } from '../modules/paths.js';
import { getErrorMessage } from '../modules/utils/errors.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON, writeJSON } = getStorage();

function printUsage(): void {
    console.log('Usage: dexbot hold <bot> <slot> [slot...]');
    console.log('');
    console.log('  <bot>     Bot name or key from profiles/bots.json');
    console.log('  <slot>    One or more slot ids (e.g. slot-9) to hold empty');
    console.log('');
    console.log('Records manual-cancel holds: held slots are not refilled.');
}

function findBotByTarget(target: string): { botKey: string } | null {
    const settings = loadBotSettings();
    const entries = Array.isArray((settings as any)?.bots) ? (settings as any).bots : [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (isSameBotName(entry?.name, target)) return { botKey: computeBotKey(entry, i) };
    }
    const keys = entries.map((b: any, i: number) => computeBotKey(b, i)).filter(Boolean);
    const hit = keys.indexOf(target);
    if (hit >= 0) return { botKey: keys[hit] };
    return null;
}

async function run(): Promise<void> {
    const argv = process.argv.slice(2);
    const positionals = argv.filter((a) => !a.startsWith('-'));
    const target = positionals[0] || null;
    const slots = positionals.slice(1).map((s) => String(s).trim()).filter((s) => s.length > 0);
    if (!target || slots.length === 0 || argv.includes('-h') || argv.includes('--help')) {
        printUsage();
        process.exit(1);
        return;
    }

    const hit = findBotByTarget(target);
    if (!hit) {
        const settings = loadBotSettings();
        const entries = Array.isArray((settings as any)?.bots) ? (settings as any).bots : [];
        const keys = entries.map((b: any, i: number) => computeBotKey(b, i)).filter(Boolean);
        console.error(`[hold] Unknown bot "${target}". Known keys: ${keys.join(', ') || '(none)'}`);
        process.exit(1);
    }

    // 1) Running instance: marker consumed on the next 1min poll tick.
    const marker = path.join(PATHS.PROFILES_DIR, `manual-holds.set.${hit.botKey}`);
    try {
        fs.writeFileSync(marker, slots.map((s) => `slot:${s}`).join('\n') + '\n', 'utf8');
        console.log(`[hold] Marker written for '${hit.botKey}' (slots ${slots.join(', ')}) — running bot holds on next poll`);
    } catch (err: any) {
        console.error(`[hold] Cannot write marker: ${getErrorMessage(err)}`);
        process.exit(1);
    }

    // 2) Stopped instance / next boot: append to the snapshot field directly,
    // anchoring each price to the persisted grid's slot price.
    try {
        const ordersDir = (PATHS as any).ORDERS_DIR || path.join(path.dirname(PATHS.PROFILES.BOTS_JSON), 'orders');
        const filePath = path.join(ordersDir, `${hit.botKey}.json`);
        if (!fs.existsSync(filePath)) {
            console.log(`[hold] No snapshot file (running bot picks up the marker instead)`);
            return;
        }
        const data = readJSON(filePath);
        const grid = Array.isArray((data as any)?.grid) ? (data as any).grid : [];
        const priceBySlot = new Map<string, number>();
        for (const o of grid) {
            const id = o?.id != null ? String(o.id) : '';
            const price = Number(o?.price);
            if (id && Number.isFinite(price) && price > 0) priceBySlot.set(id, price);
        }
        const existing = Array.isArray((data as any).manualHolds) ? (data as any).manualHolds : [];
        const have = new Set(existing.map((e: any) => String(e?.slotId)));
        let added = 0;
        const unknown: string[] = [];
        const now = Date.now();
        for (const slotId of slots) {
            if (have.has(slotId)) continue;
            const price = priceBySlot.get(slotId);
            if (price === undefined) {
                unknown.push(slotId);
                continue;
            }
            existing.push({ slotId, price, ts: now, base: null, orderId: null });
            added++;
        }
        if (added > 0) {
            (data as any).manualHolds = existing.slice(-500);
            writeJSON(filePath, data);
        }
        console.log(added > 0
            ? `[hold] Recorded ${added} hold(s) in snapshot`
            : `[hold] No new holds recorded in snapshot`);
        if (unknown.length > 0) {
            console.log(`[hold] Unknown slots (not in persisted grid, skipped): ${unknown.join(', ')}`);
        }
    } catch (err: any) {
        console.error(`[hold] Snapshot update failed: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
    run().catch((err: unknown) => {
        console.error(`[hold] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    });
}

export { printUsage, findBotByTarget, run };
