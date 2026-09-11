'use strict';

function toIntervalLabel(intervalSeconds: any) {
    if (intervalSeconds % 86400 === 0) return `${intervalSeconds / 86400}d`;
    if (intervalSeconds % 3600 === 0) return `${intervalSeconds / 3600}h`;
    if (intervalSeconds % 60 === 0) return `${intervalSeconds / 60}m`;
    return `${intervalSeconds}s`;
}

/**
 * Filename-safe slug: lowercase, non-alphanumerics collapsed to a single
 * underscore, no leading/trailing underscores. Single home for the helper
 * previously copied into fetch_lp_data.ts, kibana_feed_source.ts,
 * fetch_book_data.ts and scripts/tv.ts.
 */
function slugPart(value: any) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';
}

export { toIntervalLabel, slugPart }

