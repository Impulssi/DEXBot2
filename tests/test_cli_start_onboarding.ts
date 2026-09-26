'use strict';

const assert = require('assert');
const { selectStartOnboardingCommand } = require('../modules/cli_start_onboarding');

assert.strictEqual(
    selectStartOnboardingCommand(false, 0),
    'key',
    'start should enter key setup first when no password-protected vault exists'
);
assert.strictEqual(
    selectStartOnboardingCommand(false, 3),
    'key',
    'key setup should take precedence even when bot definitions exist'
);
assert.strictEqual(
    selectStartOnboardingCommand(true, 0),
    'bot',
    'start should enter bot setup when keys exist but no bots are configured'
);
assert.strictEqual(
    selectStartOnboardingCommand(true, 1),
    null,
    'start should use the normal launcher when setup is complete'
);

console.log('CLI start onboarding routing tests passed');
