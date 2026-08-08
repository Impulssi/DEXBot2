
import { MARKET_ADAPTER } from '../../modules/constants.js';
import { roundTo } from '../../modules/utils/math_utils.js';
'use strict';


/**
 * Permutation Entropy Analyzer
 *
 * Measures market disorder by counting ordinal patterns in a rolling price window.
 * For each position i, the ordinal pattern is the rank-order of the m consecutive
 * values [price[i], price[i+delay], ..., price[i+(m-1)*delay]]. Shannon entropy
 * over all observed patterns, normalized by log(m!), gives PE ∈ [0, 1].
 *
 * Normalized PE ≈ 0: price movement is highly ordered (strong structure; edge exists).
 * Normalized PE ≈ 1: maximum disorder (noise; no reliable edge).
 *
 * Threshold guidance: PE < PE_NODES[0] = structured (signals trustworthy);
 *                     PE > PE_NODES[2] = noise (suppress or gate signals).
 *                     Thresholds are defined in MARKET_ADAPTER.PE_NODES in constants.ts.
 *
 * Default: m=5 (5!=120 patterns), window=100 bars.
 */

/**
 * Compute the ordinal pattern key for m values starting at prices[start],
 * stepping by `delay` positions.  Returns a string of digit-chars encoding
 * the rank order (stable sort, ties broken by original index).
 */
function ordinalPattern(prices: number[], start: number, m: number, delay: number): string {
    const vals = new Array(m);
    for (let j = 0; j < m; j++) vals[j] = { v: prices[start + j * delay], j };
    vals.sort((a, b) => a.v !== b.v ? a.v - b.v : a.j - b.j);
    let key = '';
    for (let j = 0; j < m; j++) key += vals[j].j;
    return key;
}

interface PermutationEntropyAnalysis {
    isReady: boolean;
    entropy: number;
    normalizedEntropy: number;
    regime: string;
    regimeStrength: number;
    updateCount: number;
}

class PermutationEntropyAnalyzer {
    m: number;
    delay: number;
    window: number;
    _bufSize: number;
    _maxEntropy: number;
    _prices: number[];
    _updateCount: number;
    entropy: number;
    normalizedEntropy: number;
    isReady: boolean;

    /**
     * @param {Object} config
     * @param {number} config.m      - Embedding dimension (default 5; range 3–7)
     * @param {number} config.delay  - Time delay between elements (default 1)
     * @param {number} config.window - Rolling window of ordinal patterns (default 100)
     */
    constructor(config: Record<string, number> = {}) {
        this.m      = config.m      ?? 5;
        this.delay  = config.delay  ?? 1;
        this.window = config.window ?? 100;

        // Buffer must hold `window` patterns; each pattern spans (m-1)*delay+1 prices.
        this._bufSize = this.window + (this.m - 1) * this.delay;

        let f = 1;
        for (let i = 2; i <= this.m; i++) f *= i;
        this._maxEntropy = Math.log(f); // log(m!)

        this._prices = [];
        this._updateCount = 0;
        this.entropy = 0;
        this.normalizedEntropy = 0;
        this.isReady = false;
    }

    /**
     * Feed a new price and return analysis.
     * @param {number} price
     * @returns {Object} { isReady, entropy, normalizedEntropy, regime, regimeStrength, updateCount }
     */
    update(price: number): PermutationEntropyAnalysis {
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('price must be a positive finite number');
        }
        this._prices.push(price);
        if (this._prices.length > this._bufSize) this._prices.shift();
        this._updateCount++;

        if (this._prices.length < this._bufSize) {
            this.isReady = false;
            return this.getAnalysis();
        }

        // Count ordinal patterns across the rolling window
        const counts = new Map();
        // this._prices.length === this._bufSize, numPatterns === this.window
        const numPatterns = this._prices.length - (this.m - 1) * this.delay;

        for (let i = 0; i < numPatterns; i++) {
            const key = ordinalPattern(this._prices, i, this.m, this.delay);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        // Shannon entropy: H = -Σ p_k * log(p_k)
        let entropy = 0;
        for (const count of counts.values()) {
            const p = count / numPatterns;
            entropy -= p * Math.log(p);
        }

        this.entropy = entropy;
        this.normalizedEntropy = this._maxEntropy > 0 ? entropy / this._maxEntropy : 0;
        this.isReady = true;
        return this.getAnalysis();
    }

    getAnalysis(): PermutationEntropyAnalysis {
        const ne = this.normalizedEntropy;
        const [PE_LOW, , PE_HIGH] = MARKET_ADAPTER.PE_NODES as [number, number, number];
        let regime: string, regimeStrength: number;
        if (ne < PE_LOW) {
            regime = 'STRUCTURED';
            regimeStrength = Math.min(1, (PE_LOW - ne) / PE_LOW);
        } else if (ne > PE_HIGH) {
            regime = 'NOISE';
            regimeStrength = Math.min(1, (ne - PE_HIGH) / (1 - PE_HIGH));
        } else {
            regime = 'MIXED';
            regimeStrength = 0;
        }

        return {
            isReady: this.isReady,
            entropy: roundTo(this.entropy, 10000),
            normalizedEntropy: roundTo(this.normalizedEntropy, 10000),
            regime,
            regimeStrength: roundTo(regimeStrength, 100),
            updateCount: this._updateCount,
        };
    }
}

export { PermutationEntropyAnalyzer }

