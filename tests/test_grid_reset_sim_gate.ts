'use strict';

const assert = require('assert');

console.log('Running grid_reset_sim persistence-gate tests');

const { simulateGridResetSeries, GRID_RESET_SLOPE, GRID_RESET_PRICE } = require('../analysis/tradingview/grid_reset_sim');

// Minimal valid AMA series; the estimator is scripted so the test exercises the
// gate, not the slope math.
const AMA = new Array(60).fill(100);

function runSim(scripted, persistBars, opts = {}) {
    return simulateGridResetSeries(AMA, {
        priceDeltaThresholdPercent: 0,
        slopeDeltaThresholdPercent: 0.01,
        slopeEnabled: true,
        erPeriod: 0,
        lookbackBars: 0,
        warmupBars: 0,
        clipPercentile: 0,
        slopePersistBars: persistBars,
        slopeEstimator: (_series, i) => (i < scripted.length ? scripted[i] : null),
        ...opts,
    });
}

function firstSlopeReset(sim) {
    const ev = sim.events.find((e) => e.reason === GRID_RESET_SLOPE);
    return ev ? ev.index : null;
}

function countSlopeResets(sim) {
    return sim.events.filter((e) => e.reason === GRID_RESET_SLOPE).length;
}

function testSustainedMoveLatency() {
    // Slope flat at 0, then sustained +0.02 from bar 10 onward.
    const scripted = new Array(60).fill(0);
    for (let i = 10; i < 60; i++) scripted[i] = 0.02;

    const k1 = runSim(scripted, 1);
    const k3 = runSim(scripted, 3);
    const k5 = runSim(scripted, 5);

    assert.strictEqual(firstSlopeReset(k1), 10, 'K=1 fires on the first crossing');
    assert.strictEqual(firstSlopeReset(k3), 12, 'K=3 fires after 3 confirming bars');
    assert.strictEqual(firstSlopeReset(k5), 14, 'K=5 fires after 5 confirming bars');
    console.log(' - sustained move fires exactly after K bars ok');
}

function testSingleBarExcursionFiltered() {
    // One 1-bar excursion; K=1 acts on it, K=3 must ignore it entirely.
    const scripted = new Array(60).fill(0);
    scripted[10] = 0.02;

    assert.ok(countSlopeResets(runSim(scripted, 1)) >= 1, 'K=1 acts on a 1-bar blip');
    assert.strictEqual(countSlopeResets(runSim(scripted, 3)), 0, 'K=3 ignores a 1-bar blip');
    console.log(' - single-bar excursion filtered by persistence ok');
}

function testDirectionFlipResetsCounter() {
    // +0.02 for two bars, flip to -0.02: the counter must restart, not fire.
    const scripted = new Array(60).fill(0);
    scripted[10] = 0.02;
    scripted[11] = 0.02;
    scripted[12] = -0.02;
    scripted[13] = -0.02;
    scripted[14] = -0.02;

    const k3 = runSim(scripted, 3);
    const first = firstSlopeReset(k3);
    assert.strictEqual(first, 14, 'direction flip restarts the counter; fires after 3 of the new direction');
    console.log(' - direction flip restarts the persistence counter ok');
}

function main() {
    testSustainedMoveLatency();
    testSingleBarExcursionFiltered();
    testDirectionFlipResetsCounter();
    console.log('All grid_reset_sim persistence-gate tests passed!');
}

main();
