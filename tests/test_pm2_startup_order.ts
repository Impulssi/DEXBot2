const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { restoreCachedModule, setCachedModule } = require('./helpers/module_cache_stub');

console.log('Running PM2 startup order tests');

const pm2Path = require.resolve('../pm2');
const chainKeysPath = require.resolve('../modules/chain_keys');

const originalPm2Module = require.cache[pm2Path];
const originalChainKeys = require.cache[chainKeysPath];
const originalSpawn = childProcess.spawn;
const originalConsoleError = console.error;
const originalTestSecret = process.env.TEST_PM2_SECRET;

const events: any[] = [];
const spawnCalls: any[] = [];
const consoleErrors: any[] = [];
const originalWriteFileSync = fs.writeFileSync;

function installStubs() {
    delete require.cache[pm2Path];
    setCachedModule(chainKeysPath, {
        waitForDaemon: async () => {
            events.push('wait-ready-start');
            await new Promise((resolve) => setTimeout(resolve, 20));
            events.push('wait-ready-done');
        },
    });

    fs.writeFileSync = (filePath, data, options) => {
        if (String(filePath).includes('.dexbot-cred-bootstrap-path')) {
            events.push('write-bootstrap-path');
            return;
        }
        return originalWriteFileSync(filePath, data, options);
    };

    childProcess.spawn = (command, args, options) => {
        spawnCalls.push({ command, args, options });
        if (args[0] === 'start' && String(args[1]).includes('credential-daemon.js')) {
            events.push('spawn-cred');
        } else if (args[0] === 'start') {
            events.push('spawn-apps');
        } else if (args[0] === 'delete') {
            events.push('delete-cred');
        }

        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => {
            child.killed = true;
        };
        process.nextTick(() => {
            if (args[0] === 'delete') {
                child.stderr.emit('data', 'Process or Namespace dexbot-cred not found');
                child.emit('close', 1);
                return;
            }
            child.emit('close', 0);
        });
        return child;
    };
}

function restoreStubs() {
    childProcess.spawn = originalSpawn;
    fs.writeFileSync = originalWriteFileSync;
    console.error = originalConsoleError;
    if (originalTestSecret === undefined) delete process.env.TEST_PM2_SECRET;
    else process.env.TEST_PM2_SECRET = originalTestSecret;

    restoreCachedModule(chainKeysPath, originalChainKeys);

    if (originalPm2Module) require.cache[pm2Path] = originalPm2Module;
    else delete require.cache[pm2Path];
}

installStubs();
console.error = (...args) => {
    consoleErrors.push(args.join(' '));
};
process.env.TEST_PM2_SECRET = 'should-not-leak';

const { startManagedRuntimePM2 } = require('../pm2');

(async () => {
    try {
        const bootstrapSocketPath = '/tmp/test-bootstrap.sock';
        const bootstrap = {
            socketPath: bootstrapSocketPath,
            waitForTransfer: async () => {
                events.push('wait-transfer-start');
                await new Promise((resolve) => setTimeout(resolve, 10));
                events.push('wait-transfer-done');
            },
        };

        await startManagedRuntimePM2({
            apps: [{ name: 'XRP-BTS' }],
            bootstrap,
        });

        const appStartIndex = events.indexOf('spawn-apps');
        const credSpawn = spawnCalls.find((call) => call.args[0] === 'start' && String(call.args[1]).includes('credential-daemon.js'));
        const appSpawn = spawnCalls.find((call) => call.args[0] === 'start' && String(call.args[1]).includes('ecosystem.config.cjs'));
        assert.ok(appStartIndex !== -1, 'managed apps should be started');
        assert.ok(appStartIndex > events.indexOf('wait-transfer-done'), 'apps should start after password transfer completes');
        assert.ok(appStartIndex > events.indexOf('wait-ready-done'), 'apps should start after daemon readiness completes');
        assert.strictEqual(credSpawn.options.env.TEST_PM2_SECRET, undefined, 'credential daemon PM2 launch should not inherit arbitrary parent secrets');
        assert.strictEqual(credSpawn.options.env.DEXBOT_CRED_BOOTSTRAP_SOCKET, undefined, 'credential daemon PM2 launch should not receive bootstrap socket env');
        assert.strictEqual(appSpawn.options.env.TEST_PM2_SECRET, undefined, 'ecosystem PM2 launch should not inherit arbitrary parent secrets');
        assert.strictEqual(appSpawn.options.env.DEXBOT_CRED_BOOTSTRAP_SOCKET, undefined, 'ecosystem PM2 launch should not receive bootstrap env');
        assert.ok(
            !consoleErrors.some((line) => line.includes('Process or Namespace dexbot-cred not found')),
            'missing dexbot-cred should be ignored without logging a PM2 error'
        );

        console.log('PM2 startup order tests passed');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    } finally {
        restoreStubs();
    }
})();
