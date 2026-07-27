const assert = require('assert');
const childProcess = require('child_process');
const { setCachedModule } = require('./helpers/module_cache_stub');
const { makeControllerStub, makeFakeChild } = require('./helpers/unlock_test_helpers');

console.log('Running unlock isolated poll rejection tests');

const controllerPath = require.resolve('../modules/launcher/credential_daemon');
const supervisorPath = require.resolve('../modules/launcher/bot_supervisor');

const originalControllerModule = require.cache[controllerPath];
const originalSupervisorModule = require.cache[supervisorPath];
const originalSpawn = childProcess.spawn;
const originalIsolatedForeground = process.env.DEXBOT_ISOLATED_FOREGROUND;
const originalDisableSupervisorSocket = process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET;
const originalSupervisorSocket = process.env.DEXBOT_SUPERVISOR_SOCKET;

const controller = makeControllerStub();

function createThrowingGetStatusSupervisor() {
    let callCount = 0;
    return {
        start: async () => {},
        waitForStableStartup: async () => {},
        shutdown: async () => {},
        shutdownSignalHandler: () => {},
        getStatus: () => {
            callCount += 1;
            throw new Error('mock getStatus failure');
        },
        hasUserStopped: () => false,
        printStatusSummary: () => {},
        restartRunning: () => {},
        restartAll: () => {},
        stopAll: () => {},
    };
}

childProcess.spawn = (_command, _args, _options) => {
    return makeFakeChild({ withStdio: true });
};

setCachedModule(controllerPath, {
    createCredentialDaemonController: () => controller,
});

setCachedModule(supervisorPath, {
    createBotSupervisor: () => createThrowingGetStatusSupervisor(),
    SOCKET_PATH: '/tmp/dexbot-test-poll.sock',
});

process.env.DEXBOT_ISOLATED_FOREGROUND = '1';
process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET = '1';
process.env.DEXBOT_SUPERVISOR_SOCKET = '/tmp/dexbot-test-poll.sock';

const unlock = require('../unlock');

async function runPollExceptionRejectionTest() {
    const result = await Promise.race([
        unlock.main({
            argv: ['node', 'unlock', '--isolated'],
            startupGraceMs: 0,
        })
            .then(() => ({ settled: true, reason: 'resolved' }))
            .catch(() => ({ settled: true, reason: 'rejected' })),
        new Promise((resolve) => setTimeout(() => resolve({ settled: false, reason: 'timeout' }), 5000)),
    ]);

    assert.strictEqual(result.settled, true, 'main() should settle when getStatus() throws, not hang');
    assert.notStrictEqual(result.reason, 'timeout', 'main() must not time out (would indicate a hang)');
}

(async () => {
    try {
        await runPollExceptionRejectionTest();
        console.log('unlock isolated poll rejection tests passed');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    } finally {
        childProcess.spawn = originalSpawn;
        if (originalControllerModule) {
            require.cache[controllerPath] = originalControllerModule;
        } else {
            delete require.cache[controllerPath];
        }
        if (originalSupervisorModule) {
            require.cache[supervisorPath] = originalSupervisorModule;
        } else {
            delete require.cache[supervisorPath];
        }
        if (originalIsolatedForeground === undefined) {
            delete process.env.DEXBOT_ISOLATED_FOREGROUND;
        } else {
            process.env.DEXBOT_ISOLATED_FOREGROUND = originalIsolatedForeground;
        }
        if (originalDisableSupervisorSocket === undefined) {
            delete process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET;
        } else {
            process.env.DEXBOT_DISABLE_SUPERVISOR_SOCKET = originalDisableSupervisorSocket;
        }
        if (originalSupervisorSocket === undefined) {
            delete process.env.DEXBOT_SUPERVISOR_SOCKET;
        } else {
            process.env.DEXBOT_SUPERVISOR_SOCKET = originalSupervisorSocket;
        }
    }
})();
