
import * as client from './bitshares_client';
const { BitShares } = client;
import { executeOperations } from './chain_broadcast';
import { loadDexbotOrderUtils, requireDexbot2Module, loadDexbotOrderConstants } from './dexbot_bridge';
import { requireBtsBackedMpa, CORE_SYMBOL } from './mpa_utils';
import { getAsset, getBackingAsset, getFullAccount, readOpenOrders, resolveAccountId, resolveAccountName } from './chain_queries.js';
import { getErrorMessage } from '../../modules/utils/errors';

// Graphene protocol constant: operation type 4 = limit_order_create (fill events carry op[0] = 4 for matched orders)
const FILL_ORDER_OPERATION_TYPE = 4;
const accountSubscriptions = new Map();

function loadRootChainOrders() {
  return requireDexbot2Module('modules/chain_orders.js');
}

function getFloatToBlockchainInt() {
  return loadDexbotOrderUtils().floatToBlockchainInt;
}

function nextYearExpirationIso() {
  const now = new Date();
  now.setFullYear(now.getFullYear() + 1);
  return `${now.toISOString().slice(0, 10)}T23:59:59`;
}

function toGrapheneCollateralRatio(value: any) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }
  const grapheneCollateralRatioDenom = loadDexbotOrderConstants().FEE_PARAMETERS.GRAPHENE_COLLATERAL_RATIO_DENOM;
  const scaled = Math.round(numericValue * grapheneCollateralRatioDenom);
  return Number.isInteger(scaled) && scaled > 0 && scaled <= 0xffff ? scaled : null;
}

async function resolveAssetMeta(symbolOrId: any) {
  const asset = await getAsset(symbolOrId);
  if (!asset) {
    throw new Error(`Asset not found: ${symbolOrId}`);
  }
  return asset;
}

async function buildCreateLimitOrderOperation({
  accountName,
  amountToSell,
  sellAsset,
  minToReceive,
  receiveAsset,
  expiration = nextYearExpirationIso(),
  fillOrKill = false
}: any) {
  const accountId = await resolveAccountId(accountName);
  if (!accountId) {
    throw new Error(`Account not found: ${accountName}`);
  }

  const sellMeta = await resolveAssetMeta(sellAsset);
  const receiveMeta = await resolveAssetMeta(receiveAsset);
  const floatToBlockchainInt = getFloatToBlockchainInt();
  const amountToSellInt = floatToBlockchainInt(amountToSell, sellMeta.precision);
  const minToReceiveInt = floatToBlockchainInt(minToReceive, receiveMeta.precision);

  if (amountToSellInt <= 0 || minToReceiveInt <= 0) {
    throw new Error('Limit order amounts must round to positive blockchain integers');
  }

  return {
    op_name: 'limit_order_create',
    op_data: {
      fee: { amount: 0, asset_id: '1.3.0' },
      seller: accountId,
      amount_to_sell: { amount: amountToSellInt, asset_id: sellMeta.id },
      min_to_receive: { amount: minToReceiveInt, asset_id: receiveMeta.id },
      expiration,
      fill_or_kill: fillOrKill,
      extensions: []
    }
  };
}

function normalizeUpdateParams(options: Record<string, any> = {}) {
  if (options.newParams && typeof options.newParams === 'object' && !Array.isArray(options.newParams)) {
    return options.newParams;
  }

  return {
    amountToSell: options.amountToSell,
    expiration: options.expiration,
    minToReceive: options.minToReceive,
    newPrice: options.newPrice,
    orderType: options.orderType
  };
}

async function buildCancelLimitOrderOperation({ accountName, orderId }: any) {
  const accountId = await resolveAccountId(accountName);
  if (!accountId) {
    throw new Error(`Account not found: ${accountName}`);
  }

  return {
    op_name: 'limit_order_cancel',
    op_data: {
      fee: { amount: 0, asset_id: '1.3.0' },
      fee_paying_account: accountId,
      order: orderId
    }
  };
}

async function buildUpdateLimitOrderOperation(options: Record<string, any> = {}) {
  const rootChainOrders = loadRootChainOrders();
  const newParams = normalizeUpdateParams(options);
  return rootChainOrders.buildUpdateOrderOp(
    options.accountName,
    options.orderId,
    newParams,
    options.cachedOrder || null
  );
}

async function buildBorrowMpaOperation({
  accountName,
  mpaAsset,
  debtDelta,
  collateralDelta,
  targetCollateralRatio
}: any) {
  const accountId = await resolveAccountId(accountName);
  if (!accountId) {
    throw new Error(`Account not found: ${accountName}`);
  }

  const mpaMeta = await resolveAssetMeta(mpaAsset);
  if (!mpaMeta.bitasset_data_id) {
    throw new Error(`${mpaAsset} is not a market-issued asset`);
  }

  const backingAsset = await getBackingAsset(mpaAsset);
  if (!backingAsset) {
    throw new Error(`Could not resolve backing asset for ${mpaAsset}`);
  }
  if (backingAsset.symbol !== CORE_SYMBOL) {
    throw new Error(`${mpaAsset} is backed by ${backingAsset.symbol}, not ${CORE_SYMBOL}; use short_mpa_strategy for non-BTS MPAs`);
  }

  const floatToBlockchainInt = getFloatToBlockchainInt();
  const debtInt = floatToBlockchainInt(debtDelta, mpaMeta.precision);
  const collateralInt = floatToBlockchainInt(collateralDelta, backingAsset.precision);

  if (debtInt === 0 && collateralInt === 0) {
    throw new Error('At least one of debtDelta or collateralDelta must be non-zero');
  }

  const extensions: Record<string, any> = {};
  const grapheneTargetCollateralRatio = toGrapheneCollateralRatio(targetCollateralRatio);
  if (grapheneTargetCollateralRatio !== null) {
    extensions.target_collateral_ratio = grapheneTargetCollateralRatio;
  }

  return {
    op_name: 'call_order_update',
    op_data: {
      fee: { amount: 0, asset_id: '1.3.0' },
      funding_account: accountId,
      delta_collateral: { amount: collateralInt, asset_id: backingAsset.id },
      delta_debt: { amount: debtInt, asset_id: mpaMeta.id },
      extensions
    }
  };
}

async function buildSettleMpaOperation({ accountName, mpaAsset, amount }: any) {
  const accountId = await resolveAccountId(accountName);
  if (!accountId) {
    throw new Error(`Account not found: ${accountName}`);
  }

  const mpaMeta = await resolveAssetMeta(mpaAsset);
  if (!mpaMeta.bitasset_data_id) {
    throw new Error(`${mpaAsset} is not a market-issued asset`);
  }

  const backingAsset = await getBackingAsset(mpaAsset);
  if (!backingAsset) {
    throw new Error(`Could not resolve backing asset for ${mpaAsset}`);
  }
  if (backingAsset.symbol !== CORE_SYMBOL) {
    throw new Error(`${mpaAsset} is backed by ${backingAsset.symbol}, not ${CORE_SYMBOL}`);
  }

  const floatToBlockchainInt = getFloatToBlockchainInt();
  const settleAmountInt = floatToBlockchainInt(amount, mpaMeta.precision);
  if (settleAmountInt <= 0) {
    throw new Error('Settlement amount must round to a positive blockchain integer');
  }

  return {
    op_name: 'asset_settle',
    op_data: {
      fee: { amount: 0, asset_id: '1.3.0' },
      account: accountId,
      amount: { amount: settleAmountInt, asset_id: mpaMeta.id },
      extensions: []
    }
  };
}

async function createLimitOrder(options: any) {
  const operation = await buildCreateLimitOrderOperation(options);
  return executeOperations([operation], options);
}

async function cancelLimitOrder(options: any) {
  const operation = await buildCancelLimitOrderOperation(options);
  return executeOperations([operation], options);
}

async function updateLimitOrder(options: any) {
  const buildResult = await buildUpdateLimitOrderOperation(options);
  if (!buildResult) {
    return { skipped: true };
  }

  return executeOperations([buildResult.op], options);
}

async function executeBatch(options: any) {
  const operations = Array.isArray(options?.operations) ? options.operations : [];
  return executeOperations(operations, options);
}

async function borrowMpa(options: any) {
  const operation = await buildBorrowMpaOperation(options);
  return executeOperations([operation], options);
}

async function repayMpaDebt(options: any) {
  const debtAmount = Math.abs(Number(options.amountToRepay));
  if (!Number.isFinite(debtAmount) || debtAmount <= 0) {
    throw new Error('amountToRepay must be a positive number');
  }

  const collateralDelta = options.collateralDelta !== undefined ? Number(options.collateralDelta) : 0;
  if (options.collateralDelta !== undefined && !Number.isFinite(collateralDelta)) {
    throw new Error(`collateralDelta must be a number, got ${JSON.stringify(options.collateralDelta)}`);
  }
  const operation = await buildBorrowMpaOperation({
    accountName: options.accountName,
    mpaAsset: options.mpaAsset,
    debtDelta: -debtAmount,
    collateralDelta,
    targetCollateralRatio: options.targetCollateralRatio
  });

  return executeOperations([operation], options);
}

async function adjustMpaCollateral(options: any) {
  const collateralDelta = Number(options.collateralDelta);
  if (!Number.isFinite(collateralDelta) || collateralDelta === 0) {
    throw new Error('collateralDelta must be a non-zero number');
  }

  const operation = await buildBorrowMpaOperation({
    accountName: options.accountName,
    mpaAsset: options.mpaAsset,
    debtDelta: 0,
    collateralDelta,
    targetCollateralRatio: options.targetCollateralRatio
  });

  return executeOperations([operation], options);
}

async function settleMpa(options: any) {
  const operation = await buildSettleMpaOperation(options);
  return executeOperations([operation], options);
}

async function getOpenOrders(accountNameOrId: any) {
  return readOpenOrders(accountNameOrId);
}

async function getMpaPosition(accountNameOrId: any, mpaAsset: any) {
  const fullAccount = await getFullAccount(accountNameOrId);
  const mpaMeta = await resolveAssetMeta(mpaAsset);
  const callOrders = Array.isArray(fullAccount?.call_orders) ? fullAccount.call_orders : [];
  return callOrders.find((entry: any) => entry.call_price?.quote?.asset_id === mpaMeta.id) || null;
}

async function listenForFills(accountNameOrId: any, callback: any) {
  if (typeof callback !== 'function') {
    throw new Error('listenForFills requires a callback');
  }

  const accountName = await resolveAccountName(accountNameOrId);
  if (!accountName) {
    throw new Error(`Could not resolve account name for ${accountNameOrId}`);
  }

  if (!accountSubscriptions.has(accountName)) {
    const callbacks: Set<Function> = new Set();
    const bsCallback = (updates: any[] = []) => {
      const fills = updates.filter((update) => update?.op && update.op[0] === FILL_ORDER_OPERATION_TYPE);
      if (fills.length === 0) {
        return;
      }

      for (const fn of Array.from(callbacks)) {
        try {
          fn(fills);
        } catch (err: any) {
          console.error('listenForFills callback error:', getErrorMessage(err));
        }
      }
    };

    BitShares.subscribe('account', bsCallback, accountName);
    accountSubscriptions.set(accountName, { callbacks, bsCallback });
  }

  const entry = accountSubscriptions.get(accountName);
  if (!entry) {
    throw new Error(`Subscription entry not found for ${accountName}`);
  }
  entry.callbacks.add(callback);

  return async () => {
    const current = accountSubscriptions.get(accountName);
    if (!current) {
      return;
    }

    current.callbacks.delete(callback);
    if (current.callbacks.size === 0) {
      try {
        if (typeof BitShares.unsubscribe === 'function') {
          BitShares.unsubscribe('account', current.bsCallback, accountName);
        }
      } finally {
        accountSubscriptions.delete(accountName);
      }
    }
  };
}

export { adjustMpaCollateral, borrowMpa, buildBorrowMpaOperation, buildCancelLimitOrderOperation, buildCreateLimitOrderOperation, buildUpdateLimitOrderOperation, buildSettleMpaOperation, cancelLimitOrder, createLimitOrder, executeBatch, getMpaPosition, getOpenOrders, listenForFills, repayMpaDebt, updateLimitOrder, settleMpa }

