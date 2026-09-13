#!/usr/bin/env node
'use strict';
/**
 * Usage:
 *   dexbot clear-holds <bot>
 *
 * Clears manual-cancel holds for a bot so held slots refill normally:
 * - running bot picks the marker up on its next 1min poll tick (no restart)
 * - stopped bot has its snapshot field cleared, so the next boot is clean
 *
 * Manual holds suppress refills for operator-cancelled slots until the
 * market moves significantly past them. Clearing restores normal refill
 * behavior immediately (a restart does the same via graceful-shutdown
 * clearing; a crash preserves holds instead).
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
    console.log('Usage: dexbot clear-holds <bot>');
    console.log('');
    console.log('  <bot>  Bot name or key from profiles/bots.json');
    console.log('');
    console.log('Clears manual-cancel holds: held slots refill normally again.');
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
    const target = argv.find((a) => !a.startsWith('-')) || null;
    if (!target || argv.includes('-h') || argv.includes('--help')) {
        printUsage();
        if (!target) process.exit(1);
        return;
    }

    const hit = findBotByTarget(target);
    if (!hit) {
        const settings = loadBotSettings();
        const entries = Array.isArray((settings as any)?.bots) ? (settings as any).bots : [];
        const keys = entries.map((b: any, i: number) => computeBotKey(b, i)).filter(Boolean);
        console.error(`[clear-holds] Unknown bot "${target}". Known keys: ${keys.join(', ') || '(none)'}`);
        process.exit(1);
    }

    // 1) Running instance: marker consumed on the next 1min poll tick.
    const marker = path.join(PATHS.PROFILES_DIR, `manual-holds.clear.${hit.botKey}`);
    try {
        fs.writeFileSync(marker, `clear-holds ${new Date().toISOString()}\n`, 'utf8');
        console.log(`[clear-holds] Marker written for '${hit.botKey}' (running bot clears holds on next poll)`);
    } catch (err: any) {
        console.error(`[clear-holds] Cannot write marker: ${getErrorMessage(err)}`);
        process.exit(1);
    }

    // 2) Stopped instance / next boot: clear the snapshot field directly.
    try {
        const ordersDir = (PATHS as any).ORDERS_DIR || path.join(path.dirname(PATHS.PROFILES.BOTS_JSON), 'orders');
        const filePath = path.join(ordersDir, `${hit.botKey}.json`);
        if (fs.existsSync(filePath)) {
            const data = readJSON(filePath);
            if (data && Array.isArray((data as any).manualHolds) && (data as any).manualHolds.length > 0) {
                const n = (data as any).manualHolds.length;
                delete (data as any).manualHolds;
                writeJSON(filePath, data);
                console.log(`[clear-holds] Cleared ${n} persisted hold(s) from snapshot`);
            } else {
                console.log(`[clear-holds] No persisted holds in snapshot`);
            }
        } else {
            console.log(`[clear-holds] No snapshot file (nothing persisted)`);
        }
    } catch (err: any) {
        console.error(`[clear-holds] Snapshot clear failed: ${getErrorMessage(err)}`);
        process.exit(1);
    }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
    run().catch((err: unknown) => {
        console.error(`[clear-holds] Error: ${getErrorMessage(err)}`);
        process.exit(1);
    });
}

export { printUsage, findBotByTarget, run };
