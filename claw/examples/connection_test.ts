import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  getAsset,
  getBalances,
  getDynamicGlobalProperties,
  getFullAccount,
  getOrderBook
} = require('../modules/chain_queries');
const { getErrorMessage } = require('../../modules/utils/errors');

async function main() {
  const accountRef = process.argv[2];

  const globals = await getDynamicGlobalProperties();
  console.log('Connected to BitShares');
  console.log('Head block number:', globals.head_block_number);

  const bts = await getAsset('BTS');
  console.log('BTS asset id:', bts ? bts.id : 'not found');
  console.log('BTS precision:', bts ? bts.precision : 'not found');

  const book = await getOrderBook('BTS', 'USD', 5);
  console.log('Top BTS/USD bids:', Array.isArray(book.bids) ? book.bids.length : 0);
  console.log('Top BTS/USD asks:', Array.isArray(book.asks) ? book.asks.length : 0);

  if (accountRef) {
    const full = await getFullAccount(accountRef);
    const balances = await getBalances(accountRef);
    console.log('Account id:', full && full.account ? full.account.id : 'not found');
    console.log('Balances:', balances);
  }
}

main().catch((err) => {
  console.error(getErrorMessage(err));
  process.exit(1);
});
export {};
