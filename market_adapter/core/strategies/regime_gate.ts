
import { HurstAnalyzer } from '../../../analysis/trend_detection/hurst_analyzer';
import { PermutationEntropyAnalyzer } from '../../../analysis/trend_detection/permutation_entropy_analyzer';
import { MARKET_ADAPTER } from '../../../modules/constants';
import { roundTo } from '../../../modules/utils/math_utils';
'use strict';

const HURST_CONFIG = MARKET_ADAPTER.HURST_CONFIG;
const PE_CONFIG = MARKET_ADAPTER.PE_CONFIG;

function resolveHNodes(hurstZoneBand = null) {
    const band = Number.isFinite(hurstZoneBand) ? hurstZoneBand : MARKET_ADAPTER.HURST_ZONE_BAND;
    return [0.5 + band!, 0.5, 0.5 - band!];
}

function resolvePeNodes(peNodes: any = null) {
    if (Array.isArray(peNodes) && peNodes.length === 3 && peNodes.every(Number.isFinite)) {
        return peNodes;
    }
    return MARKET_ADAPTER.PE_NODES;
}

function classifyHurstRegime(h: any, hurstZoneBand: any = null) {
    const [upper, , lower] = resolveHNodes(hurstZoneBand);
    if (h >= upper) return 'TRENDING';
    if (h <= lower) return 'MEAN_REVERTING';
    return 'RANDOM';
}

function classifyPeRegime(pe: any, peNodes: any = null) {
    const [low, , high] = resolvePeNodes(peNodes);
    if (pe < low) return 'STRUCTURED';
    if (pe > high) return 'NOISE';
    return 'MIXED';
}

/**
 * Bilinear interpolation over the 3×3 regime table.
 *
 * For a given (h, pe), find the enclosing cell in the node grid, compute the
 * fractional position within that cell, and blend the four corner values.
 * Inputs outside the node range are clamped to the table boundary.
 *
 * @param {number} h  - Hurst exponent [0, 1]
 * @param {number} pe - Normalized permutation entropy [0, 1]
 * @param {Array}  [regimeTable] - Optional override for regime table
 * @param {Object} [opts]        - Optional threshold overrides for interpolation
 * @param {number} [opts.hurstZoneBand] – Override Hurst neutral-zone width
 * @param {Array}  [opts.peNodes]       – Override entropy thresholds
 * @returns {number}  - Interpolated multiplier
 */
function bilinearInterpolate(h: any, pe: any, regimeTable: any = null, opts: any = {}) {
    const table = regimeTable ?? MARKET_ADAPTER.REGIME_TABLE;
    const H_NODES = resolveHNodes(opts.hurstZoneBand);
    const PE_NODES = resolvePeNodes(opts.peNodes);
    // --- Hurst axis (H_NODES derived from HURST_ZONE_BAND, decreasing) ---
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

    // --- PE axis (PE_NODES from constants, increasing) ---
    // Find which interval pe falls in: col c0, c1 = c0+1, fraction tCol toward c1
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

/**
 * Compute the Hurst+PE regime multiplier from a price series.
 *
 * Feeds all prices through HurstAnalyzer and PermutationEntropyAnalyzer,
 * then bilinear-interpolates the regime table to produce a multiplier that
 * gates the AMA slope offset in production weight computation.
 *
 * @param {number[]} closes          - Full close price series (same array used for AMA)
 * @param {Object}   [opts]
 * @param {number}   [opts.regimeSensitivity=1.0] - Exponent on the base multiplier (0=off, 1=default)
 * @param {Array}    [opts.regimeTable]           - Custom 3x3 regime multiplier table
 * @param {number}   [opts.hurstZoneBand]         - Override Hurst neutral-zone width
 * @param {Array}    [opts.peNodes]               - Override entropy thresholds
 * @param {Object}   [opts.hurstConfig]           - Override for HurstAnalyzer config
 * @param {Object}   [opts.peConfig]              - Override for PermutationEntropyAnalyzer config
 * @returns {{ multiplier: number, hurst: number|null, pe: number|null,
 *             hurstRegime: string|null, peRegime: string|null, isReady: boolean,
 *             series: number[] }}
 */
function computeRegimeMultiplier(closes: any, opts: any = {}) {
    const sensitivity = Number.isFinite(opts.regimeSensitivity) ? opts.regimeSensitivity : 1.0;
    const regimeTable = opts.regimeTable ?? null;
    const hurstZoneBand = Number.isFinite(opts.hurstZoneBand) ? opts.hurstZoneBand : null;
    const peNodes = Array.isArray(opts.peNodes) ? opts.peNodes : null;
    const hurstCfg = opts.hurstConfig ?? HURST_CONFIG;
    const peCfg    = opts.peConfig    ?? PE_CONFIG;

    const notReady = {
        multiplier: 1.0,
        hurst: null,
        pe: null,
        hurstRegime: null,
        peRegime: null,
        isReady: false,
        series: [],
    };

    if (!Array.isArray(closes) || closes.length === 0) return notReady;

    const hurst = new HurstAnalyzer(hurstCfg);
    const pe    = new PermutationEntropyAnalyzer(peCfg);

    let hurstResult: any = null;
    let peResult: any    = null;
    const series = new Array(closes.length).fill(1.0);

    for (let i = 0; i < closes.length; i++) {
        const price = closes[i];
        if (!Number.isFinite(price) || price <= 0) continue;
        try {
            hurstResult = hurst.update(price);
            peResult    = pe.update(price);
            if (hurstResult?.isReady && peResult?.isReady) {
                const h  = hurstResult.hurst;
                const ne = peResult.normalizedEntropy;
                const baseMult = bilinearInterpolate(h, ne, regimeTable, { hurstZoneBand, peNodes });
                const rawMult = sensitivity === 1.0 ? baseMult : Math.pow(baseMult, sensitivity);
                series[i] = Math.min(rawMult, 1.0);
            }
        } catch (_: any) {
            // skip invalid prices
        }
    }

    if (!hurstResult?.isReady || !peResult?.isReady) return notReady;

    const h  = hurstResult.hurst;
    const ne = peResult.normalizedEntropy;

    const baseMult  = bilinearInterpolate(h, ne, regimeTable, { hurstZoneBand, peNodes });
    // Clamp to 1.0 max: regime only dampens, never amplifies
    const rawMult   = sensitivity === 1.0 ? baseMult : Math.pow(baseMult, sensitivity);
    const finalMult = Math.min(rawMult, 1.0);

    return {
        multiplier:  roundTo(finalMult, 1000),
        hurst:       h,
        pe:          roundTo(ne, 10000),
        hurstRegime: classifyHurstRegime(h, hurstZoneBand),
        peRegime:    classifyPeRegime(ne, peNodes),
        isReady:     true,
        series:      series.map((value) => roundTo(value, 1000)),
    };
}

export { computeRegimeMultiplier, bilinearInterpolate, classifyHurstRegime, classifyPeRegime, resolveHNodes, resolvePeNodes }

