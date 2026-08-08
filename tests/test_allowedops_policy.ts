/**
 * Test: allowedOps parameter constraint validation
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../modules/credential_policy');
const { readJSON, writeJSON } = require('../modules/storage').getStorage();

console.log('Testing allowedOps per-operation parameter constraints...\n');

// Test 1: Validate allowedOps in full config
console.log('[Test 1] Validate allowedOps in full config');
const configWithAllowedOps = {
    default: {
        allowedOps: {
            limit_order_create: {
                allowedSellAssets: ['1.3.0', '1.3.861'],
                allowedReceiveAssets: ['1.3.0', '1.3.861'],
                maxSellAmount: 1000000,
            },
            limit_order_cancel: null,
            limit_order_update: {
                maxDeltaSellAmount: 500000,
            },
        },
    },
};
const result1 = policy.validatePolicyConfig(configWithAllowedOps);
assert.strictEqual(result1.valid, true, `Policy validation failed: ${result1.errors.join('; ')}`);
console.log('  ✓ Valid allowedOps config accepted');

// Test 2: Reject invalid allowedOps
console.log('[Test 2] Reject invalid allowedOps structure');
const invalidConfig = {
    default: {
        allowedOps: {
            limit_order_create: {
                allowedSellAssets: 'not_an_array',
            },
        },
    },
};
const result2 = policy.validatePolicyConfig(invalidConfig);
assert.strictEqual(result2.valid, false, 'Should reject invalid allowedSellAssets');
assert(result2.errors.some(e => e.includes('allowedSellAssets')), `Expected asset error, got: ${result2.errors.join('; ')}`);
console.log('  ✓ Invalid allowedSellAssets rejected');

// Test 3: Reject invalid maxSellAmount
console.log('[Test 3] Reject non-positive maxSellAmount');
const invalidAmount = {
    default: {
        allowedOps: {
            limit_order_create: { maxSellAmount: 'not_a_number' },
        },
    },
};
const result3 = policy.validatePolicyConfig(invalidAmount);
assert.strictEqual(result3.valid, false);
console.log('  ✓ Invalid maxSellAmount rejected');

// Test 4: Evaluate allowedOps - asset whitelist
console.log('[Test 4] Evaluate allowedOps - asset whitelist enforcement');
(async () => {
    const testPolicy = {
        allowedOps: {
            limit_order_create: {
                allowedSellAssets: ['1.3.0'],
                allowedReceiveAssets: ['1.3.861'],
            },
        },
        maxOpsPerBatch: 20,
    };

    // Should allow: op uses whitelisted assets
    const context1 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { asset_id: '1.3.0', amount: 100 },
                    min_to_receive: { asset_id: '1.3.861', amount: 50 },
                },
            },
        ],
    };
    const evalResult1 = await policy.evaluatePolicy(testPolicy, context1);
    assert.strictEqual(evalResult1.allow, true, `Expected allow, got deny: ${evalResult1.reason}`);
    console.log('  ✓ Whitelisted assets allowed');

    // Should deny: sell asset not whitelisted
    const context2 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { asset_id: '1.3.999', amount: 100 },
                    min_to_receive: { asset_id: '1.3.861', amount: 50 },
                },
            },
        ],
    };
    const evalResult2 = await policy.evaluatePolicy(testPolicy, context2);
    assert.strictEqual(evalResult2.allow, false, 'Expected deny for non-whitelisted asset');
    assert.strictEqual(evalResult2.policyId, 'opParams');
    console.log('  ✓ Non-whitelisted sell asset denied');

    // Should deny: receive asset not whitelisted
    const context3 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { asset_id: '1.3.0', amount: 100 },
                    min_to_receive: { asset_id: '1.3.999', amount: 50 },
                },
            },
        ],
    };
    const evalResult3 = await policy.evaluatePolicy(testPolicy, context3);
    assert.strictEqual(evalResult3.allow, false, 'Expected deny for non-whitelisted receive asset');
    assert.strictEqual(evalResult3.policyId, 'opParams');
    console.log('  ✓ Non-whitelisted receive asset denied');

    // Test 5: Evaluate allowedOps - amount limits
    console.log('[Test 5] Evaluate allowedOps - amount limit enforcement');
    const testPolicy2 = {
        allowedOps: {
            limit_order_create: {
                maxSellAmount: 1000,
                maxReceiveAmount: 500,
            },
        },
        maxOpsPerBatch: 20,
    };

    // Should allow: amounts within limit
    const context4 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: 500 },
                    min_to_receive: { amount: 250 },
                },
            },
        ],
    };
    const evalResult4 = await policy.evaluatePolicy(testPolicy2, context4);
    assert.strictEqual(evalResult4.allow, true, `Expected allow, got deny: ${evalResult4.reason}`);
    console.log('  ✓ Amounts within limit allowed');

    // Should deny: sell amount exceeds limit
    const context5 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'limit_order_create',
                op_data: {
                    amount_to_sell: { amount: 2000 },
                    min_to_receive: { amount: 250 },
                },
            },
        ],
    };
    const evalResult5 = await policy.evaluatePolicy(testPolicy2, context5);
    assert.strictEqual(evalResult5.allow, false, 'Expected deny for amount exceeding limit');
    assert(evalResult5.reason.includes('maxSellAmount'));
    console.log('  ✓ Amount exceeding sell limit denied');

    // Test 6: Backward compatibility - fallback to allowedOpTypes
    console.log('[Test 6] Backward compatibility - fallback to allowedOpTypes');
    const legacyPolicy = {
        allowedOpTypes: ['limit_order_create'],
        maxOpsPerBatch: 20,
    };

    const context6 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            { op_name: 'limit_order_create', op_data: {} },
        ],
    };
    const evalResult6 = await policy.evaluatePolicy(legacyPolicy, context6);
    assert.strictEqual(evalResult6.allow, true, 'Legacy allowedOpTypes should work');
    console.log('  ✓ Legacy allowedOpTypes fallback works');

    // Should deny: operation not in legacy allowedOpTypes
    const context7 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            { op_name: 'transfer', op_data: {} },
        ],
    };
    const evalResult7 = await policy.evaluatePolicy(legacyPolicy, context7);
    assert.strictEqual(evalResult7.allow, false);
    assert.strictEqual(evalResult7.policyId, 'allowedOpTypes');
    console.log('  ✓ Legacy allowedOpTypes denies unlisted op types');

    // Test 7: limit_order_update delta amount
    console.log('[Test 7] Evaluate allowedOps - limit_order_update delta amount');
    const testPolicy3 = {
        allowedOps: {
            limit_order_update: {
                maxDeltaSellAmount: 1000,
            },
        },
        maxOpsPerBatch: 20,
    };

    // Should allow: delta within limit
    const context8 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'limit_order_update',
                op_data: {
                    delta_amount_to_sell: { amount: 500 },
                },
            },
        ],
    };
    const evalResult8 = await policy.evaluatePolicy(testPolicy3, context8);
    assert.strictEqual(evalResult8.allow, true, `Expected allow, got deny: ${evalResult8.reason}`);
    console.log('  ✓ Delta within limit allowed');

    // Should deny: absolute value of delta exceeds limit
    const context9 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'limit_order_update',
                op_data: {
                    delta_amount_to_sell: { amount: -2000 },
                },
            },
        ],
    };
    const evalResult9 = await policy.evaluatePolicy(testPolicy3, context9);
    assert.strictEqual(evalResult9.allow, false, 'Expected deny for delta exceeding limit');
    assert(evalResult9.reason.includes('maxDeltaSellAmount'));
    console.log('  ✓ Delta exceeding limit denied (absolute value)');

    // Test 8: Required loader should fail on missing policy file
    console.log('[Test 8] Required loader rejects missing policy file');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-policy-'));
    const policyPath = path.join(tempDir, 'daemon-policies.json');
    assert.throws(
        () => policy.loadRequiredPolicyConfig(policyPath),
        /Required policy config missing:/,
        'Missing policy file should fail closed'
    );
    console.log('  ✓ Missing policy file rejected');

    // Test 9: Required loader should fail on invalid policy
    console.log('[Test 9] Required loader rejects invalid policy');
    const validPolicy = {
        default: {
            maxOpsPerBatch: 7,
            allowedOps: {
                limit_order_create: null,
            },
        },
    };
    fs.writeFileSync(policyPath, '{"default":', 'utf8');
    assert.throws(
        () => policy.loadRequiredPolicyConfig(policyPath),
        /Required policy config invalid:/,
        'Invalid policy file should fail closed'
    );
    console.log('  ✓ Invalid policy file rejected');

    // Test 10: Required loader should accept valid policy
    console.log('[Test 10] Required loader accepts valid policy');
    writeJSON(policyPath, validPolicy);
    const requiredPolicy = policy.loadRequiredPolicyConfig(policyPath);
    assert.deepStrictEqual(requiredPolicy, validPolicy, 'Valid policy should load successfully');
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('  ✓ Valid policy file accepted');

    // Test 11: Policy preflight should create a minimal valid policy
    console.log('[Test 11] Policy preflight creates minimal policy file');
    const preflightDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-policy-preflight-'));
    const preflightPath = path.join(preflightDir, 'nested', 'daemon-policies.json');
    const ensuredPolicy = policy.ensurePolicyConfig(preflightPath);
    assert.deepStrictEqual(ensuredPolicy, { accounts: {} }, 'Missing policy should be initialized minimally');
    assert.deepStrictEqual(
        readJSON(preflightPath),
        { accounts: {} },
        'Initialized policy should be written to disk'
    );
    assert.strictEqual((fs.statSync(preflightPath).mode & 0o777), 0o600, 'Initialized policy should be private');
    fs.writeFileSync(preflightPath, '{"accounts":', 'utf8');
    assert.throws(
        () => policy.ensurePolicyConfig(preflightPath),
        /Required policy config invalid:/,
        'Invalid existing policy should fail closed'
    );
    fs.rmSync(preflightDir, { recursive: true, force: true });
    console.log('  ✓ Policy preflight initializes missing file and rejects invalid file');

    // Test 12: allowFillOrKill constraint
    console.log('[Test 12] Evaluate allowedOps - allowFillOrKill constraint');
    const testPolicy4 = {
        allowedOps: {
            limit_order_create: {
                allowFillOrKill: false,
            },
        },
        maxOpsPerBatch: 20,
    };

    // Should deny: fill_or_kill=true when not allowed
    const context10 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'limit_order_create',
                op_data: {
                    fill_or_kill: true,
                },
            },
        ],
    };
    const evalResult10 = await policy.evaluatePolicy(testPolicy4, context10);
    assert.strictEqual(evalResult10.allow, false, 'Expected deny for fill_or_kill=true');
    assert(evalResult10.reason.includes('fill_or_kill'));
    console.log('  ✓ fill_or_kill=true denied when not allowed');

    // Should allow: fill_or_kill=false
    const context11 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'limit_order_create',
                op_data: {
                    fill_or_kill: false,
                },
            },
        ],
    };
    const evalResult11 = await policy.evaluatePolicy(testPolicy4, context11);
    assert.strictEqual(evalResult11.allow, true, `Expected allow, got deny: ${evalResult11.reason}`);
    console.log('  ✓ fill_or_kill=false allowed');

    // Test 9: transfer parameter validation
    console.log('[Test 13] Evaluate allowedOps - transfer parameter validation');
    const transferPolicy = {
        allowedOps: {
            transfer: {
                allowedToAccounts: ['1.2.100'],
                allowedAssets: ['1.3.0'],
                maxAmount: 1000,
            },
        },
        maxOpsPerBatch: 20,
    };

    // Should allow: recipient and asset whitelisted, amount within limit
    const context12 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'transfer',
                op_data: {
                    to: '1.2.100',
                    amount: { asset_id: '1.3.0', amount: 500 },
                },
            },
        ],
    };
    const evalResult12 = await policy.evaluatePolicy(transferPolicy, context12);
    assert.strictEqual(evalResult12.allow, true, `Expected allow, got deny: ${evalResult12.reason}`);
    console.log('  ✓ transfer within limits allowed');

    // Should deny: recipient not whitelisted
    const context13 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'transfer',
                op_data: {
                    to: '1.2.999',
                    amount: { asset_id: '1.3.0', amount: 500 },
                },
            },
        ],
    };
    const evalResult13 = await policy.evaluatePolicy(transferPolicy, context13);
    assert.strictEqual(evalResult13.allow, false, 'Expected deny for non-whitelisted recipient');
    assert(evalResult13.reason.includes('recipient'));
    console.log('  ✓ transfer to non-whitelisted recipient denied');

    // Should deny: amount exceeds limit
    const context14 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'transfer',
                op_data: {
                    to: '1.2.100',
                    amount: { asset_id: '1.3.0', amount: 2000 },
                },
            },
        ],
    };
    const evalResult14 = await policy.evaluatePolicy(transferPolicy, context14);
    assert.strictEqual(evalResult14.allow, false, 'Expected deny for amount exceeding limit');
    assert(evalResult14.reason.includes('maxAmount'));
    console.log('  ✓ transfer exceeding limit denied');

    // Test 10: call_order_update parameter validation
    console.log('[Test 14] Evaluate allowedOps - call_order_update parameter validation');
    const callPolicy = {
        allowedOps: {
            call_order_update: {
                allowedAssets: ['1.3.0', '1.3.861'],
                maxDeltaCollateral: 1000,
                maxDeltaDebt: 500,
            },
        },
        maxOpsPerBatch: 20,
    };

    // Should allow: assets and deltas within limits
    const context15 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'call_order_update',
                op_data: {
                    delta_collateral: { asset_id: '1.3.0', amount: 500 },
                    delta_debt: { asset_id: '1.3.861', amount: 250 },
                },
            },
        ],
    };
    const evalResult15 = await policy.evaluatePolicy(callPolicy, context15);
    assert.strictEqual(evalResult15.allow, true, `Expected allow, got deny: ${evalResult15.reason}`);
    console.log('  ✓ call_order_update within limits allowed');

    // Should deny: collateral delta exceeds limit
    const context16 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'call_order_update',
                op_data: {
                    delta_collateral: { asset_id: '1.3.0', amount: -1500 },
                    delta_debt: { asset_id: '1.3.861', amount: 250 },
                },
            },
        ],
    };
    const evalResult16 = await policy.evaluatePolicy(callPolicy, context16);
    assert.strictEqual(evalResult16.allow, false, 'Expected deny for delta_collateral exceeding limit');
    assert(evalResult16.reason.includes('maxDeltaCollateral'));
    console.log('  ✓ call_order_update exceeding collateral limit denied');

    const crPolicy = {
        allowedOps: {
            call_order_update: {
                minCollateralRatio: 2,
                maxCollateralRatio: 2.5,
            },
        },
    };
    const context16b = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'call_order_update',
                op_data: {
                    delta_collateral: { asset_id: '1.3.0', amount: 500 },
                    delta_debt: { asset_id: '1.3.861', amount: 250 },
                    extensions: { target_collateral_ratio: 2200 },
                },
            },
        ],
    };
    const evalResult16b = await policy.evaluatePolicy(crPolicy, context16b);
    assert.strictEqual(evalResult16b.allow, true, `Expected allow for Graphene-scaled target CR, got deny: ${evalResult16b.reason}`);
    console.log('  ✓ call_order_update Graphene target collateral ratio allowed');

    // Test 11: liquidity_pool_exchange parameter validation
    console.log('[Test 15] Evaluate allowedOps - liquidity_pool_exchange parameter validation');
    const lpHookPolicy = {
        allowedOps: {
            liquidity_pool_exchange: {
                allowedPools: ['1.19.0'],
                allowedSellAssets: ['1.3.0'],
                maxSellAmount: 1000,
            },
        },
        maxOpsPerBatch: 20,
    };

    // Should allow: pool and amount within limits
    const context17 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'liquidity_pool_exchange',
                op_data: {
                    pool: '1.19.0',
                    amount_to_sell: { asset_id: '1.3.0', amount: 500 },
                    min_to_receive: { asset_id: '1.3.861', amount: 250 },
                },
            },
        ],
    };
    const evalResult17 = await policy.evaluatePolicy(lpHookPolicy, context17);
    assert.strictEqual(evalResult17.allow, true, `Expected allow, got deny: ${evalResult17.reason}`);
    console.log('  ✓ liquidity_pool_exchange within limits allowed');

    // Should deny: pool not whitelisted
    const context18 = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'liquidity_pool_exchange',
                op_data: {
                    pool: '1.19.999',
                    amount_to_sell: { asset_id: '1.3.0', amount: 500 },
                    min_to_receive: { asset_id: '1.3.861', amount: 250 },
                },
            },
        ],
    };
    const evalResult18 = await policy.evaluatePolicy(lpHookPolicy, context18);
    assert.strictEqual(evalResult18.allow, false, 'Expected deny for non-whitelisted pool');
    assert(evalResult18.reason.includes('pool'));
    console.log('  ✓ liquidity_pool_exchange for non-whitelisted pool denied');

    // Test 12: credit_offer_accept parameter validation
    console.log('[Test 16] Evaluate allowedOps - credit_offer_accept parameter validation');
    const creditOfferPolicy = {
        allowedOps: {
            credit_offer_accept: {
                allowedOfferIds: ['1.18.42'],
                collateralAsset: '1.3.861',
                maxFeeRate: 30000,
                minDurationSeconds: 3600,
            },
        },
        maxOpsPerBatch: 20,
    };

    const creditOfferContext = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'credit_offer_accept',
                op_data: {
                    borrower: '1.2.100',
                    offer_id: '1.18.42',
                    borrow_amount: { asset_id: '1.3.0', amount: 500 },
                    collateral: { asset_id: '1.3.861', amount: 1500 },
                    max_fee_rate: 30000,
                    min_duration_seconds: 3600,
                    extensions: {},
                },
            },
        ],
    };
    const creditOfferResult = await policy.evaluatePolicy(creditOfferPolicy, creditOfferContext);
    assert.strictEqual(creditOfferResult.allow, true, `Expected allow, got deny: ${creditOfferResult.reason}`);
    console.log('  ✓ credit_offer_accept within limits allowed');

    const creditOfferTooExpensive = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'credit_offer_accept',
                op_data: {
                    borrower: '1.2.100',
                    offer_id: '1.18.42',
                    borrow_amount: { asset_id: '1.3.0', amount: 500 },
                    collateral: { asset_id: '1.3.861', amount: 1500 },
                    max_fee_rate: 40000,
                    min_duration_seconds: 3600,
                    extensions: {},
                },
            },
        ],
    };
    const creditOfferTooExpensiveResult = await policy.evaluatePolicy(creditOfferPolicy, creditOfferTooExpensive);
    assert.strictEqual(creditOfferTooExpensiveResult.allow, false, 'Expected deny for fee rate above maxFeeRate');
    assert(creditOfferTooExpensiveResult.reason.includes('max_fee_rate'));
    console.log('  ✓ credit_offer_accept fee cap enforced');

    const creditOfferWrongOffer = JSON.parse(JSON.stringify(creditOfferContext));
    creditOfferWrongOffer.operations[0].op_data.offer_id = '1.18.999';
    const creditOfferWrongOfferResult = await policy.evaluatePolicy(creditOfferPolicy, creditOfferWrongOffer);
    assert.strictEqual(creditOfferWrongOfferResult.allow, false, 'Expected deny for non-whitelisted credit offer');
    assert(creditOfferWrongOfferResult.reason.includes('allowedOfferIds'));
    console.log('  ✓ credit_offer_accept offer allowlist enforced');

    const creditOfferLargeOperation = JSON.parse(JSON.stringify(creditOfferContext));
    creditOfferLargeOperation.operations[0].op_data.borrow_amount.amount = 1001;
    creditOfferLargeOperation.operations[0].op_data.collateral.amount = 1601;
    const creditOfferLargeOperationResult = await policy.evaluatePolicy(creditOfferPolicy, creditOfferLargeOperation);
    assert.strictEqual(
        creditOfferLargeOperationResult.allow,
        true,
        `Expected signer policy to leave cumulative amount caps to runtime, got deny: ${creditOfferLargeOperationResult.reason}`
    );
    console.log('  ✓ credit_offer_accept cumulative amount caps left to runtime');

    // Test 13: credit_deal_repay parameter validation
    console.log('[Test 17] Evaluate allowedOps - credit_deal_repay parameter validation');
    const creditRepayPolicy = {
        allowedOps: {
            credit_deal_repay: {
                disallowedDealIds: ['1.19.77'],
                maxRepayAmount: 800,
                maxCreditFee: 50,
            },
        },
        maxOpsPerBatch: 20,
    };

    const creditRepayContext = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'credit_deal_repay',
                op_data: {
                    account: '1.2.100',
                    deal_id: '1.19.77',
                    repay_amount: { asset_id: '1.3.0', amount: 500 },
                    credit_fee: { asset_id: '1.3.0', amount: 25 },
                },
            },
        ],
    };
    const creditRepayResult = await policy.evaluatePolicy(creditRepayPolicy, creditRepayContext);
    assert.strictEqual(creditRepayResult.allow, true, `Expected allow for excluded deal repay, got: ${creditRepayResult.reason}`);
    console.log('  ✓ credit_deal_repay excluded deal allowed (disallowedDealIds no longer blocks repay)');

    // Test 14: credit_deal_update parameter validation
    console.log('[Test 18] Evaluate allowedOps - credit_deal_update parameter validation');
    const creditUpdatePolicy = {
        allowedOps: {
            credit_deal_update: {
                disallowedDealIds: ['1.19.77'],
                allowAutoRepay: false,
            },
        },
        maxOpsPerBatch: 20,
    };

    const creditUpdateContext = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'credit_deal_update',
                op_data: {
                    account: '1.2.100',
                    deal_id: '1.19.77',
                    auto_repay: 1,
                },
            },
        ],
    };
    const creditUpdateResult = await policy.evaluatePolicy(creditUpdatePolicy, creditUpdateContext);
    assert.strictEqual(creditUpdateResult.allow, false, `Expected deny for excluded deal (allowAutoRepay), got: ${creditUpdateResult.reason}`);
    assert(creditUpdateResult.reason.includes('auto_repay'), `Expected reason about auto_repay, got: ${creditUpdateResult.reason}`);
    console.log('  ✓ credit_deal_update excluded deal denied by allowAutoRepay');

    // Test 18b: credit_deal_update auto_repay denied (non-excluded deal)
    console.log('[Test 18b] Evaluate allowedOps - credit_deal_update auto_repay restriction');
    const creditUpdateAutoRepayPolicy = {
        allowedOps: {
            credit_deal_update: {
                disallowedDealIds: ['1.19.77'],
                allowAutoRepay: false,
            },
        },
        maxOpsPerBatch: 20,
    };
    const creditUpdateAutoRepayContext = {
        accountName: 'test',
        requestType: 'sign',
        operations: [
            {
                op_name: 'credit_deal_update',
                op_data: {
                    account: '1.2.100',
                    deal_id: '1.19.99',
                    auto_repay: 1,
                },
            },
        ],
    };
    const creditUpdateAutoRepayResult = await policy.evaluatePolicy(creditUpdateAutoRepayPolicy, creditUpdateAutoRepayContext);
    assert.strictEqual(creditUpdateAutoRepayResult.allow, false, `Expected deny for disallowed auto_repay, got: ${creditUpdateAutoRepayResult.reason}`);
    assert(creditUpdateAutoRepayResult.reason.includes('auto_repay'), `Expected reason about auto_repay, got: ${creditUpdateAutoRepayResult.reason}`);
    console.log('  ✓ credit_deal_update auto_repay change denied');

    // Test 19: maxOpsPerBatch limit enforcement
    console.log('[Test 19] Evaluate allowedOps - maxOpsPerBatch limit enforcement');
    const batchContext = {
        accountName: 'test',
        requestType: 'sign',
        operations: new Array(150).fill({ op_name: 'limit_order_create' })
    };
    const batchResult = await policy.evaluatePolicy({ allowedOpTypes: ['limit_order_create'] }, batchContext);
    assert.strictEqual(batchResult.allow, true, `Expected allow for batch size 150, got: ${batchResult.reason}`);
    console.log('  ✓ Batch size 150 allowed by default');

    const batchContextTooBig = {
        accountName: 'test',
        requestType: 'sign',
        operations: new Array(201).fill({ op_name: 'limit_order_create' })
    };
    const batchResultTooBig = await policy.evaluatePolicy({ allowedOpTypes: ['limit_order_create'] }, batchContextTooBig);
    assert.strictEqual(batchResultTooBig.allow, false, 'Expected deny for batch size 201');
    assert(batchResultTooBig.reason.includes('exceeds maxOpsPerBatch 200'));
    console.log('  ✓ Batch size 201 denied by default');

    console.log('\n✓ All allowedOps tests passed!');
    process.exit(0);
})().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
