'use strict';

/**
 * Regime bilinear interpolation — canonical implementation shared by the live
 * regime gate (regime_gate.ts) and the browser-embedded dynamic-weight chart
 * script (injected via fn.toString()).
 *
 * Self-contained on purpose so the chart generator can inject this exact source
 * into generated HTML — do not add imports referenced from the function body.
 * Node-side defaults below mirror MARKET_ADAPTER.REGIME_TABLE /
 * HURST_ZONE_BAND / PE_NODES; callers may pass explicit hNodes/pNodes/table.
 */

function bilinearInterpolate(h: any, pe: any, regimeTable: any = null, opts: any = {}) {
    const table = regimeTable ?? [
        [1.0, 0.7, 0.3],
        [0.6, 0.4, 0.15],
        [0.3, 0.2, 0.05],
    ];
    const band = Number.isFinite(opts.hurstZoneBand) ? opts.hurstZoneBand : 0.05;
    const H_NODES = (Array.isArray(opts.hNodes) && opts.hNodes.length === 3 && opts.hNodes.every(Number.isFinite))
        ? opts.hNodes
        : [0.5 + band, 0.5, 0.5 - band];
    const PE_NODES = (Array.isArray(opts.peNodes) && opts.peNodes.length === 3 && opts.peNodes.every(Number.isFinite))
        ? opts.peNodes
        : [0.60, 0.725, 0.85];

    // --- Hurst axis (H_NODES decreasing) ---
    // Find which interval h falls in: row r0, r1 = r0+1, fraction tRow toward r1
    let r0, tRow;
    if (h >= H_NODES[0]) {
        r0 = 0; tRow = 0;                                           // at or above top node
    } else if (h <= H_NODES[2]) {
        r0 = 1; tRow = 1;                                           // at or below bottom node
    } else if (h >= H_NODES[1]) {
        r0 = 0; tRow = (H_NODES[0] - h) / (H_NODES[0] - H_NODES[1]); // between nodes 0 and 1
    } else {
        r0 = 1; tRow = (H_NODES[1] - h) / (H_NODES[1] - H_NODES[2]); // between nodes 1 and 2
    }
    const r1 = Math.min(2, r0 + 1);

    // --- PE axis (PE_NODES increasing) ---
    let c0, tCol;
    if (pe <= PE_NODES[0]) {
        c0 = 0; tCol = 0;
    } else if (pe >= PE_NODES[2]) {
        c0 = 1; tCol = 1;
    } else if (pe <= PE_NODES[1]) {
        c0 = 0; tCol = (pe - PE_NODES[0]) / (PE_NODES[1] - PE_NODES[0]);
    } else {
        c0 = 1; tCol = (pe - PE_NODES[1]) / (PE_NODES[2] - PE_NODES[1]);
    }
    const c1 = Math.min(2, c0 + 1);

    // --- Bilinear blend ---
    const v00 = table[r0][c0];
    const v01 = table[r0][c1];
    const v10 = table[r1][c0];
    const v11 = table[r1][c1];

    const top    = v00 * (1 - tCol) + v01 * tCol;
    const bottom = v10 * (1 - tCol) + v11 * tCol;
    return top * (1 - tRow) + bottom * tRow;
}

export { bilinearInterpolate }
