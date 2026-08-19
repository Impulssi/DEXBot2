/**
 * modules/settings_merge.ts - Shared Settings Merge
 *
 * Single source of truth for merging user settings (from general.settings.json)
 * with code defaults. Consolidates merge strategies previously duplicated
 * between constants.ts and account_bots.ts.
 *
 * ===============================================================================
 * PER-SECTION MERGE STRATEGIES
 * ===============================================================================
 *
 * replace  — direct assignment                  LOG_LEVEL
 * shallow  — one-level spread merge             TIMING, GRID_LIMITS, FILL_PROCESSING,
 *                                                PIPELINE_TIMING, DEFAULT_CONFIG, UPDATER,
 *                                                CREDENTIAL_PROMPTS, MAINTENANCE,
 *                                                COW_PERFORMANCE, INCREMENT_BOUNDS,
 *                                                FEE_PARAMETERS, API_LIMITS
 * deep     — recursive merge                    LOGGING_CONFIG, NATIVE_CLIENT, LAUNCHER,
 *                                                NODE_MANAGEMENT, MARKET_ADAPTER
 *
 * SPECIAL POST-PROCESSING:
 *   - GRID_LIMITS.GRID_COMPARISON → sub-object deep merge
 *   - raw.NODES                   → maps into NODE_MANAGEMENT constants
 */

type MergeStrategy = 'replace' | 'shallow' | 'deep';

const MERGE_STRATEGIES: Record<string, MergeStrategy> = {
    LOG_LEVEL: 'replace',
    TIMING: 'shallow',
    GRID_LIMITS: 'shallow',
    FILL_PROCESSING: 'shallow',
    PIPELINE_TIMING: 'shallow',
    DEFAULT_CONFIG: 'shallow',
    UPDATER: 'shallow',
    CREDENTIAL_PROMPTS: 'shallow',
    MAINTENANCE: 'shallow',
    COW_PERFORMANCE: 'shallow',
    INCREMENT_BOUNDS: 'shallow',
    FEE_PARAMETERS: 'shallow',
    API_LIMITS: 'shallow',
    LOGGING_CONFIG: 'deep',
    NATIVE_CLIENT: 'deep',
    LAUNCHER: 'deep',
    NODE_MANAGEMENT: 'deep',
    MARKET_ADAPTER: 'deep',
};

/**
 * Filter out comment/metadata keys (prefixed with _) from user settings.
 * These are used for JSON documentation but should not override code defaults.
 */
function filterCommentKeys(obj: Record<string, any>): Record<string, any> {
    return Object.fromEntries(
        Object.entries(obj).filter(([key]) => !key.startsWith('_'))
    );
}

/**
 * Deep recursive merge: source values override target values at any depth.
 * Plain objects are merged recursively; arrays and primitives are replaced.
 * Comment/metadata keys (prefixed with _) and `undefined` source values are skipped.
 */
function deepMerge(target: any, source: any): any {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (key.startsWith('_')) continue;
        const sv = source[key];
        if (sv === undefined) continue;
        if (sv !== null && typeof sv === 'object' && !Array.isArray(sv)) {
            if (result[key] !== undefined && result[key] !== null && typeof result[key] === 'object' && !Array.isArray(result[key])) {
                result[key] = deepMerge(result[key], sv);
            } else {
                result[key] = { ...sv };
            }
        } else {
            result[key] = sv;
        }
    }
    return result;
}

/**
 * Mapping from settings.NODES sub-keys to NODE_MANAGEMENT flat constant names.
 * Ensures both raw.NODES and raw.NODE_MANAGEMENT can update the same constants.
 */
const NODES_SUBKEY_MAP: Record<string, Record<string, string>> = {
    healthCheck: {
        intervalMs: 'HEALTH_CHECK_INTERVAL_MS',
        timeoutMs: 'HEALTH_CHECK_TIMEOUT_MS',
        maxPingMs: 'MAX_PING_MS',
        blacklistThreshold: 'BLACKLIST_THRESHOLD',
    },
    selection: {
        strategy: 'SELECTION_STRATEGY',
    },
};

/**
 * Apply raw.NODES sub-key values onto a NODE_MANAGEMENT result object.
 */
function applyNodesToNodeManagement(nodes: any, nm: Record<string, any>): void {
    if (nodes.enabled !== undefined) nm.DEFAULT_ENABLED = nodes.enabled;
    if (Array.isArray(nodes.list)) nm.DEFAULT_NODES = nodes.list;
    if (nodes.healthCheck && typeof nodes.healthCheck === 'object') {
        const hc = filterCommentKeys(nodes.healthCheck);
        for (const [subKey, constantName] of Object.entries(NODES_SUBKEY_MAP.healthCheck)) {
            if (hc[subKey] !== undefined) nm[constantName] = hc[subKey];
        }
    }
    if (nodes.selection && typeof nodes.selection === 'object') {
        const sel = filterCommentKeys(nodes.selection);
        for (const [subKey, constantName] of Object.entries(NODES_SUBKEY_MAP.selection)) {
            if (sel[subKey] !== undefined) nm[constantName] = sel[subKey];
        }
    }
}

/**
 * Merge user settings with code defaults using per-section strategies.
 *
 * @param raw      - Raw user settings object (from general.settings.json)
 * @param defaults - Code defaults object (AllConstants-shaped)
 * @returns Merged result with same shape as defaults (new objects where overridden,
 *          same references where not)
 */
function mergeSettings(raw: any, defaults: Record<string, any>): Record<string, any> {
    if (!raw || typeof raw !== 'object') raw = {};

    const result: Record<string, any> = {};

    for (const key of Object.keys(defaults)) {
        const rawVal = raw[key];
        const defaultVal = defaults[key];

        if (rawVal === undefined || rawVal === null) {
            result[key] = defaultVal;
            continue;
        }

        const strategy = MERGE_STRATEGIES[key] || 'shallow';

        switch (strategy) {
            case 'replace':
                result[key] = rawVal;
                break;

            case 'shallow': {
                const cleanRaw = typeof rawVal === 'object' && !Array.isArray(rawVal) && rawVal !== null
                    ? filterCommentKeys(rawVal)
                    : rawVal;
                const base = typeof defaultVal === 'object' && !Array.isArray(defaultVal) && defaultVal !== null
                    ? { ...defaultVal }
                    : defaultVal;
                result[key] = typeof base === 'object' && base !== null && !Array.isArray(base)
                    ? { ...base, ...cleanRaw }
                    : cleanRaw;
                break;
            }

            case 'deep': {
                const cleanRaw = typeof rawVal === 'object' && !Array.isArray(rawVal) && rawVal !== null
                    ? filterCommentKeys(rawVal)
                    : rawVal;
                if (typeof defaultVal === 'object' && !Array.isArray(defaultVal) && defaultVal !== null) {
                    result[key] = deepMerge(defaultVal, cleanRaw);
                } else {
                    result[key] = cleanRaw;
                }
                break;
            }
        }
    }

    // Post-processing: GRID_COMPARISON sub-object deep merge for GRID_LIMITS
    if (
        raw.GRID_LIMITS && typeof raw.GRID_LIMITS === 'object' && raw.GRID_LIMITS.GRID_COMPARISON &&
        typeof raw.GRID_LIMITS.GRID_COMPARISON === 'object'
    ) {
        const rawComparison = filterCommentKeys(raw.GRID_LIMITS.GRID_COMPARISON);
        const defaultComparison = defaults.GRID_LIMITS && defaults.GRID_LIMITS.GRID_COMPARISON
            ? { ...defaults.GRID_LIMITS.GRID_COMPARISON }
            : {};
        result.GRID_LIMITS = {
            ...result.GRID_LIMITS,
            GRID_COMPARISON: { ...defaultComparison, ...rawComparison },
        };
    }

    // Post-processing: NODES → NODE_MANAGEMENT mapping, then build NODES output
    if (result.NODE_MANAGEMENT) {
        // Step 1: Map raw.NODES sub-keys to NODE_MANAGEMENT constants
        if (raw.NODES && typeof raw.NODES === 'object') {
            const nm = { ...result.NODE_MANAGEMENT };
            applyNodesToNodeManagement(raw.NODES, nm);
            result.NODE_MANAGEMENT = nm;
        }

        // Step 2: Build NODES output object from merged NODE_MANAGEMENT
        const nm = result.NODE_MANAGEMENT;
        const nodesConfig: any = {
            enabled: nm.DEFAULT_ENABLED,
            list: nm.DEFAULT_NODES,
            healthCheck: {
                enabled: true,
                intervalMs: nm.HEALTH_CHECK_INTERVAL_MS,
                timeoutMs: nm.HEALTH_CHECK_TIMEOUT_MS,
                maxPingMs: nm.MAX_PING_MS,
                blacklistThreshold: nm.BLACKLIST_THRESHOLD,
            },
            selection: {
                strategy: nm.SELECTION_STRATEGY,
                preferredNode: null,
            },
        };

        // Step 3: Passthrough unmapped top-level keys from raw.NODES
        if (raw.NODES && typeof raw.NODES === 'object') {
            const rawNodes = raw.NODES;
            if (rawNodes.enabled !== undefined) nodesConfig.enabled = rawNodes.enabled;
            if (Array.isArray(rawNodes.list)) nodesConfig.list = rawNodes.list;
            // HealthCheck: keep mapped values, add any unmapped sub-keys
            if (rawNodes.healthCheck && typeof rawNodes.healthCheck === 'object') {
                for (const k of Object.keys(rawNodes.healthCheck)) {
                    if (k.startsWith('_')) continue;
                    if (!(k in NODES_SUBKEY_MAP.healthCheck)) {
                        nodesConfig.healthCheck[k] = rawNodes.healthCheck[k];
                    }
                }
            }
            // Selection: keep mapped values, add any unmapped sub-keys
            if (rawNodes.selection && typeof rawNodes.selection === 'object') {
                for (const k of Object.keys(rawNodes.selection)) {
                    if (k.startsWith('_')) continue;
                    if (!(k in NODES_SUBKEY_MAP.selection)) {
                        nodesConfig.selection[k] = rawNodes.selection[k];
                    }
                }
            }
        }

        result.NODES = nodesConfig;
    }

    // Backward-compatible EXPERT second-pass overrides (GRID_LIMITS and TIMING only).
    // These WIN over any top-level setting from the main merge above.
    if (raw.EXPERT && typeof raw.EXPERT === 'object') {
        if (raw.EXPERT.GRID_LIMITS && typeof raw.EXPERT.GRID_LIMITS === 'object') {
            const expertGrid = filterCommentKeys(raw.EXPERT.GRID_LIMITS);
            result.GRID_LIMITS = { ...result.GRID_LIMITS, ...expertGrid };
        }
        if (raw.EXPERT.TIMING && typeof raw.EXPERT.TIMING === 'object') {
            const expertTiming = filterCommentKeys(raw.EXPERT.TIMING);
            result.TIMING = { ...result.TIMING, ...expertTiming };
        }
    }

    return result;
}

export { deepMerge, mergeSettings }

