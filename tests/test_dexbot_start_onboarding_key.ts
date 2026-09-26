process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');

async function runKeyOnboarding() {
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-start-key-onboarding-'));
    process.env.DEXBOT_PROFILE_ROOT = profileRoot;
    process.env.DEXBOT_KEYS_FILE = path.join(profileRoot, 'keys.json');
    process.env.DEXBOT_MARKET_ADAPTER_DATA_DIR = path.join(profileRoot, 'market_adapter');
    process.env.DEXBOT_CLAW_DATA_DIR = path.join(profileRoot, 'claw', 'data');

    let keyManagerCalls = 0;
    let exitCalls = 0;
    const originalExit = process.exit;
    (process as any).exit = ((code: any) => {
        exitCalls += 1;
        assert.strictEqual(code, 0);
    });
    defineEsmMockAbs(require.resolve('../modules/chain_keys'), [
        'checkKeysFileSecurity', 'hasKeySetup', 'main',
    ], {
        checkKeysFileSecurity: () => {},
        hasKeySetup: () => false,
        main: async () => { keyManagerCalls += 1; },
    });

    try {
        const unlock = require('../unlock');
        await unlock.main({ argv: ['node', 'unlock'], exitAfterOnboarding: true, onboard: true });
        assert.strictEqual(keyManagerCalls, 1, 'unlock start should forward an unconfigured key setup to dexbot key');
        assert.strictEqual(exitCalls, 1, 'the launcher should exit after key setup closes');
        await assert.rejects(
            () => unlock.main({ argv: ['node', 'unlock', '--headless'], onboard: true }),
            /Incomplete setup for --headless/,
            'headless start must fail instead of opening an interactive key editor'
        );
        await assert.rejects(
            () => unlock.main({ argv: ['node', 'unlock', '--dryrun'], onboard: true }),
            /Incomplete setup for --dryrun/,
            'a dry run must fail instead of opening an interactive key editor'
        );
    } finally {
        (process as any).exit = originalExit;
        fs.rmSync(profileRoot, { recursive: true, force: true });
    }
}

runEsmMockStages(['key_onboarding'], runKeyOnboarding);
