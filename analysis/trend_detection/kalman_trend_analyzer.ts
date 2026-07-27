
import { smoothKalmanVelocityPoint } from './kalman_velocity_smoothing';
import { roundTo } from '../../modules/utils/math_utils';
'use strict';


/**
 * Kalman Trend Analyzer
 *
 * Implements a Constant Velocity Kalman Filter to estimate price and velocity.
 * Projects tangential "beams" (trajectories) forward in time.
 *
 * The Kalman filter is optimal for "State Estimation" in noisy environments
 * (like crypto markets). It separates the "true" price and velocity from
 * the high-frequency "noise" (wicks).
 */

interface KalmanFilterOpts {
    R?: number;
    Q?: number;
    dt?: number;
}

interface KalmanFilterState {
    x: number;
    v: number;
}

interface Beam {
    originX: number;
    originY: number;
    velocity: number;
    type: string;
}

interface KalmanTrendConfig {
    rNoise?: number;
    qTactical?: number;
    qModal?: number;
    qNoise?: number;
    beamCount?: number;
    dt?: number;
    warmupBars?: number;
}

export interface TrendAnalysis {
    isReady: boolean;
    price: number | null;
    kalmanPrice: number;
    modalPrice: number;
    velocity: number;
    velocityPct: number;
    velocityRawPct: number;
    velocityFilteredPct: number | null;
    velocityFilteredRawPct: number | null;
    displacementPct: number;
    displacementRawPct: number;
    signal: string;
    trend: string;
    confidence: number;
    updateCount: number;
    beams: Beam[];
    projections: { modal: number; tactical: number };
    timestamp?: number;
    hurst?: number;
    pe?: number;
    amaWeightOffset?: number | null;
}

class KalmanFilter {
    R: number;
    Q: number;
    dt: number;
    x: number;
    v: number;
    P00: number;
    P01: number;
    P10: number;
    P11: number;
    isInitialized: boolean;

    constructor(opts: KalmanFilterOpts = {}) {
        this.R = opts.R ?? 0.05;

        this.Q = opts.Q ?? 0.005;
        const dt = opts.dt;
        this.dt = dt != null && Number.isFinite(dt) && dt > 0 ? dt : 1;

        this.x = 0;
        this.v = 0;

        this.P00 = 1; this.P01 = 0;
        this.P10 = 0; this.P11 = 1;

        this.isInitialized = false;
    }

    update(z: number): KalmanFilterState {
        if (!Number.isFinite(z)) {
            return { x: this.x, v: this.v };
        }

        if (!this.isInitialized) {
            this.x = z;
            this.v = 0;
            const scale = z * z;
            this.P00 = scale * 100;
            this.P01 = 0;
            this.P10 = 0;
            this.P11 = scale;
            this.isInitialized = true;
            return { x: this.x, v: this.v };
        }

        // 1. Predict (Time Update)
        // x_new = x + v * dt
        // v_new = v
        const dt = this.dt;
        const x_p = this.x + (this.v * dt);
        const v_p = this.v;

        // P_new = F * P * F' + Q_matrix
        // F (Transition) = [[1, dt], [0, 1]]
        // Q_matrix = [[dt^3/3*q, dt^2/2*q], [dt^2/2*q, dt*q]]
        // This is a manual 2x2 matrix expansion for performance
        const q00 = ((dt * dt * dt) / 3) * this.Q;
        const q01 = ((dt * dt) / 2) * this.Q;
        const q11 = dt * this.Q;
        let p00 = this.P00 + (dt * this.P01) + (dt * this.P10) + (dt * dt * this.P11) + q00;
        let p01 = this.P01 + (dt * this.P11) + q01;
        let p10 = this.P10 + (dt * this.P11) + q01;
        let p11 = this.P11 + q11;

        // 2. Update (Measurement Update)
        const y = z - x_p;      // Innovation (error between measurement and prediction)
        const s = p00 + this.R; // Innovation covariance

        // Kalman Gain K = P * H' * S^-1
        // H (Observation) = [[1, 0]]
        const k0 = p00 / s;
        const k1 = p10 / s;

        // Corrected State
        this.x = x_p + k0 * y;
        this.v = v_p + k1 * y;

        // Corrected Covariance using Joseph form:
        // P = (I - K * H) * P * (I - K * H)' + K * R * K'
        const ikh00 = 1 - k0;
        const ikh01 = 0;
        const ikh10 = -k1;
        const ikh11 = 1;
        const t00 = ikh00 * p00 + ikh01 * p10;
        const t01 = ikh00 * p01 + ikh01 * p11;
        const t10 = ikh10 * p00 + ikh11 * p10;
        const t11 = ikh10 * p01 + ikh11 * p11;
        this.P00 = t00 * ikh00 + t01 * ikh01 + k0 * this.R * k0;
        this.P01 = t00 * ikh10 + t01 * ikh11 + k0 * this.R * k1;
        this.P10 = t10 * ikh00 + t11 * ikh01 + k1 * this.R * k0;
        this.P11 = t10 * ikh10 + t11 * ikh11 + k1 * this.R * k1;

        return { x: this.x, v: this.v };
    }
}

const MIN_PRICE_DENOMINATOR = 1e-10;

function safePct(numerator: any, denominator: any) {
    const pct = Math.abs(denominator) > MIN_PRICE_DENOMINATOR
        ? (numerator / denominator) * 100
        : 0;
    return Number.isFinite(pct) ? pct : 0;
}

class KalmanTrendAnalyzer {
    config: KalmanTrendConfig;
    tacticalKf: KalmanFilter;
    modalKf: KalmanFilter;
    beams: Beam[];
    inflections: any[];
    maxBeams: number;
    warmupBars: number;
    updateCount: number;
    currPrice: number | null;
    tactical: { x: number; v: number };
    modal: { x: number; v: number };
    velocityFilteredPct: number | null;

    constructor(config: KalmanTrendConfig = {}) {
        this.config = { ...config };
        const rNoise = config.rNoise ?? 0.05;
        const qTactical = config.qTactical ?? config.qNoise ?? 0.01;
        const qModal = config.qModal ?? config.qNoise ?? 0.0001;
        const _dt = config.dt;
        const dt = _dt != null && Number.isFinite(_dt) && _dt > 0 ? _dt : 1;

        // Tactical Filter: For short-term heading and inflections
        this.tacticalKf = new KalmanFilter({
            R: rNoise,
            Q: qTactical,
            dt
        });

        // Modal Filter: For long-term equilibrium (The "Center of Gravity")
        this.modalKf = new KalmanFilter({
            R: rNoise,
            Q: qModal,
            dt
        });

        this.beams = [];
        this.inflections = [];
        this.maxBeams = config.beamCount ?? 100;
        const wb = config.warmupBars;
        this.warmupBars = wb != null && Number.isInteger(wb) && wb >= 0
            ? wb
            : 20;
        this.updateCount = 0;

        this.currPrice = null;
        this.tactical = { x: 0, v: 0 };
        this.modal = { x: 0, v: 0 };
        this.velocityFilteredPct = null;
    }

    /**
     * Update with a new market price
     */
    update(price: number): TrendAnalysis {
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error('price must be a positive finite number');
        }

        this.currPrice = price;
        const prevTactical = { ...this.tactical };

        this.tactical = this.tacticalKf.update(price);
        this.modal = this.modalKf.update(price);

        // Detect Inflections (Velocity Change)
        // We look for significant changes in heading to spawn new beams
        const velChange = Math.abs(this.tactical.v - prevTactical.v);
        const isInflection = velChange > (price * 0.001); // 0.1% price movement in velocity

        if (isInflection || this.updateCount % 20 === 0) {
            this.beams.push({
                originX: this.updateCount,
                originY: this.tactical.x,
                velocity: this.tactical.v,
                type: this.tactical.v > 0 ? 'BULL' : 'BEAR'
            });
            if (this.beams.length > this.maxBeams) this.beams.shift();
        }

        const displacementPct = safePct(this.currPrice - this.modal.x, this.modal.x);
        const rawVelocityPct = safePct(this.tactical.v, this.modal.x);
        // Keep the analyzer's filtered velocity on the same smoothing path that the
        // research chart and live market adapter use at their default knob values.
        const smoothingResult = smoothKalmanVelocityPoint(
            rawVelocityPct,
            displacementPct,
            this.velocityFilteredPct
        );
        this.velocityFilteredPct = smoothingResult.smoothedVelocityPct;

        this.updateCount++;
        return this.getAnalysis();
    }

    getAnalysis(): TrendAnalysis {
        const displacement = this.currPrice! - this.modal.x;
        const displacementPct = safePct(displacement, this.modal.x);
        const rawVelocityPct = safePct(this.tactical.v, this.modal.x);

        // Signal Regime Logic
        let signal = 'NEUTRAL';
        if (displacementPct > 0.5 && this.tactical.v > 0) signal = 'BULLISH_DISPLACEMENT';
        if (displacementPct < -0.5 && this.tactical.v < 0) signal = 'BEARISH_DISPLACEMENT';
        if (Math.abs(displacementPct) < 0.2) signal = 'EQUILIBRIUM';

        let trend = 'FLAT';
        if (this.tactical.v > 0) trend = 'UP';
        else if (this.tactical.v < 0) trend = 'DOWN';

        // Confidence rises with warmup progress and signal clarity (velocity magnitude)
        const warmupRatio = Math.min(1, this.updateCount / (this.warmupBars || 1));
        const confidence = Math.min(100, Math.round(
            warmupRatio * 60 + Math.min(40, Math.abs(rawVelocityPct) * 8)
        ));

        return {
            isReady: this.updateCount > this.warmupBars,
            price: this.currPrice,
            kalmanPrice: roundTo(this.tactical.x, 1e8),
            modalPrice: roundTo(this.modal.x, 1e8),
            velocity: roundTo(this.tactical.v, 1e8),
            velocityPct: roundTo(rawVelocityPct, 100),
            velocityRawPct: rawVelocityPct,
            velocityFilteredPct: this.velocityFilteredPct == null ? null : roundTo(this.velocityFilteredPct, 100),
            velocityFilteredRawPct: this.velocityFilteredPct,
            displacementPct: roundTo(displacementPct, 100),
            displacementRawPct: displacementPct,
            signal,
            trend,
            confidence,
            updateCount: this.updateCount,
            beams: this.beams,
            projections: {
                modal: this.modal.x + (this.modal.v * 50),
                tactical: this.tactical.x + (this.tactical.v * 50)
            }
        };
    }

    reset(): void {
        const rNoise = this.config.rNoise ?? 0.05;
        const qTactical = this.config.qTactical ?? this.config.qNoise ?? 0.01;
        const qModal = this.config.qModal ?? this.config.qNoise ?? 0.0001;
        const _resetDt = this.config.dt;
        const dt = _resetDt != null && Number.isFinite(_resetDt) && _resetDt > 0 ? _resetDt : 1;
        this.tacticalKf = new KalmanFilter({ R: rNoise, Q: qTactical, dt });
        this.modalKf = new KalmanFilter({ R: rNoise, Q: qModal, dt });
        this.beams = [];
        this.updateCount = 0;
        this.currPrice = null;
        this.tactical = { x: 0, v: 0 };
        this.modal = { x: 0, v: 0 };
        this.velocityFilteredPct = null;
    }
}

export { KalmanTrendAnalyzer, KalmanFilter }

