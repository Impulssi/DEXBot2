

import { NODE_MANAGEMENT } from './constants.js';
import { getNodeHealthCacheFile } from './paths.js';
import { writeJsonFileAtomic } from './bots_file_lock.js';
import { getStorage } from './storage/index.js';
const storage = getStorage();
const { readJSON } = storage;

interface HealthCacheOptions {
    healthCacheFile?: string;
    stateDir?: string;
    now?: number;
    maxAgeMs?: number;
}

interface NodeHealthStat {
    url?: string;
    status?: string;
    latencyMs?: number;
    lastCheckTime?: string | number | null;
}

interface NodeHealthCacheEntry {
    url: string;
    status: string;
    latencyMs: number | null;
    lastCheckTime: string | number | null;
}

interface NodeHealthCachePayload {
    version: number;
    updatedAt: string;
    updatedAtMs: number;
    nodes: NodeHealthCacheEntry[];
}

interface NodeSettings {
    NODES?: {
        list?: string[];
        enabled?: boolean;
        healthCheck?: {
            intervalMs?: number;
            enabled?: boolean;
        };
    };
}

function resolveHealthCacheFile(config: HealthCacheOptions = {}): string {
    if (typeof config.healthCacheFile === 'string' && config.healthCacheFile.trim()) {
        return config.healthCacheFile;
    }
    if (typeof config.stateDir === 'string' && config.stateDir.trim()) {
        return getNodeHealthCacheFile(config.stateDir);
    }
    return getNodeHealthCacheFile();
}

function normalizeNodeList(nodes: unknown): string[] {
    return Array.isArray(nodes)
        ? nodes.filter((node: unknown): node is string => typeof node === 'string' && node.trim() !== '')
        : [];
}

/**
 * Comparator for healthy/slow nodes: healthy first, then by ascending latency.
 * Shared by node_health_cache and node_manager.
 */
function compareNodeHealth(a: { status: string; latencyMs?: number | null }, b: { status: string; latencyMs?: number | null }): number {
    if (a.status !== b.status) return a.status === 'healthy' ? -1 : 1;
    return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
}

function buildHealthCachePayload(stats: Iterable<NodeHealthStat> | ArrayLike<NodeHealthStat> | null | undefined, now: number = Date.now()): NodeHealthCachePayload {
    const nodes: NodeHealthCacheEntry[] = Array.from(stats || [])
        .filter((stat): stat is NodeHealthStat & { status: 'healthy' | 'slow'; url: string } =>
            !!stat && (stat.status === 'healthy' || stat.status === 'slow') && typeof stat.url === 'string' && stat.url.trim() !== ''
        )
        .map((stat) => ({
            url: stat.url,
            status: stat.status,
            latencyMs: Number.isFinite(stat.latencyMs) ? (stat.latencyMs ?? null) : null,
            lastCheckTime: stat.lastCheckTime || null,
        }));

    nodes.sort(compareNodeHealth);

    return {
        version: 1,
        updatedAt: new Date(now).toISOString(),
        updatedAtMs: now,
        nodes,
    };
}

function writeHealthCache(stats: Iterable<NodeHealthStat> | ArrayLike<NodeHealthStat> | null | undefined, options: HealthCacheOptions = {}): NodeHealthCachePayload {
    const file = resolveHealthCacheFile(options);
    const now = Number.isFinite(options.now) ? options.now! : Date.now();
    const payload = buildHealthCachePayload(stats, now);
    // Atomic write: see writeJsonFileAtomic in bots_file_lock.ts. A torn
    // health cache would either lose all health history or fail to parse.
    writeJsonFileAtomic(file, payload);
    return payload;
}

function readHealthCache(options: HealthCacheOptions = {}): NodeHealthCachePayload | null {
    const file = resolveHealthCacheFile(options);
    const maxAgeMs = Number.isFinite(options.maxAgeMs)
        ? options.maxAgeMs!
        : NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS;
    const now = Number.isFinite(options.now) ? options.now! : Date.now();

    try {
        const payload: NodeHealthCachePayload = readJSON(file);
        if (!payload || payload.version !== 1 || !Array.isArray(payload.nodes)) return null;
        if (!Number.isFinite(payload.updatedAtMs)) return null;
        if (maxAgeMs >= 0 && now - payload.updatedAtMs > maxAgeMs) return null;

        const nodes = payload.nodes
            .filter((node): node is NodeHealthCacheEntry & { status: 'healthy' | 'slow' } =>
                !!node && (node.status === 'healthy' || node.status === 'slow') && typeof node.url === 'string' && node.url.trim() !== ''
            )
            .sort(compareNodeHealth);

        return {
            ...payload,
            nodes,
        };
    } catch {
        return null;
    }
}

function removeNodesFromHealthCache(urls: string | string[], options: HealthCacheOptions = {}): NodeHealthCachePayload | null {
    const toRemove = new Set(Array.isArray(urls) ? urls : [urls]);
    if (toRemove.size === 0) return null;
    const cache = readHealthCache(options);
    if (!cache || !Array.isArray(cache.nodes)) return null;
    // No-op when the nodes are already absent: an unlocked read-modify-write
    // clobbers any concurrent fresh health-check write with the stale snapshot
    // it read, so only rewrite the file when the exclusion actually changes
    // something (the write itself is atomic — a lost exclusion, never a torn
    // file).
    if (!cache.nodes.some((n) => n && n.url && toRemove.has(n.url))) return null;
    const remaining = cache.nodes
        .filter((n) => !n || !n.url || !toRemove.has(n.url))
        .map((n) => ({
            url: n.url,
            status: n.status,
            latencyMs: n.latencyMs ?? undefined,
            lastCheckTime: n.lastCheckTime,
        }));
    return writeHealthCache(remaining, { ...options, now: Date.now() });
}

function orderNodesFromHealthCache(configuredNodes: unknown, options: HealthCacheOptions = {}): string[] {
    const configured = normalizeNodeList(configuredNodes);
    const configuredSet = new Set(configured);
    const cache = readHealthCache(options);
    if (!cache || cache.nodes.length === 0) return configured;

    const ordered: string[] = [];
    for (const node of cache.nodes) {
        if (!configuredSet.has(node.url) || ordered.includes(node.url)) continue;
        ordered.push(node.url);
    }
    for (const node of configured) {
        if (!ordered.includes(node)) ordered.push(node);
    }
    return ordered;
}

function resolveConfiguredNodes(settings: NodeSettings): string[] {
    const nodeSettings = settings?.NODES;
    const configuredNodes = normalizeNodeList(nodeSettings?.list);
    return configuredNodes.length > 0
        ? configuredNodes
        : NODE_MANAGEMENT.DEFAULT_NODES;
}

function resolveHealthCacheMaxAgeMs(settings: NodeSettings): number {
    const configuredInterval = settings?.NODES?.healthCheck?.intervalMs;
    return Number.isFinite(configuredInterval)
        ? configuredInterval!
        : NODE_MANAGEMENT.HEALTH_CHECK_INTERVAL_MS;
}

function orderNodesForSettings(settings: NodeSettings, options: HealthCacheOptions = {}): string[] {
    if (settings?.NODES?.healthCheck?.enabled === false) {
        return resolveConfiguredNodes(settings);
    }
    return orderNodesFromHealthCache(resolveConfiguredNodes(settings), {
        ...options,
        maxAgeMs: Number.isFinite(options.maxAgeMs)
            ? options.maxAgeMs
            : resolveHealthCacheMaxAgeMs(settings),
    });
}

export { compareNodeHealth, orderNodesFromHealthCache, orderNodesForSettings, readHealthCache, removeNodesFromHealthCache, resolveConfiguredNodes, resolveHealthCacheFile, writeHealthCache }

