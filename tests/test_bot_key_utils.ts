const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

console.log('Running bot_key_utils tests');

const {
    loadBotSettings,
    sanitizeKey,
    computeBotKey,
    resolveBotKey,
    candleFileForBot,
    resolveCandleFile,
} = require('../analysis/bot_key_utils');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-bot-key-utils-'));
const tmpDataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(tmpDataDir, { recursive: true });
let passed = 0;
let failed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
    } catch (err) {
        failed++;
        console.error(`  FAIL: ${name}`);
        console.error(`    ${err && err.message ? err.message : err}`);
        if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    }
}

try {

    check('sanitizeKey: null/undefined/empty → "bot"', () => {
        assert.strictEqual(sanitizeKey(null), 'bot');
        assert.strictEqual(sanitizeKey(undefined), 'bot');
        assert.strictEqual(sanitizeKey(''), 'bot');
    });

    check('sanitizeKey: lowercases and kebab-cases', () => {
        assert.strictEqual(sanitizeKey('XRP-BTS'), 'xrp-bts');
        assert.strictEqual(sanitizeKey('XRP BTS'), 'xrp-bts');
        assert.strictEqual(sanitizeKey('  My Bot!!  '), 'my-bot');
    });

    check('sanitizeKey: strips leading/trailing dashes', () => {
        assert.strictEqual(sanitizeKey('---foo---'), 'foo');
        assert.strictEqual(sanitizeKey('!!'), 'bot');
    });

    check('computeBotKey: named bot uses sanitized name only', () => {
        const key = computeBotKey({ name: 'XRP-BTS', id: '1.2.123' }, 0);
        assert.strictEqual(key, 'xrp-bts');
    });

    check('computeBotKey: named bot ignores index', () => {
        const key = computeBotKey({ name: 'XRP-BTS' }, 7);
        assert.strictEqual(key, 'xrp-bts');
    });

    check('computeBotKey: missing name uses bot-N-index fallback, ignores id', () => {
        const withId = computeBotKey({ id: '1.2.5' }, 3);
        assert.strictEqual(withId, 'bot-3-3');
        const withoutId = computeBotKey({}, 3);
        assert.strictEqual(withoutId, 'bot-3-3');
    });

    check('candleFileForBot: path format', () => {
        const customDir = path.join(tmpRoot, 'custom-data');
        const p = candleFileForBot('xrp-bts-0', '1h', customDir);
        assert.strictEqual(p, path.join(customDir, 'market_adapter_xrp-bts-0_1h.json'));
    });

    check('candleFileForBot: defaults to PATHS.MARKET_ADAPTER.DATA_DIR', () => {
        const { PATHS } = require('../modules/paths');
        const p = candleFileForBot('foo', '1h');
        assert.strictEqual(p, path.join(PATHS.MARKET_ADAPTER.DATA_DIR, 'market_adapter_foo_1h.json'));
    });

    const botsFile = path.join(tmpRoot, 'bots.json');
    fs.writeFileSync(botsFile, JSON.stringify({
        bots: [
            { name: 'XRP-BTS', id: '1.2.100', assetA: 'XRP', assetB: 'BTS' },
            { name: 'HONEST-BTC', assetA: 'HONEST.BTC', assetB: 'BTC' },
        ],
    }));

    check('loadBotSettings: missing file returns null', () => {
        assert.strictEqual(loadBotSettings(path.join(tmpRoot, 'missing.json')), null);
    });

    check('loadBotSettings: valid file returns parsed object', () => {
        const loaded = loadBotSettings(botsFile);
        assert.ok(loaded && Array.isArray(loaded.bots) && loaded.bots.length === 2);
        assert.strictEqual(loaded.bots[0].name, 'XRP-BTS');
    });

    check('loadBotSettings: null path returns null', () => {
        assert.strictEqual(loadBotSettings(null), null);
    });

    check('resolveBotKey: name hit returns canonical key', () => {
        const key = resolveBotKey('XRP-BTS', botsFile);
        assert.strictEqual(key, 'xrp-bts');
    });

    check('resolveBotKey: name hit (no id) uses sanitized name', () => {
        const key = resolveBotKey('HONEST-BTC', botsFile);
        assert.strictEqual(key, 'honest-btc');
    });

    check('resolveBotKey: unknown name returns null', () => {
        assert.strictEqual(resolveBotKey('does-not-exist', botsFile), null);
    });

    check('resolveBotKey: null/empty returns null', () => {
        assert.strictEqual(resolveBotKey(null, botsFile), null);
        assert.strictEqual(resolveBotKey('', botsFile), null);
    });

    const directFile = path.join(tmpDataDir, 'market_adapter_xrp-bts_1h.json');
    fs.writeFileSync(directFile, '{}');

    check('resolveCandleFile: direct key hit returns direct path', () => {
        const p = resolveCandleFile('xrp-bts', '1h', tmpDataDir, botsFile);
        assert.strictEqual(p, directFile);
    });

    const fuzzyFile = path.join(tmpDataDir, 'market_adapter_honest-btc_1h.json');
    fs.writeFileSync(fuzzyFile, '{}');

    check('resolveCandleFile: name-only falls back to canonical key lookup', () => {
        const p = resolveCandleFile('HONEST-BTC', '1h', tmpDataDir, botsFile);
        assert.strictEqual(p, fuzzyFile);
    });

    check('resolveCandleFile: unknown bot returns null', () => {
        assert.strictEqual(resolveCandleFile('nope-nope', '1h', tmpDataDir, botsFile), null);
    });

    check('resolveCandleFile: direct hit preferred over name resolution', () => {
        const dataDir2 = path.join(tmpRoot, 'data2');
        fs.mkdirSync(dataDir2, { recursive: true });
        const directOnly = path.join(dataDir2, 'market_adapter_xrp-bts_1h.json');
        fs.writeFileSync(directOnly, '{}');
        const p = resolveCandleFile('xrp-bts', '1h', dataDir2, botsFile);
        assert.strictEqual(p, directOnly);
    });

    check('resolveCandleFile: empty data dir is not confused with real PATHS', () => {
        const isolatedDir = path.join(tmpRoot, 'isolated');
        fs.mkdirSync(isolatedDir, { recursive: true });
        const p = resolveCandleFile('whatever', '1h', isolatedDir, botsFile);
        assert.strictEqual(p, null);
    });

} finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failed > 0) {
    console.error(`bot_key_utils tests FAILED: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`bot_key_utils tests passed (${passed} checks)`);
