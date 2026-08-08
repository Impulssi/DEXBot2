import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  buildCloseShortPlan,
  buildOpenShortPlan,
  buildTakeProfitPlan,
  closeShortOnBts,
  openShortOnBts,
  placeTakeProfitBuyOrderOnBts
} = require('../modules/short_mpa_strategy');
const { getErrorMessage } = require('../../modules/utils/errors');

function parseArgs(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--execute') {
      options.execute = true;
    } else if (arg === '--mode' && next) {
      options.mode = next;
      i += 1;
    } else if (arg === '--account' && next) {
      options.accountName = next;
      i += 1;
    } else if (arg === '--mpa' && next) {
      options.mpaAsset = next;
      i += 1;
    } else if (arg === '--debt' && next) {
      options.debtAmount = Number(next);
      i += 1;
    } else if (arg === '--collateral' && next) {
      options.collateralAmount = Number(next);
      i += 1;
    } else if (arg === '--sell-price' && next) {
      options.sellPriceInBts = Number(next);
      i += 1;
    } else if (arg === '--cover' && next) {
      options.amountToCover = Number(next);
      i += 1;
    } else if (arg === '--buy-price' && next) {
      options.buyPriceInBts = Number(next);
      i += 1;
    } else if (arg === '--repay' && next) {
      options.amountToRepay = Number(next);
      i += 1;
    } else if (arg === '--release-collateral' && next) {
      options.releaseCollateralDelta = Number(next);
      i += 1;
    } else if (arg === '--tcr' && next) {
      options.targetCollateralRatio = Number(next);
      i += 1;
    } else if (arg === '--expiration' && next) {
      options.expiration = next;
      i += 1;
    } else if (arg === '--fill-or-kill') {
      options.fillOrKill = true;
    }
  }

  return options;
}

function printUsage() {
  console.log('Usage examples:');
  console.log('  tsx examples/short_mpa_bts_strategy.ts --mode open --mpa HONEST.USD --debt 10 --collateral 25000 --sell-price 1000');
  console.log('  tsx examples/short_mpa_bts_strategy.ts --mode tp --mpa HONEST.USD --cover 10 --buy-price 900');
  console.log('  tsx examples/short_mpa_bts_strategy.ts --mode close --mpa HONEST.USD --repay 10 --release-collateral 25000');
  console.log('Add --execute to broadcast transactions. Without it, the script prints the plan only.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = options.mode;

  if (!mode || mode === 'help') {
    printUsage();
    process.exit(0);
  }

  if (mode === 'open') {
    const plan = await buildOpenShortPlan(options);
    console.log(JSON.stringify(plan, null, 2));
    if (!options.execute) {
      return;
    }

    const result = await openShortOnBts(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === 'tp') {
    const plan = await buildTakeProfitPlan(options);
    console.log(JSON.stringify(plan, null, 2));
    if (!options.execute) {
      return;
    }

    const result = await placeTakeProfitBuyOrderOnBts(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === 'close') {
    const plan = await buildCloseShortPlan(options);
    console.log(JSON.stringify(plan, null, 2));
    if (!options.execute) {
      return;
    }

    const result = await closeShortOnBts(options);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

main().catch((err) => {
  console.error(getErrorMessage(err));
  process.exit(1);
});
export {};
