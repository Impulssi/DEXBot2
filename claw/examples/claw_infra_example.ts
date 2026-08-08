import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { createClawInfrastructure } = require('../modules/claw_infra');
const { getErrorMessage } = require('../../modules/utils/errors');

async function main() {
  const accountName = process.argv[2] || null;
  const pair = process.argv[3] || 'BTS/USD';
  const [baseSymbol, quoteSymbol] = pair.split('/');

  const infra = createClawInfrastructure({
    accountName
  });

  console.log(JSON.stringify({
    credential: {
      readyFilePath: infra.credential.readyFilePath,
      socketPath: infra.credential.socketPath
    },
    runtime: infra.runtime,
    stateFile: infra.stateStore.filePath
  }, null, 2));

  const globals = await infra.market.getDynamicGlobalProperties();
  console.log('Head block number:', globals.head_block_number);

  if (accountName) {
    const accountSnapshot = await infra.market.readAccountSnapshot(accountName);
    console.log(JSON.stringify({
      accountId: accountSnapshot.account && accountSnapshot.account.account ? accountSnapshot.account.account.id : null,
      balances: accountSnapshot.balances,
      openOrders: accountSnapshot.openOrders.length
    }, null, 2));
  }

  if (baseSymbol && quoteSymbol) {
    const marketSnapshot = await infra.market.readMarketSnapshot(baseSymbol, quoteSymbol, 5);
    console.log(JSON.stringify({
      orderBookDepth: {
        asks: Array.isArray(marketSnapshot.orderBook.asks) ? marketSnapshot.orderBook.asks.length : 0,
        bids: Array.isArray(marketSnapshot.orderBook.bids) ? marketSnapshot.orderBook.bids.length : 0
      },
      tickerLatest: marketSnapshot.ticker ? marketSnapshot.ticker.latest : null
    }, null, 2));
  }
}

main().catch((err) => {
  console.error(getErrorMessage(err));
  process.exit(1);
});
export {};
