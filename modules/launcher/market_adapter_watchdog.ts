
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { LAUNCHER, MARKET_ADAPTER } from '../constants';
import { Config } from '../config';
import { PATHS } from '../paths';
import { isLikelyMarketAdapterProcess, isLockStale } from './market_adapter_runtime';
import { readProcMemMB, readProcUptime } from './status_reporting';
import { getActiveAmaBotFingerprint } from './monolithic_runtime';
'use strict';

import { buildRuntimeScriptArgs, SCRIPTS_ROOT as DEFAULT_CODE_ROOT } from './runtime_entry';
import { getErrorMessage } from '../utils/errors';
import { withTimeout } from '../order/utils/timeout';
import { getStorage } from '../storage';
const storage = getStorage();
const { readJSON, unlink: safeUnlink } = storage;

function createMarketAdapterWatchdog({
    codeRoot = DEFAULT_CODE_ROOT,
    root = PATHS.PROJECT_ROOT,
    lockFile = PATHS.MARKET_ADAPTER.LOCK_FILE,
    botsFile = PATHS.PROFILES.BOTS_JSON,
    logWarn = console.warn,
    logError = console.error,
}: any = {}) {
    let _watchdogTimer: any = null;
    let _child: any = null;
    let _childStartedAt = 0;
    let _restartCount = 0;
    let _restartExhaustedAt = 0;
    let _fingerprint = '';

    function clearTimer() {
        if (_watchdogTimer) {
            clearInterval(_watchdogTimer);
            _watchdogTimer = null;
        }
    }

    function isOwnedChildRunning() {
        return !!(_child && !_child.killed && _child.exitCode == null && _child.signalCode == null);
    }

    function readLockPid() {
        try {
            const info = readJSON(lockFile);
            return Number(info.pid) || 0;
        } catch {
            return 0;
        }
    }

    function removeLockIfNotLive() {
        const pid = readLockPid();
        if (!pid || !isLikelyMarketAdapterProcess(pid)) {
            safeUnlink(lockFile)
            return true;
        }
        return false;
    }

    async function stopOwnedChild() {
        if (!_child || _child.killed) {
            _child = null;
            _childStartedAt = 0;
            return;
        }
        try {
            _child.kill('SIGTERM');
        } catch (_) {}
        const exited = await withTimeout(
            new Promise((resolve: any) => {
                _child.once('close', () => resolve(true));
            }),
            LAUNCHER.SUPERVISOR.SHUTDOWN_TIMEOUT_MS,
            { onTimeout: 'resolve', defaultValue: false }
        );
        if (!exited && _child && _child.exitCode == null) {
            try {
                _child.kill('SIGKILL');
            } catch (_) {}
        }
        _child = null;
        _childStartedAt = 0;
        safeUnlink(lockFile)
    }

    function spawnChild(errorLog: any) {
        const args = buildRuntimeScriptArgs({ codeRoot, scriptSegments: ['market_adapter', 'market_adapter'] });
        const child = spawn(Config.EXEC_PATH, args, {
            cwd: root,
            env: process.env,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        const childLogStreams: any[] = [];
        if (child.stderr) {
            const errStream = fs.createWriteStream(errorLog, { flags: 'a' });
            childLogStreams.push(errStream);
            child.stderr.pipe(errStream);
            child.stderr.on('error', () => {});
        }
        child.once('close', () => {
            for (const stream of childLogStreams) {
                try { stream.end(); } catch (_) {}
            }
            if (_child === child) {
                _child = null;
                _childStartedAt = 0;
            }
        });
        _child = child;
        _childStartedAt = Date.now();
        return child;
    }

    function resetRestartBudget() {
        _restartCount = 0;
        _restartExhaustedAt = 0;
    }

    function readAdapterStatus() {
        try {
            const info = readJSON(lockFile);
            const pid = Number(info.pid);
            if (!Number.isInteger(pid) || pid <= 0) {
                return { pid: null, alive: false, uptime: '-', mem: '-' };
            }
            const alive = isLikelyMarketAdapterProcess(pid);
            return {
                pid,
                alive,
                uptime: alive ? readProcUptime(pid) : '-',
                mem: alive ? readProcMemMB(pid) : '-',
            };
        } catch (_) {
            return { pid: null, alive: false, uptime: '-', mem: '-' };
        }
    }

    function isLikelyRunning() {
        const status = readAdapterStatus();
        return !!(status.pid && status.alive);
    }

    function schedule(errorLog: any) {
        clearTimer();

        const tick = () => {
            try {
                const activeAmaFingerprint = getActiveAmaBotFingerprint(botsFile);
                if (activeAmaFingerprint !== _fingerprint) {
                    _fingerprint = activeAmaFingerprint;
                    resetRestartBudget();
                }

                if (!activeAmaFingerprint) {
                    if (isOwnedChildRunning()) {
                        stopOwnedChild().catch(() => {});
                    }
                    removeLockIfNotLive();
                    resetRestartBudget();
                    return;
                }

                const staleGraceMs = (
                    MARKET_ADAPTER.RUNTIME_DEFAULTS.pollSeconds * 1000 +
                    MARKET_ADAPTER.WATCHDOG_DEFAULTS.staleLockGraceMs
                );
                if (isLockStale(lockFile, staleGraceMs)) {
                    const stalePid = readLockPid();
                    safeUnlink(lockFile)
                    logWarn(`[market-adapter-watchdog] removed stale lock (was pid=${stalePid})`);
                }

                if (isLikelyRunning()) {
                    return;
                }

                if (isOwnedChildRunning()) {
                    return;
                }

                const uptime = Date.now() - _childStartedAt;
                if (_childStartedAt > 0 && uptime >= MARKET_ADAPTER.WATCHDOG_DEFAULTS.minUptimeMs) {
                    resetRestartBudget();
                }

                if (_restartExhaustedAt > 0) {
                    const exhaustedForMs = Date.now() - _restartExhaustedAt;
                    if (exhaustedForMs < MARKET_ADAPTER.WATCHDOG_DEFAULTS.restartExhaustionResetMs) {
                        return;
                    }
                    resetRestartBudget();
                    logWarn('[market-adapter-watchdog] restart budget reset after cooldown');
                }

                const nextAttempt = _restartCount + 1;
                if (nextAttempt > MARKET_ADAPTER.WATCHDOG_DEFAULTS.maxRestarts) {
                    _restartExhaustedAt = Date.now();
                    logError(`[market-adapter-watchdog] exceeded max restarts (${MARKET_ADAPTER.WATCHDOG_DEFAULTS.maxRestarts}), giving up until restart budget resets`);
                    return;
                }
                _restartCount = nextAttempt;
                logWarn(`[market-adapter-watchdog] spawning market adapter (attempt ${_restartCount}/${MARKET_ADAPTER.WATCHDOG_DEFAULTS.maxRestarts})`);
                try {
                    spawnChild(errorLog);
                } catch (err: any) {
                    logError(`[market-adapter-watchdog] spawn failed: ${getErrorMessage(err)}`);
                }
            } catch (err: any) {
                logWarn(`[market-adapter-watchdog] tick error: ${getErrorMessage(err)}`);
            }
        };

        _watchdogTimer = setInterval(tick, MARKET_ADAPTER.WATCHDOG_DEFAULTS.intervalMs);
        if (_watchdogTimer && typeof (_watchdogTimer as any).unref === 'function') {
            _watchdogTimer.unref();
        }

        tick();

        return () => {
            clearTimer();
        };
    }

    async function stop() {
        clearTimer();
        await stopOwnedChild();
    }

    return {
        schedule,
        stop,
        isLikelyRunning,
        readAdapterStatus,
        stopOwnedChild,
    };
}

export { createMarketAdapterWatchdog }

