#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { dirname as _esmDirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _esmDirname(__filename);
// node-only entry point — credential daemon launcher (Unix socket, child_process, fs)
/**
 * unlock.ts - Credential Daemon Launcher
 *
 * Starts credential daemon with master password and launches the bot process.
 *
 * Default mode: daemonizes to background and auto-restarts on crash.
 * Use --foreground to run in terminal (no auto-restart).
 *
 * Usage:
 *   dexbot unlock                         Background + auto-restart (default)
 *   dexbot unlock --foreground            Terminal mode (no auto-restart)
 *   dexbot unlock claw-only
 *   dexbot unlock --claw-only
 *   dexbot unlock --isolated
 *   dexbot unlock --isolated <botName>
 *   dexbot unlock --dryrun
 *   dexbot unlock --dryrun <botName>
 *   dexbot unlock --headless              Non-interactive (requires env var or --password-file)
 *   dexbot unlock --headless --password-file <path>
 *   dexbot stat, status        Runtime status
 *   dexbot stop                Stop the monolithic runtime
 *   dexbot restart             Restart the monolithic runtime
 *   dexbot delete              Shut down and clean up
 *
 * Repo-root users can run `./unlock` instead.
 *
 * Environment:
 *   BOT_NAME                     Fallback bot name when none is given as positional arg
 *   DEXBOT_MASTER_PASSWORD       Master password for --headless mode (less secure than file)
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { setUmask } from './modules/config.js';
import fs from 'node:fs';
import { path } from './modules/path_api.js';
import { getStorage } from './modules/storage/index.js';
import { spawn } from 'node:child_process';
import { createCredentialDaemonController } from './modules/launcher/credential_daemon.js';
import { buildScopedChildEnv } from './modules/launcher/child_env.js';
import { parseUnlockArgs } from './modules/launcher/launch_modes.js';
import { UPDATER, LAUNCHER } from './modules/constants.js';
import { runtime } from './modules/runtime.js';
import { PATHS } from './modules/paths.js';
import { buildRuntimeScriptArgs } from './modules/launcher/runtime_entry.js';
import { sendControlCommand } from './modules/launcher/supervisor_control.js';
import { registerCleanup, setupGracefulShutdown } from './modules/graceful_shutdown.js';
import { normalizeBotEntry, resolveRawBotEntries, loadSettingsFile } from './modules/bot_settings.js';
import * as chainKeys from './modules/chain_keys.js';
import * as credentialPolicy from './modules/credential_policy.js';
import { getWhitelistFlags } from './modules/market_adapter_whitelist.js';
import { createMarketAdapterWatchdog } from './modules/launcher/market_adapter_watchdog.js';
import { isLikelyMarketAdapterProcess } from './modules/launcher/market_adapter_runtime.js';
import { Config } from './modules/config.js';
import { getErrorMessage } from './modules/utils/errors.js';
import { withTimeout } from './modules/order/utils/timeout.js';
setUmask(0o077);

const storage = getStorage();
const { ensureDir } = storage;
const {
    createBotSupervisor, SOCKET_PATH,
    forwardSignal, isPidAlive, waitForPidExit,
    readMarketAdapterLockPid, stopMarketAdapterFromLock, usesAmaGridPrice,
    waitForChildSpawn, pidMatchesScriptCandidates, candidateRuntimeScriptPaths,
} = require('./modules/launcher/bot_supervisor');
const {
    statusTitle, statusLabel, statusBool, statusActiveBotName,
    statusSuccess, statusError, colorStatus, STATUS_COLORS,
    readProcStat, readProcMemMB, readProcCpuTime, readProcCpuPercent,
    readProcUptime,
    formatMemoryWithUptime, printControlStatus,
} = require('./modules/launcher/status_reporting');
const {
    MONOLITHIC_PID_FILE, MONOLITHIC_BOT_PID_FILE, MONOLITHIC_BOT_INFO_FILE,
    MONOLITHIC_CRED_PID_FILE, MONOLITHIC_OUT_LOG, MONOLITHIC_ERROR_LOG,
    CREDENTIAL_SOCKET_FILE,
    cleanupStateFiles, readLiveMonolithicPid, readMonolithicBotInfo,
    isLikelyCredentialDaemonProcess,
    isExpectedMonolithicBotPid,
    isProcessInDstate, stopCredentialDaemonPid, stopCredentialDaemon,
    ensureNoForeignCredentialDaemon, findCredentialSocketOwnerPid,
    cleanupCredentialRuntimeFiles, readCredentialDaemonStatus, ensureLogDir: ensureMonolithicLogDir,
    buildDexbotStartArgs, createUpdateScheduler,
    listConfiguredBots, getControlBotNames, getControlActionLabel,
    getControlServiceNames, printControlActionSummary, formatBotCount,
} = require('./modules/launcher/monolithic_runtime');

const CODE_ROOT = __dirname;
const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const LOGS_DIR = PATHS.LOGS_DIR;
const SUPERVISOR_OUT_LOG = path.join(LOGS_DIR, 'supervisor.log');
const SUPERVISOR_ERROR_LOG = path.join(LOGS_DIR, 'supervisor-error.log');

const controller = createCredentialDaemonController({ root: PATHS.PROJECT_ROOT, codeRoot: CODE_ROOT });
const DEFAULT_STARTUP_GRACE_MS = 750;
const botProcessRef: { current: any } = { current: null };

function printLauncherHeader({ botName = null as string | null | undefined, clawOnly = false, creditOnly = false, isolated = false, dryrun = false, headless = false }: any = {}) {
    console.log('='.repeat(50));
    console.log('DEXBot2 Unlock Launcher');
    if (dryrun) console.log('Mode: dryrun (no transactions)');
    if (isolated) console.log('Mode: isolated (per-bot processes)');
    if (headless) console.log('Mode: headless (non-interactive password)');
    if (creditOnly) {
        console.log(`Starting credit-only worker: ${botName || 'auto-detect'}`);
    } else if (clawOnly) {
        console.log('Starting credential daemon only');
    } else if (botName) {
        console.log(`Starting bot: ${botName}`);
    } else {
        console.log('Starting all bots');
    }
    console.log('='.repeat(50));
    console.log();
}

function printLauncherStartupSummary({ botNames, mode }: { botNames: string[]; mode: 'background' | 'foreground' | 'isolated' }) {
    console.log('='.repeat(50));
    console.log(`DEXBot2 started ${formatBotCount(botNames.length)} in ${mode}`);
    console.log();
    for (const botName of botNames) {
        console.log(`- ${statusActiveBotName(botName)}`);
    }
    console.log('='.repeat(50));
}

function printLauncherSuccess({ botName = null, clawOnly = false, isolated = false }: { botName?: string | null; clawOnly?: boolean; isolated?: boolean } = {}) {
    console.log();
    console.log('='.repeat(50));
    if (clawOnly) {
        console.log(statusSuccess('DEXBot2 credential daemon started successfully!'));
        console.log('If the daemon stops, rerun `dexbot unlock --claw-only` to unlock it again.');
    } else if (botName) {
        console.log(statusSuccess('DEXBot2 started successfully!'));
        const cmd = isolated ? `dexbot unlock --isolated ${botName}` : `dexbot unlock ${botName}`;
        console.log(`If the bot stops, rerun \`${cmd}\` to unlock it again.`);
    } else {
        console.log(statusSuccess('DEXBot2 started successfully!'));
        const cmd = isolated ? 'dexbot unlock --isolated' : 'dexbot unlock';
        console.log(`If the bot stops, rerun \`${cmd}\` to unlock it again.`);
    }
    console.log('='.repeat(50));
    console.log();
}

function makeFinishGuard(cleanup: () => void) {
    let settled = false;
    let timer: any = null;

    const finish = (fn: any, value?: any) => {
        if (settled) return;
        settled = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        cleanup();
        fn(value);
    };

    return { finish, getTimer: () => timer, setTimer: (t: any) => { timer = t; } };
}

function waitForStableChildStartup(child: any, { label = 'child process', timeoutMs = DEFAULT_STARTUP_GRACE_MS }: any = {}) {
    if (timeoutMs <= 0) {
        return waitForChildSpawn(child);
    }

    return new Promise<void>((resolve, reject) => {
        const handleSpawn = () => {
            const t = setTimeout(() => finish(resolve), timeoutMs);
            if (t && typeof t.unref === 'function') {
                t.unref();
            }
            setTimer(t);
        };

        const handleError = (error: any) => finish(reject, error);
        const handleClose = (code: any, signal: any) => {
            finish(reject, new Error(`${label} exited during startup (exit ${code}${signal ? `, signal ${signal}` : ''})`));
        };

        const cleanup = () => {
            child.off('spawn', handleSpawn);
            child.off('error', handleError);
            child.off('close', handleClose);
        };

        const { finish, setTimer } = makeFinishGuard(cleanup);

        child.once('spawn', handleSpawn);
        child.once('error', handleError);
        child.once('close', handleClose);
    });
}

function resolveBotEntryForName(botName: string) {
    const { config } = loadSettingsFile(BOTS_FILE);
    const raw = resolveRawBotEntries(config);
    const match = raw.find((b: any) => b && b.name === botName);
    if (!match) return null;
    const entryCopy = JSON.parse(JSON.stringify(match));
    entryCopy.active = true;
    return normalizeBotEntry(entryCopy);
}

function getLaunchedBotNames(botName: any) {
    return botName
        ? [botName]
        : listConfiguredBots().filter((b: any) => b.active).map((b: any) => b.name);
}

// ── Isolated supervisor mode ───────────────────────────────────────

function isSupervisorTransientError(err: any): boolean {
    const msg = String(err && getErrorMessage(err) || '');
    return msg.includes('No supervisor socket found') || msg.includes('Connection timed out');
}

function waitForSupervisorReady({ child = null, timeoutMs = 15000, intervalMs = 250 }: { child?: any; timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        const handleClose = (code: any, signal: any) => {
            finish(reject, new Error(`supervisor exited before becoming ready (exit ${code}${signal ? `, signal ${signal}` : ''})`));
        };
        const handleError = (error: any) => finish(reject, error);
        const cleanup = () => {
            if (child) {
                child.off('close', handleClose);
                child.off('error', handleError);
            }
        };

        const { finish, setTimer } = makeFinishGuard(cleanup);

        const startedAt = Date.now();
        const poll = async () => {
            try {
                await sendControlCommand({ cmd: 'status' });
                finish(resolve, true);
            } catch (err) {
                if (!isSupervisorTransientError(err)) {
                    finish(reject, err);
                    return;
                }
                if ((Date.now() - startedAt) >= timeoutMs) {
                    finish(resolve, false);
                    return;
                }
                const t = setTimeout(poll, intervalMs);
                if (t && typeof t.unref === 'function') {
                    t.unref();
                }
                setTimer(t);
            }
        };

        if (child) {
            child.once('close', handleClose);
            child.once('error', handleError);
        }

        poll().catch((error: any) => finish(reject, error));
    });
}

function ensureSupervisorLogDir() {
    if (!storage.exists(LOGS_DIR)) {
        ensureDir(LOGS_DIR);
    }
}

async function sendIsolatedDeleteIfAvailable(): Promise<boolean> {
    try {
        const resp: any = await sendControlCommand({ cmd: 'delete' });
        if (resp.ok && resp.status) {
            printControlStatus(resp.status);
        } else if (resp.ok) {
            console.log('OK');
        }
        return !!resp.ok;
    } catch (err: any) {
        if (isSupervisorTransientError(err)) {
            return false;
        }
        throw err;
    }
}

async function launchDetachedSupervisor({ botName = null, credentialDaemonPid = null }: any = {}) {
    try {
        await sendControlCommand({ cmd: 'status' });
        throw new Error(`another isolated supervisor is already running at ${Config.DEXBOT_SUPERVISOR_SOCKET || SOCKET_PATH}`);
    } catch (err) {
        if (!String(err && getErrorMessage(err) || '').includes('No supervisor socket found')) {
            throw err;
        }
    }

    ensureSupervisorLogDir();
    const stdoutFd = storage.open(SUPERVISOR_OUT_LOG, 'a', 0o600);
    const stderrFd = storage.open(SUPERVISOR_ERROR_LOG, 'a', 0o600);
    const args = buildRuntimeScriptArgs({
        codeRoot: CODE_ROOT,
        scriptSegments: ['unlock'],
        scriptArgs: ['--isolated', ...(botName ? [botName] : [])],
    });
    let child: any = null;

    try {
        child = spawn(Config.EXEC_PATH, args, {
            cwd: PATHS.PROJECT_ROOT,
            detached: true,
            env: buildScopedChildEnv({
                extra: {
                    DEXBOT_ISOLATED_CHILD: '1',
                    ...(credentialDaemonPid ? { DEXBOT_MANAGED_CRED_PID: String(credentialDaemonPid) } : {}),
                },
            }),
            stdio: ['ignore', stdoutFd, stderrFd],
        });
        child.unref();

        const ready = await waitForSupervisorReady({ child });
        if (!ready) {
            throw new Error(`supervisor did not become ready. Check ${SUPERVISOR_OUT_LOG} and ${SUPERVISOR_ERROR_LOG}`);
        }
        return child.pid || 0;
    } catch (err) {
        if (child && child.pid) {
            try { runtime.kill(child.pid, 'SIGTERM'); } catch (_) {}
        }
        throw err;
    } finally {
        try { storage.close(stdoutFd); } catch (_) {}
        try { storage.close(stderrFd); } catch (_) {}
    }
}

async function runIsolated({ botName, botEntry = null, stayResident = false, startupGraceMs = DEFAULT_STARTUP_GRACE_MS }: { botName?: string; botEntry?: any; stayResident?: boolean; startupGraceMs?: number } = {}): Promise<number> {
    let supervisor;

    if (botName) {
        const bot = botEntry || resolveBotEntryForName(botName);
        if (!bot) {
            throw new Error(`Bot '${botName}' not found in bots.json`);
        }
        supervisor = createBotSupervisor({ bots: [bot] });
    } else {
        supervisor = createBotSupervisor();
    }

    registerCleanup('Bot supervisor', () => supervisor.shutdown());

    await supervisor.start();
    await supervisor.waitForStableStartup({ timeoutMs: startupGraceMs });

    printLauncherStartupSummary({ botNames: getLaunchedBotNames(botName || null), mode: 'isolated' });

    const sigintHandler = () => supervisor.shutdownSignalHandler('SIGINT');
    const sigtermHandler = () => supervisor.shutdownSignalHandler('SIGTERM');
    const sigusr1Handler = () => supervisor.printStatusSummary();
    const sigusr2Handler = () => supervisor.restartRunning();
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGUSR1', sigusr1Handler);
    process.on('SIGUSR2', sigusr2Handler);

    const cleanupSignalHandlers = () => {
        process.off('SIGINT', sigintHandler);
        process.off('SIGTERM', sigtermHandler);
        process.off('SIGUSR1', sigusr1Handler);
        process.off('SIGUSR2', sigusr2Handler);
    };

    if (stayResident) {
        return new Promise(() => {});
    }

    return new Promise<number>((resolve, reject) => {
        const pollStartedAt = Date.now();
        const interval = setInterval(async () => {
            try {
                const status = supervisor.getStatus();
                const running = Object.values(status).some(
                    (s: any) => s.status === 'running' || s.status === 'restarting' || s.status === 'starting'
                );
                if (!running && !supervisor.hasUserStopped()) {
                    clearInterval(interval);
                    cleanupSignalHandlers();
                    await supervisor.shutdown();
                    resolve(0);
                    return;
                }
                const elapsedMs = Date.now() - pollStartedAt;
                if (elapsedMs >= LAUNCHER.MONOLITHIC.SUPERVISOR_POLL_TIMEOUT_MS) {
                    clearInterval(interval);
                    cleanupSignalHandlers();
                    reject(new Error(
                        `Supervisor poll timeout after ${Math.ceil(elapsedMs / 1000)}s: ` +
                        `one or more bots are still in running/restarting/starting state`
                    ));
                }
            } catch (err) {
                clearInterval(interval);
                cleanupSignalHandlers();
                reject(err);
            }
        }, 1000);
    });
}

// ── Main entry point ───────────────────────────────────────────────

async function main({ argv = process.argv, startupGraceMs = DEFAULT_STARTUP_GRACE_MS }: any = {}) {
    if (typeof chainKeys.checkKeysFileSecurity === 'function') chainKeys.checkKeysFileSecurity();
    if (typeof credentialPolicy.checkPolicyFileSecurity === 'function') credentialPolicy.checkPolicyFileSecurity(PATHS.PROFILES.DAEMON_POLICIES_JSON);

    const parsed = parseUnlockArgs(argv);
    const isDetachedSupervisorChild = Config.DEXBOT_ISOLATED_CHILD;
    const forceForegroundIsolated = Config.DEXBOT_ISOLATED_FOREGROUND;
    const isMonolithicBgChild = Config.DEXBOT_MONOLITHIC_BG;
    const forceForeground = argv.includes('--foreground');

    if (parsed.control) {
        await handleControl({ cmd: parsed.control.cmd, target: parsed.control.target ?? undefined });
        return;
    }

    const { botName, clawOnly, creditOnly, isolated, dryrun, headless, passwordFile } = parsed;
    let effectiveBotName = botName;
    if (creditOnly && !effectiveBotName) {
        const creditBots = listConfiguredBots().filter((b: any) => b.creditOnly === true && b.active !== false);
        if (creditBots.length === 0) {
            throw new Error('No credit-only bot found. Add "creditOnly": true to a bot entry in bots.json');
        }
        effectiveBotName = creditBots[0].name;
        if (creditBots.length > 1) {
            console.log(`Multiple credit-only bots found; starting first: ${effectiveBotName}`);
        }
    }
    const selectedBot = effectiveBotName ? resolveBotEntryForName(effectiveBotName) : null;
    let launchedBotNames = getLaunchedBotNames(effectiveBotName);
    const shouldStartMonolithicBackground = !clawOnly && !isolated && !isDetachedSupervisorChild && !isMonolithicBgChild && !forceForeground;
    let daemonReleased = false;

    if (botName && !selectedBot) {
        throw new Error(`Bot '${botName}' not found in bots.json`);
    }

    if (shouldStartMonolithicBackground) {
        const { pid } = readLiveMonolithicPid();
        if (pid > 0) {
            printLauncherHeader({ botName: effectiveBotName || botName, clawOnly, creditOnly, isolated, dryrun, headless });
            console.log(`DEXBot2 already running in background (PID ${pid}).`);
            console.log('Use `dexbot stat` to inspect it, or `dexbot restart` to restart it.');
            process.exitCode = 0;
            return;
        }
    }

    try {
        if (!isDetachedSupervisorChild) {
            printLauncherHeader({ botName: effectiveBotName || botName, clawOnly, creditOnly, isolated, dryrun, headless });

            await ensureNoForeignCredentialDaemon();

            const daemonOpts: any = { detached: isolated && !forceForegroundIsolated };
            let daemonOutFd: any = null;
            let daemonErrFd: any = null;

            if (!clawOnly && !isolated && !forceForeground) {
                ensureMonolithicLogDir();
                daemonOutFd = storage.open(MONOLITHIC_OUT_LOG, 'a', 0o600);
                try {
                    daemonErrFd = storage.open(MONOLITHIC_ERROR_LOG, 'a', 0o600);
                } catch (_e) {
                    try { storage.close(daemonOutFd); } catch (_) {}
                    daemonOutFd = null;
                    throw _e;
                }
                daemonOpts.stdio = ['ignore', daemonOutFd, daemonErrFd];
            }

            try {
                const unlockedNow = await controller.ensureCredentialDaemon({
                    ...daemonOpts,
                    headless,
                    passwordFile,
                });
                if (unlockedNow) {
                    console.log(statusSuccess('✓ Authentication successful'));
                }
            } finally {
                if (daemonOutFd !== null) try { storage.close(daemonOutFd); } catch (_) {}
                if (daemonErrFd !== null) try { storage.close(daemonErrFd); } catch (_) {}
            }
        } else if (!(await controller.isDaemonReady())) {
            throw new Error('credential daemon is not ready for isolated supervisor startup');
        }

        // Background daemonization for monolithic mode (default)
        if (shouldStartMonolithicBackground) {
            const { pid } = readLiveMonolithicPid();
            if (pid > 0) {
                console.log(`DEXBot2 already running in background (PID ${pid}).`);
                console.log('Use `dexbot stat` to inspect it, or `dexbot restart` to restart it.');
                process.exitCode = 0;
                return;
            }

            const credentialDaemonPid = controller.getManagedDaemonPid();
            if (credentialDaemonPid) {
                try { storage.writeFile(MONOLITHIC_CRED_PID_FILE, String(credentialDaemonPid), { mode: 0o600 }); } catch (_) {}
            }
            controller.releaseManagedDaemon();
            daemonReleased = true;

            ensureMonolithicLogDir();
            const stdoutFd = storage.open(MONOLITHIC_OUT_LOG, 'a', 0o600);
            let stderrFd;
            try {
                stderrFd = storage.open(MONOLITHIC_ERROR_LOG, 'a', 0o600);
            } catch (_e) {
                try { storage.close(stdoutFd); } catch (_) {}
                throw _e;
            }

            const child = spawn(Config.EXEC_PATH, [__filename, ...argv.slice(2)], {
                cwd: PATHS.PROJECT_ROOT,
                detached: true,
                env: {
                    ...process.env,
                    DEXBOT_MONOLITHIC_BG: '1',
                    ...(credentialDaemonPid ? { DEXBOT_MANAGED_CRED_PID: String(credentialDaemonPid) } : {}),
                },
                stdio: ['ignore', stdoutFd, stderrFd],
            });
            child.unref();
            storage.writeFile(MONOLITHIC_PID_FILE, String(child.pid), { mode: 0o600 });

            printLauncherStartupSummary({ botNames: launchedBotNames, mode: 'background' });
            process.exit(0);
        }

        if (clawOnly) {
            printLauncherSuccess({ clawOnly });
            const exitCode = await controller.waitForManagedDaemon();
            process.exitCode = exitCode || 0;
            return;
        }

        if (isolated) {
            if (isDetachedSupervisorChild || forceForegroundIsolated) {
                process.exitCode = await runIsolated({
                    botName: botName ?? undefined,
                    botEntry: selectedBot,
                    stayResident: isDetachedSupervisorChild,
                    startupGraceMs,
                });
                return;
            }

            const supervisorPid = await launchDetachedSupervisor({
                botName,
                credentialDaemonPid: controller.getManagedDaemonPid(),
            });
            controller.releaseManagedDaemon();
            daemonReleased = true;
            printLauncherStartupSummary({ botNames: launchedBotNames, mode: 'isolated' });
            console.log(`Supervisor PID: ${supervisorPid}`);
            console.log(`Control socket: ${Config.DEXBOT_SUPERVISOR_SOCKET || SOCKET_PATH}`);
            console.log(`Supervisor logs: ${SUPERVISOR_OUT_LOG}`);
            process.exitCode = 0;
            return;
        }

        // Monolithic foreground mode — spawn and supervise the bot process directly
        const updater = UPDATER.ACTIVE ? createUpdateScheduler({ botProcessRef }) : null;
        const cancelUpdater = updater ? updater.cancel : () => {};

        const watchdog = createMarketAdapterWatchdog({
            codeRoot: CODE_ROOT,
            root: PATHS.PROJECT_ROOT,
            logsDir: LOGS_DIR,
        } as any);
        const cancelWatchdog = watchdog.schedule(MONOLITHIC_ERROR_LOG);

        let restartCount = 0;
        let lastStartTime = 0;
        let keepRunning = true;
        let monolithicRestartSignalRegistered = false;
        let pendingRestart = false;
        const onSigusr2 = () => {
            pendingRestart = true;
            if (updater) updater.pendingRestart = true;
            forwardSignal(botProcessRef.current, 'SIGTERM');
        };
        process.on('SIGUSR2', onSigusr2);
        monolithicRestartSignalRegistered = true;

        try {
            do {
                launchedBotNames = getLaunchedBotNames(effectiveBotName || botName);
                const dexbotArgs = buildDexbotStartArgs(effectiveBotName || botName, dryrun);

                const botProcess = spawn(Config.EXEC_PATH, dexbotArgs, {
                    cwd: PATHS.PROJECT_ROOT,
                    env: process.env,
                    stdio: isMonolithicBgChild ? 'pipe' : 'inherit',
                });
                botProcessRef.current = botProcess;

                if (isMonolithicBgChild) {
                    try { storage.writeFile(MONOLITHIC_BOT_PID_FILE, String(botProcess.pid), { mode: 0o600 }); } catch (_) {}
                    const botStat = botProcess.pid ? readProcStat(botProcess.pid) : null;
                    try {
                        storage.writeFile(
                            MONOLITHIC_BOT_INFO_FILE,
                            JSON.stringify({ botName: effectiveBotName || botName, botNames: launchedBotNames, pid: botProcess.pid, starttime: botStat?.starttime ?? null }),
                            { mode: 0o600 }
                        );
                    } catch (_) {}
                }

                if (isMonolithicBgChild && botProcess.stdout) {
                    const outStream = fs.createWriteStream(MONOLITHIC_OUT_LOG, { flags: 'a' });
                    const errStream = fs.createWriteStream(MONOLITHIC_ERROR_LOG, { flags: 'a' });
                    botProcess.stdout.pipe(outStream);
                    botProcess.stderr!.pipe(errStream);
                    botProcess.stdout.on('error', () => {});
                    botProcess.stderr!.on('error', () => {});
                    botProcess.once('close', () => {
                        try { outStream.end(); } catch (_) {}
                        try { errStream.end(); } catch (_) {}
                    });
                }

                lastStartTime = Date.now();
                await waitForStableChildStartup(botProcess, { label: 'DEXBot', timeoutMs: startupGraceMs });

                if (!updater?.pendingRestart) {
                    if (!isMonolithicBgChild) {
                        printLauncherStartupSummary({ botNames: launchedBotNames, mode: 'foreground' });
                    }
                }

                const onSigint = () => forwardSignal(botProcess, 'SIGINT');
                const onSigterm = () => forwardSignal(botProcess, 'SIGTERM');
                process.on('SIGINT', onSigint);
                process.on('SIGTERM', onSigterm);

                const cleanupBotHandlers = () => {
                    process.off('SIGINT', onSigint);
                    process.off('SIGTERM', onSigterm);
                };

                const exitCode = await new Promise<number>((resolve: any, reject: any) => {
                    botProcess.on('error', reject);
                    botProcess.on('close', (code: any) => resolve(code));
                }).catch((err: any) => {
                    cleanupBotHandlers();
                    throw err;
                });
                cleanupBotHandlers();

                if (pendingRestart || updater?.pendingRestart) {
                    pendingRestart = false;
                    if (updater) updater.pendingRestart = false;
                    console.log('Update applied, restarting bot...');
                } else if (exitCode !== 0) {
                    const uptime = Date.now() - lastStartTime;
                    if (uptime >= LAUNCHER.MONOLITHIC.minUptimeMs) {
                        restartCount = 0;
                    }
                    restartCount++;
                    if (restartCount > LAUNCHER.MONOLITHIC.maxRestarts) {
                        console.error(statusError(`Bot crashed ${LAUNCHER.MONOLITHIC.maxRestarts} times without stable uptime. Exiting.`));
                        process.exitCode = exitCode || 1;
                        keepRunning = false;
                    } else {
                        console.log(`Bot crashed (exit ${exitCode}), restarting in ${LAUNCHER.MONOLITHIC.restartDelayMs / 1000}s (attempt ${restartCount}/${LAUNCHER.MONOLITHIC.maxRestarts})...`);
                        await new Promise((r: any) => setTimeout(r, LAUNCHER.MONOLITHIC.restartDelayMs));
                    }
                } else {
                    process.exitCode = 0;
                    keepRunning = false;
                }
            } while (keepRunning);
        } finally {
            if (monolithicRestartSignalRegistered) {
                process.off('SIGUSR2', onSigusr2);
            }
            cancelUpdater();
            cancelWatchdog();
            await watchdog.stop();
        }
    } finally {
        if (isMonolithicBgChild) {
            cleanupStateFiles();
        }
        if (!isDetachedSupervisorChild && !daemonReleased) {
            await controller.stopManagedDaemon();
        }
    }
}

// ── Control command handling ───────────────────────────────────────

/**
 * Resolve the live credential daemon PID (owned or foreign) for status
 * reporting. Falls back to the socket owner when the tracked PID file is
 * missing or stale.
 */
function resolveCredentialDaemonForStatus(): { pid: number | null; foreign: boolean } {
    let credPid: any = null;
    let credForeign = false;
    try {
        const raw = storage.readFile(MONOLITHIC_CRED_PID_FILE).trim();
        const n = Number(raw);
        if (Number.isInteger(n) && n > 0) credPid = n;
    } catch (_) {}

    if (!credPid && storage.exists(CREDENTIAL_SOCKET_FILE)) {
        const ownerPid = findCredentialSocketOwnerPid();
        if (ownerPid > 0 && isLikelyCredentialDaemonProcess(ownerPid)) {
            credPid = ownerPid;
            credForeign = true;
        }
    }

    return { pid: credPid, foreign: credForeign };
}

/**
 * Print the "Credential daemon:" status block for a resolved daemon PID.
 */
async function printCredentialDaemonStatusBlock(credPid: number | null, credForeign: boolean): Promise<{ alive: boolean; ready: boolean; socket: boolean }> {
    const credStatus = await readCredentialDaemonStatus(credPid);
    console.log(`  ${statusTitle('Credential daemon:')}`);
    if (credPid && credForeign) {
        console.log(`    ${statusLabel('PID:')}   ${credPid} ${colorStatus('(foreign/unowned)', STATUS_COLORS.warn)}`);
    } else {
        console.log(`    ${statusLabel('PID:')}   ${credPid || '-'}`);
    }
    if (credPid && isPidAlive(credPid) && isLikelyCredentialDaemonProcess(credPid)) {
        const credUptime = readProcUptime(credPid);
        const credMem = readProcMemMB(credPid);
        console.log(`    ${statusLabel('Memory:')}  ${formatMemoryWithUptime(credMem, credUptime)}`);
        console.log(`    ${statusLabel('Alive:')} ${statusBool(true)}`);
    } else {
        console.log(`    ${statusLabel('Alive:')} ${statusBool(false)}`);
    }
    console.log(`    ${statusLabel('Ready:')} ${statusBool(credStatus.ready)}`);
    console.log(`    ${statusLabel('Socket:')} ${statusBool(credStatus.socket)}`);
    if (credForeign) {
        console.log(
            `    ${colorStatus(
                'Rerun `dexbot unlock` to detach the foreign daemon and unlock with a fresh master password.',
                STATUS_COLORS.warn
            )}`
        );
    }
    return credStatus;
}

/**
 * Print the "Market adapter:" status block for the running adapter (or note
 * that it is not running).
 */
function printMarketAdapterStatusBlock() {
    const adapterPid = readMarketAdapterLockPid();
    const adapterAlive = adapterPid > 0 && isLikelyMarketAdapterProcess(adapterPid);
    console.log(`  ${statusTitle('Market adapter:')}`);
    if (adapterAlive) {
        console.log(`    ${statusLabel('PID:')}     ${adapterPid}`);
        console.log(`    ${statusLabel('Memory:')}  ${formatMemoryWithUptime(readProcMemMB(adapterPid), readProcUptime(adapterPid))}`);
    } else if (adapterPid > 0) {
        console.log(`    ${colorStatus('(offline)', STATUS_COLORS.warn)}`);
        return;
    } else {
        console.log(`    ${colorStatus('(not running)', STATUS_COLORS.muted)}`);
        return;
    }
    const amaBots = listConfiguredBots().filter((b: any) => b.active && usesAmaGridPrice(b));
    function botKeyFromName(name: string) {
        return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bot';
    }
    console.log(`    ${statusLabel('Active:')}  ${formatBotCount(amaBots.length)}`);
    for (const b of amaBots) {
        const flags = getWhitelistFlags(botKeyFromName(b.name));
        const indicators: string[] = [];
        if (flags.asymmetricBounds) indicators.push('range');
        if (flags.dynamicWeight) indicators.push('weight');
        const suffix = indicators.length > 0 ? `, ${indicators.join(', ')}` : '';
        console.log(`      - ${colorStatus(b.name, STATUS_COLORS.ok)} (${b.gridPrice}${suffix})`);
    }
}

async function handleControl({ cmd, target }: { cmd: string; target?: string }) {
    const effectiveCmd = cmd === 'shutdown' ? 'delete' : cmd === 'stat' ? 'status' : cmd;
    const actionLabel = getControlActionLabel(cmd);

    if ((effectiveCmd === 'stop-all' || effectiveCmd === 'delete' || effectiveCmd === 'status' || effectiveCmd === 'restart-all') && !target) {
        const { pid, stale } = readLiveMonolithicPid();

        if (pid > 0) {
            const summaryBotNames = getControlBotNames(undefined, true);
            const summaryServiceNames = getControlServiceNames(effectiveCmd, summaryBotNames);

            if (effectiveCmd === 'restart-all') {
                if (process.stdin.isTTY) {
                    const credResult = await stopCredentialDaemon();
                    if (credResult.signaled) {
                        console.log('Stop signal sent to credential daemon');
                    }
                    const daemonOpts: any = { detached: true };
                    const unlockedNow = await controller.ensureCredentialDaemon(daemonOpts);
                    if (unlockedNow) {
                        console.log(statusSuccess('✓ Authentication successful'));
                    }
                    const newCredPid = controller.getManagedDaemonPid();
                    if (newCredPid) {
                        try { storage.writeFile(MONOLITHIC_CRED_PID_FILE, String(newCredPid), { mode: 0o600 }); } catch (_) {}
                    }
                    controller.releaseManagedDaemon();
                }
                await stopMarketAdapterFromLock();
                try {
                    runtime.kill(pid, 'SIGUSR2');
                } catch (err: any) {
                    if (err.code !== 'ESRCH') throw err;
                }
                printControlActionSummary(actionLabel, summaryBotNames, summaryServiceNames);
                process.exit(0);
                return;
            }

            if (effectiveCmd === 'status') {
                const botInfo = readMonolithicBotInfo();

                let targetPid = pid;
                let botPidRaw = null;
                try { botPidRaw = storage.readFile(MONOLITHIC_BOT_PID_FILE).trim(); } catch (_) {}
                if (botPidRaw) {
                    const bp = Number(botPidRaw);
                    if (isExpectedMonolithicBotPid(bp, botInfo)) {
                        targetPid = bp;
                    }
                }

                const mem = readProcMemMB(targetPid);
                const cpuTime = readProcCpuTime(targetPid);
                const cpuPct = await readProcCpuPercent(targetPid);
                const uptime = readProcUptime(targetPid);

                // Prefer live bots.json (current intent) over the startup snapshot.
                // Shows what the user configured, even if the wrapper hasn't respawned yet.
                let displayedBots = listConfiguredBots().filter((b: any) => b.active);
                if (displayedBots.length === 0) {
                    if (Array.isArray(botInfo?.botNames)) {
                        displayedBots = botInfo.botNames.map((name: any) => ({ name: String(name) }));
                    } else if (botInfo?.botName) {
                        displayedBots = [{ name: String(botInfo.botName) }];
                    }
                }

                console.log(statusTitle('Monolithic bot'));
                console.log(`  ${statusLabel('PID:')}     ${targetPid}`);
                console.log(`  ${statusLabel('Memory:')}  ${formatMemoryWithUptime(mem, uptime)}`);
                console.log(`  ${statusLabel('CPU:')}     ${cpuPct}  (${statusLabel('cumulative:')} ${cpuTime})`);
                console.log(`  ${statusLabel('Bots:')}    ${displayedBots.length} active`);
                for (const b of displayedBots) {
                    console.log(`    - ${statusActiveBotName(b.name)}`);
                }

                const { pid: credPid, foreign: credForeign } = resolveCredentialDaemonForStatus();
                await printCredentialDaemonStatusBlock(credPid, credForeign);

                printMarketAdapterStatusBlock();
                return;
            }

            let monolithicExited = false;
            try {
                if (isProcessInDstate(pid)) {
                    console.warn(`monolithic wrapper PID ${pid} is in uninterruptible sleep (D-state), cannot kill. Cleaning up state.`);
                    monolithicExited = true;
                } else {
                    runtime.kill(pid, 'SIGTERM');
                    const timeoutMs = effectiveCmd === 'delete' ? LAUNCHER.MONOLITHIC.controlStopTimeoutMs : 5000;
                    monolithicExited = await waitForPidExit(pid, timeoutMs);
                    if (!monolithicExited && effectiveCmd === 'delete') {
                        if (isProcessInDstate(pid)) {
                            console.warn(`monolithic wrapper PID ${pid} is in D-state, skipping SIGKILL.`);
                        } else {
                            runtime.kill(pid, 'SIGKILL');
                            monolithicExited = await waitForPidExit(pid, 2000);
                            if (!monolithicExited) {
                                console.warn(`monolithic wrapper PID ${pid} did not exit after SIGKILL (may be in uninterruptible sleep). Cleaning up state.`);
                            }
                        }
                    }
                }
            } catch (err: any) {
                if (err.code !== 'ESRCH') throw err;
                monolithicExited = true;
            } finally {
                if (effectiveCmd === 'delete' || monolithicExited) {
                    cleanupStateFiles();
                }
            }
            if (effectiveCmd === 'delete') {
                const credResult = await stopCredentialDaemon();
                if (credResult.signaled) {
                    console.log('Stop signal sent to credential daemon');
                }
            }
            printControlActionSummary(actionLabel, summaryBotNames, summaryServiceNames);
            return;
        } else if (stale) {
            if (effectiveCmd === 'delete') {
                const summaryBotNames = getControlBotNames(undefined, true);
                const isolatedDeleted = await sendIsolatedDeleteIfAvailable();
                const credResult = await stopCredentialDaemon();
                if (credResult.signaled) {
                    console.log('Stop signal sent to credential daemon');
                }
                printControlActionSummary(actionLabel, summaryBotNames, getControlServiceNames(effectiveCmd, summaryBotNames));
                if (isolatedDeleted || credResult.cleaned) return;
            }
            console.log(effectiveCmd === 'delete' ? 'Removed stale monolithic PID file' : 'Monolithic bot not running (stale PID file)');
            return;
        } else if (effectiveCmd === 'status') {
            // The monolithic runtime is stopped (bots + market adapter down),
            // but the credential daemon may still be running — a `dexbot stop`
            // leaves it alive for faster re-unlock. Report that state instead of
            // falling through to an isolated supervisor socket that is absent.
            const daemon = resolveCredentialDaemonForStatus();
            if (daemon.pid && isPidAlive(daemon.pid) && isLikelyCredentialDaemonProcess(daemon.pid)) {
                console.log(statusTitle('Monolithic bot'));
                console.log(`  ${colorStatus('(offline)', STATUS_COLORS.warn)}`);
                console.log();
                await printCredentialDaemonStatusBlock(daemon.pid, daemon.foreign);
                console.log();
                printMarketAdapterStatusBlock();
                return;
            }
        }
    }

    if (effectiveCmd === 'delete' && !target && storage.exists(MONOLITHIC_CRED_PID_FILE)) {
        await sendIsolatedDeleteIfAvailable();
        const credResult = await stopCredentialDaemon();
        if (credResult.signaled) {
            console.log('Stop signal sent to credential daemon');
        }
        if (credResult.cleaned) {
            const summaryBotNames = getControlBotNames(undefined, true);
            printControlActionSummary(actionLabel, summaryBotNames, getControlServiceNames(effectiveCmd, summaryBotNames));
            return;
        }
    }

    // Fall through to isolated supervisor socket
    const controlCmd: any = { cmd: effectiveCmd };
    if (target) controlCmd.bot = target;

    // Restart credential daemon for restart-all (no target) in isolated mode
    if (!target && effectiveCmd === 'restart-all' && process.stdin.isTTY) {
        const ownerPid = findCredentialSocketOwnerPid();
        if (ownerPid > 0 && isLikelyCredentialDaemonProcess(ownerPid)) {
            await stopCredentialDaemonPid(ownerPid);
        }
        cleanupCredentialRuntimeFiles();
        const daemonOpts: any = { detached: true };
        const unlockedNow = await controller.ensureCredentialDaemon(daemonOpts);
        if (unlockedNow) {
            console.log(statusSuccess('✓ Authentication successful'));
        }
        controller.releaseManagedDaemon();
    }

    try {
        const resp: any = await sendControlCommand(controlCmd);
        if (resp.ok && resp.status) {
            printControlStatus(resp.status);
        } else {
            if (target || effectiveCmd === 'stop-all' || effectiveCmd === 'restart-all' || effectiveCmd === 'delete') {
                const summaryBotNames = getControlBotNames(target, !target && (effectiveCmd === 'stop-all' || effectiveCmd === 'restart-all' || effectiveCmd === 'delete'));
                const summaryServiceNames = getControlServiceNames(effectiveCmd, summaryBotNames);
                printControlActionSummary(actionLabel, summaryBotNames, summaryServiceNames);
            }
            console.log('OK');
        }
    } catch (err) {
        if (effectiveCmd === 'delete' && !target && isSupervisorTransientError(err)) {
            console.log('No runtime processes found.');
            return;
        }
        console.error(statusError(`control ${cmd}: ${getErrorMessage(err)}`));
        process.exitCode = 1;
    }
    process.exit(0);
}

// ── Bootstrap ──────────────────────────────────────────────────────

const isUnlockStartDirectRun = !!process.argv[1] && (
    import.meta.url === pathToFileURL(process.argv[1]).href ||
    path.parse(process.argv[1]).name === 'unlock'
);
if (isUnlockStartDirectRun) {
    setupGracefulShutdown();
    if (Config.DEXBOT_ISOLATED_CHILD) {
        registerCleanup('Credential daemon', () => stopCredentialDaemonPid(Config.DEXBOT_MANAGED_CRED_PID));
    } else if (Config.DEXBOT_MONOLITHIC_BG) {
        registerCleanup('PID files', cleanupStateFiles);
        registerCleanup('Bot process', async () => {
            const bot = botProcessRef.current;
            if (bot && !bot.killed) {
                forwardSignal(bot, 'SIGTERM');
                await withTimeout(
                    new Promise<void>((resolve) => bot.once('close', resolve)),
                    LAUNCHER.MONOLITHIC.SHUTDOWN_GRACE_MS,
                    { onTimeout: 'resolve', defaultValue: undefined as any }
                );
            }
        });
    } else {
        registerCleanup('Credential daemon', () => controller.stopManagedDaemon());
    }
    (async () => {
        try {
            await main();
        } catch (err) {
            console.error(statusError(`unlock failed: ${getErrorMessage(err) || err}`));
            process.exit(1);
        }
    })();
}

export { buildDexbotStartArgs, candidateRuntimeScriptPaths, ensureNoForeignCredentialDaemon, findCredentialSocketOwnerPid, isLikelyCredentialDaemonProcess, main, pidMatchesScriptCandidates, waitForChildSpawn, waitForStableChildStartup }

