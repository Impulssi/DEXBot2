#!/usr/bin/env node
// node-only entry point — PM2 process orchestration (spawn, exec, fs, os)
/**
 * pm2.ts - PM2 Orchestration Launcher
 *
 * Unified PM2 launcher for DEXBot2 multi-bot system.
 * One-command startup with all setup required before starting bots.
 * Handles process management, configuration generation, and daemon startup.
 *
 * ===============================================================================
 * COMMANDS
 * ===============================================================================
 *
 * dexbot pm2                       - Default: unlock keystore and start all bots
 * dexbot pm2 <bot>                 - Unlock keystore and start specific bot
 * dexbot pm2 claw-only             - Credential daemon only, managed by PM2
 * dexbot pm2 update                - Run the update script immediately
 * dexbot pm2 stop all              - Stop all dexbot PM2 processes
 * dexbot pm2 stop <bot-name>       - Stop specific bot process
 * dexbot pm2 delete all            - Delete all dexbot processes from PM2
 * dexbot pm2 delete <bot-name>     - Delete specific bot from PM2
 * dexbot pm2 restart all           - Restart managed apps; re-unlock dexbot-cred only if needed
 * dexbot pm2 restart <target>      - Restart a bot or safely re-unlock dexbot-cred

 * dexbot pm2 --headless            - Non-interactive unlock with env var
 * dexbot pm2 --headless --password-file <path>
 *                                - Non-interactive unlock with password file
 * dexbot pm2 help                  - Show help message
 *
 * Repo-root users can run `./pm2` instead.
 *
 * ===============================================================================
 * SETUP SEQUENCE
 * ===============================================================================
 *
 * Step 0: BITSHARES CONNECTION VERIFICATION
 *    - Waits for BitShares blockchain network connection
 *    - Suppresses debug output to keep terminal clean
 *    - Validates node availability before proceeding
 *
 * Step 1: PM2 INSTALLATION CHECK
 *    - Detects local and global PM2 installations
 *    - Prompts to install PM2 if missing
 *    - Validates PM2 is available before proceeding
 *
 * Step 2: ECOSYSTEM CONFIGURATION GENERATION
 *    - Reads bot definitions from profiles/bots.json for bot mode
 *    - Generates profiles/ecosystem.config.js with absolute paths
 *    - Filters only active bots (active !== false)
 *    - If bot-name provided, filters to only that bot
 *    - In claw-only mode, generates only the credential daemon app
 *    - Each bot configured with:
 *      * Unique app name
 *      * Log file paths
 *      * Restart/memory policies
 *
 * Step 3: AUTHENTICATION & CLEANUP
 *    - Cleans up stale daemon socket files
 *    - Prompts interactively for the unlock secret once at startup
 *    - Authenticates against profiles/keys.json
 *    - Uses a one-shot local bootstrap channel for credential-daemon only
 *
 * Step 4: PM2 DAEMON STARTUP
 *    - Starts PM2 daemon if not already running
 *    - Waits for PM2 to be ready
 *    - Starts each configured bot as PM2 app
 *    - Credential daemon is started as a PM2 app after one-shot bootstrap
 *    - Bots request private keys from credential daemon via Unix socket
 */


import { setUmask } from './modules/config';
import { path } from './modules/path_api';
import { spawn, execSync } from 'node:child_process';
import { parseJsonWithComments } from './modules/order/utils/system';
import { readBotsFileWithLock } from './modules/bots_file_lock';
import { loadSettingsFile, selectActiveBotEntries } from './modules/bot_settings';
import * as chainKeys from './modules/chain_keys';
import * as credentialPolicy from './modules/credential_policy';
import { readHeadlessPassword } from './modules/launcher/headless_password';
import { buildScopedChildEnv } from './modules/launcher/child_env';
import { createPasswordBootstrapServer } from './modules/launcher/credential_bootstrap';
import { parsePm2Args } from './modules/launcher/launch_modes';
import { setupGracefulShutdown } from './modules/graceful_shutdown';
import { UPDATER, TIMING } from './modules/constants';
import { PATHS } from './modules/paths';
import { isDistCodeRoot, buildRuntimeScriptPath } from './modules/launcher/runtime_entry';
import { getStorage } from './modules/storage';
import { ensureDir, safeUnlink } from './modules/utils/fs_utils';
import { Config } from './modules/config';
import { waitForConnected } from './modules/bitshares_client';
import * as readline from 'node:readline';
import { getErrorMessage } from './modules/utils/errors';
setUmask(0o077);

const {
    ensureCredentialRuntimeDirSync,
    getCredentialReadyFilePath,
    getCredentialSocketPath,
} = require('./modules/credential_runtime');
const storage = getStorage();

// Setup graceful shutdown handlers
setupGracefulShutdown();

const PM2_COLORS = {
    reset: '\x1b[0m',
    ok: '\x1b[1;92m',
    error: '\x1b[1;31m',
};

function colorPm2Output(text: string, color: string, stream: any = process.stdout): string {
    return stream.isTTY && !Config.NO_COLOR
        ? `${color}${text}${PM2_COLORS.reset}`
        : text;
}

function pm2Success(text: string): string {
    return colorPm2Output(text, PM2_COLORS.ok);
}

function pm2Error(text: string): string {
    return colorPm2Output(text, PM2_COLORS.error, process.stderr);
}

const CODE_ROOT = __dirname;
const BOTS_JSON = PATHS.PROFILES.BOTS_JSON;
const ECOSYSTEM_FILE = PATHS.PROFILES.ECOSYSTEM_CONFIG_JS;
const POLICY_CONFIG_FILE = PATHS.PROFILES.DAEMON_POLICIES_JSON;
const LOGS_DIR = PATHS.LOGS_DIR;
const CREDENTIAL_DAEMON_APP_NAME = 'dexbot-cred';
const CREDENTIAL_SOCKET_PATH = getCredentialSocketPath({ root: PATHS.PROJECT_ROOT });
const CREDENTIAL_READY_FILE = getCredentialReadyFilePath({ root: PATHS.PROJECT_ROOT });

function runtimeScript(...segments: string[]) {
    return path.join(CODE_ROOT, ...segments);
}

function usesAmaGridPrice(bot: any) {
    const gridPrice = typeof bot?.gridPrice === 'string' ? bot.gridPrice.trim().toLowerCase() : '';
    return /^ama(?:[1-4])?$/.test(gridPrice);
}

function needsMarketAdapter(bots: any) {
    return (bots || []).some((bot: any) => usesAmaGridPrice(bot));
}

function isServiceApp(app: any) {
    const name = String(app?.name || '');
    return name === 'dexbot-update' || name === CREDENTIAL_DAEMON_APP_NAME || name === 'dexbot-adapter';
}

function countManagedBots(apps: any) {
    return (apps || []).filter((app: any) => !isServiceApp(app)).length;
}

function isPm2TableLine(line: any) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return true;
    return /^[┌┬│├┤└┴─\s]+$/.test(trimmed) || /^[┌┬│├┤└┴]/.test(trimmed);
}

function transformPm2Line(line: any) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return null;
    if (isPm2TableLine(trimmed)) return null;
    if (/^\[PM2\] Starting\b/.test(trimmed)) return null;
    if (trimmed === '[PM2] Done.') return null;
    if (/^\[PM2\] cron restart at /.test(trimmed)) return null;
    if (/^\[PM2\]\[WARN\] Applications .* not running, starting\.\.\.$/.test(trimmed)) return null;
    if (/^\[PM2\] Applying action /.test(trimmed)) return null;
    return trimmed.replace(/\s+\(\d+ instances?\)$/, '');
}

function flushPm2Buffer(buffer: any, writer: any, { final = false }: { final?: boolean } = {}) {
    if (!buffer) return '';
    const lines = buffer.split(/\r?\n/);
    const trailing = lines.pop();
    for (const line of lines) {
        const transformed = transformPm2Line(line);
        if (transformed) writer(transformed);
    }
    if (final && trailing && trailing.trim()) {
        const transformed = transformPm2Line(trailing);
        if (transformed) writer(transformed);
        return '';
    }
    return trailing || '';
}

/**
 * Build PM2 app definitions for the current runtime.
 * @param {Array<Object>} bots - Active bot entries.
 * @param {Object} [options] - Build options.
 * @param {boolean} [options.includeUpdater=true] - Whether to add the updater service.
 * @returns {Array<Object>} PM2 app definitions.
 */
function buildEcosystemApps(bots: any, { includeUpdater = true }: { includeUpdater?: boolean } = {}) {
    const apps = (bots || []).map((bot: any, index: number) => {
        const botName = bot.name || `bot-${index}`;
        return {
            name: botName,
            script: buildRuntimeScriptPath(CODE_ROOT, ['bot']),
            args: botName,
            cwd: PATHS.PROJECT_ROOT,
            max_memory_restart: '250M',
            watch: false,
            autorestart: true,
            error_file: path.join(LOGS_DIR, `${botName}-error.log`),
            out_file: path.join(LOGS_DIR, `${botName}.log`),
            log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
            merge_logs: false,
            combine_logs: true,
            max_size: '100M',
            max_restarts: 13,
            min_uptime: 86400000,
            restart_delay: 3000
        };
    });

    if (needsMarketAdapter(bots)) {
        apps.unshift({
            name: 'dexbot-adapter',
            script: buildRuntimeScriptPath(CODE_ROOT, ['market_adapter', 'market_adapter']),
            cwd: PATHS.PROJECT_ROOT,
            watch: false,
            autorestart: true,
            max_memory_restart: '150M',
            error_file: path.join(LOGS_DIR, 'dexbot-adapter-error.log'),
            out_file: path.join(LOGS_DIR, 'dexbot-adapter.log'),
            log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
            merge_logs: false,
            combine_logs: true,
            max_size: '100M',
            max_restarts: 13,
            min_uptime: 60000,
            restart_delay: 3000,
            ...(isDistCodeRoot(CODE_ROOT) ? {} : { node_args: ['--import', 'tsx'] })
        });
    }

    if (includeUpdater && UPDATER.ACTIVE) {
        apps.push({
            name: "dexbot-update",
            script: runtimeScript('scripts', 'update.js'),
            cwd: PATHS.PROJECT_ROOT,
            autorestart: false,
            cron_restart: UPDATER.SCHEDULE,
            error_file: path.join(LOGS_DIR, `dexbot-update-error.log`),
            out_file: path.join(LOGS_DIR, `dexbot-update.log`),
            log_date_format: "YY-MM-DD HH:mm:ss.SSS",
            max_size: '100M'
        });
    }

    return apps;
}

function buildCredentialDaemonApp({ credentialEnv = {} }: { credentialEnv?: any } = {}) {
    return {
        name: CREDENTIAL_DAEMON_APP_NAME,
        script: runtimeScript('credential-daemon.js'),
        cwd: PATHS.PROJECT_ROOT,
        autorestart: false,
        error_file: path.join(LOGS_DIR, 'dexbot-cred-error.log'),
        out_file: path.join(LOGS_DIR, 'dexbot-cred.log'),
        log_date_format: 'YY-MM-DD HH:mm:ss.SSS',
        merge_logs: false,
        combine_logs: true,
        max_size: '100M',
        env: {
            DEXBOT_CRED_DAEMON_SOCKET: CREDENTIAL_SOCKET_PATH,
            DEXBOT_CRED_DAEMON_READY_FILE: CREDENTIAL_READY_FILE,
            ...credentialEnv,
        }
    };
}

/**
 * Generate ecosystem.config.js from bots.json or claw-only mode.
 * @param {Object} [options={}] - Generation options.
 * @param {string|null} [options.botNameFilter=null] - Optional bot name to filter by.
 * @param {boolean} [options.clawOnly=false] - Generate no managed bot apps.
 * @param {boolean} [options.exitOnError=true] - If true, calls process.exit(1) instead of throwing
 * @returns {Array<Object>} The generated app configurations.
 */
function generateEcosystemConfig({ botNameFilter = null, clawOnly = false, exitOnError = true }: { botNameFilter?: string | null; clawOnly?: boolean; exitOnError?: boolean } = {}) {
    function fail(message: any) {
        if (exitOnError) {
            console.error(pm2Error(String(message)));
            process.exit(1);
        }
        throw new Error(message);
    }

    // Ensure logs directory exists
    if (!storage.exists(LOGS_DIR)) {
        ensureDir(LOGS_DIR);
    }

    try {
        if (clawOnly) {
            const appsClaw: any[] = [];
            const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: dexbot pm2 or node dist/dexbot.js pm2
export default { apps: ${JSON.stringify(appsClaw, null, 2)} }
`;

            storage.writeFile(ECOSYSTEM_FILE, ecosystemContent);
            return appsClaw;
        }

        if (!storage.exists(BOTS_JSON)) {
            fail('profiles/bots.json not found. Run: dexbot bot');
        }

        const { config } = loadSettingsFile(BOTS_JSON, { exitOnError });
        const bots = selectActiveBotEntries(config);

        if (botNameFilter) {
            const filtered = bots.filter((b: any) => b.name === botNameFilter);
            if (filtered.length === 0) {
                fail(`Bot '${botNameFilter}' not found or not active in profiles/bots.json`);
            }
            const apps = buildEcosystemApps(filtered, { includeUpdater: false });
            const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: dexbot pm2 or node dist/dexbot.js pm2
module.exports = { apps: ${JSON.stringify(apps, null, 2)} };
`;

            storage.writeFile(ECOSYSTEM_FILE, ecosystemContent);
            return apps;
        }

        if (bots.length === 0) {
            fail('No active bots found in profiles/bots.json');
        }

        const apps = buildEcosystemApps(bots, { includeUpdater: true });

        const ecosystemContent = `// Auto-generated by pm2.js - DO NOT EDIT
// Regenerate with: dexbot pm2 or node dist/dexbot.js pm2
module.exports = { apps: ${JSON.stringify(apps, null, 2)} };
`;

        storage.writeFile(ECOSYSTEM_FILE, ecosystemContent);
        return apps;
    } catch (err: any) {
        fail(`Error reading bots.json: ${getErrorMessage(err)}`);
    }
}

async function runManagedAppsPm2Action(action: any, { regenerate = false }: { regenerate?: boolean } = {}) {
    if (regenerate) {
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
    }
    if (!storage.exists(ECOSYSTEM_FILE)) {
        return false;
    }
    return execPM2CommandIgnoreMissing(action, ECOSYSTEM_FILE);
}

function cleanupStaleCredentialDaemonFiles() {
    try {
        safeUnlink(CREDENTIAL_SOCKET_PATH)
        safeUnlink(CREDENTIAL_READY_FILE)
    } catch (e) {
        // Socket files already cleaned, that's fine
    }
}

async function ensureCredentialDaemonPM2({ forceRefresh = false, headless = false, passwordFile = null }: {
    forceRefresh?: boolean;
    logReuse?: any;
    headless?: boolean;
    passwordFile?: string | null;
} = {}) {
    ensureCredentialRuntimeDirSync({ root: PATHS.PROJECT_ROOT, socketPath: CREDENTIAL_SOCKET_PATH, readyFilePath: CREDENTIAL_READY_FILE });
    credentialPolicy.ensurePolicyConfig(POLICY_CONFIG_FILE);
    const daemonReady = await chainKeys.isDaemonResponsive({
        socketPath: CREDENTIAL_SOCKET_PATH,
        readyFilePath: CREDENTIAL_READY_FILE,
    });

    if (daemonReady && !forceRefresh) {
        return false;
    }

    if (!daemonReady) {
        cleanupStaleCredentialDaemonFiles();
    }

    let bootstrap: any = null;
    try {
        let vaultSecret;

        if (headless) {
            vaultSecret = chainKeys.unlockWithPassword(readHeadlessPassword({ passwordFile }));
        } else {
            vaultSecret = await chainKeys.authenticate();
        }

        bootstrap = await createPasswordBootstrapServer({ secret: vaultSecret });
        console.log(pm2Success('✓ Authentication successful'));
        await startManagedRuntimePM2({ apps: [], bootstrap });
        return true;
    } catch (error: any) {
        if (bootstrap) bootstrap.close();
        throw error;
    }
}

async function assertActiveBotTarget(target: any) {
    try {
        const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
        const botExists = selectActiveBotEntries(config).some((b: any) => b.name === target);
        if (!botExists) {
            throw new Error(`Bot '${target}' not found or not active in profiles/bots.json`);
        }
    } catch (err: any) {
        if (String(err && getErrorMessage(err) || '').includes('not found or not active')) {
            throw err;
        }
        throw new Error(`Failed to read bots configuration: ${getErrorMessage(err)}`);
    }
}

/**
 * Main application entry point for PM2 orchestration.
 * @param {Object} [options={}] - Launcher options.
 * @param {string|null} [options.botNameFilter=null] - Optional bot name to start.
 * @param {boolean} [options.clawOnly=false] - Start the credential daemon only.
 * @returns {Promise<void>}
 */
async function main({ botNameFilter = null, clawOnly = false, headless = false, passwordFile = null }: {
    botNameFilter?: string | null;
    clawOnly?: boolean;
    headless?: boolean;
    passwordFile?: string | null;
} = {}) {
    if (typeof chainKeys.checkKeysFileSecurity === 'function') chainKeys.checkKeysFileSecurity();
    if (typeof credentialPolicy.checkPolicyFileSecurity === 'function') credentialPolicy.checkPolicyFileSecurity(PATHS.PROFILES.DAEMON_POLICIES_JSON);

    console.log('='.repeat(50));
    console.log('DEXBot2 PM2 Launcher');
    if (clawOnly) {
        console.log('Starting credential daemon only');
    }
    if (botNameFilter) {
        console.log(`Starting bot: ${botNameFilter}`);
    }
    if (headless) {
        console.log('Mode: headless (non-interactive password)');
    }
    console.log('='.repeat(50));
    console.log();

    if (!clawOnly) {
        // Step 0: Wait for BitShares connection (suppress BitShares client logs)

        // Suppress BitShares console output during connection
        const originalLog = console.log;
        try {
            console.log = (...args) => {
                // Only suppress BitShares-specific messages
                const msg = args.join(' ');
                if (!msg.includes('bitshares_client') && !msg.includes('modules/')) {
                    originalLog(...args);
                }
            };

            await waitForConnected(TIMING.CONNECTION_TIMEOUT_MS);
        } finally {
            // Always restore console output, even if waitForConnected throws
            console.log = originalLog;
        }

        console.log(pm2Success('Connected to BitShares'));
    } else {
        console.log();
    }

    // Step 1: Check PM2
    if (!checkPM2Installed()) {
        console.error(pm2Error('PM2 is not installed'));
        await installPM2();
    }

    // Step 2: Ensure credential daemon availability
    try {
        await ensureCredentialDaemonPM2({ headless, passwordFile });
    } catch (error: any) {
        console.error(pm2Error(`\n❌ ${getErrorMessage(error)}`));
        process.exit(1);
    }

    // Step 3: Generate ecosystem config
    const apps = generateEcosystemConfig({
        botNameFilter,
        clawOnly,
    });
    const botCount = countManagedBots(apps);
    console.log(`Number active bots: ${botCount}`);
    console.log();

    // Step 4: Start PM2
    console.log(clawOnly ? 'Starting PM2 with credential daemon only...' : 'Starting PM2 with all services...');
    await startManagedAppsPM2(apps);

    console.log();
    console.log('='.repeat(50));
    console.log(pm2Success('DEXBot2 started successfully!'));
    console.log('If dexbot-cred stops, rerun `dexbot pm2` to unlock it again.');
    console.log('='.repeat(50));
    console.log();
}

function startPM2Process(args: any, env: any = buildScopedChildEnv()) {
    return new Promise((resolve, reject) => {
        const pm2 = spawn('pm2', args, {
            cwd: PATHS.PROJECT_ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            shell: process.platform === 'win32'
        });

        let stdoutBuffer = '';
        let stderrBuffer = '';

        pm2.stdout.on('data', (data: any) => {
            stdoutBuffer += data.toString();
            stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line: any) => console.log(line));
        });

        pm2.stderr.on('data', (data: any) => {
            stderrBuffer += data.toString();
            stderrBuffer = flushPm2Buffer(stderrBuffer, (line: any) => console.error(line));
        });

        pm2.on('close', (code: any) => {
            stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line: any) => console.log(line), { final: true });
            stderrBuffer = flushPm2Buffer(stderrBuffer, (line: any) => console.error(line), { final: true });
            if (code === 0) {
                // Ensure we disconnect from PM2's file descriptors
                setImmediate(resolve);
            } else {
                reject(new Error(`PM2 exited with code ${code}`));
            }
        });

        pm2.on('error', reject);
    });
}

function startManagedAppsPM2(apps: any) {
    if (!apps || apps.length === 0) {
        return Promise.resolve();
    }
    return startPM2Process(['start', ECOSYSTEM_FILE]);
}

function startCredentialDaemonPM2({ credentialEnv = {} }: { credentialEnv?: any } = {}) {
    const app = buildCredentialDaemonApp({ credentialEnv });
    const args = [
        'start',
        app.script,
        '--name', app.name,
        '--cwd', app.cwd,
        '--output', app.out_file,
        '--error', app.error_file,
        '--log-date-format', app.log_date_format,
        '--no-autorestart',
    ];
    return startPM2Process(args, buildScopedChildEnv({ extra: app.env }))
        .then(() => {
            console.log(`[PM2] App [${CREDENTIAL_DAEMON_APP_NAME}] launched`);
        });
}

async function startManagedRuntimePM2({ apps, bootstrap }: { apps?: any; bootstrap?: any } = {}) {
    if (bootstrap) {
        await execPM2CommandIgnoreMissing('delete', CREDENTIAL_DAEMON_APP_NAME);

        // Write the bootstrap socket path to a stable file in the runtime dir.
        // The credential daemon reads this file instead of relying on a
        // PM2-persisted env var.  Once consumed the file is deleted, so a
        // future `pm2 restart dexbot-cred` or `pm2 resurrect` will not
        // find it and will fall through to interactive auth.
        const bootstrapPathFile = path.join(
            path.dirname(CREDENTIAL_SOCKET_PATH),
            '.dexbot-cred-bootstrap-path'
        );
        try {
            storage.writeFile(bootstrapPathFile, bootstrap.socketPath, { mode: 0o600 });
        } catch (err: any) {
            throw new Error(
                `Cannot write bootstrap path file at ${bootstrapPathFile}: ${getErrorMessage(err)}. ` +
                `The daemon needs this file to find the bootstrap socket.`
            );
        }

        // Start the daemon WITHOUT DEXBOT_CRED_BOOTSTRAP_SOCKET so PM2 never
        // persists the one-shot temp socket path.
        const daemonEnv = {
            DEXBOT_CRED_DAEMON_SOCKET: CREDENTIAL_SOCKET_PATH,
            DEXBOT_CRED_DAEMON_READY_FILE: CREDENTIAL_READY_FILE,
            DEXBOT_CRED_BOOTSTRAP_PATH_FILE: bootstrapPathFile,
        };
        await startCredentialDaemonPM2({ credentialEnv: daemonEnv });
        await Promise.all([
            bootstrap.waitForTransfer(),
            chainKeys.waitForDaemon(TIMING.DAEMON_STARTUP_TIMEOUT_MS, {
                socketPath: CREDENTIAL_SOCKET_PATH,
                readyFilePath: CREDENTIAL_READY_FILE,
            }),
        ]);
    }

    await startManagedAppsPM2(apps);
}

/**
 * Check if PM2 is installed locally or globally.
 * @returns {boolean} True if PM2 is found.
 */
function checkPM2Installed() {
    try {
        require.resolve('pm2');
        return true;
    } catch (e) {
        // Check if pm2 is available in PATH
        try {
            execSync('pm2 --version', { stdio: 'ignore' });
            return true;
        } catch (err) {
            return false;
        }
    }
}

/**
 * Prompt the user to install PM2 globally.
 * @returns {Promise<void>}
 */
async function installPM2() {

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise<void>((resolve, reject) => {
        rl.question('PM2 is not installed. Install now? (Y/n): ', (answer: any) => {
            rl.close();

            if (answer.toLowerCase() === 'n') {
                console.log('PM2 installation cancelled. Run: npm install -g pm2');
                process.exit(1);
            }

            console.log('Installing PM2...');

            // Helper to run installation command
            const runInstall = (command: any, args: any) => {
                return new Promise<void>((res, rej) => {
                    const proc = spawn(command, args, {
                        stdio: 'inherit',
                        shell: process.platform === 'win32'
                    });
                    proc.on('close', (code: any) => {
                        if (code === 0) res();
                        else rej(code);
                    });
                    proc.on('error', (err: any) => rej(err));
                });
            };

            // Try standard install first
            runInstall('npm', ['install', '-g', 'pm2'])
                .then(() => {
                    console.log(pm2Success('PM2 installed successfully!'));
                    resolve();
                })
                .catch((_err: any) => {
                    // If failed and not on Windows, try sudo
                    if (process.platform !== 'win32') {
                        console.log('\nStandard installation failed (likely permissions). Trying with sudo...');
                        console.log('This covers Linux and macOS. Please enter your password if prompted:');

                        runInstall('sudo', ['npm', 'install', '-g', 'pm2'])
                            .then(() => {
                                console.log(pm2Success('PM2 installed successfully with sudo!'));
                                resolve();
                            })
                            .catch((_finalErr: any) => {
                                reject(new Error('PM2 installation failed even with sudo'));
                            });
                    } else {
                        // Windows handling
                        console.log('\nStandard installation failed (likely permissions).');
                        console.log('Attempting to install with Administrator privileges...');
                        console.log('Please accept the UAC dialog to proceed.');

                        // Run npm install in a new elevated window
                        // We use timeout so the user can see the result before window closes
                        const psCommand = "Start-Process cmd -ArgumentList '/c npm install -g pm2 & echo. & echo Installation complete. Closing in 5 seconds... & timeout /t 5' -Verb RunAs -Wait";

                        runInstall('powershell', ['-Command', psCommand])
                            .then(() => {
                                // Verify installation succeeded since we can't easily get the exit code from the elevated process
                                if (checkPM2Installed()) {
                                    console.log(pm2Success('PM2 installed successfully (Elevated)!'));
                                    resolve();
                                } else {
                                    reject(new Error('PM2 installation failed or was cancelled in the elevated window.'));
                                }
                            })
                            .catch((_winErr: any) => {
                                console.error(pm2Error('\nFailed to elevate permissions.'));
                                console.error(pm2Error('Please manually run "npm install -g pm2" as Administrator.'));
                                reject(new Error('PM2 installation failed.'));
                            });
                    }
                });
        });
    });
}

/**
 * Execute a PM2 command safely.
 * @param {string} action - PM2 action (start, stop, etc.).
 * @param {string} [target] - The target process name or configuration file.
 * @param {Object} [options] - Execution options
 * @param {boolean} [options.suppressStderrOnError=false] - Suppress stderr on failure
 * @param {boolean} [options.silent=false] - Suppress stdout output
 * @returns {Promise<Object>} Command result.
 * @throws {Error} If action is invalid or command fails.
 */
async function execPM2Command(action: any, target: any, { suppressStderrOnError = false, silent = false }: { suppressStderrOnError?: boolean; silent?: boolean } = {}) {
    // Validate action to prevent injection
    const validActions = ['start', 'stop', 'delete', 'restart'];
    if (!validActions.includes(action)) {
        throw new Error(`Invalid PM2 action: ${action}`);
    }

    // Use spawn instead of shell to avoid injection vulnerabilities
    // spawn passes arguments as array, preventing shell interpretation
    return new Promise((resolve, reject) => {
        const args = [action];
        if (target) {
            args.push(target);
        }

        const pm2 = spawn('pm2', args, {
            stdio: 'pipe',
            shell: process.platform === 'win32'
        });

        let stdout = '';
        let stderr = '';
        let stdoutBuffer = '';

        pm2.stdout.on('data', (data: any) => {
            stdout += data.toString();
            if (!silent) {
                stdoutBuffer += data.toString();
                stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line: any) => console.log(line));
            }
        });

        pm2.stderr.on('data', (data: any) => {
            stderr += data.toString();
        });

        pm2.on('close', (code: any) => {
            if (!silent) {
                stdoutBuffer = flushPm2Buffer(stdoutBuffer, (line: any) => console.log(line), { final: true });
            }
            if (code === 0) {
                resolve({ success: true, stdout, stderr });
            } else {
                if (stderr && !suppressStderrOnError) console.error(stderr);
                reject(new Error(`PM2 command failed with code ${code}: ${stderr || stdout}`));
            }
        });

        pm2.on('error', reject);
    });
}

async function execPM2CommandIgnoreMissing(action: any, target: any, options: any = {}) {
    try {
        await execPM2Command(action, target, { suppressStderrOnError: true, ...options });
        return true;
    } catch (error: any) {
        const message = String(error && getErrorMessage(error) ? getErrorMessage(error) : error);
        if (message.includes('Process or Namespace') || message.includes('not found') || message.includes('does not exist')) {
            return false;
        }
        throw error;
    }
}

/**
 * Stop PM2 processes based on target.
 * @param {string} target - 'all' or specific bot name.
 * @returns {Promise<void>}
 * @throws {Error} If target not found or stopping fails.
 */
async function stopPM2Processes(target: any) {
    console.log(`Stopping PM2 processes: ${target}`);

    if (target === 'all') {
        console.log('');
        // Stop credential daemon first — it holds the only handle to keys.
        // If managed apps were stopped first they'd lose key access; this order
        // ensures the daemon is the last process released.
        await execPM2CommandIgnoreMissing('stop', CREDENTIAL_DAEMON_APP_NAME);
        if (storage.exists(ECOSYSTEM_FILE)) {
            await runManagedAppsPm2Action('stop');
        } else if (storage.exists(BOTS_JSON)) {
            try {
                await runManagedAppsPm2Action('stop', { regenerate: true });
            } catch (err: any) {
                console.warn(`Skipping managed bot stop: ${getErrorMessage(err)}`);
            }
        }
        console.log('');
        console.log('All dexbot PM2 processes stopped.');
        return;
    }

    if (target === CREDENTIAL_DAEMON_APP_NAME) {
        await execPM2CommandIgnoreMissing('stop', CREDENTIAL_DAEMON_APP_NAME);
        console.log(`PM2 process '${target}' stopped.`);
        return;
    }

    // Validate bot exists in configuration before stopping (with lock protection)
    try {
        const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
        const botExists = selectActiveBotEntries(config).some((b: any) => b.name === target);

        if (!botExists) {
            throw new Error(`Bot '${target}' not found or not active in profiles/bots.json`);
        }
    } catch (err: any) {
        throw new Error(`Failed to read bots configuration: ${getErrorMessage(err)}`);
    }

    // Stop specific bot by name
    await execPM2Command('stop', target);
    console.log(`PM2 process '${target}' stopped.`);
}

/**
 * Delete PM2 processes based on target.
 * @param {string} target - 'all' or specific bot name.
 * @returns {Promise<void>}
 * @throws {Error} If target not found or deleting fails.
 */
async function deletePM2Processes(target: any) {
    console.log(`Deleting PM2 processes: ${target}`);

    if (target === 'all') {
        console.log('');
        await execPM2CommandIgnoreMissing('delete', CREDENTIAL_DAEMON_APP_NAME);
        if (storage.exists(ECOSYSTEM_FILE)) {
            await runManagedAppsPm2Action('delete');
        } else if (storage.exists(BOTS_JSON)) {
            try {
                await runManagedAppsPm2Action('delete', { regenerate: true });
            } catch (err: any) {
                console.warn(`Skipping managed bot delete: ${getErrorMessage(err)}`);
            }
        }
        console.log('');
        console.log('All dexbot PM2 processes deleted.');
        return;
    } else {
        if (target === CREDENTIAL_DAEMON_APP_NAME) {
            await execPM2CommandIgnoreMissing('delete', CREDENTIAL_DAEMON_APP_NAME);
            console.log(`PM2 process '${target}' deleted.`);
            return;
        }

        // Validate bot exists in configuration before deleting (with lock protection)
        try {
            const { config } = await readBotsFileWithLock(BOTS_JSON, parseJsonWithComments);
            const botExists = selectActiveBotEntries(config).some((b: any) => b.name === target);

            if (!botExists) {
                throw new Error(`Bot '${target}' not found or not active in profiles/bots.json`);
            }
        } catch (err: any) {
            throw new Error(`Failed to read bots configuration: ${getErrorMessage(err)}`);
        }

        // Delete specific bot by name
        await execPM2Command('delete', target);
        console.log(`PM2 process '${target}' deleted.`);
    }
}

async function restartPM2Processes(target: any, { headless = false, passwordFile = null }: { headless?: boolean; passwordFile?: string | null } = {}) {
    console.log(`Restarting PM2 processes: ${target}`);

    if (target === 'all') {
        generateEcosystemConfig({ clawOnly: false, exitOnError: false });
        await ensureCredentialDaemonPM2({ logReuse: false, headless, passwordFile });
        await runManagedAppsPm2Action('restart');
        console.log('Managed dexbot PM2 apps restarted. dexbot-cred was left on the safe wrapper path.');
        return;
    }

    if (target === CREDENTIAL_DAEMON_APP_NAME) {
        await ensureCredentialDaemonPM2({ forceRefresh: true, logReuse: false, headless, passwordFile });
        console.log(`Credential daemon '${target}' restarted with a fresh unlock.`);
        return;
    }

    await assertActiveBotTarget(target);
    await ensureCredentialDaemonPM2({ logReuse: false, headless, passwordFile });
    await execPM2Command('restart', target);
    console.log(`PM2 process '${target}' restarted.`);
}

/**
 * Show help text for PM2 CLI usage.
 */
function showPM2Help() {
    console.log(`
Usage: dexbot pm2 [--headless] [--password-file <path>] [<target>]

Commands:
  (default)                 Unlock keystore and start all bots with PM2
  claw-only                 Start only the credential daemon with PM2
  update                    Run the update script immediately
  stop <bot-name|all>       Stop PM2 process(es) - only dexbot processes
  delete <bot-name|all>     Delete PM2 process(es) - only dexbot processes
  restart <bot-name|all|dexbot-cred>
                            Restart managed apps safely; dexbot-cred uses fresh unlock flow
  help                      Show this help message

Flags:
  --headless                Non-interactive unlock (requires DEXBOT_MASTER_PASSWORD env var
                            or --password-file)
  --password-file <path>    Read master password from file (first line)

Examples:
  dexbot pm2                       # Start all bots (unlock + start)
  dexbot pm2 claw-only             # Start only the credential daemon
  dexbot pm2 <bot-name>           # Start a single bot
  dexbot pm2 --headless            # Start all bots (non-interactive)
  dexbot pm2 --password-file /run/secrets/bot-password
                                   # Start all bots with password from file
  dexbot pm2 stop all             # Stop all dexbot processes
  dexbot pm2 stop XRP-BTS         # Stop specific bot
  dexbot pm2 delete all           # Delete all dexbot processes from PM2
  dexbot pm2 delete XRP-BTS       # Delete specific bot from PM2
  dexbot pm2 restart all          # Safe restart path for managed apps
  dexbot pm2 restart dexbot-cred  # Re-unlock credential daemon

  dexbot pm2 help                 # Show help

Repo-root users can run \`./pm2\` instead.
    `);
}

// Run if called directly or via the root-level pm2.js shim
const isPm2DirectRun = require.main === module || (
    process.argv[1] &&
    path.basename(process.argv[1]).replace(/\.js$/, '') === 'pm2'
);
if (isPm2DirectRun) {
    // Parse command line arguments
    const { command, target, clawOnly, headless, passwordFile } = parsePm2Args(process.argv);

    (async () => {
        try {
            if (!command) {
                // Full setup: unlock, generate config, authenticate, start PM2
                // Optional: filter to specific bot if provided
                await main({ botNameFilter: target || null, clawOnly, headless, passwordFile });
                // Close stdin to prevent hanging
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } else if (command === 'claw-only') {
                await main({ clawOnly: true, headless, passwordFile });
                // Close stdin to prevent hanging
                if (process.stdin) process.stdin.destroy();
                process.exit(0);
            } else if (command === 'update') {
                const update = spawn(Config.EXEC_PATH, [runtimeScript('scripts', 'update.js')], { stdio: 'inherit' });
                update.on('close', (code: any) => process.exit(code));
            } else if (command === 'stop') {
                if (!target) {
                    console.error(pm2Error('Error: Target required. Specify bot name or "all".'));
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await stopPM2Processes(target);
                    process.exit(0);
                } catch (err: any) {
                    console.error(pm2Error(`Failed to stop processes: ${getErrorMessage(err)}`));
                    process.exit(1);
                }
            } else if (command === 'delete') {
                if (!target) {
                    console.error(pm2Error('Error: Target required. Specify bot name or "all".'));
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await deletePM2Processes(target);
                    process.exit(0);
                } catch (err: any) {
                    console.error(pm2Error(`Failed to delete processes: ${getErrorMessage(err)}`));
                    process.exit(1);
                }
            } else if (command === 'restart') {
                if (!target) {
                    console.error(pm2Error('Error: Target required. Specify bot name, "dexbot-cred", or "all".'));
                    showPM2Help();
                    process.exit(1);
                }
                try {
                    await restartPM2Processes(target, { headless, passwordFile });
                    process.exit(0);
                } catch (err: any) {
                    console.error(pm2Error(`Failed to restart processes: ${getErrorMessage(err)}`));
                    process.exit(1);
                }
            } else if (command === 'help') {
                showPM2Help();
                process.exit(0);
            } else {
                console.error(pm2Error(`Unknown command: ${command}`));
                showPM2Help();
                process.exit(1);
            }
        } catch (err: any) {
            console.error(pm2Error(`Error: ${getErrorMessage(err)}`));
            process.exit(1);
        }
    })();
}

export = {
    buildCredentialDaemonApp,
    buildEcosystemApps,
    buildScopedChildEnv,
    countManagedBots,
    deletePM2Processes,
    ensureCredentialDaemonPM2,
    generateEcosystemConfig,
    isServiceApp,
    main,
    needsMarketAdapter,
    restartPM2Processes,
    stopPM2Processes,
    startManagedRuntimePM2,
    usesAmaGridPrice
};

