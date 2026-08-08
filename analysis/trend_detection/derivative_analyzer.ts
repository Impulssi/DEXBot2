
import { roundTo } from '../../modules/utils/math_utils.js';
'use strict';

/**
 * Derivative Analyzer
 *
 * Trend detection from the sign (and magnitude) of the slow SMA derivative.
 *
 * The analyzer intentionally stays narrow:
 *   - SMA for direction / regime
 *   - MACD for momentum
 *   - RSI for exhaustion and counter-trend filtering
 */

// ─── Simple Moving Average ───────────────────────────────────────────────────

class SMA {
    period: number;
    values: number[];

    constructor(period: number) {
        this.period = period;
        this.values = [];
    }

    update(price: number): number | null {
        this.values.push(price);
        if (this.values.length > this.period) this.values.shift();
        if (this.values.length < this.period) return null;
        return this.values.reduce((a, b) => a + b, 0) / this.period;
    }

    isReady(): boolean { return this.values.length >= this.period; }

    reset(period: number): void { this.period = period; this.values = []; }
}

// ─── Exponential Moving Average ──────────────────────────────────────────────

class EMA {
    period: number;
    multiplier: number;
    value: number | null;
    count: number;
    _sum: number;

    constructor(period: number) {
        this.period = period;
        this.multiplier = 2 / (period + 1);
        this.value = null;
        this.count = 0;
        this._sum = 0;
    }

    update(price: number): number | null {
        this.count++;
        if (this.count < this.period) {
            this._sum += price;
            return null;
        }
        if (this.count === this.period) {
            this._sum += price;
            this.value = this._sum / this.period;
            return this.value;
        }
        this.value = price * this.multiplier + this.value! * (1 - this.multiplier);
        return this.value;
    }

    isReady(): boolean { return this.count >= this.period; }

    reset(period?: number): void {
        this.period = period ?? this.period;
        this.multiplier = 2 / (this.period + 1);
        this.value = null;
        this.count = 0;
        this._sum = 0;
    }
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

class MACD {
    fastPeriod: number;
    slowPeriod: number;
    signalPeriod: number;
    fastEma: EMA;
    slowEma: EMA;
    signalEma: EMA;

    /**
     * Moving Average Convergence Divergence
     * macdLine  = EMA(fast) - EMA(slow)
     * signal    = EMA(signalPeriod) of macdLine
     * histogram = macdLine - signal
     */
    constructor(fastPeriod: number = 12, slowPeriod: number = 26, signalPeriod: number = 9) {
        this.fastPeriod   = fastPeriod;
        this.slowPeriod   = slowPeriod;
        this.signalPeriod = signalPeriod;
        this.fastEma   = new EMA(fastPeriod);
        this.slowEma   = new EMA(slowPeriod);
        this.signalEma = new EMA(signalPeriod);
    }

    update(price: number): { macd: number; signal: number; histogram: number } | null {
        const fast = this.fastEma.update(price);
        const slow = this.slowEma.update(price);
        if (fast === null || slow === null) return null;
        const macdLine = fast - slow;
        const signal   = this.signalEma.update(macdLine);
        if (signal === null) return null;
        return { macd: macdLine, signal, histogram: macdLine - signal };
    }

    isReady(): boolean { return this.slowEma.isReady() && this.signalEma.isReady(); }

    reset(fastPeriod?: number, slowPeriod?: number, signalPeriod?: number): void {
        this.fastPeriod   = fastPeriod   ?? this.fastPeriod;
        this.slowPeriod   = slowPeriod   ?? this.slowPeriod;
        this.signalPeriod = signalPeriod ?? this.signalPeriod;
        this.fastEma.reset(this.fastPeriod);
        this.slowEma.reset(this.slowPeriod);
        this.signalEma.reset(this.signalPeriod);
    }
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

class RSI {
    period: number;
    count: number;
    prevPrice: number | null;
    avgGain: number;
    avgLoss: number;

    /**
     * Relative Strength Index (Wilder smoothing)
     * Overbought > 70, Oversold < 30
     */
    constructor(period: number = 14) {
        this.period    = period;
        this.count     = 0;
        this.prevPrice = null;
        this.avgGain   = 0;
        this.avgLoss   = 0;
    }

    update(price: number): number | null {
        if (this.prevPrice === null) { this.prevPrice = price; return null; }
        const change = price - this.prevPrice;
        this.prevPrice = price;
        const gain = change > 0 ?  change : 0;
        const loss = change < 0 ? -change : 0;
        this.count++;
        if (this.count < this.period) {
            this.avgGain += gain;
            this.avgLoss += loss;
            return null;
        }
        if (this.count === this.period) {
            this.avgGain = (this.avgGain + gain) / this.period;
            this.avgLoss = (this.avgLoss + loss) / this.period;
        } else {
            this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
            this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
        }
        if (this.avgLoss === 0) return 100;
        return 100 - (100 / (1 + this.avgGain / this.avgLoss));
    }

    isReady(): boolean { return this.count >= this.period; }

    reset(period?: number): void {
        this.period    = period ?? this.period;
        this.count     = 0;
        this.prevPrice = null;
        this.avgGain   = 0;
        this.avgLoss   = 0;
    }
}

// ─── Derivative Analyzer ─────────────────────────────────────────────────────

type DerivativeAnalyzerConfig = {
    slowSmaPeriod?: number;
    fastSmaPeriod?: number;
    minBarsForConfirmation?: number;
    macdFastPeriod?: number;
    macdSlowPeriod?: number;
    macdSignalPeriod?: number;
    rsiPeriod?: number;
    interpConfirmBars?: number;
    interpHoldBars?: number;
    rsiOverboughtLevel?: number;
    rsiOversoldLevel?: number;
    rsiBullThreshold?: number;
    rsiBearThreshold?: number;
    macdMinHist?: number;
    fastSmaCommitmentBars?: number;
    trendFilterEnabled?: boolean;
    trendFilterMinBars?: number;
    momentumGateEnabled?: boolean;
    momentumGateMinBars?: number;
    momentumGateRsiZone?: number;
    priceRegimeGateEnabled?: boolean;
    priceRegimeMinDistancePct?: number;
};

type MacdValues = {
    macd: number;
    signal: number;
    histogram: number;
};

class DerivativeAnalyzer {
    minBarsForConfirmation: number;
    slowSmaPeriod: number;
    sma: SMA | null;
    fastSmaPeriod: number;
    fastSma: SMA | null;
    macdConfig: { fastPeriod: number; slowPeriod: number; signalPeriod: number };
    macd: MACD;
    currMacd: MacdValues | null;
    prevMacd: MacdValues | null;
    rsiPeriod: number;
    rsi: RSI;
    currRsi: number | null;
    prevRsi: number | null;
    interpConfirmBars: number;
    interpHoldBars: number;
    rsiOverboughtLevel: number;
    rsiOversoldLevel: number;
    rsiBullThreshold: number;
    rsiBearThreshold: number;
    macdMinHist: number;
    fastSmaCommitmentBars: number;
    trendFilterEnabled: boolean;
    trendFilterMinBars: number;
    momentumGateEnabled: boolean;
    momentumGateMinBars: number;
    momentumGateRsiZone: number;
    barsInMacdDivergence: number;
    barsInRsiDivergence: number;
    priceRegimeGateEnabled: boolean;
    priceRegimeMinDistancePct: number;
    prevRawInterp: string | null;
    barsInRawInterp: number;
    currInterpretation: string;
    currInterpretationRaw: string;
    pendingInterp: string | null;
    pendingInterpBars: number;
    entryBias: string;
    isBullWeakEntry: boolean;
    isBullConfirmation: boolean;
    isLateBullWithoutWeak: boolean;
    isBearWeakEntry: boolean;
    isBearConfirmation: boolean;
    isLateBearWithoutWeak: boolean;
    bullEntrySetupActive: boolean;
    bullEntrySetupConfirmed: boolean;
    bearEntrySetupActive: boolean;
    bearEntrySetupConfirmed: boolean;
    prevSma: number | null;
    currSma: number | null;
    prevFastSma: number | null;
    currFastSma: number | null;
    prevPrice: number | null;
    currPrice: number | null;
    prevRawSmaTrend: string | null;
    barsInSmaTrend: number;
    prevRawFastSmaTrend: string | null;
    barsInFastSmaTrend: number;
    barsAboveFastSma: number;
    barsBelowFastSma: number;
    updateCount: number;

    constructor(config: DerivativeAnalyzerConfig = {}) {
        this.minBarsForConfirmation = config.minBarsForConfirmation || 3;

        // SMA (slow)
        this.slowSmaPeriod = config.slowSmaPeriod ?? 500;
        this.sma = this.slowSmaPeriod ? new SMA(this.slowSmaPeriod) : null;

        // SMA (fast)
        this.fastSmaPeriod = config.fastSmaPeriod ?? 100;
        this.fastSma = this.fastSmaPeriod ? new SMA(this.fastSmaPeriod) : null;

        // MACD
        this.macdConfig = {
            fastPeriod:   config.macdFastPeriod   ?? 12,
            slowPeriod:   config.macdSlowPeriod   ?? 26,
            signalPeriod: config.macdSignalPeriod ?? 9,
        };
        this.macd = new MACD(this.macdConfig.fastPeriod, this.macdConfig.slowPeriod, this.macdConfig.signalPeriod);
        this.currMacd = null;
        this.prevMacd = null;

        // RSI
        this.rsiPeriod = config.rsiPeriod ?? 14;
        this.rsi = new RSI(this.rsiPeriod);
        this.currRsi = null;
        this.prevRsi = null;

        // Interpretation state
        this.interpConfirmBars   = config.interpConfirmBars ?? 3;
        this.interpHoldBars      = config.interpHoldBars    ?? 0;
        this.rsiOverboughtLevel  = config.rsiOverboughtLevel ?? 70;
        this.rsiOversoldLevel    = config.rsiOversoldLevel   ?? 30;
        this.rsiBullThreshold    = config.rsiBullThreshold   ?? 55;
        this.rsiBearThreshold    = config.rsiBearThreshold   ?? 45;
        this.macdMinHist         = config.macdMinHist        ?? 0;
        this.fastSmaCommitmentBars = config.fastSmaCommitmentBars ?? 2;
        this.trendFilterEnabled  = config.trendFilterEnabled ?? false;
        this.trendFilterMinBars  = config.trendFilterMinBars ?? 3;
        this.momentumGateEnabled = config.momentumGateEnabled ?? false;
        this.momentumGateMinBars = config.momentumGateMinBars ?? 3;
        this.momentumGateRsiZone = config.momentumGateRsiZone ?? 35;
        this.barsInMacdDivergence = 0;
        this.barsInRsiDivergence  = 0;
        this.priceRegimeGateEnabled = config.priceRegimeGateEnabled ?? true;
        this.priceRegimeMinDistancePct = config.priceRegimeMinDistancePct ?? 0.35;
        this.prevRawInterp       = null;
        this.barsInRawInterp     = 0;
        this.currInterpretation    = 'NEUTRAL';
        this.currInterpretationRaw = 'NEUTRAL';
        this.pendingInterp         = null;
        this.pendingInterpBars     = 0;
        this.entryBias            = 'NONE';
        this.isBullWeakEntry      = false;
        this.isBullConfirmation   = false;
        this.isLateBullWithoutWeak = false;
        this.isBearWeakEntry      = false;
        this.isBearConfirmation   = false;
        this.isLateBearWithoutWeak = false;
        this.bullEntrySetupActive = false;
        this.bullEntrySetupConfirmed = false;
        this.bearEntrySetupActive = false;
        this.bearEntrySetupConfirmed = false;

        // Previous / current SMA values (for derivative)
        this.prevSma     = null;
        this.currSma     = null;
        this.prevFastSma = null;
        this.currFastSma = null;
        this.prevPrice = null;
        this.currPrice = null;

        // Independent trend states
        this.prevRawSmaTrend = null;
        this.barsInSmaTrend = 0;
        this.prevRawFastSmaTrend = null;
        this.barsInFastSmaTrend = 0;
        this.barsAboveFastSma = 0;
        this.barsBelowFastSma = 0;

        this.updateCount = 0;
    }

    update(price: number, timestamp: number | null = null): ReturnType<DerivativeAnalyzer['getAnalysis']> {
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('price must be a positive finite number');
        }

        // Update current price at the start of the bar (before interpretation)
        this.prevPrice = this.currPrice;
        this.currPrice = price;

        // SMA (slow)
        if (this.sma) {
            this.prevSma = this.currSma;
            this.currSma = this.sma.update(price);
        }

        // SMA (fast)
        if (this.fastSma) {
            this.prevFastSma = this.currFastSma;
            this.currFastSma = this.fastSma.update(price);
        }

        // MACD — normalized as % of price so scale is comparable across all price levels
        if (this.macd) {
            this.prevMacd = this.currMacd;
            const raw = this.macd.update(price);
            if (raw !== null && price > 0) {
                this.currMacd = {
                    macd:      (raw.macd      / price) * 100,
                    signal:    (raw.signal    / price) * 100,
                    histogram: (raw.histogram / price) * 100,
                };
            } else {
                this.currMacd = null;
            }
        }

        // RSI
        if (this.rsi) {
            this.prevRsi = this.currRsi;
            this.currRsi = this.rsi.update(price);
        }

        // Advance momentum divergence counters (for Momentum Gate optimization)
        this._advanceMomentumDivergence();

        // Fast-SMA commitment tracking: price vs fast MA position
        this._advancePriceFastSmaPosition();

        // Interpretation (computed after MACD + RSI are updated)
        if (this.macd || this.rsi) {
            const prevInterpretation = this.currInterpretation;
            this._resetEntryBias();
            let rawInterp = this.trendFilterEnabled
                ? this._applyTrendFilter(this._computeInterpretation())
                : this._computeInterpretation();

            // Opt 13 — Post-filter MACD line gate (bull/bear trap suppression)
            // The MACD line is the authoritative momentum regime indicator:
            //   line > threshold → bullish regime; line < -threshold → bearish regime.
            // Any signal that contradicts the confirmed regime is suppressed to NEUTRAL.
            // This ignores marginal crossings at ~0 and ensures signals only start when
            // momentum is clearly confirmed.
            if (this.macd && this.currMacd !== null) {
                const threshold = this.macdMinHist || 0.02;
                if ((rawInterp === 'BEAR' || rawInterp === 'BEAR_WEAK') && this.currMacd.macd > -threshold)
                    rawInterp = 'NEUTRAL';
                if ((rawInterp === 'BULL' || rawInterp === 'BULL_WEAK') && this.currMacd.macd < threshold)
                    rawInterp = 'NEUTRAL';
            }

            this.currInterpretationRaw = rawInterp;
            // BULL/BEAR require confirmation bars; other states are immediate
            if (rawInterp === 'BULL' || rawInterp === 'BEAR') {
                // Check if fast-SMA commitment is met (required before counting confirmation)
                let fastSmaPassesCommitment = true;
                if (this.fastSma && this.currFastSma !== null && this.currPrice !== null) {
                    if (rawInterp === 'BULL') {
                        fastSmaPassesCommitment = this.barsAboveFastSma >= this.fastSmaCommitmentBars;
                    } else if (rawInterp === 'BEAR') {
                        fastSmaPassesCommitment = this.barsBelowFastSma >= this.fastSmaCommitmentBars;
                    }
                }

                // Only count confirmation bars if the fast-SMA commitment passes
                if (fastSmaPassesCommitment) {
                    if (rawInterp === this.prevRawInterp) {
                        this.barsInRawInterp++;
                    } else {
                        this.prevRawInterp   = rawInterp;
                        this.barsInRawInterp = 1;
                    }
                } else {
                    // Commitment not met — reset confirmation counter
                    this.prevRawInterp   = rawInterp === 'BULL' ? 'BEAR' : 'BULL';
                    this.barsInRawInterp = 0;
                }

                const confirmed = this.barsInRawInterp >= this.interpConfirmBars
                    ? rawInterp : 'NEUTRAL';
                this._applyWithHysteresis(confirmed);
            } else {
                this.prevRawInterp   = rawInterp;
                this.barsInRawInterp = 0;
                this._applyWithHysteresis(rawInterp);
            }
            this._advanceEntryBias(prevInterpretation);
        }

        this.updateCount++;

        // Update trend states
        const smaRaw     = this._rawSmaTrend();
        const fastSmaRaw = this._rawFastSmaTrend();
        this._advanceTrend(smaRaw,     'Sma');
        this._advanceTrend(fastSmaRaw, 'FastSma');

        const result = this.getAnalysis();
        if (timestamp !== null) result.timestamp = timestamp;
        return result;
    }

    _advanceTrend(raw: string, key: string): void {
        const prevKey = `prevRaw${key}Trend` as keyof this;
        const barsKey = `barsIn${key}Trend` as keyof this;
        if (raw !== (this as any)[prevKey]) {
            (this as any)[prevKey] = raw;
            (this as any)[barsKey] = 1;
        } else {
            (this as any)[barsKey]++;
        }
    }

    // ── Derivative signs ───────────────────────────────────────

    _rawSmaTrend(): string {
        if (!this.sma || this.prevSma === null || this.currSma === null) return 'NEUTRAL';
        if (this.currSma > this.prevSma) return 'UP';
        if (this.currSma < this.prevSma) return 'DOWN';
        return 'NEUTRAL';
    }

    _rawFastSmaTrend(): string {
        if (!this.fastSma || this.prevFastSma === null || this.currFastSma === null) return 'NEUTRAL';
        if (this.currFastSma > this.prevFastSma) return 'UP';
        if (this.currFastSma < this.prevFastSma) return 'DOWN';
        return 'NEUTRAL';
    }

    _advancePriceFastSmaPosition(): void {
        if (!this.fastSma || this.currFastSma === null || this.currPrice === null) {
            this.barsAboveFastSma = 0;
            this.barsBelowFastSma = 0;
            return;
        }
        if (this.currPrice > this.currFastSma) {
            this.barsAboveFastSma++;
            this.barsBelowFastSma = 0;
        } else {
            this.barsBelowFastSma++;
            this.barsAboveFastSma = 0;
        }
    }

    _advanceMomentumDivergence(): void {
        if (!this.momentumGateEnabled || !this.macd || !this.rsi || !this.sma) return;
        if (this.currMacd === null || this.currRsi === null) return;

        const slowDir = this._rawSmaTrend();
        if (slowDir === 'NEUTRAL') {
            this.barsInMacdDivergence = 0;
            this.barsInRsiDivergence  = 0;
            return;
        }

        const macdOpposes =
            (slowDir === 'UP'   && this.currMacd.histogram < -this.macdMinHist) ||
            (slowDir === 'DOWN' && this.currMacd.histogram >  this.macdMinHist);

        const rsiOpposes =
            (slowDir === 'UP'   && this.currRsi < this.momentumGateRsiZone) ||
            (slowDir === 'DOWN' && this.currRsi > (100 - this.momentumGateRsiZone));

        this.barsInMacdDivergence = macdOpposes ? this.barsInMacdDivergence + 1 : 0;
        this.barsInRsiDivergence  = rsiOpposes  ? this.barsInRsiDivergence  + 1 : 0;
    }

    // ── Trend filter ─────────────────────────────────────────

    _applyTrendFilter(interp: string): string {
        // OB/OS are exit signals — not suppressed by trend direction
        if (interp === 'OVERBOUGHT' || interp === 'OVERSOLD') return interp;

        // Compute fast MA direction and sustained bars count
        let fastDir: string, fastBarsInDir: number;
        if (this.fastSma) {
            fastDir       = this._rawFastSmaTrend();
            fastBarsInDir = (fastDir === this.prevRawFastSmaTrend ? this.barsInFastSmaTrend + 1 : 1);
        } else if (this.sma) {
            fastDir       = this._rawSmaTrend();
            fastBarsInDir = (fastDir === this.prevRawSmaTrend ? this.barsInSmaTrend + 1 : 1);
        } else {
            return interp;
        }

        if (fastDir === 'NEUTRAL') return interp;

        // Primary gate: fast MA sustained in opposite direction → suppress to NEUTRAL
        let suppressedByTrendFilter = false;
        if (fastBarsInDir >= this.trendFilterMinBars) {
            if (fastDir === 'UP'   && (interp === 'BEAR' || interp === 'BEAR_WEAK')) {
                interp = 'NEUTRAL';
                suppressedByTrendFilter = true;
            }
            if (fastDir === 'DOWN' && (interp === 'BULL' || interp === 'BULL_WEAK')) {
                interp = 'NEUTRAL';
                suppressedByTrendFilter = true;
            }
        }

        // Momentum Gate (Opt 11): if MACD + RSI both diverge from SMA(500) for
        // >= momentumGateMinBars, allow signal through as WEAK instead of suppressing to NEUTRAL.
        if (suppressedByTrendFilter && this.momentumGateEnabled && this.sma) {
            const slowDir  = this._rawSmaTrend();
            const macdConf = this.barsInMacdDivergence >= this.momentumGateMinBars;
            const rsiConf  = this.barsInRsiDivergence  >= this.momentumGateMinBars;

            if (macdConf && rsiConf && slowDir !== 'NEUTRAL') {
                if (slowDir === 'UP' && (this.currMacd?.histogram ?? 0) < -this.macdMinHist) {
                    interp = 'BEAR_WEAK';
                }
                if (slowDir === 'DOWN' && (this.currMacd?.histogram ?? 0) > this.macdMinHist) {
                    interp = 'BULL_WEAK';
                }
            }
        }

        // Macro regime gate: when fastSMA and SMA(slow) are both present and disagree,
        // cap full BULL/BEAR to WEAK — a short-term dip/bounce against the macro trend
        // does not warrant a confirmed directional signal.
        if (this._violatesMacroDisagreeGate(interp, fastDir)) {
            if (interp === 'BULL') return 'BULL_WEAK';
            if (interp === 'BEAR') return 'BEAR_WEAK';
        }

        // Fast-SMA commitment gate — price vs fast MA cross-check (N-bar commitment required)
        if (this.fastSma && this.currFastSma !== null && this.currPrice !== null) {
            if (interp === 'BULL' && this.barsAboveFastSma < this.fastSmaCommitmentBars) return 'BULL_WEAK';
            if (interp === 'BEAR' && this.barsBelowFastSma < this.fastSmaCommitmentBars) return 'BEAR_WEAK';
        }

        // Opt 12 — MACD Line & Histogram regime check
        if (this.macd && this.currMacd !== null) {
            if (interp === 'BULL' && this.currMacd.macd <= 0) return 'BULL_WEAK';
            if (interp === 'BEAR' && this.currMacd.macd >= 0) return 'BEAR_WEAK';
            if (interp === 'BEAR' && this.currMacd.histogram > 0) return 'BEAR_WEAK';
        }

        // Macro price regime gate: require a minimum clearance beyond slow SMA.
        if (this._violatesPriceRegimeGate(interp)) return 'NEUTRAL';

        return interp;
    }

    // ── Hysteresis ────────────────────────────────────────────

    _applyWithHysteresis(newInterp: string): void {
        // OB/OS are exit signals — always immediate, bypass hold
        if (newInterp === 'OVERBOUGHT' || newInterp === 'OVERSOLD') {
            this.currInterpretation = newInterp;
            this.pendingInterp      = null;
            this.pendingInterpBars  = 0;
            return;
        }

        const curr = this.currInterpretation;
        const isDowngrade = (curr === 'BULL' && newInterp !== 'BULL')
                         || (curr === 'BEAR' && newInterp !== 'BEAR');

        // Hard regime gates define when a confirmed signal is no longer valid at all.
        // In those cases hysteresis must not keep a stale BULL/BEAR alive after invalidation.
        const hardInvalidation = this._isHardInvalidation(curr);

        if (!isDowngrade || this.interpHoldBars <= 0 || hardInvalidation) {
            this.currInterpretation = newInterp;
            this.pendingInterp      = null;
            this.pendingInterpBars  = 0;
            return;
        }

        // Debounce the downgrade — must hold for interpHoldBars bars
        if (newInterp === this.pendingInterp) {
            this.pendingInterpBars++;
            if (this.pendingInterpBars >= this.interpHoldBars) {
                this.currInterpretation = newInterp;
                this.pendingInterp      = null;
                this.pendingInterpBars  = 0;
            }
        } else {
            this.pendingInterp     = newInterp;
            this.pendingInterpBars = 1;
        }
    }

    _resetEntryBias(): void {
        this.entryBias = 'NONE';
        this.isBullWeakEntry = false;
        this.isBullConfirmation = false;
        this.isLateBullWithoutWeak = false;
        this.isBearWeakEntry = false;
        this.isBearConfirmation = false;
        this.isLateBearWithoutWeak = false;
    }

    _advanceEntryBias(prevInterpretation: string): void {
        const curr = this.currInterpretation;
        const slowDir = this._rawSmaTrend();
        const fastDir = this.fastSma ? this._rawFastSmaTrend() : slowDir;
        const prevBullish = prevInterpretation === 'BULL' || prevInterpretation === 'BULL_WEAK';
        const currBullish = curr === 'BULL' || curr === 'BULL_WEAK';
        const prevBearish = prevInterpretation === 'BEAR' || prevInterpretation === 'BEAR_WEAK';
        const currBearish = curr === 'BEAR' || curr === 'BEAR_WEAK';
        const bullMacroAligned = slowDir === 'UP';
        const bearMacroAligned = slowDir === 'DOWN';
        const bullEntryAligned = bullMacroAligned && fastDir === 'UP';
        const bearEntryAligned = bearMacroAligned && fastDir === 'DOWN';

        if (!currBullish) {
            this.bullEntrySetupActive = false;
            this.bullEntrySetupConfirmed = false;
        }

        // Keep weak bullish states visible on the chart, but do not emit long
        // entry events until both slow and fast SMA trends are aligned up.
        if (!bullEntryAligned) {
            this.bullEntrySetupActive = false;
            this.bullEntrySetupConfirmed = false;
        } else if (curr === 'BULL_WEAK' && (!prevBullish || !this.bullEntrySetupActive)) {
            this.bullEntrySetupActive = true;
            this.bullEntrySetupConfirmed = false;
            this.entryBias = 'EARLY_LONG';
            this.isBullWeakEntry = true;
            return;
        }

        if (curr === 'BULL' && prevInterpretation !== 'BULL') {
            if (this.bullEntrySetupActive && !this.bullEntrySetupConfirmed) {
                this.bullEntrySetupConfirmed = true;
                this.entryBias = 'CONFIRM_LONG';
                this.isBullConfirmation = true;
            }
        }

        if (!currBearish) {
            this.bearEntrySetupActive = false;
            this.bearEntrySetupConfirmed = false;
        }

        // Keep weak bearish states visible on the chart, but do not emit short
        // entry events until both slow and fast SMA trends are aligned down.
        if (!bearEntryAligned) {
            this.bearEntrySetupActive = false;
            this.bearEntrySetupConfirmed = false;
            return;
        }

        if (curr === 'BEAR_WEAK' && (!prevBearish || !this.bearEntrySetupActive)) {
            this.bearEntrySetupActive = true;
            this.bearEntrySetupConfirmed = false;
            this.entryBias = 'EARLY_SHORT';
            this.isBearWeakEntry = true;
            return;
        }

        if (curr === 'BEAR' && prevInterpretation !== 'BEAR') {
            if (this.bearEntrySetupActive && !this.bearEntrySetupConfirmed) {
                this.bearEntrySetupConfirmed = true;
                this.entryBias = 'CONFIRM_SHORT';
                this.isBearConfirmation = true;
            }
        }
    }

    _isHardInvalidation(interp: string): boolean {
        if (interp !== 'BULL' && interp !== 'BEAR') return false;

        if (this.macd && this.currMacd !== null) {
            const threshold = this.macdMinHist || 0.02;
            if (interp === 'BULL' && this.currMacd.macd < threshold) return true;
            if (interp === 'BEAR' && this.currMacd.macd > -threshold) return true;
        }

        if (this._violatesMacroDisagreeGate(interp)) return true;
        if (this._violatesPriceRegimeGate(interp)) return true;

        return false;
    }

    _violatesMacroDisagreeGate(interp: string, fastDirOverride: string | null = null): boolean {
        if (!this.trendFilterEnabled || !this.fastSma || !this.sma) return false;
        if (interp !== 'BULL' && interp !== 'BEAR') return false;

        const fastDir = fastDirOverride ?? this._rawFastSmaTrend();
        const slowDir = this._rawSmaTrend();
        const slowBarsInDir = (slowDir === this.prevRawSmaTrend ? this.barsInSmaTrend + 1 : 1);

        if (fastDir === 'NEUTRAL' || slowDir === 'NEUTRAL') return false;
        if (slowBarsInDir < this.trendFilterMinBars) return false;
        if (fastDir === slowDir) return false;

        return fastDir !== slowDir;
    }

    _violatesPriceRegimeGate(interp: string): boolean {
        if (!this.priceRegimeGateEnabled || !this.sma || this.currSma === null || this.currPrice === null) {
            return false;
        }
        if (!['BULL', 'BULL_WEAK', 'BEAR', 'BEAR_WEAK'].includes(interp)) return false;

        const distanceMultiplier = this.priceRegimeMinDistancePct / 100;
        const bullFloor = this.currSma * (1 + distanceMultiplier);
        const bearCeiling = this.currSma * (1 - distanceMultiplier);

        if ((interp === 'BULL' || interp === 'BULL_WEAK') && this.currPrice < bullFloor) return true;
        if ((interp === 'BEAR' || interp === 'BEAR_WEAK') && this.currPrice > bearCeiling) return true;
        return false;
    }

    // ── Interpretation ────────────────────────────────────────

    _computeInterpretation(): string {
        const hist     = this.currMacd?.histogram ?? null;
        const macdLine = this.currMacd?.macd      ?? null;
        const prevHist     = this.prevMacd?.histogram ?? null;
        const prevMacdLine = this.prevMacd?.macd      ?? null;
        const rsi = this.currRsi;

        if (hist === null && rsi === null) return 'NEUTRAL';

        // 1. MACD histogram sign with minimum magnitude filter
        const histBull = hist !== null && hist >  this.macdMinHist;
        const histBear = hist !== null && hist < -this.macdMinHist;

        // 2. MACD histogram momentum
        const histMom           = (hist !== null && prevHist !== null) ? hist - prevHist : null;
        const histWeakeningBull = histBull && histMom !== null && histMom < 0;
        const histWeakeningBear = histBear && histMom !== null && histMom > 0;

        // 3. MACD zero-line position
        const macdAboveZero = macdLine !== null && macdLine > 0;
        const macdBelowZero = macdLine !== null && macdLine < 0;

        // 5. MACD line slope — is the MACD line itself rising or falling?
        const macdLineSlope   = (macdLine !== null && prevMacdLine !== null) ? macdLine - prevMacdLine : null;
        const macdLineRising  = macdLineSlope !== null && macdLineSlope > 0;
        const macdLineFalling = macdLineSlope !== null && macdLineSlope < 0;

        // 6. RSI extremes (highest priority — exit signals)
        const rsiOverbought = rsi !== null && rsi > this.rsiOverboughtLevel;
        const rsiOversold   = rsi !== null && rsi < this.rsiOversoldLevel;

        // 7. RSI direction — rising or falling?
        const rsiSlope   = (rsi !== null && this.prevRsi !== null) ? rsi - this.prevRsi : null;
        const rsiRising  = rsiSlope !== null && rsiSlope > 0;
        const rsiFalling = rsiSlope !== null && rsiSlope < 0;

        // 8. RSI counter-trend: in opposing zone AND not recovering (direction confirms divergence)
        const rsiCounterBull = rsi !== null && rsi < this.rsiBearThreshold && !rsiRising;
        const rsiCounterBear = rsi !== null && rsi > this.rsiBullThreshold && !rsiFalling;

        // Base signal driven by MACD histogram (RSI no longer hard-gates)
        let raw = 'NEUTRAL';
        if (histBull) raw = 'BULL';
        if (histBear) raw = 'BEAR';

        // RSI extreme exit — override immediately
        if (raw === 'BULL' && rsiOverbought) return 'OVERBOUGHT';
        if (raw === 'BEAR' && rsiOversold)   return 'OVERSOLD';

        // Weak conditions:
        //   histFading:  histogram shrinking AND MACD line not supporting (any zero position)
        //   dualWeak:    histogram positive but MACD line still on wrong side of zero AND not recovering
        //   rsiCounter:  RSI in counter-trend territory AND direction confirms (standalone)
        //
        // Note: histogram = MACD line − Signal line, so macdBelowSignal is always false when
        // histBull is true. Signal line crossover is not a valid structural check here.
        const histFadingBull = histWeakeningBull && !macdLineRising;
        const histFadingBear = histWeakeningBear && !macdLineFalling;
        const dualWeakBull   = histBull && macdBelowZero && !macdLineRising;
        const dualWeakBear   = histBear && macdAboveZero && !macdLineFalling;

        const bullWeak = histFadingBull || dualWeakBull || rsiCounterBull;
        const bearWeak = histFadingBear || dualWeakBear || rsiCounterBear;

        if (raw === 'BULL' && bullWeak) return 'BULL_WEAK';
        if (raw === 'BEAR' && bearWeak) return 'BEAR_WEAK';

        return raw;
    }

    // ── Analysis ───────────────────────────────────────────────

    getAnalysis(): {
        isReady: boolean;
        reason?: string;
        trend: string;
        confidence: number;
        isConfirmed: boolean;
        rawTrend?: string;
        barsInTrend?: number;
        smaRawTrend: string;
        smaTrend: string;
        smaBarsInTrend: number;
        smaConfidence: number;
        fastSmaRawTrend: string;
        fastSmaTrend: string;
        fastSmaBarsInTrend: number;
        fastSmaConfidence: number;
        fastSmaValue: number | null;
        slowSma: number | null;
        macdLine: number | null;
        macdSignal: number | null;
        macdHistogram: number | null;
        macdTrend: string | null;
        rsi: number | null;
        rsiZone: string | null;
        interpretation: string;
        interpretationRaw: string;
        interpretationBars: number;
        entryBias: string;
        isBullWeakEntry: boolean;
        isBullConfirmation: boolean;
        isLateBullWithoutWeak: boolean;
        isBearWeakEntry: boolean;
        isBearConfirmation: boolean;
        isLateBearWithoutWeak: boolean;
        price: number | null;
        updateCount: number;
        timestamp?: number;
    } {
        const warmupNeeded = Math.max(
            this.sma     ? this.slowSmaPeriod : 0,
            this.fastSma ? this.fastSmaPeriod : 0,
            this.macd    ? this.macdConfig.slowPeriod + this.macdConfig.signalPeriod : 0,
            this.rsi     ? this.rsiPeriod + 1 : 0
        );

        if (this.updateCount < warmupNeeded) {
            return {
                isReady: false,
                reason:  `Warming up: ${this.updateCount}/${warmupNeeded} candles`,
                trend: 'NEUTRAL', confidence: 0, isConfirmed: false,
                ...this._emptySignals(),
                price: this.currPrice, updateCount: this.updateCount,
            };
        }

        const smaRaw     = this._rawSmaTrend();
        const fastSmaRaw = this._rawFastSmaTrend();
        const smaConf     = this._conf(smaRaw,     this.barsInSmaTrend);
        const fastSmaConf = this._conf(fastSmaRaw, this.barsInFastSmaTrend);

        const smaConfirmed     = smaRaw     !== 'NEUTRAL' && this.barsInSmaTrend     >= this.minBarsForConfirmation;
        const fastSmaConfirmed = fastSmaRaw !== 'NEUTRAL' && this.barsInFastSmaTrend >= this.minBarsForConfirmation;

        // Primary: fastSMA > SMA
        const primary     = this.fastSma ? fastSmaRaw  : smaRaw;
        const primConf    = this.fastSma ? fastSmaConf : smaConf;
        const primConfirm = this.fastSma ? fastSmaConfirmed : smaConfirmed;

        return {
            isReady: true,
            trend:       primConfirm ? primary : 'NEUTRAL',
            confidence:  primConf,
            isConfirmed: primConfirm,
            rawTrend:    primary,
            barsInTrend: this.fastSma ? this.barsInFastSmaTrend : this.barsInSmaTrend,
            // SMA (slow)
            smaRawTrend:    smaRaw,
            smaTrend:       smaConfirmed ? smaRaw : 'NEUTRAL',
            smaBarsInTrend: this.barsInSmaTrend,
            smaConfidence:  smaConf,
            // SMA (fast)
            fastSmaRawTrend:    fastSmaRaw,
            fastSmaTrend:       fastSmaConfirmed ? fastSmaRaw : 'NEUTRAL',
            fastSmaBarsInTrend: this.barsInFastSmaTrend,
            fastSmaConfidence:  fastSmaConf,
            fastSmaValue:       this.currFastSma !== null ? roundTo(this.currFastSma, 1e6) : null,
            // MACD
            macdLine:      this.currMacd ? roundTo(this.currMacd.macd, 1e8) : null,
            macdSignal:    this.currMacd ? roundTo(this.currMacd.signal, 1e8) : null,
            macdHistogram: this.currMacd ? roundTo(this.currMacd.histogram, 1e8) : null,
            macdTrend: this.currMacd
                ? (this.currMacd.histogram > 0 ? 'BULL' : this.currMacd.histogram < 0 ? 'BEAR' : 'NEUTRAL')
                : null,
            // RSI
            rsi: this.currRsi !== null ? roundTo(this.currRsi, 100) : null,
            rsiZone: this.currRsi !== null
                ? (this.currRsi > this.rsiOverboughtLevel ? 'OVERBOUGHT' : this.currRsi < this.rsiOversoldLevel ? 'OVERSOLD' : 'NEUTRAL')
                : null,
            // Combined interpretation
            interpretation:    this.currInterpretation,
            interpretationRaw: this.currInterpretationRaw,
            interpretationBars: this.barsInRawInterp,
            entryBias: this.entryBias,
            isBullWeakEntry: this.isBullWeakEntry,
            isBullConfirmation: this.isBullConfirmation,
            isLateBullWithoutWeak: this.isLateBullWithoutWeak,
            isBearWeakEntry: this.isBearWeakEntry,
            isBearConfirmation: this.isBearConfirmation,
            isLateBearWithoutWeak: this.isLateBearWithoutWeak,
            // Values
            price:       this.currPrice,
            slowSma:     this.currSma     !== null ? roundTo(this.currSma, 1e6) : null,
            updateCount: this.updateCount,
        };
    }

    _conf(raw: string, bars: number): number {
        return raw !== 'NEUTRAL' ? Math.min(100, Math.round((bars / 20) * 100)) : 0;
    }

    _emptySignals(): {
        smaRawTrend: string; smaTrend: string; smaBarsInTrend: number; smaConfidence: number;
        fastSmaRawTrend: string; fastSmaTrend: string; fastSmaBarsInTrend: number; fastSmaConfidence: number; fastSmaValue: null;
        slowSma: null;
        macdLine: null; macdSignal: null; macdHistogram: null; macdTrend: null;
        rsi: null; rsiZone: null;
        interpretation: string; interpretationRaw: string; interpretationBars: number;
        entryBias: string;
        isBullWeakEntry: boolean; isBullConfirmation: boolean; isLateBullWithoutWeak: boolean;
        isBearWeakEntry: boolean; isBearConfirmation: boolean; isLateBearWithoutWeak: boolean;
    } {
        return {
            smaRawTrend: 'NEUTRAL', smaTrend: 'NEUTRAL', smaBarsInTrend: 0, smaConfidence: 0,
            fastSmaRawTrend: 'NEUTRAL', fastSmaTrend: 'NEUTRAL', fastSmaBarsInTrend: 0, fastSmaConfidence: 0, fastSmaValue: null,
            slowSma: null,
            macdLine: null, macdSignal: null, macdHistogram: null, macdTrend: null,
            rsi: null, rsiZone: null,
            interpretation: 'NEUTRAL', interpretationRaw: 'NEUTRAL', interpretationBars: 0,
            entryBias: 'NONE',
            isBullWeakEntry: false,
            isBullConfirmation: false,
            isLateBullWithoutWeak: false,
            isBearWeakEntry: false,
            isBearConfirmation: false,
            isLateBearWithoutWeak: false,
        };
    }

    reset(): void {
        if (this.sma)     this.sma.reset(this.slowSmaPeriod);
        if (this.fastSma) this.fastSma.reset(this.fastSmaPeriod);
        if (this.macd)    this.macd.reset(this.macdConfig.fastPeriod, this.macdConfig.slowPeriod, this.macdConfig.signalPeriod);
        if (this.rsi)     this.rsi.reset(this.rsiPeriod);
        this.currMacd = null; this.prevMacd = null;
        this.currRsi  = null;
        this.prevRawInterp = null; this.barsInRawInterp = 0;
        this.currInterpretation = 'NEUTRAL'; this.currInterpretationRaw = 'NEUTRAL';
        this.pendingInterp      = null;
        this.pendingInterpBars  = 0;
        this.entryBias = 'NONE';
        this.isBullWeakEntry = false;
        this.isBullConfirmation = false;
        this.isLateBullWithoutWeak = false;
        this.isBearWeakEntry = false;
        this.isBearConfirmation = false;
        this.isLateBearWithoutWeak = false;
        this.bullEntrySetupActive = false;
        this.bullEntrySetupConfirmed = false;
        this.bearEntrySetupActive = false;
        this.bearEntrySetupConfirmed = false;
        this.prevSma     = null;
        this.currSma     = null;
        this.prevFastSma = null;
        this.currFastSma = null;
        this.currPrice = null;
        this.prevRawSmaTrend = null;
        this.barsInSmaTrend = 0;
        this.prevRawFastSmaTrend = null;
        this.barsInFastSmaTrend = 0;
        this.barsAboveFastSma = 0;
        this.barsBelowFastSma = 0;
        this.updateCount = 0;
    }

    getUpdateCount(): number { return this.updateCount; }
}

export { DerivativeAnalyzer }

