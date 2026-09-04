/**
 * tests/test_buy_window_config.ts
 *
 * Unit tests for buy-window behavior resolvers (bots.json: buyFloorUSDT,
 * buyDelayMinutes, buyWindowMode). Uses native assert to avoid Jest dependency.
 */

const assert = require('assert');
const { resolveBuyFloorUsdt, resolveBuyDelayMs, resolveBuyWindowMode, BUY_WINDOW_DEFAULTS } = require('../modules/order/utils/math');

let passed = 0;
function check(name, actual, expected) {
    assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`);
    passed++;
}

// --- resolveBuyFloorUsdt ---
check('floor default (missing)', resolveBuyFloorUsdt({}), BUY_WINDOW_DEFAULTS.floorUsdt);
check('floor default value is 1.0', BUY_WINDOW_DEFAULTS.floorUsdt, 1.0);
check('floor explicit 2.5', resolveBuyFloorUsdt({ buyFloorUSDT: 2.5 }), 2.5);
check('floor explicit string "0.75"', resolveBuyFloorUsdt({ buyFloorUSDT: '0.75' }), 0.75);
check('floor 0 disables', resolveBuyFloorUsdt({ buyFloorUSDT: 0 }), 0);
check('floor negative falls back', resolveBuyFloorUsdt({ buyFloorUSDT: -1 }), 1.0);
check('floor NaN falls back', resolveBuyFloorUsdt({ buyFloorUSDT: 'abc' }), 1.0);
check('floor null falls back', resolveBuyFloorUsdt({ buyFloorUSDT: null }), 1.0);
check('floor null config falls back', resolveBuyFloorUsdt(null), 1.0);

// --- resolveBuyDelayMs ---
check('delay default (missing)', resolveBuyDelayMs({}), 15 * 60 * 1000);
check('delay explicit 15', resolveBuyDelayMs({ buyDelayMinutes: 15 }), 15 * 60 * 1000);
check('delay explicit 5', resolveBuyDelayMs({ buyDelayMinutes: 5 }), 5 * 60 * 1000);
check('delay 0 disables', resolveBuyDelayMs({ buyDelayMinutes: 0 }), 0);
check('delay negative falls back', resolveBuyDelayMs({ buyDelayMinutes: -5 }), 15 * 60 * 1000);
check('delay NaN falls back', resolveBuyDelayMs({ buyDelayMinutes: 'soon' }), 15 * 60 * 1000);
check('delay null config falls back', resolveBuyDelayMs(undefined), 15 * 60 * 1000);

// --- resolveBuyWindowMode ---
check('window default (missing)', resolveBuyWindowMode({}), 'low');
check('window explicit low', resolveBuyWindowMode({ buyWindowMode: 'low' }), 'low');
check('window explicit closest', resolveBuyWindowMode({ buyWindowMode: 'closest' }), 'closest');
check('window case-insensitive', resolveBuyWindowMode({ buyWindowMode: 'Closest' }), 'closest');
check('window invalid falls back', resolveBuyWindowMode({ buyWindowMode: 'moon' }), 'low');
check('window null falls back', resolveBuyWindowMode({ buyWindowMode: null }), 'low');

console.log(`✓ Buy window config tests passed! (${passed} assertions)`);
