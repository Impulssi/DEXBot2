
import fs from 'node:fs';
import path from 'node:path';
import { calculateAMA } from '../../market_adapter/core/strategies/ama';
import { generateHTML } from '../../market_adapter/lp_chart_core';
import { toIntervalLabel } from '../../market_adapter/interval_utils';
import { loadCandleFile } from '../math_utils';
import { MARKET_ADAPTER } from '../../modules/constants';
import { getStorage } from '../../modules/storage';
const { ensureDir } = getStorage();
import { PATHS } from '../../modules/paths';
'use strict';

/**
 * UNIFIED COMPARISON CHART GENERATOR — Self-contained analysis chart
 *
 * Reads a local LP candle JSON file (any format: flat array, {candles: [...]},
 * or {data: [...]}), computes AMA series, and writes an interactive HTML chart
 * via the shared lp_chart_core renderer.
 *
 * No Kibana fetch, no market_adapter runtime deps beyond the core renderer.
 *
 * Usage:
 *   tsx analysis/ama_fitting/generate_unified_comparison_chart.ts --data <file.json>
 *   tsx analysis/ama_fitting/generate_unified_comparison_chart.ts  (auto-discovers newest lp_pool_*.json)
 */



// ── Config ─────────────────────────────────────────────────────────────────────

const LP_DATA_DIR = PATHS.MARKET_ADAPTER.LP_DATA_DIR;
const CHARTS_DIR = PATHS.ANALYSIS.CHARTS_DIR;

const DEFAULT_COLORS = ['#26a69a', '#fb8c00', '#5c9ee6', '#ef5350'];
const DEFAULT_DASHES = ['dot', 'solid', 'dash', 'dashdot'];

function buildDefaultStrategies() {
    const presets = MARKET_ADAPTER.AMAS as Record<string, typeof MARKET_ADAPTER.AMAS.AMA1>;
    return Object.keys(presets).map((key, i) => ({
        name: presets[key].name || key,
        erPeriod: presets[key].erPeriod,
        fastPeriod: presets[key].fastPeriod,
        slowPeriod: presets[key].slowPeriod,
        color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
        dash: DEFAULT_DASHES[i % DEFAULT_DASHES.length],
    }));
}

const DEFAULT_STRATEGIES = buildDefaultStrategies();

// ── Data loading (self-contained, no lp_chart_runner dep) ──────────────────────

function findLatestLpDataFile() {
    if (!fs.existsSync(LP_DATA_DIR)) return null;
    const stack = [LP_DATA_DIR];
    const matches: { path: string; mtime: number }[] = [];
    while (stack.length > 0) {
        const dir = stack.pop();
        if (!dir) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { stack.push(full); continue; }
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            if (!entry.name.startsWith('lp_pool_')) continue;
            matches.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        }
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches.length > 0 ? matches[0].path : null;
}

function normalizeCandle(c, index) {
    if (Array.isArray(c)) {
        if (c.length < 5) throw new Error(`Invalid candle at index ${index}: need at least 5 entries`);
        return { timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] ?? 0 };
    }
    if (c && typeof c === 'object') {
        const { timestamp, open, high, low, close, volume = 0 } = c;
        if ([timestamp, open, high, low, close].some(v => v == null)) {
            throw new Error(`Invalid candle object at index ${index}`);
        }
        return { timestamp, open, high, low, close, volume };
    }
    throw new Error(`Unsupported candle format at index ${index}`);
}

function loadCandles(dataFile) {
    const resolved = path.resolve(dataFile);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

    const { candles, meta } = loadCandleFile(resolved);

    if (!Array.isArray(candles) || candles.length === 0) {
        throw new Error('No candles found in file');
    }

    const candleObjects = candles.map((c, i) => normalizeCandle(c, i));
    const candleArrays = candleObjects.map(c => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);

    return { dataFile: resolved, meta, candleObjects, candleArrays };
}

// ── Metrics ────────────────────────────────────────────────────────────────────

function calculateMetrics(amaValues, candles) {
    let maxDriftUp = 0, maxDriftDown = 0, areaAbove = 0, areaBelow = 0;
    const skip = Math.max(20, Math.floor(candles.length * 0.1));
    for (let i = skip; i < candles.length; i++) {
        const ama = amaValues[i];
        const driftUp = (candles[i].high - ama) / ama;
        const driftDown = (ama - candles[i].low) / ama;
        if (driftUp > maxDriftUp) maxDriftUp = driftUp;
        if (driftDown > maxDriftDown) maxDriftDown = driftDown;
        if (candles[i].high > ama) areaAbove += driftUp;
        if (candles[i].low < ama) areaBelow += driftDown;
    }
    return {
        maxDriftUp, maxDriftDown, areaAbove, areaBelow,
        totalArea: areaAbove + areaBelow,
        maxDistance: Math.max(maxDriftUp, maxDriftDown),
    };
}

// ── Output path ────────────────────────────────────────────────────────────────

function defaultChartPath(meta) {
    const intervalLabel = meta?.intervalSeconds
        ? toIntervalLabel(meta.intervalSeconds)
        : '1h';
    const suffix = meta?.pool
        ? `pool_${String(meta.pool).replace('1.19.', '')}`
        : `${meta?.assetA?.symbol || 'unknown'}_${meta?.assetB?.symbol || 'pair'}`;
    return path.join(CHARTS_DIR, `lp_chart_${suffix}_${intervalLabel}_UNIFIED_COMPARISON.html`);
}

// ── Help ───────────────────────────────────────────────────────────────────────

function showHelp() {
    console.log(`
Unified Comparison Chart Generator

Usage:
  tsx generate_unified_comparison_chart.ts [options]

Options:
  --data FILE     LP candle export JSON file
  --file FILE     Alias for --data
  --output FILE   Output HTML file
  --quiet         Suppress console output
  --help          Show this help

Notes:
  - If --data is omitted, the newest lp_pool_*.json under market_adapter/data/lp is used.
  - Accepts any candle JSON: flat [[ts,o,h,l,c,v],...], {candles: [...]}, or {data: [...]}.
  - Separate from Kibana fetching — use fetch_lp_candles.ts to pull data first.
`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
    const cfg: { dataFile: string | null; outFile: string | null; quiet: boolean; help: boolean } = {
        dataFile: null,
        outFile: null,
        quiet: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if ((arg === '--data' || arg === '--file') && argv[i + 1]) {
            cfg.dataFile = path.resolve(argv[++i]);
        } else if ((arg === '--output' || arg === '--out') && argv[i + 1]) {
            cfg.outFile = path.resolve(argv[++i]);
        } else if (arg === '--quiet') {
            cfg.quiet = true;
        } else if (arg === '--help' || arg === '-h') {
            cfg.help = true;
        }
    }
    return cfg;
}

function generateChart(options = {} as Record<string, any>) {
    const logger = options.logger ?? console;

    const dataFile = options.dataFile
        ? path.resolve(options.dataFile)
        : findLatestLpDataFile();
    if (!dataFile) {
        throw new Error(`No LP data file found. Use --data <path> or run fetch_lp_candles.ts first.`);
    }

    const strategies = Array.isArray(options.strategies) && options.strategies.length
        ? options.strategies
        : [...DEFAULT_STRATEGIES];

    const { meta, candleObjects, candleArrays } = loadCandles(dataFile);
    const closes = candleObjects.map(c => c.close);

    const enrichedMeta = {
        ...(meta || {}),
        assetA: meta?.assetA || { symbol: path.basename(dataFile, '.json') },
        assetB: meta?.assetB || { symbol: '' },
        intervalSeconds: meta?.intervalSeconds || 3600,
        fetchedAt: meta?.fetchedAt || new Date().toISOString(),
    };

    logger.log(`Data:        ${path.relative(process.cwd(), dataFile)} (${candleObjects.length} candles)`);

    const amaResults: any[] = [];
    logger.log('');
    for (const [index, strategy] of strategies.entries()) {
        const values = calculateAMA(closes, strategy);
        const metrics = calculateMetrics(values, candleObjects);
        amaResults.push({ ...strategy, lineWidth: index === 0 ? 2 : 1.5, values });

        logger.log(`${strategy.name}`);
        logger.log(`   ├─ Total Area:     ${metrics.totalArea.toFixed(2)}%`);
        logger.log(`   ├─ Max UP:         ${(metrics.maxDriftUp * 100).toFixed(2)}%`);
        logger.log(`   ├─ Max DOWN:       ${(metrics.maxDriftDown * 100).toFixed(2)}%`);
        logger.log(`   └─ Band Factor:    ${(metrics.maxDistance * 200).toFixed(2)}%\n`);
    }

    const outFile = options.outFile
        ? path.resolve(options.outFile)
        : defaultChartPath(enrichedMeta);

    logger.log(`Generating chart (${amaResults.length} AMAs)...`);
    const html = generateHTML(enrichedMeta, candleArrays, amaResults);
    ensureDir(path.dirname(outFile));
    fs.writeFileSync(outFile, html, 'utf8');

    logger.log(`\nChart saved: ${path.relative(process.cwd(), outFile)}`);
    logger.log(`Open:        file://${outFile}`);

    return { dataFile, outFile, amaResults, meta: enrichedMeta, candleArrays };
}

function run(argv = process.argv.slice(2)) {
    const { dataFile, outFile, quiet, help } = parseArgs(argv);
    if (help) { showHelp(); return; }

    if (!quiet) {
        console.log('════════════════════════════════════════════════');
        console.log(' Unified Comparison Chart Generator');
        console.log('════════════════════════════════════════════════');
        console.log('');
    }

    try {
        generateChart({
            dataFile,
            outFile,
            logger: quiet ? { log() {} } : console,
        });
    } catch (e: unknown) {
        console.error('Error:', (e as any)?.message ?? e);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    run();
}

export { DEFAULT_STRATEGIES, generateChart, parseArgs, run, showHelp }

