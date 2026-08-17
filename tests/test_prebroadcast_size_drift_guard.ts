/*
 * tests/test_prebroadcast_size_drift_guard.ts
 * Verifies the pre-broadcast size-drift guard in chain_orders.executeBatch:
 * a negative limit_order_update delta that would over-reduce the order's
 * current on-chain for_sale is rejected PRE-broadcast with the chain's
 * "Cannot deduct all or more from order than order contains" error, so the
 * caller routes to the size-drift repair path instead of letting the chain
 * reject the whole batch and cascade into uncertain-broadcast recovery.
 */

const assert = require('assert');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

const bitsharesClientPath = path.resolve(__dirname, '../modules/bitshares_client.ts');

function makeGetObjectsMock() {
    const orders = new Map([
        ['1.7.1000', { id: '1.7.1000', sell_price: { base: { asset_id: '1.3.1', amount: 1000 }, quote: { asset_id: '1.3.2', amount: 1 } }, for_sale: '1000' }],
        ['1.7.1001', { id: '1.7.1001', sell_price: { base: { asset_id: '1.3.1', amount: 1000 }, quote: { asset_id: '1.3.2', amount: 1 } }, for_sale: '500' }],
    ]);
    return {
        calls: 0,
        fn: async (ids: string[]) => {
            return ids.map((id) => orders.get(id) || null);
        },
    };
}

function makeUpdateOp(orderId: string, deltaAmount: number, sellAssetId = '1.3.1') {
    return {
        op_name: 'limit_order_update',
        op_data: {
            fee: { amount: 0, asset_id: '1.3.0' },
            seller: '1.2.1',
            order: orderId,
            new_price: {
                base: { amount: 900, asset_id: sellAssetId },
                quote: { amount: 1, asset_id: '1.3.2' },
            },
            delta_amount_to_sell: { amount: deltaAmount, asset_id: sellAssetId },
        },
    };
}

async function main() {
    console.log('\n[DRIFT-GUARD-01] findOverReducingUpdateOpError: over-reducing negative delta detected...');

    const bsModule = require('../modules/bitshares_client');
    const getObjects = makeGetObjectsMock();
    const stubbed = {
        ...bsModule,
        BitShares: {
            assets: {},
            db: { get_objects: getObjects.fn },
        },
        waitForConnected: async () => true,
    };
    const original = setCachedModule(bitsharesClientPath, stubbed);

    try {
        const chainOrders = require('../modules/chain_orders');

        // ── over-reducing delta → error matching the chain message ────────────
        // Order 1.7.1001 has for_sale=500; a delta of -600 would drive the new
        // size to -100 → chain rejection. The guard must surface it pre-broadcast.
        const driftError = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.1001', -600),
        ]);
        assert.ok(driftError instanceof Error, 'over-reducing delta must yield an Error');
        assert.ok(
            /Cannot deduct all or more from order than order contains/.test(driftError.message),
            `error must match the chain rejection message for size-drift routing, got: ${driftError.message}`
        );
        console.log('  ✓ Over-reducing delta detected pre-broadcast');

        // ── sufficient for_sale → no error ────────────────────────────────────
        // Order 1.7.1000 has for_sale=1000; delta -600 leaves 400 → valid.
        const okResult = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.1000', -600),
        ]);
        assert.strictEqual(okResult, null, 'a delta that leaves a positive residual must pass');
        console.log('  ✓ Valid reduction passes the guard');

        // ── cumulative over-reduction across two ops on the same order ────────
        // The chain applies a batch's ops sequentially, so two -600 deltas on
        // an order with for_sale=1000 drive it to -200 even though each op
        // individually leaves a positive residual. The guard must aggregate
        // deltas per order to catch the cumulative rejection.
        const cumulativeResult = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.1000', -600),
            makeUpdateOp('1.7.1000', -600),
        ]);
        assert.ok(cumulativeResult instanceof Error, 'cumulative over-reduction across same-order ops must yield an Error');
        assert.ok(
            /Cannot deduct all or more from order than order contains/.test(cumulativeResult.message),
            'cumulative drift must route to the size-drift repair path'
        );
        console.log('  ✓ Cumulative same-order deltas detected as drift');

        // ── order gone from chain → detected as stale, not size drift ────────
        // An order missing on chain has no for_sale to re-size, so it must
        // route to stale-order cleanup (matching the chain's stale-order
        // message) rather than the size-drift repair path.
        const goneResult = await chainOrders.findOverReducingUpdateOpError([
            makeUpdateOp('1.7.9999', -100),
        ]);
        assert.ok(goneResult instanceof Error, 'an order missing on chain must be treated as drift');
        assert.ok(
            /object 1\.7\.9999 does not exist/.test(goneResult.message),
            'missing-order error must route to stale-order cleanup, got: ' + goneResult.message
        );
        console.log('  ✓ Missing on-chain order detected as stale (not size drift)');

        // ── no negative-delta update ops → no pre-read RPC ────────────────────
        const before = getObjects.calls;
        const noNegative = await chainOrders.findOverReducingUpdateOpError([
            { op_name: 'limit_order_create', op_data: { amount_to_sell: { amount: 100, asset_id: '1.3.1' } } },
            makeUpdateOp('1.7.1000', 50), // positive delta — no reduction risk
        ]);
        assert.strictEqual(noNegative, null, 'batches without over-reduction risk must pass');
        assert.strictEqual(getObjects.calls, before, 'no pre-read RPC should fire without a negative delta');
        console.log('  ✓ No pre-read RPC for batches without negative deltas');

        // ── executeBatch surfaces the drift error BEFORE any broadcast ────────
        // The guard throws before createAccountClient/broadcast, so the raw
        // executeBatch call rejects with the drift error even with a stub that
        // cannot broadcast.
        await assert.rejects(
            () => chainOrders.executeBatch('test-account', 'dummy-key', [
                makeUpdateOp('1.7.1001', -600),
            ]),
            /Cannot deduct all or more from order than order contains/,
            'executeBatch must reject pre-broadcast on over-reducing deltas'
        );
        console.log('  ✓ executeBatch rejects over-reducing deltas before broadcast');
    } finally {
        restoreCachedModule(bitsharesClientPath, original);
    }

    console.log('All pre-broadcast size-drift guard tests passed.');
}

Promise.resolve()
    .then(() => main())
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('Test failed!');
        console.error(err);
        process.exit(1);
    });
