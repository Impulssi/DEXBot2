'use strict';

// Offline unit tests for the per-account fills month-shard cache
// (analysis/fills_cache.ts). The Kibana range fetcher is injected, so nothing
// here touches a node.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running fills cache tests');

const {
    fetchFillsCached,
    shardKeyForTimestamp,
    shardBoundsForKey,
    shardKeysForRange,
    basePathFor,
    shardPathFor,
    trustedSegments,
    subtractRanges,
    mergeFills,
    TAIL_SETTLE_LAG_MS,
} = require('../analysis/fills_cache');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fills-cache-'));
}
function cleanup(dir: string) {
    fs.rmSync(dir, { recursive: true, force: true });
}
function iso(ms: number) {
    return new Date(Number(ms)).toISOString();
}

function fill(time: string, blockNum: number, opNum: number) {
    return {
        time, blockNum, opNum,
        orderId: `o${blockNum}-${opNum}`,
        accountId: '1.2.3',
        pays: { amount: 100, asset_id: '1.3.0' },
        receives: { amount: 200, asset_id: '1.3.0' },
        fee: { amount: 0, asset_id: '1.3.0' },
        isMaker: true,
        sort: [blockNum, opNum],
    };
}

function makeFetcher(dataset: any[], calls: Array<[number, number]>) {
    return async (gteIso: string, lteIso: string) => {
        const gte = Date.parse(gteIso);
        const lte = Date.parse(lteIso);
        calls.push([gte, lte]);
        return dataset.filter((f: any) => {
            const t = Date.parse(f.time);
            return t >= gte && t <= lte;
        });
    };
}

async function main() {
    // ── Pure helpers ────────────────────────────────────────────────────
    assert.strictEqual(shardKeyForTimestamp(Date.UTC(2026, 0, 15)), '2026-01');
    assert.deepStrictEqual(shardBoundsForKey('2026-01'), { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 1, 1) });
    assert.deepStrictEqual(shardBoundsForKey('2026-12'), { start: Date.UTC(2026, 11, 1), end: Date.UTC(2027, 0, 1) });
    assert.deepStrictEqual(
        shardKeysForRange(Date.UTC(2026, 0, 15), Date.UTC(2026, 2, 2)),
        ['2026-01', '2026-02', '2026-03'],
    );

    assert.deepStrictEqual(subtractRanges({ gte: 0, lte: 10 }, [{ gte: 3, lte: 5 }]), [{ gte: 0, lte: 2 }, { gte: 6, lte: 10 }]);
    assert.deepStrictEqual(subtractRanges({ gte: 0, lte: 10 }, []), [{ gte: 0, lte: 10 }]);
    assert.deepStrictEqual(subtractRanges({ gte: 0, lte: 10 }, [{ gte: -5, lte: 15 }]), []);

    {
        const now = Date.UTC(2026, 5, 1);
        const old = { gte: Date.UTC(2026, 0, 1), lte: Date.UTC(2026, 0, 31), at: now };
        assert.deepStrictEqual(trustedSegments([old], now), [{ gte: old.gte, lte: old.lte }], 'a span verified long after it closed is fully trusted');
        assert.deepStrictEqual(trustedSegments([{ gte: 0, lte: 100, at: null }], now), [], 'unknown verification time certifies nothing');
        const recent = { gte: 0, lte: 100, at: 50 + TAIL_SETTLE_LAG_MS };
        assert.deepStrictEqual(trustedSegments([recent], now), [{ gte: 0, lte: 50 }], 'only the settled part of a recent query is trusted');
    }

    assert.strictEqual(mergeFills([fill(iso(1), 1, 1)], [fill(iso(1), 1, 1), fill(iso(2), 1, 2)]).length, 2, 'dedup by block:op');

    // ── Settled months: query once, then reuse with zero queries ─────────
    {
        const dir = tmpDir();
        try {
            const data = [
                fill(iso(Date.UTC(2026, 0, 5)), 1, 1),
                fill(iso(Date.UTC(2026, 0, 15)), 1, 2),
                fill(iso(Date.UTC(2026, 1, 10)), 2, 1),
            ];
            const calls1: Array<[number, number]> = [];
            const out1 = await fetchFillsCached(null, '1.2.3', '2026-01-01T00:00:00.000Z', '2026-02-28T23:59:59.999Z', {
                cacheDir: dir, nowMs: Date.UTC(2026, 3, 1), fetchRange: makeFetcher(data, calls1), quiet: true,
            });
            assert.strictEqual(out1.length, 3);
            assert.strictEqual(calls1.length, 2, 'one query per overlapping month shard');
            assert.ok(fs.existsSync(shardPathFor(basePathFor(dir, '1.2.3'), '2026-01')));
            assert.ok(fs.existsSync(shardPathFor(basePathFor(dir, '1.2.3'), '2026-02')));

            const calls2: Array<[number, number]> = [];
            const out2 = await fetchFillsCached(null, '1.2.3', '2026-01-01T00:00:00.000Z', '2026-02-28T23:59:59.999Z', {
                cacheDir: dir, nowMs: Date.UTC(2026, 3, 2), fetchRange: makeFetcher(data, calls2), quiet: true,
            });
            assert.strictEqual(out2.length, 3);
            assert.strictEqual(calls2.length, 0, 'settled months reuse with zero queries');
        } finally {
            cleanup(dir);
        }
    }

    // ── Tail refresh picks up late-indexed fills ─────────────────────────
    {
        const dir = tmpDir();
        try {
            const H = 3600 * 1000;
            const data = [fill(iso(Date.UTC(2026, 0, 1)), 1, 1), fill(iso(Date.UTC(2026, 0, 20, 10)), 1, 2)];
            const startIso = '2026-01-01T00:00:00.000Z';
            const endIso = '2026-01-20T12:00:00.000Z';
            const calls1: Array<[number, number]> = [];
            const out1 = await fetchFillsCached(null, '1.2.3', startIso, endIso, {
                cacheDir: dir, nowMs: Date.UTC(2026, 0, 20, 12), fetchRange: makeFetcher(data, calls1), quiet: true,
            });
            assert.strictEqual(out1.length, 2);
            assert.strictEqual(calls1.length, 1);

            // A fill appears after the first query (Kibana indexing lag).
            data.push(fill(iso(Date.UTC(2026, 0, 20, 11)), 1, 3));
            const calls2: Array<[number, number]> = [];
            const out2 = await fetchFillsCached(null, '1.2.3', startIso, endIso, {
                cacheDir: dir, nowMs: Date.UTC(2026, 0, 20, 13), fetchRange: makeFetcher(data, calls2), quiet: true,
            });
            assert.strictEqual(calls2.length, 1, 'unsettled tail is re-queried');
            // Settled boundary = first query time (Jan-20 12:00) - 6h = 06:00.
            assert.strictEqual(calls2[0][0], Date.UTC(2026, 0, 20, 6) + 1, 'tail starts just past the settled boundary');
            assert.strictEqual(calls2[0][1], Date.parse(endIso));
            assert.strictEqual(out2.length, 3, 'late-indexed fill is picked up');
        } finally {
            cleanup(dir);
        }
    }

    // ── refresh re-queries but never drops cached fills ──────────────────
    {
        const dir = tmpDir();
        try {
            const data = [fill(iso(Date.UTC(2026, 0, 5)), 1, 1), fill(iso(Date.UTC(2026, 0, 25)), 1, 2)];
            const full = '2026-01-01T00:00:00.000Z';
            const fullEnd = '2026-01-31T23:59:59.999Z';
            await fetchFillsCached(null, '1.2.3', full, fullEnd, {
                cacheDir: dir, nowMs: Date.UTC(2026, 3, 1), fetchRange: makeFetcher(data, []), quiet: true,
            });

            const callsSub: Array<[number, number]> = [];
            const outSub = await fetchFillsCached(null, '1.2.3', '2026-01-10T00:00:00.000Z', '2026-01-20T00:00:00.000Z', {
                cacheDir: dir, nowMs: Date.UTC(2026, 3, 2), refresh: true, fetchRange: makeFetcher(data, callsSub), quiet: true,
            });
            assert.strictEqual(callsSub.length, 1, 'refresh re-queries the requested span');
            assert.strictEqual(outSub.length, 0);

            const calls3: Array<[number, number]> = [];
            const out3 = await fetchFillsCached(null, '1.2.3', full, fullEnd, {
                cacheDir: dir, nowMs: Date.UTC(2026, 3, 3), fetchRange: makeFetcher(data, calls3), quiet: true,
            });
            assert.strictEqual(out3.length, 2, 'a sub-range refresh preserves the rest of the month');
            assert.strictEqual(calls3.length, 0);
        } finally {
            cleanup(dir);
        }
    }

    // ── A queried-but-empty month is still covered ───────────────────────
    {
        const dir = tmpDir();
        try {
            const calls1: Array<[number, number]> = [];
            // Query well after the month closed, so its whole span is settled.
            const out1 = await fetchFillsCached(null, '1.2.3', '2026-03-01T00:00:00.000Z', '2026-03-31T23:59:59.999Z', {
                cacheDir: dir, nowMs: Date.UTC(2026, 3, 30), fetchRange: makeFetcher([], calls1), quiet: true,
            });
            assert.strictEqual(out1.length, 0);
            assert.strictEqual(calls1.length, 1);

            const calls2: Array<[number, number]> = [];
            const out2 = await fetchFillsCached(null, '1.2.3', '2026-03-01T00:00:00.000Z', '2026-03-31T23:59:59.999Z', {
                cacheDir: dir, nowMs: Date.UTC(2026, 4, 1), fetchRange: makeFetcher([], calls2), quiet: true,
            });
            assert.strictEqual(calls2.length, 0, 'empty covered month is not re-queried');
            assert.strictEqual(out2.length, 0);
        } finally {
            cleanup(dir);
        }
    }

    console.log('✓ fills cache tests passed');
}

main().catch((err) => {
    console.error('fills cache tests FAILED:', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
    process.exit(1);
});
