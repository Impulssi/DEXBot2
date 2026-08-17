/**
 * modules/node_manager.ts - Multi-Node Health Checking and Failover Management
 *
 * Manages a configurable list of BitShares nodes with automatic health checking and
 * intelligent node selection based on latency and availability.
 *
 * ===============================================================================
 * FEATURES
 * ===============================================================================
 *
 * 1. Node Health Monitoring
 *    - Periodic health checks for all configured nodes
 *    - Latency measurement via WebSocket ping
 *    - Chain ID validation (ensure correct network)
 *    - Automatic blacklisting of failed nodes
 *
 * 2. Intelligent Node Selection
 *    - Selects lowest-latency healthy node
 *    - Falls back to slow nodes if no healthy ones available
 *    - Respects user-preferred node if healthy
 *
 * 3. Failover Integration
 *    - Exports node stats for monitoring
 *    - Designed to work with the native transport's setNodes() API
 *    - Automatic recovery when blacklisted nodes become healthy
 *
 * ===============================================================================
 * USAGE
 * ===============================================================================
 *
 * In bitshares_client.ts:
 *
 *   const NodeManager = require('./node_manager').default;
 *   const nodeManager = new NodeManager(config);
 *   await nodeManager.checkAllNodes();
 *   const bestNode = nodeManager.getBestNode();
 *   nativeClient.setNodes(nodeManager.getHealthyNodes());
 *   nodeManager.start();  // Begin periodic monitoring
 *
 * ===============================================================================
 */


import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import Logger from './logger.js';
import { NODE_MANAGEMENT } from './constants.js';
import { PATHS, getNodeBlacklistFile } from './paths.js';
import { compareNodeHealth } from './node_health_cache.js';
import { writeJsonFileAtomic } from './bots_file_lock.js';
import { getStorage } from './storage/index.js';
const storage = getStorage();
const { readJSON } = storage;
import { createFailureLedger } from './node_failure_ledger.js';
const _WebSocket = globalThis.WebSocket;
import {
    resolveHealthCacheFile,
    writeHealthCache,
} from './node_health_cache.js';
import { getErrorMessage } from './utils/errors.js';

interface NodeManagerConfig {
    list?: string[];
    blacklistStateFile?: string;
    stateDir?: string;
    healthCheck?: {
        intervalMs?: number;
        timeoutMs?: number;
        maxPingMs?: number;
        blacklistThreshold?: number;
        enabled?: boolean;
    };
    selection?: {
        strategy?: string;
        preferredNode?: string | null;
    };
    healthCacheFile?: string;
    [key: string]: any;
}

/**
 * NodeManager - Manages health checking and selection of BitShares nodes
 *
 * @class
 * @param {Object} config - Configuration object
 * @param {string[]} config.list - List of node URLs to monitor (e.g., wss://dex.iobanker.com/ws)
 * @param {Object} [config.healthCheck] - Health check settings
 * @param {number} [config.healthCheck.intervalMs=NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS] - How often to check nodes (milliseconds)
 * @param {number} [config.healthCheck.timeoutMs=5000] - Timeout for each health check
 * @param {number} [config.healthCheck.maxPingMs=3000] - Max acceptable latency
 * @param {number} [config.healthCheck.blacklistThreshold=3] - Failures before blacklist
 * @param {Object} [config.selection] - Node selection settings
 * @param {string} [config.selection.strategy="latency"] - Selection strategy
 * @param {string} [config.selection.preferredNode] - Optional preferred node (if healthy)
 */
class NodeManager {
    logger: any;
    blacklistStateFile: string;
    healthCacheFile: string;
    config: any;
    nodeStats: Map<any, any>;
    _lastBlacklistWarnMs: Map<any, any>;
    monitoringActive: boolean;
    checkIntervalId: any;
    checkAllNodesPromise: any;
    expectedChainId: string;
    BLACKLIST_COOLDOWN_MS: number;
    FAILURE_REPORT_COOLDOWN_MS: number;
    failureLedger: any;

    constructor(config: NodeManagerConfig = {}) {
        this.logger = new Logger('NodeManager');
        this.blacklistStateFile = typeof config.blacklistStateFile === 'string' && config.blacklistStateFile.trim()
            ? config.blacklistStateFile
            : (typeof config.stateDir === 'string' && config.stateDir.trim()
                ? getNodeBlacklistFile(config.stateDir)
                : PATHS.PROFILES.NODE_BLACKLIST_JSON);
        this.healthCacheFile = resolveHealthCacheFile(config);
        this.config = {
            list: config.list || [],
            healthCheck: {
                intervalMs: config.healthCheck?.intervalMs ?? NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS,
                timeoutMs: config.healthCheck?.timeoutMs ?? NODE_MANAGEMENT.HEALTH_CHECK_TIMEOUT_MS,
                maxPingMs: config.healthCheck?.maxPingMs ?? NODE_MANAGEMENT.MAX_PING_MS,
                blacklistThreshold: config.healthCheck?.blacklistThreshold ?? NODE_MANAGEMENT.BLACKLIST_THRESHOLD,
                enabled: config.healthCheck?.enabled ?? true
            },
            selection: {
                strategy: config.selection?.strategy || NODE_MANAGEMENT.SELECTION_STRATEGY,
                preferredNode: config.selection?.preferredNode || null
            }
        };

        // Node statistics tracking
        this.nodeStats = new Map();
        // Shared failure-counting ledger (same rules as the credential daemon's
        // ledger — see modules/node_failure_ledger.ts). Counts live here; the
        // stats map mirrors them for persistence/health-gating.
        this.failureLedger = createFailureLedger({
            threshold: this.config.healthCheck.blacklistThreshold,
            cooldownMs: NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS,
            reportCooldownMs: NODE_MANAGEMENT.FAILURE_REPORT_COOLDOWN_MS,
            // NodeManager semantics: the count that crossed the threshold is
            // kept (persisted via the blacklist state file), failures while a
            // node is blacklisted keep counting (each extends the blacklist),
            // and the health-check cooldown expiry resets the entry via reset().
            resetCountOnBlacklist: false,
            resetCountAfterCooldown: false,
            skipWhileBlacklisted: false,
        });
        this.initializeNodeStats();
        this.loadBlacklistState();

        // Blacklist warning dedup: track last warn time per node+error to suppress repeats.
        this._lastBlacklistWarnMs = new Map();

        // Control flags
        this.monitoringActive = false;
        this.checkIntervalId = null;
        this.checkAllNodesPromise = null;

        // Expected chain ID (BitShares mainnet)
        this.expectedChainId = require('./bitshares-native/serial/chain_constants').GRAPHENE_CHAIN_ID;

        // Blacklist cooldown: retry blacklisted nodes after 24 hours
        this.BLACKLIST_COOLDOWN_MS = NODE_MANAGEMENT.BLACKLIST_COOLDOWN_MS;
        this.FAILURE_REPORT_COOLDOWN_MS = NODE_MANAGEMENT.FAILURE_REPORT_COOLDOWN_MS;
    }

    /**
     * Initialize tracking for all configured nodes
     * @private
     */
    private initializeNodeStats(): void {
        for (const nodeUrl of this.config.list) {
            if (!this.nodeStats.has(nodeUrl)) {
                this.nodeStats.set(nodeUrl, {
                    url: nodeUrl,
                    status: 'unchecked',      // unchecked | healthy | slow | failed | blacklisted
                    latencyMs: null,
                    failureCount: 0,
                    lastCheckTime: null,
                    lastErrorMessage: null,
                    chainId: null,
                    blacklistedAt: null
                });
            }
        }
    }

    /**
     * Load persisted blacklist state from disk
     * @private
     */
    private loadBlacklistState(): void {
        try {
            const state: Record<string, any> = readJSON(this.blacklistStateFile);
            if (!state || typeof state !== 'object') return;
            for (const [nodeUrl, entry] of Object.entries(state)) {
                if (!entry || entry.status !== 'blacklisted') continue;
                const stats = this.nodeStats.get(nodeUrl);
                if (!stats) continue;
                stats.status = 'blacklisted';
                stats.failureCount = typeof entry.failureCount === 'number' ? entry.failureCount : this.config.healthCheck.blacklistThreshold;
                stats.blacklistedAt = typeof entry.blacklistedAt === 'number' ? entry.blacklistedAt : Date.now();
                stats.lastErrorMessage = typeof entry.lastErrorMessage === 'string' ? entry.lastErrorMessage : null;
                // Seed the shared ledger so counting continues across restarts
                // (a persisted blacklist must still count toward the threshold
                // until the cooldown expires or a health check re-admits the
                // node).
                this.failureLedger.seed(nodeUrl, {
                    failureCount: stats.failureCount,
                    blacklistedUntil: (stats.blacklistedAt || 0) + this.BLACKLIST_COOLDOWN_MS,
                });
                this.logger.debug(`Loaded persisted blacklist: ${nodeUrl}`);
            }
        } catch (err: any) {
            // A never-created blacklist file (normal first run) is not an error.
            if ((err as any)?.code !== 'ENOENT') {
                this.logger.warn(`Failed to load blacklist state: ${getErrorMessage(err)}`);
            }
        }
    }

    /**
     * Persist blacklisted nodes to disk
     * @private
     */
    private saveBlacklistState(): void {
        try {
            const state: Record<string, any> = {};
            for (const stats of this.nodeStats.values()) {
                if (stats.status === 'blacklisted') {
                    state[stats.url] = {
                        status: 'blacklisted',
                        blacklistedAt: stats.blacklistedAt,
                        failureCount: stats.failureCount,
                        lastErrorMessage: stats.lastErrorMessage
                    };
                }
            }
            // Atomic write: see writeJsonFileAtomic in bots_file_lock.ts. A
            // truncated blacklist would cause the next process to either lose
            // all blacklist state or, worse, fail to parse it.
            writeJsonFileAtomic(this.blacklistStateFile, state);
        } catch (err: any) {
            this.logger.warn(`Failed to save blacklist state: ${getErrorMessage(err)}`);
        }
    }

    /**
     * Persist the latest healthy/slow node ordering for lightweight consumers
     * such as the credential daemon.
     * @private
     */
    private saveHealthCache(): void {
        try {
            writeHealthCache(this.nodeStats.values(), { healthCacheFile: this.healthCacheFile });
        } catch (err: any) {
            this.logger.warn(`Failed to save node health cache: ${getErrorMessage(err)}`);
        }
    }

    /**
     * Start periodic health monitoring
     */
    start(): void {
        if (this.monitoringActive) {
            this.logger.warn('Monitoring already active, ignoring duplicate start()');
            return;
        }

        this.monitoringActive = true;
        this.logger.info(`Started monitoring ${this.config.list.length} nodes (interval: ${this.config.healthCheck.intervalMs}ms)`);

        // Initial check immediately
        this.checkAllNodes().catch((err: any) => {
            this.logger.warn(`Initial health check failed: ${getErrorMessage(err)}`);
        });

        // Schedule periodic checks
        this.checkIntervalId = setInterval(() => {
            this.checkAllNodes().catch((err: any) => {
                this.logger.warn(`Health check cycle failed: ${getErrorMessage(err)}`);
            });
        }, this.config.healthCheck.intervalMs);
        if (typeof this.checkIntervalId.unref === 'function') {
            this.checkIntervalId.unref();
        }
    }

    /**
     * Stop periodic health monitoring
     */
    stop(): void {
        if (!this.monitoringActive) return;

        this.monitoringActive = false;
        if (this.checkIntervalId !== null) {
            clearInterval(this.checkIntervalId);
            this.checkIntervalId = null;
        }
        this.logger.info('Stopped monitoring');
    }

    /**
     * Check all nodes in parallel
     * @returns {Promise<void>}
     */
    async checkAllNodes(): Promise<void> {
        if (this.checkAllNodesPromise) {
            return this.checkAllNodesPromise;
        }

        this.checkAllNodesPromise = (async () => {
            const now = Date.now();
            const promises = Array.from(this.nodeStats.keys())
                .filter((nodeUrl: any) => {
                    const stats = this.nodeStats.get(nodeUrl);
                    if (stats?.status !== 'blacklisted') return true;
                    if (!stats.blacklistedAt) return false;
                    const cooldownRemaining = this.BLACKLIST_COOLDOWN_MS - (now - stats.blacklistedAt);
                    if (cooldownRemaining > 0) {
                        const remainingHours = Math.ceil(cooldownRemaining / 3600000);
                        this.logger.debug(`${nodeUrl.substring(0, 40)}... blacklisted (${remainingHours}h cooldown remaining)`);
                        return false;
                    }
                    stats.status = 'unchecked';
                    stats.failureCount = 0;
                    stats.blacklistedAt = null;
                    this.failureLedger.reset(nodeUrl);
                    this.saveBlacklistState();
                    this.logger.info(`${nodeUrl.substring(0, 40)}... blacklist cooldown expired, re-enabling`);
                    return true;
                })
                .map((nodeUrl: any) => {
                    return this.checkNode(nodeUrl).catch((err: any) => {
                        // Don't throw, just log - one node failure shouldn't crash the check cycle
                        this.logger.debug(`Check failed for ${nodeUrl}: ${getErrorMessage(err)}`);
                    });
                });

            await Promise.all(promises);
            this.saveHealthCache();
        })();

        try {
            return await this.checkAllNodesPromise;
        } finally {
            this.checkAllNodesPromise = null;
        }
    }

    /**
     * Check a single node's health
     *
     * Measures:
     * 1. WebSocket handshake latency
     * 2. RPC ping latency (get_chain_id)
     * 3. Chain ID validation
     * 4. Classifies as: healthy, slow, or failed
     *
     * @param {string} nodeUrl - WebSocket URL of the node
     * @returns {Promise<Object>} Health check result: { status, latency, error }
     */
    async checkNode(nodeUrl: string): Promise<{ status: string; latency: number | null; error: string | null }> {
        const stats = this.nodeStats.get(nodeUrl);
        if (!stats) {
            this.logger.warn(`Node ${nodeUrl} not in configured list`);
            return { status: 'unknown', latency: null, error: 'Not configured' };
        }

        const timeoutMs = this.config.healthCheck.timeoutMs;

        try {
            // Connect with timeout
            const ws = await this.connectWithTimeout(nodeUrl, timeoutMs);

            try {
                // Measure RPC latency
                const rpcStart = Date.now();
                const result = await this.getChainId(ws, timeoutMs);
                const latencyMs = Date.now() - rpcStart;

                // Validate chain ID
                if (result !== this.expectedChainId) {
                    throw new Error(`Wrong chain ID: ${result}, expected: ${this.expectedChainId}`);
                }

                // Classify health
                const status = latencyMs > this.config.healthCheck.maxPingMs ? 'slow' : 'healthy';

                // Update stats
                stats.status = status;
                stats.latencyMs = latencyMs;
                stats.failureCount = 0;
                this.failureLedger.reset(nodeUrl);
                stats.lastCheckTime = new Date().toISOString();
                stats.lastErrorMessage = null;
                stats.chainId = result;

                if (status === 'healthy') {
                    this.logger.debug(`✓ ${nodeUrl.substring(0, 40)}... (${latencyMs}ms)`);
                } else {
                    this.logger.debug(`⚠ ${nodeUrl.substring(0, 40)}... SLOW (${latencyMs}ms)`);
                }

                return { status, latency: latencyMs, error: null };
            } finally {
                ws.close();
            }
        } catch (err: any) {
            this.reportNodeFailure(nodeUrl, getErrorMessage(err), 'health-check');
            return { status: stats.status, latency: null, error: getErrorMessage(err) };
        }
    }

    _shouldLogBlacklistWarning(nodeUrl: string, errorMessage: string, nowMs: number = Date.now()): boolean {
        const errorKey = (errorMessage || '').slice(0, 160);
        const warnKey = `${nodeUrl}\0${errorKey}`;
        const lastWarnMs = this._lastBlacklistWarnMs.get(warnKey);
        if (lastWarnMs && (nowMs - lastWarnMs) <= 3_600_000) {
            return false;
        }
        this._lastBlacklistWarnMs.set(warnKey, nowMs);
        if (this._lastBlacklistWarnMs.size > 64) {
            const staleThreshold = nowMs - 3_600_000 * 2;
            for (const [key, ts] of this._lastBlacklistWarnMs) {
                if (ts < staleThreshold) this._lastBlacklistWarnMs.delete(key);
            }
        }
        return true;
    }

    _clearBlacklistWarningCooldown(nodeUrl: string | null = null): void {
        if (!nodeUrl) {
            this._lastBlacklistWarnMs.clear();
            return;
        }

        const prefix = `${nodeUrl}\0`;
        for (const key of this._lastBlacklistWarnMs.keys()) {
            if (key.startsWith(prefix)) {
                this._lastBlacklistWarnMs.delete(key);
            }
        }
    }

    /**
     * Connect to a WebSocket with timeout
     * @private
     * @param {string} nodeUrl - WebSocket URL
     * @param {number} timeoutMs - Connection timeout
     * @returns {Promise<WebSocket>} Connected WebSocket instance
     */
    connectWithTimeout(nodeUrl: string, timeoutMs: number): Promise<any> {
        return new Promise((resolve: any, reject: any) => {
            let settled = false;
            let ws: any = null;
            const settle = (method: any, value: any) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                method(value);
            };
            const timeout = setTimeout(() => {
                if (ws) {
                    try {
                        if (typeof ws.terminate === 'function') {
                            ws.terminate();
                        } else {
                            ws.close();
                        }
                    } catch (err: any) { this.logger.warn(`WebSocket cleanup failed: ${getErrorMessage(err)}`); }
                }
                settle(reject, new Error(`Connection timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            try {
                ws = new _WebSocket(nodeUrl);

                ws.onopen = () => {
                    settle(resolve, ws);
                };

                ws.onerror = (err: any) => {
                    settle(reject, new Error(`WebSocket error: ${getErrorMessage(err) || 'Unknown'}`));
                };

                ws.onclose = () => {
                    settle(reject, new Error('WebSocket closed unexpectedly'));
                };
            } catch (err: any) {
                settle(reject, err);
            }
        });
    }

    /**
     * Query the BitShares chain ID using the Graphene WebSocket RPC protocol.
     * @private
     * @param {WebSocket} ws - Connected WebSocket
     * @param {number} timeoutMs - RPC timeout
     * @returns {Promise<string>} Chain ID
     */
    async getChainId(ws: any, timeoutMs: number): Promise<string> {
        await this.rpcCall(ws, 'call', [1, 'login', ['', '']], timeoutMs);
        const databaseApiId = await this.rpcCall(ws, 'call', [1, 'database', []], timeoutMs);
        return this.rpcCall(ws, 'call', [databaseApiId, 'get_chain_id', []], timeoutMs);
    }

    /**
     * Make a JSON-RPC call to a WebSocket
     * @private
     * @param {WebSocket} ws - Connected WebSocket
     * @param {string} method - RPC method name
     * @param {Array} params - RPC parameters
     * @param {number} timeoutMs - RPC timeout
     * @returns {Promise<any>} RPC result
     */
    rpcCall(ws: any, method: string, params: any[], timeoutMs: number): Promise<any> {
        return new Promise((resolve: any, reject: any) => {
            const requestId = Math.random().toString(36).substring(7);
            const request = {
                jsonrpc: '2.0',
                id: requestId,
                method,
                params
            };

            let isResolved = false;
            const originalHandler = ws.onmessage;

            const timeout = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    // Clean up message handler to prevent memory leak
                    ws.onmessage = originalHandler;
                    reject(new Error(`RPC timeout after ${timeoutMs}ms`));
                }
            }, timeoutMs);

            ws.onmessage = (msg: any) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data.id === requestId && !isResolved) {
                        isResolved = true;
                        clearTimeout(timeout);
                        ws.onmessage = originalHandler;

                        if (data.error) {
                            reject(new Error(`RPC error: ${data.error.message}`));
                        } else {
                            resolve(data.result);
                        }
                    }
                } catch (err: any) {
                    // Continue listening for correct response
                }
            };

            try {
                ws.send(JSON.stringify(request));
            } catch (err: any) {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    ws.onmessage = originalHandler;
                    reject(err);
                }
            }
        });
    }

    /**
     * Get list of healthy nodes sorted by latency (best first)
     * @returns {string[]} Array of node URLs
     */
    getHealthyNodes(): string[] {
        const preferredNode = this.config.selection.preferredNode;
        const healthy = Array.from(this.nodeStats.values())
            .filter((stat: any) => stat.status === 'healthy' || stat.status === 'slow')
            .sort((a: any, b: any) => {
                if (preferredNode) {
                    const aPreferred = a.url === preferredNode && a.status === 'healthy';
                    const bPreferred = b.url === preferredNode && b.status === 'healthy';
                    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
                }
                return compareNodeHealth(a, b);
            })
            .map((stat: any) => stat.url);

        return healthy;
    }

    /**
     * Get the single best (lowest latency) healthy node
     * @returns {string|null} Best node URL or null if none available
     */
    getBestNode(): string | null {
        const healthy = this.getHealthyNodes();
        return healthy.length > 0 ? healthy[0] : null;
    }

    /**
     * Report a node failure (from health check or broadcast).
     * Increments failureCount and auto-blacklists when the threshold is reached.
     * All node-failure paths route through here so the retry budget is synchronized.
     * Counting (threshold / cooldown / rate-limit) is delegated to the shared
     * failure ledger — the same rules the credential daemon applies.
     * @param {string} nodeUrl - Node URL that failed
     * @param {string} [errorMessage] - Optional error description
     * @param {string} [source] - Failure source ('health-check' or 'broadcast'); controls log level
     */
    reportNodeFailure(nodeUrl: string, errorMessage?: string, source?: string): void {
        const stats = this.nodeStats.get(nodeUrl);
        if (!stats) {
            this.logger.warn(`Node ${nodeUrl} not in configured list, cannot report failure`);
            return;
        }
        const isHealthCheck = source === 'health-check';

        const result = this.failureLedger.recordFailure(nodeUrl);
        if (result.outcome === 'rate-limited' || result.outcome === 'skipped-blacklisted') {
            return;
        }

        stats.failureCount = result.failureCount;
        stats.lastCheckTime = new Date().toISOString();
        if (errorMessage) stats.lastErrorMessage = errorMessage;

        if (result.outcome === 'blacklisted') {
            stats.status = 'blacklisted';
            stats.blacklistedAt = Date.now();
            this.saveBlacklistState();
            this.saveHealthCache();

            if (this._shouldLogBlacklistWarning(nodeUrl, errorMessage || '')) {
                this.logger.warn(`✗ ${nodeUrl.substring(0, 40)}... BLACKLISTED after ${result.failureCount} failures (${errorMessage || 'unknown'})`);
            }
        } else {
            stats.status = 'failed';
            const log = isHealthCheck ? this.logger.debug.bind(this.logger) : this.logger.warn.bind(this.logger);
            log(`⚠ ${nodeUrl.substring(0, 40)}... FAILED attempt ${result.failureCount}/${result.threshold} (${errorMessage || 'unknown'})`);
        }
    }

    /**
     * Manually blacklist a node (e.g., when it causes a connection failure)
     * @param {string} nodeUrl - Node URL to blacklist
     */
    blacklistNode(nodeUrl: string): void {
        const stats = this.nodeStats.get(nodeUrl);
        if (stats) {
            stats.status = 'blacklisted';
            stats.failureCount = this.config.healthCheck.blacklistThreshold;
            stats.blacklistedAt = Date.now();
            this.failureLedger.seed(nodeUrl, {
                failureCount: stats.failureCount,
                blacklistedUntil: stats.blacklistedAt + this.BLACKLIST_COOLDOWN_MS,
            });
            this.saveBlacklistState();
            this.saveHealthCache();
            this.logger.warn(`Manually blacklisted: ${nodeUrl}`);
        }
    }

    /**
     * Reset blacklist for a specific node (allow recovery)
     * @param {string} nodeUrl - Node URL to reset
     */
    resetNode(nodeUrl: string): void {
        const stats = this.nodeStats.get(nodeUrl);
        if (stats) {
            stats.status = 'unchecked';
            stats.failureCount = 0;
            stats.latencyMs = null;
            stats.lastErrorMessage = null;
            stats.blacklistedAt = null;
            this.failureLedger.reset(nodeUrl);
            this._clearBlacklistWarningCooldown(nodeUrl);
            this.saveBlacklistState();
            this.saveHealthCache();
            this.logger.info(`Reset node: ${nodeUrl}`);
        }
    }

    /**
     * Reset all nodes (allow full recovery)
     */
    resetAllNodes() {
        for (const stats of this.nodeStats.values()) {
            stats.status = 'unchecked';
            stats.failureCount = 0;
            stats.latencyMs = null;
            stats.lastErrorMessage = null;
            stats.chainId = null;
            stats.blacklistedAt = null;
        }
        this.failureLedger.clear();
        this._clearBlacklistWarningCooldown();
        this.saveBlacklistState();
        this.saveHealthCache();
        this.logger.info('Reset all nodes');
    }

    /**
     * Get current node statistics (for monitoring/logging)
     * @returns {Array<Object>} Array of node stats
     */
    getStats(): Array<{ url: string; status: string; latencyMs: number | null; failureCount: number; lastCheckTime: string | null; lastErrorMessage: string | null }> {
        return Array.from(this.nodeStats.values()).map((stat: any) => ({
            url: stat.url,
            status: stat.status,
            latencyMs: stat.latencyMs,
            failureCount: stat.failureCount,
            lastCheckTime: stat.lastCheckTime,
            lastErrorMessage: stat.lastErrorMessage
        }));
    }

    /**
     * Get summary statistics
     * @returns {Object} Summary stats
     */
    getSummary(): { monitoring: boolean; counts: Record<string, number>; bestNode: string | null; avgLatency: number | null } {
        const stats = Array.from(this.nodeStats.values());
        const counts: Record<string, number> = {
            total: stats.length,
            healthy: 0,
            slow: 0,
            failed: 0,
            blacklisted: 0,
            unchecked: 0
        };
        for (const s of stats) {
            if (s.status in counts) counts[s.status]++;
        }

        const bestNode = this.getBestNode();
        const statsWithLatency = stats.filter((s: any) => s.latencyMs !== null);
        const avgLatency = statsWithLatency.length > 0
            ? Math.round(statsWithLatency.reduce((sum: any, s: any) => sum + s.latencyMs, 0) / statsWithLatency.length)
            : null;

        return {
            monitoring: this.monitoringActive,
            counts,
            bestNode,
            avgLatency
        };
    }
}

export default NodeManager

