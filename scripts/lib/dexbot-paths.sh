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

# Well-known files that mark a profiles dir as populated (any one suffices) —
# mirrors PROFILE_STATE_MARKERS in modules/paths.ts. Not just bots.json, so a
# claw-only / keys-only user is not treated as "fresh" and silently switched to
# a different profiles dir.
has_profile_state() {
    for f in bots.json keys.json general.settings.json market_profiles.json \
        market_adapter_settings.json daemon-policies.json fund_registry.json \
        launcher.config.json; do
        if [ -f "$1/$f" ]; then return 0; fi
    done
    return 1
}

# Profile root: DEXBOT_PROFILE_ROOT env wins; then legacy DEXBOT2_ROOT
# (<root>/profiles); then ~/.config/dexbot2/profiles for ALL installs (home is
# the default so user state survives re-clones and `npm update -g`). Legacy
# migration mirrors the TS resolveProfilesDir: until a home config exists, a
# source checkout with a populated repo/cwd profiles dir keeps its current
# location; a global npm package (project root under node_modules) never falls
# back into the package dir.
PROFILE_ROOT="$DEXBOT_PROFILE_ROOT"
if [ -z "$PROFILE_ROOT" ]; then
    if [ -n "$DEXBOT2_ROOT" ]; then
        PROFILE_ROOT="${DEXBOT2_ROOT}/profiles"
    else
        # Home dir: $HOME normally; when unset (e.g. cron/systemd), mirror
        # Node's os.homedir() passwd fallback so the shell side does not fall
        # back into a node_modules package dir on npm installs. XDG_CONFIG_HOME
        # overrides the config base, mirroring HOME_CONFIG_DIR in paths.ts.
        CONFIG_BASE=""
        if [ -n "$XDG_CONFIG_HOME" ]; then
            CONFIG_BASE="$XDG_CONFIG_HOME"
        elif [ -n "$HOME" ]; then
            CONFIG_BASE="${HOME}/.config"
        else
            PASSWD_HOME=""
            if command -v getent >/dev/null 2>&1; then
                PASSWD_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
            elif command -v dscl >/dev/null 2>&1; then
                PASSWD_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
            fi
            [ -n "$PASSWD_HOME" ] && CONFIG_BASE="${PASSWD_HOME}/.config"
        fi
        HOME_PROFILES="${CONFIG_BASE:+${CONFIG_BASE}/dexbot2/profiles}"
        # An existing home config is authoritative — the user has migrated.
        if [ -n "$HOME_PROFILES" ] && has_profile_state "$HOME_PROFILES"; then
            PROFILE_ROOT="$HOME_PROFILES"
        else
            # Legacy migration: keep a populated repo/cwd profiles dir until a
            # home config exists. npm packages never fall back into the package
            # dir — exact-parent check (basename of dirname), mirroring
            # isGlobalNpmPackageDir() in modules/paths.ts; a substring match
            # would also skip legit repos whose path merely contains the word.
            # Written as explicit checks (no word-splitting loop) so it behaves
            # identically under bash, dash, and zsh.
            LEGACY_REPO=""
            if [ "$(basename "$(dirname "$PROJECT_ROOT")")" = "node_modules" ]; then
                LEGACY_REPO=""
            else
                LEGACY_REPO="${PROJECT_ROOT}/profiles"
            fi
            PROFILE_ROOT=""
            if [ -n "$LEGACY_REPO" ] && has_profile_state "$LEGACY_REPO"; then
                PROFILE_ROOT="$LEGACY_REPO"
            elif has_profile_state "${PWD}/profiles"; then
                PROFILE_ROOT="${PWD}/profiles"
                if [ -n "$HOME_PROFILES" ]; then
                    echo "[paths] No home config at $HOME_PROFILES; falling back to profiles in the current directory: ${PWD}/profiles (set DEXBOT_PROFILE_ROOT to override)" >&2
                fi
            fi
            # Fresh install → home by default (never the package dir).
            if [ -z "$PROFILE_ROOT" ]; then
                if [ -n "$HOME_PROFILES" ]; then PROFILE_ROOT="$HOME_PROFILES"
                else PROFILE_ROOT="${PROJECT_ROOT}/profiles"; fi
            fi
        fi
    fi
fi

# Market adapter data/state: env vars win; state stays next to the code only
# when profiles resolve to the repo layout (source checkout legacy), otherwise
# it follows the resolved profiles dir (home for fresh checkouts / npm installs,
# or a DEXBOT_PROFILE_ROOT override). Mirrors resolveMarketAdapterDirs.
if [ -n "$DEXBOT_MARKET_ADAPTER_DATA_DIR" ]; then
    MA_DATA_DIR="$DEXBOT_MARKET_ADAPTER_DATA_DIR"
elif [ "$PROFILE_ROOT" = "${PROJECT_ROOT}/profiles" ] && [ -d "${PROJECT_ROOT}/market_adapter" ]; then
    MA_DATA_DIR="${PROJECT_ROOT}/market_adapter/data"
else
    MA_DATA_DIR="${PROFILE_ROOT}/market_adapter/data"
fi

if [ -n "$DEXBOT_MARKET_ADAPTER_STATE_DIR" ]; then
    MA_STATE_DIR="$DEXBOT_MARKET_ADAPTER_STATE_DIR"
elif [ "$PROFILE_ROOT" = "${PROJECT_ROOT}/profiles" ] && [ -d "${PROJECT_ROOT}/market_adapter" ]; then
    MA_STATE_DIR="${PROJECT_ROOT}/market_adapter/state"
else
    MA_STATE_DIR="${PROFILE_ROOT}/market_adapter/state"
fi

# Claw data: claw/ ships in source checkouts AND npm packages, so key on the
# same rule as market adapter — source layout only when profiles resolve to the
# repo layout. Mirrors resolveClawDirs.
if [ -n "$DEXBOT_CLAW_DATA_DIR" ]; then
    CLAW_DATA_DIR="$DEXBOT_CLAW_DATA_DIR"
elif [ "$PROFILE_ROOT" = "${PROJECT_ROOT}/profiles" ]; then
    CLAW_DATA_DIR="${PROJECT_ROOT}/claw/data"
else
    CLAW_DATA_DIR="${PROFILE_ROOT}/claw/data"
fi
