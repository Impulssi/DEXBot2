#!/usr/bin/env node
'use strict';

/**
 * BOT ACCOUNT-ID BACKFILL
 *
 * Resolves every bot's preferredAccount name to its chain account ID and
 * stamps `accountId` next to `preferredAccount` in profiles/bots.json, so
 * analysis tools and scripts can skip the chain lookup on later runs.
 * Nothing is ever written by hand — all IDs in the file come from this
 * script, the bot editor, or the analysis tools themselves.
 *
 * Usage:
 *   node dist/analysis/resolve_bot_accounts.js [--bot-key <key>] [--refresh]
 *       [--timeout-ms <n>] [--dry-run] [--json]
 *
 * Exit code 0 = all bot accounts resolved (or nothing to do),
 *           1 = one or more resolutions failed.
 *
 * Short-lived batch tool: suppresses chain INFO logging and disconnects the
 * shared client on exit. Run standalone only — never import/call from a
 * long-running process holding a live connection.
 */

import { loadBotSettings, computeBotKey, persistBotAccountId } from './bot_key_utils.js';
import { setGlobalConsoleLevel, getGlobalConsoleLevel } from '../modules/order/logger.js';
import { sleep } from '../modules/order/utils/system.js';
import { getErrorMessage } from '../modules/utils/errors.js';

const DEFAULT_TIMEOUT_MS = 20000;

function printHelp() {
    console.log(`\
Usage: node dist/analysis/resolve_bot_accounts.js [options]

Resolve bot preferredAccount names to chain IDs and store them as accountId
in profiles/bots.json (byte-preserving; comments and formatting survive).

Options:
  --bot-key <key>    Only process this bot key or bot name (default: all bots)
  --refresh          Re-resolve even when a stored accountId exists
  --timeout-ms <n>   Per-account chain lookup timeout (default: ${DEFAULT_TIMEOUT_MS})
  --dry-run          Report what would change without writing anything
  --json             Append a machine-readable summary
  --help, -h         Show this help
`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) { printHelp(); process.exit(0); }
    const opts: any = {
        botKey: null,
        refresh: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        dryRun: false,
        json: false,
    };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--bot-key': opts.botKey = args[++i]; break;
            case '--refresh': opts.refresh = true; break;
            case '--timeout-ms': opts.timeoutMs = parseInt(args[++i], 10); break;
            case '--dry-run': opts.dryRun = true; break;
            case '--json': opts.json = true; break;
            default:
                console.error(`Unknown option: ${args[i]}`);
                process.exit(1);
        }
    }
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
        console.error('Error: --timeout-ms must be a positive number.');
        process.exit(1);
    }
    return opts;
}

async function resolveWithTimeout(chainOrders: any, ref: string, timeoutMs: number): Promise<{ id: string | null; reason: string }> {
    const timeoutErr: any = new Error(`lookup timed out after ${timeoutMs}ms`);
    timeoutErr.code = 'ACCOUNT_LOOKUP_TIMEOUT';
    try {
        const id = await Promise.race([
            chainOrders.resolveAccountId(ref),
            sleep(timeoutMs).then(() => { throw timeoutErr; }),
        ]);
        if (id && /^1\.2\.\d+$/.test(String(id))) return { id: String(id), reason: 'resolved' };
        return { id: null, reason: 'not-found' };
    } catch (err: any) {
        return { id: null, reason: err && err.code === 'ACCOUNT_LOOKUP_TIMEOUT' ? 'timeout' : 'error' };
    }
}

async function main() {
    const opts = parseArgs();
    const settings = loadBotSettings();
    const entries = Array.isArray(settings?.bots) ? settings.bots : [];
    if (!entries.length) {
        console.log('No bots in profiles/bots.json — nothing to do.');
        process.exit(0);
    }

    let targets = entries.map((bot: any, index: number) => ({ bot, index, key: computeBotKey(bot, index) }));
    if (opts.botKey) {
        const want = String(opts.botKey).toLowerCase();
        targets = targets.filter((t: any) => t.key === want || String(t.bot?.name ?? '').toLowerCase() === want);
        if (!targets.length) {
            console.error(`Error: bot '${opts.botKey}' not found in profiles/bots.json.`);
            process.exit(1);
        }
    }

    // Suppress chain INFO spam for the whole batch; restored in finally.
    // (setSuppressConnectionLog is read lazily so this file never drags the
    // chain stack in when it cannot be loaded.)
    let chainClient: any = null;
    let prevSuppress = false;
    let prevGlobalLevel: string | null = null;
    let suppressionArmed = false;
    let chainOrders: any = null;
    try {
        chainClient = await import('../modules/bitshares_client.js');
        prevSuppress = chainClient.isSuppressConnectionLog();
        prevGlobalLevel = getGlobalConsoleLevel();
        suppressionArmed = true;
        chainClient.setSuppressConnectionLog(true);
        setGlobalConsoleLevel('warn');
        chainOrders = await import('../modules/chain_orders.js');
    } catch (err: any) {
        console.error(`Error: could not load the chain stack (${getErrorMessage(err)}).`);
        process.exit(1);
    }

    const results: any[] = [];
    try {
        for (const t of targets) {
            const name = t.bot?.name ?? t.key;
            const prefRaw = t.bot?.preferredAccount != null ? String(t.bot.preferredAccount) : '';
            const stored = /^1\.2\.\d+$/.test(String(t.bot?.accountId ?? '')) ? String(t.bot.accountId) : null;
            if (!prefRaw) {
                results.push({ key: t.key, name, status: 'skipped', detail: 'no preferredAccount' });
                console.log(`- ${t.key}: skipped (no preferredAccount)`);
                continue;
            }
            if (/^1\.2\.\d+$/.test(prefRaw)) {
                if (stored !== prefRaw) {
                    const wrote = opts.dryRun ? true : persistBotAccountId(t.key, prefRaw);
                    const status = !wrote ? 'failed' : (opts.dryRun ? 'would-update' : 'updated');
                    results.push({ key: t.key, name, status, detail: wrote ? `preferredAccount is authoritative (${prefRaw})` : 'could not write profiles/bots.json' });
                    console.log(`- ${t.key}: ${!wrote ? 'FAILED to write' : (opts.dryRun ? 'would update' : 'updated')} stored accountId → ${prefRaw} (preferredAccount is authoritative)`);
                } else {
                    results.push({ key: t.key, name, status: 'cached', detail: prefRaw });
                    console.log(`- ${t.key}: cached (${prefRaw})`);
                }
                continue;
            }
            if (stored && !opts.refresh) {
                results.push({ key: t.key, name, status: 'cached', detail: stored });
                console.log(`- ${t.key}: cached (${stored})`);
                continue;
            }
            const r = await resolveWithTimeout(chainOrders, prefRaw, opts.timeoutMs);
            if (r.id) {
                const changed = stored !== r.id;
                const wrote = !changed || opts.dryRun ? true : persistBotAccountId(t.key, r.id);
                const status = !wrote ? 'failed' : (opts.dryRun ? (changed ? 'would-update' : 'unchanged') : (changed ? (stored ? 'updated' : 'stored') : 'unchanged'));
                results.push({ key: t.key, name, status, detail: wrote ? r.id : 'could not write profiles/bots.json' });
                console.log(`- ${t.key}: '${prefRaw}' → ${r.id}${!wrote ? ' (FAILED to store)' : (changed ? (opts.dryRun ? ' (would store)' : (stored ? ' (updated)' : ' (stored)')) : ' (unchanged)')}`);
            } else {
                const why = r.reason === 'timeout' ? `nodes unreachable (timed out after ${opts.timeoutMs}ms)` : 'not found on the blockchain';
                results.push({ key: t.key, name, status: 'failed', detail: why });
                console.log(`- ${t.key}: FAILED to resolve '${prefRaw}' (${why})`);
            }
        }
    } finally {
        if (chainClient) {
            try { await chainClient.disconnectClient(); } catch (_) { /* best-effort cleanup */ }
            if (suppressionArmed) {
                try { chainClient.setSuppressConnectionLog(prevSuppress); } catch (_) { /* restore-only */ }
            }
        }
        if (suppressionArmed) {
            try { setGlobalConsoleLevel(prevGlobalLevel); } catch (_) { /* restore-only */ }
        }
    }

    const failed = results.filter((r: any) => r.status === 'failed');
    const skipped = results.filter((r: any) => r.status === 'skipped').length;
    const ok = results.length - failed.length - skipped;
    console.log(`\nDone: ${ok} resolved, ${skipped} skipped, ${failed.length} failed${opts.dryRun ? ' (dry run, nothing written)' : ''}.`);
    if (opts.json) {
        console.log(JSON.stringify({ dryRun: opts.dryRun, results }, null, 2));
    }
    process.exit(failed.length ? 1 : 0);
}

main().catch((err: any) => {
    console.error('Fatal:', getErrorMessage(err));
    process.exit(1);
});
