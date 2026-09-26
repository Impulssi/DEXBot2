#!/usr/bin/env node

/**
 * DEXBot2 Auto-Update Script
 *
 * Supports two installation layouts:
 *
 * 1. Git checkout:
 *    - Fetches from configured remote repository
 *    - Detects if updates are available
 *    - Handles branch switching if needed
 *    - Reinstalls npm dependencies and rebuilds TypeScript sources
 *
 * 2. npm package install (e.g. `npm install -g dexbot`):
 *    - Compares the installed version against the npm registry
 *    - Runs `npm install -g <pkg>@<latest>` to fetch the newest release
 *    - Skips the git and local build steps (published packages are pre-built)
 *    - Requires the npm CLI and registry access; only global installs can be
 *      updated in place (local `node_modules` deps must be updated from the
 *      parent project with `npm update`)
 *
 * Shared tail for both layouts:
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
 * Usage: node dist/scripts/update.js
 */

import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { sendControlCommand } from '../modules/launcher/supervisor_control.js';
import { findMissingDistEntries, inspectDistBundle } from './update_dist_freshness.js';

// Import update configuration from constants
// Contains: REPOSITORY_URL, BRANCH, BUILD_DIR settings
import { UPDATER, BUILD_DIR } from '../modules/constants.js';
import { PATHS, isGlobalNpmPackageDir } from '../modules/paths.js';
import { Config } from '../modules/config.js';
import { getStorage } from '../modules/storage/index.js';
const { readJSON } = getStorage();
import { getErrorMessage } from '../modules/utils/errors.js';
import { CLI_COLORS } from '../modules/cli_colors.js';


const UPDATE_COLORS = {
    reset: CLI_COLORS.reset,
    ok: CLI_COLORS.brightGreen,
    warn: CLI_COLORS.yellowBold,
    error: CLI_COLORS.boldRed,
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
 * runIn: Execute shell command in a given working directory with error handling
 *
 * Runs command with inherited stdio so user sees full output.
 * Throws error if command fails, breaking update process.
 *
 * @param {string} cwd - Working directory for the command
 * @param {string} cmd - Shell command to execute
 * @throws {Error} If command exits with non-zero status
 */
function runIn(cwd: string, cmd: string) {
    log(`Executing: ${cmd}`);
    try {
        execSync(cmd, { stdio: 'inherit', cwd });
    } catch (err: any) {
        console.error(updateError(`[ERROR] Command failed: ${cmd}`));
        throw err;
    }
}

/**
 * run: Execute shell command in the project root with error handling
 *
 * Runs command with inherited stdio so user sees full output.
 * Throws error if command fails, breaking update process.
 *
 * @param {string} cmd - Shell command to execute
 * @throws {Error} If command exits with non-zero status
 */
function run(cmd: string) {
    runIn(PATHS.PROJECT_ROOT, cmd);
}

// ── npm-install helpers ──────────────────────────────────────────────

function readPackageJson(root: string): Record<string, any> | null {
    try {
        return readJSON(path.join(root, 'package.json')) as Record<string, any>;
    } catch (_) {
        return null;
    }
}

function readPackageVersion(root: string): string {
    const pkg = readPackageJson(root);
    return typeof pkg?.version === 'string' ? pkg.version : '';
}

function readPackageName(root: string): string {
    const pkg = readPackageJson(root);
    return typeof pkg?.name === 'string' && pkg.name ? pkg.name : 'dexbot';
}

/**
 * compareVersions: Minimal semver comparison for major.minor.patch strings.
 *
 * Returns a negative number when a < b, zero when equal, positive when a > b.
 * Prerelease/build suffixes are ignored (sufficient for update detection).
 */
function compareVersions(a: string, b: string): number {
    const na = a.split('.').map((n) => parseInt(n, 10) || 0);
    const nb = b.split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(na.length, nb.length);
    for (let i = 0; i < len; i++) {
        const va = na[i] ?? 0;
        const vb = nb[i] ?? 0;
        if (va !== vb) return va < vb ? -1 : 1;
    }
    return 0;
}

/**
 * getNpmLatestVersion: Query the npm registry for the latest published version.
 *
 * Throws when the registry is unreachable so the update is treated as failed
 * (exit 1) and the scheduler does not restart the daemon for a no-op.
 */
function getNpmLatestVersion(pkgName: string): string {
    try {
        const version = execSync(`npm view ${pkgName} version`, { stdio: 'pipe' }).toString().trim();
        if (!version) throw new Error('npm returned an empty version.');
        return version;
    } catch (err: any) {
        throw new Error(`Could not reach the npm registry to check for updates (${getErrorMessage(err)}).`);
    }
}

/**
 * getGlobalNpmRoot: Resolve the npm global install root (e.g. <prefix>/lib/node_modules).
 * Returns an empty string when npm is unavailable.
 */
function getGlobalNpmRoot(): string {
    try {
        // npm prints only the root to stdout, but notifications can land there
        // in some setups — take the LAST non-empty line so a stray leading
        // notice cannot produce a garbage path.
        const lines = execSync('npm root -g', { stdio: 'pipe' }).toString().split('\n').filter((l) => l.trim());
        return lines.length > 0 ? lines[lines.length - 1].trim() : '';
    } catch (_) {
        return '';
    }
}

/**
 * Resolve a path to its real filesystem location, falling back to the
 * lexical path when realpath fails (e.g. a missing intermediate component).
 */
function realpathSafe(p: string): string {
    try {
        return fs.realpathSync.native(p);
    } catch {
        try {
            return fs.realpathSync(p);
        } catch {
            return p;
        }
    }
}

/**
 * True when the project root is a DIRECT child of the npm global install root
 * (e.g. <prefix>/lib/node_modules/dexbot). Comparing the immediate parent —
 * rather than a string prefix — rejects nested packages, custom `--prefix`
 * layouts where the package lives deeper in the tree, and relative/absolute
 * path mismatches. Both sides are realpath'd so a symlinked global prefix
 * (e.g. a nvm/system prefix with a symlink component) is not falsely
 * rejected: import.meta.url already realpaths PROJECT_ROOT, while `npm
 * root -g` returns the un-resolved prefix. Symlinked layouts (e.g. `npm
 * link`) resolve to the real package location, which is intentionally not a
 * global-root child, so they fall through to the manual-update error below.
 */
function isDirectGlobalInstall(projectRoot: string, globalRoot: string): boolean {
    const resolvedRoot = realpathSafe(path.resolve(globalRoot));
    const resolvedProject = realpathSafe(path.resolve(projectRoot));
    return path.dirname(resolvedProject) === resolvedRoot;
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
 * Start the monolithic daemon by invoking `dexbot start`.
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
            '     dexbot start\n' +
            '   (or with --headless --password-file <path> for automation)\n',
            UPDATE_COLORS.warn,
        ));
        return false;
    }
    log('Starting monolithic daemon (dexbot start)...');
    try {
        execSync(`node "${unlockPath}"`, {
            cwd: PATHS.PROJECT_ROOT,
            stdio: 'inherit',
        });
        logSuccess('Monolithic daemon started.');
        return true;
    } catch (err) {
        log(`Warning: Could not auto-start monolithic daemon (${getErrorMessage(err)}). Start manually with: dexbot start`);
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

/**
 * needsDepsInstall: post-pull check whether `npm install` is required.
 *
 * Only pre-state is the starting commit SHA (captured before
 * checkout/pull, passed in); the decision itself happens after the pull:
 * - `node_modules` missing or without npm's hidden lockfile (broken tree)
 *   -> install.
 * - `package.json`/`package-lock.json` changed since the pre-update
 *   commit (covers branch switch + pull) -> install.
 * - those files dirty in the worktree (e.g. stash-restored local edits)
 *   -> install (fail-open).
 * Fail-open (true) on any git error so a broken check never skips a
 * needed install.
 */
function needsDepsInstall(preUpdateHead: string): boolean {
    if (!fs.existsSync(path.join(PATHS.PROJECT_ROOT, 'node_modules'))
        || !fs.existsSync(path.join(PATHS.PROJECT_ROOT, 'node_modules', '.package-lock.json'))) {
        log('node_modules missing or incomplete — dependencies need install.');
        return true;
    }
    // Diff since the pre-update commit: covers branch switch + pull.
    // Falls back to HEAD@{1} when the SHA capture failed.
    const baseRef = preUpdateHead || 'HEAD@{1}';
    try {
        const pulled = execSync(`git diff --name-only ${baseRef} HEAD -- package.json package-lock.json 2>/dev/null`, { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT }).toString().trim();
        if (pulled) {
            log(`Dependency manifests changed in pull: ${pulled.split('\n').join(', ')}`);
            return true;
        }
    } catch (_) {
        return true;
    }
    try {
        const dirty = execSync('git status --porcelain -- package.json package-lock.json 2>/dev/null', { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT }).toString().trim();
        if (dirty) {
            log('Dependency manifests have local modifications — dependencies need install.');
            return true;
        }
    } catch (_) {
        return true;
    }
    return false;
}

/**
 * Eject the production incremental build cache so the next `tsc` re-emits every
 * output. An intact `.tsbuildinfo` makes tsc skip outputs it believes are
 * current — including a file deleted or replaced out of band — so a full
 * rebuild is the only way to guarantee `dist/` matches the sources.
 */
function ejectIncrementalBuildCache() {
    const cache = path.join(PATHS.PROJECT_ROOT, 'node_modules', '.cache', 'tsc-prod.tsbuildinfo');
    if (!fs.existsSync(cache)) return;
    try {
        fs.rmSync(cache, { force: true });
        log(`Removed ${path.relative(PATHS.PROJECT_ROOT, cache)} to force a full TypeScript rebuild.`);
    } catch (err) {
        log(`Warning: Could not remove the incremental build cache (${getErrorMessage(err)}).`);
    }
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

// ── Shared update tail (both git and npm layouts) ────────────────────

/**
 * Snapshot pre-update runtime state BEFORE touching code (git pull or
 * `npm install -g`). The daemon may shut down during the operation (e.g.
 * a prepare hook or build), erasing its PID file. By capturing state up
 * front, we can still restart it after the update completes.
 */
function snapshotMonolithicState() {
    const monolithicWasRunning = !!detectMonolithicRuntime();
    const hadMonolithicFiles = detectAnyMonolithicFiles();
    if (monolithicWasRunning) {
        log('Monolithic daemon detected running before update. Will restart after update.');
    } else if (hadMonolithicFiles) {
        log('Monolithic PID/file artifacts found but daemon is not alive. Will attempt restart after update.');
    }
    return { monolithicWasRunning, hadMonolithicFiles };
}

/**
 * Absolute file:// URL of the freshly built pm2.js. Prefers dist/ and falls
 * back to the source-tree shim when no build output exists.
 */
function resolvePm2ModuleUrl(): string {
    const distPath = path.join(PATHS.PROJECT_ROOT, BUILD_DIR, 'pm2.js');
    const pm2Path = fs.existsSync(distPath)
        ? distPath
        : path.join(PATHS.PROJECT_ROOT, 'pm2.js');
    return pathToFileURL(pm2Path).href;
}

/**
 * Regenerate the PM2 ecosystem config so profiles/ecosystem.config.cjs
 * reflects the current bots.json state (including dexbot-adapter and
 * dexbot-update service apps).
 *
 * This MUST run in a fresh process. The updater loaded the pre-pull copies of
 * modules/paths.js, config.js, constants.js, ... at startup, and Node's ESM
 * registry is keyed by resolved URL for the process lifetime. Rewriting dist/
 * via `npm run build` does not evict those cached modules, so importing the
 * freshly built dist/pm2.js in-process resolves its static imports back to
 * the stale cached copies. That surfaces as build-fresh-but-import-broken
 * errors such as "does not provide an export named 'printRelocationNotices'".
 * A child process starts with an empty registry and sees the new build.
 */
async function regenerateEcosystemConfig() {
    log('Regenerating PM2 ecosystem config...');
    try {
        const moduleUrl = resolvePm2ModuleUrl();
        const script = [
            `import(${JSON.stringify(moduleUrl)})`,
            '  .then((m) => m.generateEcosystemConfig({ clawOnly: false, exitOnError: false }))',
            '  .catch((err) => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });',
        ].join('\n');
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            stdio: 'inherit',
            cwd: PATHS.PROJECT_ROOT,
        });
        if (result.error) throw result.error;
        if (result.status !== 0) {
            throw new Error(`ecosystem generator exited with code ${result.status}`);
        }
        log('Ecosystem config regenerated successfully.');
    } catch (err: any) {
        log(`Warning: Ecosystem config regeneration failed (${getErrorMessage(err)}). Continuing with existing config.`);
    }
}

/**
 * Evaluate `needsMarketAdapter(runningActiveBots)` from the freshly built
 * dist/pm2.js in a child process. Importing pm2.js in-process after the build
 * is unsafe for the same ESM-cache reason documented on
 * regenerateEcosystemConfig(): its link against the cached pre-pull
 * modules/paths.js can fail even though dist/ is fresh.
 */
function pm2NeedsMarketAdapter(runningActiveBots: any[]): boolean {
    const moduleUrl = resolvePm2ModuleUrl();
    const script =
        `import(${JSON.stringify(moduleUrl)})` +
        `.then((m) => { process.stdout.write(m.needsMarketAdapter(${JSON.stringify(runningActiveBots)}) ? 'true' : 'false'); })` +
        `.catch((err) => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'inherit'],
        cwd: PATHS.PROJECT_ROOT,
        encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`pm2 helper exited with code ${result.status}`);
    return (result.stdout || '').trim() === 'true';
}

/**
 * Restart active runtime processes after an update so the new code is picked
 * up. Handles, in order of preference:
 * - Monolithic daemon (SIGUSR2 restart)
 * - Isolated supervisor (control-command restart)
 * - PM2 selective restart from bots.json
 * - Fallback auto-start of a monolithic daemon that died during the update
 * Never touches dexbot-cred through bulk PM2 actions.
 */
async function restartActiveRuntimes({ monolithicWasRunning, hadMonolithicFiles }: { monolithicWasRunning: boolean; hadMonolithicFiles: boolean }) {
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
                        let pm2Usable = true;
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
                            // pm2 is not installed (or not usable). Config-active
                            // bots are not proof of running processes, so don't
                            // fabricate a process list — skip PM2-managed restarts
                            // and leave `restarted` false so the monolithic
                            // auto-start fallback / manual-start notice applies.
                            log('Warning: PM2 process list unavailable (is pm2 installed?). Skipping PM2-managed restarts.');
                            pm2Usable = false;
                        }

                        if (pm2Usable) {
                            const botsToRestart = activeInConfig.filter((name: string) => (runningProcesses as string[]).includes(name));
                            const activeBots = (config.bots || []).filter((b: any) => b.active !== false);
                            const runningActiveBots = activeBots.filter((b: any) => (runningProcesses as string[]).includes(b.name));
                            const marketAdapterRequired = pm2NeedsMarketAdapter(runningActiveBots);

                            const serviceAppsToRestart: string[] = marketAdapterRequired ? ['dexbot-adapter'] : [];
                            const servicesToRestart: string[] = serviceAppsToRestart.filter((name: string) => (runningProcesses as string[]).includes(name));
                            const allToRestart: string[] = [...botsToRestart, ...servicesToRestart];

                            if (allToRestart.length > 0) {
                                log(`Active processes detected: ${allToRestart.join(', ')}`);
                                let restartOk = false;
                                for (const name of allToRestart) {
                                    try {
                                        run(`pm2 restart "${name}"`);
                                        restartOk = true;
                                    } catch (e) {
                                        log(`Warning: Failed to restart process "${name}" (it might not be running).`);
                                    }
                                }
                                if (restartOk) {
                                    restarted = true;
                                } else {
                                    log('Warning: none of the PM2 restart attempts succeeded.');
                                }
                            } else {
                                log('No active processes currently running in PM2. Skipping restart.');
                            }

                            if (marketAdapterRequired && !runningProcesses.includes('dexbot-adapter')) {
                                log('dexbot-adapter is required by an AMA-grid bot but not running. Starting from ecosystem...');
                                try {
                                    run(`pm2 start "${PATHS.PROFILES.ECOSYSTEM_CONFIG_JS}" --only dexbot-adapter`);
                                } catch (e) {
                                    log('Warning: Failed to start dexbot-adapter from ecosystem config.');
                                }
                            }
                        }
                    } else {
                        log('No active bots found in config.');
                    }
                } else {
                    log(`Warning: ${PATHS.PROFILES.BOTS_JSON} not found, skipping selective restart.`);
                }
            }
        }
    } catch (err: any) {
        log(`Warning: runtime restart logic failed (${getErrorMessage(err)}). Skipping bulk restart to avoid touching dexbot-cred.`);
    }

    // Fallback restart for monolithic daemon that died during the update
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
            '     dexbot start\n' +
            '   (will prompt for master password; add --foreground for interactive mode)\n' +
            '   For non-interactive automation:\n' +
            '     dexbot start --headless --password-file <path>\n',
            UPDATE_COLORS.warn,
        ));
    }
}

/**
 * Fail loudly when the post-build bundle is incomplete or still lags its
 * source. `dist/dexbot.js` matters here: the CLI alias table lives in it, and
 * the previous single-marker guard never looked at it.
 */
function assertDistBundleFresh(status = inspectDistBundle(PATHS.PROJECT_ROOT, BUILD_DIR)) {
    if (status.needsRebuild) {
        throw new Error(
            `Build left ${BUILD_DIR}/ incomplete or stale (${status.reason}). ` +
            `Refusing to restart PM2 with a stale bundle. ` +
            `Run \`npm run build\` manually and inspect tsc output.`
        );
    }
    log(`${BUILD_DIR}/ is fresh.`);
}

/**
 * Build the TypeScript bundle, verify it is fresh, regenerate the PM2 ecosystem
 * config, and restart active runtimes. Shared by the normal update tail and the
 * "already up to date but dist/ is stale" recovery path.
 */
async function buildAndRestartRuntimes({
    monolithicWasRunning,
    hadMonolithicFiles,
    forceFull,
    successMessage,
}: {
    monolithicWasRunning: boolean;
    hadMonolithicFiles: boolean;
    forceFull: boolean;
    successMessage: string;
}) {
    if (forceFull) ejectIncrementalBuildCache();
    log('Building TypeScript sources (npm run build)...');
    run('npm run build');

    // An incremental build can skip an output whose source only changed mtime
    // (e.g. a stash re-apply on conflict). If that leaves dist/ stale, clear the
    // cache and emit everything once more so a false-stale can never fail the
    // update or spin the cron job. Capture the status so the final check does
    // not re-walk the source tree.
    let distStatus = inspectDistBundle(PATHS.PROJECT_ROOT, BUILD_DIR);
    if (distStatus.needsRebuild) {
        log('Incremental build left dist/ stale — forcing a full rebuild...');
        ejectIncrementalBuildCache();
        run('npm run build');
        distStatus = inspectDistBundle(PATHS.PROJECT_ROOT, BUILD_DIR);
    }

    assertDistBundleFresh(distStatus);

    await regenerateEcosystemConfig();
    await restartActiveRuntimes({ monolithicWasRunning, hadMonolithicFiles });
    logSuccess(successMessage);
    process.exit(0);
}

// ── npm-install update flow ──────────────────────────────────────────

/**
 * Update a globally installed npm package to the latest published version.
 *
 * Steps:
 * 1. Compare installed package.json version against the npm registry.
 * 2. Exit cleanly (0) when already up to date — no restart needed.
 * 3. Verify this is a global install (only that layout can be replaced in place).
 * 4. Snapshot runtime state, then run `npm install -g <pkg>@<latest>` from a
 *    neutral cwd (home dir) so npm can freely swap the package directory the
 *    currently running process executes from.
 * 5. Regenerate the ecosystem config and restart active runtimes using the
 *    new code — the published package ships a pre-built dist/, so there is
 *    no local TypeScript build step.
 */
async function runNpmUpdateFlow() {
    log('Detected npm package installation. Checking npm registry for updates...');

    const pkgName = readPackageName(PATHS.PROJECT_ROOT);
    const currentVersion = readPackageVersion(PATHS.PROJECT_ROOT);
    if (!currentVersion) {
        throw new Error(`Could not read a version from package.json at ${PATHS.PROJECT_ROOT}.`);
    }
    log(`Current installed version: ${currentVersion}`);

    // Verify the npm CLI is available and this is a genuine global install
    // BEFORE querying the registry. Only a global layout can be replaced in
    // place by `npm install -g`; a local (project) dependency must be updated
    // from its own package tree instead.
    const globalRoot = getGlobalNpmRoot();
    if (!globalRoot) {
        throw new Error(
            'DEXBot2 auto-update requires the npm CLI with registry access (it runs `npm view` and ' +
            '`npm install -g`). npm could not be found on PATH or returned no global root. ' +
            'Install Node.js/npm or update the package manually.'
        );
    }
    if (!isDirectGlobalInstall(PATHS.PROJECT_ROOT, globalRoot)) {
        // A genuine local (non-global) dependency resolves to a different real
        // parent; a symlinked prefix or version-manager/pnpm store lands the
        // package somewhere `npm root -g` does not point at. Either way the
        // package cannot be swapped in place.
        throw new Error(
            'DEXBot2 is installed at ' + PATHS.PROJECT_ROOT + ' but `npm root -g` reports ' + globalRoot + '. ' +
            'Auto-update cannot replace the package in place; the install root differs from `npm root -g` ' +
            '(a symlinked prefix, pnpm/yarn global store, or a different Node version manager prefix). ' +
            'Run `npm update ' + pkgName + '` in the parent project directory, or fix the mismatch and re-run `dexbot update`.'
        );
    }

    const latestVersion = getNpmLatestVersion(pkgName);
    log(`Latest published version: ${latestVersion}`);

    if (compareVersions(currentVersion, latestVersion) >= 0) {
        log('DEXBot2 is already up to date (installed version matches or exceeds the latest published version).');
        process.exit(0);
    }

    log(`${currentVersion} -> ${latestVersion} update available. Proceeding with npm update...`);

    // Snapshot pre-update runtime state BEFORE npm replaces the package files.
    const snapshot = snapshotMonolithicState();

    // Run from a neutral cwd: npm's reify swaps the package directory this
    // process is executing from, so the working directory may briefly not exist.
    runIn(homedir(), `npm install -g ${pkgName}@${latestVersion}`);

    // Post-install sanity checks: the published package is pre-built, so a
    // successful `npm install -g` MUST leave the requested version and a
    // usable dist/ bundle behind. Refuse to restart runtimes against a broken
    // install (mirrors the git flow's staleness guard).
    const installedAfter = readPackageVersion(PATHS.PROJECT_ROOT);
    log(`Installed version after update: ${installedAfter || 'unknown'}`);
    if (!installedAfter) {
        throw new Error(
            `Update completed but the package version could not be read at ${PATHS.PROJECT_ROOT}. ` +
            `The global install may be broken; inspect it with \`npm ls -g ${pkgName}\`.`
        );
    }
    if (compareVersions(installedAfter, latestVersion) < 0) {
        throw new Error(
            `Update completed but the installed version (${installedAfter}) is older than the requested ` +
            `${latestVersion}. Run \`npm install -g ${pkgName}@${latestVersion}\` manually and inspect the npm output.`
        );
    }

    // Verify the pre-built bundle is complete. Published packages ship a
    // pre-built dist/, so a missing file here means the publish is broken and
    // restarting runtimes against it would strand them on a dead install.
    // Shares the required-entry list with the git flow's freshness check.
    const missingDist = findMissingDistEntries(PATHS.PROJECT_ROOT, BUILD_DIR);
    if (missingDist.length > 0) {
        throw new Error(
            `Update completed but ${BUILD_DIR}/ is missing required files (${missingDist.join(', ')}). ` +
            `The published package appears to ship no pre-built bundle; refusing to restart runtimes against ` +
            `a broken install.`
        );
    }
    log(`${BUILD_DIR}/ verified after update.`);

    await regenerateEcosystemConfig();
    await restartActiveRuntimes(snapshot);
}

(async () => {
try {
    // Change to project root for all git operations
    process.chdir(PATHS.PROJECT_ROOT);
    log('Starting DEXBot2 update process...');

    /**
     * STEP 0: Detect Installation Layout
     *
     * Two supported layouts:
     * 1. Git checkout (has a .git dir) -> git pull + npm install + build
     * 2. Global npm package install (path under a node_modules tree) ->
     *    `npm install -g <pkg>@<latest>` (pre-built dist, no local build)
     *
     * A git checkout wins over the npm path so a repo that was npm-linked is
     * still updated through git. Neither layout -> fail with a clear message.
     */
    const isGitRepo = fs.existsSync(path.join(PATHS.PROJECT_ROOT, '.git'));
    const isNpmInstall = isGlobalNpmPackageDir(PATHS.PROJECT_ROOT);

    if (!isGitRepo && isNpmInstall) {
        await runNpmUpdateFlow();
        logSuccess('DEXBot2 update completed successfully.');
        process.exit(0);
    }

    if (!isGitRepo) {
        throw new Error(
            'DEXBot2 is neither a git checkout nor an npm package install. ' +
            'Auto-update is not available for this installation.'
        );
    }

    // Get configured repository URL and target branch
    const repoUrl = UPDATER.REPOSITORY_URL;
    let branch = UPDATER.BRANCH;

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
     *    - Action: Switch branch if needed, then exit cleanly — unless dist/
     *      is stale or incomplete, in which case rebuild and restart so a
     *      bundle that never got built is not preserved forever
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
        // `git` never reconciles dist/ (it is gitignored); only the build does.
        // If a source update bypassed the build (a manual pull/checkout, or a
        // tsc run that skipped outputs via its incremental cache), the bundle
        // lags its sources indefinitely while every later run reports
        // "up to date". Detect that and self-heal instead of exiting stale.
        const dist = inspectDistBundle(PATHS.PROJECT_ROOT, BUILD_DIR);
        if (dist.needsRebuild) {
            log(`Local source is current, but ${BUILD_DIR}/ ${dist.reason}. Rebuilding from source...`);
            const snapshot = snapshotMonolithicState();
            await buildAndRestartRuntimes({
                monolithicWasRunning: snapshot.monolithicWasRunning,
                hadMonolithicFiles: snapshot.hadMonolithicFiles,
                forceFull: true,
                successMessage: 'DEXBot2 rebuild completed successfully.',
            });
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
    const snapshot = snapshotMonolithicState();
    const monolithicWasRunning = snapshot.monolithicWasRunning;
    const hadMonolithicFiles = snapshot.hadMonolithicFiles;

    // Starting commit for the post-pull dep check (covers both branch
    // switch and pull — the decision itself still happens after).
    let preUpdateHead = '';
    try {
        preUpdateHead = execSync('git rev-parse HEAD', { stdio: 'pipe', cwd: PATHS.PROJECT_ROOT }).toString().trim();
    } catch (_) {}

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
    let lockRegenerated = false;
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
                    lockRegenerated = true;
                }
            }
        } catch (_) {}
    }

    /**
     * STEP 8: Reinstall Dependencies (only when needed)
     * Runs `npm install` when the pull touched package.json/package-lock.json,
     * when those files are dirty (stash-restored local edits), or when
     * node_modules is missing/incomplete. Otherwise skips — the build below
     * is what picks up pure .ts changes.
     * --ignore-scripts prevents npm from running the package `prepare` hook,
     * which would build once here before the explicit build step below.
     * --prefer-offline: Uses cached packages when possible
     */
    if (lockRegenerated) {
        log('Dependencies already regenerated after lockfile conflict — skipping npm install.');
    } else if (needsDepsInstall(preUpdateHead)) {
        log('Updating dependencies...');
        run('npm install --prefer-offline --ignore-scripts');
    } else {
        log('Dependencies unchanged — skipping npm install.');
    }

    /**
     * STEP 8b/8c/9: Build + verify, regenerate the ecosystem config, and restart
     * active runtimes. Shared with the stale-dist recovery path so both go
     * through the same freshness guard.
     *
     * Do NOT rely on the npm `prepare` hook: it only re-fires when package.json
     * changes, not when only .ts files do. After a pull that touches only .ts,
     * `npm install` is skipped (STEP 8) and `tsc` would never run, leaving the
     * running bot on a stale dist/ with no error surfaced. `buildAndRestartRuntimes`
     * runs the explicit build and aborts before restarting if the bundle is
     * still incomplete or stale.
     */
    await buildAndRestartRuntimes({
        monolithicWasRunning,
        hadMonolithicFiles,
        forceFull: false,
        successMessage: 'DEXBot2 update completed successfully.',
    });
} catch (err: any) {
    console.error(updateError('=========================================='));
    console.error(updateError('UPDATE FAILED'));
    console.error(updateError(`Error: ${getErrorMessage(err)}`));
    console.error(updateError('=========================================='));
    process.exit(1);
}
})();
