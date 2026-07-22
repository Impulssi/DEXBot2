const assert = require('assert');
const Module = require('module');

const constantsModulePath = require.resolve('../modules/constants');
const originalModuleLoad = Module._load;

function loadConstantsWithSettings(mockSettings) {
    delete require.cache[constantsModulePath];

    Module._load = function(request, parent, isMain) {
        if (request === './general_settings' && parent?.filename === constantsModulePath) {
            return {
                readGeneralSettings: () => mockSettings
            };
        }
        return originalModuleLoad.call(this, request, parent, isMain);
    };

    try {
        return require('../modules/constants');
    } finally {
        Module._load = originalModuleLoad;
        delete require.cache[constantsModulePath];
    }
}

function testTopLevelSecondsSetting() {
    const constants = loadConstantsWithSettings({
        GRID_LIMITS: {
            DUST_CANCEL_DELAY_SEC: 300
        }
    });

    assert.strictEqual(
        constants.GRID_LIMITS.DUST_CANCEL_DELAY_SEC,
        300,
        'Top-level DUST_CANCEL_DELAY_SEC should pass through'
    );
}

function testExpertSecondsSetting() {
    const constants = loadConstantsWithSettings({
        EXPERT: {
            GRID_LIMITS: {
                DUST_CANCEL_DELAY_SEC: 420
            }
        }
    });

    assert.strictEqual(
        constants.GRID_LIMITS.DUST_CANCEL_DELAY_SEC,
        420,
        'Expert DUST_CANCEL_DELAY_SEC should pass through'
    );
}

function testExplicitSecondsOverride() {
    const constants = loadConstantsWithSettings({
        EXPERT: {
            GRID_LIMITS: {
                DUST_CANCEL_DELAY_SEC: 45
            }
        }
    });

    assert.strictEqual(
        constants.GRID_LIMITS.DUST_CANCEL_DELAY_SEC,
        45,
        'Explicit DUST_CANCEL_DELAY_SEC should pass through'
    );
}

function testLegacyMinuteIgnored() {
    const constants = loadConstantsWithSettings({
        GRID_LIMITS: {
            DUST_CANCEL_DELAY_MIN: 5
        }
    });

    // Legacy DUST_CANCEL_DELAY_MIN is no longer migrated;
    // DUST_CANCEL_DELAY_SEC should remain at its default (-1 = immediate cancel)
    assert.strictEqual(
        constants.GRID_LIMITS.DUST_CANCEL_DELAY_SEC,
        -1,
        'Legacy DUST_CANCEL_DELAY_MIN should be ignored; default DUST_CANCEL_DELAY_SEC should remain at -1'
    );
}

try {
    testTopLevelSecondsSetting();
    testExpertSecondsSetting();
    testExplicitSecondsOverride();
    testLegacyMinuteIgnored();
    console.log('Dust cancel delay config migration tests passed');
} catch (err) {
    console.error('Dust cancel delay config migration tests failed');
    console.error(err);
    process.exit(1);
}
