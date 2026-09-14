const assert = require('assert');

console.log('Running seam-resolve helper tests');

// These helpers encode the exact null/zero semantics of the timing test
// seams. Getting them wrong is how a `0` (meaning "no delay") silently turns
// into the production default, or how `null` silently turns into `0`
// (Number(null) === 0) — both bugs this suite exists to pin down.
const { resolveSeamMs, resolveSeamMsOrNull } = require('../modules/utils/errors');

// ---------------------------------------------------------------------------
// resolveSeamMs(value, fallback)
// ---------------------------------------------------------------------------

// Explicit 0 means "no delay" and must beat the fallback.
assert.strictEqual(resolveSeamMs(0, 1500), 0, 'explicit 0 must be honored, not treated as absent');
assert.strictEqual(resolveSeamMs('0', 1500), 0, 'string "0" must be honored');

// Absent / invalid values fall through to the production default.
assert.strictEqual(resolveSeamMs(undefined, 1500), 1500, 'undefined must fall back');
assert.strictEqual(resolveSeamMs(null, 1500), 1500, 'null must fall back (Number(null) === 0 trap)');
assert.strictEqual(resolveSeamMs(NaN, 1500), 1500, 'NaN must fall back');
assert.strictEqual(resolveSeamMs('nonsense', 1500), 1500, 'non-numeric string must fall back');
assert.strictEqual(resolveSeamMs({}, 1500), 1500, 'object must fall back');
// Only null/undefined are treated as "absent". Other values that coerce to a
// non-negative number ([] -> 0, '' -> 0, true -> 1) are honored, matching the
// pre-helper seam behavior. Callers pass a scalar or nothing, so this is a
// documented edge of the contract rather than a supported input.
assert.strictEqual(resolveSeamMs([], 1500), 0, 'empty array coerces to 0 and is honored');
assert.strictEqual(resolveSeamMs('', 1500), 0, 'empty string coerces to 0 and is honored');
assert.strictEqual(resolveSeamMs(Infinity, 1500), 1500, 'Infinity is not finite and must fall back');
assert.strictEqual(resolveSeamMs(-1, 1500), 1500, 'negative delay is invalid and must fall back');

// Valid positive values pass through as numbers.
assert.strictEqual(resolveSeamMs(250, 1500), 250, 'positive number must pass through');
assert.strictEqual(resolveSeamMs('250', 1500), 250, 'numeric string must be coerced');
assert.strictEqual(resolveSeamMs(12.5, 1500), 12.5, 'fractional ms must pass through');

// Nesting (the COW poll-interval precedence: explicit option, then bot seam,
// then production default).
assert.strictEqual(resolveSeamMs(undefined, resolveSeamMs(undefined, 1500)), 1500, 'no seam -> production default');
assert.strictEqual(resolveSeamMs(undefined, resolveSeamMs(0, 1500)), 0, 'bot seam 0 -> 0');
assert.strictEqual(resolveSeamMs(0, resolveSeamMs(5, 1500)), 0, 'explicit option beats bot seam, including 0');
assert.strictEqual(resolveSeamMs(7, resolveSeamMs(5, 1500)), 7, 'explicit option beats bot seam');

// ---------------------------------------------------------------------------
// resolveSeamMsOrNull(value)
// ---------------------------------------------------------------------------

// The distinction from resolveSeamMs: "absent" is preserved as null so the
// caller can resolve its own fallback lazily.
assert.strictEqual(resolveSeamMsOrNull(0), 0, 'explicit 0 must be preserved as 0, not null');
assert.strictEqual(resolveSeamMsOrNull('0'), 0, 'string "0" must resolve to 0');
assert.strictEqual(resolveSeamMsOrNull(250), 250, 'positive number must pass through');
assert.strictEqual(resolveSeamMsOrNull(undefined), null, 'undefined must resolve to null');
assert.strictEqual(resolveSeamMsOrNull(null), null, 'null must resolve to null (Number(null) === 0 trap)');
assert.strictEqual(resolveSeamMsOrNull(NaN), null, 'NaN must resolve to null');
assert.strictEqual(resolveSeamMsOrNull('nonsense'), null, 'non-numeric string must resolve to null');
assert.strictEqual(resolveSeamMsOrNull([]), 0, 'empty array coerces to 0 and is honored');
assert.strictEqual(resolveSeamMsOrNull(-1), null, 'negative must resolve to null');
assert.strictEqual(resolveSeamMsOrNull(Infinity), null, 'Infinity must resolve to null');

// The caller pattern used by the credit/fill seams: `?? derivedDefault`.
assert.strictEqual(resolveSeamMsOrNull(0) ?? 50, 0, 'seam 0 must not be overridden by ?? default');
assert.strictEqual(resolveSeamMsOrNull(undefined) ?? 50, 50, 'absent seam must fall to ?? default');

console.log('✓ seam-resolve helper tests passed');
