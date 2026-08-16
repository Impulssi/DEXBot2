
import { HurstAnalyzer } from '../signals/hurst_analyzer.js';
import { PermutationEntropyAnalyzer } from '../signals/permutation_entropy_analyzer.js';
import { MARKET_ADAPTER } from '../../../modules/constants.js';
import { roundTo } from '../../../modules/utils/math_utils.js';
import { bilinearInterpolate } from './regime_interp.js';
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
 * Compute the Hurst+PE regime multiplier from a price series.
 *
 * Bilinear interpolation over the 3×3 regime table is delegated to the
 * canonical pure implementation in strategies/regime_interp.ts (shared with the
 * browser-embedded chart scripts).
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
    const regimeTable = opts.regimeTable ?? MARKET_ADAPTER.REGIME_TABLE;
    const hurstZoneBand = Number.isFinite(opts.hurstZoneBand) ? opts.hurstZoneBand : MARKET_ADAPTER.HURST_ZONE_BAND;
    const peNodes = Array.isArray(opts.peNodes) ? opts.peNodes : MARKET_ADAPTER.PE_NODES;
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

