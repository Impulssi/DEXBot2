const { DEFAULT_STATE_PATH, PositionManager } = require('../modules/position_manager');
const { getErrorMessage } = require('../../modules/utils/errors');

function parseArgs(argv: any) {
  const options: any = {
    statePath: DEFAULT_STATE_PATH
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--mode' && next) {
      options.mode = next;
      i += 1;
    } else if (arg === '--id' && next) {
      options.positionId = next;
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
    } else if (arg === '--buy-price' && next) {
      options.buyPriceInBts = Number(next);
      i += 1;
    } else if (arg === '--cover' && next) {
      options.amountToCover = Number(next);
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
    } else if (arg === '--state' && next) {
      options.statePath = next;
      i += 1;
    }
  }

  return options;
}

function printUsage() {
  console.log('Position manager modes:');
  console.log('  list');
  console.log('  create --account ACCOUNT --mpa HONEST.USD --debt 10 --collateral 25000 --sell-price 1000');
  console.log('  open --id POSITION_ID');
  console.log('  tp --id POSITION_ID --buy-price 900 [--cover 10]');
  console.log('  close --id POSITION_ID --repay 10 [--release-collateral 25000]');
  console.log('  sync --id POSITION_ID');
  console.log('  sync-all');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manager = new PositionManager({ statePath: options.statePath });
  const mode = options.mode;

  if (!mode || mode === 'help') {
    printUsage();
    return;
  }

  if (mode === 'list') {
    console.log(JSON.stringify(await manager.listPositions(), null, 2));
    return;
  }

  if (mode === 'create') {
    console.log(JSON.stringify(await manager.createShortPosition(options), null, 2));
    return;
  }

  if (mode === 'open') {
    console.log(JSON.stringify(await manager.openShort(options.positionId, options), null, 2));
    return;
  }

  if (mode === 'tp') {
    console.log(JSON.stringify(await manager.placeTakeProfit(options.positionId, options), null, 2));
    return;
  }

  if (mode === 'close') {
    console.log(JSON.stringify(await manager.closePosition(options.positionId, options), null, 2));
    return;
  }

  if (mode === 'sync') {
    console.log(JSON.stringify(await manager.syncPosition(options.positionId), null, 2));
    return;
  }

  if (mode === 'sync-all') {
    console.log(JSON.stringify(await manager.syncAllPositions(), null, 2));
    return;
  }

  throw new Error(`Unsupported mode: ${mode}`);
}

main().catch((err: any) => {
  console.error(getErrorMessage(err));
  process.exit(1);
});
export {};
