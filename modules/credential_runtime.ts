
import { path } from './path_api';
import { getStorage } from './storage';
import { Config } from './config';
import { runtime } from './runtime';
import { ensureDir } from './utils/fs_utils';
const storage = getStorage();

interface RuntimeDirOptions {
    runtimeDir?: string;
    root?: string;
}
interface SocketPathOptions {
    socketPath?: string;
    runtimeDir?: string;
    root?: string;
}
interface ReadyFilePathOptions {
    readyFilePath?: string;
    runtimeDir?: string;
    root?: string;
}
interface PrivatePathOptions {
    expectedType?: 'file' | 'dir' | 'socket';
    requiredMode?: number;
    requireOwner?: boolean;
}

const DEFAULT_RUNTIME_DIR_NAME = 'dexbot2';
const DEFAULT_SOCKET_BASENAME = 'dexbot-cred-daemon.sock';
const DEFAULT_READY_BASENAME = 'dexbot-cred-daemon.ready';

let _resolveProjectRoot: any;
function getResolveProjectRoot() {
    if (_resolveProjectRoot === undefined) {
        try {
            _resolveProjectRoot = require('./launcher/runtime_entry').resolveProjectRoot;
        } catch {
            _resolveProjectRoot = null;
        }
    }
    if (!_resolveProjectRoot) {
        throw new Error('runtime_entry module not available in this environment');
    }
    return _resolveProjectRoot;
}

function getDexbotRoot() {
    const MODULE_DIR = path.dirname(__dirname);
    return getResolveProjectRoot()(MODULE_DIR);
}

function isUsableRuntimeBaseDir(dirPath: any) {
    try {
        storage.access(dirPath, 3);
        return storage.stat(dirPath).isDirectory();
    } catch (err: any) {
        return false;
    }
}

function getCredentialRuntimeDir(options: RuntimeDirOptions = {}) {
    if (options.runtimeDir) {
        return path.resolve(options.runtimeDir);
    }
    if (Config.DEXBOT_CRED_RUNTIME_DIR) {
        return path.resolve(Config.DEXBOT_CRED_RUNTIME_DIR);
    }
    if (Config.XDG_RUNTIME_DIR) {
        const xdgRuntimeDir = path.resolve(Config.XDG_RUNTIME_DIR);
        if (isUsableRuntimeBaseDir(xdgRuntimeDir)) {
            return path.join(xdgRuntimeDir, DEFAULT_RUNTIME_DIR_NAME);
        }
    }

    const root = options.root ? path.resolve(options.root) : getDexbotRoot();
    return path.join(root, 'profiles', 'run');
}

function getCredentialSocketPath(options: SocketPathOptions = {}) {
    if (options.socketPath) {
        return path.resolve(options.socketPath);
    }
    if (Config.DEXBOT_CRED_DAEMON_SOCKET) {
        return path.resolve(Config.DEXBOT_CRED_DAEMON_SOCKET);
    }
    return path.join(getCredentialRuntimeDir(options), DEFAULT_SOCKET_BASENAME);
}

function getCredentialReadyFilePath(options: ReadyFilePathOptions = {}) {
    if (options.readyFilePath) {
        return path.resolve(options.readyFilePath);
    }
    if (Config.DEXBOT_CRED_DAEMON_READY_FILE) {
        return path.resolve(Config.DEXBOT_CRED_DAEMON_READY_FILE);
    }
    return path.join(getCredentialRuntimeDir(options), DEFAULT_READY_BASENAME);
}

function ensureCredentialRuntimeDirSync(options: RuntimeDirOptions = {}) {
    const runtimeDir = getCredentialRuntimeDir(options);
    // mode: 0o700 in mkdirSync is sufficient; the redundant chmodSync that
    // previously followed was a no-op.  assertPrivatePathSecurity verifies
    // the resulting mode as a post-condition.
    ensureDir(runtimeDir, { mode: 0o700 });
    assertPrivatePathSecurity(runtimeDir, { expectedType: 'dir', requiredMode: 0o700 });
    return runtimeDir;
}

function getCurrentUid() {
    return runtime.getuid();
}

function assertPrivatePathSecurity(filePath: string, options: PrivatePathOptions = {}) {
    if (!filePath) {
        throw new Error('filePath is required');
    }

    const expectedType = options.expectedType || 'file';
    const requiredMode = options.requiredMode;
    const requireOwner = options.requireOwner !== false;

    if (Config.PLATFORM === 'win32' && expectedType === 'socket') {
        if (!storage.exists(filePath)) {
            throw new Error(`Missing socket path: ${filePath}`);
        }
        return null;
    }

    const stat = storage.lstat(filePath);

    if (stat.isSymbolicLink!()) {
        throw new Error(`Refusing to use symbolic link: ${filePath}`);
    }

    const typeCheck = {
        dir: () => stat.isDirectory(),
        file: () => stat.isFile(),
        socket: () => stat.isSocket!(),
    }[expectedType];

    if (!typeCheck) {
        throw new Error(`Unsupported expectedType: ${expectedType}`);
    }

    if (!typeCheck()) {
        throw new Error(`Unexpected path type for ${filePath}; expected ${expectedType}`);
    }

    const currentUid = getCurrentUid();
    if (requireOwner && currentUid !== null && currentUid !== 0
        && typeof stat.uid === 'number' && stat.uid !== currentUid) {
        throw new Error(`Unexpected owner for ${filePath}; expected uid ${currentUid}, found ${stat.uid}`);
    }
    if (Number.isInteger(requiredMode) && Config.PLATFORM !== 'win32') {
        const mode = stat.mode! & 0o777;
        if (mode !== requiredMode) {
            throw new Error(`Unexpected permissions for ${filePath}; expected ${requiredMode!.toString(8)}, found ${mode.toString(8)}`);
        }
    }

    return stat;
}

function isPrivatePathSecure(filePath: string, options: PrivatePathOptions = {}) {
    try {
        assertPrivatePathSecurity(filePath, options);
        return true;
    } catch {
        return false;
    }
}

export { DEFAULT_READY_BASENAME, DEFAULT_RUNTIME_DIR_NAME, DEFAULT_SOCKET_BASENAME, assertPrivatePathSecurity, ensureCredentialRuntimeDirSync, getCredentialReadyFilePath, getCredentialRuntimeDir, getCredentialSocketPath, getCurrentUid, isUsableRuntimeBaseDir, isPrivatePathSecure }

