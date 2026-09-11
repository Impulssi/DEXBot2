const assert = require('assert');

console.log('Running window_cache pruning tests');

const {
    findMissingBucketRanges,
    planWindowReuse,
    pruneImmutableGaps,
    persistCacheChunk,
    readCacheChunk,
    loadBucketCache,
    priorQueriedInWindow,
} = require('../market_adapter/inputs/window_cache');

const H = 3600 * 1000;
// Fixed "now" so the 7-day immutability horizon is deterministic.
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
// Old window: 2026-07-10 -> 2026-07-17 (fully past the lag horizon).
const WGTE = Date.UTC(2026, 6, 10, 0, 0, 0);
const WLTE = Date.UTC(2026, 6, 17, 0, 0, 0);

function candle(ts: number) {
    return [ts, 1, 1, 1, 1, 0];
}

function hourly(fromMs: number, toMs: number) {
    const out: number[] = [];
    for (let ts = fromMs; ts <= toMs; ts += H) out.push(ts);
    return out;
}

// Local buckets on both sides of an interior old gap (Jul-12..Jul-13).
function interiorGapCache(queried: { gte: number; lte: number }[]) {
    const have = [
        ...hourly(WGTE, WGTE + H),
        ...hourly(WGTE + 4 * 24 * H, WLTE),
    ];
    const byTs = new Map();
    for (const h of have) byTs.set(h, candle(h));
    return {
        localCache: {
            byTs,
            files: 1,
            fileCover: [{ gte: WGTE, lte: WLTE, count: have.length, queried }],
        },
        have,
    };
}

{
    // Interior old gap never actually queried: the file's overall range
    // covers it, but queriedRanges do not -> must be KEPT (re-queried).
    // Before the queriedRanges fix this was wrongly pruned.
    const { localCache, have } = interiorGapCache([
        { gte: WGTE, lte: WGTE + H },
        { gte: WGTE + 4 * 24 * H, lte: WLTE },
    ]);
    const raw = findMissingBucketRanges(WGTE, WLTE, H, new Set(have));
    const pruned = pruneImmutableGaps(raw, WLTE, localCache.fileCover, NOW);
    assert.strictEqual(pruned.length, 1, `interior never-queried gap must survive pruning, got ${JSON.stringify(pruned)}`);
    assert.strictEqual(pruned[0].gte, WGTE + 2 * H, 'gap starts at first missing bucket');
    assert.strictEqual(pruned[0].lte, WGTE + 4 * 24 * H - H, 'gap ends at last missing bucket');

    // Same expectation through the planner entry point.
    const plan = planWindowReuse(localCache, {
        gteMs: WGTE, lteMs: WLTE, bucketMs: H,
        isTail: false, allowSubFetch: true, nowMs: NOW,
    });
    assert.strictEqual(plan.missing.length, 1, `planner must keep the never-queried gap, got ${JSON.stringify(plan.missing)}`);
    assert.strictEqual(plan.missing[0].gte, WGTE + 2 * H);
}

{
    // Same gap, but actually queried before -> still pruned (no regression).
    const { localCache, have } = interiorGapCache([{ gte: WGTE, lte: WLTE }]);
    const raw = findMissingBucketRanges(WGTE, WLTE, H, new Set(have));
    const pruned = pruneImmutableGaps(raw, WLTE, localCache.fileCover, NOW);
    assert.strictEqual(pruned.length, 0, `actually-queried interior gap must be pruned, got ${JSON.stringify(pruned)}`);

    const plan = planWindowReuse(localCache, {
        gteMs: WGTE, lteMs: WLTE, bucketMs: H,
        isTail: false, allowSubFetch: true, nowMs: NOW,
    });
    assert.strictEqual(plan.missing.length, 0, 'planner must prune the actually-queried gap');
}


{
    // Round trip through real chunk files in a temp dir: a sub-fetch-style
    // meta yields exactly its narrow queriedRanges in fileCover, while a
    // legacy meta without the field falls back to the full timeRange
    // (pre-fix files were full-fetch only, so the claim is exact).
    // priorQueriedInWindow clips surviving coverage to the new window.
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-test-'));
    try {
        const out = path.join(dir, 'feed_x_1h.json');
        const qgte = Date.parse('2026-07-20T00:00:00.000Z');
        const qlte = Date.parse('2026-07-22T00:00:00.000Z');
        persistCacheChunk(
            path.join(dir, 'feed_x_1h.chunk_01_2026-07-10_2026-08-10.json'),
            { feed: 'x', timeRange: { gte: '2026-07-10T00:00:00.000Z', lte: '2026-08-10T00:00:00.000Z' }, queriedRanges: [{ gte: qgte, lte: qlte }] },
            [[qgte, 1, 1, 1, 1, 0]],
        );
        persistCacheChunk(
            path.join(dir, 'feed_x_1h.chunk_02_2026-06-10_2026-07-10.json'),
            { feed: 'x', timeRange: { gte: '2026-06-10T00:00:00.000Z', lte: '2026-07-10T00:00:00.000Z' } },
            [],
        );
        const isMatch = () => true;
        const cache = loadBucketCache(out, {}, isMatch);
        assert.strictEqual(cache.files, 2, 'both chunk files load');
        const narrow = cache.fileCover.find((f: any) => f.count === 1);
        assert.deepStrictEqual(narrow.queried, [{ gte: qgte, lte: qlte }], 'narrow queriedRanges survive the round trip');
        const legacy = cache.fileCover.find((f: any) => f.count === 0);
        assert.deepStrictEqual(
            legacy.queried,
            [{ gte: Date.parse('2026-06-10T00:00:00.000Z'), lte: Date.parse('2026-07-10T00:00:00.000Z') }],
            'legacy meta without the field falls back to its timeRange',
        );
        const file1 = path.join(dir, 'feed_x_1h.chunk_01_2026-07-10_2026-08-10.json');
        const clipped = priorQueriedInWindow(file1, {}, isMatch, Date.parse('2026-07-21T00:00:00.000Z'), Date.parse('2026-07-25T00:00:00.000Z'));
        assert.deepStrictEqual(clipped, [{ gte: Date.parse('2026-07-21T00:00:00.000Z'), lte: qlte }], 'prior coverage is clipped to the new window');
        const outside = priorQueriedInWindow(file1, {}, isMatch, Date.parse('2026-07-23T00:00:00.000Z'), Date.parse('2026-07-25T00:00:00.000Z'));
        assert.deepStrictEqual(outside, [], 'non-overlapping windows keep no prior coverage');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

{
    // Regression: 5 stray boundary buckets from the NEXT window's file sat
    // at the end of this old window (real incident: a whole month certified
    // "nothing missing" from 5 stray buckets while hundreds of live hours
    // went unfetched). Buckets before the first local one
    // are not proven empty by anything -> the whole leading range must be
    // kept for querying.
    const strays = hourly(WLTE - 4 * H, WLTE);
    const byTs = new Map();
    for (const h of strays) byTs.set(h, candle(h));
    const localCache = {
        byTs,
        files: 1,
        fileCover: [{ gte: WGTE, lte: WLTE, count: strays.length, queried: [] }],
    };
    const raw = findMissingBucketRanges(WGTE, WLTE, H, new Set(strays));
    const pruned = pruneImmutableGaps(raw, WLTE, localCache.fileCover, NOW);
    assert.strictEqual(pruned.length, 1, `stray-anchored leading range must survive pruning, got ${JSON.stringify(pruned)}`);
    assert.strictEqual(pruned[0].gte, WGTE, 'gap starts at the window start');
    assert.strictEqual(pruned[0].lte, WLTE - 5 * H, 'gap ends before the first stray bucket');

    const plan = planWindowReuse(localCache, {
        gteMs: WGTE, lteMs: WLTE, bucketMs: H,
        isTail: false, allowSubFetch: true, nowMs: NOW,
    });
    assert.ok(plan.missing.length > 0, `planner must re-query the uncovered range, got ${JSON.stringify(plan.missing)}`);
    assert.strictEqual(plan.missing[0].gte, WGTE);
}

console.log('window_cache pruning tests passed');
