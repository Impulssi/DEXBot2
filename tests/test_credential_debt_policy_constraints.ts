'use strict';

const assert = require('assert');
const fs = require('fs');
// Compiled ESM namespaces are frozen; stub bitshares_client through the
// loader-hook harness before credential_policy is loaded.
const { esmMockEntry, defineEsmMockAbs } = require('./helpers/esm_mocks');

esmMockEntry();

console.log('Running credential debt-policy constraint tests');

function installAssetStub(assetsBySymbol = {}) {
    defineEsmMockAbs(require.resolve('../modules/bitshares_client'), ['BitShares'], {
        BitShares: {
            db: {
                lookup_asset_symbols: async (symbols) => {
                    return (symbols || []).map((symbol) => assetsBySymbol[String(symbol)] || null);
                },
                get_assets: async (ids) => {
                    return (ids || []).map((id) => {
                        const match = Object.values(assetsBySymbol).find((asset) => String((asset as any)?.id) === String(id));
                        return match || null;
                    });
                },
            },
        },
    });
}

async function testWrappedCommentedBotsJsonResolvesDebtConstraints() {
    const originalExistsSync = fs.existsSync;
    const originalReadFileSync = fs.readFileSync;
    installAssetStub({
        'HONEST.USD': { id: '1.3.10', symbol: 'HONEST.USD' },
        BTS: { id: '1.3.0', symbol: 'BTS' },
    });
    const policy = require('../modules/credential_policy');

    try {
        fs.existsSync = (targetPath) => {
            if (String(targetPath).endsWith('/profiles/bots.json')) return true;
            return originalExistsSync(targetPath);
        };
        fs.readFileSync = (targetPath, encoding) => {
            if (String(targetPath).endsWith('/profiles/bots.json')) {
                return `{
  // active omitted on purpose: default-enabled bots should still derive constraints
  "bots": [
    {
      "preferredAccount": "alice",
      "name": "credit-bot",
      "debtPolicy": {
        "lending": [
          {
            "asset": "HONEST.USD",
            "collateralAsset": "BTS",
            "type": "creditOffer"
          },
          {
            "asset": "HONEST.USD",
            "collateralAsset": "BTS",
            "type": "mpa"
          }
        ]
      }
    },
    {
      "preferredAccount": "alice",
      "active": false,
      "debtPolicy": {
        "lending": [
          {
            "asset": "1.3.999",
            "collateralAsset": "1.3.998",
            "type": "creditOffer"
          }
        ]
      }
    }
  ]
}`;
            }
            return originalReadFileSync(targetPath, encoding);
        };

        const resolvedPolicy = policy.resolveAccountPolicy({}, 'alice');
        assert.strictEqual(
            resolvedPolicy.allowedOps.call_order_update.collateralAsset,
            'BTS',
            'wrapped bots.json should derive MPA collateral constraints for default-enabled bots'
        );
        assert.deepStrictEqual(
            resolvedPolicy.allowedOps.credit_offer_accept.allowedDebtAssets,
            ['HONEST.USD'],
            'wrapped bots.json should derive credit debt constraints from the active bot set'
        );

        const creditAcceptResult = await policy.evaluatePolicy(resolvedPolicy, {
            accountName: 'alice',
            requestType: 'sign',
            operations: [
                {
                    op_name: 'credit_offer_accept',
                    op_data: {
                        offer_id: '1.18.42',
                        borrow_amount: { asset_id: '1.3.10', amount: 500 },
                        collateral: { asset_id: '1.3.0', amount: 1000 },
                        max_fee_rate: 0,
                        min_duration_seconds: 0,
                        extensions: {},
                    },
                },
            ],
        });
        assert.strictEqual(
            creditAcceptResult.allow,
            true,
            `symbol-based credit constraints should resolve to on-chain asset IDs, got: ${creditAcceptResult.reason}`
        );

        const callOrderResult = await policy.evaluatePolicy(resolvedPolicy, {
            accountName: 'alice',
            requestType: 'sign',
            operations: [
                {
                    op_name: 'call_order_update',
                    op_data: {
                        delta_collateral: { asset_id: '1.3.0', amount: 100 },
                        delta_debt: { asset_id: '1.3.10', amount: 50 },
                        extensions: { target_collateral_ratio: 2200 },
                    },
                },
            ],
        });
        assert.strictEqual(
            callOrderResult.allow,
            true,
            `symbol-based MPA collateral constraints should resolve to on-chain asset IDs, got: ${callOrderResult.reason}`
        );
    } finally {
        fs.existsSync = originalExistsSync;
        fs.readFileSync = originalReadFileSync;
    }
}

(async () => {
    await testWrappedCommentedBotsJsonResolvesDebtConstraints();
    console.log('credential debt-policy constraint tests passed');
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
