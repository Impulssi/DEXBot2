'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CreditRuntime = require('../modules/credit_runtime');
const { disconnectClient, waitForConnected } = require('../modules/bitshares_client');
const chainOrders = require('../modules/chain_orders');
const { PATHS } = require('../modules/paths');
const { loadSettingsFile, normalizeBotEntries, resolveRawBotEntries } = require('../modules/bot_settings');
const { blockchainToFloat } = require('../modules/order/utils/math');

const DEFAULT_BOT_NAME = 'XRP-BTS';
const DEFAULT_THRESHOLD_HOURS = 24;
const DEFAULT_MAX_FEE_RATE_PER_DAY = 0.05;
const DEFAULT_MAX_COLLATERAL_RATIO = 2.5;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const CREDIT_FEE_RATE_DENOM = 1_000_000;

function parseArgs(argv) {
  const args = {
    bot: DEFAULT_BOT_NAME,
    account: null,
    asset: null,
    collateral: null,
    thresholdHours: DEFAULT_THRESHOLD_HOURS,
    maxFeeRatePerDay: DEFAULT_MAX_FEE_RATE_PER_DAY,
    maxCollateralRatio: null,
    connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
    autoRepay: 2,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--bot' && next) {
      args.bot = next;
      i += 1;
    } else if (arg === '--account' && next) {
      args.account = next;
      i += 1;
    } else if (arg === '--asset' && next) {
      args.asset = next;
      i += 1;
    } else if (arg === '--collateral' && next) {
      args.collateral = next;
      i += 1;
    } else if (arg === '--threshold-hours' && next) {
      args.thresholdHours = Number(next);
      i += 1;
    } else if (arg === '--max-fee-rate-per-day' && next) {
      args.maxFeeRatePerDay = Number(next);
      i += 1;
    } else if (arg === '--max-collateral-ratio' && next) {
      args.maxCollateralRatio = Number(next);
      i += 1;
    } else if (arg === '--connect-timeout-ms' && next) {
      args.connectTimeoutMs = Number(next);
      i += 1;
    } else if (arg === '--auto-repay' && next) {
      args.autoRepay = Number(next);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: tsx scripts/test-credit-renewal.ts [options]

Dry-run the credit renewal plan for an existing BitShares credit position.

Options:
  --bot <name>                    Bot profile name (default: ${DEFAULT_BOT_NAME})
  --account <name-or-id>           Account override (default: bot preferredAccount)
  --asset <symbol-or-id>           Credit/debt asset override (default: bot assetA)
  --collateral <symbol-or-id>      Collateral asset override (default: bot assetB)
  --threshold-hours <hours>        Renew when latest repay time is inside this window (default: ${DEFAULT_THRESHOLD_HOURS})
  --max-fee-rate-per-day <number>  Policy fee cap (default: ${DEFAULT_MAX_FEE_RATE_PER_DAY})
  --max-collateral-ratio <number>  Policy collateral ratio cap (default: derive from current deals)
  --connect-timeout-ms <ms>         BitShares connection timeout (default: ${DEFAULT_CONNECT_TIMEOUT_MS})
  --auto-repay <0|1|2>             auto_repay mode to enforce on deals and renewals (default: 2)
`);
}

function loadBot(botName) {
  const botsPath = PATHS.PROFILES.BOTS_JSON;
  const { config } = loadSettingsFile(botsPath, { silent: false, exitOnError: false });
  const entries = normalizeBotEntries(resolveRawBotEntries(config));
  const bot = entries.find((entry) => entry.name === botName);
  if (!bot) {
    throw new Error(`Bot profile "${botName}" not found in ${botsPath}`);
  }
  return bot;
}

function amountToFloat(amount, asset) {
  const value = Number(amount);
  const precision = Number(asset?.precision);
  if (!Number.isFinite(value) || !Number.isFinite(precision)) return null;
  return blockchainToFloat(value, precision);
}

function hoursUntil(isoTime) {
  if (!isoTime) return null;
  const expiresAt = new Date(isoTime).getTime();
  if (!Number.isFinite(expiresAt)) return null;
  return (expiresAt - Date.now()) / 3600000;
}

function ceilToPrecision(value, precision) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** Math.max(0, Number(precision) || 0);
  return Math.ceil(value * scale) / scale;
}

function summarizeOperations(calls) {
  return calls.flatMap((call) => (call.operations || []).map((op) => op.op_name));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!Number.isFinite(args.thresholdHours) || args.thresholdHours <= 0) {
    throw new Error('--threshold-hours must be positive');
  }
  if (![0, 1, 2].includes(Number(args.autoRepay))) {
    throw new Error('--auto-repay must be 0, 1, or 2');
  }
  if (!Number.isFinite(args.connectTimeoutMs) || args.connectTimeoutMs <= 0) {
    throw new Error('--connect-timeout-ms must be positive');
  }

  const profileBot = loadBot(args.bot);
  const accountRef = args.account || profileBot.preferredAccount;
  const debtAssetRef = args.asset || profileBot.assetA;
  const collateralAssetRef = args.collateral || profileBot.assetB;
  if (!accountRef) throw new Error('No account found. Set preferredAccount or pass --account.');
  if (!debtAssetRef || !collateralAssetRef) throw new Error('Both debt asset and collateral asset are required.');

  await waitForConnected(args.connectTimeoutMs, {
    retryDelayMs: 250,
    maxRetryDelayMs: 1000,
    refreshNodesEveryMs: 5000,
  });
  const accountId = await chainOrders.resolveAccountId(accountRef);
  const accountName = await chainOrders.resolveAccountName(accountId || accountRef);
  if (!accountId) throw new Error(`Unable to resolve account: ${accountRef}`);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-credit-renewal-'));
  const dryRunCalls = [];
  const botConfig = {
    ...profileBot,
    preferredAccount: accountName || accountRef,
    dryRun: true,
    TIMING: {
      ...(profileBot.TIMING || {}),
      CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: args.thresholdHours,
    },
    debtPolicy: {
      lending: [
        {
          type: 'creditOffer',
          asset: debtAssetRef,
          collateralAsset: collateralAssetRef,
          ratio: 1,
          maxBorrowAmount: 1,
          maxCollateralRatio: args.maxCollateralRatio || DEFAULT_MAX_COLLATERAL_RATIO,
          maxFeeRatePerDay: args.maxFeeRatePerDay,
          autoReborrow: true,
          autoRepay: args.autoRepay,
        },
      ],
    },
  };

  const runtime = new CreditRuntime({
    config: botConfig,
    account: { id: accountId, name: accountName || accountRef },
    accountId,
    privateKey: null,
    _log: (message) => console.log(message),
    _warn: (message) => console.warn(message),
  }, { stateDir });

  const originalExecuteOperations = runtime.executeOperations.bind(runtime);
  runtime.executeOperations = async (operations, reason) => {
    dryRunCalls.push({ reason, operations: JSON.parse(JSON.stringify(operations || [])) });
    return originalExecuteOperations(operations, reason);
  };

  try {
    const debtAsset = await runtime._resolveAsset(debtAssetRef);
    const collateralAsset = await runtime._resolveAsset(collateralAssetRef);
    if (!debtAsset) throw new Error(`Unable to resolve debt asset: ${debtAssetRef}`);
    if (!collateralAsset) throw new Error(`Unable to resolve collateral asset: ${collateralAssetRef}`);

    await runtime.refreshState();
    const posKey = `${debtAsset.id}:${collateralAsset.id}`;
    const posState = runtime.state.positions[posKey] || {};
    const deals = Array.isArray(posState.creditDeals) ? posState.creditDeals : [];
    if (deals.length === 0) {
      throw new Error(`No current credit deals found for ${accountName || accountRef} ${debtAsset.symbol}-${collateralAsset.symbol}. Renew-only mode has nothing to renew.`);
    }

    const offerById = new Map();
    const enrichedDeals = await Promise.all(deals.map(async (deal) => {
      const debtFloat = amountToFloat(deal.debtAmount, debtAsset);
      const collateralFloat = amountToFloat(deal.collateralAmount, collateralAsset);
      if (!offerById.has(deal.offerId)) {
        offerById.set(deal.offerId, await runtime._getOfferById(deal.offerId));
      }
      const offer = offerById.get(deal.offerId);
      const collateralMap = offer?.acceptable_collateral instanceof Map
        ? offer.acceptable_collateral
        : new Map(Array.isArray(offer?.acceptable_collateral)
          ? offer.acceptable_collateral
          : Object.entries(offer?.acceptable_collateral || {}));
      const collateralPrice = collateralMap.get(collateralAsset.id);
      const marketValueInDebt = await runtime._calculateCollateralValueInDebtAsset(deal.collateralAmount, collateralAsset, debtAsset, collateralPrice);
      const creditOfferValueInDebt = runtime._calculateCreditOfferCollateralValueInDebtAsset(deal.collateralAmount, collateralAsset, debtAsset, collateralPrice);
      const feeDueFloat = amountToFloat(Math.ceil((Number(deal.debtAmount || 0) * Number(deal.feeRate || 0)) / CREDIT_FEE_RATE_DENOM), debtAsset);
      return {
        ...deal,
        debtFloat,
        collateralFloat,
        marketValueInDebt,
        creditOfferValueInDebt,
        collateralRatio: Number.isFinite(marketValueInDebt) && Number.isFinite(creditOfferValueInDebt) && creditOfferValueInDebt > 0
          ? marketValueInDebt / creditOfferValueInDebt
          : null,
        feeDueFloat,
        hoursLeft: hoursUntil(deal.latestRepayTime),
      };
    }));

    const currentDebt = enrichedDeals.reduce((sum, deal) => sum + (Number.isFinite(deal.debtFloat) ? deal.debtFloat : 0), 0);
    const currentCollateral = enrichedDeals.reduce((sum, deal) => sum + (Number.isFinite(deal.collateralFloat) ? deal.collateralFloat : 0), 0);
    const allowedOfferIds = Array.from(new Set(enrichedDeals.map((deal) => deal.offerId).filter(Boolean)));
    const maxBorrowAmount = ceilToPrecision(currentDebt, debtAsset.precision);
    const maxObservedCollateralRatio = enrichedDeals.reduce((max, deal) => (
      Number.isFinite(deal.collateralRatio) ? Math.max(max, deal.collateralRatio) : max
    ), 0);
    const effectiveMaxCollateralRatio = args.maxCollateralRatio || Math.max(
      DEFAULT_MAX_COLLATERAL_RATIO,
      Math.ceil(maxObservedCollateralRatio * 1000) / 1000
    );

    botConfig.debtPolicy.lending[0] = {
      ...botConfig.debtPolicy.lending[0],
      maxBorrowAmount,
      maxCollateralRatio: effectiveMaxCollateralRatio,
      maxCollateralAmount: currentCollateral > 0 ? ceilToPrecision(currentCollateral, collateralAsset.precision) : undefined,
      allowedOfferIds,
    };

    await runtime.refreshState();
    const result = await runtime.runMaintenance('credit-renewal-test');
    const opNames = summarizeOperations(dryRunCalls);
    const repayCount = opNames.filter((name) => name === 'credit_deal_repay').length;
    const acceptCount = opNames.filter((name) => name === 'credit_offer_accept').length;
    const standaloneAccept = dryRunCalls.some((call) => {
      const names = (call.operations || []).map((op) => op.op_name);
      return names.includes('credit_offer_accept') && !names.includes('credit_deal_repay');
    });
    if (standaloneAccept) {
      throw new Error('Renew-only guard failed: dry-run attempted a standalone credit_offer_accept.');
    }

    const dueDeals = enrichedDeals.filter((deal) => Number.isFinite(deal.hoursLeft) && deal.hoursLeft < args.thresholdHours);
    if (dueDeals.length > 0 && repayCount < dueDeals.length) {
      throw new Error(`Renewal guard failed: ${dueDeals.length} due deal(s) but only ${repayCount} repay op(s).`);
    }
    if (dueDeals.length > 0 && acceptCount < dueDeals.length) {
      throw new Error(`Renewal guard failed: ${dueDeals.length} due deal(s) but only ${acceptCount} retake credit_offer_accept op(s).`);
    }
    if (acceptCount < repayCount) {
      throw new Error(`Renewal guard failed: ${repayCount} repay op(s) but only ${acceptCount} retake credit_offer_accept op(s).`);
    }
    const configForProfile = {
      debtPolicy: {
        lending: [
          botConfig.debtPolicy.lending[0],
        ],
      },
      TIMING: {
        CREDIT_DEAL_EXPIRY_THRESHOLD_HOURS: args.thresholdHours,
      },
    };

    console.log('\nCredit renewal dry-run report');
    console.log('=============================');
    console.log(`Bot/account: ${profileBot.name} / ${accountName || accountRef} (${accountId})`);
    console.log(`Market assets: ${debtAsset.symbol}-${collateralAsset.symbol}`);
    console.log(`Current deals: ${enrichedDeals.length}`);
    console.log(`Current credit debt: ${currentDebt} ${debtAsset.symbol}`);
    console.log(`Current credit collateral: ${currentCollateral} ${collateralAsset.symbol}`);
    console.log(`Renew threshold: ${args.thresholdHours} hours before latest_repay_time`);
    console.log(`Deals due inside threshold: ${dueDeals.length}`);
    for (const deal of enrichedDeals) {
      const hours = Number.isFinite(deal.hoursLeft) ? deal.hoursLeft.toFixed(2) : 'unknown';
      const ratio = Number.isFinite(deal.collateralRatio) ? deal.collateralRatio.toFixed(3) : 'unknown';
      const due = Number.isFinite(deal.hoursLeft) && deal.hoursLeft < args.thresholdHours ? 'DUE' : 'not due';
      const marketValue = Number.isFinite(deal.marketValueInDebt) ? deal.marketValueInDebt.toFixed(5) : 'unknown';
      const creditValue = Number.isFinite(deal.creditOfferValueInDebt) ? deal.creditOfferValueInDebt.toFixed(5) : 'unknown';
      console.log(`- ${deal.id}: debt=${deal.debtFloat} ${debtAsset.symbol}, collateral=${deal.collateralFloat} ${collateralAsset.symbol}, market_value=${marketValue} ${debtAsset.symbol}, credit_offer_value=${creditValue} ${debtAsset.symbol}, market_to_credit_ratio=${ratio}, offer=${deal.offerId}, auto_repay=${deal.autoRepay}, hours_left=${hours}, ${due}`);
    }
    console.log(`Dry-run operation sequence: ${opNames.length ? opNames.join(' -> ') : 'none'}`);
    console.log(`Repay/retake pairing: ${repayCount} repay op(s), ${acceptCount} credit_offer_accept op(s)`);
    console.log(`Renew-only guard: ${standaloneAccept ? 'FAILED' : 'passed'}`);
    console.log(`Maintenance result: ${JSON.stringify(result, null, 2)}`);
    console.log('\nTested configuration overlay:');
    console.log(JSON.stringify(configForProfile, null, 2));
  } finally {
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
    try { await disconnectClient(); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(`credit renewal test failed: ${err.message}`);
  process.exitCode = 1;
});
export {};
