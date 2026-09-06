'use strict';

// Offline unit tests for bot account-ID resolution + persistence:
//   - ensureBotAccountId pure branches (no chain touch: typed IDs, empty input,
//     cached IDs)
//   - persistBotAccountId against temp bots.json files (insert, update, no-op,
//     invalid input, byte preservation of comments/formatting)
// Chain-touching paths (fresh name resolution, --refresh-account) are NOT
// covered here — they need a live node (see npm run test:live).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureBotAccountId } = require('../modules/account_bots');
const { persistBotAccountId, loadBotSettings, findBotKeyByAccountRef, getStoredBotAccountId } = require('../analysis/bot_key_utils');

function writeTempBotsFile(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-accountid-'));
  const file = path.join(dir, 'bots.json');
  fs.writeFileSync(file, doc, 'utf8');
  return file;
}

function botEntry(name: any, preferredAccount: any, extra: any = {}) {
  return Object.assign({
    name,
    preferredAccount,
    assetA: 'AAA',
    assetB: 'BBB',
    active: true,
  }, extra || {});
}

// ─── ensureBotAccountId: pure branches (must never touch the chain) ───

async function testTypedIdStampsDirectly() {
  const data: any = { preferredAccount: '1.2.1001' };
  const res = await ensureBotAccountId(data, 1000, true);
  assert.strictEqual(res.id, '1.2.1001');
  assert.strictEqual(res.reason, 'id');
  assert.strictEqual(data.accountId, '1.2.1001', 'typed ID must be stamped onto the draft');
}

async function testEmptyInputIsInvalid() {
  for (const data of [{}, { preferredAccount: '' }, { preferredAccount: '   ' }, null]) {
    const res = await ensureBotAccountId(data, 1000, true);
    assert.strictEqual(res.id, null);
    assert.strictEqual(res.reason, 'invalid');
  }
}

async function testCachedIdReusedWithoutChain() {
  // A cached ID must return WITHOUT importing the chain stack: prove it by
  // asserting the call settles even though no network exists for it to use.
  // (Any chain attempt would hang past this timeout and fail the test.)
  const data = { preferredAccount: 'fixture-account', accountId: '1.2.1001' };
  const res = await Promise.race([
    ensureBotAccountId(data, 1000, true),
    new Promise((_, reject) => setTimeout(() => reject(new Error('chain hit on cached path')), 5000)),
  ]);
  assert.strictEqual(res.id, '1.2.1001');
  assert.strictEqual(res.reason, 'cached');
}

// ─── persistBotAccountId ───

function testPersistInsertsNextToPreferredAccount() {
  const file = writeTempBotsFile(JSON.stringify({
    bots: [botEntry('My Bot', 'fixture-account')],
  }, null, 2) + '\n');
  assert.strictEqual(persistBotAccountId('my-bot', '1.2.1001', file), true);
  const settings = loadBotSettings(file);
  assert.strictEqual(settings.bots[0].accountId, '1.2.1001');
}

function testPersistNoopWhenAlreadyStored() {
  const file = writeTempBotsFile(JSON.stringify({
    bots: [botEntry('My Bot', 'fixture-account', { accountId: '1.2.1001' })],
  }, null, 2) + '\n');
  const before = fs.readFileSync(file, 'utf8');
  assert.strictEqual(persistBotAccountId('my-bot', '1.2.1001', file), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'no-op must not touch the file');
}

function testPersistOverwritesStaleId() {
  const file = writeTempBotsFile(JSON.stringify({
    bots: [botEntry('My Bot', 'fixture-account', { accountId: '1.2.1999' })],
  }, null, 2) + '\n');
  assert.strictEqual(persistBotAccountId('my-bot', '1.2.1001', file), true);
  assert.strictEqual(loadBotSettings(file).bots[0].accountId, '1.2.1001');
}

function testPersistRejectsBadInput() {
  const file = writeTempBotsFile(JSON.stringify({
    bots: [botEntry('My Bot', 'fixture-account')],
  }, null, 2) + '\n');
  assert.strictEqual(persistBotAccountId('my-bot', 'fixture-account', file), false, 'names are not IDs');
  assert.strictEqual(persistBotAccountId('my-bot', '', file), false);
  assert.strictEqual(persistBotAccountId('no-such-bot', '1.2.777001', file), false);
  assert.strictEqual(persistBotAccountId(null, '1.2.777001', file), false);
  assert.strictEqual(loadBotSettings(file).bots[0].accountId, undefined);
}

function testPersistPreservesCommentsAndFormatting() {
  const raw = '{\n'
    + '  // operator notes stay untouched\n'
    + '  "bots": [\n'
    + '    {\n'
    + '      "name": "My Bot",\n'
    + '      "preferredAccount": "fixture-account", // primary account\n'
    + '      "active": true\n'
    + '    },\n'
    + '    {\n'
    + '      "name": "Other Bot",\n'
    + '      "preferredAccount": "fixture-account-2",\n'
    + '      "active": false\n'
    + '    }\n'
    + '  ]\n'
    + '}\n';
  const file = writeTempBotsFile(raw);
  assert.strictEqual(persistBotAccountId('my-bot', '1.2.1001', file), true);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('// operator notes stay untouched'), 'comments must survive');
  assert.ok(after.includes('"preferredAccount": "fixture-account",\n'), 'preferredAccount line must keep its comma');
  assert.ok(after.includes('"accountId": "1.2.1001", // primary account'), 'ID inserted, trailing comment preserved on its line');
  assert.ok(after.includes('"accountId": "1.2.1001"'), 'ID must be inserted');
  assert.ok(after.includes('"preferredAccount": "fixture-account-2"'), 'other entries must be untouched');
  // Only the accountId line may differ.
  const beforeLines = raw.split('\n');
  const afterLines = after.split('\n');
  assert.strictEqual(afterLines.length, beforeLines.length + 1, 'exactly one line added');
}

function testPersistTargetsCorrectEntryByIndex() {
  const file = writeTempBotsFile(JSON.stringify({
    bots: [
      botEntry('First Bot', 'fixture-account'),
      botEntry('Second Bot', 'fixture-account-2'),
      botEntry('Third Bot', 'fixture-account-3'),
    ],
  }, null, 2) + '\n');
  assert.strictEqual(persistBotAccountId('second-bot', '1.2.1002', file), true);
  const settings = loadBotSettings(file);
  assert.strictEqual(settings.bots[0].accountId, undefined);
  assert.strictEqual(settings.bots[1].accountId, '1.2.1002');
  assert.strictEqual(settings.bots[2].accountId, undefined);
}

function testPersistIgnoresKeyLookalikesInComments() {
  // A comment containing `"accountId": "..."` before the real key must not
  // be mistaken for it: the real key is patched in place and every comment
  // survives (no full-rewrite fallback).
  const raw = '{\n'
    + '  "bots": [\n'
    + '    {\n'
    + '      // "accountId": "1.2.9999" (old, do not use)\n'
    + '      /* "accountId": "1.2.8888" (older) */\n'
    + '      "name": "My Bot",\n'
    + '      "preferredAccount": "fixture-account",\n'
    + '      "accountId": "1.2.1999",\n'
    + '      "active": true\n'
    + '    }\n'
    + '  ]\n'
    + '}\n';
  const file = writeTempBotsFile(raw);
  assert.strictEqual(persistBotAccountId('my-bot', '1.2.1001', file), true);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.includes('// "accountId": "1.2.9999" (old, do not use)'), 'line comment decoy must survive untouched');
  assert.ok(after.includes('/* "accountId": "1.2.8888" (older) */'), 'block comment decoy must survive untouched');
  assert.ok(!after.includes('"accountId": "1.2.1999"'), 'real stale value must be replaced');
  assert.ok(after.includes('"accountId": "1.2.1001"'), 'real key must carry the new ID');
  assert.strictEqual(after.split('\n').length, raw.split('\n').length, 'replace path must not add or remove lines');
  assert.strictEqual(loadBotSettings(file).bots[0].accountId, '1.2.1001');
}

function testPersistInsertSkipsPreferredAccountLookalikeInComment() {
  // Insert path: a `"preferredAccount": "..."` lookalike inside a comment
  // must not attract the new `"accountId"` line.
  const raw = '{\n'
    + '  "bots": [\n'
    + '    {\n'
    + '      "name": "My Bot",\n'
    + '      // "preferredAccount": "decoy-account"\n'
    + '      "preferredAccount": "fixture-account",\n'
    + '      "active": true\n'
    + '    }\n'
    + '  ]\n'
    + '}\n';
  const file = writeTempBotsFile(raw);
  assert.strictEqual(persistBotAccountId('my-bot', '1.2.1001', file), true);
  const after = fs.readFileSync(file, 'utf8');
  assert.strictEqual((after.match(/"accountId"/g) || []).length, 1, 'exactly one accountId key may exist');
  const prefIdx = after.indexOf('"preferredAccount": "fixture-account"');
  const idIdx = after.indexOf('"accountId": "1.2.1001"');
  assert.ok(idIdx > prefIdx, 'accountId must be inserted after the real preferredAccount');
  assert.strictEqual(loadBotSettings(file).bots[0].accountId, '1.2.1001');
}

// ─── findBotKeyByAccountRef / getStoredBotAccountId ───

function fixtureBotsFile() {
  return writeTempBotsFile(JSON.stringify({
    bots: [
      botEntry('First Bot', 'fixture-account', { accountId: '1.2.1001' }),
      botEntry('Second Bot', 'fixture-account-2'),
    ],
  }, null, 2) + '\n');
}

function testFindBotKeyByAccountRef() {
  const file = fixtureBotsFile();
  const hit = findBotKeyByAccountRef('fixture-account', file);
  assert.ok(hit, 'must match by preferredAccount');
  assert.strictEqual(hit.meta.name, 'First Bot');
  assert.strictEqual(findBotKeyByAccountRef('FIXTURE-ACCOUNT', file).meta.name, 'First Bot', 'match must be case-insensitive');
  assert.strictEqual(findBotKeyByAccountRef('1.2.1001', file), null, 'IDs are not names');
  assert.strictEqual(findBotKeyByAccountRef('unknown-account', file), null);
  assert.strictEqual(findBotKeyByAccountRef('', file), null);
}

function testGetStoredBotAccountId() {
  const file = fixtureBotsFile();
  const hit = findBotKeyByAccountRef('fixture-account', file);
  assert.strictEqual(getStoredBotAccountId(hit.botKey, 'fixture-account', file), '1.2.1001');
  assert.strictEqual(
    getStoredBotAccountId(hit.botKey, 'renamed-account', file),
    null,
    'a rename must never reuse the stale ID',
  );
  const unstamped = findBotKeyByAccountRef('fixture-account-2', file);
  assert.strictEqual(getStoredBotAccountId(unstamped.botKey, 'fixture-account-2', file), null);
  assert.strictEqual(getStoredBotAccountId('no-such-bot', null, file), null);
  assert.strictEqual(getStoredBotAccountId(null, null, file), null);
}

async function main() {
  await testTypedIdStampsDirectly();
  await testEmptyInputIsInvalid();
  await testCachedIdReusedWithoutChain();
  testPersistInsertsNextToPreferredAccount();
  testPersistNoopWhenAlreadyStored();
  testPersistOverwritesStaleId();
  testPersistRejectsBadInput();
  testPersistPreservesCommentsAndFormatting();
  testPersistTargetsCorrectEntryByIndex();
  testPersistIgnoresKeyLookalikesInComments();
  testPersistInsertSkipsPreferredAccountLookalikeInComment();
  testFindBotKeyByAccountRef();
  testGetStoredBotAccountId();
  console.log('bot account id tests passed');
}

main().catch((err) => {
  console.error('bot account id tests FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
