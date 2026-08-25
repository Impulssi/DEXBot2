const assert = require('assert');

async function main() {

    const mock = { assets: {}, db: {} as any };
    const assetA = 'IOB.XRP';
    const assetB = 'BTS';
    mock.assets[assetA.toLowerCase()] = { id: '1.3.100' };
    mock.assets[assetB.toLowerCase()] = { id: '1.3.101' };

    mock.db.lookup_asset_symbols = async arr => arr.map(s => ({ id: s.toLowerCase() === assetA.toLowerCase() ? '1.3.100' : '1.3.101', precision: 0 }));
    mock.db.get_assets = async ids => ids.map(id => ({ id: String(id), precision: 0 }));

    mock.db.get_liquidity_pools_by_both_assets = async (a, b) => [];
    mock.db.get_liquidity_pools = async () => [{ id: '1.19.501', asset_ids: ['1.3.100', '1.3.101'], total_reserve: 100000 }];
    mock.db.get_objects = async (ids) => {
        if (Array.isArray(ids) && ids[0] === '1.19.501') return [{
            id: '1.19.501',
            // Reserves intentionally lack asset_id and there are no reserve_a/reserve_b fields
            reserves: [{ amount: 20000 }, { amount: 3000000 }]
        }];
        return [];
    };

    try {
        const { derivePoolPrice } = require('../modules/order/utils/system');
        const p = await derivePoolPrice(mock, assetA, assetB);
        assert(p === null, 'derivePoolPrice should return null when pool reserves lack asset_id and no named reserve fields');
        console.log('derivePoolPrice returned null as expected (no positional fallback)');
    } finally {
    }
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(2); });
