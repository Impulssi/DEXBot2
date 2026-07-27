
import { path } from '../path_api';
import { getStorage } from '../storage';
import { spawn } from 'node:child_process';
import { PATHS } from '../paths';
import { buildScopedChildEnv } from './child_env';
import { UPDATER, LAUNCHER } from '../constants';
import { safeUnlink } from '../utils/fs_utils';
import { readProcStat } from './status_reporting';
import * as foreignCredDaemon from './foreign_cred_daemon';
import { Config } from '../config';
import { runtime } from '../runtime';
import { getCredentialReadyFilePath, getCredentialSocketPath } from '../credential_runtime';
import { resolveRawBotEntries, loadSettingsFile } from '../bot_settings';
import { sleep } from '../order/utils/system';
import * as chainKeys from '../chain_keys';
'use strict';

const storage = getStorage();
import {
    isPidAlive,
    parseCronExpression,
    getNextCronDate,
    isNodeProcessWithExactScript,
} from './bot_supervisor';
import { buildRuntimeScriptArgs, SCRIPTS_ROOT as CODE_ROOT } from './runtime_entry';
import { getErrorMessage } from '../utils/errors';

const MONOLITHIC_PID_FILE = PATHS.PROFILES.MONOLITHIC_PID;
const MONOLITHIC_BOT_PID_FILE = PATHS.PROFILES.MONOLITHIC_BOT_PID;
const MONOLITHIC_BOT_INFO_FILE = PATHS.PROFILES.MONOLITHIC_BOT_INFO;
const MONOLITHIC_CRED_PID_FILE = PATHS.PROFILES.MONOLITHIC_CRED_PID;
const MONOLITHIC_OUT_LOG = path.join(PATHS.LOGS_DIR, 'dexbot.log');
const MONOLITHIC_ERROR_LOG = path.join(PATHS.LOGS_DIR, 'dexbot-error.log');
const BOTS_FILE = PATHS.PROFILES.BOTS_JSON;
const CREDENTIAL_SOCKET_FILE = getCredentialSocketPath({ root: PATHS.PROJECT_ROOT });
const CREDENTIAL_READY_FILE = getCredentialReadyFilePath({ root: PATHS.PROJECT_ROOT });

function formatBotCount(count: any) {
    return `${count} ${count === 1 ? 'bot' : 'bots'}`;
}

// ── PID file management ────────────────────────────────────────────

function cleanupStateFiles() {
    safeUnlink(MONOLITHIC_PID_FILE)
    safeUnlink(MONOLITHIC_BOT_PID_FILE)
    safeUnlink(MONOLITHIC_BOT_INFO_FILE)
}

function readLiveMonolithicPid() {
    if (!storage.exists(MONOLITHIC_PID_FILE)) return { pid: 0, stale: false };

    let pid = 0;
    try {
        const raw = storage.readFile(MONOLITHIC_PID_FILE).trim();
        pid = Number(raw);
        if (!Number.isInteger(pid) || pid <= 0) pid = 0;
    } catch (_) {
        safeUnlink(MONOLITHIC_PID_FILE)
        return { pid: 0, stale: true };
    }

    if (pid <= 0) return { pid: 0, stale: true };

    if (!isLikelyUnlockProcess(pid)) {
        safeUnlink(MONOLITHIC_PID_FILE)
        return { pid: 0, stale: true };
    }

    return { pid, stale: false };
}

function readMonolithicBotInfo() {
    try {
        const infoRaw = storage.readFile(MONOLITHIC_BOT_INFO_FILE);
        const info = JSON.parse(infoRaw);
        return info && typeof info === 'object' ? info : null;
    } catch (_) {
        return null;
    }
}

// ── Process matching ───────────────────────────────────────────────

function isLikelyCredentialDaemonProcess(pid: any) {
    return isNodeProcessWithExactScript(pid, ['credential-daemon']);
}

function isLikelyDexbotProcess(pid: any) {
    return isNodeProcessWithExactScript(pid, ['dexbot']);
}

function isLikelyUnlockProcess(pid: any) {
    return isNodeProcessWithExactScript(pid, ['unlock']);
}

function isExpectedProcessStarttime(pid: any, expectedStarttime: any) {
    if (typeof expectedStarttime !== 'number') return false;
    const stat = readProcStat(pid);
    return !!(stat && stat.starttime === expectedStarttime);
}

function isExpectedMonolithicBotPid(pid: any, botInfo: any) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    if (!botInfo || botInfo.pid !== pid) {
        return false;
    }
    if (!isLikelyDexbotProcess(pid)) {
        return false;
    }
    if (!isExpectedProcessStarttime(pid, botInfo.starttime)) {
        return false;
    }
    return true;
}

// ── Credential daemon management ───────────────────────────────────

async function stopCredentialDaemonPid(pid: string | number) {
    const daemonPid = Number(pid);
    if (!Number.isInteger(daemonPid) || daemonPid <= 0) {
        return;
    }

    function isAlive(targetPid: number): boolean {
        try {
            return runtime.kill(targetPid, 0);
        } catch (_) {
            return false;
        }
    }

    try {
        runtime.kill(daemonPid, 'SIGTERM');
    } catch (e: any) {
        if (e.code !== 'ESRCH') throw e;
        return;
    }

    const startedAt = Date.now();
    while ((Date.now() - startedAt) < 5000) {
        if (!isAlive(daemonPid)) {
            return;
        }
        await sleep(100);
    }

    const SIGKILL_DEADLINE_MS = LAUNCHER.MONOLITHIC.DAEMON_SIGKILL_DEADLINE_MS;
    const sigkillStartedAt = Date.now();
    let sigkillSent = false;
    try {
        sigkillSent = runtime.kill(daemonPid, 'SIGKILL');
    } catch (e: any) {
        if (e.code !== 'ESRCH') throw e;
        return;
    }
    if (sigkillSent) {
        while ((Date.now() - sigkillStartedAt) < SIGKILL_DEADLINE_MS) {
            if (!isAlive(daemonPid)) {
                return;
            }
            await sleep(100);
        }
    }

    console.warn(
        `stopCredentialDaemonPid: SIGKILL did not terminate pid ${daemonPid} after ` +
        `${Math.ceil(SIGKILL_DEADLINE_MS / 1000)}s (process may be in uninterruptible sleep).`
    );
}

function cleanupCredentialRuntimeFiles() {
    safeUnlink(CREDENTIAL_SOCKET_FILE)
    safeUnlink(CREDENTIAL_READY_FILE)
}

async function stopCredentialDaemon() {
    let pidRaw: string | null = null;
    try {
        pidRaw = storage.readFile(MONOLITHIC_CRED_PID_FILE).trim();
    } catch (_) {}

    const daemonPid = Number(pidRaw);
    if (!pidRaw || !Number.isInteger(daemonPid) || daemonPid <= 0) {
        cleanupCredentialRuntimeFiles();
        safeUnlink(MONOLITHIC_CRED_PID_FILE)
        return { signaled: false, cleaned: true };
    }

    const signaled = isPidAlive(daemonPid);
    await stopCredentialDaemonPid(daemonPid);
    cleanupCredentialRuntimeFiles();
    safeUnlink(MONOLITHIC_CRED_PID_FILE)
    return { signaled, cleaned: true };
}

async function ensureNoForeignCredentialDaemon({ verbose = true }: any = {}) {
    return foreignCredDaemon.ensureNoForeignCredentialDaemon({
        socketPath: CREDENTIAL_SOCKET_FILE,
        readyFilePath: CREDENTIAL_READY_FILE,
        pidFile: MONOLITHIC_CRED_PID_FILE,
        isLikelyProcess: isLikelyCredentialDaemonProcess,
        verbose,
    });
}

function findCredentialSocketOwnerPid() {
    return foreignCredDaemon.findCredentialSocketOwnerPid(
        CREDENTIAL_SOCKET_FILE,
        isLikelyCredentialDaemonProcess
    );
}

async function readCredentialDaemonStatus(pid: number | null): Promise<{ alive: boolean; ready: boolean; socket: boolean }> {
    const alive = !!(pid && isLikelyCredentialDaemonProcess(pid));
    if (!alive) {
        return { alive: false, ready: false, socket: false };
    }

    try {
        const responsive = await chainKeys.isDaemonResponsive({
            socketPath: CREDENTIAL_SOCKET_FILE,
            readyFilePath: CREDENTIAL_READY_FILE,
        });
        return { alive, ready: responsive as boolean, socket: responsive as boolean };
    } catch (_) {
        return { alive, ready: false, socket: false };
    }
}

// ── Monolithic daemonization ───────────────────────────────────────

function ensureLogDir() {
    storage.ensureDir(PATHS.LOGS_DIR);
}

function buildDexbotStartArgs(botName: any, dryrun: any = false) {
    const scriptArgs = [dryrun ? 'drystart' : 'test'];
    if (botName) scriptArgs.push(botName);
    return buildRuntimeScriptArgs({
        codeRoot: CODE_ROOT,
        scriptSegments: ['dexbot'],
        scriptArgs,
    });
}

function buildUnlockArgs({ isolated = false, botName = null }: any = {}) {
    const scriptArgs: string[] = [];
    if (isolated) {
        scriptArgs.push('--isolated');
    }
    if (botName) {
        scriptArgs.push(botName);
    }
    return buildRuntimeScriptArgs({
        codeRoot: CODE_ROOT,
        scriptSegments: ['unlock'],
        scriptArgs,
    });
}

// ── Update scheduler ───────────────────────────────────────────────

function createUpdateScheduler({ botProcessRef, warn = console.warn }: { botProcessRef?: { current: any }; log?: (...data: any[]) => void; warn?: (...data: any[]) => void } = {}) {
    let _updateTimer: any = null;
    let _pendingRestart = false;
    let cancelled = false;

    function clearTimer() {
        if (_updateTimer) {
            clearTimeout(_updateTimer);
            _updateTimer = null;
        }
    }

    function scheduleNext() {
        if (cancelled) return;
        try {
            const parsed = parseCronExpression(UPDATER.SCHEDULE);
            const nextDate = getNextCronDate(parsed);
            const delay = Math.max(0, nextDate.getTime() - Date.now());
            _updateTimer = setTimeout(async () => {
                if (cancelled) return;
                const updateArgs: string[] = buildRuntimeScriptArgs({
                    codeRoot: CODE_ROOT,
                    scriptSegments: ['scripts', 'update'],
                    scriptArgs: [],
                });
                const updateChild = spawn(Config.EXEC_PATH, updateArgs, {
                    cwd: PATHS.PROJECT_ROOT,
                    stdio: 'inherit',
                    env: buildScopedChildEnv({ extra: { DEXBOT_UPDATE_SKIP_RELOAD: '1' } }),
                });
                const code = await new Promise((resolve: any) => {
                    updateChild.on('close', resolve);
                });
                if (code === 0 && !cancelled) {
                    _pendingRestart = true;
                    const bot = botProcessRef?.current;
                    if (bot && !bot.killed) {
                        try { bot.kill('SIGTERM'); } catch (_) {}
                    }
                }
                if (!cancelled) scheduleNext();
            }, delay);
            if (_updateTimer && typeof _updateTimer.unref === 'function') {
                _updateTimer.unref();
            }
        } catch (err: any) {
            warn(`Update scheduler: ${getErrorMessage(err)}`);
            _updateTimer = setTimeout(scheduleNext, 3600000);
            if (_updateTimer && typeof _updateTimer.unref === 'function') {
                _updateTimer.unref();
            }
        }
    }

    scheduleNext();

    return {
        cancel: () => { cancelled = true; clearTimer(); },
        get pendingRestart() { return _pendingRestart; },
        set pendingRestart(v) { _pendingRestart = v; },
    };
}

// ── Control command helpers ────────────────────────────────────────

function listConfiguredBots(botsFile?: any) {
    try {
        const botsFilePath = botsFile || BOTS_FILE;
        const { config } = loadSettingsFile(botsFilePath);
        const raw = resolveRawBotEntries(config);
        return raw.map((b: any) => ({
            name: b.name,
            active: b.active !== false,
            gridPrice: typeof b.gridPrice === 'string' ? b.gridPrice.trim().toLowerCase() : '',
        }));
    } catch {
        return [];
    }
}

function getActiveAmaBotFingerprint(botsFile?: any) {
    return (botsFile ? listConfiguredBots(botsFile) : listConfiguredBots())
        .filter((b: any) => b.active && usesAmaGridPrice(b))
        .map((b: any) => `${b.name}:${b.gridPrice}`)
        .sort()
        .join('|');
}

function getAllControlBotNames() {
    // Prefer live bots.json (current intent) over the startup snapshot.
    // Shows what the user configured, even if the wrapper hasn't respawned yet.
    const liveBots = listConfiguredBots().filter((b: any) => b.active).map((b: any) => b.name);
    if (liveBots.length > 0) {
        return liveBots;
    }
    const botInfo = readMonolithicBotInfo();
    if (Array.isArray(botInfo?.botNames) && botInfo.botNames.length > 0) {
        return botInfo.botNames.map((name: any) => String(name));
    }
    if (botInfo?.botName) {
        return [String(botInfo.botName)];
    }
    return [];
}

function getControlBotNames(target: any, wholeRuntime: any = false) {
    if (target) return [target];
    if (wholeRuntime) return getAllControlBotNames();
    return [];
}

function getControlActionLabel(cmd: any) {
    if (cmd === 'restart' || cmd === 'restart-all') return 'restarting';
    if (cmd === 'shutdown' || cmd === 'delete') return 'shutting down';
    return 'stopping';
}

function usesAmaGridPrice(bot: any) {
    const gridPrice = typeof bot?.gridPrice === 'string' ? bot.gridPrice.trim().toLowerCase() : '';
    return /^ama(?:[1-4])?$/.test(gridPrice);
}

function getControlServiceNames(cmd: any, botNames: any) {
    if (!['stop-all', 'restart-all', 'delete', 'shutdown'].includes(cmd)) return [];
    const serviceNames: string[] = [];
    if (cmd === 'delete' || cmd === 'shutdown') {
        serviceNames.push('credential daemon');
    }
    const botNameSet = new Set(botNames);
    const affectedAmaBots = listConfiguredBots().some((bot: any) => (
        bot.active && usesAmaGridPrice(bot) && botNameSet.has(bot.name)
    ));
    if (affectedAmaBots) {
        serviceNames.push('market adapter');
    }
    return serviceNames;
}

function printControlActionSummary(action: any, botNames: any, serviceNames: any = []) {
    console.log('='.repeat(50));
    console.log(`DEXBot2 ${action} ${formatBotCount(botNames.length)}`);
    console.log();
    for (const botName of botNames) {
        console.log(`- ${botName}`);
    }
    for (const serviceName of serviceNames) {
        console.log(`- ${serviceName}`);
    }
    console.log('='.repeat(50));
    console.log();
}

export { MONOLITHIC_PID_FILE, MONOLITHIC_BOT_PID_FILE, MONOLITHIC_BOT_INFO_FILE, MONOLITHIC_CRED_PID_FILE, MONOLITHIC_OUT_LOG, MONOLITHIC_ERROR_LOG, CREDENTIAL_SOCKET_FILE, CREDENTIAL_READY_FILE, cleanupStateFiles, readLiveMonolithicPid, readMonolithicBotInfo, isLikelyCredentialDaemonProcess, isLikelyDexbotProcess, isLikelyUnlockProcess, isExpectedProcessStarttime, isExpectedMonolithicBotPid, readProcStat, stopCredentialDaemonPid, cleanupCredentialRuntimeFiles, stopCredentialDaemon, ensureNoForeignCredentialDaemon, findCredentialSocketOwnerPid, readCredentialDaemonStatus, ensureLogDir, buildDexbotStartArgs, buildUnlockArgs, createUpdateScheduler, getActiveAmaBotFingerprint, listConfiguredBots, getAllControlBotNames, getControlBotNames, getControlActionLabel, getControlServiceNames, printControlActionSummary, formatBotCount }

