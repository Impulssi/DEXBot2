// Root-level forwarder for `pm2 start` run directly in the repo root.
//
// DEXBot2 must be launched through its own launcher (`dexbot pm2`, `./pm2`, or
// `npm run pm2:unlock`) so the keystore is unlocked and the credential daemon
// is started first. A raw `pm2 start` here would start bot apps that cannot
// reach the credential daemon, so this file always rejects it with guidance
// instead of silently launching a broken runtime.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const target = path.join(__dirname, 'profiles', 'ecosystem.config.cjs');
const exists = fs.existsSync(target);

const lines = [
    '',
    'DEXBot2 is not started with raw `pm2 start`.',
    'The PM2 launcher must unlock your keystore and start the credential daemon first.',
    '',
    'Please start DEXBot2 with one of:',
    '  dexbot pm2            (preferred)',
    '  ./pm2                 (repo root)',
    '  npm run pm2:unlock    (legacy alias)',
];
if (!exists) {
    lines.push('', 'No profiles/ecosystem.config.cjs generated yet; the launcher creates it on first run.');
}
lines.push('');

console.error(lines.join('\n'));
process.exit(1);