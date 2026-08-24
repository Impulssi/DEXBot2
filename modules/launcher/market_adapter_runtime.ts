
import { buildScopedChildEnv } from './child_env.js';
import { Config } from '../config.js';
import { LAUNCHER } from '../constants.js';
import { PATHS } from '../paths.js';
import { getProcessDiscovery } from '../process_discovery.js';
import { withTimeout } from '../order/utils/timeout.js';
import { spawn } from 'node:child_process';
import { getStorage } from '../storage/index.js';
'use strict';

const storage = getStorage();
const { readJSON, unlink: safeUnlink } = storage;
import { buildRuntimeScriptPath, SCRIPTS_ROOT as DEFAULT_CODE_ROOT } from './runtime_entry.js';

const DEFAULT_SCRIPT = buildRuntimeScriptPath(DEFAULT_CODE_ROOT, ['market_adapter', 'market_adapter']);

function loadLockInfo(lockPath: string): any {
    try {
        const parsed = readJSON(lockPath);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_: any) {
        return {};
    }
}

function isLikelyMarketAdapterProcess(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (!getProcessDiscovery().isAlive(pid)) return false;
    const cmdline = getProcessDiscovery().readCmdline(pid);
    if (!cmdline) return false;
    return cmdline.includes('node') && /market_adapter\/market_adapter\.(?:js|ts)\b/.test(cmdline);
}

function isLockStale(
    lockPath = PATHS.MARKET_ADAPTER.LOCK_FILE,
    _staleAfterMs?: number,
    isAdapterProcess = isLikelyMarketAdapterProcess
): boolean {
    try {
        const info = loadLockInfo(lockPath);
        const pid = Number(info.pid);
        // Runtime startup may remove malformed locks so a new owned process can acquire the file.
        if (!Number.isInteger(pid) || pid <= 0) return true;
        // A lock whose holder is not a live market adapter process is stale,
        // regardless of file age. A live adapter's lock is never removed
        // solely because its mtime is old.
        return !isAdapterProcess(pid);
    } catch (_: any) {
        return false;
    }
}

function isLikelyAdapterRunning(lockPath = PATHS.MARKET_ADAPTER.LOCK_FILE) {
    try {
        const info = loadLockInfo(lockPath);
        const pid = Number(info.pid);
        if (!Number.isInteger(pid) || pid <= 0) return false;
        return isLikelyMarketAdapterProcess(pid);
    } catch (_: any) {
        return false;
    }
}

function waitForChildExit(child: any): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!child) {
            resolve(0);
            return;
        }

        child.once('error', reject);
        child.once('close', (code: any) => resolve(code));
    });
}

function createMarketAdapterRuntime({
    root = PATHS.PROJECT_ROOT,
    script = DEFAULT_SCRIPT,
    lockFile = PATHS.MARKET_ADAPTER.LOCK_FILE,
    spawnFn = spawn,
    buildEnv = buildScopedChildEnv,
} = {}) {
    let child: any = null;
    let childExitPromise: any = null;
    const desiredBots = new Set();

    function isOwnedChildRunning() {
        return !!(child && !child.killed && child.exitCode == null && child.signalCode == null);
    }

    function getActiveCount() {
        return desiredBots.size;
    }

    function getLockInfo() {
        return loadLockInfo(lockFile);
    }

    function isRunningExternally() {
        return isLikelyAdapterRunning(lockFile);
    }

    async function startOwnedProcess() {
        if (isOwnedChildRunning()) {
            return { running: true, owned: true, started: false };
        }

        if (isLockStale(lockFile)) {
            safeUnlink(lockFile)
        }

        if (isRunningExternally()) {
            return { running: true, owned: false, external: true, started: false };
        }

        const nodeArgs = script.endsWith('.ts') ? ['--import', 'tsx', script] : [script];
        const spawnedChild = spawnFn(Config.EXEC_PATH, nodeArgs, {
            cwd: root,
            env: buildEnv(),
            stdio: 'ignore',
        });
        child = spawnedChild;
        childExitPromise = waitForChildExit(spawnedChild).catch(() => 0).finally(() => {
            if (child === spawnedChild) {
                child = null;
                childExitPromise = null;
            }
        });

        return { running: true, owned: true, started: true };
    }

    async function stopOwnedProcess() {
        if (!child || child.killed) {
            child = null;
            childExitPromise = null;
            return { running: false, stopped: false };
        }

        try {
            child.kill('SIGTERM');
        } catch (_: any) {}

        await withTimeout(
            childExitPromise || waitForChildExit(child).catch(() => 0),
            LAUNCHER.SUPERVISOR.SHUTDOWN_TIMEOUT_MS,
            { onTimeout: 'resolve', defaultValue: 0 }
        );

        if (child && child.exitCode == null) {
            try {
                child.kill('SIGKILL');
            } catch (_: any) {}
        }

        child = null;
        childExitPromise = null;
        return { running: false, stopped: true };
    }

    async function syncBot(botId: string, shouldRun: boolean): Promise<any> {
        if (!botId) {
            throw new Error('botId is required');
        }

        if (shouldRun) {
            desiredBots.add(botId);
            return startOwnedProcess();
        }

        desiredBots.delete(botId);
        if (desiredBots.size === 0) {
            return stopOwnedProcess();
        }

        return {
            running: isOwnedChildRunning(),
            owned: isOwnedChildRunning(),
            started: false,
        };
    }

    async function releaseBot(botId: string): Promise<any> {
        if (botId) {
            desiredBots.delete(botId);
        }

        if (desiredBots.size === 0) {
            return stopOwnedProcess();
        }

        return {
            running: isOwnedChildRunning(),
            owned: isOwnedChildRunning(),
            stopped: false,
        };
    }

    function getStatus() {
        return {
            activeBotCount: getActiveCount(),
            botIds: [...desiredBots],
            hasOwnedChild: isOwnedChildRunning(),
            ownedPid: child?.pid || null,
            runningExternally: isRunningExternally(),
            lockInfo: getLockInfo(),
        };
    }

    async function shutdown() {
        desiredBots.clear();
        return stopOwnedProcess();
    }

    return {
        getStatus,
        releaseBot,
        shutdown,
        syncBot,
    };
}

let sharedRuntime: any = null;

function getSharedMarketAdapterRuntime(options = {}) {
    if (!sharedRuntime) {
        sharedRuntime = createMarketAdapterRuntime(options);
    }
    return sharedRuntime;
}

export { createMarketAdapterRuntime, getSharedMarketAdapterRuntime, isLikelyAdapterRunning, isLikelyMarketAdapterProcess, isLockStale, loadLockInfo, waitForChildExit }

