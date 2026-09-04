'use strict';

/**
 * modules/launcher/adapter_requirement.ts - Canonical market-adapter requirement.
 *
 * Single source of truth for the question "does the current bots.json require
 * a running market adapter, and has that answer changed since last check?".
 *
 * Previously two independent implementations answered it with different
 * fingerprints in different processes:
 *   - modules/dexbot_maintenance_runtime.ts loadBotsConfigSnapshot (sha1 of
 *     the raw file, per DEXBot instance, every 5min + every blockchain tick)
 *   - modules/launcher/monolithic_runtime.ts getActiveAmaBotFingerprint
 *     (semantic name:gridPrice join, unlock wrapper, every 30s)
 * so a comment/whitespace edit looked like a "change" to one but not the
 * other, and both sides could spawn the adapter as their own child.
 * Both sides now tick on the single shared TIMING.BOTS_CONFIG_POLL_INTERVAL_MS
 * (1min).
 *
 * Ownership rule (see DEXBOT_ADAPTER_OWNER):
 *   - Monolithic mode (unlock wrapper alive): the wrapper watchdog is the
 *     SOLE adapter spawner (shared-interval liveness + restart budget +
 *     stale-lock handling). The wrapper exports DEXBOT_ADAPTER_OWNER=wrapper into the
 *     bot child env; bots then skip their own sync/poll and act as pure
 *     adapter-output consumers.
 *   - Wrapper-less modes (dexbot test one-shot, isolated supervisor, PM2):
 *     the variable is unset and the first/only bot keeps the in-bot fallback
 *     via getSharedMarketAdapterRuntime / pm2.
 *
 * The fingerprint is semantic on purpose: only AMA-relevant changes
 * (AMA bot added/removed, activated/deactivated, gridPrice ama<->non-ama)
 * reset it. Non-AMA edits (funds, spread, comments, non-AMA add/remove) do not.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { getStorage } from '../storage/index.js';
import { PATHS } from '../paths.js';
import { usesAmaGridPrice } from '../grid_price_source.js';

const storage = getStorage();

// Lazy require: keeps the ../order/utils/system test seam working (tests
// stub parseJsonWithComments via the module cache).
function parseJsonWithComments(...args: any): any {
    return (require('../order/utils/system') as any).parseJsonWithComments(...args);
}

/** Env var the unlock wrapper sets on bot children it supervises. */
const ADAPTER_OWNER_ENV = 'DEXBOT_ADAPTER_OWNER';
/** Value marking the wrapper as sole market-adapter owner. */
const WRAPPER_ADAPTER_OWNER = 'wrapper';

/**
 * Check whether the unlock wrapper owns the market adapter lifecycle.
 * Bots skip their own adapter sync/poll when this is true.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment to inspect
 * @returns {boolean} True when running as a wrapper-supervised bot child
 */
function isWrapperAdapterOwner(env: any = process.env): boolean {
    try {
        return !!env && env[ADAPTER_OWNER_ENV] === WRAPPER_ADAPTER_OWNER;
    } catch {
        return false;
    }
}

function normalizeGridPrice(value: any): string {
    return String(value ?? '').trim().toLowerCase();
}

/**
 * Build the semantic adapter fingerprint for an active-bot list.
 * Only AMA-priced bots contribute; sorted so bot order is irrelevant.
 * @param {any[]} activeBots - Bots with active !== false
 * @returns {string} Fingerprint ('' when no AMA bot is active)
 */
function buildAdapterFingerprint(activeBots: any[]): string {
    const bots = Array.isArray(activeBots) ? activeBots : [];
    return bots
        .filter((b: any) => b && b.active !== false && usesAmaGridPrice(b))
        .map((b: any) => `${String(b.name ?? '').trim()}:${normalizeGridPrice((b as any).gridPrice)}`)
        .sort()
        .join('|');
}

/**
 * Summarize parsed bots.json content for adapter decisions.
 * @param {any} parsed - Parsed bots.json object
 * @returns {{activeBots: any[], needsMarketAdapter: boolean, fingerprint: string}}
 */
function summarizeBotsConfig(parsed: any): { activeBots: any[]; needsMarketAdapter: boolean; fingerprint: string } {
    const bots = Array.isArray((parsed as any)?.bots)
        ? (parsed as any).bots.filter(Boolean)
        : [];
    const activeBots = bots.filter((bot: any) => bot && bot.active !== false);
    return {
        activeBots,
        needsMarketAdapter: activeBots.some((bot: any) => usesAmaGridPrice(bot)),
        fingerprint: buildAdapterFingerprint(activeBots),
    };
}

/**
 * Read bots.json and summarize the market-adapter requirement.
 * Never throws: missing/empty files report exists:false, unparseable files
 * add corrupt:true, and stat/read failures add readError:true. Callers must
 * skip (not stop) the adapter on corrupt/readError: a transient partial
 * write or I/O error must leave a running adapter alone.
 * @param {string} [botsFile=PATHS.PROFILES.BOTS_JSON] - Path to bots.json
 * @returns {{exists: boolean, fingerprint: string, config: any, activeBots: any[], needsMarketAdapter: boolean, corrupt?: boolean, readError?: boolean}}
 */
function readAdapterRequirement(botsFile?: string): {
    exists: boolean;
    fingerprint: string;
    config: any;
    activeBots: any[];
    needsMarketAdapter: boolean;
    corrupt?: boolean;
    readError?: boolean;
} {
    const file = botsFile || PATHS.PROFILES.BOTS_JSON;
    const empty = {
        exists: false,
        fingerprint: '',
        config: null,
        activeBots: [],
        needsMarketAdapter: false,
    };
    let raw: string | null = null;
    try {
        if (!storage.exists(file)) return { ...empty };
        raw = storage.readFile(file);
    } catch {
        return { ...empty, readError: true };
    }
    if (!raw || !raw.trim()) return { ...empty };
    let parsed: any;
    try {
        parsed = parseJsonWithComments(raw);
    } catch {
        return { ...empty, corrupt: true };
    }
    const summary = summarizeBotsConfig(parsed);
    return {
        exists: true,
        fingerprint: summary.fingerprint,
        config: parsed,
        activeBots: summary.activeBots,
        needsMarketAdapter: summary.needsMarketAdapter,
    };
}

export {
    ADAPTER_OWNER_ENV,
    WRAPPER_ADAPTER_OWNER,
    isWrapperAdapterOwner,
    buildAdapterFingerprint,
    readAdapterRequirement,
};
