#!/bin/bash
# Shared directory resolution for DEXBot2 shell scripts.
#
# Mirrors modules/paths.ts (resolveProfilesDir / resolveMarketAdapterDirs /
# resolveClawDirs) so the shell side stays in lockstep with the TypeScript
# runtime. Update both together when path resolution changes.
#
# Callers must compute SCRIPT_DIR and PROJECT_ROOT before sourcing:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
#   source "$SCRIPT_DIR/lib/dexbot-paths.sh"
#
# Defines: PROFILE_ROOT, MA_DATA_DIR, MA_STATE_DIR, CLAW_DATA_DIR

# Profile root: DEXBOT_PROFILE_ROOT env wins; then legacy DEXBOT2_ROOT
# (<root>/profiles); a global npm package (project root under node_modules)
# defaults to the user's home; otherwise <root>/profiles. Mirrors the TS cwd
# fallback: when the default root has no bots.json but cwd/profiles does, use
# the cwd.
PROFILE_ROOT="$DEXBOT_PROFILE_ROOT"
if [ -z "$PROFILE_ROOT" ]; then
    if [ -n "$DEXBOT2_ROOT" ]; then
        PROFILE_ROOT="${DEXBOT2_ROOT}/profiles"
    else
        case "$PROJECT_ROOT" in
            *node_modules*) PROFILE_ROOT="${HOME:-${PROJECT_ROOT}}/.config/dexbot2/profiles" ;;
            *) PROFILE_ROOT="${PROJECT_ROOT}/profiles" ;;
        esac
        if [ ! -f "${PROFILE_ROOT}/bots.json" ] && [ -f "${PWD}/profiles/bots.json" ]; then
            PROFILE_ROOT="${PWD}/profiles"
        fi
    fi
fi

# Market adapter data/state: env vars win; a source checkout ships a top-level
# market_adapter/ dir so runtime state stays next to the code; npm packages
# relocate under the profiles dir.
if [ -n "$DEXBOT_MARKET_ADAPTER_DATA_DIR" ]; then
    MA_DATA_DIR="$DEXBOT_MARKET_ADAPTER_DATA_DIR"
elif [ -d "${PROJECT_ROOT}/market_adapter" ]; then
    MA_DATA_DIR="${PROJECT_ROOT}/market_adapter/data"
else
    MA_DATA_DIR="${PROFILE_ROOT}/market_adapter/data"
fi

if [ -n "$DEXBOT_MARKET_ADAPTER_STATE_DIR" ]; then
    MA_STATE_DIR="$DEXBOT_MARKET_ADAPTER_STATE_DIR"
elif [ -d "${PROJECT_ROOT}/market_adapter" ]; then
    MA_STATE_DIR="${PROJECT_ROOT}/market_adapter/state"
else
    MA_STATE_DIR="${PROFILE_ROOT}/market_adapter/state"
fi

# Claw data: claw/ ships in source checkouts AND npm packages, so key on the
# npm detection (not dir existence), like resolveClawDirs.
if [ -n "$DEXBOT_CLAW_DATA_DIR" ]; then
    CLAW_DATA_DIR="$DEXBOT_CLAW_DATA_DIR"
else
    case "$PROJECT_ROOT" in
        *node_modules*) CLAW_DATA_DIR="${PROFILE_ROOT}/claw/data" ;;
        *) CLAW_DATA_DIR="${PROJECT_ROOT}/claw/data" ;;
    esac
fi
