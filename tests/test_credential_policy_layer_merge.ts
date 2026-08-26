/**
 * tests/test_credential_policy_layer_merge.ts
 *
 * Regression coverage for resolveAccountPolicy layer merging:
 *   1. Per-op constraint merge preserves builtin/default op entries the
 *      layer does not mention (previously a shallow spread replaced the
 *      whole allowedOps map with the layer's partial one).
 *   2. Prototype-dangerous own keys ('__proto__') coming from JSON-parsed
 *      config cannot pollute Object.prototype via the per-op assignment.
 */

const assert = require('assert');
const policy = require('../modules/credential_policy');

console.log('Testing resolveAccountPolicy layer merging...\n');

// ── 1. Partial allowedOps layer deep-merges per op ──────────────────────────
{
    const builtinOps = Object.keys(policy.BUILTIN_DEFAULT_POLICY.allowedOps || {});
    assert.ok(builtinOps.length > 0, 'builtin policy must define allowedOps to merge against');

    const config = {
        default: {},
        accounts: {
            tester: {
                allowedOps: {
                    limit_order_create: { maxSellAmount: 555 }
                }
            }
        }
    };

    const merged = policy.resolveAccountPolicy(config, 'tester');

    // The overridden op carries the layer constraint...
    assert.strictEqual(merged.allowedOps.limit_order_create.maxSellAmount, 555,
        'layer constraint must win over the builtin value');

    // ...while every builtin op the layer did not mention survives.
    for (const opName of builtinOps) {
        if (opName === 'limit_order_create') continue;
        assert.ok(merged.allowedOps[opName] !== undefined,
            `builtin op "${opName}" must survive a partial allowedOps layer`);
    }

    console.log('  ✓ partial allowedOps layer merges per-op without dropping builtin ops');
}

// ── 2. '__proto__' op key from JSON config cannot pollute Object.prototype ──
{
    const evilConfig = JSON.parse('{"default":{},"accounts":{"evil":{"allowedOps":{"__proto__":{"isAdmin":true}}}}}');

    policy.resolveAccountPolicy(evilConfig, 'evil');

    const probe: any = {};
    assert.strictEqual(probe.isAdmin, undefined,
        "'__proto__' op key must be ignored instead of setting Object.prototype.isAdmin");

    console.log("  ✓ '__proto__' op keys are rejected safely");
}

console.log('\nAll credential policy layer-merge assertions passed.');
