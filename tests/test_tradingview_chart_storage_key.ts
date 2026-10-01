const assert = require('assert');

console.log('Running tradingview chart storage-key tests');

const {
    generateHTML,
    resolveChartStorageKey,
    sanitizeStorageComponent,
    TRADINGVIEW_PREFS_KEY_PREFIX,
    TRADINGVIEW_SYNC_KEY,
} = require('../analysis/tradingview/tradingview_uplot_chart_generator');
const { MARKET_ADAPTER } = require('../modules/constants');

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
    try {
        fn();
        passed++;
    } catch (err: any) {
        failed++;
        console.error(`  FAIL: ${name}`);
        console.error(`    ${err && err.message ? err.message : err}`);
        if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
}

// ── sanitizeStorageComponent ──────────────────────────────────────
check('sanitize: primitives are preserved', () => {
    assert.strictEqual(sanitizeStorageComponent('1.19.133', 'x'), '1.19.133');
    assert.strictEqual(sanitizeStorageComponent(305, 'x'), '305');
});

check('sanitize: whitespace and punctuation collapse to underscores', () => {
    assert.strictEqual(sanitizeStorageComponent('  IOB XRP!!  ', 'x'), 'IOB_XRP');
    // Dashes and dots are valid in storage keys and are preserved.
    assert.strictEqual(sanitizeStorageComponent('1.19.133', 'x'), '1.19.133');
    assert.strictEqual(sanitizeStorageComponent('-a-b-', 'x'), '-a-b-');
});

check('sanitize: empty/null uses fallback', () => {
    assert.strictEqual(sanitizeStorageComponent(null, 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent(undefined, 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent('', 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent('   ', 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent('!!!', 'fb'), 'fb');
});

check('sanitize: plain objects use fallback (not "[object Object]")', () => {
    assert.strictEqual(sanitizeStorageComponent({}, 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent({ symbol: undefined, id: null }, 'fb'), 'fb');
    assert.strictEqual(sanitizeStorageComponent([], 'fb'), 'fb');
});

// ── resolveChartStorageKey ────────────────────────────────────────
check('key: namespaced prefix and sync constant', () => {
    assert.strictEqual(TRADINGVIEW_PREFS_KEY_PREFIX, 'dexbot2-tradingview-uplot-v3');
    assert.strictEqual(TRADINGVIEW_SYNC_KEY, 'dexbot2-tradingview-sync');
});

check('key: distinct per pool and pair, stable across calls', () => {
    const pairA = { pool: '1.19.133', assetA: { id: '1.3.5537', symbol: 'IOB.XRP' }, assetB: { id: '1.3.0', symbol: 'BTS' } };
    const pairB = { pool: '1.19.305', assetA: { id: '1.3.0', symbol: 'BTS' }, assetB: { id: '1.3.121', symbol: 'HONEST' } };
    const a1 = resolveChartStorageKey(pairA, 3600);
    const a2 = resolveChartStorageKey(pairA, 3600);
    const b = resolveChartStorageKey(pairB, 3600);
    assert.strictEqual(a1, a2);
    assert.notStrictEqual(a1, b);
    assert.strictEqual(a1, 'dexbot2-tradingview-uplot-v3:1.19.133:1.3.5537_1.3.0:3600');
});

check('key: same pair in different pools stays distinct', () => {
    const pair = { assetA: { id: '1.3.5537' }, assetB: { id: '1.3.0' } };
    const a = resolveChartStorageKey({ ...pair, pool: '1.19.133' }, 3600);
    const b = resolveChartStorageKey({ ...pair, pool: '1.19.305' }, 3600);
    assert.notStrictEqual(a, b);
});

check('key: interval participates in the key', () => {
    const meta = { assetA: { id: '1.3.0' }, assetB: { id: '1.3.121' } };
    assert.notStrictEqual(resolveChartStorageKey(meta, 3600), resolveChartStorageKey(meta, 14400));
});

check('key: non-positive/absent interval falls back to literal "base"', () => {
    const meta = { assetA: { id: '1.3.0' }, assetB: { id: '1.3.121' } };
    assert.ok(resolveChartStorageKey(meta, 0).endsWith(':base'));
    assert.ok(resolveChartStorageKey(meta, undefined).endsWith(':base'));
    assert.ok(resolveChartStorageKey(meta, -5).endsWith(':base'));
});

check('key: string assets and poolId alias are accepted', () => {
    const key = resolveChartStorageKey({ poolId: '1.19.9', assetA: 'BTS', assetB: 'HONEST' }, 3600);
    assert.strictEqual(key, 'dexbot2-tradingview-uplot-v3:1.19.9:BTS_HONEST:3600');
});

check('key: symbol used when id is absent', () => {
    const key = resolveChartStorageKey({ assetA: { symbol: 'IOB.XRP' }, assetB: { symbol: 'BTS' } }, 3600);
    assert.strictEqual(key, 'dexbot2-tradingview-uplot-v3:nipool:IOB.XRP_BTS:3600');
});

check('key: object asset without id/symbol uses fallback, not "object_Object"', () => {
    const key = resolveChartStorageKey({ assetA: {}, assetB: {} }, 3600);
    assert.strictEqual(key, 'dexbot2-tradingview-uplot-v3:nipool:assetA_assetB:3600');
});

check('key: empty meta produces a valid default key', () => {
    assert.strictEqual(resolveChartStorageKey(), 'dexbot2-tradingview-uplot-v3:nipool:assetA_assetB:base');
});

// ── Simulated band price-axis fit ─────────────────────────────────
check('fit: simulated band extension tracks the upper edge with max', () => {
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
        grid: { minPrice: '1.5x', maxPrice: '3x' },
        gridSim: { enabled: true, priceDeltaThresholdPercent: 1, slopeDeltaThresholdPercent: 0.0072, slopeEnabled: true },
    });
    assert.ok(html.includes('if (su > simMax) simMax = su;'), 'simMax must track the band upper bound');
    assert.ok(!html.includes('if (su < simMax) simMax = su;'), 'inverted simMax comparison must not return');
    assert.ok(html.includes('SIM_FIT_MAX_STRETCH'), 'the stretch guard must stay wired');
});

// ── Shared AMA-slope lookback window ──────────────────────────────
check('slope window: the band and the reset replay resolve one shared lookback', () => {
    const html = generateHTML({
        candles: [
            [1710000000000, 1, 1.1, 0.9, 1.02, 10],
            [1710003600000, 1.02, 1.2, 0.98, 1.08, 12],
            [1710007200000, 1.08, 1.22, 1.01, 1.15, 9],
        ],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
        gridSim: { enabled: true, lookbackBars: 32 },
    });
    assert.ok(html.includes('function resolveSlopeLookbackBars()'), 'the shared resolver must exist');
    assert.ok(
        html.includes('const lookback = resolveSlopeLookbackBars();'),
        'the range band must consume the shared resolver',
    );
    assert.ok(
        !html.includes('slopeCfg.lookbackBars'),
        'the band must not stay pinned to the constant while the replay uses the config',
    );
    assert.ok(
        html.includes('Object.assign({}, gridSimCfg, { warmupBars: warmupBars })'),
        'the replay must keep using its own already-resolved lookbackBars',
    );
});

check('slope window: a bot-configured lookback reaches the band through the payload', () => {
    const html = generateHTML({
        candles: [[1710000000000, 1, 1.1, 0.9, 1.02, 10]],
        meta: { assetA: { symbol: 'A' }, assetB: { symbol: 'B' } },
        gridSim: { enabled: true, lookbackBars: 32 },
    });
    const payload = JSON.parse(/<script id="payload"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]);
    assert.strictEqual(payload.gridSim.lookbackBars, 32, 'the config-resolved window must reach the page');
    assert.strictEqual(
        payload.rangeSlope.lookbackBars,
        MARKET_ADAPTER.DYNAMIC_WEIGHT_AMA_LOOKBACK_BARS,
        'the constant stays embedded as the fallback',
    );
});

if (failed > 0) {
    console.error(`tradingview chart storage-key tests FAILED: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`tradingview chart storage-key tests passed (${passed} checks)`);
