const assert = require('assert');

console.log('Running fetch_lp_data parsing tests');

const {
    applyPrecisionOverrides,
    parseBotsConfig,
    selectBot,
} = require('../market_adapter/inputs/fetch_lp_data');

{
    const raw = `{
  // single-line comment
  "bots": [
    {
      /* block comment */
      "name": "AAA-BBB",
      "active": true,
      "startPrice": "pool",
      "assetA": "IOB.XRP",
      "assetB": "BTS"
    }
  ]
}`;

    const bots = parseBotsConfig(raw, 'inline-fixture');
    assert.ok(Array.isArray(bots), 'parseBotsConfig should return an array');
    assert.strictEqual(bots.length, 1, 'commented bots fixture should parse one bot');
    assert.strictEqual(bots[0].name, 'AAA-BBB', 'parsed bot name should match');
}

{
    assert.throws(
        () => parseBotsConfig('{"foo": 1}', 'invalid-fixture'),
        /Invalid bots\.json format: invalid-fixture/,
        'invalid format should throw with source label'
    );
}

{
    const bots = [
        { name: 'A', active: false, startPrice: 'pool' },
        { name: 'B', active: true, startPrice: 'book' },
        { name: 'C', active: true, startPrice: 'pool' },
    ];
    const selected = selectBot(bots, null);
    assert.strictEqual(selected.name, 'C', 'selectBot should pick first active pool-price bot');
}

{
    const { assetA, assetB } = applyPrecisionOverrides(
        { id: '1.3.1', precision: 4, symbol: 'IOB.XRP' },
        { id: '1.3.0', precision: 5, symbol: 'BTS' },
        8,
        null
    );
    assert.strictEqual(assetA.precision, 8, 'precision override should be applied to cached or resolved asset A metadata');
    assert.strictEqual(assetB.precision, 5, 'missing override should preserve the existing asset B precision');
}

console.log('fetch_lp_data parsing tests passed');
