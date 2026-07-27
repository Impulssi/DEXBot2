const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');
const { makeControllerStub, getActiveBotNames, stripAnsi, makeFakeChild, hasActiveAmaBot } = require('./helpers/unlock_test_helpers');

console.log('Running unlock control output tests');

const controllerPath = require.resolve('../modules/launcher/credential_daemon');
const supervisorControlPath = require.resolve('../modules/launcher/supervisor_control');
const originalControllerModule = require.cache[controllerPath];
const originalSupervisorControlModule = require.cache[supervisorControlPath];
const originalSpawn = childProcess.spawn;
const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

const monolithicPidPath = path.resolve(__dirname, '..', 'profiles', 'monolithic.pid');
const monolithicCredPidPath = path.resolve(__dirname, '..', 'profiles', 'monolithic-cred.pid');
const monolithicBotInfoPath = path.resolve(__dirname, '..', 'profiles', 'monolithic-bot.json');

const logs: any[] = [];
const errors: any[] = [];
const state = {
    controlCalls: [],
    staleMonolithicPid: false,
    supervisorDeleteTransient: false,
};

const controller = makeControllerStub();

function resetState() {
    process.exitCode = 0;
    logs.length = 0;
    errors.length = 0;
    state.controlCalls.length = 0;
    state.staleMonolithicPid = false;
    state.supervisorDeleteTransient = false;
}

function assertRuntimeServicesListed(command) {
    if (command === 'delete' || command === 'shutdown') {
        assert.ok(logs.includes('- credential daemon'), 'shutdown controls should list the credential daemon service');
    } else {
        assert.ok(!logs.includes('- credential daemon'), `${command} should not list the credential daemon service`);
    }
    if (hasActiveAmaBot()) {
        assert.ok(logs.includes('- market adapter'), 'whole-runtime control should list the market adapter service');
    }
}

function installStubs() {
    setCachedModule(controllerPath, {
        createCredentialDaemonController: () => controller,
    });

    setCachedModule(supervisorControlPath, {
        sendControlCommand: async (cmd) => {
            if (cmd.cmd === 'delete' && state.supervisorDeleteTransient) {
                throw new Error('No supervisor socket found. Start bots with: dexbot unlock --isolated');
            }
            state.controlCalls.push(cmd);
            return { ok: true };
        },
    });

    childProcess.spawn = (_command, _args, _options) => {
        return makeFakeChild();
    };

    fs.existsSync = (filePath) => {
        const normalized = String(filePath);
        if (normalized === monolithicPidPath) {
            return state.staleMonolithicPid;
        }
        if (normalized === monolithicCredPidPath) {
            return false;
        }
        return originalExistsSync(filePath);
    };

    fs.readFileSync = (filePath, options) => {
        if (String(filePath) === monolithicPidPath && state.staleMonolithicPid) {
            return '999999';
        }
        if (String(filePath) === monolithicBotInfoPath) {
            const err = new Error('ENOENT: no such file or directory');
            (err as any).code = 'ENOENT';
            throw err;
        }
        return originalReadFileSync(filePath, options);
    };

    console.log = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) logs.push(line);
    };
    console.error = (...args) => {
        const line = args.map((part) => String(part)).join(' ').trim();
        if (line) errors.push(line);
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    restoreCachedModule(controllerPath, originalControllerModule);
    restoreCachedModule(supervisorControlPath, originalSupervisorControlModule);
}

installStubs();

const unlock = require('../unlock');

async function runControl(args) {
    resetState();
    await unlock.main({ argv: ['node', 'unlock', ...args], startupGraceMs: 0 });
}

async function assertTargetControl(command, actionWord, botName) {
    await runControl([command, botName]);
    assert.deepStrictEqual(state.controlCalls[0], { cmd: command, bot: botName });
    assert.ok(logs.includes(`DEXBot2 ${actionWord} 1 bot`), `should print the ${actionWord} summary`);
    assert.ok(logs.some((line) => stripAnsi(line).includes(`- ${botName}`)), 'should list the affected bot');
}

async function assertWholeRuntimeControl(command, actionWord) {
    const activeBotNames = getActiveBotNames();
    await runControl([command]);
    assert.deepStrictEqual(state.controlCalls[0], { cmd: command === 'shutdown' ? 'delete' : command });
    assert.ok(logs.includes(`DEXBot2 ${actionWord} ${activeBotNames.length} bots`), `should print the ${actionWord} summary`);
    for (const botName of activeBotNames) {
        assert.ok(logs.some((line) => stripAnsi(line).includes(`- ${botName}`)), `should list active bot ${botName}`);
    }
    assertRuntimeServicesListed(command);
}

async function assertStaleControl(command, actionWord) {
    resetState();
    state.staleMonolithicPid = true;
    state.supervisorDeleteTransient = true;
    const activeBotNames = getActiveBotNames();
    await runControl([command]);

    assert.ok(logs.includes(`DEXBot2 ${actionWord} ${activeBotNames.length} bots`), 'stale control should print the shared summary');
    for (const botName of activeBotNames) {
        assert.ok(logs.some((line) => stripAnsi(line).includes(`- ${botName}`)), `stale control should list active bot ${botName}`);
    }
    assertRuntimeServicesListed(command);
    assert.ok(!logs.some((line) => line.includes('stale PID file')), 'stale control should not fall back to the legacy stale message');
}

(async () => {
    try {
        const activeBotNames = getActiveBotNames();
        assert.ok(activeBotNames.length > 0, 'test requires at least one active bot');

        await assertTargetControl('stop', 'stopping', activeBotNames[0]);
        await assertTargetControl('restart', 'restarting', activeBotNames[0]);
        await assertWholeRuntimeControl('stop-all', 'stopping');
        await assertWholeRuntimeControl('restart-all', 'restarting');
        await assertWholeRuntimeControl('delete', 'shutting down');
        await assertWholeRuntimeControl('shutdown', 'shutting down');
        await assertStaleControl('delete', 'shutting down');
        await assertStaleControl('shutdown', 'shutting down');

        restoreStubs();
        process.stdout.write('unlock control output tests passed\n');
        process.exit(0);
    } catch (err) {
        restoreStubs();
        console.error(err);
        process.exit(1);
    }
})();
