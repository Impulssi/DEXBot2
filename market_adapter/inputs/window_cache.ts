'use strict';
/**
 * WINDOW CACHE — persistent bucket cache for windowed Kibana candle fetches.
 *
 * Storage is decoupled from querying: candles live in fixed calendar-month
 * shards (`<base>.shard_YYYY-MM.json`, UTC), one file per month with a stable
 * name that never shifts. A run maps its requested range onto the overlapping
 * shards, loads ONLY those files, fetches only genuinely missing buckets, and
 * writes back ONLY shards that gained buckets or query coverage. Pure-reuse
 * runs perform zero writes and zero deletes.
 *
 * Each shard holds `{ meta, candles }` where `meta.queriedRanges` records the
 * spans actually queried to produce the data (monotonically unioned on every
 * write) together with `at`, the time each query ran. Missing buckets are
 * pruned only against recorded query coverage — the absence of local buckets
 * alone never certifies history as empty — and only once the span is older
 * than GAP_SETTLE_HORIZON_MS, judged per gap rather than per window. `at` is
 * what makes the newest window's late-indexing refresh incremental: buckets a
 * previous query already saw TAIL_SETTLE_LAG_MS after they closed are settled
 * and never re-queried (see settleCoverage). A run that re-verifies the tail
 * therefore REWRITES that shard even when the candles come back identical —
 * the moved verification time is the only news, and skipping the write would
 * throw it away. Pure-reuse runs (no query at all) still write nothing.
 *
 * Callers supply:
 *   - `requestKey` — opaque identity object stored in each shard's meta,
 *   - `isMatch(meta, requestKey)` — same-pool/feed/interval/assets check,
 *   - `fetchRange(gteIso, lteIso)` — query one (sub-)range, gap-filled grid,
 *   - `metaForWindow(window)` — identity meta fields (source/feed/pool/...);
 *     the runner overrides timeRange with the shard bounds and drops
 *     chunkIndex, which is meaningless for stable shards.
 *
 * Node-only (disk I/O via storage). Browser-safe code must not import this.
 */

import { path } from '../../modules/path_api.js';
import { getStorage } from '../../modules/storage/index.js';
import { writeJsonAtomic } from '../utils/atomic_write.js';
import { sleepMs } from '../../modules/utils/errors.js';
import { mergeCandles } from '../candle_utils.js';

const storage = getStorage();
const { readJSON } = storage;

// Trailing overlap for the newest window. It is the refresh when the cache
// records no query timestamps (pre-`at` shard files) AND the hard ceiling when
// it does: Kibana indexing can lag minutes–hours, so buckets cached as
// zero-volume fills may gain real trades after the fact, and 48h bounds the
// extra query to a small range. Once coverage carries `at`, the refresh shrinks
// to the still-unsettled tail instead (see TAIL_SETTLE_LAG_MS /
// settleCoverage) — but never reaches back past this window. Without the
// ceiling a single mid-window coverage hole (e.g. an old span dropped by
// compactCoverage) would drag the boundary back weeks and re-query settled
// history on every run.
const TAIL_REFRESH_HOURS = 48;

// How long after a bucket closes its last trade may still be indexed. A
// bucket is settled once some query covering it ran at least this long after
// the bucket closed — after that, re-querying it can only confirm what we
// already have. Sized well above real Kibana indexing lag (minutes–hours)
// while staying far below the 48h legacy fallback, so a rerun minutes after a
// previous one costs a few hours of query instead of two days.
const TAIL_SETTLE_LAG_MS = 6 * 3600 * 1000;

// A missing bucket range that ended longer ago than this is immutable:
// blockchain history does not change and Kibana indexing lag is long past.
// Judged PER GAP, not per window: a month-old gap at the leading edge of the
// newest window is just as settled as one in last year's window, and the
// window-level test could never prune it. Inside the horizon nothing is
// certified — recent buckets may still gain late-indexed trades.
//
// 7 days, i.e. the margin the window-level rule used before: the win here
// comes from judging each gap by its OWN age, not from trusting the cache
// sooner. Nothing in this repo measures how far behind Kibana indexing can
// lag, so the horizon stays at the last value that was live-proven rather
// than being tightened on a guess — the reported incident (a month-old,
// already-queried gap re-fetched forever) is pruned either way.
const GAP_SETTLE_HORIZON_MS = 7 * 24 * 3600 * 1000;

// Sub-range fetch budget. Small gaps are queried individually; gaps closer
// than this many buckets are merged first (one query instead of two) and the
// run only takes the sub-range path while the merged spans stay under
// MAX_SUBFETCH_SPAN_RATIO of the window. The cap is on merged SPAN HOURS, not
// on the gap count: a count cap made a 4th tiny gap escalate to a full-month
// fetch (~700x the query for one extra hour of data).
const GAP_MERGE_TOLERANCE_BUCKETS = 2;
const MAX_SUBFETCH_RANGES = 8;
const MAX_SUBFETCH_SPAN_RATIO = 0.5;

// Upper bound on the spans persisted in one shard. Spans merge only when they
// agree on `at` (see unionQueriedRanges), so a shard that is re-verified often
// gains one span per run and would otherwise grow without limit. Normal
// operation stays far below this: coverage is clipped per shard, so only the
// current month accumulates.
const MAX_COVERAGE_SPANS = 64;

// ─── Month-shard naming ───────────────────────────────────────────────────────
// Shard key is the UTC calendar month; bounds are half-open [start, end) so
// every bucket timestamp maps to exactly one shard (a bucket exactly at a
// month boundary belongs to the new month).

function shardKeyForTimestamp(tsMs: any) {
    const d = new Date(Number(tsMs));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function shardBoundsForKey(key: any) {
    const parts = String(key).split('-').map(Number);
    const start = Date.UTC(parts[0], parts[1] - 1, 1);
    const end = parts[1] === 12 ? Date.UTC(parts[0] + 1, 0, 1) : Date.UTC(parts[0], parts[1], 1);
    return { start, end };
}

function shardKeysForRange(gteMs: any, lteMs: any) {
    const keys: string[] = [];
    let cursor = new Date(Date.UTC(
        new Date(Number(gteMs)).getUTCFullYear(),
        new Date(Number(gteMs)).getUTCMonth(), 1));
    const last = new Date(Number(lteMs));
    while (cursor <= last) {
        keys.push(shardKeyForTimestamp(cursor.getTime()));
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
    return keys;
}

function shardRangeOverlaps(shardKey: any, gteMs: any, lteMs: any) {
    const { start, end } = shardBoundsForKey(shardKey);
    return start <= lteMs && end > gteMs;
}

function shardPathFor(outPath: any, shardKey: any) {
    const parsed = path.parse(outPath);
    return path.join(parsed.dir, `${parsed.name}.shard_${shardKey}${parsed.ext}`);
}

function siblingCacheFiles(outPath: any) {
    const resolved = path.resolve(outPath);
    const parsed = path.parse(resolved);
    if (!storage.exists(parsed.dir)) return [];
    const shardPrefix = `${parsed.name}.shard_`;
    const out: { file: string; shardKey: string }[] = [];
    for (const name of storage.readdir(parsed.dir)) {
        if (!name.endsWith(parsed.ext) || !name.startsWith(shardPrefix)) continue;
        const key = name.slice(shardPrefix.length, name.length - parsed.ext.length);
        if (!/^\d{4}-\d{2}$/.test(key)) continue;
        out.push({ file: path.join(parsed.dir, name), shardKey: key });
    }
    out.sort((a: any, b: any) => (a.file < b.file ? -1 : 1));
    return out;
}

function readCacheChunk(chunkFile: any, requestKey: any, isMatch: (meta: any, requestKey: any) => boolean) {
    // Same-identity check WITHOUT the timeRange match — any chunk for this
    // request can contribute buckets.
    try {
        const parsed = readJSON(chunkFile);
        const meta = parsed?.meta || {};
        if (!isMatch(meta, requestKey)) return null;
        if (!Array.isArray(parsed.candles)) return null;
        const rangeGte = Date.parse(String(meta.timeRange?.gte || ''));
        const rangeLte = Date.parse(String(meta.timeRange?.lte || ''));
        const gte = Number.isFinite(rangeGte) ? rangeGte : null;
        const lte = Number.isFinite(rangeLte) ? rangeLte : null;
        // Ranges actually queried to produce these candles. Pre-fix files
        // predate sub-range fetches (full-window only), so their timeRange
        // claim is exact and serves as the fallback.
        // `at` = when the covering query actually ran. Shards written before
        // timestamps were recorded carry none, so the FILE's own write time
        // stands in: `persistCacheChunk` stamps `fetchedAt` at flush time and
        // the data in that file was queried in the same run, so the real query
        // time is at most one run-duration earlier. That optimism is minutes
        // against a 6h settle lag and only touches the run's own tail; the
        // alternative — treating those spans as unverifiable — poisons the
        // whole window (see planWindowReuse) and silently disables the
        // late-indexing refresh on every cache that has one old shard.
        const fileAt = timestampMs(meta?.fetchedAt);
        const spanAt = (q: any) => verifiedAt(q) ?? fileAt;
        const queried: QueriedRange[] = Array.isArray(meta.queriedRanges)
            ? meta.queriedRanges
                .filter((q: any) => Number.isFinite(Number(q?.gte)) && Number.isFinite(Number(q?.lte)))
                .map((q: any) => ({ gte: Number(q.gte), lte: Number(q.lte), at: spanAt(q) }))
            : (gte !== null && lte !== null ? [{ gte, lte, at: fileAt }] : []);
        return {
            candles: parsed.candles,
            fetchedAt: meta.fetchedAt || null,
            file: chunkFile,
            rangeGte: gte,
            rangeLte: lte,
            queried,
        };
    } catch (_: any) {
        return null;
    }
}

function loadBucketCache(outPath: any, requestKey: any, isMatch: (meta: any, requestKey: any) => boolean, range?: { gte: number; lte: number } | null) {
    const byTs = new Map();
    const fileCover: { gte: number | null; lte: number | null; count: number; queried: QueriedRange[] }[] = [];
    const shards: { file: string; shardKey: string; candles: any[]; queried: QueriedRange[] }[] = [];
    let files = 0;
    const scoped = range && Number.isFinite(range.gte) && Number.isFinite(range.lte);
    for (const entry of siblingCacheFiles(outPath)) {
        // Shards outside the requested range are never even opened —
        // a narrow run reads only the months it needs.
        if (scoped && !shardRangeOverlaps(entry.shardKey, (range as any).gte, (range as any).lte)) continue;
        const chunk = readCacheChunk(entry.file, requestKey, isMatch);
        if (!chunk) continue;
        files += 1;
        fileCover.push({ gte: chunk.rangeGte, lte: chunk.rangeLte, count: chunk.candles.length, queried: chunk.queried });
        for (const c of chunk.candles) {
            if (!Array.isArray(c)) continue;
            const ts = Number(c[0]);
            if (!Number.isFinite(ts)) continue;
            const prev = byTs.get(ts);
            if (!prev || Number(c[5] || 0) > Number(prev[5] || 0)) byTs.set(ts, c);
        }
        shards.push({ file: entry.file, shardKey: entry.shardKey, candles: chunk.candles.filter((c: any) => Array.isArray(c)), queried: chunk.queried });
    }
    return { byTs, files, fileCover, shards };
}

function cachedCandlesInRange(localCache: any, gteMs: number, lteMs: number) {
    const out: any[] = [];
    for (const [ts, c] of localCache.byTs) {
        if (ts >= gteMs && ts <= lteMs) out.push(c);
    }
    out.sort((a: any, b: any) => a[0] - b[0]);
    return out;
}

// ─── Queried-range set ops ────────────────────────────────────────────────────
// Coverage provenance: normalize recorded spans (sort, merge overlapping or
// bucket-adjacent) so growth checks and absorption decisions are exact.
// A span also carries the time its covering query RAN (`at`), which is what
// makes the tail refresh incremental: extent says "we asked", `at` says "and
// the answer is still current".

/** Span of time actually queried, plus when the query ran (null = unknown). */
type QueriedRange = { gte: number; lte: number; at: number | null };

/** Parse a verification timestamp: epoch ms or ISO. Anything else is unknown. */
function timestampMs(raw: any): number | null {
    // `null`/`undefined`/`''` mean "not recorded". They must NOT fall through
    // to Number(): Number(null) === 0 is finite, which would read an unknown
    // verification time as "verified at the epoch" — i.e. as maximally stale,
    // silently disabling the tail refresh on every pre-`at` shard.
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
}

function verifiedAt(range: any): number | null {
    return timestampMs(range?.at);
}

/**
 * Normalize recorded spans: sort, then merge overlapping / bucket-adjacent
 * ones — but ONLY when they assert the same verification time. Merging spans
 * with different `at` would have to pick one verdict for the whole union, and
 * either pick loses (min → the merged span vouches for buckets the older
 * query never saw; max → buckets verified long ago look freshly verified).
 * Keeping them separate preserves exact per-bucket freshness, which is the
 * whole point of `at`. Spans therefore accumulate ~1 per tail run, each a few
 * dozen bytes — negligible next to the candles in the same file, and the
 * same-`at` case (bulk fetches, and every pre-`at` shard) still collapses to
 * one span as before.
 */
function unionQueriedRanges(ranges: { gte: number; lte: number; at?: number | null }[], bucketMs: number): QueriedRange[] {
    const clean = (ranges || [])
        .filter((q: any) => q && Number.isFinite(Number(q.gte)) && Number.isFinite(Number(q.lte)) && Number(q.lte) >= Number(q.gte))
        .map((q: any) => ({ gte: Number(q.gte), lte: Number(q.lte), at: verifiedAt(q) }))
        .sort((a: any, b: any) => a.gte - b.gte || a.lte - b.lte);
    const merged: QueriedRange[] = [];
    const gap = Number.isFinite(Number(bucketMs)) && Number(bucketMs) > 0 ? Number(bucketMs) : 0;
    for (const q of clean) {
        const top = merged[merged.length - 1];
        if (top && q.gte <= top.lte + gap && top.at === q.at) {
            if (q.lte > top.lte) top.lte = q.lte;
        } else {
            merged.push({ gte: q.gte, lte: q.lte, at: q.at });
        }
    }
    return merged;
}

function rangesCoveredBy(have: { gte: number; lte: number }[], want: { gte: number; lte: number }[]) {
    for (const w of want || []) {
        let covered = false;
        for (const h of have || []) {
            if (h.gte <= w.gte && h.lte >= w.lte) { covered = true; break; }
        }
        if (!covered) return false;
    }
    return true;
}

/**
 * Change detection for shard writes: `have` already accounts for every span in
 * `want`, in extent AND in verification time. Without the `at` half, a run
 * whose only news is "these buckets were re-verified 1h later" would skip the
 * write and the next run would fall back to the wide fixed refresh window.
 * An unknown `at` on either side is never treated as fresh.
 */
function coverageSatisfied(have: QueriedRange[], want: QueriedRange[]) {
    if (!rangesCoveredBy(have, want)) return false;
    for (const w of want || []) {
        const wAt = verifiedAt(w);
        if (wAt == null) continue;
        let fresh = false;
        for (const h of have || []) {
            if (h.gte > w.gte || h.lte < w.lte) continue;
            const hAt = verifiedAt(h);
            if (hAt != null && hAt >= wAt) { fresh = true; break; }
        }
        if (!fresh) return false;
    }
    return true;
}

/** Every recorded span across the loaded files, newest verification included. */
function allQueriedRanges(fileCover: { queried?: QueriedRange[] | null }[]): QueriedRange[] {
    const out: QueriedRange[] = [];
    for (const f of fileCover || []) {
        for (const q of f?.queried || []) {
            if (q && Number.isFinite(Number(q.gte)) && Number.isFinite(Number(q.lte))) out.push(q);
        }
    }
    return out;
}

/**
 * How settled a window is, given the recorded coverage.
 *
 * A bucket is settled when some recorded query covering it ran at least
 * `lagMs` after the bucket closed — late indexing has certainly landed by
 * then, so re-querying it can only re-confirm cached data. Returns
 * `hasTimestamps: false` when no coverage carries a verification time (all
 * pre-`at` shards), which tells the caller to fall back to the fixed window.
 * Otherwise `firstUnsettled` is the earliest bucket that still needs a query
 * (null when the whole window is settled).
 */
function settleCoverage(opts: { gteMs: number; lteMs: number; bucketMs: number; queried: QueriedRange[]; lagMs: number }): { hasTimestamps: boolean; firstUnsettled: number | null } {
    const { gteMs, lteMs, bucketMs, lagMs } = opts;
    const spans = (opts.queried || []).filter((q: any) => q && Number.isFinite(Number(q.gte)) && Number.isFinite(Number(q.lte)));
    const hasTimestamps = spans.some((q: any) => verifiedAt(q) != null);
    if (!hasTimestamps) return { hasTimestamps: false, firstUnsettled: null };
    const first = Math.floor(gteMs / bucketMs) * bucketMs;
    const last = Math.floor(lteMs / bucketMs) * bucketMs;
    for (let ts = first; ts <= last; ts += bucketMs) {
        let settled = false;
        for (const q of spans) {
            if (q.gte > ts || q.lte < ts) continue;
            const at = verifiedAt(q);
            if (at != null && at >= ts + bucketMs + lagMs) { settled = true; break; }
        }
        if (!settled) return { hasTimestamps: true, firstUnsettled: ts };
    }
    return { hasTimestamps: true, firstUnsettled: null };
}

/**
 * Bound the persisted span list. Because spans merge only when they assert
 * the same `at`, a shard that is re-verified on every run gains one span per
 * run and would grow without limit (and `settleCoverage` scans the list once
 * per tail window). Dropping the OLDEST spans never invents emptiness, but it
 * is not free: coverage is consulted by BOTH `pruneImmutableGaps` (to skip a
 * query) and `settleCoverage` (to decide a bucket is fresh). A dropped span
 * makes its buckets look unsettled, and the tail refresh would otherwise start
 * at the earliest of them. That is why the refresh is capped at
 * TAIL_REFRESH_HOURS: the worst a dropped span can cost is the legacy 48h
 * overlap, never weeks. The input is already sorted by extent, so the tail of
 * the list is the newest.
 */
function compactCoverage(spans: QueriedRange[], maxSpans: number): QueriedRange[] {
    const list = spans || [];
    const max = Number.isFinite(Number(maxSpans)) && Number(maxSpans) >= 1 ? Math.floor(Number(maxSpans)) : list.length;
    return list.length <= max ? list : list.slice(list.length - max);
}

function clipRangeTo(q: QueriedRange, gteMs: number, lteMs: number): QueriedRange | null {
    const gte = Math.max(q.gte, gteMs);
    const lte = Math.min(q.lte, lteMs);
    return lte >= gte ? { gte, lte, at: verifiedAt(q) } : null;
}

function addUtcMonths(date: any, months: any) {
    const result = new Date(date.getTime());
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(result.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(
        result.getUTCFullYear(),
        result.getUTCMonth() + 1,
        0
    )).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
    return result;
}

function normalizeDateInput(raw: any, label: any) {
    const ms = Date.parse(String(raw || ''));
    if (!Number.isFinite(ms)) {
        throw new Error(`Invalid ${label} date: ${raw}`);
    }
    return new Date(ms);
}

function buildFetchWindowsFromRange(timeRange: any, chunkMonths: any) {
    const start = normalizeDateInput(timeRange.gte, 'start');
    const end = normalizeDateInput(timeRange.lte, 'end');

    if (start >= end) {
        throw new Error(`Invalid fetch range: ${start.toISOString()} must be earlier than ${end.toISOString()}`);
    }

    const windows: any[] = [];
    let cursor = start;
    while (cursor < end) {
        const next = addUtcMonths(cursor, chunkMonths);
        const windowEnd = next < end ? next : end;
        windows.push({
            gte: cursor.toISOString(),
            lte: windowEnd.toISOString(),
        });
        cursor = windowEnd;
    }

    return windows;
}

function findMissingBucketRanges(gteMs: number, lteMs: number, bucketMs: number, haveTs: Set<number>) {
    const first = Math.floor(gteMs / bucketMs) * bucketMs;
    const last = Math.floor(lteMs / bucketMs) * bucketMs;
    const missing: { gte: number; lte: number; hours: number }[] = [];
    let runStart: number | null = null;
    for (let ts = first; ts <= last; ts += bucketMs) {
        if (haveTs.has(ts)) {
            if (runStart !== null) {
                missing.push({ gte: runStart, lte: ts - bucketMs, hours: Math.round((ts - runStart) / bucketMs) });
                runStart = null;
            }
        } else if (runStart === null) {
            runStart = ts;
        }
    }
    if (runStart !== null) {
        missing.push({ gte: runStart, lte: last, hours: Math.round((last - runStart) / bucketMs) + 1 });
    }
    return missing;
}

/**
 * Merge gap ranges that sit closer together than `toleranceBuckets`, so a
 * cluster of one-bucket holes costs one query instead of one per hole. Only
 * the bounding span widens (the buckets in between get queried too — they are
 * local anyway, so the over-claim is harmless), and input order is preserved.
 */
function mergeGapRanges(missing: { gte: number; lte: number; hours: number }[], bucketMs: number, toleranceBuckets: number) {
    const tolMs = Number.isFinite(bucketMs) && bucketMs > 0 ? bucketMs * Math.max(0, toleranceBuckets || 0) : 0;
    const out: { gte: number; lte: number; hours: number }[] = [];
    for (const m of missing || []) {
        if (!m) continue;
        const prev = out[out.length - 1];
        if (prev && m.gte <= prev.lte + tolMs) {
            if (m.lte > prev.lte) {
                prev.lte = m.lte;
                prev.hours = Math.round((m.lte - prev.gte) / bucketMs) + 1;
            }
        } else {
            out.push({ gte: m.gte, lte: m.lte, hours: m.hours });
        }
    }
    return out;
}

function pruneImmutableGaps(missing: { gte: number; lte: number; hours: number }[], fileCover: { gte: number | null; lte: number | null; count: number; queried: QueriedRange[] }[], nowMs: number = Date.now()) {
    const settleBeforeMs = nowMs - GAP_SETTLE_HORIZON_MS;
    return missing.filter((m: any) => {
        // Absence of local buckets is NEVER proof of emptiness: stray
        // buckets from a sibling window's file (e.g. boundary over-fetch)
        // must not vouch for anything. Only queriedRanges count.
        // (A former "leading no-trade gap" heuristic pruned everything
        // before the first local bucket; it once certified a whole month
        // as empty from 5 stray boundary buckets of the next window.)
        // Coverage comes from meta.queriedRanges, not the file's overall
        // timeRange: a chunk rewritten from reused buckets plus sub-range
        // fetches only proves its fetched sub-ranges empty, never the
        // ranges it merely copied forward.
        // Immutability is judged per GAP, not per window: a month-old gap at
        // the leading edge of the newest window is exactly as settled as one
        // in a fully past window, and a window-level test could never prune it
        // (that gap was re-queried on every single run). Gaps ending inside
        // the horizon are always kept — recent buckets may still gain
        // late-indexed trades.
        if (m.lte >= settleBeforeMs) return true;
        for (const f of fileCover) {
            for (const q of f.queried || []) {
                if (q.gte <= m.gte && q.lte >= m.lte) return false;
            }
        }
        return true;
    });
}

function persistCacheChunk(chunkFile: any, meta: any, candles: any) {
    const payload = {
        meta: {
            ...meta,
            candleCount: candles.length,
            firstTs: candles.length > 0 ? new Date(candles[0][0]).toISOString() : null,
            lastTs: candles.length > 0 ? new Date(candles[candles.length - 1][0]).toISOString() : null,
        },
        candles,
    };
    writeJsonAtomic(chunkFile, payload);
}

function candlesEqual(a: any[], b: any[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
        for (let j = 0; j < x.length; j++) {
            if (Number(x[j]) !== Number(y[j])) return false;
        }
    }
    return true;
}

/**
 * Reuse plan for one window: buckets already on disk + the ranges that still
 * need querying. When `allowSubFetch` is false (data with cross-range state
 * such as forward-filled crosses), the tail widening is skipped and the
 * caller must take full-window fetches — reuse (zero queries) still applies.
 */
function planWindowReuse(localCache: any, opts: { gteMs: number; lteMs: number; bucketMs: number; isTail: boolean; allowSubFetch?: boolean; nowMs?: number }) {
    const { gteMs, lteMs, bucketMs, isTail } = opts;
    const allowSubFetch = opts.allowSubFetch !== false;
    const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    const valid = Number.isFinite(gteMs) && Number.isFinite(lteMs) && Number.isFinite(bucketMs) && bucketMs > 0;
    const reusable = valid
        ? cachedCandlesInRange(localCache, gteMs, lteMs)
        : [];
    let missing = valid
        ? findMissingBucketRanges(gteMs, lteMs, bucketMs, new Set(reusable.map((c: any) => Number(c[0]))))
        : [];
    // Immutable history (pruned again after the tail widening below, which
    // reintroduces the leading gap via its refresh set).
    const prune = () => {
        missing = pruneImmutableGaps(missing, localCache.fileCover, nowMs);
    };
    prune();
    // Late-indexing guard: the newest window re-fetches everything that is
    // not yet SETTLED — a bucket closes at ts+bucket and may still gain
    // late-indexed trades until a query has run TAIL_SETTLE_LAG_MS later.
    // With verification times on record the refresh shrinks to exactly that
    // unsettled tail, so a rerun an hour later queries ~lag+1h instead of a
    // fixed 48h, and repeated reruns converge instead of repeating the same
    // 48h query forever. Coverage without timestamps (pre-`at` shards) falls
    // back to the fixed trailing window.
    if (allowSubFetch && isTail && reusable.length > 0) {
        const settle = settleCoverage({
            gteMs, lteMs, bucketMs,
            queried: allQueriedRanges(localCache.fileCover),
            lagMs: TAIL_SETTLE_LAG_MS,
        });
        // Refresh start, widest case last:
        //   no timestamps      -> the bounded 48h fallback,
        //   everything settled -> no refresh at all,
        //   unsettled tail     -> the earliest unsettled bucket, but never
        //     earlier than 48h. An unsettled bucket older than the legacy
        //     window is past any plausible indexing lag, and letting it pull
        //     the boundary back (a coverage hole after span compaction, an
        //     undatable span, a hand-written file) would re-query weeks of
        //     settled history on every run. The clamp also covers the old
        //     `firstUnsettled <= gte` fallback: when the window begins
        //     unsettled, `max` lands on the 48h floor rather than switching
        //     the late-indexing refresh off.
        const fallbackFromMs = lteMs - TAIL_REFRESH_HOURS * 3600 * 1000;
        const refreshFromMs = settle.hasTimestamps
            ? (settle.firstUnsettled == null
                ? lteMs + bucketMs
                : Math.max(settle.firstUnsettled, fallbackFromMs))
            : fallbackFromMs;
        if (refreshFromMs > gteMs && refreshFromMs <= lteMs) {
            const refreshSet = new Set(
                reusable.filter((c: any) => Number(c[0]) < refreshFromMs).map((c: any) => Number(c[0])),
            );
            const refreshed = findMissingBucketRanges(gteMs, lteMs, bucketMs, refreshSet);
            // Only widen, never narrow: keep previously-missing buckets.
            const seen = new Set(missing.map((m: any) => `${m.gte}-${m.lte}`));
            for (const m of refreshed) {
                if (!seen.has(`${m.gte}-${m.lte}`)) missing.push(m);
            }
            missing.sort((a: any, b: any) => a.gte - b.gte);
            prune();
        }
    }
    const missingHours = missing.reduce((sum: number, m: any) => sum + m.hours, 0);
    const windowHours = valid ? Math.max(1, Math.round((lteMs - gteMs) / bucketMs)) : 1;
    return { reusable, missing, missingHours, windowHours, inputsValid: valid };
}

// ─── Shared progress output ───────────────────────────────────────────────────
// Both fetch modes (pool and feed windows) print the same per-window
// lines so the output is comparable: one line per cached/reused window and
// one line per executed range query.
function formatWindowLine(unit: string, index: number, total: number, gte: string, lte: string, detail = '') {
    return `  ${unit} ${index}/${total}: ${gte} → ${lte}${detail ? ` ${detail}` : ''}`;
}

/**
 * Per-range fetch budget shared by every cached candle fetcher (pool, book,
 * feed). Retries a failing range up to `attempts` times with linear backoff
 * and an optional per-attempt timeout (aborted via signal passed as the 4th
 * fetchRange argument — fetchers that ignore it simply get no abort).
 * Defaults (attempts 1, no timeout) preserve the old single-shot behavior.
 */
async function fetchRangeWithRetry(
    fetchRange: (gteIso: string, lteIso: string, window: any, signal?: AbortSignal) => Promise<any>,
    opts: {
        gte: string;
        lte: string;
        window: any;
        label: string;
        attempts?: number;
        backoffBaseMs?: number;
        timeoutMs?: number;
        onRetry?: (info: { attempt: number; attempts: number; backoffMs: number; error: any; gte: string; lte: string }) => void;
    }
) {
    const attempts = Number.isFinite(Number(opts.attempts)) && Number(opts.attempts) >= 1 ? Math.floor(Number(opts.attempts)) : 1;
    const backoffBaseMs = Number.isFinite(Number(opts.backoffBaseMs)) && Number(opts.backoffBaseMs) >= 0 ? Number(opts.backoffBaseMs) : 0;
    const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let signal: AbortSignal | undefined;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;
        const timeoutMessage = `${opts.label} timed out after ${Math.round(timeoutMs / 1000)}s`;
        if (timeoutMs > 0) {
            const controller = new AbortController();
            signal = controller.signal;
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort(new Error(timeoutMessage));
            }, timeoutMs);
        }
        try {
            const candles = await fetchRange(opts.gte, opts.lte, opts.window, signal);
            return { candles, attempts: attempt };
        } catch (err: any) {
            lastErr = timedOut && (err?.name === 'AbortError' || err?.message === timeoutMessage)
                ? new Error(timeoutMessage)
                : err;
            if (attempt < attempts) {
                const backoffMs = backoffBaseMs * attempt;
                try { opts.onRetry?.({ attempt, attempts, backoffMs, error: lastErr, gte: opts.gte, lte: opts.lte }); } catch (_) { /* logging must never fail the fetch */ }
                if (backoffMs > 0) await sleepMs(backoffMs);
            }
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    throw lastErr;
}

async function fetchRangeLogged(fetchRange: (gteIso: string, lteIso: string, window?: any, signal?: AbortSignal) => Promise<any[] | { candles: any[]; complete?: boolean }>, opts: { unit: string; index: number; total: number; gte: string; lte: string; note?: string; window?: any; retry?: { attempts?: number; backoffBaseMs?: number; timeoutMs?: number; onRetry?: (info: any) => void } }) {
    const startMs = Date.now();
    const label = `${opts.unit} ${opts.index}/${opts.total}`;
    const { candles: raw, attempts } = await fetchRangeWithRetry(fetchRange, {
        gte: opts.gte,
        lte: opts.lte,
        window: opts.window,
        label,
        attempts: opts.retry?.attempts,
        backoffBaseMs: opts.retry?.backoffBaseMs,
        timeoutMs: opts.retry?.timeoutMs,
        onRetry: opts.retry?.onRetry,
    });
    // A fetcher may return { candles, complete: false } for a partial result
    // (e.g. one swap direction failed). Partial candles are still merged
    // into this run's output, but the caller must not persist them as full
    // coverage — otherwise the missing side would never be re-queried.
    const complete = !Array.isArray(raw) && raw?.complete === false ? false : true;
    const candles = Array.isArray(raw) ? raw : (raw?.candles ?? []);
    const attemptNote = attempts > 1 ? ` (attempt ${attempts})` : '';
    const partialNote = complete ? '' : ' (partial — not cached)';
    const note = opts.note ? `${opts.note}` : '';
    console.log(formatWindowLine(opts.unit, opts.index, opts.total, opts.gte, opts.lte, `-> ${candles.length} candles (${((Date.now() - startMs) / 1000).toFixed(1)}s)${attemptNote}${partialNote}${note}`));
    return { candles, complete };
}

function higherVolumeWins(existing: any, incoming: any) {
    return incoming[5] > existing[5] ? incoming : existing;
}

function sortedCandles(byTs: Map<number, any>) {
    return [...byTs.values()].sort((a: any, b: any) => Number(a[0]) - Number(b[0]));
}

/**
 * Run windows with bucket-level reuse against month-shard storage. `windows`
 * entries are `{ index, gte, lte }` (1-based index, fetch-planning splits —
 * `chunkMonths` controls query batching only, never file layout). Returns
 * merged candles clipped to the requested windows.
 *
 * Fetch policy per window: exact reuse when nothing is missing, sub-range
 * queries merged over local when gaps are small (and `allowSubFetch`), else
 * one full-window fetch merged over local. Fresh data wins collisions by
 * volume/count, output is clamped to the window and sorted. A window whose
 * fetch reports partial (`{ candles, complete: false }`) is merged into
 * this run's output but NOT persisted, so the missing side is re-queried
 * on the next run instead of being baked in as gap-filled zeros.
 *
 * Persistence is per shard and write-on-change only: a shard file is
 * rewritten solely when it gains buckets or query coverage. Reuse-only runs
 * touch nothing on disk.
 */
async function runCachedWindows(opts: {
    windows: any[];
    outPath: any;
    requestKey: any;
    isMatch: (meta: any, requestKey: any) => boolean;
    metaForWindow: (window: any) => any;
    // A fetch may return either a candle array (complete) or
    // { candles, complete: false } for a partial result that must be merged
    // but NOT persisted (see fetchRangeLogged).
    fetchRange: (gteIso: string, lteIso: string, window: any, signal?: AbortSignal) => Promise<any[] | { candles: any[]; complete?: boolean }>;
    bucketMs: number;
    allowSubFetch?: boolean;
    // Planning clock: how old a gap must be before it counts as settled.
    // A TEST SEAM only — production always leaves it unset (Date.now()).
    nowMs?: number;
    // Shared per-range fetch budget (used by the LP fetcher; book/feed keep
    // the single-shot default). See fetchRangeWithRetry.
    fetchAttempts?: number;
    fetchBackoffBaseMs?: number;
    fetchTimeoutMs?: number;
    onFetchRetry?: (info: { attempt: number; attempts: number; backoffMs: number; error: any; gte: string; lte: string }) => void;
}) {
    const { windows, outPath, requestKey, isMatch, metaForWindow, fetchRange, bucketMs } = opts;
    const allowSubFetch = opts.allowSubFetch !== false;
    const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    const total = windows.length;
    const retry = {
        attempts: opts.fetchAttempts,
        backoffBaseMs: opts.fetchBackoffBaseMs,
        timeoutMs: opts.fetchTimeoutMs,
        onRetry: opts.onFetchRetry,
    };

    const bounds = windows.map((w: any) => ({
        gte: Date.parse(String(w.gte)),
        lte: Date.parse(String(w.lte)),
    }));
    const finiteBounds = bounds.every((b: any) => Number.isFinite(b.gte) && Number.isFinite(b.lte));
    const overall = finiteBounds && bounds.length > 0
        ? { gte: Math.min(...bounds.map((b: any) => b.gte)), lte: Math.max(...bounds.map((b: any) => b.lte)) }
        : null;

    // Scoped load: only shards overlapping the run are opened.
    const localCache = loadBucketCache(outPath, requestKey, isMatch, overall);
    if (localCache.files > 0) {
        console.log(`  Local cache: ${localCache.files} file(s), ${localCache.byTs.size} buckets — fetching only what is missing`);
    }

    // In-memory shard states for every month the run touches, seeded from
    // whatever shard files already exist.
    const shardStates = new Map<string, {
        key: string; file: string;
        candles: Map<number, any>;
        queried: QueriedRange[];
        pendingQueried: QueriedRange[];
    }>();
    if (overall) {
        for (const key of shardKeysForRange(overall.gte, overall.lte)) {
            const file = shardPathFor(outPath, key);
            const existing = localCache.shards.find((s: any) => s.shardKey === key);
            const candles = new Map<number, any>();
            if (existing) {
                for (const c of existing.candles) {
                    const ts = Number(c[0]);
                    if (Number.isFinite(ts)) candles.set(ts, c);
                }
            }
            shardStates.set(key, {
                key, file, candles,
                queried: unionQueriedRanges(existing?.queried ?? [], bucketMs),
                pendingQueried: [],
            });
        }
    }

    const noteCompletedWindow = (gteMs: number, lteMs: number, candles: any[], queried: QueriedRange[]) => {
        // Later windows plan against what earlier windows proved: fresh
        // buckets join the pool and fresh coverage joins the cover, so a
        // re-query inside one run never fetches the same span twice.
        // Only complete windows feed this — partial data stays in this
        // run's output and is re-queried next run.
        for (const c of candles) {
            if (!Array.isArray(c)) continue;
            const ts = Number(c[0]);
            if (!Number.isFinite(ts)) continue;
            const prev = localCache.byTs.get(ts);
            if (!prev || Number(c[5] || 0) > Number(prev[5] || 0)) localCache.byTs.set(ts, c);
        }
        if (queried.length > 0) {
            localCache.fileCover.push({ gte: gteMs, lte: lteMs, count: candles.length, queried });
        }
        // Fan window results out to the shards they fall in.
        for (const state of shardStates.values()) {
            const { start, end } = shardBoundsForKey(state.key);
            for (const c of candles) {
                const ts = Number(c[0]);
                if (!Number.isFinite(ts) || ts < start || ts >= end) continue;
                const prev = state.candles.get(ts);
                if (!prev || Number(c[5] || 0) > Number(prev[5] || 0)) state.candles.set(ts, c);
            }
            for (const q of queried) {
                const clipped = clipRangeTo(q, start, end);
                if (clipped) state.pendingQueried.push(clipped);
            }
        }
    };

    let merged: any[] = [];
    for (const windowEntry of windows) {
        const tag = formatWindowLine('Window', windowEntry.index, total, windowEntry.gte, windowEntry.lte);
        const gteMs = Date.parse(String(windowEntry.gte));
        const lteMs = Date.parse(String(windowEntry.lte));

        const plan = planWindowReuse(localCache, {
            gteMs, lteMs, bucketMs,
            isTail: windowEntry.index === total,
            allowSubFetch, nowMs,
        });
        const { reusable, missing, windowHours, inputsValid } = plan;
        // Gap clusters closer than GAP_MERGE_TOLERANCE_BUCKETS collapse into
        // one query, and the sub-range budget is spent on merged SPAN HOURS
        // rather than on the gap count: the old `missing.length <= 3` made one
        // extra 1-hour hole escalate an otherwise 2-hour refresh into a full
        // ~700-bucket window fetch.
        const subRanges = mergeGapRanges(missing, bucketMs, GAP_MERGE_TOLERANCE_BUCKETS);
        const subRangeHours = subRanges.reduce((sum: number, m: any) => sum + m.hours, 0);
        const reusableNote = reusable.length > 0 ? `, ${reusable.length} buckets local` : '';
        if (inputsValid && missing.length === 0 && (reusable.length > 0 || localCache.files > 0)) {
            console.log(`${tag} (reused ${reusable.length} local buckets, nothing missing)`);
            // Reuse is read-only: shard files already hold these buckets, so
            // nothing is rewritten.
            merged = merged.length === 0
                ? reusable
                : mergeCandles(merged, reusable, { onCollision: higherVolumeWins });
            continue;
        }

        let candles: any[];
        let queriedRanges: QueriedRange[] = [];
        // A partial sub-range makes the whole window partial: gap-filled
        // buckets from the surviving side would otherwise claim coverage
        // the failed side never earned, baking the skew into the cache.
        let windowComplete = true;
        if (allowSubFetch && reusable.length > 0 && subRanges.length > 0
            && subRangeHours <= windowHours * MAX_SUBFETCH_SPAN_RATIO
            && subRanges.length <= MAX_SUBFETCH_RANGES) {
            // Small gaps: query only the missing sub-ranges, merge over local.
            console.log(`${tag} (local cover${reusableNote}; fetching ${subRangeHours}h in ${subRanges.length} sub-range(s))`);
            let mergedLocal: any[] = reusable.slice();
            for (const m of subRanges) {
                // Extend lte past the final bucket start: the ES range is
                // inclusive and m.lte is a bucket *start*, so without this
                // the bucket's real trades are cut off and the gap-filler
                // freezes it as a zero-volume candle. Over-fetch is safe —
                // merged output is clamped to the window below.
                const part = await fetchRangeLogged(
                    fetchRange,
                    { unit: 'Window', index: windowEntry.index, total, gte: new Date(m.gte).toISOString(), lte: new Date(m.lte + bucketMs).toISOString(), window: windowEntry, retry },
                );
                if (!part.complete) windowComplete = false;
                mergedLocal = mergeCandles(mergedLocal, part.candles, { onCollision: higherVolumeWins });
                // Claimed coverage is the canonical missing range (a
                // conservative subset of what was actually queried with the
                // +1-bucket overlap), stamped per sub-range with the moment
                // THAT query returned — one shared stamp would date the first
                // sub-range to the end of the whole loop.
                queriedRanges.push({ gte: m.gte, lte: m.lte, at: Date.now() });
            }
            // Clamp to the window (drops the one-bucket over-fetch above).
            candles = mergedLocal.filter((c: any) => Number(c[0]) >= gteMs && Number(c[0]) <= lteMs);
        } else {
            if (reusable.length > 0) {
                console.log(`${tag} (local cover${reusableNote}; gap too large — full window fetch)`);
            }
            const fresh = await fetchRangeLogged(
                fetchRange,
                { unit: 'Window', index: windowEntry.index, total, gte: windowEntry.gte, lte: windowEntry.lte, window: windowEntry, retry },
            );
            if (!fresh.complete) windowComplete = false;
            candles = reusable.length > 0
                ? mergeCandles(reusable, fresh.candles, { onCollision: higherVolumeWins }).filter((c: any) => Number(c[0]) >= gteMs && Number(c[0]) <= lteMs).sort((a: any, b: any) => a[0] - b[0])
                : fresh.candles;
            // Full-window fetch. `at` is deliberately the WALL clock, never
            // `nowMs`: `at` answers "when did this query run", so stamping a
            // backdated test clock would certify old buckets as freshly
            // verified. That also means a backdated-window test sees those
            // buckets as already settled — a property tests must account for.
            queriedRanges = [{ gte: gteMs, lte: lteMs, at: Date.now() }];
        }
        if (windowComplete) {
            noteCompletedWindow(gteMs, lteMs, candles, queriedRanges);
        } else {
            console.log(`${tag} (partial — kept for this run, not cached; will re-query next run)`);
        }
        merged = merged.length === 0
            ? candles
            : mergeCandles(merged, candles, { onCollision: higherVolumeWins });
    }

    // Flush: rewrite only shards that gained buckets or coverage. Everything
    // else on disk is already current.
    if (overall) {
        const fetchedAt = new Date().toISOString();
        for (const state of shardStates.values()) {
            const { start, end } = shardBoundsForKey(state.key);
            // Fold every loaded bucket into its home shard. Presence on disk
            // already makes a bucket reusable, so this preserves the cache's
            // trust semantics when a shard is rewritten.
            for (const [ts, c] of localCache.byTs) {
                if (ts < start || ts >= end) continue;
                const prev = state.candles.get(ts);
                if (!prev || Number(c[5] || 0) > Number(prev[5] || 0)) state.candles.set(ts, c);
            }
            const before = sortedCandles(new Map(
                (localCache.shards.find((s: any) => s.shardKey === state.key)?.candles || [])
                    .filter((c: any) => Array.isArray(c) && Number.isFinite(Number(c[0])))
                    .map((c: any) => [Number(c[0]), c] as [number, any]),
            ));
            const after = sortedCandles(state.candles);
            const union = compactCoverage(unionQueriedRanges(state.queried.concat(state.pendingQueried), bucketMs), MAX_COVERAGE_SPANS);
            // Coverage counts as unchanged only when the recorded verification
            // times are current too: a re-query that returned identical candles
            // still moved the "verified as of" mark forward, and persisting
            // that is what lets the next run shrink its tail refresh.
            if (candlesEqual(before, after) && coverageSatisfied(state.queried, union)) continue;
            const synthWindow = {
                index: 0,
                gte: new Date(start).toISOString(),
                lte: new Date(end).toISOString(),
            };
            const meta = { ...metaForWindow(synthWindow), fetchedAt, queriedRanges: union };
            meta.timeRange = { gte: synthWindow.gte, lte: synthWindow.lte };
            meta.shard = state.key;
            delete meta.chunkIndex;
            persistCacheChunk(state.file, meta, after);
            state.queried = union;
            state.pendingQueried = [];
        }

    }
    return merged;
}

export {
    TAIL_REFRESH_HOURS,
    TAIL_SETTLE_LAG_MS,
    GAP_SETTLE_HORIZON_MS,
    GAP_MERGE_TOLERANCE_BUCKETS,
    MAX_SUBFETCH_RANGES,
    MAX_SUBFETCH_SPAN_RATIO,
    MAX_COVERAGE_SPANS,
    shardKeyForTimestamp,
    shardBoundsForKey,
    shardKeysForRange,
    shardPathFor,
    readCacheChunk,
    loadBucketCache,
    cachedCandlesInRange,
    unionQueriedRanges,
    compactCoverage,
    rangesCoveredBy,
    coverageSatisfied,
    verifiedAt,
    timestampMs,
    allQueriedRanges,
    settleCoverage,
    buildFetchWindowsFromRange,
    findMissingBucketRanges,
    mergeGapRanges,
    pruneImmutableGaps,
    persistCacheChunk,
    planWindowReuse,
    formatWindowLine,
    runCachedWindows,
};
export type { QueriedRange };
