#!/bin/bash
# Reset DEXBot2 settings files and restore built-in defaults.
#
# Removes the three settings files used by the bot runtime and market adapter:
# - profiles/general.settings.json
# - profiles/market_profiles.json
# - profiles/market_adapter_settings.json
#
# On the next run, the application will recreate or fall back to defaults.
#
# Usage: ./scripts/reset-settings.sh or bash scripts/reset-settings.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PROFILE_ROOT="${DEXBOT_PROFILE_ROOT:-${PROJECT_ROOT}/profiles}"
GENERAL_SETTINGS_FILE="${PROFILE_ROOT}/general.settings.json"
MARKET_PROFILES_FILE="${PROFILE_ROOT}/market_profiles.json"
MARKET_ADAPTER_SETTINGS_FILE="${PROFILE_ROOT}/market_adapter_settings.json"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_info "=========================================="
log_info "DEXBot2 Reset Settings Script"
log_info "=========================================="
log_info "General settings:         $GENERAL_SETTINGS_FILE"
log_info "Market profiles:          $MARKET_PROFILES_FILE"
log_info "Market adapter settings:  $MARKET_ADAPTER_SETTINGS_FILE"
log_info ""
log_warning "WARNING: This will delete all three settings files."
log_warning "The app will fall back to built-in defaults on next run."
log_info ""

FILES=(
    "$GENERAL_SETTINGS_FILE"
    "$MARKET_PROFILES_FILE"
    "$MARKET_ADAPTER_SETTINGS_FILE"
)

FOUND_FILES=()
for file in "${FILES[@]}"; do
    if [ -f "$file" ]; then
        FOUND_FILES+=("$file")
    fi
done

if [ "${#FOUND_FILES[@]}" -eq 0 ]; then
    log_info "No settings files found to delete."
    exit 0
fi

log_info "Found ${#FOUND_FILES[@]} file(s) to delete"
log_info ""
log_info "Files to be deleted:"
for file in "${FOUND_FILES[@]}"; do
    SIZE=$(du -h "$file" | cut -f1)
    echo -e "${BLUE}  -${NC} $(realpath --relative-to="$PROJECT_ROOT" "$file") ($SIZE)"
done
log_info ""

# Ask for confirmation
read -p "Delete the listed settings files? (y/n): " -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    log_warning "Cancelled"
    exit 0
fi

for file in "${FOUND_FILES[@]}"; do
    rm -f "$file"
done

REMAINING=0
for file in "${FILES[@]}"; do
    if [ -f "$file" ]; then
        REMAINING=$((REMAINING + 1))
    fi
done

log_info "=========================================="
if [ "$REMAINING" -eq 0 ]; then
    log_success "All settings files cleared!"
    log_info "Total deleted: ${#FOUND_FILES[@]}"
    log_info ""
    log_info "Next steps:"
    log_info "- Re-run \`node dexbot bots\` to recreate general settings if needed"
    log_info "- Re-run \`npm run market-adapter:whitelist\` if your AMA bot set changed"
    log_info "- Re-fit market profiles only if you want custom AMA presets again"
else
    log_warning "Cleanup incomplete. Remaining settings files: $REMAINING"
fi
log_info "=========================================="

exit 0
