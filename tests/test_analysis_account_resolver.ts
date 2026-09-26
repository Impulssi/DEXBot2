'use strict';

// Offline unit tests for the shared analysis account resolver
// (analysis/account_resolver.ts): the preferredAccount / --account override /
// stored-accountId decision tree and the bots.json persistence it performs.
// The chain lookup is injected, so nothing here touches a node.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveBotAccount, resolveAccountRef } = require('../analysis/account_resolver');
const { loadBotSettings } = require('../analysis/bot_key_utils');

function tempBotsFile(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-acct-resolver-'));
  const file = path.join(dir, 'bots.json');
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return file;
}

function bot(name, preferredAccount, extra = {}) {
  return Object.assign({
    name,
    preferredAccount,
    assetA: 'AAA',
    assetB: 'BBB',
    active: true,
  }, extra || {});
}

const quiet = { quiet: true };
const noLookup = () => { throw new Error('chain lookup must not run'); };

async function main() {
  // ─── resolveBotAccount: decision tree + persistence ───

  // Typed 1.2.x preferredAccount is authoritative and self-heals a stale cache.
  {
    const file = tempBotsFile({ bots: [bot('My Bot', '1.2.1001', { accountId: '1.2.9999' })] });
    const res = await resolveBotAccount('my-bot', { ...quiet, botsFile: file, lookup: noLookup });
    assert.strictEqual(res.accountId, '1.2.1001');
    assert.strictEqual(res.source, 'preferred-id');
    assert.strictEqual(res.reason, null);
    assert.strictEqual(loadBotSettings(file).bots[0].accountId, '1.2.1001', 'stale cache must be self-healed');
  }

  // A cached accountId is reused with no chain lookup.
  {
    const file = tempBotsFile({ bots: [bot('My Bot', 'fixture-account', { accountId: '1.2.1001' })] });
    const res = await resolveBotAccount('my-bot', { ...quiet, botsFile: file, lookup: noLookup });
    assert.strictEqual(res.accountId, '1.2.1001');
    assert.strictEqual(res.source, 'stored');
  }

  // A fresh name resolution is persisted onto the bot entry.
  {
    const file = tempBotsFile({ bots: [bot('My Bot', 'fixture-account')] });
    let calls = 0;
    const res = await resolveBotAccount('my-bot', {
      ...quiet,
      botsFile: file,
      lookup: async (name) => { calls++; assert.strictEqual(name, 'fixture-account'); return '1.2.1001'; },
    });
    assert.strictEqual(res.accountId, '1.2.1001');
    assert.strictEqual(res.source, 'resolved');
    assert.strictEqual(calls, 1, 'exactly one chain lookup');
    assert.strictEqual(loadBotSettings(file).bots[0].accountId, '1.2.1001', 'resolved ID must be stored');
  }

  // --refresh-account bypasses the cache and updates a changed ID.
  {
    const file = tempBotsFile({ bots: [bot('My Bot', 'fixture-account', { accountId: '1.2.1999' })] });
    const res = await resolveBotAccount('my-bot', { ...quiet, refresh: true, botsFile: file, lookup: async () => '1.2.1001' });
    assert.strictEqual(res.accountId, '1.2.1001');
    assert.strictEqual(loadBotSettings(file).bots[0].accountId, '1.2.1001');
  }

  // An explicit --account name wins over the bot entry and is never persisted.
  {
    const file = tempBotsFile({ bots: [bot('My Bot', 'fixture-account', { accountId: '1.2.1001' })] });
    const before = fs.readFileSync(file, 'utf8');
    const res = await resolveBotAccount('my-bot', { ...quiet, overrideAccount: 'other-account', botsFile: file, lookup: async () => '1.2.7777' });
    assert.strictEqual(res.accountId, '1.2.7777');
    assert.strictEqual(res.source, 'override-resolved');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'an override must not touch bots.json');
  }

  // An explicit --account 1.2.x override is returned verbatim.
  {
    const file = tempBotsFile({ bots: [bot('My Bot', 'fixture-account')] });
    const res = await resolveBotAccount('my-bot', { ...quiet, overrideAccount: '1.2.4242', botsFile: file, lookup: noLookup });
    assert.strictEqual(res.accountId, '1.2.4242');
    assert.strictEqual(res.source, 'override-id');
    assert.strictEqual(loadBotSettings(file).bots[0].accountId, undefined);
  }

  // Failure reasons, and no write on failure.
  {
    const file = tempBotsFile({ bots: [bot('My Bot', 'fixture-account')] });
    assert.strictEqual((await resolveBotAccount('no-such-bot', { ...quiet, botsFile: file, lookup: noLookup })).reason, 'bot-not-found');
    assert.strictEqual((await resolveBotAccount('my-bot', { ...quiet, overrideAccount: 'nope', botsFile: file, lookup: async () => null })).reason, 'override-unresolved');
    assert.strictEqual((await resolveBotAccount('my-bot', { ...quiet, botsFile: file, lookup: async () => null })).reason, 'name-unresolved');
    const empty = tempBotsFile({ bots: [bot('My Bot', '')] });
    assert.strictEqual((await resolveBotAccount('my-bot', { ...quiet, botsFile: empty, lookup: noLookup })).reason, 'no-preferred-account');
    assert.strictEqual(loadBotSettings(file).bots[0].accountId, undefined, 'failed lookups must not write');
  }

  // ─── resolveAccountRef: bare account argument ───

  {
    const typed = await resolveAccountRef('1.2.55', { ...quiet, lookup: noLookup });
    assert.strictEqual(typed.accountId, '1.2.55');
    assert.strictEqual(typed.source, 'typed-id');

    // A name that matches a bot's preferredAccount is resolved and persisted.
    const file = tempBotsFile({ bots: [bot('My Bot', 'fixture-account')] });
    const matched = await resolveAccountRef('FIXTURE-ACCOUNT', { ...quiet, botsFile: file, lookup: async () => '1.2.1001' });
    assert.strictEqual(matched.accountId, '1.2.1001');
    assert.strictEqual(matched.botKey, 'my-bot');
    assert.strictEqual(loadBotSettings(file).bots[0].accountId, '1.2.1001', 'a bot-name match must persist');

    // A name no bot claims still resolves, but there is no entry to persist to.
    const unmatched = await resolveAccountRef('stranger', { ...quiet, botsFile: file, lookup: async () => '1.2.8888' });
    assert.strictEqual(unmatched.accountId, '1.2.8888');
    assert.strictEqual(unmatched.botKey, null);
    assert.strictEqual((await resolveAccountRef('stranger', { ...quiet, botsFile: file, lookup: async () => null })).reason, 'name-unresolved');
  }

  console.log('analysis account resolver tests passed');
}

main().catch((err) => {
  console.error('analysis account resolver tests FAILED:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
