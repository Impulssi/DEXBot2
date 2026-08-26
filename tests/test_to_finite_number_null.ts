/**
 * tests/test_to_finite_number_null.ts
 *
 * Regression coverage for the toFiniteNumber overload semantics:
 * passing null as defaultValue must return null for non-finite input
 * (previously undefined triggered the default-0 overload, so call sites
 * asking for a nullable read silently received 0 instead of null).
 */

const assert = require('assert');
const { toFiniteNumber } = require('../modules/order/format');

console.log('Testing toFiniteNumber null-overload semantics...\n');

// Default contract: non-finite falls back to 0.
assert.strictEqual(toFiniteNumber(NaN), 0, 'default fallback for NaN must be 0');
assert.strictEqual(toFiniteNumber(undefined), 0, 'default fallback for undefined must be 0');
assert.strictEqual(toFiniteNumber('not-a-number'), 0, "default fallback for garbage strings must be 0");
assert.strictEqual(toFiniteNumber(Infinity), 0, 'default fallback for Infinity must be 0');

// Explicit null: non-finite yields null (the fixed behavior under test).
assert.strictEqual(toFiniteNumber('not-a-number', null), null, 'null default must surface null for garbage strings');
assert.strictEqual(toFiniteNumber(NaN, null), null, 'null default must surface null for NaN');
assert.strictEqual(toFiniteNumber(undefined, null), null, 'null default must surface null for undefined');
assert.strictEqual(toFiniteNumber(Infinity, null), null, 'null default must surface null for Infinity');

// Finite values pass through unchanged regardless of default.
assert.strictEqual(toFiniteNumber('12.5', null), 12.5);
assert.strictEqual(toFiniteNumber(0, null), 0, 'zero is finite and must pass through as 0, not null');
assert.strictEqual(toFiniteNumber(-3.25), -3.25);

// Numeric default still honored.
assert.strictEqual(toFiniteNumber('x', 7), 7);

console.log('All toFiniteNumber null-overload assertions passed.');
