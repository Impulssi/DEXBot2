#!/bin/bash
# create-bot-symlinks.sh - Create ecosystem config symlinks for each bot
#
# This allows: pm2 start bot-name (or: pm2 start bot-name.config.js)
#
# Usage: ./scripts/create-bot-symlinks.sh

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROFILE_ROOT="${DEXBOT_PROFILE_ROOT:-${REPO_ROOT}/profiles}"
BOTS_CONFIG="${PROFILE_ROOT}/bots.json"
ECOSYSTEM_CONFIG="${PROFILE_ROOT}/ecosystem.config.cjs"
PROFILES_DIR="${PROFILE_ROOT}"

if [ ! -f "$BOTS_CONFIG" ]; then
    echo "Error: $BOTS_CONFIG not found"
    exit 1
fi

if [ ! -f "$ECOSYSTEM_CONFIG" ]; then
    echo "Error: $ECOSYSTEM_CONFIG not found"
    exit 1
fi

echo "Creating PM2 bot symlinks in profiles directory..."

# Parse bots.json and create symlinks
node -e "
const fs = require('fs');
const path = require('path');
const botsConfig = JSON.parse(fs.readFileSync('$BOTS_CONFIG', 'utf8'));
const profilesDir = '$PROFILES_DIR';
const ecoConfig = '$ECOSYSTEM_CONFIG';

(botsConfig.bots || []).forEach(bot => {
    const botName = bot.name;
    const symlink = path.join(profilesDir, botName + '.config.js');

    // Remove old symlink if exists
    if (fs.existsSync(symlink)) {
        fs.unlinkSync(symlink);
    }

    // Create symlink
    try {
        fs.symlinkSync(ecoConfig, symlink);
        console.log('✓ Created symlink: profiles/' + botName + '.config.cjs -> ecosystem.config.cjs');
    } catch (err) {
        console.error('✗ Error creating symlink for ' + botName + ':', err.message);
    }
});
"
