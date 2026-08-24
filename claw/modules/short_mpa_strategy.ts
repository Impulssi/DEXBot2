
import { Config } from '../../modules/config.js';
import { borrowMpa, createLimitOrder, repayMpaDebt } from './chain_actions.js';
import { requireBtsBackedMpa } from './mpa_utils.js';
import { requirePositiveNumber } from './utils.js';

function requireNonNegativeNumber(value: any, fieldName: string) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    throw new Error(`${fieldName} must be zero or a positive number`);
  }

  return numericValue;
}


function resolveAccountName(options: Record<string, any> = {}, { required = true }: Record<string, any> = {}) {
  const accountName = options.accountName || Config.BITSHARES_ACCOUNT || null;
  if (required && !accountName) {
    throw new Error('accountName is required');
  }
  return accountName;
}

function withSigningOptions(options: Record<string, any> = {}) {
  const signingOptions: Record<string, any> = {
    accountName: resolveAccountName(options)
  };

  if (options.privateKey) {
    signingOptions.privateKey = options.privateKey;
  }

  return signingOptions;
}

async function buildOpenShortPlan(options: Record<string, any> = {}) {
  const accountName = resolveAccountName(options, { required: false });
  const debtAmount = requirePositiveNumber(options.debtAmount, 'debtAmount');
  const collateralAmount = requirePositiveNumber(options.collateralAmount, 'collateralAmount');
  const sellPriceInBts = requirePositiveNumber(options.sellPriceInBts, 'sellPriceInBts');
  const { mpaAsset, backingAsset } = await requireBtsBackedMpa(options.mpaAsset);

  return {
    accountName,
    action: 'open-short',
    collateralAsset: backingAsset.symbol,
    collateralAmount,
    debtAmount,
    expectedBtsProceeds: debtAmount * sellPriceInBts,
    market: `${mpaAsset.symbol}/${backingAsset.symbol}`,
    mpaAsset: mpaAsset.symbol,
    sellOrder: {
      amountToSell: debtAmount,
      minToReceive: debtAmount * sellPriceInBts,
      receiveAsset: backingAsset.symbol,
      sellAsset: mpaAsset.symbol
    },
    targetCollateralRatio: options.targetCollateralRatio ?? null
  };
}

async function openShortOnBts(options: Record<string, any> = {}) {
  const plan = await buildOpenShortPlan(options);
  const signingOptions = withSigningOptions(options);

  const borrowResult = await borrowMpa({
    ...signingOptions,
    collateralDelta: plan.collateralAmount,
    debtDelta: plan.debtAmount,
    mpaAsset: plan.mpaAsset,
    targetCollateralRatio: plan.targetCollateralRatio
  });

  const sellOrderResult = await createLimitOrder({
    ...signingOptions,
    amountToSell: plan.sellOrder.amountToSell,
    expiration: options.expiration,
    fillOrKill: options.fillOrKill,
    minToReceive: plan.sellOrder.minToReceive,
    receiveAsset: plan.sellOrder.receiveAsset,
    sellAsset: plan.sellOrder.sellAsset
  });

  return {
    borrowResult,
    market: plan.market,
    plan,
    sellOrderResult
  };
}

async function buildTakeProfitPlan(options: Record<string, any> = {}) {
  const accountName = resolveAccountName(options, { required: false });
  const amountToCover = requirePositiveNumber(options.amountToCover, 'amountToCover');
  const buyPriceInBts = requirePositiveNumber(options.buyPriceInBts, 'buyPriceInBts');
  const { mpaAsset, backingAsset } = await requireBtsBackedMpa(options.mpaAsset);

  return {
    accountName,
    action: 'place-take-profit',
    amountToCover,
    buyPriceInBts,
    market: `${mpaAsset.symbol}/${backingAsset.symbol}`,
    maxBtsToSpend: amountToCover * buyPriceInBts,
    mpaAsset: mpaAsset.symbol,
    rebuyOrder: {
      amountToSell: amountToCover * buyPriceInBts,
      minToReceive: amountToCover,
      receiveAsset: mpaAsset.symbol,
      sellAsset: backingAsset.symbol
    }
  };
}

async function placeTakeProfitBuyOrderOnBts(options: Record<string, any> = {}) {
  const plan = await buildTakeProfitPlan(options);
  const signingOptions = withSigningOptions(options);

  const rebuyOrderResult = await createLimitOrder({
    ...signingOptions,
    amountToSell: plan.rebuyOrder.amountToSell,
    expiration: options.expiration,
    fillOrKill: options.fillOrKill,
    minToReceive: plan.rebuyOrder.minToReceive,
    receiveAsset: plan.rebuyOrder.receiveAsset,
    sellAsset: plan.rebuyOrder.sellAsset
  });

  return {
    market: plan.market,
    plan,
    rebuyOrderResult
  };
}

async function buildCloseShortPlan(options: Record<string, any> = {}) {
  const accountName = resolveAccountName(options, { required: false });
  const amountToRepay = requirePositiveNumber(options.amountToRepay, 'amountToRepay');
  const releaseCollateralDelta = options.releaseCollateralDelta === undefined
    ? 0
    : requireNonNegativeNumber(options.releaseCollateralDelta, 'releaseCollateralDelta');
  const { mpaAsset, backingAsset } = await requireBtsBackedMpa(options.mpaAsset);

  return {
    accountName,
    action: 'close-short',
    collateralAsset: backingAsset.symbol,
    market: `${mpaAsset.symbol}/${backingAsset.symbol}`,
    mpaAsset: mpaAsset.symbol,
    releaseCollateralDelta,
    repayAmount: amountToRepay,
    targetCollateralRatio: options.targetCollateralRatio ?? null
  };
}

async function closeShortOnBts(options: Record<string, any> = {}) {
  const plan = await buildCloseShortPlan(options);
  const signingOptions = withSigningOptions(options);

  const repayResult = await repayMpaDebt({
    ...signingOptions,
    amountToRepay: plan.repayAmount,
    collateralDelta: -plan.releaseCollateralDelta,
    mpaAsset: plan.mpaAsset,
    targetCollateralRatio: plan.targetCollateralRatio
  });

  return {
    market: plan.market,
    plan,
    repayResult
  };
}

export { buildCloseShortPlan, buildOpenShortPlan, buildTakeProfitPlan, closeShortOnBts, openShortOnBts, placeTakeProfitBuyOrderOnBts }

