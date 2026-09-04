'use strict';

// Universal credit conversion fallback: _resolveCreditConversionRate must
// resolve a rate for every collateral/debt pair — offer map first, then LP
// pool, then universal DEX pricing (direct market, else bridge hops) —
// instead of dropping to missing-offer when the collateral or pool is not
// part of the credit offer.

const assert = require('assert');

const DEBT = { id: '1.3.10', symbol: 'HONEST.USD', precision: 5 };
const COLL = { id: '1.3.11', symbol: 'EXO.TOKEN', precision: 5 };

function createRuntime() {
  delete require.cache[require.resolve('../modules/credit_runtime')];
  const CreditRuntime = require('../modules/credit_runtime').default;
  const runtime = new CreditRuntime({
    config: {
      botKey: 'credit-fallback-0',
      debtPolicy: { lending: [] },
      feeParams: { GRAPHENE_FEE_RATE_DENOM: 1000000 },
    },
    account: { id: '1.2.3', name: 'alice' },
    accountId: '1.2.3',
    _log() {},
    _warn() {},
  }, { stateDir: require('os').tmpdir() });
  const byRef = new Map([
    ['HONEST.USD', DEBT], ['1.3.10', DEBT],
    ['EXO.TOKEN', COLL], ['1.3.11', COLL],
  ]);
  runtime._resolveAsset = async (ref) => byRef.get(String(ref)) || null;
  return runtime;
}

const lendingItem = {
  type: 'creditOffer',
  asset: 'HONEST.USD',
  collateralAsset: 'EXO.TOKEN',
  maxCollateralRatio: 2.5,
  allowedOfferIds: [],
};

async function main() {
  const { setDerivePriceTestHook } = require('../modules/order/utils/system');
  // No direct EXO/HONEST market; both legs vs BTS exist (2 * 3 = 6).
  setDerivePriceTestHook(async (_bs, symA, symB) => {
    if (symA === '1.3.11' && symB === 'BTS') return 2;
    if (symA === 'BTS' && symB === '1.3.10') return 3;
    return null;
  });

  try {
    // Case 1: no offer anywhere -> universal bridge pricing, not missing-offer.
    const rt1 = createRuntime();
    rt1._dbCall = async () => [];
    const bridged = await rt1._resolveCreditConversionRate(lendingItem, DEBT.id, COLL.id, { includeSource: true });
    assert.deepStrictEqual(
      bridged,
      { price: 6, source: 'market-bridge:BTS' },
      `unlisted collateral should bridge-price (got ${JSON.stringify(bridged)})`,
    );
    assert.strictEqual(rt1.state.positions[`${DEBT.id}:${COLL.id}`].creditConversionRate, 6, 'bridged rate should be cached');

    // Case 2: offer map hit still wins over bridging.
    const rt2 = createRuntime();
    const offer = {
      id: '1.21.7',
      asset_type: DEBT.id,
      enabled: true,
      acceptable_collateral: {
        [COLL.id]: {
          base: { amount: 1000000, asset_id: DEBT.id },
          quote: { amount: 100000, asset_id: COLL.id },
        },
      },
    };
    rt2.state.positions[`${DEBT.id}:${COLL.id}`] = { creditDeals: [{ offerId: '1.21.7' }] };
    rt2._dbCall = async (method) => {
      if (method === 'get_objects') return [offer];
      return [];
    };
    const offered = await rt2._resolveCreditConversionRate(lendingItem, DEBT.id, COLL.id, { includeSource: true });
    assert.deepStrictEqual(
      offered,
      { price: 10, source: 'live-offer' },
      `offer price must take precedence (got ${JSON.stringify(offered)})`,
    );

    console.log('credit conversion fallback tests passed');
  } finally {
    setDerivePriceTestHook(null);
  }

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(2); });
