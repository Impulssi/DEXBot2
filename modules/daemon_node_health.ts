/**
 * modules/daemon_node_health.ts - Credential daemon node health ledger
 *
 * Daemon-local failure ledger used by the credential daemon's broadcast
 * path (broadcastWithDeadline). Failures count toward the bot-side
 * NODE_MANAGEMENT.BLACKLIST_THRESHOLD and, at the threshold, the node is
 * blacklisted for NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS and removed from the
 * shared health cache so every process stops preferring it.
 *
 * Recovery is two-fold, NOT health-bound:
 *   - the in-memory ledger entry expires after BLACKLIST_COOLDOWN_MS, so the
 *     daemon itself re-admits the node (cooldown-bound) — the node is then
 *     re-preferable immediately, without waiting for a health check;
 *   - the shared health-cache exclusion is reverted when a later bot-side
 *     health check re-adds the node (health-bound). The exclusion rewrite is
 *     a best-effort unlocked read-modify-write of the shared cache: a
 *     concurrent health-check writer may overwrite it with a fresh snapshot
 *     that re-includes the node, which is the intended recovery path (the
 *     write is atomic, so a torn file cannot result — only a lost exclusion).
 *
 * Counting unit differs from the bot-side NodeManager on purpose: one ledger
 * report per exhausted node rotation (all pinned attempts), not per probe.
 * The threshold and cooldown constants are the same NODE_MANAGEMENT values;
 * the granularity is coarser because the daemon only observes failures at
 * rotation boundaries.
 *
 * The ledger is in-memory (resets on daemon restart); the health-cache
 * exclusion persists until a health check re-adds the node.
 */
'use strict';

import { NODE_MANAGEMENT } from './constants';
import { readHealthCache, writeHealthCache } from './node_health_cache';
import { getErrorMessage } from './utils/errors';

export interface NodeHealthLedgerEntry {
    failureCount: number;
    blacklistedUntil: number;
    lastReportedAt: number;
}

export interface NodeHealthLedgerOptions {
    /** Override the shared health-cache file (tests). Defaults to the shared cache. */
    healthCacheFile?: string;
    /** Override the failure threshold (tests). Defaults to NODE_MANAGEMENT.BLACKLIST_THRESHOLD. */
    threshold?: number;
    /** Override the blacklist cooldown (tests). Defaults to NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS. */
    cooldownMs?: number;
    /** Override the report rate-limit (tests). Defaults to NODE_MANAGEMENT.FAILURE_REPORT_COOLDOWN_MS. */
    reportCooldownMs?: number;
    logger?: { warn?: Function; log?: Function; debug?: Function };
}

export interface NodeHealthLedger {
    /** Whether the node is currently blacklisted (cooldown active). */
    isBlacklisted(nodeUrl: string): boolean;
    /** Report a failed node rotation; counts toward the blacklist threshold. */
    reportFailure(nodeUrl: string, errorMessage: string): void;
    /** Snapshot of the ledger (tests/inspection). */
    getState(): ReadonlyMap<string, NodeHealthLedgerEntry>;
    /** Reset all ledger state (tests). */
    clear(): void;
}

export function createNodeHealthLedger(options: NodeHealthLedgerOptions = {}): NodeHealthLedger {
    const ledger = new Map<string, NodeHealthLedgerEntry>();
    const logger = options.logger || { warn() {}, log() {}, debug() {} };
    const threshold = Number.isFinite(Number(options.threshold))
        ? Number(options.threshold)
        : Number.isFinite(Number(NODE_MANAGEMENT?.BLACKLIST_THRESHOLD))
            ? Number(NODE_MANAGEMENT.BLACKLIST_THRESHOLD)
            : 3;
    const cooldownMs = Number.isFinite(Number(options.cooldownMs))
        ? Number(options.cooldownMs)
        : Number.isFinite(Number(NODE_MANAGEMENT?.BLACKLIST_COOLDOWN_MS))
            ? Number(NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS)
            : 24 * 60 * 60 * 1000;
    const reportCooldownMs = Number.isFinite(Number(options.reportCooldownMs))
        ? Number(options.reportCooldownMs)
        : Number.isFinite(Number(NODE_MANAGEMENT?.FAILURE_REPORT_COOLDOWN_MS))
            ? Number(NODE_MANAGEMENT.FAILURE_REPORT_COOLDOWN_MS)
            : 1000;

    function isBlacklisted(nodeUrl: string): boolean {
        const entry = ledger.get(nodeUrl);
        return !!entry && entry.blacklistedUntil > Date.now();
    }

    /**
     * Remove a blacklisted node from the shared health cache so
     * orderNodesForSettings (daemon and bot processes) stops preferring it.
     * Best-effort unlocked read-modify-write: the write itself is atomic
     * (no torn file), but a concurrent health-check writer may overwrite the
     * exclusion with a fresh snapshot that re-includes the node — which is
     * the intended health-bound recovery path.
     */
    function excludeFromHealthCache(nodeUrl: string) {
        try {
            const cacheOptions = options.healthCacheFile ? { healthCacheFile: options.healthCacheFile } : {};
            const cache = readHealthCache(cacheOptions);
            if (!cache || !Array.isArray(cache.nodes)) return;
            const remaining = cache.nodes
                .filter((n) => !n || n.url !== nodeUrl)
                .map((n) => ({
                    url: n.url,
                    status: n.status,
                    latencyMs: n.latencyMs ?? undefined,
                    lastCheckTime: n.lastCheckTime,
                }));
            writeHealthCache(remaining, { ...cacheOptions, now: Date.now() });
            logger.log?.(`[credential-daemon] Excluded ${nodeUrl.substring(0, 40)}... from shared health cache (blacklisted)`);
        } catch (err: any) {
            logger.warn?.(`[credential-daemon] Failed to update health cache after blacklisting ${nodeUrl}: ${getErrorMessage(err)}`);
        }
    }

    /**
     * Report a failed node rotation. Counts toward the threshold
     * (rate-limited by reportCooldownMs); when the threshold is reached the
     * node is blacklisted for cooldownMs, logged, and removed from the shared
     * health cache so all processes stop preferring it.
     */
    function reportFailure(nodeUrl: string, errorMessage: string) {
        const now = Date.now();
        const prev = ledger.get(nodeUrl);
        if (prev && prev.blacklistedUntil > now) {
            logger.debug?.(`Node ${nodeUrl} already blacklisted until ${new Date(prev.blacklistedUntil).toISOString()}; skipping failure report`);
            return;
        }
        if (prev && now - prev.lastReportedAt < reportCooldownMs) {
            return;
        }

        // A blacklist whose cooldown expired resets the count (recovery retry).
        const base = prev && prev.blacklistedUntil > 0 && prev.blacklistedUntil <= now ? 0 : (prev?.failureCount ?? 0);
        const failureCount = base + 1;

        if (failureCount >= threshold) {
            ledger.set(nodeUrl, { failureCount: 0, blacklistedUntil: now + cooldownMs, lastReportedAt: now });
            logger.warn?.(`✗ ${nodeUrl.substring(0, 40)}... BLACKLISTED after ${failureCount} failures (${errorMessage})`);
            excludeFromHealthCache(nodeUrl);
        } else {
            ledger.set(nodeUrl, { failureCount, blacklistedUntil: 0, lastReportedAt: now });
            logger.warn?.(`⚠ ${nodeUrl.substring(0, 40)}... FAILED attempt ${failureCount}/${threshold} (${errorMessage})`);
        }
    }

    return {
        isBlacklisted,
        reportFailure,
        getState: () => new Map(ledger),
        clear: () => ledger.clear(),
    };
}

export default createNodeHealthLedger;
