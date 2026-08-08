
import { getStorage } from '../../modules/storage/index.js';
import { path } from '../../modules/path_api.js';
import { PATHS } from '../../modules/paths.js';
import { Config } from '../../modules/config.js';
import * as bitsharesClient from './bitshares_client.js';
import * as chainBroadcast from './chain_broadcast.js';
import * as chainQueries from './chain_queries.js';
import * as credentialClient from './dexbot_credential_client.js';
import { createHonestEcosystemAdapter } from './honest_ecosystem.js';
import { loadDexbotOrderSubsystem } from './dexbot_bridge.js';
import { createDexbotProfileAdapter } from './dexbot_profiles.js';
import { createCreditRuntimeAdapter } from './credit_runtime_adapter.js';
import { acquireFileLock } from '../../market_adapter/utils/file_lock.js';
import { clone } from './utils.js';
const storage = getStorage();

import { createPositionManagerWatcher, parsePositionManagerWatchArgs, runPositionManagerWatch } from './position_manager_watch.js';

import type {
  RuntimeContextOptions,
  CredentialClientOptions,
  StateStoreOptions,
  BitsharesClientOptions,
  BroadcastOptions,
  ClawInfrastructureOptions,
} from './types.js';
import { getErrorMessage } from '../../modules/utils/errors.js';

const CLAW_ROOT = PATHS.CLAW.DIR;
const DEFAULT_DATA_DIR = PATHS.CLAW.DATA_DIR;
const DEFAULT_STATE_DIR = PATHS.CLAW.STATE_DIR;


/**
 * Create a runtime context object with paths, logger, and configuration.
 * Used by createClawInfrastructure to wire up all subsystems.
 */
function createRuntimeContext(options: RuntimeContextOptions = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const stateDir = options.stateDir || path.join(dataDir, 'state');

  return {
    accountName: options.accountName || null,
    config: clone(options.config) || {},
    createdAt: new Date().toISOString(),
    dataDir,
    cwd: Config.CWD,
    logger: options.logger || console,
    name: options.name || 'claw-runtime',
    profileRoot: options.profileRoot || Config.DEXBOT_PROFILE_ROOT || null,
    readyFilePath: options.readyFilePath || credentialClient.DEFAULT_READY_FILE,
    socketPath: options.socketPath || credentialClient.DEFAULT_SOCKET_PATH,
    stateDir
  };
}

/**
 * Create a filesystem-backed state store with atomic reads/writes and serialized write queue.
 * Provides read, write, patch, update, and clear operations.
 */
function createStateStore(options: StateStoreOptions = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const stateDir = options.stateDir || path.join(dataDir, 'state');
  const filePath = options.filePath || path.join(stateDir, 'claw-state.json');
  const defaultValue = clone(options.defaultValue);
  let writeQueue: Promise<any> = Promise.resolve();

  function readFromDisk(): any {
    try {
      if (!storage.exists(filePath)) {
        return clone(defaultValue);
      }
      const raw = storage.readFile(filePath, 'utf8');
      if (!raw.trim()) {
        return clone(defaultValue);
      }
      return JSON.parse(raw);
    } catch (error: any) {
      if (error && error.code === 'ENOENT') {
        return clone(defaultValue);
      }
      throw new Error(`Failed to read state store ${filePath}: ${getErrorMessage(error)}`);
    }
  }

  function writeUnlocked(value: any): void {
    const serialized = JSON.stringify(value === undefined ? null : value, null, 2);
    storage.writeFile(filePath, `${serialized}\n`, 'utf8');
  }

  async function withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    storage.ensureDir(path.dirname(filePath));
    const release = await acquireFileLock(filePath);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async function writeUnsafe(value: any): Promise<any> {
    await withFileLock(async () => {
      await writeUnlocked(value);
    });
    return value;
  }

  function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const queued = writeQueue.then(operation, operation);
    writeQueue = queued.catch(() => {});
    return queued;
  }

  async function write(value: any): Promise<any> {
    return serializeWrite(() => writeUnsafe(value));
  }

  async function patch(partial: any): Promise<any> {
    return serializeWrite(async () => {
      return withFileLock(async () => {
        const current = await readFromDisk();
        const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
        const next = {
          ...base,
          ...(partial && typeof partial === 'object' ? partial : {})
        };
        await writeUnlocked(next);
        return next;
      });
    });
  }

  async function update(updater: (state: any) => any): Promise<any> {
    if (typeof updater !== 'function') {
      throw new Error('update(updater) requires a function');
    }

    return serializeWrite(async () => {
      return withFileLock(async () => {
        const current = await readFromDisk();
        const next = await updater(clone(current));
        await writeUnlocked(next);
        return next;
      });
    });
  }

  async function clear(): Promise<any> {
    return serializeWrite(() => writeUnsafe(clone(defaultValue)));
  }

  return {
    clear,
    filePath,
    patch,
    read: readFromDisk,
    update,
    write
  };
}

/**
 * Create a credential-daemon client wrapper with isReady() and waitForReady() helpers.
 */
function createCredentialClient(options: CredentialClientOptions = {}) {
  const socketPath = options.socketPath || credentialClient.DEFAULT_SOCKET_PATH;
  const readyFilePath = options.readyFilePath || credentialClient.DEFAULT_READY_FILE;

  return {
    isReady: () => credentialClient.isCredentialDaemonReady({ socketPath, readyFilePath }),
    readyFilePath,
    socketPath,
    waitForReady: (timeoutMs?: number) => credentialClient.waitForCredentialDaemon(timeoutMs, {
      pollIntervalMs: options.pollIntervalMs,
      readyFilePath,
      socketPath
    })
  };
}

/**
 * Create a BitShares client adapter wrapping chain queries, broadcast, and signing.
 * Shares the DEXBot2 chain client infrastructure underneath.
 */
function createBitsharesClient(options: BitsharesClientOptions = {}) {
  const accountName = options.accountName || null;
  const socketPath = options.socketPath || credentialClient.DEFAULT_SOCKET_PATH;
  const readyFilePath = options.readyFilePath || credentialClient.DEFAULT_READY_FILE;

  return {
    accountName,
    createAccountClient: (name?: string, privateKey?: string) => bitsharesClient.createAccountClient(name ?? accountName, privateKey),
    credentials: {
      readyFilePath,
      socketPath
    },
    dbCall: chainQueries.dbCall,
    executeOperations: (operations: any, broadcastOptions: BroadcastOptions = {}) => chainBroadcast.executeOperations(operations, {
      ...broadcastOptions,
      accountName: broadcastOptions.accountName || accountName,
      readyFilePath,
      socketPath
    }),
    getSigningClient: (broadcastOptions: BroadcastOptions = {}) => chainBroadcast.getSigningClient({
      ...broadcastOptions,
      accountName: broadcastOptions.accountName || accountName,
      readyFilePath,
      socketPath
    }),
    isConnected: bitsharesClient.isConnected,
    read: chainQueries,
    setSuppressConnectionLog: bitsharesClient.setSuppressConnectionLog,
    waitForConnected: bitsharesClient.waitForConnected
  };
}

/**
 * Create a market adapter with readAccountSnapshot and readMarketSnapshot helpers,
 * delegating to chain_queries for individual data points.
 */
function createMarketAdapter(options: Record<string, any> = {}) {
  const readAccountSnapshot = async (accountRef: string) => {
    const [account, balances, openOrders] = await Promise.all([
      chainQueries.getFullAccount(accountRef),
      chainQueries.getBalances(accountRef),
      chainQueries.readOpenOrders(accountRef)
    ]);

    return {
      account,
      balances,
      openOrders
    };
  };

  const readMarketSnapshot = async (baseSymbol: string, quoteSymbol: string, limit: number = 10) => {
    const [dynamicGlobalProperties, orderBook, ticker] = await Promise.all([
      chainQueries.getDynamicGlobalProperties(),
      chainQueries.getOrderBook(baseSymbol, quoteSymbol, limit),
      chainQueries.getTicker(baseSymbol, quoteSymbol)
    ]);

    return {
      dynamicGlobalProperties,
      orderBook,
      ticker
    };
  };

  return {
    getAsset: chainQueries.getAsset,
    getBackingAsset: chainQueries.getBackingAsset,
    getBitassetData: chainQueries.getBitassetData,
    getCallOrders: chainQueries.getCallOrders,
    getDynamicGlobalProperties: chainQueries.getDynamicGlobalProperties,
    getFullAccount: chainQueries.getFullAccount,
    getOrderBook: chainQueries.getOrderBook,
    getTicker: chainQueries.getTicker,
    listAssets: chainQueries.listAssets,
    readAccountSnapshot,
    readMarketSnapshot,
    readOpenOrders: chainQueries.readOpenOrders,
    resolveAccountId: chainQueries.resolveAccountId,
    resolveAccountName: chainQueries.resolveAccountName
  };
}

/**
 * Load the DEXBot2 order subsystem as a tools object.
 */
function createOrderTools() {
  return loadDexbotOrderSubsystem();
}

/**
 * Create the full Claw infrastructure object: wires runtime context, state store,
 * credential client, BitShares client, market adapter, order tools, HONEST adapter,
 * profile adapter, and credit runtime adapter into a single object.
 */
function createClawInfrastructure(options: ClawInfrastructureOptions = {}) {
  const runtime = createRuntimeContext({
    ...options,
    ...(options.runtime || {})
  } as RuntimeContextOptions);
  const stateStore = createStateStore({
    ...(options.stateStore || {}),
    dataDir: (options.stateStore && options.stateStore.dataDir) || runtime.dataDir,
    defaultValue: options.stateDefaultValue,
    filePath: (options.stateStore && options.stateStore.filePath) || options.stateFilePath,
    stateDir: (options.stateStore && options.stateStore.stateDir) || runtime.stateDir
  });
  const credential = createCredentialClient((options.credential || options) as CredentialClientOptions);
  const bitshares = createBitsharesClient({
    ...(options.bitshares || {}),
    accountName: (options.bitshares && options.bitshares.accountName) || (runtime.accountName ?? undefined),
    readyFilePath: (options.bitshares && options.bitshares.readyFilePath) || credential.readyFilePath,
    socketPath: (options.bitshares && options.bitshares.socketPath) || credential.socketPath
  });
  const market = createMarketAdapter(options.market || options);
  const order = createOrderTools();
  const honest = createHonestEcosystemAdapter({
    logger: runtime.logger
  });
  const profiles = createDexbotProfileAdapter(runtime.profileRoot, {
    logger: runtime.logger
  });
  const creditRuntime = createCreditRuntimeAdapter(
    { profiles, runtime },
    { accountName: runtime.accountName || undefined, ...(options.creditRuntime || {}) }
  );
  return {
    bitshares,
    credential,
    creditRuntime,
    honest,
    profiles,
    market,
    order,
    runtime,
    stateStore
  };
}

export { DEFAULT_DATA_DIR, DEFAULT_STATE_DIR, createBitsharesClient, createClawInfrastructure, createCredentialClient, createHonestEcosystemAdapter, createMarketAdapter, createOrderTools, createRuntimeContext, createStateStore, createPositionManagerWatcher, parsePositionManagerWatchArgs, runPositionManagerWatch }

