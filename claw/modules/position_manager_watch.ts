
import { getStorage } from '../../modules/storage';
import { path } from '../../modules/path_api';
import { PATHS } from '../../modules/paths';
import { PositionManager, DEFAULT_STATE_PATH } from './position_manager';
import * as client from './bitshares_client';
const { waitForConnected } = client;
import { PIPELINE_TIMING } from '../../modules/constants';
import { Config } from '../../modules/config';
import { runtime } from '../../modules/runtime';
import { clone } from './utils';
import { getErrorMessage } from '../../modules/utils/errors';
const storage = getStorage();

const DEFAULT_HEALTH_PATH = PATHS.CLAW.WATCHER_HEALTH_FILE;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;


function parsePositionManagerWatchArgs(argv: string[] = [], env = runtime.env) {
  const options = {
    accountName: env.BITSHARES_ACCOUNT || null,
    healthPath: DEFAULT_HEALTH_PATH,
    maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
    statePath: DEFAULT_STATE_PATH,
    syncIntervalMs: PIPELINE_TIMING.TIMEOUT_MS
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--account' && next) {
      options.accountName = next;
      i += 1;
    } else if (arg === '--state' && next) {
      options.statePath = next;
      i += 1;
    } else if (arg === '--sync-interval' && next) {
      options.syncIntervalMs = Number(next);
      i += 1;
    } else if (arg === '--health-path' && next) {
      options.healthPath = next;
      i += 1;
    } else if (arg === '--max-failures' && next) {
      options.maxConsecutiveFailures = Number(next);
      i += 1;
    }
  }

  return options;
}

async function main(argv = Config.ARGS, env = runtime.env, logger: Record<string, any> = console) {
  const options = parsePositionManagerWatchArgs(argv, env);
  const watcher = await runPositionManagerWatch({
    ...options,
    logger
  });

  const handleSignal = () => {
    watcher.stop().finally(() => runtime.exit(0));
  };

  runtime.onSignal('SIGINT', handleSignal);
  runtime.onSignal('SIGTERM', handleSignal);
}

function resolveLogger(logger: any) {
  const fallback = console;
  return {
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : fallback.log.bind(fallback),
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : fallback.warn.bind(fallback),
    error: typeof logger?.error === 'function' ? logger.error.bind(logger) : fallback.error.bind(fallback)
  };
}

function createPositionManagerWatcher(options: Record<string, any> = {}) {
  const logger = resolveLogger(options.logger);
  const resolvedOptions = {
    accountName: options.accountName || Config.BITSHARES_ACCOUNT || null,
    healthPath: options.healthPath || DEFAULT_HEALTH_PATH,
    maxConsecutiveFailures: Number.isFinite(Number(options.maxConsecutiveFailures))
      ? Number(options.maxConsecutiveFailures)
      : DEFAULT_MAX_CONSECUTIVE_FAILURES,
    statePath: options.statePath || DEFAULT_STATE_PATH,
    syncIntervalMs: Number.isFinite(Number(options.syncIntervalMs)) && Number(options.syncIntervalMs) > 0
      ? Number(options.syncIntervalMs)
      : PIPELINE_TIMING.TIMEOUT_MS
  };

  const manager = new PositionManager({ statePath: resolvedOptions.statePath });
  let running = false;
  let syncTimer: any = null;
  let unsubscribe: any = null;
  let syncInFlight = false;

  // Health tracking state
  let consecutiveFailures = 0;
  let lastSuccessAt: string | null = null;
  let lastFailureAt: string | null = null;
  let lastFailureMessage: string | null = null;
  let healthWriteChain: Promise<any> = Promise.resolve();

  function getHealth() {
    return {
      checkedAt: new Date().toISOString(),
      consecutiveFailures,
      lastFailureAt,
      lastFailureMessage,
      lastSuccessAt,
      running,
      // Informational only — the watcher continues syncing regardless of status
      status: consecutiveFailures >= resolvedOptions.maxConsecutiveFailures ? 'unhealthy' : 'healthy'
    };
  }

  function writeHealth() {
    try {
      storage.writeJSON(resolvedOptions.healthPath, getHealth());
    } catch {
      // Best-effort — do not let health writes break the watcher
    }
  }

  function queueHealthWrite() {
    healthWriteChain = healthWriteChain.then(() => writeHealth()).catch(() => null);
    return healthWriteChain;
  }

  async function recordSyncSuccess() {
    consecutiveFailures = 0;
    lastSuccessAt = new Date().toISOString();
    await queueHealthWrite();
  }

  async function recordSyncFailure(err: any) {
    consecutiveFailures += 1;
    lastFailureAt = new Date().toISOString();
    lastFailureMessage = getErrorMessage(err);

    if (consecutiveFailures >= resolvedOptions.maxConsecutiveFailures) {
      logger.error(`[position-manager-watch] sync failed ${consecutiveFailures} consecutive times: ${lastFailureMessage}`);
    } else {
      logger.warn(`[position-manager-watch] sync failed (${consecutiveFailures}/${resolvedOptions.maxConsecutiveFailures}): ${lastFailureMessage}`);
    }
    await queueHealthWrite();
  }

  const stop = async () => {
    if (!running) {
      return;
    }

    running = false;
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    if (typeof unsubscribe === 'function') {
      await unsubscribe().catch(() => null);
      unsubscribe = null;
    }
    await queueHealthWrite();
  };

  const start = async () => {
    if (running) {
      return {
        getHealth,
        manager,
        options: resolvedOptions,
        stop
      };
    }

    if (!resolvedOptions.accountName) {
      throw new Error('accountName is required. Pass --account or set BITSHARES_ACCOUNT.');
    }

    running = true;
    logger.info(`[position-manager-watch] starting for ${resolvedOptions.accountName}`);

    await waitForConnected().catch((err: any) => {
      throw new Error(`BitShares connection not ready: ${getErrorMessage(err)}`);
    });

    await manager.syncAllPositions()
      .then(() => recordSyncSuccess())
      .catch((err: any) => recordSyncFailure(err));

    unsubscribe = await manager.watchAccount(resolvedOptions.accountName, async (position: any) => {
      logger.info(`[position-manager-watch] fill observed for ${position.id}`);
      if (typeof options.onFill === 'function') {
        await options.onFill(clone(position));
      }
    });

    syncTimer = setInterval(() => {
      if (!running) {
        return;
      }
      // Guard against overlapping ticks: if a previous sync is still running
      // (slow chain / stall), skip this tick rather than queue a second
      // syncAllPositions call on top of the first.
      if (syncInFlight) {
        return;
      }
      syncInFlight = true;
      manager.syncAllPositions()
        .then(() => recordSyncSuccess())
        .catch((err: any) => recordSyncFailure(err))
        .finally(() => {
          syncInFlight = false;
        });
    }, resolvedOptions.syncIntervalMs);
    if (typeof syncTimer.unref === 'function') {
      syncTimer.unref();
    }

    logger.info('[position-manager-watch] running');
    return {
      getHealth,
      manager,
      options: resolvedOptions,
      stop
    };
  };

  return {
    getHealth,
    manager,
    options: resolvedOptions,
    start,
    stop
  };
}

async function runPositionManagerWatch(options: Record<string, any> = {}) {
  const watcher = createPositionManagerWatcher(options);
  return watcher.start();
}

export { DEFAULT_HEALTH_PATH, DEFAULT_MAX_CONSECUTIVE_FAILURES, createPositionManagerWatcher, parsePositionManagerWatchArgs, runPositionManagerWatch, main }

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((err) => {
    console.error(getErrorMessage(err));
    runtime.exit(1);
  });
}

