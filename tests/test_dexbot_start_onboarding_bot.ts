process.env.DEXBOT_SKIP_PROFILE_VALIDATION = '1';
// Lower the scrypt cost BEFORE chain_keys loads (Config snapshots env).
process.env.DEXBOT_VAULT_SCRYPT_N = '4096';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runEsmMockStages, defineEsmMockAbs } = require('./helpers/esm_mocks');

async function runBotOnboarding() {
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexbot-start-bot-onboarding-'));
    process.env.DEXBOT_PROFILE_ROOT = profileRoot;
    process.env.DEXBOT_KEYS_FILE = path.join(profileRoot, 'keys.json');
    process.env.DEXBOT_MARKET_ADAPTER_DATA_DIR = path.join(profileRoot, 'market_adapter');
    process.env.DEXBOT_CLAW_DATA_DIR = path.join(profileRoot, 'claw', 'data');
    fs.writeFileSync(path.join(profileRoot, 'bots.json'), JSON.stringify({ bots: [] }));

    // A real account entry is required before start may advance to bot setup.
    const { writeModernVault } = require('./helpers/vault_fixture');
    writeModernVault(process.env.DEXBOT_KEYS_FILE, 'onboarding-fixture-password', {
        'onboarding-account': 'a'.repeat(64),
    });

    let botEditorCalls = 0;
    defineEsmMockAbs(require.resolve('../modules/account_bots'), ['main'], {
        main: async () => { botEditorCalls += 1; },
    });

    try {
        const unlock = require('../unlock');
        await unlock.main({ argv: ['node', 'unlock'], onboard: true });
        assert.strictEqual(botEditorCalls, 1, 'unlock start should forward a valid key with no bots to dexbot bot');
    } finally {
        fs.rmSync(profileRoot, { recursive: true, force: true });
    }
}

runEsmMockStages(['bot_onboarding'], runBotOnboarding);
