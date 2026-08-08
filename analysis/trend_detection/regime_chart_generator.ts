
import { escapeHtml, serializeJsonForScript, toEpochSeconds, UPLOT_SHARED_SCRIPT } from '../chart_utils.js';
'use strict';


/**
 * Build background-shading segments for a value array.
 * greenFn/redFn return true when the value falls in that zone.
 * Returns an array of { from, to, color } objects (null-color segments omitted).
 */
function buildSegments(values, greenFn, redFn) {
    const segments: { from: number; to: number; color: string }[] = [];
    let start = 0, color: string | null = null;

    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        let next: string | null = null;
        if (v != null) {
            if (greenFn(v))     next = 'rgba(46,160,67,0.13)';
            else if (redFn(v))  next = 'rgba(248,81,73,0.13)';
        }
        if (next !== color) {
            if (color !== null) segments.push({ from: start, to: i - 1, color });
            color = next;
            start = i;
        }
    }
    if (color !== null) segments.push({ from: start, to: values.length - 1, color });
    return segments;
}

function generateRegimeHTML(data, title = 'Regime Analysis') {
    const results = data.allResults || [];
    if (results.length === 0) throw new Error('No analysis results in input');

    const hurstConfig = data.hurstConfig || {};
    const peConfig    = data.peConfig    || {};

    const interval = results.length > 1
        ? (new Date(results[1].timestamp).getTime() - new Date(results[0].timestamp).getTime()) / 1000
        : 3600;

    const dates      = results.map((r, i) => toEpochSeconds(r.timestamp, i));
    const prices     = results.map((r)    => r.price);
    const ama3Prices = results.map((r)    => r.ama3Price ?? null);
    const hurstArr   = results.map((r)    => r.hurstReady  ? r.hurst             : null);
    const peArr      = results.map((r)    => r.peReady     ? r.normalizedEntropy : null);

    const realBarCount = results.length;

    // Extend arrays with null padding so the last real bar is not glued to chart right edge
    const lastDate = dates[dates.length - 1];
    for (let i = 1; i <= 80; i++) {
        dates.push(lastDate + i * interval);
        prices.push(null);
        ama3Prices.push(null);
        hurstArr.push(null);
        peArr.push(null);
    }

    // Background shading segments (server-side, passed to browser via JSON payload)
    const hurstSegments = buildSegments(hurstArr.slice(0, realBarCount), v => v > 0.55, v => v < 0.45);
    const peSegments    = buildSegments(peArr.slice(0, realBarCount),    v => v < 0.60, v => v > 0.85);

    const payload = {
        dates, prices, ama3Prices, hurstArr, peArr,
        hurstSegments, peSegments,
        realBarCount,
        hurstWindow: hurstConfig.window ?? 128,
        peM:         peConfig.m         ?? 5,
        peWindow:    peConfig.window    ?? 100,
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="../uplot/uPlot.min.css">
    <script src="../uplot/uPlot.iife.min.js"></script>
    <style>
        * { box-sizing: border-box; }
        body { background: #0b0e14; color: #e6edf3; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; overflow: hidden; }
        #header { padding: 10px 20px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; justify-content: space-between; height: 45px; z-index: 100; }
        #panels { display: flex; flex-direction: column; height: calc(100vh - 45px); width: 100vw; }
        #price-panel  { flex: 0 0 34%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #hurst-panel  { flex: 0 0 28%; min-height: 0; position: relative; border-bottom: 1px solid #30363d; }
        #pe-panel     { flex: 1 1 0;   min-height: 0; position: relative; }
        .uplot { background: #0b0e14; }
        .legend { position: absolute; top: 8px; left: 12px; font-size: 11px; pointer-events: none; z-index: 10; display: flex; gap: 14px; color: #adbac7; white-space: nowrap; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 5px; }
        .dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
        .u-cursor-x { border-left: 1px dashed rgba(255,255,255,0.3) !important; }
        .u-cursor-y { border-top:  1px dashed rgba(255,255,255,0.3) !important; display: none; }
        .is-hovered .u-cursor-y { display: block; }
        .section-label { position: absolute; top: 8px; right: 12px; font-size: 9px; color: #30363d; text-transform: uppercase; letter-spacing: 1px; z-index: 10; pointer-events: none; }
        .badge { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 10px; font-weight: bold; }
        .badge-green  { background: rgba(46,160,67,0.25); color: #3fb950; }
        .badge-red    { background: rgba(248,81,73,0.25); color: #ff7b72; }
        .badge-grey   { background: rgba(110,118,129,0.2); color: #adbac7; }
    </style>
</head>
<body>
    <div id="header">
        <div style="font-weight:bold;color:#fff;">${escapeHtml(title)}</div>
        <div style="display:flex;align-items:center;gap:16px;">
            <span style="font-size:10px;color:#8b949e;font-family:monospace;">
                Hurst: window=${escapeHtml(String(hurstConfig.window ?? 128))}&thinsp;bars &middot; scales=[${escapeHtml((hurstConfig.scales ?? [8,16,32,64]).join(','))}]
                &nbsp;&nbsp;|&nbsp;&nbsp;
                PE: m=${escapeHtml(String(peConfig.m ?? 5))} &middot; window=${escapeHtml(String(peConfig.window ?? 100))}&thinsp;bars
            </span>
            <span style="font-size:11px;color:#adbac7;text-transform:uppercase;">
                H&gt;0.55=trend &middot; H&lt;0.45=revert &middot; PE&lt;0.60=structured &middot; PE&gt;0.85=noise
                &nbsp;&nbsp;|&nbsp;&nbsp; Scroll &middot; Drag &middot; Ctrl+0
            </span>
        </div>
    </div>

    <div id="panels">
        <div id="price-panel">
            <div class="section-label">PRICE (LOG)</div>
            <div class="legend">
                <div class="legend-item" style="color:#555;"><span id="l-date">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#58a6ff;"></div>Price: <span id="l-price" style="font-weight:bold;color:#58a6ff;">-</span></div>
                <div class="legend-item"><div class="dot" style="background:#e3b341;"></div>AMA3: <span id="l-ama3" style="color:#e3b341;">-</span></div>
            </div>
            <div id="price-chart"></div>
        </div>
        <div id="hurst-panel">
            <div class="section-label">HURST EXPONENT</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#4dc3ff;"></div>H: <span id="l-hurst" style="font-weight:bold;color:#4dc3ff;">-</span></div>
                <div class="legend-item">Regime: <span id="l-hurst-regime" style="font-weight:bold;">-</span></div>
                <div class="legend-item" style="color:#555;font-size:10px;">window=${escapeHtml(String(hurstConfig.window ?? 128))} bars</div>
            </div>
            <div id="hurst-chart"></div>
        </div>
        <div id="pe-panel">
            <div class="section-label">PERMUTATION ENTROPY (NORM.)</div>
            <div class="legend">
                <div class="legend-item"><div class="dot" style="background:#d2a8ff;"></div>PE: <span id="l-pe" style="font-weight:bold;color:#d2a8ff;">-</span></div>
                <div class="legend-item">Regime: <span id="l-pe-regime" style="font-weight:bold;">-</span></div>
                <div class="legend-item" style="color:#555;font-size:10px;">m=${escapeHtml(String(peConfig.m ?? 5))}, window=${escapeHtml(String(peConfig.window ?? 100))} bars</div>
            </div>
            <div id="pe-chart"></div>
        </div>
    </div>

    <script id="payload" type="application/json">${serializeJsonForScript(payload)}</script>

    <script>
    (function () {
        const data = JSON.parse(document.getElementById('payload').textContent);
        const SYNC_KEY = 'regime-v1';
        const Y_AXIS_SIZE = 58;
        const X_AXIS_CFG = { show: false, stroke: '#545d68', grid: { stroke: '#1c2128' }, ticks: { stroke: '#30363d', width: 1 }, size: 28, font: '11px Segoe UI, sans-serif' };
        const cursorCfg  = { sync: { key: SYNC_KEY, setSeries: false, scales: ['x', null] }, drag: { x: false, y: false, setScale: false }, focus: { prox: -1 }, show: true, x: true, y: true, points: { show: false } };

        // ── helpers ──────────────────────────────────────────────────────────
        function fmtPrice(v) {
            if (v == null) return '-';
            return v < 0.01 ? v.toPrecision(4) : v < 100 ? v.toFixed(4) : v.toFixed(2);
        }
        function fmtH(v)  { return v == null ? '-' : v.toFixed(3); }
        function fmtPE(v) { return v == null ? '-' : v.toFixed(3); }
        function fmtDate(ts) {
            if (ts == null) return '-';
            const d = new Date(ts * 1000);
            return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                 + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        }

        function hurstRegimeLabel(v) {
            if (v == null) return '<span class="badge badge-grey">-</span>';
            if (v > 0.55) return '<span class="badge badge-green">TRENDING</span>';
            if (v < 0.45) return '<span class="badge badge-red">MEAN REV</span>';
            return '<span class="badge badge-grey">RANDOM</span>';
        }
        function peRegimeLabel(v) {
            if (v == null) return '<span class="badge badge-grey">-</span>';
            if (v < 0.60) return '<span class="badge badge-green">STRUCTURED</span>';
            if (v > 0.85) return '<span class="badge badge-red">NOISE</span>';
            return '<span class="badge badge-grey">MIXED</span>';
        }

        // ── background-shading + reference-lines draw hook ───────────────────
        // Uses valToPos(..., true) = CSS pixels, matching how u.bbox works in draw hooks.
        function makeBgHook(segments, refLines, yScaleKey) {
            return (u) => {
                const { ctx, bbox } = u;
                ctx.save();
                ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();

                for (const seg of segments) {
                    if (!seg.color) continue;
                    const x0 = u.valToPos(data.dates[seg.from], 'x', true);
                    const toIdx = Math.min(seg.to + 1, data.dates.length - 1);
                    const x1 = u.valToPos(data.dates[toIdx], 'x', true);
                    ctx.fillStyle = seg.color;
                    ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
                }

                for (const rl of refLines) {
                    const yPos = u.valToPos(rl.y, yScaleKey, true);
                    ctx.strokeStyle = rl.color;
                    ctx.lineWidth = 1;
                    ctx.setLineDash([4, 4]);
                    ctx.beginPath();
                    ctx.moveTo(bbox.left, yPos);
                    ctx.lineTo(bbox.left + bbox.width, yPos);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                ctx.restore();
            };
        }

        function yAxis(scaleKey) {
            return { side: 1, scale: scaleKey, stroke: '#545d68', grid: { stroke: '#1c2128', dash: [4, 4] }, ticks: { stroke: '#30363d', width: 1 }, size: Y_AXIS_SIZE, font: '11px Segoe UI, sans-serif' };
        }

        // ── x-range sync (shared across all panels) ─────────────────────────
        const xMin = data.dates[0];
        const xMax = data.dates[data.dates.length - 1];
        let pendingRange = null, pendingRangeRaf = 0;
        let priceChart, hurstChart, peChart;
        let charts;

        ${UPLOT_SHARED_SCRIPT}

        // ── chart instances ──────────────────────────────────────────────────

        const hurstRefLines = [
            { y: 0.55, color: 'rgba(46,160,67,0.5)'   },
            { y: 0.50, color: 'rgba(110,118,129,0.3)'  },
            { y: 0.45, color: 'rgba(248,81,73,0.5)'    },
        ];
        const peRefLines = [
            { y: 0.85, color: 'rgba(248,81,73,0.5)'  },
            { y: 0.60, color: 'rgba(46,160,67,0.5)'  },
        ];

        const hurstBgFn = makeBgHook(data.hurstSegments, hurstRefLines, 'h');
        const peBgFn    = makeBgHook(data.peSegments,    peRefLines,    'p');

        function init() {
            const priceEl = document.getElementById('price-panel');
            const hurstEl = document.getElementById('hurst-panel');
            const peEl    = document.getElementById('pe-panel');

            priceChart = new uPlot({
                width: priceEl.offsetWidth, height: priceEl.offsetHeight,
                padding: [4, 4, 2, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, y: { auto: true, distr: 3, log: 10, range: (u, min, max) => [min * 0.95, max * 1.05] } },
                series: [
                    { label: 'Time' },
                    { label: 'Price', stroke: '#58a6ff', width: 1.5, scale: 'y', points: { show: false } },
                    { label: 'AMA3',  stroke: '#e3b341', width: 1,   scale: 'y', points: { show: false } },
                ],
                axes: [
                    X_AXIS_CFG,
                    { ...yAxis('y'), values: (u, v) => v.map(x => x != null ? fmtPrice(x) : '') },
                ],
                cursor: cursorCfg,
                hooks: { draw: [(u) => { updateLegend(u.cursor.idx); }] },
            }, [data.dates, data.prices, data.ama3Prices], document.getElementById('price-chart'));

            hurstChart = new uPlot({
                width: hurstEl.offsetWidth, height: hurstEl.offsetHeight,
                padding: [4, 4, 2, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, h: { auto: true } },
                series: [
                    { label: 'Time' },
                    { label: 'Hurst', stroke: '#4dc3ff', width: 1.5, scale: 'h', points: { show: false } },
                ],
                axes: [
                    X_AXIS_CFG,
                    { ...yAxis('h'), values: (u, v) => v.map(x => x != null ? x.toFixed(2) : '') },
                ],
                cursor: cursorCfg,
                hooks: { draw: [hurstBgFn] },
            }, [data.dates, data.hurstArr], document.getElementById('hurst-chart'));

            peChart = new uPlot({
                width: peEl.offsetWidth, height: peEl.offsetHeight,
                padding: [4, 4, 4, 4], select: { show: false }, legend: { show: false },
                scales: { x: { time: true }, p: { range: [0, 1] } },
                series: [
                    { label: 'Time' },
                    { label: 'PE', stroke: '#d2a8ff', width: 1.5, scale: 'p', points: { show: false } },
                ],
                axes: [
                    { ...X_AXIS_CFG, show: true },
                    { ...yAxis('p'), values: (u, v) => v.map(x => x != null ? x.toFixed(2) : '') },
                ],
                cursor: cursorCfg,
                hooks: { draw: [peBgFn] },
            }, [data.dates, data.peArr], document.getElementById('pe-chart'));

            charts = [priceChart, hurstChart, peChart];
            let leavePending = null;
            charts.forEach(chart => {
                chart.over.addEventListener('mousemove', () => {
                    if (leavePending !== null) { clearTimeout(leavePending); leavePending = null; }
                    updateLegend(chart.cursor.idx);
                });
                chart.over.addEventListener('mouseleave', () => {
                    leavePending = setTimeout(() => { leavePending = null; updateLegend(null); }, 60);
                });
                chart.root.addEventListener('mouseenter', () => chart.root.classList.add('is-hovered'));
                chart.root.addEventListener('mouseleave', () => chart.root.classList.remove('is-hovered'));
                bindWheelZoom(chart);
                bindPan(chart);
            });
        }

        // ── cursor legend update ─────────────────────────────────────────────
        function updateLegend(idx) {
            if (idx == null || idx >= data.realBarCount) return;
            document.getElementById('l-date').textContent  = fmtDate(data.dates[idx]);
            document.getElementById('l-price').textContent = fmtPrice(data.prices[idx]);
            document.getElementById('l-ama3').textContent  = fmtPrice(data.ama3Prices[idx]);
            document.getElementById('l-hurst').textContent = fmtH(data.hurstArr[idx]);
            document.getElementById('l-pe').textContent    = fmtPE(data.peArr[idx]);
            document.getElementById('l-hurst-regime').innerHTML = hurstRegimeLabel(data.hurstArr[idx]);
            document.getElementById('l-pe-regime').innerHTML    = peRegimeLabel(data.peArr[idx]);
        }

        // ── resize ───────────────────────────────────────────────────────────
        function sizeCharts() {
            if (!priceChart || !hurstChart || !peChart) return;
            [[priceChart, 'price-panel'], [hurstChart, 'hurst-panel'], [peChart, 'pe-panel']].forEach(([chart, id]) => {
                const el = document.getElementById(id);
                chart.setSize({ width: el.offsetWidth, height: el.offsetHeight });
            });
        }

        window.addEventListener('resize', sizeCharts);
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === '0') syncXRange(xMin, xMax);
        });

        init();
        requestAnimationFrame(() => requestAnimationFrame(() => sizeCharts()));

    })();
    </script>
</body>
</html>`;
}

export { generateRegimeHTML }

