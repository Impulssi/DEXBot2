process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';
const assert = require('assert');

console.log('Running dexbot start alias (unlock delegation) tests');

// `dexbot start` aliases the persistent unlock launcher. Since commit 42724793
// the CLI must delegate to the unlock entry point (built or source layout) and
// forward its exit status instead of running the one-shot in-process bot flow.
// This test guards that delegation contract: a regression here previously made
// `dexbot start` silently no-op (ENOENT spawn -> exit 0) and would spawn the
// real `dist/unlock.js` from the other CLI tests, blocking the suite on live
// password prompts.

const dexbotPath = require.resolve('../dexbot.js');
const childProcess = require('child_process');

const originalArgv = process.argv.slice();
const originalExit = process.exit;
const originalSpawnSync = childProcess.spawnSync;

const spawnCalls: any[] = [];
let exitCode: any = 'not-exited';

function installHooks() {
    process.argv = ['node', dexbotPath, 'start'];
    (process as any).exit = ((code: any) => {
        exitCode = code;
    });
    childProcess.spawnSync = ((...args: any[]) => {
        spawnCalls.push(args);
        return { status: 7, error: null };
    });
}

function restoreHooks() {
    process.argv = originalArgv;
    process.exit = originalExit;
    childProcess.spawnSync = originalSpawnSync;
}

function parseUnlockEntry(args: any[]): string | null {
    const flat: string[] = [];
    for (const arg of args) {
        if (Array.isArray(arg)) {
            for (const inner of arg) if (typeof inner === 'string') flat.push(inner);
        } else if (typeof arg === 'string') {
            flat.push(arg);
        }
    }
    for (const arg of flat) {
        if (arg === '--import') continue;
        if (arg.endsWith('unlock.ts') || arg.endsWith('unlock.js')) return arg;
    }
    return null;
}

installHooks();
require('../dexbot');

(async () => {
    try {
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(spawnCalls.length, 1, 'dexbot start should spawn the unlock runtime once');
        const spawnArgs = spawnCalls[0] || [];
        assert.strictEqual(spawnArgs[0], process.execPath, 'dexbot start should spawn with the current Node executable');
        const unlockEntry = parseUnlockEntry(spawnArgs);
        assert.ok(
            unlockEntry && /unlock\.(ts|js)$/.test(unlockEntry),
            `dexbot start should spawn an unlock entry point; got argv=${JSON.stringify(spawnArgs)}`
        );
        assert.strictEqual(exitCode, 7, 'dexbot start should forward the unlock exit status (no silent exit 0 on spawn failure)');

        restoreHooks();
        process.exit(0);
    } catch (err) {
        restoreHooks();
        console.error(err);
        process.exit(1);
    }
})();