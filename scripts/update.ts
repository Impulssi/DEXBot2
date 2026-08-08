#!/usr/bin/env node

/**
 * DEXBot2 Auto-Update Script
 *
 * Manages pulling latest code from git repository with smart logic:
 * - Fetches from configured remote repository
 * - Detects if updates are available
 * - Handles branch switching if needed
 * - Reinstalls npm dependencies
 * - Selectively restarts active runtime processes
 * - Gracefully handles missing files or PM2
 *
 * Configuration:
 * - Repository URL: Hardcoded in modules/constants.ts (UPDATER.REPOSITORY_URL)
 * - Target branch: Configurable in constants.ts (UPDATER.BRANCH), supports 'auto' for auto-detection
 *
 * Exit codes:
 * - 0: Update completed successfully (or already up-to-date)
 * - 1: Update failed (with error details printed)
 *
 * Usage: tsx scripts/update.ts
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { sendControlCommand } from '../modules/launcher/supervisor_control.js';

// Import update configuration from constants
// Contains: REPOSITORY_URL, BRANCH, BUILD_DIR settings
import { UPDATER, BUILD_DIR } from '../modules/constants.js';
import { PATHS } from '../modules/paths.js';
import { Config } from '../modules/config.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import { getErrorMessage } from '../modules/utils/errors.js';


const UPDATE_COLORS = {
    reset: '\x1b[0m',
    ok: '\x1b[1;92m',
    warn: '\x1b[1;33m',
    error: '\x1b[1;31m',
};

function colorUpdateOutput(text: string, color: string, stream: NodeJS.WriteStream = process.stdout) {
    return stream.isTTY && !Config.NO_COLOR
        ? `${color}${text}${UPDATE_COLORS.reset}`
        : text;
}

/**
 * log: Output timestamped update log message
 *
 * Formats: [ISO_TIMESTAMP] [UPDATE] message
 *
 * @param {string} msg - Message to log
 */
function log(msg: string) {
    console.log(`[${new Date().toISOString()}] [UPDATE] ${msg}`);
}

function logSuccess(msg: string) {
    console.log(colorUpdateOutput(`[${new Date().toISOString()}] [UPDATE] ${msg}`, UPDATE_COLORS.ok));
}

function updateError(msg: string): string {
    return colorUpdateOutput(msg, UPDATE_COLORS.error, process.stderr);
}

/**
 * run: Execute shell command with error handling
 *
 * Runs command with inherited stdio so user sees full output.
 * Throws error if command fails, breaking update process.
 *
 * @param {string} cmd - Shell command to execute
 * @throws {Error} If command exits with non-zero status
 */
function run(cmd: string) {
    log(`Executing: ${cmd}`);
    try {
        execSync(cmd, { stdio: 'inherit', cwd: PATHS.PROJECT_ROOT });
    } catch (err: any) {
        console.error(updateError(`[ERROR] Command failed: ${cmd}`));
        throw err;
    }
}

function readLivePidFile(filePath: string): number {
    if (!fs.existsSync(filePath)) return 0;

    try {
        const pid = Number(fs.readFileSync(filePath, 'utf8').trim());
        if (!Number.isInteger(pid) || pid <= 0) return 0;
        process.kill(pid, 0);
        return pid;
    } catch (_) {
        return 0;
    }
}

function detectMonolithicRuntime() {
    const wrapperPid = readLivePidFile(PATHS.PROFILES.MONOLITHIC_PID);
    if (!wrapperPid) return null;

    const detected = { wrapperPid, botPid: readLivePidFile(PATHS.PROFILES.MONOLITHIC_BOT_PID), botNames: [] as string[] };
    try {
        const info = readJSON(PATHS.PROFILES.MONOLITHIC_BOT_INFO);
        if (Array.isArray(info.botNames)) {
            detected.botNames = info.botNames.map((name: any) => String(name));
        } else if (info.botName) {
            detected.botNames = [String(info.botName)];
        }
    } catch (_) {}
    return detected;
}

function detectAnyMonolithicFiles() {
    return fs.existsSync(PATHS.PROFILES.MONOLITHIC_PID)
        || fs.existsSync(PATHS.PROFILES.MONOLITHIC_BOT_INFO)
        || fs.existsSync(PATHS.PROFILES.MONOLITHIC_CRED_PID);
}

function restartMonolithicRuntime(monolithic: any) {
    const details = [
        `wrapper PID ${monolithic.wrapperPid}`,
        monolithic.botPid ? `bot PID ${monolithic.botPid}` : null,
        monolithic.botNames.length ? `bots: ${monolithic.botNames.join(', ')}` : null,
    ].filter(Boolean).join('; ');

    log(`Monolithic runtime detected (${details}). Restarting via SIGUSR2...`);
    try {
        const lockRaw = fs.readFileSync(PATHS.MARKET_ADAPTER.LOCK_FILE, 'utf8').trim();
        const info = JSON.parse(lockRaw);
        const adapterPid = Number(info.pid);
        if (Number.isInteger(adapterPid) && adapterPid > 0) {
            try { process.kill(adapterPid, 'SIGTERM'); } catch (_) {}
        }
    } catch (_) {}
    try { process.kill(monolithic.wrapperPid, 'SIGUSR2'); } catch (_) {}
}

/**
 * Start the monolithic daemon by invoking `dexbot unlock`.
 *
 * Returns true only when the unlock command exited successfully. In
 * non-interactive (non-TTY) mode the function prints a manual-start hint
 * and returns false; the caller can then surface its own fallback message.
 * On a thrown error (e.g. wrong password, user cancellation) the function
 * logs a warning and returns false.
 */
function startMonolithicRuntime() {
    const unlockPath = fs.existsSync(path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'unlock.js'))
        ? path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'unlock.js')
        : path.join(PATHS.PROJECT_ROOT, 'unlock.js');
    const isTTY = process.stdin && process.stdin.isTTY;
    if (!isTTY) {
        console.log(colorUpdateOutput(
            '\n⚠️  Monolithic daemon was running before update but cannot be auto-started\n' +
            '   in non-interactive mode (no TTY).\n' +
            '   To start it manually:\n' +
            '     dexbot unlock\n' +
            '   (or with --headless --password-file <path> for automation)\n',
            UPDATE_COLORS.warn,
        ));
        return false;
    }
    log('Starting monolithic daemon (dexbot unlock)...');
    try {
        execSync(`node "${unlockPath}"`, {
            cwd: PATHS.PROJECT_ROOT,
            stdio: 'inherit',
        });
        logSuccess('Monolithic daemon started.');
        return true;
    } catch (err) {
        log(`Warning: Could not auto-start monolithic daemon (${getErrorMessage(err)}). Start manually with: dexbot unlock`);
        return false;
    }
}

function hasLocalChanges() {
    try {
        const tracked = execSync('git diff --name-only', { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT }).toString().trim();
        if (tracked) return true;
        const untracked = execSync('git ls-files --others --exclude-standard', { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT }).toString().trim();
        return !!untracked;
    } catch (_) {
        return false;
    }
}

/**
 * Resolve a stash ref (e.g. `stash@{0}`) for a given stash message.
 *
 * Capturing the ref by message — rather than always using `stash@{0}` —
 * makes the apply+drop pair robust against any other stash operation that
 * may occur between push and pop (e.g. an external tool, hook, or operator
 * action). Falls back to `stash@{0}` if the lookup fails so the script
 * still attempts a restore.
 */
function resolveStashRef(message: string): string {
    try {
        const list = execSync('git stash list --format="%gd %gs" 2>/dev/null', { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT }).toString().trim();
        if (list) {
            for (const line of list.split('\n')) {
                if (line.includes(message)) {
                    return line.split(' ')[0];
                }
            }
        }
    } catch (_) {
        log('Debug: Could not enumerate stash list to resolve stash ref. Falling back to stash@{0}.');
    }
    return 'stash@{0}';
}

async function detectIsolatedSupervisor(): Promise<Record<string, any> | null> {
    try {
        const resp: any = await sendControlCommand({ cmd: 'status' });
        return resp?.ok ? (resp.status as Record<string, any>) || {} : null;
    } catch (_) {
        return null;
    }
}

async function restartActiveIsolatedProcesses() {
    const status = await detectIsolatedSupervisor();
    if (!status) {
        return false;
    }

    const runningNames = Object.entries(status)
        .filter(([name, info]: any) => name !== 'dexbot-update' && info && info.status === 'running')
        .map(([name]: any) => name);

    if (runningNames.length === 0) {
        log('No active isolated processes are currently running. Skipping supervisor restart.');
        return true;
    }

    log(`Active isolated processes detected: ${runningNames.join(', ')}`);
    await sendControlCommand({ cmd: 'restart-running' });
    return true;
}

(async () => {
try {
    // Change to project root for all git operations
    process.chdir(PATHS.PROJECT_ROOT);
    log('Starting DEXBot2 update process...');

    // Get configured repository URL and target branch
    const repoUrl = UPDATER.REPOSITORY_URL;
    let branch = UPDATER.BRANCH;

    /**
     * STEP 1: Validate Git Repository
     * Ensures .git directory exists so we can perform git operations
     */
    if (!fs.existsSync(path.join(PATHS.PROJECT_ROOT, '.git'))) {
        throw new Error('Not a git repository. If installed from npm, run: npm update -g dexbot');
    }

    /**
     * STEP 2: Detect Current Branch
     * Gets the current checked-out branch name
     */
    log('Checking for updates...');

    let currentBranch;
    try {
        // Get detached/attached branch name
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    } catch (e: any) {
        // Fallback if command fails
        currentBranch = 'unknown';
    }

    /**
     * STEP 3: Handle Branch Auto-Detection
     * If UPDATER.BRANCH is 'auto', detect or default to 'main'
     * Otherwise use the configured branch name
     */
    if (branch === 'auto') {
        if (currentBranch === 'HEAD' || currentBranch === 'unknown') {
            // Detached HEAD or unknown state - default to main
            branch = 'main';
            log(`Could not detect current branch, defaulting to: ${branch}`);
        } else {
            // Auto-detect: use current branch
            branch = currentBranch;
            log(`Detected current branch: ${branch}`);
        }
    }

    /**
     * STEP 4: Verify/Fix Remote Configuration
     * Ensures origin points to the correct repository URL
     * Updates URL if it differs, or adds origin remote if missing
     */
    try {
        const currentRemote = execSync('git remote get-url origin', { stdio: 'pipe' }).toString().trim();
        log(`Remote origin already configured (${currentRemote}). Keeping existing remote.`);
    } catch (e: any) {
        // Remote doesn't exist, add it from config
        log(`Adding origin remote: ${repoUrl}`);
        run(`git remote add origin ${repoUrl}`);
    }

    /**
     * STEP 5: Check for Available Updates
     * Fetches remote branch metadata and compares with local
     */
    run(`git fetch origin ${branch}`);

    // Get current commit hashes for comparison

    /**
     * Check for incoming commits
     * git rev-list --count HEAD..origin/branch = commits that exist remotely but not locally
     * This is the core check: if > 0, updates are available
     */
    const incomingCommits = parseInt(execSync(`git rev-list --count HEAD..origin/${branch}`).toString().trim(), 10);
    const updatesAvailable = incomingCommits > 0;
    const branchSwitchNeeded = currentBranch !== branch;

    /**
     * Decision Logic for Update Flow
     *
     * Three scenarios are possible:
     * 1. NO incoming updates (updatesAvailable = false)
     *    - Local is either equal to or ahead of remote
     *    - Action: Switch branch if needed, then exit cleanly
     * 2. Incoming updates available (updatesAvailable = true)
     *    - Remote has new commits we need to pull
     *    - Action: Proceed with full update (pull, npm install, restart runtimes)
     */
    if (!updatesAvailable) {
        // No updates available - check if branch switch is needed
        if (branchSwitchNeeded) {
            log(`Aligning branch reference: ${currentBranch} -> ${branch} (no incoming updates).`);
            run(`git checkout ${branch}`);
            log('DEXBot2 is now tracking the correct branch.');
        }
        log('DEXBot2 is already up to date (local is equal or ahead of remote).');
        process.exit(0);
    }

    log(`${incomingCommits} update(s) available. Proceeding with update process...`);

    // List changes
    console.log('\n----------------------------------------------------------------');
    console.log('Incoming Changes:');
    try {
        execSync(`git log --oneline --graph --decorate HEAD..origin/${branch}`, { stdio: 'inherit', cwd: PATHS.PROJECT_ROOT });
    } catch (e: any) {
        log('Warning: Could not list changes.');
    }
    console.log('----------------------------------------------------------------\n');

    /**
     * STEP 6a: Snapshot pre-update runtime state
     *
     * Detect whether the monolithic daemon is alive BEFORE we touch git.
     * The daemon may shut down during git/npm operations (e.g. prepare
     * hook or build), erasing its PID file. By capturing state up front,
     * we can still restart it after the build completes.
     */
    const monolithicWasRunning = !!detectMonolithicRuntime();
    const hadMonolithicFiles = detectAnyMonolithicFiles();
    if (monolithicWasRunning) {
        log('Monolithic daemon detected running before update. Will restart after build.');
    } else if (hadMonolithicFiles) {
        log('Monolithic PID/file artifacts found but daemon is not alive. Will attempt restart after build.');
    }

    /**
     * STEP 6b: Prepare Working Directory
     * Stashes local changes to ensure a clean pull.
     * Skips stash entirely if there are no local changes (avoids creating
     * orphaned empty stash entries).
     * Ignores gitignored directories (profiles/, dist/) — they are
     * never touched by stash, so bot configs and keys are safe.
     */
    let stashed = false;
    const STASH_MESSAGE = 'dexbot-update-auto';
    if (hasLocalChanges()) {
        log('Stashing local changes before pull...');
        run(`git stash push --include-untracked --message "${STASH_MESSAGE}" 2>/dev/null; true`);
        stashed = true;
    } else {
        log('No local changes — skipping stash.');
    }

    /**
     * STEP 7: Pull Latest Code Changes
     * Switches branch if needed, then pulls remote changes
     */
    if (currentBranch !== branch) {
        log(`Switching to branch: ${branch}...`);
        run(`git checkout ${branch}`);
    }
    log(`Pulling latest changes from ${repoUrl} (branch: ${branch})...`);
    // Use --rebase to avoid merge commits and keep clean linear history
    run(`git pull --rebase origin ${branch}`);

    /**
     * Restore stashed changes using apply + explicit drop.
     *
     * Using `git stash apply` instead of `git stash pop` avoids the stash
     * leak bug: `pop` keeps the stash entry when conflicts occur, causing
     * orphaned entries to accumulate across runs. `apply` always preserves
     * the stash, so we clean it up unconditionally with `git stash drop`.
     *
     * If the apply produces merge conflicts we auto-resolve by keeping
     * the stashed (user-local) version with `--theirs`. In a `git stash
     * apply` 3-way merge, `--ours` is the current worktree (the pulled-in
     * remote content) and `--theirs` is the stashed content (the user's
     * local edits). Local changes take precedence over incoming remote.
     */
    if (stashed) {
        const stashRef = resolveStashRef(STASH_MESSAGE);
        log('Restoring stashed changes...');
        try {
            execSync(`git stash apply ${stashRef} 2>/dev/null`, { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT });
        } catch (_) {
            // Apply had conflicts — auto-resolve in favor of the stashed (local) content
            log('Stash apply had conflicts, auto-resolving in favor of local changes...');
            try {
                execSync('git checkout --theirs -- . 2>/dev/null', { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT });
            } catch (_2) {}
        }
        // Unconditionally drop the stash entry — no orphan accumulation
        try {
            execSync(`git stash drop ${stashRef} 2>/dev/null`, { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT });
        } catch (_) {
            log('Warning: Could not drop stash entry — it may have been already dropped.');
        }
        // Check for leftover unmerged paths and resolve them
        try {
            const unmergedRaw = execSync('git diff --name-only --diff-filter=U', { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT }).toString().trim();
            if (unmergedRaw) {
                const unmerged = unmergedRaw.split('\n').filter(Boolean);
                log(`Cleaning up ${unmerged.length} unresolved merge marker(s) after stash restore...`);
                execSync(`git checkout --theirs -- ${unmerged.join(' ')} 2>/dev/null`, { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT });
                // If package-lock.json was conflicted, regenerate it so it's
                // consistent with the (potentially updated) package.json
                if (unmerged.includes('package-lock.json')) {
                    log('package-lock.json was conflicted — regenerating...');
                    execSync('npm install --prefer-offline --ignore-scripts 2>&1', { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT });
                }
            }
        } catch (_) {}
    }

    /**
     * STEP 8: Reinstall Dependencies
     * Updates npm packages to versions specified in package-lock.json.
     * --ignore-scripts prevents npm from running the package `prepare` hook,
     * which would build once here before the explicit build step below.
     * --prefer-offline: Uses cached packages when possible
     */
    log('Updating dependencies...');
    run('npm install --prefer-offline --ignore-scripts');

    /**
     * STEP 8b: Build TypeScript sources
     *
     * Do NOT rely on the npm `prepare` hook. The `prepare` script only re-fires
     * when package.json itself changes, not when only .ts source files are
     * updated. After a `git pull` that touches only .ts files, `npm install`
     * is a no-op, `tsc` never runs, and the running bot process keeps loading
     * the stale dist/ bundle — with no error surfaced to the operator.
     *
     * Always run the explicit build here so the next PM2 restart picks up
     * the new code. The staleness check at the end of this step is defense
     * in depth: if the build silently no-ops (e.g. tsc crashed, output path
     * missing), the update aborts before PM2 is restarted.
     */
    log('Building TypeScript sources (npm run build)...');
    run('npm run build');

    const SOURCE_MARKER = path.join(PATHS.PROJECT_ROOT, 'modules', 'dexbot_class.ts');
    const DIST_MARKER = path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'modules', 'dexbot_class.js');
    if (fs.existsSync(SOURCE_MARKER)) {
        if (!fs.existsSync(DIST_MARKER)) {
            throw new Error(
                `Build did not produce ${BUILD_DIR}/modules/dexbot_class.js. ` +
                `Refusing to restart PM2 with a missing bundle. ` +
                `Run \`npm run build\` manually and inspect tsc output.`
            );
        }

        const srcStat = fs.statSync(SOURCE_MARKER);
        const distStat = fs.statSync(DIST_MARKER);
        if (distStat.mtimeMs < srcStat.mtimeMs) {
            throw new Error(
                `Build did not refresh ${BUILD_DIR}/modules/dexbot_class.js ` +
                `(src mtime=${srcStat.mtime.toISOString()}, ` +
                `${BUILD_DIR} mtime=${distStat.mtime.toISOString()}). ` +
                `Refusing to restart PM2 with a stale bundle. ` +
                `Run \`npm run build\` manually and inspect tsc output.`
            );
        }
        log(`${BUILD_DIR}/ is fresh (mtime=${distStat.mtime.toISOString()}).`);
    }

    /**
     * STEP 8c: Regenerate Ecosystem Config
     * Ensures profiles/ecosystem.config.cjs reflects the current bots.json
     * state, including service apps like dexbot-adapter and dexbot-update.
     * Uses the compiled dist/pm2.js (after TS build) for correct dist/ paths.
     */
    log('Regenerating PM2 ecosystem config...');
    try {
        // Try loading from compiled dist/ first, then fall back to source dir
        const distPath = path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'pm2.js');
        const pm2Module = fs.existsSync(distPath)
            ? await import(distPath)
            : await import(path.join(PATHS.PROJECT_ROOT, 'pm2.js'));
        pm2Module.generateEcosystemConfig({ clawOnly: false, exitOnError: false });
        log('Ecosystem config regenerated successfully.');
    } catch (err: any) {
        log(`Warning: Ecosystem config regeneration failed (${getErrorMessage(err)}). Continuing with existing config.`);
    }

    /**
     * STEP 9: Restart Active Runtime Processes
     * Intelligently restarts only the bots that were active before update
     * This approach:
     * - Preserves PM2 state if not running
     * - Restarts active bots to pick up code changes
     * - Handles missing bots.json gracefully
     * - Never restarts dexbot-cred through bulk PM2 actions
     *
     * Uses the pre-update snapshot (monolithicWasRunning) as a fallback:
     * if the daemon shut down during git/npm ops and its PID file is gone,
     * we still attempt to restart it.
     */
    let restarted = false;
    log('Restarting active runtime processes...');
    try {
        if (Config.DEXBOT_UPDATE_SKIP_RELOAD) {
            log('Restart skipped (managed by launcher).');
            restarted = true;
        } else {
            const monolithic = detectMonolithicRuntime();
            if (monolithic) {
                restartMonolithicRuntime(monolithic);
                restarted = true;
            } else if (await restartActiveIsolatedProcesses()) {
                log('Isolated supervisor runtime restarted.');
                restarted = true;
            } else {
                const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
                if (fs.existsSync(BOTS_FILE)) {
                    const raw = fs.readFileSync(BOTS_FILE, 'utf8');
                    const stripped = raw.replace(/\/\*(?:.|[\r\n])*?\*\//g, '').replace(/(^|\s*)\/\/.*$/gm, '');
                    const config = JSON.parse(stripped);

                    const activeInConfig = (config.bots || [])
                        .filter((b: any) => b.active !== false)
                        .map((b: any) => b.name)
                        .filter((name: string) => !!name);

                    if (activeInConfig.length > 0) {
                        let runningProcesses: string[] = [];
                        try {
                            const output = execSync('pm2 jlist').toString().trim();
                            const jsonStart = output.indexOf('[');
                            if (jsonStart !== -1) {
                                const jsonPart = output.substring(jsonStart);
                                const parsed = JSON.parse(jsonPart);
                                runningProcesses = parsed.map((p: any) => p.name);
                            } else {
                                log('Warning: PM2 jlist output did not contain JSON array.');
                            }
                        } catch (e: any) {
                            log('Warning: Could not fetch PM2 process list. Falling back to config-only detection.');
                            runningProcesses = activeInConfig;
                        }

                        const botsToRestart = activeInConfig.filter((name: string) => (runningProcesses as string[]).includes(name));
                        const activeBots = (config.bots || []).filter((b: any) => b.active !== false);
                        const runningActiveBots = activeBots.filter((b: any) => (runningProcesses as string[]).includes(b.name));
                        const maPath = path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'pm2.js');
                        const pm2Module = fs.existsSync(maPath)
                            ? await import(maPath)
                            : await import(path.join(PATHS.PROJECT_ROOT, 'pm2.js'));
                        const marketAdapterRequired = pm2Module.needsMarketAdapter(runningActiveBots);

                        const serviceAppsToRestart: string[] = marketAdapterRequired ? ['dexbot-adapter'] : [];
                        const servicesToRestart: string[] = serviceAppsToRestart.filter((name: string) => (runningProcesses as string[]).includes(name));
                        const allToRestart: string[] = [...botsToRestart, ...servicesToRestart];

                        if (allToRestart.length > 0) {
                            log(`Active processes detected: ${allToRestart.join(', ')}`);
                            for (const name of allToRestart) {
                                try {
                                    run(`pm2 restart "${name}"`);
                                } catch (e) {
                                    log(`Warning: Failed to restart process "${name}" (it might not be running).`);
                                }
                            }
                            restarted = true;
                        } else {
                            log('No active processes currently running in PM2. Skipping restart.');
                        }

                        if (marketAdapterRequired && !runningProcesses.includes('dexbot-adapter')) {
                            log('dexbot-adapter is required by an AMA-grid bot but not running. Starting from ecosystem...');
                            try {
                                run('pm2 start profiles/ecosystem.config.cjs --only dexbot-adapter');
                            } catch (e) {
                                log('Warning: Failed to start dexbot-adapter from ecosystem config.');
                            }
                        }
                    } else {
                        log('No active bots found in config.');
                    }
                } else {
                    log('Warning: profiles/bots.json not found, skipping selective restart.');
                }
            }
        }
    } catch (err: any) {
        log(`Warning: runtime restart logic failed (${getErrorMessage(err)}). Skipping bulk restart to avoid touching dexbot-cred.`);
    }

    /**
     * STEP 9b: Fallback restart for monolithic daemon
     *
     * If the monolithic daemon was running (or had state files) before the
     * update but is no longer alive (common when the daemon is killed during
     * git/npm operations like the prepare hook), try to auto-start it.
     * This prevents the "bot updated but is not running" failure mode.
     *
     * Only mark `restarted` true when startMonolithicRuntime reports
     * success — otherwise fall through to the manual-start instructions
     * below so the operator knows the daemon did not actually come back.
     */
    if (!restarted && !Config.DEXBOT_UPDATE_SKIP_RELOAD) {
        if (monolithicWasRunning || hadMonolithicFiles) {
            log('Monolithic daemon was detected before update but is no longer running. Auto-starting...');
            if (startMonolithicRuntime()) {
                restarted = true;
            } else {
                log('Auto-start did not succeed; the manual-start instructions below apply.');
            }
        }
    }

    if (!restarted) {
        console.log(colorUpdateOutput(
            '\n⚠️  No active runtime was restarted.\n' +
            '   If the daemon was running before, start it manually from a terminal:\n' +
            '     dexbot unlock\n' +
            '   (will prompt for master password; add --foreground for interactive mode)\n' +
            '   For non-interactive automation:\n' +
            '     dexbot unlock --headless --password-file <path>\n',
            UPDATE_COLORS.warn,
        ));
    }

    logSuccess('DEXBot2 update completed successfully.');
    process.exit(0);
} catch (err: any) {
    console.error(updateError('=========================================='));
    console.error(updateError('UPDATE FAILED'));
    console.error(updateError(`Error: ${getErrorMessage(err)}`));
    console.error(updateError('=========================================='));
    process.exit(1);
}
})();
