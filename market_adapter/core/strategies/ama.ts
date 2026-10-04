'use strict';

import { MARKET_ADAPTER } from '../../../modules/constants.js';


/**
 * Kaufman's Adaptive Moving Average (KAMA/AMA).
 */
export interface AmaParams {
    erPeriod: number;
    fastPeriod: number;
    slowPeriod: number;
}

class AMA {
    erPeriod: number;
    fastSC: number;
    slowSC: number;
    prevAMA: number | null;
    history: number[];
    warmedUp: boolean;
    smaSum: number;
    smaCount: number;

    constructor(erPeriod: number, fastPeriod: number, slowPeriod: number) {
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

        this.fastSC = 2 / (fastPeriod + 1);
        this.slowSC = 2 / (slowPeriod + 1);
        this.prevAMA = null;
        this.history = [];
        this.warmedUp = false;
        this.smaSum = 0;
        this.smaCount = 0;
    }

    update(price: number): number {
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

        const prevAMA = this.prevAMA as number;
        const smooth = (er * (this.fastSC - this.slowSC) + this.slowSC) ** 2;
        const ama = prevAMA + smooth * (price - prevAMA);

        this.prevAMA = ama;
        return ama;
    }
}

function getAmaWarmupBars(erPeriod: number, slowPeriod: number, lookbackBars: number, fastPeriod: number): number {
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

    const safeErPeriod = Math.ceil(erPeriod);
    const safeSlowPeriod = Math.ceil(slowPeriod);
    const safeLookbackBars = Math.ceil(lookbackBars);
    const fastSC = 2 / (fastPeriod + 1);
    const slowSC = 2 / (safeSlowPeriod + 1);
    const deltaSC = fastSC - slowSC;
    const scAvg = (MARKET_ADAPTER.AMA_CONVERGENCE_ER_AVG * deltaSC + slowSC) ** 2;
    const convergenceBars = Math.ceil(
        Math.log(MARKET_ADAPTER.AMA_CONVERGENCE_EPSILON) / Math.log(1 - scAvg)
    );

    return safeErPeriod + convergenceBars + safeLookbackBars;
}

function calculateAMA(closes: number[], params: AmaParams): number[] {
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

    const indicator = new AMA(params.erPeriod, params.fastPeriod, params.slowPeriod);
    return closes.map(price => indicator.update(price));
}

export { calculateAMA, getAmaWarmupBars }

