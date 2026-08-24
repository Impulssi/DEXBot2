
import { getStorage } from '../storage/index.js';
import { getProcessDiscovery } from '../process_discovery.js';
import { isPidAlive } from './bot_supervisor.js';
import { runtime } from '../runtime.js';
import { sleep } from '../order/utils/system.js';
const storage = getStorage();
const { unlink: safeUnlink } = storage;

/**
 * Foreign credential daemon detection.
 *
 * The launcher can end up reusing a credential daemon that was NOT started
 * by the current `dexbot start` invocation. The readiness probe
 * (`isDaemonReady` / `isDaemonResponsive`) only checks that the socket is
 * answering, so a leftover daemon from a previous run, an old PM2 entry, or
 * a manually-spawned daemon can silently satisfy that probe — and the
 * launcher then skips the master password prompt.
 *
 * This module exposes the helper we use to detect and clean up that case.
 * Ownership is tracked via a PID file written by the launcher; the live
 * socket owner is discovered through ProcessDiscovery. If the two disagree
 * the helper kills the foreign daemon, removes the orphan runtime files,
 * and lets the caller fall through to the normal "prompt for master
 * password" path.
 */

function readCredentialSocketInode(socketPath: any) {
    return getProcessDiscovery().readSocketInode(socketPath);
}

function findCredentialSocketOwnerPid(socketPath: any, isLikelyProcess: any) {
    return getProcessDiscovery().findSocketOwnerPid(socketPath, isLikelyProcess || undefined);
}

function readOwnedCredentialDaemonPid(pidFile: any, isLikelyProcess: any) {
    if (!pidFile) return 0;
    let raw;
    try { raw = storage.readFile(pidFile); } catch (_) { return 0; }
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
        safeUnlink(pidFile)
        return 0;
    }
    if (!isPidAlive(pid)) {
        safeUnlink(pidFile)
        return 0;
    }
    if (typeof isLikelyProcess === 'function' && !isLikelyProcess(pid)) {
        safeUnlink(pidFile)
        return 0;
    }
    return pid;
}

async function stopPid(pid: any, timeoutMs: any = 5000) {
    if (!isPidAlive(pid)) return true;
    try {
        runtime.kill(pid, 'SIGTERM');
    } catch (e: any) {
        if (e.code !== 'ESRCH') throw e;
    }

    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
        if (!isPidAlive(pid)) return true;
        await sleep(100);
    }

    try {
        runtime.kill(pid, 'SIGKILL');
    } catch (e: any) {
        if (e.code !== 'ESRCH') throw e;
    }

    const killSettledAt = Date.now();
    while ((Date.now() - killSettledAt) < timeoutMs) {
        if (!isPidAlive(pid)) return true;
        await sleep(100);
    }
    return !isPidAlive(pid);
}

/**
 * Detect and clean up a credential daemon that is listening on our socket
 * but was NOT started by the current unlock session.
 *
 * Parameters
 * ----------
 * @param {Object} options
 * @param {string} options.socketPath - Path to the credential daemon's
 *   Unix socket (e.g. `$XDG_RUNTIME_DIR/dexbot2/dexbot-cred-daemon.sock`).
 * @param {string} options.readyFilePath - Path to the daemon's ready
 *   marker file.
 * @param {string} options.pidFile - Path to the ownership PID file the
 *   launcher writes when it starts a daemon.
 * @param {(pid: number) => boolean} options.isLikelyProcess - Returns true
 *   when the PID is a credential-daemon process.
 * @param {boolean} [options.verbose=true] - Log when a foreign daemon is
 *   found.
 *
 * @returns {Promise<boolean>} true when a foreign daemon was removed.
 */
async function ensureNoForeignCredentialDaemon({
    socketPath,
    readyFilePath,
    pidFile,
    isLikelyProcess,
    verbose = true,
}: {
    socketPath?: string;
    readyFilePath?: string;
    pidFile?: string;
    isLikelyProcess?: (pid: number) => boolean;
    verbose?: boolean;
} = {}) {
    if (!socketPath || !readyFilePath) return false;
    const socketExists = storage.exists(socketPath);
    const readyExists = storage.exists(readyFilePath);

    // Nothing on disk: nothing to clean, nothing to kill.
    if (!socketExists && !readyExists) return false;

    // Orphan ready file with no socket behind it (e.g. a previous launch
    // crashed after writing the ready marker but before binding the
    // socket, or someone manually deleted the socket). Treat as stale.
    if (!socketExists && readyExists) {
        safeUnlink(readyFilePath);
        return false;
    }

    // socketExists is true from here on. Probe the kernel and compare with
    // our ownership record. We deliberately do NOT require the ready
    // marker: a foreign daemon may be holding the socket after the ready
    // file was removed (e.g. by a previous unlock that did not own the
    // daemon). If we skip this case the controller will unlink the
    // socket and start a new daemon, leaving the old one orphaned in
    // memory with a live socket to nobody.
    const ownedPid = readOwnedCredentialDaemonPid(pidFile, isLikelyProcess);
    const liveOwnerPid = findCredentialSocketOwnerPid(socketPath, isLikelyProcess);

    if (ownedPid > 0 && liveOwnerPid === ownedPid) {
        return false;
    }

    if (liveOwnerPid > 0) {
        if (verbose) {
            // eslint-disable-next-line no-console
            console.warn(
                `[unlock] Detected foreign credential daemon (PID ${liveOwnerPid}) on ${socketPath} ` +
                `not started by this launcher — removing it to force a fresh master password prompt.`
            );
        }
        await stopPid(liveOwnerPid);
        safeUnlink(socketPath);
        safeUnlink(readyFilePath);
        return true;
    }

    // No live owner but the socket file is still on disk (e.g. left over
    // by a crashed daemon). Clean it up so the controller's own
    // removeStaleDaemonFiles does not have to deal with the wreckage.
    safeUnlink(socketPath);
    if (readyExists) safeUnlink(readyFilePath);
    return false;
}

export { ensureNoForeignCredentialDaemon, findCredentialSocketOwnerPid, readCredentialSocketInode, readOwnedCredentialDaemonPid, stopPid }

