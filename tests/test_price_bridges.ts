/*
 * tests/test_price_bridges.ts
 * Tests derivePriceWithBridges / derivePriceViaBridges multi-hop pricing and
 * the bridged reserve leg inside deriveLiquidityPoolTokenValue — the
 * universal fallback that resolves a conversion rate for every
 * collateral/debt pair even when the offer lists no price for it.
 */

const assert = require('assert');

async function main() {
  const system = require('../modules/order/utils/system');
  const { derivePriceWithBridges, derivePriceViaBridges, deriveLiquidityPoolTokenValue, setDerivePriceTestHook } = system;

  // Leg matrix: no direct X/Y market; both legs vs BTS exist.
  setDerivePriceTestHook(async (_bs: any, symA: string, symB: string) => {
    if (symA === '1.3.100' && symB === '1.3.101') return 7;
    if (symA === '1.3.100' && symB === 'BTS') return 4;
    if (symA === 'BTS' && symB === '1.3.101') return 3;
    if (symA === '1.3.200' && symB === 'BTS') return 2;
    if (symA === 'BTS' && symB === '1.3.201') return 0.5;
    return null;
  });

  try {
    const mock = { assets: {}, db: {} as any };

    // Direct market wins when present.
    const direct = await derivePriceWithBridges(mock, '1.3.100', '1.3.101');
    assert.deepStrictEqual(direct, { rate: 7, path: 'direct' }, 'direct price preferred');

    // No direct market -> bridge product (4 * 3 = 12 via BTS).
    setDerivePriceTestHook(async (_bs: any, symA: string, symB: string) => {
      if (symA === '1.3.200' && symB === 'BTS') return 2;
      if (symA === 'BTS' && symB === '1.3.201') return 0.5;
      return null;
    });
    const bridged = await derivePriceWithBridges(mock, '1.3.200', '1.3.201');
    assert.deepStrictEqual(bridged, { rate: 1, path: 'bridge:BTS' }, 'bridge hops multiply');

    // Identity pair is 1 without touching the market.
    assert.deepStrictEqual(await derivePriceWithBridges(mock, 'BTS', 'BTS'), { rate: 1, path: 'identity' }, 'identity is 1');

    // A bridge equal to either side is skipped -> null when nothing else helps.
    assert.strictEqual(await derivePriceViaBridges(mock, 'BTS', '1.3.201', ['BTS']), null, 'self bridge skipped');
    assert.strictEqual(await derivePriceViaBridges(mock, '1.3.200', '1.3.201', ['NOPE']), null, 'unknown bridge is null');
    assert.strictEqual(await derivePriceWithBridges(mock, '1.3.200', '1.3.201', []), null, 'empty bridges is null');

    // LP valuation with an exotic reserve: direct reserve->denom leg is
    // missing, the BTS bridge completes it.
    const shareId = '1.3.500';
    const denomId = '1.3.0';
    const reserveId = '1.3.100';
    const assetDefs: Record<string, any> = {
      [shareId]: { id: shareId, symbol: 'LP.SHARE', precision: 4, dynamic_asset_data_id: '2.3.500' },
      [denomId]: { id: denomId, symbol: 'BTS', precision: 5 },
      [reserveId]: { id: reserveId, symbol: 'EXO.TOKEN', precision: 5 },
    };
    mock.db.lookup_asset_symbols = async (arr: string[]) => arr.map((s) => assetDefs[String(s)] || null);
    mock.db.get_assets = async (ids: string[]) => ids.map((id) => assetDefs[String(id)] || null);
    mock.db.get_liquidity_pools_by_share_asset = async () => [
      { id: '1.19.9', asset_a: reserveId, asset_b: denomId, balance_a: 20000, balance_b: 3000000 },
    ];
    mock.db.get_objects = async (ids: string[]) => {
      if (Array.isArray(ids) && ids[0] === '2.3.500') return [{ id: '2.3.500', current_supply: 10000 }];
      return [];
    };
    setDerivePriceTestHook(async (_bs: any, symA: string, symB: string) => {
      if (symA === reserveId && symB === denomId) return null; // no direct market
      if (symA === reserveId && symB === 'BTS') return 4;
      if (symA === 'BTS' && symB === denomId) return 0.5;
      return null;
    });
    const lpValue = await deriveLiquidityPoolTokenValue(mock, shareId, denomId, 'auto', true);
    // reserveA = 0.2 @ bridged 2.0 + reserveB = 30 @ 1.0, supply = 1.0 share.
    assert(Number.isFinite(lpValue), 'bridged LP valuation must be numeric');
    assert(Math.abs((lpValue as number) - 30.4) < 1e-9, `bridged LP value should be 30.4 (got ${lpValue})`);

    // Default (no opt-in): previous direct-only behavior — the exotic
    // reserve without a direct market fails the whole valuation.
    assert.strictEqual(await deriveLiquidityPoolTokenValue(mock, shareId, denomId), null, 'bridges are opt-in');

    console.log('price-bridge tests passed');
  } finally {
    setDerivePriceTestHook(null);
  }

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(2); });
