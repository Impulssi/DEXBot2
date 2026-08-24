
'use strict';

/**
 * Shared CSS fragments for uPlot chart generators.
 *
 * All functions return raw CSS strings for interpolation into HTML template
 * literals. Consumers compose these fragments inside their `<style>` blocks.
 */

function baseResetCSS(): string {
    return `* { box-sizing: border-box; }
        body { background: #0b0e14; color: #d1d5db; font-family: 'Segoe UI', sans-serif; margin: 0; padding: 0; overflow: hidden; }`;
}

function headerCSS(height = 45): string {
    return `#header { padding: 10px 20px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; justify-content: space-between; height: ${height}px; z-index: 100; }`;
}

function panelsCSS(headerHeight = 45): string {
    return `#panels { display: flex; flex-direction: column; height: calc(100vh - ${headerHeight}px); width: 100vw; }`;
}

function uplotBgCSS(): string {
    return `.uplot { background: #0b0e14; }`;
}

function dotCSS(): string {
    return `.dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }`;
}

function cursorCSS(): string {
    return `.u-cursor-x { border-left: 1px dashed rgba(255,255,255,0.3) !important; }
        .u-cursor-y { border-top:  1px dashed rgba(255,255,255,0.3) !important; display: none; }
        .is-hovered .u-cursor-y { display: block; }`;
}

function sectionLabelCSS(): string {
    return `.section-label { position: absolute; top: 8px; right: 12px; font-size: 9px; color: #30363d; text-transform: uppercase; letter-spacing: 1px; z-index: 10; pointer-events: none; }`;
}

function legendCSS(): string {
    return `.legend { position: absolute; top: 8px; left: 12px; font-size: 11px; pointer-events: none; z-index: 10; display: flex; gap: 14px; color: #adbac7; white-space: nowrap; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 5px; }`;
}

function sharedChartCSS(): string {
    return [
        baseResetCSS(),
        headerCSS(),
        panelsCSS(),
        uplotBgCSS(),
        dotCSS(),
        cursorCSS(),
        sectionLabelCSS(),
        legendCSS(),
    ].join('\n        ');
}

export { sharedChartCSS }
