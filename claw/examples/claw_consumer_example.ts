const { createClawInfrastructure } = require('../modules/claw_infra');
const { getErrorMessage } = require('../../modules/utils/errors');

async function main() {
  const accountName = process.argv[2] || null;
  const pair = process.argv[3] || 'BTS/USD';
  const [baseSymbol, quoteSymbol] = pair.split('/');

  const claw = createClawInfrastructure({
    accountName,
    runtime: {
      name: 'claw-consumer',
      accountName
    }
  });

  const market = await claw.market.readMarketSnapshot(baseSymbol, quoteSymbol, 5);
  const account = accountName ? await claw.market.readAccountSnapshot(accountName) : null;
  const orderUtils = claw.order.utils;
  const gapSlots = orderUtils.calculateGapSlots(0.4, 1.6);
  const defaultWeights = claw.order.constants.DEFAULT_CONFIG.weightDistribution;

  await claw.stateStore.patch({
    lastSeenPair: pair,
    lastSeenAt: new Date().toISOString()
  });

  console.log(JSON.stringify({
    account: account ? {
      balances: account.balances,
      openOrders: account.openOrders.length
    } : null,
    market: {
      asks: Array.isArray(market.orderBook.asks) ? market.orderBook.asks.length : 0,
      bids: Array.isArray(market.orderBook.bids) ? market.orderBook.bids.length : 0,
      headBlock: market.dynamicGlobalProperties ? market.dynamicGlobalProperties.head_block_number : null,
      tickerLatest: market.ticker ? market.ticker.latest : null
    },
    order: {
      defaultWeights,
      gapSlots,
      utilityKeys: Object.keys(orderUtils).slice(0, 10)
    }
  }, null, 2));
}

main().catch((err) => {
  console.error(getErrorMessage(err));
  process.exit(1);
});
export {};
