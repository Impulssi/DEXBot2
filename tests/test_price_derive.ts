/*
 * tests/test_price_derive.ts
 * Tests derivePoolPrice and deriveMarketPrice produce numeric values and expected inversions/orientations.
 */

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
    mock.db.get_liquidity_pools = async () => [{ id: '1.19.500', asset_ids: ['1.3.100', '1.3.101'], total_reserve: 3020000 }];
    mock.db.get_objects = async (ids) => {
        if (Array.isArray(ids) && ids[0] === '1.19.500') return [
            {
                id: '1.19.500',
                reserves: [
                    { asset_id: '1.3.100', amount: 20000 },
                    { asset_id: '1.3.101', amount: 3000000 }
                ],
                total_reserve: 3020000
            }
        ];
        return [];
    };

    mock.db.get_order_book = async (a, b, limit) => ({ bids: [{ price: 0.0014, size: 5 }], asks: [{ price: 0.0016, size: 3 }] });
    mock.db.get_ticker = async () => ({ latest: 0.0015 });

    try {
        const { derivePoolPrice, deriveMarketPrice } = require('../modules/order/utils/system');

        const poolP = await derivePoolPrice(mock, assetA, assetB);
        const marketP = await deriveMarketPrice(mock, assetA, assetB);
        const { derivePrice } = require('../modules/order/utils/system');
        const derivedP = await derivePrice(mock, assetA, assetB);

        // Expected poolP = reserveB/reserveA = 3000000 / 20000 = 150 (B/A orientation)
        assert(Number.isFinite(poolP), 'pool price must be numeric');
        assert(Math.abs(poolP - (3000000 / 20000)) < 1e-9, `unexpected pool price value ${poolP}`);

        // Expected marketP = 1/mid = 1/0.0015 ≈ 666.67 (B/A orientation after inverting A/B from API).
        const expectedMarketP = 1 / 0.0015;
        assert(Number.isFinite(marketP), 'market price must be numeric');
        assert(Math.abs(marketP - expectedMarketP) < 1e-6, `unexpected market price value ${marketP}, expected ${expectedMarketP}`);

        // derivePrice should prefer pool (since we provide pool reserves)
        assert(Number.isFinite(derivedP), 'derived price must be numeric');
        assert(Math.abs(derivedP - poolP) < 1e-9, `derivePrice should choose pool price when pool exists (got ${derivedP}, expected ${poolP})`);

        // Also verify explicit-mode behavior: forcing 'pool' or 'book' modes
        const derivedForcePool = await derivePrice(mock, assetA, assetB, 'pool');
        assert(Number.isFinite(derivedForcePool) && Math.abs(derivedForcePool - poolP) < 1e-9, `derivePrice(mode=pool) should return pool price when available (got ${derivedForcePool}, expected ${poolP})`);
        const derivedForceBook = await derivePrice(mock, assetA, assetB, 'book');
        assert(Number.isFinite(derivedForceBook) && Math.abs(derivedForceBook - marketP) < 1e-9, `derivePrice(mode=book) should return book price when available (got ${derivedForceBook}, expected ${marketP})`);
         // Now test strict behavior: remove pools so pool resolution returns null and derivePrice(auto) still prefers pool but falls back to book
         mock.db.get_liquidity_pools = async () => [];
         mock.db.get_objects = async () => [];
         const derivedStrictAuto = await derivePrice(mock, assetA, assetB);
         assert(Number.isFinite(derivedStrictAuto), 'derivePrice(auto) must still return book price when pool unavailable');
         assert(Math.abs(derivedStrictAuto - marketP) < 1e-9, `derivePrice(auto) should fall back to book price when no pool (got ${derivedStrictAuto}, expected ${marketP})`);

         // When pool is removed, forcing 'pool' mode returns ONLY pool (null if no pool)
         const derivedPoolOnly = await derivePrice(mock, assetA, assetB, 'pool');
         assert(derivedPoolOnly === null, 'derivePrice(mode=pool) should return null when pool unavailable (no fallback to book)');

         // Forcing 'book' mode returns ONLY book price (null if unavailable)
         const derivedBookOnly = await derivePrice(mock, assetA, assetB, 'book');
         assert(Number.isFinite(derivedBookOnly) && Math.abs(derivedBookOnly - marketP) < 1e-9, 'derivePrice(mode=book) should return book price');

         // Invalid mode must not silently fall back to auto behavior
         const derivedInvalidMode = await derivePrice(mock, assetA, assetB, 'markte');
         assert(derivedInvalidMode === null, 'derivePrice(invalid mode) should return null (strict mode validation)');

        console.log('derivePoolPrice, deriveMarketPrice and derivePrice tests passed: poolP=', poolP, 'marketP=', marketP, 'derivedP=', derivedP);

        // TEST: Incomplete metadata (missing reserves) should fetch full data
        console.log('Testing derivePoolPrice with incomplete metadata...');
        mock.db.get_liquidity_pools = async () => [
            { id: '1.19.501', asset_ids: ['1.3.100', '1.3.101'] }
            // Note: missing total_reserve field (incomplete metadata)
        ];
        mock.db.get_objects = async (ids) => {
            if (Array.isArray(ids) && ids[0] === '1.19.501') return [
                {
                    id: '1.19.501',
                    reserves: [
                        { asset_id: '1.3.100', amount: 15000 },
                        { asset_id: '1.3.101', amount: 2250000 }
                    ],
                    total_reserve: 2265000
                }
            ];
            return [];
        };

        const poolPIncomplete = await derivePoolPrice(mock, assetA, assetB);
        assert(Number.isFinite(poolPIncomplete), 'Pool price with incomplete metadata should be numeric');
        // B/A orientation: 2250000 / 15000 = 150
        assert(Math.abs(poolPIncomplete - (2250000 / 15000)) < 1e-9, `Pool price should be calculated from fetched reserves (expected ${2250000 / 15000}, got ${poolPIncomplete})`);
        console.log('✓ Incomplete metadata handling: poolPIncomplete=', poolPIncomplete);

        // TEST: 0-precision asset handling
        console.log('Testing derivePoolPrice with 0-precision assets...');
        const zeroPrecAssetA = 'TEST.ZERO';
        const zeroPrecAssetB = 'BTS.STABLE';

        mock.assets[zeroPrecAssetA.toLowerCase()] = { id: '1.3.200', precision: 0 };
        mock.assets[zeroPrecAssetB.toLowerCase()] = { id: '1.3.201', precision: 5 };

        mock.db.lookup_asset_symbols = async arr => arr.map(s => {
            const lower = String(s).toLowerCase();
            if (lower === zeroPrecAssetA.toLowerCase()) return { id: '1.3.200', precision: 0 };
            if (lower === zeroPrecAssetB.toLowerCase()) return { id: '1.3.201', precision: 5 };
            if (lower === assetA.toLowerCase()) return { id: '1.3.100', precision: 0 };
            if (lower === assetB.toLowerCase()) return { id: '1.3.101', precision: 0 };
            return { id: '1.3.0', precision: 0 };
        });

        mock.db.get_liquidity_pools = async () => [
            {
                id: '1.19.502',
                asset_ids: ['1.3.200', '1.3.201'],
                total_reserve: 5001000
            }
        ];

        mock.db.get_objects = async (ids) => {
            if (Array.isArray(ids) && ids[0] === '1.19.502') return [
                {
                    id: '1.19.502',
                    reserves: [
                        { asset_id: '1.3.200', amount: 1000 },    // 0-precision asset (no decimals)
                        { asset_id: '1.3.201', amount: 5000000 }  // 5 precision asset = 50.00000 in blockchain format
                    ],
                    total_reserve: 5001000
                }
            ];
            return [];
        };

        const poolPZeroPrecision = await derivePoolPrice(mock, zeroPrecAssetA, zeroPrecAssetB);
        assert(Number.isFinite(poolPZeroPrecision), '0-precision asset pool price should be numeric');
        // B/A orientation:
        // floatA = 1000 / 10^0 = 1000
        // floatB = 5000000 / 10^5 = 50
        // price = floatB / floatA = 50 / 1000 = 0.05
        const expectedZeroPrecPrice = (5000000 / Math.pow(10, 5)) / (1000 / Math.pow(10, 0));
        assert(Math.abs(poolPZeroPrecision - expectedZeroPrecPrice) < 1e-9, `Pool price with 0-precision asset should be calculated correctly (expected ${expectedZeroPrecPrice}, got ${poolPZeroPrecision})`);
        console.log('✓ 0-precision asset handling: poolPZeroPrecision=', poolPZeroPrecision);

    } finally {
    }

    process.exit(0);
}
main().catch(err => { console.error(err); process.exit(2); });
