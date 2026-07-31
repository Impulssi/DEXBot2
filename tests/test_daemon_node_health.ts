/**
 * tests/test_daemon_node_health.ts - Daemon node health ledger tests
 *
 * Verifies the credential daemon's node health ledger (blacklist after
 * threshold, health-cache exclusion, rate limiting, cooldown recovery) — the
 * invariants documented in COW_INVARIANTS.md INV-BROADCAST-001.
 */
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createNodeHealthLedger } = require('../modules/daemon_node_health');
const { writeHealthCache, readHealthCache } = require('../modules/node_health_cache');

const sleep = (ms: number) => new Promise((resolve: any) => setTimeout(resolve, ms));

function makeTmpCacheFile(): string {
    return path.join(os.tmpdir(), `dexbot2-test-node-health-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
}

function writeSeedCache(file: string, urls: string[]) {
    writeHealthCache(
        urls.map((url, i) => ({ url, status: 'healthy', latencyMs: 10 + i * 10, lastCheckTime: null })),
        { healthCacheFile: file }
    );
}

async function main() {
    console.log('Running daemon node health ledger tests...');

    // ── 1. counts to threshold, then blacklists + excludes from health cache ──
    {
        const cacheFile = makeTmpCacheFile();
        try {
            writeSeedCache(cacheFile, ['wss://node-a/ws', 'wss://node-b/ws']);
            const logs: string[] = [];
            const ledger = createNodeHealthLedger({
                healthCacheFile: cacheFile,
                threshold: 3,
                cooldownMs: 60000,
                reportCooldownMs: 0,
                logger: { warn: (m: string) => logs.push(m), log: () => {}, debug: () => {} },
            });
            assert.strictEqual(ledger.isBlacklisted('wss://node-a/ws'), false, 'initially not blacklisted');
            ledger.reportFailure('wss://node-a/ws', 'connect failed');
            ledger.reportFailure('wss://node-a/ws', 'connect failed');
            assert.strictEqual(ledger.isBlacklisted('wss://node-a/ws'), false, 'below threshold not blacklisted');
            ledger.reportFailure('wss://node-a/ws', 'connect failed');
            assert.strictEqual(ledger.isBlacklisted('wss://node-a/ws'), true, 'blacklisted at threshold');
            assert.ok(logs.some((l) => l.includes('FAILED attempt 1/3')), 'failure-count log expected');
            assert.ok(logs.some((l) => l.includes('BLACKLISTED after 3 failures')), 'blacklist log expected');

            const cache = readHealthCache({ healthCacheFile: cacheFile });
            assert.ok(cache, 'health cache still readable');
            assert.ok(!cache.nodes.some((n: any) => n.url === 'wss://node-a/ws'), 'blacklisted node removed from health cache');
            assert.ok(cache.nodes.some((n: any) => n.url === 'wss://node-b/ws'), 'healthy nodes preserved');
        } finally {
            try { fs.unlinkSync(cacheFile); } catch (_: any) {}
        }
    }

    // ── 2. rate limit: reports within reportCooldownMs are ignored ──────────
    {
        const ledger = createNodeHealthLedger({ threshold: 3, cooldownMs: 60000, reportCooldownMs: 60000, logger: {} });
        ledger.reportFailure('wss://node-x/ws', 'a');
        ledger.reportFailure('wss://node-x/ws', 'b');
        const state = ledger.getState();
        assert.strictEqual(state.get('wss://node-x/ws')?.failureCount, 1, 'rate-limited report must not count');
    }

    // ── 3. cooldown expiry re-enables the node and resets the count ─────────
    {
        const ledger = createNodeHealthLedger({ threshold: 2, cooldownMs: 50, reportCooldownMs: 0, logger: {} });
        ledger.reportFailure('wss://node-y/ws', 'a');
        ledger.reportFailure('wss://node-y/ws', 'b');
        assert.strictEqual(ledger.isBlacklisted('wss://node-y/ws'), true, 'blacklisted at threshold');
        await sleep(60);
        assert.strictEqual(ledger.isBlacklisted('wss://node-y/ws'), false, 'cooldown expiry re-enables');
        ledger.reportFailure('wss://node-y/ws', 'c');
        assert.strictEqual(ledger.getState().get('wss://node-y/ws')?.failureCount, 1, 'count resets after cooldown expiry');
    }

    // ── 4. reports for an already-blacklisted node are skipped ──────────────
    {
        const logs: string[] = [];
        const ledger = createNodeHealthLedger({
            threshold: 1,
            cooldownMs: 60000,
            reportCooldownMs: 0,
            logger: { warn: () => {}, log: () => {}, debug: (m: string) => logs.push(m) },
        });
        ledger.reportFailure('wss://node-z/ws', 'a');
        assert.strictEqual(ledger.isBlacklisted('wss://node-z/ws'), true, 'blacklisted after single report');
        ledger.reportFailure('wss://node-z/ws', 'b');
        assert.ok(logs.some((l) => l.includes('already blacklisted')), 'skip log expected');
        assert.strictEqual(ledger.getState().get('wss://node-z/ws')?.failureCount, 0, 'count stays reset while blacklisted');
    }

    // ── 5. missing health cache is handled gracefully ───────────────────────
    {
        const cacheFile = makeTmpCacheFile();
        try {
            const ledger = createNodeHealthLedger({ healthCacheFile: cacheFile, threshold: 1, cooldownMs: 60000, reportCooldownMs: 0, logger: {} });
            ledger.reportFailure('wss://node-q/ws', 'boom');
            assert.strictEqual(ledger.isBlacklisted('wss://node-q/ws'), true, 'ledger state independent of cache presence');
        } finally {
            try { fs.unlinkSync(cacheFile); } catch (_: any) {}
        }
    }

    // ── 6. clear() resets all ledger state ──────────────────────────────────
    {
        const ledger = createNodeHealthLedger({ threshold: 1, cooldownMs: 60000, reportCooldownMs: 0, logger: {} });
        ledger.reportFailure('wss://node-r/ws', 'a');
        assert.strictEqual(ledger.isBlacklisted('wss://node-r/ws'), true);
        ledger.clear();
        assert.strictEqual(ledger.isBlacklisted('wss://node-r/ws'), false, 'clear resets blacklists');
        assert.strictEqual(ledger.getState().size, 0);
    }

    console.log('All daemon node health ledger tests passed.');
    process.exit(0);
}

main().catch((err: any) => {
    console.error('Test failed:', err);
    process.exit(2);
});
