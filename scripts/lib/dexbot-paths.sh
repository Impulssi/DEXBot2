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
#
# Also provides the advisory runtime-detection and log-predicate helpers used by
# the clear-* scripts: live_pid_from_file, runtime_processes,
# warn_if_runtime_running, log_files, note_audit_included.

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

# ---------------------------------------------------------------------------
# Runtime detection (advisory only — never blocks, never changes exit codes)
#
# The clear-* scripts delete runtime state. When the runtime is up it re-creates
# that state within seconds (grid snapshots; adapter state *and* its lock) and
# keeps the deleted log files open, so the space is only reclaimed on restart.
# Detecting that here keeps the warning identical in every script.
#
# Deliberately side-effect free: liveness is read from pid files, and `pm2 jlist`
# is probed only when the PM2 daemon is already up — otherwise a cleanup script
# would spawn a daemon as a side effect. Mirrors the runtime locations in
# modules/paths.ts (MONOLITHIC_PID, MONOLITHIC_BOT_PID, MONOLITHIC_CRED_PID).
# ---------------------------------------------------------------------------

# Echo the pid recorded in $1 when that process is alive, nothing otherwise.
# A recycled pid can produce a false positive; the warning is advisory, so that
# is preferable to the cost of a full process-table scan.
live_pid_from_file() {
    [ -f "$1" ] || return 0
    _lpf_pid="$(tr -dc '0-9' < "$1" 2>/dev/null)"
    [ -n "$_lpf_pid" ] || return 0
    kill -0 "$_lpf_pid" 2>/dev/null || return 0
    echo "$_lpf_pid"
}

# Echo one "<label> <pid>" line per live runtime process: the monolithic
# runtime's pid files first, then PM2 apps belonging to this install.
runtime_processes() {
    for _rp_file in monolithic.pid monolithic-bot.pid monolithic-cred.pid; do
        _rp_pid="$(live_pid_from_file "${PROFILE_ROOT}/${_rp_file}")"
        if [ -n "$_rp_pid" ]; then
            echo "${_rp_file} ${_rp_pid}"
        fi
    done

    _rp_pm2_home="${PM2_HOME:-${HOME}/.pm2}"
    _rp_pm2_pid="$(live_pid_from_file "${_rp_pm2_home}/pm2.pid")"
    if [ -n "$_rp_pm2_pid" ] && command -v pm2 >/dev/null 2>&1; then
        # Filter to online apps whose cwd/exec path is this install, so an
        # unrelated PM2 daemon on the same host is not reported. `process.argv`
        # after -e starts at index 1 (no script path is prepended).
        pm2 jlist 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
    let apps;
    try { apps = JSON.parse(raw); } catch { process.exit(0); }
    const roots = process.argv.slice(1).filter(Boolean);
    for (const app of apps || []) {
        const env = app.pm2_env || {};
        if (env.status && env.status !== "online") continue;
        const scope = env.cwd || env.pm_exec_path || "";
        if (roots.some((root) => scope === root || scope.startsWith(root + "/"))) {
            console.log("pm2:" + (app.name || "?") + " " + (app.pid || "?"));
        }
    }
});' "${PROJECT_ROOT}" "${PROFILE_ROOT}" 2>/dev/null || true
    fi
}

# Print a warning when a live runtime is detected. Advisory: prints and returns,
# never prompts, never exits, never changes the script's exit code.
warn_if_runtime_running() {
    _wirr_found="$(runtime_processes)"
    [ -n "$_wirr_found" ] || return 0
    if command -v log_warning >/dev/null 2>&1; then
        log_warning "A DEXBot2 runtime appears to be RUNNING:"
        echo "${_wirr_found}" | while read -r _wirr_line; do
            log_warning "  - ${_wirr_line}"
        done
        log_warning "The deletion below is unreliable while it runs: bots re-persist"
        log_warning "their grids within seconds, the market adapter rewrites its state"
        log_warning "file and lock, and open log handles keep the disk space until the"
        log_warning "processes restart. Stop first: dexbot stop (or dexbot pm2 stop all)."
    else
        echo "WARNING: a DEXBot2 runtime appears to be running:" >&2
        echo "${_wirr_found}" >&2
    fi
}

# ---------------------------------------------------------------------------
# Log file predicate
#
# One predicate for every find over the logs directory, so the preview, the
# count, the delete and the verification can never disagree. `*.jsonl*` (not
# `*.jsonl`) so the credential daemon's rotated audit siblings
# (daemon-audit.jsonl.1) are wiped together with daemon-audit.jsonl — they match
# no other pattern, and leaving them behind would make "clear" a partial wipe.
# ---------------------------------------------------------------------------
log_files() {
    find "$1" -type f \( -name "*.log" -o -name "*.log.*" -o -name "*.jsonl*" \) 2>/dev/null
}

# The audit trail is log content as far as these commands are concerned, so it is
# deleted with everything else — it is only named in the preview so the deletion
# is never a surprise. No extra prompt, no opt-in flag.
note_audit_included() {
    [ -n "$(find "$1" -type f -name 'daemon-audit.jsonl*' 2>/dev/null | head -n 1)" ] || return 0
    if command -v log_info >/dev/null 2>&1; then
        log_info "Includes the credential audit trail: daemon-audit.jsonl*"
    else
        echo "Includes the credential audit trail: daemon-audit.jsonl*" >&2
    fi
}
