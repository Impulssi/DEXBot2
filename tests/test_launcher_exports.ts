const assert = require('assert');
const path = require('path');
const { BUILD_DIR } = require('../modules/constants');
const { Config } = require('../modules/config');

console.log('Running launcher export tests');

const unlock = require('../unlock');
const {
    parsePm2Args,
    parseUnlockArgs,
} = require('../modules/launcher/launch_modes');
const {
    buildRuntimeScriptArgs,
    buildRuntimeScriptPath,
} = require('../modules/launcher/runtime_entry');

assert.strictEqual(typeof unlock.main, 'function', 'unlock should export main');
assert.strictEqual(typeof unlock.buildDexbotStartArgs, 'function', 'unlock should export buildDexbotStartArgs');
const UNLOCK_BASE = { headless: false, passwordFile: null, creditOnly: false };

assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--claw-only']),
    { botName: null, clawOnly: true, isolated: false, dryrun: false, ...UNLOCK_BASE },
    'unlock parser should recognize claw-only mode'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', 'AAA-BBB']),
    { botName: 'AAA-BBB', clawOnly: false, isolated: false, dryrun: false, ...UNLOCK_BASE },
    'unlock parser should capture bot names'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--isolated']),
    { botName: null, clawOnly: false, isolated: true, dryrun: false, ...UNLOCK_BASE },
    'unlock parser should recognize isolated flag'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--isolated', 'AAA-BBB']),
    { botName: 'AAA-BBB', clawOnly: false, isolated: true, dryrun: false, ...UNLOCK_BASE },
    'unlock parser should combine isolated flag with bot name'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--dryrun']),
    { botName: null, clawOnly: false, isolated: false, dryrun: true, ...UNLOCK_BASE },
    'unlock parser should recognize dryrun flag'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--dryrun', 'AAA-BBB']),
    { botName: 'AAA-BBB', clawOnly: false, isolated: false, dryrun: true, ...UNLOCK_BASE },
    'unlock parser should combine dryrun flag with bot name'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--dryrun', '--isolated']),
    { botName: null, clawOnly: false, isolated: true, dryrun: true, ...UNLOCK_BASE },
    'unlock parser should combine dryrun and isolated flags'
);
const originalBotName = process.env.BOT_NAME;
const originalConfigBotName = Config.BOT_NAME;
process.env.BOT_NAME = 'ENV-BOT';
Config.BOT_NAME = 'ENV-BOT';
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock']),
    { botName: 'ENV-BOT', clawOnly: false, isolated: false, dryrun: false, ...UNLOCK_BASE },
    'unlock parser should use BOT_NAME when no bot argument is passed'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--claw-only']),
    { botName: null, clawOnly: true, isolated: false, dryrun: false, ...UNLOCK_BASE },
    'unlock parser should ignore BOT_NAME in claw-only mode'
);
if (originalBotName === undefined) {
    delete process.env.BOT_NAME;
} else {
    process.env.BOT_NAME = originalBotName;
}
Config.BOT_NAME = originalConfigBotName;
// Headless mode tests
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--headless']),
    { botName: null, clawOnly: false, isolated: false, dryrun: false, headless: true, passwordFile: null, creditOnly: false },
    'unlock parser should recognize headless flag'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--headless', '--password-file', '/run/secrets/pw']),
    { botName: null, clawOnly: false, isolated: false, dryrun: false, headless: true, passwordFile: '/run/secrets/pw', creditOnly: false },
    'unlock parser should recognize headless with password-file'
);
assert.deepStrictEqual(
    parseUnlockArgs(['node', 'unlock', '--headless', '--password-file=/run/secrets/pw']),
    { botName: null, clawOnly: false, isolated: false, dryrun: false, headless: true, passwordFile: '/run/secrets/pw', creditOnly: false },
    'unlock parser should accept --password-file=value syntax'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', '--headless']),
    { command: null, target: null, clawOnly: false, headless: true, passwordFile: null },
    'pm2 parser should recognize headless flag'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', '--headless', 'AAA-BBB']),
    { command: null, target: 'AAA-BBB', clawOnly: false, headless: true, passwordFile: null },
    'pm2 parser should combine headless with bot name'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', '--password-file', '/run/secrets/pw']),
    { command: null, target: null, clawOnly: false, headless: false, passwordFile: '/run/secrets/pw' },
    'pm2 parser should recognize password-file without headless'
);

const PM2_BASE = { headless: false, passwordFile: null };

assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'claw-only']),
    { command: 'claw-only', target: null, clawOnly: true, ...PM2_BASE },
    'pm2 parser should accept claw-only as a direct command'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', '--claw-only']),
    { command: 'claw-only', target: null, clawOnly: true, ...PM2_BASE },
    'pm2 parser should accept claw-only as a flag'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'AAA-BBB']),
    { command: null, target: 'AAA-BBB', clawOnly: false, ...PM2_BASE },
    'pm2 parser should treat a bare bot name as the default PM2 target'
);
assert.deepStrictEqual(
    parsePm2Args(['node', 'pm2.js', 'restart', 'all']),
    { command: 'restart', target: 'all', clawOnly: false, ...PM2_BASE },
    'pm2 parser should accept restart commands'
);
const expectedDexbotPath = path.join(__dirname, '..', 'dexbot.js');
assert.deepStrictEqual(
    unlock.buildDexbotStartArgs('AAA-BBB'),
    [expectedDexbotPath, 'test', 'AAA-BBB'],
    'launcher should append the requested bot name'
);
assert.deepStrictEqual(
    unlock.buildDexbotStartArgs(null),
    [expectedDexbotPath, 'test'],
    'launcher should omit the bot arg when starting all bots'
);
assert.deepStrictEqual(
    unlock.buildDexbotStartArgs('AAA-BBB', true),
    [expectedDexbotPath, 'drystart', 'AAA-BBB'],
    'launcher should pass drystart when dryrun is true'
);
assert.deepStrictEqual(
    unlock.buildDexbotStartArgs(null, true),
    [expectedDexbotPath, 'drystart'],
    'launcher should pass drystart with no bot name'
);
assert.strictEqual(
    buildRuntimeScriptPath(path.join(__dirname, '..'), ['dexbot']),
    expectedDexbotPath,
    'runtime helper should resolve entrypoints under the runtime root'
);
assert.deepStrictEqual(
    buildRuntimeScriptArgs({
        codeRoot: path.join(__dirname, '..', BUILD_DIR),
        scriptSegments: ['dexbot'],
        scriptArgs: ['start'],
    }),
    [path.join(__dirname, '..', BUILD_DIR, 'dexbot.js'), 'start'],
    'runtime helper should resolve dist entrypoints to plain node args'
);

for (const entry of [
    { args: ['node', 'unlock', 'status'], expected: { cmd: 'status', target: null } },
    { args: ['node', 'unlock', 'stop', 'AAA-BBB'], expected: { cmd: 'stop', target: 'AAA-BBB' } },
    { args: ['node', 'unlock', 'restart', 'AAA-BBB'], expected: { cmd: 'restart', target: 'AAA-BBB' } },
    { args: ['node', 'unlock', 'stop'], expected: { cmd: 'stop-all', target: null } },
    { args: ['node', 'unlock', 'restart'], expected: { cmd: 'restart-all', target: null } },
    { args: ['node', 'unlock', 'stop', 'all'], expected: { cmd: 'stop-all', target: null } },
    { args: ['node', 'unlock', 'restart', 'all'], expected: { cmd: 'restart-all', target: null } },
    { args: ['node', 'unlock', 'stop-all'], expected: { cmd: 'stop-all', target: null } },
    { args: ['node', 'unlock', 'restart-all'], expected: { cmd: 'restart-all', target: null } },
    { args: ['node', 'unlock', 'delete'], expected: { cmd: 'delete', target: null } },
    { args: ['node', 'unlock', 'shutdown'], expected: { cmd: 'shutdown', target: null } },
]) {
    const label = `unlock parser should handle ${entry.args.slice(2).join(' ')}`;
    const result = parseUnlockArgs(entry.args);
    const expected = { botName: null, clawOnly: false, isolated: false, dryrun: false, headless: false, passwordFile: null, creditOnly: false, control: entry.expected };
    assert.deepStrictEqual(result, expected, label);
}

console.log('launcher export tests passed');
process.exit(0);
