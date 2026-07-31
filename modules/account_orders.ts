/**
 * modules/account_orders.ts - Order Grid Persistence Layer
 *
 * Local persistence for order grid snapshots and state.
 * Enables bot recovery after crashes or restarts.
 *
 * Per-Bot Architecture:
 * Each bot has its own dedicated file: profiles/orders/{botKey}.json
 * The file stores a single bot's data directly (no per-file wrapper),
 * which makes the doubled-entry bug structurally impossible.
 *
 * ===============================================================================
 * EXPORTS (1 class + 1 helper)
 * ===============================================================================
 *
 * 1. AccountOrders(botKey) - Class for per-bot order persistence
 *    Methods: readOrders(), writeOrders(meta, grid, state), deleteOrders(), etc.
 *    Constructor requires botKey (throws if missing)
 *
 * 2. createBotKey(accountName, assetA, assetB) - Generate unique bot key string
 *
 * ===============================================================================
 *
 * FILE STRUCTURE (profiles/orders/{botKey}.json):
 * {
 *   "meta": {
 *     "name": "Bot name",
 *     "assetA": "BTS",
 *     "assetB": "USD",
 *     "active": true,
 *     "index": 0
 *   },
 *   "grid": [
 *     { "id": "slot-0", "type": "buy", "state": "virtual", "price": 100, "size": 1, "orderId": null },
 *     ...
 *   ],
 *   "btsFeesOwed": 0.1,
 *   "createdAt": "ISO timestamp",
 *   "lastUpdated": "ISO timestamp"
 * }
 *
 * GRID ENTRY FIELDS:
 * - id: Unique identifier (format: slot-N or custom)
 * - type: 'buy', 'sell', or 'spread'
 * - state: 'virtual', 'active', or 'partial'
 * - price: Price level
 * - size: Order size in base asset
 * - orderId: Blockchain order ID (null for VIRTUAL)
 *
 * ===============================================================================
 */


import { path } from './path_api';
import { getStorage } from './storage';
import { ORDER_TYPES, ORDER_STATES } from './constants';
import { PATHS } from './paths';
import AsyncLock from './order/async_lock';
import { isPhantomOrder } from './order/utils/order';
import * as Format from './order/format';
import { ensureDir } from './order/utils/system';
import Logger from './logger';
import { getErrorMessage } from './utils/errors';
const storage = getStorage();
const { toFiniteNumber } = Format;


const accountOrdersLogger = new Logger('AccountOrders');

/**
 * Ensures that the directory for the given file path exists.
 * @param {string} filePath - The file path to check.
 * @private
 */
function ensureDirExists(filePath: any) {
  ensureDir(path.dirname(filePath));
}

/**
 * Sanitizes a string to be used as a key in storage.
 * @param {string} source - The source string.
 * @returns {string} The sanitized string.
 * @private
 */
function sanitizeKey(source: any) {
  if (!source) return 'bot';
  return String(source)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'bot';
}

/**
 * Generate a unique key for identifying a bot in storage.
 * Bot names are enforced unique, so for named bots the key is simply
 * the sanitized name. Unnamed bots fall back to sanitized asset pair + index.
 *
 * @param {Object} bot - Bot configuration
 * @param {number} index - Index in bots array (used for unnamed fallback)
 * @returns {string} Sanitized key
 */
function createBotKey(bot: any, index: any) {
  if (bot && bot.name) {
    return sanitizeKey(bot.name);
  }
  const identifier = bot && bot.assetA && bot.assetB
    ? `${bot.assetA}/${bot.assetB}`
    : bot && bot.assetAId && bot.assetBId
      ? `${bot.assetAId}/${bot.assetBId}`
      : `bot-${index}`;
  return `${sanitizeKey(identifier)}-${index}`;
}

/**
 * Returns the current date and time in ISO format.
 * @returns {string} ISO timestamp.
 * @private
 */
function nowIso() {
  return new Date().toISOString();
}

const SENSITIVE_KEY_PATTERN = /(private|secret|password|credential|wif|token|hmac|memo)/i;

function cloneForDebug(value: any, seen: any = new WeakSet()): any {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (value instanceof Map) {
    seen.add(value);
    return Object.fromEntries(Array.from(value.entries(), ([key, item]: any) => [
      key,
      SENSITIVE_KEY_PATTERN.test(String(key)) ? '[REDACTED]' : cloneForDebug(item, seen)
    ]));
  }
  if (value instanceof Set) {
    seen.add(value);
    return Array.from(value.values(), (item: any) => cloneForDebug(item, seen));
  }
  if (value instanceof Date) return value.toISOString();

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item: any) => cloneForDebug(item, seen));
  }

  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'function') continue;
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : cloneForDebug(item, seen);
  }
  return result;
}

/**
 * Builds an empty per-bot data object. The file is single-object, so this is
 * the default content when the file does not yet exist.
 * @returns {Object} Fresh data object
 * @private
 */
function emptyData() {
  const timestamp = nowIso();
  return {
    meta: null,
    grid: [],
    btsFeesOwed: 0,
    btsBalance: null,
    boundaryIdx: null,
    assets: null,
    debugInputs: null,
    processedFills: {},
    recentFillKeys: {},
    createdAt: timestamp,
    lastUpdated: timestamp
  };
}

/**
 * AccountOrders class - manages order grid persistence
 *
 * Provides methods to:
 * - Store and load order grid snapshots
 * - Track bot metadata and state
 * - Calculate asset balances from stored grids
 *
 * Each bot has its own file: {botkey}.json
 * The file holds the bot's data directly (no `bots: { [key]: ... }` wrapper).
 *
 * @class
 */
class AccountOrders {
  botKey: string;
  profilesPath: string;
  _persistenceLock: any;
  _needsBootstrapSave: boolean;
  data: any;

  /**
   * Create an AccountOrders instance.
   * @param {Object} options - Configuration options
   * @param {string} options.botKey - Bot identifier (e.g., 'xrp-bts-0', 'h-bts-1')
   * @param {string} [options.ordersDir] - Optional override for the per-bot storage directory
   * @param {string} [options.profilesPath] - Optional override for the per-bot storage file path
   */
  constructor(options: { botKey: string; ordersDir?: string; profilesPath?: string } = { botKey: '' }) {
    if (!options.botKey) throw new Error("botKey required for AccountOrders");
    this.botKey = options.botKey;

    // Use per-bot file: {botKey}.json
    const ordersDir = options.ordersDir || PATHS.ORDERS_DIR;
    this.profilesPath = options.profilesPath || path.join(ordersDir, `${this.botKey}.json`);

    // AsyncLock prevents concurrent read-modify-write races on file I/O
    this._persistenceLock = new AsyncLock();

    this._needsBootstrapSave = !storage.exists(this.profilesPath);
    this.data = this._loadData() || emptyData();
    // One-time upgrade migration: pre-1.1.0 files used a { bots: { [key]: ... } }
    // wrapper. Strip it and rewrite the file in the flat shape so the bot keeps
    // its grid across the upgrade.
    if (this._migrateLegacyWrapper()) {
      this._needsBootstrapSave = true;
    }
    if (this._needsBootstrapSave) {
      this._persist();
    }
  }

  /**
   * Loads the data for the current bot from its profile file.
   * @returns {Object|null} The loaded data or null if not found.
   * @private
   */
  _loadData() {
    // Load the file directly - per-bot files only contain their own bot's data
    return this._readFile(this.profilesPath);
  }

  /**
   * Detects the pre-1.1.0 `{ bots: { [key]: ... } }` wrapper in `this.data` and,
   * if present, extracts the entry matching this.botKey (and warns about any
   * other keys, which were the doubled-entry bug). Returns true when a rewrite
   * is required.
   * @returns {boolean} True when this.data was rewritten and needs persistence.
   * @private
   */
  _migrateLegacyWrapper(): boolean {
    const data = this.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (!data.bots || typeof data.bots !== 'object' || Array.isArray(data.bots)) return false;

    const bots = data.bots;
    const keys = Object.keys(bots);
    if (keys.length === 0) {
      this.data = emptyData();
      accountOrdersLogger.info(`Migrated legacy empty bots wrapper for ${this.botKey}`);
      return true;
    }

    const matching = bots[this.botKey];
    if (matching && typeof matching === 'object' && !Array.isArray(matching)) {
      this.data = { ...emptyData(), ...matching };
      const orphans = keys.filter((k: any) => k !== this.botKey);
      if (orphans.length > 0) {
        accountOrdersLogger.warn(
          `Discarded ${orphans.length} orphan bot entr${orphans.length === 1 ? 'y' : 'ies'} ` +
          `from legacy wrapper in ${this.botKey}.json: ${orphans.join(', ')}`
        );
      }
      accountOrdersLogger.info(`Migrated legacy { bots: { ... } } wrapper for ${this.botKey}`);
      return true;
    }

    // No usable entry for this bot. Pick the first object-valued entry, or
    // start fresh if every value is corrupt (array / primitive / null).
    const fallbackKey = keys.find((k: any) => {
      const v = bots[k];
      return v && typeof v === 'object' && !Array.isArray(v);
    });
    if (fallbackKey) {
      const fallback = bots[fallbackKey];
      accountOrdersLogger.warn(
        `Legacy wrapper in ${this.botKey}.json had no entry for this bot; ` +
        `falling back to ${fallbackKey}`
      );
      this.data = { ...emptyData(), ...fallback };
      return true;
    }

    accountOrdersLogger.warn(
      `Legacy wrapper in ${this.botKey}.json had no object entry; starting with empty data`
    );
    this.data = emptyData();
    return true;
  }

  /**
   * Reads and parses a JSON file.
   * @param {string} filePath - The path to the file.
   * @returns {Object|null} The parsed object or null on failure.
   * @private
   */
  _readFile(filePath: any) {
    try {
      const parsed = storage.readJSON(filePath);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) {
        accountOrdersLogger.warn(`Failed to read ${filePath} - ${getErrorMessage(err)}`);
      }
    }
    return null;
  }

  /**
   * Persists the current data to the profile file.
   * @private
   */
  _persist() {
    ensureDirExists(this.profilesPath);
    storage.writeJSON(this.profilesPath, this.data, { fsync: true });
  }

  /**
   * Sync the persisted meta for this bot from its bots.json entry.
   * Creates a new file if the meta was never written; updates the existing
   * meta in place if it has drifted. The grid and other state are not touched.
   * @param {Object} botConfig - The bot config matching this.botKey
   */
  async syncMeta(botConfig: any) {
    if (!botConfig) return;

    await this._persistenceLock.acquire(async () => {
      // Reload from disk to ensure we have the latest state
      this.data = this._loadData() || emptyData();

      const newMeta = this._buildMeta(botConfig, this.botKey, botConfig.botIndex ?? 0, this.data.meta);
      const prevMeta = this.data.meta;

      if (this._metaChanged(prevMeta, newMeta)) {
        accountOrdersLogger.info(`Metadata changed for bot ${this.botKey}: updating from old metadata to new`);
        accountOrdersLogger.info(`  OLD: name=${prevMeta?.name}, assetA=${prevMeta?.assetA}, assetB=${prevMeta?.assetB}, active=${prevMeta?.active}`);
        accountOrdersLogger.info(`  NEW: name=${newMeta.name}, assetA=${newMeta.assetA}, assetB=${newMeta.assetB}, active=${newMeta.active}`);
        this.data.meta = { ...(prevMeta || {}), ...newMeta, createdAt: prevMeta?.createdAt || newMeta.createdAt };
        this.data.lastUpdated = nowIso();
        this._persist();
      } else {
        accountOrdersLogger.info(`No metadata change for bot ${this.botKey} - skipping update`);
        accountOrdersLogger.info(`  CURRENT: name=${prevMeta?.name}, assetA=${prevMeta?.assetA}, assetB=${prevMeta?.assetB}, active=${prevMeta?.active}`);
        accountOrdersLogger.info(`  PASSED:  name=${newMeta.name}, assetA=${newMeta.assetA}, assetB=${newMeta.assetB}, active=${newMeta.active}`);
      }
    });
  }

  /**
   * Checks whether two meta objects differ on the relevant fields.
   * @param {Object} existing - The existing meta (possibly null).
   * @param {Object} next - The new meta.
   * @returns {boolean} True if meta has changed.
   * @private
   */
  _metaChanged(existing: any, next: any) {
    if (!existing) return true;
    return existing.name !== next.name ||
      existing.assetA !== next.assetA ||
      existing.assetB !== next.assetB ||
      existing.active !== next.active ||
      existing.index !== next.index;
  }

  /**
   * Builds a metadata object for a bot.
   * @param {Object} bot - The bot configuration.
   * @param {string} key - The bot key.
   * @param {number} index - The bot index.
   * @param {Object|null} [existing=null] - Existing metadata for preserving createdAt.
   * @returns {Object} The new meta object.
   * @private
   */
  _buildMeta(bot: any, key: string, index: number, existing: { createdAt?: string } | null = null) {
    const timestamp = nowIso();
    return {
      key,
      name: bot.name || null,
      assetA: bot.assetA || null,
      assetB: bot.assetB || null,
      active: !!bot.active,
      index,
      createdAt: (existing && existing.createdAt) || timestamp,
      updatedAt: timestamp
    };
  }

  /**
   * Save the current order grid snapshot for this bot.
   * Called after grid changes (initialization, fills, syncs).
   * @param {Array} orders - Array of order objects from OrderManager
   * @param {number|null} btsFeesOwed - Optional BTS blockchain fees owed
   * @param {number|null} boundaryIdx - Optional master boundary index for StrategyEngine
   * @param {Object|null} assets - Optional asset metadata { assetA, assetB }
   * @param {Object|null} debugInputs - Optional debug-only input snapshot
   * @param {Object|null} recentFillKeys - Optional fill key dedup snapshot for crash recovery
   */
  async storeMasterGrid(orders: any[] = [], btsFeesOwed: any = null, boundaryIdx: any = null, assets: any = null, debugInputs: any = null, recentFillKeys: any = null) {
    // Use AsyncLock to serialize read-modify-write operations
    await this._persistenceLock.acquire(async () => {
      // Reload from disk before writing to prevent race conditions
      this.data = this._loadData() || emptyData();

      const snapshot = Array.isArray(orders) ? orders.map((order: any) => this._serializeOrder(order)) : [];
      const debugSnapshot = debugInputs ? cloneForDebug(debugInputs) : null;

      this.data.grid = snapshot;

      if (Number.isFinite(btsFeesOwed)) {
        this.data.btsFeesOwed = btsFeesOwed;
      }

      if (Number.isFinite(boundaryIdx)) {
        this.data.boundaryIdx = boundaryIdx;
      }

      if (assets) {
        this.data.assets = assets;
      }

      if (debugSnapshot) {
        this.data.debugInputs = debugSnapshot;
      }

      // Persist btsBalance for non-BTS pairs (passed via debugInputs)
      if (debugSnapshot && debugSnapshot.btsBalance) {
        this.data.btsBalance = debugSnapshot.btsBalance;
      }

      // Initialize processedFills if missing (backward compat)
      if (!this.data.processedFills) {
        this.data.processedFills = {};
      }

      // Persist recent fill keys for crash-durable dedup window
      if (recentFillKeys) {
        this.data.recentFillKeys = recentFillKeys;
      } else if (!this.data.recentFillKeys) {
        this.data.recentFillKeys = {};
      }

      const timestamp = nowIso();
      this.data.lastUpdated = timestamp;
      if (this.data.meta) this.data.meta.updatedAt = timestamp;
      this._persist();
    });
  }

  /**
   * Load the persisted order grid for this bot.
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data
   * @returns {Array|null} Order grid array or null if not found
   */
  loadGrid(forceReload: boolean = false) {
    if (forceReload) {
      this.data = this._loadData() || emptyData();
    }
    return (this.data && Array.isArray(this.data.grid)) ? this.data.grid : null;
  }

  /**
   * Load the recently queued fill keys for crash-durable dedup.
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} Recent fill keys map or null if not found
   */
  loadRecentFillKeys(forceReload: boolean = false) {
    if (forceReload) {
      this.data = this._loadData() || emptyData();
    }
    if (this.data && this.data.recentFillKeys) {
      return this.data.recentFillKeys;
    }
    return null;
  }

  /**
   * Load persisted asset metadata for this bot.
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} Asset metadata { assetA, assetB } or null if not found
   */
  loadPersistedAssets(forceReload: boolean = false) {
    if (forceReload) {
      this.data = this._loadData() || emptyData();
    }
    if (this.data && this.data.assets) {
      return this.data.assets;
    }
    return null;
  }

  /**
   * Load the master boundary index for this bot.
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {number|null} Boundary index or null if not found
   */
  loadBoundaryIdx(forceReload: boolean = false) {
    if (forceReload) {
      this.data = this._loadData() || emptyData();
    }
    if (this.data) {
      const idx = this.data.boundaryIdx;
      if (typeof idx === 'number' && Number.isFinite(idx)) {
        return idx;
      }
    }
    return null;
  }

  /**
   * Load persisted BTS balance for this bot (non-BTS pairs only).
   * @param {boolean} forceReload - If true, reload from disk
   * @returns {Object|null} BTS balance { free, total, locked } or null if not found
   */
  loadBtsBalance(forceReload: boolean = false) {
    if (forceReload) {
      this.data = this._loadData() || emptyData();
    }
    if (this.data && this.data.btsBalance && typeof this.data.btsBalance === 'object') {
      return this.data.btsBalance;
    }
    return null;
  }

  /**
   * Load BTS blockchain fees owed for this bot.
   * BTS fees accumulate during fill processing and must persist across restarts
   * to ensure they are properly deducted from proceeds during rotation.
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data
   * @returns {number} BTS fees owed or 0 if not found
   */
  loadBtsFeesOwed(forceReload: boolean = false) {
    if (forceReload) {
      this.data = this._loadData() || emptyData();
    }
    if (this.data) {
      const fees = this.data.btsFeesOwed;
      if (typeof fees === 'number' && Number.isFinite(fees)) {
        return fees;
      }
    }
    return 0;
  }

  /**
   * Update (persist) BTS blockchain fees for this bot.
   * BTS fees are deducted during fill processing and must be tracked across
   * restarts to prevent fund loss if the bot crashes before rotation.
   * @param {number} btsFeesOwed - BTS blockchain fees owed
   */
  async updateBtsFeesOwed(btsFeesOwed: any) {
    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || emptyData();
      this.data.btsFeesOwed = btsFeesOwed || 0;
      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Clear the persisted grid for this bot.
   * @returns {Promise<boolean>} true if cleared successfully
   */
  async clearGrid() {
    return await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || emptyData();
      this.data.grid = [];
      this.data.btsFeesOwed = 0;
      this.data.lastUpdated = nowIso();
      this._persist();
      return true;
    });
  }

  /**
   * Load processed fill IDs for this bot to prevent reprocessing fills across
   * restarts. Returns a Map of fillKey => timestamp for fills already processed.
   * @param {boolean|Object} options - Reload/filter options
   * @returns {Map} Map of fillKey => timestamp
   */
  loadProcessedFills(options: boolean | { forceReload?: boolean; minTimestamp?: number } = {}) {
    const forceReload = typeof options === 'boolean' ? options : options?.forceReload === true;
    const minTimestamp = typeof options === 'object' && options !== null && Number.isFinite(options.minTimestamp)
      ? options.minTimestamp
      : null;

    if (forceReload) {
      this.data = this._loadData() || emptyData();
    }

    if (this.data) {
      const fills = this.data.processedFills || {};
      const entries = Object.entries(fills).filter(([, timestamp]: any) =>
        minTimestamp == null || (Number.isFinite(timestamp) && (timestamp as number) >= minTimestamp!)
      );
      return new Map(entries);
    }
    return new Map();
  }

  /**
   * Persist a batch of processed fill records in one locked disk write.
   * @param {Map<string, number>} fills - Processed fill entries
   */
  async updateProcessedFillsBatch(fills: Map<string, number>) {
    if (!(fills instanceof Map) || fills.size === 0) return;

    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || emptyData();

      if (!this.data.processedFills) {
        this.data.processedFills = {};
      }

      let changed = false;
      for (const [fillKey, timestamp] of fills) {
        if (!fillKey) continue;
        if (this.data.processedFills[fillKey] === timestamp) continue;
        this.data.processedFills[fillKey] = timestamp;
        changed = true;
      }

      if (!changed) return;

      this.data.lastUpdated = nowIso();
      this._persist();
    });
  }

  /**
   * Clean up old processed fill records (remove entries older than specified age).
   * Prevents processedFills from growing unbounded over time.
   * @param {number} olderThanMs - Remove fills processed more than this many milliseconds ago
   */
  async cleanOldProcessedFills(olderThanMs: number = 3600000) {
    // Default: 1 hour (3600000ms)
    await this._persistenceLock.acquire(async () => {
      this.data = this._loadData() || emptyData();

      if (!this.data.processedFills) {
        return;
      }

      const now = Date.now();
      const fills = this.data.processedFills;
      let deletedCount = 0;

      for (const [fillKey, timestamp] of Object.entries(fills)) {
        if (now - (timestamp as number) > olderThanMs) {
          delete fills[fillKey];
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        this.data.lastUpdated = nowIso();
        this._persist();
      }
    });
  }

  /**
   * Calculate asset balances from the persisted grid for this bot.
   * Sums order sizes by asset and state (active vs virtual).
   * @param {boolean} forceReload - If true, reload from disk to ensure fresh data
   * @returns {Object|null} Balance summary or null if no data
   */
  getAssetBalances(forceReload: boolean = false) {
    if (forceReload) {
      this.data = this._loadData() || emptyData();
    }

    if (!this.data) return null;
    const meta = this.data.meta || {};
    const grid = Array.isArray(this.data.grid) ? this.data.grid : [];
    const sums = {
      assetA: { active: 0, virtual: 0 },
      assetB: { active: 0, virtual: 0 },
      meta: { key: this.botKey, name: meta.name || null, assetA: meta.assetA || null, assetB: meta.assetB || null }
    };

    for (const o of grid) {
      const size = toFiniteNumber(o?.size);
      const state = o && o.state || '';
      const typ = o && o.type || '';

      if (typ === ORDER_TYPES.SELL) {
        if (state === ORDER_STATES.ACTIVE || state === ORDER_STATES.PARTIAL) sums.assetA.active += size;
        else if (state === ORDER_STATES.VIRTUAL) sums.assetA.virtual += size;
      } else if (typ === ORDER_TYPES.BUY) {
        if (state === ORDER_STATES.ACTIVE || state === ORDER_STATES.PARTIAL) sums.assetB.active += size;
        else if (state === ORDER_STATES.VIRTUAL) sums.assetB.virtual += size;
      }
    }

    return sums;
  }

  /**
   * Serializes an order object for persistence.
   * @param {Object} [order={}] - The order object to serialize.
   * @returns {Object} The serialized order.
   * @private
   */
  _serializeOrder(order: any = {}) {
    const priceValue = toFiniteNumber(order.price);
    const sizeValue = toFiniteNumber(order.size);

    // SANITY CHECK: If order is ACTIVE/PARTIAL but has no orderId, it's corrupted.
    // Downgrade to VIRTUAL to prevent persisting phantom active orders.
    // This fixes the root cause of "Active No ID" state in JSON files.
    let state = order.state || null;
    let orderId = order.orderId || '';

    if (isPhantomOrder(order)) {
        state = ORDER_STATES.VIRTUAL;
        orderId = '';
    }

    const serialized = {
      id: order.id || null,
      type: order.type || null,
      state: state,
      price: Number.isFinite(priceValue) ? priceValue : 0,
      size: Number.isFinite(sizeValue) ? sizeValue : 0,
      orderId,
      isGhost: order.isGhost === true
    };

    return serialized;
  }
}

export { AccountOrders, createBotKey }

