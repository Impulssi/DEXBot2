'use strict';

const { getStorage } = require('../storage');
const storage = getStorage();
const { spawn } = require('child_process');
const { buildScopedChildEnv } = require('./child_env');
const { Config } = require('../config');
const { MARKET_ADAPTER } = require('../constants');
const { buildRuntimeScriptPath, SCRIPTS_ROOT: DEFAULT_CODE_ROOT } = require('./runtime_entry');
const { PATHS } = require('../paths');
const { readJSON, safeUnlink } = require('../utils/fs_utils');
const { getProcessDiscovery } = require('../process_discovery');

const DEFAULT_SCRIPT = buildRuntimeScriptPath(DEFAULT_CODE_ROOT, ['market_adapter', 'market_adapter']);
const DEFAULT_STALE_LOCK_MS = (
    MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds * 1000 +
    MARKET_ADAPTER.WATCHDOG_DEFAULTS.staleLockGraceMs
);

function loadLockInfo(lockPath: string): any {
    try {
        const parsed = readJSON(lockPath);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_: any) {
        return {};
    }
}

function isProcessAlive(pid: number): boolean {
    return getProcessDiscovery().isAlive(pid);
}

function isLikelyMarketAdapterProcess(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (!getProcessDiscovery().isAlive(pid)) return false;
    const cmdline = getProcessDiscovery().readCmdline(pid);
    if (!cmdline) return false;
    return cmdline.includes('node') && /market_adapter\/market_adapter\.(?:js|ts)\b/.test(cmdline);
}

function isLockStale(lockPath = PATHS.MARKET_ADAPTER.LOCK_FILE, staleAfterMs = DEFAULT_STALE_LOCK_MS, isAdapterProcess = isLikelyMarketAdapterProcess): boolean {
    try {
        const info = loadLockInfo(lockPath);
        const pid = Number(info.pid);
        // Runtime startup may remove malformed locks so a new owned process can acquire the file.
        if (!Number.isInteger(pid) || pid <= 0) return true;
        if (!isAdapterProcess(pid)) return true;
        const mtimeMs = storage.stat(lockPath).mtimeMs;
        if ((Date.now() - mtimeMs) > staleAfterMs) {
            return !isAdapterProcess(pid);
        }
        return false;
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

        await Promise.race([
            childExitPromise || waitForChildExit(child).catch(() => 0),
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);

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

function resetSharedMarketAdapterRuntime() {
    sharedRuntime = null;
}

export = {
    createMarketAdapterRuntime,
    getSharedMarketAdapterRuntime,
    isLikelyAdapterRunning,
    isLikelyMarketAdapterProcess,
    isLockStale,
    isProcessAlive,
    loadLockInfo,
    resetSharedMarketAdapterRuntime,
    waitForChildExit,
};
