/**
 * DEXBot2 Credential Daemon Policy Engine
 *
 * Evaluates policies before key material is decrypted. Inspired by OWS pattern.
 * Supports declarative rules (fast, in-process) + executable hooks (subprocess).
 * AND semantics: all policies must allow, or signing is denied.
 * Default-deny on errors: validation failures, executable timeouts, etc.
 */

const { path } = require('./path_api');
const { randomBytes, createHmac, timingSafeEqual } = require('./crypto/sync');
const { BitShares } = require('./bitshares_client');
const { isPositiveInt } = require('./order/utils/math');
const { parseJsonWithComments } = require('./order/utils/system');
const { FEE_PARAMETERS, NATIVE_CLIENT } = require('./constants');
const { RESOLVERS } = NATIVE_CLIENT;
const { getCredentialReadyFilePath, assertPrivatePathSecurity } = require('./credential_runtime');
const { PATHS } = require('./paths');
const Logger = require('./logger');
const { getStorage } = require('./storage');
const storage = getStorage();
const { runtime } = require('./runtime');
const { ensureDir, readJSON, safeUnlink, writeJSON } = require('./utils/fs_utils');

// Module-scope logger for library-style helpers that don't own a process
// logger.  The class honours PM2 auto-quiet and routes to a log file when one
// is configured, matching the rest of the codebase.
const policyLogger = new Logger('credential-policy');

const BOTS_JSON_PATH = PATHS.PROFILES.BOTS_JSON;
const ASSET_OBJECT_ID_PATTERN = /^1\.3\.\d+$/;

const POLICY_DENIED_PREFIX = 'POLICY_DENIED: ';
const EXECUTABLE_TIMEOUT_MS = 5000;

interface PolicyContext {
    accountName: string;
    requestType: string;
    sessionId: string | null;
    timestamp: string;
    operations: any[];
}

interface PolicyConfig {
    sessionTtlMs?: number;
    default?: Record<string, any>;
    accounts?: Record<string, Record<string, any>>;
}

// BitShares operation types that DEXBot2 uses
const ALLOWED_OP_TYPES = [
    'transfer',
    'limit_order_create',
    'limit_order_cancel',
    'call_order_update',
    'liquidity_pool_exchange',
    'limit_order_update',
    'credit_offer_accept',
    'credit_deal_repay',
    'credit_deal_update',
];

// Hardcoded baseline policy used when resolving policy layers in-process.
// The credential daemon now requires an explicit on-disk policy file and
// fails closed on startup/reload mismatches.
const BUILTIN_DEFAULT_POLICY = Object.freeze({
    allowedOps: Object.freeze({
        limit_order_create: null,
        limit_order_cancel: null,
        limit_order_update: null,
        call_order_update: null,
        liquidity_pool_exchange: null,
        transfer: null,
        credit_offer_accept: null,
        credit_deal_repay: null,
        credit_deal_update: null,
    }),
    maxOpsPerBatch: 200,
    allowedAssetIds: null,
    executable: null,
});

const { LRUCache } = require('./bitshares-native/lru_cache');

const policyCache = new Map();
const assetRefResolutionCache = new LRUCache(RESOLVERS.LRU_DEFAULT_SIZE, RESOLVERS.ASSET_TTL_MS);

type AssetResolver = (assetRef: string) => Promise<string | null>;
let _externalAssetResolver: AssetResolver | null = null;

/**
 * Register an external asset-ref resolver used by the credential daemon.
 * The daemon's native chain client is connected and can resolve symbol names,
 * whereas the global BitShares object may not be initialised in daemon context.
 */
function setExternalAssetResolver(resolver: AssetResolver | null): void {
    _externalAssetResolver = resolver;
}

async function resolveAssetRefToId(assetRef: string): Promise<string | null> {
    if (!assetRef || typeof assetRef !== 'string') return null;
    const cacheKey = String(assetRef);
    const cached = assetRefResolutionCache.get(cacheKey);
    if (cached !== undefined) return cached;

    let resolvedId = null;

    // Try external resolver first (credential daemon with native chain client).
    // Only registered by the daemon; the legacy bot process path never sets one.
    // If it fails (e.g. native client not yet connected), fall through to the
    // legacy BitShares path below.
    if (_externalAssetResolver) {
        try {
            const result = await _externalAssetResolver(cacheKey);
            if (result) {
                assetRefResolutionCache.set(cacheKey, result);
                return result;
            }
        } catch (_: any) {
            // fall through — native client may not be connected yet
        }
        // Don't cache null from external resolver; the native client may not
        // be connected yet and would have returned a transient failure.
    }

    try {
        if (ASSET_OBJECT_ID_PATTERN.test(cacheKey)) {
            resolvedId = cacheKey;
        } else if (BitShares?.db?.lookup_asset_symbols) {
            const result = await BitShares.db.lookup_asset_symbols([cacheKey]);
            const asset = Array.isArray(result) ? result[0] : null;
            resolvedId = asset?.id ? String(asset.id) : null;
        } else if (BitShares?.db?.get_assets) {
            const result = await BitShares.db.get_assets([cacheKey]);
            const asset = Array.isArray(result) ? result[0] : null;
            resolvedId = asset?.id ? String(asset.id) : null;
        }
    } catch (_: any) {
        resolvedId = null;
    }

    if (resolvedId) assetRefResolutionCache.set(cacheKey, resolvedId);
    return resolvedId;
}

async function resolveConfiguredAssetRefs(refs: string[], label: string): Promise<{ ok: boolean; values?: string[]; reason?: string }> {
    const resolved = [];
    for (const ref of refs) {
        if (!ref) continue;
        const normalizedRef = String(ref);
        if (ASSET_OBJECT_ID_PATTERN.test(normalizedRef)) {
            resolved.push(normalizedRef);
            continue;
        }
        const resolvedId = await resolveAssetRefToId(normalizedRef);
        if (!resolvedId) {
            return {
                ok: false,
                reason: `unable to resolve asset ref "${normalizedRef}" from ${label}`,
            };
        }
        resolved.push(String(resolvedId));
    }
    return { ok: true, values: resolved };
}

function normalizeGrapheneCollateralRatio(value: number): number | null {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const denom = FEE_PARAMETERS.GRAPHENE_COLLATERAL_RATIO_DENOM;
    return numeric >= denom ? numeric / denom : numeric;
}

function createMinimalPolicyConfig(): { accounts: Record<string, never> } {
    return {
        accounts: {},
    };
}

function readPolicyConfigDetailed(filePath: string): { status: string; config: any; error: string | null } {
    if (!storage.exists(filePath)) {
        return {
            status: 'missing',
            config: null,
            error: `config file not found: ${filePath}`,
        };
    }

    let raw;
    try {
        raw = readJSON(filePath);
    } catch (error: any) {
        return {
            status: 'invalid',
            config: null,
            error: `failed to load config: ${error.message}`,
        };
    }

    const { valid, errors } = validatePolicyConfig(raw);
    if (!valid) {
        return {
            status: 'invalid',
            config: null,
            error: `config validation failed: ${errors.join('; ')}`,
        };
    }

    return {
        status: 'ok',
        config: raw,
        error: null,
    };
}

/**
 * Check that a policy config file has restrictive permissions (0o600).
 * MIGRATION: Auto-remediates legacy 0o644 mode with a warning, matching
 * the behavior of checkKeysFileSecurity in chain_keys.ts.
 *
 * @param {string} filePath - Path to daemon-policies.json
 */
function checkPolicyFileSecurity(filePath: string) {
    if (!storage.exists(filePath)) return;
    try {
        assertPrivatePathSecurity(filePath, { expectedType: 'file', requiredMode: 0o600 });
    } catch (err: any) {
        const stat = storage.lstat(filePath);
        const mode = stat.mode & 0o777;
        if (mode === 0o644 && !stat.isSymbolicLink()) {
            storage.chmod(filePath, 0o600);
            policyLogger.warn(`[security] Auto-fixed ${filePath} permissions from 0o644 to 0o600. Run: chmod 600 profiles/daemon-policies.json`);
            return;
        }
        throw err;
    }
}

/**
 * Ensure daemon-policies.json exists before the credential daemon starts.
 * Missing files are initialized to a minimal strict-compatible policy; invalid
 * existing files still fail closed and are not overwritten.
 *
 * @param {string} filePath - Path to daemon-policies.json
 * @returns {object} Valid parsed config
 * @throws {Error} When the existing file is invalid or creation fails
 */
function ensurePolicyConfig(filePath: string): PolicyConfig {
    if (!storage.exists(filePath)) {
        try {
            storage.ensureDir(path.dirname(filePath));
            storage.writeJSON(filePath, createMinimalPolicyConfig(), { mode: 0o600, flag: 'wx' });
        } catch (err: any) {
            if (err.code !== 'EEXIST') {
                const wrapped = new Error(`Failed to create required policy config: ${err.message}`) as Error & { code: string };
                wrapped.code = 'POLICY_CONFIG_CREATE_FAILED';
                throw wrapped;
            }
        }
    }

    return loadRequiredPolicyConfig(filePath);
}

/**
 * Load and parse daemon-policies.json. Returns normalized config or throws on
 * error/absence (daemon uses loadRequiredPolicyConfig which throws).
 *
 * @param {string} filePath - Path to daemon-policies.json
 * @param {object} [options={}] - Options
 * @param {boolean} [options.forceReload=false] - If true, bypass cache and reload from disk
 */
function loadPolicyConfig(filePath: string, options: { forceReload?: boolean } = {}): PolicyConfig | null {
    const forceReload = options.forceReload || false;
    if (!forceReload && policyCache.has(filePath)) {
        return policyCache.get(filePath);
    }

    const detailed = readPolicyConfigDetailed(filePath);
    if (detailed.status !== 'ok') {
        policyLogger.warn(`[policy] ${detailed.error} — using builtin defaults`);
        policyCache.set(filePath, null);
        return null;
    }

    policyCache.set(filePath, detailed.config);
    return detailed.config;
}

/**
 * Reload daemon-policies.json from disk with caller-controlled failure
 * semantics.  Single source of truth for both the SIGHUP handler
 * (operator-initiated, fail closed) and the fs.watch debounce
 * (auto-provision, keep last-good in-memory config).
 *
 * @param {string} filePath - Path to daemon-policies.json
 * @param {object} [options={}] - Options
 * @param {boolean} [options.strict=false] - When true, rethrows the load
 *   error so the caller can decide the response (e.g. shutdown).  When
 *   false (default), returns null on failure so the caller can keep the
 *   existing in-memory config and log a warning.
 * @returns {object|null} Parsed config on success, null on non-strict failure
 */
function reloadPolicyFromDisk(filePath: string, options: { strict?: boolean } = {}): PolicyConfig | null {
    const strict = options.strict === true;
    try {
        return loadRequiredPolicyConfig(filePath);
    } catch (err: any) {
        if (strict) throw err;
        policyLogger.warn(`[policy] Reload from ${filePath} failed: ${err.message} — keeping in-memory config`);
        return null;
    }
}

/**
 * Load daemon-policies.json as a required runtime dependency.
 * Used by the credential daemon, which fails closed on missing/invalid policy.
 *
 * @param {string} filePath - Path to daemon-policies.json
 * @returns {object} Valid parsed config
 * @throws {Error} When the file is missing or invalid
 */
function loadRequiredPolicyConfig(filePath: string): PolicyConfig {
    const detailed = readPolicyConfigDetailed(filePath);
    if (detailed.status !== 'ok') {
        policyCache.set(filePath, null);
        const err = new Error(`Required policy config ${detailed.status}: ${detailed.error}`) as Error & { code: string };
        err.code = detailed.status === 'missing'
            ? 'POLICY_CONFIG_MISSING'
            : 'POLICY_CONFIG_INVALID';
        throw err;
    }

    policyCache.set(filePath, detailed.config);
    return detailed.config;
}

/**
 * Helper: check if value is an array of strings
 */
function isStringArray(v: any): v is string[] {
    return Array.isArray(v) && v.every((x: any) => typeof x === 'string');
}

/**
 * Validate per-operation constraints. Returns { errors: string[] }.
 * Constraint fields are validated based on operation type.
 */
function validateOpConstraints(opName: string, constraints: any): { errors: string[] } {
    const errors = [];

    // transfer
    if (opName === 'transfer') {
        if (constraints.allowedToAccounts !== undefined && !isStringArray(constraints.allowedToAccounts))
            errors.push('allowedToAccounts must be an array of strings');
        if (constraints.allowedAssets !== undefined && !isStringArray(constraints.allowedAssets))
            errors.push('allowedAssets must be an array of strings');
        if (constraints.maxAmount !== undefined && !isPositiveInt(constraints.maxAmount))
            errors.push('maxAmount must be a positive integer');
    }

    // Fields valid for limit_order_create and limit_order_update
    if (['limit_order_create', 'limit_order_update'].includes(opName)) {
        if (constraints.allowedSellAssets !== undefined) {
            if (!isStringArray(constraints.allowedSellAssets))
                errors.push('allowedSellAssets must be an array of strings');
        }
        if (constraints.allowedReceiveAssets !== undefined) {
            if (!isStringArray(constraints.allowedReceiveAssets))
                errors.push('allowedReceiveAssets must be an array of strings');
        }
    }

    // maxSellAmount, maxReceiveAmount, allowFillOrKill — only for limit_order_create
    if (opName === 'limit_order_create') {
        if (constraints.maxSellAmount !== undefined && !isPositiveInt(constraints.maxSellAmount))
            errors.push('maxSellAmount must be a positive integer');
        if (constraints.maxReceiveAmount !== undefined && !isPositiveInt(constraints.maxReceiveAmount))
            errors.push('maxReceiveAmount must be a positive integer');
        if (constraints.allowFillOrKill !== undefined && typeof constraints.allowFillOrKill !== 'boolean')
            errors.push('allowFillOrKill must be a boolean');
    }

    // maxDeltaSellAmount — only for limit_order_update
    if (opName === 'limit_order_update') {
        if (constraints.maxDeltaSellAmount !== undefined && !isPositiveInt(constraints.maxDeltaSellAmount))
            errors.push('maxDeltaSellAmount must be a positive integer');
    }

    // call_order_update
    if (opName === 'call_order_update') {
        if (constraints.allowedAssets !== undefined && !isStringArray(constraints.allowedAssets))
            errors.push('allowedAssets must be an array of strings');
        if (constraints.collateralAsset !== undefined && typeof constraints.collateralAsset !== 'string')
            errors.push('collateralAsset must be a string');
        if (constraints.allowedCollateralAssets !== undefined && !isStringArray(constraints.allowedCollateralAssets))
            errors.push('allowedCollateralAssets must be an array of strings');
        if (constraints.maxDeltaCollateral !== undefined && !isPositiveInt(constraints.maxDeltaCollateral))
            errors.push('maxDeltaCollateral must be a positive integer');
        if (constraints.maxDeltaDebt !== undefined && !isPositiveInt(constraints.maxDeltaDebt))
            errors.push('maxDeltaDebt must be a positive integer');
        if (constraints.minCollateralRatio !== undefined && typeof constraints.minCollateralRatio !== 'number')
            errors.push('minCollateralRatio must be a number');
        if (constraints.maxCollateralRatio !== undefined && typeof constraints.maxCollateralRatio !== 'number')
            errors.push('maxCollateralRatio must be a number');
        if (constraints.targetCollateralRatio !== undefined && typeof constraints.targetCollateralRatio !== 'number')
            errors.push('targetCollateralRatio must be a number');
    }

    // credit_offer_accept
    if (opName === 'credit_offer_accept') {
        if (constraints.allowedOfferIds !== undefined && !isStringArray(constraints.allowedOfferIds))
            errors.push('allowedOfferIds must be an array of strings');
        if (constraints.collateralAsset !== undefined && typeof constraints.collateralAsset !== 'string')
            errors.push('collateralAsset must be a string');
        if (constraints.allowedCollateralAssets !== undefined && !isStringArray(constraints.allowedCollateralAssets))
            errors.push('allowedCollateralAssets must be an array of strings');
        if (constraints.allowedDebtAssets !== undefined && !isStringArray(constraints.allowedDebtAssets))
            errors.push('allowedDebtAssets must be an array of strings');
        if (constraints.maxFeeRate !== undefined && !isPositiveInt(constraints.maxFeeRate))
            errors.push('maxFeeRate must be a positive integer');
        if (constraints.minDurationSeconds !== undefined && !isPositiveInt(constraints.minDurationSeconds))
            errors.push('minDurationSeconds must be a positive integer');
    }

    // credit_deal_repay
    if (opName === 'credit_deal_repay') {
        if (constraints.disallowedDealIds !== undefined && !isStringArray(constraints.disallowedDealIds))
            errors.push('disallowedDealIds must be an array of strings');
        if (constraints.maxRepayAmount !== undefined && !isPositiveInt(constraints.maxRepayAmount))
            errors.push('maxRepayAmount must be a positive integer');
        if (constraints.maxCreditFee !== undefined && !isPositiveInt(constraints.maxCreditFee))
            errors.push('maxCreditFee must be a positive integer');
    }

    // credit_deal_update
    if (opName === 'credit_deal_update') {
        if (constraints.disallowedDealIds !== undefined && !isStringArray(constraints.disallowedDealIds))
            errors.push('disallowedDealIds must be an array of strings');
        if (constraints.allowAutoRepay !== undefined && typeof constraints.allowAutoRepay !== 'boolean')
            errors.push('allowAutoRepay must be a boolean');
    }

    // liquidity_pool_exchange
    if (opName === 'liquidity_pool_exchange') {
        if (constraints.allowedPools !== undefined && !isStringArray(constraints.allowedPools))
            errors.push('allowedPools must be an array of strings');
        if (constraints.allowedSellAssets !== undefined && !isStringArray(constraints.allowedSellAssets))
            errors.push('allowedSellAssets must be an array of strings');
        if (constraints.allowedReceiveAssets !== undefined && !isStringArray(constraints.allowedReceiveAssets))
            errors.push('allowedReceiveAssets must be an array of strings');
        if (constraints.maxSellAmount !== undefined && !isPositiveInt(constraints.maxSellAmount))
            errors.push('maxSellAmount must be a positive integer');
    }

    // limit_order_cancel has no constraints

    return { errors };
}

/**
 * Validate raw policy config. Returns { valid: boolean, errors: string[] }.
 */
function validatePolicyConfig(raw: any): { valid: boolean; errors: string[] } {
    const errors = [];

    if (typeof raw !== 'object' || raw === null) {
        errors.push('root must be an object');
        return { valid: false, errors };
    }

    // sessionTtlMs: optional positive integer
    if (raw.sessionTtlMs !== undefined) {
        if (typeof raw.sessionTtlMs !== 'number' || raw.sessionTtlMs <= 0) {
            errors.push('sessionTtlMs must be a positive integer');
        }
    }

    // default: optional policy object
    if (raw.default !== undefined) {
        if (typeof raw.default !== 'object' || raw.default === null) {
            errors.push('default must be an object');
        } else {
            const { valid: validDefault, errors: defaultErrors } = validatePolicyObject(raw.default);
            if (!validDefault) {
                errors.push(`default: ${defaultErrors.join('; ')}`);
            }
        }
    }

    // accounts: optional object of policies
    if (raw.accounts !== undefined) {
        if (typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) {
            errors.push('accounts must be an object');
        } else {
            for (const [accountName, policy] of Object.entries(raw.accounts)) {
                if (typeof policy !== 'object' || policy === null) {
                    errors.push(`accounts.${accountName} must be an object`);
                } else {
                    const { valid: validPolicy, errors: policyErrors } = validatePolicyObject(policy);
                    if (!validPolicy) {
                        errors.push(`accounts.${accountName}: ${policyErrors.join('; ')}`);
                    }
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate a single policy object (used by both default and per-account policies).
 */
function validatePolicyObject(policy: any): { valid: boolean; errors: string[] } {
    const errors = [];

    // allowedOpTypes: must be array of strings
    if (policy.allowedOpTypes !== undefined) {
        if (!Array.isArray(policy.allowedOpTypes)) {
            errors.push('allowedOpTypes must be an array');
        } else if (!policy.allowedOpTypes.every((x) => typeof x === 'string')) {
            errors.push('allowedOpTypes must be an array of strings');
        }
    }

    // maxOpsPerBatch: must be positive integer
    if (policy.maxOpsPerBatch !== undefined) {
        if (typeof policy.maxOpsPerBatch !== 'number' || policy.maxOpsPerBatch <= 0) {
            errors.push('maxOpsPerBatch must be a positive integer');
        }
    }

    // allowedAssetIds: optional array of strings
    if (policy.allowedAssetIds !== undefined) {
        if (policy.allowedAssetIds !== null) {
            if (!Array.isArray(policy.allowedAssetIds)) {
                errors.push('allowedAssetIds must be an array or null');
            } else if (!policy.allowedAssetIds.every((x) => typeof x === 'string')) {
                errors.push('allowedAssetIds must be an array of strings');
            }
        }
    }

    // executable: optional string path or null
    if (policy.executable !== undefined) {
        if (policy.executable !== null && typeof policy.executable !== 'string') {
            errors.push('executable must be a string path or null');
        }
    }

    // botHmacSecret: optional 64-char hex string (32 bytes)
    if (policy.botHmacSecret !== undefined) {
        if (typeof policy.botHmacSecret !== 'string' || !/^[0-9a-f]{64}$/i.test(policy.botHmacSecret)) {
            errors.push('botHmacSecret must be a 64-char hex string (32 bytes)');
        }
    }

    // allowedOps: optional object keyed by op_name → constraints (object or null)
    if (policy.allowedOps !== undefined) {
        if (policy.allowedOps !== null) {
            if (typeof policy.allowedOps !== 'object' || Array.isArray(policy.allowedOps)) {
                errors.push('allowedOps must be an object or null');
            } else {
                for (const [opName, constraints] of Object.entries(policy.allowedOps)) {
                    if (constraints !== null) {
                        if (typeof constraints !== 'object' || Array.isArray(constraints)) {
                            errors.push(`allowedOps.${opName} must be an object or null`);
                        } else {
                            const { errors: cErrors } = validateOpConstraints(opName, constraints);
                            for (const e of cErrors) errors.push(`allowedOps.${opName}: ${e}`);
                        }
                    }
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Derive debt-policy constraints from profiles/bots.json for an account.
 * Scans all bots using `accountName` as preferredAccount and extracts
 * collateralAsset / asset mappings from debtPolicy.lending[].
 *
 * Returns { call_order_update?, credit_offer_accept?, credit_deal_repay? }
 * where each op constraint may contain:
 *   - collateralAsset (string) — if all lending items for that op type share one collateral
 *   - allowedCollateralAssets (string[]) — if multiple collaterals are used
 *   - allowedDebtAssets (string[]) — debt assets used in credit lending items
 */
function deriveDebtPolicyConstraints(accountName: string): Record<string, any> {
    if (!accountName) return {};
    try {
        if (!storage.exists(BOTS_JSON_PATH)) return {};
        const raw = storage.readFile(BOTS_JSON_PATH);
        const parsed = parseJsonWithComments(raw);
        const bots = Array.isArray(parsed)
            ? parsed.filter(Boolean)
            : (Array.isArray(parsed?.bots) ? parsed.bots.filter(Boolean) : []);
        if (!Array.isArray(bots)) return {};

        const mpaCollaterals = new Set();
        const creditCollaterals = new Set();
        const creditDebtAssets = new Set();

        for (const bot of bots) {
            if (!bot || bot.active === false) continue;
            const pref = bot.preferredAccount || bot.account;
            if (pref !== accountName) continue;
            const dp = bot.debtPolicy;
            if (!dp || !Array.isArray(dp.lending)) continue;

            for (const item of dp.lending) {
                if (!item || !item.asset || !item.collateralAsset) continue;
                if (item.type === 'mpa') {
                    mpaCollaterals.add(item.collateralAsset);
                } else if (item.type === 'creditOffer') {
                    creditCollaterals.add(item.collateralAsset);
                    creditDebtAssets.add(item.asset);
                }
            }
        }

        const constraints: Record<string, any> = {};

        if (mpaCollaterals.size > 0) {
            constraints.call_order_update = {};
            if (mpaCollaterals.size === 1) {
                constraints.call_order_update.collateralAsset = Array.from(mpaCollaterals)[0];
            } else {
                constraints.call_order_update.allowedCollateralAssets = Array.from(mpaCollaterals);
            }
        }

        if (creditCollaterals.size > 0 || creditDebtAssets.size > 0) {
            constraints.credit_offer_accept = {};
            if (creditCollaterals.size === 1) {
                constraints.credit_offer_accept.collateralAsset = Array.from(creditCollaterals)[0];
            } else if (creditCollaterals.size > 1) {
                constraints.credit_offer_accept.allowedCollateralAssets = Array.from(creditCollaterals);
            }
            if (creditDebtAssets.size > 0) {
                constraints.credit_offer_accept.allowedDebtAssets = Array.from(creditDebtAssets);
            }
        }

        if (creditDebtAssets.size > 0) {
            constraints.credit_deal_repay = {
                allowedDebtAssets: Array.from(creditDebtAssets),
            };
        }

        return constraints;
    } catch {
        return {};
    }
}

/**
 * Resolve the effective policy for an account by merging layers:
 * builtin default → auto-derived debt constraints → config.default → config.accounts[accountName]
 */
function resolveAccountPolicy(config: any, accountName: string): any {
    // Start with builtin
    let policy = JSON.parse(JSON.stringify(BUILTIN_DEFAULT_POLICY));

    // Layer auto-derived debt constraints from bots.json
    const debtConstraints = deriveDebtPolicyConstraints(accountName);
    if (Object.keys(debtConstraints).length > 0) {
        policy.allowedOps = { ...policy.allowedOps };
        for (const [opName, constraints] of Object.entries(debtConstraints)) {
            policy.allowedOps[opName] = { ...(policy.allowedOps[opName] || {}), ...constraints };
        }
    }

    // Layer on config.default
    if (config && config.default) {
        policy = { ...policy, ...config.default };
    }

    // Layer on config.accounts[accountName]
    if (config && config.accounts && config.accounts[accountName]) {
        policy = { ...policy, ...config.accounts[accountName] };
    }

    return policy;
}

/**
 * Build the PolicyContext passed to evaluatePolicy and to executable hooks.
 */
function buildPolicyContext(request: any): PolicyContext {
    return {
        accountName: request.accountName,
        requestType: request.type,
        sessionId: request.sessionId || null,
        timestamp: new Date().toISOString(),
        operations: request.operations || [],
    };
}

/**
 * Evaluate per-operation parameter constraints.
 * Returns { allow: boolean, reason: string|null, policyId: string }
 */
async function evaluateOpConstraints(opName: string, opData: any, constraints: any): Promise<{ allow: boolean; reason: string | null; policyId: string | null }> {
    if (!constraints) return { allow: true, reason: null, policyId: null };
    const d = opData || {};

    if (opName === 'transfer') {
        // allowedToAccounts
        if (Array.isArray(constraints.allowedToAccounts) && constraints.allowedToAccounts.length > 0) {
            if (!constraints.allowedToAccounts.includes(d.to)) {
                return {
                    allow: false,
                    reason: `transfer: recipient "${d.to}" not in allowedToAccounts`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedAssets
        if (Array.isArray(constraints.allowedAssets) && constraints.allowedAssets.length > 0) {
            const id = d.amount && d.amount.asset_id;
            if (id && !constraints.allowedAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `transfer: asset "${id}" not in allowedAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxAmount
        if (constraints.maxAmount != null) {
            const amt = d.amount && d.amount.amount;
            if (typeof amt === 'number' && amt > constraints.maxAmount) {
                return {
                    allow: false,
                    reason: `transfer: amount ${amt} exceeds maxAmount ${constraints.maxAmount}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    if (opName === 'limit_order_create') {
        // allowedSellAssets
        if (Array.isArray(constraints.allowedSellAssets) && constraints.allowedSellAssets.length > 0) {
            const id = d.amount_to_sell && d.amount_to_sell.asset_id;
            if (id && !constraints.allowedSellAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `limit_order_create: sell asset "${id}" not in allowedSellAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedReceiveAssets
        if (Array.isArray(constraints.allowedReceiveAssets) && constraints.allowedReceiveAssets.length > 0) {
            const id = d.min_to_receive && d.min_to_receive.asset_id;
            if (id && !constraints.allowedReceiveAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `limit_order_create: receive asset "${id}" not in allowedReceiveAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxSellAmount
        if (constraints.maxSellAmount != null) {
            const amt = d.amount_to_sell && d.amount_to_sell.amount;
            if (typeof amt === 'number' && amt > constraints.maxSellAmount) {
                return {
                    allow: false,
                    reason: `limit_order_create: sell amount ${amt} exceeds maxSellAmount ${constraints.maxSellAmount}`,
                    policyId: 'opParams',
                };
            }
        }
        // maxReceiveAmount
        if (constraints.maxReceiveAmount != null) {
            const amt = d.min_to_receive && d.min_to_receive.amount;
            if (typeof amt === 'number' && amt > constraints.maxReceiveAmount) {
                return {
                    allow: false,
                    reason: `limit_order_create: receive amount ${amt} exceeds maxReceiveAmount ${constraints.maxReceiveAmount}`,
                    policyId: 'opParams',
                };
            }
        }
        // allowFillOrKill
        if (constraints.allowFillOrKill === false && d.fill_or_kill === true) {
            return {
                allow: false,
                reason: 'limit_order_create: fill_or_kill=true not permitted',
                policyId: 'opParams',
            };
        }
    }

    if (opName === 'limit_order_update') {
        // allowedSellAssets via new_price.base
        if (Array.isArray(constraints.allowedSellAssets) && constraints.allowedSellAssets.length > 0) {
            const id = d.new_price && d.new_price.base && d.new_price.base.asset_id;
            if (id && !constraints.allowedSellAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `limit_order_update: base asset "${id}" not in allowedSellAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedReceiveAssets via new_price.quote
        if (Array.isArray(constraints.allowedReceiveAssets) && constraints.allowedReceiveAssets.length > 0) {
            const id = d.new_price && d.new_price.quote && d.new_price.quote.asset_id;
            if (id && !constraints.allowedReceiveAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `limit_order_update: quote asset "${id}" not in allowedReceiveAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxDeltaSellAmount (abs value)
        if (constraints.maxDeltaSellAmount != null) {
            const delta = d.delta_amount_to_sell && d.delta_amount_to_sell.amount;
            if (typeof delta === 'number' && Math.abs(delta) > constraints.maxDeltaSellAmount) {
                return {
                    allow: false,
                    reason: `limit_order_update: |delta| ${Math.abs(delta)} exceeds maxDeltaSellAmount ${constraints.maxDeltaSellAmount}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    if (opName === 'call_order_update') {
        // allowedAssets
        if (Array.isArray(constraints.allowedAssets) && constraints.allowedAssets.length > 0) {
            const collId = d.delta_collateral && d.delta_collateral.asset_id;
            const debtId = d.delta_debt && d.delta_debt.asset_id;
            if (collId && !constraints.allowedAssets.includes(collId)) {
                return {
                    allow: false,
                    reason: `call_order_update: collateral asset "${collId}" not in allowedAssets`,
                    policyId: 'opParams',
                };
            }
            if (debtId && !constraints.allowedAssets.includes(debtId)) {
                return {
                    allow: false,
                    reason: `call_order_update: debt asset "${debtId}" not in allowedAssets`,
                    policyId: 'opParams',
                };
            }
        }
        if (constraints.collateralAsset) {
            const collId = d.delta_collateral && d.delta_collateral.asset_id;
            const resolved = await resolveConfiguredAssetRefs([constraints.collateralAsset], 'collateralAsset');
            if (!resolved.ok) {
                return {
                    allow: false,
                    reason: `call_order_update: ${resolved.reason}`,
                    policyId: 'opParams',
                };
            }
            if (collId && !resolved.values.includes(String(collId))) {
                return {
                    allow: false,
                    reason: `call_order_update: collateral asset "${collId}" does not match collateralAsset`,
                    policyId: 'opParams',
                };
            }
        }
        if (Array.isArray(constraints.allowedCollateralAssets) && constraints.allowedCollateralAssets.length > 0) {
            const collId = d.delta_collateral && d.delta_collateral.asset_id;
            const resolved = await resolveConfiguredAssetRefs(constraints.allowedCollateralAssets, 'allowedCollateralAssets');
            if (!resolved.ok) {
                return {
                    allow: false,
                    reason: `call_order_update: ${resolved.reason}`,
                    policyId: 'opParams',
                };
            }
            if (collId && !resolved.values.includes(String(collId))) {
                return {
                    allow: false,
                    reason: `call_order_update: collateral asset "${collId}" not in allowedCollateralAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxDeltaCollateral
        if (constraints.maxDeltaCollateral != null) {
            const amt = d.delta_collateral && d.delta_collateral.amount;
            if (typeof amt === 'number' && Math.abs(amt) > constraints.maxDeltaCollateral) {
                return {
                    allow: false,
                    reason: `call_order_update: |delta_collateral| ${Math.abs(amt)} exceeds maxDeltaCollateral ${constraints.maxDeltaCollateral}`,
                    policyId: 'opParams',
                };
            }
        }
        // maxDeltaDebt
        if (constraints.maxDeltaDebt != null) {
            const amt = d.delta_debt && d.delta_debt.amount;
            if (typeof amt === 'number' && Math.abs(amt) > constraints.maxDeltaDebt) {
                return {
                    allow: false,
                    reason: `call_order_update: |delta_debt| ${Math.abs(amt)} exceeds maxDeltaDebt ${constraints.maxDeltaDebt}`,
                    policyId: 'opParams',
                };
            }
        }
        if (constraints.minCollateralRatio != null && d.extensions && d.extensions.target_collateral_ratio != null) {
            const target = normalizeGrapheneCollateralRatio(d.extensions.target_collateral_ratio);
            if (Number.isFinite(target) && target < constraints.minCollateralRatio) {
                return {
                    allow: false,
                    reason: `call_order_update: target_collateral_ratio ${target} below minCollateralRatio ${constraints.minCollateralRatio}`,
                    policyId: 'opParams',
                };
            }
        }
        if (constraints.maxCollateralRatio != null && d.extensions && d.extensions.target_collateral_ratio != null) {
            const target = normalizeGrapheneCollateralRatio(d.extensions.target_collateral_ratio);
            if (Number.isFinite(target) && target > constraints.maxCollateralRatio) {
                return {
                    allow: false,
                    reason: `call_order_update: target_collateral_ratio ${target} above maxCollateralRatio ${constraints.maxCollateralRatio}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    if (opName === 'credit_offer_accept') {
        if (Array.isArray(constraints.allowedOfferIds) && constraints.allowedOfferIds.length > 0) {
            const offerId = d.offer_id;
            if (offerId && !constraints.allowedOfferIds.includes(String(offerId))) {
                return {
                    allow: false,
                    reason: `credit_offer_accept: offer "${offerId}" not in allowedOfferIds`,
                    policyId: 'opParams',
                };
            }
        }
        if (constraints.collateralAsset) {
            const assetId = d.collateral && d.collateral.asset_id;
            const resolved = await resolveConfiguredAssetRefs([constraints.collateralAsset], 'collateralAsset');
            if (!resolved.ok) {
                return {
                    allow: false,
                    reason: `credit_offer_accept: ${resolved.reason}`,
                    policyId: 'opParams',
                };
            }
            if (assetId && !resolved.values.includes(String(assetId))) {
                return {
                    allow: false,
                    reason: `credit_offer_accept: collateral asset "${assetId}" does not match collateralAsset`,
                    policyId: 'opParams',
                };
            }
        }
        if (Array.isArray(constraints.allowedCollateralAssets) && constraints.allowedCollateralAssets.length > 0) {
            const assetId = d.collateral && d.collateral.asset_id;
            const resolved = await resolveConfiguredAssetRefs(constraints.allowedCollateralAssets, 'allowedCollateralAssets');
            if (!resolved.ok) {
                return {
                    allow: false,
                    reason: `credit_offer_accept: ${resolved.reason}`,
                    policyId: 'opParams',
                };
            }
            if (assetId && !resolved.values.includes(String(assetId))) {
                return {
                    allow: false,
                    reason: `credit_offer_accept: collateral asset "${assetId}" not in allowedCollateralAssets`,
                    policyId: 'opParams',
                };
            }
        }
        if (Array.isArray(constraints.allowedDebtAssets) && constraints.allowedDebtAssets.length > 0) {
            const assetId = d.borrow_amount && d.borrow_amount.asset_id;
            const resolved = await resolveConfiguredAssetRefs(constraints.allowedDebtAssets, 'allowedDebtAssets');
            if (!resolved.ok) {
                return {
                    allow: false,
                    reason: `credit_offer_accept: ${resolved.reason}`,
                    policyId: 'opParams',
                };
            }
            if (assetId && !resolved.values.includes(String(assetId))) {
                return {
                    allow: false,
                    reason: `credit_offer_accept: debt asset "${assetId}" not in allowedDebtAssets`,
                    policyId: 'opParams',
                };
            }
        }
        if (constraints.maxFeeRate != null) {
            const maxFeeRate = Number(d.max_fee_rate);
            if (Number.isFinite(maxFeeRate) && maxFeeRate > constraints.maxFeeRate) {
                return {
                    allow: false,
                    reason: `credit_offer_accept: max_fee_rate ${maxFeeRate} exceeds maxFeeRate ${constraints.maxFeeRate}`,
                    policyId: 'opParams',
                };
            }
        }
        if (constraints.minDurationSeconds != null) {
            const minDurationSeconds = Number(d.min_duration_seconds);
            if (Number.isFinite(minDurationSeconds) && minDurationSeconds < constraints.minDurationSeconds) {
                return {
                    allow: false,
                    reason: `credit_offer_accept: min_duration_seconds ${minDurationSeconds} below minDurationSeconds ${constraints.minDurationSeconds}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    if (opName === 'credit_deal_repay') {
        if (Array.isArray(constraints.allowedDebtAssets) && constraints.allowedDebtAssets.length > 0) {
            const assetId = d.repay_amount && d.repay_amount.asset_id;
            const resolved = await resolveConfiguredAssetRefs(constraints.allowedDebtAssets, 'allowedDebtAssets');
            if (!resolved.ok) {
                return {
                    allow: false,
                    reason: `credit_deal_repay: ${resolved.reason}`,
                    policyId: 'opParams',
                };
            }
            if (assetId && !resolved.values.includes(String(assetId))) {
                return {
                    allow: false,
                    reason: `credit_deal_repay: debt asset "${assetId}" not in allowedDebtAssets`,
                    policyId: 'opParams',
                };
            }
        }
        if (constraints.maxRepayAmount != null) {
            const amt = d.repay_amount && d.repay_amount.amount;
            if (typeof amt === 'number' && amt > constraints.maxRepayAmount) {
                return {
                    allow: false,
                    reason: `credit_deal_repay: repay amount ${amt} exceeds maxRepayAmount ${constraints.maxRepayAmount}`,
                    policyId: 'opParams',
                };
            }
        }
        if (constraints.maxCreditFee != null) {
            const fee = d.credit_fee && d.credit_fee.amount;
            if (typeof fee === 'number' && fee > constraints.maxCreditFee) {
                return {
                    allow: false,
                    reason: `credit_deal_repay: credit fee ${fee} exceeds maxCreditFee ${constraints.maxCreditFee}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    if (opName === 'credit_deal_update') {
        if (constraints.allowAutoRepay === false && d.auto_repay) {
            return {
                allow: false,
                reason: 'credit_deal_update: auto_repay change not permitted',
                policyId: 'opParams',
            };
        }
    }

    if (opName === 'liquidity_pool_exchange') {
        // allowedPools
        if (Array.isArray(constraints.allowedPools) && constraints.allowedPools.length > 0) {
            if (!constraints.allowedPools.includes(d.pool)) {
                return {
                    allow: false,
                    reason: `liquidity_pool_exchange: pool "${d.pool}" not in allowedPools`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedSellAssets
        if (Array.isArray(constraints.allowedSellAssets) && constraints.allowedSellAssets.length > 0) {
            const id = d.amount_to_sell && d.amount_to_sell.asset_id;
            if (id && !constraints.allowedSellAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `liquidity_pool_exchange: sell asset "${id}" not in allowedSellAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedReceiveAssets
        if (Array.isArray(constraints.allowedReceiveAssets) && constraints.allowedReceiveAssets.length > 0) {
            const id = d.min_to_receive && d.min_to_receive.asset_id;
            if (id && !constraints.allowedReceiveAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `liquidity_pool_exchange: receive asset "${id}" not in allowedReceiveAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxSellAmount
        if (constraints.maxSellAmount != null) {
            const amt = d.amount_to_sell && d.amount_to_sell.amount;
            if (typeof amt === 'number' && amt > constraints.maxSellAmount) {
                return {
                    allow: false,
                    reason: `liquidity_pool_exchange: sell amount ${amt} exceeds maxSellAmount ${constraints.maxSellAmount}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    // limit_order_cancel — no constraints
    return { allow: true, reason: null, policyId: null };
}

/**
 * Evaluate a policy against a context. AND semantics: short-circuit on first denial.
 * Returns Promise<{ allow: boolean, reason: string|null, policyId: string|null }>
 */
async function evaluatePolicy(policy: any, context: PolicyContext): Promise<{ allow: boolean; reason: string | null; policyId: string | null }> {
    try {
        // Step 1: allowedOps check (if present) or allowedOpTypes fallback
        if (policy.allowedOps && typeof policy.allowedOps === 'object') {
            for (const op of context.operations) {
                if (!op || typeof op !== 'object') continue;
                const opName = op.op_name;

                // Check if op type is allowed
                if (!(opName in policy.allowedOps)) {
                    return {
                        allow: false,
                        reason: `op type "${opName}" not permitted`,
                        policyId: 'allowedOps',
                    };
                }

                // Get per-op constraints and evaluate
                const constraints = policy.allowedOps[opName];
                const result = await evaluateOpConstraints(opName, op.op_data, constraints);
                if (!result.allow) {
                    return result;
                }
            }
        } else {
            // Fallback: allowedOpTypes check (backward compat)
            const allowed = policy.allowedOpTypes || [];
            if (Array.isArray(allowed) && allowed.length > 0) {
                for (const op of context.operations) {
                    if (!op || typeof op !== 'object') continue;
                    if (!allowed.includes(op.op_name)) {
                        return {
                            allow: false,
                            reason: `op type "${op.op_name}" not permitted`,
                            policyId: 'allowedOpTypes',
                        };
                    }
                }
            }
        }

        // Step 2: maxOpsPerBatch check
        {
            const max = policy.maxOpsPerBatch || 200;
            if (context.operations.length > max) {
                return {
                    allow: false,
                    reason: `batch size ${context.operations.length} exceeds maxOpsPerBatch ${max}`,
                    policyId: 'maxOpsPerBatch',
                };
            }
        }

        // Step 3: allowedAssetIds check (optional)
        if (policy.allowedAssetIds && Array.isArray(policy.allowedAssetIds) && policy.allowedAssetIds.length > 0) {
            const allowed = policy.allowedAssetIds;
            for (const op of context.operations) {
                if (!op || typeof op !== 'object') continue;

                const opData = op.op_data || {};

                // Check amount_to_sell asset (for create/update)
                if (opData.amount_to_sell && opData.amount_to_sell.asset_id) {
                    if (!allowed.includes(opData.amount_to_sell.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.amount_to_sell.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                }

                // Check min_to_receive asset (for create/update)
                if (opData.min_to_receive && opData.min_to_receive.asset_id) {
                    if (!allowed.includes(opData.min_to_receive.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.min_to_receive.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                }

                if (op.op_name === 'call_order_update') {
                    if (opData.delta_collateral && opData.delta_collateral.asset_id && !allowed.includes(opData.delta_collateral.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.delta_collateral.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                    if (opData.delta_debt && opData.delta_debt.asset_id && !allowed.includes(opData.delta_debt.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.delta_debt.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                }

                if (op.op_name === 'credit_offer_accept') {
                    if (opData.borrow_amount && opData.borrow_amount.asset_id && !allowed.includes(opData.borrow_amount.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.borrow_amount.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                    if (opData.collateral && opData.collateral.asset_id && !allowed.includes(opData.collateral.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.collateral.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                }

                if (op.op_name === 'credit_deal_repay') {
                    if (opData.repay_amount && opData.repay_amount.asset_id && !allowed.includes(opData.repay_amount.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.repay_amount.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                    if (opData.credit_fee && opData.credit_fee.asset_id && !allowed.includes(opData.credit_fee.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.credit_fee.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                }
            }
        }

        // Step 4: executable check (optional)
        if (policy.executable && typeof policy.executable === 'string') {
            const result = await evaluateExecutable(policy.executable, context);
            if (!result.allow) {
                return {
                    allow: false,
                    reason: result.reason || 'denied by executable',
                    policyId: 'executable',
                };
            }
        }

        // All checks passed
        return { allow: true, reason: null, policyId: null };
    } catch (error: any) {
        // Any evaluation error → deny
        return {
            allow: false,
            reason: `policy evaluation error: ${error.message}`,
            policyId: 'policy_eval_error',
        };
    }
}

/**
 * Spawn and evaluate a custom policy executable.
 * Executable receives PolicyContext JSON on stdin.
 * Must output { "allow": true/false, "reason": "..." } to stdout within 5 seconds.
 * Returns Promise<{ allow: boolean, reason: string|null }>
 */
// File mode check: execute permission (X_OK = 1 on POSIX)
const X_OK = 1;

function evaluateExecutable(exePath: string, context: PolicyContext): Promise<{ allow: boolean; reason: string | null }> {
    return new Promise((resolve) => {
        let spawn;
        try {
            spawn = require('child_process').spawn;
        } catch {
            return resolve({ allow: false, reason: `executable not supported in this environment: ${exePath}` });
        }

        // Check file exists and is executable
        try {
            storage.access(exePath, X_OK);
        } catch {
            return resolve({ allow: false, reason: `executable not found or not executable: ${exePath}` });
        }

        let stdout = '';
        let stderr = '';

        const child = spawn(exePath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: EXECUTABLE_TIMEOUT_MS,
        });

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('error', (error) => {
            if (error.code === 'ETIMEDOUT') {
                resolve({ allow: false, reason: `executable timed out after ${EXECUTABLE_TIMEOUT_MS}ms` });
            } else {
                resolve({ allow: false, reason: `executable spawn failed: ${error.message}` });
            }
        });

        child.on('close', (code, signal) => {
            if (signal === 'SIGTERM') {
                return resolve({ allow: false, reason: `executable timed out after ${EXECUTABLE_TIMEOUT_MS}ms` });
            }

            if (code !== 0) {
                const stderrMsg = stderr.trim() ? `: ${stderr.trim()}` : '';
                return resolve({ allow: false, reason: `executable exited with code ${code}${stderrMsg}` });
            }

            // Parse JSON output
            try {
                const result = JSON.parse(stdout.trim());
                if (typeof result.allow !== 'boolean') {
                    return resolve({ allow: false, reason: 'executable output missing "allow" field' });
                }
                resolve({
                    allow: result.allow,
                    reason: result.allow ? null : (result.reason || 'denied by executable'),
                });
            } catch (error: any) {
                resolve({ allow: false, reason: `executable output invalid JSON: ${error.message}` });
            }
        });

        // Send context to stdin
        try {
            child.stdin.write(JSON.stringify(context));
            child.stdin.end();
        } catch (error: any) {
            child.kill();
            resolve({ allow: false, reason: `failed to pipe context to executable: ${error.message}` });
        }
    });
}

/**
 * Load the botHmacSecret for an account from the policy config file.
 *
 * CONCURRENCY NOTE (M1): If two bot processes call this simultaneously for
 * the same account before either has written, both will generate independent
 * secrets.  The second atomic rename clobbers the first, leaving both bots
 * holding the second bot's secret.  The first bot's HMAC will then mismatch
 * until it retries (triggering another reload).  This is a brief disruption
 * window, not a security breach — both bots are legitimate.  If strict
 * per-bot isolation is required, use flock(2) on the policy file or switch
 * to a per-bot key-derivation from a shared master secret.
 *
 * @param {string} accountName - The account name
 * @param {string} policyConfigPath - Path to daemon-policies.json
 * @param {Object} [options] - Optional configuration
 * @returns {string|null} The botHmacSecret, or null if not configured
 */
function loadBotHmacSecret(accountName: string, policyConfigPath: string, options: { quiet?: boolean; silent?: boolean } = {}): string | null {
    const quiet = options.quiet === true || options.silent === true;
    // Route through the module-scope policyLogger so output honours the
    // process-wide log level, file rotation, and PM2 auto-quiet rules.
    // `quiet` (per-call) suppresses routine info; security-relevant warns
    // and the auto-provision event still surface regardless.
    const info = (msg: string) => {
        if (!quiet) policyLogger.info(msg);
    };
    const debug = (msg: string) => {
        if (!quiet) policyLogger.debug?.(msg);
    };
    const warn = (msg: string) => {
        policyLogger.warn(msg);
    };
    // Always reload from disk to avoid serving a stale cached entry when
    // another process (or this process in an earlier call) already
    // auto-provisioned a new secret and signalled the daemon via SIGHUP.
    let config = loadPolicyConfig(policyConfigPath, { forceReload: true });
    if (!config) config = {};
    if (!config.accounts) config.accounts = {};
    if (!config.accounts[accountName]) config.accounts[accountName] = {};

    let secret = config.accounts[accountName].botHmacSecret;

    if (!secret) {
        const newSecret = randomBytes(32).toString('hex');
        config.accounts[accountName].botHmacSecret = newSecret;

        // Atomic write via unified StorageAdapter.
        storage.writeJSON(policyConfigPath, config, { mode: 0o600, fsync: true });
        warn(`[policy] SECURITY: Auto-provisioned strict botHmacSecret for ${accountName} — first-time secret generation`);

        // Best-effort SIGHUP to the credential daemon so the new secret is
        // picked up immediately, without waiting for the fs.watch debounce
        // (500ms) or a SIGHUP from the operator.  Three distinct failure
        // modes are handled separately:
        //   - ready file missing: daemon is not running, nothing to do
        //   - ready file empty: daemon is mid-startup; fs.watch will catch it
        //   - ready file malformed (old format, partial write): warn and skip
        //   - process.kill error (ESRCH=process gone, EPERM=not allowed):
        //     warn — the fs.watch safety net will still pick up the change
        try {
            const readyFile = getCredentialReadyFilePath({ root: PATHS.PROJECT_ROOT });
            if (!storage.exists(readyFile)) {
                info(`[policy] Ready file ${readyFile} not present; daemon not running, SIGHUP skipped`);
                secret = newSecret;
                return secret;
            }
            const raw = storage.readFile(readyFile);
            if (!raw.trim()) {
                // File exists but is empty: daemon is mid-startup.  Don't warn —
                // this is the expected race window between fork and ready-file write.
                // The fs.watch safety net will pick up the change within 500ms.
                debug(`[policy] Ready file ${readyFile} is empty (daemon mid-startup); fs.watch will pick up the change`);
                secret = newSecret;
                return secret;
            }
            const daemonInfo = JSON.parse(raw);
            if (daemonInfo && typeof daemonInfo.pid === 'number') {
                runtime.kill(daemonInfo.pid, 'SIGHUP');
                info(`[policy] Sent SIGHUP to credential daemon (pid ${daemonInfo.pid}) to activate new secret`);
            } else {
                warn(`[policy] Ready file ${readyFile} has no numeric pid field; skipping SIGHUP`);
            }
        } catch (e: any) {
            if (e && e.code === 'ENOENT') {
                info(`[policy] Ready file not present; daemon not running, SIGHUP skipped`);
            } else if (e instanceof SyntaxError) {
                warn(`[policy] Ready file is malformed JSON (${e.message}); SIGHUP skipped, fs.watch will pick up the change`);
            } else if (e && (e.code === 'ESRCH' || e.code === 'EPERM')) {
                warn(`[policy] SIGHUP to daemon failed (${e.code}: ${e.message}); fs.watch will pick up the change`);
            } else {
                warn(`[policy] Unexpected error signalling daemon (${e && e.message}); fs.watch will pick up the change`);
            }
        }
        secret = newSecret;
    }
    return secret;
}

/**
 * Verify that the signing request was HMAC-signed by the bot holding botHmacSecret.
 * Session binding: HMAC includes sessionId, so replay is impossible across sessions.
 *
 * @param {object} request - Parsed request: { accountName, sessionId, operations, hmac }
 * @param {object|null} policyConfig - Loaded daemon-policies.json content
 * @returns {{ valid: boolean, reason: string|null, skipped: boolean }}
 *   skipped is always false — missing secrets are rejected in strict mode.
 */
function verifySourceHmac(request: any, policyConfig: any): { valid: boolean; reason: string | null; skipped: boolean } {
    const accountPolicy =
        policyConfig && policyConfig.accounts && policyConfig.accounts[request.accountName];
    const secretHex = accountPolicy && accountPolicy.botHmacSecret;

    // Strict Mode Enforcement: Reject instantly if no secret is configured
    if (!secretHex) {
        return { valid: false, reason: 'Strict Mode: botHmacSecret missing in daemon-policies.json', skipped: false };
    }

    const providedHmac = request.hmac;
    if (!providedHmac || typeof providedHmac !== 'string') {
        return { valid: false, reason: 'missing hmac field', skipped: false };
    }

    // Canonical signing payload: must match exactly what the bot computed
    const signingPayload = JSON.stringify({
        sessionId: request.sessionId,
        operations: request.operations,
    });

    const expected = createHmac('sha256', Buffer.from(secretHex, 'hex'))
        .update(signingPayload)
        .digest('hex');

    try {
        const valid = timingSafeEqual(
            Buffer.from(expected, 'hex'),
            Buffer.from(providedHmac, 'hex'),
        );
        return { valid, reason: valid ? null : 'hmac mismatch', skipped: false };
    } catch {
        // Buffer.from throws if provided hmac is not valid hex or wrong length
        return { valid: false, reason: 'invalid hmac format', skipped: false };
    }
}

export = {
    POLICY_DENIED_PREFIX,
    BUILTIN_DEFAULT_POLICY,
    checkPolicyFileSecurity,
    ensurePolicyConfig,
    loadPolicyConfig,
    loadRequiredPolicyConfig,
    reloadPolicyFromDisk,
    validatePolicyConfig,
    deriveDebtPolicyConstraints,
    resolveAccountPolicy,
    buildPolicyContext,
    evaluatePolicy,
    verifySourceHmac,
    loadBotHmacSecret,
    setExternalAssetResolver,
};
