const { createClawInfrastructure } = require('../modules/claw_infra');
const { getErrorMessage } = require('../../modules/utils/errors');

async function main() {
  const pair = process.argv[2] || 'HONEST.MONEY/BTS';
  const [assetA, assetB] = pair.split('/');

  const claw = createClawInfrastructure({
    runtime: {
      name: 'honest-ecosystem'
    }
  });

  const context = await claw.honest.buildContext({
    discoverPairs: [[assetA, assetB]]
  });
  const pairPrice = await claw.honest.resolvePairPrice(assetA, assetB);

  console.log(JSON.stringify({
    bridge: context.bridge,
    pairContexts: context.pairContexts,
    pair,
    pairPrice,
    summary: context.summary
  }, null, 2));
}

main().catch((err) => {
  console.error(getErrorMessage(err));
  process.exit(1);
});
export {};
