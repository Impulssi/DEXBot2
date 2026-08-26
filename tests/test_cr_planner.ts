'use strict';

const assert = require('assert');
const {
  buildDebtFirstCrPlan,
  buildCollateralFallbackPlan,
  resolveMinCollateralIncreaseThreshold,
} = require('../modules/cr_planner');

function testDebtFirstPlanner() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 250,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    targetCollateralRatio: 2.2,
    maxBorrowAmount: 10,
    maxCollateralAmount: 10000,
  });

  assert(plan, 'plan should be produced for an out-of-band CR');
  assert.strictEqual(plan.action, 'reduce_debt', 'low CR should reduce debt first');
  assert.strictEqual(plan.fallbackAction, 'add_collateral', 'low CR should fallback to collateral');
  assert.strictEqual(plan.needsGridReset, true, 'CR change should require a grid reset');
  assert.strictEqual(plan.debtDelta, -37.5, 'debt reduction should not be capped by maxBorrowAmount');
  assert.strictEqual(plan.collateralDelta, 0, 'debt-first repair should fully resolve without adding collateral');
}

function testDebtCeilingOnIncrease() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 600,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    targetCollateralRatio: 2.2,
    maxBorrowAmount: 110,
    maxCollateralAmount: 10000,
  });

  assert(plan, 'plan should be produced for a high-CR position');
  assert.strictEqual(plan.action, 'increase_debt', 'high CR should still prefer debt increase');
  assert.strictEqual(plan.fallbackAction, 'withdraw_collateral', 'high CR should fallback to collateral withdrawal');
  assert.strictEqual(plan.debtDelta, 10, 'debt increase should be capped by total maxBorrowAmount');
  assert.strictEqual(plan.collateralDelta < 0, true, 'collateral should fall when debt increase is capped');
}

function testMinCollateralIncreaseThresholdSkipsSmallIncrease() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 520,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    maxBorrowAmount: 1000,
    maxCollateralAmount: 525,
    minCollateralIncreaseThreshold: 10,
  });

  assert.strictEqual(plan, null, 'small collateral increases should be skipped when below threshold');
}

function testMinCollateralIncreaseThresholdAllowsLargeIncrease() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 600,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    maxBorrowAmount: 1000,
    maxCollateralAmount: 700,
    minCollateralIncreaseThreshold: '10%',
  });

  assert(plan, 'large collateral increases should still allow debt planning');
  assert.strictEqual(plan.action, 'increase_debt');
  assert.strictEqual(plan.debtDelta, 20);
}

function testZeroMinCollateralIncreaseThresholdAllowsMissingBudget() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 600,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    maxBorrowAmount: 1000,
    minCollateralIncreaseThreshold: 0,
  });

  assert(plan, 'zero threshold should not require a collateral budget');
  assert.strictEqual(plan.action, 'increase_debt');
}

function testPercentMinCollateralIncreaseThresholdRequiresBudget() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 600,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    maxBorrowAmount: 1000,
    minCollateralIncreaseThreshold: '10%',
  });

  assert.strictEqual(plan, null, 'percentage threshold should require a collateral budget reference');
}

function testMalformedMinCollateralIncreaseThresholds() {
  assert.strictEqual(resolveMinCollateralIncreaseThreshold(null, 100), null);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold('', 100), null);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold('10%%', 100), null);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold('10abc%', 100), null);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold('abc', 100), null);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold('10', 100), null);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold(false, 100), null);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold(true, 100), null);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold([], 100), null);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold('.5%', 100), 0.5);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold('10%', 100), 10);
  assert.strictEqual(resolveMinCollateralIncreaseThreshold(0, 100), 0);
}

function testCollateralCapPercentage() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 600,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    targetCollateralRatio: 2.5,
    maxBorrowAmount: 110,
    maxCollateralAmount: '5%',
  });

  assert(plan, 'plan should be produced for a high-CR position');
  assert.strictEqual(plan.blocked, undefined, 'total collateral ceiling should not block withdrawals when current is above limit');
  assert.strictEqual(plan.collateralDelta, -50, 'collateral withdrawal should proceed despite low limit');
}

function testCollateralFallbackPlanner() {
  const plan = buildCollateralFallbackPlan({
    currentCollateralAmount: 250,
    currentDebtAmount: 90,
    feedPrice: 2,
    targetCollateralRatio: 2,
    maxCollateralAmount: 10000,
  });

  assert(plan, 'fallback collateral plan should be produced');
  assert.strictEqual(plan.action, 'add_collateral', 'fallback should add collateral for low CR');
  assert.strictEqual(plan.needsGridReset, true, 'fallback collateral change should reset the grid');
}

function testCollateralFallbackPlannerClamped() {
  const plan = buildCollateralFallbackPlan({
    currentCollateralAmount: 200,
    currentDebtAmount: 100,
    feedPrice: 2,
    targetCollateralRatio: 2.5,
    maxCollateralAmount: 400,
  });

  assert(plan, 'fallback collateral plan should be produced');
  assert.strictEqual(plan.action, 'add_collateral', 'fallback should add collateral for low CR');
  assert.strictEqual(plan.collateralDelta, 200, 'collateral increase should be clamped to total ceiling');
}

function testCollateralFallbackPlannerAtCeiling() {
  const plan = buildCollateralFallbackPlan({
    currentCollateralAmount: 450,
    currentDebtAmount: 100,
    feedPrice: 2,
    targetCollateralRatio: 2.5,
    maxCollateralAmount: 400,
  });

  assert.strictEqual(plan, null, 'fallback should return null when already above total ceiling');
}

function testCollateralFallbackPlannerUsesReferenceAmount() {
  const plan = buildCollateralFallbackPlan({
    currentCollateralAmount: 200,
    currentDebtAmount: 100,
    feedPrice: 2,
    targetCollateralRatio: 2.5,
    maxCollateralAmount: '50%',
    collateralLimitReferenceAmount: 800,
  });

  assert(plan, 'fallback collateral plan should be produced');
  assert.strictEqual(plan.action, 'add_collateral', 'fallback should add collateral for low CR');
  assert.strictEqual(plan.collateralDelta, 200, 'percentage collateral ceiling should use the supplied total reference');
}

function testDebtOnlyWithLowCr() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 250,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    targetCollateralRatio: 2.2,
    maxBorrowAmount: 10,
    maxCollateralAmount: 10000,
    debtOnly: true,
  });

  assert(plan, 'plan should be produced for low CR');
  assert.strictEqual(plan.action, 'reduce_debt', 'low CR should reduce debt');
  assert.strictEqual(plan.fallbackAction, null, 'debtOnly should clear fallbackAction');
  assert.strictEqual(plan.debtDelta, -37.5, 'debt reduction should not be capped');
  assert.strictEqual(plan.collateralDelta, 0, 'debtOnly should keep collateral constant');
}

function testDebtOnlyWithHighCr() {
  const plan = buildDebtFirstCrPlan({
    currentCollateralAmount: 600,
    currentDebtAmount: 100,
    feedPrice: 2,
    minCollateralRatio: 2,
    maxCollateralRatio: 2.5,
    maxBorrowAmount: 110,
    maxCollateralAmount: 10000,
    debtOnly: true,
  });

  assert(plan, 'plan should be produced for high CR');
  assert.strictEqual(plan.action, 'increase_debt', 'high CR should increase debt');
  assert.strictEqual(plan.fallbackAction, null, 'debtOnly should clear fallbackAction');
  assert.strictEqual(plan.debtDelta, 10, 'debt increase capped by maxBorrowAmount');
  assert.strictEqual(plan.collateralDelta, 0, 'debtOnly should keep collateral constant');
}

testDebtFirstPlanner();
testDebtCeilingOnIncrease();
testMinCollateralIncreaseThresholdSkipsSmallIncrease();
testMinCollateralIncreaseThresholdAllowsLargeIncrease();
testZeroMinCollateralIncreaseThresholdAllowsMissingBudget();
testPercentMinCollateralIncreaseThresholdRequiresBudget();
testMalformedMinCollateralIncreaseThresholds();
testCollateralCapPercentage();
testCollateralFallbackPlanner();
testCollateralFallbackPlannerClamped();
testCollateralFallbackPlannerAtCeiling();
testCollateralFallbackPlannerUsesReferenceAmount();
testDebtOnlyWithLowCr();
testDebtOnlyWithHighCr();

console.log('cr planner tests passed');
