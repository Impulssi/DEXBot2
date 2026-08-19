#!/bin/bash
# create-bot-symlinks.sh - Create ecosystem config symlinks for each bot
#
# This allows: pm2 start bot-name (or: pm2 start bot-name.config.cjs)
#
# Usage: ./scripts/create-bot-symlinks.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/lib/dexbot-paths.sh"
REPO_ROOT="$PROJECT_ROOT"
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
    const symlink = path.join(profilesDir, botName + '.config.cjs');

    // Remove old symlink if exists
    if (fs.existsSync(symlink)) {
        fs.unlinkSync(symlink);
    }

    // Create symlink
    try {
        fs.symlinkSync(ecoConfig, symlink);
        console.log('✓ Created symlink: profiles/' + botName + '.config.cjs -> ' + path.basename(ecoConfig));
    } catch (err) {
        console.error('✗ Error creating symlink for ' + botName + ':', err.message);
    }
});
"
