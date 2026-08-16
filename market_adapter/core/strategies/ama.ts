
import { MARKET_ADAPTER } from '../../../modules/constants.js';
'use strict';


/**
 * Kaufman's Adaptive Moving Average (KAMA/AMA).
 */
class AMA {
    erPeriod: any;
    erSmoothPeriod: any;
    erSmoothAlpha: any;
    erSmoothValue: any;
    fastSC: any;
    slowSC: any;
    prevAMA: any;
    history: any;
    warmedUp: any;
    smaSum: any;
    smaCount: any;

    constructor(erPeriod: any, fastPeriod: any, slowPeriod: any, erSmoothPeriod: any) {
        if (!Number.isFinite(erPeriod) || erPeriod <= 0) {
            throw new TypeError(`AMA erPeriod must be a positive finite number, got ${erPeriod}`);
        }
        if (!Number.isFinite(fastPeriod) || fastPeriod <= 0) {
            throw new TypeError(`AMA fastPeriod must be a positive finite number, got ${fastPeriod}`);
        }
        if (!Number.isFinite(slowPeriod) || slowPeriod <= 0) {
            throw new TypeError(`AMA slowPeriod must be a positive finite number, got ${slowPeriod}`);
        }
        this.erPeriod = Math.ceil(erPeriod);

        const esPeriod = Number(erSmoothPeriod);
        this.erSmoothPeriod = Number.isFinite(esPeriod) && esPeriod >= 1 ? esPeriod : 0;
        this.erSmoothAlpha = this.erSmoothPeriod > 0 ? 2 / (this.erSmoothPeriod + 1) : 0;
        this.erSmoothValue = null;

        this.fastSC = 2 / (fastPeriod + 1);
        this.slowSC = 2 / (slowPeriod + 1);
        this.prevAMA = null;
        this.history = [];
        this.warmedUp = false;
        this.smaSum = 0;
        this.smaCount = 0;
    }

    update(price: any) {
        if (!Number.isFinite(price)) {
            throw new TypeError(`AMA price must be a finite number, got ${price}`);
        }

        this.history.push(price);
        if (this.history.length > this.erPeriod + 1) {
            this.history.shift();
        }

        // Warmup phase: expose the rolling SMA until the full ER window exists.
        // The first recursive AMA seed is the same full-window SMA.
        if (!this.warmedUp) {
            this.smaSum += price;
            this.smaCount++;
            const sma = this.smaSum / this.smaCount;
            if (this.smaCount < this.erPeriod + 1) {
                return sma;
            }
            this.warmedUp = true;
            this.prevAMA = sma;
            return this.prevAMA;
        }

        const direction = Math.abs(price - this.history[0]);
        let volatility = 0;
        for (let i = 1; i < this.history.length; i++) {
            volatility += Math.abs(this.history[i] - this.history[i - 1]);
        }

        const er = volatility === 0 ? 0 : direction / volatility;

        const effectiveER = this.erSmoothAlpha > 0
            ? (this.erSmoothValue === null
                ? er
                : this.erSmoothValue + this.erSmoothAlpha * (er - this.erSmoothValue))
            : er;
        if (this.erSmoothAlpha > 0) {
            this.erSmoothValue = effectiveER;
        }

        const smooth = (effectiveER * (this.fastSC - this.slowSC) + this.slowSC) ** 2;
        const ama = this.prevAMA + smooth * (price - this.prevAMA);

        this.prevAMA = ama;
        return ama;
    }
}

function getAmaWarmupBars(erPeriod: any, slowPeriod: any, lookbackBars: any, fastPeriod: any, erSmoothPeriod = 0) {
    if (!Number.isFinite(erPeriod) || erPeriod <= 0) {
        throw new TypeError(`getAmaWarmupBars erPeriod must be a positive finite number, got ${erPeriod}`);
    }
    if (!Number.isFinite(slowPeriod) || slowPeriod <= 0) {
        throw new TypeError(`getAmaWarmupBars slowPeriod must be a positive finite number, got ${slowPeriod}`);
    }
    if (!Number.isFinite(lookbackBars) || lookbackBars < 0) {
        throw new TypeError(`getAmaWarmupBars lookbackBars must be a non-negative finite number, got ${lookbackBars}`);
    }
    if (!Number.isFinite(fastPeriod) || fastPeriod <= 0) {
        throw new TypeError(`getAmaWarmupBars fastPeriod must be a positive finite number, got ${fastPeriod}`);
    }
    if (!Number.isFinite(erSmoothPeriod) || erSmoothPeriod < 0) {
        throw new TypeError(`getAmaWarmupBars erSmoothPeriod must be a non-negative finite number, got ${erSmoothPeriod}`);
    }

    const safeErPeriod = Math.ceil(erPeriod);
    const safeSlowPeriod = Math.ceil(slowPeriod);
    const safeLookbackBars = Math.ceil(lookbackBars);
    const safeErSmoothPeriod = erSmoothPeriod >= 1 ? erSmoothPeriod : 0;
    const fastSC = 2 / (fastPeriod + 1);
    const slowSC = 2 / (safeSlowPeriod + 1);
    const deltaSC = fastSC - slowSC;
    const scAvg = (MARKET_ADAPTER.AMA_CONVERGENCE_ER_AVG * deltaSC + slowSC) ** 2;
    const convergenceBars = Math.ceil(
        Math.log(MARKET_ADAPTER.AMA_CONVERGENCE_EPSILON) / Math.log(1 - scAvg)
    );
    const erSmoothConvergenceBars = safeErSmoothPeriod > 0
        ? Math.ceil(
            Math.log(MARKET_ADAPTER.AMA_CONVERGENCE_EPSILON)
            / Math.log(1 - (2 / (safeErSmoothPeriod + 1)))
        )
        : 0;

    return safeErPeriod + convergenceBars + erSmoothConvergenceBars + safeLookbackBars;
}

function calculateAMA(closes: any, params: any) {
    if (!params || typeof params !== 'object') {
        throw new TypeError('calculateAMA params must be an object with erPeriod, fastPeriod, slowPeriod');
    }
    if (!Number.isFinite(params.erPeriod) || params.erPeriod <= 0) {
        throw new TypeError(`calculateAMA params.erPeriod must be a positive finite number, got ${params.erPeriod}`);
    }
    if (!Number.isFinite(params.fastPeriod) || params.fastPeriod <= 0) {
        throw new TypeError(`calculateAMA params.fastPeriod must be a positive finite number, got ${params.fastPeriod}`);
    }
    if (!Number.isFinite(params.slowPeriod) || params.slowPeriod <= 0) {
        throw new TypeError(`calculateAMA params.slowPeriod must be a positive finite number, got ${params.slowPeriod}`);
    }
    if (!Array.isArray(closes)) {
        throw new TypeError('calculateAMA closes must be an array');
    }

    const indicator = new AMA(params.erPeriod, params.fastPeriod, params.slowPeriod, params.erSmoothPeriod);
    return closes.map(price => indicator.update(price));
}

export { calculateAMA, getAmaWarmupBars }

